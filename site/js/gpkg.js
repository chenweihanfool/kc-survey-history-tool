// GeoPackage (GPKG) 建立工具：WKB 幾何編碼 + 以 sql.js（SQLite WASM）建立／更新 GeoPackage。
// 座標系統固定為 TWD97 / TM2 zone 121 (EPSG:3826)。

export const SRS_ID = 3826;
export const SRS_WKT = (
  'PROJCS["TWD97 / TM2 zone 121",GEOGCS["TWD97",'
  + 'DATUM["Taiwan_Datum_1997",SPHEROID["GRS 1980",6378137,298.257222101]],'
  + 'PRIMEM["Greenwich",0],UNIT["degree",0.017453292519943278]],'
  + 'PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],'
  + 'PARAMETER["central_meridian",121],PARAMETER["scale_factor",0.9999],'
  + 'PARAMETER["false_easting",250000],PARAMETER["false_northing",0],'
  + 'UNIT["metre",1]]'
);

function builder(size) {
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  let o = 0;
  return {
    buf,
    u8(v) { buf[o++] = v; },
    u32(v) { dv.setUint32(o, v, true); o += 4; },
    i32(v) { dv.setInt32(o, v, true); o += 4; },
    f64(v) { dv.setFloat64(o, v, true); o += 8; },
  };
}

function header(b) {
  // magic 'GP' + version(0) + flags(1: little-endian, no envelope) + srs_id (int32 LE)
  b.u8(0x47); b.u8(0x50); b.u8(0); b.u8(1); b.i32(SRS_ID);
}

export function wkbPoint(x, y) {
  const b = builder(8 + 1 + 4 + 16);
  header(b); b.u8(1); b.u32(1); b.f64(x); b.f64(y);
  return b.buf;
}

export function wkbLinestring(pts) {
  const b = builder(8 + 1 + 4 + 4 + pts.length * 16);
  header(b); b.u8(1); b.u32(2); b.u32(pts.length);
  for (const [x, y] of pts) { b.f64(x); b.f64(y); }
  return b.buf;
}

export function wkbPolygon(ring) {
  const pts = ring.slice();
  const f = pts[0]; const l = pts[pts.length - 1];
  if (f[0] !== l[0] || f[1] !== l[1]) pts.push(f);
  const b = builder(8 + 1 + 4 + 4 + 4 + pts.length * 16);
  header(b); b.u8(1); b.u32(3); b.u32(1); b.u32(pts.length);
  for (const [x, y] of pts) { b.f64(x); b.f64(y); }
  return b.buf;
}

function bounds(rows) {
  let minx = Infinity; let miny = Infinity; let maxx = -Infinity; let maxy = -Infinity;
  for (const r of rows) {
    const bb = r._bbox;
    if (!bb) continue;
    minx = Math.min(minx, bb[0]); miny = Math.min(miny, bb[1]);
    maxx = Math.max(maxx, bb[2]); maxy = Math.max(maxy, bb[3]);
  }
  return Number.isFinite(minx) ? [minx, miny, maxx, maxy] : null;
}

function one(db, sql, params = []) {
  const res = db.exec(sql, params);
  return res.length && res[0].values.length ? res[0].values[0] : null;
}

