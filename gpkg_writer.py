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


def build_gpkg(out_path, layer_defs):
    """layer_defs: [{name, geom_type:'POINT'|'LINESTRING'|'POLYGON', attrs:[(name,sqltype)], rows:[{...}]}]
    每個 row 需含 'geom' (bytes)；若含 '_bbox'=(minx,miny,maxx,maxy) 會用於 gpkg_contents 範圍。
    只會寫入 rows 非空的圖層。回傳實際寫入的圖層名稱清單。
    """
    import os
    if os.path.exists(out_path):
        os.remove(out_path)

    conn = sqlite3.connect(out_path)
    cur = conn.cursor()
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

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    written = []

    for layer in layer_defs:
        rows = layer.get('rows') or []
        if not rows:
            continue
        name = layer['name']
        attrs = layer['attrs']
        col_defs = ','.join(f'"{n}" {t}' for (n, t) in attrs)
        cur.execute(f'CREATE TABLE "{name}" (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom BLOB, {col_defs})')

        bbox = _bounds(rows, layer['geom_type'])
        if bbox:
            minx, miny, maxx, maxy = bbox
        else:
            minx = miny = maxx = maxy = None
        cur.execute('INSERT INTO gpkg_contents VALUES (?,?,?,?,?,?,?,?,?,?)',
                    (name, 'features', name, name, now, minx, miny, maxx, maxy, SRS_ID))
        cur.execute('INSERT INTO gpkg_geometry_columns VALUES (?,?,?,?,?,?)',
                    (name, 'geom', layer['geom_type'], SRS_ID, 0, 0))

        col_names = ','.join(f'"{n}"' for (n, _t) in attrs)
        placeholders = ','.join('?' for _ in attrs)
        insert_sql = f'INSERT INTO "{name}"(geom,{col_names}) VALUES (?,{placeholders})'
        for row in rows:
            values = [row['geom']] + [row.get(n) for (n, _t) in attrs]
            cur.execute(insert_sql, values)

        written.append(name)

    conn.commit()
    conn.close()
    return written
