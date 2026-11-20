"use strict";
/* JARVIS panel — zakładki na telefonie (poziomo). Dane: /api/dash (Przegląd) i /api/tab/<nazwa>. */

// ================================================================== podstawy
// Mostek z appki (WebView). W zwykłej przeglądarce go nie ma — strona działa bez niego.
const B = window.JarvisPanel || null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* bez pamięci */ } };
const dwa = (n) => String(n).padStart(2, "0");

const qToken = new URLSearchParams(location.search).get("token");
if (qToken) lsSet("panelToken", qToken);
const TOKEN = (B && B.token && B.token()) || qToken || lsGet("panelToken") || "";

async function api(path, method = "GET", body) {
  const opt = { method, headers: {} };
  if (method !== "GET") {
    opt.headers["Content-Type"] = "application/json";
    if (TOKEN) opt.headers["X-Panel-Token"] = TOKEN;
    opt.body = JSON.stringify(body ?? {});
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), method === "GET" ? 15000 : 130000);
  opt.signal = ctrl.signal;
  try {
    const r = await fetch(path, opt);
    const txt = await r.text();
    let d = null;
    try { d = txt ? JSON.parse(txt) : null; } catch { d = null; }
    if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
    return d;
  } finally { clearTimeout(t); }
}

let toastT = 0;
function toast(msg, zle = false) {
  const el = $("toast");
  el.textContent = msg; el.className = "widoczny" + (zle ? " zle" : "");
  clearTimeout(toastT); toastT = setTimeout(() => { el.className = ""; }, 3500);
}

function bateria() {
  if (!B || !B.battery) return null;
  try { return JSON.parse(B.battery()); } catch (e) { return null; }
}

