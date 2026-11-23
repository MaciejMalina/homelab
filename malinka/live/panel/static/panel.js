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

// karta TO DO: wybrana lista ("" = główna „zadania”), tryb tworzenia nowej listy, ostatnie dane (2026-11-22)
let todoLista = "", todoNowa = false, todoDane = null;

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
  if (todoLista || todoNowa) { todoLista = ""; todoNowa = false; renderTodo(todoDane); }  // po wygaszeniu karta wraca na „zadania”
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
  budzikZastosuj(s.budzik, s);
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
  strumien.addEventListener("discord", () => { zywy(); if (aktywna === "muzyka" && !sleeping) odswiezTeraz(); });
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
  muzyka: { tytul: "Muzyka i Discord", co: 2500, ikona: IK('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>') },
  claude: { tytul: "Claude", co: 60000, ikona: IK('<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="2.5"/>') },
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
  $("t-inne").dataset.tab = id;  // CSS: poprawki układu dla wybranych zakładek (np. Media)
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
  todoDane = t;
  const ul = $("lista"), chipy = $("todo-listy");
  if (!t || !t.ok) { ul.innerHTML = `<li class="przyg">Lista TO DO nie odpowiada</li>`; $("todo-licznik").textContent = ""; chipy.innerHTML = ""; return; }
  const wszystkie = t.data.tasks || [];
  const ile = { "": 0 };
  wszystkie.forEach((z) => { ile[z.lista || ""] = (ile[z.lista || ""] || 0) + 1; });
  if (!(todoLista in ile)) todoLista = "";   // lista się opróżniła — znika (istnieje, dopóki ma pozycje)
  const nazwy = ["", ...Object.keys(ile).filter((n) => n).sort((a, b) => a.localeCompare(b, "pl"))];
  chipy.innerHTML = nazwy.map((n) => `<button class="chip ${!todoNowa && n === todoLista ? "aktywny" : ""}" data-akcja="todo-lista" data-l="${esc(n)}">${esc(n || "zadania")}${ile[n] ? ` <b>${ile[n]}</b>` : ""}</button>`).join("")
    + `<button class="chip ${todoNowa ? "aktywny" : ""}" data-akcja="todo-nowa" aria-label="Nowa lista">＋</button>`;
  $("nowe-lista").hidden = !todoNowa;
  $("nowe-tytul").placeholder = todoNowa ? "Pierwsza pozycja…" : todoLista ? `Dodaj do: ${todoLista}…` : "Nowe zadanie…";
  const zadania = todoNowa ? [] : wszystkie.filter((z) => (z.lista || "") === todoLista);
  $("todo-licznik").textContent = zadania.length ? String(zadania.length) : "";
  if (todoNowa) { ul.innerHTML = `<li class="przyg">Wpisz nazwę listy i pierwszą pozycję — lista zniknie sama, gdy ją opróżnisz.</li>`; return; }
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
  const inp = $("nowe-tytul"), title = inp.value.trim(), pole = $("nowe-lista");
  const lista = todoNowa ? pole.value.trim() : todoLista;
  if (todoNowa && !lista) { pole.focus(); toast("Wpisz nazwę listy", true); return; }
  if (!title) return;
  inp.disabled = true;
  try {
    const z = await api("/api/todo", "POST", { title, lista });
    inp.value = ""; inp.blur();
    if (todoNowa) { todoNowa = false; pole.value = ""; todoLista = (z && z.lista) || ""; }   // nazwa po normalizacji usługi todo
    toast(lista ? `Dodano do: ${todoLista || lista}` : "Dodano"); loadDash();
  }
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
  const dcPc = (id) => ((zrodlo(d.pcs_dc, "")[0] || []).find((x) => x.id === id) || {});
  chipyPc(pcs, (p) => (p.online && p.media && p.media.stan === "gra" ? " ▶" : "") +
    (dcPc(p.id).discord && dcPc(p.id).discord.polaczony && dcPc(p.id).discord.kanal ? " 🔊" : ""));
  if (!pc.online) {
    muzykaStan = null;
    return `<div class="muzyka-uklad"><div style="flex:1;min-height:0;display:flex">${pcOffline(pc)}</div>${discordPasek(d)}</div>`;
  }
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
  return `<div class="muzyka-uklad"><div class="siatka" style="grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);flex:1;min-height:0">${lewa}
    <div class="karta"><h2>Mikser<span class="prawo jedna-linia">${esc((a.urzadzenia || []).find((u) => u.domyslne)?.nazwa || "")}</span></h2>
      <div class="suwak" style="margin-bottom:8px"><button data-akcja="pc-cmd" data-pc="${esc(pc.id)}" data-cmd="audio/wycisz" ${bodyAttr({})}>${a.wyciszony ? "🔇" : "🔊"}</button>
        <span class="nazwa"><b>Główna</b></span><input type="range" min="0" max="100" value="${a.glosnosc ?? 0}" data-suwak="master" data-pc="${esc(pc.id)}"><span class="proc">${a.glosnosc ?? "–"}%</span></div>
      <div class="przewijane" data-scroll="mikser">${apki || pustoHtml("Żadna aplikacja nie gra")}</div></div></div>${discordPasek(d)}</div>`;
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

