// 複丈歷史資料匯出工具 - 網頁版主程式（畫面與流程）
import { APP_TITLE, APP_VERSION, CHANGELOG } from './version.js';
import { FsaWorkspace, FilesWorkspace, hasFsa, download, folderSource, saveHandle, loadHandle } from './workspace.js';
import { findCases, runExport, MASTER_GPKG_NAME, makeCaseId, ExportAbortedError } from './pipeline.js';
import * as survey from './survey.js';
import { ParamStore, parseInp, convertCase, sanityCheck, MODELS, baseName } from './twd.js';
import { checkForUpdate } from './update.js';

const $ = (id) => document.getElementById(id);
const store = new ParamStore();
const st = {
  ws: null, found: null, caseEntry: null, raw: null, parcels: [], labelToKey: new Map(),
  selected: new Set(), displayed: [], manualQgz: null, outDir: null, inpNames: [],
};
const libs = { SQL: null, JSZip: window.JSZip };

// ── 小工具 ──────────────────────────────────────────────────
function log(msg) {
  const el = $('log');
  el.textContent += `${msg}\n`;
  el.scrollTop = el.scrollHeight;
}
const radio = (name) => document.querySelector(`input[name=${name}]:checked`).value;
const setStatus = (t) => { $('status').textContent = t; };
const fmtCm = (m) => `${(m * 100).toFixed(1)} cm`;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function getSQL() {
  if (!libs.SQL) {
    // 單一 .html 版把 WASM 以 base64 內嵌（file:// 下瀏覽器不允許另外載入 .wasm）；開發用的 site/ 版則照檔案載入
    const b64 = window.__SQL_WASM_B64;
    libs.SQL = await window.initSqlJs(b64
      ? { wasmBinary: Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)) }
      : { locateFile: (f) => `vendor/${f}` });
  }
  return libs.SQL;
}

async function readText(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) { try { text = new TextDecoder('big5').decode(buf); } catch (_e) { /* 保留 utf-8 結果 */ } }
  return text;
}

// ── 版本／更新 ──────────────────────────────────────────────
function initVersion() {
  document.title = `${APP_TITLE} v${APP_VERSION}`;
  $('ver').textContent = `v${APP_VERSION}（點選查看更新歷程）`;
  $('ver').onclick = () => {
    $('verBody').innerHTML = CHANGELOG.map((e) => `<h3>v${e.version}　${e.date}</h3><ul>${
      e.notes.map((n) => `<li>${n.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</li>`).join('')}</ul>`).join('');
    $('dlgVer').showModal();
  };
  $('verClose').onclick = () => $('dlgVer').close();
  checkForUpdate(APP_VERSION).then((u) => {
    if (!u) return;
    $('updateVer').textContent = u.version;
    $('updateLink').href = u.assetUrl || u.url;
    $('updateBanner').style.display = 'block';
  });
}

// ── 步驟 1：資料夾與案件 ─────────────────────────────────────
async function chooseFolder() {
  if (!hasFsa()) { $('folderInp').click(); return; }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    if (e && e.name === 'AbortError') { setStatus('已取消選擇資料夾'); return; } // 使用者按了取消
    const why = `${e && e.name ? e.name : 'Error'}：${e && e.message ? e.message : e}`;
    log(`❌ 無法開啟資料夾選擇視窗（${why}）`);
    setStatus('無法開啟資料夾選擇視窗');
    alert(`無法開啟資料夾選擇視窗。\n\n${why}\n\n可以改按「相容模式」選資料夾（只能讀取，結果會以下載方式提供）。`);
    return;
  }
  try {
    await saveHandle('root', handle);
    await openWorkspace(new FsaWorkspace(handle));
  } catch (e) {
    log(`❌ 讀取資料夾失敗：${e.message}`);
    setStatus('讀取失敗');
    alert(`讀取資料夾失敗：${e.message}`);
  }
}

