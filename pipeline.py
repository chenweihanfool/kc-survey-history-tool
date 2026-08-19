"""整合流程：讀取案件 -> 建圖層 -> 寫入彙整 GPKG -> 確保 QGZ 固定圖層存在。

輸出的圖層是固定、持續累積的彙整圖層（界址點/参考點/補點/地籍線/参考線/宗地），
不是每次案件輸出都另外產生新的 GPKG 檔案與新的 QGZ 圖層。每筆資料都會標記
CASE_ID 屬性（格式：{案號}-{民國年}-{月}-{日}，例如 KC0395-115-08-20），
同一案號重跑時會先刪除該案號舊資料再寫入新的，避免重複累積。
"""
import os
import re
import shutil

import survey
import qgz_writer
from gpkg_writer import upsert_gpkg

MASTER_GPKG_NAME = '複丈歷史.gpkg'


class ExportAbortedError(Exception):
    pass


def find_qgis_setup(case_folder):
    """依案件資料夾推測專案結構：<root>/QGIS/*.qgz, <root>/QGIS/複丈歷史/
    回傳 dict{root, qgis_dir, hist_dir, qgz_candidates:[path,...]}；找不到 QGIS 資料夾則對應值為 None。
    """
    root = os.path.dirname(os.path.normpath(case_folder))
    qgis_dir = os.path.join(root, 'QGIS')
    result = {'root': root, 'qgis_dir': None, 'hist_dir': None, 'qgz_candidates': []}
    if os.path.isdir(qgis_dir):
        result['qgis_dir'] = qgis_dir
        hist_dir = os.path.join(qgis_dir, '複丈歷史')
        result['hist_dir'] = hist_dir
        for fn in os.listdir(qgis_dir):
            if fn.lower().endswith('.qgz'):
                result['qgz_candidates'].append(os.path.join(qgis_dir, fn))
    return result


def to_roc_date(date_str):
    """'2026-08-20' -> '115-08-20'（民國年 = 西元年 - 1911）。輸入格式不符時原樣回傳。"""
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', (date_str or '').strip())
    if not m:
        return date_str
    year, month, day = m.groups()
    roc_year = int(year) - 1911
    return f'{roc_year}-{month}-{day}'


def make_case_id(case_id, date_str):
    """案件屬性欄位值：'{案號}-{民國年}-{月}-{日}'，例如 KC0395-115-08-20。"""
    return f'{case_id}-{to_roc_date(date_str)}'


def run_export(case: survey.CaseData, parcel_keys, date_str, hist_dir, qgz_path, log=print, include_refs=True):
    """執行匯出。parcel_keys=None 表示全部輸出；否則為 [(sec,m,c), ...] 地號清單（可多選）。
    include_refs 控制補點/参考點/参考線是否輸出（不受地號篩選影響，全有或全無）。

    - 若指定地號但地號不存在，呼叫端應在呼叫前已用 find_parcel_by_label 驗證並中止，
      本函式仍會在任一 key 不在 case.parcel_rings 時拋出例外作為最後防線。
    - 若建出的圖層全部沒有資料，會拋出 ExportAbortedError 並且「不會」寫出任何檔案。
    - 資料寫入固定名稱的彙整 GPKG（複丈歷史.gpkg），同案號（案號+複丈日期換算的民國日期）
      重跑會先清掉該案號的舊資料再寫入，不會重複累積。
    """
    if parcel_keys is not None:
        missing = [k for k in parcel_keys if k not in case.parcel_rings]
        if missing:
            raise survey.ParcelNotFoundError(f'地號 {missing} 不存在於案件資料中')

    case_id_tag = make_case_id(case.case_id, date_str)

    layers = survey.build_layers(case, parcel_keys=parcel_keys, include_refs=include_refs,
                                  case_id_tag=case_id_tag)
    total_rows = sum(len(l['rows']) for l in layers)
    if total_rows == 0:
        scope = '所選地號' if parcel_keys is not None else '此案件'
        raise ExportAbortedError(f'{scope}查無任何有效點/線/面幾何資料，已中止輸出（不會產生空的 GPKG）')

    os.makedirs(hist_dir, exist_ok=True)
    gpkg_path = os.path.join(hist_dir, MASTER_GPKG_NAME)

    written_layers = upsert_gpkg(gpkg_path, layers, case_id_tag)
    log(f'已寫入彙整 GPKG：{gpkg_path}（案件標記：{case_id_tag}）')
    for l in layers:
        if l['rows']:
            log(f"  {l['name']}：{len(l['rows'])} 筆")

    qgz_result = None
    if qgz_path:
        backup_path = qgz_path + '.bak'
        shutil.copy2(qgz_path, backup_path)
        log(f'已備份原專案檔至：{backup_path}')

        qgs_name, qgs_text, other_entries = qgz_writer.read_qgz(qgz_path)
        layer_specs = qgz_writer.build_layer_specs(
            [l for l in layers if l['name'] in written_layers],
        )
        gpkg_rel_path = f'./複丈歷史/{MASTER_GPKG_NAME}'
        new_qgs_text, newly_added = qgz_writer.ensure_layers(qgs_text, layer_specs, gpkg_rel_path)
        qgz_writer.write_qgz(qgz_path, qgs_name, new_qgs_text, other_entries)
        if newly_added:
            log(f"已更新 QGIS 專案：{qgz_path}（複丈歷史 群組新增圖層：{'、'.join(newly_added)}）")
        else:
            log(f'已更新 QGIS 專案：{qgz_path}（複丈歷史 群組圖層已存在，資料已透過 GPKG 更新）')
        qgz_result = qgz_path

    return {
        'gpkg_path': gpkg_path,
        'qgz_path': qgz_result,
        'case_id_tag': case_id_tag,
        'layer_counts': {l['name']: len(l['rows']) for l in layers if l['rows']},
    }