// Discord (pasek na dole zakładki Muzyka): kto siedzi na kanałach głosowych (RPC agentów + bot) i mikrofon /
// słuchawki / rozłącz dla komputera wybranego chipem
function discordPasek(d) {
  const dc = d.discord || {};
  const [pcs] = zrodlo(d.pcs_dc, "Komputery");
  const online = (pcs || []).filter((p) => p.online);
  const maKanal = (p) => p.discord && p.discord.polaczony && p.discord.kanal;
  const osoba = (o) => `<span class="osoba-mini">${o.avatar ? `<img src="${esc(o.avatar)}" alt="" referrerpolicy="no-referrer">` : '<span class="awatar"></span>'}${esc(o.nazwa)}${o.mute ? '<span class="zle-t">🎙✕</span>' : ""}${o.deaf ? '<span class="zle-t">🎧✕</span>' : ""}${o.stream ? '<span class="etykieta czerwona">LIVE</span>' : ""}</span>`;
  const kanaly = [];
  const juz = new Set();
  online.filter(maKanal).forEach((p) => {
    const k = p.discord.kanal;
    juz.add((k.nazwa || "").toLowerCase());
    kanaly.push(`<span class="dc-kanal">🔊 ${esc(k.nazwa || "Rozmowa")}</span>${k.uczestnicy.map(osoba).join("")}`);
  });
  (dc.kanaly || []).forEach((k) => {   // kanały z bota, których nie pokazał już RPC
    if (!juz.has((k.kanal || "").toLowerCase())) kanaly.push(`<span class="dc-kanal">🔊 ${esc(k.kanal)} <span class="przyg">· ${esc(k.serwer)}</span></span>${k.osoby.map(osoba).join("")}`);
  });
  const opis = kanaly.length ? kanaly.join("")
    : `<span class="przyg">${online.some((p) => p.discord && p.discord.polaczony) ? "Nie siedzisz na kanale głosowym" : dc.ts ? "Nikt nie siedzi na kanałach głosowych" : "Discord: brak danych (RPC w agencie albo bot)"}</span>`;
  const pc = online.find((p) => p.id === wybranyPc) || null;
  let ster = "";
  if (pc) {
    const r = pc.discord && pc.discord.polaczony ? pc.discord : null;
    const kl = (v) => (r ? (v ? "wylaczony" : "wlaczony") : "");
    ster = `<button class="${kl(r && r.mute)}" data-akcja="pc-cmd" data-pc="${esc(pc.id)}" data-cmd="discord/mikrofon" title="mikrofon">🎙️</button>
      <button class="${kl(r && r.deaf)}" data-akcja="pc-cmd" data-pc="${esc(pc.id)}" data-cmd="discord/sluchawki" title="słuchawki">🎧</button>
      ${r && r.kanal ? `<button class="groznie" data-akcja="pc-cmd" data-pc="${esc(pc.id)}" data-cmd="discord/rozlacz" title="rozłącz">📞</button>` : ""}`;
  }
  return `<div class="karta dc-pasek"><div class="dc-lewa"><h2>Discord<span class="prawo">${dc.ts ? temuOd(dc.ts) : ""}</span></h2>
    <div class="dc-osoby przewijane" data-scroll="dc">${opis}</div></div><div class="dc-ster">${ster}</div></div>`;
}

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
  return `<div class="siatka" style="grid-template-columns:minmax(0,.85fr) minmax(0,1fr) minmax(0,1.15fr)">
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
    const pasma = [z.pasmo, z.pasmo_lte ? String(z.pasmo_lte).replace(/^LTE\s*BAND\s*/i, "B") : ""].filter(Boolean).join(" · ");
    zte = `<div style="display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px;margin-bottom:6px"><span style="font-size:22px;font-weight:800;white-space:nowrap">${esc(typ)}</span>
        <span class="etykieta">${esc(pasma ? "pasmo " + pasma : "")}</span><span class="przyg mala">${esc(z.operator || "")}</span></div>
      <div class="kafle" style="grid-template-columns:1fr 1fr">
        ${kafel("5G RSRP", z.nr.rsrp ?? "–", "dBm", kolRsrp(z.nr.rsrp))}${kafel("5G SINR", z.nr.sinr ?? "–", "dB", kolSinr(z.nr.sinr))}
        ${kafel("LTE RSRP", z.lte.rsrp ?? "–", "dBm", kolRsrp(z.lte.rsrp))}${kafel("LTE SINR", z.lte.sinr ?? "–", "dB", kolSinr(z.lte.sinr))}</div>
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
      ${kafel("Ping", s ? s.ping : "–", "ms", KOL.morski)}${kafel("Pobier.", s ? Math.round(s.dol) : "–", "Mb/s", KOL.ok)}${kafel("Wysył.", s ? Math.round(s.gora) : "–", "Mb/s", KOL.fiolet)}</div>`;
  const spNaglowek = `<span class="prawo" style="display:flex;align-items:center;gap:6px"><span class="mala przyg" title="z malinki przez ZTE (25 MB ↓, 10 MB ↑)">${s ? temuOd(s.ts) : "jeszcze nie"}</span>
    <button class="maly" data-akcja="speedtest-malinka" data-dlugie>⇅ Testuj</button></span>`;
  const urz = d.urzadzenia || [];
  const nowe = urz.filter((u) => !u.znane), znane = urz.filter((u) => u.znane);
  const lista = !urz.length ? pustoHtml("Pierwszy skan sieci za chwilę") :
    (nowe.length ? `<div class="dzien-naglowek uwaga-t">Nowe — do zatwierdzenia (${nowe.length})</div>${nowe.map(urzWiersz).join("")}` : "") +
    `<div class="dzien-naglowek">Znane (${znane.length})</div>${znane.map(urzWiersz).join("") || pustoHtml("—")}`;
  return `<div class="siatka" style="grid-template-columns:1fr 1fr 1.15fr">
    <div class="karta"><h2>Router 5G (ZTE)<span class="prawo">${z && z.kreski != null ? "▂▄▆█".slice(0, Math.max(1, Math.min(4, z.kreski))) : ""}</span></h2><div class="przewijane" data-scroll="zte">${zte}</div></div>
    <div class="siatka" style="grid-template-rows:1fr auto;gap:8px;min-height:0">
      <div class="karta"><h2>AdGuard</h2><div class="przewijane" data-scroll="ag">${ad}</div></div>
      <div class="karta"><h2 style="display:flex;align-items:center">Speedtest${spNaglowek}</h2>${sp}</div></div>
    <div class="karta"><h2>Urządzenia<span class="prawo">${urz.filter((u) => u.online).length} w sieci</span></h2><div class="przewijane" data-scroll="urz">${lista}</div></div></div>`;
};

// urządzenia w sieci: nowe (nieznane) na górze; ✎ = nazwa (nadanie nazwy zatwierdza) albo Usuń, „Znane ✓” = zatwierdź bez nazwy
let edytowanyMac = null;
function urzWiersz(u) {
  if (edytowanyMac === u.mac) {
    return `<div class="wiersz"><input type="text" class="tekst" id="urz-nazwa" maxlength="40" placeholder="Nazwa, np. Telefon Ani" value="${esc(u.nazwa || u.host || "")}">
      <button class="maly" data-akcja="urz-zapisz" data-mac="${esc(u.mac)}">Zapisz</button><button class="maly" data-akcja="urz-usun" data-mac="${esc(u.mac)}" data-potwierdz>Usuń</button><button class="maly" data-akcja="urz-anuluj">✕</button></div>`;
  }
  const nazwa = u.nazwa || u.host || (u.prywatny ? "prywatny MAC" : "bez nazwy");
  const opis = [u.ip, u.mac, u.online ? null : u.ostatni ? `widziane ${temuOd(u.ostatni)}` : "jeszcze nie widziane"].filter(Boolean).join(" · ");
  return `<div class="wiersz"><span class="v"><span style="color:${u.online ? KOL.ok : KOL.brak}">●</span> ${esc(nazwa)}<div class="mala przyg" style="overflow:hidden;text-overflow:ellipsis">${esc(opis)}</div></span>
    <span class="k" style="display:flex;gap:4px">${u.znane ? "" : `<button class="maly" data-akcja="urz-znane" data-mac="${esc(u.mac)}">Znane ✓</button>`}<button class="maly" data-akcja="urz-edytuj" data-mac="${esc(u.mac)}">✎</button></span></div>`;
}
function urzPrzerysuj() { blokadaRenderu = 0; if (dane.siec) renderuj("siec", dane.siec, true); }

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
  $("naglowek-info").innerHTML = `<div class="chipy"><button class="maly" data-akcja="wydarzenie-otworz">＋ wydarzenie</button>
    <button class="maly" data-akcja="reguly-otworz">⚡ Reguły</button>
    <button class="maly" data-akcja="budziki-otworz">⏰ ${esc(d.budzik ? "Budzik " + d.budzik : "Budziki")}</button></div>`;
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
      // pogoda w miejscu wydarzenia (Open-Meteo o tej godzinie; z Yapass) — pojawia się, gdy miejsce jest już zgeokodowane
      const p = w.pogoda;
      const pog = p ? ` <span class="mala" title="${esc(p.opis || "")}">${p.ikona} ${Math.round(p.temp)}°${p.pp ? ` · ${p.pp}%` : ""}</span>` : "";
      return `${nag}<div class="wiersz"><span class="k mala" style="width:78px">${esc(godz)}</span><span class="v zawijaj">${esc(w.tytul)}${w.miejsce ? ` <span class="przyg mala">· 📍 ${esc(w.miejsce)}</span>` : ""}${pog}</span></div>`;
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

// ------------------------------------------------------------------ Claude: limity planu (malinka pyta co 10 min)
const kolClaude = (x) => (x.poziom && x.poziom !== "normal" ? KOL.zle : x.proc >= 80 ? KOL.pom : x.proc >= 50 ? KOL.uwaga : KOL.ok);
function doResetu(ts) {
  if (!ts) return "";
  const s = Math.max(0, ts - Date.now() / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const d = new Date(ts * 1000);
  const kiedy = s < 86400 ? `${d.getHours()}:${dwa(d.getMinutes())}` : `${["nd", "pn", "wt", "śr", "cz", "pt", "sb"][d.getDay()]} ${d.getHours()}:${dwa(d.getMinutes())}`;
  return `odnowi się ${kiedy} · za ${h >= 24 ? Math.floor(h / 24) + " d " + (h % 24) + " h" : h ? h + " h " + m + " min" : m + " min"}`;
}
function wykresClaude(hist) {
  // 7 dni: tydzień (fiolet) i sesja (akcent), oś 0–100 %
  const kon = Date.now() / 1000, start = kon - 7 * 86400;
  const pts = hist.filter((h) => h[0] >= start);
  if (pts.length < 2) return pustoHtml("Historia zbiera się co 10 minut");
  const x = (t) => ((100 * (t - start)) / (kon - start)).toFixed(2), y = (v) => (100 - Math.min(100, v)).toFixed(2);
  const linia = (i, kol) => `<polyline fill="none" stroke="${kol}" stroke-width="1.6" vector-effect="non-scaling-stroke"
      points="${pts.filter((h) => h[i] != null).map((h) => `${x(h[0])},${y(h[i])}`).join(" ")}"/>`;
  const dni = [...Array(7)].map((_, k) => { const t = kon - k * 86400; return `<line x1="${x(t)}" x2="${x(t)}" y1="0" y2="100" stroke="rgba(255,255,255,.06)" vector-effect="non-scaling-stroke"/>`; }).join("");
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;flex:1;min-height:90px">
      <line x1="0" x2="100" y1="20" y2="20" stroke="rgba(255,122,133,.35)" stroke-dasharray="2 2" vector-effect="non-scaling-stroke"/>${dni}
      ${linia(1, "var(--akcent)")}${linia(2, "var(--fiolet)")}</svg>
    <div class="mala przyg" style="display:flex;gap:14px"><span style="color:var(--akcent)">● sesja</span><span style="color:var(--fiolet)">● tydzień</span><span>7 dni · kreska = 80%</span></div>`;
}
RENDER.claude = (d) => {
  $("naglowek-info").innerHTML = `<button class="maly" data-akcja="claude-odswiez" data-dlugie>⟳ Odśwież</button>`;
  const c = d.claude || {};
  if (c.disabled) return pustoHtml("Malinka nie jest zalogowana do Claude (brak data/claude/.credentials.json).");
  const lim = c.limity || [];
  if (!lim.length) return pustoHtml(c.blad ? "Nie udało się pobrać limitów: " + c.blad : "Czekam na pierwsze dane…");
  const tydz = lim.find((x) => x.kind === "weekly_all");
  let tempo = "";
  if (tydz && tydz.reset) {
    const uplyw = Math.min(1, Math.max(0, 1 - (tydz.reset - Date.now() / 1000) / (7 * 86400)));
    const roznica = tydz.proc - 100 * uplyw;
    tempo = `<div class="mala przyg" style="margin-top:4px">Minęło ${Math.round(100 * uplyw)}% tygodnia — ${roznica > 10 ? "zużywasz szybciej niż równo" : roznica < -10 ? "masz zapas" : "równe tempo"}.</div>`;
  }
  const karty = lim.map((x) => `<div class="karta" style="gap:6px"><h2>${esc(x.nazwa)}${x.aktywny ? '<span class="prawo">teraz liczy się ten</span>' : ""}</h2>
      <div style="font-size:54px;font-weight:800;line-height:1;color:${kolClaude(x)}">${Math.round(x.proc)}<small style="font-size:22px">%</small></div>
      ${pasek(x.proc, kolClaude(x))}<div class="mala przyg">${esc(doResetu(x.reset))}</div>${x.kind === "weekly_all" ? tempo : ""}</div>`).join("");
  const podzial = (c.podzial || []).map((r) => `<div class="wiersz" style="display:block"><div class="v">${esc(r.nazwa)}</div><div class="mala przyg">${Math.round(r.udzial)}% tygodnia · ${Math.round(r.limitu)}% limitu</div></div>`).join("");
  const stan = `${c.plan ? "Plan " + esc(c.plan) + " · " : ""}dane ${c.ts ? temuOd(c.ts) : "—"}${c.blad && c.blad_ts > (c.ts || 0) ? ` · <span class="zle-t">${esc(c.blad)}</span>` : ""}`;
  return `<div style="display:flex;flex-direction:column;gap:8px;height:100%">
    <div class="siatka" style="grid-template-columns:repeat(${Math.min(lim.length, 3)},1fr);flex:none;height:auto">${karty}</div>
    <div class="siatka" style="grid-template-columns:minmax(0,1.35fr) minmax(0,1.1fr) minmax(0,.85fr);flex:1;min-height:0">
      <div class="karta"><h2>Historia</h2>${wykresClaude(d.hist || [])}</div>
      <div class="karta"><h2>Powiadomienia<span class="prawo">${(d.powiadomienia || []).filter((x) => x.aktywne).length ? "● czeka" : ""}</span></h2>
        <div class="przewijane" data-scroll="clp">${(d.powiadomienia || []).map((x) => `<div class="wiersz"><span class="v zawijaj">
          <span style="color:${x.aktywne ? "var(--pom)" : "var(--ramka)"}">●</span> <b>${esc(x.tytul)}</b>
          <div class="mala przyg">${esc(x.tresc)}</div><div class="mala przyg">${esc(x.pc)} · ${godzMin(x.czas)} · ${temuOd(x.czas)}</div></span></div>`).join("")
          || pustoHtml("Brak. Zbiera je agent 1.2 z powiadomień aplikacji Claude na komputerze.")}</div></div>
      <div class="karta"><h2>Tydzień według</h2><div class="przewijane" data-scroll="cl">${podzial || pustoHtml("—")}</div>
        <div class="mala przyg" style="margin-top:auto">${stan}<br>Alert przy ${(d.progi || []).join(" i ")}% · głosem: „ile mam limitu w Claude”</div></div></div></div>`;
};

