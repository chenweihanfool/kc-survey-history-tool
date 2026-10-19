import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeFixture, dirSource } from './helpers.mjs';
import { parseInp, fitTransform, convertCase, sanityCheck, transformPair, ParamStore } from '../site/js/twd.js';
import { loadCase } from '../site/js/survey.js';
import { isNewer } from '../site/js/update.js';

// 已知的 TWD67 -> TWD97：平移 + 微小旋轉縮放（仿射），用來驗證擬合能還原參數
const TRUE = (e, n) => [e + 829.073 + 2e-6 * (e - 217000) - 1e-5 * (n - 2709000), n - 205.223 + 1e-5 * (e - 217000) + 3e-6 * (n - 2709000)];

function inpText(points) {
  return points.map(([name, e67, n67], i) => {
    const [e97, n97] = TRUE(e67, n67);
    return `${name.padEnd(8)} 1 ${n97.toFixed(3).padStart(14)} ${e97.toFixed(3).padStart(14)} ${n67.toFixed(3).padStart(14)} ${e67.toFixed(3).padStart(14)}`;
  }).join('\r\n');
}

const CTRL = [['A1', 216500, 2708500], ['A2', 217900, 2708700], ['A3', 218400, 2709300], ['A4', 217100, 2709600], ['A5', 216800, 2709000], ['A6', 217600, 2708950]];

test('parseInp：欄位順序、單組座標略過、BOM/逗號', () => {
  const text = `﻿${inpText(CTRL)}\r\nN114026  8    2709412.362     218175.238\r\n\r\nbad line\r\nX 1 1,2,3,4`;
  const { pairs, skipped } = parseInp(text);
  assert.equal(pairs.length, 6);
  assert.equal(skipped, 3); // 單組座標、bad line、座標不合理的 X 行
});

test('parseInp：北東欄位順序相反時自動對調', () => {
  const { pairs } = parseInp('P1 1 218785.951 2709376.350 217956.883 2709581.598');
  assert.deepEqual([pairs[0].n97, pairs[0].e97, pairs[0].n67, pairs[0].e67], [2709376.350, 218785.951, 2709581.598, 217956.883]);
});

test('fitTransform：仿射可還原已知轉換（殘差 ~ 毫米以下）', () => {
  const { pairs } = parseInp(inpText(CTRL));
  const fit = fitTransform(pairs, 'affine');
  assert.equal(fit.model, 'affine');
  assert.ok(fit.max < 0.001, `max=${fit.max}`);
  const [E, N] = fit.apply(217300, 2709100);
  const [te, tn] = TRUE(217300, 2709100);
  assert.ok(Math.abs(E - te) < 0.002 && Math.abs(N - tn) < 0.002);
});

test('fitTransform：點數不足或共線時依序退回', () => {
  const { pairs } = parseInp(inpText(CTRL.slice(0, 2)));
  const f2 = fitTransform(pairs, 'affine');
  assert.equal(f2.model, 'helmert'); assert.match(f2.note, /退回/);
  const f1 = fitTransform(pairs.slice(0, 1), 'affine');
  assert.equal(f1.model, 'shift');
  const line = parseInp(inpText([['L1', 217000, 2709000], ['L2', 217500, 2709000], ['L3', 218000, 2709000]])).pairs;
  assert.notEqual(fitTransform(line, 'affine').model, 'affine');
  assert.throws(() => fitTransform([], 'affine'));
});

test('transformPair：不論欄位順序（北,東／東,北）都轉對', () => {
  const fit = fitTransform(parseInp(inpText(CTRL)).pairs, 'affine');
  const [te, tn] = TRUE(217300, 2709100);
  const [a, b] = transformPair(fit, 217300, 2709100);
  const [c, d] = transformPair(fit, 2709100, 217300);
  assert.ok(Math.abs(a - te) < 0.002 && Math.abs(b - tn) < 0.002);
  assert.ok(Math.abs(c - tn) < 0.002 && Math.abs(d - te) < 0.002);
  assert.throws(() => transformPair(fit, 1000, 2000));
});

