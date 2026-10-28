// bridge-vision.mjs — chat.z.ai, STICKY SESSION + SUBAGENT ROUTE API
// Node >= 22. 0 dependency.

import { createServer } from "node:http";
import { writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT    = Number(process.env.PORT ?? 8789);       // vision
const CDP     = Number(process.env.CDP ?? 9225);         // Chrome rieng vision
const TOOLS   = (process.env.ZAI_TOOLS ?? "off") !== "off";   // vision: khong tools
const VISION  = (process.env.ZAI_VISION ?? "on") === "on";    // vision: DUOC upload anh
const WEBSEARCH = (process.env.VISION_WEBSEARCH ?? "off") === "on";  // vision mac dinh OFF (subagent phan tich anh, khong search) — ham van ton tai, chi gate
const MAXCH   = 30000;   // o nhap web nhan du — khong cat nua
const TIMEOUT = Number(process.env.ZAI_TIMEOUT ?? 600_000);
const PROFILE = process.env.ZAI_PROFILE ? join(process.env.ZAI_PROFILE) : join(homedir(), ".qwen-vision-bridge");   // profile rieng vision
const DUMP    = join(process.cwd(), "vision-last.txt");
const CHROME  = process.env.CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const QWEN_URL = "https://chat.qwen.ai/";
const SEL_TA   = "textarea";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const txt   = c => typeof c === "string" ? c : Array.isArray(c) ? c.map(x => x?.text ?? "").filter(Boolean).join("\n") : "";

const MEM_RE   = /memory extraction subagent/i;
const TITLE_RE = /Generate a concise title|title-generation task|Generate the session title|session title from this JSON|title from this JSON array|summari[sz]e.{0,30}session.{0,30}title/i;
const API_KEY   = (process.env.ZAI_API_KEY ?? "").trim();
const API_URL   = "https://api.z.ai/api/paas/v4/chat/completions";
const API_MODEL   = process.env.ZAI_MEM_MODEL ?? "glm-4.7-flash";
const isMem = msgs => { const u = msgs.find(m => m.role === "user"); return !!u && MEM_RE.test(txt(u.content)); };
const WEBFETCH_RE = /^\s*(<[^>]+>\s*)*Web page content:/i;
const isSub = msgs => {
  if (isMem(msgs)) return true;
  { const u0 = msgs.find(m => m.role === "user"); if (u0 && TITLE_RE.test(txt(u0.content))) return true; }
  if (msgs.some(m => m.role === "system")) return false;
  const u = msgs.find(m => m.role === "user");
  if (!u) return false;
  const c = txt(u.content);
  return msgs.length <= 8 && (WEBFETCH_RE.test(c) || /<system-reminder>[\s\S]{0,400}Web page content:/i.test(c));
};

// ===== TASK FINGERPRINT v2 — strip bien dong truoc khi hash =====
const normTask = s => String(s ?? "")
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
  .replace(/<env>[\s\S]*?<\/env>/gi, "")
  .replace(/(Normalized copy \(read-only\):\s*")[^"]*(mcp-[a-z0-9]+|img-\d+-[a-z0-9]+)\.[a-z0-9]+"/gi, "$1(image)")   // vision: duong dan anh bien dong moi lan — bien thanh (image) de hash on dinh
  .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, " ")
  .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, " ")
  .replace(/\s+/g, " ").trim();
const NOISE_START = /^\[ket qua tool |^Web page content:|^CWD:|^Thought Process|^exit code|^Volume in drive|^This is an automatically generated checkpoint|automatically generated checkpoint condensing|^<checkpoint|^\[checkpoint|^\s*ENVIRONMENT\b|^\s*REVIEW_POLICY\b|You are the final authorization reviewer|^Time sampled while|^Browser time zone for this request|^Current runtime context|^runtime context\b|^#\s*Memor|^#\s*Skill|^\s*Memories\b|^\s*Skills\b/i;
const firstTaskText = msgs => {
  for (const m of msgs) {
    if (m.role !== "user") continue;
    const c = normTask(txt(m.content));
    if (c && !NOISE_START.test(c)) return c;
  }
  return "";
};
const taskKey = fu => { let h = 5381; const s = String(fu || ""); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return "t" + h.toString(36); };
const hashTxt = s => { let h = 5381; const x = normTask(s); for (let i = 0; i < x.length; i++) h = ((h << 5) + h + x.charCodeAt(i)) >>> 0; return h.toString(36); };

// ===== SYNC TASK SANG DSH BRIDGE =====
const DSH_BRIDGE_URL = process.env.DSH_BRIDGE_URL ?? "http://127.0.0.1:8788";
async function syncTaskToDSH(tKey, firstUser) {
  try {
    await fetch(DSH_BRIDGE_URL + "/__settask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskKey: tKey, firstUser }),
    });
  } catch (e) {
    log("sync DSH fail:", String(e.message || e).slice(0, 80));
  }
}

const SESSIONS_FILE = join(process.cwd(), "zai-sessions.json");   // vision chay cwd D:\Zai\ZaiVision — file rieng theo thu muc   // vision chay cwd D:\Zai\ZaiVision — file rieng theo thu muc   // vision chay cwd D:\Zai\ZaiVision — file rieng theo thu muc
const sessions = new Map();
let lastMain = null;   // session CHINH dang DUNG gan nhat (thay cho "moi tao nhat")

try {
  const saved = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
  for (const [k, v] of Object.entries(saved)) {
    if (!v || !v.chatUrl) continue;
    sessions.set(k, { chatUrl: v.chatUrl, sent: 0, mem: k.startsWith("__"), callMap: {}, booted: !!v.chatUrl, firstUser: v.firstUser || "", lastUsed: v.lastUsed || 0 });
  }
  lastMain = [...sessions.values()].filter(S => !S.mem).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))[0] || null;
  log("nap lai", sessions.size, "session tu file");
} catch {}
const saveSessions = () => { try {
  const o = {};
  for (const [k, S] of sessions) if (S.chatUrl) o[k] = { chatUrl: S.chatUrl, firstUser: S.firstUser, mem: S.mem, lastUsed: S.lastUsed || 0 };
  writeFileSync(SESSIONS_FILE, JSON.stringify(o, null, 1));
} catch {} };

