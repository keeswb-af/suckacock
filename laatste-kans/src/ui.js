'use strict';
/* ============================================================
   DOM helpers
   ============================================================ */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
function fill(el, ...kids) { el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false)); }
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2400); }

/* ============================================================
   Storage: the viewer's private space in the artifact database when
   available, else this browser. A local mirror keeps every change, so
   a visit that could not reach the database is synced on the next one.
   ============================================================ */
/* ============================================================
   Host bridge. Inside the Scriptable app on the iPhone, the native
   script injects window.LK_HOST = {kind, state, live} before this page
   runs. The page never calls the native side directly: it puts
   messages in an outbox that the native script polls (LK_TAKE), and the
   native script pushes live AH data in with LK_LIVE / LK_LIVE_STATUS.
   ============================================================ */
const HOST = (window.LK_HOST && window.LK_HOST.kind) ? window.LK_HOST : null;
const OUTBOX = [];
function hostSend(cmd, arg) {
  if (!HOST) return;
  if (cmd === 'save' && OUTBOX.some(m => m.cmd === 'save')) return;
  OUTBOX.push({ cmd, arg: arg == null ? null : arg });
}
window.LK_TAKE = () => JSON.stringify(OUTBOX.splice(0));
window.LK_EXPORT = () => JSON.stringify({ profile: S.profile, session: S.session, trips: S.trips });

const Store = {
  db: null, uid: null, mode: 'local', inViewer: false, loaded: false,
  pending: {}, timers: {}, chains: {}, failed: false, unsub: [],
  async init() {
    if (HOST) { this.mode = 'host'; return; }
    this.inViewer = !!(window.claude && typeof window.claude.use === 'function');
    if (!this.inViewer) return;
    let db = null, user = null;
    try { [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]); } catch (e) { db = null; }
    if (!db || !user) return;
    let id = null;
    try { id = await user.id(); } catch (e) { id = null; }
    if (!id) return;
    this.db = db; this.uid = id; this.mode = 'db';
  },
  lk(key) { return 'lk:' + (this.uid ? this.uid + ':' : '') + key; },
  localGet(key) { try { const s = localStorage.getItem(this.lk(key)); return s ? JSON.parse(s) : null; } catch (e) { return null; } },
  localSet(key, v) { if (this.mode === 'host') return; try { localStorage.setItem(this.lk(key), JSON.stringify(v)); } catch (e) { /* storage may be blocked */ } },
  ref(key) { return this.db.doc(`data/users/${this.uid}/${key}`); },
  tripsCol() { return this.db.doc(`data/users/${this.uid}/log`).collection('trips'); },
  async retry(fn) {
    try { return await fn(); }
    catch (e) {
      const c = e && e.code;
      if (c === 'invalid_argument' || c === 'quota_exceeded' || c === 'revoked' || c === 'not_granted') throw e;
      await sleep(200 + Math.random() * 600);
      return fn();
    }
  },
  async load(key) {
    if (this.mode === 'host') return HOST.state && HOST.state[key] != null ? clone(HOST.state[key]) : null;
    if (!this.db) return this.localGet(key);
    const snap = await this.retry(() => this.ref(key).get());
    return snap && snap.exists ? clone(snap.data()) : null;
  },
  save(key, value) {
    value.savedAt = Date.now();
    if (this.mode === 'host') { if (this.loaded) hostSend('save'); return; }
    this.localSet(key, value);
    if (!this.db || !this.loaded) return;
    this.pending[key] = clone(value);
    clearTimeout(this.timers[key]);
    this.timers[key] = setTimeout(() => this.flush(key), 500);
  },
  flush(key) {
    if (!(key in this.pending) || !this.db) return Promise.resolve();
    clearTimeout(this.timers[key]);
    const value = this.pending[key]; delete this.pending[key];
    this.chains[key] = (this.chains[key] || Promise.resolve())
      .then(() => this.retry(() => this.ref(key).set(value)))
      .then(() => this.onWriteOk(), e => this.onWriteError(e));
    return this.chains[key];
  },
  flushAll() { return Promise.all(Object.keys(this.pending).map(k => this.flush(k))); },
  onWriteOk() { if (this.failed) { this.failed = false; showLoadBanner(null); } },
  onWriteError(e) {
    this.failed = true;
    const c = e && e.code;
    showLoadBanner(c === 'quota_exceeded' || c === 'invalid_argument'
      ? 'Je gegevens zijn te groot om op te slaan. Wis oude producten of ritten.'
      : 'Opslaan in je account lukt even niet. Alles staat op dit toestel en wordt bij je volgende bezoek bijgewerkt.');
  },
  watch(key, getCur, apply) {
    if (!this.db) return;
    try {
      const u = this.ref(key).onSnapshot(snap => {
        if (!snap.exists || snap.metadata.hasPendingWrites || key in this.pending) return;
        const d = snap.data();
        if ((d.savedAt || 0) > ((getCur() || {}).savedAt || 0)) apply(clone(d));
      }, () => { /* the listener ended; the page keeps working with what it has */ });
      this.unsub.push(u);
    } catch (e) { /* ignore */ }
  },
  unsynced() { return this.localGet('unsyncedTrips') || []; },
  async listTrips() {
    if (this.mode === 'host') return HOST.state && Array.isArray(HOST.state.trips) ? clone(HOST.state.trips) : [];
    if (!this.db) return this.localGet('trips') || [];
    const qs = await this.retry(() => this.tripsCol().orderBy('ts', 'desc').limit(300).get());
    return qs.docs.map(d => Object.assign({ id: d.id }, clone(d.data())));
  },
  async addTrip(trip) {
    if (this.mode === 'host') { hostSend('save'); return 'host'; }
    const all = [trip, ...(this.localGet('trips') || []).filter(t => t.id !== trip.id)].slice(0, 300);
    this.localSet('trips', all);
    if (!this.db) { if (this.inViewer) this.localSet('unsyncedTrips', [...this.unsynced().filter(t => t.id !== trip.id), trip]); return 'local'; }
    try { await this.retry(() => this.tripsCol().doc(trip.id).set(trip)); return 'db'; }
    catch (e) { this.localSet('unsyncedTrips', [...this.unsynced().filter(t => t.id !== trip.id), trip]); return 'local'; }
  },
  async deleteTrip(id) {
    if (this.mode === 'host') { setTimeout(() => hostSend('save'), 0); return; }
    this.localSet('trips', (this.localGet('trips') || []).filter(t => t.id !== id));
    this.localSet('unsyncedTrips', this.unsynced().filter(t => t.id !== id));
    if (this.db) await this.retry(() => this.tripsCol().doc(id).delete());
  },
  async syncTrips(dbTrips) {
    const have = new Set(dbTrips.map(t => t.id));
    const todo = this.unsynced().filter(t => !have.has(t.id));
    const done = [];
    for (const t of todo) { try { await this.retry(() => this.tripsCol().doc(t.id).set(t)); done.push(t); } catch (e) { break; } }
    this.localSet('unsyncedTrips', this.unsynced().filter(t => !done.some(d => d.id === t.id) && !have.has(t.id)));
    return done;
  },
};
window.addEventListener('pagehide', () => { try { Store.flushAll(); } catch (e) { /* ignore */ } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { try { Store.flushAll(); } catch (e) { /* ignore */ } } });

/* ============================================================
   App state
   ============================================================ */
const S = {
  profile: defaultProfile(),
  draft: null,
  session: emptySession(),
  trips: [],
  tab: 'winkel',
  editing: null,
  form: { disc: 35, exp: 'vandaag' },
  sample: null, sampleImages: false, sampleMax: 3,
  adviceCtl: null, photoCtl: null, estCtl: null,
  finishing: false, pendingTripId: null,
  live: { status: 'idle', message: null, per: {} },
};
function emptySession() { return { candidates: [], basket: [], pantry: [], startedAt: null, savedAt: 0, hiddenAH: [], liveFilter: 'fit', storeFilter: 'all', liveMeta: {} }; }
function normalizeSession(d) {
  const s = Object.assign(emptySession(), d || {});
  for (const k of ['candidates', 'basket', 'pantry']) s[k] = (Array.isArray(s[k]) ? s[k] : []).map(migrateItem).filter(Boolean);
  // Live items from before multi-store support have no store: drop them, the next refresh brings them back.
  s.candidates = s.candidates.filter(c => c.source !== 'ah' || c.storeKey || c.edited);
  const m = s.liveMeta;
  s.liveMeta = !m || typeof m !== 'object' ? {} : m.storeKey ? {} : m;
  return s;
}
function normalizeProfile(d) {
  const p = Object.assign(defaultProfile(), d || {});
  p.filters = normalizeFilters(d && d.filters !== undefined ? d.filters : defaultFilters());
  p.stores = profileStores(p);
  delete p.store;
  return p;
}
function myStores() { return profileStores(S.profile).map(storeById).filter(Boolean); }
function storeShort(s) { return s ? (s.short || s.name) : ''; }
function pruneSession() {
  const t = todayISO(), weekAgo = addDays(t, -7);
  const s = S.session;
  const before = s.candidates.length + s.pantry.length;
  const valid = s.candidates.filter(it => !it.expDate || it.expDate >= t);
  const liveOnes = valid.filter(it => it.source === 'ah' && !it.edited);
  const drop = new Set(liveOnes.slice(150));
  s.candidates = valid.filter(it => !drop.has(it));
  s.pantry = s.pantry.filter(it => !it.expDate || it.expDate >= weekAgo);
  return before !== s.candidates.length + s.pantry.length;
}
function saveProfile() { Store.save('profile', S.profile); }
function saveSession() { Store.save('session', S.session); }

/* ============================================================
   Rendering: shared bits
   ============================================================ */