test('convertCase：TWD67 案件轉換後等於 TWD97 案件；控制點用公告值', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'kctwd-'));
  try {
    const d97 = path.join(tmp, 'KC0001'); const d67 = path.join(tmp, 'KC0002');
    makeFixture(d97); makeFixture(d67, true);
    const c97 = await loadCase(dirSource(d97), 'KC0001');
    const c67 = await loadCase(dirSource(d67), 'KC0002');
    // 這份合成資料的 67/97 偏移是純平移，控制點同樣用純平移
    const pairs = [[216500, 2708500], [217900, 2708700], [218400, 2709300], [217100, 2709600]].map(([e, n], i) => ({
      name: `C${i}`, e67: e, n67: n, e97: e + 829.073, n97: n - 205.223,
    }));
    const fit = fitTransform(pairs, 'affine');
    const stats = convertCase(c67, fit, { exact: true });
    assert.equal(stats.outside, 0);
    assert.ok(stats.points >= 8 + 2 + 2);
    for (const [k, [x, y]] of c97.mainPts) {
      const [x2, y2] = c67.mainPts.get(k);
      assert.ok(Math.abs(x - x2) < 0.002 && Math.abs(y - y2) < 0.002, `主點 ${k}`);
    }
    for (const [k, [x, y]] of c97.subPts) {
      const [x2, y2] = c67.subPts.get(k);
      assert.ok(Math.abs(x - x2) < 0.002 && Math.abs(y - y2) < 0.002, `參考點 ${k}`);
    }
    for (const [i, r] of c97.supplements.entries()) {
      if (!r.CTL_NAME) continue;
      assert.ok(Math.abs(Number(r.CTL_X) - Number(c67.supplements[i].CTL_X)) < 0.002);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('convertCase：座標與控制點相符時採公告值（exact）；關閉時用擬合值', () => {
  const { pairs } = parseInp(inpText(CTRL));
  pairs[0].e97 += 0.040; // 讓公告值與擬合值有明顯差異
  const fit = fitTransform(pairs, 'affine');
  const mk = () => ({ mainPts: new Map([['1', [pairs[0].e67, pairs[0].n67]]]), subPts: new Map(), supplements: [] });
  const a = mk(); const sa = convertCase(a, fit, { exact: true });
  assert.equal(sa.exact, 1); assert.ok(Math.abs(a.mainPts.get('1')[0] - pairs[0].e97) < 1e-9);
  const b = mk(); const sb = convertCase(b, fit, { exact: false });
  assert.equal(sb.exact, 0); assert.ok(Math.abs(b.mainPts.get('1')[0] - pairs[0].e97) > 0.001);
});

test('convertCase：座標不像 TWD67 時丟錯；外插會警告', () => {
  const fit = fitTransform(parseInp(inpText(CTRL)).pairs, 'affine');
  assert.throws(() => convertCase({ mainPts: new Map([['1', [10, 20]]]), subPts: new Map(), supplements: [] }, fit), /不像/);
  const far = { mainPts: new Map([['1', [230000, 2709000]]]), subPts: new Map(), supplements: [] };
  const s = convertCase(far, fit);
  assert.equal(s.outside, 1); assert.equal(s.warnings.length, 1);
});

test('sanityCheck：已是 TWD97 的資料會被警告', () => {
  const { pairs } = parseInp(inpText(CTRL));
  const near97 = { mainPts: new Map(pairs.map((p) => [p.name, [p.e97, p.n97]])) };
  const near67 = { mainPts: new Map(pairs.map((p) => [p.name, [p.e67, p.n67]])) };
  assert.equal(sanityCheck(near67, pairs).length, 0);
  assert.match(sanityCheck(near97, pairs)[0], /已經是 TWD97/);
  const far = { mainPts: new Map([['1', [300000, 2600000]]]) };
  assert.match(sanityCheck(far, pairs)[0], /離這組參數/);
});

test('ParamStore：新增/更新/選擇/刪除/匯出匯入', () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const s = new ParamStore(storage);
  const { pairs } = parseInp(inpText(CTRL));
  assert.equal(s.upsert({ name: '金城', pairs }), 'added');
  assert.equal(s.upsert({ name: '金城', pairs: pairs.slice(0, 4) }), 'updated');
  assert.equal(s.list().length, 1); assert.equal(s.list()[0].pairs.length, 4);
  s.upsert({ name: '金沙', pairs });
  const id = s.list()[0].id; s.select(id);
  assert.equal(new ParamStore(storage).selected, id); // 重新載入仍記得
  const json = s.exportJson();
  const t = new ParamStore({ getItem: () => null, setItem() {}, removeItem() {} });
  assert.deepEqual(t.importJson(json), { added: 2, updated: 0 });
  assert.throws(() => t.importJson('{"x":1}'), /不是本工具/);
  s.remove(id); assert.equal(s.list().length, 1); assert.equal(s.selected, null);
  // storage 壞掉也不能丟錯
  const broken = new ParamStore({ getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() {} });
  assert.doesNotThrow(() => broken.upsert({ name: 'a', pairs }));
});

test('isNewer 版本比較', () => {
  assert.ok(isNewer('v2.0.1', '2.0.0')); assert.ok(isNewer('2.1.0', 'v2.0.9')); assert.ok(isNewer('v10.0.0', '9.9.9'));
  assert.ok(!isNewer('v2.0.0', '2.0.0')); assert.ok(!isNewer('1.4.2', '2.0.0')); assert.ok(!isNewer('', '1.0.0'));
});
