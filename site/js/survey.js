// 複丈案件資料處理核心邏輯：讀取 D 系列檔案 -> 建立點/線/面圖層定義。
//
// 檔案對應關係（依實際案件資料驗證，並經使用者確認新舊圖對應方向）：
//   ── 新圖／現況（預設）──
//   D14 = 界址點/參考點座標（COT_REF='0' 為界址點，其餘為參考點，小數點編碼）
//   D21 = 地籍圖線段拓樸（含 L/R 地號）
//   D13 = 宗地界址點序列（每筆最多 8 個點號，同地號可跨多筆記錄接續）
//   D11 = 宗地面積/地目等屬性（依 SECTION_O + PAR_O_M/PAR_O_C 對照），僅新圖適用
//   ── 舊圖（使用者可於 UI 切換）──
//   D2C = 界址點/參考點座標（格式同 D14）
//   D2D = 地籍圖線段拓樸（格式同 D21）
//   D2B = 宗地界址點序列（格式同 D13）
//   ── 兩者皆有（不受新舊圖切換影響）──
//   D29 = 參考線（LIN_TOP/BOT/MID 為文字型態，格式如 "90.7"）
//   D20 = 補點（Q 開頭補樁點，無地號歸屬）
//
// 座標：預設視為 TWD97 / TM2 zone 121 (EPSG:3826)；若案件是 TWD67，由 twd.js 在讀入後轉換。
import { readDbfRecords } from './dbf.js';
import { wkbPoint, wkbLinestring, wkbPolygon } from './gpkg.js';
import { toFloat, toInt, normKey, normKeySafe } from './util.js';

export class CaseNotFoundError extends Error {}
export class ParcelNotFoundError extends Error {}

const pkey = (sec, m, c) => `${sec}|${m}|${c}`;
const parsePkey = (k) => k.split('|').map(Number);

/** files：資料夾內的檔名清單。找 XX####.D14，回傳 {prefix, segNum, baseName}。 */
export function detectCase(fileNames) {
  const pat = /^([A-Za-z]+)(\d+)\.D14$/i;
  for (const fn of [...fileNames].sort()) {
    const m = pat.exec(fn);
    if (m) return { prefix: m[1].toUpperCase(), segNum: m[2], baseName: m[1].toUpperCase() + m[2] };
  }
  throw new CaseNotFoundError('資料夾內找不到 .D14 檔案，請確認選擇的是複丈案件資料夾（例如 KC0391）');
}

/**
 * source：{ names:[檔名...], read(name) -> Promise<Uint8Array|null> }（檔名比對不分大小寫）。
 */
async function readOpt(source, baseName, ext) {
  const want = `${baseName}.${ext}`.toLowerCase();
  const actual = source.names.find((n) => n.toLowerCase() === want);
  if (!actual) return [];
  try {
    const bytes = await source.read(actual);
    return bytes ? readDbfRecords(bytes) : [];
  } catch (_e) {
    return [];
  }
}

export async function hasOldMapData(source) {
  const { baseName } = detectCase(source.names);
  for (const ext of ['D2B', 'D2C', 'D2D']) {
    if ((await readOpt(source, baseName, ext)).length) return true;
  }
  return false;
}