// ================================================================== formatowanie
const st = (v) => (v === null || v === undefined ? "–" : `${Math.round(v)}°`);
const DNI_KROTKO = ["nd", "pn", "wt", "śr", "cz", "pt", "sb"];
const godzMin = (ts) => { const d = new Date(ts * 1000); return `${dwa(d.getHours())}:${dwa(d.getMinutes())}`; };
function bajty(b) {
  if (b === null || b === undefined) return "–";
  const j = ["B", "KB", "MB", "GB", "TB"]; let i = 0; let v = b;
  while (v >= 1024 && i < j.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${j[i]}`;
}
const predk = (b) => (b ? `${bajty(b)}/s` : "0");
function czasTrwania(s) {
  if (s === null || s === undefined || !isFinite(s)) return "–";
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sek = s % 60;
  return h ? `${h}:${dwa(m)}:${dwa(sek)}` : `${m}:${dwa(sek)}`;
}
function eta(s) {
  if (s === null || s === undefined || s < 0 || s >= 8640000) return "∞";
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  return `${Math.round(s / 86400)} d`;
}
function temuOd(ts) {
  if (!ts) return "";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 90) return "przed chwilą";
  if (s < 3600) return `${Math.round(s / 60)} min temu`;
  if (s < 86400) return `${Math.round(s / 3600)} h temu`;
  return `${Math.round(s / 86400)} d temu`;
}
function dataKrotko(iso) {
  const d = new Date(iso);
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const d1 = new Date(d); d1.setHours(0, 0, 0, 0);
  const r = Math.round((d1 - d0) / 86400e3);
  return r === 0 ? "dziś" : r === 1 ? "jutro" : r === -1 ? "wczoraj" : `${DNI_KROTKO[d.getDay()]} ${dwa(d.getDate())}.${dwa(d.getMonth() + 1)}`;
}
const KOL = { ok: "var(--ok)", uwaga: "var(--uwaga)", zle: "var(--zle)", pom: "var(--pom)", morski: "var(--morski)", akcent: "var(--akcent)", fiolet: "var(--fiolet)", brak: "var(--ramka)" };
const kolTemp = (t) => (t == null ? KOL.brak : t < 60 ? KOL.morski : t < 75 ? KOL.uwaga : KOL.pom);
const kolProc = (p) => (p == null ? KOL.brak : p < 60 ? KOL.morski : p < 85 ? KOL.uwaga : KOL.zle);
function kafel(et, wa, jedn = "", kolor = KOL.brak, pod = "", atrybuty = "", wykres = "") {
  return `<div class="kafel" style="--kolor:${kolor}" ${atrybuty}><div class="et">${esc(et)}</div>` +
    `<div class="wa">${esc(wa)}${jedn ? `<small>${esc(jedn)}</small>` : ""}</div>${wykres}${pod ? `<div class="pod">${esc(pod)}</div>` : ""}</div>`;
}
const WYKRESY_ATR = 'data-akcja="pc-wykresy"';
// mały wykres liniowy (ostatnie ~10 min z malinki); wartości poza [min, max] przycięte, braki pomijane
function spark(wart, min, max) {
  const v = wart.map((x, i) => [i, x]).filter(([, x]) => x != null);
  if (v.length < 2) return "";
  const n = wart.length - 1 || 1;
  const pkt = v.map(([i, x]) => `${(100 * i / n).toFixed(1)},${(20 - 20 * (Math.min(max, Math.max(min, x)) - min) / (max - min)).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 100 20" preserveAspectRatio="none"><polyline points="${pkt}"/></svg>`;
}
const pasek = (proc, kolor = KOL.akcent) => `<div class="pasek" style="--kolor:${kolor}"><i style="width:${Math.max(0, Math.min(100, proc || 0))}%"></i></div>`;
const pustoHtml = (t) => `<div class="pusto">${esc(t)}</div>`;
function zrodlo(z, nazwa) {
  // {ok, data|error} -> [dane, html_bledu]
  if (!z) return [null, pustoHtml(`${nazwa}: brak danych`)];
  if (!z.ok) return [null, `<div class="pusto zle-t mala">${esc(nazwa)}: ${esc(z.error)}</div>`];
  if (z.data && z.data.disabled) return [null, pustoHtml(`${nazwa}: nie skonfigurowano w .env panelu`)];
  return [z.data, ""];
}
const bodyAttr = (o) => `data-body="${esc(JSON.stringify(o))}"`;

// ================================================================== wygaszanie ekranu
let wakeMin = 2;
let awakeUntil = Date.now() + wakeMin * 60e3;
let forcedUntil = 0;
let sleeping = false;
let screenVer = null;

// Blokada „tapnięcia przez ekran": tuż po wybudzeniu (dotyk albo komenda z JARVIS-a) ignorujemy dotyk i kliknięcia,
// żeby przypadkowy dotyk w jeszcze ciemny ekran nie uśpił serwera ani nie zrestartował kontenera.
// Te nasłuchiwacze muszą być pierwsze na document (faza przechwytywania), przed resztą skryptu.
const BLOKADA_MS = 600;
let blokadaDo = 0;
for (const typ of ["pointerdown", "pointerup", "click", "mousedown", "mouseup"]) {
  document.addEventListener(typ, (e) => {
    if (Date.now() < blokadaDo) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
}

function goSleep() {
  if (sleeping) return;
  sleeping = true;
  blokadaDo = 0;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  $("sen").hidden = false;
  if (B) try { B.setSleep(true); } catch (e) { /* stara appka */ }
  zamknijWidok();
  if (aktywna !== "przeglad") przelacz("przeglad", false);
}
function wake(minuty) {
  awakeUntil = Math.max(awakeUntil, Date.now() + minuty * 60e3);
  if (!sleeping) return;
  sleeping = false;
  blokadaDo = Date.now() + BLOKADA_MS;
  $("sen").hidden = true;
  if (B) try { B.setSleep(false); } catch (e) { /* j.w. */ }
  odswiezTeraz();
}
$("sen").addEventListener("click", () => wake(wakeMin));
document.addEventListener("pointerdown", () => { if (!sleeping) wake(wakeMin); }, true);
document.addEventListener("keydown", () => { if (!sleeping) wake(wakeMin); }, true);

function zastosujEkran(s) {
  if (typeof s.wake_min === "number" && s.wake_min !== wakeMin) {
    // nowy czas wygaszania z /ekran auto minuty:N — obowiązuje od razu (krótszy skraca bieżące odliczanie)
    wakeMin = s.wake_min;
    awakeUntil = Math.min(awakeUntil, Date.now() + wakeMin * 60e3);
  }
  if (s.ver !== screenVer) {
    const pierwszy = screenVer === null;
    screenVer = s.ver;
    const untilMs = s.until ? Date.now() + (s.until - s.now) * 1000 : Infinity;
    if (s.mode === "on" && untilMs > Date.now()) { forcedUntil = untilMs; wake(wakeMin); }
    else if (s.mode === "sleep" && !pierwszy) { forcedUntil = 0; awakeUntil = 0; goSleep(); }
    else if (s.mode !== "on") forcedUntil = 0;
  }
  pokazAlert(s.alert);
}
async function pollScreen() {
  try { zastosujEkran(await api("/api/screen")); } catch (e) { /* offline pokazuje loadDash */ }
}

// Strumień zdarzeń z malinki (SSE): zmiana ekranu/alertu i stan Discorda dochodzą od razu. Gdy strumień nie działa,
// wracamy do odpytywania /api/screen co 3 s (gdy działa — tylko co 30 s, jako zapas).
let strumien = null;
let strumienZywy = false;
let strumienOstatni = 0;
function startStrumien() {
  if (!window.EventSource) return;
  try { if (strumien) strumien.close(); } catch (e) { /* j.w. */ }
  strumienOstatni = Date.now();
  strumien = new EventSource("/api/stream");
  const zywy = () => { strumienZywy = true; strumienOstatni = Date.now(); };
  strumien.addEventListener("ekran", (e) => { zywy(); try { zastosujEkran(JSON.parse(e.data)); } catch (err) { /* uszkodzone zdarzenie */ } });
  strumien.addEventListener("ping", zywy);
  strumien.addEventListener("discord", () => { zywy(); if (aktywna === "discord" && !sleeping) odswiezTeraz(); });
  // minutnik / przypomnienie głosowe: malinka już ustawiła alert (budzi ekran, baner) — tu sygnał i czytanie na głos
  strumien.addEventListener("przypomnienie", (e) => {
    zywy();
    let p = null;
    try { p = JSON.parse(e.data); } catch (err) { return; }
    wake(wakeMin);
    pikniecie();
    setTimeout(() => { if (B && B.mow) try { B.mow(p.mow || p.tekst); } catch (err) { /* stara appka */ } }, 900);
  });
  strumien.onerror = () => { strumienZywy = false; };  // EventSource łączy się ponownie sam
}
function pokazAlert(a) {
  const el = $("alert");
  if (!a) { el.hidden = true; return; }
  $("alert-tekst").textContent = a.text;
  el.className = a.level || "info";
  el.hidden = false;
}
$("alert-x").addEventListener("click", async () => {
  $("alert").hidden = true;
  try { await api("/api/alert/clear", "POST"); } catch (e) { toast("Nie udało się zamknąć alertu: " + e.message, true); }
});

// ================================================================== zakładki
const IK = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const TABS = {
  przeglad: { tytul: "Przegląd", co: 30000, ikona: IK('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>') },
  dzien: { tytul: "Dzień", co: 60000, ikona: IK('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>') },
  pc: { tytul: "Komputer", co: 3000, ikona: IK('<rect x="2" y="3" width="20" height="13" rx="2"/><path d="M8 21h8M12 16v5"/>') },
  muzyka: { tytul: "Muzyka", co: 2500, ikona: IK('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>') },
  discord: { tytul: "Discord", co: 5000, ikona: IK('<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><rect x="2" y="14" width="5" height="7" rx="1.5"/><rect x="17" y="14" width="5" height="7" rx="1.5"/>') },
  media: { tytul: "Media", co: 5000, ikona: IK('<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>') },
  serwery: { tytul: "Serwery", co: 5000, ikona: IK('<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>') },
  siec: { tytul: "Sieć", co: 15000, ikona: IK('<path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1"/>') },
  trening: { tytul: "Trening", co: 60000, ikona: IK('<path d="M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12"/>') },
  swiatlo: { tytul: "Światło", co: 5000, ikona: IK('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>') },
};
let aktywna = "przeglad";
const ostatnio = {};
const dane = {};
let blokadaRenderu = 0;   // podczas przesuwania suwaka nie przerysowujemy zakładki
let wczytywanie = {};

$("rail").innerHTML = Object.entries(TABS).map(([id, t]) =>
  `<button data-akcja="zakladka" data-tab="${id}" aria-label="${esc(t.tytul)}" class="${id === aktywna ? "aktywna" : ""}">${t.ikona}</button>`).join("");

function przelacz(id, odswiez = true) {
  if (!TABS[id]) return;
  zamknijWidok();
  aktywna = id;
  document.querySelectorAll("#rail button").forEach((b) => b.classList.toggle("aktywna", b.dataset.tab === id));
  $("tytul").textContent = TABS[id].tytul;
  $("naglowek-info").innerHTML = "";
  $("t-przeglad").hidden = id !== "przeglad";
  $("t-inne").hidden = id === "przeglad";
  if (id !== "przeglad") {
    $("t-inne").innerHTML = dane[id] ? "" : `<div class="pusto">Wczytuję…</div>`;
    if (dane[id]) renderuj(id, dane[id], true);
  }
  if (odswiez) odswiezTeraz();
}

function odswiezTeraz() { ostatnio[aktywna] = 0; petla(); }

async function wczytaj(id) {
  if (wczytywanie[id]) return;
  wczytywanie[id] = true;
  ostatnio[id] = Date.now();
  try {
    if (id === "przeglad") { await loadDash(); return; }
    const d = await api(`/api/tab/${id}`);
    $("offline").hidden = true;
    dane[id] = d;
    if (id === aktywna) renderuj(id, d);
  } catch (e) {
    $("offline").hidden = false;
  } finally { wczytywanie[id] = false; }
}

function renderuj(id, d, wymus = false) {
  if (!wymus && Date.now() < blokadaRenderu) return;
  const kont = $("t-inne");
  const przewiniecia = {};
  kont.querySelectorAll("[data-scroll]").forEach((el) => { przewiniecia[el.dataset.scroll] = el.scrollTop; });
  try {
    kont.innerHTML = RENDER[id](d);
  } catch (e) {
    kont.innerHTML = `<div class="pusto zle-t">Błąd rysowania zakładki: ${esc(e.message)}</div>`;
  }
  kont.querySelectorAll("[data-scroll]").forEach((el) => { if (przewiniecia[el.dataset.scroll]) el.scrollTop = przewiniecia[el.dataset.scroll]; });
  kont.querySelectorAll("input[type=range]").forEach(ustawTlo);
}

function petla() {
  if (sleeping) return;
  const t = TABS[aktywna];
  if (!ostatnio[aktywna] || Date.now() - ostatnio[aktywna] >= t.co) wczytaj(aktywna);
}

// ================================================================== Przegląd
const fmtData = new Intl.DateTimeFormat("pl-PL", { weekday: "long", day: "numeric", month: "long" });
function tick() {
  const d = new Date();
  const hm = `${dwa(d.getHours())}:${dwa(d.getMinutes())}`;
  $("zegar").textContent = hm;
  $("zegarek").textContent = hm;
  const txt = fmtData.format(d);
  $("data").textContent = txt.charAt(0).toUpperCase() + txt.slice(1);
  if (!sleeping && Date.now() > Math.max(awakeUntil, forcedUntil, minutnik.koniec ? minutnik.koniec + 60e3 : 0)) goSleep();
  tickMuzyka();
  tickMinutnik();
}

const WMO = {
  0: ["☀️", "Bezchmurnie"], 1: ["🌤️", "Przeważnie pogodnie"], 2: ["⛅", "Częściowe zachmurzenie"], 3: ["☁️", "Pochmurno"],
  45: ["🌫️", "Mgła"], 48: ["🌫️", "Mgła szronowa"], 51: ["🌦️", "Słaba mżawka"], 53: ["🌦️", "Mżawka"], 55: ["🌧️", "Gęsta mżawka"],
  56: ["🌧️", "Marznąca mżawka"], 57: ["🌧️", "Marznąca mżawka"], 61: ["🌦️", "Słaby deszcz"], 63: ["🌧️", "Deszcz"],
  65: ["🌧️", "Ulewa"], 66: ["🌧️", "Marznący deszcz"], 67: ["🌧️", "Marznący deszcz"], 71: ["🌨️", "Słaby śnieg"],
  73: ["🌨️", "Śnieg"], 75: ["❄️", "Intensywny śnieg"], 77: ["🌨️", "Ziarna śniegu"], 80: ["🌦️", "Przelotny deszcz"],
  81: ["🌧️", "Przelotne opady"], 82: ["⛈️", "Gwałtowne opady"], 85: ["🌨️", "Przelotny śnieg"], 86: ["❄️", "Śnieżyca"],
  95: ["⛈️", "Burza"], 96: ["⛈️", "Burza z gradem"], 99: ["⛈️", "Burza z gradem"],
};

function renderPogoda(p) {
  const el = $("pogoda");
  if (!p || !p.ok) { el.textContent = "Pogoda niedostępna"; el.className = "przyg"; return; }
  const w = p.data, [ik, opis] = WMO[w.code] || ["🌡️", ""];
  const ikona = w.code === 0 && w.is_day === 0 ? "🌙" : ik;
  const dzis = (w.days || [])[0] || {};
  const kolejne = (w.days || []).slice(1, 5).map((d) => {
    const dz = DNI_KROTKO[new Date(d.date + "T12:00").getDay()];
    return `<div class="dzien-mini"><span class="dz">${dz}</span><span class="ik">${(WMO[d.code] || ["", ""])[0]}</span>` +
      `<span class="mx">${st(d.max)}</span><span class="mn">${st(d.min)}</span><span class="pp ${d.pp >= 50 ? "mokro" : ""}">${d.pp ? d.pp + "%" : ""}</span></div>`;
  }).join("");
  el.className = "";
  el.innerHTML = `
    <div class="pogoda"><span class="ikona">${ikona}</span>
      <div><div class="temp">${st(w.temp)}</div><div class="opis">${esc(opis)} · odczuw. ${st(w.feels)}</div></div></div>
    <div class="dni"><span>dziś <b>${st(dzis.max)}</b>/${st(dzis.min)}${dzis.pp ? ` · opady ${dzis.pp}%` : ""}</span>
      <span>wiatr ${w.wind != null ? Math.round(w.wind) : "–"} km/h</span>
      <span>☀ ${esc(dzis.sunrise || "–")}–${esc(dzis.sunset || "–")}</span></div>
    <div class="dni-lista">${kolejne}</div>`;
}

function fmtTermin(due) {
  if (!due) return null;
  const [dzien, godz] = due.split("T");
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const d = new Date(dzien + "T00:00");
  const roznica = Math.round((d - d0) / 86400e3);
  const kiedy = new Date(due.length > 10 ? due : dzien + "T23:59");
  let tekst = roznica === 0 ? "dziś" : roznica === 1 ? "jutro" : roznica === -1 ? "wczoraj"
    : roznica > 1 && roznica < 7 ? DNI_KROTKO[d.getDay()] : `${dwa(d.getDate())}.${dwa(d.getMonth() + 1)}`;
  if (godz) tekst += " " + godz;
  return { tekst, klasa: kiedy < new Date() ? "po" : roznica === 0 ? "dzis" : "" };
}

function renderTodo(t) {
  const ul = $("lista");
  if (!t || !t.ok) { ul.innerHTML = `<li class="przyg">Lista TO DO nie odpowiada</li>`; $("todo-licznik").textContent = ""; return; }
  const zadania = t.data.tasks || [];
  $("todo-licznik").textContent = zadania.length ? String(zadania.length) : "";
  if (!zadania.length) { ul.innerHTML = `<li class="przyg">Nic do zrobienia 🎉</li>`; return; }
  ul.innerHTML = zadania.map((z) => {
    const tm = fmtTermin(z.due);
    return `<li data-id="${z.id}"><span class="ptaszek"></span><span class="t">${esc(z.title)}</span>${tm ? `<span class="termin ${tm.klasa}">${esc(tm.tekst)}</span>` : ""}</li>`;
  }).join("");
}
$("lista").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li || li.classList.contains("zrobione")) return;
  li.classList.add("zrobione");
  try { await api(`/api/todo/${li.dataset.id}`, "PATCH", { done: true }); setTimeout(loadDash, 1500); }
  catch (err) { li.classList.remove("zrobione"); toast("Nie odhaczono: " + err.message, true); }
});
$("nowe").addEventListener("submit", async (e) => {
  e.preventDefault();
  const inp = $("nowe-tytul"), title = inp.value.trim();
  if (!title) return;
  inp.disabled = true;
  try { await api("/api/todo", "POST", { title }); inp.value = ""; inp.blur(); toast("Dodano"); loadDash(); }
  catch (err) { toast("Nie dodano: " + err.message, true); }
  finally { inp.disabled = false; }
});

function ustaw(id, klasa, tekst) { $("k-" + id).className = "kropka " + klasa; $("v-" + id).textContent = tekst; }

function opisSerwera(s) {
  if (!s || !s.ok) return ["zle", "błąd sprawdzania", null];
  const x = s.data;
  if (x.disabled) return ["", "brak SERVER_IP w .env", null];
  if (x.up) return [x.n8n === false ? "uwaga" : "ok", `działa${x.since ? " od " + godzMin(x.since) : ""} · n8n ${x.n8n ? "OK" : "nie odpowiada"}`, true];
  if (x.waking_since) {
    const sek = Math.max(0, Math.round(Date.now() / 1000 - x.waking_since));
    return ["uwaga miga", `budzi się… ${Math.floor(sek / 60)}:${dwa(sek % 60)}`, false];
  }
  return ["", `śpi${x.since ? " od " + godzMin(x.since) : ""}`, false];
}

function opisKumy(k) {
  if (!k || !k.ok) return ["zle", "nie odpowiada"];
  if (k.data.disabled) return ["", "brak KUMA_API_KEY / KUMA_STATUS_SLUG"];
  if (k.data.down.length) return ["zle", `leży: ${k.data.down.join(", ")}`];
  if (k.data.pending.length) return ["uwaga", `oczekuje: ${k.data.pending.join(", ")}`];
  return ["ok", `wszystko OK (${k.data.up}/${k.data.total})`];
}

const STATUS_BATERII = { 2: "ładuje", 3: "rozładowuje", 4: "nie ładuje", 5: "pełna" };
function opisBaterii() {
  const b = bateria();
  if (!b) return ["", "przeglądarka (bez appki)"];
  const kl = b.temp > 42 ? "zle" : b.temp > 38 || (b.level < 20 && !b.plugged) ? "uwaga" : "ok";
  return [kl, `🔋 ${b.level}% · ${Math.round(b.temp)}°C · ${STATUS_BATERII[b.status] || "?"}${b.plugged ? "" : " · bez zasilacza!"}` +
    (b.kamera ? ` · 📷 ${b.kamera}` : "")];
}

function renderJarvis(d) {
  const [ks, ts, up] = opisSerwera(d.serwer);
  ustaw("serwer", ks, ts);
  $("b-wake").disabled = up === true;
  $("b-sleep").disabled = up === false;
  const m = d.malinka && d.malinka.ok ? d.malinka.data : {};
  ustaw("malinka", m.temp > 75 ? "zle" : m.temp > 65 ? "uwaga" : "ok",
    [m.load != null ? `load ${m.load.toFixed(2)}` : null, m.temp != null ? `${m.temp}°C` : null,
      m.mem_used_pct != null ? `RAM ${m.mem_used_pct}%` : null].filter(Boolean).join(" · ") || "działa");
  ustaw("kuma", ...opisKumy(d.kuma));
  renderBudzeniePc(d.pcs);
  renderGniazda(d.gniazda);
  $("odswiezone").textContent = godzMin(d.now);
  // czerwona kropka na pasku: coś leży w Kumie
  const zleKuma = d.kuma && d.kuma.ok && d.kuma.data.down && d.kuma.data.down.length;
  znacznik("serwery", zleKuma);
}

// Przegląd: przycisk „Obudź” dla każdego komputera z PCS (WoL); działający komputer = zielona kropka, przycisk nieaktywny
function renderBudzeniePc(w) {
  const el = $("pc-budzenie");
  const pcs = w && w.ok ? w.data : null;
  if (!Array.isArray(pcs) || !pcs.length) { el.innerHTML = ""; return; }
  if (el.querySelector(".potwierdz") || Date.now() < blokadaRenderu) return;
  el.innerHTML = pcs.map((p) => {
    const tekst = p.online ? `${esc(p.nazwa)} działa` : p.wol ? `Obudź ${esc(p.nazwa)}` : `${esc(p.nazwa)}: brak MAC`;
    return `<button data-akcja="pc-cmd" data-pc="${esc(p.id)}" data-cmd="wol" ${p.online || !p.wol ? "disabled" : ""}>` +
      `<span class="kropka ${p.online ? "ok" : ""}"></span>${tekst}</button>`;
  }).join("");
}

// Przegląd: zasilanie z przedłużaczy ESPHome (GNIAZDA w .env): „Włącz monitor” / „Wyłącz monitor”; zielona kropka = jest prąd
function renderGniazda(w) {
  const el = $("gniazda");
  const gn = w && w.ok ? w.data : null;
  if (!Array.isArray(gn) || !gn.length) { el.innerHTML = ""; return; }
  if (Date.now() < blokadaRenderu) return;
  el.innerHTML = gn.map((g) => {
    const tekst = !g.online ? `${esc(g.nazwa)}: przedłużacz offline` : `${g.on ? "Wyłącz" : "Włącz"} ${esc(g.nazwa.toLowerCase())}`;
    return `<button data-akcja="gniazdo" data-gniazdo="${esc(g.id)}" ${g.online ? "" : "disabled"}>` +
      `<span class="kropka ${g.on ? "ok" : ""}"></span>${tekst}</button>`;
  }).join("");
}

function znacznik(tab, wlacz) {
  const b = document.querySelector(`#rail button[data-tab="${tab}"]`);
  if (!b) return;
  let z = b.querySelector(".znacznik");
  if (wlacz && !z) { z = document.createElement("span"); z.className = "znacznik"; b.appendChild(z); }
  if (!wlacz && z) z.remove();
}

let dashTrwa = false;
let wersjaUi = null;   // skrót plików strony z pierwszego /api/dash po załadowaniu
async function loadDash() {
  if (dashTrwa) return;
  dashTrwa = true;
  try {
    const d = await api("/api/dash");
    $("offline").hidden = true;
    if (d.config && typeof d.config.wake_min === "number") wakeMin = d.config.wake_min;
    // nowa wersja strony na malince (wdrożenie) -> przeładuj, zamiast czekać na odświeżenie appki co 6 h
    if (d.config && d.config.ui) {
      if (wersjaUi && d.config.ui !== wersjaUi) { location.reload(); return; }
      wersjaUi = d.config.ui;
    }
    renderPogoda(d.pogoda); renderTodo(d.todo); renderJarvis(d);
  } catch (e) { $("offline").hidden = false; }
  finally { dashTrwa = false; }
}

// ================================================================== wspólne: wybór komputera
let wybranyPc = lsGet("pc") || "";
let pcRecznieDo = 0;   // świeży wybór chipem wygrywa z automatem (np. podgląd wyłączonego laptopa, żeby go obudzić)
function chipyPc(pcs, opisFn) {
  $("naglowek-info").innerHTML = `<div class="chipy">${pcs.map((p) =>
    `<button class="chip ${p.id === wybranyPc ? "aktywny" : ""}" data-akcja="wybierz-pc" data-pc="${esc(p.id)}">` +
    `<span class="kropka ${p.online ? "ok" : ""}"></span>${esc(p.nazwa)}${opisFn ? opisFn(p) : ""}</button>`).join("")}</div>`;
}
function wybierzPc(pcs, preferuj) {
  let pc = pcs.find((p) => p.id === wybranyPc);
  if (!pc || Date.now() >= pcRecznieDo) {
    if (preferuj) pc = pcs.find(preferuj) || pc;
    if (!pc || (!pc.online && pcs.some((p) => p.online))) pc = pcs.find((p) => p.online) || pc || pcs[0];
  }
  if (pc) wybranyPc = pc.id;
  return pc;
}
function pcOffline(pc) {
  return `<div class="siatka"><div class="karta" style="align-items:center;justify-content:center;text-align:center;gap:10px">
    <div style="font-size:40px">💤</div><div style="font-size:18px;font-weight:700">${esc(pc.nazwa)} jest offline</div>
    <div class="przyg mala">${esc(pc.error || "")}</div>
    ${pc.wol ? `<button class="glowny" style="width:220px" data-akcja="pc-cmd" data-pc="${esc(pc.id)}" data-cmd="wol">Obudź (Wake-on-LAN)</button>`
    : `<div class="przyg mala">Bez MAC w PCS — Wake-on-LAN niedostępny (laptop: włącz ręcznie)</div>`}</div></div>`;
}

// ================================================================== zakładki: rysowanie
const wynikiSpeedPc = {};
const RENDER = {};

RENDER.pc = (d) => {
  const [pcs, err] = zrodlo(d.pcs, "Komputery");
  if (!pcs) return err;
  if (!pcs.length) return pustoHtml("Brak komputerów — ustaw PCS i AGENT_TOKEN w .env panelu i zainstaluj agenta (pc-agent).");
  const pc = wybierzPc(pcs);
  chipyPc(pcs);
  if (!pc.online) return pcOffline(pc);
  const s = pc.stan || {}, cpu = s.cpu || {}, gpu = s.gpu || {}, a = pc.audio || {};
  const ramP = s.ramRazemGb ? (100 * s.ramUzyteGb) / s.ramRazemGb : null;
  const vramP = gpu.vramRazemMb ? (100 * gpu.vramUzyteMb) / gpu.vramRazemMb : null;
  const ping = s.pingMs;
  const sp = wynikiSpeedPc[pc.id];
  const hist = pc.historia || [], kol = (i) => hist.map((r) => r[i]);
  const kafle = [
    kafel("CPU", cpu.temp != null ? Math.round(cpu.temp) + "°" : "–", "", kolTemp(cpu.temp), cpu.nazwa || "", WYKRESY_ATR, spark(kol(3), 30, 100)),
    kafel("GPU", gpu.temp != null ? Math.round(gpu.temp) + "°" : "–", "", kolTemp(gpu.temp), gpu.nazwa || "", WYKRESY_ATR, spark(kol(4), 30, 100)),
    kafel("Moc", s.mocW != null ? Math.round(s.mocW) : "–", "W", KOL.morski, "CPU + GPU"),
    kafel("RAM", s.ramUzyteGb != null ? s.ramUzyteGb.toFixed(1) : "–", s.ramRazemGb ? `/${Math.round(s.ramRazemGb)} GB` : "GB", kolProc(ramP)),
    kafel("VRAM", gpu.vramUzyteMb != null ? (gpu.vramUzyteMb / 1024).toFixed(1) : "–", gpu.vramRazemMb ? `/${Math.round(gpu.vramRazemMb / 1024)} GB` : "GB", kolProc(vramP)),
    kafel("Ping", ping != null ? (ping < 10 ? ping.toFixed(1) : Math.round(ping)) : "–", "ms", ping == null ? KOL.zle : ping < 30 ? KOL.ok : ping < 80 ? KOL.uwaga : KOL.zle, "1.1.1.1"),
    kafel("CPU obc.", cpu.obciazenie != null ? Math.round(cpu.obciazenie) : "–", "%", kolProc(cpu.obciazenie), cpu.moc != null ? `${Math.round(cpu.moc)} W` : "", WYKRESY_ATR, spark(kol(1), 0, 100)),
    kafel("GPU obc.", gpu.obciazenie != null ? Math.round(gpu.obciazenie) : "–", "%", kolProc(gpu.obciazenie), gpu.moc != null ? `${Math.round(gpu.moc)} W` : "", WYKRESY_ATR, spark(kol(2), 0, 100)),
    kafel("Włączony", s.uptimeS != null ? eta(s.uptimeS) : "–", "", KOL.fiolet, "od startu Windows"),
  ].join("");
  const urz = (a.urzadzenia || []).map((u) =>
    `<button class="chip ${u.domyslne ? "aktywny" : ""}" data-akcja="pc-cmd" data-pc="${esc(pc.id)}" data-cmd="audio/wyjscie" ${bodyAttr({ id: u.id })}>${u.domyslne ? "🎧 " : ""}${esc(u.nazwa)}</button>`).join("");
  return `<div class="siatka pc-uklad">
    <div class="karta"><h2>Sprzęt i temperatury<span class="prawo">${esc(s.host || "")}</span></h2>
      <div class="kafle" style="grid-template-columns:repeat(3,1fr)">${kafle}</div>
      <div class="przyciski" style="margin-top:auto;padding-top:8px;grid-template-columns:auto auto 1fr">
        <button data-akcja="pc-cmd" data-pc="${esc(pc.id)}" data-cmd="speedtest" data-dlugie>⇅ Speedtest PC</button>
        <button data-akcja="pc-procesy">☰ Procesy ›</button>
        <div class="mala przyg" style="align-self:center">${sp ? `↓ ${sp.pobieranieMbps} · ↑ ${sp.wysylanieMbps} Mb/s${sp.pingMs != null ? ` · ${Math.round(sp.pingMs)} ms` : ""}` : "Test: 25 MB w dół, 10 MB w górę"}</div>
      </div></div>
    <div class="siatka" style="grid-template-rows:auto 1fr;gap:8px">
      <div class="karta"><h2>Dźwięk<span class="prawo">${a.glosnosc != null ? a.glosnosc + "%" : ""}</span></h2>
        <div class="chipy" style="margin-bottom:6px">${urz || '<span class="przyg mala">brak urządzeń</span>'}</div>
        <div class="suwak"><button data-akcja="pc-cmd" data-pc="${esc(pc.id)}" data-cmd="audio/wycisz" ${bodyAttr({})}>${a.wyciszony ? "🔇" : "🔊"}</button>
          <input type="range" min="0" max="100" value="${a.glosnosc ?? 0}" data-suwak="master" data-pc="${esc(pc.id)}"><span class="proc">${a.glosnosc ?? "–"}%</span></div>
      </div>
      <div class="karta"><h2>Zasilanie</h2>
        <div class="przyciski" style="flex:1">
          <button data-akcja="pc-cmd" data-pc="${esc(pc.id)}" data-cmd="zasilanie/uspij" data-potwierdz>🌙 Uśpij</button>
          <button class="groznie" data-akcja="pc-cmd" data-pc="${esc(pc.id)}" data-cmd="zasilanie/wylacz" data-potwierdz>⏻ Wyłącz</button>
          <button data-akcja="pc-cmd" data-pc="${esc(pc.id)}" data-cmd="zasilanie/restart" data-potwierdz>↻ Restart</button>
          <button data-akcja="pc-cmd" data-pc="${esc(pc.id)}" data-cmd="zasilanie/zablokuj">🔒 Zablokuj</button>
        </div></div>
    </div></div>`;
};

let muzykaStan = null; // do płynnego paska postępu między odświeżeniami
RENDER.muzyka = (d) => {
  const [pcs, err] = zrodlo(d.pcs, "Komputery");
  if (!pcs) return err;
  if (!pcs.length) return pustoHtml("Brak komputerów — ustaw PCS i AGENT_TOKEN w .env panelu.");
  const pc = wybierzPc(pcs, (p) => p.online && p.media && p.media.stan === "gra");
  chipyPc(pcs, (p) => (p.online && p.media && p.media.stan === "gra" ? " ▶" : ""));
  if (!pc.online) { muzykaStan = null; return pcOffline(pc); }
  const m = pc.media || {}, a = pc.audio || {};
  muzykaStan = m.dlugoscS ? { poz: m.pozycjaS || 0, dl: m.dlugoscS, gra: m.stan === "gra", t: Date.now() } : null;
  const okl = m.okladkaId ? `<img class="okladka" src="/api/pc/${encodeURIComponent(pc.id)}/okladka/${esc(m.okladkaId)}" alt="">` : `<div class="okladka">🎵</div>`;
  const cmd = (c, t, kl = "") => `<button class="${kl}" data-akcja="pc-cmd" data-pc="${esc(pc.id)}" data-cmd="media/${c}">${t}</button>`;
  const lewa = m.stan === "brak" || !m.tytul
    ? `<div class="karta" style="align-items:center;justify-content:center;gap:8px"><div style="font-size:44px">🎵</div><div class="przyg">Nic nie gra na ${esc(pc.nazwa)}</div>
        <div class="sterowanie">${cmd("poprzedni", "⏮")}${cmd("toggle", "⏯", "duzy")}${cmd("nastepny", "⏭")}</div></div>`
    : `<div class="karta"><h2>Teraz gra<span class="prawo">${esc(m.aplikacja || "")}</span></h2>
        <div style="display:flex;gap:14px;align-items:center;flex:1;min-height:0">${okl}
          <div style="flex:1;min-width:0"><div class="utwor">${esc(m.tytul)}</div><div class="wykonawca">${esc(m.wykonawca || "")}</div>
            <div class="przyg mala">${esc(m.album || "")}</div>
            ${muzykaStan ? `<div style="margin-top:10px">${pasek((100 * (m.pozycjaS || 0)) / m.dlugoscS)}<div class="czas-utworu"><span id="m-poz">${czasTrwania(m.pozycjaS)}</span><span>${czasTrwania(m.dlugoscS)}</span></div></div>` : ""}
            <div class="sterowanie">${cmd("poprzedni", "⏮")}${cmd("toggle", m.stan === "gra" ? "⏸" : "▶", "duzy")}${cmd("nastepny", "⏭")}</div>
          </div></div></div>`;
  const apki = (a.aplikacje || []).map((x) => `<div class="suwak" style="margin-bottom:4px">
      <button data-akcja="pc-cmd" data-pc="${esc(pc.id)}" data-cmd="audio/aplikacja" ${bodyAttr({ pid: x.pid, wyciszona: !x.wyciszona })}>${x.wyciszona ? "🔇" : x.aktywna ? "🔊" : "🔈"}</button>
      <span class="nazwa">${esc(x.nazwa)}</span>
      <input type="range" min="0" max="100" value="${x.glosnosc}" data-suwak="app" data-pc="${esc(pc.id)}" data-pid="${x.pid}"><span class="proc">${x.glosnosc}%</span></div>`).join("");
  return `<div class="siatka" style="grid-template-columns:1.25fr 1fr">${lewa}
    <div class="karta"><h2>Mikser<span class="prawo">${esc((a.urzadzenia || []).find((u) => u.domyslne)?.nazwa || "")}</span></h2>
      <div class="suwak" style="margin-bottom:8px"><button data-akcja="pc-cmd" data-pc="${esc(pc.id)}" data-cmd="audio/wycisz" ${bodyAttr({})}>${a.wyciszony ? "🔇" : "🔊"}</button>
        <span class="nazwa"><b>Główna</b></span><input type="range" min="0" max="100" value="${a.glosnosc ?? 0}" data-suwak="master" data-pc="${esc(pc.id)}"><span class="proc">${a.glosnosc ?? "–"}%</span></div>
      <div class="przewijane" data-scroll="mikser">${apki || pustoHtml("Żadna aplikacja nie gra")}</div></div></div>`;
};
function tickMuzyka() {
  if (aktywna !== "muzyka" || !muzykaStan || !muzykaStan.gra) return;
  const poz = Math.min(muzykaStan.dl, muzykaStan.poz + (Date.now() - muzykaStan.t) / 1000);
  const el = $("m-poz");
  if (el) {
    el.textContent = czasTrwania(poz);
    const bar = el.closest("div").previousElementSibling;
    if (bar && bar.firstElementChild) bar.firstElementChild.style.width = `${(100 * poz) / muzykaStan.dl}%`;
  }
}

RENDER.discord = (d) => {
  const dc = d.discord || {};
  const [pcs] = zrodlo(d.pcs, "Komputery");
  const online = (pcs || []).filter((p) => p.online);
  const maKanal = (p) => p.discord && p.discord.polaczony && p.discord.kanal;
  let pc = online.length ? wybierzPc(online) : null;
  // wybór komputera zostaje ręczny; 🔊 przy nazwie pokazuje, na którym jesteś teraz na kanale
  if (pcs && pcs.length) chipyPc(pcs, (p) => (maKanal(p) ? " 🔊" : ""));

  // Twój kanał (Discord RPC z agenta): działa na każdym serwerze, nie tylko tam, gdzie jest bot
  const rpcHtml = online.filter(maKanal).map((p) => {
    const k = p.discord.kanal;
    return `<div class="dzien-naglowek">🔊 ${esc(k.nazwa || "Rozmowa")} <span class="przyg" style="text-transform:none">· Ty na ${esc(p.nazwa)} · ${k.uczestnicy.length} os.</span></div>` +
      k.uczestnicy.map((o) => `<div class="osoba">${o.avatar ? `<img src="${esc(o.avatar)}" alt="" referrerpolicy="no-referrer">` : '<span class="awatar"></span>'}<span class="v">${esc(o.nazwa)}${o.bot ? ' <span class="etykieta">BOT</span>' : ""}</span>
        <span class="ikony">${o.mute ? '<span class="etykieta czerwona">🎙 off</span>' : ""}${o.deaf ? '<span class="etykieta czerwona">🎧 off</span>' : ""}</span></div>`).join("");
  }).join("");

  // serwery z botem (stan wypychany przez cogs/panel.py)
  let botHtml = "";
  if (dc.ts && (dc.kanaly || []).length) {
    botHtml = dc.kanaly.map((k) => `<div class="dzien-naglowek">🔊 ${esc(k.kanal)} <span class="przyg" style="text-transform:none">· ${esc(k.serwer)} · ${k.osoby.length} os.</span></div>` +
      k.osoby.map((o) => `<div class="osoba">${o.avatar ? `<img src="${esc(o.avatar)}" alt="" referrerpolicy="no-referrer">` : '<span class="awatar"></span>'}
        <span class="v">${esc(o.nazwa)}${o.bot ? ' <span class="etykieta">BOT</span>' : ""}</span>
        <span class="ikony">${o.stream ? '<span class="etykieta czerwona">LIVE</span>' : ""}${o.kamera ? "📷" : ""}${o.mute ? '<span class="etykieta czerwona">🎙 off</span>' : ""}${o.deaf ? '<span class="etykieta czerwona">🎧 off</span>' : ""}</span></div>`).join("")).join("");
    if (rpcHtml) botHtml = '<div class="przyg mala" style="margin:10px 0 4px">Serwery z botem</div>' + botHtml;
  }

  let lewa = rpcHtml + botHtml;
  if (!lewa) {
    const rpcDziala = online.some((p) => p.discord && p.discord.polaczony);
    if (rpcDziala) lewa = pustoHtml("Nie siedzisz na żadnym kanale głosowym.");
    else if (!dc.ts) lewa = pustoHtml("Brak danych: uruchom Discorda z włączonym RPC w agencie albo dodaj cogs/panel.py do bota.");
    else lewa = pustoHtml("Nikt nie siedzi na kanałach głosowych.");
  }

  let prawa;
  if (pc) {
    const r = pc.discord && pc.discord.polaczony ? pc.discord : null;
    const kl = (v) => (r ? (v ? "wylaczony" : "wlaczony") : "");
    const opis = r
      ? `Sterowanie przez Discord RPC na ${esc(pc.nazwa)}${r.kanal ? "" : " · nie jesteś na kanale głosowym"}.`
      : pc.discord && pc.discord.wlaczony
        ? `Discord RPC na ${esc(pc.nazwa)}: ${esc(pc.discord.status || "niepołączony")} — działają skróty z agent.json.`
        : `Przełącza wyciszenie w Discordzie na ${esc(pc.nazwa)} (skróty z agent.json).`;
    prawa = `<div class="duze-przyciski" style="flex:1">
        <button class="${kl(r && r.mute)}" data-akcja="pc-cmd" data-pc="${esc(pc.id)}" data-cmd="discord/mikrofon">🎙️<div class="mala">${r ? (r.mute ? "wyciszony" : "włączony") : "mikrofon"}</div></button>
        <button class="${kl(r && r.deaf)}" data-akcja="pc-cmd" data-pc="${esc(pc.id)}" data-cmd="discord/sluchawki">🎧<div class="mala">${r ? (r.deaf ? "ogłuszony" : "słyszysz") : "słuchawki"}</div></button></div>
       ${r && r.kanal ? `<button class="groznie" style="margin-top:8px;min-height:56px;width:100%" data-akcja="pc-cmd" data-pc="${esc(pc.id)}" data-cmd="discord/rozlacz">📞 Rozłącz z kanału</button>` : ""}
       <div class="przyg mala" style="margin-top:6px">${opis}</div>`;
  } else {
    prawa = pustoHtml("Żaden komputer z agentem nie jest online.");
  }
  return `<div class="siatka" style="grid-template-columns:1.5fr 1fr">
    <div class="karta"><h2>Kanały głosowe<span class="prawo">${dc.ts ? temuOd(dc.ts) : ""}</span></h2><div class="przewijane" data-scroll="dc">${lewa}</div></div>
    <div class="karta"><h2>Sterowanie</h2>${prawa}</div></div>`;
};

function serwerSpi(s) {
  const [kl, txt] = opisSerwera(s);
  return `<div class="siatka"><div class="karta" style="align-items:center;justify-content:center;text-align:center;gap:10px">
    <div style="font-size:40px">💤</div><div style="font-size:18px;font-weight:700">Serwer ${esc(txt)}</div>
    <div class="przyg mala">Media, Glances i Paperless są na serwerze — panel ich nie budzi.</div>
    <button class="glowny" style="width:200px" data-akcja="serwer" data-cmd="wake" ${kl.includes("miga") ? "disabled" : ""}>Obudź serwer</button></div></div>`;
}

const STANY_ARR = { downloading: "pobiera", importPending: "czeka na import", importing: "importuje", imported: "zaimportowane",
  failedPending: "błąd", failed: "błąd", queued: "w kolejce", paused: "pauza", completed: "pobrane", delay: "opóźnione", warning: "uwaga" };
RENDER.media = (d) => {
  if (!d.media) return serwerSpi(d.serwer);
  const [m, err] = zrodlo(d.media, "Media");
  if (!m) return err;
  const [q, eq] = zrodlo(m.qbit, "qBittorrent"), [so, es] = zrodlo(m.sonarr, "Sonarr"), [ra, er] = zrodlo(m.radarr, "Radarr"), [jf, ej] = zrodlo(m.jellyfin, "Jellyfin");
  const torr = q ? (q.torrenty.length ? q.torrenty.map((t) => `<div class="wiersz" style="display:block">
      <div style="display:flex;gap:6px;align-items:center"><span class="v" style="flex:1">${esc(t.nazwa)}</span>
        <button class="maly" data-akcja="qbit" data-hash="${esc(t.hash)}" data-cmd="${t.pauza ? "start" : "stop"}">${t.pauza ? "▶" : "⏸"}</button></div>
      ${pasek(100 * (t.postep || 0), t.postep >= 1 ? KOL.ok : KOL.akcent)}
      <div class="mala przyg">${esc(t.stan)} · ${Math.floor(100 * (t.postep || 0))}% z ${bajty(t.rozmiar)}${t.dl ? ` · ↓ ${predk(t.dl)} · ${eta(t.eta)}` : ""}</div></div>`).join("") : pustoHtml("Nic się nie pobiera")) : eq;
  const kolejka = [...(so ? so.kolejka.map((x) => ({ ...x, ik: "📺" })) : []), ...(ra ? ra.kolejka.map((x) => ({ ...x, ik: "🎬" })) : [])];
  const nadch = [...(so ? so.nadchodzace.map((x) => ({ ...x, ik: "📺" })) : []), ...(ra ? ra.nadchodzace.map((x) => ({ ...x, ik: "🎬" })) : [])]
    .filter((x) => x.kiedy).sort((a, b) => String(a.kiedy).localeCompare(String(b.kiedy))).slice(0, 12);
  const sr = (kolejka.length ? kolejka.map((x) => `<div class="wiersz" style="display:block"><div class="v">${x.ik} ${esc(x.tytul)} ${esc(x.odc || "")}</div>
      ${x.postep != null ? pasek(100 * x.postep) : ""}<div class="mala przyg">${esc(STANY_ARR[x.stan] || x.stan || "")}${x.eta ? ` · zostało ${esc(x.eta)}` : ""}</div></div>`).join("") : pustoHtml("Kolejka pusta")) +
    `<div class="dzien-naglowek">Nadchodzące</div>` +
    (nadch.length ? nadch.map((x) => `<div class="wiersz"><span class="v">${x.ik} ${esc(x.tytul)} ${esc(x.odc || "")}</span><span class="etykieta ${x.jest ? "zielona" : ""}">${esc(dataKrotko(x.kiedy))}</span></div>`).join("") : pustoHtml("Nic w najbliższych dniach")) + es + er;
  const jelly = jf ? `<div class="dzien-naglowek">Teraz ogląda</div>${jf.teraz.length ? jf.teraz.map((x) => `<div class="wiersz" style="display:block"><div class="v">${x.pauza ? "⏸" : "▶"} ${esc(x.serial ? x.serial + " — " : "")}${esc(x.tytul)}</div>
      ${x.postep != null ? pasek(100 * x.postep, KOL.fiolet) : ""}<div class="mala przyg">${esc(x.kto || "")} · ${esc(x.urzadzenie || "")}</div></div>`).join("") : pustoHtml("Nikt nie ogląda")}
      <div class="dzien-naglowek">Ostatnio dodane</div>${jf.ostatnie.map((x) => `<div class="wiersz"><span class="v">${x.typ === "Episode" ? "📺" : "🎬"} ${esc(x.serial ? x.serial + " — " : "")}${esc(x.tytul)}</span>${x.rok ? `<span class="k mala">${x.rok}</span>` : ""}</div>`).join("") || pustoHtml("—")}` : ej;
  return `<div class="siatka" style="grid-template-columns:1.15fr 1fr 1fr">
    <div class="karta"><h2>Pobieranie<span class="prawo">${q ? `↓ ${predk(q.dl)} · ↑ ${predk(q.ul)}` : ""}</span></h2><div class="przewijane" data-scroll="qb">${torr}</div></div>
    <div class="karta"><h2>Sonarr / Radarr</h2><div class="przewijane" data-scroll="arr">${sr}</div></div>
    <div class="karta"><h2>Jellyfin</h2><div class="przewijane" data-scroll="jf">${jelly}</div></div></div>`;
};

RENDER.serwery = (d) => {
  const [ks, ts, up] = opisSerwera(d.serwer);
  let srw = `<div class="wiersz"><span class="kropka ${ks}"></span><span class="v zawijaj">${esc(ts)}</span></div>`;
  const [g, eg] = d.glances ? zrodlo(d.glances, "Glances") : [null, ""];
  if (g) {
    srw += `<div class="kafle" style="grid-template-columns:repeat(4,1fr);margin:6px 0">
      ${kafel("CPU", g.cpu != null ? Math.round(g.cpu) : "–", "%", kolProc(g.cpu))}
      ${kafel("Temp", g.cpu_temp != null ? Math.round(g.cpu_temp) + "°" : "–", "", kolTemp(g.cpu_temp))}
      ${kafel("RAM", g.ram != null ? Math.round(g.ram) : "–", "%", kolProc(g.ram))}
      ${kafel("Load", g.load != null ? g.load.toFixed(1) : "–", "", KOL.morski, g.rdzenie ? `${g.rdzenie} rdz.` : "")}</div>`;
    srw += (g.gpu || []).map((x) => `<div class="wiersz"><span class="k">GPU</span><span class="v">${esc(x.nazwa)}</span><span class="mala">${x.proc != null ? Math.round(x.proc) + "%" : ""} ${x.temp != null ? Math.round(x.temp) + "°C" : ""} ${x.mem != null ? "VRAM " + Math.round(x.mem) + "%" : ""}</span></div>`).join("");
    srw += (g.dyski || []).map((x) => `<div style="margin:3px 0"><div class="mala" style="display:flex;justify-content:space-between"><span>${esc(x.mnt)}</span><span class="przyg">${bajty(x.uzyte)} / ${bajty(x.razem)}</span></div>${pasek(x.proc, kolProc(x.proc))}</div>`).join("");
    srw += `<div class="dzien-naglowek">Zasoby kontenerów (${(g.kontenery || []).length})</div>` + (g.kontenery || []).map((c) => {
      const okc = /running|healthy/i.test(c.status || "");
      return `<div class="wiersz"><span class="kropka ${okc ? "ok" : "zle"}"></span><span class="v">${esc(c.nazwa)}</span><span class="k mala">${c.cpu != null ? c.cpu.toFixed(1) + "%" : ""} ${c.ram ? bajty(c.ram) : ""}</span></div>`;
    }).join("");
  } else srw += eg;
  const przyciskiSerwera = `<div class="przyciski" style="grid-template-columns:1fr 1fr 1fr;margin-top:6px;flex:none">
    <button class="glowny" data-akcja="serwer" data-cmd="wake" ${up ? "disabled" : ""}>Obudź</button>
    <button class="groznie" data-akcja="serwer" data-cmd="sleep" data-potwierdz ${up === false ? "disabled" : ""}>Uśpij</button>
    <button data-akcja="serwer" data-cmd="reboot" data-potwierdz ${up === false ? "disabled" : ""}>Restart</button></div>`;
  const [m] = zrodlo(d.malinka, "Malinka");
  const mm = m || {};
  const [kb, tb] = opisBaterii();
  const hb = d.panel && d.panel.ts ? temuOd(d.panel.ts) : "brak";
  const malinkaHtml = `<div class="kafle" style="grid-template-columns:1fr 1fr">
      ${kafel("Temp", mm.temp != null ? Math.round(mm.temp) + "°" : "–", "", kolTemp(mm.temp))}
      ${kafel("Load", mm.load != null ? mm.load.toFixed(2) : "–", "", KOL.morski)}
      ${kafel("RAM", mm.mem_used_pct ?? "–", "%", kolProc(mm.mem_used_pct), mm.mem_total_gb ? `z ${mm.mem_total_gb} GB` : "")}
      ${kafel("Dysk", mm.dysk_pct ?? "–", "%", kolProc(mm.dysk_pct), "SSD")}</div>
    <div class="wiersz" style="margin-top:6px"><span class="k">Uptime</span><span class="v">${mm.uptime_s ? eta(mm.uptime_s) : "–"}</span></div>
    ${dockerSkrot(d.docker)}
    <div class="dzien-naglowek">Telefon (panel)</div>
    <div class="wiersz"><span class="kropka ${kb}"></span><span class="v zawijaj">${esc(tb)}</span></div>
    <div class="wiersz"><span class="k">Sygnał</span><span class="v">${esc(hb)}</span></div>`;
  const [k, ek] = zrodlo(d.kuma, "Uptime Kuma");
  const kumaHtml = k ? k.monitory.map((x) => `<div class="wiersz"><span class="kropka ${x.stan === "up" ? "ok" : x.stan === "down" ? "zle" : "uwaga"}"></span><span class="v">${esc(x.nazwa)}</span>${/backup/i.test(x.nazwa) ? '<span class="etykieta">backup</span>' : ""}</div>`).join("") : ek;
  return `<div class="siatka" style="grid-template-columns:1.25fr .9fr 1fr">
    <div class="karta"><h2>Serwer<span class="prawo">${g && g.uptime ? "up " + esc(g.uptime) : ""}</span></h2><div class="przewijane" data-scroll="srw">${srw}</div>${przyciskiSerwera}</div>
    <div class="karta"><h2>Malinka</h2><div class="przewijane" data-scroll="mal">${malinkaHtml}</div></div>
    <div class="karta"><h2>Uptime Kuma<span class="prawo">${k ? `${k.up}/${k.total} OK` : ""}</span></h2><div class="przewijane" data-scroll="kuma">${kumaHtml}</div></div></div>`;
};

// jakość sygnału (typowe progi dla 5G/LTE)
const kolRsrp = (v) => (v == null ? KOL.brak : v >= -80 ? KOL.ok : v >= -90 ? KOL.morski : v >= -100 ? KOL.uwaga : KOL.zle);
const kolSinr = (v) => (v == null ? KOL.brak : v >= 20 ? KOL.ok : v >= 13 ? KOL.morski : v >= 0 ? KOL.uwaga : KOL.zle);
const TYP_SIECI = { ENDC: "5G NSA", SA: "5G SA", "LTE-NSA": "5G NSA", LTE: "4G LTE", "LTE-A": "4G LTE-A", WCDMA: "3G", GSM: "2G" };

RENDER.siec = (d) => {
  const [z, ez] = zrodlo(d.zte, "Router ZTE");
  let zte = ez;
  if (z) {
    const typ = TYP_SIECI[String(z.siec || "").toUpperCase()] || z.siec || "?";
    zte = `<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:6px"><span style="font-size:26px;font-weight:800">${esc(typ)}</span>
        <span class="etykieta">${esc(z.pasmo ? "pasmo " + z.pasmo : "")}</span><span class="przyg mala">${esc(z.operator || "")}</span></div>
      <div class="kafle" style="grid-template-columns:1fr 1fr">
        ${kafel("5G RSRP", z.nr.rsrp ?? "–", "dBm", kolRsrp(z.nr.rsrp))}${kafel("5G SINR", z.nr.sinr ?? "–", "dB", kolSinr(z.nr.sinr))}
        ${kafel("LTE RSRP", z.lte.rsrp ?? "–", "dBm", kolRsrp(z.lte.rsrp), z.pasmo_lte ? "pasmo " + z.pasmo_lte : "")}${kafel("LTE SINR", z.lte.sinr ?? "–", "dB", kolSinr(z.lte.sinr))}</div>
      <div class="wiersz" style="margin-top:6px"><span class="k">Teraz</span><span class="v">↓ ${predk(z.rx)} · ↑ ${predk(z.tx)}</span></div>
      <div class="wiersz"><span class="k">Miesiąc</span><span class="v">↓ ${bajty(z.miesiac_rx)} · ↑ ${bajty(z.miesiac_tx)}</span></div>
      <div class="wiersz"><span class="k">Temp.</span><span class="v">${[z.temp.modem != null ? `modem ${Math.round(z.temp.modem)}°` : null, z.temp["5g"] != null ? `5G ${Math.round(z.temp["5g"])}°` : null].filter(Boolean).join(" · ") || "–"}</span></div>
      ${z.zalogowany ? "" : '<div class="mala uwaga-t">Router nie zalogowany — sprawdź ZTE_PASS</div>'}`;
  }
  const [a, ea] = zrodlo(d.adguard, "AdGuard");
  const ad = a ? `<div class="kafle" style="grid-template-columns:1fr 1fr 1fr">
      ${kafel("Zapytań", a.zapytania > 9999 ? Math.round(a.zapytania / 1000) + "k" : a.zapytania, "", KOL.akcent)}
      ${kafel("Blok.", Math.round(a.proc), "%", KOL.pom, `${a.zablokowane}`)}${kafel("Czas", Math.round(a.czas_ms), "ms", KOL.morski)}</div>
    <div class="dzien-naglowek">Kto pyta (24 h)</div>${a.klienci.map((k) => `<div class="wiersz"><span class="v">${esc(k.nazwa || k.ip)}</span><span class="k mala">${k.nazwa ? esc(k.ip) + " · " : ""}${k.n}</span></div>`).join("") || pustoHtml("—")}
    <div class="dzien-naglowek">Najczęściej blokowane</div>${a.blokowane.map((k) => `<div class="wiersz"><span class="v mala">${esc(k.domena)}</span><span class="k mala">${k.n}</span></div>`).join("") || pustoHtml("—")}` : ea;
  const s = d.speedtest;
  const sp = `<div class="kafle" style="grid-template-columns:1fr 1fr 1fr">
      ${kafel("Ping", s ? s.ping : "–", "ms", KOL.morski)}${kafel("Pobier.", s ? Math.round(s.dol) : "–", "Mb/s", KOL.ok)}${kafel("Wysył.", s ? Math.round(s.gora) : "–", "Mb/s", KOL.fiolet)}</div>
    <div class="przyg mala" style="margin:6px 0">${s ? "Ostatni test " + temuOd(s.ts) : "Jeszcze nie testowano"} · z malinki przez ZTE (25 MB ↓, 10 MB ↑)</div>
    <button class="glowny" data-akcja="speedtest-malinka" data-dlugie style="margin-top:auto">⇅ Testuj łącze</button>`;
  return `<div class="siatka" style="grid-template-columns:1.1fr 1fr .9fr">
    <div class="karta"><h2>Router 5G (ZTE)<span class="prawo">${z && z.kreski != null ? "▂▄▆█".slice(0, Math.max(1, Math.min(4, z.kreski))) : ""}</span></h2><div class="przewijane" data-scroll="zte">${zte}</div></div>
    <div class="karta"><h2>AdGuard</h2><div class="przewijane" data-scroll="ag">${ad}</div></div>
    <div class="karta"><h2>Speedtest</h2>${sp}</div></div>`;
};

// ------------------------------------------------------------------ Trening + minutnik przerw
const minutnik = { koniec: null, dl: 90, zagrany: false };
RENDER.trening = (d) => {
  $("naglowek-info").innerHTML = `<button class="maly" data-akcja="serwer" data-cmd="sync" data-dlugie>⟳ Synchronizuj treningi</button>`;
  const [t, et] = zrodlo(d.trening, "Trener");
  if (!t) return et + minutnikHtml();
  const tydz = `<div class="tydzien">${t.dni.map((x) => `<div class="dzien ${x.dzis ? "dzis" : ""}"><div class="d">${esc(x.dzien)} ${esc(x.date.slice(8))}</div>
      <div class="p">${x.plan.map((p) => p.ikona).join("") || "·"}</div>
      <div class="z">${x.zrobione.length ? "✔ " + esc(x.zrobione.map((z) => z.km ? `${z.km.toFixed(1)} km` : z.typ).join(", ")) : ""}</div></div>`).join("")}</div>`;
  const dzis = t.dni.find((x) => x.dzis) || { plan: [], zrobione: [] };
  const plan = dzis.plan.length ? dzis.plan.map((p) => `<div style="margin-bottom:6px"><div style="font-weight:700">${p.ikona} ${esc(p.tytul)}${p.min ? ` <span class="przyg mala">${p.min} min</span>` : ""}</div>
      <div class="mala przyg">${esc(p.opis)}</div>
      ${(p.sila || []).map((c) => `<div class="wiersz"><span class="v">${esc(c.nazwa)}</span><span class="k mala">${c.serie ? c.serie + "×" : ""}${esc(c.powt || "")}${c.kg ? ` @ ${c.kg} kg` : ""}</span></div>`).join("")}</div>`).join("")
    : pustoHtml(t.podsumowanie ? "Dziś odpoczynek" : "Brak planu na ten tydzień — ułóż go w appce trener");
  const c = t.cele || {}, pd = c.podciaganie || {}, pm = c.polmaraton || {};
  const w = t.wellness;
  const cele = `<div class="mala" style="display:flex;justify-content:space-between"><span>🏋️ Podciąganie</span><span>${pd.powt ?? "–"} / ${pd.cel ?? "–"} powt.</span></div>${pasek(pd.powt && pd.cel ? Math.min(100, (100 * pd.powt) / pd.cel) : 0, KOL.pom)}
    <div class="mala" style="display:flex;justify-content:space-between;margin-top:6px"><span>🏃 Półmaraton (prognoza)</span><span>${pm.sek ? czasTrwania(pm.sek) : "–"} / ${czasTrwania(pm.cel)}</span></div>${pasek(pm.sek ? Math.min(100, (100 * pm.cel) / pm.sek) : 0, KOL.ok)}
    ${w ? `<div class="mala przyg" style="margin-top:6px">${[w.senH ? `🛌 ${w.senH.toFixed(1)} h` : null, w.hrSpocz ? `❤️ ${w.hrSpocz}` : null, w.hrv ? `HRV ${Math.round(w.hrv)}` : null, w.waga ? `⚖️ ${w.waga} kg` : null].filter(Boolean).join(" · ")}</div>` : ""}`;
  return `<div style="display:flex;flex-direction:column;gap:8px;height:100%">${tydz}
    <div class="siatka" style="grid-template-columns:1.3fr 1fr;flex:1;min-height:0">
      <div class="karta"><h2>Dziś<span class="prawo">${dzis.zrobione.length ? "✔ zrobione" : ""}</span></h2><div class="przewijane" data-scroll="tr">${plan}</div></div>
      <div class="siatka" style="grid-template-rows:1fr auto;gap:8px">${minutnikHtml()}<div class="karta"><h2>Cele</h2>${cele}</div></div></div></div>`;
};
function minutnikHtml() {
  return `<div class="karta"><h2>Przerwa<span class="prawo" id="mn-dl">${minutnik.dl} s</span></h2>
    <div class="minutnik" id="mn-czas">${minutnik.koniec ? "" : czasTrwania(minutnik.dl)}</div>
    <div class="chipy" style="justify-content:center;margin-top:4px">${[60, 90, 120, 180, 240].map((s) =>
      `<button class="chip maly ${minutnik.dl === s ? "aktywny" : ""}" data-akcja="minutnik" data-s="${s}">${s >= 120 ? s / 60 + " min" : s + " s"}</button>`).join("")}
      <button class="chip maly" data-akcja="minutnik" data-s="0">■</button></div></div>`;
}
let audioCtx = null;
function pikniecie() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach((o) => {
      const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
      osc.frequency.value = 880; osc.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.25, audioCtx.currentTime + o); g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + o + 0.2);
      osc.start(audioCtx.currentTime + o); osc.stop(audioCtx.currentTime + o + 0.2);
    });
  } catch (e) { /* bez dźwięku */ }
}
function tickMinutnik() {
  const el = $("mn-czas");
  if (!minutnik.koniec) { if (el) el.classList.remove("koniec"); return; }
  const zostalo = (minutnik.koniec - Date.now()) / 1000;
  if (zostalo <= 0 && !minutnik.zagrany) { minutnik.zagrany = true; pikniecie(); wake(1); }
  if (zostalo < -30) { minutnik.koniec = null; }
  if (el) { el.textContent = zostalo > 0 ? czasTrwania(Math.ceil(zostalo)) : "Seria!"; el.classList.toggle("koniec", zostalo <= 0); }
}

