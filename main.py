"""複丈歷史資料匯出工具 - GUI

流程：選擇複丈案件資料夾（如 KC0391）-> 自動偵測相鄰的 QGIS 專案資料夾與複丈歷史資料夾
     -> 選擇輸出全部或指定地號 -> 輸出 GPKG 至複丈歷史資料夾並更新 QGZ 專案。
"""
import os
import queue
import threading
import traceback
from datetime import date
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

import survey
import pipeline
import updater
from version import APP_TITLE, APP_VERSION, CHANGELOG


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(f'{APP_TITLE} v{APP_VERSION}')
        self.geometry('720x860')
        self.minsize(680, 760)

        self.case = None
        self.case_folder = None
        self.setup_info = None
        self.qgz_path_var = tk.StringVar()
        self.qgz_display_var = tk.StringVar()
        self.date_var = tk.StringVar(value=date.today().isoformat())
        self.scope_var = tk.StringVar(value='all')
        self.parcel_query_var = tk.StringVar()
        self.include_refs_var = tk.BooleanVar(value=True)
        self.status_var = tk.StringVar(value='請先選擇複丈案件資料夾')

        self._log_queue = queue.Queue()
        self._parcel_labels = []

        self._build_ui()
        self.after(100, self._poll_log_queue)
        self.after(300, self._start_update_check)

    def _start_update_check(self):
        threading.Thread(target=self._update_check_thread, daemon=True).start()

    def _update_check_thread(self):
        triggered = updater.check_and_prepare_update(APP_VERSION, log=self.log)
        if triggered:
            self.after(0, self._begin_restart_for_update)

    def _begin_restart_for_update(self):
        self.status_var.set('已下載新版本，即將重新啟動…')
        self.after(1200, self._finalize_update_and_exit)

    def _finalize_update_and_exit(self):
        self.destroy()
        os._exit(0)

    def show_changelog(self):
        win = tk.Toplevel(self)
        win.title('更新歷程')
        win.geometry('560x520')
        win.transient(self)

        frame = ttk.Frame(win)
        frame.pack(fill='both', expand=True, padx=12, pady=12)

        canvas = tk.Canvas(frame, highlightthickness=0)
        scrollbar = ttk.Scrollbar(frame, orient='vertical', command=canvas.yview)
        inner = ttk.Frame(canvas)
        inner.bind('<Configure>', lambda _e: canvas.configure(scrollregion=canvas.bbox('all')))
        canvas.create_window((0, 0), window=inner, anchor='nw')
        canvas.configure(yscrollcommand=scrollbar.set)
        canvas.pack(side='left', fill='both', expand=True)
        scrollbar.pack(side='right', fill='y')

        for entry in CHANGELOG:
            title = ttk.Label(inner, text=f"v{entry['version']}　{entry['date']}",
                               font=('', 11, 'bold'), foreground='#1a5cb8')
            title.pack(anchor='w', pady=(10, 2))
            for note in entry['notes']:
                ttk.Label(inner, text=f'• {note}', wraplength=500, justify='left').pack(anchor='w', padx=(12, 0))

        ttk.Button(win, text='關閉', command=win.destroy).pack(pady=(0, 10))

    # ────────────────────────────────────────────────────────────────
    def _build_ui(self):
        pad = {'padx': 10, 'pady': 6}

        header = ttk.Frame(self)
        header.pack(fill='x', padx=10, pady=(8, 0))
        ttk.Label(header, text=APP_TITLE, font=('', 12, 'bold')).pack(side='left')
        ver_link = ttk.Label(header, text=f'v{APP_VERSION}（點選查看更新歷程）',
                              foreground='#1a5cb8', cursor='hand2')
        ver_link.pack(side='left', padx=10)
        ver_link.bind('<Button-1>', lambda _e: self.show_changelog())

        step1 = ttk.LabelFrame(self, text='步驟 1 — 選擇複丈案件資料夾')
        step1.pack(fill='x', **pad)
        row = ttk.Frame(step1)
        row.pack(fill='x', padx=8, pady=6)
        ttk.Button(row, text='📁 選擇資料夾…', command=self.pick_case_folder).pack(side='left')
        self.lbl_case = ttk.Label(row, text='尚未選擇（例如 KC0391，內含 .D14 等檔案）', foreground='#888')
        self.lbl_case.pack(side='left', padx=10)

        self.lbl_detect = ttk.Label(step1, text='', foreground='#2a7a3a', wraplength=660, justify='left')
        self.lbl_detect.pack(fill='x', padx=8, pady=(0, 6))

        step1b = ttk.Frame(step1)
        step1b.pack(fill='x', padx=8, pady=(0, 8))
        ttk.Label(step1b, text='QGIS 專案檔（複丈歷史群組將寫入此檔）：').pack(side='left')
        self.qgz_combo = ttk.Combobox(step1b, textvariable=self.qgz_display_var, state='readonly', width=40)
        self.qgz_combo.pack(side='left', padx=6)
        ttk.Button(step1b, text='另選檔案…', command=self.pick_qgz_manually).pack(side='left')

        step2 = ttk.LabelFrame(self, text='步驟 2 — 複丈日期')
        step2.pack(fill='x', **pad)
        row2 = ttk.Frame(step2)
        row2.pack(fill='x', padx=8, pady=6)
        ttk.Label(row2, text='日期（YYYY-MM-DD，用於檔名與 QGIS 群組命名）：').pack(side='left')
        ttk.Entry(row2, textvariable=self.date_var, width=14).pack(side='left', padx=6)

        step3 = ttk.LabelFrame(self, text='步驟 3 — 輸出範圍')
        step3.pack(fill='x', **pad)
        row3 = ttk.Frame(step3)
        row3.pack(fill='x', padx=8, pady=4)
        ttk.Radiobutton(row3, text='全部地號', variable=self.scope_var, value='all',
                         command=self._on_scope_change).pack(side='left')
        ttk.Radiobutton(row3, text='指定地號', variable=self.scope_var, value='one',
                         command=self._on_scope_change).pack(side='left', padx=(20, 0))

        row3b = ttk.Frame(step3)
        row3b.pack(fill='x', padx=8, pady=(0, 4))
        ttk.Checkbutton(
            row3b, text='包含補點／参考點／参考線（不受地號篩選影響，全部輸出或完全不輸出）',
            variable=self.include_refs_var,
        ).pack(side='left')

        self.parcel_frame = ttk.Frame(step3)
        self.parcel_frame.pack(fill='x', padx=8, pady=(4, 8))

        search_row = ttk.Frame(self.parcel_frame)
        search_row.pack(fill='x')
        ttk.Label(search_row, text='🔍 地號搜尋：').pack(side='left')
        self.parcel_search_entry = ttk.Entry(search_row, textvariable=self.parcel_query_var, width=20)
        self.parcel_search_entry.pack(side='left', padx=6)
        self.parcel_search_entry.bind('<KeyRelease>', self._on_parcel_typing)
        ttk.Button(search_row, text='全選', command=self._select_all_parcels).pack(side='left', padx=(10, 2))
        ttk.Button(search_row, text='清除', command=self._clear_parcel_selection).pack(side='left')
        self.parcel_info = ttk.Label(search_row, text='', foreground='#888')
        self.parcel_info.pack(side='left', padx=10)

        list_row = ttk.Frame(self.parcel_frame)
        list_row.pack(fill='x', pady=(4, 0))
        scrollbar = ttk.Scrollbar(list_row, orient='vertical')
        self.parcel_listbox = tk.Listbox(
            list_row, selectmode=tk.EXTENDED, height=8,
            yscrollcommand=scrollbar.set, exportselection=False,
        )
        scrollbar.configure(command=self.parcel_listbox.yview)
        self.parcel_listbox.pack(side='left', fill='both', expand=True)
        scrollbar.pack(side='left', fill='y')
        self.parcel_listbox.bind('<<ListboxSelect>>', self._on_parcel_selection_change)

        self._displayed_labels = []
        self._label_to_key = {}
        self._selected_labels = set()
        self._set_parcel_enabled(False)

        step4 = ttk.LabelFrame(self, text='步驟 4 — 執行')
        step4.pack(fill='x', **pad)
        row4 = ttk.Frame(step4)
        row4.pack(fill='x', padx=8, pady=6)
        self.btn_run = ttk.Button(row4, text='▶ 開始輸出', command=self.on_run, state='disabled')
        self.btn_run.pack(side='left')
        ttk.Label(row4, textvariable=self.status_var, foreground='#1a5cb8').pack(side='left', padx=12)

        log_frame = ttk.LabelFrame(self, text='紀錄')
        log_frame.pack(fill='both', expand=True, **pad)
        self.log_text = tk.Text(log_frame, height=14, state='disabled', wrap='word')
        self.log_text.pack(fill='both', expand=True, padx=8, pady=8)

    def _set_parcel_enabled(self, enabled):
        # 注意：Listbox 在 disabled 狀態下 insert() 會被靜默忽略，
        # 所以清單本身維持 normal，只鎖搜尋欄位；未選「指定地號」時勾選也不會生效（on_run 會忽略）。
        self.parcel_search_entry.configure(state='normal' if enabled else 'disabled')

    def _on_scope_change(self):
        self._set_parcel_enabled(self.scope_var.get() == 'one')

    # ────────────────────────────────────────────────────────────────
    def log(self, msg):
        self._log_queue.put(msg)

    def _poll_log_queue(self):
        try:
            while True:
                msg = self._log_queue.get_nowait()
                self.log_text.configure(state='normal')
                self.log_text.insert('end', msg + '\n')
                self.log_text.see('end')
                self.log_text.configure(state='disabled')
        except queue.Empty:
            pass
        self.after(100, self._poll_log_queue)

    # ────────────────────────────────────────────────────────────────
    def pick_case_folder(self):
        folder = filedialog.askdirectory(title='選擇複丈案件資料夾（例如 KC0391）')
        if not folder:
            return
        self.status_var.set('讀取中…')
        self.btn_run.configure(state='disabled')
        threading.Thread(target=self._load_case_thread, args=(folder,), daemon=True).start()

    def _load_case_thread(self, folder):
        try:
            case = survey.load_case(folder)
        except survey.CaseNotFoundError as e:
            self.after(0, lambda: messagebox.showerror('找不到案件資料', str(e)))
            self.after(0, lambda: self.status_var.set('請先選擇複丈案件資料夾'))
            return
        except Exception as e:
            self.after(0, lambda: messagebox.showerror('讀取失敗', f'{e}\n\n{traceback.format_exc()}'))
            self.after(0, lambda: self.status_var.set('讀取失敗'))
            return

        setup = pipeline.find_qgis_setup(folder)
        self.after(0, lambda: self._on_case_loaded(folder, case, setup))

    def _on_case_loaded(self, folder, case, setup):
        self.case_folder = folder
        self.case = case
        self.setup_info = setup

        self.lbl_case.configure(text=f'✓ {case.case_id}（{folder}）', foreground='#2a7a3a')

        parcels = survey.list_parcels(case)
        self._parcel_labels = [p['label'] for p in parcels]
        self._label_to_key = {p['label']: p['key'] for p in parcels}
        self._selected_labels = set()
        self.parcel_query_var.set('')
        self._refresh_parcel_listbox(self._parcel_labels)

        detect_lines = [
            f'界址點 {len(case.main_pts)} 筆、參考點 {len(case.sub_pts)} 筆、補點 {len(case.supplements)} 筆、'
            f'地籍線 {len(case.lines)} 筆、地號 {len(parcels)} 筆'
        ]
        if setup['qgis_dir']:
            detect_lines.append(f"QGIS 專案資料夾：{setup['qgis_dir']}")
            if setup['qgz_candidates']:
                names = [os.path.basename(p) for p in setup['qgz_candidates']]
                self.qgz_combo.configure(values=names, state='readonly')
                self.qgz_combo.current(0)
                self.qgz_path_var.set(setup['qgz_candidates'][0])
                self._qgz_name_to_path = dict(zip(names, setup['qgz_candidates']))
                self.qgz_combo.bind('<<ComboboxSelected>>', self._on_qgz_pick)
            else:
                detect_lines.append('⚠ 該資料夾內找不到 .qgz 專案檔，請手動選擇，或留空僅輸出 GPKG')
                self.qgz_combo.configure(values=[], state='readonly')
                self.qgz_path_var.set('')
                self.qgz_display_var.set('')
        else:
            detect_lines.append('⚠ 找不到相鄰的 QGIS 資料夾，請手動選擇 QGZ 專案檔，或留空僅輸出 GPKG')
            self.qgz_combo.configure(values=[], state='readonly')
            self.qgz_path_var.set('')
            self.qgz_display_var.set('')

        self.lbl_detect.configure(text='\n'.join(detect_lines))
        self.status_var.set('已讀取案件資料，可設定輸出範圍後執行')
        self.btn_run.configure(state='normal')
        self.log(f'已讀取案件：{case.case_id}（{folder}）')
        if case.used_new_points:
            self.log('點位採用「新」版資料（D2C）')
        if case.used_new_lines:
            self.log('線段採用「新」版資料（D2D）')
        if case.used_new_rings:
            self.log('宗地邊界採用「新」版資料（D2B）')

    def _on_qgz_pick(self, _event=None):
        name = self.qgz_combo.get()
        path = getattr(self, '_qgz_name_to_path', {}).get(name)
        if path:
            self.qgz_path_var.set(path)

    def pick_qgz_manually(self):
        path = filedialog.askopenfilename(title='選擇 QGIS 專案檔', filetypes=[('QGIS Project', '*.qgz')])
        if path:
            self.qgz_path_var.set(path)
            self.qgz_combo.configure(values=[os.path.basename(path)], state='readonly')
            self.qgz_combo.current(0)
            self._qgz_name_to_path = {os.path.basename(path): path}

    def _on_parcel_typing(self, _event=None):
        q = self.parcel_query_var.get().strip()
        labels = self._parcel_labels if not q else [lb for lb in self._parcel_labels if q in lb]
        self._refresh_parcel_listbox(labels)

    def _refresh_parcel_listbox(self, labels):
        self._displayed_labels = labels
        self.parcel_listbox.delete(0, tk.END)
        for lb in labels:
            self.parcel_listbox.insert(tk.END, lb)
        for i, lb in enumerate(labels):
            if lb in self._selected_labels:
                self.parcel_listbox.selection_set(i)
        self._update_parcel_info()

    def _update_parcel_info(self):
        self.parcel_info.configure(text=f'已選 {len(self._selected_labels)} 個地號')

    def _on_parcel_selection_change(self, _event=None):
        selected_indices = set(self.parcel_listbox.curselection())
        for i, lb in enumerate(self._displayed_labels):
            if i in selected_indices:
                self._selected_labels.add(lb)
            else:
                self._selected_labels.discard(lb)
        self._update_parcel_info()

    def _select_all_parcels(self):
        self.parcel_listbox.selection_set(0, tk.END)
        self._selected_labels.update(self._displayed_labels)
        self._update_parcel_info()

    def _clear_parcel_selection(self):
        self.parcel_listbox.selection_clear(0, tk.END)
        self._selected_labels.clear()
        self._update_parcel_info()

    # ────────────────────────────────────────────────────────────────
    def on_run(self):
        if not self.case:
            return
        date_str = self.date_var.get().strip()
        if not date_str:
            messagebox.showerror('輸入錯誤', '請輸入複丈日期')
            return

        parcel_keys = None
        if self.scope_var.get() == 'one':
            if not self._selected_labels:
                messagebox.showerror('輸入錯誤', '請至少選擇一個地號（可從清單中複選）\n已中止輸出，不會產生任何檔案。')
                self.status_var.set('尚未選擇地號，已中止')
                return
            parcel_keys, missing_labels = [], []
            for lb in self._selected_labels:
                key = self._label_to_key.get(lb)
                if key is None:
                    missing_labels.append(lb)
                else:
                    parcel_keys.append(key)
            if missing_labels:
                messagebox.showerror(
                    '查無地號',
                    f"找不到地號：{'、'.join(missing_labels)}\n已中止輸出，不會產生任何檔案。"
                )
                self.status_var.set('查無地號，已中止')
                return

        hist_dir = None
        if self.setup_info and self.setup_info['hist_dir']:
            hist_dir = self.setup_info['hist_dir']
        else:
            hist_dir = filedialog.askdirectory(title='選擇複丈歷史輸出資料夾')
            if not hist_dir:
                return

        qgz_path = self.qgz_path_var.get().strip() or None
        if qgz_path and not os.path.exists(qgz_path):
            messagebox.showerror('找不到專案檔', f'QGZ 專案檔不存在：{qgz_path}')
            return

        scope_desc = f'指定地號（{len(parcel_keys)} 筆）' if parcel_keys is not None else '全部地號'
        case_id_preview = pipeline.make_case_id(self.case.case_id, date_str)
        gpkg_note = (f'即將把資料寫入彙整 GPKG：\n{hist_dir}\\{pipeline.MASTER_GPKG_NAME}\n'
                     f'（案件標記：{case_id_preview}；若已有相同標記的舊資料會先取代）')
        if qgz_path:
            proceed = messagebox.askyesno(
                '確認執行',
                f'輸出範圍：{scope_desc}\n\n{gpkg_note}\n\n並修改 QGIS 專案檔：\n{qgz_path}\n'
                f'（會先自動備份為 .bak）\n\n確定要繼續嗎？'
            )
        else:
            proceed = messagebox.askyesno(
                '確認執行',
                f'輸出範圍：{scope_desc}\n\n{gpkg_note}\n\n（未選擇 QGZ 專案檔，僅寫入 GPKG）\n\n確定要繼續嗎？'
            )
        if not proceed:
            return

        include_refs = self.include_refs_var.get()

        self.btn_run.configure(state='disabled')
        self.status_var.set('輸出中…')
        threading.Thread(
            target=self._run_export_thread,
            args=(parcel_keys, date_str, hist_dir, qgz_path, include_refs),
            daemon=True,
        ).start()

    def _run_export_thread(self, parcel_keys, date_str, hist_dir, qgz_path, include_refs):
        try:
            result = pipeline.run_export(self.case, parcel_keys, date_str, hist_dir, qgz_path,
                                          log=self.log, include_refs=include_refs)
        except pipeline.ExportAbortedError as e:
            self.log(f'❌ 已中止：{e}')
            self.after(0, lambda: messagebox.showwarning('已中止輸出', str(e)))
            self.after(0, lambda: self.status_var.set('已中止（無資料）'))
            self.after(0, lambda: self.btn_run.configure(state='normal'))
            return
        except Exception as e:
            self.log(f'❌ 發生錯誤：{e}')
            tb = traceback.format_exc()
            self.after(0, lambda: messagebox.showerror('輸出失敗', f'{e}\n\n{tb}'))
            self.after(0, lambda: self.status_var.set('輸出失敗'))
            self.after(0, lambda: self.btn_run.configure(state='normal'))
            return

        self.log('✅ 完成')
        summary = '\n'.join(f'  {k}: {v} 筆' for k, v in result['layer_counts'].items())
        msg = (f"已寫入彙整 GPKG：\n{result['gpkg_path']}\n\n"
               f"案件標記：{result['case_id_tag']}\n\n本次筆數：\n{summary}")
        if result['qgz_path']:
            msg += f"\n\nQGIS 專案已更新：\n{result['qgz_path']}"
        self.after(0, lambda: messagebox.showinfo('輸出完成', msg))
        self.after(0, lambda: self.status_var.set('完成'))
        self.after(0, lambda: self.btn_run.configure(state='normal'))


if __name__ == '__main__':
    app = App()
    app.mainloop()
