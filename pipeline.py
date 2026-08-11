"""整合流程：讀取案件 -> 建圖層 -> 寫 GPKG -> 修改 QGZ 專案。"""
import os
import shutil

import survey
import qgz_writer
from gpkg_writer import build_gpkg


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


def run_export(case: survey.CaseData, parcel_keys, date_str, hist_dir, qgz_path, log=print, include_refs=True):
    """執行匯出。parcel_keys=None 表示全部輸出；否則為 [(sec,m,c), ...] 地號清單（可多選）。
    include_refs 控制補點/参考點/参考線是否輸出（不受地號篩選影響，全有或全無）。

    - 若指定地號但地號不存在，呼叫端應在呼叫前已用 find_parcel_by_label 驗證並中止，
      本函式仍會在任一 key 不在 case.parcel_rings 時拋出例外作為最後防線。
    - 若建出的圖層全部沒有資料，會拋出 ExportAbortedError 並且「不會」寫出任何檔案。
    """
    if parcel_keys is not None:
        missing = [k for k in parcel_keys if k not in case.parcel_rings]
        if missing:
            raise survey.ParcelNotFoundError(f'地號 {missing} 不存在於案件資料中')

    layers = survey.build_layers(case, parcel_keys=parcel_keys, include_refs=include_refs)
    total_rows = sum(len(l['rows']) for l in layers)
    if total_rows == 0:
        scope = '所選地號' if parcel_keys is not None else '此案件'
        raise ExportAbortedError(f'{scope}查無任何有效點/線/面幾何資料，已中止輸出（不會產生空的 GPKG）')

    os.makedirs(hist_dir, exist_ok=True)
    gpkg_name = f'{case.case_id}_{date_str}.gpkg'
    gpkg_path = os.path.join(hist_dir, gpkg_name)

    written_layers = build_gpkg(gpkg_path, layers)
    log(f'已寫入 GPKG：{gpkg_path}')
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
            name_prefix=f'{case.case_id}_{date_str}',
        )
        group_label = f'{case.case_id} ({date_str})'
        gpkg_rel_path = f'./複丈歷史/{gpkg_name}'
        new_qgs_text = qgz_writer.patch_qgs(qgs_text, group_label, layer_specs, gpkg_rel_path)
        qgz_writer.write_qgz(qgz_path, qgs_name, new_qgs_text, other_entries)
        log(f'已更新 QGIS 專案：{qgz_path}（複丈歷史 > {group_label}）')
        qgz_result = qgz_path

    return {
        'gpkg_path': gpkg_path,
        'qgz_path': qgz_result,
        'layer_counts': {l['name']: len(l['rows']) for l in layers if l['rows']},
    }
