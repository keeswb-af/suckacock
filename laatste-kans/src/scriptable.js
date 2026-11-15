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
function fail(code, message) { const e = new Error(message); e.code = code; return e; }
function sleep(ms) { return new Promise(resolve => { const t = new Timer(); t.timeInterval = ms; t.repeats = false; t.schedule(resolve); }); }
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
function scriptJSON(v) { return JSON.stringify(v).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029'); }

/* ============================================================
   Files: iCloud Drive/Scriptable/Laatste Kans data (or on the phone)
   ============================================================ */
const FM = (() => { try { const f = FileManager.iCloud(); f.documentsDirectory(); return f; } catch (e) { return FileManager.local(); } })();
const DIR = FM.joinPath(FM.documentsDirectory(), 'Laatste Kans data');
const STATE_FILE = FM.joinPath(DIR, 'state.json');
const CACHE_FILE = FM.joinPath(DIR, 'voeding-cache.json');
async function readJSON(path, fallback) {
  try {
    if (!FM.fileExists(path)) return fallback;
    if (FM.isFileStoredIniCloud(path) && !FM.isFileDownloaded(path)) await FM.downloadFileFromiCloud(path);
    return JSON.parse(FM.readString(path));
  } catch (e) { return fallback; }
}
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
const AUTH_RE = /unauthori|unauthenti|not authenticated|not authorized|forbidden|access denied|login|permission/i;

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
    r.timeoutInterval = 25;
    let text;
    try { text = await r.loadString(); } catch (e) { throw fail('network', 'Geen verbinding met AH. Check je internet en probeer het opnieuw.'); }
    const status = r.response ? r.response.statusCode : 0;
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { status, json };
  },
  tokens() { try { return Keychain.contains(KC) ? JSON.parse(Keychain.get(KC)) : null; } catch (e) { return null; } },
  keep(json, kind) {
    const t = { access: json.access_token, refresh: json.refresh_token || null, expiresAt: Date.now() + Math.max(60, (json.expires_in || 3600) - 120) * 1000, kind };
    Keychain.set(KC, JSON.stringify(t));
    return t;
  },
  logout() { if (Keychain.contains(KC)) Keychain.remove(KC); },
  async token() {
    const t = this.tokens();
    if (t && t.access && t.expiresAt > Date.now()) return t;
    if (t && t.refresh) {
      const r = await this.call('/mobile-auth/v1/auth/token/refresh', { clientId: this.clientId, refreshToken: t.refresh });
      if (r.status > 0 && r.status < 400 && r.json && r.json.access_token) return this.keep(r.json, t.kind);
      if (t.kind === 'member') { this.logout(); throw fail('login', 'Je AH-login is verlopen. Log opnieuw in.'); }
    }
    const r = await this.call('/mobile-auth/v1/auth/token/anonymous', { clientId: this.clientId });
    if (r.status > 0 && r.status < 400 && r.json && r.json.access_token) return this.keep(r.json, 'anon');
    throw fail('api', `AH gaf geen toegang (code ${r.status}). Misschien is de koppeling veranderd: werk het script bij via Info.`);
  },
  async gql(query, variables) {
    let t = await this.token();
    let r = await this.call('/graphql', { query, variables: variables || {} }, t.access);
    if (r.status === 401) {
      Keychain.set(KC, JSON.stringify(Object.assign({}, t, { expiresAt: 0 })));
      t = await this.token();
      r = await this.call('/graphql', { query, variables: variables || {} }, t.access);
    }
    const errs = r.json && Array.isArray(r.json.errors) ? r.json.errors.map(e => e && e.message).filter(Boolean).join('; ') : '';
    const noData = !r.json || r.json.data == null;
    if (r.status === 401 || r.status === 403 || (noData && AUTH_RE.test(errs))) {
      throw fail(t.kind === 'member' ? 'api' : 'login', t.kind === 'member' ? `AH weigert de aanvraag${errs ? ': ' + errs : ''}.` : 'AH vraagt om in te loggen met je AH-account. Dat hoeft maar één keer.');
    }
    if (r.status >= 400 || noData) throw fail('api', `AH gaf een fout${errs ? ': ' + errs : ` (code ${r.status})`}.`);
    return { data: r.json.data, errors: errs, kind: t.kind };
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
    const t = AH.tokens();
    if (e.code === 'api' && t && t.kind === 'anon') throw fail('login', 'AH vraagt om in te loggen met je AH-account om de koopjes te zien. Dat hoeft maar één keer.');
    throw e;
  }
  const raw = (res.data && res.data.bargainItems) || [];
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
  })).filter(x => x.productId != null && x.title);
  const cache = await readJSON(CACHE_FILE, {});
  const need = [...new Set(items.map(x => String(x.productId)))].filter(id => !(id in cache)).slice(0, 80);
  for (let i = 0; i < need.length; i += 20) {
    const chunk = need.slice(i, i + 20);
    try {
      const { data } = await AH.gql(nutritionQuery(chunk), {});
      chunk.forEach((id, k) => {
        const p = data && data['p' + k];
        if (p === undefined) return; // not answered: try again next time
        const block = p && p.tradeItem && Array.isArray(p.tradeItem.nutritions) ? p.tradeItem.nutritions[0] : null;
        cache[id] = nutritionFromAH(block && block.nutrients);
      });
    } catch (e) { if (e.code === 'network') break; }
  }
  const ids = Object.keys(cache);
  if (ids.length > 3000) for (const id of ids.slice(0, ids.length - 3000)) delete cache[id];
  try { writeJSON(CACHE_FILE, cache); } catch (e) { /* cache is optional */ }
  for (const x of items) x.nutrition = cache[String(x.productId)] || null;
  return { storeKey: s.key, storeName: s.name, storeId, fetchedAt: Date.now(), items };
}
function statusFor(e) { return { status: e && e.code === 'login' ? 'login' : 'error', message: (e && e.message) || 'Ophalen lukte niet.' }; }