const getSess = msgs => {
  const nDataImg = inlineDataImages(msgs);
  if (nDataImg) log("VISION-IN: " + nDataImg + " anh base64 -> file tam");
  const joined = msgs.map(m => txt(m.content)).join("");
  // 0) subagent (memory/title/webfetch) -> 1 session rieng, KHONG BAO GIO sinh chat task moi
  if (isMem(msgs) || (() => { const u0 = msgs.find(m => m.role === "user"); return !!u0 && TITLE_RE.test(txt(u0.content)); })() || (!API_KEY && isSub(msgs))) {
    let S = sessions.get("__mem__");
    if (!S) { S = { chatUrl: null, sent: 0, mem: true, callMap: {}, booted: false, firstUser: "", lastUsed: 0 }; sessions.set("__mem__", S); log("NEW session SUB"); }
    return S;
  }
  const fu = firstTaskText(msgs);
  const k = fu ? taskKey(fu) : null;
  const isCont = msgs.some(m => m.role === "assistant" || m.role === "tool");   // co lutan tra loi = DANG TIEP task -> chat cu (da nghiem 13:48); chi tin user = task MOI -> New Chat

  // 1) task da biet -> DUNG LAI chat cu (mo lai task cu = mo lai chat cu)
  if (isCont && k && sessions.has(k)) { const S = sessions.get(k); S.lastUsed = Date.now(); lastMain = S; return S; }
  if (isCont && lastMain) { lastMain.lastUsed = Date.now(); return lastMain; }   // key khong trung nhung dang tiep = van task hien hanh

  // 2) khong xac dinh duoc task (toan tool-result/webcontent) -> glu vao session DANG DUNG
  if (!k) {
    if (isCont && lastMain) { lastMain.lastUsed = Date.now(); return lastMain; }
    let S = sessions.get("t_anon");
    if (!S) { S = { chatUrl: null, sent: 0, mem: false, callMap: {}, booted: false, firstUser: "", lastUsed: Date.now() }; sessions.set("t_anon", S); lastMain = S; }
    return S;
  }

  // 3) key MOI nhung cac tin gan day da tung gui trong session cu = compact rewrite -> GIU chat cu
  if (!isCont && lastMain && lastMain.seenMsgs) {
    const us = msgs.filter(m => m.role === "user").map(m => normTask(txt(m.content))).filter(x => x.trim().length > 40 && !NOISE_START.test(x));
    if (us.some(h => lastMain.seenMsgs.has(hashTxt(h)))) {
      lastMain.lastUsed = Date.now();
      return lastMain;
    }
  }

  // 4) task that su moi -> session + chat moi (BO lua junk 250 ky tu)
  const S = { chatUrl: null, sent: 0, mem: false, callMap: {}, booted: false, firstUser: fu.slice(0, 300), lastUsed: Date.now() };
  sessions.set(k, S); lastMain = S;
  log("NEW chat task=" + k.slice(0, 10) + " (user_dau: " + fu.slice(0, 90).replace(/\s+/g, " ") + ")");
  return S;
};


let ws, mid = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++mid; pend.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
  const t = list.find(p => p.type === "page" && p.url.includes("qwen.ai")) ?? list.find(p => p.type === "page");
  if (!t) throw new Error("khong co tab page");
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === "Page.javascriptDialogOpening") {
      log("DIALOG chan reload (" + (m.params?.type || "?") + ") -> tu dong chap nhan Leave");
      ws.send(JSON.stringify({ id: ++mid, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
      return;
    }
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  };
  await send("Runtime.enable"); await send("Page.enable");
}
async function launch() {
  if (!existsSync(PROFILE)) mkdirSync(PROFILE, { recursive: true });
  try { await fetch(`http://127.0.0.1:${CDP}/json/version`); log("CDP song — attach"); }
  catch {
    log("mo Chrome...");
    spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`,
      "--disable-features=CalculateNativeWinOcclusion", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-background-timer-throttling", "--no-first-run", "--no-default-browser-check", QWEN_URL],
      { detached: true, stdio: "ignore" }).unref();
    for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${CDP}/json/version`); break; } catch { await sleep(500); } }
  }
  await connect();
}
async function ev(expression, retried = false) {
  let out;
  const TO = retried ? 60_000 : 20_000;
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("WS_TIMEOUT")), TO));
  try {
    out = await Promise.race([send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), timeout]);
  } catch (e) {
    const msg = String(e.message || e);
    const wsDead = ws.readyState !== 1;

    if (!wsDead && /WS_TIMEOUT/.test(msg)) {
      if (!retried) {
        log("BROWSER BAN (eval >" + (TO/1000) + "s) — thu lai 60s, KHONG dong Chrome");
        return ev(expression, true);
      }
      log("BROWSER TREO THAT (>60s) — reload page, giu Chrome + login");
      try { await send("Page.reload"); } catch {}
      await sleep(5000);
      for (let i = 0; i < 60; i++) {
        const ok = await ev(`!!document.querySelector(${JSON.stringify(SEL_TA)})`, true).catch(() => false);
        if (ok) break;
        await sleep(1000);
      }
      return ev(expression, true);
    }

    if (retried) throw e;
    log("WS chet that su (" + msg + ") -> relaunch Chrome (GIU profile)");
    try { ws.close(); } catch {}
    const { execSync } = await import("node:child_process");
    try {
      const psKill = "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'remote-debugging-port=" + CDP + "' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
      execSync("powershell -NoProfile -Command " + JSON.stringify(psKill), { stdio: "ignore" });
    } catch {}
    await sleep(2000);
    try { await Promise.race([launch(), new Promise((_, rej) => setTimeout(() => rej(new Error("LAUNCH_TIMEOUT")), 45_000))]); }
    catch (e2) { log("relaunch LOI:", String(e2 && e2.message || e2)); throw e; }
    await sleep(3000);
    let okRel = false;
    for (let i = 0; i < 20; i++) { okRel = await ev(`!!document.querySelector(${JSON.stringify(SEL_TA)})`, true).catch(() => false); if (okRel) break; await sleep(1000); }
    if (okRel) return ev(expression, true);
    log("==================================================");
    log("Chrome mo lai CHUA LOGIN — login tay trong cua so do.");
    log("Login xong BAM ENTER trong terminal nay (toi da 180s).");
    log("==================================================");
    await new Promise(res => { const t = setTimeout(res, 180_000); process.stdin.once("data", () => { clearTimeout(t); res(); }); });
    return ev(expression, true);
  }
  if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails.exception?.description || out.exceptionDetails).slice(0, 300));
  return out.result?.value;
}
const waitSel = async (sel, ms) => {
  for (let i = 0; i < ms / 300; i++) { if (await ev(`!!document.querySelector(${JSON.stringify(sel)})`)) return true; await sleep(300); }
  return false;
};

