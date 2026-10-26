// bridge.mjs — chat.z.ai, STICKY SESSION + SUBAGENT ROUTE API
// Node >= 22. 0 dependency.
// [PATCH 2025-10-26 WEB MOI] 6 nhom sua:
//  (1) HOOK TAT AGENT CHI O completions: features.flags=[] + preview_mode=false
//      -> het MODEL_CONCURRENCY_LIMIT. chats/new GIU NGUYEN body site (v1 sua type/flags
//      -> server 400, da REVERT).
//  (2) Hook bump V5->V6 (tab mo san co hook cu khong chan hook moi).
//  (3) openChat: nut Home/New chat = #sidebar-new-chat-button (bo qua text "new chat").
//  (4) sendPrompt: nut gui = #send-message-button (bo btns.pop() click nham nut khac).
//  (5) FAIL-FAST net-err: SSE co data.error.code hoac chats/new >=400 -> dung ngay,
//      xoa session chat chet, bao loi ro cho DSH retry thay vi treo 600s.
//  (6) stripSiteTools + <glm_block>; serverAnswer doc content array cua block text.
//  (7) [v2.1] HOOK V6->V7: v1 va v2 cung dat flag __zaiHookV6 -> tab con hook v1 khong phat hien
//      duoc (v1 van rewrite chats/new -> 400). V7 = flag rieng; thieu V7 -> F5 lay trang sach.
//      + banner "=== BRIDGE v2.1-WEBMOI ===" luc khoi dong: khong thay dong nay = dang chay file cu.
//  (8) [v2.2] TOC DO + GIO: doc answer TRUC TIEP tu SSE stream hook da bat (web xong -> co ngay,
//      khoi cho poll server 20s); F5 giua chung CHI khi khong thay dang sinh (F5 vo dieu kien
//      moi 30s cua ban cu giet stream -> mat answer -> nghen 30-60s); serverAnswer fallback
//      20s->10s; F5-don-trang tu HUY neu request sau da den; log in gio LOCAL (ban cu UTC lech 7h).

import { createServer } from "node:http";
import { writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT    = Number(process.env.PORT ?? 8787);
const CDP     = Number(process.env.CDP ?? 9223);
const TOOLS   = (process.env.ZAI_TOOLS ?? "on") !== "off";
const VISION  = (process.env.ZAI_VISION ?? "") === "on";   // chi instance nay duoc upload anh
const MAXCH   = 30000;   // o nhap web nhan du — khong cat nua
const TIMEOUT = Number(process.env.ZAI_TIMEOUT ?? 600_000);
const PROFILE = process.env.ZAI_PROFILE ? join(process.env.ZAI_PROFILE) : join(homedir(), ".zai-bridge");
const DUMP    = join(process.cwd(), "zai-last.txt");
const CHROME  = process.env.CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const SEL_INPUT = "#chat-input";
const API_COMPLETIONS = "/v2/chat/completions";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = (...a) => { const d = new Date(), p = n => String(n).padStart(2, "0"); console.log(p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()), ...a); };   // [v2.2] gio LOCAL may (ban cu in UTC -> lech 7h voi VN)
const txt   = c => typeof c === "string" ? c : Array.isArray(c) ? c.map(x => x?.text ?? "").filter(Boolean).join("\n") : "";

const MEM_RE   = /memory extraction subagent/i;
const TITLE_RE = /Generate a concise title|title-generation task|Generate the session title|session title from this JSON|title from this JSON array|summari[sz]e.{0,30}session.{0,30}title/i;
const API_KEY   = (process.env.ZAI_API_KEY ?? "").trim();
const API_URL   = "https://api.z.ai/api/paas/v4/chat/completions";
const API_MODEL   = process.env.ZAI_MEM_MODEL ?? "glm-4.7-flash";
const FORCE_MODEL = process.env.ZAI_FORCE_MODEL ?? "glm-5.3";
const BUILD = "v2.2-WEBMOI (2025-10-26)";   // [PATCH v2.1] banner khoi dong — in ra de xac nhan file nao dang chay
let lastReqAt = 0;   // [v2.2] thoi diem request den — F5-don-trang check de khong reload dam vao request sau
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

const SESSIONS_FILE = join(process.cwd(), "zai-sessions.json");
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