/** useOldMap=false（預設）：D14/D21/D13/D11（新圖）；true：D2C/D2D/D2B（舊圖，無面積/地目）。 */
export async function loadCase(source, caseId, useOldMap = false) {
  const { baseName } = detectCase(source.names);
  const ptExt = useOldMap ? 'D2C' : 'D14';
  const lineExt = useOldMap ? 'D2D' : 'D21';
  const ringExt = useOldMap ? 'D2B' : 'D13';

  let ptRecords;
  if (useOldMap) {
    ptRecords = await readOpt(source, baseName, ptExt);
  } else {
    const actual = source.names.find((n) => n.toLowerCase() === `${baseName}.${ptExt}`.toLowerCase());
    ptRecords = readDbfRecords(await source.read(actual));
  }

  const mainPts = new Map(); const subPts = new Map(); const mainRows = new Map(); const subRows = new Map();
  for (const r of ptRecords) {
    const x = toFloat(r.COT_X); const y = toFloat(r.COT_Y);
    if (x === null || y === null) continue;
    const ref = (r.COT_REF || '0').trim();
    const num = r.COT_NUMBER;
    if (num === undefined || num === null || num === '') continue;
    if (!/^[+-]?\d+$/.test(String(num).trim())) continue; // 對齊舊版 int(str)：非整數字串略過
    const numKey = normKey(num);
    if (ref === '0' || ref === '') {
      mainPts.set(numKey, [x, y]);
      mainRows.set(numKey, r);
    } else {
      const refI = toInt(ref);
      if (refI === null) continue;
      const subKey = `${numKey}.${refI}`;
      subPts.set(subKey, [x, y]);
      subRows.set(subKey, r);
    }
  }

  const lines = await readOpt(source, baseName, lineExt);
  const refLines = await readOpt(source, baseName, 'D29');
  const supplements = await readOpt(source, baseName, 'D20');
  const ringRecords = await readOpt(source, baseName, ringExt);

  const parcelRings = new Map();
  for (const r of ringRecords) {
    const sec = toInt(r.O_SECTION); const m = toInt(r.O_PARCEL); const c = toInt(r.O_PARCEL_E);
    if (sec === null || m === null) continue;
    const key = pkey(sec, m, c || 0);
    if (!parcelRings.has(key)) parcelRings.set(key, []);
    const seq = parcelRings.get(key);
    for (let i = 1; i <= 8; i++) {
      const pid = toInt(r[`COORD_${i}`]);
      if (!pid) continue;
      seq.push(String(pid));
    }
  }

  const parcelAreas = new Map();
  if (!useOldMap) {
    for (const r of await readOpt(source, baseName, 'D11')) {
      const sec = toInt(r.SECTION_O); const m = toInt(r.PAR_O_M); const c = toInt(r.PAR_O_C);
      if (sec === null || m === null) continue;
      parcelAreas.set(pkey(sec, m, c || 0), {
        AREA_HA: toFloat(r.AREA_NEW) || toFloat(r.AREA_OLD),
        CATE: (r.CATE_NEW || r.CATE_OLD || '').trim(),
      });
    }
  }

  return {
    caseId, baseName, dataVersion: useOldMap ? 'old' : 'new',
    mainPts, subPts, mainRows, subRows, lines, refLines, supplements, parcelRings, parcelAreas,
  };
}

/** 回傳 [{key, label}] 依地號排序。 */
export function listParcels(c) {
  const keys = [...c.parcelRings.keys()].map(parsePkey);
  const single = new Set(keys.map((k) => k[0])).size <= 1;
  keys.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return keys.map(([sec, m, ch]) => {
    const pno = ch ? `${m}-${ch}` : String(m);
    return { key: pkey(sec, m, ch), label: single ? pno : `${pno}（段${sec}）` };
  });
}

function parcelPointIdSet(c, key) {
  const [sec, m, ch] = parsePkey(key);
  const ids = new Set();
  for (const r of c.lines) {
    const lMatch = toInt(r.L_SECTION) === sec && toInt(r.L_PARCEL) === m && (toInt(r.L_PARCEL_E) || 0) === ch;
    const rMatch = toInt(r.R_SECTION) === sec && toInt(r.R_PARCEL) === m && (toInt(r.R_PARCEL_E) || 0) === ch;
    if (lMatch || rMatch) {
      for (const f of ['LIN_TOP', 'LIN_MID', 'LIN_BOT']) {
        const v = toInt(r[f]);
        if (v) ids.add(String(v));
      }
    }
  }
  for (const id of c.parcelRings.get(key) || []) ids.add(id); // 併入宗地邊界序列本身的點號
  return ids;
}

/**
 * 查找 D29 參考線端點座標。小數點編碼（如 '211.80'）只能對應到 subPts 裡完全相同的參考點，
 * 找不到就回傳 null（該線段被跳過），不可退回連到小數點前的主點座標（FG0518 案件實測的交叉打結問題）。
 */
