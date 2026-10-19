// TWD67 -> TWD97 座標轉換。
//
// 轉換參數＝一份 INP 控制點檔：每行「點名 類型 TWD97北 TWD97東 TWD67北 TWD67東」
// （前 2 欄 TWD97、後 2 欄 TWD67 公告座標；只有 2 欄座標的點不能當控制點，自動略過）。
// 程式用這些共同點以最小二乘擬合出 TWD67 -> TWD97 的轉換，並回報殘差。
// 座標一律在「東(E)、北(N)」下計算，且先減去控制點重心，避免大數值造成的數值誤差。

export const MODELS = {
  affine: '6 參數仿射（最小二乘）',
  helmert: '4 參數相似轉換',
  shift: '僅平移',
};

const LS_KEY = 'kc.twdParams.v1';
const LS_SELECTED = 'kc.twdParams.selected';

// ── INP 解析 ───────────────────────────────────────────────
/** 回傳 {pairs:[{name,n97,e97,n67,e67}], skipped:number}。 */
export function parseInp(text) {
  const pairs = [];
  let skipped = 0;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.replace(/,/g, ' ').trim();
    if (!line) continue;
    const t = line.split(/\s+/);
    if (t.length < 6) { skipped++; continue; } // 點名 類型 N E（只有一組座標）
    const nums = t.slice(-4).map(Number);
    if (!nums.every(Number.isFinite)) { skipped++; continue; }
    let [a1, b1, a2, b2] = nums;
    // 預期順序是 北、東；若欄位順序相反（第一欄 < 100 萬）就對調
    if (a1 < 1e6 && b1 > 1e6) [a1, b1] = [b1, a1];
    if (a2 < 1e6 && b2 > 1e6) [a2, b2] = [b2, a2];
    // 台灣 TM2 座標：北約 2,000,000～3,000,000、東約 0～1,000,000；不合理的列不能當控制點
    if (![a1, a2].every((n) => n > 2e6 && n < 3e6) || ![b1, b2].every((e) => e > 0 && e < 1e6)) { skipped++; continue; }
    pairs.push({ name: t[0], n97: a1, e97: b1, n67: a2, e67: b2 });
  }
  return { pairs, skipped };
}

// ── 擬合 ──────────────────────────────────────────────────
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

function fitCore(pairs, model) {
  const e0 = mean(pairs.map((p) => p.e67));
  const n0 = mean(pairs.map((p) => p.n67));
  const E0 = mean(pairs.map((p) => p.e97));
  const N0 = mean(pairs.map((p) => p.n97));
  const de = pairs.map((p) => p.e67 - e0);
  const dn = pairs.map((p) => p.n67 - n0);
  const te = pairs.map((p) => p.e97 - E0);
  const tn = pairs.map((p) => p.n97 - N0);
  const sum = (f) => { let s = 0; for (let i = 0; i < pairs.length; i++) s += f(i); return s; };

  const Sxx = sum((i) => de[i] * de[i]);
  const Syy = sum((i) => dn[i] * dn[i]);
  const Sxy = sum((i) => de[i] * dn[i]);

  if (model === 'affine') {
    const det = Sxx * Syy - Sxy * Sxy;
    if (pairs.length < 3 || !(det > 1e-4 * (Sxx + Syy) * (Sxx + Syy))) return null; // 共線或點數不足
    const solve = (rx, ry) => [(rx * Syy - ry * Sxy) / det, (Sxx * ry - Sxy * rx) / det];
    const [a1, a2] = solve(sum((i) => de[i] * te[i]), sum((i) => dn[i] * te[i]));
    const [b1, b2] = solve(sum((i) => de[i] * tn[i]), sum((i) => dn[i] * tn[i]));
    return { e0, n0, E0, N0, m: [a1, a2, b1, b2] }; // e' = E0 + a1*de + a2*dn ; n' = N0 + b1*de + b2*dn
  }
  if (model === 'helmert') {
    const den = Sxx + Syy;
    if (pairs.length < 2 || !(den > 1e-6)) return null;
    const a = sum((i) => de[i] * te[i] + dn[i] * tn[i]) / den;
    const b = sum((i) => de[i] * tn[i] - dn[i] * te[i]) / den;
    return { e0, n0, E0, N0, m: [a, -b, b, a] }; // e' = E0 + a*de - b*dn ; n' = N0 + b*de + a*dn
  }
  return { e0, n0, E0, N0, m: [1, 0, 0, 1] };
}

/**
 * 以控制點擬合 TWD67 -> TWD97。點數或分佈不足時依序退回 4 參數、僅平移，並在 note 說明。
 * 回傳 {model, requested, note, n, rms, max, apply(e,n)->[E,N], control:[{name,e67,n67,e97,n97,dE,dN}]}
 */
