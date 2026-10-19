// 把 site/ 打包成「單一 .html」：所有 JS（含 sql.js、JSZip）與 sql.js 的 WASM（base64）都內嵌，
// 雙擊即可用（file:// 下瀏覽器不允許載入 ES 模組與另外的 .wasm 檔）。輸出：dist/kc-survey-history-tool.html
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = (p) => path.join(ROOT, 'site', p);
// 內嵌進 <script> 時不能出現 </script>
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

const bundled = await build({
  entryPoints: [site('js/app.js')], bundle: true, write: false, format: 'iife',
  target: 'chrome100', minify: true, charset: 'utf8', legalComments: 'none',
});
const appJs = bundled.outputFiles[0].text;
const sqlJs = readFileSync(site('vendor/sql-wasm.js'), 'utf8');
const jszip = readFileSync(site('vendor/jszip.min.js'), 'utf8');
const wasmB64 = readFileSync(site('vendor/sql-wasm.wasm')).toString('base64');

let html = readFileSync(site('index.html'), 'utf8');
const swap = (needle, replacement) => {
  if (!html.includes(needle)) throw new Error(`index.html 找不到：${needle}`);
  html = html.replace(needle, () => replacement);
};
swap('<script src="vendor/sql-wasm.js"></script>', `<script>window.__SQL_WASM_B64="${wasmB64}";</script>\n<script>${safe(sqlJs)}</script>`);
swap('<script src="vendor/jszip.min.js"></script>', `<script>${safe(jszip)}</script>`);
swap('<script type="module" src="js/app.js"></script>', `<script>${safe(appJs)}</script>`);

mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist/kc-survey-history-tool.html');
writeFileSync(out, html);
console.log(`${out}  ${(html.length / 1024 / 1024).toFixed(2)} MB`);
