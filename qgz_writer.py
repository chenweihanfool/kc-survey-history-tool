"""QGZ（QGIS 專案壓縮檔）讀取與修改工具。

QGZ 本質是 ZIP 檔，內含一個 .qgs（QGIS 專案 XML）以及可能的其他資源（如樣式資料庫）。
本模組會：
  1. 完整保留 ZIP 內所有非 .qgs 的檔案（例如 *_styles.db），避免修改專案時遺失資源。
  2. 解析 .qgs XML，在「複丈歷史」群組下確保固定的圖層集合存在（界址點/参考點/補點/
     地籍線/参考線/宗地），這些圖層永遠指向同一個彙整 GPKG；圖層已存在時不重建 XML
     （資料已透過 gpkg_writer.upsert_gpkg 直接寫進同一個資料表），只有該圖層類型第一次
     出現時才會新增 maplayer / layer-tree-layer 項目，避免每次案件輸出都讓 QGZ 多長圖層。
  3. 新增圖層時，若既有專案內有同型圖層（去除案號前綴後比對），複製其樣式設定；否則
     套用內建預設樣式。
  4. 保留原始 <!DOCTYPE ...> 宣告後重新壓縮回 QGZ。
"""
import io
import re
import uuid
import zipfile
import xml.etree.ElementTree as ET

GEOM_LABEL = {'POINT': 'Point', 'LINESTRING': 'Line', 'POLYGON': 'Polygon'}

# 完整 WKT/proj4/srsid 區塊（與 QGIS 本身寫入的格式一致）。只給 <authid> 在部分情況下
# QGIS 無法正確解析出 EPSG:3826，必須帶完整資訊才能確保新圖層 CRS 正確設為 3826。
_TWD97_WKT = (
    'PROJCRS["TWD97 / TM2 zone 121",BASEGEOGCRS["TWD97",'
    'DATUM["Taiwan Datum 1997",ELLIPSOID["GRS 1980",6378137,298.257222101,LENGTHUNIT["metre",1]]],'
    'PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]],ID["EPSG",3824]],'
    'CONVERSION["Taiwan 2-degree TM zone 121",METHOD["Transverse Mercator",ID["EPSG",9807]],'
    'PARAMETER["Latitude of natural origin",0,ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",8801]],'
    'PARAMETER["Longitude of natural origin",121,ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",8802]],'
    'PARAMETER["Scale factor at natural origin",0.9999,SCALEUNIT["unity",1],ID["EPSG",8805]],'
    'PARAMETER["False easting",250000,LENGTHUNIT["metre",1],ID["EPSG",8806]],'
    'PARAMETER["False northing",0,LENGTHUNIT["metre",1],ID["EPSG",8807]]],CS[Cartesian,2],'
    'AXIS["easting (X)",east,ORDER[1],LENGTHUNIT["metre",1]],'
    'AXIS["northing (Y)",north,ORDER[2],LENGTHUNIT["metre",1]],'
    'USAGE[SCOPE["Engineering survey, topographic mapping."],'
    'AREA["Taiwan, Republic of China - between 120°E and 122°E, onshore and offshore - Taiwan Island."],'
    'BBOX[20.41,119.99,26.72,122.06]],ID["EPSG",3826]]'
)
_TWD97_PROJ4 = ('+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 '
                '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs')

SRS_BLOCK = (
    '<srs><spatialrefsys nativeFormat="Wkt">'
    f'<wkt>{_TWD97_WKT}</wkt>'
    f'<proj4>{_TWD97_PROJ4}</proj4>'
    '<srsid>27234</srsid>'
    '<srid>3826</srid>'
    '<authid>EPSG:3826</authid>'
    '<description>TWD97 / TM2 zone 121</description>'
    '<projectionacronym>tmerc</projectionacronym>'
    '<ellipsoidacronym>EPSG:7019</ellipsoidacronym>'
    '<geographicflag>false</geographicflag>'
    '</spatialrefsys></srs>'
)

DOCTYPE_LINE = "<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>"