RENDER.swiatlo = (d) => {
  const [w, ew] = zrodlo(d.wled, "Pasek LED");
  if (!w) {
    return `<div class="siatka"><div class="karta" style="align-items:center;justify-content:center;text-align:center;gap:8px">
      <div style="font-size:40px">💡</div><div style="font-size:16px;font-weight:700">Pasek LED jeszcze niepodłączony</div>
      <div class="przyg mala" style="max-width:460px">Wgraj WLED na płytkę ESP8266 (README-esp.md), potem wpisz jej adres do WLED_URL w .env panelu.</div>${ew}</div></div>`;
  }
  const KOLORY = [[255, 255, 255], [255, 180, 107], [255, 120, 40], [255, 0, 0], [255, 0, 128], [160, 0, 255], [0, 80, 255], [0, 200, 255], [0, 255, 120], [255, 220, 0]];
  const proc = Math.round((100 * (w.bri || 0)) / 255);
  return `<div class="siatka" style="grid-template-columns:1fr 1.2fr">
    <div class="karta"><h2>${esc(w.nazwa || "WLED")}<span class="prawo">${esc(w.wersja || "")}</span></h2>
      <button class="${w.on ? "glowny" : ""}" style="min-height:70px;font-size:20px" data-akcja="led" ${bodyAttr({ on: !w.on })}>${w.on ? "💡 Włączony" : "⚫ Wyłączony"}</button>
      <div class="suwak" style="margin-top:12px"><span class="nazwa">Jasność</span><input type="range" min="1" max="255" value="${w.bri || 128}" data-suwak="led-bri"><span class="proc">${proc}%</span></div>
      <div class="dzien-naglowek" style="margin-top:10px">Presety</div>
      <div class="chipy">${w.presety.map((p) => `<button class="chip ${w.ps === p.id ? "aktywny" : ""}" data-akcja="led" ${bodyAttr({ ps: p.id })}>${esc(p.nazwa)}</button>`).join("") || '<span class="przyg mala">brak presetów</span>'}</div></div>
    <div class="karta"><h2>Kolor</h2><div class="kolory">${KOLORY.map((k) =>
      `<button style="background:rgb(${k.join(",")})" class="${w.kolor && w.kolor.join() === k.join() ? "aktywny" : ""}" data-akcja="led" ${bodyAttr({ kolor: k })}></button>`).join("")}</div></div></div>`;
};

