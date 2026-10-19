// 整合流程：讀取案件 -> 建圖層 -> 寫入彙整 GPKG -> 確保 QGZ 固定圖層存在。
//
// 輸出的圖層是固定、持續累積的彙整圖層（界址點/參考點/補點/地籍線/參考線/宗地），
// 每筆資料都標記 CASE_ID（{案號}-{民國年}-{月}-{日}，舊圖加「-舊」），
// 同一 CASE_ID 重跑時先刪除舊資料再寫入，避免重複累積。
import { buildLayers, ParcelNotFoundError } from './survey.js';
import { upsertGpkg } from './gpkg.js';
import { readQgz, writeQgz, ensureLayers, buildLayerSpecs } from './qgz.js';

export const MASTER_GPKG_NAME = '複丈歷史.gpkg';
export const GPKG_REL_PATH = `./複丈歷史/${MASTER_GPKG_NAME}`;

export class ExportAbortedError extends Error {}

const D14 = /^[A-Za-z]+\d+\.D14$/i;

/**
 * 判斷選到的是「案件資料夾」還是「專案根目錄」。
 * 回傳 {mode:'case'|'root', cases:[{name, parts}], qgis:{dirParts, qgz:[檔名...]}|null}
 */
export async function findCases(ws) {
  const top = await ws.listDir([]);
  if (top.some((e) => e.kind === 'file' && D14.test(e.name))) {
    return { mode: 'case', cases: [{ name: ws.name, parts: [] }], qgis: null };
  }
  const cases = [];
  for (const e of top) {
    if (e.kind !== 'directory' || e.name.toLowerCase() === 'qgis' || !/^[A-Za-z]+\d+/.test(e.name)) continue;
    try {
      const inner = await ws.listDir([e.name]);
      if (inner.some((f) => f.kind === 'file' && D14.test(f.name))) cases.push({ name: e.name, parts: [e.name] });
    } catch (_e) { /* 無法讀取的資料夾略過 */ }
  }
  cases.sort((a, b) => a.name.localeCompare(b.name));
  let qgis = null;
  const q = top.find((e) => e.kind === 'directory' && e.name.toLowerCase() === 'qgis');
  if (q) {
    const inner = await ws.listDir([q.name]);
    qgis = {
      dirParts: [q.name],
      qgz: inner.filter((f) => f.kind === 'file' && f.name.toLowerCase().endsWith('.qgz')).map((f) => f.name),
    };
  }
  return { mode: 'root', cases, qgis };
}

/** '2026-08-20' -> '115-08-20'（民國年 = 西元年 - 1911）。輸入格式不符時原樣回傳。 */
export function toRocDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dateStr || '').trim());
  if (!m) return dateStr;
  return `${Number(m[1]) - 1911}-${m[2]}-${m[3]}`;
}

/** '{案號}-{民國年}-{月}-{日}'；舊圖加 '-舊' 後綴，讓同案件同一天的新舊圖能並存。 */
export function makeCaseId(caseId, dateStr, dataVersion = 'new') {
  return `${caseId}-${toRocDate(dateStr)}${dataVersion === 'old' ? '-舊' : ''}`;
}

/**
 * 執行匯出。parcelKeys=null 表示全部；includeRefs 控制補點/參考點/參考線（全有或全無）。
 * io：{ gpkg:{read(),write(bytes)}, qgz:null | {read(),write(bytes),backup(bytes),name} }
 * libs：{ SQL, JSZip }
 */
export async function runExport(c, { parcelKeys, dateStr, includeRefs }, io, libs, log = () => {}) {
  if (parcelKeys !== null) {
    const missing = parcelKeys.filter((k) => !c.parcelRings.has(k));
    if (missing.length) throw new ParcelNotFoundError(`地號 ${missing.join('、')} 不存在於案件資料中`);
  }
  const tag = makeCaseId(c.caseId, dateStr, c.dataVersion);
  const layers = buildLayers(c, { parcelKeys, includeRefs, caseIdTag: tag });
  const total = layers.reduce((s, l) => s + l.rows.length, 0);
  if (total === 0) {
    throw new ExportAbortedError(`${parcelKeys !== null ? '所選地號' : '此案件'}查無任何有效點/線/面幾何資料，已中止輸出（不會產生空的 GPKG）`);
  }

  const existing = await io.gpkg.read();
  const { bytes, written } = upsertGpkg(libs.SQL, existing, layers, tag);
  await io.gpkg.write(bytes);
  log(`已寫入彙整 GPKG（案件標記：${tag}）`);
  for (const l of layers) if (l.rows.length) log(`  ${l.name}：${l.rows.length} 筆`);

  let qgzName = null;
  if (io.qgz) {
    const orig = await io.qgz.read();
    await io.qgz.backup(orig);
    log(`已備份原專案檔（${io.qgz.name}.bak）`);
    const { qgsName, qgsText, other } = await readQgz(libs.JSZip, orig);
    const specs = buildLayerSpecs(layers.filter((l) => written.includes(l.name)));
    const { text, newlyAdded } = ensureLayers(qgsText, specs, GPKG_REL_PATH);
    await io.qgz.write(await writeQgz(libs.JSZip, qgsName, text, other));
    log(newlyAdded.length
      ? `已更新 QGIS 專案（複丈歷史 群組新增圖層：${newlyAdded.join('、')}）`
      : '已更新 QGIS 專案（複丈歷史 群組圖層已存在，資料已透過 GPKG 更新）');
    qgzName = io.qgz.name;
  }

  return {
    caseIdTag: tag, qgzName,
    layerCounts: Object.fromEntries(layers.filter((l) => l.rows.length).map((l) => [l.name, l.rows.length])),
  };
}
