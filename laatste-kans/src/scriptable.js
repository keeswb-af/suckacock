// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-green; icon-glyph: shopping-cart;
// Laatste Kans: de Laatste Kans Koopjes van je AH in Groningen, live, beoordeeld op je dieet.
// Bron: https://github.com/keeswb-af/suckacock (map laatste-kans). Versie @@VERSION@@.
// Werk bij via Info > Script bijwerken in de app. Niet met de hand aanpassen.

/*@@DATA@@*/

/*@@ENGINE@@*/

const VERSION = '@@VERSION@@';
const SCRIPT_URL = '@@SCRIPT_URL@@';
const APP_HTML = /*@@APP_HTML@@*/'';

/* ============================================================
   Small helpers
   ============================================================ */
function fail(code, message, extra) { const e = new Error(message); e.code = code; if (extra) Object.assign(e, extra); return e; }
function sleep(ms) { return new Promise(resolve => { const t = new Timer(); t.timeInterval = ms; t.repeats = false; t.schedule(resolve); }); }
function withTimeout(promise, ms, code) { return Promise.race([promise, sleep(ms).then(() => { throw fail(code || 'timeout', 'Duurde te lang.'); })]); }
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
function scriptJSON(v) { return JSON.stringify(v).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029'); }

/* ============================================================
   Files: iCloud Drive/Scriptable/Laatste Kans data (or on the phone)
   A file that exists but cannot be read is never replaced: the app
   then runs without saving, so a bad iCloud moment cannot wipe the
   diet, basket or logbook.
   ============================================================ */
const FM = (() => { try { const f = FileManager.iCloud(); f.documentsDirectory(); return f; } catch (e) { return FileManager.local(); } })();
const DIR = FM.joinPath(FM.documentsDirectory(), 'Laatste Kans data');
const STATE_FILE = FM.joinPath(DIR, 'state.json');
const CACHE_FILE = FM.joinPath(DIR, 'voeding-cache.json');
const HISTORY_FILE = FM.joinPath(DIR, 'afprijs-geschiedenis.json');
// One copy of the nutrition cache and the markdown history per run, written once at the end,
// so stores fetched side by side do not overwrite each other's additions.
const RUN = { cache: null, hist: null, histOk: true, dirty: false, seen: new Set(), noIngredients: false };
async function runCache() { if (!RUN.cache) RUN.cache = await readJSON(CACHE_FILE, {}); return RUN.cache; }
async function runHistory() {
  if (!RUN.hist) {
    try { RUN.hist = await readJSONStrict(HISTORY_FILE, {}) || {}; }
    catch (e) { RUN.hist = {}; RUN.histOk = false; } // unreadable: keep measuring in memory, never overwrite the file
  }
  return RUN.hist;
}
async function record(payload) { recordObservations(await runHistory(), payload, payload.fetchedAt); RUN.dirty = true; }
async function flushRun() {
  // Nutrition cache: trim once, never the products seen during this run.
  try {
    if (RUN.cache) {
      const c = RUN.cache;
      const old = Object.keys(c).filter(id => !RUN.seen.has(id)).sort((a, b) => ((c[a] && c[a].t) || 0) - ((c[b] && c[b].t) || 0));
      const extra = Object.keys(c).length - 2000;
      if (extra > 0) for (const id of old.slice(0, extra)) delete c[id];
      writeJSON(CACHE_FILE, c);
    }
  } catch (e) { /* optional */ }
  // History: the app and the widget can both have written it meanwhile, so merge with the file first.
  try {
    if (RUN.hist && RUN.histOk && RUN.dirty) {
      let disk = null;
      try { disk = await readJSONStrict(HISTORY_FILE, null); } catch (e) { return; } // unreadable now: try again next time
      RUN.hist = pruneHistory(mergeHistory(disk, RUN.hist), Date.now());
      writeJSON(HISTORY_FILE, RUN.hist);
      RUN.dirty = false;
    }
  } catch (e) { /* optional */ }
}
async function pool(list, n, fn) {
  let i = 0;
  const worker = async () => { while (i < list.length) { const x = list[i++]; await fn(x); } };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
}
async function readJSONStrict(path, fallback) {
  if (!FM.fileExists(path)) return fallback;
  if (FM.isFileStoredIniCloud(path) && !FM.isFileDownloaded(path)) await withTimeout(FM.downloadFileFromiCloud(path), 8000, 'file');
  return JSON.parse(FM.readString(path));
}
async function readJSON(path, fallback) { try { return await readJSONStrict(path, fallback); } catch (e) { return fallback; } }
function writeJSON(path, v) {
  if (!FM.fileExists(DIR)) FM.createDirectory(DIR, true);
  FM.writeString(path, JSON.stringify(v));
}

/* ============================================================
   AH app API (unofficial; request shapes as in github.com/gwillem/appie-go)
   ============================================================ */
const KC = 'laatste-kans.ah-tokens';
const STORES_Q = `query StoresSearch($filter: StoresFilterInput) {
  storesSearch(filter: $filter, limit: 5) {
    result { id name storeType address { street houseNumber houseNumberExtra postalCode city } }
  }
}`;
const BARGAINS_Q = `query BargainItems($storeId: String!) {
  bargainItems(storeId: $storeId) {
    product { id title brand salesUnitSize }
    categoryTitle
    markdown { markdownType markdownExpirationDate markdownPercentage }
    stock
    bargainPrice { priceWas priceNow }
  }
}`;
function nutritionQuery(ids) {
  return 'query FetchNutrition {\n' + ids.map((id, k) => `  p${k}: product(id: ${parseInt(id, 10)}) { id tradeItem { nutritions { nutrients { type name value } } } }`).join('\n') + '\n}';
}
// Ingredients and allergens come in their own query: if AH changes those fields, nutrition still works.
function ingredientQuery(ids) {
  return 'query FetchIngredients {\n' + ids.map((id, k) => `  p${k}: product(id: ${parseInt(id, 10)}) { id tradeItem { ingredients { statement allergens { contains mayContain } } } }`).join('\n') + '\n}';
}
const AUTH_RE = /unauthori|unauthenti|not authenticated|not authorized|forbidden|access denied|login|permission|expired|invalid token/i;

const AH = {
  base: 'https://api.ah.nl',
  loginURL: 'https://login.ah.nl/login?client_id=appie-ios&response_type=code&redirect_uri=appie://login-exit',
  clientId: 'appie-ios',
  headers(token) {
    const h = {
      'User-Agent': 'Appie/9.28 (iPhone17,3; iPhone; CPU OS 26_1 like Mac OS X)',
      'x-client-name': 'appie-ios', 'x-client-version': '9.28', 'x-application': 'AHWEBSHOP',
      'Accept': 'application/json', 'Content-Type': 'application/json',
    };
    if (token) h.Authorization = 'Bearer ' + token;
    return h;
  },
  async call(path, body, token) {
    const r = new Request(this.base + path);
    r.method = 'POST';
    r.headers = this.headers(token);
    r.body = JSON.stringify(body);
    r.timeoutInterval = 20;
    let text;
    try { text = await r.loadString(); } catch (e) { throw fail('network', 'Geen verbinding met AH. Check je internet en probeer het opnieuw.'); }
    const status = r.response ? r.response.statusCode : 0;
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { status, json };
  },
  tokens() { try { return Keychain.contains(KC) ? JSON.parse(Keychain.get(KC)) : null; } catch (e) { return null; } },
  keep(json, kind, prev) {
    const t = {
      access: json.access_token, refresh: json.refresh_token || (prev && prev.refresh) || null,
      expiresAt: Date.now() + Math.max(60, (json.expires_in || 3600) - 120) * 1000, kind,
    };
    Keychain.set(KC, JSON.stringify(t));
    return t;
  },
  logout() { if (Keychain.contains(KC)) Keychain.remove(KC); },
  token(force) {
    if (!this._pending) this._pending = this._token(force).finally(() => { this._pending = null; });
    return this._pending;
  },
  async _token(force) {
    const t = this.tokens();
    if (t && t.access && t.expiresAt > Date.now() && !force) return t;
    if (t && t.refresh) {
      const r = await this.call('/mobile-auth/v1/auth/token/refresh', { clientId: this.clientId, refreshToken: t.refresh });
      if (r.status > 0 && r.status < 400 && r.json && r.json.access_token) return this.keep(r.json, t.kind, t);
      if (t.kind === 'member') {
        // The widget and the app may refresh at the same moment: use a token the other one just stored.
        const now = this.tokens();
        if (now && now.access !== t.access && now.expiresAt > Date.now()) return now;
        if ([400, 401, 403].includes(r.status) && r.json) { this.logout(); throw fail('login', 'Je AH-login is verlopen. Log opnieuw in.'); }
        throw fail('network', `AH kon je login nu niet vernieuwen (code ${r.status}). Probeer het zo opnieuw.`);
      }
    }
    const r = await this.call('/mobile-auth/v1/auth/token/anonymous', { clientId: this.clientId });
    if (r.status > 0 && r.status < 400 && r.json && r.json.access_token) return this.keep(r.json, 'anon');
    throw fail('api', `AH gaf geen toegang (code ${r.status}). Misschien is de koppeling veranderd: werk het script bij via Info.`, { status: r.status });
  },
  async gql(query, variables) {
    const send = t => this.call('/graphql', { query, variables: variables || {} }, t.access);
    let t = await this.token();
    let r = await send(t);
    const authProblem = res => {
      const e = res.json && Array.isArray(res.json.errors) ? res.json.errors.map(x => x && x.message).filter(Boolean).join('; ') : '';
      const data = res.json && res.json.data;
      const empty = data == null || (e && typeof data === 'object' && Object.values(data).every(v => v == null));
      return { errs: e, empty, auth: res.status === 401 || res.status === 403 || (empty && AUTH_RE.test(e)) };
    };
    let a = authProblem(r);
    if (a.auth && (r.status === 401 || t.kind === 'member')) {
      t = await this.token(true);
      r = await send(t);
      a = authProblem(r);
    }
    const errors = r.json && Array.isArray(r.json.errors) ? r.json.errors : [];
    if (a.auth) throw fail('login', t.kind === 'member' ? 'AH accepteert je login niet meer. Log opnieuw in.' : 'AH vraagt om in te loggen met je AH-account. Dat hoeft maar één keer.', { status: r.status, auth: true });
    if (r.status >= 400 || a.empty) throw fail(r.status >= 500 || r.status === 429 || r.status === 0 ? 'network' : 'api', `AH gaf een fout${a.errs ? ': ' + a.errs : ` (code ${r.status})`}.`, { status: r.status, graphql: !!a.errs, kind: t.kind });
    return { data: r.json.data, errors, kind: t.kind };
  },
  async exchange(code) {
    const r = await this.call('/mobile-auth/v1/auth/token', { clientId: this.clientId, code });
    if (r.status > 0 && r.status < 400 && r.json && r.json.access_token) return this.keep(r.json, 'member');
    throw fail('login', 'Inloggen bij AH lukte niet. Probeer het nog eens.');
  },
};

/* ============================================================
   Live bargains for one store, with label nutrition (cached)
   ============================================================ */
function storeFromKey(key) { return STORES.find(s => s.id === key) || null; }
function storeArg(s) { return { key: s.id, ahId: s.id.replace(/^ah-/, ''), postcode: s.postcode, street: s.street, name: s.short || s.name }; }
const squash = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function resolveStoreId(s, state) {
  state.storeIds = state.storeIds || {};
  if (state.storeIds[s.key]) return state.storeIds[s.key];
  try {
    const { data } = await AH.gql(STORES_Q, { filter: { postalCode: String(s.postcode || '').replace(/\s+/g, '') } });
    const list = (data && data.storesSearch && data.storesSearch.result) || [];
    const want = squash(s.street);
    const hit = list.find(x => String(x.id) === String(s.ahId))
      || list.find(x => x.address && squash(`${x.address.street}${x.address.houseNumber}${x.address.houseNumberExtra || ''}`) === want)
      || (list.length === 1 ? list[0] : null);
    if (hit) { state.storeIds[s.key] = String(hit.id); return state.storeIds[s.key]; }
  } catch (e) {
    if (e.code === 'network' || e.code === 'login') throw e;
  }
  return String(s.ahId); // the number in the ah.nl store page address
}
async function fetchLive(s, state) {
  const storeId = await resolveStoreId(s, state);
  let res;
  try { res = await AH.gql(BARGAINS_Q, { storeId }); }
  catch (e) {
    // AH hides why it refuses (e.g. "Subgraph errors redacted"). Without a login that is almost
    // always because the koopjes need an AH account, as in the AH app itself.
    if (e.code === 'api' && e.graphql && e.kind === 'anon') throw fail('login', 'AH laat de koopjes alleen zien als je bent ingelogd met je AH-account. Tik op Inloggen bij AH; dat hoeft maar één keer.');
    if (e.code === 'api') throw fail('api', `${e.message} (winkelnummer ${storeId})`);
    throw e;
  }
  const raw = res.data && Array.isArray(res.data.bargainItems) ? res.data.bargainItems : null;
  if (!raw) throw fail('api', 'AH gaf geen lijst met koopjes terug.' + (res.errors.length ? ' ' + res.errors.map(e => e && e.message).join('; ') : ''));
  const seen = {};
  const items = raw.map(b => ({
    productId: b && b.product ? b.product.id : null,
    title: b && b.product ? b.product.title : null,
    brand: b && b.product ? b.product.brand : null,
    unitSize: b && b.product ? b.product.salesUnitSize : null,
    category: b ? b.categoryTitle : null,
    markdownType: b && b.markdown ? b.markdown.markdownType : null,
    pct: b && b.markdown ? b.markdown.markdownPercentage : null,
    expDate: b && b.markdown ? b.markdown.markdownExpirationDate : null,
    stock: b ? b.stock : null,
    priceWas: b && b.bargainPrice ? b.bargainPrice.priceWas : null,
    priceNow: b && b.bargainPrice ? b.bargainPrice.priceNow : null,
  })).filter(x => x.productId != null && x.title).filter(x => {
    const k = `${x.productId}|${x.expDate}|${x.priceNow}`;
    if (seen[k]) return false; seen[k] = true; return true;
  });
  // Label nutrition per product. Cache entries are {n, t}; n null means AH has no label for it.
  const cache = await runCache();
  for (const x of items) RUN.seen.add(String(x.productId));
  const need = [...new Set(items.map(x => String(x.productId)))].filter(id => !cache[id]).slice(0, 80);
  for (let i = 0; i < need.length; i += 20) {
    const chunk = need.slice(i, i + 20);
    try {
      const { data, errors } = await AH.gql(nutritionQuery(chunk), {});
      const errPaths = new Set(errors.map(e => e && Array.isArray(e.path) ? e.path[0] : null).filter(Boolean));
      chunk.forEach((id, k) => {
        const p = data ? data['p' + k] : undefined;
        if (p === undefined || (p === null && (errPaths.has('p' + k) || errors.length))) return; // try again next time
        const block = p && p.tradeItem && Array.isArray(p.tradeItem.nutritions) ? p.tradeItem.nutritions[0] : null;
        cache[id] = { n: nutritionFromAH(block && block.nutrients), t: Date.now() };
      });
    } catch (e) { if (e.code === 'network' || e.code === 'login') break; }
  }
  // Ingredients and allergens (for the wegfilter and allergies). Cached as cache[id].i = {s, c, m} or null.
  const needI = RUN.noIngredients ? [] : [...new Set(items.map(x => String(x.productId)))].filter(id => cache[id] && cache[id].i === undefined).slice(0, 80);
  for (let i = 0; i < needI.length; i += 20) {
    const chunk = needI.slice(i, i + 20);
    try {
      const { data, errors } = await AH.gql(ingredientQuery(chunk), {});
      const errPaths = new Set(errors.map(e => e && Array.isArray(e.path) ? e.path[0] : null).filter(Boolean));
      chunk.forEach((id, k) => {
        const p = data ? data['p' + k] : undefined;
        if (p === undefined || (p === null && (errPaths.has('p' + k) || errors.length))) return;
        const ing = p && p.tradeItem && p.tradeItem.ingredients;
        const al = ing && ing.allergens && typeof ing.allergens === 'object' ? ing.allergens : {};
        cache[id].i = ing && (ing.statement || al.contains) ? { s: ing.statement ? String(ing.statement).slice(0, 1500) : null, c: al.contains ? String(al.contains).slice(0, 300) : null, m: al.mayContain ? String(al.mayContain).slice(0, 300) : null } : null;
      });
    } catch (e) {
      if (e.code === 'network' || e.code === 'login') break;
      RUN.noIngredients = true; break; // the fields are not accepted (any more): skip them this run
    }
  }
  for (const x of items) {
    const c = cache[String(x.productId)];
    x.nutrition = c ? c.n : null;
    x.ingredients = c && c.i ? c.i : null;
  }

  return { storeKey: s.key, storeName: s.name, storeId, fetchedAt: Date.now(), kind: res.kind, items };
}
function lastLiveMap(state) {
  const l = state.lastLive;
  if (!l || typeof l !== 'object') return {};
  return l.storeKey ? { [l.storeKey]: l } : l;
}
function statusFor(e) { return { status: e && e.code === 'login' ? 'login' : 'error', message: (e && e.message) || 'Ophalen lukte niet.' }; }

/* ============================================================
   The app: the same page as the web version, with live data
   ============================================================ */
function pageWith(state, opts) {
  const host = {
    kind: 'scriptable', version: VERSION,
    state: { profile: state.profile || null, session: state.session || null, trips: state.trips || [] },
    live: opts.live || null, liveStale: !!opts.stale, liveError: opts.error || null, readOnly: !!opts.readOnly, stats: opts.stats || null,
  };
  const inject = `<script>window.LK_HOST = ${scriptJSON(host)};</script>`;
  // Fonts must not hold up the first paint in a shop with weak reception.
  const html = APP_HTML.replace(/<link rel="stylesheet" href="(https:\/\/fonts\.googleapis\.com[^"]+)">/, '<link rel="stylesheet" href="$1" media="print" onload="this.media=\'all\'">');
  const i = html.indexOf('<head>');
  return i >= 0 ? html.slice(0, i + 6) + '\n' + inject + html.slice(i + 6) : inject + html;
}
async function runApp() {
  let state = {}, readOnly = false;
  try { state = await readJSONStrict(STATE_FILE, {}) || {}; }
  catch (e) { readOnly = true; state = {}; }
  const save = () => {
    if (readOnly) return;
    try {
      if (FM.fileExists(STATE_FILE) && !(FM.isFileStoredIniCloud(STATE_FILE) && !FM.isFileDownloaded(STATE_FILE))) {
        const disk = JSON.parse(FM.readString(STATE_FILE));
        state.widgetCursor = disk.widgetCursor;
        state.storeIds = Object.assign({}, disk.storeIds || {}, state.storeIds || {});
        const a = lastLiveMap(disk), b = lastLiveMap(state);
        for (const k in a) if (!b[k] || (a[k].fetchedAt || 0) > (b[k].fetchedAt || 0)) b[k] = a[k];
        state.lastLive = b;
      }
    } catch (e) { /* use what we have */ }
    writeJSON(STATE_FILE, state);
  };
  const wv = new WebView();
  let open = true, mode = 'app';
  let refreshing = null, queued;
  const js = code => wv.evaluateJavaScript(code);
  const call = (fn, arg) => js(`typeof ${fn} === 'function' ? ${fn}(${JSON.stringify(JSON.stringify(arg))}) : 'no-page'`).catch(() => null);
  const pageStatus = st => call('LK_LIVE_STATUS', st);
  const pageToast = msg => call('LK_TOAST', msg);
  async function saveFromPage() {
    try {
      const out = JSON.parse(await js(`typeof LK_EXPORT === 'function' ? LK_EXPORT() : 'null'`));
      if (!out) return;
      state.profile = out.profile; state.session = out.session; state.trips = out.trips;
      save();
    } catch (e) { /* the page is not loaded (login screen) */ }
  }
  async function refresh(arg) {
    let list = arg && Array.isArray(arg.stores) ? arg.stores : arg && arg.key ? [arg] : null;
    if (!list) list = profileStores(state.profile || {}).map(storeFromKey).filter(Boolean).map(storeArg);
    if (!list.length) return pageStatus({ status: 'error', message: 'Kies eerst je winkels.' });
    if (!RUN.dirty) RUN.hist = null; // read the history again: the widget may have added to it
    try { await AH.token(); } catch (e) { return pageStatus(Object.assign(statusFor(e), { all: true })); }
    let needLogin = false;
    await pool(list, 4, async st => {
      if (needLogin) return;
      try {
        const payload = await fetchLive(st, state);
        state.lastLive = Object.assign(lastLiveMap(state), { [st.key]: payload });
        await record(payload);
        await call('LK_LIVE', payload);
      } catch (e) {
        if (e.code === 'login') { if (!needLogin) { needLogin = true; await pageStatus(Object.assign(statusFor(e), { all: true })); } return; }
        await pageStatus(Object.assign(statusFor(e), { storeKey: st.key }));
      }
    });
    save();
    await flushRun();
    await call('LK_STATS', buildTimingStats(await runHistory()));
  }
  function startRefresh(arg) {
    if (refreshing) {
      if (queued === undefined) queued = arg;
      else if (!arg || !arg.stores || !queued || !queued.stores) queued = null; // null: all followed stores
      else { const m = new Map(); for (const x of [...queued.stores, ...arg.stores]) m.set(x.key, x); queued = { stores: [...m.values()] }; }
      return;
    }
    refreshing = refresh(arg).finally(() => {
      refreshing = null;
      if (queued !== undefined) { const a = queued; queued = undefined; startRefresh(a); }
    });
  }
  async function reloadApp(opts) {
    mode = 'app';
    await wv.loadHTML(pageWith(state, Object.assign({ readOnly }, opts || {})));
  }
  async function finishLogin(code) {
    try {
      if (!code) throw fail('login', 'Inloggen is afgebroken.');
      await AH.exchange(code);
      state.storeIds = {}; // look the store up again with the member token
      await reloadApp({ stats: buildTimingStats(await runHistory()) }); // the page asks for fresh bargains itself
    } catch (e) { await reloadApp({ error: statusFor(e) }); }
  }
  wv.shouldAllowRequest = req => {
    const url = String((req && req.url) || '');
    if (url.startsWith('appie://')) {
      const m = url.match(/[?&]code=([^&#]+)/);
      finishLogin(m ? decodeURIComponent(m[1]) : null);
      return false;
    }
    // Links in the app (route, ah.nl, sources) open in Safari; the app itself stays.
    if (mode === 'app' && /^https?:/i.test(url)) { Safari.open(url); return false; }
    return true;
  };
  async function update() {
    try {
      const r = new Request(SCRIPT_URL);
      const code = await r.loadString();
      if (!/Laatste Kans/.test(code) || !/const VERSION = '/.test(code)) throw new Error('bad download');
      const m = code.match(/const VERSION = '([^']+)'/);
      if (m && m[1] === VERSION) return pageToast('Je hebt de nieuwste versie al.');
      FM.writeString(module.filename, code);
      await pageToast('Bijgewerkt. Sluit de app en open hem opnieuw.');
    } catch (e) { await pageToast('Bijwerken lukte niet. Probeer het later opnieuw.'); }
  }
  async function handle(m) {
    if (!m || !m.cmd) return;
    if (m.cmd === 'save') return saveFromPage();
    if (m.cmd === 'refresh') return startRefresh(m.arg);
    if (m.cmd === 'login') { await saveFromPage(); mode = 'login'; return wv.loadURL(AH.loginURL); }
    if (m.cmd === 'logout') { AH.logout(); state.storeIds = {}; save(); return pageToast('Uitgelogd bij AH.'); }
    if (m.cmd === 'update') return update();
  }
  // Show the app at once with the last known bargains; the page then asks for fresh ones.
  const lastMap = lastLiveMap(state);
  const last = profileStores(state.profile || {}).map(k => lastMap[k]).filter(Boolean);
  const stats0 = buildTimingStats(await runHistory());
  await reloadApp({ live: last, stale: last.length > 0, stats: stats0 });
  wv.present(true).then(() => { open = false; }, () => { open = false; });
  let busy = false;
  while (open) {
    await sleep(500);
    if (!open || busy) continue;
    busy = true;
    try {
      const raw = await js(`typeof LK_TAKE === 'function' ? LK_TAKE() : '[]'`);
      const msgs = JSON.parse(raw || '[]');
      for (const m of msgs) await handle(m);
    } catch (e) { /* page busy or navigating */ }
    busy = false;
  }
  await saveFromPage();
  if (refreshing) { try { await withTimeout(refreshing, 5000); } catch (e) { /* ignore */ } }
  await flushRun();
}

/* ============================================================
   Widgets: Home Screen (small/medium/large) and Lock Screen
   ============================================================ */
async function runWidget() {
  const state = await readJSON(STATE_FILE, {});
  const P = Object.assign(defaultProfile(), state.profile || {});
  const stores = profileStores(P).map(storeFromKey).filter(Boolean);
  const family = config.widgetFamily || 'small';
  const accessory = !!config.runsInAccessoryWidget || /^accessory/.test(family);
  const w = new ListWidget();
  const line = (txt, size, color, bold) => {
    const t = w.addText(txt);
    t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
    if (!accessory) t.textColor = new Color(color);
    t.lineLimit = 1; t.minimumScaleFactor = 0.6;
    return t;
  };
  if (!accessory) { w.backgroundColor = new Color('#15211B'); w.setPadding(12, 14, 12, 14); }
  let result = null, problem = null, used = 0;
  if (stores.length) {
    const ses = state.session || {};
    const gone = new Set([...(ses.hiddenAH || []), ...(ses.basket || []).map(b => b.id)]);
    const lives = {};
    let failed = 0;
    // A widget gets little time: fetch at most 4 stores per run, taking turns.
    const start = (state.widgetCursor || 0) % stores.length;
    const turn = stores.slice(start).concat(stores.slice(0, start)).slice(0, 4);
    try { await AH.token(); } catch (e) { if (e.code === 'login') problem = 'Log in via de app'; }
    if (!problem) await pool(turn, 4, async st => {
      try { const live = await fetchLive(storeArg(st), state); lives[st.id] = live; await record(live); }
      catch (e) { failed++; if (e.code === 'login') problem = 'Log in via de app'; }
    });
    if (!problem && failed === turn.length) problem = 'Ophalen lukte niet';
    await flushRun();
    try {
      const fresh = await readJSONStrict(STATE_FILE, {});
      fresh.storeIds = Object.assign({}, fresh.storeIds || {}, state.storeIds || {});
      fresh.lastLive = Object.assign(lastLiveMap(fresh), lives);
      fresh.widgetCursor = (start + turn.length) % stores.length;
      writeJSON(STATE_FILE, fresh);
    } catch (e) { /* the file could not be read: leave it alone */ }
    // Show every followed store: fresh answers from this run, otherwise what was fetched in the last 3 hours.
    const known = Object.assign({}, lastLiveMap(state), lives);
    let items = [];
    for (const st of stores) {
      const l = known[st.id];
      if (!l || Date.now() - (l.fetchedAt || 0) > Math.max(3, Math.ceil(stores.length / 4) * 0.75) * 3600000) continue;
      used++;
      items = items.concat(l.items.map(x => itemFromAH(Object.assign({}, x, { storeKey: st.id, storeName: st.short || st.name }))));
    }
    items = items.filter(it => !gone.has(it.id));
    const fits = items.map(it => ({ it, ev: evaluate(it, P) })).filter(x => x.ev.verdict === 'ja').sort((a, b) => b.ev.score - a.ev.score);
    result = { total: items.length, fits };
  }
  const where = stores.length === 1 ? (stores[0].short || stores[0].name) : used < stores.length ? `${used} van ${stores.length} winkels` : `${stores.length} winkels`;
  const multi = stores.length > 1;
  const none = !stores.length;
  if (family === 'accessoryInline') {
    line(none ? 'Kies je AH' : problem || `${result.fits.length} koopjes voor jou`, 12, '', false);
  } else if (family === 'accessoryCircular') {
    if (w.addAccessoryWidgetBackground !== undefined) w.addAccessoryWidgetBackground = true;
    line(none || problem ? '?' : String(result.fits.length), 22, '', true);
    line('koopjes', 9, '', false);
  } else if (accessory) {
    line(none ? 'Kies je AH in de app' : problem || `${result.fits.length} koopjes voor jou`, 14, '', true);
    if (result && result.fits[0]) line(`${result.fits[0].it.name} ${fmtEur(itemPriceNow(result.fits[0].it))}`, 12, '', false);
    if (!none) line(where, 11, '', false);
  } else {
    line('LAATSTE KANS', 11, '#F2541B', true);
    w.addSpacer(4);
    if (none) line('Open de app en kies je winkels', 13, '#E5EDE8', false);
    else if (problem) line(problem, 13, '#FF8F85', false);
    else {
      line(`${result.fits.length} voor jou`, 24, '#FFFFFF', true);
      line(`${result.total} koopjes · ${where}`, 11, '#9AABA1', false);
      w.addSpacer(6);
      const n = family === 'small' ? 2 : family === 'medium' ? 3 : 8;
      for (const { it } of result.fits.slice(0, n)) {
        const pct = it.discountPct ? `-${it.discountPct}% ` : '';
        line(`${it.name}  ${pct}${fmtEur(itemPriceNow(it))}${multi && it.storeName ? ' · ' + it.storeName : ''}`, 12, '#E5EDE8', false);
      }
      w.addSpacer();
      line(`bijgewerkt ${new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`, 9, '#9AABA1', false);
    }
  }
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  Script.setWidget(w);
}

if (config.runsInWidget) await runWidget();
else await runApp();
Script.complete();