async function openLast() {
  const h = await loadHandle('root');
  if (!h) return;
  try {
    if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') return;
    await openWorkspace(new FsaWorkspace(h));
  } catch (_e) { setStatus('無法開啟上次的資料夾，請重新選擇'); }
}

async function openWorkspace(ws) {
  st.ws = ws; st.manualQgz = null; st.outDir = null; st.raw = null;
  $('btnRun').disabled = true;
  setStatus('讀取資料夾…');
  try {
    st.found = await findCases(ws);
  } catch (e) {
    setStatus('讀取失敗'); alert(`無法讀取資料夾：${e.message}`); return;
  }
  $('rootLabel').textContent = `${ws.name}　${st.found.mode === 'case' ? '（單一案件資料夾）' : '（專案根目錄）'}`;
  $('browserNotice').classList.toggle('hidden', ws.canWrite);

  const sel = $('selCase');
  sel.innerHTML = '';
  for (const c of st.found.cases) sel.add(new Option(c.name, c.name));
  sel.disabled = st.found.cases.length === 0;
  if (st.found.cases.length === 0) {
    $('caseInfo').textContent = '';
    setStatus('找不到案件');
    alert('在這個資料夾裡找不到任何案件（需要有 XX####.D14 檔案的資料夾）。\n請選專案根目錄或單一案件資料夾。');
    return;
  }
  renderQgz();
  renderOut();
  await selectCase(st.found.cases[0]);
}

function renderQgz() {
  const sel = $('selQgz');
  sel.innerHTML = '';
  const q = st.found && st.found.qgis;
  if (st.manualQgz) {
    sel.add(new Option(st.manualQgz.name, '__manual__'));
    sel.disabled = false; $('qgzNote').textContent = '';
    return;
  }
  if (q && q.qgz.length) {
    for (const n of q.qgz) sel.add(new Option(n, n));
    sel.add(new Option('（不更新 QGZ，僅輸出 GPKG）', ''));
    sel.disabled = false; $('qgzNote').textContent = `QGIS 資料夾：${q.dirParts.join('/')}`;
  } else {
    sel.add(new Option('（不更新 QGZ，僅輸出 GPKG）', ''));
    sel.disabled = true;
    $('qgzNote').textContent = q ? '⚠ QGIS 資料夾內找不到 .qgz，可另選檔案' : '⚠ 找不到相鄰的 QGIS 資料夾，可另選 QGZ 檔，或只輸出 GPKG';
  }
}

function renderOut() {
  const hasQgis = st.found && st.found.qgis;
  const show = !hasQgis && st.ws && st.ws.canWrite;
  $('rowOut').classList.toggle('hidden', !show);
  $('outLabel').textContent = st.outDir ? st.outDir.name : '（尚未選擇；執行時會詢問）';
}

async function selectCase(entry) {
  st.caseEntry = entry;
  setStatus('讀取中…'); $('btnRun').disabled = true;
  const useOld = radio('ver') === 'old';
  try {
    const source = await folderSource(st.ws, entry.parts);
    st.inpNames = source.names.filter((n) => /\.inp$/i.test(n));
    if (useOld && !(await survey.hasOldMapData(source))) {
      alert('這個案件資料夾內找不到任何舊圖資料（D2B/D2C/D2D 皆無記錄），切換後重新讀取會是空的。');
    }
    const caseId = entry.name;
    st.raw = await survey.loadCase(source, caseId, useOld);
    st.source = source;
  } catch (e) {
    setStatus('讀取失敗'); st.raw = null;
    alert(`讀取失敗：${e.message}`); return;
  }
  const c = st.raw;
  st.parcels = survey.listParcels(c);
  st.labelToKey = new Map(st.parcels.map((p) => [p.label, p.key]));
  st.selected = new Set(); $('inSearch').value = '';
  renderParcels();
  $('caseInfo').textContent = `✓ ${c.caseId}［${c.dataVersion === 'old' ? '舊圖' : '新圖'}］界址點 ${c.mainPts.size}、參考點 ${c.subPts.size}、補點 ${c.supplements.length}、地籍線 ${c.lines.length}、地號 ${st.parcels.length}`;
  log(`已讀取案件：${c.caseId} — 資料版本：${c.dataVersion === 'old' ? '舊圖（D2C/D2D/D2B）' : '新圖（D14/D21/D13/D11）'}`);
  setStatus('已讀取案件資料，可設定輸出範圍後執行');
  $('btnRun').disabled = false;
  renderInpHint();
  updateCrsWarn();
}

