// QGZ（QGIS 專案壓縮檔）讀取與修改工具。
//
// QGZ 本質是 ZIP 檔，內含一個 .qgs（QGIS 專案 XML）以及可能的其他資源（如樣式資料庫）。
//   1. 完整保留 ZIP 內所有非 .qgs 的檔案，避免修改專案時遺失資源。
//   2. 在「複丈歷史」群組下確保固定的圖層集合存在（界址點/參考點/補點/地籍線/參考線/宗地），
//      這些圖層永遠指向同一個彙整 GPKG；圖層已存在時不重建 XML（資料已直接寫進同一個資料表），
//      只有該圖層類型第一次出現時才會新增 maplayer / layer-tree-layer 項目。
//   3. 新增圖層時，若既有專案內有同型圖層，複製其樣式設定；否則套用內建預設樣式。
//   4. 保留原始 <!DOCTYPE ...> 宣告後重新壓縮回 QGZ。

const GEOM_LABEL = { POINT: 'Point', LINESTRING: 'Line', POLYGON: 'Polygon' };

// 完整 WKT/proj4/srsid 區塊（與 QGIS 本身寫入的格式一致）；只給 authid 時部分情況 QGIS 解析不出 EPSG:3826。
const TWD97_WKT = (
  'PROJCRS["TWD97 / TM2 zone 121",BASEGEOGCRS["TWD97",'
  + 'DATUM["Taiwan Datum 1997",ELLIPSOID["GRS 1980",6378137,298.257222101,LENGTHUNIT["metre",1]]],'
  + 'PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]],ID["EPSG",3824]],'
  + 'CONVERSION["Taiwan 2-degree TM zone 121",METHOD["Transverse Mercator",ID["EPSG",9807]],'
  + 'PARAMETER["Latitude of natural origin",0,ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",8801]],'
  + 'PARAMETER["Longitude of natural origin",121,ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",8802]],'
  + 'PARAMETER["Scale factor at natural origin",0.9999,SCALEUNIT["unity",1],ID["EPSG",8805]],'
  + 'PARAMETER["False easting",250000,LENGTHUNIT["metre",1],ID["EPSG",8806]],'
  + 'PARAMETER["False northing",0,LENGTHUNIT["metre",1],ID["EPSG",8807]]],CS[Cartesian,2],'
  + 'AXIS["easting (X)",east,ORDER[1],LENGTHUNIT["metre",1]],'
  + 'AXIS["northing (Y)",north,ORDER[2],LENGTHUNIT["metre",1]],'
  + 'USAGE[SCOPE["Engineering survey, topographic mapping."],'
  + 'AREA["Taiwan, Republic of China - between 120°E and 122°E, onshore and offshore - Taiwan Island."],'
  + 'BBOX[20.41,119.99,26.72,122.06]],ID["EPSG",3826]]'
);
const TWD97_PROJ4 = '+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SRS_BLOCK = '<srs><spatialrefsys nativeFormat="Wkt">'
  + `<wkt>${esc(TWD97_WKT)}</wkt><proj4>${esc(TWD97_PROJ4)}</proj4>`
  + '<srsid>27234</srsid><srid>3826</srid><authid>EPSG:3826</authid>'
  + '<description>TWD97 / TM2 zone 121</description><projectionacronym>tmerc</projectionacronym>'
  + '<ellipsoidacronym>EPSG:7019</ellipsoidacronym><geographicflag>false</geographicflag>'
  + '</spatialrefsys></srs>';

function markerRenderer(color, name = 'circle', size = '2.2') {
  return `<renderer-v2 symbollevels="0" type="singleSymbol" forceraster="0" enableorderby="0">
  <symbols>
    <symbol force_rhr="0" name="0" alpha="1" type="marker" clip_to_extent="1" is_animated="0" frame_rate="10">
      <layer class="SimpleMarker" locked="0" enabled="1" pass="0">
        <Option type="Map">
          <Option type="QString" name="color" value="${color}"/>
          <Option type="QString" name="name" value="${name}"/>
          <Option type="QString" name="outline_color" value="0,0,0,255"/>
          <Option type="QString" name="outline_style" value="solid"/>
          <Option type="QString" name="outline_width" value="0.4"/>
          <Option type="QString" name="outline_width_unit" value="MM"/>
          <Option type="QString" name="size" value="${size}"/>
          <Option type="QString" name="size_unit" value="MM"/>
        </Option>
      </layer>
    </symbol>
  </symbols>
</renderer-v2>`;
}

function lineRenderer(color, width = '0.3', style = 'solid') {
  return `<renderer-v2 symbollevels="0" type="singleSymbol" forceraster="0" enableorderby="0">
  <symbols>
    <symbol force_rhr="0" name="0" alpha="1" type="line" clip_to_extent="1" is_animated="0" frame_rate="10">
      <layer class="SimpleLine" locked="0" enabled="1" pass="0">
        <Option type="Map">
          <Option type="QString" name="line_color" value="${color}"/>
          <Option type="QString" name="line_style" value="${style}"/>
          <Option type="QString" name="line_width" value="${width}"/>
          <Option type="QString" name="line_width_unit" value="MM"/>
        </Option>
      </layer>
    </symbol>
  </symbols>
</renderer-v2>`;
}

