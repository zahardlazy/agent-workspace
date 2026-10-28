# auto_gui.py — ClickQA Auto • PySide6 • môn riêng từng acc • nhiều acc song song
import sys, os, re, json, time, html, threading, subprocess, random

from PySide6.QtCore import Qt, QObject, Signal, QTimer
from PySide6.QtGui import QColor, QFont, QFontDatabase
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QFrame, QLabel, QPushButton, QToolButton,
    QLineEdit, QComboBox, QCheckBox, QProgressBar, QVBoxLayout, QHBoxLayout,
    QGridLayout, QScrollArea, QTabWidget, QPlainTextEdit, QTableWidget,
    QTableWidgetItem, QHeaderView, QAbstractItemView, QMessageBox, QFileDialog,
    QDialog, QListWidget, QListWidgetItem)

CONFIG = r"C:\frida\config.json"
RUNNER = r"C:\frida\run_acc.py"

# ---------------- DESIGN ----------------
BG, CARD, CARD2, SUB, BORDER = "#0F0F14", "#181821", "#20202C", "#2A2A3A", "#34344A"
FIELD = "#15151D"
C_MAIN, C_MAIN_H, C_MAIN_D = "#8B5CF6", "#A78BFA", "#6D28D9"
C_OK, C_ERR, C_RUN, C_TXT, C_DIM, C_CYAN = \
    "#34D399", "#F87171", "#FBBF24", "#F0F0F5", "#8E8EA3", "#22D3EE"

ACC_COLORS = ["#9575CD", "#4DB6AC", "#FFB74D", "#F06292", "#64B5F6",
              "#AED581", "#FFF176", "#4DD0E1", "#BA68C8", "#FF8A65"]
ST_NEW, ST_RUN, ST_DONE, ST_ERR = ("○ Sẵn sàng", C_DIM), ("▶ Đang chạy", C_RUN), \
                                  ("✔ Hoàn thành", C_OK), ("✖ Lỗi", C_ERR)

DASH_COLS = ["Tài khoản", "Môn", "Trạng thái", "Chương", "✔ / ✖", "🎥", "Đang làm"]

QSS = """
QMainWindow, QDialog { background: #0F0F14; }
QWidget { background: transparent; color: #F0F0F5; }

QFrame[cssClass="toolbar"] { background: #6D28D9; border: none; }
QFrame[cssClass="card"]    { background: #181821; border: 1px solid #34344A; border-radius: 12px; }
QFrame[cssClass="acccard"] { background: #20202C; border: 1px solid #2A2A3A; border-radius: 10px; }

QLabel[cssClass="dim"]   { color: #8E8EA3; font-size: 11px; }
QLabel[cssClass="title"] { color: #FFFFFF; font-size: 20px; font-weight: bold; }
QLabel[cssClass="headst"]{ color: #D8CBF5; }
QLabel[cssClass="stat"]  { font-size: 26px; font-weight: bold; }

QPushButton { background: #2A2A3A; color: #F0F0F5; border: none; border-radius: 8px; padding: 8px 14px; }
QPushButton:hover { background: #3A3A4C; }
QPushButton:disabled { background: #23232E; color: #5C5C6A; }
QPushButton[mini="true"] { padding: 4px 10px; font-size: 11px; border-radius: 6px; }
QPushButton[danger="true"] { background: #5A2020; }
QPushButton[danger="true"]:hover { background: #7A2A2A; }
QPushButton[accent="true"] { background: #8B5CF6; color: #FFFFFF; font-weight: bold; }
QPushButton[accent="true"]:hover { background: #A78BFA; }

QFrame[cssClass="toolbar"] QPushButton { background: rgba(255,255,255,0.15); color: #FFFFFF; }
QFrame[cssClass="toolbar"] QPushButton:hover { background: rgba(255,255,255,0.28); }
QFrame[cssClass="toolbar"] QPushButton:disabled { background: rgba(0,0,0,0.25); color: rgba(255,255,255,0.45); }
QFrame[cssClass="toolbar"] QPushButton[runbtn="true"] { background: #FFFFFF; color: #6D28D9; font-weight: bold; font-size: 15px; padding: 10px 26px; }
QFrame[cssClass="toolbar"] QPushButton[runbtn="true"]:hover { background: #EDE7FF; }
QFrame[cssClass="toolbar"] QPushButton[runbtn="true"]:disabled { background: rgba(255,255,255,0.4); color: rgba(109,40,217,0.5); }
QFrame[cssClass="toolbar"] QPushButton[stopbtn="true"] { background: #8B2525; color: #FFFFFF; }
QFrame[cssClass="toolbar"] QPushButton[stopbtn="true"]:hover { background: #A53030; }

QLineEdit, QComboBox {
    background: #15151D; border: 1px solid #34344A; border-radius: 8px;
    padding: 6px 10px; color: #F0F0F5; selection-background-color: #8B5CF6;
}
QLineEdit:disabled, QComboBox:disabled { background: #1B1B24; color: #5C5C6A; }
QComboBox::drop-down { border: none; width: 22px; }
QComboBox QAbstractItemView {
    background: #15151D; border: 1px solid #34344A; color: #F0F0F5;
    selection-background-color: #8B5CF6; selection-color: #FFFFFF;
}

QCheckBox { spacing: 8px; background: transparent; }
QCheckBox::indicator { width: 16px; height: 16px; border-radius: 4px;
                       border: 1px solid #34344A; background: #15151D; }
QCheckBox::indicator:checked { background: #8B5CF6; border-color: #8B5CF6; }

QProgressBar { background: #26262F; border: none; border-radius: 4px; max-height: 8px; }
QProgressBar::chunk { background: #8B5CF6; border-radius: 4px; }

QTabWidget::pane { border: 1px solid #34344A; border-top: none; background: #0F0F14;
                   border-bottom-left-radius: 10px; border-bottom-right-radius: 10px; }
QTabBar { background: transparent; }
QTabBar::tab { background: #181821; color: #8E8EA3; padding: 9px 20px; margin-right: 3px;
               border-top-left-radius: 8px; border-top-right-radius: 8px; }
QTabBar::tab:selected { background: #20202C; color: #FFFFFF; }
QTabBar::tab:hover:!selected { color: #F0F0F5; }

QScrollArea { background: transparent; border: none; }
QScrollBar:vertical { background: #0F0F14; width: 10px; margin: 0; }
QScrollBar::handle:vertical { background: #2A2A3A; border-radius: 5px; min-height: 30px; }
QScrollBar::handle:vertical:hover { background: #3A3A4C; }
QScrollBar::add-line, QScrollBar::sub-line { height: 0; width: 0; }
QScrollBar::add-page, QScrollBar::sub-page { background: transparent; }

QPlainTextEdit { background: #181821; border: 1px solid #34344A; border-radius: 10px;
                 color: #F0F0F5; padding: 8px; selection-background-color: #8B5CF6; }

QTableWidget { background: #181821; alternate-background-color: #20202C;
               border: 1px solid #34344A; border-radius: 10px; gridline-color: transparent;
               color: #F0F0F5; font-size: 14px; selection-background-color: #8B5CF6; }
QTableWidget::item { padding: 4px 8px; border: none; }
QHeaderView::section { background: transparent; color: #8E8EA3; border: none;
                       border-bottom: 1px solid #34344A; padding: 8px 6px; font-size: 11px; }
QTableCornerButton::section { background: transparent; border: none; }

QListWidget { background: #15151D; border: 1px solid #34344A; border-radius: 8px;
              color: #F0F0F5; outline: none; }
QListWidget::item { padding: 8px; }
QListWidget::item:selected { background: #8B5CF6; }

QToolTip { background: #20202C; color: #F0F0F5; border: 1px solid #34344A; }
QMessageBox { background: #20202C; }
"""

