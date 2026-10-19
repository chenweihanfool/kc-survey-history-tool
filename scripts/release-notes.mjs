// 印出 CHANGELOG 最新一筆（Markdown），給 GitHub Release 當說明。
import { CHANGELOG } from '../site/js/version.js';

const e = CHANGELOG[0];
console.log(`## v${e.version}（${e.date}）\n\n**${e.title}**\n\n${e.notes.map((n) => `- ${n}`).join('\n')}\n\n---\n下載 \`kc-survey-history-tool.html\`，用 Chrome 或 Edge 開啟即可使用（不需安裝）。`);