function fillRenderer(color, outline = '0,0,0,255', width = '0.3') {
  return `<renderer-v2 symbollevels="0" type="singleSymbol" forceraster="0" enableorderby="0">
  <symbols>
    <symbol force_rhr="0" name="0" alpha="1" type="fill" clip_to_extent="1" is_animated="0" frame_rate="10">
      <layer class="SimpleFill" locked="0" enabled="1" pass="0">
        <Option type="Map">
          <Option type="QString" name="color" value="${color}"/>
          <Option type="QString" name="outline_color" value="${outline}"/>
          <Option type="QString" name="outline_style" value="solid"/>
          <Option type="QString" name="outline_width" value="${width}"/>
          <Option type="QString" name="outline_width_unit" value="MM"/>
          <Option type="QString" name="style" value="solid"/>
        </Option>
      </layer>
    </symbol>
  </symbols>
</renderer-v2>`;
}

// 沒有既有同型圖層可參考樣式時的預設值（之後若專案內已有使用者調整過的同型圖層，會優先複製它）。
const DEFAULT_RENDERERS = {
  界址點: markerRenderer('227,26,28,255', 'circle', '2.4'),
  參考點: markerRenderer('255,127,0,255', 'circle', '2.0'),
  補點: markerRenderer('31,120,180,255', 'square', '2.0'),
  地籍線: lineRenderer('0,0,0,255', '0.3', 'solid'),
  參考線: lineRenderer('120,120,120,255', '0.3', 'dash'),
  宗地: fillRenderer('255,255,0,50'),
};

export class QgzError extends Error {}

/** 回傳 {qgsName, qgsText, other:Map<檔名, Uint8Array>}。 */
export async function readQgz(JSZip, bytes) {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    throw new QgzError('這是舊版 GZIP 格式的 QGZ（QGIS < 3.30），本工具僅支援新版 ZIP 格式 QGZ。請用目前的 QGIS 開啟後另存一次即可轉為新格式。');
  }
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  let qgsName = names.find((n) => n.toLowerCase() === 'qgis.qgs')
    || names.find((n) => n.toLowerCase().endsWith('.qgs'));
  if (!qgsName) throw new QgzError('QGZ 檔內找不到 .qgs 專案檔');
  const qgsText = new TextDecoder('utf-8').decode(await zip.file(qgsName).async('uint8array'));
  const other = new Map();
  for (const n of names) {
    if (n === qgsName) continue;
    other.set(n, await zip.file(n).async('uint8array'));
  }
  return { qgsName, qgsText, other };
}