function lookupRefPoint(c, keyStr) {
  const k = (keyStr || '').trim();
  if (!k || k === '0') return null;
  if (k.includes('.')) {
    const i = k.indexOf('.');
    const baseI = toInt(k.slice(0, i)); const subI = toInt(k.slice(i + 1));
    if (baseI === null || !subI) return null;
    return c.subPts.get(`${baseI}.${subI}`) || null;
  }
  const v = toInt(k);
  return v === null ? null : (c.mainPts.get(String(v)) || null);
}

const CASE_ID_ATTR = ['CASE_ID', 'TEXT'];
const bboxOf = (pts) => {
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

/**
 * 建立圖層定義。parcelKeys=null 輸出全部；否則為地號 key 陣列。
 * includeRefs 控制補點/參考點/參考線（不受地號篩選影響，全有或全無）。
 */
export function buildLayers(c, { parcelKeys = null, includeRefs = true, caseIdTag = null } = {}) {
  let filterIds = null; let keySet = null;
  if (parcelKeys !== null) {
    keySet = new Set(parcelKeys);
    filterIds = new Set();
    for (const k of parcelKeys) for (const id of parcelPointIdSet(c, k)) filterIds.add(id);
  }
  const layers = [];

  // 界址點
  const ptRows = [];
  for (const [numKey, [x, y]] of c.mainPts) {
    if (filterIds !== null && !filterIds.has(numKey)) continue;
    const r = c.mainRows.get(numKey) || {};
    ptRows.push({
      geom: wkbPoint(x, y), _bbox: [x, y, x, y],
      COT_NUMBER: toInt(numKey), COT_Y: y, COT_X: x,
      COT_MATTER: toInt(r.COT_MATTER), COT_SOURCE: toInt(r.COT_SOURCE),
      COT_REMARK: (r.COT_REMARK || '').trim(), CASE_ID: caseIdTag,
    });
  }
  layers.push({
    name: '界址點', geomType: 'POINT',
    attrs: [['COT_NUMBER', 'INTEGER'], ['COT_Y', 'REAL'], ['COT_X', 'REAL'], ['COT_MATTER', 'INTEGER'],
      ['COT_SOURCE', 'INTEGER'], ['COT_REMARK', 'TEXT'], CASE_ID_ATTR],
    rows: ptRows,
  });

  // 參考點
  const subOut = [];
  if (includeRefs) {
    for (const [subKey, [x, y]] of c.subPts) {
      const r = c.subRows.get(subKey) || {};
      subOut.push({
        geom: wkbPoint(x, y), _bbox: [x, y, x, y],
        PT_ID: subKey, COT_Y: y, COT_X: x, COT_SOURCE: toInt(r.COT_SOURCE), CASE_ID: caseIdTag,
      });
    }
  }
  layers.push({
    name: '參考點', geomType: 'POINT',
    attrs: [['PT_ID', 'TEXT'], ['COT_Y', 'REAL'], ['COT_X', 'REAL'], ['COT_SOURCE', 'INTEGER'], CASE_ID_ATTR],
    rows: subOut,
  });

  // 補點
  const suppRows = [];
  if (includeRefs) {
    for (const r of c.supplements) {
      const x = toFloat(r.CTL_X); const y = toFloat(r.CTL_Y);
      const name = (r.CTL_NAME || '').trim();
      if (x === null || y === null || !name) continue;
      suppRows.push({
        geom: wkbPoint(x, y), _bbox: [x, y, x, y],
        CTL_NAME: name, CTL_Y: y, CTL_X: x, CTL_LEVEL: (r.CTL_LEVEL || '').trim(),
        STATE: '?', // 現況狀態：0=良好 ?=未知 x=已回報找不到，預設未知，待現場查核後手動更新
        CASE_ID: caseIdTag,
      });
    }
  }
  layers.push({
    name: '補點', geomType: 'POINT',
    // STATE 帶 DEFAULT '?'：既有資料表用 ALTER TABLE 補欄位時，舊資料也會回填 '?' 而非 NULL
    attrs: [['CTL_NAME', 'TEXT'], ['CTL_Y', 'REAL'], ['CTL_X', 'REAL'], ['CTL_LEVEL', 'TEXT'],
      ['STATE', "TEXT DEFAULT '?'"], CASE_ID_ATTR],
    rows: suppRows,
  });

  // 地籍線（單一圖層，L_SEC/R_SEC 區分段別）
  const lineRows = [];
  for (const r of c.lines) {
    const lSec = toInt(r.L_SECTION); const rSec = toInt(r.R_SECTION);
    const top = c.mainPts.get(normKeySafe(r.LIN_TOP)); const bot = c.mainPts.get(normKeySafe(r.LIN_BOT));
    if (!top || !bot) continue;
    if (keySet !== null) {
      const lMatch = keySet.has(pkey(lSec, toInt(r.L_PARCEL), toInt(r.L_PARCEL_E) || 0));
      const rMatch = keySet.has(pkey(rSec, toInt(r.R_PARCEL), toInt(r.R_PARCEL_E) || 0));
      if (!(lMatch || rMatch)) continue;
    }
    let pts = [top, bot];
    const midId = normKeySafe(r.LIN_MID);
    if (midId && midId !== '0') {
      const mid = c.mainPts.get(midId);
      if (mid) pts = [top, mid, bot];
    }
    lineRows.push({
      geom: wkbLinestring(pts), _bbox: bboxOf(pts),
      L_SEC: lSec, L_PAR: toInt(r.L_PARCEL), R_SEC: rSec, R_PAR: toInt(r.R_PARCEL),
      LIN_MODE: toInt(r.LIN_MODE), CASE_ID: caseIdTag,
    });
  }
  layers.push({
    name: '地籍線', geomType: 'LINESTRING',
    attrs: [['L_SEC', 'INTEGER'], ['L_PAR', 'INTEGER'], ['R_SEC', 'INTEGER'], ['R_PAR', 'INTEGER'],
      ['LIN_MODE', 'INTEGER'], CASE_ID_ATTR],
    rows: lineRows,
  });

  // 參考線
  const refRows = [];
  if (includeRefs) {
    for (const r of c.refLines) {
      const top = lookupRefPoint(c, r.LIN_TOP); const bot = lookupRefPoint(c, r.LIN_BOT);
      if (!top || !bot) continue;
      let pts = [top, bot];
      const midKey = (r.LIN_MID || '').trim();
      if (midKey && midKey !== '0') {
        const mid = lookupRefPoint(c, midKey);
        if (mid) pts = [top, mid, bot];
      }
      refRows.push({
        geom: wkbLinestring(pts), _bbox: bboxOf(pts),
        L_TOP: (r.LIN_TOP || '').trim(), L_BOT: (r.LIN_BOT || '').trim(),
        LIN_MODE: toInt(r.LIN_MODE), CASE_ID: caseIdTag,
      });
    }
  }
  layers.push({
    name: '參考線', geomType: 'LINESTRING',
    attrs: [['L_TOP', 'TEXT'], ['L_BOT', 'TEXT'], ['LIN_MODE', 'INTEGER'], CASE_ID_ATTR],
    rows: refRows,
  });

  // 宗地（面）
  const parRows = [];
  const ringKeys = parcelKeys !== null ? parcelKeys : [...c.parcelRings.keys()];
  for (const key of ringKeys) {
    const ring = [];
    for (const pid of c.parcelRings.get(key) || []) {
      const pt = c.mainPts.get(pid) || lookupRefPoint(c, pid);
      if (pt) ring.push(pt);
    }
    if (ring.length < 3) continue;
    const [sec, m, ch] = parsePkey(key);
    const area = c.parcelAreas.get(key) || {};
    parRows.push({
      geom: wkbPolygon(ring), _bbox: bboxOf(ring),
      SECTION: sec, MOTHER: m, CHILD: ch, PARCEL_NO: ch ? `${m}-${ch}` : String(m),
      AREA_HA: area.AREA_HA === undefined ? null : area.AREA_HA, CATE: area.CATE || '', CASE_ID: caseIdTag,
    });
  }
  layers.push({
    name: '宗地', geomType: 'POLYGON',
    attrs: [['SECTION', 'INTEGER'], ['MOTHER', 'INTEGER'], ['CHILD', 'INTEGER'], ['PARCEL_NO', 'TEXT'],
      ['AREA_HA', 'REAL'], ['CATE', 'TEXT'], CASE_ID_ATTR],
    rows: parRows,
  });

  return layers;
}