function ensureBase(db) {
  if (one(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='gpkg_spatial_ref_sys'")) return;
  db.run('PRAGMA application_id = 0x47504B47');
  db.run('PRAGMA user_version = 10300');
  db.run(`CREATE TABLE gpkg_spatial_ref_sys (
    srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY,
    organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL,
    definition TEXT NOT NULL, description TEXT)`);
  const ins = 'INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?)';
  db.run(ins, ['TWD97 / TM2 zone 121', SRS_ID, 'EPSG', SRS_ID, SRS_WKT, 'TWD97/TM2']);
  db.run(ins, ['Undefined cartesian', -1, 'NONE', -1, 'undefined', 'undefined']);
  db.run(ins, ['Undefined geographic', 0, 'NONE', 0, 'undefined', 'undefined']);
  db.run(`CREATE TABLE gpkg_contents (
    table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL,
    identifier TEXT, description TEXT DEFAULT '',
    last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    min_x REAL, min_y REAL, max_x REAL, max_y REAL, srs_id INTEGER)`);
  db.run(`CREATE TABLE gpkg_geometry_columns (
    table_name TEXT NOT NULL, column_name TEXT NOT NULL,
    geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL,
    z TINYINT NOT NULL DEFAULT 0, m TINYINT NOT NULL DEFAULT 0,
    PRIMARY KEY (table_name, column_name))`);
}

/** 為已存在的資料表補上目前 attrs 裡缺少的欄位（彙整 GPKG 長期累積使用，程式新增欄位時要自動遷移）。 */
function migrateColumns(db, table, attrs) {
  const res = db.exec(`PRAGMA table_info("${table}")`);
  const existing = new Set(res.length ? res[0].values.map((r) => r[1]) : []);
  for (const [n, t] of attrs) {
    if (!existing.has(n)) db.run(`ALTER TABLE "${table}" ADD COLUMN "${n}" ${t}`);
  }
}

/**
 * 開啟既有 GeoPackage 位元組（null 則新建），把各圖層資料寫入固定名稱的資料表：
 * - 資料表不存在：建立並註冊到 gpkg_contents / gpkg_geometry_columns。
 * - 已存在：補齊缺少欄位，刪除 CASE_ID = caseId 的舊資料（同案重跑取代），再插入新資料，範圍取聯集。
 * 只處理 rows 非空的圖層。回傳 {bytes, written:[圖層名稱]}。
 */
export function upsertGpkg(SQL, existingBytes, layerDefs, caseId) {
  const db = existingBytes ? new SQL.Database(existingBytes) : new SQL.Database();
  try {
    ensureBase(db);
    const now = new Date().toISOString().replace(/\.\d+Z$/, '.000Z');
    const written = [];
    db.run('BEGIN');
    for (const layer of layerDefs) {
      const rows = layer.rows || [];
      if (rows.length === 0) continue;
      const { name, attrs } = layer;
      const exists = one(db, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]) !== null;
      if (!exists) {
        const cols = attrs.map(([n, t]) => `"${n}" ${t}`).join(',');
        db.run(`CREATE TABLE "${name}" (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom BLOB, ${cols})`);
        db.run('INSERT INTO gpkg_contents VALUES (?,?,?,?,?,?,?,?,?,?)',
          [name, 'features', name, name, now, null, null, null, null, SRS_ID]);
        db.run('INSERT INTO gpkg_geometry_columns VALUES (?,?,?,?,?,?)', [name, 'geom', layer.geomType, SRS_ID, 0, 0]);
      } else {
        migrateColumns(db, name, attrs);
        if (caseId !== null && caseId !== undefined) db.run(`DELETE FROM "${name}" WHERE CASE_ID = ?`, [caseId]);
      }

      const colNames = attrs.map(([n]) => `"${n}"`).join(',');
      const marks = attrs.map(() => '?').join(',');
      const stmt = db.prepare(`INSERT INTO "${name}"(geom,${colNames}) VALUES (?,${marks})`);
      try {
        for (const row of rows) {
          stmt.run([row.geom, ...attrs.map(([n]) => (row[n] === undefined ? null : row[n]))]);
        }
      } finally {
        stmt.free();
      }

      const bb = bounds(rows);
      if (bb) {
        let [minx, miny, maxx, maxy] = bb;
        const ex = one(db, 'SELECT min_x, min_y, max_x, max_y FROM gpkg_contents WHERE table_name=?', [name]);
        if (ex && ex[0] !== null) {
          minx = Math.min(minx, ex[0]); miny = Math.min(miny, ex[1]);
          maxx = Math.max(maxx, ex[2]); maxy = Math.max(maxy, ex[3]);
        }
        db.run('UPDATE gpkg_contents SET min_x=?, min_y=?, max_x=?, max_y=?, last_change=? WHERE table_name=?',
          [minx, miny, maxx, maxy, now, name]);
      }
      written.push(name);
    }
    db.run('COMMIT');
    return { bytes: db.export(), written };
  } finally {
    db.close();
  }
}
