(() => {
"use strict";

const CFG = window.APP_CONFIG;
const TZ = CFG.timezone || "Europe/Moscow";

const K = {
  schedule: "ma.schedule.v1",
  scheduleAt: "ma.scheduleAt.v1",
  records: "ma.records.v1",
  settings: "ma.settings.v1",
  token: "ma.token.v1",
  dirty: "ma.dirty.v1",
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------------- storage ---------------- */

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const state = {
  schedule: load(K.schedule, null),
  records: load(K.records, {}),
  settings: Object.assign({ lectures: false, target: 60 }, load(K.settings, {})),
  token: load(K.token, ""),
  filter: "all",
};

let pushTimer = null;

/* ---------------- dates ---------------- */

const mskFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

const mskNow = () => mskFmt.format(new Date()).replace(" ", "T");
const mskToday = () => mskNow().slice(0, 10);

const MONTHS = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const MONTHS_SHORT = ["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"];
const WEEKDAYS = ["вс","пн","вт","ср","чт","пт","сб"];

function fmtDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${d} ${MONTHS[m - 1]}, ${WEEKDAYS[dt.getUTCDay()]}`;
}
function fmtShortDay(iso) {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS_SHORT[m - 1]}`;
}
const fmtTime = (iso) => iso.slice(11, 16);
const fmtRange = (e) => `${fmtTime(e.start)}–${fmtTime(e.end)}`;

const timeNow = () => {
  const t = mskNow();
  return t.slice(11, 16);
};

/* ---------------- helpers ---------------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

function hue(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const TYPE = { LECT: "Лекция", SEMI: "Практика", LAB: "Лабораторная" };
const TYPE_CLASS = { LECT: "lect", LAB: "lab" };

const byStart = (a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0);

/* ---------------- records ---------------- */

function rec(id) {
  const r = state.records[id];
  return r && r.s ? r.s : null;
}
function setRec(id, s) {
  state.records[id] = { s, t: Date.now() };
  save(K.records, state.records);
  render();
  queuePush();
}

/* ---------------- stats ---------------- */

const isPast = (e) => e.start.slice(0, 16) <= mskNow();

function counted(e) {
  return e.status !== "CANCELLED" && isPast(e) && (state.settings.lectures || e.type !== "LECT");
}

function statsOf(events) {
  const s = { present: 0, absent: 0, excused: 0, unmarked: 0 };
  for (const e of events) {
    if (!counted(e)) continue;
    const r = rec(e.id);
    if (r === "present") s.present++;
    else if (r === "absent") s.absent++;
    else if (r === "excused") s.excused++;
    else s.unmarked++;
  }
  return s;
}

const pct = (n, d) => (d ? Math.round((n * 1000) / d) / 10 : null);
const fmtPct = (p) => (p === null ? "—" : (Number.isInteger(p) ? p : p.toFixed(1)) + "%");

function canSkip(s) {
  const T = Number(state.settings.target) || 0;
  if (T <= 0 || T > 100) return null;
  if (s.present + s.absent + s.excused === 0) return null;
  return Math.max(0, Math.floor((s.present * (100 - T)) / T) - s.absent);
}

/* ---------------- cards ---------------- */

function cardHtml(e, opts = {}) {
  const cancelled = e.status === "CANCELLED";
  const r = rec(e.id);
  const today = mskToday();
  const day = e.start.slice(0, 10);

  let badge = "";
  if (cancelled) badge = `<span class="badge cancel">Отменено</span>`;
  else if (TYPE[e.type]) badge = `<span class="badge ${TYPE_CLASS[e.type] || ""}">${TYPE[e.type]}</span>`;

  const meta = [];
  if (e.room) meta.push(esc(e.room));
  if (e.building) meta.push(esc(e.building));
  const teachers = (e.teachers || []).filter(Boolean).join(", ");
  if (teachers) meta.push(esc(teachers));

  let seg = "";
  if (cancelled) {
    seg = "";
  } else if (day <= today) {
    const on = (v) => (r === v ? " on" : "");
    seg = `<div class="seg" data-id="${esc(e.id)}">
      <button data-s="present" data-act="present" class="${on("present").trim()}">Был</button>
      <button data-s="absent" data-act="absent" class="${on("absent").trim()}">Не был</button>
      <button data-s="excused" data-act="excused" class="${on("excused").trim()}">Уваж.</button>
      <button data-act="reset" class="reset"${r ? "" : " disabled"} title="Сбросить">↺</button>
    </div>`;
  } else {
    seg = `<div class="future">Ещё не было</div>`;
  }

  return `<article class="card${cancelled ? " cancelled" : ""}" style="--c:hsl(${hue(e.subject_id || e.subject || "x")} 55% 52%)">
    <div class="card-top">
      <span class="time">${fmtRange(e)}</span>
      ${day !== today ? `<span>${fmtShortDay(day)}</span>` : ""}
      ${badge}
    </div>
    <h3 class="subject">${esc(e.subject || e.title || "Занятие")}</h3>
    ${meta.length ? `<div class="meta">${meta.join(' <span class="sep">·</span> ')}</div>` : ""}
    ${seg}
  </article>`;
}

/* ---------------- render: today ---------------- */

function eventsForDay(day) {
  return (state.schedule?.events || []).filter((e) => e.start.slice(0, 10) === day).sort(byStart);
}

function renderToday() {
  const body = $("#todayBody");
  if (!state.schedule) {
    body.innerHTML = `<div class="empty"><p>Загружаю расписание…</p></div>`;
    return;
  }
  const day = mskToday();
  const list = eventsForDay(day);

  if (!list.length) {
    let html = `<div class="empty"><span class="emoji">☕️</span><p>Сегодня пар нет</p></div>`;
    const upcoming = (state.schedule.events || [])
      .filter((e) => e.start.slice(0, 10) > day && e.status !== "CANCELLED")
      .sort(byStart)
      .slice(0, 3);
    if (upcoming.length) {
      html += `<div class="day-head"><h2>Ближайшее</h2></div>
        <div class="cards">${upcoming.map((e) => cardHtml(e)).join("")}</div>`;
    }
    body.innerHTML = html;
    return;
  }

  const s = statsOf(list);
  const marked = s.present + s.absent + s.excused;
  body.innerHTML = `
    <div class="day-head">
      <h2>Сегодня</h2>
      <span>${list.length} ${plural(list.length, "пара", "пары", "пар")}${marked ? ` · отмечено ${marked}` : ""}</span>
    </div>
    <div class="cards">${list.map((e) => cardHtml(e)).join("")}</div>`;
}

/* ---------------- render: subjects ---------------- */

function subjectGroups() {
  const map = new Map();
  for (const e of state.schedule?.events || []) {
    if (e.status === "CANCELLED") continue;
    const key = e.subject_id || e.subject || "?";
    if (!map.has(key)) map.set(key, { id: key, name: e.subject || "Без названия", events: [] });
    map.get(key).events.push(e);
  }
  return [...map.values()]
    .map((g) => ({ ...g, s: statsOf(g.events) }))
    .filter((g) => g.s.present + g.s.absent + g.s.excused + g.s.unmarked > 0)
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

function renderSubjects() {
  const body = $("#subjectsBody");
  if (!state.schedule) {
    body.innerHTML = `<div class="empty"><p>Загружаю расписание…</p></div>`;
    return;
  }
  const all = statsOf(state.schedule.events || []);
  const len = pct(all.present, all.present + all.absent);
  const strict = pct(all.present, all.present + all.absent + all.excused);
  const skip = canSkip(all);
  const marked = all.present + all.absent + all.excused;

  const summary = marked
    ? `${all.present} из ${marked} ${plural(marked, "занятия", "занятий", "занятий")}
       · строго ${fmtPct(strict)}
       ${all.unmarked ? ` · <b>${all.unmarked} без отметки</b>` : ""}`
    : `Пока нет отметок${all.unmarked ? ` · прошло ${all.unmarked}` : ""}`;

  let html = `<div class="overall">
    <div class="big">${fmtPct(len).replace("%", "")}<small>${len === null ? "" : "%"}</small></div>
    <div class="sub">${summary}</div>
    ${skip !== null ? `<div class="sub">До ${state.settings.target}% можно пропустить ещё <b>${skip}</b> ${plural(skip, "пару", "пары", "пар")}</div>` : ""}
  </div>`;

  for (const g of subjectGroups()) {
    const s = g.s;
    const p = pct(s.present, s.present + s.absent);
    const st = pct(s.present, s.present + s.absent + s.excused);
    const total = s.present + s.absent + s.excused + s.unmarked;
    const marked = s.present + s.absent + s.excused;
    const sk = canSkip(s);
    const color = `hsl(${hue(g.id)} 55% 52%)`;
    const foot = marked
      ? `<span><b>${s.present}</b> из <b>${marked}</b>${s.excused ? ` · строго ${fmtPct(st)}` : ""}${s.unmarked ? ` · ${s.unmarked} без отметки` : ""}</span>
         <span>${sk === null ? "" : `можно пропустить: <b>${sk}</b>`}</span>`
      : `<span>нет отметок · ${total} ${plural(total, "пара", "пары", "пар")}</span><span></span>`;
    html += `<div class="subj" style="--c:${color}">
      <div class="subj-head">
        <div class="subj-name">${esc(g.name)}</div>
        <div class="subj-pct">${fmtPct(p)}</div>
      </div>
      <div class="bar"><i style="width:${p === null ? 0 : Math.min(100, p)}%"></i></div>
      <div class="subj-foot">${foot}</div>
    </div>`;
  }

  body.innerHTML = html;
}

/* ---------------- render: all ---------------- */

function renderAll() {
  const body = $("#allBody");
  if (!state.schedule) {
    body.innerHTML = `<div class="empty"><p>Загружаю расписание…</p></div>`;
    return;
  }
  const today = mskToday();
  let list = (state.schedule.events || []).filter(
    (e) => e.status !== "CANCELLED" && e.start.slice(0, 10) <= today && isPast(e)
  );

  if (state.filter === "unmarked") list = list.filter((e) => !rec(e.id));
  if (state.filter === "missed") list = list.filter((e) => rec(e.id) === "absent" || rec(e.id) === "excused");

  if (!list.length) {
    body.innerHTML = `<div class="empty"><span class="emoji">🔍</span><p>Ничего не найдено</p></div>`;
    return;
  }

  const days = new Map();
  for (const e of list.sort(byStart)) {
    const d = e.start.slice(0, 10);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(e);
  }

  const groups = [...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const html = groups
    .map(([d, evs]) => {
      const present = evs.filter((e) => rec(e.id) === "present").length;
      const absent = evs.filter((e) => rec(e.id) === "absent").length;
      const excused = evs.filter((e) => rec(e.id) === "excused").length;
      const parts = [];
      if (present) parts.push(`${present} ✓`);
      if (absent) parts.push(`${absent} ✕`);
      if (excused) parts.push(`${excused} у`);
      const unmarked = evs.filter((e) => !rec(e.id)).length;
      return `<div class="day-head">
          <h2>${fmtDay(d)}</h2>
          <div class="day-right">
            <span>${parts.join(" · ")}</span>
            ${unmarked ? `<button class="mini" data-day="${d}">Все были</button>` : ""}
          </div>
        </div>
        <div class="cards" style="margin-bottom:16px">${evs.map((e) => cardHtml(e)).join("")}</div>`;
    })
    .join("");

  const bulk =
    state.filter === "unmarked" && list.length
      ? `<div class="bulk"><button class="btn ghost" id="bulkMark">Отметить все ${list.length} как «был»</button></div>`
      : "";
  body.innerHTML = bulk + html;
}

/* ---------------- render root ---------------- */

function render() {
  renderToday();
  renderSubjects();
  renderAll();
  updateHeader();
}

function updateHeader() {
  const today = mskToday();
  let extra = "";
  let unmarked = 0;
  if (state.schedule) {
    const today = mskToday();
    unmarked = (state.schedule.events || []).filter(
      (e) =>
        e.status !== "CANCELLED" &&
        e.start.slice(0, 10) <= today &&
        isPast(e) &&
        !rec(e.id)
    ).length;
    if (unmarked) extra = ` · ${unmarked} без отметки`;
  }
  const label = $("#todayLabel");
  label.textContent = fmtDay(today) + extra;
  label.classList.toggle("clickable", unmarked > 0);
}

/* ---------------- sync: gist ---------------- */

const rawUrl = (f) => `https://gist.githubusercontent.com/${CFG.owner}/${CFG.gistId}/raw/${f}`;
const API_URL = `https://api.github.com/gists/${CFG.gistId}`;
const auth = () => ({
  Authorization: `Bearer ${state.token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});

function setSync(kind, msg) {
  const dot = $("#syncDot");
  dot.className = "dot" + (kind ? " " + kind : "");
  const line = $("#syncLine");
  if (line) {
    line.className = "status" + (kind === "ok" ? " ok" : kind === "err" ? " err" : "");
    line.textContent = msg;
  }
}

function mergeRemote(remote) {
  let changed = false;
  for (const [id, r] of Object.entries(remote || {})) {
    const cur = state.records[id];
    if (!cur || (r.t || 0) > (cur.t || 0)) {
      state.records[id] = r;
      changed = true;
    }
  }
  return changed;
}

function prune(records) {
  const cutoff = Date.now() - 60 * 864e5;
  const out = {};
  for (const [id, r] of Object.entries(records)) {
    if (!r.s && (r.t || 0) < cutoff) continue;
    out[id] = r;
  }
  return out;
}

async function pullAttendance() {
  if (!CFG.gistId) return;
  try {
    const r = await fetch(rawUrl(CFG.attendanceFile) + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json();
    if (data && data.records && mergeRemote(data.records)) {
      save(K.records, state.records);
      render();
    }
  } catch {}
}

function queuePush() {
  save(K.dirty, true);
  if (!state.token) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushAttendance, 1200);
}

async function pushAttendance() {
  if (!state.token) return;
  setSync("busy", "синхронизация…");
  try {
    let remote = {};
    const g = await fetch(API_URL, { headers: auth() });
    if (g.status === 401) throw new Error("токен не подошёл");
    if (g.ok) {
      const j = await g.json();
      const f = j.files && j.files[CFG.attendanceFile];
      if (f && f.content) {
        try {
          remote = JSON.parse(f.content).records || {};
        } catch {}
      }
    }
    mergeRemote(remote);

    const payload = {
      version: 1,
      updated: new Date().toISOString(),
      records: prune(state.records),
    };
    const w = await fetch(API_URL, {
      method: "PATCH",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        files: { [CFG.attendanceFile]: { content: JSON.stringify(payload, null, 2) } },
      }),
    });
    if (!w.ok) throw new Error("GitHub " + w.status);

    save(K.records, state.records);
    save(K.dirty, false);
    state.unmarkedTotal = undefined;
    render();
    setSync("ok", "синхронизировано · " + timeNow());
  } catch (e) {
    setSync("err", "не удалось сохранить: " + e.message);
  }
}

/* ---------------- sync: schedule ---------------- */

function setSched(text, isErr) {
  const line = $("#schedLine");
  if (!line) return;
  line.className = "status" + (isErr ? " err" : "");
  line.textContent = text;
}

function schedSummary() {
  if (!state.schedule) return "нет данных";
  const n = (state.schedule.events || []).length;
  const g = state.schedule.generated ? new Date(state.schedule.generated) : null;
  const when = g
    ? new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(g)
    : "?";
  return `обновлено ${when} · ${n} ${plural(n, "пара", "пары", "пар")}`;
}

async function pullSchedule(force) {
  const at = load(K.scheduleAt, 0);
  if (!force && state.schedule && Date.now() - at < 30 * 60 * 1000) {
    setSched(schedSummary());
    return;
  }
  try {
    const r = await fetch(rawUrl(CFG.scheduleFile) + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("файл ещё не опубликован");
    const data = await r.json();
    if (!Array.isArray(data.events)) throw new Error("неверный формат");
    state.schedule = data;
    save(K.schedule, data);
    save(K.scheduleAt, Date.now());
    setSched(schedSummary());
    render();
  } catch (e) {
    setSched(state.schedule ? "кэш · " + e.message : e.message, !state.schedule);
  }
}

/* ---------------- settings ---------------- */

function syncSettingsInputs() {
  $("#target").value = state.settings.target;
  $("#lectures").checked = !!state.settings.lectures;
  $("#token").value = state.token;
}

async function checkToken() {
  if (!state.token) {
    setSync("", "не настроена");
    return false;
  }
  setSync("busy", "проверяю токен…");
  try {
    const r = await fetch("https://api.github.com/user", { headers: auth() });
    if (!r.ok) throw new Error(r.status === 401 ? "токен не подошёл" : "GitHub " + r.status);
    const u = await r.json();
    setSync("ok", `подключено как ${u.login}`);
    return true;
  } catch (e) {
    setSync("err", e.message);
    return false;
  }
}

function initSettings() {
  syncSettingsInputs();

  $("#target").addEventListener("change", (e) => {
    const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
    state.settings.target = v;
    e.target.value = v;
    save(K.settings, state.settings);
    render();
  });

  $("#lectures").addEventListener("change", (e) => {
    state.settings.lectures = e.target.checked;
    save(K.settings, state.settings);
    render();
  });

  $("#saveToken").addEventListener("click", async () => {
    state.token = $("#token").value.trim();
    save(K.token, state.token);
    const ok = await checkToken();
    if (ok) {
      await pullAttendance();
      await pushAttendance();
    }
  });

  $("#syncNow").addEventListener("click", async () => {
    await pullAttendance();
    await pushAttendance();
    toast("Готово");
  });

  $("#refreshBtn").addEventListener("click", async () => {
    setSched("обновляю…");
    await pullSchedule(true);
    toast("Расписание обновлено");
  });

  $("#exportBtn").addEventListener("click", () => {
    const data = {
      version: 1,
      exported: new Date().toISOString(),
      records: state.records,
      settings: state.settings,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `poseshchaemost-${mskToday()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  $("#importBtn").addEventListener("click", () => $("#importFile").click());

  $("#importFile").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.records) {
        state.records = data.records;
        save(K.records, state.records);
      }
      if (data.settings) {
        state.settings = { ...state.settings, ...data.settings };
        save(K.settings, state.settings);
      }
      syncSettingsInputs();
      render();
      queuePush();
      toast("Импортировано");
    } catch {
      toast("Не получилось прочитать файл");
    } finally {
      e.target.value = "";
    }
  });

  $("#calendarLink").href = CFG.calendarUrl;
  setSched(schedSummary());
  if (state.token) checkToken();
}

/* ---------------- ui ---------------- */

function toast(msg) {
  let el = $(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 1800);
}

function switchTab(name) {
  $$(".tabbtn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((s) => s.classList.toggle("active", s.id === "tab-" + name));
  if (name === "more") setSched(schedSummary());
}

/* ---------------- boot ---------------- */

function markDay(day) {
  const evs = (state.schedule?.events || []).filter(
    (e) => e.start.slice(0, 10) === day && e.status !== "CANCELLED" && !rec(e.id)
  );
  if (!evs.length) return;
  applyPresent(evs);
  toast(`Отмечено: ${evs.length}`);
}

function applyPresent(evs) {
  const t = Date.now();
  evs.forEach((e, i) => {
    state.records[e.id] = { s: "present", t: t + i };
  });
  save(K.records, state.records);
  render();
  queuePush();
}

function bulkMark() {
  const today = mskToday();
  const evs = (state.schedule?.events || []).filter(
    (e) =>
      e.status !== "CANCELLED" &&
      e.start.slice(0, 10) <= today &&
      isPast(e) &&
      !rec(e.id)
  );
  if (!evs.length) return;
  if (!confirm(`Отметить ${evs.length} ${plural(evs.length, "пару", "пары", "пар")} как «был»?`)) return;
  applyPresent(evs);
  toast(`Отмечено: ${evs.length}`);
}

document.addEventListener("click", (ev) => {
  const bulk = ev.target.closest("#bulkMark");
  if (bulk) {
    bulkMark();
    return;
  }
  const dayBtn = ev.target.closest(".mini[data-day]");
  if (dayBtn) {
    markDay(dayBtn.dataset.day);
    return;
  }
  const btn = ev.target.closest(".seg button");
  if (!btn) return;
  const seg = btn.closest(".seg");
  const id = seg && seg.dataset.id;
  if (!id) return;
  const act = btn.dataset.act;
  if (act === "reset") {
    setRec(id, "");
    toast("Отметка снята");
  } else {
    setRec(id, act);
  }
});

$$(".tabbtn").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

$("#todayLabel").addEventListener("click", () => {
  if (!$("#todayLabel").classList.contains("clickable")) return;
  switchTab("all");
  state.filter = "unmarked";
  $$(".chip").forEach((c) => c.classList.toggle("active", c.dataset.filter === "unmarked"));
  renderAll();
});

$("#filters").addEventListener("click", (ev) => {
  const chip = ev.target.closest(".chip");
  if (!chip) return;
  state.filter = chip.dataset.filter;
  $$(".chip").forEach((c) => c.classList.toggle("active", c === chip));
  renderAll();
});

window.addEventListener("online", () => {
  if (load(K.dirty, false)) pushAttendance();
});

async function init() {
  initSettings();
  render();
  await pullSchedule(false);
  await pullAttendance();
  if (state.token && load(K.dirty, false)) pushAttendance();

  const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
  if ("serviceWorker" in navigator && !isLocal && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
})();
