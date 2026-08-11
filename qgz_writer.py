"""QGZ（QGIS 專案壓縮檔）讀取與修改工具。

QGZ 本質是 ZIP 檔，內含一個 .qgs（QGIS 專案 XML）以及可能的其他資源（如樣式資料庫）。
本模組會：
  1. 完整保留 ZIP 內所有非 .qgs 的檔案（例如 *_styles.db），避免修改專案時遺失資源。
  2. 解析 .qgs XML，於「複丈歷史」群組下新增／取代指定日期子群組的圖層。
  3. 若既有專案內有同名圖層（去除案號前綴後比對類型），複製其樣式設定到新圖層。
  4. 保留原始 <!DOCTYPE ...> 宣告後重新壓縮回 QGZ。
"""
import io
import re
import uuid
import zipfile
import xml.etree.ElementTree as ET

GEOM_LABEL = {'POINT': 'Point', 'LINESTRING': 'Line', 'POLYGON': 'Polygon'}

SRS_BLOCK = (
    '<srs><spatialrefsys nativeFormat="Wkt">'
    '<authid>EPSG:3826</authid>'
    '<description>TWD97 / TM2 zone 121</description>'
    '</spatialrefsys></srs>'
)

DOCTYPE_LINE = "<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>"


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
    """去除案號前綴（'案號 — 類型' 格式）以及地籍圖線段的段代碼後綴，取得圖層類型基底名稱，供樣式比對用。"""
    if ' — ' in layername:
        layername = layername.rsplit(' — ', 1)[-1]
    m = re.match(r'^(地籍圖線段)_S\d+$', layername)
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


def patch_qgs(qgs_text, group_label, layer_specs, gpkg_rel_path):
    """在 XML 中新增圖層並掛入「複丈歷史」>「group_label」子群組。

    layer_specs: [{'id':str, 'name':str, 'geom_type':'POINT'|'LINESTRING'|'POLYGON', 'table_name':str}]
    gpkg_rel_path: 相對於 .qgs 的路徑，例如 './複丈歷史/KC0391_2026-08-11.gpkg'
    回傳新的 qgs_text。
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

    # 若已存在同名日期子群組，先移除它，並清掉它對應的 maplayer（避免重跑累積孤兒圖層）
    for g in list(hist_grp.findall('layer-tree-group')):
        if g.get('name') == group_label:
            old_ids = {ltl.get('id') for ltl in g.findall('layer-tree-layer') if ltl.get('id')}
            for ml in list(proj_layers.findall('maplayer')):
                id_el = ml.find('id')
                if id_el is not None and id_el.text in old_ids:
                    proj_layers.remove(ml)
            hist_grp.remove(g)

    for spec in layer_specs:
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

        cache_key = (_base_type_name(spec['name']), geom_label)
        cached = style_cache.get(cache_key)
        if cached:
            for tag in ('renderer-v2', 'pipe', 'customproperties', 'fieldConfiguration', 'labeling'):
                if tag in cached:
                    import copy
                    ml.append(copy.deepcopy(cached[tag]))

    if proj_layers.get('layercount') is not None:
        try:
            cnt = int(proj_layers.get('layercount'))
        except ValueError:
            cnt = len(proj_layers.findall('maplayer'))
        proj_layers.set('layercount', str(cnt + len(layer_specs)))

    date_grp = ET.Element('layer-tree-group', {
        'name': group_label, 'checked': 'Qt::Checked', 'expanded': '1', 'groupLayer': '',
    })
    for spec in layer_specs:
        ltl = ET.SubElement(date_grp, 'layer-tree-layer', {
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
    hist_grp.insert(0, date_grp)

    new_body = ET.tostring(root, encoding='unicode')
    if doctype:
        return doctype + '\n' + new_body
    return new_body


def build_layer_specs(layer_defs, name_prefix):
    """由 gpkg_writer 的 layer_defs 產生 patch_qgs 所需的 layer_specs，圖層名稱格式：'{name_prefix} — {類型}'。
    只納入實際有資料 (rows 非空) 的圖層，確保不會把空圖層寫進 QGZ。
    """
    specs = []
    for d in layer_defs:
        if not d.get('rows'):
            continue
        display_name = f"{name_prefix} — {d['name']}"
        specs.append({
            'id': _new_layer_id(d['name']),
            'name': display_name,
            'geom_type': d['geom_type'],
            'table_name': d['name'],
        })
    return specs