RENDER.dzien = (d) => {
  const [kal, ekal] = zrodlo(d.kalendarz, "Kalendarz");
  let kalHtml = ekal;
  if (kal === null && !ekal) kalHtml = pustoHtml("Kalendarz: brak danych (serwer jeszcze nie działał od startu panelu)");
  if (kal) {
    let ostatni = "";
    kalHtml = (kal.wydarzenia || []).map((w) => {
      const dz = dataKrotko(w.start);
      const nag = dz !== ostatni ? `<div class="dzien-naglowek">${esc(dz)}</div>` : "";
      ostatni = dz;
      const s = new Date(w.start), k = w.koniec ? new Date(w.koniec) : null;
      const godz = w.caly_dzien ? "cały dzień" : `${dwa(s.getHours())}:${dwa(s.getMinutes())}${k ? "–" + dwa(k.getHours()) + ":" + dwa(k.getMinutes()) : ""}`;
      return `${nag}<div class="wiersz"><span class="k mala" style="width:78px">${esc(godz)}</span><span class="v zawijaj">${esc(w.tytul)}${w.miejsce ? ` <span class="przyg mala">· ${esc(w.miejsce)}</span>` : ""}</span></div>`;
    }).join("") || pustoHtml("Nic w kalendarzu na 7 dni");
  }
  const kalInfo = kal ? (kal.aktualne ? "" : `stan z ${godzMin(kal.ts)} · serwer śpi`) : "";
  const [pp, epp] = zrodlo(d.paperless, "Paperless");
  let fakt = epp || (pp === null ? pustoHtml("Paperless: brak danych") : "");
  if (pp) {
    fakt = (pp.faktury || []).map((f) => {
      const kl = f.dni < 0 ? "czerwona" : f.dni <= 2 ? "zolta" : "";
      const txt = f.dni < 0 ? `${-f.dni} d po terminie` : f.dni === 0 ? "dziś" : f.dni === 1 ? "jutro" : `za ${f.dni} d`;
      return `<div class="wiersz"><span class="v zawijaj">${esc(f.tytul)}${f.kwota ? ` <b>${esc(f.kwota)}</b>` : ""}</span><span class="etykieta ${kl}">${esc(txt)}</span></div>`;
    }).join("") || pustoHtml("Wszystko zapłacone 🎉");
  }
  const [po, epo] = zrodlo(d.poczta, "Poczta");
  const paczki = po && (po.paczki || []).length ? `<div class="dzien-naglowek">📦 Paczki do odbioru</div>` + po.paczki.map((p) =>
    `<div class="wiersz"><span class="v zawijaj"><b>${esc(p.od)}</b>${p.kod ? ` · kod <b style="font-size:16px;letter-spacing:.06em">${esc(p.kod)}</b>` : ""}` +
    `<br><span class="mala przyg">${esc(temuOd(p.ts))}</span></span>` +
    `<button class="maly" data-akcja="paczka-odebrana" data-id="${esc(p.id)}">Odebrana ✓</button></div>`).join("") +
    `<div class="dzien-naglowek">Ważne maile</div>` : "";
  const poczta = po ? paczki + (po.wazne.length ? po.wazne.map((m) => `<div class="wiersz" style="display:block"><div class="v"><b>${esc(m.od)}</b></div><div class="v mala">${esc(m.temat)}</div>
      <div class="mala przyg">${esc(m.konto)} · ${esc(temuOd(m.ts))}</div></div>`).join("") : pustoHtml("Brak ważnych nieprzeczytanych 🎉")) +
    (po.zalegle.length ? `<div class="dzien-naglowek">Z nocy</div>` + po.zalegle.map((m) => `<div class="wiersz"><span class="v"><b>${esc(m.od)}</b> — ${esc(m.temat)}</span></div>`).join("") : "") +
    `<div class="mala przyg" style="margin-top:6px">Pominięte (promocje itp.): ${po.pominiete} — w porannym briefie</div>` : epo;
  return `<div class="siatka" style="grid-template-columns:1.2fr 1fr 1fr">
    <div class="karta"><h2>Kalendarz<span class="prawo">${esc(kalInfo)}</span></h2><div class="przewijane" data-scroll="kal">${kalHtml}</div></div>
    <div class="karta"><h2>Faktury do zapłaty<span class="prawo">${pp && !pp.aktualne ? `stan z ${godzMin(pp.ts)}` : ""}</span></h2><div class="przewijane" data-scroll="pp">${fakt}</div></div>
    <div class="karta"><h2>Ważne maile</h2><div class="przewijane" data-scroll="mail">${poczta}</div></div></div>`;
};

