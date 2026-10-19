// 極簡 dBase III/IV 讀取器（Big5 編碼），用於讀取地籍複丈案件的 D 系列檔案。

function makeDecoder() {
  try {
    return new TextDecoder('big5');
  } catch (_e) {
    return new TextDecoder('latin1');
  }
}

/** 回傳 {fields:[{name,type,len,dec}], records:[{欄位: 去頭尾空白的字串}]}。 */
export function readDbf(bytes) {
  if (bytes.length < 32) throw new Error('檔案過短，不是有效的 DBF 檔');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numRecords = dv.getUint32(4, true);
  const headerSize = dv.getUint16(8, true);
  const recordSize = dv.getUint16(10, true);
  const decoder = makeDecoder();
  const ascii = new TextDecoder('latin1');

  const fields = [];
  let pos = 32;
  while (pos < headerSize - 1) {
    if (pos + 32 > bytes.length || bytes[pos] === 0x0d) break;
    let end = pos;
    while (end < pos + 11 && bytes[end] !== 0) end++;
    const name = ascii.decode(bytes.subarray(pos, end));
    fields.push({
      name,
      type: String.fromCharCode(bytes[pos + 11]),
      len: bytes[pos + 16],
      dec: bytes[pos + 17],
    });
    pos += 32;
  }

  const records = [];
  let rp = headerSize;
  for (let i = 0; i < numRecords; i++) {
    if (rp + recordSize > bytes.length) break;
    const rec = bytes.subarray(rp, rp + recordSize);
    rp += recordSize;
    if (rec[0] === 0x2a) continue; // '*' 已刪除的紀錄
    let off = 1;
    const row = {};
    for (const f of fields) {
      const raw = rec.subarray(off, off + f.len);
      let isAscii = true;
      for (let k = 0; k < raw.length; k++) { if (raw[k] > 0x7f) { isAscii = false; break; } }
      row[f.name] = (isAscii ? ascii : decoder).decode(raw).trim();
      off += f.len;
    }
    records.push(row);
  }
  return { fields, records };
}

export function readDbfRecords(bytes) {
  return readDbf(bytes).records;
}