// ===== MAT NGUOI — du kien eyes-qwen (textarea / Stop / .chat-response-message) =====
const domState = async () => ev(`(() => { const ta = document.querySelector('textarea'); const stop = !![...document.querySelectorAll('button')].find(b => b.offsetParent && /^stop$/i.test((b.getAttribute('aria-label') || b.innerText || '').trim())); return { inputLen: ta ? (ta.value || '').length : -1, stop }; })()`).catch(() => null);
const snapBody = async () => { const t = await ev(`(() => { const r = document.querySelector('.qwen-recommend-prompt'); if (r) r.setAttribute('data-bridge-cut', '1'); const clone = document.body.cloneNode(true); clone.querySelectorAll('[data-bridge-cut]').forEach(e => e.remove()); const main = clone.querySelector('.chat-response-message'); return (main || clone).innerText; })()`); return String(t ?? ""); };
const DIAG_NOISE = new Set(["."]);
const DIAG_NOISE_RE = /^Thinking completed$|^\+\d+$|^Web search(Fast)?$/i;
const renderCalm = async () => {
  let p = await snapBody(), q = "";
  for (let i = 0; i < 40 && p !== q; i++) { await sleep(500); q = p; p = await snapBody(); }
  return p;
};
const diffNew = (A, B, promptNow) => {
  const cA = new Map();
  for (const x of String(A || "").split("\n").map(x => x.trim()).filter(Boolean)) cA.set(x, (cA.get(x) || 0) + 1);
  const PL = new Set(String(promptNow || "").split("\n").map(x => x.trim()).filter(Boolean));
  const out = [], cB = new Map();
  for (const x of String(B || "").split("\n").map(x => x.trim()).filter(Boolean)) {
    cB.set(x, (cB.get(x) || 0) + 1);
    if (PL.has(x) || DIAG_NOISE.has(x) || DIAG_NOISE_RE.test(x)) continue;
    if (cB.get(x) > (cA.get(x) || 0)) out.push(x);
  }
  return out;
};
const reloadPage = async () => {
  await send("Page.reload").catch(() => {});
  await sleep(4500);
  for (let i = 0; i < 30; i++) { if (await ev('!!document.querySelector("textarea")')) break; await sleep(500); }
  await renderCalm();
};
async function waitIdle(ms = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const st = await domState();
    if (st && !st.stop) return;
    if (Date.now() - t0 > ms) {
      log("waitIdle: Stop con hien qua lau -> bam Stop 1 lan");
      await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.offsetParent && /^stop$/i.test((x.getAttribute('aria-label') || x.innerText || '').trim())); if (b) b.click(); })()`).catch(() => {});
      const t1 = Date.now();
      for (;;) { const s = await domState(); if (s && !s.stop) return; if (Date.now() - t1 > 20_000) return; await sleep(500); }
    }
    await sleep(700);
  }
}
async function openChat(S) {
  if (!S.chatUrl && S.sent > 0 && !S.mem) {
    const tabu = await ev("location.href").catch(() => "");
    if (tabu && /\/c\/[0-9a-f-]{16,}/i.test(tabu)) {
      const owned = [...sessions.values()].some(x => x && x.chatUrl === tabu);
      if (!owned) { S.chatUrl = tabu; log("TAB ADOPT — " + tabu.slice(-24)); saveSessions(); }
    }
  }
  const cur = await ev("location.href").catch(() => "");
  if (!(S.chatUrl && cur === S.chatUrl)) {
    await send("Page.navigate", { url: S.chatUrl ?? QWEN_URL });
    if (!(await waitSel(SEL_TA, 30_000))) throw new Error("khong thay textarea — login Qwen trong Chrome cua bridge truoc");
    await sleep(2500);
  }
  await waitIdle();
}
async function grabChatId(S) {
  if (S.chatUrl) return S.chatUrl;
  for (let i = 0; i < 40; i++) {
    const u = await ev("location.href").catch(() => "");
    if (/\/c\/[0-9a-f-]{16,}/i.test(u)) { S.chatUrl = u; log("gio chat:", u); saveSessions(); return u; }
    await sleep(500);
  }
  log("CANH: khong lay duoc chat_id");
  return null;
}
async function uploadImagesViaCDP(paths) {
  if (!paths.length) return 0;
  let ok = 0;
  for (const item of paths) {
    try {
      const before = await ev(`(() => [...document.querySelectorAll('img')].filter(i => /^blob:/.test(i.src || '')).length)()`).catch(() => 0);
      const buf = readFileSync(item.src);
      if (buf.length > 4 * 1024 * 1024) log("WARN: anh " + (buf.length / 1048576).toFixed(1) + "MB lon — base64 injection co the cham/loi");
      const b64 = buf.toString("base64");
      const ext = (item.ext || ".png").toLowerCase();
      const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/png";
      const fname = "img-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6) + ext;
      const r = await ev(`(async () => {
        try {
          const b64 = ${JSON.stringify(b64)};
          const bin = atob(b64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          const f = new File([arr], ${JSON.stringify(fname)}, { type: ${JSON.stringify(mime)} });
          const dt = new DataTransfer();
          dt.items.add(f);
          const ta = document.querySelector('textarea');
          if (!ta) return { ok: false, why: 'no textarea' };
          ta.focus();
          ta.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
          return { ok: true };
        } catch (e) { return { ok: false, why: String(e && e.message || e) }; }
      })()`);
      if (!r || !r.ok) { log("UPLOAD paste FAIL:", r && r.why); continue; }
      let landed = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        const n = await ev(`(() => [...document.querySelectorAll('img')].filter(i => /^blob:/.test(i.src || '')).length)()`).catch(() => before);
        if (n > before) { landed = true; break; }
        await sleep(700);
      }
      if (landed) { ok++; log("UPLOAD paste OK: " + fname + " (" + (buf.length / 1024).toFixed(0) + "KB)"); }
      else log("UPLOAD paste KHONG thay thumbnail sau 25s: " + fname);
      await sleep(800);
    } catch (e) {
      log("UPLOAD FAIL:", String(e && e.message || e).slice(0, 120));
    }
  }
  return ok;
}
function inlineDataImages(msgs) {
  let n = 0;
  for (const m of msgs) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    const nc = [];
    for (const part of m.content) {
      let url = null;
      if (typeof part?.image_url?.url === "string") url = part.image_url.url;
      else if (part?.type === "image" && part?.source?.data) url = "data:" + (part.source.media_type || "image/png") + ";base64," + part.source.data;
      const mm = typeof url === "string" ? /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(url) : null;
      if (mm) {
        n++;
        const ext = mm[1].toLowerCase() === "jpeg" ? "jpg" : mm[1].toLowerCase();
        const mimeStr = ext === "jpg" ? "image/jpeg" : "image/" + ext;
        try {
          const dir = join(process.cwd(), ".tmp-upload");
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          let h = 5381; for (let i = 0; i < mm[2].length; i++) h = ((h << 5) + h + mm[2].charCodeAt(i)) >>> 0;
          const f = join(dir, "mcp-" + h.toString(36) + "." + ext);
          if (!existsSync(f)) writeFileSync(f, Buffer.from(mm[2], "base64"));
          nc.push({ type: "text", text: `Normalized copy (read-only): "${f.replace(/\\/g, "\\\\")}" (${mimeStr}).\n` });
        } catch { nc.push(part); }
      } else nc.push(part);
    }
    m.content = nc;
  }
  return n;
}

function extractImagePaths(text) {
  const out = [];
  const re = /Normalized copy \(read-only[^:]*\):\s*"([^"]+)"\s*\([^)]*?(image\/[a-z]+)\)/g;
  let m;
  while ((m = re.exec(text))) {
    const src = m[1].replace(/\\\\/g, "\\");
    const mime = m[2];
    const ext = mime === "image/jpeg" ? ".jpg" : mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : mime === "image/gif" ? ".gif" : ".png";
    out.push({ src, ext });
  }
  // Fallback: khong co mime -> mac dinh .png
  if (!out.length) {
    const re2 = /Normalized copy \(read-only[^:]*\):\s*"([^"]+)"/g;
    let m2;
    while ((m2 = re2.exec(text))) out.push({ src: m2[1].replace(/\\\\/g, "\\"), ext: ".png" });
  }
  return out;
}

function stripImageRefs(text) {
  return text
    .replace(/Image "[^"]+" \(sha256:[^)]+\)[\s\S]*?before editing\.\s*/g, "")
    .replace(/Normalized copy \(read-only[^:]*\):\s*"[^"]+"\s*\([^)]+\)\.[^\n]*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function sendPrompt(text, S) {
  await waitIdle();
  const preAlive = await ev(`(() => { const ta = document.querySelector(${JSON.stringify(SEL_INPUT)}); const stop = !!document.querySelector('[aria-label="Stop"]'); return !!ta && !ta.disabled && !stop; })()`).catch(() => true);
  if (!preAlive) {
    log("WEB TE san truoc khi gui -> F5 cung tab");
    await send("Page.reload");
    if (await waitSel(SEL_INPUT, 30_000)) { await sleep(2500); await waitIdle(); }
  }
  if (!(await ev("!!(window.__zaiLog && window.__zaiHookV5)").catch(() => false))) {
    log("HOOK cu hoac mat -> reload trang inject lai");
    await ev("location.reload()");
    if (!(await waitSel(SEL_INPUT, 30_000))) throw new Error("khong thay o nhap sau reload hook");
    await sleep(2500);
    await waitIdle();
  }
  // [FIX] siteErr bi bo — loi cu trong lich su khong duoc phep lam navigate/reload.
  const siteErr = false;
  let before = await ev("window.__zaiLog.length");
  const sentOk = () => ev(`(() => { const L = window.__zaiLog || []; for (let j = ${before}; j < L.length; j++) { const u = String(L[j].url || ""); if (/completion/i.test(u) || u.includes("/chats/")) return true; } return false; })()`).catch(() => false);
  const hasCaptcha = () => ev(`!!document.querySelector('iframe[src*="captcha"]')`).catch(() => false);
  const focus = () => ev(`(() => {
    const el = document.querySelector(${JSON.stringify(SEL_INPUT)});
    if (!el || !el.offsetParent) return false;
    el.scrollIntoView({ block: "center" }); el.focus(); el.click();
    return true;
  })()`);
  const inLen = () => ev(`(() => { const el = document.querySelector(${JSON.stringify(SEL_INPUT)}); return el ? (el.value || el.innerText || "").length : 0; })()`).catch(() => 0);
  const clearInput = async () => {
    await focus();
    await ev(`(() => { const el = document.querySelector(${JSON.stringify(SEL_INPUT)}); if (el) { el.focus(); try { document.execCommand("selectAll", false, null); document.execCommand("delete", false, null); } catch (e) {} } })()`).catch(() => {});
    const del = { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 };
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...del });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...del });
    await sleep(300);
  };
  const enter = async () => {
    const k = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...k });
    await send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...k });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
  };
  const trySend = async () => {
    await clearInput();
    if (!(await focus())) throw new Error("khong tim thay #chat-input");
        const imgPaths = VISION ? extractImagePaths(text) : [];
    if (imgPaths.length) {
      log("IMG: phat hien " + imgPaths.length + " anh -> upload");
      const up = await uploadImagesViaCDP(imgPaths);
      log("IMG: upload OK " + up + "/" + imgPaths.length);
      await sleep(2000);
    }
    const cleanText = imgPaths.length ? stripImageRefs(text) : text;
    log("RAW  len=" + text.length + " head=" + JSON.stringify(text.slice(0, 150)));
    log("CLEAN len=" + cleanText.length + " head=" + JSON.stringify(cleanText.slice(0, 150)));
    await send("Input.insertText", { text: cleanText });
    await sleep(700);
    const len1 = await inLen();
    await enter();
    for (let i = 0; i < 20; i++) { await sleep(250); if (await sentOk()) return { ok: true, len: len1 }; }
    if (await hasCaptcha()) {
      log("CAPTCHA chan gui — giai BANG TAY trong cua so Chrome (cho toi 120s)");
      for (let i = 0; i < 480; i++) { await sleep(250); if (await sentOk()) return { ok: true, len: len1 }; if (!(await hasCaptcha())) break; }
    }
    log("Enter chua gui -> Enter lan 2");
    await enter();
    for (let i = 0; i < 16; i++) { await sleep(250); if (await sentOk()) return { ok: true, len: len1 }; }
    log("Enter van chua gui -> click nut submit");
    await ev(`(() => {
      const btns = [...document.querySelectorAll("form button")].filter(b => !b.disabled);
      const b = btns.find(b => /send|submit|gui/i.test(b.getAttribute("aria-label") || ""))
            || btns.find(b => b.type === "submit")
            || btns.pop();
      if (b) { b.dispatchEvent(new MouseEvent("mousedown",{bubbles:true})); b.dispatchEvent(new MouseEvent("mouseup",{bubbles:true})); b.click(); }
    })()`);
    for (let i = 0; i < 24; i++) { await sleep(250); if (await sentOk()) return { ok: true, len: len1 }; }
    return { ok: false, len: len1 };
  };
  let r = await trySend();
  if (!r.ok) {
    log("GUI THAT BAI -> reload trang va go lai 1 lan");
    await ev("location.reload()");
    if (!(await waitSel(SEL_INPUT, 30_000))) throw new Error("khong thay o nhap sau reload");
    await sleep(2500);
    await waitIdle();
    before = await ev("window.__zaiLog.length");
    r = await trySend();
  }
  if (r.ok) return before;
  log("GUI LOI — VAN GIU CHAT, khong tao chat moi");
  const urls = await ev(`(window.__zaiLog || []).map(x => String(x.url || "")).join("\\n")`).catch(() => "");
  const html = await ev(`(() => (document.querySelector("form")?.outerHTML || "").slice(0, 20000))()`).catch(() => null);
  try { writeFileSync(DUMP, `input_len=${r.len}\n--- POST URLs da bat ---\n${urls}\n--- form ---\n` + html); } catch {}
  throw new Error("KHONG gay duoc request (input_len=" + r.len + ") — xem zai-last.txt");
}


function pickChunk(j) {
  if (!j || typeof j !== "object") return null;
  const d = (j.type === "chat:completion" && j.data) ? j.data : (j.data ?? j);
  return {
    type: j.type ?? null, phase: d.phase || null,
    content: typeof d.delta_content === "string" ? d.delta_content
           : (txt(d.content) || txt(d.delta?.content) || txt(d.text) || ""),
  };
}
const stripSiteTools = t => String(t || "")
  .replace(/<divinjeff>[\s\S]*?<\/divinjeff>/gi, "")
  .replace(/\n{3,}/g, "\n\n");

const protoBlock = tools => {
  const list = tools.map(t => { const f = t.function ?? t;
    const props = f.parameters?.properties ? Object.keys(f.parameters.properties).join(",") : "";
    return `${f.name}(${props})`; }).join(" ");
  const visTool = tools.map(t => (t.function ?? t).name).find(n => /analyze_image/i.test(String(n)));
  const visHint = visTool ? `
ANH: can biet noi dung mot file anh (user dan kem, read_image tra ve, screenshot, diagram) -> goi ${visTool}: file_path = duong dan trong dong 'Normalized copy (read-only): "..."' trong tin nhan (file khong co duoi van OK), question = dieu can hoi cu the. Tool mat 20-90s, tra ve mo ta that. Khong bao gio tu bia noi dung anh khi chua goi tool.` : "";
  return `[HARNESS] Khong co native function calling. Goi tool = in dung block:
<TOOLCALL>{"name":"TenTool","arguments":{...}}</TOOLCALL>
Moi tool mot block rieng. Tag phai dung CHINH TA: <TOOLCALL> va </TOOLCALL>.
NHIEU thao tac doc lap (nhieu WebFetch/Read/Glob/Grep cung luc) -> in TAT CA cac block TOOLCALL trong CUNG MOT luot de chay song song.
Dung viet tiep sau block cuoi, cho ket qua quay ve. Khong can tool -> tra loi thuan, khong in block.
TAUYET DOI: khong viet command trong code fence, khong gia ket qua, khong noi "da lam" khi chua in block.
Co 55+ SKILL san co (doc danh sach trong SYSTEM phia tren): viec khop skill nao thi goi Skill("ten-skill", args) truoc khi tu lam thu cong.${visHint}
TOOLS: ${list}`;
};
function extractCalls(text) {
  const calls = [];
  const parts = String(text).split(/<TOOLCALL[^>]*>/i).slice(1);
  for (const part of parts) {
    let depth = 0, start = -1, end = -1, inStr = false, esc = false;
    for (let i = 0; i < part.length; i++) {
      const c = part[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") { if (!depth) start = i; depth++; }
      else if (c === "}") { depth--; if (!depth) { end = i; break; } }
    }
    if (start < 0 || end < 0) continue;
    let j; try { j = JSON.parse(part.slice(start, end + 1)); } catch { continue; }
    const name = j?.name || j?.tool; if (!name) continue;
    let args = j.arguments ?? j.args ?? j.parameters ?? j.input ?? null;
    if (args !== null && typeof args !== "object" && typeof args !== "string") args = null;
    if (!args || (typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 0)) {
      const rest = { ...j };
      delete rest.name; delete rest.tool; delete rest.arguments; delete rest.args;
      delete rest.parameters; delete rest.input;
      if (Object.keys(rest).length) args = rest;
    }
    calls.push({ id: "call_" + Math.random().toString(36).slice(2, 9), type: "function",
      function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) } });
  }
  if (!calls.length) {
    const chunkRe = /\b(Read|Write|Edit|Bash|Glob|Grep|WebFetch|Skill|Agent|TodoWrite|TaskOutput)((?:\s*[A-Za-z_]+="(?:[^"\\]|\\.)*")+)/g;
    let mm;
    while ((mm = chunkRe.exec(String(text)))) {
      const args = {};
      const kvRe = /([A-Za-z_]+)\s*=\s*"((?:[^"\\]|\\.)*)"/g; let kv;
      while ((kv = kvRe.exec(mm[2]))) args[kv[1]] = kv[2].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      if (Object.keys(args).length) calls.push({ id: "call_" + Math.random().toString(36).slice(2, 9), type: "function",
        function: { name: mm[1], arguments: JSON.stringify(args) } });
    }
  }

    // TANG 2b: Write/Edit dang text — file_path=... content="...nhieu dong..."
  if (!calls.length) {
    const wRe = /\b(Write|Edit|Read)\s*file_path\s*=\s*"((?:[^"\\]|\\.)*)"\s*,?\s*(?:\n|$)/i;
    const wm = String(text).match(wRe);
    if (wm) {
      const args2 = { file_path: wm[2] };
      const cm = String(text).match(/content\s*=\s*"([\s\S]*?)"\s*\}?\s*(?:\n\s*["']?\}|\n|$)/);
      if (cm) args2.content = cm[1];
      const om = String(text).match(/old_string\s*=\s*"([\s\S]*?)"\s*,\s*new_string\s*=\s*"([\s\S]*?)"/);
      if (om) { args2.old_string = om[1]; args2.new_string = om[2]; }
      if (Object.keys(args2).length > 1) calls.push({ id: "call_" + Math.random().toString(36).slice(2, 9), type: "function",
        function: { name: wm[1], arguments: JSON.stringify(args2) } });
    }
  }
  // TANG 2c: Bash］(arguments: command="..." description="...") — bracket fullwidth, khong name=
  if (!calls.length) {
    const bRe = /Bash[）)］]\s*(?:［\[\s]*)?arguments?\s*:?\s*command\s*=\s*"((?:[^"\\]|\\.)*)"(\s*description\s*=\s*"((?:[^"\\]|\\.)*)")?/i;
    const bm = String(text).match(bRe);
    if (bm) {
      const args3 = { command: bm[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') };
      if (bm[3]) args3.description = bm[3];
      calls.push({ id: "call_" + Math.random().toString(36).slice(2, 9), type: "function",
        function: { name: "Bash", arguments: JSON.stringify(args3) } });
    }
  }
   // TANG 3: JSON tran {"name":...,"arguments":{...}} — tag TOOLCALL mo bi mang (TOOLCALL> khong co <)
  if (!calls.length || String(text).match(/TOOLCALL>[^{]/)) {
    const s3 = String(text);
    const jsonRe = /"name"\s*:\s*"([A-Za-z_][\w]*)"\s*,\s*"arguments"\s*:\s*\{/g;
    let jm; const seen = new Set();
    while ((jm = jsonRe.exec(s3))) {
      let start = -1;
      for (let k2 = jm.index; k2 >= 0 && k2 > jm.index - 40; k2--) { if (s3[k2] === "{") { start = k2; break; } }
      if (start < 0) continue;
      let depth = 0, end = -1, inStr = false, esc = false;
      for (let i2 = start; i2 < s3.length; i2++) {
        const c2 = s3[i2];
        if (esc) { esc = false; continue; }
        if (c2 === "\\") { esc = true; continue; }
        if (c2 === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c2 === "{") depth++;
        else if (c2 === "}") { depth--; if (!depth) { end = i2; break; } }
      }
      if (end < 0) continue;
      const raw = s3.slice(start, end + 1);
      if (seen.has(raw)) continue; seen.add(raw);
      try {
        let j2;
        try { j2 = JSON.parse(raw); }
        catch {
          try { j2 = JSON.parse(raw.replace(/\\(?!["\\\/bfnrtu])/g, "\\\\")); }
          catch {
            // dang 3: quote long khong escape — boc thu cong tung key
            const nmM = raw.match(/"name"\s*:\s*"([^"]+)"/);
            const cmdM = raw.match(/"command"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"|}\s*$)/);
            const descM = raw.match(/"description"\s*:\s*"([\s\S]*?)"\s*\}/);
            if (nmM) {
              const ag = {};
              const grab = (key, stop) => {
                const m2 = raw.match(new RegExp('"' + key + '"\\s*:\\s*"([\\s\\S]*?)"' + (stop ? '\\s*,\\s*"' + stop + '"' : '\\s*\\}'), ''));
                return m2 ? m2[1] : null;
              };
              const fpM = grab("file_path", "content");
              const ctM = fpM ? grab("content", null) : null;
              if (fpM && ctM !== null) { ag.file_path = fpM; ag.content = ctM; }
              else if (cmdM) { ag.command = cmdM; if (descM) ag.description = descM[1]; }
              if (Object.keys(ag).length) j2 = { name: nmM[1], arguments: ag };
            }
          }
        }
        const nm = j2?.name || j2?.tool; if (!nm) continue;
        let ag = j2.arguments ?? j2.args ?? {};
        calls.push({ id: "call_" + Math.random().toString(36).slice(2, 9), type: "function",
          function: { name: nm, arguments: typeof ag === "string" ? ag : JSON.stringify(ag ?? {}) } });
      } catch {}
    }
  }
  // TANG 3b: ':read","arguments":{...' — model bo luon '{"name":"'
  if (!calls.length) {
    const s3b = String(text);
    const re3b = /:([A-Za-z_][\w]*)"\s*,\s*"arguments"\s*:\s*\{/g;
    let m3b; const seen3b = new Set();
    while ((m3b = re3b.exec(s3b))) {
      const name = m3b[1];
      const braceStart = s3b.indexOf("{", m3b.index + m3b[0].length - 1);
      if (braceStart < 0) continue;
      let depth = 0, end = -1, inStr = false, esc = false;
      for (let i = braceStart; i < s3b.length; i++) {
        const c = s3b[i];
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (!depth) { end = i; break; } }
      }
      if (end < 0) continue;
      const raw = s3b.slice(braceStart, end + 1);
      if (seen3b.has(raw)) continue; seen3b.add(raw);
      try {
        let j2;
        try { j2 = JSON.parse(raw); }
        catch { j2 = JSON.parse(raw.replace(/\\(?!["\\\/bfnrtu])/g, "\\\\")); }
        calls.push({ id: "call_" + Math.random().toString(36).slice(2, 9), type: "function",
          function: { name, arguments: JSON.stringify(j2) } });
      } catch {}
    }
  }
  let clean = String(text).split(/<TOOLCALL[^>]*>/i)[0].trim();
  clean = clean
    .replace(/\b(Read|Write|Edit|Bash|Glob|Grep|WebFetch|Skill|Agent|TaskOutput|TodoWrite)\s*file_path[^\n]*/gi, "")
    .replace(/<parameter[^>]*>[\s\S]*?(<\/parameter>|$)/gi, "")
    .replace(/<\/?(TOOLCALL|DoOLCALLTYPE)[^>]*>/gi, "")
    .replace(/[_A-Za-z]*OOLCALL>?/g, "")
    .replace(/\{\{?"name"\s*:[^}]*$/gim, "")
    .replace(/TOOLCALL>?\s*\{[\s\S]*?\}\s*(<\/?TOOLCALL>?|TOOLCALL>?)?/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { calls, clean };
}

function renderNew(messages, tools, S) {
  let fresh = messages.slice(S.sent).filter(m => m.role === "user" || m.role === "tool");
  if (S.replayCut) {   // chi active request dau sau restart — roi tu tay
    const lastReal = [...messages].reverse().find(m => m.role === "user" && !NOISE_START.test(normTask(txt(m.content))) && txt(m.content).trim());
    if (lastReal) fresh = [lastReal];
    S.replayCut = false;
  }



  if (!fresh.length) {
    const lastU = [...messages].reverse().find(m => m.role === "user");
    if (!lastU || !txt(lastU.content)) return null;
    fresh = [lastU];
  }
  if (fresh.length > 50) {
    log("BOOT GON: " + fresh.length + " tin -> 50 tin cuoi (chat web la bo nho, khong can lai lich su)");
    fresh = fresh.slice(-50);
  }
  const parts = [];
  let cauUserCuoi = "";

  for (const m of fresh) {
    if (m.role === "tool") {
      const nm = S.callMap[m.tool_call_id] || m.tool_call_id || "";
      parts.push(`[ket qua tool ${nm}]\n${txt(m.content)}`);
      continue;
    }

    const c = txt(m.content);
    if (!c) continue;

    if (m.role === "user") {
      // Env/time/context/checkpoint = metadata cua DSH. Nguoi that khong go cai nay vao chat.
      if (NOISE_START.test(c)) continue;
      cauUserCuoi = c;
      continue;
    }

    parts.push(`[${m.role}]\n${c}`);
  }

  let t = parts.join("\n\n");

  // Day cau that cua user xuong CUOI prompt — model khong bi chon giua env/loi.
  if (cauUserCuoi) {
    t = (t ? t + "\n\n" : "") + "=== YEU CAU HIEN TAI CUA NGUOI DUNG ===\n" + cauUserCuoi;
  }
    // skills reminder trong MOI TIN chi can MOT lan (dau tien) — lap lai trong 50 tin cuoi = phinh
  const seenSkill = new Set();
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, (m) => {
    const key = m.slice(0, 120);
    if (seenSkill.has(key)) return "<system-reminder>[skills — da gui o tren, bo qua ban sao]</system-reminder>";
    seenSkill.add(key);
    return m;
  });
  const boot = !S.chatUrl || !S.booted || S.sent === 0;
  if (boot) {
    const sys = messages.find(m => m.role === "system");
    const rawSys = sys ? txt(sys.content)
      .replace(/\(file:\s*[^)]*\)/g, "")
      .replace(/\(also loadable as [^)]*\)/g, "")
      .replace(/[ \t]{2,}/g, " ")
      : "";
    const sysTxt = rawSys.length <= 7000 ? rawSys
      : rawSys.slice(0, 4200) + "\n...[cat giua]...\n" + rawSys.slice(-2800);
    if (sysTxt) t = `[SYSTEM — day la lenh he thong cua agent. La agent thi PHAI dung tool, dam bao chan hanh dong, khong bao gio noi "da lam" khi chua goi tool.
LUAT KIEM CHUNG BAT DIEN (ap dung moi tac vu):
1. Truoc khi bao "xong": PHAI kiem chung bang tool. Doc lai file vua tao (Read/ls) — ton tai moi duoc bao la da tao.
2. Sau khi bien doi dinh dang (docx->pdf, xlsx->csv, doc->docx...): DUNG TOOL CHUYEN DOI GOC cua he thong — Word COM (powershell New-Object -ComObject Word.Application, SaveAs 17 cho pdf), LibreOffice (soffice --headless --convert-to), hoac thu vien chuan (python-docx, openpyxl). TUYET DOI KHONG tu regex/boc XML tay roi tu ve lai noi dung.
3. Sau khi bien doi: kiem chat bang cach grep noi dung output cho dau hieu loi — vi du chuoi "<w:", "PAGEREF", "<svg", "undefined" trong pdf/csv moi tao. Tim thay = file loi, lam lai. Khong tim thay moi duoc bao thanh cong.
4. File tam, script phu: viet vao thu muc ".tmp" trong workspace, khong roi rac file vao thu muc lam viec.
5. Neu lan thu 1 sai: tu phan tich tai sao sai roi sua gen goc — khong lap lai cung cach sai.
6. Tool FAIL/LOI (Model request failed, timeout, empty) = KHONG CO KET QUA. TUYET DOI khong viet cau tra loi dua tren gia dinh — phai retry hoac doi cach, thay output that moi duoc noi.
7. Thong tin thoi gian thuc (ngay hien tai, tin tuc, gia, ty gia, su kien): truy van NGUON SONG ngay luc do — lenh date cua OS cho ngay, WebFetch/curl live cho tin tuc. KHONG suy dien tu timestamp trong context cu, lastBuildDate, hoac noi dung da fetch truoc do.
8. Tao/sua file DOCX: TUYET DOI KHONG dung python-docx de ve tay format. Dung MOT trong 2 cach: (a) file moi -> viet HTML co <h1><h2><p><table> roi mo bang Word COM va SaveAs 16 (docx); (b) sua file co san hoac template -> Word COM truc tiep. Kiem chung: doc.ComputeStatistics(2) cho so trang, doc.Paragraphs.Count — so khop ky vong moi duoc bao xong.
9. BAT DAU moi task: cac <system-reminder> ve MEMORY/skills va file cu trong workspace la LICH SU cua nguoi dung — KHONG tuong tuong chung la viec hien tai. Chi lam dung yeu cau moi nhat cua nguoi dung, khong survey workspace khong duoc yeu cau, khong ke lai thanh qua cu, khong hoi lai neu yeu cau da ro.
]\n${sysTxt}\n\n` + t;
    if (TOOLS && Array.isArray(tools) && tools.length) t = protoBlock(tools) + "\n\n" + t;
    S.booted = true;
  } else if (TOOLS) {
    t = `[HARNESS] Nho: la agent, ban CO tool. Muon hanh dong thi in <TOOLCALL>{"name":"TenTool","arguments":{...}}</TOOLCALL>. Khong viet command bang text, khong gia ket qua, khong noi "da lam". Bao "xong" chi khi da Read/ls kiem chung file that; bien doi dinh dang thi dung tool goc (Word COM/LibreOffice), khong boc XML tay; kiem output khong chua "<w:"/"PAGEREF" truoc khi bao thanh cong. Tool loi = chua co ket qua, retry thay that moi tra loi. Ngay/tin tuc: query song (date, WebFetch live), khong dung context cu. Nhieu thao tac doc lap -> in nhieu block TOOLCALL cung luot (song song). Tao DOCX: viet HTML roi Word COM SaveAs 16, khong python-docx tay. File tam vao .tmp. Memory/skills reminder va file cu = lich su, chi lam yeu cau moi nhat, khong ke chuyen cu khong duoc hoi.\n\n` + t;
  }
  let head = "";
  const HEAD_RE = /^(\[SYSTEM[^\]]*\][\s\S]*?)(\[HARNESS\])/;
  const hm = HEAD_RE.exec(t);
  if (hm) { head = hm[1]; t = t.slice(hm[1].length); }
    if (t.length > MAXCH) {
    const lines = t.split("\n");
    const out = []; let len = 0;
    const perHead = 4000;
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li];
      if (len + L.length + 1 > MAXCH - 2000) {
        const rest = lines.length - li;
        if (rest > 30) { out.push("...[cat " + rest + " dong giua — dung Read offset de lay]" ); break; }
        out.push(L); len += L.length + 1;
      } else { out.push(L); len += L.length + 1; }
    }
    t = out.join("\n");
  }
  return t;
}

async function proxyToApi(req, res, body) {
  try {
    const up = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ ...body, model: API_MODEL }),
    });
    if (res.headersSent || res.destroyed || res.writableEnded) return;
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") || "application/json" });
    if (up.body) {
      const { Readable } = await import("node:stream");
      const { pipeline } = await import("node:stream/promises");
      await pipeline(Readable.fromWeb(up.body), res);
    } else res.end(await up.text());
  } catch (e) {
    log("SUB loi (client dong?) — an loi, khong chet:", String(e.message).slice(0, 80));
    if (!res.headersSent) { try { res.writeHead(502, { "content-type": "application/json" }); } catch {} }
    try { res.end(JSON.stringify({ error: { message: "subagent upstream loi: " + String(e.message).slice(0, 120) } })); } catch {}
  }
}

let queue = Promise.resolve();
const mutex = fn => { const r = queue.then(fn, fn); queue = r.catch(() => {}); return r; };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const J = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  try {
    if (url.pathname === "/__raw") { const n = await ev("window.__zaiLog.length"); const r = n ? await recAt(n - 1) : null; if (r) r.raw = r.chunks.join(""); return J(200, r); }
    if (url.pathname === "/__sessions") return J(200, [...sessions.entries()].map(([k, S]) => ({ k, chatUrl: S.chatUrl, sent: S.sent, mem: !!S.mem, firstUser: (S.firstUser || "").slice(0, 100) })));
    if (url.pathname === "/__reset") { sessions.clear(); lastMain = null; saveSessions(); return J(200, { ok: true }); }
    if (url.pathname === "/__model") { const seen = await ev("(window.__zaiModels || []).slice(-8)").catch(() => []); return J(200, { force_hien_tai: FORCE_MODEL || "(khong ep)", da_bat: seen }); }
    if (url.pathname.endsWith("/models")) return J(200, { object: "list", data: [{ id: "glm-5.3", object: "model" }] });
    if (!url.pathname.endsWith("/chat/completions")) return J(404, { error: { message: "no route " + url.pathname } });

    const body = JSON.parse(await new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c).toString())); }) || "{}");
    const model = String(body.model ?? "glm-5.3");
    const msgs  = body.messages ?? [];
    try { writeFileSync("D:\\Zai\\ZaiApi\\debug-body.json", JSON.stringify(body, null, 2)); } catch {}
    try {
      const last = msgs[msgs.length - 1];
      if (last && Array.isArray(last.content)) {
        const types = last.content.map(c => c.type || "text").join(",");
        log("LAST MSG types:", types, "| len:", JSON.stringify(last.content).length);
        if (last.content.some(c => c.type === "image" || c.type === "image_url")) {
          const img = last.content.find(c => c.type === "image" || c.type === "image_url");
          const src = img?.source?.data || img?.image_url?.url || "";
          log("IMAGE detected, mime:", img?.source?.media_type || "?", "| base64 len:", src.length);
        }
      }
    } catch (e) { log("log img err", String(e.message)); }
    // log("DSH TOOLS:", (body.tools || []).map(t => t.function?.name || t.name).join(",") || "(none)");
    if (API_KEY && isSub(msgs)) { log("SUB -> api.z.ai " + API_MODEL); return proxyToApi(req, res, body); }
    const S = getSess(msgs);
    if (!S.mem) {
      const fuSync = firstTaskText(msgs);
      if (fuSync) syncTaskToDSH(taskKey(fuSync), fuSync).catch(() => {});
    }
    if (msgs.length < S.sent) { S.sent = msgs.length; log("COMPACT — giu nguyen chat web"); }
    if (!S.mem) {
      S.seenMsgs = S.seenMsgs || new Set();
      if (S.seenMsgs.size > 500) S.seenMsgs.clear();
      for (const m of msgs) if (m.role === "user") {
        const nt = normTask(txt(m.content));
        if (nt.trim().length > 40) S.seenMsgs.add(hashTxt(nt));   // tin pure-reminder hash rong — bo, no la ngon ngu chung cua moi task
      }
    }

    if (S.mem && S.sent > 12) { S.chatUrl = null; S.sent = 0; log("RESET memory thread"); }

        // REPLAY-SAUC-RESTART (loi m): DSH tu gui lai ca tram nghin dong khi bridge moi len.
    // Chi request DAU sau restart (S.sent===0 + >3 tin moi) — cat chi gui tin user cuoi.
    // Dat DAY (sau getSess) — hash/taskKey khong bi doi, sticky khong gay.
    if (!S.mem && !S.chatUrlSentMark && S.sent === 0 && msgs.length > 3) {
      const lastReal = [...msgs].reverse().find(m => m.role === "user" && !NOISE_START.test(normTask(txt(m.content))) && txt(m.content).trim());
      if (lastReal) {
        const pos = msgs.indexOf(lastReal);
        if (pos >= 0 && msgs.slice(0, pos + 1).filter(m => m.role === "user" || m.role === "tool").length > 3) {
          log("REPLAY-CAT: " + msgs.length + " tin tu DSH sau restart -> chi gui tin cuoi (chan dom 23k)");
          S.replayCut = true;
        }
      }
    }

    const prompt = renderNew(msgs, body.tools, S);
    if (prompt === null) return J(400, { error: { message: "khong co tin moi" } });
    if (!prompt.trim()) return J(400, { error: { message: "empty prompt" } });

    log("XEP HANG — cho request truoc xong");
    await mutex(async () => {
      let idx = 0;   // scope cho bestRec — ERR "idx is not defined" 08:05
      log(">>> REQUEST MOI —", msgs.length, "tin | task:", (S.firstUser || "").slice(0, 60).replace(/\s+/g, " "));
      await openChat(S);
      let promptNow = prompt;
      if (!S.chatUrl && S.sent > 0) {
        S.sent = 0; S.booted = false;
        promptNow = renderNew(msgs, body.tools, S);
        log("chat moi giua chung — bootstrap lai toan bo context");
      }
      const before = S.sent;
      S.sent = msgs.length;

      const rid = "chatcmpl-" + Math.random().toString(36).slice(2);
      const head = { id: rid, object: "chat.completion.chunk", model, created: Math.floor(Date.now() / 1000) };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
      res.write(`data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`);

      let ans = "", think = "", st = 0, ct = "", via = "?", full = "", types = {};
      const t0 = Date.now();

      for (let attempt = 0; attempt < 1; attempt++) {   // 1 request = 1 lan gui — doc hong thi bao loi, khong gui lai
      idx = await sendPrompt(promptNow, S);
      grabChatId(S, idx).catch(() => {});   // truyen idx de doc tu API response
        // F5 30s VO DIEU KIEN sau khi gui prompt (loi m) — nhu tay nguoi nhan F5.
        // Dung chi khi SERVER (messages/batch) tra duoc answer moi that — byte SSE khong tin vi webchat van nghen.
        const tLoop = Date.now();
        const chatIdSrv0 = () => S.chatUrl ? (S.chatUrl.match(/\/c\/([0-9a-f-]{16,})/i) || [])[1] : null;
        let f5Count = 0;
        let serverAns = "";
        const enterL = async () => {   // scope DAY — khong phai cua watch cu da xoa
          const k = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
          await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...k });
          await send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...k });
          await send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
        };
        const inputLenL = () => ev(`(() => { const el = document.querySelector(${JSON.stringify(SEL_INPUT)}); return el ? (el.value || el.innerText || "").length : 0; })()`).catch(() => 0);
        while (Date.now() - tLoop < TIMEOUT) {
          await sleep(20000);   // loi m: poll 20s/lan — 3s la spam z.ai
          const cid = chatIdSrv0();
          if (cid) {
            const srv = await serverAnswer(cid);
            if (srv.trim()) { serverAns = srv; log("[SERVER] answer ve sau F5 — " + srv.length + " ky tu"); break; }
          }
          if (Date.now() - tLoop >= (f5Count + 1) * 30000) {
            f5Count++;
            log("[F5] " + f5Count * 30 + "s sau prompt — cap nhat trang (vo dieu kien, loi m)");
            await send("Page.reload").catch(() => {});
            await sleep(4500);
            for (let i = 0; i < 30; i++) { if (await ev('!!document.querySelector("#chat-input")').catch(() => false)) break; await sleep(500); }
            const inL = await inputLenL();
            if (inL > 0) {
              log("[GUI-LAI] input con " + inL + " ky tu -> Enter lai");
              await sleep(2000); await enterL(); await sleep(2000);
              if ((await inputLenL()) > 0) { log("[GUI-LAI] Enter lan 2"); await sleep(2000); await enterL(); await sleep(2000); }
            }
          }
        }
        ans = serverAns;
        full = "";
      }   // dong vong for (attempt) — 1 request = 1 lan gui
      await grabChatId(S, idx);

   let ansSrc = ans.trim() ? "SSE" : "";
   const chatIdSrv = S.chatUrl ? (S.chatUrl.match(/\/c\/([0-9a-f-]{16,})/i)?.[1] || null) : null;

   // NEU SSE RONG -> DOC SERVER. KHONG BAO GIO DOC MAN HINH DE LAM ANSWER.
   if (!ans.trim() && chatIdSrv) {
     const srv = await serverAnswer(chatIdSrv);
     if (srv.trim()) {
       ans = srv;
       ansSrc = "SERVER";
       log("[SERVER] answer tu messages/batch — " + ans.length + " ky tu");
     }
   }

   // VAN RONG -> DOI 3s DOC SERVER LAN 2.
   if (!ans.trim() && chatIdSrv) {
     await sleep(3000);
     const srv2 = await serverAnswer(chatIdSrv);
     if (srv2.trim()) {
       ans = srv2;
       ansSrc = "SERVER-2";
       log("[SERVER-2] answer tu messages/batch — " + ans.length + " ky tu");
     }
   }

   try {
     writeFileSync(DUMP, `src=${ansSrc || "EMPTY"} status=${st} ct=${ct} via=${via} session=${S.chatUrl}\n--- types ---\n${JSON.stringify(types,null,2)}\n--- ans ---\n${ans}\n--- raw ---\n${full}`);
   } catch {}
      const sent = (msg) => { for (let i = 0; i < msg.length; i += 400)
        res.write(`data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: { content: msg.slice(i, i + 400) } }] })}\n\n`); };

      if (!ans.trim()) {
        const hint = !st ? "khong bat duoc response"
          : st === 401 || st === 403 ? "cookie het han — login lai"
          : st === 429 ? "rate-limit — cho vai phut"
          : /WORKSPACE_TOOL_INIT|INTERNAL_ERROR|Internal Server Error/i.test(full) ? "Z.ai 500 phia tren — thu lai"
          : "khong co dong data: nao";

        sent(`[bridge] RONG. status=${st} ct="${ct}" | ${hint}\n--- cuoi ---\n${full.slice(-600) || "(empty)"}`);
        S.sent = before;
        log("EMPTY", "status=" + st, hint);
      } else {
        const { calls, clean } = TOOLS ? extractCalls(stripSiteTools(ans)) : { calls: [], clean: stripSiteTools(ans) };

        if (calls.length) {
          S.callMap = Object.fromEntries(calls.map(c => [c.id, c.function.name]));

          res.write(`data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: { tool_calls: calls } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);

          log("TOOL", calls.map(c => c.function.name).join(","), "| sess=" + (S.chatUrl ? "OK" : "MISS"));
          log("TOOL CHI TIET:", calls.map(c => {
            try {
              const a = JSON.parse(c.function.arguments);
              return c.function.name + "(" + Object.entries(a).map(([k, v]) => k + "=" + String(v).replace(/\s+/g, " ").slice(0, 60)).join(", ") + ")";
            } catch {
              return c.function.name + "(?)";
            }
          }).join(" || ").slice(0, 400));
        } else {
          sent(clean || ans);

          res.write(`data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);

          log("ANS", (clean || ans).length, "chars |", ((Date.now() - t0) / 1000).toFixed(1) + "s | sess=" + (S.chatUrl ? "OK" : "MISS"));
          log("NOI DUNG (250 ky tu dau):", (clean || ans).replace(/\s+/g, " ").slice(0, 250));
        }
      }
      // DA CO NOI DUNG -> RELOAD NGAY (loi m): don webchat khoi vung kẹt, lan sau khong nghen
      if (ans.trim()) {
        log("[F5-SAU-ANS] don trang cho lan sau");
        send("Page.reload").catch(() => {});
      }
      res.write("data: [DONE]\n\n"); res.end();
    });
  } catch (e) {
    log("ERR", e.message);
    if (!res.headersSent) J(502, { error: { message: String(e.message) } }); else res.end();
  }
}).listen(PORT, "127.0.0.1", () => log(`http://127.0.0.1:${PORT}/api/paas/v4/chat/completions  tools=${TOOLS}`));

await launch();
log("Chrome da mo. CHUA LOGIN -> login trong window DO.");