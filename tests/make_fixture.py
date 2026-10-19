"""產生合成的複丈案件資料夾（D 系列 DBF，Big5），供 JS 版與舊版 Python 版對照測試。

用法：python3 make_fixture.py <輸出資料夾> [twd67]
twd67：座標改用「TWD97 反推的 TWD67」（平移 -829.07 E / +205.22 N 附近），測 TWD67 轉換。
"""
import os
import struct
import sys

OFF_E, OFF_N = 829.073, -205.223  # TWD97 - TWD67 的大致偏移（東、北）


def write_dbf(path, fields, rows):
    """fields: [(name, len)]（一律 C 型）；rows: [dict]"""
    rec_size = 1 + sum(l for _, l in fields)
    header_size = 32 + 32 * len(fields) + 1
    out = bytearray()
    out += struct.pack('<BBBBIHH', 3, 126, 10, 19, len(rows), header_size, rec_size) + b'\x00' * 20
    for name, l in fields:
        out += name.encode('ascii').ljust(11, b'\x00') + b'C' + b'\x00' * 4 + bytes([l, 0]) + b'\x00' * 14
    out += b'\x0d'
    for r in rows:
        out += b' '
        for name, l in fields:
            raw = str(r.get(name, '')).encode('big5')[:l]
            out += raw.ljust(l, b' ')
    out += b'\x1a'
    open(path, 'wb').write(bytes(out))


def pt(num, e, n, ref='0', remark='', matter='1', source='2'):
    return dict(COT_NUMBER=num, COT_REF=ref, COT_X=f'{e:.3f}', COT_Y=f'{n:.3f}',
                COT_MATTER=matter, COT_SOURCE=source, COT_REMARK=remark)


def build(folder, twd67=False):
    os.makedirs(folder, exist_ok=True)
    base = os.path.basename(os.path.normpath(folder))
    e0, n0 = 218000.0, 2709000.0
    if twd67:
        e0, n0 = e0 - OFF_E, n0 - OFF_N

    def c(de, dn):
        return e0 + de, n0 + dn

    pts = [
        (101, *c(0, 0)), (102, *c(30.5, 0.25)), (103, *c(31, 40.125)), (104, *c(0.5, 41)),
        (105, *c(60, 0)), (106, *c(61, 42)), (107, *c(-30, 10)), (108, *c(-31, 50)),
    ]
    d14 = [pt(n, e, nn, remark=('界樁' if n == 101 else '')) for n, e, nn in pts]
    d14.append(pt(101, *c(10.25, 10.5), ref='1'))      # 101.1 參考點
    d14.append(pt(102, *c(20.75, 15.0), ref='2'))      # 102.2
    f14 = [('COT_NUMBER', 8), ('COT_REF', 4), ('COT_X', 14), ('COT_Y', 14), ('COT_MATTER', 4),
           ('COT_SOURCE', 4), ('COT_REMARK', 20)]
    write_dbf(f'{folder}/{base}.D14', f14, d14)
    # 舊圖：座標略有不同
    d2c = [pt(n, e + 0.5, nn - 0.5) for n, e, nn in pts[:6]]
    write_dbf(f'{folder}/{base}.D2C', f14, d2c)

    def ln(ls, lp, rs, rp, top, bot, mid='0', mode='1', lpe='0', rpe='0'):
        return dict(L_SECTION=ls, L_PARCEL=lp, L_PARCEL_E=lpe, R_SECTION=rs, R_PARCEL=rp, R_PARCEL_E=rpe,
                    LIN_TOP=top, LIN_MID=mid, LIN_BOT=bot, LIN_MODE=mode)
    f21 = [('L_SECTION', 6), ('L_PARCEL', 6), ('L_PARCEL_E', 6), ('R_SECTION', 6), ('R_PARCEL', 6),
           ('R_PARCEL_E', 6), ('LIN_TOP', 8), ('LIN_MID', 8), ('LIN_BOT', 8), ('LIN_MODE', 4)]
    d21 = [ln(1, 10, 1, 0, 101, 102), ln(1, 10, 1, 11, 102, 103, mid=105), ln(1, 10, 1, 0, 103, 104),
           ln(1, 10, 1, 0, 104, 101), ln(1, 11, 1, 0, 102, 105), ln(1, 11, 1, 0, 105, 106),
           ln(1, 11, 1, 0, 106, 103), ln(2, 20, 1, 0, 107, 108, lpe='1'), ln(1, 11, 1, 0, 999, 101)]
    write_dbf(f'{folder}/{base}.D21', f21, d21)
    write_dbf(f'{folder}/{base}.D2D', f21, d21[:5])

    f13 = [('O_SECTION', 6), ('O_PARCEL', 6), ('O_PARCEL_E', 6)] + [(f'COORD_{i}', 8) for i in range(1, 9)]

    def ring(sec, m, ch, ids):
        r = dict(O_SECTION=sec, O_PARCEL=m, O_PARCEL_E=ch)
        for i in range(1, 9):
            r[f'COORD_{i}'] = ids[i - 1] if i <= len(ids) else ''
        return r
    d13 = [ring(1, 10, 0, [101, 102, 103, 104]), ring(1, 11, 0, [102, 105, 106]),
           ring(1, 11, 0, [103]), ring(2, 20, 1, [107, 108, 101]), ring(1, 12, 0, ['101.1', 102, 103])]
    write_dbf(f'{folder}/{base}.D13', f13, d13)
    write_dbf(f'{folder}/{base}.D2B', f13, d13[:2])

    f11 = [('SECTION_O', 6), ('PAR_O_M', 6), ('PAR_O_C', 6), ('AREA_NEW', 12), ('AREA_OLD', 12),
           ('CATE_NEW', 8), ('CATE_OLD', 8)]
    write_dbf(f'{folder}/{base}.D11', f11, [
        dict(SECTION_O=1, PAR_O_M=10, PAR_O_C=0, AREA_NEW='0.1234', AREA_OLD='0.1', CATE_NEW='建', CATE_OLD='旱'),
        dict(SECTION_O=1, PAR_O_M=11, PAR_O_C=0, AREA_NEW='', AREA_OLD='0.05', CATE_NEW='', CATE_OLD='田')])

    f20 = [('CTL_NAME', 10), ('CTL_X', 14), ('CTL_Y', 14), ('CTL_LEVEL', 8)]
    write_dbf(f'{folder}/{base}.D20', f20, [
        dict(CTL_NAME='Q01', CTL_X=f'{c(5, 5)[0]:.3f}', CTL_Y=f'{c(5, 5)[1]:.3f}', CTL_LEVEL='補點'),
        dict(CTL_NAME='Q02', CTL_X=f'{c(50, 5)[0]:.3f}', CTL_Y=f'{c(50, 5)[1]:.3f}', CTL_LEVEL='一等'),
        dict(CTL_NAME='', CTL_X='1', CTL_Y='2', CTL_LEVEL='')])

    f29 = [('LIN_TOP', 10), ('LIN_MID', 10), ('LIN_BOT', 10), ('LIN_MODE', 4)]
    write_dbf(f'{folder}/{base}.D29', f29, [
        dict(LIN_TOP='101.1', LIN_MID='0', LIN_BOT='102.2', LIN_MODE='1'),
        dict(LIN_TOP='101', LIN_MID='101.1', LIN_BOT='102', LIN_MODE='2'),
        dict(LIN_TOP='101.9', LIN_MID='0', LIN_BOT='102', LIN_MODE='1')])  # 找不到 -> 略過


if __name__ == '__main__':
    build(sys.argv[1], twd67=len(sys.argv) > 2 and sys.argv[2] == 'twd67')
