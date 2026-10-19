import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// 根目錄 package.json 是 type:module，vendor 的 UMD .js 要以 CommonJS 載入
function loadUmd(file) {
  const module = { exports: {} };
  new Function('module', 'exports', 'require', '__dirname', readFileSync(file, 'utf8'))(module, module.exports, require, path.dirname(file));
  return module.exports;
}

let SQLP;
export function getSQL() {
  if (!SQLP) {
    const init = loadUmd(path.join(ROOT, 'site/vendor/sql-wasm.js'));
    SQLP = init({ locateFile: (f) => path.join(ROOT, 'site/vendor', f) });
  }
  return SQLP;
}

export const JSZip = loadUmd(path.join(ROOT, 'site/vendor/jszip.min.js'));

export function makeFixture(dir, twd67 = false) {
  execFileSync('python3', ['-I', path.join(ROOT, 'tests/make_fixture.py'), dir, ...(twd67 ? ['twd67'] : [])]);
}

/** Node 版的 folderSource（與瀏覽器版介面相同）。 */
export function dirSource(dir) {
  return {
    names: readdirSync(dir),
    read: async (n) => new Uint8Array(readFileSync(path.join(dir, n))),
  };
}

/** 把 GPKG 位元組倒成可比較的結構：{表名: [row...]}（不含 fid 與 gpkg_contents.last_change）。 */
export function dumpGpkg(SQL, bytes) {
  const db = new SQL.Database(bytes);
  const out = {};
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  for (const [name] of tables[0].values) {
    const cols = db.exec(`PRAGMA table_info("${name}")`)[0].values.map((r) => r[1]).filter((c) => c !== 'fid' && c !== 'last_change');
    const q = db.exec(`SELECT ${cols.map((c) => `"${c}"`).join(',')} FROM "${name}" ORDER BY ${name.startsWith('gpkg_') ? '1' : 'fid'}`);
    out[name] = q.length ? q[0].values.map((r) => r.map((v) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v))) : [];
    out[`${name}#cols`] = cols;
  }
  db.close();
  return out;
}