def _marker_renderer(color, name='circle', size='2.2'):
    return f'''<renderer-v2 symbollevels="0" type="singleSymbol" forceraster="0" enableorderby="0">
  <symbols>
    <symbol force_rhr="0" name="0" alpha="1" type="marker" clip_to_extent="1" is_animated="0" frame_rate="10">
      <layer class="SimpleMarker" locked="0" enabled="1" pass="0">
        <Option type="Map">
          <Option type="QString" name="color" value="{color}"/>
          <Option type="QString" name="name" value="{name}"/>
          <Option type="QString" name="outline_color" value="0,0,0,255"/>
          <Option type="QString" name="outline_style" value="solid"/>
          <Option type="QString" name="outline_width" value="0.4"/>
          <Option type="QString" name="outline_width_unit" value="MM"/>
          <Option type="QString" name="size" value="{size}"/>
          <Option type="QString" name="size_unit" value="MM"/>
        </Option>
      </layer>
    </symbol>
  </symbols>
</renderer-v2>'''


def _line_renderer(color, width='0.3', style='solid'):
    return f'''<renderer-v2 symbollevels="0" type="singleSymbol" forceraster="0" enableorderby="0">
  <symbols>
    <symbol force_rhr="0" name="0" alpha="1" type="line" clip_to_extent="1" is_animated="0" frame_rate="10">
      <layer class="SimpleLine" locked="0" enabled="1" pass="0">
        <Option type="Map">
          <Option type="QString" name="line_color" value="{color}"/>
          <Option type="QString" name="line_style" value="{style}"/>
          <Option type="QString" name="line_width" value="{width}"/>
          <Option type="QString" name="line_width_unit" value="MM"/>
        </Option>
      </layer>
    </symbol>
  </symbols>
</renderer-v2>'''


def _fill_renderer(color, outline_color='0,0,0,255', outline_width='0.3'):
    return f'''<renderer-v2 symbollevels="0" type="singleSymbol" forceraster="0" enableorderby="0">
  <symbols>
    <symbol force_rhr="0" name="0" alpha="1" type="fill" clip_to_extent="1" is_animated="0" frame_rate="10">
      <layer class="SimpleFill" locked="0" enabled="1" pass="0">
        <Option type="Map">
          <Option type="QString" name="color" value="{color}"/>
          <Option type="QString" name="outline_color" value="{outline_color}"/>
          <Option type="QString" name="outline_style" value="solid"/>
          <Option type="QString" name="outline_width" value="{outline_width}"/>
          <Option type="QString" name="outline_width_unit" value="MM"/>
          <Option type="QString" name="style" value="solid"/>
        </Option>
      </layer>
    </symbol>
  </symbols>
</renderer-v2>'''


# 沒有既有同型圖層可參考樣式時的預設值（第一次匯入該類型時套用；之後若專案內已有
# 使用者調整過的同型圖層，會優先複製那個既有樣式，不會被這裡的預設值覆蓋）。
DEFAULT_RENDERERS = {
    '界址點': _marker_renderer('227,26,28,255', 'circle', '2.4'),
    '参考點': _marker_renderer('255,127,0,255', 'circle', '2.0'),
    '補點': _marker_renderer('31,120,180,255', 'square', '2.0'),
    '地籍線': _line_renderer('0,0,0,255', '0.3', 'solid'),
    '参考線': _line_renderer('120,120,120,255', '0.3', 'dash'),
    '宗地': _fill_renderer('255,255,0,50'),
}


class QgzError(Exception):
    pass


def read_qgz(path):
    """回傳 (qgs_name, qgs_text, other_entries: {name: bytes})"""
    with open(path, 'rb') as f:
        head = f.read(4)
    if head[:2] == b'\x1f\x8b':
        raise QgzError('這是舊版 GZIP 格式的 QGZ（QGIS < 3.30），本工具僅支援新版 ZIP 格式 QGZ。'
                        '請用目前的 QGIS 開啟後另存一次即可轉為新格式。')
    zf = zipfile.ZipFile(path)
    names = zf.namelist()
    qgs_name = None
    for n in names:
        if n.lower() == 'qgis.qgs':
            qgs_name = n
            break
    if qgs_name is None:
        for n in names:
            if n.lower().endswith('.qgs'):
                qgs_name = n
                break
    if qgs_name is None:
        raise QgzError('QGZ 檔內找不到 .qgs 專案檔')

    qgs_bytes = zf.read(qgs_name)
    qgs_text = qgs_bytes.decode('utf-8')
    other = {}
    for n in names:
        if n == qgs_name:
            continue
        other[n] = zf.read(n)
    zf.close()
    return qgs_name, qgs_text, other


