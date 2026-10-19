// 對照測試：同一份合成案件資料，JS 版與舊版 Python 版輸出的 GPKG 必須逐列相同。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ROOT, getSQL, makeFixture, dirSource, dumpGpkg } from './helpers.mjs';
import { loadCase, buildLayers, listParcels } from '../site/js/survey.js';
import { upsertGpkg } from '../site/js/gpkg.js';
import { makeCaseId } from '../site/js/pipeline.js';

const PY = `
import sys, json
sys.path.insert(0, sys.argv[1] + '/legacy')
import survey, pipeline
from gpkg_writer import upsert_gpkg
folder, out, old, date, keys, refs = sys.argv[2], sys.argv[3], sys.argv[4] == '1', sys.argv[5], json.loads(sys.argv[6]), sys.argv[7] == '1'
c = survey.load_case(folder, use_old_map=old)
tag = pipeline.make_case_id(c.case_id, date, data_version=c.data_version)
pk = None if keys is None else [tuple(k) for k in keys]
layers = survey.build_layers(c, parcel_keys=pk, include_refs=refs, case_id_tag=tag)
upsert_gpkg(out, layers, tag)
`;

async function jsExport(dir, existing, { old = false, keys = null, refs = true, date = '2026-08-20' } = {}) {
  const SQL = await getSQL();
  const id = path.basename(dir);
  const c = await loadCase(dirSource(dir), id, old);
  const tag = makeCaseId(id, date, c.dataVersion);
  const layers = buildLayers(c, { parcelKeys: keys && keys.map((k) => k.join('|')), includeRefs: refs, caseIdTag: tag });
  return upsertGpkg(SQL, existing, layers, tag).bytes;
}

function pyExport(dir, out, { old = false, keys = null, refs = true, date = '2026-08-20' } = {}) {
  execFileSync('python3', ['-I', '-c', PY, ROOT, dir, out, old ? '1' : '0', date, JSON.stringify(keys), refs ? '1' : '0']);
}

test('JS 與 Python 輸出的 GPKG 逐列一致（新圖、舊圖、指定地號、不含補點、重跑取代）', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'kcparity-'));
  try {
    const dir = path.join(tmp, 'KC0001');
    makeFixture(dir);
    const SQL = await getSQL();
    const pyOut = path.join(tmp, 'py.gpkg');
    let js = null;

    const steps = [
      {},                                   // 新圖全部
      { old: true },                        // 舊圖（CASE_ID 加 -舊，並存）
      { keys: [[1, 10, 0]], date: '2026-09-01' }, // 指定地號
      { refs: false, date: '2026-09-02' },  // 不含補點/參考
      {},                                   // 同案號重跑 -> 取代，不重複
    ];
    for (const [i, s] of steps.entries()) {
      js = await jsExport(dir, js, s);
      pyExport(dir, pyOut, s);
      assert.deepEqual(dumpGpkg(SQL, js), dumpGpkg(SQL, new Uint8Array(readFileSync(pyOut))), `step ${i}`);
    }
    const d = dumpGpkg(SQL, js);
    assert.ok(d['界址點'].length > 0 && d['宗地'].length > 0 && d['補點'].length > 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('地號清單與 Python 版一致', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'kcparity-'));
  try {
    const dir = path.join(tmp, 'KC0001');
    makeFixture(dir);
    const c = await loadCase(dirSource(dir), 'KC0001');
    const labels = listParcels(c).map((p) => p.label);
    const py = execFileSync('python3', ['-I', '-c', `
import sys; sys.path.insert(0, sys.argv[1] + '/legacy')
import survey
c = survey.load_case(sys.argv[2])
print('|'.join(p['label'] for p in survey.list_parcels(c)))`, ROOT, dir]).toString().trim();
    assert.equal(labels.join('|'), py);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