export async function writeQgz(JSZip, qgsName, qgsText, other) {
  const zip = new JSZip();
  zip.file(qgsName, new TextEncoder().encode(qgsText));
  for (const [n, data] of other) zip.file(n, data);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

function stripDoctype(text) {
  const m = /^\s*(?:<\?xml[^>]*\?>\s*)?(<!DOCTYPE[^>]*>)?\s*/.exec(text);
  return { doctype: m && m[1] ? m[1] : null, body: text.slice(m ? m[0].length : 0) };
}

const newLayerId = (name) => `${name.replace(/[^A-Za-z0-9_]/g, '_')}_${crypto.randomUUID().replace(/-/g, '')}`;

/** 去除舊版命名可能殘留的案號前綴（'案號 — 類型'）與地籍圖段代碼後綴，取得圖層類型基底名稱。 */
function baseTypeName(layername) {
  let n = layername;
  if (n.includes(' — ')) n = n.slice(n.lastIndexOf(' — ') + 3);
  const m = /^(地籍圖)_S\d+$/.exec(n);
  return m ? m[1] : n;
}

const kids = (el, tag) => Array.from(el.children).filter((c) => c.localName === tag);
const kid = (el, tag) => kids(el, tag)[0] || null;
const STYLE_TAGS = ['renderer-v2', 'pipe', 'customproperties', 'fieldConfiguration', 'labeling'];

function collectStyleCache(root) {
  const cache = new Map();
  const pl = kid(root, 'projectlayers');
  if (!pl) return cache;
  for (const ml of kids(pl, 'maplayer')) {
    const nameEl = kid(ml, 'layername');
    const name = nameEl && nameEl.textContent ? nameEl.textContent : '';
    if (!name) continue;
    const key = `${baseTypeName(name)}|${ml.getAttribute('geometry') || ''}`;
    if (cache.has(key)) continue;
    const parts = {};
    for (const tag of STYLE_TAGS) {
      const el = kid(ml, tag);
      if (el) parts[tag] = el;
    }
    if (Object.keys(parts).length) cache.set(key, parts);
  }
  return cache;
}

function findExistingLayerId(root, gpkgRelPath, tableName) {
  const pl = kid(root, 'projectlayers');
  if (!pl) return null;
  const target = `${gpkgRelPath}|layername=${tableName}`;
  for (const ml of kids(pl, 'maplayer')) {
    const ds = kid(ml, 'datasource');
    if (ds && ds.textContent === target) {
      const id = kid(ml, 'id');
      return id ? id.textContent : '';
    }
  }
  return null;
}

/**
 * 確保 layerSpecs 內每個圖層都存在於專案的「複丈歷史」群組下，且指向同一個彙整 GPKG。
 * layerSpecs: [{id, name, geomType, tableName}]；gpkgRelPath 例如 './複丈歷史/複丈歷史.gpkg'。
 * 回傳 {text, newlyAdded:[圖層名稱]}。
 */
export function ensureLayers(qgsText, layerSpecs, gpkgRelPath) {
  const { doctype, body } = stripDoctype(qgsText);
  const doc = new DOMParser().parseFromString(body, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new QgzError('QGZ 內的專案檔 XML 無法解析');
  const root = doc.documentElement;
  const mk = (tag, attrs = {}, text = null) => {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text !== null) el.textContent = text;
    return el;
  };
  const fromXml = (xml) => doc.importNode(
    new DOMParser().parseFromString(xml, 'application/xml').documentElement, true);

  const styleCache = collectStyleCache(root);
  let projLayers = kid(root, 'projectlayers');
  if (!projLayers) { projLayers = mk('projectlayers'); root.appendChild(projLayers); }
  let rootLtg = kid(root, 'layer-tree-group');
  if (!rootLtg) { rootLtg = mk('layer-tree-group'); root.appendChild(rootLtg); }

  let histGrp = kids(rootLtg, 'layer-tree-group').find((g) => g.getAttribute('name') === '複丈歷史') || null;
  if (!histGrp) {
    histGrp = mk('layer-tree-group', { name: '複丈歷史', checked: 'Qt::Checked', expanded: '1', groupLayer: '' });
    const children = Array.from(rootLtg.children);
    const cp = kid(rootLtg, 'customproperties');
    const idx = cp ? children.indexOf(cp) + 1 : 0;
    rootLtg.insertBefore(histGrp, children[idx] || null);
  }

  const newlyAdded = [];
  for (const spec of layerSpecs) {
    if (findExistingLayerId(root, gpkgRelPath, spec.tableName) !== null) continue; // 已存在：資料已由 GPKG 更新

    const geomLabel = GEOM_LABEL[spec.geomType] || 'Point';
    const ds = `${gpkgRelPath}|layername=${spec.tableName}`;
    const ml = mk('maplayer', { type: 'vector', geometry: geomLabel, autoRefreshEnabled: '0' });
    ml.appendChild(mk('id', {}, spec.id));
    ml.appendChild(mk('datasource', {}, ds));
    ml.appendChild(mk('layername', {}, spec.name));
    ml.appendChild(fromXml(SRS_BLOCK));
    ml.appendChild(mk('geometrytype', {}, geomLabel));
    ml.appendChild(mk('provider', { encoding: 'UTF-8' }, 'ogr'));
    projLayers.appendChild(ml);

    const baseType = baseTypeName(spec.name);
    const cached = styleCache.get(`${baseType}|${geomLabel}`);
    if (cached) {
      for (const tag of STYLE_TAGS) if (cached[tag]) ml.appendChild(cached[tag].cloneNode(true));
    } else if (DEFAULT_RENDERERS[baseType]) {
      ml.appendChild(fromXml(DEFAULT_RENDERERS[baseType]));
    }

    const ltl = mk('layer-tree-layer', {
      providerKey: 'ogr', name: spec.name, patch_size: '-1,-1', source: ds, expanded: '1',
      checked: 'Qt::Checked', legend_exp: '', legend_split_behavior: '0', id: spec.id,
    });
    ltl.appendChild(mk('customproperties'));
    histGrp.appendChild(ltl);
    newlyAdded.push(spec.name);
  }

  if (newlyAdded.length && projLayers.getAttribute('layercount') !== null) {
    const cnt = parseInt(projLayers.getAttribute('layercount'), 10);
    projLayers.setAttribute('layercount', String(Number.isNaN(cnt) ? kids(projLayers, 'maplayer').length : cnt + newlyAdded.length));
  }

  const out = new XMLSerializer().serializeToString(root);
  return { text: doctype ? `${doctype}\n${out}` : out, newlyAdded };
}

/** 由 buildLayers 的結果產生 layerSpecs（只納入有資料的圖層；名稱即資料表名稱）。 */
export function buildLayerSpecs(layerDefs) {
  return layerDefs.filter((d) => d.rows && d.rows.length).map((d) => ({
    id: newLayerId(d.name), name: d.name, geomType: d.geomType, tableName: d.name,
  }));
}
