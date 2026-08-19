"""複丈案件資料處理核心邏輯：讀取 D 系列檔案 -> 建立點/線/面圖層定義。

檔案對應關係（依實際 KC0391 測試資料驗證）：
  D14 = 界址點/參考點座標（COT_REF='0' 為界址點，其餘為參考點，小數點編碼）
  D2C = 界址點/參考點座標「新」版（若有資料則優先採用，否則退回 D14）
  D21 = 地籍圖線段拓樸（含 L/R 地號）
  D2D = 地籍圖線段拓樸「新」版（若有資料則優先採用，否則退回 D21）
  D29 = 參考線（LIN_TOP/BOT/MID 為文字型態，格式如 "90.7"）
  D20 = 補點（Q 開頭補樁點，無地號歸屬）
  D2B = 宗地界址點序列「新」版（若有資料則優先採用，否則退回 D13）
  D13 = 宗地界址點序列（每筆最多 8 個點號，同地號可跨多筆記錄接續）
  D11 = 宗地面積/地目等屬性（依 SECTION_O + PAR_O_M/PAR_O_C 對照）

座標系統：D 系列檔案座標已是 TWD97 / TM2 zone 121 (EPSG:3826)，不需再轉換。
"""
import os
import re
from dataclasses import dataclass, field

from dbf_reader import read_dbf_records
from gpkg_writer import wkb_point, wkb_linestring, wkb_polygon


class ParcelNotFoundError(Exception):
    pass


class CaseNotFoundError(Exception):
    pass