// ================================================================== widoki szczegółowe: pogoda, kontenery Dockera
// Nakładka na obszar treści (pasek zakładek zostaje). Otwiera ją dotknięcie kafla pogody i przycisk w Serwerach.
let widok = null;       // {id, dane, kontener: {host, nazwa, restart}|null, logi, ost, laduje}
const WIDOK = {};

function otworzWidok(id) {
  widok = { id, dane: null, kontener: null, logi: null, ost: 0, laduje: false };
  $("widok").hidden = false;
  rysujWidok(true);
  wczytajWidok();
}
function zamknijWidok() {
  widok = null;
  $("widok").hidden = true;
  $("widok-tresc").innerHTML = "";
}
function widokWstecz() {
  if (widok && widok.kontener) { widok.kontener = null; widok.logi = null; rysujWidok(true); wczytajWidok(); }
  else zamknijWidok();
}

async function wczytajWidok() {
  if (!widok || widok.laduje) return;
  const w = widok;
  w.laduje = true;
  w.ost = Date.now();
  try {
    if (w.kontener) {
      const k = w.kontener;
      // logi + świeża lista (stan kontenera w nagłówku, np. po restarcie)
      const [r, lista] = await Promise.all([
        api(`/api/docker/${encodeURIComponent(k.host)}/${encodeURIComponent(k.nazwa)}/logi`, "POST", { tail: 100 }),
        api(`/api/tab/${w.id}`).catch(() => null)]);
      if (lista) w.dane = lista;
      if (widok === w && w.kontener === k) w.logi = r.logi || "(brak logów)";
    } else {
      w.dane = await api(`/api/tab/${w.id}`);
    }
    $("offline").hidden = true;
  } catch (e) {
    if (w.kontener) w.logi = "Nie udało się pobrać logów: " + e.message;
    else $("offline").hidden = false;
  } finally { w.laduje = false; }
  if (widok === w) rysujWidok();
}