const HOOK = `(() => {
  // [PATCH v2.1] bump V6 -> V7: v1 va v2 deu dat __zaiHookV6 -> khong phan biet duoc tab nao con hook v1
  //   (hook v1 rewrite ca chats/new -> 400). V7 = flag RIENG cua ban v2.1 tro len.
  //   Neu tab chi co hook v1 (V6) thi KHONG wrap chong len (v1 van nam duoi, van rewrite chats/new)
   //  -> de nguyen, sendPrompt thay thieu V7 se F5 lay trang sach roi hook V7 chuoi.
  if (window.__zaiHookV7) return;                         // ban nay da hook roi -> khong wrap lap
  if (window.__zaiHooked && window.__zaiHookV6) return;   // con hook v1 trong tab -> khong chong, cho F5
  window.__zaiHooked = true; window.__zaiHookV7 = true;
  window.__zaiLog = [];
  const mark = o => (window.__zaiLog.push(o), o);
  const FORCE_MODEL = ${JSON.stringify(FORCE_MODEL)};
  const rewriteBody = (url, body) => {
    if (typeof body !== "string") return body;
    if (!(url.includes(${JSON.stringify(API_COMPLETIONS)}) || url.includes("/chats/new"))) return body;
    try {
      const bd = JSON.parse(body);
      try {
        const caps = (bd.chat && bd.chat.models) || bd.models || (typeof bd.model === "string" ? [bd.model] : null);
        if (caps && caps.length) {
          const s = caps.join(",");
          const M = window.__zaiModels = window.__zaiModels || [];
          if (!M.length || M[M.length - 1].m !== s) M.push({ t: Date.now(), m: s });
        }
      } catch (e) {}
      if (FORCE_MODEL) {
        if (typeof bd.model === "string") bd.model = FORCE_MODEL;
        if (bd.chat && Array.isArray(bd.chat.models)) bd.chat.models = [FORCE_MODEL];
        if (bd.chat && bd.chat.history && bd.chat.history.messages)
          for (const mm of Object.values(bd.chat.history.messages))
            if (Array.isArray(mm.models)) mm.models = [FORCE_MODEL];
      }
      if (bd.chat && bd.chat.reasoning_effort) bd.chat.reasoning_effort = "max";
      if (bd.features && bd.features.reasoning_effort) bd.features.reasoning_effort = "max";
      // [PATCH v2 2025-10 WEB MOI] TAT AGENT CHI TANG /v2/chat/completions.
      // Ban v1 sua ca chats/new (type=default + xoa flags + loc features) -> server tra 400 (log 12:33).
      // => REVERT: chats/new GIU NGUYEN body site gui (chi FORCE_MODEL + reasoning max nhu ban goc,
      //    cach nay chay 200 tu truoc). Chat tao bang type gi khong quan trong — hanh vi sinh do
      //    completions quy dinh.
      // => completions: features.flags=[] (tat agent pipeline + site-tool glm_block)
      //    + preview_mode=false (roi khoi nhom x-preview-l gioi han -> het MODEL_CONCURRENCY_LIMIT).
      //    Dung body nay da test console thay SSE 200.
      try {
        if (url.includes(${JSON.stringify(API_COMPLETIONS)}) && bd.features) {
          if (Array.isArray(bd.features.flags)) bd.features.flags = [];
          if ("preview_mode" in bd.features) bd.features.preview_mode = false;
        }
      } catch (e) {}
      return JSON.stringify(bd);
    } catch (e) { return body; }
  };
  const tee = (rec, res) => {
    rec.status = res.status;
    try { rec.ct = res.headers.get("content-type") || ""; } catch (e) {}
    const [a, b] = [res.clone(), res];
    (async () => { try {
      if (!a.body) { rec.done = true; return; }
      const rd = a.body.getReader(), dec = new TextDecoder();
      for (;;) { const { done, value } = await rd.read(); if (done) break;
        rec.chunks.push(dec.decode(value, { stream: true })); }
      if (!rec.chunks.join("").includes("[DONE]")) rec.chunks.push("data: [DONE]\\n\\n");
      rec.done = true;
    } catch (e) { rec.error = String(e && e.message || e); rec.done = true; } })();
    return b;
  };
  const of = window.fetch;
  window.fetch = function (u, o) {
    const url = typeof u === "string" ? u : (u && u.url) || "";
    const method = String((o && o.method) || (u && u.method) || "GET").toUpperCase();
    if (method === "POST") {
      if (o && typeof o.body === "string") {
        const nb = rewriteBody(url, o.body);
        if (nb !== o.body) o = Object.assign({}, o, { body: nb });
      }
      const rec = mark({ t: Date.now(), via: "fetch", url, status: 0, ct: "", chunks: [], done: false, error: null });
      return of.call(this, u, o).then(r => tee(rec, r));
    }
return of.apply(this, arguments); }; const OES = window.EventSource; if (OES && !window.__esHooked) { window.__esHooked = true; const NES = function (u, cfg) { const rec = mark({ t: Date.now(), via: "es", url: String(u), status: 0, ct: "text/event-stream", chunks: [], done: false, error: null }); const es = new OES(u, cfg); es.addEventListener("open", function () { rec.status = 200; }); es.addEventListener("message", function (ev) { rec.chunks.push("data: " + ev.data + String.fromCharCode(10)); }); es.addEventListener("error", function () { if (es.readyState === 2) { rec.done = true; rec.chunks.push("data: [DONE]" + String.fromCharCode(10)); } }); return es; }; NES.prototype = OES.prototype; window.EventSource = NES; } const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; this.__m = m; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    const u = String(this.__u || "");
    if (String(this.__m || "GET").toUpperCase() === "POST") {
      const nb = rewriteBody(u, b);
      if (nb !== b) b = nb;
      const rec = mark({ t: Date.now(), via: "xhr", url: u, status: 0, ct: "", chunks: [], done: false, error: null });
      this.addEventListener("readystatechange", () => { try {
        if (this.readyState >= 2) { rec.status = this.status; try { rec.ct = this.getResponseHeader("content-type") || ""; } catch (e) {} }
        if (this.readyState >= 3) {
          const all = this.responseText || "", had = rec.chunks.join("").length;
          if (all.length > had) rec.chunks.push(all.slice(had));
        }
        if (this.readyState === 4) rec.done = true;
      } catch (e) { rec.error = String(e && e.message || e); rec.done = true; } });
    }
    return os.call(this, b);
  };
})();`;