function storeById(id) { return (typeof STORES !== 'undefined' ? STORES : []).find(s => s.id === id) || null; }
function renderStoreSelect() {
  const ss = myStores();
  $('#storeBtnLabel').textContent = !ss.length ? 'Kies je AH' : ss.length === 1 ? storeShort(ss[0]) : `${ss.length} winkels`;
  $('#storeBtn').disabled = !Store.loaded;
}
function openStoreSheet() {
  if (!Store.loaded) return;
  S.sheetSel = profileStores(S.profile);
  const list = $('#storeSheetList');
  fill(list, ...STORES.map(st => h('label', { class: 'check store-check' },
    h('input', { type: 'checkbox', id: 'st-' + st.id, 'data-id': st.id, checked: S.sheetSel.includes(st.id) }),
    h('span', null, h('b', null, st.name), h('span', { class: 'sub' }, `${st.street}${st.area ? ' · ' + st.area : ''}${st.note ? ' · ' + st.note : ''}`)))));
  syncSheet();
  $('#storeSheet').hidden = false;
}
function syncSheet() {
  const sel = new Set(S.sheetSel || []);
  $$('#storeSheetList input').forEach(i => { i.checked = sel.has(i.dataset.id); });
  $('#storeSheetCount').textContent = sel.size ? `${sel.size} gekozen.` : '';
}
function closeStoreSheet() {
  if ($('#storeSheet').hidden) return;
  $('#storeSheet').hidden = true;
  setStores(S.sheetSel || profileStores(S.profile));
}
function setStores(ids) {
  if (!Store.loaded) return;
  const next = [...new Set(ids)].filter(id => storeById(id)).slice(0, MAX_STORES);
  const prev = profileStores(S.profile);
  if (next.join('|') === prev.join('|')) return;
  const removed = prev.filter(id => !next.includes(id)), added = next.filter(id => !prev.includes(id));
  S.profile.stores = next; delete S.profile.store;
  if (S.draft) S.draft.stores = next.slice();
  if (removed.length) {
    S.session.candidates = S.session.candidates.filter(c => c.source !== 'ah' || c.edited || !removed.includes(c.storeKey));
    for (const k of removed) { delete S.session.liveMeta[k]; if (S.live.per) delete S.live.per[k]; }
    if (removed.includes(S.session.storeFilter)) S.session.storeFilter = 'all';
    saveSession();
  }
  saveProfile(); renderStoreSelect(); renderInfo(); renderWinkel();
  toast(!next.length ? 'Geen winkel gekozen' : next.length === 1 ? `${storeShort(storeById(next[0]))} is je winkel` : `${next.length} winkels gekozen`);
  if (HOST && added.length) liveRefresh(added);
}
function toggleStore(id) {
  const cur = profileStores(S.profile);
  if (cur.includes(id)) setStores(cur.filter(x => x !== id));
  else setStores([...cur, id]);
}
function showLoadBanner(msg, action) {
  const b = $('#loadBanner');
  if (!msg) { b.hidden = true; return; }
  b.replaceChildren(h('span', null, msg), action || '');
  b.hidden = false;
}
function discountOf(it) {
  const price = itemPriceNow(it);
  if (it.priceNormal > 0 && price != null) return Math.round((1 - price / it.priceNormal) * 100);
  return price != null && it.discountPct > 0 ? it.discountPct : 0;
}
function stickerFor(it) {
  const pct = discountOf(it);
  return pct > 0 ? h('div', { class: 'sticker', 'aria-label': `${pct} procent korting` }, `-${pct}%`) : null;
}
const EXP_NL = { vandaag: 'tot vandaag', morgen: 'tot morgen', verlopen: 'datum verstreken', later: null };
const TIMING_NL = { nu: 'Nu kopen', wacht: 'Wachten loont', gok: 'Gok', info: 'Afprijzen' };
function modeKey(m) { let best = null, c = 0; for (const k in m || {}) if (m[k] > c || (m[k] === c && +k > best)) { c = m[k]; best = +k; } return best; }
function fmtDay(ts) { return new Date(ts).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }); }
// What the app has seen of this one product (all your stores, up to 120 days).
function productTrack(it) {
  const P = it && it.source === 'ah' && it.productId != null && S.stats && S.stats.prod ? S.stats.prod[it.productId] : null;
  if (!P || !(P.k >= 2)) return null;
  const deep = modeKey(P.mx);
  const parts = [`${P.k}× in de aanbieding gezien${P.ns > 1 ? ` in ${P.ns} winkels` : ''}${P.f ? ` sinds ${fmtDay(P.f)}` : ''}`];
  if (deep != null) parts.push(`meestal tot ${deep}%`);
  if (P.lo != null) parts.push(`laagste prijs ${fmtEur(P.lo)}`);
  return `Gevolgd: ${parts.join(', ')}.`;
}
function itemCard(it, where, alts, rank) {
  const ev = evaluate(it, S.profile);
  const price = itemPriceNow(it);
  const meta = [it.grams ? `${fmtNum(it.grams)} g` : (it.unitSize || null), EXP_NL[ev.exp], CATS[it.cat] || null,
    it.source === 'claude' ? 'gelezen door Claude' : null,
    it.source === 'ah' && it.storeName && profileStores(S.profile).length > 1 ? `bij ${it.storeName}` : null,
    it.source === 'ah' && it.stock != null ? `nog ${it.stock} in de winkel` : null,
    it.source === 'ah' ? (it.nutriSource === 'etiket' ? 'voeding van etiket' : it.nutriSource === 'tabel' ? 'voeding: richtwaarde' : 'voeding onbekend') : null].filter(Boolean).join(' · ');
  const metrics = [];
  const kcal100 = it.n && it.n.kcal != null ? +it.n.kcal : 0;
  if (ev.m.eurPerProt != null) {
    metrics.push(h('li', null, h('b', null, `${fmtNum(ev.m.protPack)} g`), ' eiwit'));
    metrics.push(h('li', null, h('b', null, fmtEur(ev.m.eurPerProt)), ' per 100 g eiwit'));
  }
  if (ev.m.kcalPerEur != null && kcal100 >= 150) metrics.push(h('li', null, h('b', null, fmtNum(ev.m.kcalPerEur)), ' kcal per €'));
  if (ev.m.perKg != null) metrics.push(h('li', null, h('b', null, fmtEur(ev.m.perKg)), ' per kg'));
  if (ev.m.carbPack != null && (S.profile.goal === 'keto' || S.profile.goal === 'lowcarb' || S.profile.carbsMax != null)) metrics.push(h('li', null, h('b', null, `${fmtNum(ev.m.carbPack)} g`), ' koolh.'));
  const actions = [];
  if (where === 'cand') {
    actions.push(h('button', { class: 'btn btn-sm ' + (ev.verdict === 'ja' ? 'btn-primary' : ''), type: 'button', onclick: () => moveToBasket(it.id) }, 'In mandje'));
    actions.push(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => editItem(it.id, 'cand') }, 'Wijzig'));
    actions.push(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': `Verwijder ${it.name}`, onclick: () => removeItem(it.id) }, 'Weg'));
  } else {
    actions.push(h('div', { class: 'qty' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Eén ${it.name} minder`, onclick: () => changeQty(it.id, -1) }, '−'),
      h('span', { 'aria-label': 'Aantal' }, String(it.qty || 1)),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Eén ${it.name} meer`, onclick: () => changeQty(it.id, 1) }, '+')));
    actions.push(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => editItem(it.id, 'basket') }, 'Wijzig'));
    actions.push(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => backToCand(it.id) }, 'Terugleggen'));
  }
  return h('article', { class: `item v-${ev.verdict}` },
    h('div', { class: 'item-top' },
      h('div', { style: 'min-width:0' },
        h('div', { class: 'item-name' }, it.name, it.example ? h('span', { class: 'chip ex', style: 'margin-left:6px;vertical-align:2px' }, 'Voorbeeld') : null, it.source === 'ah' ? h('span', { class: 'chip live-tag' }, 'live') : null),
        h('div', { class: 'item-meta' }, meta)),
      h('div', { class: 'price' },
        it.priceNormal > 0 && price != null && price < it.priceNormal ? h('s', null, fmtEur(it.priceNormal)) : null,
        h('b', null, price == null ? 'prijs?' : fmtEur(price)),
        stickerFor(it))),
    h('div', { class: 'verdict-row' },
      rank ? h('span', { class: 'chip rank' }, `#${rank}`) : null,
      h('span', { class: `chip ${ev.verdict}` }, verdictName(ev.verdict, S.profile)),
      h('div', { class: 'scorebar', role: 'img', 'aria-label': `Score ${ev.score} van 100` }, h('i', { style: `width:${ev.score}%` })),
      h('span', { class: 'score' }, `${ev.score}/100`)),
    metrics.length ? h('ul', { class: 'metrics' }, metrics) : null,
    ev.reasons.length ? h('ul', { class: 'reasons' }, ev.reasons.map(r => h('li', { class: r.pos ? 'pos' : r.neg ? 'neg' : '' }, r.s))) : null,
    (() => { const m = it.storeKey && S.session.liveMeta ? S.session.liveMeta[it.storeKey] : null; const a = where === 'cand' && ev.verdict !== 'nee' ? timingAdvice(it, S.stats, Date.now(), m ? m.fetchedAt : null) : null; return a ? h('p', { class: 'timing t-' + a.kind }, h('span', { class: 'chip' }, TIMING_NL[a.kind] || ''), ' ', a.text) : null; })(),
    where === 'cand' ? (() => { const t = productTrack(it); return t ? h('p', { class: 'timing-hist' }, t) : null; })() : null,
    alts && alts.length ? h('p', { class: 'alts' }, 'Ook bij: ', alts.slice(0, 6).map(a => `${a.storeName || '?'} ${fmtEur(itemPriceNow(a))}${a.discountPct ? ` (-${a.discountPct}%)` : ''}`).join(', '), alts.length > 6 ? ` en ${alts.length - 6} meer` : '') : null,
    h('div', { class: 'item-actions' }, actions));
}

/* ============================================================
   Winkel view
   ============================================================ */
function renderSummary() {
  const t = basketTotals(S.session.basket, S.profile);
  const budget = S.profile.budget > 0 ? S.profile.budget : null;
  const cell = (k, v) => h('div', null, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  const kids = [cell('Mandje', fmtEur(t.spent)), cell('Bespaard', fmtEur(t.saved)), cell('Eiwit', `${fmtNum(t.prot)} g`), cell('Eiwit-dagen', fmtNum(t.protDays, 1))];
  if (budget) {
    const pct = clamp(t.spent / budget * 100, 0, 100);
    kids.push(h('div', { class: 'budget-bar', role: 'img', 'aria-label': `${fmtNum(pct)}% van je weekbudget` }, h('i', { style: `width:${pct}%` })));
    kids.push(h('div', { class: 'note' }, `${fmtEur(Math.max(0, budget - t.spent))} over van je weekbudget van ${fmtEur(budget)}${S.profile.persons > 1 ? `, voor ${S.profile.persons} personen` : ''}`));
  }
  fill($('#summary'), ...kids);
}
function renderCandidates() {
  const scored = S.session.candidates.map(it => { const ev = evaluate(it, S.profile); return { it, s: ev.score, v: ev.verdict }; });
  const onlyFit = HOST && (S.session.liveFilter || 'fit') === 'fit';
  const sf = S.session.storeFilter && S.session.storeFilter !== 'all' && profileStores(S.profile).includes(S.session.storeFilter) ? S.session.storeFilter : null;
  const inStore = sf ? scored.filter(x => x.it.source !== 'ah' || x.it.storeKey === sf) : scored;
  // A ranking diet (Ray Peat) hides nothing for scoring low; only explicit exclusions and the wegfilter.
  const ranking = !!(GOALS[S.profile.goal] || {}).rank;
  const hidden = onlyFit ? inStore.filter(x => x.it.source === 'ah' && (x.v === 'nee' || (!ranking && x.v === 'laten'))) : [];
  const list = inStore.filter(x => !hidden.includes(x)).sort((a, b) => b.s - a.s).map(x => x.it);
  $('#candCount').textContent = list.length ? `${list.length} product${list.length === 1 ? '' : 'en'}` : '';
  const byFilter = hidden.filter(x => filterHits(x.it, S.profile).some(f => f.level !== 'onbekend')).length;
  const hiddenNote = hidden.length ? h('div', { class: 'banner info' }, h('span', null, `${hidden.length} koopje${hidden.length === 1 ? '' : 's'} verborgen dat niet bij je dieet past${byFilter ? `, waarvan ${byFilter} door je wegfilter` : ''}.`), h('button', { class: 'btn btn-sm', type: 'button', onclick: () => setLiveFilter('all') }, 'Toon alles')) : null;
  if (!list.length && HOST) {
    fill($('#candList'), hiddenNote, h('div', { class: 'empty' },
      h('strong', null, myStores().length ? 'Geen passende koopjes gevonden' : 'Kies je winkels'),
      h('span', null, myStores().length ? 'Vernieuw later nog eens: AH zet de hele dag nieuwe Laatste Kans Koopjes klaar, en de korting loopt op richting de avond. Je kunt ook zelf iets toevoegen.' : 'Tik bovenaan op Kies je AH en kies een of meer winkels. Dan haalt de app hun Laatste Kans Koopjes op.')));
    return;
  }
  if (!list.length) {
    fill($('#candList'), h('div', { class: 'empty' },
      h('strong', null, 'Nog niks gevonden'),
      h('span', null, S.sample && S.sampleImages
        ? 'Maak thuis een screenshot van Laatste Kans Koopjes in de AH-app, of fotografeer in de winkel producten met een kortingssticker. Je kunt ook typen wat je ziet. De app zegt meteen of het past bij je dieet en of het een goede deal is.'
        : 'Loop langs vlees, vis, zuivel, brood en groente en zoek de kortingsstickers. Typ wat je ziet: de app zegt meteen of het past bij je dieet en of het een goede deal is.'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: addExamples }, 'Laat voorbeelden zien'))));
    return;
  }
  // The same product at several stores: show the best offer, list the others on its card.
  const multi = !sf && profileStores(S.profile).length > 1;
  const shown = [], altsOf = new Map(), seenP = new Map();
  for (const it of list) {
    if (multi && it.source === 'ah' && it.productId != null) {
      const lead = seenP.get(it.productId);
      // Only fold offers from other stores; two packs at one store each keep their own card.
      if (lead && lead.storeKey !== it.storeKey && !altsOf.get(lead).some(a => a.storeKey === it.storeKey)) { altsOf.get(lead).push(it); continue; }
      if (!lead) { seenP.set(it.productId, it); altsOf.set(it, []); }
    }
    shown.push(it);
  }
  const cap = S.showMax || 60;
  const more = shown.length > cap ? h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { S.showMax = cap + 60; renderCandidates(); } }, `Toon meer (${shown.length - cap})`)) : null;
  $('#candCount').textContent = shown.length ? `${shown.length} product${shown.length === 1 ? '' : 'en'}` : '';
  const kids = [hiddenNote, ...shown.slice(0, cap).map((it, i) => itemCard(it, 'cand', altsOf.get(it), ranking && !it.example ? i + 1 : null)), more];
  if (list.some(it => it.example)) kids.push(h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: clearExamples }, 'Wis voorbeelden')));
  fill($('#candList'), ...kids);
}
function renderBasket() {
  const list = S.session.basket;
  const n = list.reduce((a, it) => a + (it.qty || 1), 0);
  $('#basketCount').textContent = n ? `${n} stuk${n === 1 ? '' : 's'}` : '';
  const badge = $('#badgeBasket'); badge.hidden = !n; badge.textContent = String(n);
  $('#finishRow').hidden = !list.length;
  $('#finishConfirm').hidden = true;
  if (!list.length) {
    fill($('#basketList'), h('div', { class: 'empty' }, h('strong', null, 'Je mandje is leeg'), h('span', null, 'Tik bij een gevonden product op "In mandje". Je ziet dan wat je uitgeeft, bespaart en hoeveel dagen eiwit je binnenhaalt.')));
    return;
  }
  fill($('#basketList'), ...list.map(it => itemCard(it, 'basket')));
}
function renderWinkel() {
  $('#dietBanner').hidden = !!S.profile.setAt || !Store.loaded;
  renderLive(); renderSummary(); renderCandidates(); renderBasket();
}