function rysujWidok(wymus = false) {
  if (!widok) return;
  if (!wymus && Date.now() < blokadaRenderu) return;  // trwa potwierdzenie „Na pewno?" albo przesuwanie suwaka
  const def = WIDOK[widok.id];
  const kont = $("widok-tresc");
  const prz = {};
  kont.querySelectorAll("[data-scroll]").forEach((el) => { prz[el.dataset.scroll] = [el.scrollTop, el.scrollTop + el.clientHeight >= el.scrollHeight - 12]; });
  $("widok-tytul").textContent = def.tytul(widok);
  $("widok-info").textContent = widok.dane && widok.dane.now ? "odśw. " + godzMin(widok.dane.now) : "";
  try { kont.innerHTML = widok.dane ? def.html(widok) : pustoHtml("Wczytuję…"); }
  catch (e) { kont.innerHTML = `<div class="pusto zle-t">Błąd rysowania widoku: ${esc(e.message)}</div>`; }
  kont.querySelectorAll("[data-scroll]").forEach((el) => {
    const p = prz[el.dataset.scroll];
    if (p) el.scrollTop = el.dataset.dol && p[1] ? el.scrollHeight : p[0];
    else if (el.dataset.dol) el.scrollTop = el.scrollHeight;
  });
}

// ---------- pogoda
const KIERUNKI = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const kierunek = (deg) => (deg == null ? "" : KIERUNKI[Math.round(deg / 45) % 8]);
const kolUv = (u) => (u == null ? KOL.brak : u >= 8 ? KOL.zle : u >= 6 ? KOL.pom : u >= 3 ? KOL.uwaga : KOL.ok);

WIDOK.pogoda = {
  tytul: () => "Pogoda",
  co: 300000,
  html(w) {
    const [p, err] = zrodlo(w.dane.pogoda, "Pogoda");
    if (!p) return `<div class="karta">${err}</div>`;
    const dni = p.dni || [];
    const dzis = dni[0] || {};
    const [ik, opis] = WMO[p.code] || ["🌡️", ""];
    const ikona = p.code === 0 && p.is_day === 0 ? "🌙" : ik;
    const obecna = `<div class="pogoda"><span class="ikona">${ikona}</span>
        <div><div class="temp">${st(p.temp)}</div><div class="opis">${esc(opis)} · odczuw. ${st(p.feels)}</div></div></div>`;
    const kafle = `<div class="kafle" style="grid-template-columns:1fr 1fr;margin-top:8px">
      ${kafel("Wilgotność", p.wilg ?? "–", "%", KOL.morski)}
      ${kafel("Ciśnienie", p.cisnienie != null ? Math.round(p.cisnienie) : "–", "hPa", KOL.akcent)}
      ${kafel("Wiatr", p.wiatr != null ? Math.round(p.wiatr) : "–", "km/h", KOL.akcent,
        [kierunek(p.kierunek), p.porywy != null ? `porywy ${Math.round(p.porywy)}` : ""].filter(Boolean).join(" · "))}
      ${kafel("Opady", p.opad ?? 0, "mm", KOL.morski, dzis.opad != null ? `dziś ${dzis.opad} mm` : "")}
      ${kafel("UV", dzis.uv != null ? Math.round(dzis.uv) : "–", "", kolUv(dzis.uv), "dziś maks.")}
      ${kafel("Wschód", dzis.sunrise || "–", "", KOL.uwaga, `zachód ${dzis.sunset || "–"}`)}</div>`;
    const noc = (g) => {
      const d = dni.find((x) => x.date === g.data);
      return !!d && !!d.sunrise && !!d.sunset && (g.t < d.sunrise || g.t >= d.sunset);
    };
    const godz = (p.godziny || []).map((g) => {
      const [i] = WMO[g.code] || ["🌡️"];
      const ikG = (g.code === 0 || g.code === 1) && noc(g) ? "🌙" : i;
      return `<div class="godz"><div class="g">${esc(g.t)}</div><div class="i">${ikG}</div><b>${st(g.temp)}</b>` +
        `<div class="pp ${g.pp >= 50 ? "mokro" : ""}">${g.pp ? g.pp + "%" : "&nbsp;"}</div></div>`;
    }).join("");
    const mn = Math.min(...dni.map((x) => x.min ?? 99)), mx = Math.max(...dni.map((x) => x.max ?? -99));
    const zakres = Math.max(1, mx - mn);
    const wiersze = dni.map((x) => {
      const [i] = WMO[x.code] || ["🌡️"];
      const l = (100 * ((x.min ?? mn) - mn)) / zakres, sz = Math.max(4, (100 * ((x.max ?? mx) - (x.min ?? mn))) / zakres);
      return `<div class="dzien-pog"><span class="dt">${esc(dataKrotko(x.date))}</span><span class="ik">${i}</span>
        <span class="mn">${st(x.min)}</span><span class="zakres"><i style="left:${l.toFixed(1)}%;width:${sz.toFixed(1)}%"></i></span><span class="mx">${st(x.max)}</span>
        <span class="pp ${x.pp >= 50 ? "mokro" : ""}">${x.pp ? x.pp + "%" : ""}</span>
        <span class="wi">${x.wiatr != null ? Math.round(x.wiatr) : "–"} km/h</span><span class="uv" style="color:${kolUv(x.uv)}">UV ${x.uv != null ? Math.round(x.uv) : "–"}</span></div>`;
    }).join("");
    return `<div class="siatka" style="grid-template-columns:1fr 1.7fr">
      <div class="karta"><h2>Teraz</h2><div class="przewijane" data-scroll="pg-t">${obecna}${kafle}</div></div>
      <div style="display:grid;grid-template-rows:auto minmax(0,1fr);gap:8px;min-height:0">
        <div class="karta"><h2>Najbliższe 24 godziny</h2><div class="godziny" data-scroll="pg-g">${godz}</div></div>
        <div class="karta"><h2>7 dni</h2><div class="przewijane" data-scroll="pg-d">${wiersze}</div></div></div></div>`;
  },
};

// ---------- wykresy CPU/GPU komputera (historia ~10 min z malinki, próbka co 5 s)
const WYKRES_OKNO_S = 600;
function wykresDuzy(hist, serie, min, max, jedn, krok) {
  if (hist.length < 2) return pustoHtml("Zbieram dane… (pierwsze punkty po kilkunastu sekundach)");
  const koniec = hist[hist.length - 1][0], start = koniec - WYKRES_OKNO_S;
  const x = (t) => ((100 * (t - start)) / WYKRES_OKNO_S).toFixed(2);
  const y = (v) => (100 - (100 * (Math.min(max, Math.max(min, v)) - min)) / (max - min)).toFixed(2);
  let siatka = "", oy = "";
  for (let v = min; v <= max; v += krok) {
    siatka += `<line class="linia-s" x1="0" x2="100" y1="${y(v)}" y2="${y(v)}"/>`;
    oy += `<div class="oy" style="top:${y(v)}%">${v}${jedn}</div>`;
  }
  const ox = [10, 5, 0].map((m) => `<div class="ox" style="left:${x(koniec - m * 60)}%">${m ? "−" + m + " min" : "teraz"}</div>`).join("");
  const linie = serie.map((s) => {
    // przerwa > 15 s (np. agent nie odpowiadał) = przerwana linia
    const odcinki = [];
    let biez = [], ost = null;
    for (const r of hist) {
      const v = r[s.i];
      if (v == null || (ost != null && r[0] - ost > 15)) { if (biez.length > 1) odcinki.push(biez); biez = []; }
      if (v != null) biez.push(`${x(r[0])},${y(v)}`);
      ost = r[0];
    }
    if (biez.length > 1) odcinki.push(biez);
    return odcinki.map((o) => `<polyline style="stroke:${s.kolor}" points="${o.join(" ")}"/>`).join("");
  }).join("");
  return `<div class="wykres"><svg viewBox="0 0 100 100" preserveAspectRatio="none">${siatka}${linie}</svg>${oy}${ox}</div>`;
}
function statyWykresu(hist, s, jedn) {
  const v = hist.map((r) => r[s.i]).filter((x) => x != null);
  if (!v.length) return `<span class="leg" style="--kolor:${s.kolor}">${esc(s.nazwa)}: brak czujnika</span>`;
  const sr = v.reduce((a, b) => a + b, 0) / v.length;
  return `<span class="leg" style="--kolor:${s.kolor}">${esc(s.nazwa)} <b>${Math.round(v[v.length - 1])}${jedn}</b>` +
    ` · śr. ${Math.round(sr)} · maks. ${Math.round(Math.max(...v))}</span>`;
}
WIDOK.pc = {
  tytul: (w) => {
    const pcs = (w.dane && w.dane.pcs && w.dane.pcs.data) || [];
    const pc = pcs.find((p) => p.id === wybranyPc);
    return "Wykresy" + (pc ? " — " + pc.nazwa : "");
  },
  co: 5000,
  html(w) {
    const [pcs, err] = zrodlo(w.dane.pcs, "Komputery");
    if (!pcs) return `<div class="karta">${err}</div>`;
    const pc = pcs.find((p) => p.id === wybranyPc) || pcs.find((p) => p.online);
    if (!pc || !pc.online) return `<div class="karta">${pustoHtml("Komputer jest offline — brak bieżących danych.")}</div>`;
    const h = pc.historia || [];
    const obc = [{ i: 1, nazwa: "CPU", kolor: KOL.akcent }, { i: 2, nazwa: "GPU", kolor: KOL.fiolet }];
    const tmp = [{ i: 3, nazwa: "CPU", kolor: KOL.akcent }, { i: 4, nazwa: "GPU", kolor: KOL.fiolet }];
    return `<div class="siatka" style="grid-template-rows:1fr 1fr">
      <div class="karta"><h2>Obciążenie — ostatnie 10 min<span class="prawo">${obc.map((s) => statyWykresu(h, s, "%")).join("")}</span></h2>
        ${wykresDuzy(h, obc, 0, 100, "%", 25)}</div>
      <div class="karta"><h2>Temperatury<span class="prawo">${tmp.map((s) => statyWykresu(h, s, "°")).join("")}</span></h2>
        ${wykresDuzy(h, tmp, 30, 100, "°", 10)}</div></div>`;
  },
};

