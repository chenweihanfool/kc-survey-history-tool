"""GitHub Releases 自動更新：檢查最新版本、下載、自我取代並重啟。

僅在以 PyInstaller 打包的 exe（sys.frozen）下才會實際取代執行檔；
以原始碼（python main.py）執行時只會檢查並記錄，不會自我取代。
任何檢查/下載失敗都不拋出例外給呼叫端，安靜地當作「沒有更新」處理，
確保網路異常時仍可正常開啟舊版。
"""
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

from version import GITHUB_OWNER, GITHUB_REPO

API_URL = f'https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest'
USER_AGENT = f'{GITHUB_REPO}-updater'
REQUEST_TIMEOUT = 6
DOWNLOAD_TIMEOUT = 30


def _parse_version(v):
    v = (v or '').strip().lstrip('vV')
    parts = []
    for p in v.split('.'):
        digits = ''.join(ch for ch in p if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


def is_newer(latest_version, current_version):
    return _parse_version(latest_version) > _parse_version(current_version)


def fetch_latest_release():
    """回傳 {'version', 'exe_url', 'exe_name', 'size'} 或 None（查無資料/查詢失敗）。"""
    req = urllib.request.Request(API_URL, headers={
        'User-Agent': USER_AGENT,
        'Accept': 'application/vnd.github+json',
    })
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError):
        return None

    tag = data.get('tag_name') or ''
    if not tag:
        return None
    exe_asset = next((a for a in data.get('assets', []) if a.get('name', '').lower().endswith('.exe')), None)
    if not exe_asset:
        return None
    return {
        'version': tag,
        'exe_url': exe_asset.get('browser_download_url'),
        'exe_name': exe_asset.get('name'),
        'size': exe_asset.get('size'),
    }


def download_exe(url, dest_path, expected_size=None):
    """下載並嚴格驗證檔案完整性：比對 HTTP Content-Length 與 GitHub Release 記錄的檔案大小，
    任何一個對不上都視為下載不完整而中止（不寫入/不覆蓋任何東西），避免用損毀的執行檔
    取代掉正在運作的舊版（PyInstaller onefile 執行檔若不完整，啟動時會出現
    "Failed to load Python DLL" 這類錯誤）。
    """
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT) as resp:
        content_length = resp.headers.get('Content-Length')
        data = resp.read()

    if len(data) < 1024 or data[:2] != b'MZ':
        raise ValueError('下載的檔案不是有效的執行檔（可能下載不完整或來源錯誤）')
    if content_length is not None and len(data) != int(content_length):
        raise ValueError(f'下載不完整：HTTP 回應宣告 {content_length} bytes，實際收到 {len(data)} bytes')
    if expected_size is not None and len(data) != expected_size:
        raise ValueError(
            f'下載檔案大小與 GitHub Release 記錄不符（預期 {expected_size} bytes，'
            f'實際 {len(data)} bytes），可能下載中斷，已中止更新'
        )

    with open(dest_path, 'wb') as f:
        f.write(data)
    if os.path.getsize(dest_path) != len(data):
        raise ValueError('寫入檔案大小與下載內容不符，可能磁碟空間不足或寫入中斷')


_UPDATE_PS1 = '''$ErrorActionPreference = 'SilentlyContinue'
$newExe = "{new_exe}"
$targetExe = "{target_exe}"
$backupExe = "{backup_exe}"
for ($i = 0; $i -lt 30; $i++) {{
    Start-Sleep -Milliseconds 500
    try {{
        if (Test-Path $targetExe) {{
            if (Test-Path $backupExe) {{ Remove-Item -Path $backupExe -Force -ErrorAction SilentlyContinue }}
            Move-Item -Path $targetExe -Destination $backupExe -Force -ErrorAction Stop
        }}
        Move-Item -Path $newExe -Destination $targetExe -Force -ErrorAction Stop
        Start-Process -FilePath $targetExe
        Remove-Item -Path $PSCommandPath -Force -ErrorAction SilentlyContinue
        exit 0
    }} catch {{
        continue
    }}
}}
'''


def apply_self_update(new_exe_path):
    """回傳 True 表示已交給外部腳本處理，呼叫端應盡快結束目前程序（例如 os._exit(0)）。
    非 frozen（開發模式）下回傳 False，不做任何取代動作。

    取代前會先把目前執行檔備份成 '{原檔名}.old.exe'（同目錄），若新版有問題開不起來，
    使用者仍可手動把備份檔改回原檔名復原舊版。
    """
    if not getattr(sys, 'frozen', False):
        return False

    target_exe = sys.executable
    backup_exe = target_exe + '.old.exe'
    script = _UPDATE_PS1.format(new_exe=new_exe_path, target_exe=target_exe, backup_exe=backup_exe)
    ps1_path = os.path.join(tempfile.gettempdir(), 'kc_survey_tool_update.ps1')
    with open(ps1_path, 'w', encoding='utf-8-sig') as f:
        f.write(script)

    # 注意：DETACHED_PROCESS 會讓 powershell.exe 因缺少 console 而無法正常啟動/執行腳本
    # （實測會直接以 exit code 0 結束但完全不執行腳本內容）。CREATE_NO_WINDOW 才是
    # 正確用法：保留 console 但不顯示視窗，腳本才會確實執行。
    subprocess.Popen(
        ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1_path],
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    return True


def check_and_prepare_update(current_version, log=lambda m: None):
    """執行完整檢查流程。回傳 True 表示已觸發自我更新（呼叫端應盡快結束程序）；否則 False。"""
    new_exe_path = None
    try:
        latest = fetch_latest_release()
        if not latest:
            return False
        if not is_newer(latest['version'], current_version):
            return False

        log(f"發現新版本 {latest['version']}（目前 v{current_version}），正在下載…")

        # 下載到跟目前執行檔「同一個磁碟機」的暫存檔，讓之後取代時用的是同磁碟快速
        # rename，而不是跨磁碟複製（跨磁碟複製較容易在中途被防毒軟體或網路磁碟同步
        # 干擾而損毀，是先前版本更新失敗的主因）。開發模式（非 frozen）沒有目標路徑
        # 可比對，一律用系統暫存資料夾即可，反正不會真的套用取代。
        if getattr(sys, 'frozen', False):
            target_dir = os.path.dirname(sys.executable)
        else:
            target_dir = tempfile.gettempdir()
        new_exe_path = os.path.join(target_dir, f".{latest['exe_name']}.downloading")

        download_exe(latest['exe_url'], new_exe_path, expected_size=latest.get('size'))
        log('下載完成，準備套用更新並重新啟動…')

        if apply_self_update(new_exe_path):
            return True
        log('（開發模式執行，略過自我取代）')
        _cleanup(new_exe_path)
        return False
    except Exception as e:
        log(f'檢查更新時發生錯誤，已略過：{e}')
        _cleanup(new_exe_path)
        return False


def _cleanup(path):
    """清掉下載到一半/開發模式下用不到的暫存檔（apply_self_update 成功時，
    該檔案的所有權已交給 PowerShell 腳本處理，不會呼叫這裡）。"""
    if path and os.path.exists(path):
        try:
            os.remove(path)
        except OSError:
            pass
