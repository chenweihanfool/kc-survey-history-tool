"""極簡 dBase III/IV 讀取器（Big5 編碼），用於讀取地籍複丈案件的 D 系列檔案。"""
import struct


def read_dbf(path):
    """回傳 (fields, records)。fields 為 [(name, type, len, dec), ...]；
    records 為 [dict, ...]，值皆為去除頭尾空白的字串（依欄位型別未額外轉型）。"""
    with open(path, 'rb') as f:
        data = f.read()

    if len(data) < 32:
        raise ValueError(f'{path}: 檔案過短，不是有效的 DBF 檔')

    num_records = struct.unpack_from('<I', data, 4)[0]
    header_size = struct.unpack_from('<H', data, 8)[0]
    record_size = struct.unpack_from('<H', data, 10)[0]

    fields = []
    pos = 32
    while pos < header_size - 1:
        chunk = data[pos:pos + 32]
        if not chunk or chunk[0] == 0x0D:
            break
        name = chunk[0:11].split(b'\x00')[0].decode('ascii', 'replace')
        ftype = chr(chunk[11])
        flen = chunk[16]
        fdec = chunk[17]
        fields.append((name, ftype, flen, fdec))
        pos += 32

    records = []
    rp = header_size
    for _ in range(num_records):
        rec = data[rp:rp + record_size]
        rp += record_size
        if not rec or rec[0:1] == b'*':
            continue  # 已刪除的紀錄
        off = 1
        row = {}
        for (name, ftype, flen, fdec) in fields:
            raw = rec[off:off + flen]
            try:
                val = raw.decode('big5', 'replace').strip()
            except Exception:
                val = raw.decode('latin-1', 'replace').strip()
            row[name] = val
            off += flen
        records.append(row)

    return fields, records


def read_dbf_records(path):
    """僅回傳 records（list[dict]）。"""
    _, records = read_dbf(path)
    return records
