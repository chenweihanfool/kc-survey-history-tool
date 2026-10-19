// 檔案存取抽象層。
//  - FsaWorkspace：File System Access API（Chrome / Edge），可直接讀寫使用者授權的資料夾。
//  - FilesWorkspace：<input webkitdirectory> 取得的檔案清單（Firefox / Safari 等），只能讀；
//    要「寫出」的檔案改以下載方式提供。
// 路徑一律用陣列表示（例如 ['QGIS', '複丈歷史', '複丈歷史.gpkg']）。

export const hasFsa = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

export function download(name, bytes, mime = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export class FsaWorkspace {
  constructor(handle) {
    this.handle = handle; this.kind = 'fsa'; this.canWrite = true; this.name = handle.name;
  }

  async dir(parts, create = false) {
    let h = this.handle;
    for (const p of parts) h = await h.getDirectoryHandle(p, { create });
    return h;
  }

  async listDir(parts) {
    const h = await this.dir(parts);
    const out = [];
    for await (const [name, e] of h.entries()) out.push({ name, kind: e.kind });
    return out;
  }

  async readFile(parts) {
    try {
      const d = await this.dir(parts.slice(0, -1));
      const fh = await d.getFileHandle(parts[parts.length - 1]);
      return new Uint8Array(await (await fh.getFile()).arrayBuffer());
    } catch (e) {
      if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return null;
      throw e;
    }
  }

  async writeFile(parts, bytes) {
    const d = await this.dir(parts.slice(0, -1), true);
    const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
  }
}

export class FilesWorkspace {
  /** fileList：<input webkitdirectory> 的 FileList；webkitRelativePath 為 根/子/檔。 */
  constructor(fileList) {
    this.kind = 'files'; this.canWrite = false;
    this.files = new Map(); // 'a/b/c' -> File
    this.dirs = new Map();  // 'a/b' -> Map(name -> kind)
    this.name = '';
    const ensure = (p) => { if (!this.dirs.has(p)) this.dirs.set(p, new Map()); return this.dirs.get(p); };
    ensure('');
    for (const f of fileList) {
      const segs = (f.webkitRelativePath || f.name).split('/');
      if (!this.name) this.name = segs[0];
      const rel = segs.slice(1);
      if (rel.length === 0) continue;
      this.files.set(rel.join('/'), f);
      for (let i = 0; i < rel.length; i++) {
        const parent = rel.slice(0, i).join('/');
        ensure(parent).set(rel[i], i === rel.length - 1 ? 'file' : 'directory');
        if (i < rel.length - 1) ensure(rel.slice(0, i + 1).join('/'));
      }
    }
  }

  async listDir(parts) {
    const m = this.dirs.get(parts.join('/'));
    if (!m) throw new Error(`找不到資料夾：${parts.join('/')}`);
    return [...m.entries()].map(([name, kind]) => ({ name, kind }));
  }

  async readFile(parts) {
    const f = this.files.get(parts.join('/'));
    return f ? new Uint8Array(await f.arrayBuffer()) : null;
  }

  async writeFile(parts, bytes) {
    download(parts[parts.length - 1], bytes);
  }
}

/** 某資料夾的 {names, read(name)}，供 survey.js 讀 D 系列檔案。 */
export async function folderSource(ws, parts) {
  const entries = await ws.listDir(parts);
  return {
    names: entries.filter((e) => e.kind === 'file').map((e) => e.name),
    read: (name) => ws.readFile([...parts, name]),
  };
}

// ── 記住上次使用的資料夾（IndexedDB；失敗就當作沒有）──────────
const DB = 'kc-survey'; const STORE = 'handles';
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function saveHandle(key, handle) {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch (_e) { /* 不影響主流程 */ }
}
export async function loadHandle(key) {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const r = db.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
    });
  } catch (_e) { return null; }
}
