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
  async token(force) {
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
    if (r.status >= 400 || a.empty) throw fail(r.status >= 500 || r.status === 429 || r.status === 0 ? 'network' : 'api', `AH gaf een fout${a.errs ? ': ' + a.errs : ` (code ${r.status})`}.`, { status: r.status });
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
  const res = await AH.gql(BARGAINS_Q, { storeId });
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
  const cache = await readJSON(CACHE_FILE, {});
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
  for (const x of items) x.nutrition = cache[String(x.productId)] ? cache[String(x.productId)].n : null;
  const current = new Set(items.map(x => String(x.productId)));
  const ids = Object.keys(cache).filter(id => !current.has(id)).sort((a, b) => ((cache[a] && cache[a].t) || 0) - ((cache[b] && cache[b].t) || 0));
  const extra = Object.keys(cache).length - 3000;
  if (extra > 0) for (const id of ids.slice(0, extra)) delete cache[id];
  try { writeJSON(CACHE_FILE, cache); } catch (e) { /* the cache is optional */ }
  return { storeKey: s.key, storeName: s.name, storeId, fetchedAt: Date.now(), kind: res.kind, items };
}
function statusFor(e) { return { status: e && e.code === 'login' ? 'login' : 'error', message: (e && e.message) || 'Ophalen lukte niet.' }; }

/* ============================================================
   The app: the same page as the web version, with live data
   ============================================================ */
function pageWith(state, opts) {
  const host = {
    kind: 'scriptable', version: VERSION,
    state: { profile: state.profile || null, session: state.session || null, trips: state.trips || [] },
    live: opts.live || null, liveStale: !!opts.stale, liveError: opts.error || null, readOnly: !!opts.readOnly,
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
  const save = () => { if (!readOnly) writeJSON(STATE_FILE, state); };
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
    const s = arg && arg.key ? arg : (state.profile && storeFromKey(state.profile.store) ? storeArg(storeFromKey(state.profile.store)) : null);
    if (!s) return pageStatus({ status: 'error', message: 'Kies eerst je winkel.' });
    try {
      const payload = await fetchLive(s, state);
      state.lastLive = payload;
      save();
      await call('LK_LIVE', payload);
    } catch (e) { await pageStatus(statusFor(e)); }
  }
  function startRefresh(arg) {
    if (refreshing) { queued = arg; return; }
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
      await reloadApp({}); // the page asks for fresh bargains itself
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
  const store0 = storeFromKey(state.profile && state.profile.store);
  const last = state.lastLive && store0 && state.lastLive.storeKey === store0.id ? state.lastLive : null;
  await reloadApp({ live: last, stale: !!last });
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
}

/* ============================================================
   Widgets: Home Screen (small/medium/large) and Lock Screen
   ============================================================ */
async function runWidget() {
  const state = await readJSON(STATE_FILE, {});
  const P = Object.assign(defaultProfile(), state.profile || {});
  const s = storeFromKey(P.store);
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
  let result = null, problem = null;
  if (s) {
    try {
      const live = await fetchLive(storeArg(s), state);
      try {
        const fresh = await readJSONStrict(STATE_FILE, {});
        fresh.storeIds = Object.assign({}, fresh.storeIds || {}, state.storeIds || {});
        fresh.lastLive = live;
        writeJSON(STATE_FILE, fresh);
      } catch (e) { /* the file could not be read: leave it alone */ }
      const ses = state.session || {};
      const gone = new Set([...(ses.hiddenAH || []), ...(ses.basket || []).map(b => b.id)]);
      const items = live.items.map(itemFromAH).filter(it => !gone.has(it.id));
      const fits = items.map(it => ({ it, ev: evaluate(it, P) })).filter(x => x.ev.verdict === 'ja').sort((a, b) => b.ev.score - a.ev.score);
      result = { total: items.length, fits };
    } catch (e) { problem = e.code === 'login' ? 'Log in via de app' : 'Ophalen lukte niet'; }
  }
  const store = s ? (s.short || s.name) : '';
  if (family === 'accessoryInline') {
    line(!s ? 'Kies je AH' : problem || `${result.fits.length} koopjes voor jou`, 12, '', false);
  } else if (family === 'accessoryCircular') {
    if (w.addAccessoryWidgetBackground !== undefined) w.addAccessoryWidgetBackground = true;
    line(!s || problem ? '?' : String(result.fits.length), 22, '', true);
    line('koopjes', 9, '', false);
  } else if (accessory) {
    line(!s ? 'Kies je AH in de app' : problem || `${result.fits.length} koopjes voor jou`, 14, '', true);
    if (result && result.fits[0]) line(`${result.fits[0].it.name} ${fmtEur(itemPriceNow(result.fits[0].it))}`, 12, '', false);
    if (s) line(store, 11, '', false);
  } else {
    line('LAATSTE KANS', 11, '#F2541B', true);
    w.addSpacer(4);
    if (!s) line('Open de app en kies je winkel', 13, '#E5EDE8', false);
    else if (problem) line(problem, 13, '#FF8F85', false);
    else {
      line(`${result.fits.length} voor jou`, 24, '#FFFFFF', true);
      line(`${result.total} koopjes · ${store}`, 11, '#9AABA1', false);
      w.addSpacer(6);
      const n = family === 'small' ? 2 : family === 'medium' ? 3 : 8;
      for (const { it } of result.fits.slice(0, n)) {
        const pct = it.discountPct ? `-${it.discountPct}% ` : '';
        line(`${it.name}  ${pct}${fmtEur(itemPriceNow(it))}`, 12, '#E5EDE8', false);
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