// ---------- nowe wydarzenie w kalendarzu (Nextcloud; gdy serwer śpi — kolejka + budzenie)
const noweWyd = { tytul: "", data: "", godz: "", minuty: 60, miejsce: "" };
WIDOK.wydarzenie = {
  tytul: () => "Nowe wydarzenie w kalendarzu",
  co: 600000,
  html: (w) => {
    if (!noweWyd.data) { const d = new Date(Date.now() + 864e5); noweWyd.data = `${d.getFullYear()}-${dwa(d.getMonth() + 1)}-${dwa(d.getDate())}`; }
    const pole = (id, typ, wart, ph, styl = "") => `<input type="${typ}" class="tekst" id="wyd-${id}" value="${esc(wart)}" placeholder="${esc(ph)}" style="width:100%;flex:none;min-height:44px;font-size:16px;${styl}">`;
    return `<div class="siatka" style="grid-template-columns:minmax(0,1.3fr) minmax(0,1fr)">
      <div class="karta" style="gap:8px"><h2>Co i gdzie</h2>
        ${pole("tytul", "text", noweWyd.tytul, "Tytuł, np. Dentysta")}
        ${pole("miejsce", "text", noweWyd.miejsce, "Miejsce (opcjonalnie) — dostanie pogodę, np. Kraków")}
        <div class="mala przyg">${w.dane.google ? "Trafi od razu do Twojego Kalendarza Google (widać je też w telefonie)." : w.dane.serwer ? "Serwer działa — wydarzenie trafi do Nextclouda od razu." : "Serwer śpi — obudzę go, wydarzenie trafi do kalendarza, gdy wstanie."}</div></div>
      <div class="karta" style="gap:8px"><h2>Kiedy</h2>
        ${pole("data", "date", noweWyd.data, "")}
        ${pole("godz", "time", noweWyd.godz, "")}
        <div class="chipy">${[[0, "cały dzień"], [30, "30 min"], [60, "1 h"], [90, "1,5 h"], [120, "2 h"], [180, "3 h"]].map(([m, n]) =>
          `<button class="chip maly ${(m === 0 ? !noweWyd.godz : noweWyd.godz && noweWyd.minuty === m) ? "aktywny" : ""}" data-akcja="wyd-czas" data-m="${m}">${n}</button>`).join("")}</div>
        <button class="glowny" data-akcja="wyd-dodaj" data-dlugie style="margin-top:auto">📅 Dodaj do kalendarza</button></div></div>`;
  },
};
function wydZbierz() {
  for (const k of ["tytul", "miejsce", "data", "godz"]) { const el = $("wyd-" + k); if (el) noweWyd[k] = el.value.trim(); }
}

