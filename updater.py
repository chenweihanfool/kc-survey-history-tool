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
    """回傳 {'version', 'exe_url', 'exe_name'} 或 None（查無資料/查詢失敗）。"""
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
    }


def download_exe(url, dest_path):
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT) as resp:
        data = resp.read()
    if len(data) < 1024 or data[:2] != b'MZ':
        raise ValueError('下載的檔案不是有效的執行檔（可能下載不完整或來源錯誤）')
    with open(dest_path, 'wb') as f:
        f.write(data)


_UPDATE_PS1 = '''$ErrorActionPreference = 'SilentlyContinue'
$newExe = "{new_exe}"
$targetExe = "{target_exe}"
for ($i = 0; $i -lt 30; $i++) {{
    Start-Sleep -Milliseconds 500
    try {{
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
    """
    if not getattr(sys, 'frozen', False):
        return False

    target_exe = sys.executable
    script = _UPDATE_PS1.format(new_exe=new_exe_path, target_exe=target_exe)
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
    try:
        latest = fetch_latest_release()
        if not latest:
            return False
        if not is_newer(latest['version'], current_version):
            return False

        log(f"發現新版本 {latest['version']}（目前 v{current_version}），正在下載…")
        tmp_dir = os.path.join(tempfile.gettempdir(), 'kc_survey_tool_update')
        os.makedirs(tmp_dir, exist_ok=True)
        new_exe_path = os.path.join(tmp_dir, latest['exe_name'])
        download_exe(latest['exe_url'], new_exe_path)
        log('下載完成，準備套用更新並重新啟動…')

        if apply_self_update(new_exe_path):
            return True
        log('（開發模式執行，略過自我取代）')
        return False
    except Exception as e:
        log(f'檢查更新時發生錯誤，已略過：{e}')
        return False
