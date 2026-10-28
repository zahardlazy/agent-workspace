import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
import unicodedata
import httpx, json, base64, re, os, time, random, datetime as dt
import threading

import queue

VIDEO_WORKERS = 12

from cryptography.hazmat.primitives import hashes as _c_hashes
from cryptography.hazmat.primitives.asymmetric import padding as _c_padding

_RSA_KEY = None
def _rsa_key():
    global _RSA_KEY
    if _RSA_KEY is None:
        _RSA_KEY = serialization_load_key()
    return _RSA_KEY

def serialization_load_key():
    from cryptography.hazmat.primitives import serialization
    return serialization.load_pem_private_key(
        open(r"C:\frida\key1.pem", "rb").read(), password=None)

def make_media_signature(userId: str) -> str:
    k = _rsa_key()
    return k.sign(userId.encode(), _c_padding.PKCS1v15(), _c_hashes.SHA256()).hex()

APIKEY = os.environ["CLICKQA_APIKEY"]
QKEY = os.environ["CLICKQA_QKEY"]
DEVICE  = os.environ.get("CLICKQA_DEVICE", "V417IR")
CHARGE  = "6707a597c8e1ab6897fa4e42"
BANK    = r"C:\frida\answer_bank.json"

QBASE   = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
QMODEL  = "deepseek-v4-flash"

QC = httpx.Client(timeout=120)
_lock = threading.Lock()
_net_gate = threading.Semaphore(10)   # toi da 10 request dong luc tren TOAN HE THONG
LLM_CALLS = 0
BANK_MTIME = 0

def load_bank_if_new():
    global BANK_MTIME
    try:
        m = os.path.getmtime(BANK)
        if m != BANK_MTIME:
            with _lock:
                with open(BANK, encoding="utf-8") as f:
                    BANKD.update(json.load(f))
            BANK_MTIME = m
    except json.JSONDecodeError:
        print(f"[!] BANK FILE CORRUPT — không nạp được, mọi câu sẽ đi LLM. Kiểm tra {BANK}")
    except FileNotFoundError:
        pass  # file chưa tồn tại lần đầu chạy — bình thường, im lặng ok

def save_bank():
    global BANK_MTIME
    import msvcrt
    lock = open(BANK + ".wlock", "w")
    while True:
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            break
        except OSError:
            time.sleep(0.3)
    try:
        try:
            with open(BANK, encoding="utf-8") as f:
                disk = json.load(f)
            disk.update(BANKD)
        except Exception:
            disk = dict(BANKD)
        tmp = "%s.%d.tmp" % (BANK, os.getpid())
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(disk, f, ensure_ascii=False, indent=2)
        for _ in range(5):
            try:
                os.replace(tmp, BANK)
                break
            except PermissionError:
                time.sleep(0.4)
        try:
            BANK_MTIME = os.path.getmtime(BANK)
        except OSError:
            pass
        BANKD.update(disk)
    finally:
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
        finally:
            lock.close()

def jwt_user(token):
    p = token.split(".")[1]
    p += "=" * (-len(p) % 4)
    return json.loads(base64.urlsafe_b64decode(p))


FAST_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro-0813"]
TIEBREAK    = "deepseek-v4-pro"

def llm_ask(model, prompt, thinking=False, timeout=45):
    body = {"model": model, "temperature": 0, "enable_thinking": thinking,
            "messages": [{"role": "user", "content": prompt}]}
    r = QC.post(f"{QBASE}/chat/completions",
                headers={"Authorization": f"Bearer {QKEY}"}, json=body, timeout=timeout)
    j = r.json()
    if "choices" not in j:
        body.pop("enable_thinking", None)
        r = QC.post(f"{QBASE}/chat/completions",
                    headers={"Authorization": f"Bearer {QKEY}"}, json=body, timeout=timeout)
        j = r.json()
    if "choices" not in j:
        raise RuntimeError(str(j)[:120])
    out = j["choices"][0]["message"]["content"] or ""
    m = re.search(r"\{[^}]*\}", out, re.S)
    if not m:
        raise ValueError(f"không trả JSON: {out[:60]}")
    ans = json.loads(m.group(0))["answer"]
    if isinstance(ans, int):
        ans = [ans]
    return [int(a) for a in ans]

def ask_qwen(text, choices, multi):
    global LLM_CALLS
    letters = "ABCDEFGH"
    opts = "\n".join(f"{letters[i]}. {c}" for i, c in enumerate(choices))
    prompt = ("Bạn là chuyên gia làm bài trắc nghiệm. Chọn đáp án đúng.\n\n"
              f"Câu hỏi: {text}\n{opts}\n\n"
              + ("Có THỂ có nhiều đáp án đúng." if multi else "Chỉ MỘT đáp án đúng.")
              + '\nTrả lời CHÍNH XÁC theo format JSON: {"answer": [chỉ số]} '
                "với chỉ số 0=A, 1=B, 2=C, 3=D. Không giải thích.")
    print("  [..] đang hỏi LLM…")
    with _lock:
        LLM_CALLS += 1

    res = [None] * len(FAST_MODELS)
    def _call(i, model):
        try:
            res[i] = llm_ask(model, prompt)
        except Exception as e:
            print(f"  ! {model}: {e}")
    ths = [threading.Thread(target=_call, args=(i, m), daemon=True)
           for i, m in enumerate(FAST_MODELS)]
    for t in ths: t.start()
    for t in ths: t.join(timeout=50)
    cands = [r for r in res if r is not None]

    if len(cands) == 2 and sorted(cands[0]) == sorted(cands[1]):
        return cands[0]

    if cands:
        other = cands[1] if len(cands) > 1 else "?"
        print(f"  [≠] bất đồng {cands[0]} vs {other} — vote 3 (tiebreak)")
        try:
            cands.append(llm_ask(TIEBREAK, prompt))
        except Exception as e:
            print(f"  ! {TIEBREAK}: {e}")
    for c in cands:
        if sum(1 for x in cands if sorted(x) == sorted(c)) >= 2:
            return c

    try:
        return llm_ask(QMODEL, prompt, thinking=True, timeout=60)
    except Exception as e:
        print(f"  ! thinking fail: {e}")
    return cands[0] if cands else [0]