/* --- live AH data (Scriptable host only) --- */
function fmtTime(ts) { return new Date(ts).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }); }
function renderLive() {
  $('#liveHint').hidden = !!HOST || !Store.loaded;
  const card = $('#liveCard');
  if (!HOST) { card.hidden = true; return; }
  card.hidden = false;
  const L = S.live, ss = myStores(), meta = S.session.liveMeta || {}, per = L.per || {};
  let msg = '';
  if (!ss.length) msg = 'Tik bovenaan op Kies je AH en kies een of meer winkels. Daarna haalt de app hun Laatste Kans Koopjes op.';
  else if (L.status === 'login') msg = L.message || 'AH laat de koopjes alleen zien als je bent ingelogd met je AH-account. Dat hoeft maar één keer.';
  else if (L.message) msg = L.message;
  $('#liveStatus').textContent = msg;
  $('#liveStatus').hidden = !msg;
  const lineFor = st => {
    const m = meta[st.id], ps = per[st.id] || {}, nm = storeShort(st);
    let cls = '', txt;
    if (ps.status === 'loading') { cls = 'wait'; txt = `${nm}: ophalen…`; }
    else if (ps.status === 'login') { cls = 'err'; txt = `${nm}: inloggen bij AH nodig`; }
    else if (ps.status === 'error') { cls = 'err'; txt = `${nm}: ${ps.message || 'ophalen lukte niet'}${m ? ` Je ziet de koopjes van ${fmtTime(m.fetchedAt)}.` : ''}`; }
    else if (m) { cls = m.stale ? 'wait' : 'ok'; txt = `${nm}: ${m.count} koopje${m.count === 1 ? '' : 's'}, ${m.stale ? 'van ' + fmtTime(m.fetchedAt) + ' (wordt ververst)' : 'bijgewerkt om ' + fmtTime(m.fetchedAt)}`; }
    else txt = `${nm}: nog niet opgehaald`;
    return { cls, li: h('li', { class: cls }, txt) };
  };
  const all = ss.map(lineFor);
  if (ss.length <= 4) fill($('#liveLines'), ...all.map(x => x.li));
  else {
    // Many stores: one summary line, problems listed, the rest folded away.
    const ms = ss.map(st => meta[st.id]).filter(Boolean);
    const total = ms.reduce((a, m) => a + (m.count || 0), 0);
    const loading = ss.filter(st => (per[st.id] || {}).status === 'loading').length;
    const newest = ms.length ? Math.max(...ms.map(m => m.fetchedAt || 0)) : null;
    const sum = h('li', { class: loading ? 'wait' : ms.length ? 'ok' : '' }, `${ss.length} winkels: ${total} koopjes${loading ? `, nog ${loading} aan het ophalen` : newest ? `, bijgewerkt om ${fmtTime(newest)}` : ''}`);
    const bad = all.filter(x => x.cls === 'err').map(x => x.li);
    fill($('#liveLines'), sum, ...bad, h('li', null, h('details', null, h('summary', null, 'Per winkel'), h('ul', { class: 'live-lines' }, all.filter(x => x.cls !== 'err').map(x => x.li)))));
  }
  const metas = ss.map(st => meta[st.id]).filter(Boolean);
  const anyLoading = ss.some(st => (per[st.id] || {}).status === 'loading');
  const dot = $('#liveDot');
  dot.className = 'live-dot' + (L.status === 'error' || L.status === 'login' ? ' err' : metas.length && !anyLoading && metas.every(m => !m.stale) ? ' on' : '');
  $('#liveRefresh').disabled = !ss.length || anyLoading || !Store.loaded;
  const anonEmpty = !anyLoading && metas.length && metas.every(m => m.count === 0 && m.kind === 'anon');
  $('#liveLogin').hidden = !(L.status === 'login' || anonEmpty);
  setSeg('#liveFilter', S.session.liveFilter || 'fit');
  $('#liveStoreWrap').hidden = ss.length < 2;
  if (ss.length >= 2) {
    const cur = ss.some(st => st.id === S.session.storeFilter) ? S.session.storeFilter : 'all';
    const counts = {};
    for (const c of S.session.candidates) if (c.source === 'ah' && c.storeKey) counts[c.storeKey] = (counts[c.storeKey] || 0) + 1;
    const sel = $('#liveStoreSel');
    fill(sel, h('option', { value: 'all' }, `Alle winkels (${ss.length})`), ...ss.map(st => h('option', { value: st.id }, `${storeShort(st)}${counts[st.id] ? ` (${counts[st.id]})` : ''}`)));
    sel.value = cur;
  }
}
function setLiveFilter(v) { S.session.liveFilter = v === 'all' ? 'all' : 'fit'; saveSession(); renderWinkel(); }
function setStoreFilter(v) { S.session.storeFilter = v || 'all'; saveSession(); renderWinkel(); }
function storeArgOf(st) { return { key: st.id, ahId: st.id.replace(/^ah-/, ''), postcode: st.postcode, street: st.street, name: storeShort(st) }; }
function settleLive() {
  const per = S.live.per || {};
  const st = profileStores(S.profile).map(k => (per[k] || {}).status);
  S.live.status = st.includes('loading') ? 'loading' : st.includes('login') ? 'login' : st.includes('error') ? 'error' : 'ok';
}
function liveRefresh(keys) {
  if (!HOST) return;
  const all = myStores();
  if (!all.length) { toast('Kies eerst je winkels'); openStoreSheet(); return; }
  const list = keys && keys.length ? all.filter(st => keys.includes(st.id)) : all;
  S.live.per = Object.assign({}, S.live.per);
  for (const st of list) S.live.per[st.id] = { status: 'loading' };
  S.live.status = 'loading'; S.live.message = null;
  hostSend('refresh', { stores: list.map(storeArgOf) });
  renderLive();
}
function applyLive(p, opts) {
  if (!p || !Array.isArray(p.items) || !p.storeKey) return;
  if (!profileStores(S.profile).includes(p.storeKey)) return; // an answer for a store the user no longer follows
  const stale = !!(opts && opts.stale);
  const items = p.items.map(x => itemFromAH(Object.assign({}, x, { storeKey: p.storeKey, storeName: p.storeName || storeShort(storeById(p.storeKey)) })));
  const hiddenIds = new Set(S.session.hiddenAH || []);
  const inBasket = new Set(S.session.basket.map(b => b.id));
  const editing = S.editing && S.editing.id;
  const kept = S.session.candidates.filter(c => c.source !== 'ah' || c.edited || c.id === editing || c.storeKey !== p.storeKey);
  const keptIds = new Set(kept.map(c => c.id));
  const fresh = items.filter(it => !inBasket.has(it.id) && !hiddenIds.has(it.id) && !keptIds.has(it.id)).slice(0, 150);
  S.session.candidates = [...kept, ...fresh];
  S.session.liveMeta = Object.assign({}, S.session.liveMeta, { [p.storeKey]: { fetchedAt: p.fetchedAt || Date.now(), count: items.length, kind: p.kind || null, stale } });
  if (!stale) {
    S.live.per = Object.assign({}, S.live.per, { [p.storeKey]: { status: 'ok' } });
    S.live.message = null;
    settleLive();
  }
  saveSession(); renderWinkel(); if (S.tab === 'koken') renderKoken();
}
window.LK_LIVE = payload => { try { applyLive(typeof payload === 'string' ? JSON.parse(payload) : payload); return 'ok'; } catch (e) { return 'error: ' + e.message; } };
window.LK_STATS = st => { try { S.stats = typeof st === 'string' ? JSON.parse(st) : st; renderCandidates(); renderPatterns(); return 'ok'; } catch (e) { return 'error: ' + e.message; } };
window.LK_TOAST = m => { toast(String(typeof m === 'string' && m[0] === '"' ? JSON.parse(m) : m)); return 'ok'; };
window.LK_LIVE_STATUS = st => {
  const o = typeof st === 'string' ? JSON.parse(st) : (st || {});
  if (o.storeKey) {
    S.live.per = Object.assign({}, S.live.per, { [o.storeKey]: { status: o.status || 'idle', message: o.message || null } });
    settleLive();
  } else if (o.all) {
    S.live.per = {};
    for (const k of profileStores(S.profile)) S.live.per[k] = { status: o.status, message: o.message || null };
    S.live.status = o.status; S.live.message = o.message || null;
  } else {
    S.live.status = o.status || 'idle'; S.live.message = o.message || null;
    if (S.live.status !== 'loading') { const per = S.live.per || {}; for (const k of Object.keys(per)) if (per[k].status === 'loading') per[k] = { status: 'idle' }; }
  }
  renderLive(); return 'ok';
};
function closeFormIf(id) { if (S.editing && S.editing.id === id) closeForm(); }
function moveToBasket(id) {
  const i = S.session.candidates.findIndex(x => x.id === id); if (i < 0) return;
  closeFormIf(id);
  const [it] = S.session.candidates.splice(i, 1);
  const same = S.session.basket.find(b => b.foodId && b.foodId === it.foodId && !!b.example === !!it.example && (b.storeKey || null) === (it.storeKey || null) && b.name === it.name && itemPriceNow(b) === itemPriceNow(it) && b.grams === it.grams && b.expDate === it.expDate);
  if (same) same.qty = (same.qty || 1) + (it.qty || 1); else S.session.basket.push(it);
  if (!S.session.startedAt) S.session.startedAt = Date.now();
  saveSession(); renderWinkel(); toast(`${it.name} in je mandje`);
}
function backToCand(id) {
  const i = S.session.basket.findIndex(x => x.id === id); if (i < 0) return;
  closeFormIf(id);
  const [it] = S.session.basket.splice(i, 1); it.qty = 1; S.session.candidates.unshift(it);
  saveSession(); renderWinkel();
}
function changeQty(id, d) {
  const it = S.session.basket.find(x => x.id === id); if (!it) return;
  it.qty = (it.qty || 1) + d;
  if (it.qty <= 0) { closeFormIf(id); S.session.basket = S.session.basket.filter(x => x.id !== id); }
  saveSession(); renderWinkel();
}
function removeItem(id) {
  closeFormIf(id);
  const it = S.session.candidates.find(x => x.id === id);
  if (it && it.source === 'ah') S.session.hiddenAH = [id, ...(S.session.hiddenAH || []).filter(x => x !== id)].slice(0, 300);
  S.session.candidates = S.session.candidates.filter(x => x.id !== id);
  saveSession(); renderWinkel();
}
function addExamples() {
  const picks = [['kipfilet', 35, 'vandaag'], ['magere_kwark', 40, 'vandaag'], ['croissant', 50, 'vandaag'], ['spinazie', 35, 'vandaag'], ['zalmfilet', 25, 'morgen']];
  for (const [id, pct, exp] of picks) {
    const f = FOOD.find(x => x.id === id);
    if (f) S.session.candidates.push(itemFromFood(f, { discountPct: pct, expDate: expDateFor(exp), example: true }));
  }
  saveSession(); renderWinkel();
}
function clearExamples() {
  S.session.candidates = S.session.candidates.filter(x => !x.example);
  S.session.basket = S.session.basket.filter(x => !x.example);
  if (S.editing && S.editing.base && S.editing.base.example) closeForm();
  saveSession(); renderWinkel();
}

