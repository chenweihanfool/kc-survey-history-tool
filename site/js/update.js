// 自動更新：網頁版由 GitHub Release 驅動。
// 發布 Release 時 GitHub Actions 會把該版本部署到 GitHub Pages；頁面啟動時查詢最新 Release，
// 若比目前載入的版本新，就提示使用者重新載入（失敗一律靜默略過，不影響使用）。
import { GITHUB_OWNER, GITHUB_REPO } from './version.js';

const API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

export function parseVersion(v) {
  const parts = String(v || '').trim().replace(/^[vV]/, '').split('.')
    .map((p) => parseInt(p.replace(/\D/g, ''), 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

export function isNewer(latest, current) {
  const a = parseVersion(latest); const b = parseVersion(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** 回傳 {version, url} 或 null（沒有新版／查詢失敗）。 */
export async function checkForUpdate(current, fetchImpl = fetch) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    const resp = await fetchImpl(API_URL, { headers: { Accept: 'application/vnd.github+json' }, signal: ctl.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.tag_name || !isNewer(data.tag_name, current)) return null;
    return { version: data.tag_name, url: data.html_url };
  } catch (_e) {
    return null;
  }
}
