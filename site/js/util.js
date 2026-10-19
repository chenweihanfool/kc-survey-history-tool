// 共用小工具。行為對齊舊版 Python（survey.py 的 _to_float / _to_int）。

export function toFloat(s) {
  if (s === null || s === undefined) return null;
  if (typeof s === 'string' && s.trim() === '') return null;
  const f = Number(s);
  return Number.isFinite(f) ? f : null;
}

export function toInt(s) {
  const f = toFloat(s);
  return f === null ? null : Math.trunc(f);
}

export function normKey(n) {
  return String(Math.trunc(Number(n)));
}

export function normKeySafe(v) {
  const i = toInt(v);
  return i === null ? null : String(i);
}

export function concatBytes(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
