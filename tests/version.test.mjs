import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_VERSION, CHANGELOG } from '../site/js/version.js';
import { isNewer } from '../site/js/update.js';

test('CHANGELOG：每筆都有版本、日期、標題、類型與內容；最新一筆就是 APP_VERSION；版本由新到舊', () => {
  assert.equal(CHANGELOG[0].version, APP_VERSION);
  for (const e of CHANGELOG) {
    assert.match(e.version, /^\d+\.\d+\.\d+$/);
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.title && e.title.length > 0, `${e.version} 缺標題`);
    assert.ok(['major', 'minor', 'patch'].includes(e.type), `${e.version} 類型不合法`);
    assert.ok(Array.isArray(e.notes) && e.notes.length > 0, `${e.version} 缺內容`);
  }
  for (let i = 1; i < CHANGELOG.length; i++) assert.ok(isNewer(CHANGELOG[i - 1].version, CHANGELOG[i].version), `${CHANGELOG[i].version} 順序錯誤`);
});