// ── 地號清單 ─────────────────────────────────────────────────
function renderParcels() {
  const q = $('inSearch').value.trim();
  st.displayed = st.parcels.map((p) => p.label).filter((l) => !q || l.includes(q));
  const sel = $('selParcel');
  sel.innerHTML = '';
  for (const l of st.displayed) {
    const o = new Option(l, l);
    o.selected = st.selected.has(l);
    sel.add(o);
  }
  $('parcelInfo').textContent = `已選 ${st.selected.size} 個地號`;
}

function syncSelection() {
  const picked = new Set(Array.from($('selParcel').selectedOptions).map((o) => o.value));
  for (const l of st.displayed) { if (picked.has(l)) st.selected.add(l); else st.selected.delete(l); }
  $('parcelInfo').textContent = `已選 ${st.selected.size} 個地號`;
}

// ── 步驟 2：座標系與轉換參數 ─────────────────────────────────
function renderParams(preferId) {
  const sel = $('selParam');
  const keep = preferId || sel.value || store.selected;
  sel.innerHTML = '';
  if (store.list().length === 0) sel.add(new Option('（尚無參數，請先匯入 INP）', ''));
  for (const s of store.list()) sel.add(new Option(`${s.name}（${s.pairs.length} 點）`, s.id));
  if (keep && store.get(keep)) sel.value = keep;
  store.select(sel.value || null);
  renderParamInfo();
}

function renderParamInfo() {
  const set = store.get($('selParam').value);
  const el = $('paramInfo');
  if (!set) { el.textContent = ''; return; }
  try {
    const fit = store.fitOf(set);
    el.textContent = `控制點 ${fit.n} 個｜${MODELS[fit.model]}｜殘差 RMS ${fmtCm(fit.rms)}、最大 ${fmtCm(fit.max)}${fit.note ? `｜⚠ ${fit.note}` : ''}`;
  } catch (e) { el.textContent = `⚠ ${e.message}`; }
}

function updateCrsWarn() {
  const box = $('crsWarn');
  const is67 = radio('crs') === '67';
  $('rowParam').classList.toggle('hidden', !is67);
  $('paramInfo').classList.toggle('hidden', !is67);
  const msgs = [];
  if (is67 && st.raw) {
    const set = store.get($('selParam').value);
    if (set) { try { msgs.push(...sanityCheck(st.raw, ParamStore.pairsOf(set))); } catch (_e) { /* 在執行時會再報錯 */ } }
  }
  box.classList.toggle('hidden', msgs.length === 0);
  box.textContent = msgs.map((m) => `⚠ ${m}`).join('\n');
}

function renderInpHint() {
  let el = $('inpHint');
  if (!el) {
    el = document.createElement('div'); el.id = 'inpHint'; el.className = 'notice';
    $('crsWarn').after(el);
  }
  el.classList.toggle('hidden', st.inpNames.length === 0);
  if (st.inpNames.length === 0) return;
  el.innerHTML = '';
  el.append(`這個案件資料夾內有 ${st.inpNames.length} 個 INP 檔（${st.inpNames.join('、')}）。 `);
  const b = document.createElement('button'); b.className = 'small'; b.textContent = '匯入為轉換參數';
  b.onclick = async () => {
    const files = [];
    for (const n of st.inpNames) {
      const bytes = await st.source.read(n);
      if (bytes) files.push(new File([bytes], n));
    }
    const first = await importInpFiles(files);
    renderParams(first); updateCrsWarn();
  };
  el.append(b);
}