// ---------- wszystkie listy TO DO (zakupy, projekty…) — dotknięcie pozycji = zrobione / kupione
WIDOK.listy = {
  tytul: () => "Listy",
  co: 20000,
  html: (w) => {
    const t = w.dane.todo || {};
    const grupy = {};
    (t.tasks || []).forEach((z) => { (grupy[z.lista || ""] = grupy[z.lista || ""] || []).push(z); });
    const nazwy = Object.keys(grupy).sort((a, b) => (a !== "") - (b !== "") || a.localeCompare(b, "pl"));   // główna pierwsza
    if (!nazwy.length) return pustoHtml("Wszystkie listy są puste. Głosem: „dodaj mleko do zakupów”.");
    return `<div class="siatka" style="grid-template-columns:repeat(${Math.min(nazwy.length, 3)},minmax(0,1fr))">${nazwy.map((n) => `<div class="karta">
      <h2>${esc(n || "zadania")}<span class="prawo">${grupy[n].length}</span></h2><div class="przewijane" data-scroll="l-${esc(n)}">
      ${grupy[n].map((z) => `<div class="wiersz" data-akcja="lista-odhacz" data-id="${z.id}" style="cursor:pointer"><span class="v zawijaj">☐ ${esc(z.title)}</span>${z.kto ? `<span class="k mala">${esc(z.kto)}</span>` : ""}</div>`).join("")}
      </div></div>`).join("")}</div>`;
  },
};

// ---------- ściąga komend „Hey Jarvis” (głosem: „co umiesz?”)
WIDOK.komendy = {
  tytul: () => "Co umie JARVIS — powiedz „Hey Jarvis”, a potem…",
  co: 600000,
  html: (w) => `<div class="siatka" style="grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-rows:min-content;overflow:auto">
    ${(w.dane.grupy || []).map(([g, lista]) => `<div class="karta"><h2>${esc(g)}</h2>
      ${lista.map((k) => `<div class="wiersz"><span class="v zawijaj">„${esc(k)}”</span></div>`).join("")}</div>`).join("")}</div>`,
};

// ---------- reguły „gdy → wtedy”: lista + kreator (malinka sprawdza je co 20 s; głosem „pokaż reguły”)
const REG_NOWA = () => ({ id: "", nazwa: "", wl: true, sucho: true, warunek: null, okno: null, wtedy: [],
  gdy: { typ: "pobrane", minuty: 10, mac: "", godz: "07:30", dni: [], filtr: "", tylko_miejsce: true, mnt: "/mnt/data", proc: 90 } });
let rk = REG_NOWA();
const REG_MIN = { nieobecnosc: [5, 10, 15, 30, 60], wraca: [30, 60, 120, 240], znika: [5, 10, 15, 30, 60],
  przed: [15, 30, 60, 120, 1440], usluga: [1, 5, 15, 30], serwer_wol: [2, 3, 5, 10] };
const REG_MIN_DOM = { nieobecnosc: 10, wraca: 60, znika: 15, przed: 60, usluga: 5, serwer_wol: 3 };
const REG_MIN_OPIS = { nieobecnosc: "bez nikogo przy biurku (kamera panelu)", wraca: "nieobecności w sieci", znika: "bez urządzenia w sieci",
  przed: "przed startem wydarzenia", usluga: "od awarii (usługi serwera tylko, gdy działa)", serwer_wol: "po wysłaniu Wake-on-LAN" };