/* --- search + add form --- */
function renderSuggest() {
  const q = $('#q').value;
  const ul = $('#suggest');
  if (!q.trim()) { ul.hidden = true; ul.replaceChildren(); return; }
  const pq = parseQuick(q);
  const matches = matchFood(pq.name || q, 6);
  const lis = matches.map(({ f }) => h('li', null, h('button', { type: 'button', onclick: () => openForm({ food: f, quick: pq }) },
    h('span', null, f.name), h('span', { class: 'cat' }, `${CATS[f.cat] || ''} · ${fmtNum(f.pack_g)} g`))));
  if (pq.name) lis.push(h('li', null, h('button', { type: 'button', onclick: () => openForm({ food: null, quick: pq }) },
    h('span', null, `"${pq.name}" als nieuw product`), h('span', { class: 'cat' }, 'zelf invullen'))));
  ul.replaceChildren(...lis);
  ul.hidden = !lis.length;
}
function setSeg(sel, v) { $$(sel + ' button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === String(v)))); }
const fmtIn = v => v == null || v === '' ? '' : String(v).replace('.', ',');
function openForm({ food, quick, item, where }) {
  if (S.estCtl) { S.estCtl.abort(); S.estCtl = null; }
  const f = $('#addForm');
  S.editing = item ? { id: item.id, where, food: item.foodId ? FOOD.find(x => x.id === item.foodId) || null : null, base: clone(item) } : { id: null, where: 'cand', food, base: null };
  const base = item || (food ? itemFromFood(food) : { name: quick?.name || '', grams: null, priceNormal: null, discountPct: 35, expDate: todayISO(), n: null, tags: [], cat: 'overig', freezable: false });
  $('#fName').value = base.name || '';
  $('#fGrams').value = quick?.grams ?? base.grams ?? '';
  const typedPrice = quick && (quick.price != null || quick.now != null);
  $('#fPrice').value = fmtIn(typedPrice ? quick.price : base.priceNormal);
  $('#fNow').value = fmtIn(quick?.now != null ? quick.now : (item && item.priceNow != null ? item.priceNow : ''));
  S.form.disc = quick?.pct ?? (item ? item.discountPct : 35);
  if (typedPrice && quick.now != null && quick.pct == null) S.form.disc = null;
  const st = expState(base);
  S.form.exp = st === 'verlopen' ? 'vandaag' : st;
  setSeg('#fDisc', S.form.disc); setSeg('#fExp', S.form.exp);
  const n = base.n || {};
  $('#nKcal').value = fmtIn(n.kcal); $('#nProt').value = fmtIn(n.protein); $('#nCarb').value = fmtIn(n.carbs); $('#nFat').value = fmtIn(n.fat);
  const known = !!(base.n && (base.n.kcal || base.n.protein));
  $('#nutriBox').open = !known;
  const ref = food || S.editing.food;
  $('#matchNote').textContent = ref ? `Voedingswaarde: richtwaarde voor ${ref.name}. Pas aan met het etiket als jouw product afwijkt.` : item && item.source === 'claude' ? 'Voedingswaarde geschat door Claude. Check het etiket als je twijfelt.' : 'Onbekend product. Vul de voedingswaarde van het etiket in, of laat Claude schatten.';
  $('#estimateBtn').hidden = !S.sample;
  $('#estimateStatus').textContent = '';
  f.hidden = false; $('#addHint').hidden = true; $('#suggest').hidden = true;
  f.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
function closeForm() {
  if (S.estCtl) { S.estCtl.abort(); S.estCtl = null; }
  $('#addForm').hidden = true; $('#addHint').hidden = false; S.editing = null; $('#q').value = ''; renderSuggest();
}
function readForm() {
  const ed = S.editing; const base = ed.base || (ed.food ? itemFromFood(ed.food) : null);
  const num = id => parseNum($(id).value);
  const n = Object.assign({}, base && base.n ? base.n : {});
  // An emptied field means "unknown", not "keep the old value".
  n.kcal = num('#nKcal'); n.protein = num('#nProt'); n.carbs = num('#nCarb'); n.fat = num('#nFat');
  const hasN = n.kcal != null || n.protein != null;
  const priceNormal = num('#fPrice');
  const now = num('#fNow');
  const name = $('#fName').value.trim() || (base && base.name) || 'Product';
  const it = Object.assign({}, base || { id: uid(), foodId: null, cat: 'overig', tags: [], freezable: false, source: 'manual', qty: 1, addedAt: Date.now() }, {
    name, grams: num('#fGrams'), priceNormal,
    discountPct: now != null ? (priceNormal > 0 ? Math.round((1 - now / priceNormal) * 100) : null) : (S.form.disc ?? 0),
    priceNow: now != null ? now : null,
    expDate: expDateFor(S.form.exp),
    n: hasN ? n : null,
  });
  if (!it.foodId && it.source === 'manual') it.tags = [...new Set([...(it.tags || []), ...inferTags(name)])];
  if (!ed.id) it.id = uid();
  delete it.example;
  return it;
}
function submitForm(e) {
  e.preventDefault();
  if (!S.editing) return;
  const it = readForm();
  if (itemPriceNow(it) == null) { toast('Vul een prijs in'); $('#fPrice').focus(); return; }
  const ed = S.editing;
  let placed = false;
  if (ed.id) {
    for (const arr of [S.session.candidates, S.session.basket]) {
      const i = arr.findIndex(x => x.id === ed.id);
      if (i >= 0) { arr[i] = Object.assign(it, { id: ed.id, qty: arr[i].qty || 1 }, it.source === 'ah' ? { edited: true } : {}); placed = true; break; }
    }
  }
  if (!placed) { it.qty = 1; S.session.candidates.unshift(it); }
  saveSession(); closeForm(); renderWinkel();
  toast(`${it.name}: ${verdictName(evaluate(it, S.profile).verdict, S.profile)}`);
}
function editItem(id, where) {
  const arr = where === 'basket' ? S.session.basket : S.session.candidates;
  const it = arr.find(x => x.id === id); if (it) openForm({ item: it, where });
}
function finishTrip() {
  const real = S.session.basket.filter(x => !x.example);
  const conf = $('#finishConfirm');
  if (!real.length) {
    conf.replaceChildren(h('span', null, 'In je mandje liggen alleen voorbeelden. Wis ze of voeg echte producten toe.'));
    conf.hidden = false; return;
  }
  S.pendingTripId = 't' + uid();
  const t = basketTotals(real, S.profile);
  conf.replaceChildren(
    h('span', null, `Rit opslaan: ${fmtEur(t.spent)} uitgegeven, ${fmtEur(t.saved)} bespaard. Je mandje gaat naar je voorraad in Koken en Gevonden wordt leeggemaakt.`),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-sm btn-primary', type: 'button', id: 'confirmFinishBtn', onclick: confirmFinish }, 'Opslaan'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { conf.hidden = true; } }, 'Nog niet')));
  conf.hidden = false;
}
async function confirmFinish() {
  if (S.finishing) return;
  const real = S.session.basket.filter(x => !x.example);
  if (!real.length) { $('#finishConfirm').hidden = true; return; }
  S.finishing = true;
  const btn = $('#confirmFinishBtn'); if (btn) btn.disabled = true;
  try {
    const t = basketTotals(real, S.profile);
    const names = [...new Set(real.map(it => it.storeName).filter(Boolean))];
    const storeLabel = names.length ? names.join(', ') : myStores().map(storeShort).join(', ');
    const trip = {
      id: S.pendingTripId || ('t' + uid()), date: todayISO(), ts: Date.now(), store: storeLabel, stores: profileStores(S.profile),
      spent: t.spent, saved: t.saved, prot: Math.round(t.prot), kcal: Math.round(t.kcal),
      items: real.map(it => ({ name: it.name, qty: it.qty || 1, price: itemPriceNow(it), normal: it.priceNormal ?? null, grams: it.grams ?? null })),
    };
    const where = await Store.addTrip(trip);
    S.trips = [trip, ...S.trips.filter(x => x.id !== trip.id)];
    S.session.pantry = [...real.map(it => Object.assign({}, it, { boughtAt: Date.now() })), ...S.session.pantry].slice(0, 120);
    S.session.basket = []; S.session.candidates = []; S.session.startedAt = null;
    S.pendingTripId = null;
    saveSession();
    renderWinkel(); renderLogboek(); renderKoken();
    toast(where === 'local' && Store.inViewer ? `Opgeslagen op dit toestel. Je bespaarde ${fmtEur(trip.saved)}.` : `Opgeslagen. Je bespaarde ${fmtEur(trip.saved)}.`);
  } catch (e) {
    toast('Opslaan van de rit lukte niet. Probeer het zo nog eens.');
    if (btn) btn.disabled = false;
  } finally { S.finishing = false; }
}

/* ============================================================
   Koken view
   ============================================================ */
function kitchenItems() {
  const have = [...S.session.basket, ...S.session.pantry];
  return have.length ? { items: have, kind: 'have' } : { items: S.session.candidates, kind: 'seen' };
}
function renderKoken() {
  const { items, kind } = kitchenItems();
  const urg = $('#urgCard');
  if (!items.length) {
    fill(urg, h('h3', null, 'Eerst op'), h('div', { class: 'empty' }, h('strong', null, 'Nog geen buit'), h('span', null, 'Voeg in de winkel producten toe. Hier zie je daarna wat vandaag op of de vriezer in moet, en wat je ermee kookt.')));
  } else {
    const groups = [
      ['Datum verstreken', items.filter(it => expState(it) === 'verlopen'), 'alleen goed als je het hebt ingevroren'],
      ['Vandaag opeten of invriezen', items.filter(it => expState(it) === 'vandaag'), null],
      ['Morgen op', items.filter(it => expState(it) === 'morgen'), null],
      ['Kan nog even', items.filter(it => expState(it) === 'later'), null],
    ].filter(g => g[1].length);
    const tail = kind === 'have' && S.session.pantry.length
      ? h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', id: 'clearPantry', onclick: clearPantry }, 'Voorraad is op, wis hem'))
      : null;
    fill(urg, h('h3', null, kind === 'have' ? 'Eerst op (je mandje en voorraad)' : 'Eerst op (gevonden, nog niet gekocht)'),
      ...groups.map(([title, list, note]) => h('div', { class: 'urg-group' }, h('h3', { class: 'muted' }, title),
        ...list.map(it => h('div', { class: 'urg-row' }, h('span', null, it.name, (it.qty || 1) > 1 ? ` ×${it.qty}` : ''),
          h('span', { class: 'muted small' }, note || (expState(it) === 'vandaag' ? (it.freezable && S.profile.freezer ? 'invriezen kan' : 'vandaag op') : it.freezable ? 'kan de vriezer in' : '')))))),
      tail);
  }
  const ideas = mealIdeas(items, S.profile);
  $('#mealCount').textContent = ideas.length ? `${ideas.length}` : '';
  if (!ideas.length) {
    fill($('#mealList'), h('div', { class: 'empty' }, h('strong', null, 'Nog geen ideeën'), h('span', null, 'Ideeën verschijnen zodra je bijvoorbeeld een eiwitbron en een groente hebt.')));
  } else {
    const lowCarb = S.profile.goal === 'keto' || S.profile.goal === 'lowcarb';
    fill($('#mealList'), ...ideas.slice(0, 8).map(({ meal, items: used, how }) => h('div', { class: 'card meal' },
      h('h3', null, meal.name),
      h('div', { class: 'uses' }, used.map(it => h('span', { class: expState(it) === 'vandaag' ? 'u' : '' }, it.name))),
      h('p', { class: 'small' }, how + (lowCarb && (meal.opt || []).includes('zetmeel') ? ' Laat rijst of pasta weg of neem bloemkoolrijst.' : '')))));
  }
  $('#aiCard').hidden = !S.sample;
}
function clearPantry() {
  const b = $('#clearPantry');
  if (b && b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Zeker weten? Tik nog eens'; setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = 'Voorraad is op, wis hem'; } }, 3000); return; }
  S.session.pantry = []; saveSession(); renderKoken();
}
function renderAdvice(text) {
  const out = $('#adviceOut');
  const kids = []; let ul = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) { ul = null; continue; }
    const bullet = line.match(/^[-*•]\s+(.*)$/) || line.match(/^\d+[.)]\s+(.*)$/);
    const head = line.match(/^#{1,4}\s+(.*)$/);
    if (head) { ul = null; kids.push(h('h4', null, stripMd(head[1]))); }
    else if (bullet) { if (!ul) { ul = h('ul'); kids.push(ul); } ul.append(inlineMd(bullet[1])); }
    else { ul = null; kids.push(inlineMd(line, 'p')); }
  }
  fill(out, ...kids);
}
function stripMd(s) { return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1'); }
function inlineMd(s, tag = 'li') {
  const el = h(tag);
  for (const p of s.split(/(\*\*[^*]+\*\*)/g)) {
    if (/^\*\*[^*]+\*\*$/.test(p)) el.append(h('strong', null, p.slice(2, -2)));
    else if (p) el.append(document.createTextNode(p.replace(/\*([^*]+)\*/g, '$1')));
  }
  return el;
}

/* ============================================================
   Logboek view
   ============================================================ */
function renderPatterns() {
  const card = $('#patternCard');
  const st = S.stats;
  if (!HOST || !st || !st.keys) { card.hidden = true; return; }
  card.hidden = false;
  const steps = key => {
    const K = st.keys[key] || {};
    return Object.keys(K).map(Number).sort((a, b) => a - b).filter(b => b < 70 && K[b].n >= 3).map(b => {
      const B = K[b], up = Math.round(B.up / B.n * 100);
      return `Bij ${b}%: ${up}% zakte verder${B.to ? ` naar ${B.to}%` : ''}${B.h != null ? `, meestal rond ${fmtHour(B.h)}` : ''}; ${100 - up}% was eerder op (${B.n}×).`;
    });
  };
  const rows = [];
  for (const s of myStores()) { const l = steps(`s:${s.id}`); if (l.length) rows.push(h('div', null, h('b', null, storeShort(s)), h('ul', { class: 'tips small' }, l.map(x => h('li', null, x))))); }
  const cats = Object.keys(CATS).map(c => ({ c, l: steps(`c:${c}`) })).filter(x => x.l.length);
  const nProd = Object.keys(st.prod || {}).length;
  fill(card, h('h3', null, 'Hoe AH afprijst bij jou'),
    h('p', { class: 'small muted' }, st.offers || nProd ? `De app volgt elk product apart: hoe vaak het in de aanbieding ligt, hoe ver en hoe laat de korting zakt en hoe vaak het eerst op is. Het advies gaat uit van het product zelf; zolang dat weinig metingen heeft, telt het patroon van de soort product mee. ${nProd ? `${nProd} producten gevolgd.` : ''}` : 'Nog geen metingen. Elke keer dat je de app of de widget opent, volgt de app hoe de korting oploopt.'),
    rows.length ? rows : h('p', { class: 'small' }, 'Nog te weinig metingen per winkel.'),
    cats.length ? h('details', null, h('summary', null, 'Per soort product'), ...cats.map(x => h('div', null, h('b', null, CATS[x.c]), h('ul', { class: 'tips small' }, x.l.map(t => h('li', null, t)))))) : null,
    nProd ? h('details', { id: 'prodTrack', open: !!S.prodOpen, ontoggle: e => { S.prodOpen = e.target.open; } },
      h('summary', null, `Per product (${nProd})`),
      h('input', { type: 'search', id: 'prodSearch', placeholder: 'Zoek een product', 'aria-label': 'Zoek een product', value: S.prodQuery || '', autocomplete: 'off', oninput: e => { S.prodQuery = e.target.value; renderProdList(); } }),
      h('div', { id: 'prodList', class: 'prod-list' })) : null);
  if (nProd) renderProdList();
}
// One row per product: how often, how deep, at what time, and how often it was gone first.
function productSteps(id) {
  const K = (S.stats && S.stats.keys && S.stats.keys['p:' + id]) || {};
  return Object.keys(K).map(Number).sort((a, b) => a - b).filter(b => b < 70).map(b => {
    const B = K[b], gone = B.n - B.up;
    return `${b}%: ${B.up} van ${B.n}× verder${B.up && B.to ? ` naar ${B.to}%${B.h != null ? ` rond ${fmtHour(B.h)}` : ''}` : ''}${gone ? `, ${gone}× eerst op` : ''}`;
  });
}
function renderProdList() {
  const box = $('#prodList');
  if (!box) return;
  const prod = (S.stats && S.stats.prod) || {};
  const q = norm(S.prodQuery || '');
  const all = Object.keys(prod).map(id => Object.assign({ id }, prod[id])).filter(P => !q || norm(P.n).includes(q));
  all.sort((a, b) => (b.k || 0) - (a.k || 0) || (b.t || 0) - (a.t || 0));
  const shown = all.slice(0, 40);
  fill(box, shown.length ? shown.map(P => {
    const deep = modeKey(P.mx);
    const meta = [`${P.k}×`, P.ns > 1 ? `${P.ns} winkels` : null, deep != null ? `meestal tot ${deep}%` : null, P.lo != null ? `laagste ${fmtEur(P.lo)}` : null, P.t ? `laatst ${fmtDay(P.t)}` : null].filter(Boolean).join(' · ');
    const steps = productSteps(P.id);
    return h('div', { class: 'prod-row' }, h('b', null, P.n), h('span', { class: 'small muted' }, meta), steps.length ? h('span', { class: 'small' }, steps.join('; ')) : null);
  }) : h('p', { class: 'small muted' }, q ? 'Geen product gevonden.' : 'Nog geen producten gevolgd.'),
  all.length > shown.length ? h('p', { class: 'small muted' }, `En nog ${all.length - shown.length}. Zoek om ze te vinden.`) : null);
}
function renderLogboek() {
  renderPatterns();
  const trips = S.trips;
  const month = todayISO().slice(0, 7);
  const tm = trips.filter(t => (t.date || '').startsWith(month));
  const sum = (arr, k) => arr.reduce((a, t) => a + (+t[k] || 0), 0);
  const kpi = (k, v) => h('div', { class: 'kpi' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  fill($('#tripKpis'), kpi('Bespaard deze maand', fmtEur(sum(tm, 'saved'))), kpi('Uitgegeven', fmtEur(sum(tm, 'spent'))), kpi('Ritten', String(tm.length)));
  if (!trips.length) {
    fill($('#tripList'), h('div', { class: 'empty' }, h('strong', null, 'Nog geen ritten'), h('span', null, 'Rond een boodschappenronde af in het tabblad Winkel. Dan zie je hier per rit wat je kocht en bespaarde, en je totaal per maand.')));
    return;
  }
  fill($('#tripList'), ...trips.slice(0, 60).map(t => {
    const del = h('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, 'Verwijder');
    del.addEventListener('click', async () => {
      if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Zeker weten?'; setTimeout(() => { if (del.isConnected) { del.dataset.armed = ''; del.textContent = 'Verwijder'; } }, 3000); return; }
      del.disabled = true;
      try { await Store.deleteTrip(t.id); S.trips = S.trips.filter(x => x.id !== t.id); renderLogboek(); }
      catch (e) { toast('Verwijderen lukte niet'); del.disabled = false; }
    });
    return h('div', { class: 'card' },
      h('div', { class: 'trip' },
        h('div', null, h('div', { style: 'font-weight:700' }, new Date(t.ts || t.date).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' }), t.store ? ` · ${t.store}` : ''),
          h('div', { class: 'small muted' }, `${(t.items || []).reduce((a, i) => a + (i.qty || 1), 0)} producten · ${fmtNum(t.prot)} g eiwit`)),
        h('div', { style: 'text-align:right' }, h('div', { class: 'num', style: 'font-weight:600' }, fmtEur(t.spent)), h('div', { class: 'small', style: 'color:var(--good);font-weight:600' }, `${fmtEur(t.saved)} bespaard`))),
      h('details', null, h('summary', null, 'Wat je kocht'),
        h('ul', { class: 'tips small' }, (t.items || []).map(i => h('li', null, `${i.qty > 1 ? i.qty + '× ' : ''}${i.name}: ${fmtEur(i.price)}${i.normal ? ` (was ${fmtEur(i.normal)})` : ''}`)))),
      h('div', { class: 'btn-row' }, del));
  }));
}

/* ============================================================
   Dieet view (edits a draft; nothing changes until Opslaan)
   ============================================================ */
function renderDieet() {
  const p = S.draft || (S.draft = clone(S.profile));
  fill($('#dGoal'), ...Object.entries(GOALS).map(([k, g]) => h('button', { type: 'button', 'data-v': k, 'aria-pressed': String(p.goal === k), onclick: () => applyGoal(k) }, g.label)));
  $('#dGoalDesc').textContent = (GOALS[p.goal] || GOALS.balanced).desc;
  fill($('#dEat'), ...Object.entries(EATS).map(([k, e]) => h('button', { type: 'button', 'data-v': k, 'aria-pressed': String(p.eat === k), onclick: () => { S.draft.eat = k; setSeg('#dEat', k); } }, e.label)));
  fill($('#dExcl'), ...EXCL.map(([k, label]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'x-' + k, checked: !!(p.excl || {})[k], onchange: e => { S.draft.excl = Object.assign({}, S.draft.excl, { [k]: e.target.checked }); } }), label)));
  $('#dUltra').checked = !!p.avoidUltra;
  $('#dKcal').value = p.kcal ?? ''; $('#dProt').value = p.protein ?? ''; $('#dCarb').value = p.carbsMax ?? '';
  $('#dWeight').value = p.weight ?? ''; $('#dPersons').value = p.persons ?? 1; $('#dBudget').value = p.budget ?? '';
  $('#dFreezer').checked = !!p.freezer; $('#dNotes').value = p.notes || '';
  $('#dietSubmit').disabled = !Store.loaded;
  p.filters = normalizeFilters(p.filters);
  renderFilters();
}
function renderFilters() {
  const list = S.draft.filters;
  fill($('#filterList'), ...list.map(f => {
    const preset = FILTER_PRESETS[f.id];
    const sub = preset ? preset.note : f.terms.join(', ');
    return h('div', { class: 'filter-row' },
      h('input', { type: 'checkbox', id: 'wf-' + f.id, checked: f.on, 'aria-label': `${preset ? preset.label : f.label} aan`, onchange: e => { f.on = e.target.checked; } }),
      h('label', { class: 'txt', for: 'wf-' + f.id }, h('b', null, preset ? preset.label : f.label), h('span', null, sub)),
      preset ? null : h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': `Verwijder filter ${f.label}`, onclick: () => { S.draft.filters = S.draft.filters.filter(x => x.id !== f.id); renderFilters(); } }, 'Weg'));
  }));
}
function addFilter() {
  const name = $('#wfName').value.trim(), terms = $('#wfTerms').value;
  const words = terms.split(',').map(w => w.trim()).filter(w => w.length >= 2);
  if (!words.length) { toast('Vul een of meer woorden in, met komma\'s ertussen'); $('#wfTerms').focus(); return; }
  S.draft.filters = normalizeFilters([...S.draft.filters, { id: 'f' + uid(), label: name || words[0], terms: words, on: true }]);
  $('#wfName').value = ''; $('#wfTerms').value = '';
  renderFilters();
  toast('Filter toegevoegd. Tik op Opslaan.');
}
function applyGoal(k) {
  const g = GOALS[k];
  S.draft.goal = k;
  setSeg('#dGoal', k);
  $('#dGoalDesc').textContent = g.desc;
  const w = parseNum($('#dWeight').value);
  $('#dKcal').value = g.kcal;
  $('#dProt').value = w ? proteinFor(k, w) : g.protein;
  $('#dCarb').value = g.carbsMax ?? '';
}
function proteinFor(goal, w) { const f = goal === 'cut' ? 2.0 : goal === 'bulk' ? 1.8 : goal === 'keto' || goal === 'lowcarb' ? 1.4 : goal === 'peat' ? 1.3 : 1.0; return Math.round(w * f); }
function submitDiet(e) {
  e.preventDefault();
  if (!Store.loaded) return;
  const d = S.draft || clone(S.profile);
  const num = id => parseNum($(id).value);
  const G = GOALS[d.goal] || GOALS.balanced;
  d.kcal = clamp(num('#dKcal') || G.kcal, 800, 6000);
  d.protein = clamp(num('#dProt') || G.protein, 20, 400);
  const c = num('#dCarb'); d.carbsMax = c == null ? null : clamp(c, 0, 800);
  d.weight = num('#dWeight');
  d.persons = clamp(Math.round(num('#dPersons') || 1), 1, 10);
  const b = num('#dBudget'); d.budget = b == null ? null : Math.max(0, b);
  d.avoidUltra = $('#dUltra').checked; d.freezer = $('#dFreezer').checked;
  d.notes = $('#dNotes').value.slice(0, 2000);
  d.filters = normalizeFilters(d.filters);
  S.profile = Object.assign({}, d, { stores: profileStores(S.profile), setAt: Date.now() });
  delete S.profile.store;
  S.draft = clone(S.profile);
  saveProfile(); renderAll();
  $('#dietSaved').textContent = 'Opgeslagen. Alle producten zijn opnieuw beoordeeld.';
  setTimeout(() => { $('#dietSaved').textContent = ''; }, 3500);
}

/* ============================================================
   Info view
   ============================================================ */
const SCRIPT_URL = '@@SCRIPT_URL@@';
const INSTALLER = `// Installeert of werkt "Laatste Kans" bij
const url = '${SCRIPT_URL}';
const req = new Request(url);
const code = await req.loadString();
if (!/Laatste Kans/.test(code)) throw new Error('Download mislukt');
let fm; try { fm = FileManager.iCloud(); fm.documentsDirectory(); } catch (e) { fm = FileManager.local(); }
fm.writeString(fm.joinPath(fm.documentsDirectory(), 'Laatste Kans.js'), code);
const a = new Alert();
a.title = 'Geïnstalleerd';
a.message = 'Open nu het script "Laatste Kans" in Scriptable.';
await a.present();`;
function renderLiveInfo() {
  const card = $('#liveInfoCard');
  if (HOST) {
    fill(card, h('h3', null, 'Live via Scriptable'),
      h('p', { class: 'small' }, 'Deze app haalt de Laatste Kans Koopjes rechtstreeks bij AH op, via dezelfde koppeling als de AH-app. Je gegevens staan in iCloud Drive in de map Scriptable.'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { hostSend('update'); toast('Nieuwste versie ophalen…'); } }, 'Script bijwerken'),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { hostSend('logout'); toast('Uitgelogd bij AH'); } }, 'Uitloggen bij AH')),
      h('p', { class: 'small muted' }, 'Tip: zet in Scriptable een widget op je beginscherm. Die laat zien hoeveel koopjes bij je dieet passen.'));
    return;
  }
  const copy = h('button', { class: 'btn btn-sm btn-primary', type: 'button' }, 'Kopieer installatiecode');
  const box = h('pre', { class: 'codebox', id: 'installerCode', tabindex: '0' }, INSTALLER);
  copy.addEventListener('click', () => {
    const done = () => toast('Gekopieerd');
    try { navigator.clipboard.writeText(INSTALLER).then(done, () => selectBox(box)); } catch (e) { selectBox(box); }
  });
  fill(card, h('h3', null, 'Live koopjes op je iPhone'),
    h('p', { class: 'small' }, 'Een webpagina mag de AH-servers niet zelf aanroepen. De gratis app Scriptable mag dat wel. Daarin draait deze zelfde app, maar dan met de Laatste Kans Koopjes van je winkel live erin.'),
    h('ol', { class: 'steps small' },
      h('li', null, 'Installeer ', h('a', { href: 'https://apps.apple.com/nl/app/scriptable/id1405459188', target: '_blank', rel: 'noopener' }, 'Scriptable'), ' uit de App Store.'),
      h('li', null, 'Kopieer de code hieronder. Open Scriptable, tik op + en plak de code. Tik op het afspeelknopje.'),
      h('li', null, 'Er staat nu een script "Laatste Kans". Open het, kies je winkel en stel je dieet in. De koopjes komen er live in.'),
      h('li', null, 'Lang drukken op je beginscherm, + en Scriptable kiezen geeft een widget met je koopjes van vandaag.')),
    h('div', { class: 'btn-row' }, copy),
    box,
    h('p', { class: 'small muted' }, 'De koppeling is niet officieel. AH kan haar veranderen en dan werkt live ophalen even niet, tot het script is bijgewerkt. Je dieet en logboek in Scriptable staan los van deze pagina.'));
}
function selectBox(el) { const r = document.createRange(); r.selectNodeContents(el); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('Selecteer en kopieer de code'); }
function renderInfo() {
  renderLiveInfo();
  const T = typeof TIPS !== 'undefined' ? TIPS : { when: [], stickers: [], sources: [] };
  fill($('#tipCard'), h('h3', null, 'Zo werkt afprijzen bij AH'),
    h('ul', { class: 'tips' }, (T.stickers || []).map(s => h('li', null, s))),
    h('h3', null, 'Wanneer je de meeste kans hebt'),
    h('ul', { class: 'tips' }, (T.when || []).map(s => h('li', null, s))),
    T.digital && T.digital.length ? h('h3', null, 'Digitaal') : null,
    T.digital && T.digital.length ? h('ul', { class: 'tips' }, T.digital.map(s => h('li', null, s))) : null);
  const mine = new Set(profileStores(S.profile));
  fill($('#storeCard'), h('h3', null, `Albert Heijn in Groningen (${STORES.length})`),
    h('p', { class: 'small muted' }, `Je volgt ${mine.size} winkel${mine.size === 1 ? '' : 's'}.`),
    h('div', null, STORES.map(s => h('div', { class: 'store' + (mine.has(s.id) ? ' on' : '') },
      h('div', { style: 'min-width:0' }, h('div', { class: 'nm' }, s.name), h('div', { class: 'ad' }, `${s.street}, ${s.postcode} ${s.city || 'Groningen'}${s.area ? ` · ${s.area}` : ''}`),
        s.hours ? h('div', { class: 'ad' }, `Open: ${s.hours}`) : null,
        s.note ? h('div', { class: 'ad' }, s.note) : null,
        s.url ? h('a', { class: 'ad', href: s.url, target: '_blank', rel: 'noopener' }, 'Actuele tijden op ah.nl') : null),
      h('div', { class: 'btn-row', style: 'flex:none' },
        h('button', { class: 'btn btn-sm' + (mine.has(s.id) ? ' btn-primary' : ''), type: 'button', disabled: !Store.loaded, 'aria-pressed': String(mine.has(s.id)), onclick: () => toggleStore(s.id) }, mine.has(s.id) ? 'Gevolgd' : 'Volg'),
        h('a', { class: 'btn btn-sm btn-ghost', href: mapsUrl(s), target: '_blank', rel: 'noopener' }, 'Route'))))),
    h('p', { class: 'small muted' }, 'Openingstijden zijn een indicatie en wijken af op feestdagen. Check de winkelpagina op ah.nl.'));
  const SF = typeof SAFETY !== 'undefined' ? SAFETY : { rules: [], freeze: [] };
  fill($('#safetyCard'), h('h3', null, 'Veilig omgaan met laatste-kans-producten'),
    h('ul', { class: 'tips' }, SF.rules.map(r => h('li', null, r))),
    SF.freeze.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Product'), h('th', null, 'Vriezer'), h('th', null, 'Na ontdooien'))),
      h('tbody', null, SF.freeze.map(r => h('tr', null, h('td', null, r.cat), h('td', null, r.months), h('td', null, r.after)))))) : null,
    h('p', { class: 'small muted' }, 'Bron: Voedingscentrum en NVWA. Kijk bij twijfel in de Bewaarwijzer van het Voedingscentrum.'));
  fill($('#aboutCard'), h('h3', null, 'Over deze app'),
    h('p', { class: 'small' }, 'AH laat de Laatste Kans Koopjes per winkel alleen in de AH-app zien en heeft daar geen openbare koppeling voor. Deze app werkt daarom met wat jij ziet: een screenshot uit de AH-app, een foto in de winkel of wat je intypt. De beoordeling gebeurt op je toestel met richtwaarden voor voeding (NEVO-achtig en AH-etiketten). Prijzen in de tabel zijn richtprijzen; de prijs op de sticker telt.'),
    h('p', { class: 'small muted' }, `Opslag: ${Store.mode === 'db' ? 'privé in je Claude-account (ook anderen met de link zien jouw gegevens niet)' : 'alleen in deze browser'}. Claude: ${S.sample ? 'beschikbaar voor screenshots, foto’s en plannen' : 'niet beschikbaar in deze weergave'}.`),
    h('p', { class: 'small muted' }, 'Geen officiële app van Albert Heijn.'),
    (T.sources || []).length ? h('details', null, h('summary', null, 'Bronnen'), h('ul', { class: 'tips small' }, T.sources.map(u => h('li', null, h('a', { href: u, target: '_blank', rel: 'noopener' }, u.replace(/^https?:\/\//, '')))))) : null);
}
function mapsUrl(s) { return `https://maps.apple.com/?q=${encodeURIComponent(`Albert Heijn ${s.street}, ${s.postcode} ${s.city || 'Groningen'}`)}`; }

/* ============================================================
   Claude features (optional)
   ============================================================ */
async function initSample() {
  if (!(window.claude && typeof window.claude.use === 'function')) return;
  let s = null;
  try { s = await window.claude.use('sample'); } catch (e) { s = null; }
  if (!s) return;
  S.sample = s;
  try { const lim = await s.limits(); S.sampleImages = !!(lim && lim.images); S.sampleMax = lim && lim.images ? lim.images.maxCount : 0; } catch (e) { S.sampleImages = false; }
  $('#photoRow').hidden = !S.sampleImages;
  $('#estimateBtn').hidden = $('#addForm').hidden;
  renderCandidates(); renderKoken(); renderInfo();
}
function disableSample(code) {
  if (code === 'images_unavailable') { S.sampleImages = false; $('#photoRow').hidden = true; return; }
  if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code)) {
    S.sample = null; $('#photoRow').hidden = true; $('#aiCard').hidden = true; $('#estimateBtn').hidden = true;
  }
}
function sampleErrorText(e) {
  const c = e && e.code;
  return c === 'rate_limited' ? 'Claude is even druk of je limiet is bereikt. Probeer het later opnieuw.'
    : c === 'not_granted' ? 'Je hebt Claude niet toegestaan voor deze app. Je kunt alles nog handmatig doen.'
    : c === 'session_expired' ? 'Log opnieuw in bij Claude en probeer het nog eens.'
    : c === 'image_rejected' ? 'Deze afbeelding werd niet geaccepteerd. Probeer een andere (JPEG of PNG).'
    : c === 'images_unavailable' ? 'Afbeeldingen lezen kan hier niet. Typ de producten in.'
    : c === 'invalid_json' ? 'Het antwoord was niet goed leesbaar. Probeer het nog een keer.'
    : c === 'refused' ? 'Claude kon dit niet verwerken. Probeer een andere afbeelding.'
    : c === 'cancelled' ? 'Gestopt.'
    : 'Er ging iets mis bij Claude. Probeer het opnieuw.';
}
function profileText() {
  const p = S.profile; const g = GOALS[p.goal] || GOALS.balanced;
  const ex = [...exclusionsFor(p)].map(t => TAG_NL[t] || t);
  return [
    `Doel: ${g.label} (${g.desc})`,
    `Eetwijze: ${EATS[p.eat]?.label || 'Alles'}${ex.length ? `; eet geen: ${ex.join(', ')}` : ''}${p.excl?.halal ? '; alleen halal vlees' : ''}`,
    `Per persoon per dag: ${p.kcal} kcal, ${p.protein} g eiwit${p.carbsMax != null ? `, max ${p.carbsMax} g koolhydraten` : ''}`,
    `Personen: ${p.persons}; budget per week: ${p.budget != null ? '€' + p.budget : 'onbekend'}; vriezer: ${p.freezer ? 'ja' : 'nee'}${p.avoidUltra ? '; vermijdt ultrabewerkt' : ''}`,
    ...normalizeFilters(p.filters).filter(f => f.on).map(f => f.id === 'pufa' ? 'Vermijdt zaadoliën: zonnebloem, raapzaad (koolzaad), soja, maïs, katoenzaad, druivenpit, saffloer, rijstzemel, sesam en lijnzaad. Olijf, palm, kokos, avocado en boter mogen wel.' : `Vermijdt (${f.label}): ${f.terms.join(', ')}`),
    p.notes ? `Eigen woorden: ${p.notes}` : '',
  ].filter(Boolean).join('\n');
}
async function toJpeg(file, maxSide = 2000) {
  try {
    const bmp = await createImageBitmap(file);
    const sc = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.86));
    return blob || file;
  } catch (e) { return file; }
}
const PHOTO_PROMPT = () => `Je krijgt een of meer afbeeldingen. Het zijn screenshots uit de Albert Heijn-app (de lijst "Laatste Kans Koopjes" van een winkel, met per product naam, inhoud, oude en nieuwe prijs, kortingspercentage, houdbaarheidsdatum en soms voorraad) of foto's uit een AH-winkel van producten met een kortingssticker (blauw-oranje "Laatste Kans Koopje"-sticker, "35% korting", of een elektronisch prijskaartje met 25%, 40% of 70% korting).
Zoek ALLE afgeprijsde producten op de afbeeldingen. Neem elk product één keer op, ook als het op twee screenshots staat.

Geef per product:
- name: korte Nederlandse productnaam zoals op het etiket (zonder merk "AH" ervoor)
- grams: netto gewicht in gram of ml als getal, of null
- priceNormal: de oude of normale prijs in euro (getal), of null als je die niet kunt lezen
- priceNow: de nieuwe prijs in euro, of null
- discountPct: het kortingspercentage (getal 0-100), of null
- expiry: houdbaarheidsdatum als "YYYY-MM-DD" als die leesbaar is, anders null
- cat: precies een van ${Object.keys(CATS).join(', ')}
- per100: geschatte voedingswaarde per 100 g: {"kcal","protein","carbs","sugar","fat","satfat","fiber","salt"} in getallen. Lees het etiket als dat zichtbaar is, anders schat je op basis van NEVO-waarden voor dit type product.
- tags: alle van toepassing zijnde waarden uit ${ALLOWED_TAGS.join(', ')}. Wees volledig bij dierlijke producten en allergenen (meat, poultry, pork, beef, fish, shellfish, dairy, lactose, egg, gluten, nuts, soy).
- ingredients: de ingrediëntenlijst als die op de foto leesbaar is (letterlijk overnemen), anders null
- freezable: true als je dit product op de laatste dag kunt invriezen
- confidence: "hoog", "middel" of "laag" voor hoe zeker je naam en prijs hebt gelezen

Verzin geen prijzen: liever null. Vandaag is ${todayISO()}.
Antwoord met alleen JSON in deze vorm: {"items":[{"name":"Kipfilet","grams":500,"priceNormal":6.49,"priceNow":4.22,"discountPct":35,"expiry":"${todayISO()}","cat":"gevogelte","per100":{"kcal":110,"protein":24,"carbs":0,"sugar":0,"fat":1.5,"satfat":0.4,"fiber":0,"salt":0.15},"tags":["meat","poultry"],"freezable":true,"confidence":"hoog"}]}`;
function itemFromClaude(x) {
  const name = String(x.name || 'Product').slice(0, 80);
  const match = matchFood(name, 1)[0];
  const strong = match && match.s >= 70 ? match.f : null;
  const cat = CATS[x.cat] ? x.cat : (match ? match.f.cat : 'overig');
  const own = Array.isArray(x.tags) ? x.tags.filter(t => ALLOWED_TAGS.includes(t)) : [];
  const tags = [...new Set([...own, ...(strong ? strong.tags : []), ...inferTags(name)])];
  if (tags.includes('vegan') && ANIMAL.some(t => tags.includes(t))) tags.splice(tags.indexOf('vegan'), 1);
  const p100 = x.per100 && typeof x.per100 === 'object' ? x.per100 : null;
  const pv = k => p100 ? parseNum(p100[k]) : null;
  const n = p100 && (pv('kcal') != null || pv('protein') != null)
    ? { kcal: pv('kcal'), protein: pv('protein'), carbs: pv('carbs'), sugar: pv('sugar'), fat: pv('fat'), satfat: pv('satfat'), fiber: pv('fiber'), salt: pv('salt') }
    : match ? itemFromFood(match.f).n : null;
  const pn = parseNum(x.priceNormal), pnow = parseNum(x.priceNow), pct = parseNum(x.discountPct);
  const d = typeof x.expiry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.expiry) ? x.expiry : todayISO();
  return {
    id: uid(), foodId: strong ? strong.id : null, name, cat, n, tags,
    freezable: typeof x.freezable === 'boolean' ? x.freezable : !!(match && match.f.freezable),
    grams: parseNum(x.grams) ?? (match ? match.f.pack_g : null),
    priceNormal: pn ?? (pnow != null && pct > 0 && pct < 100 ? round2(pnow / (1 - pct / 100)) : null),
    priceNow: pnow,
    discountPct: pct ?? (pn && pnow ? Math.round((1 - pnow / pn) * 100) : null),
    ingr: typeof x.ingredients === 'string' && x.ingredients.trim() ? x.ingredients.slice(0, 1500) : null,
    expDate: d < todayISO() ? todayISO() : d, qty: 1, source: 'claude', confidence: x.confidence || null, addedAt: Date.now(),
  };
}
function setPhotoBusy(b) {
  for (const id of ['#shotIn', '#photoIn']) $(id).disabled = b;
  $$('#photoRow label.btn').forEach(l => { l.setAttribute('aria-disabled', String(b)); l.style.opacity = b ? '0.5' : ''; });
}
async function onPhoto(e) {
  const input = e.target;
  const files = Array.from(input.files || []).slice(0, Math.max(1, S.sampleMax || 1));
  input.value = '';
  if (!files.length || !S.sample || S.photoCtl) return;
  const ctl = new AbortController(); S.photoCtl = ctl;
  setPhotoBusy(true);
  const st = $('#photoStatus');
  st.replaceChildren(h('span', null, `${files.length > 1 ? files.length + " afbeeldingen" : 'Afbeelding'} lezen… meestal 10 tot 40 seconden. `), h('button', { class: 'btn btn-sm', type: 'button', onclick: () => ctl.abort() }, 'Stop'));
  try {
    const imgs = await Promise.all(files.map(f => toJpeg(f)));
    const res = await S.sample.json(PHOTO_PROMPT(), { images: imgs, signal: ctl.signal, cache: false });
    const arr = Array.isArray(res) ? res : (res && Array.isArray(res.items) ? res.items : []);
    const items = arr.filter(x => x && typeof x === 'object' && x.name).slice(0, 60).map(itemFromClaude);
    if (!items.length) { st.textContent = 'Geen afgeprijsde producten herkend. Zorg dat de naam en de korting goed in beeld zijn.'; return; }
    S.session.candidates = [...items, ...S.session.candidates].slice(0, 150);
    saveSession(); renderWinkel();
    const noPrice = items.filter(it => itemPriceNow(it) == null).length;
    st.textContent = `${items.length} product${items.length === 1 ? '' : 'en'} toegevoegd aan Gevonden.${noPrice ? ` Bij ${noPrice} kon de prijs niet worden gelezen: tik op Wijzig.` : ''} Check de prijzen even.`;
  } catch (err) {
    st.textContent = sampleErrorText(err);
    disableSample(err && err.code);
  } finally {
    if (S.photoCtl === ctl) S.photoCtl = null;
    setPhotoBusy(false);
  }
}
async function estimateNutrition() {
  if (!S.sample || !S.editing) return;
  const name = $('#fName').value.trim();
  if (!name) { toast('Vul eerst een productnaam in'); return; }
  const ed = S.editing;
  if (S.estCtl) S.estCtl.abort();
  const ctl = new AbortController(); S.estCtl = ctl;
  const st = $('#estimateStatus'); st.textContent = 'Claude schat…';
  $('#estimateBtn').disabled = true;
  try {
    const r = await S.sample.json(`Schat de voedingswaarde per 100 g van dit Nederlandse supermarktproduct (Albert Heijn): "${name}". Gebruik NEVO-achtige waarden. Geef bij tags alle dierlijke ingrediënten en allergenen die er normaal in zitten. Antwoord met alleen JSON: {"kcal":0,"protein":0,"carbs":0,"sugar":0,"fat":0,"satfat":0,"fiber":0,"salt":0,"cat":"een van ${Object.keys(CATS).join('|')}","tags":["uit: ${ALLOWED_TAGS.join(', ')}"],"freezable":true,"grams":0}`, { modelTier: 'quick', signal: ctl.signal });
    if (ctl.signal.aborted || S.editing !== ed) return;
    if (!r || typeof r !== 'object') throw { code: 'invalid_json' };
    $('#nKcal').value = fmtIn(parseNum(r.kcal)); $('#nProt').value = fmtIn(parseNum(r.protein)); $('#nCarb').value = fmtIn(parseNum(r.carbs)); $('#nFat').value = fmtIn(parseNum(r.fat));
    if (!$('#fGrams').value && parseNum(r.grams)) $('#fGrams').value = parseNum(r.grams);
    const base = ed.base || { id: uid(), foodId: null, source: 'manual', qty: 1, addedAt: Date.now(), tags: [] };
    const own = Array.isArray(r.tags) ? r.tags.filter(t => ALLOWED_TAGS.includes(t)) : [];
    ed.base = Object.assign({}, base, {
      cat: CATS[r.cat] ? r.cat : (base.cat || 'overig'),
      tags: [...new Set([...(base.tags || []), ...own, ...inferTags(name)])],
      freezable: typeof r.freezable === 'boolean' ? r.freezable : !!base.freezable,
      n: { kcal: parseNum(r.kcal), protein: parseNum(r.protein), carbs: parseNum(r.carbs), sugar: parseNum(r.sugar), fat: parseNum(r.fat), satfat: parseNum(r.satfat), fiber: parseNum(r.fiber), salt: parseNum(r.salt) },
      source: 'claude',
    });
    st.textContent = 'Geschat door Claude. Check het etiket als je twijfelt.';
  } catch (err) {
    if (S.editing === ed) st.textContent = sampleErrorText(err);
    disableSample(err && err.code);
  } finally {
    if (S.estCtl === ctl) S.estCtl = null;
    $('#estimateBtn').disabled = false;
  }
}
async function askAdvice() {
  if (!S.sample || S.adviceCtl) return;
  const btn = $('#adviceBtn'), stop = $('#adviceStop');
  const ctl = new AbortController(); S.adviceCtl = ctl;
  btn.disabled = true; stop.hidden = false;
  fill($('#adviceOut'), h('p', { class: 'muted' }, 'Claude denkt na…'));
  const fmtIt = it => { const ev = evaluate(it, S.profile); const n = it.n; return `- ${it.name}${it.storeName ? ' (' + it.storeName + ')' : ''}${(it.qty || 1) > 1 ? ' x' + it.qty : ''}, ${it.grams || '?'} g, ${fmtEur(itemPriceNow(it))}${it.priceNormal ? ` (normaal ${fmtEur(it.priceNormal)})` : ''}, houdbaar: ${expState(it)}, invriesbaar: ${it.freezable ? 'ja' : 'nee'}${n ? `, per 100 g: ${n.kcal ?? '?'} kcal, ${n.protein ?? '?'} g eiwit, ${n.carbs ?? '?'} g koolh., ${n.fat ?? '?'} g vet` : ''}; app-oordeel: ${VERDICT_NL[ev.verdict]} (${ev.score}/100)`; };
  const sts = myStores();
  const prompt = `Je helpt iemand die in Groningen goedkoop boodschappen doet met Laatste Kans Koopjes (afgeprijsde producten) bij Albert Heijn${sts.length ? ` (${sts.map(x => x.name).join(', ')})` : ''}. Vandaag is ${new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' })}.

Dieet:
${profileText()}

In het mandje:
${S.session.basket.map(fmtIt).join('\n') || '(leeg)'}

Thuis (net gekocht):
${S.session.pantry.slice(0, 25).map(fmtIt).join('\n') || '(niets)'}

Ook gezien, nog niet gekocht:
${S.session.candidates.slice(0, 25).map(fmtIt).join('\n') || '(niets)'}

Schrijf in het Nederlands, kort en concreet, met kopjes (##) en opsommingen:
## Kopen of laten
Welke van de geziene producten nog meenemen en welke laten liggen, met een reden in een paar woorden.
## Vandaag en morgen
Wat vandaag op moet en wat de vriezer in moet (alleen als dat veilig kan), met hoeveelheden.
## Maaltijden
3 tot 5 maaltijden voor de komende dagen die deze producten gebruiken en passen bij het dieet, met per maaltijd geschatte kcal en eiwit per persoon.
## Aanvullen
Maximaal 5 goedkope basisproducten (geen afprijsproducten) die het plan compleet maken, binnen het weekbudget.
Gebruik geen em-dashes. Maximaal 350 woorden.`;
  try {
    const { text, truncated } = await S.sample(prompt, { signal: ctl.signal, cache: false, onText: ({ text }) => renderAdvice(text) });
    renderAdvice(text + (truncated ? '\n\n(Ingekort. Vraag opnieuw met minder producten.)' : ''));
  } catch (err) {
    if (err && err.text) renderAdvice(err.text + '\n\n' + (err.code === 'cancelled' ? '(gestopt)' : '(onderbroken)'));
    else fill($('#adviceOut'), h('p', null, sampleErrorText(err)));
    disableSample(err && err.code);
  } finally { btn.disabled = false; stop.hidden = true; S.adviceCtl = null; }
}

/* ============================================================
   Routing and boot
   ============================================================ */
const TABS = ['winkel', 'koken', 'logboek', 'dieet', 'info'];
function route() {
  const t = (location.hash || '').replace('#', '');
  const prev = S.tab;
  S.tab = TABS.includes(t) ? t : 'winkel';
  for (const k of TABS) $('#view-' + k).hidden = k !== S.tab;
  $$('.tabbar a').forEach(a => { if (a.dataset.tab === S.tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (S.tab === 'winkel') renderWinkel();
  if (S.tab === 'koken') renderKoken();
  if (S.tab === 'dieet') { if (prev !== 'dieet' || !S.draft) S.draft = clone(S.profile); renderDieet(); }
  if (S.tab === 'info') renderInfo();
  if (S.tab === 'logboek') renderLogboek();
  if (prev !== S.tab) window.scrollTo(0, 0);
}
function renderAll() { renderStoreSelect(); renderWinkel(); renderKoken(); renderLogboek(); if (S.tab === 'dieet') renderDieet(); renderInfo(); }

function bind() {
  $('#q').addEventListener('input', renderSuggest);
  $('#q').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const pq = parseQuick($('#q').value);
      const best = matchFood(pq.name || $('#q').value, 1)[0];
      if (best && best.s >= 60) openForm({ food: best.f, quick: pq }); else if (pq.name) openForm({ food: null, quick: pq });
    }
  });
  $('#addForm').addEventListener('submit', submitForm);
  $('#cancelAdd').addEventListener('click', closeForm);
  $('#fDisc').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.form.disc = +b.dataset.v; setSeg('#fDisc', S.form.disc); $('#fNow').value = ''; });
  $('#fExp').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.form.exp = b.dataset.v; setSeg('#fExp', S.form.exp); });
  $('#fNow').addEventListener('input', () => { if ($('#fNow').value.trim()) { S.form.disc = null; setSeg('#fDisc', null); } });
  $('#estimateBtn').addEventListener('click', estimateNutrition);
  $('#photoIn').addEventListener('change', onPhoto);
  $('#shotIn').addEventListener('change', onPhoto);
  $('#finishBtn').addEventListener('click', finishTrip);
  $('#adviceBtn').addEventListener('click', askAdvice);
  $('#adviceStop').addEventListener('click', () => S.adviceCtl && S.adviceCtl.abort());
  $('#storeBtn').addEventListener('click', openStoreSheet);
  $('#storeSheetDone').addEventListener('click', closeStoreSheet);
  $('#storeSheet').addEventListener('click', e => { if (e.target.id === 'storeSheet') closeStoreSheet(); });
  $('#storeSheetList').addEventListener('change', e => {
    const id = e.target && e.target.dataset && e.target.dataset.id; if (!id) return;
    const cur = (S.sheetSel || []).filter(x => x !== id);
    S.sheetSel = e.target.checked ? [...cur, id] : cur;
    syncSheet();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeStoreSheet(); });
  $('#liveStoreSel').addEventListener('change', e => setStoreFilter(e.target.value));
  $('#storeSheetAll').addEventListener('click', () => { S.sheetSel = STORES.map(x => x.id); syncSheet(); });
  $('#storeSheetNone').addEventListener('click', () => { S.sheetSel = []; syncSheet(); });
  $('#dietForm').addEventListener('submit', submitDiet);
  $('#wfAdd').addEventListener('click', addFilter);
  $('#wfTerms').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addFilter(); } });
  $('#dUltra').addEventListener('change', e => { if (S.draft) S.draft.avoidUltra = e.target.checked; });
  $('#dFreezer').addEventListener('change', e => { if (S.draft) S.draft.freezer = e.target.checked; });
  $('#calcProt').addEventListener('click', () => {
    const w = parseNum($('#dWeight').value);
    if (!w) { toast('Vul eerst je gewicht in'); $('#dWeight').focus(); return; }
    $('#dProt').value = proteinFor((S.draft || S.profile).goal, w);
    toast(`Eiwit: ${$('#dProt').value} g per dag`);
  });
  window.addEventListener('hashchange', route);
  $('#liveRefresh').addEventListener('click', liveRefresh);
  $('#liveLogin').addEventListener('click', () => { S.live = Object.assign({}, S.live, { status: 'loading', message: 'Inlogscherm van AH openen…' }); hostSend('login'); renderLive(); });
  $('#liveFilter').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setLiveFilter(b.dataset.v); });
}

