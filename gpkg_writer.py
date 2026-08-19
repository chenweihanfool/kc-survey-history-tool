"""GeoPackage (GPKG) 建立工具：WKB 幾何編碼 + 以 sqlite3 建立標準 GeoPackage 檔案。

座標系統固定為 TWD97 / TM2 zone 121 (EPSG:3826)，與案件 D 系列檔案座標系統一致。
"""
import sqlite3
import struct
from datetime import datetime, timezone

SRS_ID = 3826
SRS_WKT = (
    'PROJCS["TWD97 / TM2 zone 121",GEOGCS["TWD97",'
    'DATUM["Taiwan_Datum_1997",SPHEROID["GRS 1980",6378137,298.257222101]],'
    'PRIMEM["Greenwich",0],UNIT["degree",0.017453292519943278]],'
    'PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],'
    'PARAMETER["central_meridian",121],PARAMETER["scale_factor",0.9999],'
    'PARAMETER["false_easting",250000],PARAMETER["false_northing",0],'
    'UNIT["metre",1]]'
)


def _gpkg_header(srs_id=SRS_ID):
    # magic 'GP' + version(0) + flags(1: little-endian, no envelope) + srs_id (int32 LE)
    return b'GP' + bytes([0, 1]) + struct.pack('<i', srs_id)


def wkb_point(x, y):
    body = b'\x01' + struct.pack('<I', 1) + struct.pack('<dd', x, y)
    return _gpkg_header() + body


def wkb_linestring(pts):
    n = len(pts)
    body = b'\x01' + struct.pack('<I', 2) + struct.pack('<I', n)
    for (x, y) in pts:
        body += struct.pack('<dd', x, y)
    return _gpkg_header() + body


def wkb_polygon(ring):
    pts = list(ring)
    if pts[0] != pts[-1]:
        pts.append(pts[0])
    n = len(pts)
    body = b'\x01' + struct.pack('<I', 3) + struct.pack('<I', 1) + struct.pack('<I', n)
    for (x, y) in pts:
        body += struct.pack('<dd', x, y)
    return _gpkg_header() + body


def _bounds(rows, geom_type):
    xs, ys = [], []
    for r in rows:
        g = r['geom']
        # 從已編碼的 WKB 反解座標範圍太麻煩，改由呼叫端在 row 內帶 _x/_y 或 _bbox
        bbox = r.get('_bbox')
        if bbox:
            xs.extend([bbox[0], bbox[2]])
            ys.extend([bbox[1], bbox[3]])
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def _ensure_gpkg_base(cur):
    """若 GeoPackage 基礎結構尚未建立則建立之；已存在則略過（讓函式可重複對同一檔案呼叫）。"""
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='gpkg_spatial_ref_sys'")
    if cur.fetchone():
        return
    cur.execute('PRAGMA application_id = 0x47504B47')
    cur.execute('PRAGMA user_version = 10300')

    cur.execute('''CREATE TABLE gpkg_spatial_ref_sys (
        srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY,
        organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL,
        definition TEXT NOT NULL, description TEXT)''')
    cur.execute('INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?)',
                ('TWD97 / TM2 zone 121', SRS_ID, 'EPSG', SRS_ID, SRS_WKT, 'TWD97/TM2'))
    cur.execute('INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?)',
                ('Undefined cartesian', -1, 'NONE', -1, 'undefined', 'undefined'))
    cur.execute('INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?)',
                ('Undefined geographic', 0, 'NONE', 0, 'undefined', 'undefined'))

    cur.execute('''CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL,
        identifier TEXT, description TEXT DEFAULT '',
        last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        min_x REAL, min_y REAL, max_x REAL, max_y REAL, srs_id INTEGER)''')
    cur.execute('''CREATE TABLE gpkg_geometry_columns (
        table_name TEXT NOT NULL, column_name TEXT NOT NULL,
        geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL,
        z TINYINT NOT NULL DEFAULT 0, m TINYINT NOT NULL DEFAULT 0,
        PRIMARY KEY (table_name, column_name))''')


def upsert_gpkg(out_path, layer_defs, case_id):
    """開啟既有 GeoPackage（不存在則建立），把各圖層資料寫入固定名稱的資料表，用於彙整
    多個案件到同一個持續累積的 GPKG 檔，而不是每次案件都產生新檔案／新圖層。

    - 資料表不存在：建立資料表並註冊到 gpkg_contents / gpkg_geometry_columns。
    - 資料表已存在：先刪除 CASE_ID = case_id 的舊資料（同案號重跑時取代而非累加重複），
      再插入這次的新資料，並將 gpkg_contents 的範圍與既有範圍取聯集。

    只處理 rows 非空的圖層。回傳實際寫入（新建或更新）的圖層名稱清單。
    """
    conn = sqlite3.connect(out_path)
    cur = conn.cursor()
    _ensure_gpkg_base(cur)

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    written = []

    for layer in layer_defs:
        rows = layer.get('rows') or []
        if not rows:
            continue
        name = layer['name']
        attrs = layer['attrs']

        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,))
        exists = cur.fetchone() is not None

        if not exists:
            col_defs = ','.join(f'"{n}" {t}' for (n, t) in attrs)
            cur.execute(f'CREATE TABLE "{name}" (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom BLOB, {col_defs})')
            cur.execute('INSERT INTO gpkg_contents VALUES (?,?,?,?,?,?,?,?,?,?)',
                        (name, 'features', name, name, now, None, None, None, None, SRS_ID))
            cur.execute('INSERT INTO gpkg_geometry_columns VALUES (?,?,?,?,?,?)',
                        (name, 'geom', layer['geom_type'], SRS_ID, 0, 0))
        elif case_id is not None:
            cur.execute(f'DELETE FROM "{name}" WHERE CASE_ID = ?', (case_id,))

        col_names = ','.join(f'"{n}"' for (n, _t) in attrs)
        placeholders = ','.join('?' for _ in attrs)
        insert_sql = f'INSERT INTO "{name}"(geom,{col_names}) VALUES (?,{placeholders})'
        for row in rows:
            values = [row['geom']] + [row.get(n) for (n, _t) in attrs]
            cur.execute(insert_sql, values)

        bbox = _bounds(rows, layer['geom_type'])
        if bbox:
            minx, miny, maxx, maxy = bbox
            cur.execute('SELECT min_x, min_y, max_x, max_y FROM gpkg_contents WHERE table_name=?', (name,))
            existing = cur.fetchone()
            if existing and existing[0] is not None:
                minx = min(minx, existing[0]); miny = min(miny, existing[1])
                maxx = max(maxx, existing[2]); maxy = max(maxy, existing[3])
            cur.execute('UPDATE gpkg_contents SET min_x=?, min_y=?, max_x=?, max_y=?, last_change=? WHERE table_name=?',
                        (minx, miny, maxx, maxy, now, name))

        written.append(name)

    conn.commit()
    conn.close()
    return written