let ws, mid = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++mid; pend.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
  const t = list.find(p => p.type === "page" && p.url.includes("chat.z.ai")) ?? list.find(p => p.type === "page");
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
  await send("Runtime.enable"); await send("Page.enable"); await send("DOM.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK, runImmediately: true });
  try { await send("Runtime.evaluate", { expression: HOOK }); } catch {}
}
async function launch() {
  if (!existsSync(PROFILE)) mkdirSync(PROFILE, { recursive: true });
  try { await fetch(`http://127.0.0.1:${CDP}/json/version`); log("CDP song — attach"); }
  catch {
    log("mo Chrome...");
    spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`,
      "--disable-features=CalculateNativeWinOcclusion", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-background-timer-throttling", "--no-first-run", "--no-default-browser-check", "https://chat.z.ai"],
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
        const ok = await ev(`!!document.querySelector(${JSON.stringify(SEL_INPUT)})`, true).catch(() => false);
        if (ok) break;
        await sleep(1000);
      }
      return ev(expression, true);
    }

    if (retried) throw e;
    log("WS chet that su (" + msg + ") -> relaunch Chrome (GIU profile, KHONG xoa login)");
    try { ws.close(); } catch {}
    const { execSync } = await import("node:child_process");
    try { execSync('powershell -NoProfile -Command "Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue"', { stdio: "ignore" }); } catch {}
    await sleep(2000);
    try {
      await Promise.race([
        launch(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("LAUNCH_TIMEOUT")), 45_000))
      ]);
    } catch (e2) { log("relaunch LOI:", String(e2.message || e2)); throw e; }
    log("==================================================");
    log("Chrome mo lai. LOGIN TAY trong cua so Chrome.");
    log("Login xong thi BAM ENTER trong terminal nay.");
    log("==================================================");
    await new Promise(res => process.stdin.once("data", () => res()));
    return ev(expression, true);
  }
  if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails.exception?.description || out.exceptionDetails).slice(0, 300));
  return out.result?.value;
}
const waitSel = async (sel, ms) => {
  for (let i = 0; i < ms / 300; i++) { if (await ev(`!!document.querySelector(${JSON.stringify(sel)})`)) return true; await sleep(300); }
  return false;
};

async function waitIdle(ms = 30_000) {
  let t0 = Date.now();
  let lastState = "";
  let lastReload = 0;
  for (;;) {
    const st = await ev(`(() => {
      const stop = !!document.querySelector('[aria-label="Stop"]');
      const ta = document.querySelector(${JSON.stringify(SEL_INPUT)});
      return { stop, ok: !!ta && !ta.disabled };
    })()`).catch(() => null);
    if (st && !st.stop && st.ok) return;
    if (Date.now() - t0 > ms) {
      await ev(`(() => { const b = document.querySelector('[aria-label="Stop"] button') || document.querySelector('[aria-label="Stop"]'); if (b) b.click(); })()`).catch(() => {});
      const t1 = Date.now();
      for (;;) {
        const busy = await ev(`!!document.querySelector('[aria-label="Stop"]')`).catch(() => true);
        if (!busy) return;
        if (Date.now() - t1 > 20_000) throw new Error("site khong rang sau khi bam Stop");
        await sleep(500);
      }
    }
    const curState = (st && JSON.stringify(st)) || "";
    if (curState === lastState) {
      if (Date.now() - t0 > 60_000 && Date.now() - lastReload > 30_000) {
        log("waitIdle: khong tien trien -> navigate ve chinh URL (vuot dialog)");
        try { const href = await ev("location.href"); await send("Page.navigate", { url: href }); log("navigate OK:", href.slice(-20)); } catch (e) { log("navigate LOI:", String(e.message)); }
        await sleep(6000);
        t0 = Date.now();
        lastState = "";
        lastReload = Date.now();
        continue;
      }
    } else lastState = curState;
    await sleep(700);
  }
}

async function openChat(S) {
  if (!S.chatUrl && S.sent > 0 && !S.mem) {
    const tabu = await ev("location.href").catch(() => "");
    if (tabu && /\/c\/[0-9a-f-]{16,}/i.test(tabu)) {
      const owned = [...sessions.values()].some(x => x && x.chatUrl === tabu);
      if (!owned) {
        S.chatUrl = tabu;
        log("TAB ADOPT — nhat lai chat tren tab: " + tabu.slice(-24));
        saveSessions();
      }
    }
  }

  const cur = await ev("location.href").catch(() => "");
  if (!(S.chatUrl && cur === S.chatUrl)) {
    if (S.chatUrl) {
      await send("Page.navigate", { url: S.chatUrl });
    } else {
      // [FIX] S.sent > 0 = da tung gui tin trong session nay.
      // KHONG bam "New Chat" — no tao entry rong trong sidebar moi lan grabChatId fail.
      // Chi ve trang chu. Send tu trang chu tao chat co noi dung, khong tao chat rong.
      if (S.sent > 0) {
        await send("Page.navigate", { url: "https://chat.z.ai/" });
      } else {
        let veNha = true;
        if (/\/c\//.test(cur)) {
          // [PATCH WEB MOI] nut "Home / New chat" co id cu the: #sidebar-new-chat-button.
          // KHONG quet text "new chat" nua — de trung item lich su co ten "New Chat".
          const nc = await ev(`(() => {
            const b = document.querySelector("#sidebar-new-chat-button");
            if (b && b.offsetParent) {
              b.scrollIntoView({ block: "center" });
              b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
              b.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
              b.click();
              return true;
            }
            return false;
          })()`).catch(() => false);
          if (nc) {
            await sleep(2500);
            const cur2 = await ev("location.href").catch(() => "");
            if (!/\/c\//.test(cur2)) veNha = false;
          }
        }
        if (veNha) await send("Page.navigate", { url: "https://chat.z.ai/" });
      }
    }

    if (!(await waitSel(SEL_INPUT, 30_000))) {
      throw new Error("khong thay o nhap — login trong Chrome cua bridge truoc");
    }
    await sleep(2500);
  }

  await waitIdle();
}

async function grabChatId(S, startIdx) {
  if (S.chatUrl) return S.chatUrl;
  for (let i = 0; i < 40; i++) {
    // 1) URL bar
    const u = await ev("location.href").catch(() => "");
    if (/\/c\/[0-9a-f-]{16,}/i.test(u)) { S.chatUrl = u; log("gio chat (URL):", u); saveSessions(); return u; }
    // 2) API response /chats/new — HOOK da capture, khong can URL doi
    if (typeof startIdx === "number") {
      const fromApi = await ev(`(() => {
        const L = window.__zaiLog || [];
        for (let j = ${startIdx}; j < L.length; j++) {
          if (!/chats\\/new/.test(String(L[j].url || ""))) continue;
          const raw = (L[j].chunks || []).join("");
          const m = raw.match(/"id"\\s*:\\s*"([0-9a-f-]{16,})"/);
          if (m) return "https://chat.z.ai/c/" + m[1];
        }
        return null;
      })()`).catch(() => null);
      if (fromApi) { S.chatUrl = fromApi; log("gio chat (API):", fromApi); saveSessions(); return fromApi; }
    }
    await sleep(500);
  }
  log("CANH: khong lay duoc chat_id");
  return null;
}

async function uploadImagesViaCDP(paths) {
  if (!paths.length) return 0;
  const { copyFileSync, mkdirSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const tmpDir = join(process.cwd(), ".tmp-upload");
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  const { root } = await send("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[type="file"]' });
  if (!nodeId) { log("UPLOAD: khong tim thay input file"); return 0; }
  let ok = 0;
  for (const item of paths) {
    try {
      const src = item.src;
      const ext = item.ext || ".png";
      const name = "img-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6) + ext;
      const dst = join(tmpDir, name);
      copyFileSync(src, dst);
      await send("DOM.setFileInputFiles", { nodeId, files: [dst] });
      log("UPLOAD: " + dst);
      ok++;
      await sleep(1500);
    } catch (e) {
      log("UPLOAD FAIL:", String(e.message || e).slice(0, 100));
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
  if (!(await ev("!!(window.__zaiLog && window.__zaiHookV7)").catch(() => false))) {
    log("HOOK v1/V6 cu hoac mat -> F5 lay trang sach + inject hook V7 (chi rewrite completions)");
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
      // [PATCH WEB MOI] nut gui that la #send-message-button (type=submit, disabled khi input rong).
      // KHONG dung btns.pop() nua — form moi co them nut "Select a model"/"Connect IM" se bi click nham.
      const b = document.querySelector("#send-message-button:not([disabled])")
        || [...document.querySelectorAll("form button")].filter(x => !x.disabled)
             .find(x => /send|submit|gui/i.test(x.getAttribute("aria-label") || "") || x.type === "submit");
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

// ===== DOC ANSWER TU SERVER — messages/batch — KHONG DOC MAN HINH =====
async function serverAnswer(chatId) {
  if (!chatId) return "";
  try {
    const raw = await ev(`(async () => {
      const cid = ${JSON.stringify(chatId)};
      const tried = [];

      const textOf = (m) => {
        if (!m) return "";
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) {
          return m.content
            .map(x => x?.text ?? "")
            .filter(Boolean)
            .join("\\n");
        }
        const blocks = m.content_blocks || [];
        return blocks
          .filter(b => b && b.type === "text")
          .map(b => typeof b.content === "string" ? b.content
            : Array.isArray(b.content) ? b.content.map(x => (x && x.text) || "").filter(Boolean).join("\\n")
            : "")
          .join("");
      };

      const latestAssistant = (obj) => {
        // du kien record #36: data la MAP msg-theo-id ({"071d64c4...": {role, content_blocks}})
        if (obj?.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
          const ids = Object.keys(obj.data);
          for (let i = ids.length - 1; i >= 0; i--) {
            const m = obj.data[ids[i]];
            if (!m || m.role !== "assistant") continue;
            const c = textOf(m);
            if (c.trim()) return c;
          }
        }
        const hist =
          obj?.chat?.history?.messages ||
          obj?.history?.messages ||
          obj?.data?.chat?.history?.messages ||
          obj?.data?.history?.messages ||
          obj?.messages ||
          obj?.data?.messages;

        if (!hist) return "";

        if (Array.isArray(hist)) {
          for (let i = hist.length - 1; i >= 0; i--) {
            const m = hist[i];
            if (!m || m.role !== "assistant") continue;
            const c = textOf(m);
            if (c.trim()) return c;
          }
          return "";
        }

        if (typeof hist === "object") {
          const ids = Object.keys(hist);
          for (let i = ids.length - 1; i >= 0; i--) {
            const m = hist[ids[i]];
            if (!m || m.role !== "assistant") continue;
            const c = textOf(m);
            if (c.trim()) return c;
          }
        }

        return "";
      };
      // 1) GET chat-detail: map id + role + timestamp (metadata — khong co chu)
      let lastAsstId = null, lastTs = 0;
      try {
        const r = await fetch('/api/v1/chats/' + encodeURIComponent(cid), { headers: { accept: 'application/json' } });
        const t = await r.text();
        tried.push({ ep: 'GET detail', status: r.status, len: t.length });
        if (r.ok) {
          const j = JSON.parse(t);
          const msgs = j?.chat?.history?.messages || j?.history?.messages || {};
          for (const [mid, m] of Object.entries(msgs)) {
            if (!m || m.role !== 'assistant') continue;
            const ts = m.timestamp || 0;
            if (ts >= lastTs) { lastTs = ts; lastAsstId = m.id || mid; }
          }
          tried.push({ lastAsstId });
        }
      } catch (e) { tried.push({ err1: String(e && e.message || e).slice(0, 120) }); }

      // 2) batch DUNG body z.ai tu gui: {"ids":[id-assistant-cuoi]} (Network tab do duoc)
      if (lastAsstId) {
        try {
          const r2 = await fetch('/api/v1/chats/' + encodeURIComponent(cid) + '/messages/batch', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ids: [lastAsstId] })
          });
          const t2 = await r2.text();
          tried.push({ ep: 'POST batch 1-id', status: r2.status, len: t2.length });
          if (r2.ok) {
            const j2 = JSON.parse(t2);
            const d2 = j2?.data && typeof j2.data === 'object' ? j2.data : j2;
            const m2 = d2[lastAsstId] || Object.values(d2)[0];
            if (m2) {
              const c2 = textOf(m2);
              if (c2.trim()) return JSON.stringify({ ok: true, chu: c2, via: 'BATCH-ID', tried });
            }
          }
        } catch (e) { tried.push({ err2: String(e && e.message || e).slice(0, 120) }); }
      }

      return JSON.stringify({ ok: false, tried });

      // 2) Try batch with ids=[] because bare {} returns 422 missing ids.
      try {
        const r2 = await fetch('/api/v1/chats/' + encodeURIComponent(cid) + '/messages/batch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids: [] })
        });
        const t2 = await r2.text();
        tried.push({ ep: 'POST batch ids=[]', status: r2.status, len: t2.length });

        if (r2.ok) {
          try {
            const j2 = JSON.parse(t2);
            const c2 = latestAssistant(j2);
            if (c2.trim()) {
              return JSON.stringify({ ok: true, chu: c2, via: 'BATCH-EMPTY-IDS', tried });
            }
          } catch (e) {
            tried.push({ parseErr2: String(e && e.message || e).slice(0, 160) });
          }
        }
      } catch (e) {
        tried.push({ err2: String(e && e.message || e).slice(0, 160) });
      }

      return JSON.stringify({ ok: false, tried });
    })()`);

    const o = JSON.parse(String(raw || "{}"));
    if (o && o.ok) {
      log("[SERVER] answer " + (o.via || "?") + " — " + String(o.chu).length + " ky tu");
      return String(o.chu);
    }

    log("[SERVER] khong doc duoc: " + JSON.stringify(o.tried || o).slice(0, 900));
  } catch (e) {
    log("[SERVER] loi: " + String(e.message || e).slice(0, 160));
  }
  return "";
}

const recAt = i => ev(`window.__zaiLog[${i}] ? {via: window.__zaiLog[${i}].via, status: window.__zaiLog[${i}].status, ct: window.__zaiLog[${i}].ct, chunks: window.__zaiLog[${i}].chunks, done: window.__zaiLog[${i}].done, error: window.__zaiLog[${i}].error} : null`);
const bestRec = i => ev(`(() => {
  const L = window.__zaiLog; if (!L) return null;
  const from = Math.max(0, Number(${i}) || 0);
  let best = -1, bestScore = -1, matched = false;
  for (let j = from; j < L.length; j++) {
    const u = String(L[j].url || "");
    if (!/completion/i.test(u)) continue;
    matched = true;
    const bytes = (L[j].chunks || []).reduce((a, c) => a + c.length, 0);
    const score = bytes + (L[j].done ? 0 : 10000000);   // record DANG STREAM luon thang
    if (score > bestScore) { bestScore = score; best = j; }
  }
  if (best < 0) return null;
  const r = L[best];
  return { via: r.via, status: r.status, ct: r.ct, chunks: r.chunks, done: r.done, error: r.error, hit: matched };
})()`);

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
  // [PATCH WEB MOI] site-tool moi danh dau bang <glm_block ...> (thay <divinjeff>)
  .replace(/<glm_block[^>]*>[\s\S]*?<\/glm_block>/gi, "")
  .replace(/<\/?glm_block[^>]*>/gi, "")
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
  if (!calls.length) {
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
            const descM = raw.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (nmM) {
              const ag = {};
              const grab = (key, stop) => {
                const m2 = raw.match(new RegExp('"' + key + '"\\s*:\\s*"([\\s\\S]*?)"' + (stop ? '\\s*,\\s*"' + stop + '"' : '\\s*\\}'), ''));
                return m2 ? m2[1] : null;
              };
              const fpM = grab("file_path", "content");
              const ctM = fpM ? grab("content", null) : null;
              const u = s => { try { return JSON.parse('"' + s + '"'); } catch { return s; } };
              if (fpM && ctM !== null) { ag.file_path = u(fpM); ag.content = u(ctM); }
              else if (cmdM) { ag.command = u(cmdM[1]); if (descM) ag.description = u(descM[1]); }
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

  // TANG 3c: JSON gan-dung thieu ':' sau key — "command":"...","description"act OCR...
  if (!calls.length) {
    const s3c = String(text);
    const mm3 = s3c.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"description"\s*(?::|(?=["A-Za-zÀ-ỹ]))\s*"?([^"}]*)/);
    if (mm3) {
      const nm3 = s3c.match(/"name"\s*:\s*"([^"]+)"/) || s3c.match(/\b(pwsh|Bash|Read|Write|Edit|Glob|Grep|WebFetch|Skill)\b(?=.*"command")/);
      const nameC = nm3 ? (nm3[1] || nm3[0]) : "pwsh";
      calls.push({ id: "call_" + Math.random().toString(36).slice(2, 9), type: "function",
        function: { name: nameC, arguments: JSON.stringify({ command: mm3[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'), description: (mm3[2] || "").trim() }) } });
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

  // TANG 3d: SANITIZE — model GLM viet JSON tho (newline trong chuoi, ':' bi mat, '(' roi dong).
  // Bat cac cap key:value cua "command"/"description" bang regex mem, lai sach, dong goi lai JSON dung.
  if (!calls.length) {
    const s3d = String(text);
    const cmdM = s3d.match(/"command"\s*:?\s*"((?:[^"\\]|\\.|[\r\n])+?)"\s*,\s*"description"/s);
    if (cmdM) {
      let cmd = cmdM[1]
        .replace(/\r\n/g, "\\n").replace(/\n/g, "\\n").replace(/\r/g, "\\n")   // newline thau -> \n escape
        .replace(/"\s*\n?\s*\(/g, "\"(")                                        // " \n ( -> "(
        .replace(/\n?\s*\(/g, "(")                                               // dau ( roi dong don lai
        .replace(/:\s*\n\s*\(/g, ":(")
        .replace(/\\(?!["\\\/bfnrtu])/g, "\\\\")
        .replace(/\t/g, "\\t");
      const descM = s3d.match(/"description"\s*:?\s*"?([^"}\n]*)/);
      const nm3 = s3d.match(/"name"\s*:\s*"([^"]+)"/);
      const name3 = nm3 ? nm3[1] : (/\bpwsh\b/i.test(s3d.slice(0, cmdM.index)) ? "pwsh" : "Bash");
      try {
        const argv = { command: JSON.parse('"' + cmd + '"'), description: (descM ? descM[1] : "").trim() };
        if (argv.command && argv.command.trim()) calls.push({ id: "call_" + Math.random().toString(36).slice(2, 9), type: "function",
          function: { name: name3, arguments: JSON.stringify(argv) } });
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
10. LENH DAI: command/command-chain >300 ky tu thi TUYET DOI khong nhet vao mot block TOOLCALL. Cach dung duy nhat: (1) Write tool ghi script vao file .tmp/xxx.ps1 — noi dung script la parameter rieng cua Write, khong can escape JSON; (2) TOOLCALL chi chua: pwsh -File .tmp/xxx.ps1 (<300 ky tu). Script sai -> PowerShell bao SO DONG -> Edit dung dong do, khong sinh lai nguyen file. Trong script: bien trong chuoi xai $ + {ten_bien} chu khong xai $ten_bien.
]\n${sysTxt}\n\n` + t;
    if (TOOLS && Array.isArray(tools) && tools.length) t = protoBlock(tools) + "\n\n" + t;
    S.booted = true;
  } else if (TOOLS) {
    t = `[HARNESS] Nho: la agent, ban CO tool. Muon hanh dong thi in <TOOLCALL>{"name":"TenTool","arguments":{...}}</TOOLCALL>. Khong viet command bang text, khong gia ket qua, khong noi "da lam". Bao "xong" chi khi da Read/ls kiem chung file that; bien doi dinh dang thi dung tool goc (Word COM/LibreOffice), khong boc XML tay; kiem output khong chua "<w:"/"PAGEREF" truoc khi bao thanh cong. Tool loi = chua co ket qua, retry thay that moi tra loi. Ngay/tin tuc: query song (date, WebFetch live), khong dung context cu. Nhieu thao tac doc lap -> in nhieu block TOOLCALL cung luot (song song). Tao DOCX: viet HTML roi Word COM SaveAs 16, khong python-docx tay. File tam vao .tmp. 
    Memory/skills reminder va file cu = lich su, chi lam yeu cau moi nhat, khong ke chuyen cu khong duoc hoi.
    Command >300 ky tu -> Write file .tmp roi pwsh -File, khong nhet vao TOOLCALL.\n\n` + t;
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

    lastReqAt = Date.now();   // [v2.2] ghi nhan request vua den (F5-don-trang se HUY neu chay dam vao luc nay)
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
      let sseFail = null;   // [PATCH v2] hoist RA KHOI vong for — bug v1 khai bao trong block for -> "sseFail is not defined" (log 12:33)
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
        // [PATCH] FAIL-FAST NET-ERR: doc __zaiLog tu idx — SSE co data.error.code hoac POST
        // chats/new tra >= 400 thi dung NGAY (web da xoa chat) thay vi treo den TIMEOUT 600s.
        const netErr = () => ev(`(() => {
          const L = window.__zaiLog || [];
          for (let j = ${idx}; j < L.length; j++) {
            const u = String(L[j].url || "");
            if (/chats\\/new/.test(u) && L[j].status >= 400) return "CHATS_NEW_HTTP_" + L[j].status;
            if (!/completion/i.test(u)) continue;
            const raw = (L[j].chunks || []).join("");
            const m = raw.match(/"error"\\s*:\\s*\\{[\\s\\S]{0,200}?"code"\\s*:\\s*"([^"]{3,60})"/);
            if (m) return m[1];
          }
          return null;
        })()`).catch(() => null);
        // [v2.2] SSE FAST-PATH: doc answer TRUC TIEP tu stream ma hook da bat trong __zaiLog.
        // Web sinh xong -> [DONE] xuat hien -> lay NGAY, khoi cho poll server 10-20s.
        // Parse = dung chung logic script verify da chay that tren web moi:
        // unwrap {type:"chat:completion",data:{...}}, chi lay phase==="answer".
        const sseAns = () => ev(`(() => {
          const L = window.__zaiLog || [];
          for (let j = ${idx}; j < L.length; j++) {
            const u = String(L[j].url || "");
            if (!/completion/i.test(u)) continue;
            const raw = (L[j].chunks || []).join("");
            if (!raw.includes("[DONE]")) continue;   // stream chua xong / bi F5 giau mang -> bo qua
            let out = "";
            for (const ln of raw.split("\\n")) {
              const s = ln.trim();
              if (!s.startsWith("data:")) continue;
              const p = s.slice(5).trim();
              if (!p || p === "[DONE]") continue;
              try {
                const j2 = JSON.parse(p);
                const d = (j2.type === "chat:completion" && j2.data) ? j2.data : (j2.data ?? j2);
                if (d.phase === "answer" && typeof d.delta_content === "string") out += d.delta_content;
              } catch (e) {}
            }
            if (out.trim()) return out;
          }
          return null;
        })()`).catch(() => null);
        let lastSrvAt = tLoop;
        while (Date.now() - tLoop < TIMEOUT) {
          await sleep(3000);   // [v2.2] 3s/lan — chi doc memory qua CDP (re, khong API z.ai); loi m "3s spam" la ve API call, khong phai doc memory
          const ec = await netErr();
          if (ec) {
            sseFail = ec;
            log("[NET-ERR] " + ec + " — fail nhanh thay vi cho " + Math.round(TIMEOUT / 1000) + "s");
            if (/CONCURRENCY/i.test(ec) || /^CHATS_NEW_HTTP_/.test(ec)) {
              S.chatUrl = null; S.booted = false;   // web da xoa chat / chat khong tao duoc — request sau bootstrap lai chat moi
              try { saveSessions(); } catch (e) {}
            }
            break;
          }
          // [v2.2] FAST-PATH: web sinh xong ([DONE] trong stream) -> lay answer NGAY TAI DAY
          const sse = await sseAns();
          if (sse) { serverAns = sse; log("[SSE] answer truc tiep — " + sse.length + " ky tu | " + ((Date.now() - tLoop) / 1000).toFixed(1) + "s sau prompt"); break; }
          if (Date.now() - lastSrvAt >= 10000) {   // [v2.2] 20s -> 10s — fallback khi SSE khong doc duoc (hook mat / F5 cu)
            lastSrvAt = Date.now();
            const cid = chatIdSrv0();
            if (cid) {
              const srv = await serverAnswer(cid);
              if (srv.trim()) { serverAns = srv; log("[SERVER] answer (fallback poll) — " + srv.length + " ky tu | " + ((Date.now() - tLoop) / 1000).toFixed(1) + "s"); break; }
            }
          }
          if (Date.now() - tLoop >= (f5Count + 1) * 30000) {
            // [v2.2] F5 CO DIEU KIEN: chi reload khi KHONG thay dau hieu dang sinh
            // (khong co rec completions nao tu luc gui + khong co nut Stop).
            // Ban cu F5 vo dieu kien moi 30s -> giet stream SSE giua chung -> mat answer truc tiep.
            const genAlive = await ev(`(() => { const L = window.__zaiLog || []; for (let j = ${idx}; j < L.length; j++) if (/completion/i.test(String(L[j].url || ""))) return true; return !!document.querySelector('[aria-label="Stop"]'); })()`).catch(() => false);
            f5Count++;
            if (genAlive) { log("[F5] HUY — web dang sinh (completions/Stop) — khong reload sua stream"); continue; }
            log("[F5] " + f5Count * 30 + "s sau prompt, chua thay dau hieu sinh -> cap nhat trang");
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
      if (!sseFail) await grabChatId(S, idx);   // [PATCH] fail-fast thi bo qua — chat da chet / da clear session

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
        if (sseFail) await sleep(15000);   // [PATCH v2] NET-ERR -> cham 15s truoc khi bao loi, chan DSH retry xoang vong home
        const hint = sseFail
          ? (/CONCURRENCY/i.test(sseFail) ? "z.ai MODEL_CONCURRENCY_LIMIT — slot model day. Agent/preview da tat o hook; DSH retry se tu tao chat moi"
             : /^CHATS_NEW_HTTP_(401|403)$/.test(sseFail) ? sseFail + " — cookie het han, login lai trong Chrome cua bridge"
             : /^CHATS_NEW_HTTP_/.test(sseFail) ? sseFail + " — POST chats/new bi server chan (da revert rewrite, body la goc cua site) — kiem login/cookie trong Chrome cua bridge"
             : "z.ai SSE error: " + sseFail)
          : !st ? "khong bat duoc response"
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
          if (clean && clean.trim()) sent(clean);

          res.write(`data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: { tool_calls: calls.map((c, ix) => ({ ...c, index: ix })) } }] })}\n\n`);
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
        log("[F5-SAU-ANS] cho 10s roi don trang (tu huy neu request sau da den)");
        setTimeout(async () => {
          await sleep(10000);
          // [v2.2] HUY reload neu request moi da den / web dang sinh — reload giua chung se
          // giet stream cua request sau (DSH gui tool-result ngay lap tuc sau answer)
          const busy = (Date.now() - lastReqAt) < 20000 || await ev(`(() => { const stop = !!document.querySelector('[aria-label="Stop"]'); const inp = document.querySelector(${JSON.stringify(SEL_INPUT)}); return stop || (inp && (inp.value || "")).length > 0; })()`).catch(() => false);
          if (busy) { log("[F5-SAU-ANS] HUY — request moi dang chay, giu nguyen trang"); return; }
          send("Page.reload").catch(() => {});
        }, 0);
      }
      res.write("data: [DONE]\n\n"); res.end();
    });
  } catch (e) {
    log("ERR", e.message);
    if (!res.headersSent) J(502, { error: { message: String(e.message) } }); else res.end();
  }
}).listen(PORT, "127.0.0.1", () => { log(`=== BRIDGE ${BUILD} ===`); log(`http://127.0.0.1:${PORT}/api/paas/v4/chat/completions  tools=${TOOLS}`); });

await launch();
log("Chrome da mo. CHUA LOGIN -> login trong window DO.");
