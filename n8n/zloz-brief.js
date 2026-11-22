// ===== JARVIS — poranny brief (pogoda, kalendarz, zadania TO DO, Paperless, maile, media, awarie, serwer) =====
// Ustawienia
const USER_ID = '340572098873393153';
const TZ = 'Europe/Warsaw';
const PROG_DYSKU = 85;      // % zajętości, od którego dysk dostaje ⚠️
const PROG_TEMP  = 75;      // °C, od którego temperatura dostaje ⚠️

const now = DateTime.now().setZone(TZ);
const dzis = now.startOf('day');
const jutro = dzis.plus({ days: 1 });
const koniecOkna = dzis.plus({ days: 2 });       // do końca jutra
const problemy = [];

function dane(nazwa) {
  try { return $(nazwa).all().map(i => i.json || {}); } catch (e) { return []; }
}
function blad(nazwa, rows) {
  const r = rows.find(x => x && x.error);
  if (r) problemy.push(`${nazwa}: ${String(r.error.message || r.error).slice(0, 120)}`);
  return !!r;
}

// ---------- Kalendarz (ICS z Nextcloud) ----------
const kal = dane('Kalendarz');
const icsRaw = blad('Kalendarz', kal) ? '' : String((kal[0] || {}).data || '');
const ics = icsRaw.replace(/\r?\n[ \t]/g, '');

function wlasciwosci(body, nazwa) {
  const re = new RegExp('^' + nazwa + '((?:;[^:\\r\\n]*)?):(.*)$', 'gim');
  const out = []; let m;
  while ((m = re.exec(body)) !== null) out.push({ params: m[1] || '', value: m[2].trim() });
  return out;
}
const wl = (body, nazwa) => wlasciwosci(body, nazwa)[0] || null;