const REG_OKNA = [[null, "cały dzień"], [{ od: 7, do: 23 }, "7–23"], [{ od: 8, do: 22 }, "8–22"], [{ od: 22, do: 7 }, "noc 22–7"]];
const regMin = (m) => (m >= 1440 ? m / 1440 + " d" : m >= 60 ? m / 60 + " h" : m + " min");
function regUrz(d, mac) { const u = (d.urzadzenia || []).find((x) => x.mac === mac); return u ? u.nazwa : mac || "—"; }
function regGniazdo(d, id) { const g = (d.gniazda || []).find((x) => x.id === id); return g ? g.nazwa : id; }
function regOpisGdy(g, d) {
  switch (g.typ) {
    case "pobrane": return "pobieranie skończone" + (g.filtr ? ` (nazwa zawiera „${g.filtr}”)` : "");
    case "nieobecnosc": return `nikogo przy biurku ${regMin(g.minuty)}`;
    case "obecnosc": return "ktoś siada przy biurku";
    case "wraca": return g.mac ? `${regUrz(d, g.mac)} wraca po ${regMin(g.minuty)}` : "urządzenie wraca (nie wybrano!)";
    case "znika": return g.mac ? `${regUrz(d, g.mac)} znika na ${regMin(g.minuty)}` : "urządzenie znika (nie wybrano!)";
    case "godzina": return `o ${g.godz}${g.dni && g.dni.length ? " · " + g.dni.map((x) => DNI_PN[x]).join(", ") : " codziennie"}`;
    case "przed": return `${regMin(g.minuty)} przed wydarzeniem${g.tylko_miejsce ? " z miejscem" : ""}`;
    case "dzien_przed": return `o ${g.godz} dzień przed wydarzeniem całodniowym`;
    case "dobranoc": return "„Dobranoc”";
    case "usluga": return `usługa nie działa ${regMin(g.minuty)}` + (g.filtr ? ` („${g.filtr}”)` : "");
    case "serwer_wol": return `serwer nie wstał ${regMin(g.minuty)} po WoL`;
    case "dysk": return `dysk ${g.mnt} ≥ ${g.proc}%`;
    default: return g.typ;
  }
}
function regOpisWar(w) { return !w ? "" : w.typ === "lista" ? ` · jeśli lista „${w.lista}” niepusta` : w.typ === "paczka" ? " · jeśli czeka paczka" : ""; }
function regOpisWtedy(a, d) {
  const onoff = (x) => (x === "off" ? "wyłącz" : "włącz");
  switch (a.typ) {
    case "powiedz": return `powiedz „${a.tekst}”`;
    case "baner": return "baner";
    case "discord": return "Discord";
    case "gniazdo": return `${onoff(a.akcja)} ${regGniazdo(d, a.id)}`;
    case "stanowisko": return `${onoff(a.akcja)} stanowisko`;
    case "ekran": return a.akcja === "off" ? "uśpij ekran" : "obudź ekran";
    case "brief": return "brief dnia";
    case "komenda": return `„${a.tekst}”`;
    default: return a.typ;
  }
}
function regZbierz() {
  const v = (id) => { const el = $(id); return el ? el.value : null; };
  if (v("reg-nazwa") !== null) rk.nazwa = v("reg-nazwa");
  if (v("reg-godz")) rk.gdy.godz = v("reg-godz");
  if (v("reg-filtr") !== null) rk.gdy.filtr = v("reg-filtr");
  rk.wtedy.forEach((a, i) => { const t = v("reg-t-" + i); if (t !== null) a.tekst = t; });
}
WIDOK.reguly = {
  tytul: () => "Reguły — gdy… wtedy…",
  co: 15000,
  html: (w) => {
    const d = w.dane, lista = d.reguly || [];
    const chip = (akt, akcja, attrs, tekst) => `<button class="chip maly ${akt ? "aktywny" : ""}" data-akcja="${akcja}" ${attrs}>${tekst}</button>`;
    const wiersze = lista.map((r) => `<div class="wiersz" style="align-items:flex-start"><span class="v zawijaj" style="${r.wl ? "" : "opacity:.5"}">
        <b>${esc(r.nazwa)}</b>${r.sucho ? ' <span class="mala" style="color:var(--pom)">🧪 na sucho</span>' : ""}${rk.id === r.id ? ' <span class="mala" style="color:var(--akcent)">✎ edytujesz</span>' : ""}
        <div class="mala przyg">gdy ${esc(regOpisGdy(r.gdy, d))}${esc(regOpisWar(r.warunek))}${r.okno ? ` · ${r.okno.od}–${r.okno.do}` : ""} → ${esc(r.wtedy.map((a) => regOpisWtedy(a, d)).join(", "))}</div>
        <div class="mala przyg">${r.ostatnio ? `ostatnio ${temuOd(r.ostatnio)} · razem ${r.licznik}` : r.sucho ? "jeszcze nic — historia pokaże, co by zrobiła" : "jeszcze nie działała"}</div></span>
      <span class="k" style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end">
        ${chip(r.wl, "reg-cmd", `data-id="${esc(r.id)}" data-cmd="${r.wl ? "wyl" : "wl"}"`, r.wl ? "Wł." : "Wył.")}
        ${chip(r.sucho, "reg-cmd", `data-id="${esc(r.id)}" data-cmd="${r.sucho ? "naprawde" : "sucho"}"`, r.sucho ? "🧪 Sucho" : "Naprawdę")}
        <button class="maly" data-akcja="reg-edytuj" data-id="${esc(r.id)}">Edytuj</button>
        <button class="maly" data-akcja="reg-cmd" data-id="${esc(r.id)}" data-cmd="test" data-dlugie>Test</button>
        <button class="maly" data-akcja="reg-cmd" data-id="${esc(r.id)}" data-cmd="usun" data-potwierdz>Usuń</button></span></div>`).join("");
    const hist = (d.hist || []).map((h) => `<div class="wiersz"><span class="v zawijaj"><span class="${h.ok ? "" : "zle-t"}" style="${h.pominieta ? "color:var(--przyg)" : h.sucho ? "color:var(--pom)" : ""}">${h.pominieta ? "○" : "●"}</span> <b>${esc(h.nazwa)}</b>
        <span class="mala przyg">${esc(h.opis)}</span></span><span class="k mala">${godzMin(h.ts)}<br>${temuOd(h.ts)}</span></div>`).join("");

    // --- kreator
    const g = rk.gdy;
    const gdyChipy = Object.entries(d.gdy || {}).map(([k, n]) => chip(g.typ === k, "reg-gdy", `data-typ="${k}"`, esc(n))).join("");
    let param = "";
    if (REG_MIN[g.typ]) param += `<div class="chipy">${REG_MIN[g.typ].map((m) => chip(g.minuty === m, "reg-min", `data-m="${m}"`, regMin(m))).join("")}
      <span class="mala przyg">${REG_MIN_OPIS[g.typ]}</span></div>`;
    if (g.typ === "wraca" || g.typ === "znika") param += `<div class="chipy" style="max-height:96px;overflow:auto">${(d.urzadzenia || []).map((u) =>
      chip(g.mac === u.mac, "reg-mac", `data-mac="${esc(u.mac)}"`, `${u.online ? "🟢" : "⚪"} ${esc(u.nazwa)} <span class="przyg">${esc(u.ip || "")}</span>`)).join("")}</div>
      <div class="mala przyg">Wybierz urządzenie (np. telefon). Sieć skanuje co 5 min, więc czas jest przybliżony.</div>`;
    if (g.typ === "godzina" || g.typ === "dzien_przed") param += `<div class="chipy"><input type="time" class="tekst" id="reg-godz" value="${esc(g.godz)}" style="flex:none;width:130px;min-height:36px;font-size:16px">
      ${g.typ === "godzina" ? DNI_PN.map((n, i) => chip((g.dni || []).includes(i), "reg-dzien", `data-d="${i}"`, n)).join("") : '<span class="mala przyg">dzień wcześniej, gdy jutro jest wydarzenie całodniowe (bez świąt)</span>'}</div>
      ${g.typ === "godzina" ? '<div class="mala przyg">Bez zaznaczonych dni = codziennie.</div>' : ""}`;
    if (g.typ === "pobrane" || g.typ === "usluga") param += `<input type="text" class="tekst" id="reg-filtr" value="${esc(g.filtr || "")}" placeholder="Tylko gdy nazwa zawiera… (puste = każda)" style="width:100%;flex:none;min-height:36px">`;
    if (g.typ === "przed") param += `<div class="chipy">${chip(g.tylko_miejsce, "reg-miejsce", "", "📍 tylko wydarzenia z miejscem")}
      <span class="mala przyg">w tekście: {nazwa} {miejsce} {pogoda} {parasol} {godzina}</span></div>`;
    if (g.typ === "dysk") param += `<div class="chipy">${[80, 85, 90, 95].map((p) => chip(g.proc === p, "reg-proc", `data-p="${p}"`, p + "%")).join("")}
      <span class="mala przyg">${esc(g.mnt)} · sprawdzane co godzinę, gdy serwer działa; ponownie po spadku o 5%</span></div>`;
    if (g.typ === "obecnosc") param += `<div class="mala przyg">Gdy kamera panelu zobaczy kogoś przy biurku (monitor i tak włącza się sam).</div>`;
    if (g.typ === "dobranoc") param += `<div class="mala przyg">Po odliczeniu „Dobranoc” (anulowane się nie liczy).</div>`;
    const war = rk.warunek;
    const warChipy = chip(!war, "reg-war", 'data-w=""', "zawsze") + Object.entries(d.warunki || {}).map(([k, n]) => chip(war && war.typ === k, "reg-war", `data-w="${k}"`, esc(n))).join("")
      + (war && war.typ === "lista" ? (d.listy || ["zakupy"]).map((n) => chip(war.lista === n, "reg-war-lista", `data-l="${esc(n)}"`, "📋 " + esc(n))).join("") : "");
    const okno = REG_OKNA.map(([o, n]) => chip(JSON.stringify(o) === JSON.stringify(rk.okno), "reg-okno", `data-o='${JSON.stringify(o)}'`, n)).join("");
    const akcje = rk.wtedy.map((a, i) => {
      let p = "";
      if (["powiedz", "baner", "discord", "komenda"].includes(a.typ)) p = `<input type="text" class="tekst" id="reg-t-${i}" value="${esc(a.tekst || "")}"
        placeholder="${a.typ === "komenda" ? "np. włącz drukarkę / co mam jutro" : "Tekst — {nazwa}, {minuty}, {lista}, {paczki} podstawią się same"}" style="min-height:34px">`;
      if (["gniazdo", "stanowisko", "ekran"].includes(a.typ)) p = ["on", "off"].map((x) => chip(a.akcja === x, "reg-onoff", `data-i="${i}" data-x="${x}"`,
        a.typ === "ekran" ? (x === "on" ? "obudź" : "uśpij") : (x === "on" ? "włącz" : "wyłącz"))).join("");
      if (a.typ === "gniazdo") p += (d.gniazda || []).map((gn) => chip(a.id === gn.id, "reg-gn", `data-i="${i}" data-id="${esc(gn.id)}"`, esc(gn.nazwa))).join("");
      if (a.typ === "stanowisko") p += `<span class="mala przyg">${esc((d.stanowisko || []).join(", "))}</span>`;
      return `<div class="chipy" style="flex-wrap:nowrap;align-items:center"><b class="mala" style="white-space:nowrap">${esc((d.wtedy || {})[a.typ] || a.typ)}</b>
        <div class="chipy" style="flex:1;min-width:0">${p}</div><button class="maly" data-akcja="reg-usun-a" data-i="${i}">✕</button></div>`;
    }).join("");
    const dodaj = Object.entries(d.wtedy || {}).map(([k, n]) => `<button class="chip maly" data-akcja="reg-dodaj-a" data-typ="${k}">＋ ${esc(n)}</button>`).join("");
    return `<div class="siatka" style="grid-template-columns:minmax(0,1fr) minmax(0,1.15fr)">
      <div style="display:flex;flex-direction:column;gap:8px;min-height:0">
        <div class="karta" style="flex:1.4;min-height:0"><h2>Reguły<span class="prawo">${lista.filter((r) => r.wl).length}/${lista.length} wł. · ${lista.filter((r) => r.wl && r.sucho).length} na sucho</span></h2>
          <div class="przewijane" data-scroll="reg">${wiersze || pustoHtml("Brak reguł — utwórz obok")}</div></div>
        <div class="karta" style="flex:1;min-height:0"><h2>Ostatnio zadziałały<span class="prawo mala">🧪 = tylko zapis · ○ = warunek niespełniony</span></h2><div class="przewijane" data-scroll="regh">${hist || pustoHtml("Jeszcze nic")}</div></div></div>
      <div class="karta" style="gap:7px;overflow:auto"><h2>${rk.id ? "Edycja reguły" : "Nowa reguła"}<span class="prawo"><button class="maly" data-akcja="reg-nowa">＋ nowa</button></span></h2>
        <input type="text" class="tekst" id="reg-nazwa" value="${esc(rk.nazwa)}" placeholder="Nazwa, np. Wychodzę z domu" style="width:100%;flex:none;min-height:40px;font-size:16px">
        <div class="mala przyg">GDY</div><div class="chipy">${gdyChipy}</div>${param}
        <div class="mala przyg">TYLKO JEŚLI</div><div class="chipy">${warChipy}</div>
        <div class="mala przyg">TYLKO W GODZINACH</div><div class="chipy">${okno}</div>
        <div class="mala przyg">WTEDY</div>${akcje || '<div class="mala przyg">Dodaj, co ma się stać:</div>'}
        <div class="chipy">${dodaj}</div>
        <div class="chipy" style="margin-top:auto">${chip(rk.sucho, "reg-sucho", "", rk.sucho ? "🧪 Na sucho — najpierw tylko zapisuje, co by zrobiła" : "⚡ Działa od razu naprawdę")}</div>
        <button class="glowny" data-akcja="reg-zapisz" data-dlugie>⚡ ${rk.id ? "Zapisz zmiany" : "Utwórz regułę"}</button></div></div>`;
  },
};

