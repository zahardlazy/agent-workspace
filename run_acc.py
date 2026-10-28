# run_acc.py — chạy 1 acc (NHIỀU môn) trong process riêng
import sys, os, time, random

if len(sys.argv) < 4:
    print("Cách dùng: python run_acc.py <user> <pass> <môn1|môn2|...> [device] [--skip-video]")
    sys.exit(1)

extra = [a for a in sys.argv[4:] if not a.startswith("--")]
if extra:
    os.environ["CLICKQA_DEVICE"] = extra[0]    
print("APIKEY ENV:", bool(os.environ.get("CLICKQA_APIKEY")))
print("QKEY ENV:", bool(os.environ.get("CLICKQA_QKEY")))
print("DEVICE ENV:", os.environ.get("CLICKQA_DEVICE"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
import auto

user, pwd = sys.argv[1], sys.argv[2]
courses = [c.strip() for c in sys.argv[3].split("|") if c.strip()]
skip = "--skip-video" in sys.argv

os.makedirs(r"C:\frida\logs", exist_ok=True)

class Tee:
    def __init__(self, path):
        self.f = open(path, "a", encoding="utf-8")
    def write(self, s):
        sys.__stdout__.write(s)
        sys.__stdout__.flush()
        self.f.write(s)
        self.f.flush()
    def flush(self):
        self.f.flush()

sys.stdout = Tee(rf"C:\frida\logs\{user}.log")
sys.stderr = sys.stdout        # traceback crash cũng vào log + console

time.sleep(random.uniform(0.5, 3))   # lệch pha: process không đập server cùng lúc

if not courses:
    print("[!] Không có môn nào để chạy"); sys.exit(1)
print(f"[*] {len(courses)} môn: {' | '.join(courses)}")
qa = auto.ClickQA()
qa.login(user, pwd)
for c in courses:
    print(f"===== MÔN: {c} =====")
    qa.run_course_auto(c, skip)
print("[*] Xong. Log lưu tại logs/%s.log" % user)