// ---------- najcięższe procesy na PC (agent 1.1+), kończenie z potwierdzeniem „Na pewno?”
const ramTxt = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : Math.round(mb) + " MB");
function wierszProcesu(pcId, p, wartosc) {
  const nazwa = `${esc(p.nazwa)}${p.liczba > 1 ? ` <span class="przyg">×${p.liczba}</span>` : ""}`;
  const zakoncz = (pid, etykieta) => `<button class="maly groznie" data-akcja="pc-cmd" data-pc="${esc(pcId)}" data-cmd="procesy/zakoncz" ` +
    `${bodyAttr(pid ? { nazwa: p.nazwa, pid } : { nazwa: p.nazwa })} data-potwierdz>${etykieta}</button>`;
  const przyciski = p.chroniony ? `<span class="przyg mala">chroniony</span>`
    : p.liczba > 1 ? zakoncz(p.glownyPid, "Jedną") + zakoncz(null, `Wszystkie ×${p.liczba}`) : zakoncz(p.glownyPid, "Zakończ");
  return `<div class="wiersz"><span class="v zawijaj">${nazwa}</span><span class="k" style="white-space:nowrap">${wartosc}</span>` +
    `<span style="display:flex;gap:4px;flex:none">${przyciski}</span></div>`;
}
WIDOK.procesy = {
  tytul: (w) => {
    const pcs = (w.dane && w.dane.pcs && w.dane.pcs.data) || [];
    const pc = pcs.find((p) => p.id === wybranyPc);
    return "Procesy" + (pc ? " — " + pc.nazwa : "");
  },
  co: 3000,
  html(w) {
    const [pcs, err] = zrodlo(w.dane.pcs, "Komputery");
    if (!pcs) return `<div class="karta">${err}</div>`;
    const pc = pcs.find((p) => p.id === wybranyPc) || pcs.find((p) => p.online);
    if (!pc || !pc.online || !pc.procesy) return `<div class="karta">${pustoHtml((pc && pc.error) || "Komputer jest offline.")}</div>`;
    const pr = pc.procesy;
    const cpu = (pr.cpu || []).map((p) => wierszProcesu(pc.id, p, `${p.cpu.toFixed(1)}%`)).join("");
    const ram = (pr.ram || []).map((p) => wierszProcesu(pc.id, p, ramTxt(p.ramMb))).join("");
    return `<div class="siatka" style="grid-template-columns:1fr 1fr">
      <div class="karta"><h2>Najwięcej CPU<span class="prawo">100% = wszystkie ${pr.rdzenie || ""} wątki</span></h2>
        <div class="przewijane" data-scroll="pr-cpu">${cpu || pustoHtml("brak danych")}</div></div>
      <div class="karta"><h2>Najwięcej RAM</h2><div class="przewijane" data-scroll="pr-ram">${ram || pustoHtml("brak danych")}</div></div></div>`;
  },
};

// ---------- kontenery Dockera
const STAN_KONT = { running: "działa", exited: "zatrzymany", restarting: "restartuje się", paused: "pauza", created: "utworzony", dead: "martwy" };
const ZDROWIE = { healthy: "zdrowy", unhealthy: "niezdrowy", starting: "startuje" };
function statusKrotki(s) {
  let t = String(s || "");
  const ex = t.match(/^Exited \((-?\d+)\)\s*(.*?)\s*(?:ago)?$/);
  if (ex) return `kod ${ex[1]}${ex[2] ? " · " + statusKrotki(ex[2]) : ""}`;
  t = t.replace(/\s*\(.*?\)/g, "").replace(/^Up\s+/, "od ").replace(/\s+ago$/, "")
    .replace(/About an? hour/, "~1 h").replace(/About an? minute/, "~1 min").replace(/Less than a second/, "<1 s")
    .replace(/(\d+) seconds?/, "$1 s").replace(/(\d+) minutes?/, "$1 min").replace(/(\d+) hours?/, "$1 h")
    .replace(/(\d+) days?/, "$1 d").replace(/(\d+) weeks?/, "$1 tyg.").replace(/(\d+) months?/, "$1 mies.");
  return t;
}
function kolKont(c) { return c.ok ? (c.zdrowie === "starting" ? "uwaga" : "ok") : (c.stan === "running" || c.stan === "restarting" ? "uwaga" : "zle"); }

function dockerSkrot(z) {
  const [x, err] = zrodlo(z, "Docker");
  if (!x) return `<div class="dzien-naglowek">Kontenery</div>${err}`;
  const wiersze = (x.hosty || []).map((h) => {
    if (h.spi) return `<div class="wiersz"><span class="kropka"></span><span class="v">${esc(h.nazwa)}</span><span class="k mala">serwer śpi</span></div>`;
    if (h.error) return `<div class="wiersz"><span class="kropka zle"></span><span class="v zawijaj">${esc(h.nazwa)}: brak połączenia z proxy Dockera</span></div>`;
    const zle = h.kontenery.filter((c) => !c.ok);
    return `<div class="wiersz"><span class="kropka ${zle.length ? "zle" : "ok"}"></span><span class="v zawijaj">${esc(h.nazwa)}: ${h.kontenery.length - zle.length}/${h.kontenery.length} OK${zle.length ? " · " + zle.map((c) => esc(c.nazwa)).join(", ") : ""}</span></div>`;
  }).join("");
  return `<div class="dzien-naglowek">Kontenery</div>${wiersze}<button class="maly" style="width:100%;margin-top:4px" data-akcja="docker-otworz">Zarządzaj kontenerami ›</button>`;
}

WIDOK.docker = {
  tytul: (w) => (w.kontener ? w.kontener.nazwa : "Kontenery Dockera"),
  co: 5000,
  html(w) {
    const [x, err] = zrodlo(w.dane.docker, "Docker");
    if (!x) return `<div class="karta">${err}</div>`;
    if (w.kontener) return widokLogi(w, x);
    const hosty = x.hosty || [];
    return `<div class="siatka" style="grid-template-columns:repeat(${Math.max(1, hosty.length)},1fr)">${hosty.map((h) => {
      let tresc;
      if (h.spi) tresc = pustoHtml("Serwer śpi — panel go nie budzi.");
      else if (h.error) tresc = `<div class="pusto zle-t mala">${esc(h.error)}</div>`;
      else tresc = h.kontenery.map((c) => `<div class="wiersz kont">
          <span class="kropka ${kolKont(c)}"></span>
          <span class="v" title="${esc(c.obraz)}">${esc(c.nazwa)}</span>
          <span class="k mala st">${esc(STAN_KONT[c.stan] || c.stan)}${c.zdrowie && c.zdrowie !== "healthy" ? " · " + esc(ZDROWIE[c.zdrowie]) : ""}${c.stan === "running" ? " " + esc(statusKrotki(c.status)) : ""}</span>
          <button class="maly" data-akcja="docker-logi" data-host="${esc(h.id)}" data-nazwa="${esc(c.nazwa)}" data-restart="${c.restart ? 1 : 0}">Logi</button></div>`).join("") || pustoHtml("Brak kontenerów");
      const ok = h.kontenery.filter((c) => c.ok).length;
      return `<div class="karta"><h2>${esc(h.nazwa)}<span class="prawo">${h.spi || h.error ? "" : `${ok}/${h.kontenery.length}`}${h.rw ? "" : " · tylko podgląd"}</span></h2>
        <div class="przewijane" data-scroll="dk-${esc(h.id)}">${tresc}</div></div>`;
    }).join("")}</div>`;
  },
};

function widokLogi(w, x) {
  const k = w.kontener;
  const h = (x.hosty || []).find((y) => y.id === k.host);
  const c = h && (h.kontenery || []).find((y) => y.nazwa === k.nazwa);
  const stan = c ? `${STAN_KONT[c.stan] || c.stan}${c.zdrowie ? " · " + ZDROWIE[c.zdrowie] : ""}${c.stan === "running" ? " " + statusKrotki(c.status) : ""}` : "nie ma go na liście";
  const restart = k.restart && c ? `<button class="groznie maly" data-akcja="docker-restart" data-host="${esc(k.host)}" data-nazwa="${esc(k.nazwa)}" data-potwierdz data-dlugie>↻ Restart</button>`
    : `<span class="mala przyg">restart wyłączony</span>`;
  return `<div class="siatka" style="grid-template-columns:1fr"><div class="karta">
      <h2><span>${esc(h ? h.nazwa : k.host)} · ${esc(stan)}</span><span class="prawo">${restart}</span></h2>
      <pre class="logi przewijane" data-scroll="logi" data-dol="1">${w.logi == null ? "Wczytuję logi…" : esc(w.logi)}</pre></div></div>`;
}

// ================================================================== akcje (delegowane)
async function akcjaPost(btn, path, body, poSukcesie) {
  const dlugie = btn && btn.hasAttribute("data-dlugie");
  const tekst = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; if (dlugie) btn.innerHTML = "Trwa…"; }
  try {
    const r = await api(path, "POST", body || {});
    if (poSukcesie) poSukcesie(r); else if (r && r.msg) toast(r.msg);
  } catch (e) { toast(e.message, true); }
  finally {
    if (btn && btn.isConnected) { btn.disabled = false; if (dlugie) btn.innerHTML = tekst; }
    setTimeout(odswiezTeraz, 400);
  }
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-akcja]");
  if (!b || b.disabled) return;
  if (b.hasAttribute("data-potwierdz") && !b.classList.contains("potwierdz")) {
    b.dataset.tekst = b.innerHTML;
    b.classList.add("potwierdz"); b.innerHTML = "Na pewno?";
    blokadaRenderu = Date.now() + 4000;
    setTimeout(() => { if (b.isConnected && b.classList.contains("potwierdz")) { b.classList.remove("potwierdz"); b.innerHTML = b.dataset.tekst; } }, 4000);
    return;
  }
  if (b.classList.contains("potwierdz")) { b.classList.remove("potwierdz"); b.innerHTML = b.dataset.tekst; blokadaRenderu = 0; }
  let body = {};
  try { body = b.dataset.body ? JSON.parse(b.dataset.body) : {}; } catch { body = {}; }
  switch (b.dataset.akcja) {
    case "zakladka": przelacz(b.dataset.tab); break;
    case "ekran-off": forcedUntil = 0; awakeUntil = 0; goSleep(); break;
    case "sluchaj":
      if (B && B.sluchaj) B.sluchaj(); else toast("Mikrofon działa tylko w appce na telefonie", true);
      break;
    case "serwer": akcjaPost(b, `/api/serwer/${b.dataset.cmd}`); break;
    case "gniazdo": akcjaPost(b, `/api/gniazdo/${encodeURIComponent(b.dataset.gniazdo)}/toggle`); break;
    case "wybierz-pc": wybranyPc = b.dataset.pc; pcRecznieDo = Date.now() + 10 * 60 * 1000; lsSet("pc", wybranyPc); if (dane[aktywna]) renderuj(aktywna, dane[aktywna], true); odswiezTeraz(); break;
    case "pc-cmd":
      akcjaPost(b, `/api/pc/${encodeURIComponent(b.dataset.pc)}/${b.dataset.cmd}`, body, (r) => {
        if (b.dataset.cmd === "speedtest") { wynikiSpeedPc[b.dataset.pc] = r; toast(`PC: ↓ ${r.pobieranieMbps} · ↑ ${r.wysylanieMbps} Mb/s`); }
        else if (r && r.msg) toast(r.msg);
      });
      break;
    case "pogoda-otworz": otworzWidok("pogoda"); break;
    case "pc-wykresy": otworzWidok("pc"); break;
    case "pc-procesy": otworzWidok("procesy"); break;
    case "paczka-odebrana": akcjaPost(b, `/api/paczka/${encodeURIComponent(b.dataset.id)}/odebrana`, {}, (r) => { toast(r.msg); odswiezTeraz(); }); break;
    case "docker-otworz": otworzWidok("docker"); break;
    case "widok-wstecz": widokWstecz(); break;
    case "docker-logi":
      if (widok) { widok.kontener = { host: b.dataset.host, nazwa: b.dataset.nazwa, restart: b.dataset.restart === "1" }; widok.logi = null; rysujWidok(true); wczytajWidok(); }
      break;
    case "docker-restart":
      akcjaPost(b, `/api/docker/${encodeURIComponent(b.dataset.host)}/${encodeURIComponent(b.dataset.nazwa)}/restart`, {}, (r) => {
        toast(r.msg || "Restart wysłany");
        setTimeout(() => { if (widok) { widok.ost = 0; wczytajWidok(); } }, 3000);
      });
      break;
    case "qbit": akcjaPost(b, `/api/media/qbit/${b.dataset.hash}/${b.dataset.cmd}`); break;
    case "speedtest-malinka": akcjaPost(b, "/api/siec/speedtest", {}, (r) => toast(`Łącze: ↓ ${r.dol} · ↑ ${r.gora} Mb/s · ${r.ping} ms`)); break;
    case "led": akcjaPost(b, "/api/swiatlo", body, () => {}); break;
    case "minutnik": {
      const s = Number(b.dataset.s);
      if (!s) { minutnik.koniec = null; }
      else { minutnik.dl = s; minutnik.koniec = Date.now() + s * 1000; minutnik.zagrany = false;
        // AudioContext trzeba utworzyć w geście użytkownika, inaczej WebView nie zagra sygnału na końcu przerwy
        try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); } catch (err) { /* bez dźwięku */ } }
      if (dane.trening) renderuj("trening", dane.trening, true);
      tickMinutnik();
      break;
    }
    default: break;
  }
});