function newerOf(remote, local) {
  if (local && (local.savedAt || 0) > ((remote && remote.savedAt) || 0)) return { v: local, push: true };
  return { v: remote, push: false };
}
async function boot() {
  document.body.classList.toggle('host', !!HOST);
  bind();
  renderStoreSelect(); route();
  const viewer = !!(window.claude && typeof window.claude.use === 'function');
  if (viewer) showLoadBanner('Je gegevens laden…');
  initSample();
  await Store.init();
  const timer = setTimeout(() => { if (!Store.loaded) showLoadBanner('Je opgeslagen gegevens zijn nog niet bereikbaar. Wat je in de winkel toevoegt, wordt bewaard zodra de verbinding er is.'); }, 10000);
  let data = null, push = { profile: false, session: false }, note = null;
  if (Store.mode === 'host') {
    data = { profile: await Store.load('profile'), session: await Store.load('session'), trips: await Store.listTrips() };
  } else if (Store.db) {
    try {
      const [p, s, t] = await Promise.all([Store.load('profile'), Store.load('session'), Store.listTrips()]);
      const np = newerOf(p, Store.localGet('profile')), ns = newerOf(s, Store.localGet('session'));
      push = { profile: np.push, session: ns.push };
      const synced = await Store.syncTrips(t);
      const trips = [...synced, ...t].sort((a, b) => (b.ts || 0) - (a.ts || 0));
      data = { profile: np.v, session: ns.v, trips };
    } catch (e) {
      Store.db = null; Store.mode = 'local';
      note = 'Je account-opslag is nu niet bereikbaar. Alles wordt op dit toestel bewaard en bij je volgende bezoek bijgewerkt.';
    }
  } else if (viewer) {
    note = null; // a viewer without private storage (signed out or not allowed): this browser only
  }
  if (!data) data = { profile: Store.localGet('profile'), session: Store.localGet('session'), trips: Store.localGet('trips') || [] };
  clearTimeout(timer);
  showLoadBanner(note);
  // Keep anything added to Gevonden or the basket while loading.
  const live = S.session;
  S.profile = normalizeProfile(data.profile);
  S.session = normalizeSession(data.session);
  if (live.candidates.length) S.session.candidates = live.candidates.filter(x => !S.session.candidates.some(y => y.id === x.id)).concat(S.session.candidates);
  if (live.basket.length) S.session.basket = live.basket.filter(x => !S.session.basket.some(y => y.id === x.id)).concat(S.session.basket);
  S.trips = Array.isArray(data.trips) ? data.trips : [];
  Store.localSet('trips', S.trips);
  Store.loaded = true;
  const pruned = pruneSession();
  if (push.profile) saveProfile();
  if (push.session || pruned || live.candidates.length || live.basket.length) saveSession();
  Store.watch('profile', () => S.profile, d => { S.profile = normalizeProfile(d); if (S.tab !== 'dieet') S.draft = null; renderAll(); });
  Store.watch('session', () => S.session, d => { S.session = normalizeSession(d); renderWinkel(); if (S.tab === 'koken') renderKoken(); });
  S.draft = null;
  renderAll(); route();
  if (HOST) {
    if (HOST.readOnly) showLoadBanner('Je opgeslagen gegevens konden niet worden gelezen (iCloud). Wat je nu doet, wordt niet bewaard. Sluit de app en probeer het later opnieuw.');
    if (HOST.stats) S.stats = HOST.stats;
    for (const p of [].concat(HOST.live || [])) if (p && p.items) applyLive(p, { stale: !!HOST.liveStale });
    renderPatterns();
    if (HOST.liveError) window.LK_LIVE_STATUS(HOST.liveError);
    else if (myStores().length) liveRefresh();
  }
}

window.LK = { productTrack, pruneHistory, mergeHistory, filterHits, seedOilHit, normalizeFilters, timingAdvice, buildTimingStats, recordObservations, profileStores, setStores, evaluate, matchFood, parseQuick, basketTotals, mealIdeas, itemFromFood, itemFromClaude, itemFromAH, nutritionFromAH, parseUnitSize, inferTags, exclusionsFor, defaultProfile, expState, GOALS, S, Store };
boot();