// ---------- budziki (widok z zakładki Dzień)
const DNI_PN = ["pn", "wt", "śr", "cz", "pt", "sb", "nd"];
const nowyBudzik = { godz: "07:00", dni: [] };
WIDOK.budziki = {
  tytul: () => "Budziki",
  co: 30000,
  html: (w) => {
    const d = w.dane, lista = d.budziki || [];
    const wiersze = lista.map((b) => `<div class="wiersz"><span class="v"><b style="font-size:22px">${b.h}:${dwa(b.m)}</b>
        <span class="przyg">${esc(b.opis)}</span><div class="mala przyg">${b.nastepny ? "dzwoni " + esc(b.nastepny_opis) : "wyłączony"}</div></span>
      <span class="k" style="display:flex;gap:6px">${b.ts ? "" : `<button class="chip maly ${b.wl ? "aktywny" : ""}" data-akcja="budzik-wl" data-id="${esc(b.id)}" data-cmd="${b.wl ? "wyl" : "wl"}">${b.wl ? "Wł." : "Wył."}</button>`}
        <button class="maly" data-akcja="budzik-usun" data-id="${esc(b.id)}" data-potwierdz>Usuń</button></span></div>`).join("");
    const dniChipy = DNI_PN.map((n, i) => `<button class="chip maly ${nowyBudzik.dni.includes(i) ? "aktywny" : ""}" data-akcja="budzik-dzien" data-d="${i}">${n}</button>`).join("");
    const szybkie = [["pn–pt", "0,1,2,3,4"], ["weekend", "5,6"], ["codziennie", "0,1,2,3,4,5,6"], ["jednorazowo", ""]]
      .map(([n, v]) => `<button class="chip maly ${nowyBudzik.dni.join(",") === v ? "aktywny" : ""}" data-akcja="budzik-dni" data-dni="${v}">${n}</button>`).join("");
    const opisNowego = nowyBudzik.dni.length ? "Stały: " + nowyBudzik.dni.map((x) => DNI_PN[x]).join(", ") : "Jednorazowy — najbliższa taka godzina";
    return `<div class="siatka" style="grid-template-columns:1.3fr 1fr">
      <div class="karta"><h2>Nastawione</h2><div class="przewijane" data-scroll="bud">${wiersze || pustoHtml("Brak budzików — dodaj obok albo powiedz „obudź mnie o siódmej”")}</div></div>
      <div class="karta"><h2>Nowy budzik</h2>
        <input type="time" class="tekst" id="budzik-godz" value="${esc(nowyBudzik.godz)}" style="flex:none;width:100%;font-size:30px;min-height:58px;text-align:center">
        <div class="chipy" style="margin-top:10px">${dniChipy}</div>
        <div class="chipy" style="margin-top:6px">${szybkie}</div>
        <div class="mala przyg" style="margin:8px 0">${esc(opisNowego)}</div>
        <button class="glowny" data-akcja="budzik-dodaj">⏰ Dodaj budzik</button>
        <div class="mala przyg" style="margin-top:auto;padding-top:8px">Pika z telefonu (głośność multimediów), drzemka ${d.drzemka_min} min, sam milknie po ${d.max_min} min.
          Głosem: „obudź mnie o siódmej”, „drzemka”, „wyłącz”.</div></div></div>`;
  },
};