export function fitTransform(pairs, requested = 'affine') {
  if (!pairs || pairs.length === 0) throw new Error('參數內沒有可用的控制點（需要有 TWD97 與 TWD67 兩組座標的點）');
  const order = requested === 'affine' ? ['affine', 'helmert', 'shift']
    : requested === 'helmert' ? ['helmert', 'shift'] : ['shift'];
  let model = null; let core = null;
  for (const m of order) {
    core = fitCore(pairs, m);
    if (core) { model = m; break; }
  }
  const { e0, n0, E0, N0, m } = core;
  const apply = (e, n) => {
    const de = e - e0; const dn = n - n0;
    return [E0 + m[0] * de + m[1] * dn, N0 + m[2] * de + m[3] * dn];
  };
  let ss = 0; let max = 0;
  const control = pairs.map((p) => {
    const [E, N] = apply(p.e67, p.n67);
    const dE = E - p.e97; const dN = N - p.n97;
    const d = Math.hypot(dE, dN);
    ss += d * d; if (d > max) max = d;
    return { name: p.name, e67: p.e67, n67: p.n67, e97: p.e97, n97: p.n97, dE, dN, d };
  });
  const note = model === requested ? '' : `控制點不足或共線，已由「${MODELS[requested]}」退回「${MODELS[model]}」`;
  return { model, requested, note, n: pairs.length, rms: Math.sqrt(ss / pairs.length), max, apply, control };
}

// ── 套用到案件資料 ─────────────────────────────────────────
const isNorthing = (v) => v > 1e6;

/** 依數值大小判斷 (a,b) 哪個是北、哪個是東，轉換後保持原本的欄位順序。 */
export function transformPair(fit, a, b) {
  let e; let n; let swap;
  if (isNorthing(a) && !isNorthing(b)) { n = a; e = b; swap = true; }
  else if (!isNorthing(a) && isNorthing(b)) { e = a; n = b; swap = false; }
  else throw new Error(`座標 (${a}, ${b}) 不像 TWD67 TM2 座標（北約 2,400,000～2,800,000、東約 100,000～350,000）`);
  const [E, N] = fit.apply(e, n);
  return swap ? [N, E] : [E, N];
}

/**
 * 把案件的點位（界址點、參考點、補點）由 TWD67 轉成 TWD97，就地修改 case。
 * exact=true 時，座標與控制點的 TWD67 座標相符（±0.5 mm）的點直接採用公告的 TWD97 值。
 * 回傳統計：{points, exact, outside, warnings:[...]}
 */
export function convertCase(caseData, fit, { exact = true } = {}) {
  const exactMap = new Map();
  if (exact) {
    for (const c of fit.control) exactMap.set(`${Math.round(c.e67 * 1000)},${Math.round(c.n67 * 1000)}`, [c.e97, c.n97]);
  }
  const eMin = Math.min(...fit.control.map((c) => c.e67)) - 1000;
  const eMax = Math.max(...fit.control.map((c) => c.e67)) + 1000;
  const nMin = Math.min(...fit.control.map((c) => c.n67)) - 1000;
  const nMax = Math.max(...fit.control.map((c) => c.n67)) + 1000;
  const stats = { points: 0, exact: 0, outside: 0, warnings: [] };

  const conv = (a, b) => {
    let e; let n; let swap;
    if (isNorthing(a) && !isNorthing(b)) { n = a; e = b; swap = true; } else if (!isNorthing(a) && isNorthing(b)) { e = a; n = b; swap = false; } else {
      throw new Error(`座標 (${a}, ${b}) 不像 TWD67 TM2 座標，請確認案件座標系選對了`);
    }
    stats.points++;
    if (e < eMin || e > eMax || n < nMin || n > nMax) stats.outside++;
    let E; let N;
    const hit = exactMap.get(`${Math.round(e * 1000)},${Math.round(n * 1000)}`);
    if (hit) { [E, N] = hit; stats.exact++; } else [E, N] = fit.apply(e, n);
    return swap ? [N, E] : [E, N];
  };

  const convMap = (m, rows) => {
    for (const [k, [x, y]] of m) {
      const [nx, ny] = conv(x, y);
      m.set(k, [nx, ny]);
    }
    return rows;
  };
  convMap(caseData.mainPts);
  convMap(caseData.subPts);
  let badSupp = 0;
  for (const r of caseData.supplements) {
    const x = Number(r.CTL_X); const y = Number(r.CTL_Y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || r.CTL_X === '' || r.CTL_Y === '') continue;
    if (isNorthing(x) === isNorthing(y)) { badSupp++; continue; } // 補點表的雜列（座標不合理）：不轉換、保留原值
    const [nx, ny] = conv(x, y);
    r.CTL_X = String(nx); r.CTL_Y = String(ny);
  }
  if (badSupp > 0) stats.warnings.push(`補點有 ${badSupp} 列座標不像 TM2 座標，未轉換`);

  if (stats.outside > 0) {
    stats.warnings.push(`${stats.outside} 個點位超出控制點範圍 1 km 以上，屬外插，精度會較差`);
  }
  return stats;
}