// ── 轉換參數管理 ─────────────────────────────────────────────
function pMsg(t) { $('pMsg').textContent = t; }

/** 匯入多個 INP；回傳第一個成功匯入的參數 id。 */
async function importInpFiles(files) {
  let added = 0; let updated = 0; const skipped = []; let firstName = null;
  for (const f of files) {
    const { pairs } = parseInp(await readText(f));
    if (pairs.length === 0) { skipped.push(f.name); continue; }
    const name = baseName(f.name);
    const r = store.upsert({ name, pairs });
    if (r === 'added') added++; else updated++;
    if (!firstName) firstName = name;
  }
  const msg = `匯入完成：新增 ${added}、更新 ${updated}${skipped.length ? `；略過（沒有可用控制點）：${skipped.join('、')}` : ''}`;
  pMsg(msg); log(msg);
  const hit = store.list().find((s) => s.name === firstName);
  return hit ? hit.id : null;
}

function renderParamTable() {
  const body = $('pBody');
  body.innerHTML = '';
  if (store.list().length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="muted">尚無轉換參數。請按「匯入 INP 檔」。</td></tr>';
    return;
  }
  for (const s of store.list()) {
    let fit = null; let err = '';
    try { fit = store.fitOf(s); } catch (e) { err = e.message; }
    const tr = document.createElement('tr');
    const td = (child) => { const c = document.createElement('td'); if (typeof child === 'string') c.textContent = child; else if (child) c.append(child); tr.append(c); return c; };
    td(s.name);
    td(String(s.pairs.length));
    const ms = document.createElement('select');
    for (const [k, v] of Object.entries(MODELS)) ms.add(new Option(v, k));
    ms.value = s.model || 'affine';
    ms.onchange = () => { store.patch(s.id, { model: ms.value }); renderParamTable(); renderParams(); updateCrsWarn(); };
    td(ms);
    td(fit ? `${fmtCm(fit.rms)}／${fmtCm(fit.max)}${fit.note ? ' ⚠' : ''}` : `⚠ ${err}`);
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = s.exact !== false;
    cb.onchange = () => store.patch(s.id, { exact: cb.checked });
    td(cb);
    const act = td('');
    const mkBtn = (label, fn) => { const b = document.createElement('button'); b.className = 'small'; b.textContent = label; b.onclick = fn; act.append(b, ' '); };
    mkBtn('殘差', () => showDetail(s, fit));
    mkBtn('改名', () => {
      const n = prompt('參數名稱', s.name);
      if (n && n.trim() && n.trim() !== s.name && !store.list().some((x) => x.name === n.trim())) {
        store.patch(s.id, { name: n.trim() }); renderParamTable(); renderParams(s.id);
      }
    });
    mkBtn('刪除', () => {
      if (confirm(`刪除轉換參數「${s.name}」？`)) { store.remove(s.id); renderParamTable(); renderParams(); updateCrsWarn(); $('pDetail').innerHTML = ''; }
    });
    body.append(tr);
  }
}