def _to_float(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _to_int(s):
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return None


def _norm_key(n):
    return str(int(n))


def detect_case(folder):
    """在資料夾中尋找 XX####.D14 檔案，回傳 (prefix, seg_num, base_name)。"""
    pat = re.compile(r'^([A-Za-z]+)(\d+)\.D14$', re.IGNORECASE)
    for entry in os.listdir(folder):
        m = pat.match(entry)
        if m:
            return m.group(1).upper(), m.group(2), m.group(1).upper() + m.group(2)
    raise CaseNotFoundError(f'資料夾「{folder}」內找不到 .D14 檔案，請確認選擇的是複丈案件資料夾（例如 KC0391）')


def _dbf_path(folder, base_name, ext):
    return os.path.join(folder, f'{base_name}.{ext}')


def _read_opt(folder, base_name, ext):
    p = _dbf_path(folder, base_name, ext)
    if not os.path.exists(p):
        return []
    try:
        return read_dbf_records(p)
    except Exception:
        return []


@dataclass
class CaseData:
    case_id: str
    base_name: str
    folder: str
    main_pts: dict = field(default_factory=dict)   # "123" -> (x,y)
    sub_pts: dict = field(default_factory=dict)     # "123.4" -> (x,y)
    main_rows: dict = field(default_factory=dict)   # "123" -> raw D14/D2C row
    sub_rows: dict = field(default_factory=dict)
    lines: list = field(default_factory=list)       # D21/D2D rows
    ref_lines: list = field(default_factory=list)   # D29 rows
    supplements: list = field(default_factory=list)  # D20 rows
    parcel_rings: dict = field(default_factory=dict)  # (sec,m,c) -> [point_id_str,...] ordered
    parcel_areas: dict = field(default_factory=dict)  # (sec,m,c) -> {AREA_HA, CATE}
    used_new_points: bool = False
    used_new_lines: bool = False
    used_new_rings: bool = False


def load_case(folder):
    prefix, seg_num, base_name = detect_case(folder)
    case_id = os.path.basename(os.path.normpath(folder))

    d14 = read_dbf_records(_dbf_path(folder, base_name, 'D14'))
    d2c = _read_opt(folder, base_name, 'D2C')
    use_new_pts = len(d2c) > 0
    pt_records = d2c if use_new_pts else d14

    main_pts, sub_pts, main_rows, sub_rows = {}, {}, {}, {}
    for r in pt_records:
        x, y = _to_float(r.get('COT_X')), _to_float(r.get('COT_Y'))
        if x is None or y is None:
            continue
        ref = (r.get('COT_REF') or '0').strip()
        num = r.get('COT_NUMBER')
        if num is None or num == '':
            continue
        try:
            num_key = _norm_key(num)
        except ValueError:
            continue
        if ref in ('0', ''):
            main_pts[num_key] = (x, y)
            main_rows[num_key] = r
        else:
            ref_i = _to_int(ref)
            if ref_i is None:
                continue
            sub_key = f'{num_key}.{ref_i}'
            sub_pts[sub_key] = (x, y)
            sub_rows[sub_key] = r

    d21 = read_dbf_records(_dbf_path(folder, base_name, 'D21')) if os.path.exists(_dbf_path(folder, base_name, 'D21')) else []
    d2d = _read_opt(folder, base_name, 'D2D')
    use_new_lines = len(d2d) > 0
    lines = d2d if use_new_lines else d21

    ref_lines = _read_opt(folder, base_name, 'D29')
    supplements = _read_opt(folder, base_name, 'D20')

    d13 = _read_opt(folder, base_name, 'D13')
    d2b = _read_opt(folder, base_name, 'D2B')
    use_new_rings = len(d2b) > 0
    ring_records = d2b if use_new_rings else d13

    parcel_rings = {}
    for r in ring_records:
        sec, m, c = _to_int(r.get('O_SECTION')), _to_int(r.get('O_PARCEL')), _to_int(r.get('O_PARCEL_E'))
        if sec is None or m is None:
            continue
        c = c or 0
        key = (sec, m, c)
        seq = parcel_rings.setdefault(key, [])
        for i in range(1, 9):
            coord = r.get(f'COORD_{i}')
            pid = _to_int(coord)
            if not pid:
                continue
            seq.append(str(pid))

    d11 = _read_opt(folder, base_name, 'D11')
    parcel_areas = {}
    for r in d11:
        sec, m, c = _to_int(r.get('SECTION_O')), _to_int(r.get('PAR_O_M')), _to_int(r.get('PAR_O_C'))
        if sec is None or m is None:
            continue
        c = c or 0
        area_ha = _to_float(r.get('AREA_NEW')) or _to_float(r.get('AREA_OLD'))
        parcel_areas[(sec, m, c)] = {
            'AREA_HA': area_ha,
            'CATE': (r.get('CATE_NEW') or r.get('CATE_OLD') or '').strip(),
        }

    return CaseData(
        case_id=case_id, base_name=base_name, folder=folder,
        main_pts=main_pts, sub_pts=sub_pts, main_rows=main_rows, sub_rows=sub_rows,
        lines=lines, ref_lines=ref_lines, supplements=supplements,
        parcel_rings=parcel_rings, parcel_areas=parcel_areas,
        used_new_points=use_new_pts, used_new_lines=use_new_lines, used_new_rings=use_new_rings,
    )


def list_parcels(case: CaseData):
    """回傳 [{'key':(sec,m,c), 'label':str}] 依地號排序。"""
    keys = list(case.parcel_rings.keys())
    sections = {k[0] for k in keys}
    single_section = len(sections) <= 1
    out = []
    for (sec, m, c) in sorted(keys, key=lambda k: (k[0], k[1], k[2])):
        pno = f'{m}-{c}' if c else str(m)
        label = pno if single_section else f'{pno}（段{sec}）'
        out.append({'key': (sec, m, c), 'label': label})
    return out


def find_parcel_by_label(case: CaseData, label_or_number):
    """依標籤或純地號字串（如 '120' 或 '120-1'）尋找地號 key；找不到回傳 None。"""
    parcels = list_parcels(case)
    q = label_or_number.strip()
    for p in parcels:
        if p['label'] == q:
            return p['key']
    # 允許只輸入地號數字（不含段別標示）
    m = re.match(r'^(\d+)(?:-(\d+))?$', q)
    if m:
        mother = int(m.group(1))
        child = int(m.group(2)) if m.group(2) else 0
        matches = [p['key'] for p in parcels if p['key'][1] == mother and p['key'][2] == child]
        if len(matches) == 1:
            return matches[0]
    return None


def _parcel_point_id_set(case: CaseData, key):
    """依 D21/D2D 拓樸取得地號相關界址點 id 集合（跨圖幅正確來源）。"""
    sec, m, c = key
    ids = set()
    for r in case.lines:
        l_match = (_to_int(r.get('L_SECTION')) == sec and _to_int(r.get('L_PARCEL')) == m
                   and (_to_int(r.get('L_PARCEL_E')) or 0) == c)
        r_match = (_to_int(r.get('R_SECTION')) == sec and _to_int(r.get('R_PARCEL')) == m
                   and (_to_int(r.get('R_PARCEL_E')) or 0) == c)
        if l_match or r_match:
            for f in ('LIN_TOP', 'LIN_MID', 'LIN_BOT'):
                v = _to_int(r.get(f))
                if v:
                    ids.add(str(v))
    # 併入宗地邊界序列本身的點號（避免拓樸資料不完整時遺漏）
    ids.update(case.parcel_rings.get(key, []))
    return ids


def _parcel_point_id_set_multi(case: CaseData, keys):
    ids = set()
    for key in keys:
        ids |= _parcel_point_id_set(case, key)
    return ids


def _lookup_ref_point(case: CaseData, key_str):
    key_str = (key_str or '').strip()
    if not key_str or key_str == '0':
        return None
    if '.' in key_str:
        base, sub = key_str.split('.', 1)
        base_i, sub_i = _to_int(base), _to_int(sub)
        if base_i is None:
            return None
        if sub_i:
            k = f'{base_i}.{sub_i}'
            if k in case.sub_pts:
                return case.sub_pts[k]
        return case.main_pts.get(str(base_i))
    v = _to_int(key_str)
    if v is None:
        return None
    return case.main_pts.get(str(v))


CASE_ID_ATTR = ('CASE_ID', 'TEXT')


def build_layers(case: CaseData, parcel_keys=None, include_refs=True, case_id_tag=None):
    """建立圖層定義清單（供 gpkg_writer 使用）。
    parcel_keys=None 表示輸出全部；否則為 [(sec,m,c), ...]，
    僅輸出與這些地號相關之點/線，以及這些地號的宗地面。
    include_refs 控制補點/参考點/参考線：這三種類型不考慮地號關聯性，
    只有「全部輸出」（include_refs=True，預設）或「完全不輸出」（False）兩種選擇，
    不受 parcel_keys 篩選影響。
    case_id_tag：每一筆輸出資料的 CASE_ID 屬性值（例如 'KC0395-115-08-20'），
    用於彙整圖層裡標記資料來源案件，供之後同案號重跑時比對刪除舊資料。
    """
    filter_ids = None
    key_set = None
    if parcel_keys is not None:
        key_set = set(parcel_keys)
        filter_ids = _parcel_point_id_set_multi(case, parcel_keys)

    layers = []

    # 界址點
    pt_rows = []
    for num_key, (x, y) in case.main_pts.items():
        if filter_ids is not None and num_key not in filter_ids:
            continue
        r = case.main_rows.get(num_key, {})
        pt_rows.append({
            'geom': wkb_point(x, y),
            '_bbox': (x, y, x, y),
            'COT_NUMBER': _to_int(num_key),
            'COT_Y': y, 'COT_X': x,
            'COT_MATTER': _to_int(r.get('COT_MATTER')),
            'COT_SOURCE': _to_int(r.get('COT_SOURCE')),
            'COT_REMARK': (r.get('COT_REMARK') or '').strip(),
            'CASE_ID': case_id_tag,
        })
    layers.append({
        'name': '界址點', 'geom_type': 'POINT',
        'attrs': [('COT_NUMBER', 'INTEGER'), ('COT_Y', 'REAL'), ('COT_X', 'REAL'),
                  ('COT_MATTER', 'INTEGER'), ('COT_SOURCE', 'INTEGER'), ('COT_REMARK', 'TEXT'),
                  CASE_ID_ATTR],
        'rows': pt_rows,
    })

    # 參考點（不考慮地號關聯，僅由 include_refs 控制全有或全無）
    sub_rows_out = []
    if include_refs:
        for sub_key, (x, y) in case.sub_pts.items():
            r = case.sub_rows.get(sub_key, {})
            sub_rows_out.append({
                'geom': wkb_point(x, y),
                '_bbox': (x, y, x, y),
                'PT_ID': sub_key, 'COT_Y': y, 'COT_X': x,
                'COT_SOURCE': _to_int(r.get('COT_SOURCE')),
                'CASE_ID': case_id_tag,
            })
    layers.append({
        'name': '參考點', 'geom_type': 'POINT',
        'attrs': [('PT_ID', 'TEXT'), ('COT_Y', 'REAL'), ('COT_X', 'REAL'), ('COT_SOURCE', 'INTEGER'),
                  CASE_ID_ATTR],
        'rows': sub_rows_out,
    })

    # 補點（無地號歸屬，僅由 include_refs 控制全有或全無）
    supp_rows = []
    if include_refs:
        for r in case.supplements:
            x, y = _to_float(r.get('CTL_X')), _to_float(r.get('CTL_Y'))
            name = (r.get('CTL_NAME') or '').strip()
            if x is None or y is None or not name:
                continue
            supp_rows.append({
                'geom': wkb_point(x, y),
                '_bbox': (x, y, x, y),
                'CTL_NAME': name, 'CTL_Y': y, 'CTL_X': x,
                'CTL_LEVEL': (r.get('CTL_LEVEL') or '').strip(),
                'CASE_ID': case_id_tag,
            })
    layers.append({
        'name': '補點', 'geom_type': 'POINT',
        'attrs': [('CTL_NAME', 'TEXT'), ('CTL_Y', 'REAL'), ('CTL_X', 'REAL'), ('CTL_LEVEL', 'TEXT'),
                  CASE_ID_ATTR],
        'rows': supp_rows,
    })

    # 地籍線（單一圖層，含所有段別；L_SEC/R_SEC 屬性區分段別，不再依段分層建圖層）
    line_rows = []
    for r in case.lines:
        l_sec, r_sec = _to_int(r.get('L_SECTION')), _to_int(r.get('R_SECTION'))
        top_id, bot_id = _norm_key_safe(r.get('LIN_TOP')), _norm_key_safe(r.get('LIN_BOT'))
        top, bot = case.main_pts.get(top_id), case.main_pts.get(bot_id)
        if not top or not bot:
            continue
        if key_set is not None:
            l_m, l_c = _to_int(r.get('L_PARCEL')), _to_int(r.get('L_PARCEL_E')) or 0
            r_m, r_c = _to_int(r.get('R_PARCEL')), _to_int(r.get('R_PARCEL_E')) or 0
            l_match = (l_sec, l_m, l_c) in key_set
            r_match = (r_sec, r_m, r_c) in key_set
            if not (l_match or r_match):
                continue
        pts = [top, bot]
        mid_id = _norm_key_safe(r.get('LIN_MID'))
        if mid_id and mid_id != '0':
            mid = case.main_pts.get(mid_id)
            if mid:
                pts = [top, mid, bot]
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        line_rows.append({
            'geom': wkb_linestring(pts),
            '_bbox': (min(xs), min(ys), max(xs), max(ys)),
            'L_SEC': l_sec, 'L_PAR': _to_int(r.get('L_PARCEL')),
            'R_SEC': r_sec, 'R_PAR': _to_int(r.get('R_PARCEL')),
            'LIN_MODE': _to_int(r.get('LIN_MODE')),
            'CASE_ID': case_id_tag,
        })
    layers.append({
        'name': '地籍線', 'geom_type': 'LINESTRING',
        'attrs': [('L_SEC', 'INTEGER'), ('L_PAR', 'INTEGER'), ('R_SEC', 'INTEGER'),
                  ('R_PAR', 'INTEGER'), ('LIN_MODE', 'INTEGER'), CASE_ID_ATTR],
        'rows': line_rows,
    })

    # 參考線（不考慮地號關聯，僅由 include_refs 控制全有或全無）
    ref_rows = []
    if include_refs:
        for r in case.ref_lines:
            top = _lookup_ref_point(case, r.get('LIN_TOP'))
            bot = _lookup_ref_point(case, r.get('LIN_BOT'))
            if not top or not bot:
                continue
            top_key = (r.get('LIN_TOP') or '').strip()
            bot_key = (r.get('LIN_BOT') or '').strip()
            pts = [top, bot]
            mid_key = (r.get('LIN_MID') or '').strip()
            if mid_key and mid_key != '0':
                mid = _lookup_ref_point(case, mid_key)
                if mid:
                    pts = [top, mid, bot]
            xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
            ref_rows.append({
                'geom': wkb_linestring(pts),
                '_bbox': (min(xs), min(ys), max(xs), max(ys)),
                'L_TOP': top_key, 'L_BOT': bot_key,
                'LIN_MODE': _to_int(r.get('LIN_MODE')),
                'CASE_ID': case_id_tag,
            })
    layers.append({
        'name': '參考線', 'geom_type': 'LINESTRING',
        'attrs': [('L_TOP', 'TEXT'), ('L_BOT', 'TEXT'), ('LIN_MODE', 'INTEGER'), CASE_ID_ATTR],
        'rows': ref_rows,
    })

    # 宗地（面）
    par_rows = []
    ring_keys = parcel_keys if parcel_keys is not None else list(case.parcel_rings.keys())
    for key in ring_keys:
        seq = case.parcel_rings.get(key, [])
        ring = []
        for pid in seq:
            pt = case.main_pts.get(pid) or _lookup_ref_point(case, pid)
            if pt:
                ring.append(pt)
        if len(ring) < 3:
            continue
        sec, m, c = key
        area_info = case.parcel_areas.get(key, {})
        xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
        par_rows.append({
            'geom': wkb_polygon(ring),
            '_bbox': (min(xs), min(ys), max(xs), max(ys)),
            'SECTION': sec, 'MOTHER': m, 'CHILD': c,
            'PARCEL_NO': f'{m}-{c}' if c else str(m),
            'AREA_HA': area_info.get('AREA_HA'),
            'CATE': area_info.get('CATE', ''),
            'CASE_ID': case_id_tag,
        })
    layers.append({
        'name': '宗地', 'geom_type': 'POLYGON',
        'attrs': [('SECTION', 'INTEGER'), ('MOTHER', 'INTEGER'), ('CHILD', 'INTEGER'),
                  ('PARCEL_NO', 'TEXT'), ('AREA_HA', 'REAL'), ('CATE', 'TEXT'), CASE_ID_ATTR],
        'rows': par_rows,
    })

    return layers


def _norm_key_safe(v):
    i = _to_int(v)
    if i is None:
        return None
    return str(i)