def parse_question(q):
    kv = {c["KEY"]: c["VALUE"] for c in q.get("LIST_TEST_QUESTION_CONTENT") or []}
    letters = "ABCDEFGH"
    n = int(kv.get("MULTIPLE_CHOICE_QUESTION_NUMBER_OF_CHOICES", 4))
    choices = [kv.get(f"MULTIPLE_CHOICE_QUESTION_CHOICE_{letters[i]}", "") for i in range(n)]
    multi = kv.get("MULTIPLE_CHOICE_QUESTION_OVER_ONE_CORRECT_CHOICE") == "1"
    return q["TEST_QUESTION_TEXT"], choices, multi

def _strip(s):
    return "".join(c for c in unicodedata.normalize("NFD", str(s or "")) if unicodedata.category(c) != "Mn").lower().strip()

class ClickQA:
    def vbeat(self, vid, line):
        try:
            import datetime as dt
            with open(rf"C:\frida\logs\beat_{self.username}.log", "a", encoding="utf-8") as f:
                f.write(f"{dt.datetime.now():%H:%M:%S} {vid} {line}\n")
        except Exception:
            pass

    def __init__(self):
        self.tag = ""
        self.username = None
        self._pwd = None
        self._last_relogin = 0
        self.stop = threading.Event()
        self.failed_videos = []
        self._video_enforced = False
        self._idle_pools = []
        self.all_pending = []
        self._media_clients = {}
        self.progress = {"correct": 0, "answered": 0,
                         "pools_done": 0, "pools_total": 0, "course": ""}
        self.S = httpx.Client(
            base_url="https://api-prod-01.clickqa.net/v1/api",
            timeout=60, verify=False,
            headers={"x-api-key": APIKEY, "content-type": "application/json",
                     "x-platform": "app", "x-device-id": DEVICE,
                     "user-agent": "Dart/3.10 (dart:io)"})

    def pr(self, msg):
        print((self.tag + " " if self.tag else "") + f"[{time.strftime('%H:%M:%S')}] " + msg)

    def _wait(self, seconds, why):
        if seconds >= 1.0:
            self.pr(f"      ⏱ chờ {seconds:.0f}s — {why}")
        time.sleep(seconds)

    def _retry(self, fn, desc=""):
        last = None
        for i in range(4):
            try:
                with _net_gate:
                    return fn()
            except Exception as e:
                last = e
                wait = 10 * (i + 1)
                self._wait(wait, f"mạng lỗi {type(e).__name__} [{desc}] — retry {i + 1}/4")
        raise RuntimeError(f"API chết 4 lần liên tiếp [{desc}]: {last}")

    def _post(self, path, body):
        j = self._retry(lambda: self.S.post(path, json=body).json(), path)
        msg = j.get("message") or ""
        low = msg.lower()
        kicked = ("another device" in low or "x-client-id" in low
                  or "không tìm thấy x-client" in low or "hết hạn" in low
                  or "invalid token" in low or "token không hợp lệ" in low
                  or "token is invalid" in low or "unauthorized" in low)
        if kicked and self.username:
            with self._rlogin_lock:
                now = time.time()
                # vua bi dan 3 lan lien tiep — mai 60s (may khac dang giu)
                if now < getattr(self, "_kick_pause_until", 0):
                    return j
                # thread khac vua relogin — thu lai voi token moi
                if now - self._last_relogin > 5:
                    self._kick_count = getattr(self, "_kick_count", 0) + 1
                    self.pr(f"  [!] Session bị đá ({msg[:50]}) — relogin lần {self._kick_count}…")
                    self._relogin()
                    j = self._retry(lambda: self.S.post(path, json=body).json(), path)
                    # request sau relogin van bi dan = may khac that su giu
                    jj = (j.get("message") or "").lower()
                    if any(k in jj for k in ("another device", "x-client-id", "không tìm thấy x-client", "unauthorized")):
                        self._kick_count = getattr(self, "_kick_count", 0)
                        self._kick_pause_until = now + 60
                        self.pr("  [!] Máy khác đang giữ phiên — NGHĨ 60s rồi thử lại (không đơ, bỏ qua request này)")
                else:
                    j = self._retry(lambda: self.S.post(path, json=body).json(), path)
        return j

    _rlogin_lock = threading.Lock()

    def _relogin(self):
        self._last_relogin = time.time()
        j = self._retry(lambda: self.S.post("user/login", json={
            "username": self.username, "password": self._pwd,
            "language": "vi"}).json(), "login")
        d = (j.get("data") or [{}])[0]
        if "accessToken" in d:
            self.S.headers.update({
                "authorization": d["accessToken"],
                "x-client-id": jwt_user(d["accessToken"])["userId"]})

    def login(self, u, p):
        self._pwd = p
        j = self._post("user/login", {"username": u, "password": p, "language": "vi"})
        d = (j.get("data") or [{}])[0]
        if "accessToken" not in d:
            raise RuntimeError(f"Đăng nhập thất bại: {j.get('message')}")
        self.S.headers.update({"authorization": d["accessToken"],
                               "x-client-id": jwt_user(d["accessToken"])["userId"]})
        self.username = u
        self.tag = f"[{u}]"
        self._last_relogin = time.time()
        self.pr("[*] Đăng nhập OK")

    def get_courses(self):
        out, page = [], 1
        while True:
            j = self._post("course/getListCourseByUser", {"page": page, "limit": 20})
            d = j.get("data") or []
            if isinstance(d, dict):
                d = d.get("data") or []
            out += d
            if len(d) < 20:
                break
            page += 1
        return out

    def _wait_work(self, seconds):
        end = time.time() + seconds
        while True:
            left = end - time.time()
            if left <= 0 or self.stop.is_set():
                return
            if self._idle_pools:
                pool = self._idle_pools.pop(0)
                try:
                    self.do_pool(pool)
                except Exception as e:
                    self.pr(f"  [!] pool chờ lỗi: {e}")
                continue
            time.sleep(min(left, 5.0))



    def _media_jwt(self):
        try:
            uid = jwt_user(self.S.headers["authorization"])["userId"]
            r = httpx.post("https://med-prod-01.click-ed.vn/api/v1/auth/generateAuthTokenMobile",
                           json={"signature": make_media_signature(uid), "userId": uid,
                                 "deviceId": DEVICE}, verify=False, timeout=30)
            dd = r.json().get("data")
            if isinstance(dd, list) and dd:
                return dd[0].get("token") or dd[0].get("authorizationvideo")
            if isinstance(dd, dict):
                return dd.get("token") or dd.get("authorizationvideo")
        except Exception:
            pass
        return None

    def _variants(self, M, hls, tok):
        try:
            rr = M.get(hls.split("?")[0] + "?authorizationvideo=" + tok)
            base = hls.split("?")[0].rsplit("/", 1)[0]
            return [(l.strip() if l.strip().startswith("http") else base + "/" + l.strip())
                    for l in rr.text.splitlines() if l.strip() and not l.startswith("#")]
        except Exception:
            return []

    def _parse_pl(self, M, url, tok):
        try:
            rr = M.get(url.split("?")[0] + "?authorizationvideo=" + tok)
            if rr.status_code != 200:
                return None
            base = url.split("?")[0].rsplit("/", 1)[0]
            segs, durs, cur = [], [], None
            for l in rr.text.splitlines():
                if l.startswith("#EXTINF:"):
                    cur = float(l.split(":")[1].split(",")[0])
                elif l.strip() and not l.startswith("#") and cur is not None:
                    ln = l.strip()
                    if not ln.startswith("http"):
                        ln = base + "/" + ln
                    segs.append(ln); durs.append(cur); cur = None
            return segs, durs
        except Exception:
            return None

    def _verify_pool_done(self, pid, pname):
        """Check pool đã được server mark complete chưa — max 3 lần, mỗi lần chờ 10s."""
        for attempt in range(3):
            if attempt > 0:
                self._wait(8.0, "chờ server tính pool xong rồi check lại")
            j = self._post("question_pool/totalAnswerInPool",
                           {"TEST_QUESTION_POOL_ID": pid})
            d = (j.get("data") or [{}])
            d = d[0] if isinstance(d, list) and d else (d or {})
            answered = d.get("TOTAL_QUESTION_ANSWER")
            total = d.get("TOTAL_QUESTION")
            if answered is not None and total is not None and answered >= total:
                self.pr(f"      ✔ POOL DONE {str(pname)[:40]} — server xác nhận {answered}/{total}")
                return True
            self.pr(f"      ⚠ POOL CHƯA XONG {str(pname)[:40]} ({answered}/{total}) — check lại lần {attempt+1}/3")
        self.pr(f"      ✖ POIL KHÔNG XÁC NHẬN: {str(pname)[:40]}")
        return False

    def _report_videos(self, cid, pending):
        """Report sau khi pool xong — server cần ~2 phút kể từ lúc stream mới ăn."""
        need = [v for v in pending if not v.get("IS_COMPLETED_VIDEO_IN_COURSE")]
        if not need:
            return
        # nguong = dur tung video (test 9 video: report an khi troi du ~dur ke tu luc stream)
        # video chua du: bo qua, don nen se report dung luc — khong block chuong sau
        elapsed_min = min(time.time() - v.get("_stream_t", time.time()) for v in need)
        dur_max = max(float(v.get("VIDEO_DURATION_LENGTH") or 0) for v in need)
        if elapsed_min < dur_max:
            self.pr(f"      ⏭ video mới stream {elapsed_min:.0f}s < dur {dur_max:.0f}s — để dọn nền report lúc đủ")
            return
        for v in need:
            if self.stop.is_set():
                return
            vid = v["VIDEO_ID"]
            dur = float(v.get("VIDEO_DURATION_LENGTH") or 0)
            body = {"COURSE_ID": cid, "VIDEO_ID": vid,
                    "CHECKPOINT_LAST_POSITION_TIME": 0.0,
                    "LIST_CHUNK_VIEW_VIDEO": [{"FROM_POSITION_TIME": 0.0,
                                               "TO_POSITION_TIME": round(dur, 3)}]}
            j = self._post("course/lesson/updateViewVideoInLessonV2", body)
            if j.get("errorCode") == 0 and (j.get("data") or {}).get("IS_COMPLETED_VIDEO"):
                v["IS_COMPLETED_VIDEO_IN_COURSE"] = True
                v["NUMBER_PERCENT_DURATION_VIEWED_IN_COURSE"] = 100.0
                self.pr(f"      ✅ {vid} HOÀN THÀNH")
            else:
                self.pr(f"      ⏭ {vid} chưa ăn (ec={j.get('errorCode')}) — để dọn nền/cuối")
            self._wait(random.uniform(0.3, 0.8), "giãn report video")

    def _watch_parallel(self, cid, pending):
        """Logic video port NGUYÊN VẸN từ autofull.py — 12 thread."""
        pending = [v for v in pending
                   if float(v.get("VIDEO_DURATION_LENGTH") or 0) > 30
                   and v.get("FILE_ATTACHMENT_URL_HLS")]
        if not pending:
            self.pr("[P] không còn video hợp lệ (dur>30 + có HLS)")
            return
        tok = self._media_jwt()
        self.pr(f"      [P] {len(pending)} video | {min(VIDEO_WORKERS, len(pending))} luồng | JWT: {'OK' if tok else 'THẤT BẠI'}")
        q = queue.Queue()
        for v in pending:
            q.put(v)
        done_ct = [0]
        vlock = threading.Lock()

        def worker():
            Ml = httpx.Client(verify=False, timeout=30,
                              headers={"user-agent": "ExoPlayer",
                                       "accept-encoding": "gzip, deflate, br"},
                              limits=httpx.Limits(max_connections=8, max_keepalive_connections=8))
            while True:
                try:
                    v = q.get_nowait()
                except queue.Empty:
                    return
                if self.stop.is_set():
                    return
                vid = v["VIDEO_ID"]
                dur = float(v.get("VIDEO_DURATION_LENGTH") or 0)
                hls = v.get("FILE_ATTACHMENT_URL_HLS") or ""
                try:
                    v["_stream_t"] = time.time()
                    self.pr(f"      ▶ {vid} nhận việc (dur={dur:.0f}s)\n")
                    try:
                        self._post("video/increaseViewedCount",
                                   {"is_viewed": True, "video_id": vid, "time_view": 4})
                    except Exception:
                        pass
                    # burn chunk 28s
                    pos = 0.0
                    while pos < dur - 0.001:
                        nxt = min(pos + 28.0, dur)
                        if nxt >= dur - 0.001:
                            nxt = dur
                        fin = nxt >= dur - 0.001
                        ck = 0.0 if fin else float(int(nxt))
                        self._post("course/lesson/updateViewVideoInLessonV2", {
                            "COURSE_ID": cid, "VIDEO_ID": vid,
                            "CHECKPOINT_LAST_POSITION_TIME": ck,
                            "LIST_CHUNK_VIEW_VIDEO": [{"FROM_POSITION_TIME": 0.0,
                                                       "TO_POSITION_TIME": round(nxt, 3)}]})
                        pos = nxt
                        if not fin:
                            time.sleep(0.05)
                    self.pr(f"      ⚙ {vid} burn xong — stream 82%")
                    # stream media 82% @1s/segment — KHÔNG top-up
                    acc = 0.0
                    if tok and hls:
                        vs_ = self._variants(Ml, hls, tok)
                        if vs_:
                            p = self._parse_pl(Ml, vs_[0], tok)
                            if p:
                                segs, durs = p
                                target = dur * 1.0
                                for i, s in enumerate(segs):
                                    if acc >= target or self.stop.is_set():
                                        break
                                    try:
                                        Ml.get(s.split("?")[0] + "?authorizationvideo=" + tok)
                                    except Exception:
                                        pass
                                    acc += durs[i] if i < len(durs) else 10.0
                                    time.sleep(0.01)
                    with vlock:
                        done_ct[0] += 1
                        self.pr(f"      📼 VIDEO {done_ct[0]:>2}/{len(pending)} | {vid} | ĐÃ STREAM {acc:.0f}s/{dur:.0f}s — đợi report cuối chương")
                    time.sleep(random.uniform(0.05, 0.15))
                except Exception as e:
                    with vlock:
                        self.failed_videos.append(vid)
                        self.pr(f"  [x err] {vid}: {e}")
                q.task_done()

        ths = [threading.Thread(target=worker, daemon=True)
               for _ in range(min(VIDEO_WORKERS, max(len(pending), 1)))]
        for t in ths:
            t.start()
        for t in ths:
            t.join()
        self._last_stream_t = time.time()


    def do_pool(self, pool):
        pid = pool["_id"]
        total = pool.get("QUESTION_COUNT") or 0
        answered = pool.get("NUM_QUESTION_ANSWER") or 0

        if total and answered >= total:
            self._post("question_pool/totalAnswerInPool", {"TEST_QUESTION_POOL_ID": pid})
            with _lock:
                self.progress["pools_done"] += 1
            return

        self.pr(f"[*] Pool: {pool.get('TEST_QUESTION_POOL_NAME')} ({answered}/{total})")
        jt = self._retry(lambda: self.S.post("user/getCurrentTime", content=b"").json(), "gettime")
        srv_off = dt.timedelta(0)
        try:
            st = ((jt.get("data") or [{}])[0]).get("CURRENT_TIME")
            if st:
                srv_off = (dt.datetime.fromisoformat(st.replace("Z", "+00:00"))
                           - dt.datetime.now(dt.timezone.utc))
        except Exception:
            pass

        self._post("question_pool/checkPoolPrerequisite",
                   {"LIST_PREREQUISITE": pool.get("TEST_QUESTION_POOL_PREREQUISITE") or []})

        qs, page, opt = [], 1, {}
        while True:
            j = self._post("question_pool/getListQuestionInQuestionPool", {
                "page": page, "limit": 5,
                "TEST_QUESTION_POOL_ID": pid,
                "USER_ID": pool.get("USER_ID")})
            b = j.get("data") or []
            opt = j.get("option_data") or {}
            qs += b
            if len(b) < 5:
                break
            page += 1

        lim, cur = opt.get("LIMITED_TIME_ANSWER_POOL"), opt.get("CURRENT_TIME")
        if lim and cur and lim < cur:
            self.pr("  [!] Phiên hết giờ — dọn & đóng pool")
            self._post("question/autoUpdateAllQuestionInPoolOutTime", {"TEST_QUESTION_POOL_ID": pid})
            self._post("question_pool/totalAnswerInPool", {"TEST_QUESTION_POOL_ID": pid})
            with _lock:
                self.progress["pools_done"] += 1
            return

        todo = [q for q in qs if not q.get("IS_ANSWERED")]
        correct = attempted = 0

        # ===== DELAY ĐỘNG: mọi pool hiển thị 1p30 - 2p30 (thời gian FAKE trên app) =====
        # Công thức thực nghiệm đã verify: hiển thị = delay * n * (n+3) / 2
        # (n=5,delay=300 -> 100 phút | n=10,delay=300 -> 325 phút | n=5,delay=2.5 -> 50s ...)
        # => delay = target_seconds * 2 / (n * (n+3))
        n_q = max(len(todo), 1)
        # delay int sao cho hien thi delay*n(n+3)/2 nam trong 70-100s
        lo = (50 * 2) / (n_q * (n_q + 3))   # hien thi >= 90s
        hi = (70 * 2) / (n_q * (n_q + 3))   # hien thi <= 150s
        base_delay = int((lo + hi) / 2) + 1

        pool_fake_minutes = random.uniform(1.9, 2.2)
        virt = dt.datetime.now(dt.timezone.utc) + srv_off - dt.timedelta(minutes=pool_fake_minutes)
        pool_start_t0 = virt.isoformat().replace("+00:00", "Z")

        seen_ids, seen_t0s, seen_t1s = [], [], []
        _active_cv = threading.Condition()
        _active_done = [False]

        def _active_worker():
            last_sent = 0
            while True:
                with _active_cv:
                    while len(seen_ids) <= last_sent:
                        if _active_done[0] and len(seen_ids) == last_sent:
                            return
                        _active_cv.wait(timeout=0.5)
                    snap_ids = list(seen_ids); snap_t0 = list(seen_t0s); snap_t1 = list(seen_t1s)
                    n2 = len(snap_ids)
                if n2 > last_sent:
                    self._post("question_pool/addInfoPoolAnswer", {
                        "TEST_QUESTION_POOL_ID": pid,
                        "REALLY_STARTING_DATETIME": pool_start_t0,
                        "REALLY_ENDING_DATETIME": snap_t1[-1],
                        "USERS_TEST_QUESTION_POOL_STATUS_TYPE_NAME": "Active",
                        "USERS_TEST_QUESTION_POOL_STATUS_TYPE_NAME_EN": "Active",
                        "LIST_TEST_QUESTION_ID_SEEN": snap_ids,
                        "LIST_TIME_STARTED_SEEN_QUESTION": snap_t0,
                        "LIST_TIME_ENDED_SEEN_QUESTION": snap_t1})
                    last_sent = n2

        _ath = threading.Thread(target=_active_worker, daemon=True)
        _ath.start()

        for q in todo:
            if self.stop.is_set():
                return
            qid, text, choices, multi = q["TEST_QUESTION_ID"], *parse_question(q)
            load_bank_if_new()
            with _lock:
                sol = BANKD.get(qid)
            src = "bank"
            if sol is None:
                sol, src = ask_qwen(text, choices, multi), "qwen"
            delay = max(1, int(random.uniform(base_delay, base_delay * 1.3)) + 1)
            t0 = virt.isoformat().replace("+00:00", "Z")
            virt += dt.timedelta(seconds=delay)
            t1 = virt.isoformat().replace("+00:00", "Z")
            body = {"TEST_QUESTION_ID": qid, "TEST_QUESTION_POOL_ID": pid,
                    "MULTIPLE_CHOICE_QUESTION_CHOICE_SOLUTION": sol,
                    "ID_TYPE_CHARGE": CHARGE, "TEST_QUESTION_ANSWER_DATETIME": t0,
                    "TEST_QUESTION_ANSWER_END_DATETIME": t1,
                    "TEST_QUESTION_ANSWER_TOTAL_TIME_AMOUNT": delay, "SELECTION_TIMES": 1}

            j = self._post("question/markMultiChoice", body)
            msg = j.get("message") or ""
            for tries in range(5):
                if "đang được xử lý" in msg:
                    self.pr(f"  [⏳] chờ server 12s (lần {tries + 1})")
                    time.sleep(12)
                    j = self._post("question/markMultiChoice", body)
                    msg = j.get("message") or ""
                elif "vượt quá" in msg and tries == 0:
                    self.pr("  [!] Phiên hết giờ — dọn & đóng pool")
                    self._post("question/autoUpdateAllQuestionInPoolOutTime", {"TEST_QUESTION_POOL_ID": pid})
                    self._post("question_pool/totalAnswerInPool", {"TEST_QUESTION_POOL_ID": pid})
                    with _lock:
                        self.progress["pools_done"] += 1
                    return
                else:
                    break

            if "đã trả lời" in msg or "đang được xử lý" in msg:
                continue

            real = ((j.get("data") or [{}])[0]).get("LIST_SOLUTION")
            if real:
                with _lock:
                    BANKD[qid] = real
                save_bank()

            data_item = (j.get("data") or [{}])[0] if isinstance(j.get("data"), list) else (j.get("data") or {})
            ok2 = bool(data_item.get("IS_CORRECT") or data_item.get("SCORE", 0) > 0 or "thành công" in msg.lower() or "chính x" in msg.lower())
            correct += int(ok2)
            attempted += 1
            with _lock:
                self.progress["correct"] += int(ok2)
                self.progress["answered"] += 1
            self.pr(f"  [{'v' if ok2 else 'x'}] ({src}) {text[:55]}... -> {msg}")

            seen_ids.append(qid)
            seen_t0s.append(t0)
            seen_t1s.append(t1)
            with _active_cv:
                _active_cv.notify_all()

        _active_done[0] = True
        with _active_cv:
            _active_cv.notify_all()
        _ath.join(timeout=10)

        self.pr(f"[*] Kết quả: {correct}/{attempted}")
        self._post("question_pool/addInfoPoolAnswer", {
            "TEST_QUESTION_POOL_ID": pid,
            "REALLY_STARTING_DATETIME": pool_start_t0,
            "REALLY_ENDING_DATETIME": t1 if 't1' in locals() else pool_start_t0,
            "USERS_TEST_QUESTION_POOL_STATUS_TYPE_NAME": "Completed",
            "USERS_TEST_QUESTION_POOL_STATUS_TYPE_NAME_EN": "Completed",
            "LIST_TEST_QUESTION_ID_SEEN": seen_ids,
            "LIST_TIME_STARTED_SEEN_QUESTION": seen_t0s,
            "LIST_TIME_ENDED_SEEN_QUESTION": seen_t1s})
        self._post("question_pool/totalAnswerInPool", {"TEST_QUESTION_POOL_ID": pid})
        with _lock:
            self.progress["pools_done"] += 1

    def run_course(self, course_kw, skip_video=False):
        c = next((x for x in self.get_courses() if _strip(course_kw) in _strip(x.get("COURSE_NAME")) or course_kw.strip() in [x.get("COURSE_ID"), x.get("_id")]), None)
        if not c:
            self.pr(f"[!] Không thấy môn: {course_kw}")
            return False
        cid = c.get("COURSE_ID") or c["_id"]
        self.failed_videos = []
        self._streamed_pending = []
        self._video_enforced = False
        self._carry = []
        self._vpos = {}
        self._vpct = {}
        with _lock:
            self.progress.update({"correct": 0, "answered": 0,
                                  "pools_done": 0, "pools_total": 0,
                                  "course": c.get("COURSE_NAME", "")})
        self.pr(f"[*] Môn học: {c.get('COURSE_NAME')}")

        lessons, page = [], 1
        while True:
            batch = (self._post("course/lesson/getListLessonInCourse", {
                "COURSE_ID": cid, "page": page, "limit": 20}).get("data") or [])
            lessons += batch
            if len(batch) < 20:
                break
            page += 1
        with _lock:
            self.progress["pools_total"] = sum(l.get("NUMBER_QUESTION_POOL") or 0 for l in lessons)
        self.pr(f"[*] {len(lessons)} chương, {self.progress['pools_total']} pool")

        for lesson in lessons:
            if self.stop.is_set():
                return False

            if skip_video:
                for pool in (self._post("course/lesson/getListQuestionPoolInLesson", {
                    "LESSON_ID": lesson["LESSON_ID"], "page": 1, "limit": 20
                }).get("data") or []):
                    if self.stop.is_set():
                        return False
                    self.do_pool(pool)
                continue

            lid = lesson["LESSON_ID"]
            vids = (self._post("course/lesson/getListVideoInLesson", {
                "LESSON_ID": lid, "page": 1, "limit": 20}).get("data") or [])
            pending = [v for v in vids
                       if not v.get("IS_COMPLETED_VIDEO_IN_COURSE")
                       or (v.get("NUMBER_PERCENT_DURATION_VIEWED_IN_COURSE") or 0) < 99.5]
            pools = (self._post("course/lesson/getListQuestionPoolInLesson", {
                "LESSON_ID": lid, "page": 1, "limit": 20}).get("data") or [])

            self.pr("")
            self.pr(f"[CHƯƠNG] {lesson['LESSON_NAME'][:60]} — pool: {len(pools)} | video: {len(pending)}")

            pool_thread = None
            if pools:
                # do_pool GOI NGUYEN VIEN qua thread — ben trong khong doi gi
                pool_thread = threading.Thread(
                    target=lambda: [self.do_pool(pool) for pool in pools
                                    if not self.stop.is_set()],
                    daemon=True)
                pool_thread.start()

            if pending and not self.stop.is_set():
                self.pr(f"┌─── [STREAM] {len(pending)} video + pool song song ───")
                self._watch_parallel(cid, pending)
                self._streamed_pending += [v for v in pending
                                           if not v.get("IS_COMPLETED_VIDEO_IN_COURSE")]

            if pool_thread is not None:
                pool_thread.join()

            if pending and not self.stop.is_set():
                self.pr(f"└─── [REPORT] hoàn thành {len(pending)} video của chương ───")
                self._report_videos(cid, pending)

            if not self.stop.is_set():
                back = [v for v in getattr(self, "_streamed_pending", [])
                        if not v.get("IS_COMPLETED_VIDEO_IN_COURSE")
                        and v.get("FILE_ATTACHMENT_URL_HLS")]
                if back and not getattr(self, "_bg_cleaning", False):
                    self._bg_cleaning = True
                    self.pr(f"      ♻ dọn nền {len(back)} video cũ — 12 luồng…")
                    dlock = threading.Lock()
                    def bg_one(v):
                        vid = v["VIDEO_ID"]
                        dur = float(v.get("VIDEO_DURATION_LENGTH") or 0)
                        if time.time() - v.get("_stream_t", 0) < dur:
                            return  # chua du dur — lan don nen sau se an
                        body = {"COURSE_ID": cid, "VIDEO_ID": vid,
                                "CHECKPOINT_LAST_POSITION_TIME": 0.0,
                                "LIST_CHUNK_VIEW_VIDEO": [{"FROM_POSITION_TIME": 0.0,
                                                           "TO_POSITION_TIME": round(dur, 3)}]}
                        j = self._post("course/lesson/updateViewVideoInLessonV2", body)
                        if j.get("errorCode") == 0 and (j.get("data") or {}).get("IS_COMPLETED_VIDEO"):
                            v["IS_COMPLETED_VIDEO_IN_COURSE"] = True
                            self.pr(f"      ✅ {vid} HOÀN THÀNH (dọn nền)")
                    def bg_clean():
                        try:
                            remaining = [v for v in list(back)
                                         if not v.get("IS_COMPLETED_VIDEO_IN_COURSE")]
                            while remaining and not self.stop.is_set():
                                ths = []
                                for v in remaining:
                                    if self.stop.is_set():
                                        break
                                    while len([t for t in ths if t.is_alive()]) >= 12:
                                        time.sleep(0.2)
                                    t = threading.Thread(target=bg_one, args=(v,), daemon=True)
                                    t.start()
                                    ths.append(t)
                                for t in ths:
                                    t.join()
                                remaining = [v for v in remaining
                                             if not v.get("IS_COMPLETED_VIDEO_IN_COURSE")]
                                if remaining:
                                    # chua du dur — doi 20s roi quet lai (dong ho dur van chay)
                                    time.sleep(20.0)
                        finally:
                            self._bg_cleaning = False
                    threading.Thread(target=bg_clean, daemon=True).start()

        pass

        # video da stream nhung chua an — stream lai + report toi khi comp (12 luong)
        leftover = [v for v in getattr(self, "_streamed_pending", [])
                    if not v.get("IS_COMPLETED_VIDEO_IN_COURSE")]
        if leftover:
            self.pr(f"[*] Dọn nốt {len(leftover)} video — 12 luồng…")
            dlock = threading.Lock()

            def cleanup(v):
                vid = v["VIDEO_ID"]
                dur = float(v.get("VIDEO_DURATION_LENGTH") or 0)
                # doi du dur ke tu luc stream roi moi report — stream lai la thua
                lack = dur + 15.0 - (time.time() - v.get("_stream_t", time.time()))
                if lack > 0:
                    self._wait(lack, f"{vid} chờ đủ dur +15s buffer ({lack:.0f}s)")
                body = {"COURSE_ID": cid, "VIDEO_ID": vid,
                        "CHECKPOINT_LAST_POSITION_TIME": 0.0,
                        "LIST_CHUNK_VIEW_VIDEO": [{"FROM_POSITION_TIME": 0.0,
                                                   "TO_POSITION_TIME": round(dur, 3)}]}
                fails = 0
                while not self.stop.is_set():
                    j = self._post("course/lesson/updateViewVideoInLessonV2", body)
                    if j.get("errorCode") == 0 and (j.get("data") or {}).get("IS_COMPLETED_VIDEO"):
                        v["IS_COMPLETED_VIDEO_IN_COURSE"] = True
                        self.pr(f"      ✅ {vid} HOÀN THÀNH (dọn cuối)")
                        break
                    fails += 1
                    self._wait(3.0, f"{vid} chưa sync ({fails})")
                if not v.get("IS_COMPLETED_VIDEO_IN_COURSE"):
                    with dlock:
                        self.failed_videos.append(vid)
                    self.pr(f"      ❌ {vid} không ăn — vào failed")

            dths = []
            for v in leftover:
                if self.stop.is_set():
                    break
                while len([t for t in dths if t.is_alive()]) >= 12:
                    time.sleep(0.2)
                t = threading.Thread(target=cleanup, args=(v,), daemon=True)
                t.start()
                dths.append(t)
            for t in dths:
                t.join()
        if self.failed_videos:
            self.pr(f"[!] VIDEO CHƯA XONG ({len(self.failed_videos)}): " + ", ".join(self.failed_videos))
        else:
            self.pr("[*] TOÀN BỘ VIDEO ĐÃ XONG")
        self.pr("[*] Hết vòng quét")
        return True

    def _print_ranking_course(self, course_kw):
        """Tim mon theo keyword roi in bang xep hang."""
        courses = self.get_courses()
        c = next((x for x in courses
                  if _strip(course_kw) in _strip(x.get("COURSE_NAME"))
                  or course_kw.strip() in [x.get("COURSE_ID"), x.get("_id")]), None)
        if not c:
            self.pr(f"[!] Không thấy môn: {course_kw}")
            return
        cid = str(c.get("COURSE_ID") or c.get("_id"))
        self.pr(f"[*] BXH môn: {c.get('COURSE_NAME')}")
        self._print_ranking(cid)

    def _print_ranking(self, cid):
        """Bang xep hang mon — tim minh trong moi trang, in rank/grade/time."""
        uid = jwt_user(self.S.headers["authorization"])["userId"]
        me, top, pg = None, [], 1
        while pg <= 10:
            j = self._post("course/getRankingUserInCourse",
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
        G, Y, C, R = '\033[92m', '\033[93m', '\033[96m', '\033[0m'

        def fmt_time(t):
            try:
                t = float(t)
            except (TypeError, ValueError):
                return "?"
            if t < 59.5:
                return f"{int(round(t))}s"
            m, s = divmod(int(round(t)), 60)
            return f"{m}ph{s:02d}s"

        self.pr('')
        self.pr(C + '┏━━━━━ BẢNG XẾP HẠNG ━━━━━' + R)
        for u in top:
            self.pr(f"{C}┃{R} 🏆 #{u.get('CURRENT_RANKING'):>2} {str(u.get('FULL_NAME'))[:22]:24}"
                    f"{G}⭐ {u.get('GRADE_PERCENTILE_ACHIEVED')}{R}"
                    f" ⏱ {fmt_time(u.get('TIME_TAKEN_TO_COMPLETE'))}")
        if me:
            rk = me.get('CURRENT_RANKING')
            self.pr(f"{Y}┃{R} 👤 MÌNH #{rk} {str(me.get('FULL_NAME'))[:22]:24}"
                    f"{G}⭐ {me.get('GRADE_PERCENTILE_ACHIEVED')}{R}"
                    f" ⏱ {fmt_time(me.get('TIME_TAKEN_TO_COMPLETE'))}")
            if rk == 1:
                self.pr(f"{G}┃{R} 🥇 TOP 1")
            elif rk <= 3:
                self.pr(f"{G}┃{R} 🥉 TOP {rk}")
        else:
            self.pr(f"{Y}┃{R} 👤 MÌNH: không nằm trong top 200")
        self.pr(C + '┗━━━━━━━━━━━━━━━━━━━━━━━━' + R)

    def _course_snapshot(self, course_kw):
        c = next((x for x in self.get_courses() if _strip(course_kw) in _strip(x.get("COURSE_NAME")) or course_kw.strip() in [x.get("COURSE_ID"), x.get("_id")]), None)
        if not c:
            return {}
        cid = c.get("COURSE_ID") or c["_id"]
        out, page = {}, 1
        while True:
            batch = (self._post("course/lesson/getListLessonInCourse", {
                "COURSE_ID": cid, "page": page, "limit": 20}).get("data") or [])
            for l in batch:
                out[l["LESSON_ID"]] = (l.get("IS_COMPLETE"),
                                       l.get("NUMBER_PERCENT_PROGRESS_COMPLETE_LESSON"),
                                       l.get("NUMBER_VIDEO_VIEWED"),
                                       l.get("NUMBER_QUESTION_POOL_DONE"))
            if len(batch) < 20:
                break
            page += 1
        return out

    def run_course_auto(self, course_kw, skip_video=False, max_passes=8):
        t_start = time.time()
        prev = None
        same = 0
        for p in range(1, max_passes + 1):
            if self.stop.is_set():
                return
            self.pr(f"### VÒNG {p}/{max_passes}")
            self.run_course(course_kw, skip_video)
            snap = self._course_snapshot(course_kw)
            done = sum(1 for v in snap.values() if v[0])
            total = len(snap)
            self.pr(f"### Chương hoàn thành: {done}/{total}")
            if done == total and total > 0 and not self.failed_videos:
                el = int(time.time() - t_start)
                self.pr(f"### ✅ MÔN HOÀN TẤT 100% — ⏱ {el // 60}p{el % 60:02d}s")
                try:
                    c_data = self.get_courses()
                    done, remain, cur_name = [], 0, ''
                    G = '\033[92m'
                    Y = '\033[93m'
                    C = '\033[96m'
                    R = '\033[0m'
                    for c in c_data:
                        name = str(c.get('COURSE_NAME') or 'N/A')
                        cid2 = str(c.get('COURSE_ID') or c.get('_id') or '')
                        try: tot = float(c.get('TOTAL_GRADE_PERCENTILE_ACHIEVED') or 0)
                        except Exception: tot = 0.0
                        is_curr = (_strip(course_kw) in _strip(name)) or (course_kw.strip() == cid2)
                        if is_curr:
                            cur_name = f'{name} ({tot:.0f}/100)'
                        elif tot >= 95.0:
                            done.append(f'{name} ({tot:.0f}/100)')
                        else:
                            remain += 1
                    self.pr('\n' + C + '=' * 48 + R)
                    if cur_name:
                        self.pr(f'{G} [VỪA XONG] -> {cur_name}{R}')
                    if done:
                        self.pr(f'{C} CÁC MÔN ĐÃ ĐẠT CHUẨN:{R}')
                        for d in done:
                            self.pr(f'{G}   ✔ {d}{R}')
                    self.pr(f'{Y} CÒN LẠI: {remain} môn chưa học{R}')
                    self.pr(C + '=' * 48 + R + '\n')
                except Exception as _e:
                    self.pr(f'[!] Khong the in bang diem: {_e}')
                try:
                    c0 = next((x for x in c_data
                               if _strip(course_kw) in _strip(x.get('COURSE_NAME'))
                               or course_kw.strip() in [x.get('COURSE_ID'), x.get('_id')]), None)
                    cid_run = str(c0.get('COURSE_ID') or c0.get('_id')) if c0 else ''
                    if cid_run:
                        self._print_ranking(cid_run)
                except Exception as _e:
                    self.pr(f'[!] Khong the in bang xep hang: {_e}')
                return

            if snap == prev:
                same += 1
                if same >= 2:
                    el = int(time.time() - t_start)
                    self.pr(f"### Không còn tiến triển — dừng — ⏱ {el // 60}p{el % 60:02d}s")
                    return
            else:
                same = 0
            prev = snap
            self.pr("### Chờ 5s…")
            time.sleep(5)
        el = int(time.time() - t_start)
        self.pr(f"### Hết số vòng — ⏱ {el // 60}p{el % 60:02d}s")

try:
    BANKD = json.load(open(BANK, encoding="utf-8"))
except Exception:
    BANKD = {}
    try:
        os.remove(BANK)
    except OSError:
        pass

if __name__ == "__main__":
    import sys
    skip = "--skip-video" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 3:
        print("Cách dùng: python auto.py <user> <password> <tên môn> [--skip-video]")
        sys.exit(1)
    qa = ClickQA()
    qa.login(args[0], args[1])
    qa.run_course_auto(args[2], skip)