function showDetail(s, fit) {
  const d = $('pDetail');
  if (!fit) { d.textContent = ''; return; }
  const rows = fit.control.map((c) => `<tr><td>${c.name}</td><td>${c.dE.toFixed(3)}</td><td>${c.dN.toFixed(3)}</td><td>${c.d.toFixed(3)}</td></tr>`).join('');
  d.innerHTML = `<h3 style="font-size:14px">「${s.name}」各控制點殘差（轉換結果 − 公告 TWD97，單位 m）</h3>
    <div class="scroll" style="max-height:30vh"><table><thead><tr><th>點名</th><th>ΔE</th><th>ΔN</th><th>距離</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function initParams() {
  renderParams();
  $('btnParams').onclick = () => { pMsg(''); $('pDetail').innerHTML = ''; renderParamTable(); $('dlgParams').showModal(); };
  $('pClose').onclick = () => { $('dlgParams').close(); renderParams(); updateCrsWarn(); };
  $('pImportFiles').onclick = () => $('fileInp').click();
  $('pImportDir').onclick = () => $('dirInp').click();
  $('pImportJson').onclick = () => $('jsonInp').click();
  $('fileInp').onchange = async (e) => { await importInpFiles(Array.from(e.target.files)); e.target.value = ''; renderParamTable(); };
  $('dirInp').onchange = async (e) => {
    const files = Array.from(e.target.files).filter((f) => /\.inp$/i.test(f.name));
    if (files.length === 0) pMsg('這個資料夾內沒有 .inp 檔'); else await importInpFiles(files);
    e.target.value = ''; renderParamTable();
  };
  $('jsonInp').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const r = store.importJson(await readText(f));
      pMsg(`設定檔匯入完成：新增 ${r.added}、更新 ${r.updated}`);
    } catch (err) { pMsg(`⚠ ${err.message}`); }
    renderParamTable();
  };
  $('pExportJson').onclick = () => {
    if (store.list().length === 0) { pMsg('沒有可匯出的參數'); return; }
    download('twd67-conversion-params.json', new TextEncoder().encode(store.exportJson()), 'application/json');
  };
  $('selParam').onchange = () => { store.select($('selParam').value || null); renderParamInfo(); updateCrsWarn(); };
  document.querySelectorAll('input[name=crs]').forEach((r) => { r.onchange = updateCrsWarn; });
}

// ── 輸出目標（GPKG / QGZ）────────────────────────────────────
const GPKG_PARTS = ['複丈歷史', MASTER_GPKG_NAME];

function gpkgTarget() {
  if (st.outDir) {
    return {
      read: async () => {
        try { return new Uint8Array(await (await (await st.outDir.getFileHandle(MASTER_GPKG_NAME)).getFile()).arrayBuffer()); } catch (_e) { return null; }
      },
      write: async (bytes) => {
        const w = await (await st.outDir.getFileHandle(MASTER_GPKG_NAME, { create: true })).createWritable();
        await w.write(bytes); await w.close();
      },
    };
  }
  const q = st.found && st.found.qgis;
  if (q) {
    const parts = [...q.dirParts, ...GPKG_PARTS];
    return { read: () => st.ws.readFile(parts), write: (b) => st.ws.writeFile(parts, b) };
  }
  return null;
}

function qgzTarget() {
  if (st.manualQgz) return st.manualQgz;
  const name = $('selQgz').value;
  const q = st.found && st.found.qgis;
  if (!name || !q) return null;
  const parts = [...q.dirParts, name];
  return {
    name,
    read: async () => {
      const b = await st.ws.readFile(parts);
      if (!b) throw new Error(`QGZ 專案檔不存在：${name}`);
      return b;
    },
    backup: (b) => st.ws.writeFile([...q.dirParts, `${name}.bak`], b),
    write: (b) => st.ws.writeFile(parts, b),
  };
}

async function pickQgzManually() {
  if (window.showOpenFilePicker) {
    let h;
    try { [h] = await window.showOpenFilePicker({ types: [{ description: 'QGIS Project', accept: { 'application/zip': ['.qgz'] } }] }); } catch (_e) { return; }
    st.manualQgz = {
      name: h.name,
      read: async () => new Uint8Array(await (await h.getFile()).arrayBuffer()),
      backup: async (b) => download(`${h.name}.bak`, b),
      write: async (b) => { const w = await h.createWritable(); await w.write(b); await w.close(); },
    };
    if (!st.found) st.found = { mode: 'case', cases: [], qgis: null };
    renderQgz();
  } else {
    $('qgzInp').click();
  }
}

async function pickOutDir() {
  try { st.outDir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (_e) { return; }
  renderOut();
}

// ── 執行 ─────────────────────────────────────────────────────
function cloneForConvert(c) {
  return {
    ...c,
    mainPts: new Map(c.mainPts), subPts: new Map(c.subPts),
    supplements: c.supplements.map((r) => ({ ...r })),
  };
}

async function onRun() {
  if (!st.raw) return;
  const dateStr = $('inDate').value.trim();
  if (!dateStr) { alert('請輸入複丈日期'); return; }

  let parcelKeys = null;
  if (radio('scope') === 'one') {
    if (st.selected.size === 0) {
      alert('請至少選擇一個地號（可從清單中複選）\n已中止輸出，不會產生任何檔案。');
      setStatus('尚未選擇地號，已中止'); return;
    }
    const missing = []; parcelKeys = [];
    for (const l of st.selected) { const k = st.labelToKey.get(l); if (k === undefined) missing.push(l); else parcelKeys.push(k); }
    if (missing.length) { alert(`找不到地號：${missing.join('、')}\n已中止輸出，不會產生任何檔案。`); setStatus('查無地號，已中止'); return; }
  }

  // 座標轉換
  let c = st.raw; let convNote = '座標系：TWD97（不轉換）'; const warns = [];
  if (radio('crs') === '67') {
    const set = store.get($('selParam').value);
    if (!set) { alert('案件座標系選了 TWD67，請先在下拉清單選一組轉換參數（沒有的話按「管理轉換參數」匯入 INP）。'); return; }
    try {
      const fit = store.fitOf(set);
      warns.push(...sanityCheck(st.raw, ParamStore.pairsOf(set)));
      c = cloneForConvert(st.raw);
      const stats = convertCase(c, fit, { exact: set.exact !== false });
      if (fit.note) warns.push(fit.note);
      warns.push(...stats.warnings);
      convNote = `座標系：TWD67 → TWD97\n參數：${set.name}（${MODELS[fit.model]}，控制點 ${fit.n}，殘差 RMS ${fmtCm(fit.rms)}、最大 ${fmtCm(fit.max)}）\n已轉換 ${stats.points} 個點位，其中 ${stats.exact} 個採用公告值`;
      log(convNote.replace(/\n/g, '；'));
    } catch (e) { alert(`座標轉換失敗：${e.message}`); return; }
  }

  // 輸出目標
  let gpkg = gpkgTarget();
  if (!gpkg) {
    if (hasFsa()) {
      alert('找不到 QGIS 資料夾。請選擇「複丈歷史」GPKG 的輸出資料夾。');
      await pickOutDir();
      gpkg = gpkgTarget();
      if (!gpkg) return;
    } else {
      gpkg = { read: async () => null, write: async (b) => download(MASTER_GPKG_NAME, b) };
    }
  }
  const qgz = qgzTarget();

  const tag = makeCaseId(c.caseId, dateStr, c.dataVersion);
  const scopeDesc = parcelKeys !== null ? `指定地號（${parcelKeys.length} 筆）` : '全部地號';
  const lines = [`輸出範圍：${scopeDesc}`, convNote, '', `即將寫入彙整 GPKG：${MASTER_GPKG_NAME}`,
    `（案件標記：${tag}；若已有相同標記的舊資料會先取代）`];
  if (qgz) lines.push('', `並修改 QGIS 專案檔：${qgz.name}（會先備份為 .bak）`); else lines.push('', '（未選擇 QGZ 專案檔，僅寫入 GPKG）');
  if (!st.ws.canWrite && !st.outDir) lines.push('', '※ 此瀏覽器無法直接寫入，結果會以下載方式提供（請放回 QGIS\\複丈歷史 資料夾）。');
  if (warns.length) lines.push('', ...warns.map((w) => `⚠ ${w}`));
  lines.push('', '確定要繼續嗎？');
  if (!confirm(lines.join('\n'))) return;

  $('btnRun').disabled = true; setStatus('輸出中…');
  try {
    const SQL = await getSQL();
    const result = await runExport(c, { parcelKeys, dateStr, includeRefs: $('chkRefs').checked },
      { gpkg, qgz }, { SQL, JSZip: libs.JSZip }, log);
    log('✅ 完成');
    const summary = Object.entries(result.layerCounts).map(([k, v]) => `  ${k}: ${v} 筆`).join('\n');
    setStatus('完成');
    alert(`已寫入彙整 GPKG\n案件標記：${result.caseIdTag}\n\n本次筆數：\n${summary}${result.qgzName ? `\n\nQGIS 專案已更新：${result.qgzName}` : ''}`);
  } catch (e) {
    if (e instanceof ExportAbortedError) { log(`❌ 已中止：${e.message}`); setStatus('已中止（無資料）'); alert(e.message); } else {
      log(`❌ 發生錯誤：${e.message}`); setStatus('輸出失敗'); alert(`輸出失敗：${e.message}`);
    }
  } finally {
    $('btnRun').disabled = false;
  }
}

// ── 初始化 ───────────────────────────────────────────────────
function safely(name, fn) {
  try { fn(); } catch (e) { log(`❌ 初始化「${name}」失敗：${e.message}`); console.error(e); }
}

function init() {
  // 先綁定主要按鈕，確保後面任何步驟出錯都不會讓按鈕沒反應
  $('btnPick').onclick = chooseFolder;
  $('btnCompat').onclick = () => $('folderInp').click();
  $('folderInp').onchange = async (e) => {
    const files = Array.from(e.target.files); e.target.value = ''; // FileList 是活的，清空 value 前先複製
    if (files.length) await openWorkspace(new FilesWorkspace(files));
  };
  safely('版本', initVersion);
  safely('轉換參數', initParams);
  safely('日期', () => { $('inDate').value = today(); });
  if (!hasFsa()) $('browserNotice').classList.remove('hidden');
  $('selCase').onchange = () => {
    const entry = st.found.cases.find((x) => x.name === $('selCase').value);
    if (entry) selectCase(entry);
  };
  document.querySelectorAll('input[name=ver]').forEach((r) => { r.onchange = () => { if (st.caseEntry) selectCase(st.caseEntry); }; });
  $('btnQgz').onclick = pickQgzManually;
  $('qgzInp').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    st.manualQgz = {
      name: f.name,
      read: async () => new Uint8Array(await f.arrayBuffer()),
      backup: async (b) => download(`${f.name}.bak`, b),
      write: async (b) => download(f.name, b),
    };
    renderQgz();
  };
  $('selQgz').onchange = () => { if ($('selQgz').value !== '__manual__') st.manualQgz = null; };
  $('btnOut').onclick = pickOutDir;
  document.querySelectorAll('input[name=scope]').forEach((r) => {
    r.onchange = () => $('parcelBox').classList.toggle('hidden', radio('scope') !== 'one');
  });
  $('inSearch').oninput = renderParcels;
  $('selParcel').onchange = syncSelection;
  $('btnAll').onclick = () => { for (const l of st.displayed) st.selected.add(l); renderParcels(); };
  $('btnNone').onclick = () => { st.selected.clear(); renderParcels(); };
  $('btnRun').onclick = onRun;

  if (hasFsa()) {
    loadHandle('root').then((h) => {
      if (!h) return;
      const b = $('btnLast');
      b.textContent = `↻ 開啟上次的資料夾（${h.name}）`;
      b.classList.remove('hidden');
      b.onclick = openLast;
    }).catch(() => {});
  }
  safely('座標系', updateCrsWarn);
}

// 任何沒被接住的錯誤都顯示在「紀錄」區，不要讓使用者面對沒反應的畫面
window.addEventListener('error', (e) => log(`❌ 發生錯誤：${e.message}`));
window.addEventListener('unhandledrejection', (e) => log(`❌ 發生錯誤：${(e.reason && e.reason.message) || e.reason}`));

init();