function parsujDate(value, params) {
  const m = String(value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
  if (!m) return null;
  const [, Y, Mo, D, h, mi, s, z] = m;
  if (h === undefined || /VALUE=DATE(?!-)/i.test(params || '')) {
    return { dt: DateTime.fromObject({ year: +Y, month: +Mo, day: +D }, { zone: TZ }), allDay: true };
  }
  const o = { year: +Y, month: +Mo, day: +D, hour: +h, minute: +mi, second: +(s || 0) };
  const tzm = (params || '').match(/TZID=("?)([^;:"]+)\1/i);
  let dt = DateTime.fromObject(o, { zone: z ? 'utc' : (tzm ? tzm[2] : TZ) });
  if (!dt.isValid) dt = DateTime.fromObject(o, { zone: TZ });  // nieznana nazwa strefy
  return { dt, allDay: false };            // strefa źródłowa — RRULE liczymy w niej (RFC 5545)
}
function czasTrwania(iso) {
  const m = String(iso || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  return { weeks: +(m[2] || 0), days: +(m[3] || 0), hours: +(m[4] || 0), minutes: +(m[5] || 0), seconds: +(m[6] || 0) };
}
const odEscape = s => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
const DNI = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

// Rozwija RRULE do wystąpień w [od, doo). Obsługuje DAILY/WEEKLY/MONTHLY/YEARLY,
// INTERVAL, COUNT, UNTIL, BYDAY (tygodniowo oraz np. 2TU/-1FR miesięcznie), EXDATE.
function rozwin(start, rrule, wyjatki, od, doo) {
  const r = Object.fromEntries(rrule.split(';').map(x => x.split('=')));
  const jedn = { DAILY: 'days', WEEKLY: 'weeks', MONTHLY: 'months', YEARLY: 'years' }[r.FREQ];
  if (!jedn) return [];
  const co = Math.max(1, +(r.INTERVAL || 1));
  const until = r.UNTIL ? (parsujDate(r.UNTIL, '') || {}).dt : null;
  const count = r.COUNT ? +r.COUNT : Infinity;
  const wynik = []; let n = 0;
  for (let i = 0; i < 50000; i++) {
    const baza = start.plus({ [jedn]: i * co });
    let kand = [baza];
    if (r.FREQ === 'WEEKLY' && r.BYDAY) {
      const pon = baza.minus({ days: baza.weekday - 1 });
      kand = r.BYDAY.split(',').map(d => DNI[d.slice(-2)]).filter(Boolean)
        .sort((a, b) => a - b).map(d => pon.plus({ days: d - 1 }));
    } else if (r.FREQ === 'MONTHLY' && r.BYDAY) {
      const mies = start.startOf('month').plus({ months: i * co });
      kand = r.BYDAY.split(',').map(t => {
        const mm = t.match(/^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/);
        if (!mm) return null;
        const nth = +(mm[1] || 1), wd = DNI[mm[2]];
        let d;
        if (nth > 0) d = mies.plus({ days: (wd - mies.weekday + 7) % 7 }).plus({ weeks: nth - 1 });
        else { const ost = mies.endOf('month').startOf('day'); d = ost.minus({ days: (ost.weekday - wd + 7) % 7 }).plus({ weeks: nth + 1 }); }
        if (d.month !== mies.month) return null;
        return d.set({ hour: start.hour, minute: start.minute, second: start.second });
      }).filter(Boolean).sort((a, b) => a - b);
    } else if (['MONTHLY', 'YEARLY'].includes(r.FREQ) && baza.day !== start.day) {
      kand = [];                                    // np. 31. w miesiącu bez 31 dni — pomijamy
    }
    for (const c of kand) {
      if (c < start) continue;
      if (until && c > until) return wynik;
      if (++n > count) return wynik;
      if (c >= doo) return wynik;
      if (c >= od && !wyjatki.has(c.toMillis())) wynik.push(c);
    }
    if (baza.minus({ days: 31 }) > doo) break;
  }
  return wynik;
}

const bloki = ics.split('BEGIN:VEVENT').slice(1).map(b => b.split('END:VEVENT')[0]);
const nadpisane = new Set();                       // UID|czas — wystąpienia przeniesione/odwołane
for (const b of bloki) {
  const rid = wl(b, 'RECURRENCE-ID'), uid = wl(b, 'UID');
  if (rid && uid) { const p = parsujDate(rid.value, rid.params); if (p) nadpisane.add(uid.value + '|' + p.dt.toMillis()); }
}
const wydarzenia = [];
for (const b of bloki) {
  if (/^STATUS:CANCELLED/im.test(b)) continue;
  const ds = wl(b, 'DTSTART'); if (!ds) continue;
  const st = parsujDate(ds.value, ds.params); if (!st) continue;
  const uid = (wl(b, 'UID') || {}).value || '';
  const tytul = odEscape(((wl(b, 'SUMMARY') || {}).value) || '(bez tytułu)');
  const de = wl(b, 'DTEND'), du = wl(b, 'DURATION');
  let dur;
  if (de) { const e = parsujDate(de.value, de.params); dur = e ? e.dt.diff(st.dt).toObject() : null; }
  else if (du) dur = czasTrwania(du.value);
  if (!dur) dur = st.allDay ? { days: 1 } : { minutes: 0 };
  const koniec = st.dt.plus(dur);
  const dlugoscMs = Math.max(0, koniec.toMillis() - st.dt.toMillis());
  const od = dzis.minus({ milliseconds: dlugoscMs + 1 });
  let starty;
  const rr = wl(b, 'RRULE');
  if (rr && !wl(b, 'RECURRENCE-ID')) {
    const wyj = new Set();
    for (const ex of wlasciwosci(b, 'EXDATE')) for (const v of ex.value.split(',')) {
      const p = parsujDate(v, ex.params); if (p) wyj.add(p.dt.toMillis());
    }
    for (const k of nadpisane) if (k.startsWith(uid + '|')) wyj.add(+k.split('|')[1]);
    starty = rozwin(st.dt, rr.value, wyj, od, koniecOkna);
  } else starty = [st.dt];
  for (const s of starty) {
    const e = s.plus({ milliseconds: dlugoscMs });
    const granica = st.allDay ? dzis : now;           // zakończone dziś rano już nie interesują
    if (s < koniecOkna && (e > granica || (dlugoscMs === 0 && s >= now))) {
      wydarzenia.push({ tytul, s: s.setZone(TZ), e: e.setZone(TZ), allDay: st.allDay });
    }
  }
}
wydarzenia.sort((a, b) => (a.allDay === b.allDay ? a.s - b.s : (a.allDay ? -1 : 1)));

// ---------- Pogoda w miejscu wydarzeń (panel na malince: GET /api/kalendarz/pogoda; węzeł „Pogoda wydarzeń”) ----------
// Panel geokoduje pole „Miejsce” i bierze prognozę Open-Meteo na godzinę wydarzenia. Brak węzła = brak dopisków.
const pogWyd = {};
for (const r of dane('Pogoda wydarzeń')) for (const w of (r.wydarzenia || [])) {
  if (!w || !w.pogoda) continue;
  pogWyd[`${w.tytul}|${DateTime.fromISO(w.start, { zone: TZ }).toMillis()}`] = `📍 ${w.miejsce} ${w.pogoda}`;
}
const pogDla = w => { const p = pogWyd[`${w.tytul}|${w.s.toMillis()}`]; return p ? ` — ${p}` : ''; };

function linieDnia(dzien) {
  const kon = dzien.plus({ days: 1 });
  return wydarzenia.filter(w => w.s < kon && w.e > dzien || (w.s >= dzien && w.s < kon))
    .map(w => w.allDay ? `• 🗓️ **${w.tytul}** — cały dzień${pogDla(w)}`
      : `• **${w.s.toFormat('HH:mm')}** ${w.tytul}${w.s < dzien ? ' (trwa)' : ''}${pogDla(w)}`);
}

// ---------- Zadania (lista TO DO na malince, GET /api/todos?open=1 -> { tasks: [...] }) ----------
// due: null | 'RRRR-MM-DD' (do końca dnia) | 'RRRR-MM-DDTHH:MM' (czas lokalny)
const zad = dane('Zadania');
const zadaniaWszystkie = blad('Zadania', zad) ? [] : (Array.isArray((zad[0] || {}).tasks) ? zad[0].tasks : []);
// listy (zakupy, prezenty… — pole "lista", od 2026-11-20) nie są zadaniami: osobno, tylko liczba pozycji
const zadania = zadaniaWszystkie.filter(t => !t.lista);
const inneListy = {};
for (const t of zadaniaWszystkie) if (t && t.lista && !t.done) inneListy[t.lista] = (inneListy[t.lista] || 0) + 1;
const poTerminie = [], naDzis = [], naJutro = [], wTygodniu = [], bezTerminu = [];
for (const t of zadania) {
  if (!t || t.done || !t.title) continue;
  const etykieta = `**${String(t.title).slice(0, 150)}**`;
  if (!t.due) { bezTerminu.push({ due: t.id, txt: `• ${etykieta}` }); continue; }
  const maGodz = String(t.due).includes('T');
  const due = DateTime.fromISO(String(t.due), { zone: TZ });
  if (!due.isValid) continue;
  const koniec = maGodz ? due : due.endOf('day');
  const godz = maGodz ? ` ${due.toFormat('HH:mm')}` : '';
  if (koniec < now) {
    const n = Math.round(dzis.diff(due.startOf('day'), 'days').days);
    poTerminie.push({ due, txt: `• ${etykieta} — ${due.setLocale('pl').toFormat('d MMM')}${godz} (${n === 0 ? 'dziś' : n === 1 ? 'wczoraj' : `${n} dni temu`})` });
  }
  else if (due < jutro) naDzis.push({ due, txt: `• ${etykieta}${maGodz ? ` — do ${due.toFormat('HH:mm')}` : ''}` });
  else if (due < koniecOkna) naJutro.push({ due, txt: `• ${etykieta}${maGodz ? ` — jutro ${due.toFormat('HH:mm')}` : ''}` });
  else if (due < dzis.plus({ days: 8 })) wTygodniu.push({ due, txt: `• ${etykieta} — ${due.setLocale('pl').toFormat('ccc d.MM')}${godz}` });
}
for (const l of [poTerminie, naDzis, naJutro, wTygodniu, bezTerminu]) l.sort((a, b) => a.due - b.due);

// ---------- Stan serwera (Glances) ----------
const fs = dane('Glances dyski'), sen = dane('Glances temperatury');
const linieSerwer = [];
if (!blad('Glances dyski', fs)) {
  // Glances w Dockerze widzi dyski hosta pod „dziwnymi” ścieżkami (np. /etc/hostname) —
  // grupujemy po urządzeniu i pomijamy systemy wirtualne / małe partycje.
  const gb = x => (x / 1024 ** 3).toFixed(0);
  const wg = {};
  for (const d of fs) {
    if (!d.device_name || !d.size || d.size < 2 * 1024 ** 3) continue;
    if (/^(tmpfs|overlay|squashfs|devtmpfs|shm|nsfs|efivarfs|vfat)$/i.test(d.fs_type || '')) continue;
    const mp = String(d.mnt_point || '');
    if (/^\/(boot|snap)/.test(mp)) continue;
    const k = d.device_name;
    if (!wg[k] || mp.length < String(wg[k].mnt_point).length) wg[k] = d;
  }
  const dyski = Object.values(wg).sort((a, b) => b.size - a.size);
  for (const d of dyski) {
    const mp = /^\/(etc\/|host$)/.test(d.mnt_point) ? '/' : String(d.mnt_point).replace(/^\/host(?=\/)/, '');
    const dev = String(d.device_name).replace(/^\/dev\//, '');
    linieSerwer.push(`${d.percent >= PROG_DYSKU ? '⚠️' : '💾'} \`${mp}\` (${dev}) ${Math.round(d.percent)}% — ${gb(d.used)}/${gb(d.size)} GB`);
  }
  if (!dyski.length && fs.some(d => d && d.mnt_point)) problemy.push(`Glances dyski: brak pasujących dysków (${fs.length} wpisów)`);
}
if (!blad('Glances temperatury', sen)) {
  const temp = sen.filter(s => typeof s.value === 'number' && /temperature/i.test(s.type || ''));
  const cpu = temp.filter(s => /core/i.test(s.type));
  const hdd = temp.filter(s => /hdd/i.test(s.type));
  const pokaz = (nazwa, l) => {
    if (!l.length) return;
    const max = l.reduce((a, b) => (b.value > a.value ? b : a));
    linieSerwer.push(`${max.value >= PROG_TEMP ? '⚠️' : '🌡️'} ${nazwa}: maks. ${Math.round(max.value)}°C`);
  };
  pokaz('CPU', cpu); pokaz('Dyski', hdd);
}

// ---------- Paperless (pola własne) ----------
const PAPERLESS_URL = 'http://100.93.105.37:8010';    // ten sam adres co w węzłach „Paperless …”
const POLA = { termin: 'Termin płatności', zaplacone: 'Zapłacone', gwarancja: 'Gwarancja do', wazne: 'Ważne do', kwota: 'Kwota' };
const DNI_PLATNOSC = 7, DNI_KONIEC = 30;
const doZaplaty = [], konczySie = [];
const ppl = dane('Paperless pola'), pdo = dane('Paperless dokumenty');
const bladPP = blad('Paperless pola', ppl), bladPD = blad('Paperless dokumenty', pdo);
if (!bladPP && !bladPD) {
  const idPola = {};
  for (const f of ((ppl[0] || {}).results || [])) idPola[String(f.name).toLowerCase()] = f.id;
  const id = k => idPola[POLA[k].toLowerCase()];
  if (ppl[0] && Array.isArray(ppl[0].results) && !id('termin') && !id('gwarancja') && !id('wazne')) problemy.push(`Paperless: brak pól „${POLA.termin}” / „${POLA.gwarancja}” / „${POLA.wazne}”`);
  const za = n => (n === 0 ? '**dziś**' : n === 1 ? 'jutro' : `za ${n} dni`);
  for (const d of ((pdo[0] || {}).results || [])) {
    const w = {};
    for (const cf of d.custom_fields || []) w[cf.field] = cf.value;
    const data = k => {
      const v = id(k) !== undefined ? w[id(k)] : null;
      if (!v) return null;
      const dt = DateTime.fromISO(String(v), { zone: TZ });
      return dt.isValid ? dt.startOf('day') : null;
    };
    const link = `[${String(d.title || 'dokument').replace(/[\[\]]/g, '').slice(0, 70)}](${PAPERLESS_URL}/documents/${d.id}/details)`;
    const t = data('termin');
    if (t && w[id('zaplacone')] !== true && t <= dzis.plus({ days: DNI_PLATNOSC })) {
      const n = Math.round(t.diff(dzis, 'days').days);
      const kw = w[id('kwota')] ? ` — ${String(w[id('kwota')]).replace(/^([A-Z]{3})(.+)$/, '$2 $1')}` : '';
      doZaplaty.push({ t, txt: `• ${n < 0 ? '⚠️ ' : ''}${link}${kw} — ${n < 0 ? `${-n} dni po terminie` : za(n)} (${t.toFormat('dd.MM')})` });
    }
    for (const [k, opis] of [['gwarancja', 'gwarancja'], ['wazne', 'ważne do']]) {
      const e = data(k);
      if (e && e >= dzis && e <= dzis.plus({ days: DNI_KONIEC })) {
        konczySie.push({ t: e, txt: `• ${link} — ${opis} ${e.toFormat('dd.MM')} (${za(Math.round(e.diff(dzis, 'days').days))})` });
      }
    }
  }
  for (const l of [doZaplaty, konczySie]) l.sort((a, b) => a.t - b.t);
}

// ---------- Pogoda (Open-Meteo) ----------
const WMO = { 0: ['☀️', 'bezchmurnie'], 1: ['🌤️', 'przeważnie słonecznie'], 2: ['⛅', 'częściowe zachmurzenie'], 3: ['☁️', 'pochmurno'],
  45: ['🌫️', 'mgła'], 48: ['🌫️', 'mgła osadzająca szadź'], 51: ['🌦️', 'lekka mżawka'], 53: ['🌦️', 'mżawka'], 55: ['🌧️', 'gęsta mżawka'],
  56: ['🌧️', 'marznąca mżawka'], 57: ['🌧️', 'marznąca mżawka'], 61: ['🌧️', 'lekki deszcz'], 63: ['🌧️', 'deszcz'], 65: ['🌧️', 'ulewny deszcz'],
  66: ['🌧️', 'marznący deszcz'], 67: ['🌧️', 'marznący deszcz'], 71: ['🌨️', 'lekki śnieg'], 73: ['🌨️', 'śnieg'], 75: ['❄️', 'intensywny śnieg'],
  77: ['🌨️', 'ziarnisty śnieg'], 80: ['🌦️', 'przelotny deszcz'], 81: ['🌧️', 'przelotne opady'], 82: ['⛈️', 'gwałtowne ulewy'],
  85: ['🌨️', 'przelotny śnieg'], 86: ['❄️', 'śnieżyce'], 95: ['⛈️', 'burza'], 96: ['⛈️', 'burza z gradem'], 99: ['⛈️', 'burza z gradem'] };
const num = x => (typeof x === 'number' && isFinite(x) ? x : 0);
const pog = dane('Pogoda');
const liniePogoda = [];
if (!blad('Pogoda', pog) && pog[0] && pog[0].daily && Array.isArray(pog[0].daily.time)) {
  const d = pog[0].daily, c = pog[0].current || {};
  const opisDnia = (i, nazwa) => {
    const [ik, opis] = WMO[d.weather_code[i]] || ['🌡️', 'brak opisu'];
    let s = `${ik} **${nazwa}:** ${opis}, ${Math.round(num(d.temperature_2m_min[i]))}…${Math.round(num(d.temperature_2m_max[i]))}°C`;
    const szansa = num(d.precipitation_probability_max[i]), opad = num(d.precipitation_sum[i]);
    if (szansa >= 30 || opad >= 0.5) s += `, opady ${Math.round(szansa)}% (${opad.toFixed(1)} mm)`;
    if (num(d.wind_speed_10m_max[i]) >= 40) s += `, wiatr do ${Math.round(d.wind_speed_10m_max[i])} km/h`;
    return s;
  };
  if (typeof c.temperature_2m === 'number') liniePogoda.push(`🌡️ Teraz ${Math.round(c.temperature_2m)}°C (odczuwalna ${Math.round(num(c.apparent_temperature))}°C)`);
  liniePogoda.push(opisDnia(0, 'Dziś'));
  if (num(d.precipitation_probability_max[0]) >= 50 || num(d.precipitation_sum[0]) >= 1) liniePogoda.push('☂️ Weź parasol');
  if (typeof d.temperature_2m_min[0] === 'number' && d.temperature_2m_min[0] <= 0) liniePogoda.push('🧊 Możliwy przymrozek — uwaga na drodze');
  if (d.time.length > 1) liniePogoda.push(opisDnia(1, 'Jutro'));
}

// ---------- Nowe dokumenty w Paperlessie (24 h) ----------
const pnw = dane('Paperless nowe');
const linieNowe = [];
if (!blad('Paperless nowe', pnw)) {
  const nazwaPola = {};
  for (const f of ((ppl[0] || {}).results || [])) nazwaPola[f.id] = f.name;
  const polaDat = new Set(Object.values(POLA).filter(n => !/zapłacone|kwota/i.test(n)).map(n => n.toLowerCase()));
  // PDF-y importowane przez panel z Nextclouda (tag = folder) — jedna zbiorcza linia zamiast listy
  const TAGI_NEXTCLOUD = { 5: 'Dokumenty', 6: 'Studia' };
  const zNc = {};
  for (const d of ((pnw[0] || {}).results || [])) {
    const nc = (d.tags || []).map(t => TAGI_NEXTCLOUD[t]).find(Boolean);
    if (nc) { zNc[nc] = (zNc[nc] || 0) + 1; continue; }
    const puste = (d.custom_fields || [])
      .filter(cf => (cf.value === null || cf.value === '') && polaDat.has(String(nazwaPola[cf.field] || '').toLowerCase()))
      .map(cf => nazwaPola[cf.field]);
    const t = String(d.title || 'dokument').replace(/[\[\]]/g, '').slice(0, 70);
    linieNowe.push(`• [${t}](${PAPERLESS_URL}/documents/${d.id}/details)${puste.length ? ` — ⚠️ uzupełnij: ${puste.join(', ')}` : ''}`);
  }
  const ncOpis = Object.entries(zNc).map(([f, n]) => `${f}: ${n}`).join(', ');
  if (ncOpis) linieNowe.push(`• 📂 z Nextclouda — ${ncOpis}`);
}

// ---------- Ważne maile (24 h, etykiety AI: BIZNES / OSOBISTE) ----------
const linieMaile = [];
for (const [wezel, konto] of [['Maile ważne – macmalonet783', 'macmalonet783'], ['Maile ważne – maciejmalina19', 'maciejmalina19']]) {
  const r = dane(wezel);
  if (blad(wezel, r)) continue;
  for (const m of r) {
    if (!m || !m.id) continue;
    const od = String(m.From || m.from || '').replace(/\s*<[^>]+>$/, '').replace(/"/g, '') || '(nieznany)';
    linieMaile.push(`• **${od}** — ${String(m.Subject || m.subject || '(bez tematu)')}`.slice(0, 160) + (konto === 'maciejmalina19' ? ' ²' : ''));
  }
}

// ---------- Media: Sonarr / Radarr (24 h) ----------
const linieMedia = [];
const son = dane('Sonarr'), rad = dane('Radarr');
if (!blad('Sonarr', son)) {
  const seriale = {};
  for (const h of son) {
    if (!h || !h.eventType) continue;
    const tytul = (h.series && h.series.title) || h.sourceTitle || '(serial)';
    if (h.eventType === 'downloadFolderImported') {
      const e = h.episode || {};
      (seriale[tytul] = seriale[tytul] || new Set()).add(e.seasonNumber != null
        ? `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}` : '');
    } else if (h.eventType === 'downloadFailed') linieMedia.push(`❌ Nie pobrano: ${String(h.sourceTitle || tytul).slice(0, 100)}`);
  }
  for (const [t, zb] of Object.entries(seriale)) {
    const odc = [...zb].filter(Boolean).sort();
    const opis = !odc.length ? 'nowy odcinek' : odc.length > 4 ? `${odc.length} odcinków (${odc[0]}–${odc[odc.length - 1]})` : odc.join(', ');
    linieMedia.unshift(`📺 **${t}** — ${opis}`);
  }
}
if (!blad('Radarr', rad)) {
  const filmy = new Set();
  for (const h of rad) {
    if (!h || !h.eventType) continue;
    const t = h.movie ? `${h.movie.title}${h.movie.year ? ` (${h.movie.year})` : ''}` : (h.sourceTitle || '(film)');
    if (h.eventType === 'downloadFolderImported') filmy.add(t);
    else if (h.eventType === 'downloadFailed') linieMedia.push(`❌ Nie pobrano: ${String(h.sourceTitle || t).slice(0, 100)}`);
  }
  for (const t of filmy) linieMedia.unshift(`🎬 **${t}**`);
}

// ---------- Uptime Kuma: awarie i backup (pokazywane TYLKO gdy coś nie tak) ----------
const ks = dane('Kuma strona'), kh = dane('Kuma stan');
const linieAwarie = [], linieBackup = [];
const bladKs = blad('Kuma strona', ks), bladKh = blad('Kuma stan', kh);
if (!bladKs && !bladKh && ks[0] && kh[0]) {
  const czasKumy = t => {
    const s = String(t || '');
    let d = DateTime.fromSQL(s, { zone: 'utc' });
    if (!d.isValid) d = DateTime.fromISO(s, { zone: 'utc' });
    return d.setZone(TZ);
  };
  const nazwy = {};
  for (const g of ks[0].publicGroupList || []) for (const m of g.monitorList || []) nazwy[m.id] = m.name;
  if (!Object.keys(nazwy).length) problemy.push('Uptime Kuma: strona statusu „brief” nie ma monitorów');
  const hb = kh[0].heartbeatList || {}, up = kh[0].uptimeList || {};
  for (const [id, nazwa] of Object.entries(nazwy)) {
    const beats = [...(hb[id] || [])].sort((a, b) => czasKumy(a.time) - czasKumy(b.time));
    const ost = beats[beats.length - 1] || null;
    const teraz = ost ? ost.status : null;          // 1 działa, 0 awaria, 2 oczekuje, 3 przerwa techniczna
    if (/backup/i.test(nazwa)) {
      if (teraz !== 1) linieBackup.push(`❌ **${nazwa}** — ${ost ? `${String(ost.msg || 'błąd').slice(0, 120)} (${czasKumy(ost.time).toFormat('dd.MM HH:mm')})` : 'brak sygnału'}`);
      continue;
    }
    const uptime = up[`${id}_24`];
    const ostAwaria = [...beats].reverse().find(b => b.status === 0);
    const swieza = ostAwaria && czasKumy(ostAwaria.time) > now.minus({ hours: 12 });
    if (!((typeof uptime === 'number' && uptime < 0.995) || teraz === 0 || swieza)) continue;
    const pct = typeof uptime === 'number' ? ` — 24 h: ${(uptime * 100).toFixed(1)}%` : '';
    const kiedy = ostAwaria ? `, ostatnio padło ${czasKumy(ostAwaria.time).toFormat('dd.MM HH:mm')}` : '';
    linieAwarie.push(`• **${nazwa}** ${teraz === 0 ? '🔴 nadal nie działa' : '🟢 już działa'}${pct}${kiedy}`);
  }
}

// ---------- Trener (appka treningowa na malince, GET /api/brief -> { lines: [...] }) ----------
const tr = dane('Trener');
const linieTrening = blad('Trener', tr) ? [] : (Array.isArray((tr[0] || {}).lines) ? tr[0].lines : []);

// ---------- Złożenie embeda (limity Discorda: pole ≤1024 znaki) ----------
function pole(nazwa, linie) {
  if (!linie.length) return null;
  let wart = '', i = 0;
  for (; i < linie.length; i++) {
    const kolejna = (wart ? wart + '\n' : '') + linie[i];
    if (kolejna.length > 990) break;
    wart = kolejna;
  }
  if (i < linie.length) wart += `\n…i ${linie.length - i} więcej`;
  return { name: nazwa, value: wart };
}
const fmtDzien = d => d.setLocale('pl').toFormat('cccc, d MMMM');
const fields = [
  pole('🌦️ Pogoda — Sułkowice', liniePogoda),
  pole(`📅 Dziś — ${fmtDzien(dzis)}`, linieDnia(dzis)),
  pole(`📅 Jutro — ${fmtDzien(jutro)}`, linieDnia(jutro)),
  pole('⚠️ Zadania po terminie', poTerminie.map(x => x.txt)),
  pole('✅ Zadania na dziś', naDzis.map(x => x.txt)),
  pole('🕐 Zadania na jutro', naJutro.map(x => x.txt)),
  pole('📆 Zadania w tym tygodniu', wTygodniu.map(x => x.txt)),
  pole('📝 Lista TO DO (bez terminu)', bezTerminu.map(x => x.txt)),
  pole('📋 Listy', Object.entries(inneListy).map(([n, c]) => `• **${n}**: ${c} poz.`)),
  pole(`💳 Do zapłaty (${DNI_PLATNOSC} dni)`, doZaplaty.map(x => x.txt)),
  pole(`⏳ Kończy się (${DNI_KONIEC} dni)`, konczySie.map(x => x.txt)),
  pole('📄 Nowe w Paperlessie (24 h)', linieNowe),
  pole('📧 Ważne maile (24 h)', linieMaile),
  pole('🍿 Media (24 h)', linieMedia),
  pole('🏋️ Trening', linieTrening),
  pole('💾 Backup — PROBLEM', linieBackup),
  pole('🚨 Awarie (Uptime Kuma)', linieAwarie),
  pole('🖥️ Serwer', linieSerwer),
  pole('❗ Problemy z danymi', problemy),
].filter(Boolean);
// Discord: cały embed ≤ 6000 znaków — przy nadmiarze skracamy najdłuższe pola
const dlugosc = () => fields.reduce((n, f) => n + f.name.length + f.value.length, 60);
for (let i = 0; i < 200 && dlugosc() > 5700; i++) {
  const f = fields.reduce((a, b) => (b.value.length > a.value.length ? b : a));
  const linie = f.value.split('\n').filter(l => !l.startsWith('…i '));
  const ile = Math.max(1, Math.floor(linie.length * 0.7));
  const ukryte = (+(f.value.match(/…i (\d+) więcej$/) || [0, 0])[1]) + (linie.length - ile);
  f.value = linie.slice(0, ile).join('\n') + (ukryte ? `\n…i ${ukryte} więcej` : '');
  if (linie.length === 1) f.value = f.value.slice(0, 300);
}
const zrodlaOk = !problemy.some(p => /^(Kalendarz|Zadania):/.test(p));
if (zrodlaOk && !fields.some(f => /📅|Zadania/.test(f.name))) {
  fields.unshift({ name: '📅 Kalendarz i zadania', value: 'Nic zaplanowanego na dziś i jutro 🎉' });
}

return [{ json: {
  content: `<@${USER_ID}>`,
  embeds: [{
    title: `🌅 Dzień dobry — ${fmtDzien(dzis)}`,
    color: linieBackup.length || linieAwarie.some(l => l.includes('🔴')) ? 15158332
      : poTerminie.length || problemy.length || linieAwarie.length || doZaplaty.some(x => x.t < dzis) ? 15105570 : 5793266,
    fields,
    footer: { text: linieMaile.some(l => l.endsWith('²')) ? 'JARVIS • poranny brief • ² = maciejmalina19' : 'JARVIS • poranny brief' },
    timestamp: now.toISO(),
  }],
  allowed_mentions: { users: [USER_ID] },
} }];