// suwaki: podgląd od razu, wysyłka co 300 ms i na puszczeniu
function ustawTlo(r) { r.style.setProperty("--w", `${(100 * (r.value - r.min)) / (r.max - r.min)}%`); }
let suwakT = 0;
function wyslijSuwak(r) {
  const v = Number(r.value);
  if (r.dataset.suwak === "master") return api(`/api/pc/${encodeURIComponent(r.dataset.pc)}/audio/glosnosc`, "POST", { wartosc: v });
  if (r.dataset.suwak === "app") return api(`/api/pc/${encodeURIComponent(r.dataset.pc)}/audio/aplikacja`, "POST", { pid: Number(r.dataset.pid), glosnosc: v });
  if (r.dataset.suwak === "led-bri") return api("/api/swiatlo", "POST", { bri: v });
  return null;
}
document.addEventListener("input", (e) => {
  const r = e.target.closest("input[type=range][data-suwak]");
  if (!r) return;
  blokadaRenderu = Date.now() + 2000;
  ustawTlo(r);
  const proc = r.parentElement.querySelector(".proc");
  if (proc) proc.textContent = r.dataset.suwak === "led-bri" ? `${Math.round((100 * r.value) / 255)}%` : `${r.value}%`;
  clearTimeout(suwakT);
  suwakT = setTimeout(() => { const p = wyslijSuwak(r); if (p) p.catch((err) => toast(err.message, true)); }, 300);
});
document.addEventListener("change", (e) => {
  const r = e.target.closest("input[type=range][data-suwak]");
  if (!r) return;
  clearTimeout(suwakT);
  const p = wyslijSuwak(r);
  if (p) p.catch((err) => toast(err.message, true)).finally(() => { blokadaRenderu = Date.now() + 800; });
});

// ================================================================== gesty dłoni (kamera w appce → window.jarvisGest)
// Appka rozpoznaje gest na telefonie i woła window.jarvisGest(nazwa). Wszędzie: góra/dół = poprzednia/następna
// zakładka, ✌️ = Przegląd, ✋ budzi wygaszony ekran. Reszta zależy od zakładki. Żadnych groźnych akcji
// (usypianie serwera, wyłączanie komputera) — przypadkowy ruch ręką nie może niczego popsuć.
const GEST_IKONY = { dlon: "✋", piesc: "✊", palec: "☝️", kciuk_gora: "👍", kciuk_dol: "👎", v: "✌️", rock: "🤟", gora: "⬆️", dol: "⬇️", prawo: "👉", lewo: "👈" };
let gestT = 0;
function pokazGest(g, opis) {
  const el = $("gest");
  el.innerHTML = `<span class="ik">${GEST_IKONY[g] || "🖐️"}</span>${opis ? `<span>${esc(opis)}</span>` : ""}`;
  el.className = "widoczny";
  clearTimeout(gestT); gestT = setTimeout(() => { el.className = ""; }, 1400);
}
function pcNaZakladce() {
  const w = dane[aktywna] && dane[aktywna].pcs;
  const lista = w && w.ok && Array.isArray(w.data) ? w.data : [];
  const pc = lista.find((p) => p.id === wybranyPc);
  if (!pc || !pc.online) { toast("Komputer offline", true); return null; }
  return pc;
}
function pcGest(cmd, opis, body = {}) {
  const pc = pcNaZakladce();
  if (!pc) return null;
  api(`/api/pc/${encodeURIComponent(pc.id)}/${cmd}`, "POST", body)
    .then(() => setTimeout(odswiezTeraz, 300)).catch((e) => toast(e.message, true));
  return opis;
}
function glosnoscGest(krok) {
  const pc = pcNaZakladce();
  if (!pc || !pc.audio) return null;
  const v = Math.max(0, Math.min(100, (pc.audio.glosnosc || 0) + krok));
  pc.audio.glosnosc = v;   // kolejny gest liczy od nowej wartości, zanim przyjdzie odświeżenie
  return pcGest("audio/glosnosc", `głośność ${v}%`, { wartosc: v });
}
function ledGest(body, opis) {
  const w = dane.swiatlo && dane.swiatlo.wled && dane.swiatlo.wled.ok ? dane.swiatlo.wled.data : null;
  if (!w) { toast("Pasek LED niepodłączony", true); return null; }
  const b = typeof body === "function" ? body(w) : body;
  api("/api/swiatlo", "POST", b).then(() => setTimeout(odswiezTeraz, 300)).catch((e) => toast(e.message, true));
  return typeof opis === "function" ? opis(w) : opis;
}
const PRZERWY = [60, 90, 120, 180, 240];
const GESTY = {
  przeglad: {
    palec: () => { otworzWidok("pogoda"); return "pogoda"; },
    piesc: () => { forcedUntil = 0; awakeUntil = 0; setTimeout(goSleep, 600); return "wygaszam"; },
  },
  muzyka: {
    piesc: () => pcGest("media/toggle", "pauza / wznów"),
    palec: () => pcGest("media/nastepny", "następny utwór"),
    kciuk_gora: () => glosnoscGest(10),
    kciuk_dol: () => glosnoscGest(-10),
  },
  pc: {
    kciuk_gora: () => glosnoscGest(10),
    kciuk_dol: () => glosnoscGest(-10),
    piesc: () => pcGest("audio/wycisz", "wycisz / przywróć"),
  },
  discord: {
    piesc: () => pcGest("discord/mikrofon", "mikrofon"),
    kciuk_dol: () => pcGest("discord/sluchawki", "słuchawki"),
  },
  trening: {
    piesc: () => {
      if (minutnik.koniec) { minutnik.koniec = null; }
      else {
        minutnik.koniec = Date.now() + minutnik.dl * 1000; minutnik.zagrany = false;
        try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* bez dźwięku */ }
      }
      if (dane.trening) renderuj("trening", dane.trening, true);
      tickMinutnik();
      return minutnik.koniec ? `przerwa ${czasTrwania(minutnik.dl)}` : "stop";
    },
    palec: () => {
      minutnik.dl = PRZERWY[(PRZERWY.indexOf(minutnik.dl) + 1) % PRZERWY.length];
      if (dane.trening) renderuj("trening", dane.trening, true);
      return `przerwa ${czasTrwania(minutnik.dl)}`;
    },
  },
  swiatlo: {
    piesc: () => ledGest((w) => ({ on: !w.on }), (w) => (w.on ? "wyłączam" : "włączam")),
    kciuk_gora: () => ledGest((w) => ({ bri: Math.min(255, (w.bri || 0) + 40) }), "jaśniej"),
    kciuk_dol: () => ledGest((w) => ({ bri: Math.max(1, (w.bri || 0) - 40) }), "ciemniej"),
  },
};
window.jarvisGest = (g) => {
  if (sleeping) {
    if (g === "dlon") { wake(wakeMin); pokazGest(g, ""); }
    return;
  }
  wake(wakeMin);   // gest = aktywność, odsuwa wygaszanie
  // palec wskazujący w prawo = następna zakładka (niżej na pasku), w lewo = poprzednia (gora/dol: starsza wersja appki)
  if (g === "prawo" || g === "lewo" || g === "gora" || g === "dol") {
    const ids = Object.keys(TABS);
    const n = ids[(ids.indexOf(aktywna) + (g === "prawo" || g === "dol" ? 1 : -1) + ids.length) % ids.length];
    przelacz(n);
    pokazGest(g, TABS[n].tytul);
    return;
  }
  if (g === "v") { przelacz("przeglad"); pokazGest(g, "Przegląd"); return; }
  const fn = (GESTY[aktywna] || {})[g];
  let opis = "";
  if (fn) { try { opis = fn() || ""; } catch (e) { toast(e.message, true); } }
  pokazGest(g, opis);
};

// ================================================================== JARVIS głosem (mikrofon w appce → window.jarvisGlos)
// Appka: „Hey Jarvis” (albo przycisk 🎙️) → rozpoznawanie mowy Google → tutaj tekst → /api/jarvis na malince
// → odpowiedź w dymku + B.mow() czyta ją na głos.
let glosT = 0;
function pokazGlos(pytanie, odp, mysli = false) {
  const el = $("glos");
  el.innerHTML = `<div class="pyt">🎙️ ${esc(pytanie)}</div>` +
    (mysli ? `<div class="odp przyg">JARVIS myśli…</div>` : odp ? `<div class="odp">${esc(odp)}</div>` : "");
  el.hidden = false;
  clearTimeout(glosT);
}
function schowajGlos(poMs) {
  clearTimeout(glosT);
  glosT = setTimeout(() => { $("glos").hidden = true; }, poMs);
}
async function zapytajJarvisa(tekst) {
  pokazGlos(tekst, null, true);
  let r;
  try { r = await api("/api/jarvis", "POST", { tekst }); }
  catch (e) { r = { odp: "Nie mogę połączyć się z malinką: " + e.message, mow: "Nie mogę połączyć się z malinką." }; }
  wake(wakeMin);
  pokazGlos(tekst, r.odp);
  if (B && B.mow) try { B.mow(r.mow || r.odp); } catch (e) { /* stara appka */ }
  const a = r.akcja || {};
  if (a.zakladka) przelacz(a.zakladka);
  if (a.zakladka_krok) {
    const ids = Object.keys(TABS);
    przelacz(ids[(ids.indexOf(aktywna) + a.zakladka_krok + ids.length) % ids.length]);
  }
  if (a.dobranoc) pokazDobranoc(a.dobranoc.do_ms);
  if (a.dobranoc_anuluj) schowajDobranoc();
  if (a.ekran === "sleep") setTimeout(() => { $("glos").hidden = true; forcedUntil = 0; awakeUntil = 0; goSleep(); }, 2500);
  setTimeout(odswiezTeraz, 800);
  schowajGlos(Math.min(40000, 6000 + (r.odp || "").length * 60));
}
// „Dobranoc”: malinka sama wykona wyłączanie po odliczaniu; tu tylko licznik na ekranie i anulowanie dotknięciem
let dobranocT = 0;
function schowajDobranoc() {
  clearInterval(dobranocT);
  const el = document.getElementById("dobranoc");
  if (el) el.remove();
}
function pokazDobranoc(doMs) {
  schowajDobranoc();
  const el = document.createElement("div");
  el.id = "dobranoc";
  el.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.82);color:#e6eaf0;display:flex;" +
    "flex-direction:column;align-items:center;justify-content:center;font:600 28px sans-serif;text-align:center";
  el.innerHTML = `<div>🌙 Dobranoc — wyłączam za <span id="dobranoc-s"></span> s</div>` +
    `<div style="font-size:18px;opacity:.75;margin-top:14px">Dotknij ekranu, żeby anulować</div>`;
  el.addEventListener("pointerdown", async (e) => {
    e.stopPropagation();
    schowajDobranoc();
    try { const r = await api("/api/dobranoc/anuluj", "POST"); toast(r.msg || "Anulowane"); }
    catch (err) { toast("Nie udało się anulować: " + err.message, true); }
  });
  document.body.appendChild(el);
  const tik = () => {
    const s = Math.max(0, Math.ceil((doMs - Date.now()) / 1000));
    const sp = document.getElementById("dobranoc-s");
    if (sp) sp.textContent = s;
    if (s <= 0) schowajDobranoc();
  };
  tik();
  dobranocT = setInterval(tik, 500);
}
window.jarvisGlos = (stan, tekst) => {
  if (stan === "wake") { wake(wakeMin); pokazGlos("Słucham…"); return; }
  if (stan === "czesciowy") { wake(wakeMin); pokazGlos(tekst + "…"); return; }
  if (stan === "tekst") { zapytajJarvisa(tekst); return; }
  if (stan === "blad") { pokazGlos(tekst || "Nie usłyszałem"); schowajGlos(2500); }
};

// kamera panelu: ktoś usiadł przy biurku / odszedł (twarz albo dłoń) -> malinka steruje gniazdem monitora
// pierwsze siadanie danego dnia: malinka odsyła brief dnia -> dymek + czytanie na głos
window.jarvisObecnosc = (jest) => {
  api("/api/obecnosc", "POST", { twarz: !!jest }).then((r) => {
    const br = r && r.brief;
    if (!br || !br.odp) return;
    wake(wakeMin);
    pokazGlos(br.tytul || "Brief dnia", br.odp);
    if (B && B.mow) try { B.mow(br.mow || br.odp); } catch (e) { /* stara appka */ }
    schowajGlos(Math.min(60000, 6000 + br.odp.length * 60));
  }).catch(() => { /* offline */ });
};

async function heartbeat() {
  // stan telefonu zgłasza tylko appka; zwykła przeglądarka z otwartym panelem nie może go nadpisywać
  if (!B) return;
  try { await api("/api/heartbeat", "POST", { battery: bateria(), sleeping }); } catch (e) { /* offline */ }
}

// ================================================================== start
// Po przeładowaniu strony (np. co 6 h z appki) zostań w tym stanie, w jakim jest ekran telefonu
const startowa = bateria();
if (startowa && startowa.sleeping) goSleep();
else if (B) try { B.setSleep(false); } catch (e) { /* j.w. */ }

przelacz("przeglad", false);
tick(); loadDash(); pollScreen(); heartbeat(); startStrumien();
ostatnio.przeglad = Date.now();
setInterval(tick, 1000);
setInterval(petla, 1000);
let licznikPollu = 0;
setInterval(() => { licznikPollu++; if (!strumienZywy || licznikPollu % 10 === 0) pollScreen(); }, 3000);  // zapas, gdy strumień milczy
setInterval(() => { if (window.EventSource && Date.now() - strumienOstatni > 45000) { strumienZywy = false; startStrumien(); } }, 10000);
setInterval(() => { if (widok && !sleeping && Date.now() - widok.ost >= (widok.kontener ? 5000 : WIDOK[widok.id].co)) wczytajWidok(); }, 1000);
setInterval(heartbeat, 60000);
let licznikSnu = 0;
setInterval(() => { licznikSnu++; if (sleeping && licznikSnu % 10 === 0) loadDash(); }, 30000); // śpiąc: Przegląd co 5 min