// ---------- dzwonienie: stan przychodzi z malinki (stan ekranu), tu tylko dźwięk, nakładka i świt
const budzik = { dzwoni: false, timer: 0, krok: 0, ciszaDo: 0, ostMowa: 0, switDo: 0 };
function budzikEl() {
  let el = $("budzik");
  if (el) return el;
  el = document.createElement("div");
  el.id = "budzik"; el.hidden = true;
  el.innerHTML = `<div class="czas" id="budzik-czas"></div><div class="opis" id="budzik-opis"></div>
    <div class="przyciski"><button class="drzemka" data-akcja="budzik-drzemka" id="budzik-drz">💤 Drzemka</button>
      <button class="wylacz" data-akcja="budzik-stop">Wyłącz</button></div>`;
  document.body.appendChild(el);
  return el;
}
function budzikZastosuj(b, s) {
  if (!b) return;
  if (b.swit_do && b.swit_do > s.now && budzik.switDo !== b.swit_do) { budzik.switDo = b.swit_do; swit(); }
  if (b.dzwoni && !budzik.dzwoni) budzikStart();
  else if (!b.dzwoni && budzik.dzwoni) budzikStop();
  if (b.dzwoni) {
    $("budzik-opis").textContent = b.tekst || "Budzik";
    $("budzik-drz").textContent = `💤 Drzemka ${b.drzemka_min} min`;
  }
}
function swit() {
  // ekran budzi się w czerni i w kilka sekund rozjaśnia (appka nie umie płynnie zmieniać podświetlenia — robi to nakładka)
  let el = $("swit");
  if (!el) { el = document.createElement("div"); el.id = "swit"; document.body.appendChild(el); }
  el.style.transition = "none"; el.style.opacity = "1"; el.hidden = false;
  wake(wakeMin);
  void el.offsetWidth;   // przeliczenie stylu, żeby przejście ruszyło od pełnej czerni
  el.style.transition = ""; el.style.opacity = "0";
  setTimeout(() => { el.hidden = true; }, 3300);
}
function budzikStart() {
  budzik.dzwoni = true; budzik.krok = 0; budzik.ostMowa = Date.now(); budzik.ciszaDo = 0;
  if (widok) zamknijWidok();
  budzikEl().hidden = false;
  wake(wakeMin);
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.resume) audioCtx.resume(); } catch (e) { /* bez dźwięku */ }
  clearInterval(budzik.timer);
  budzik.timer = setInterval(budzikTik, 1300);
  budzikTik();
}
function budzikStop() {
  budzik.dzwoni = false;
  clearInterval(budzik.timer);
  const el = $("budzik"); if (el) el.hidden = true;
}
function budzikTik() {
  const d = new Date();
  $("budzik-czas").textContent = `${d.getHours()}:${dwa(d.getMinutes())}`;
  if (Date.now() < budzik.ciszaDo) return;   // mówi godzinę albo słucha polecenia
  if (Date.now() - budzik.ostMowa > 60000) {
    budzik.ostMowa = Date.now(); budzik.ciszaDo = Date.now() + 4000;
    if (B && B.mow) try { B.mow(`Pobudka. Jest ${d.getHours()}:${dwa(d.getMinutes())}.`); } catch (e) { /* stara appka */ }
    return;
  }
  budzik.krok++;
  const glosnosc = Math.min(1, 0.15 + budzik.krok * 0.03);   // pełna głośność po ~40 s
  try {
    if (audioCtx.state === "suspended" && audioCtx.resume) audioCtx.resume();
    [0, 0.18, 0.36, 0.54].forEach((o, i) => {
      const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
      osc.type = "square"; osc.frequency.value = i % 2 ? 1319 : 988;
      osc.connect(g); g.connect(audioCtx.destination);
      const t0 = audioCtx.currentTime + o;
      g.gain.setValueAtTime(glosnosc * 0.5, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.15);
      osc.start(t0); osc.stop(t0 + 0.16);
    });
  } catch (e) { /* bez dźwięku */ }
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
    case "urz-znane": akcjaPost(b, `/api/siec/urzadzenie/${encodeURIComponent(b.dataset.mac)}`, { znane: true }); break;
    case "urz-edytuj": {
      edytowanyMac = b.dataset.mac; urzPrzerysuj();
      blokadaRenderu = Date.now() + 120000;   // nie przerysowuj, póki piszesz (odświeżanie co 15 s skasowałoby tekst)
      const i = $("urz-nazwa"); if (i) { i.focus(); i.select(); }
      break;
    }
    case "urz-anuluj": edytowanyMac = null; urzPrzerysuj(); break;
    case "urz-usun":
      akcjaPost(b, `/api/siec/urzadzenie/${encodeURIComponent(b.dataset.mac)}`, { usun: true }, (r) => { toast(r.msg); edytowanyMac = null; urzPrzerysuj(); odswiezTeraz(); });
      break;
    case "urz-zapisz": {
      const i = $("urz-nazwa"); const nazwa = i ? i.value : "";
      edytowanyMac = null; blokadaRenderu = 0;
      akcjaPost(b, `/api/siec/urzadzenie/${encodeURIComponent(b.dataset.mac)}`, { nazwa });
      break;
    }
    case "budzik-stop": budzikStop(); akcjaPost(null, "/api/budzik/stop", {}, () => {}); break;
    case "budzik-drzemka": budzikStop(); akcjaPost(null, "/api/budzik/drzemka", {}, (r) => toast(r.msg)); break;
    case "claude-odswiez": akcjaPost(b, "/api/claude-limity/odswiez", {}, (r) => { toast(r.msg); if (aktywna === "claude") odswiezTeraz(); }); break;
    case "listy-otworz": otworzWidok("listy"); break;
    case "todo-lista": todoLista = b.dataset.l || ""; todoNowa = false; renderTodo(todoDane); break;
    case "todo-nowa": todoNowa = !todoNowa; renderTodo(todoDane); if (todoNowa) $("nowe-lista").focus(); break;
    case "reguly-otworz": rk = REG_NOWA(); otworzWidok("reguly"); break;
    case "reg-nowa": rk = REG_NOWA(); blokadaRenderu = 0; rysujWidok(true); break;
    case "reg-edytuj": {
      const r = ((widok && widok.dane && widok.dane.reguly) || []).find((x) => x.id === b.dataset.id);
      if (r) { const c = JSON.parse(JSON.stringify(r)); rk = { ...REG_NOWA(), ...c, sucho: !!c.sucho, warunek: c.warunek || null, gdy: { ...REG_NOWA().gdy, ...c.gdy } }; }
      blokadaRenderu = 0; rysujWidok(true); break;
    }
    case "reg-cmd":
      akcjaPost(b, `/api/reguly/${encodeURIComponent(b.dataset.id)}/${b.dataset.cmd}`, {}, (r) => {
        toast(r.msg);
        if (b.dataset.cmd === "usun" && rk.id === b.dataset.id) rk = REG_NOWA();
        if (widok) { widok.ost = 0; wczytajWidok(); }
      });
      break;
    case "reg-gdy": case "reg-min": case "reg-mac": case "reg-dzien": case "reg-okno": case "reg-miejsce": case "reg-proc":
    case "reg-war": case "reg-war-lista": case "reg-sucho": case "reg-onoff": case "reg-gn": case "reg-dodaj-a": case "reg-usun-a": {
      regZbierz();
      const ds = b.dataset, i = Number(ds.i), g = rk.gdy;
      if (ds.akcja === "reg-gdy") {
        g.typ = ds.typ;
        if (REG_MIN[g.typ] && !REG_MIN[g.typ].includes(g.minuty)) g.minuty = REG_MIN_DOM[g.typ];
        if (g.typ === "dzien_przed" && g.godz === "07:30") g.godz = "20:00";
      }
      if (ds.akcja === "reg-miejsce") g.tylko_miejsce = !g.tylko_miejsce;
      if (ds.akcja === "reg-proc") g.proc = Number(ds.p);
      if (ds.akcja === "reg-war") rk.warunek = ds.w ? { typ: ds.w, lista: ds.w === "lista" ? "zakupy" : undefined } : null;
      if (ds.akcja === "reg-war-lista" && rk.warunek) rk.warunek.lista = ds.l;
      if (ds.akcja === "reg-sucho") rk.sucho = !rk.sucho;
      if (ds.akcja === "reg-min") g.minuty = Number(ds.m);
      if (ds.akcja === "reg-mac") g.mac = ds.mac;
      if (ds.akcja === "reg-dzien") { const x = Number(ds.d); g.dni = g.dni.includes(x) ? g.dni.filter((y) => y !== x) : [...g.dni, x].sort(); }
      if (ds.akcja === "reg-okno") rk.okno = JSON.parse(ds.o);
      if (ds.akcja === "reg-onoff") rk.wtedy[i].akcja = ds.x;
      if (ds.akcja === "reg-gn") rk.wtedy[i].id = ds.id;
      if (ds.akcja === "reg-dodaj-a" && rk.wtedy.length < 6) rk.wtedy.push({ typ: ds.typ, akcja: ds.typ === "stanowisko" ? "off" : "on", tekst: "", id: "" });
      if (ds.akcja === "reg-usun-a") rk.wtedy.splice(i, 1);
      rysujWidok(true); break;
    }
    case "reg-zapisz":
      regZbierz();
      akcjaPost(b, "/api/reguly", rk, (r) => { toast(r.msg); rk = REG_NOWA(); blokadaRenderu = 0; if (widok) { widok.ost = 0; wczytajWidok(); } });
      break;
    case "wydarzenie-otworz": Object.assign(noweWyd, { tytul: "", data: "", godz: "", minuty: 60, miejsce: "" }); otworzWidok("wydarzenie"); break;
    case "wyd-czas": {
      wydZbierz();
      const m = Number(b.dataset.m);
      if (m === 0) noweWyd.godz = ""; else { noweWyd.minuty = m; if (!noweWyd.godz) noweWyd.godz = "18:00"; }
      rysujWidok(true); break;
    }
    case "wyd-dodaj": {
      wydZbierz();
      if (!noweWyd.tytul) { toast("Wpisz tytuł", true); break; }
      akcjaPost(b, "/api/kalendarz", { tytul: noweWyd.tytul, data: noweWyd.data, godzina: noweWyd.godz || null,
        minuty: noweWyd.minuty, miejsce: noweWyd.miejsce || null, zrodlo: "panel" }, (r) => { toast(r.msg); blokadaRenderu = 0; zamknijWidok(); });
      break;
    }
    case "lista-odhacz":
      b.style.opacity = ".4";
      api(`/api/todo/${encodeURIComponent(b.dataset.id)}`, "PATCH", { done: true })
        .then(() => { toast("Odhaczone"); if (widok) { widok.ost = 0; wczytajWidok(); } loadDash(); })
        .catch((err) => { b.style.opacity = ""; toast("Nie odhaczono: " + err.message, true); });
      break;
    case "budziki-otworz": otworzWidok("budziki"); break;
    case "budzik-dzien": {
      const dz = Number(b.dataset.d);
      nowyBudzik.dni = nowyBudzik.dni.includes(dz) ? nowyBudzik.dni.filter((x) => x !== dz) : [...nowyBudzik.dni, dz].sort();
      rysujWidok(true); break;
    }
    case "budzik-dni": nowyBudzik.dni = b.dataset.dni ? b.dataset.dni.split(",").map(Number) : []; rysujWidok(true); break;
    case "budzik-dodaj": {
      const i = $("budzik-godz"); if (i && i.value) nowyBudzik.godz = i.value;
      blokadaRenderu = 0;
      akcjaPost(b, "/api/budzik", { godzina: nowyBudzik.godz, dni: nowyBudzik.dni, zrodlo: "panel" }, (r) => { toast(r.msg); if (widok) { widok.ost = 0; wczytajWidok(); } });
      break;
    }
    case "budzik-wl": case "budzik-usun":
      akcjaPost(b, `/api/budzik/${encodeURIComponent(b.dataset.id)}/${b.dataset.akcja === "budzik-usun" ? "usun" : b.dataset.cmd}`, {},
        (r) => { toast(r.msg); if (widok) { widok.ost = 0; wczytajWidok(); } });
      break;
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

document.addEventListener("focusin", (e) => {
  if (e.target && (e.target.id === "budzik-godz" || String(e.target.id).startsWith("wyd-") || String(e.target.id).startsWith("reg-"))) blokadaRenderu = Date.now() + 120000;
});
document.addEventListener("change", (e) => {
  if (!e.target || e.target.id !== "budzik-godz") return;
  if (e.target.value) nowyBudzik.godz = e.target.value;
  blokadaRenderu = 0;
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target || e.target.id !== "urz-nazwa") return;
  e.preventDefault();
  const z = document.querySelector('[data-akcja="urz-zapisz"]'); if (z) z.click();
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
  if (a.widok && WIDOK[a.widok]) setTimeout(() => otworzWidok(a.widok), 1500);
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
  if (budzik.dzwoni && (stan === "wake" || stan === "czesciowy")) budzik.ciszaDo = Date.now() + 8000;
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
