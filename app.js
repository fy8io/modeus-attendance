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
function fmtDayShort(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${d} ${MONTHS_SHORT[m - 1]}, ${WEEKDAYS[dt.getUTCDay()]}`;
}
function dayShiftIso(days) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + days * 864e5));
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
const fmtPct = (p) =>
  p === null ? "—" : (Number.isInteger(p) ? p : p.toFixed(1).replace(".", ",")) + "%";

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

  const nowIso = mskNow();
  const live = !cancelled && e.start.slice(0, 16) <= nowIso && e.end.slice(0, 16) > nowIso;

  let badge = "";
  if (cancelled) {
    badge = `<span class="badge cancel">Отменено</span>`;
  } else {
    if (live) badge += `<span class="badge now">Сейчас</span>`;
    if (TYPE[e.type]) badge += `<span class="badge ${TYPE_CLASS[e.type] || ""}">${TYPE[e.type]}</span>`;
  }

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
    seg = `<div class="future">Запланировано</div>`;
  }

  return `<article class="card${cancelled ? " cancelled" : ""}${live ? " live" : ""}" style="--c:hsl(${hue(e.subject_id || e.subject || "x")} 62% 50%)">
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

function ringHtml(value, target) {
  const R = 50;
  const C = 2 * Math.PI * R;
  const Rt = 56;
  const Ct = 2 * Math.PI * Rt;
  const v = value === null ? 0 : Math.max(0, Math.min(100, value));
  const t = Math.max(0, Math.min(100, Number(target) || 0));
  const color =
    value === null ? "var(--muted)" : t > 0 && v < t ? "var(--red)" : "var(--green)";
  const tick =
    t > 0
      ? `<circle class="ring-target" cx="60" cy="60" r="${Rt}" style="stroke-dasharray:2 ${(Ct - 2).toFixed(1)};stroke-dashoffset:${((-Ct * t) / 100).toFixed(1)}"/>`
      : "";
  const num =
    value === null
      ? "—"
      : Number.isInteger(value)
        ? String(value)
        : value.toFixed(1).replace(".", ",");
  return `<div class="ring-wrap">
    <svg class="ring" viewBox="0 0 120 120" aria-hidden="true">
      <circle class="ring-track" cx="60" cy="60" r="${R}"/>
      <circle class="ring-value" cx="60" cy="60" r="${R}" style="stroke:${color};stroke-dasharray:${C.toFixed(1)};stroke-dashoffset:${(C * (1 - v / 100)).toFixed(1)}"/>
      ${tick}
    </svg>
    <div class="ring-label"><b>${num}${value === null ? "" : "<i>%</i>"}</b><span>с уваж.</span></div>
  </div>`;
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
  const t = Number(state.settings.target) || 0;
  const skip = canSkip(all);
  const marked = all.present + all.absent + all.excused;

  const sub = marked
    ? `${all.present} из ${marked} ${plural(marked, "занятия", "занятий", "занятий")} · строго <b>${fmtPct(strict)}</b>`
    : all.unmarked
      ? `пока нет отметок · прошло ${all.unmarked}`
      : "пока нет прошедших занятий";

  const pills = [];
  if (skip !== null) {
    pills.push(
      skip > 0
        ? `<span class="pill">можно пропустить ещё <b>${skip}</b></span>`
        : `<span class="pill warn">запаса нет — пропускать нельзя</span>`
    );
  }
  if (all.unmarked) pills.push(`<span class="pill neutral">${all.unmarked} без отметки</span>`);

  let html = `<div class="overall">
    <div class="overall-main">
      ${ringHtml(len, t)}
      <div class="overall-body">
        <div class="overall-title">Посещаемость${t ? ` <span class="goal">цель ${t}%</span>` : ""}</div>
        <div class="overall-sub">${sub}</div>
        ${pills.length ? `<div class="overall-pills">${pills.join("")}</div>` : ""}
      </div>
    </div>
  </div>`;

  const groups = subjectGroups();
  if (!groups.length) {
    body.innerHTML =
      html + `<div class="empty"><span class="emoji">📚</span><p>Пока нет занятий</p></div>`;
    return;
  }

  const cards = groups
    .map((g) => {
      const s = g.s;
      const p = pct(s.present, s.present + s.absent);
      const st = pct(s.present, s.present + s.absent + s.excused);
      const total = s.present + s.absent + s.excused + s.unmarked;
      const done = s.present + s.absent + s.excused;
      const sk = canSkip(s);
      const color = `hsl(${hue(g.id)} 62% 48%)`;
      const good = p !== null && (t <= 0 || p >= t);
      const pctColor = p === null ? "var(--muted)" : good ? "var(--green)" : "var(--red)";
      const w = p === null ? 0 : Math.max(3, Math.min(100, p));
      const footL = done
        ? `<b>${s.present}</b> из <b>${done}</b>${s.excused ? ` · строго ${fmtPct(st)}` : ""}${s.unmarked ? ` · ${s.unmarked} без отм.` : ""}`
        : `нет отметок · ${total} ${plural(total, "пара", "пары", "пар")}`;
      const footR =
        sk === null
          ? ""
          : sk > 0
            ? `запас <b>${sk}</b>`
            : `<span class="${p !== null && t > 0 && p < t ? "neg" : ""}">запас 0</span>`;
      return `<div class="subj" style="--c:${color}">
      <div class="subj-head">
        <div class="subj-name">${esc(g.name)}</div>
        <div class="subj-pct" style="color:${pctColor}">${fmtPct(p)}</div>
      </div>
      <div class="bar"><i style="width:${w}%;background:${pctColor}"></i>${t ? `<span class="tick" style="left:${Math.min(100, t)}%"></span>` : ""}</div>
      <div class="subj-foot"><span>${footL}</span><span>${footR}</span></div>
    </div>`;
    })
    .join("");

  body.innerHTML = html + `<div class="subj-grid">${cards}</div>`;
}

/* ---------------- render: all ---------------- */

const CHIP_LABELS = { all: "Все", unmarked: "Без отметки", missed: "Пропуски" };

function updateChips(base) {
  const counts = {
    all: base.length,
    unmarked: base.filter((e) => !rec(e.id)).length,
    missed: base.filter((e) => rec(e.id) === "absent" || rec(e.id) === "excused").length,
  };
  $$("#filters .chip").forEach((c) => {
    const n = counts[c.dataset.filter] || 0;
    c.textContent = CHIP_LABELS[c.dataset.filter] + (n ? ` ${n}` : "");
  });
}

function renderAll() {
  const body = $("#allBody");
  if (!state.schedule) {
    body.innerHTML = `<div class="empty"><p>Загружаю расписание…</p></div>`;
    return;
  }
  const today = mskToday();
  const yesterday = dayShiftIso(-1);
  const base = (state.schedule.events || []).filter(
    (e) => e.status !== "CANCELLED" && e.start.slice(0, 10) <= today && isPast(e)
  );
  updateChips(base);

  let list = base;
  if (state.filter === "unmarked") list = base.filter((e) => !rec(e.id));
  if (state.filter === "missed")
    list = base.filter((e) => rec(e.id) === "absent" || rec(e.id) === "excused");

  if (!list.length) {
    const none = state.filter === "unmarked";
    body.innerHTML = `<div class="empty"><span class="emoji">${none ? "✅" : "🔍"}</span><p>${
      none ? "Всё отмечено — так держать" : "Ничего не найдено"
    }</p></div>`;
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
      const rel = d === today ? "Сегодня" : d === yesterday ? "Вчера" : fmtDay(d);
      return `<div class="day-head">
          <h2>${rel}</h2>
          <div class="day-right">
            <span>${parts.join(" · ")}</span>
            ${unmarked ? `<button class="mini" data-day="${d}">Все были</button>` : ""}
          </div>
        </div>
        <div class="cards" style="margin-bottom:18px">${evs.map((e) => cardHtml(e)).join("")}</div>`;
    })
    .join("");

  const bulk =
    state.filter === "unmarked" && list.length
      ? `<div class="bulk"><button class="btn" id="bulkMark">Отметить все ${list.length} как «был»</button></div>`
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
  let unmarked = 0;
  if (state.schedule) {
    unmarked = (state.schedule.events || []).filter(
      (e) =>
        e.status !== "CANCELLED" &&
        e.start.slice(0, 10) <= today &&
        isPast(e) &&
        !rec(e.id)
    ).length;
  }

  const date = $("#todayDate");
  if (date) date.textContent = fmtDayShort(today);

  const label = $("#todayLabel");
  if (label) {
    label.textContent = `${unmarked} без отметки`;
    label.hidden = unmarked === 0;
  }

  const badge = $("#allBadge");
  if (badge) {
    badge.hidden = unmarked === 0;
    badge.textContent = unmarked > 99 ? "99+" : String(unmarked);
  }
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
  window.scrollTo(0, 0);
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

  const want = new URLSearchParams(location.search).get("tab");
  if (want && ["today", "subjects", "all", "more"].includes(want)) switchTab(want);

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