/** 轉換前檢查：回傳警告字串陣列（資料看起來已是 TWD97、或離控制點太遠）。 */
export function sanityCheck(caseData, pairs) {
  const warns = [];
  const pts = [...caseData.mainPts.values()];
  if (pts.length === 0 || pairs.length === 0) return warns;
  const split = (a, b) => (isNorthing(a) ? [b, a] : [a, b]); // -> [e, n]
  const es = []; const ns = [];
  for (const [a, b] of pts) { const [e, n] = split(a, b); es.push(e); ns.push(n); }
  const ce = mean(es); const cn = mean(ns);
  const d67 = Math.hypot(ce - mean(pairs.map((p) => p.e67)), cn - mean(pairs.map((p) => p.n67)));
  const d97 = Math.hypot(ce - mean(pairs.map((p) => p.e97)), cn - mean(pairs.map((p) => p.n97)));
  if (d67 > 20000) {
    warns.push(`案件位置離這組參數的控制點約 ${(d67 / 1000).toFixed(1)} km，可能選錯參數`);
  } else if (d97 + 100 < d67) {
    warns.push(`案件座標比較接近這組參數的 TWD97 座標（差 ${d97.toFixed(0)} m，TWD67 則差 ${d67.toFixed(0)} m），資料可能已經是 TWD97，請確認案件座標系`);
  }
  return warns;
}

// ── 參數庫（localStorage；失敗時退回記憶體）─────────────────
export class ParamStore {
  constructor(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    this.storage = storage;
    this.sets = [];
    this.selected = null;
    this.load();
  }

  load() {
    try {
      const raw = this.storage && this.storage.getItem(LS_KEY);
      this.sets = raw ? JSON.parse(raw) : [];
      this.selected = (this.storage && this.storage.getItem(LS_SELECTED)) || null;
    } catch (_e) {
      this.sets = [];
    }
    if (!Array.isArray(this.sets)) this.sets = [];
    if (this.selected && !this.sets.some((s) => s.id === this.selected)) this.selected = null;
  }

  save() {
    try {
      if (!this.storage) return true;
      this.storage.setItem(LS_KEY, JSON.stringify(this.sets));
      if (this.selected) this.storage.setItem(LS_SELECTED, this.selected);
      else this.storage.removeItem(LS_SELECTED);
      return true;
    } catch (_e) {
      return false; // 私密視窗／容量滿：本次工作階段仍可用
    }
  }

  list() { return this.sets; }
  get(id) { return this.sets.find((s) => s.id === id) || null; }

  /** 同名參數視為更新。回傳 'added' | 'updated'。 */
  upsert({ name, pairs, model = 'affine', exact = true }) {
    const slim = pairs.map((p) => [p.name, p.n97, p.e97, p.n67, p.e67]);
    const cur = this.sets.find((s) => s.name === name);
    if (cur) {
      Object.assign(cur, { pairs: slim, model, exact, updated: Date.now() });
      this.save();
      return 'updated';
    }
    const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.sets.push({ id, name, pairs: slim, model, exact, updated: Date.now() });
    this.sets.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    this.save();
    return 'added';
  }

  patch(id, fields) {
    const s = this.get(id);
    if (!s) return;
    Object.assign(s, fields);
    this.save();
  }

  remove(id) {
    this.sets = this.sets.filter((s) => s.id !== id);
    if (this.selected === id) this.selected = null;
    this.save();
  }

  select(id) {
    this.selected = id || null;
    this.save();
  }

  static pairsOf(set) {
    return set.pairs.map(([name, n97, e97, n67, e67]) => ({ name, n97, e97, n67, e67 }));
  }

  fitOf(set) {
    return fitTransform(ParamStore.pairsOf(set), set.model || 'affine');
  }

  exportJson() {
    return JSON.stringify({ kind: 'kc-twd-params', version: 1, sets: this.sets }, null, 1);
  }

  /** 匯入整包設定（匯出的 JSON）。回傳新增/更新筆數。 */
  importJson(text) {
    const data = JSON.parse(text);
    if (!data || data.kind !== 'kc-twd-params' || !Array.isArray(data.sets)) throw new Error('不是本工具匯出的轉換參數設定檔');
    let added = 0; let updated = 0;
    for (const s of data.sets) {
      if (!s.name || !Array.isArray(s.pairs)) continue;
      const pairs = s.pairs.map(([name, n97, e97, n67, e67]) => ({ name, n97, e97, n67, e67 }));
      const r = this.upsert({ name: s.name, pairs, model: s.model || 'affine', exact: s.exact !== false });
      if (r === 'added') added++; else updated++;
    }
    return { added, updated };
  }
}

export function baseName(fileName) {
  return fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
}