def write_qgz(path, qgs_name, qgs_text, other_entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(qgs_name, qgs_text.encode('utf-8'))
        for n, data in other_entries.items():
            zf.writestr(n, data)
    with open(path, 'wb') as f:
        f.write(buf.getvalue())


def _strip_doctype(text):
    m = re.match(r'^\s*(<!DOCTYPE[^>]*>)\s*', text)
    if m:
        return m.group(1), text[m.end():]
    return None, text


def _new_layer_id(name):
    safe = re.sub(r'[^A-Za-z0-9_]', '_', name)
    return f'{safe}_{uuid.uuid4().hex}'


def _base_type_name(layername):
    """去除舊版命名可能殘留的案號前綴（'案號 — 類型' 格式）以及地籍圖的段代碼後綴，
    取得圖層類型基底名稱，供樣式比對用。新版圖層本身就是固定的基底名稱（例如「界址點」），
    這裡主要是為了在舊版留下的圖層（例如「KC1120_2026-08-12 — 界址點」）中找到可複製的樣式。"""
    if ' — ' in layername:
        layername = layername.rsplit(' — ', 1)[-1]
    m = re.match(r'^(地籍圖)_S\d+$', layername)
    if m:
        return m.group(1)
    return layername


def _collect_style_cache(root):
    cache = {}
    proj_layers = root.find('projectlayers')
    if proj_layers is None:
        return cache
    for ml in proj_layers.findall('maplayer'):
        layername_el = ml.find('layername')
        name = layername_el.text if layername_el is not None and layername_el.text else ''
        if not name:
            continue
        geom = ml.get('geometry') or ''
        key = (_base_type_name(name), geom)
        if key in cache:
            continue
        parts = {}
        for tag in ('renderer-v2', 'pipe', 'customproperties', 'fieldConfiguration', 'labeling'):
            el = ml.find(tag)
            if el is not None:
                parts[tag] = el
        if parts:
            cache[key] = parts
    return cache


def _find_existing_layer_id(root, gpkg_rel_path, table_name):
    """在專案內尋找 datasource 完全對應到指定 GPKG + 資料表的既有圖層，回傳其 id；找不到回傳 None。"""
    proj_layers = root.find('projectlayers')
    if proj_layers is None:
        return None
    target_ds = f'{gpkg_rel_path}|layername={table_name}'
    for ml in proj_layers.findall('maplayer'):
        ds_el = ml.find('datasource')
        if ds_el is not None and ds_el.text == target_ds:
            id_el = ml.find('id')
            return id_el.text if id_el is not None else None
    return None


def ensure_layers(qgs_text, layer_specs, gpkg_rel_path):
    """確保 layer_specs 內每個圖層都存在於專案的「複丈歷史」群組下，且指向同一個彙整 GPKG。

    layer_specs: [{'id':str, 'name':str, 'geom_type':'POINT'|'LINESTRING'|'POLYGON', 'table_name':str}]
    gpkg_rel_path: 相對於 .qgs 的路徑，例如 './複丈歷史/複丈歷史.gpkg'（固定檔名，不隨案件變動）

    若專案內已有 datasource 完全相同（同一個彙整 GPKG + 同一個資料表）的圖層，就跳過不重建
    ——資料已經透過 gpkg_writer.upsert_gpkg 直接寫進那個資料表，QGIS 重新整理圖層／重開專案
    即可看到最新資料，不需要改動 XML。只有該圖層類型第一次出現時才會新增 maplayer /
    layer-tree-layer 項目。回傳 (新的 qgs_text, 這次新增的圖層名稱清單)。
    """
    doctype, body = _strip_doctype(qgs_text)
    root = ET.fromstring(body)

    style_cache = _collect_style_cache(root)

    proj_layers = root.find('projectlayers')
    if proj_layers is None:
        proj_layers = ET.SubElement(root, 'projectlayers')

    root_ltg = root.find('layer-tree-group')
    if root_ltg is None:
        root_ltg = ET.SubElement(root, 'layer-tree-group')

    hist_grp = None
    for g in root_ltg.findall('layer-tree-group'):
        if g.get('name') == '複丈歷史':
            hist_grp = g
            break
    if hist_grp is None:
        hist_grp = ET.Element('layer-tree-group', {
            'name': '複丈歷史', 'checked': 'Qt::Checked', 'expanded': '1', 'groupLayer': '',
        })
        # 插入在既有 customproperties 之後（若有），否則放在最前面
        cprops = root_ltg.find('customproperties')
        if cprops is not None:
            idx = list(root_ltg).index(cprops) + 1
        else:
            idx = 0
        root_ltg.insert(idx, hist_grp)

    newly_added = []

    for spec in layer_specs:
        if _find_existing_layer_id(root, gpkg_rel_path, spec['table_name']) is not None:
            continue  # 圖層已存在，資料已透過 GPKG upsert 更新，不需要改動 XML

        geom_label = GEOM_LABEL.get(spec['geom_type'], 'Point')
        ml = ET.SubElement(proj_layers, 'maplayer')
        ml.set('type', 'vector')
        ml.set('geometry', geom_label)
        ml.set('autoRefreshEnabled', '0')
        ET.SubElement(ml, 'id').text = spec['id']
        ET.SubElement(ml, 'datasource').text = f"{gpkg_rel_path}|layername={spec['table_name']}"
        ET.SubElement(ml, 'layername').text = spec['name']
        srs_el = ET.fromstring(SRS_BLOCK)
        ml.append(srs_el)
        ET.SubElement(ml, 'geometrytype').text = geom_label
        ET.SubElement(ml, 'provider', {'encoding': 'UTF-8'}).text = 'ogr'

        base_type = _base_type_name(spec['name'])
        cache_key = (base_type, geom_label)
        cached = style_cache.get(cache_key)
        if cached:
            # 優先複製既有同型圖層的樣式（可能是使用者在 QGIS 內調整過的）
            for tag in ('renderer-v2', 'pipe', 'customproperties', 'fieldConfiguration', 'labeling'):
                if tag in cached:
                    import copy
                    ml.append(copy.deepcopy(cached[tag]))
        else:
            # 專案內找不到同型圖層可參考時，套用內建預設樣式，而非留給 QGIS 隨機配色
            default_xml = DEFAULT_RENDERERS.get(base_type)
            if default_xml:
                ml.append(ET.fromstring(default_xml))

        ltl = ET.SubElement(hist_grp, 'layer-tree-layer', {
            'providerKey': 'ogr',
            'name': spec['name'],
            'patch_size': '-1,-1',
            'source': f"{gpkg_rel_path}|layername={spec['table_name']}",
            'expanded': '1',
            'checked': 'Qt::Checked',
            'legend_exp': '',
            'legend_split_behavior': '0',
            'id': spec['id'],
        })
        ET.SubElement(ltl, 'customproperties')

        newly_added.append(spec['name'])

    if newly_added and proj_layers.get('layercount') is not None:
        try:
            cnt = int(proj_layers.get('layercount'))
        except ValueError:
            cnt = len(proj_layers.findall('maplayer'))
        proj_layers.set('layercount', str(cnt + len(newly_added)))

    new_body = ET.tostring(root, encoding='unicode')
    result = (doctype + '\n' + new_body) if doctype else new_body
    return result, newly_added


def build_layer_specs(layer_defs):
    """由 gpkg_writer 的 layer_defs 產生 ensure_layers 所需的 layer_specs。
    圖層名稱／資料表名稱直接用類型名稱（例如「界址點」），不再加案號前綴——
    因為現在是固定的彙整圖層，非案件專屬。只納入實際有資料 (rows 非空) 的圖層。
    """
    specs = []
    for d in layer_defs:
        if not d.get('rows'):
            continue
        specs.append({
            'id': _new_layer_id(d['name']),
            'name': d['name'],
            'geom_type': d['geom_type'],
            'table_name': d['name'],
        })
    return specs