# ---------------- CORE (lazy import) ----------------
_core_mod = None
def core():
    global _core_mod
    if _core_mod is None:
        import auto
        _core_mod = auto
    return _core_mod

def core_ready():
    return _core_mod is not None


class Signals(QObject):
    log = Signal(str, str)             # user, text
    state = Signal(object, str, str)   # row, text, color
    busy = Signal(bool)
    courses = Signal(list)
    head = Signal(str, str)            # text, color


class _StdoutBridge(QObject):
    """Đưa print() trong GUI process (vd login) vào panel log."""
    def __init__(self, sig):
        super().__init__()
        self._sig = sig
    def write(self, s):
        if s and s.strip():
            self._sig.log.emit(None, s)
        return len(s) if s else 0
    def flush(self): pass
    def isatty(self): return False


class MainWindow(QMainWindow):
    ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

    def __init__(self, mono_family):
        super().__init__()
        self.setWindowTitle("ClickQA Auto — DTU Suite")
        self.resize(1440, 900); self.setMinimumSize(1200, 760)
        self.mono = QFont(mono_family, 10)

        self.sig = Signals()
        self.sig.log.connect(self._on_log)
        self.sig.state.connect(self._on_state)
        self.sig.busy.connect(self.busy)
        self.sig.courses.connect(self._on_courses)
        self.sig.head.connect(self._on_head)

        self.rows, self.log_lines = [], []
        self.running = False
        self.color_map = {}
        self.course_names = []
        self.hint = None
        self._bank_m = 0
        self._headcol = None
        self._scorecol = None
        self._sig_cur = None

        self._stdout_bridge = _StdoutBridge(self.sig)
        sys.stdout = self._stdout_bridge

        self._build()

        self.timer = QTimer(self)
        self.timer.timeout.connect(self._refresh)
        self.timer.start(1000)

        self.load_config()

    # ================================================== UI
    def _dim(self, text):
        l = QLabel(text); l.setProperty("cssClass", "dim"); return l

    def _build(self):
        central = QWidget(); self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(0, 0, 0, 0); root.setSpacing(0)

        # ---------- TOOLBAR ----------
        bar = QFrame(); bar.setProperty("cssClass", "toolbar")
        bv = QVBoxLayout(bar); bv.setContentsMargins(24, 12, 24, 14); bv.setSpacing(8)
        r1 = QHBoxLayout()
        t = QLabel("⚡ ClickQA Auto"); t.setProperty("cssClass", "title")
        r1.addWidget(t); r1.addStretch(1)
        self.head_status = QLabel("○ Sẵn sàng"); self.head_status.setProperty("cssClass", "headst")
        r1.addWidget(self.head_status)
        bv.addLayout(r1)

        r2 = QHBoxLayout(); r2.setSpacing(8)
        for txt, fn in [("＋ Thêm", lambda: self.add_account()),
                        ("📋 Bulk", self.bulk),
                        ("📂 Từ file", self.import_file),
                        ("💾 Xuất", self.export_file)]:
            b = QPushButton(txt); b.clicked.connect(fn); r2.addWidget(b)
        r2.addSpacing(16)
        self.btn_rank = QPushButton("🏆 BXH")
        self.btn_rank.clicked.connect(self.show_ranking)
        r2.addWidget(self.btn_rank)
        self.btn_login = QPushButton("🔑 Đăng nhập tất cả")
        self.btn_login.clicked.connect(self.login_all); r2.addWidget(self.btn_login)
        r2.addStretch(1)
        self.btn_run = QPushButton("▶ CHẠY TẤT CẢ")
        self.btn_run.setProperty("runbtn", True)
        self.btn_run.clicked.connect(self.run_all); r2.addWidget(self.btn_run)
        self.btn_stop = QPushButton("■ Dừng")
        self.btn_stop.setProperty("stopbtn", True); self.btn_stop.setEnabled(False)
        self.btn_stop.clicked.connect(self.confirm_stop); r2.addWidget(self.btn_stop)
        bv.addLayout(r2)
        root.addWidget(bar)

        main = QHBoxLayout(); main.setContentsMargins(10, 10, 10, 10); main.setSpacing(10)
        root.addLayout(main)

        # ---------- SIDEBAR ----------
        side = QWidget(); side.setFixedWidth(490)
        sv = QVBoxLayout(side); sv.setContentsMargins(0, 0, 0, 0); sv.setSpacing(8)
        self.acc_search = QLineEdit()
        self.acc_search.setPlaceholderText("🔎 Tìm tài khoản…")
        self.acc_search.textChanged.connect(self.filter_accounts)
        sv.addWidget(self.acc_search)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        inner = QWidget()
        self.acc_layout = QVBoxLayout(inner)
        self.acc_layout.setContentsMargins(4, 4, 4, 4); self.acc_layout.setSpacing(6)
        self.acc_layout.addStretch(1)
        scroll.setWidget(inner)
        sv.addWidget(scroll, 1)

        ctl = QFrame(); ctl.setProperty("cssClass", "card")
        cv = QGridLayout(ctl)
        cv.setContentsMargins(14, 12, 14, 12)
        cv.setHorizontalSpacing(10); cv.setVerticalSpacing(8); cv.setColumnStretch(1, 1)
        cv.addWidget(self._dim("Môn chung (acc chưa gán 📚)"), 0, 0, 1, 2)
        self.cb = QComboBox(); self.cb.addItems(["(bấm Đăng nhập để tải)"])
        cv.addWidget(self.cb, 1, 0, 1, 2)
        cv.addWidget(self._dim("Thiết bị (phân phối round-robin)"), 2, 0, 1, 2)
        self.dev = QLineEdit("V417IR, DEV002, DEV003"); self.dev.setFont(self.mono)
        cv.addWidget(self.dev, 3, 0, 1, 2)
        cv.addWidget(self._dim("Cùng lúc"), 4, 0)
        self.cc = QComboBox(); self.cc.addItems(["Tất cả", "1", "2", "3", "5"])
        self.cc.setCurrentText("Tất cả"); self.cc.setFixedWidth(110)
        cv.addWidget(self.cc, 4, 1)
        self.savepwd = QCheckBox("Lưu mật khẩu vào cấu hình"); self.savepwd.setChecked(True)
        cv.addWidget(self.savepwd, 5, 0, 1, 2)
        sv.addWidget(ctl)
        main.addWidget(side)

        # ---------- TABS ----------
        self.tabs = QTabWidget()
        main.addWidget(self.tabs, 1)

        # ---- Dashboard ----
        d = QWidget()
        dv = QVBoxLayout(d); dv.setContentsMargins(10, 10, 10, 10); dv.setSpacing(8)
        stats = QHBoxLayout(); stats.setSpacing(10)
        self.cards = {}
        for key, title, color in [("acc", "Tài khoản", C_TXT),
                                  ("run", "Đang chạy", C_RUN),
                                  ("done", "Hoàn thành", C_OK),
                                  ("score", "Đúng / đã làm", None),
                                  ("bank", "Bank đáp án", C_TXT),
                                  ("vid", "Video đã xong", C_CYAN),
                                  ("vidp", "Video đang xem", C_RUN)]:
            c = QFrame(); c.setProperty("cssClass", "card")
            cvv = QVBoxLayout(c); cvv.setContentsMargins(10, 12, 10, 12); cvv.setSpacing(2)
            val = QLabel("—"); val.setProperty("cssClass", "stat"); val.setAlignment(Qt.AlignCenter)
            if color: val.setStyleSheet(f"color: {color};")
            cvv.addWidget(val); cvv.addWidget(self._dim(title))
            stats.addWidget(c, 1)
            self.cards[key] = val
        dv.addLayout(stats)

        dv.addWidget(self._dim("Tiến độ từng tài khoản  (bấm tên để xem log riêng)"))
        split = QHBoxLayout(); split.setSpacing(10)

        twrap = QVBoxLayout(); twrap.setSpacing(4)
        self.table = QTableWidget(0, 8)
        self.table.setHorizontalHeaderLabels(DASH_COLS + [""])
        hh = self.table.horizontalHeader()
        hh.setSectionResizeMode(0, QHeaderView.Stretch)
        for c in range(1, 6): hh.setSectionResizeMode(c, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(6, QHeaderView.Stretch)
        hh.setSectionResizeMode(7, QHeaderView.Fixed)
        self.table.setColumnWidth(7, 52)
        vh = self.table.verticalHeader()
        vh.setVisible(False); vh.setDefaultSectionSize(44)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.setSelectionMode(QAbstractItemView.NoSelection)
        self.table.setFocusPolicy(Qt.NoFocus)
        self.table.setShowGrid(False)
        self.table.setAlternatingRowColors(True)
        self.table.cellClicked.connect(self._table_click)
        twrap.addWidget(self.table, 1)
        split.addLayout(twrap, 5)

        awrap = QVBoxLayout(); awrap.setSpacing(4)
        awrap.addWidget(self._dim("Hoạt động gần nhất"))
        self.activity = QPlainTextEdit()
        self.activity.setReadOnly(True); self.activity.setMaximumBlockCount(260)
        self.activity.setFont(self.mono)
        awrap.addWidget(self.activity, 1)
        split.addLayout(awrap, 4)
        dv.addLayout(split, 1)
        self.tabs.addTab(d, "Dashboard")

        # ---- Nhật ký ----
        lg = QWidget(); self.tab_log = lg
        lv = QVBoxLayout(lg); lv.setContentsMargins(10, 10, 10, 10); lv.setSpacing(8)
        top = QHBoxLayout(); top.setSpacing(10)
        top.addWidget(QLabel("Xem log của:"))
        self.log_filter = QComboBox(); self.log_filter.addItems(["Tất cả"])
        self.log_filter.setFixedWidth(230)
        self.log_filter.currentTextChanged.connect(self.render_log)
        top.addWidget(self.log_filter)
        clearb = QPushButton("🧹 Xoá"); clearb.clicked.connect(self.clear_log)
        top.addWidget(clearb); top.addStretch(1)
        lv.addLayout(top)
        self.txt = QPlainTextEdit()
        self.txt.setReadOnly(True); self.txt.setMaximumBlockCount(4000)
        self.txt.setFont(self.mono)
        lv.addWidget(self.txt, 1)
        self.tabs.addTab(lg, "Nhật ký")

        # ---- Bank ----
        bk = QWidget()
        kv = QVBoxLayout(bk); kv.setContentsMargins(10, 10, 10, 10); kv.setSpacing(8)
        btop = QHBoxLayout(); btop.setSpacing(10)
        self.bank_search = QLineEdit(); self.bank_search.setPlaceholderText("Tìm theo ID câu hỏi…")
        self.bank_search.setFixedWidth(340); self.bank_search.setFont(self.mono)
        self.bank_search.returnPressed.connect(self.render_bank)
        btop.addWidget(self.bank_search)
        findb = QPushButton("Tìm"); findb.setProperty("accent", True)
        findb.clicked.connect(self.render_bank); btop.addWidget(findb)
        self.bank_count = QLabel("—"); self.bank_count.setProperty("cssClass", "dim")
        btop.addWidget(self.bank_count); btop.addStretch(1)
        kv.addLayout(btop)
        self.bank_txt = QPlainTextEdit()
        self.bank_txt.setReadOnly(True); self.bank_txt.setFont(self.mono)
        kv.addWidget(self.bank_txt, 1)
        self.tabs.addTab(bk, "Bank đáp án")

    def _table_click(self, r_, c_):
        if c_ == 0 and 0 <= r_ < len(self.rows):
            self._focus_log(self.rows[r_])

    # ================================================== ACCOUNTS
    def add_account(self, u="", p="", courses=None):
        if self.hint:
            self.hint.deleteLater(); self.hint = None
        color = ACC_COLORS[len(self.rows) % len(ACC_COLORS)]
        card = QFrame(); card.setProperty("cssClass", "acccard")
        v = QVBoxLayout(card); v.setContentsMargins(12, 10, 12, 10); v.setSpacing(6)

        row = {"frame": card, "proc": None, "color": color, "t0": 0, "last": "",
               "st_txt": ST_NEW[0], "st_col": C_DIM, "courses": list(courses or []),
               "stats": {"ok": 0, "bad": 0, "qwen": 0, "vid": 0, "vid_pend": 0, "ch": "—"},
               "_stcol": None, "_barv": -1, "_sbon": None}

        r1 = QHBoxLayout(); v.addLayout(r1)
        name = QToolButton(); name.setText(u or "tài khoản mới")
        name.setCursor(Qt.PointingHandCursor)
        name.setStyleSheet(
            f"QToolButton {{ background: transparent; border: none; color: {color}; "
            f"font-weight: bold; font-size: 15px; padding: 0; text-align: left; }}"
            "QToolButton:hover { color: #FFFFFF; }")
        name.clicked.connect(lambda _=False, r=row: self._focus_log(r))
        r1.addWidget(name, 1)
        row["name"] = name

        cb = QPushButton("📚"); cb.setProperty("mini", True)
        cb.setCursor(Qt.PointingHandCursor)
        cb.clicked.connect(lambda _=False, r=row: self.pick_courses(r))
        r1.addWidget(cb)
        row["courses_btn"] = cb

        db = QPushButton("🗑"); db.setProperty("mini", True); db.setProperty("danger", True)
        db.setCursor(Qt.PointingHandCursor)
        db.clicked.connect(lambda _=False, r=row: self.del_account(r))
        r1.addWidget(db)

        r2 = QHBoxLayout(); v.addLayout(r2)
        row["user"] = QLineEdit(u); row["user"].setPlaceholderText("tên đăng nhập")
        row["user"].editingFinished.connect(lambda r=row: self._on_user_edit(r))
        r2.addWidget(row["user"], 1)
        row["pwd"] = QLineEdit(p); row["pwd"].setPlaceholderText("mật khẩu")
        row["pwd"].setEchoMode(QLineEdit.Password); row["pwd"].setFixedWidth(140)
        r2.addWidget(row["pwd"])

        r3 = QHBoxLayout(); v.addLayout(r3)
        row["status"] = QLabel(ST_NEW[0])
        row["status"].setStyleSheet(f"color: {C_DIM}; font-size: 11px;")
        r3.addWidget(row["status"])
        row["bar"] = QProgressBar()
        row["bar"].setRange(0, 100); row["bar"].setValue(0); row["bar"].setTextVisible(False)
        r3.addWidget(row["bar"], 1)

        row["mini"] = QLabel("—")
        row["mini"].setStyleSheet(f"color: {C_DIM}; font-size: 11px;")
        v.addWidget(row["mini"])

        self._courses_btn_text(row)
        self.acc_layout.insertWidget(self.acc_layout.count() - 1, card)
        if u: self.color_map[u] = color
        self.rows.append(row)
        self._update_filter()
        return row

    def _courses_btn_text(self, row):
        cs = row.get("courses") or []
        row["courses_btn"].setText("📚 mặc định" if not cs else f"📚 {len(cs)} môn")

    def pick_courses(self, row):
        if not self.course_names:
            QMessageBox.information(
                self, "Chưa có danh sách môn",
                "Bấm “Đăng nhập tất cả” để tải danh sách môn trước.\n"
                "(Môn gán bằng bulk/file vẫn chạy bình thường.)")
            return
        dlg = QDialog(self)
        dlg.setWindowTitle(f"Môn của {row['user'].text().strip() or '?'}")
        dlg.resize(480, 560)
        v = QVBoxLayout(dlg); v.setContentsMargins(14, 14, 14, 14); v.setSpacing(10)
        lst = QListWidget()
        cur = set(row.get("courses") or [])
        for c in self.course_names:
            it = QListWidgetItem(c)
            it.setFlags(it.flags() | Qt.ItemIsUserCheckable)
            it.setCheckState(Qt.Checked if c in cur else Qt.Unchecked)
            lst.addItem(it)
        v.addWidget(lst, 1)
        h = QHBoxLayout()
        clearb = QPushButton("Bỏ chọn tất cả")
        def clear_all():
            for k in range(lst.count()):
                lst.item(k).setCheckState(Qt.Unchecked)
        clearb.clicked.connect(clear_all)
        okb = QPushButton("✔ Lưu"); okb.setProperty("accent", True)
        def save():
            row["courses"] = [lst.item(k).text() for k in range(lst.count())
                              if lst.item(k).checkState() == Qt.Checked]
            self._courses_btn_text(row); self.save_config(); dlg.accept()
        okb.clicked.connect(save)
        h.addWidget(clearb); h.addStretch(1); h.addWidget(okb)
        v.addLayout(h)
        dlg.exec()

    def _parse_acc_line(self, line):
        """'user:pass:môn1|môn2' -> (user, pass, [môn]). Môn bỏ trống được."""
        s = line.strip()
        if not s or s.startswith("#"):
            return None
        if ":" in s:
            parts = s.split(":", 2)
            u, p = parts[0].strip(), parts[1].strip()
            cs = [c.strip() for c in parts[2].split("|")
                  if c.strip()] if len(parts) > 2 else []
        else:
            parts = s.split(None, 1)
            if len(parts) < 2: return None
            u, p = parts[0].strip(), parts[1].strip()
            cs = []
        return (u, p, cs) if u and p else None

    def del_account(self, row):
        pr = row.get("proc")
        if pr and pr.poll() is None:
            if QMessageBox.question(self, "Xác nhận",
                                    "Đang chạy — dừng và xoá?") != QMessageBox.Yes:
                return
            row["stopped"] = True
            pr.terminate()
        row["frame"].deleteLater()
        self.rows.remove(row)
        self._update_filter()
        if not self.rows:
            self._hint("Chưa có tài khoản — bấm “＋ Thêm”")

    def _hint(self, text):
        self.hint = QLabel(text); self.hint.setProperty("cssClass", "dim")
        self.acc_layout.insertWidget(self.acc_layout.count() - 1, self.hint)

    def _on_user_edit(self, row):
        u = row["user"].text().strip()
        row["name"].setText(u or "tài khoản mới")
        if u: self.color_map[u] = row["color"]
        self._update_filter()

    def _focus_log(self, row):
        u = row["user"].text().strip()
        if u:
            self.tabs.setCurrentWidget(self.tab_log)
            self.log_filter.blockSignals(True)
            self.log_filter.setCurrentText(u)
            self.log_filter.blockSignals(False)
            self.render_log()

    def _update_filter(self):
        names = ["Tất cả"] + [r["user"].text().strip() for r in self.rows
                              if r["user"].text().strip()]
        self.log_filter.blockSignals(True)
        self.log_filter.clear()
        self.log_filter.addItems(names or ["Tất cả"])
        self.log_filter.blockSignals(False)

    def filter_accounts(self, text=""):
        kw = text.strip().lower()
        for r in self.rows:
            u = r["user"].text().strip().lower()
            r["frame"].setVisible(not kw or kw in u)

    def bulk(self):
        dlg = QDialog(self); dlg.setWindowTitle("Nhập hàng loạt"); dlg.resize(520, 420)
        v = QVBoxLayout(dlg); v.setContentsMargins(14, 14, 14, 14); v.setSpacing(10)
        info = QLabel("Mỗi dòng:   user:pass:môn1|môn2\n"
                      "Bỏ trống phần môn = dùng môn chung • môn chỉ cần từ khóa (vd: Toán)\n"
                      "Dòng bắt đầu # bị bỏ qua")
        info.setProperty("cssClass", "dim"); v.addWidget(info)
        box = QPlainTextEdit(); v.addWidget(box, 1)
        addb = QPushButton("➕ Thêm tất cả"); addb.setProperty("accent", True)
        def go():
            for line in box.toPlainText().splitlines():
                parsed = self._parse_acc_line(line)
                if parsed:
                    self.add_account(*parsed)
            dlg.accept(); self.filter_accounts(""); self.save_config()
        addb.clicked.connect(go); v.addWidget(addb)
        dlg.exec()

    def import_file(self):
        path, _ = QFileDialog.getOpenFileName(self, "Chọn file", "", "Text (*.txt);;All (*.*)")
        if not path: return
        for line in open(path, encoding="utf-8", errors="replace").read().splitlines():
            parsed = self._parse_acc_line(line)
            if parsed:
                self.add_account(*parsed)
        self.save_config()

    def export_file(self):
        path, _ = QFileDialog.getSaveFileName(self, "Lưu file", "tai-khoan.txt", "Text (*.txt)")
        if not path: return
        with open(path, "w", encoding="utf-8") as f:
            for r in self.rows:
                line = f"{r['user'].text().strip()}:{r['pwd'].text().strip()}"
                cs = "|".join(r.get("courses") or [])
                if cs: line += f":{cs}"
                f.write(line + "\n")

    # ================================================== RUN
    def busy(self, b):
        self.btn_login.setEnabled(not b)
        self.btn_run.setEnabled(not b)
        self.btn_stop.setEnabled(b)
        self.running = b

    def log(self, user, text):
        self.sig.log.emit(user, text)

    def login_all(self):
        if self.running: return
        accs = [(r, r["user"].text().strip(), r["pwd"].text().strip()) for r in self.rows]
        accs = [(r, u, p) for r, u, p in accs if u and p]
        if not accs:
            self.log(None, "[!] Chưa nhập tài khoản hợp lệ\n"); return
        def work():
            self.sig.busy.emit(True)
            self.sig.head.emit("⏳ Đang đăng nhập…", C_RUN)
            dev0 = (self.dev.text().split(",") or ["V417IR"])[0].strip() or "V417IR"
            os.environ["CLICKQA_DEVICE"] = dev0
            self.log(None, f"[*] Đăng nhập theo thiết bị: {dev0}\n")
            res = [None] * len(accs)
            def t(i, r, u, p):
                qa = core().ClickQA()
                try:
                    qa.login(u, p); res[i] = qa
                    self.color_map[u] = r["color"]
                    self.sig.state.emit(r, "● Đã đăng nhập", C_DIM)
                except Exception as e:
                    self.log(u, f"[{u}] Lỗi đăng nhập: {e}\n")
                    self.sig.state.emit(r, ST_ERR[0], ST_ERR[1])
            ths = [threading.Thread(target=t, args=(i, r, u, p), daemon=True)
                   for i, (r, u, p) in enumerate(accs)]
            for th in ths: th.start()
            for th in ths: th.join()
            names = []
            self._rank_qa = None
            for qa in res:
                if qa:
                    try: names = sorted({c.get("COURSE_NAME") or ""
                                         for c in qa.get_courses()})
                    except Exception: pass
                    self._rank_qa = qa
                    break
            # KHÔNG close _rank_qa — session cho nút BXH tái dùng
            if names:
                self.sig.courses.emit(names)
                self.log(None, f"[*] Đã tải {len(names)} môn — chọn môn rồi bấm CHẠY\n")
            else:
                self.log(None, "[!] Không tải được danh sách môn — kiểm tra tài khoản\n")
            self.sig.busy.emit(False)
            self.sig.head.emit("○ Sẵn sàng", C_DIM)
        threading.Thread(target=work, daemon=True).start()

    def run_all(self):
        if self.running: return
        default_kw = self.cb.currentText()
        default_ok = bool(default_kw) and not default_kw.startswith("(")
        seen, valid, missing = set(), [], []
        for r in self.rows:
            u, p = r["user"].text().strip(), r["pwd"].text().strip()
            if not (u and p): continue
            if u in seen:
                self.log(u, f"[!] Bỏ qua trùng: {u}\n"); continue
            seen.add(u)
            kws = list(r.get("courses") or [])
            if not kws and default_ok:
                kws = [default_kw]                 # acc chưa gán 📚 → dùng môn chung
            if not kws:
                missing.append(u); continue
            valid.append((r, u, p, kws))
        if missing:
            self.log(None, f"[!] Thiếu môn (bấm 📚 gán riêng hoặc chọn môn chung): "
                           f"{', '.join(missing)}\n")
        if not valid:
            self.log(None, "[!] Không có tài khoản hợp lệ / chưa chọn môn\n"); return
        devs = [d.strip() for d in self.dev.text().split(",") if d.strip()] or ["V417IR"]
        v = self.cc.currentText()
        n = len(valid) if v in ("Tất cả", "") else max(1, int(v))
        def work():
            self.sig.busy.emit(True)
            self.sig.head.emit(f"▶ {len(valid)} acc • {min(n, len(valid))} cùng lúc", C_RUN)
            total = sum(len(k) for _, _, _, k in valid)
            self.log(None, f"[*] Chạy {len(valid)} acc • {min(n, len(valid))} cùng lúc • "
                           f"{total} môn • device: {', '.join(devs)}\n")
            sem = threading.Semaphore(n)
            ths = []
            for i, (row, u, p, kws) in enumerate(valid):
                def t(row=row, u=u, p=p, kws=kws, i=i):
                    sem.acquire()
                    try:
                        time.sleep(random.uniform(2.0, 12.0) * (i // max(n, 1)))
                        self._run_one(row, u, p, kws, devs[i % len(devs)])
                    finally: sem.release()
                th = threading.Thread(target=t, daemon=True)
                th.start(); ths.append(th)
            for th in ths: th.join()
            self.log(None, "\n[*] ===== TẤT CẢ HOÀN TẤT =====\n")
            self.sig.busy.emit(False)
            self.sig.head.emit("✔ Đã xong", C_OK)
        threading.Thread(target=work, daemon=True).start()

    def _run_one(self, row, u, p, kws, dev):
        row["stats"] = {"ok": 0, "bad": 0, "qwen": 0, "vid": 0, "vid_pend": 0, "ch": "—"}
        row["t0"] = time.time(); row["stopped"] = False
        rc = -1
        for attempt in range(3):
            row["last"] = "khởi động…" if attempt == 0 else f"restart {attempt + 1}…"
            cmd = [sys.executable, "-u", RUNNER, u, p, "|".join(kws)] + \
                  ([dev] if dev else [])
            try:
                pr = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                      stderr=subprocess.STDOUT, text=True,
                                      encoding="utf-8", errors="replace", cwd=r"C:\frida")
            except Exception as e:
                self.log(u, f"[{u}] Không khởi động được: {e}\n")
                self.sig.state.emit(row, ST_ERR[0], ST_ERR[1]); return
            row["proc"] = pr
            self.sig.state.emit(row, ST_RUN[0], ST_RUN[1])
            for line in pr.stdout:
                self.sig.log.emit(u, line)
                self._parse(row, line)
            rc = pr.wait()
            if rc == 0 or row.get("stopped"):
                break
            if attempt < 2:
                self.log(u, f"[{u}] ✖ Chết (mã {rc}) — restart {attempt + 2}/3 sau 60s\n")
                self.sig.state.emit(row, f"⏳ restart {attempt + 2}/3", C_RUN)
                time.sleep(60)
                if row.get("stopped"): break
        row["last"] = f"kết thúc (mã {rc})"
        if rc == 0:
            self.sig.state.emit(row, ST_DONE[0], ST_DONE[1])
        else:
            self.sig.state.emit(row, f"✖ Mã {rc}", C_ERR)

    def _parse(self, row, line):
        line = self.ANSI_RE.sub("", line)
        st = row["stats"]
        if "_seen_vids" not in st:
            st["_seen_vids"] = set()

        s = line.strip()
        # boc tag [user] va [timestamp] — lap toi khi het tag
        while s.startswith("[") and "]" in s:
            head = s[1:s.index("]")]
            if " " in head or head in ("v", "x", "~", "!", "*", "✔", "✖", "?", "P"):
                break
            s = s[s.index("]") + 1:].strip()
        line_clean = s

        # ---- cau hoi: [✔]/[✖] (auto moi) hoac [v]/[x] (auto cu) ----
        if line_clean.startswith(("✔", "[✔]", "✖", "[✖]", "[v] (", "[x] (")):
            if line_clean.startswith(("✖", "[✖]", "[x] (")):
                st["bad"] += 1
            else:
                st["ok"] += 1
                if "(qwen)" in line_clean:
                    st["qwen"] += 1

        # ---- video nhan viec (dang xem) ----
        if "nhận việc" in line_clean:
            m_vid = re.search(r"([0-9a-f]{24})", line_clean)
            if m_vid:
                vid_id = m_vid.group(1)
                if vid_id not in st.get("_seen_pend", set()):
                    if "_seen_pend" not in st: st["_seen_pend"] = set()
                    st["_seen_pend"].add(vid_id)
                    st["vid_pend"] = len(st["_seen_pend"])
            else:
                st["vid_pend"] += 1

        # ---- video hoan thanh: format moi (✅ HOÀN THÀNH) va cu (100% ⚡) ----
        if ("HOÀN THÀNH" in line_clean or "HOAN THANH" in line_clean
                or ("100%" in line_clean and ("⚡" in line_clean or "MAX" in line_clean))):
            m_vid = re.search(r"([0-9a-f]{24})", line_clean)
            if m_vid:
                vid_id = m_vid.group(1)
                if vid_id not in st["_seen_vids"]:
                    st["_seen_vids"].add(vid_id)
                    st["vid"] = len(st["_seen_vids"])
                    # video nay da xem xong — bo khoi danh sach dang xem
                    if "_seen_pend" in st and vid_id in st["_seen_pend"]:
                        st["_seen_pend"].discard(vid_id)
                        st["vid_pend"] = len(st["_seen_pend"])
            elif "HOÀN THÀNH" in line_clean or "HOAN THANH" in line_clean:
                st["vid"] += 1

        # ---- chuong x/y ----
        m = re.search(r"(\d+)\s*/\s*(\d+)", line_clean)
        if m and ("###" in line_clean or "chuong" in line_clean.lower()
                  or "chương" in line_clean.lower() or "hoàn thành:" in line_clean.lower()):
            st["ch"] = f"{m.group(1)}/{m.group(2)}"

        if any(line_clean.startswith(k)
               for k in ("###", "[*]", "[!]", "[v]", "[x]", "[~]", "[✔]", "[✖]", "[<>]")):
            row["last"] = line_clean[:70]

    def show_ranking(self):
        """BXH môn đang chọn — chỉ gửi getRankingUserInCourse, không login."""
        # đợi login_all gán session (tối đa 30s)
        waited = 0
        while getattr(self, "_rank_qa", None) is None and waited < 30:
            time.sleep(0.5); waited += 1
        qa = getattr(self, "_rank_qa", None)
        if qa is None:
            self.log(None, "[!] Chưa có session — bấm 🔑 Đăng nhập tất cả trước\n")
            return
        kw = self.cb.currentText()
        if not kw or kw.startswith("("):
            self.log(None, "[!] Chưa chọn môn\n")
            return
        def work():
            try:
                courses = qa.get_courses()
                c = next((x for x in courses
                          if kw in str(x.get("COURSE_NAME") or "")
                          or kw in [x.get("COURSE_ID"), x.get("_id")]), None)
                if not c:
                    self.log(None, f"[!] Không thấy môn: {kw}\n")
                    return
                cid = str(c.get("COURSE_ID") or c["_id"])
                uid = core().jwt_user(qa.S.headers["authorization"])["userId"]
                me, top, pg = None, [], 1
                while pg <= 10:
                    j = qa._post("course/getRankingUserInCourse",
                                 {"COURSE_ID": cid, "page": pg, "limit": 20})
                    dd = j.get("data")
                    if isinstance(dd, dict):
                        dd = dd.get("data") or []
                    if not dd:
                        break
                    if pg == 1:
                        top = dd[:3]
                    for u in dd:
                        if u.get("USER_ID") == uid:
                            me = u
                            break
                    if me:
                        break
                    pg += 1
                def fmt_time(t):
                    try:
                        t = float(t)
                    except (TypeError, ValueError):
                        return "?"
                    if t < 59.5:
                        return f"{int(round(t))}s"
                    m2, s2 = divmod(int(round(t)), 60)
                    return f"{m2}m{s2:02d}s"

                self.log(None, "\n┏━━━━━ BẢNG XẾP HẠNG ━━━━━\n")
                for u in top:
                    self.log(None, f"┃ 🏆 #{u.get('CURRENT_RANKING'):>2} {str(u.get('FULL_NAME'))[:22]:24}"
                                   f"⭐ {u.get('GRADE_PERCENTILE_ACHIEVED')}"
                                   f" ⏱ {fmt_time(u.get('TIME_TAKEN_TO_COMPLETE'))}\n")
                if me:
                    rk = me.get('CURRENT_RANKING')
                    self.log(None, f"┃ 👤 MÌNH #{rk} {str(me.get('FULL_NAME'))[:22]:24}"
                                   f"⭐ {me.get('GRADE_PERCENTILE_ACHIEVED')}"
                                   f" ⏱ {fmt_time(me.get('TIME_TAKEN_TO_COMPLETE'))}\n")
                    if rk == 1:
                        self.log(None, "┃ 🥇 TOP 1\n")
                    elif rk <= 3:
                        self.log(None, f"┃ 🥉 TOP {rk}\n")
                else:
                    self.log(None, "┃ 👤 MÌNH: không nằm trong top 200\n")
                self.log(None, "┗━━━━━━━━━━━━━━━━━━━━━━━━\n")
            except Exception as e:
                self.log(None, f"[!] BXH lỗi: {e}\n")
        threading.Thread(target=work, daemon=True).start()

    def stop_one(self, row):
        pr = row.get("proc")
        if pr and pr.poll() is None:
            row["stopped"] = True
            pr.terminate()
            u = row["user"].text().strip()
            self.log(u, f"[{u}] ■ Đã dừng\n")

    def confirm_stop(self):
        if QMessageBox.question(self, "Xác nhận",
                                "Dừng toàn bộ process đang chạy?") == QMessageBox.Yes:
            for row in self.rows:
                self.stop_one(row)
            self.sig.head.emit("■ Đã dừng", C_ERR)

    # ================================================== LOG / SIGNAL SLOTS
    def _on_state(self, row, t, c):
        row["st_txt"], row["st_col"] = t, c
        self._st_label(row, t, c)
        try:
            row["bar"].setStyleSheet(
                f"QProgressBar::chunk {{ background: {c}; border-radius: 4px; }}")
        except Exception: pass

    def _st_label(self, row, text, color):
        row["status"].setText(text)
        if row.get("_stcol") != color:
            row["_stcol"] = color
            row["status"].setStyleSheet(
                f"color: {color}; font-size: 11px; background: transparent;")

    def _on_head(self, text, color):
        self.head_status.setText(text)
        if self._headcol != color:
            self._headcol = color
            self.head_status.setStyleSheet(f"color: {color}; background: transparent;")

    def _on_courses(self, names):
        self.course_names = list(names)
        cur = self.cb.currentText()
        self.cb.blockSignals(True)
        self.cb.clear(); self.cb.addItems(names)
        self.cb.setCurrentText(cur if cur in names else (names[0] if names else ""))
        self.cb.blockSignals(False)

    def _append_html(self, w, text, color, prefix=""):
        for part in text.rstrip("\n").split("\n"):
            w.appendHtml(f'<span style="color:{color}">{prefix}{html.escape(part)}</span>')

    def _on_log(self, user, text):
        text = self.ANSI_RE.sub("", text)      # GUI không render ANSI — bỏ mã màu
        color = C_TXT
        s0 = text.strip()
        if s0.startswith("[") and "]" in s0 and " " not in s0[1:s0.index("]")]:
            s0 = s0[s0.index("]") + 1:].strip()   # boc tag [user]
        if user and user in self.color_map:
            color = self.color_map[user]
        elif s0.startswith(("[!", "[X]")) or s0.startswith("  !"):
            color = C_ERR
        elif s0.startswith(("[*", "###")):
            color = C_DIM
        elif s0.startswith(("[v]", "[✔]", "✔", "[<>]", "✅")) or "HOÀN THÀNH" in s0[:60]:
            color = C_OK
        ts = time.strftime("%H:%M:%S")
        self.log_lines.append((user, color, text, ts))
        if len(self.log_lines) > 5000:
            self.log_lines = self.log_lines[-4000:]
        f = self.log_filter.currentText()
        if f == "Tất cả" or (user and user == f):
            self._append_html(self.txt, text, color)
        s = text.strip()
        if s:
            self._append_html(self.activity, s[:110], color, prefix=f"{ts}  ")

    def render_log(self, _=None):
        self.txt.clear()
        f = self.log_filter.currentText()
        for u, c, t, _ts in self.log_lines[-4000:]:
            if f == "Tất cả" or (u and u == f):
                self._append_html(self.txt, t, c)
        self.txt.verticalScrollBar().setValue(self.txt.verticalScrollBar().maximum())

    def clear_log(self):
        self.log_lines.clear()
        self.txt.clear()
        self.activity.clear()

    # ================================================== BANK
    def render_bank(self):
        c = core()
        try: c.load_bank_if_new()
        except Exception: pass
        kw = self.bank_search.text().strip().lower()
        items = [(k, v) for k, v in c.BANKD.items() if kw in k.lower()][:500]
        self.bank_count.setText(f"{len(c.BANKD)} câu • hiển thị {len(items)}")
        letters = "ABCDEFGH"
        self.bank_txt.clear()
        for k, v in items:
            ans = "".join(letters[i] if i < 8 else str(i) for i in v)
            self.bank_txt.appendHtml(
                f'<span style="color:{C_OK}">{html.escape(str(k))}  →  {ans}</span>')

    # ================================================== DASHBOARD
    def _sig(self):
        return tuple(id(r) for r in self.rows)

    def _rebuild_table(self):
        self.table.setRowCount(len(self.rows))
        bold = QFont(self.table.font()); bold.setBold(True)
        for i, r in enumerate(self.rows):
            r["_items"] = [None] * 7
            r["_cellcache"] = [("", "")] * 7
            for c in range(7):
                it = QTableWidgetItem("")
                if c == 0: it.setFont(bold)
                self.table.setItem(i, c, it)
                r["_items"][c] = it
            stop = QPushButton("■")
            stop.setProperty("danger", True)
            stop.setFixedSize(40, 28); stop.setEnabled(False)
            stop.setCursor(Qt.PointingHandCursor)
            stop.clicked.connect(lambda _=False, rr=r: self.stop_one(rr))
            self.table.setCellWidget(i, 7, stop)
            r["_stop"] = stop

    def _cell(self, i, c, text, color, r):
        if r["_cellcache"][c] == (text, color): return
        r["_cellcache"][c] = (text, color)
        it = r["_items"][c]
        it.setText(text)
        it.setToolTip(text)
        it.setForeground(QColor(color))

    def _refresh(self):
        running = done = ok = bad = vid = vidp = 0
        for r in self.rows:
            pr = r.get("proc")
            if pr and pr.poll() is None: running += 1
            elif "Hoàn thành" in r["st_txt"]: done += 1
            st = r["stats"]
            ok += st["ok"]; bad += st["bad"]; vid += st["vid"]; vidp += st.get("vid_pend", 0)
        self.cards["acc"].setText(str(len(self.rows)))
        self.cards["run"].setText(str(running))
        self.cards["done"].setText(str(done))
        if ok + bad:
            ratio = ok / (ok + bad)
            col = C_OK if ratio >= .8 else (C_RUN if ratio >= .5 else C_ERR)
            self.cards["score"].setText(f"{ok}/{ok + bad}")
            if self._scorecol != col:
                self._scorecol = col
                self.cards["score"].setStyleSheet(f"color: {col};")
        else:
            self.cards["score"].setText("—")
            if self._scorecol != C_DIM:
                self._scorecol = C_DIM
                self.cards["score"].setStyleSheet(f"color: {C_DIM};")
        if core_ready():
            try:
                m = os.path.getmtime(core().BANK)
                if m != self._bank_m:
                    core().load_bank_if_new(); self._bank_m = m
            except Exception: pass
            self.cards["bank"].setText(str(len(core().BANKD)))
        self.cards["vid"].setText(str(vid))
        self.cards["vidp"].setText(str(vidp))

        if self._sig() != self._sig_cur:
            self._sig_cur = self._sig()
            self._rebuild_table()

        for i, r in enumerate(self.rows):
            st = r["stats"]
            pr = r.get("proc")
            isrun = pr is not None and pr.poll() is None
            el = int(time.time() - r.get("t0", time.time())) if isrun else 0
            timer_txt = f"▶ {el // 60:02d}:{el % 60:02d}"

            self._cell(i, 0, r["user"].text().strip() or "…", r["color"], r)
            ncs = len(r.get("courses") or [])
            self._cell(i, 1, str(ncs) if ncs else "—", C_TXT if ncs else C_DIM, r)
            self._cell(i, 2, timer_txt if isrun else r["st_txt"],
                       C_RUN if isrun else r["st_col"], r)
            self._cell(i, 3, st["ch"], C_TXT, r)
            if st["ok"] or st["bad"]:
                qac = C_OK if st["ok"] and st["bad"] == 0 else C_RUN
                self._cell(i, 4, f"✔ {st['ok']}  ✖ {st['bad']}", qac, r)
            else:
                self._cell(i, 4, "—", C_DIM, r)
            vp = st.get("vid_pend", 0)
            vtxt = f"{st['vid']} ✔ | {vp} ⏳" if (st["vid"] or vp) else "—"
            self._cell(i, 5, vtxt, C_CYAN if st["vid"] else C_RUN, r)
            last = (r.get("last") or "")[:70]
            lcol = C_DIM
            if "[!" in last or "[X]" in last: lcol = C_ERR
            elif "[v]" in last or "100%" in last: lcol = C_OK
            elif "⏳" in last or "chờ" in last: lcol = C_RUN
            self._cell(i, 6, last, lcol, r)

            if isrun != r.get("_sbon"):
                r["_sbon"] = isrun
                r["_stop"].setEnabled(isrun)

            self._st_label(r, timer_txt if isrun else r["st_txt"],
                           C_RUN if isrun else r["st_col"])
            if st["ch"] != "—":
                try:
                    a, b = map(int, st["ch"].split("/"))
                    v = min(100, a * 100 // max(b, 1))
                    if abs(r.get("_barv", -1) - v) > 0.2:
                        r["_barv"] = v; r["bar"].setValue(v)
                except Exception: pass
            txt = f"✔ {st['ok']}   ✖ {st['bad']}   🎥 {st['vid']}   ⏳ {st.get('vid_pend', 0)}"
            if r.get("courses"):
                txt += f"   📚 {len(r['courses'])} môn"
            r["mini"].setText(txt)

        if self.running:
            t0s = [r["t0"] for r in self.rows
                   if r.get("proc") and r["proc"].poll() is None and r.get("t0")]
            if t0s:
                el = int(time.time() - min(t0s))
                self.head_status.setText(
                    f"▶ {running} acc • {el // 3600:02d}:{el % 3600 // 60:02d}:{el % 60:02d}")
        else:
            ready = sum(1 for r in self.rows
                        if r["user"].text().strip() and r["pwd"].text().strip())
            self.btn_run.setText("▶ CHẠY TẤT CẢ" + (f"  •  {ready} acc" if ready else ""))
            self.head_status.setText(f"○ Sẵn sàng • {len(self.rows)} tài khoản")

    # ================================================== CONFIG
    def save_config(self):
        try:
            data = {"course": self.cb.currentText(), "save_pwd": self.savepwd.isChecked(),
                    "devices": self.dev.text(), "concurrency": self.cc.currentText(),
                    "accounts": [{"user": r["user"].text().strip(),
                                  "pwd": r["pwd"].text().strip() if self.savepwd.isChecked() else "",
                                  "courses": r.get("courses") or []}
                                 for r in self.rows]}
            json.dump(data, open(CONFIG, "w", encoding="utf-8"),
                      ensure_ascii=False, indent=2)
        except Exception: pass

    def load_config(self):
        if not os.path.exists(CONFIG):
            self._hint("Chưa có tài khoản — bấm “＋ Thêm”"); return
        try:
            d = json.load(open(CONFIG, encoding="utf-8"))
            for a in d.get("accounts", []):
                if a.get("user"):
                    self.add_account(a["user"], a.get("pwd", ""), a.get("courses") or [])
            if d.get("course"): self.cb.setCurrentText(d["course"])
            if d.get("devices"):
                self.dev.setText(d["devices"])
            if d.get("concurrency"): self.cc.setCurrentText(d["concurrency"])
            self.savepwd.setChecked(d.get("save_pwd", True))
        except Exception: pass

    def closeEvent(self, e):
        self.save_config()
        for row in self.rows:
            pr = row.get("proc")
            if pr and pr.poll() is None: pr.terminate()
        sys.stdout = sys.__stdout__          # trả stdout trước khi app chết
        super().closeEvent(e)


def main():
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    fams = set(QFontDatabase.families())
    ui = "Segoe UI" if "Segoe UI" in fams else app.font().family()
    mono = ("Cascadia Mono" if "Cascadia Mono" in fams
            else ("Consolas" if "Consolas" in fams else ui))
    app.setFont(QFont(ui, 10))
    app.setStyleSheet(QSS)
    w = MainWindow(mono)
    w.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()