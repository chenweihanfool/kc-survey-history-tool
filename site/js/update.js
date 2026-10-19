// 更新提示：工具是單一 .html 檔，附在 GitHub Release。頁面啟動時查詢最新 Release，
// 若比目前版本新，就提示並提供新版 .html 的下載連結（檔案無法自己覆蓋自己，由使用者換檔）。
// 查詢失敗（沒有網路等）一律靜默略過，不影響使用。
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

/** 回傳 {version, url, assetUrl} 或 null（沒有新版／查詢失敗）。assetUrl 是 Release 附件 .html 的下載連結。 */
export async function checkForUpdate(current, fetchImpl = fetch) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    const resp = await fetchImpl(API_URL, { headers: { Accept: 'application/vnd.github+json' }, signal: ctl.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.tag_name || !isNewer(data.tag_name, current)) return null;
    const asset = (data.assets || []).find((a) => /\.html$/i.test(a.name || ''));
    return { version: data.tag_name, url: data.html_url, assetUrl: asset ? asset.browser_download_url : null };
  } catch (_e) {
    return null;
  }
}