/* ============================================================
   The app: the same page as the web version, with live data
   ============================================================ */
function pageWith(state, live, liveError) {
  const host = { kind: 'scriptable', version: VERSION, state: { profile: state.profile || null, session: state.session || null, trips: state.trips || [] }, live: live || null, liveError: liveError || null };
  const inject = `<script>window.LK_HOST = ${scriptJSON(host)};</script>`;
  const i = APP_HTML.indexOf('<head>');
  return i >= 0 ? APP_HTML.slice(0, i + 6) + '\n' + inject + APP_HTML.slice(i + 6) : inject + APP_HTML;
}
async function runApp() {
  const state = await readJSON(STATE_FILE, {});
  const wv = new WebView();
  let open = true, busy = false;
  const store0 = storeFromKey(state.profile && state.profile.store);
  let live = null, liveError = null;
  if (store0) { try { live = await fetchLive(storeArg(store0), state); } catch (e) { liveError = statusFor(e); } }
  const js = (code) => wv.evaluateJavaScript(code);
  const pageStatus = (st) => js(`typeof LK_LIVE_STATUS === 'function' ? LK_LIVE_STATUS(${JSON.stringify(JSON.stringify(st))}) : 'no-page'`).catch(() => null);
  async function saveFromPage() {
    try {
      const out = JSON.parse(await js(`typeof LK_EXPORT === 'function' ? LK_EXPORT() : 'null'`));
      if (!out) return;
      state.profile = out.profile; state.session = out.session; state.trips = out.trips;
      writeJSON(STATE_FILE, state);
    } catch (e) { /* the page is not loaded (login screen) */ }
  }
  async function refresh(arg) {
    const s = arg && arg.key ? arg : (state.profile && storeFromKey(state.profile.store) ? storeArg(storeFromKey(state.profile.store)) : null);
    if (!s) return pageStatus({ status: 'error', message: 'Kies eerst je winkel.' });
    try {
      const payload = await fetchLive(s, state);
      writeJSON(STATE_FILE, state);
      await js(`LK_LIVE(${JSON.stringify(JSON.stringify(payload))})`);
    } catch (e) { await pageStatus(statusFor(e)); }
  }
  async function reloadApp(extraLive, extraError) {
    await wv.loadHTML(pageWith(state, extraLive, extraError));
  }
  async function finishLogin(code) {
    try {
      if (!code) throw fail('login', 'Inloggen is afgebroken.');
      await AH.exchange(code);
      state.storeIds = {}; // ids may differ per account type; look them up again
      await reloadApp(null, null); // the page asks for fresh bargains itself
    } catch (e) { await reloadApp(null, statusFor(e)); }
  }
  wv.shouldAllowRequest = req => {
    const url = String((req && req.url) || '');
    if (url.startsWith('appie://')) {
      const m = url.match(/[?&]code=([^&#]+)/);
      finishLogin(m ? decodeURIComponent(m[1]) : null);
      return false;
    }
    return true;
  };
  async function update() {
    try {
      const r = new Request(SCRIPT_URL);
      const code = await r.loadString();
      if (!/Laatste Kans/.test(code) || !/const VERSION = '/.test(code)) throw new Error('bad download');
      const m = code.match(/const VERSION = '([^']+)'/);
      if (m && m[1] === VERSION) return pageStatus({ status: 'idle', message: 'Je hebt de nieuwste versie al.' });
      FM.writeString(module.filename, code);
      await pageStatus({ status: 'idle', message: 'Bijgewerkt. Sluit de app en open hem opnieuw.' });
    } catch (e) { await pageStatus({ status: 'error', message: 'Bijwerken lukte niet. Probeer het later opnieuw.' }); }
  }
  async function handle(m) {
    if (!m || !m.cmd) return;
    if (m.cmd === 'save') return saveFromPage();
    if (m.cmd === 'refresh') return refresh(m.arg);
    if (m.cmd === 'login') { await saveFromPage(); return wv.loadURL(AH.loginURL); }
    if (m.cmd === 'logout') { AH.logout(); state.storeIds = {}; writeJSON(STATE_FILE, state); return pageStatus({ status: 'idle', message: 'Uitgelogd bij AH.' }); }
    if (m.cmd === 'update') return update();
  }
  await reloadApp(live, liveError);
  if (live) { try { writeJSON(STATE_FILE, state); } catch (e) { /* ignore */ } }
  wv.present(true).then(() => { open = false; }, () => { open = false; });
  while (open) {
    await sleep(600);
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
}

/* ============================================================
   Home-screen widget: how many bargains fit your diet right now
   ============================================================ */
async function runWidget() {
  const state = await readJSON(STATE_FILE, {});
  const P = Object.assign(defaultProfile(), state.profile || {});
  const s = storeFromKey(P.store);
  const w = new ListWidget();
  w.backgroundColor = new Color('#15211B');
  w.setPadding(12, 14, 12, 14);
  const line = (txt, size, color, bold) => { const t = w.addText(txt); t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size); t.textColor = new Color(color); t.lineLimit = 1; t.minimumScaleFactor = 0.7; return t; };
  line('LAATSTE KANS', 11, '#F2541B', true);
  w.addSpacer(4);
  const family = config.widgetFamily || 'small';
  if (!s) {
    line('Open de app en kies je winkel', 13, '#E5EDE8', false);
  } else {
    try {
      const live = await fetchLive(storeArg(s), state);
      const fresh = await readJSON(STATE_FILE, {});
      fresh.storeIds = Object.assign({}, fresh.storeIds || {}, state.storeIds || {});
      writeJSON(STATE_FILE, fresh);
      const scored = live.items.map(itemFromAH).map(it => ({ it, ev: evaluate(it, P) })).filter(x => x.ev.verdict === 'ja').sort((a, b) => b.ev.score - a.ev.score);
      line(`${scored.length} voor jou`, 24, '#FFFFFF', true);
      line(`${live.items.length} koopjes · ${s.short || s.name}`, 11, '#9AABA1', false);
      w.addSpacer(6);
      const n = family === 'small' ? 2 : family === 'medium' ? 3 : 8;
      for (const { it } of scored.slice(0, n)) {
        const pct = it.discountPct ? `-${it.discountPct}% ` : '';
        line(`${it.name}  ${pct}${fmtEur(itemPriceNow(it))}`, 12, '#E5EDE8', false);
      }
      w.addSpacer();
      line(`bijgewerkt ${new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`, 9, '#9AABA1', false);
    } catch (e) {
      line(e.code === 'login' ? 'Log in via de app' : 'Ophalen lukte niet', 13, '#FF8F85', false);
    }
  }
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  Script.setWidget(w);
}

if (config.runsInWidget) await runWidget();
else await runApp();
Script.complete();
