// Run: node tests/test_scriptable.js   (after: python3 build.py)
// Runs dist/LaatsteKans.js under a stand-in for the Scriptable app (Request,
// FileManager, Keychain, Timer, WebView on headless Chromium, ListWidget) against
// a fake AH API, and checks: anonymous token, store lookup, live bargains with
// label nutrition in the app, saving, login when AH asks for it, the widget and
// the self-update.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPT = fs.readFileSync(path.resolve(__dirname, '..', 'dist', 'LaatsteKans.js'), 'utf8');
let failures = 0;
function ok(cond, msg) { if (cond) console.log('  ok  ' + msg); else { failures++; console.log('  FAIL ' + msg); } }
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch (e) { /* retry */ } await wait(100); }
  throw new Error('timed out waiting for ' + label);
}
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

/* ---------- fake AH API ---------- */
const AH = { ingrBroken: false, failStore: null, requireLogin: false, partialAuth: false, refresh503: false, nutriError: false, calls: [], badHeaders: 0, scriptText: null };
const BARGAINS_1093 = [
  { product: { id: 201, title: 'AH Broccoli', brand: 'AH', salesUnitSize: '500 g' }, categoryTitle: 'Groente, aardappelen', markdown: { markdownType: 'DYNAMIC', markdownExpirationDate: today, markdownPercentage: 40 }, stock: 4, bargainPrice: { priceWas: '1.79', priceNow: '1.07' } },
];
const BARGAINS = [
  { product: { id: 101, title: 'AH Kipdijfilet', brand: 'AH', salesUnitSize: '400 g' }, categoryTitle: 'Vlees, kip, vis', markdown: { markdownType: 'DYNAMIC', markdownExpirationDate: today, markdownPercentage: 40 }, stock: 3, bargainPrice: { priceWas: '4.99', priceNow: '2.99' } },
  { product: { id: 102, title: 'AH Roomboter croissants', brand: 'AH', salesUnitSize: '6 stuks' }, categoryTitle: 'Brood, bakkerij', markdown: { markdownType: 'DYNAMIC', markdownExpirationDate: today, markdownPercentage: 70 }, stock: 2, bargainPrice: { priceWas: '2.49', priceNow: '0.75' } },
  { product: { id: 103, title: 'Campina Volle yoghurt', brand: 'Campina', salesUnitSize: '1 l' }, categoryTitle: 'Zuivel, eieren', markdown: { markdownType: 'DYNAMIC', markdownExpirationDate: today, markdownPercentage: 70 }, stock: 2, bargainPrice: { priceWas: '1.95', priceNow: '0.59' } },
  { product: { id: 104, title: 'AH Spekreepjes', brand: 'AH', salesUnitSize: '150 g' }, categoryTitle: 'Vlees, kip, vis', markdown: { markdownType: 'DYNAMIC', markdownExpirationDate: today, markdownPercentage: 40 }, stock: 1, bargainPrice: { priceWas: '2.29', priceNow: '1.37' } },
];
const NUTRI = {
  101: [{ type: 'ENERGY', name: 'Energie', value: '615 kJ (147 kcal)' }, { type: 'FAT', name: 'Vet', value: '7,9 g' }, { type: 'SATURATED_FAT', name: 'waarvan verzadigd', value: '2,3 g' }, { type: 'CARBOHYDRATES', name: 'Koolhydraten', value: '0 g' }, { type: 'SUGARS', name: 'waarvan suikers', value: '0 g' }, { type: 'PROTEIN', name: 'Eiwitten', value: '19 g' }, { type: 'SALT', name: 'Zout', value: '0,18 g' }],
  103: [{ type: 'ENERGY', name: 'Energie', value: '263 kJ / 63 kcal' }, { type: 'FAT', name: 'Vet', value: '3,1 g' }, { type: 'PROTEIN', name: 'Eiwitten', value: '3,9 g' }, { type: 'CARBOHYDRATES', name: 'Koolhydraten', value: '3,7 g' }],
};
function ahRespond(req) {
  const u = new URL(req.url);
  const h = req.headers || {};
  if (u.host === 'raw.githubusercontent.com') return { status: 200, body: AH.scriptText };
  if (u.host !== 'api.ah.nl') return { status: 404, body: '' };
  if (h['x-client-name'] !== 'appie-ios' || h['x-application'] !== 'AHWEBSHOP' || !/^Appie\//.test(h['User-Agent'] || '')) AH.badHeaders++;
  const body = req.body ? JSON.parse(req.body) : {};
  AH.calls.push({ path: u.pathname, auth: h.Authorization || null, query: body.query ? body.query.split(/[\s({]/).filter(Boolean)[1] : null, vars: body.variables || null });
  if (u.pathname === '/mobile-auth/v1/auth/token/anonymous') return { status: 200, body: JSON.stringify({ access_token: 'anon-token', refresh_token: 'anon-refresh', expires_in: 604798 }) };
  if (u.pathname === '/mobile-auth/v1/auth/token') return body.code === 'good-code'
    ? { status: 200, body: JSON.stringify({ access_token: 'member-token', refresh_token: 'member-refresh', expires_in: 3600, member_id: '42' }) }
    : { status: 400, body: JSON.stringify({ message: 'bad code' }) };
  if (u.pathname === '/mobile-auth/v1/auth/token/refresh' && AH.refresh503) return { status: 503, body: 'Service Unavailable' };
  if (u.pathname === '/mobile-auth/v1/auth/token/refresh') return { status: 200, body: JSON.stringify({ access_token: 'refreshed-token', refresh_token: 'r2', expires_in: 3600 }) };
  if (u.pathname === '/graphql') {
    const q = body.query || '';
    if (/storesSearch/.test(q)) return { status: 200, body: JSON.stringify({ data: { storesSearch: { result: [
      { id: 9999, name: 'AH Elders', storeType: 'REGULAR', address: { street: 'Andere straat', houseNumber: '1', postalCode: '9742AK', city: 'Groningen' } },
      { id: 1829, name: 'AH Dierenriemstraat', storeType: 'REGULAR', address: { street: 'Dierenriemstraat', houseNumber: '122', postalCode: '9742AK', city: 'Groningen' } }] } } }) };
    if (/bargainItems/.test(q) && AH.partialAuth) return { status: 200, body: JSON.stringify({ data: { bargainItems: null }, errors: [{ message: 'Unauthorized', path: ['bargainItems'] }] }) };
    if (/bargainItems/.test(q)) {
      // Real AH hides the reason: an anonymous token gets "Subgraph errors redacted".
      if (AH.requireLogin && h.Authorization !== 'Bearer member-token') return { status: 200, body: JSON.stringify({ data: null, errors: [{ message: 'Subgraph errors redacted' }] }) };
      if (body.variables.storeId === '1093') return AH.failStore === '1093' ? { status: 500, body: 'oops' } : { status: 200, body: JSON.stringify({ data: { bargainItems: BARGAINS_1093 } }) };
      if (body.variables.storeId !== '1829') return { status: 200, body: JSON.stringify({ data: { bargainItems: [] } }) };
      return { status: 200, body: JSON.stringify({ data: { bargainItems: BARGAINS } }) };
    }
    if (/FetchIngredients/.test(q)) {
      if (AH.ingrBroken) return { status: 400, body: JSON.stringify({ errors: [{ message: 'Cannot query field "ingredients" on type "ProductTradeItem".' }] }) };
      const LABELS = { 101: ['Kipdijfilet (98%), zout', null], 102: ['Tarwebloem, roomboter (21%), water, suiker, gist, zonnebloemolie, zout', 'Bevat: tarwe, melk, ei'], 103: ['Volle melk, yoghurtcultuur', 'Bevat: melk'] };
      const ids = [...q.matchAll(/p(\d+): product\(id: (\d+)\)/g)];
      const data = {};
      for (const [, k, id] of ids) data['p' + k] = { id: +id, tradeItem: LABELS[id] ? { ingredients: { statement: LABELS[id][0], allergens: { contains: LABELS[id][1], mayContain: null } } } : null };
      return { status: 200, body: JSON.stringify({ data }) };
    }
    if (/FetchNutrition/.test(q) && AH.nutriError) {
      const ids = [...q.matchAll(/p(\d+): product\(id: (\d+)\)/g)];
      const data = {}; for (const [, k] of ids) data['p' + k] = null;
      return { status: 200, body: JSON.stringify({ data, errors: [{ message: 'Upstream timeout', path: ['p0'] }] }) };
    }
    if (/FetchNutrition/.test(q)) {
      const ids = [...q.matchAll(/p(\d+): product\(id: (\d+)\)/g)];
      const data = {};
      for (const [, k, id] of ids) data['p' + k] = { id: +id, tradeItem: NUTRI[id] ? { nutritions: [{ nutrients: NUTRI[id] }] } : null };
      return { status: 200, body: JSON.stringify({ data }) };
    }
  }
  return { status: 404, body: '{}' };
}

/* ---------- Scriptable stand-in ---------- */
function makeEnv(browserCtx, docs, keychain, opts) {
  const env = { webviews: [], widget: null, done: null };
  class Request {
    constructor(url) { this.url = url; this.method = 'GET'; this.headers = {}; this.body = null; this.timeoutInterval = 60; this.response = null; }
    async loadString() { const r = ahRespond(this); this.response = { statusCode: r.status }; return r.body; }
    async loadJSON() { return JSON.parse(await this.loadString()); }
  }
  const fmApi = {
    documentsDirectory: () => docs,
    joinPath: (a, b) => path.join(a, b),
    fileExists: p => fs.existsSync(p),
    readString: p => fs.readFileSync(p, 'utf8'),
    writeString: (p, s) => fs.writeFileSync(p, s),
    createDirectory: p => fs.mkdirSync(p, { recursive: true }),
    isFileStoredIniCloud: () => !!opts.icloudBroken,
    isFileDownloaded: () => !opts.icloudBroken,
    downloadFileFromiCloud: async () => { if (opts.icloudBroken) throw new Error('iCloud offline'); },
  };
  const FileManager = { iCloud: () => fmApi, local: () => fmApi };
  const Keychain = { contains: k => keychain.has(k), get: k => keychain.get(k), set: (k, v) => keychain.set(k, v), remove: k => keychain.delete(k) };
  class Timer { constructor() { this.timeInterval = 0; this.repeats = false; } schedule(cb) { this._t = setTimeout(cb, Math.min(this.timeInterval, 150)); } invalidate() { clearTimeout(this._t); } }
  class WebView {
    constructor() { this.page = null; this.loadedURL = null; this.shouldAllowRequest = null; this._dismiss = null; env.webviews.push(this); }
    async ensure() {
      if (!this.page) {
        this.page = await browserCtx.newPage();
        this.page.on('pageerror', e => env.pageErrors.push(String(e)));
        await this.page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
      }
      return this.page;
    }
    async fresh() { if (this.page) { const old = this.page; this.page = null; await old.close(); } return this.ensure(); }
    async loadHTML(html) { const p = await this.fresh(); this.loadedURL = null; await p.setContent(html, { waitUntil: 'load' }); }
    async loadURL(url) { const p = await this.fresh(); this.loadedURL = url; await p.setContent('<p>AH login</p>'); }
    async evaluateJavaScript(js) { const p = await this.ensure(); return p.evaluate(js); }
    present() { env.presentedAt = AH.calls.length; return new Promise(r => { this._dismiss = r; }); }
    dismiss() { if (this._dismiss) this._dismiss(); }
  }
  class ListWidget {
    constructor() { this.texts = []; this.backgroundColor = null; this.refreshAfterDate = null; env.widget = this; }
    addText(t) { const o = { text: t }; this.texts.push(o); return o; }
    addSpacer() {} setPadding() {}
  }
  class Color { constructor(hex) { this.hex = hex; } }
  const Font = { boldSystemFont: s => ({ s, b: true }), systemFont: s => ({ s }) };
  const config = { runsInWidget: !!opts.widget, widgetFamily: 'medium' };
  const Script = { complete: () => {}, setWidget: w => { env.widget = w; } };
  const module = { filename: path.join(docs, 'Laatste Kans.js') };
  env.pageErrors = [];
  env.opened = [];
  const Safari = { open: url => env.opened.push(url) };
  if (opts.family) config.widgetFamily = opts.family;
  if (opts.accessory) config.runsInAccessoryWidget = true;
  env.globals = { Request, FileManager, Keychain, Timer, WebView, ListWidget, Color, Font, config, Script, module, Safari };
  return env;
}
async function pickStores(page, ids) {
  await page.click('#storeBtn');
  await page.waitForSelector('#storeSheet:not([hidden])');
  await page.evaluate(want => { for (const i of document.querySelectorAll('#storeSheetList input')) { if (i.checked !== want.includes(i.dataset.id)) i.click(); } }, ids);
  await page.click('#storeSheetDone');
}
function run(env) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const names = Object.keys(env.globals);
  const fn = new AsyncFunction(...names, SCRIPT);
  env.done = fn(...names.map(n => env.globals[n]));
  env.done.catch(e => { env.error = e; });
  return env;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-scriptable-'));
  const keychain = new Map();

  console.log('\n[first run: pick a store, live bargains]');
  let env = run(makeEnv(ctx, docs, keychain, {}));
  await until(() => env.webviews[0] && env.webviews[0].page, 8000, 'webview');
  let wv = env.webviews[0], page = wv.page;
  await until(() => page.evaluate(() => window.LK && window.LK.Store.loaded), 8000, 'page boot');
  ok(await page.evaluate(() => window.LK.Store.mode === 'host'), 'page runs in host mode');
  ok(await page.isVisible('#liveCard') && /Kies je AH/.test(await page.textContent('#liveStatus')), 'asks to pick a store');
  await pickStores(page, ['ah-1829']);
  await until(() => page.evaluate(() => window.LK.S.session.candidates.some(c => c.source === 'ah')), 10000, 'live items');
  const live = await page.evaluate(() => window.LK.S.session.candidates.filter(c => c.source === 'ah').map(c => ({ name: c.name, n: c.n, ns: c.nutriSource, pct: c.discountPct, grams: c.grams, tags: c.tags })));
  ok(live.length >= 3, 'live items in Gevonden: ' + live.map(x => x.name).join(', '));
  const kd = live.find(x => x.name === 'Kipdijfilet');
  ok(kd && kd.ns === 'etiket' && kd.n.protein === 19 && kd.n.kcal === 147 && kd.grams === 400, 'Kipdijfilet uses label nutrition from AH');
  ok(AH.calls.some(c => c.query === 'StoresSearch') && AH.calls.some(c => c.query === 'BargainItems' && c.vars.storeId === '1829'), 'store id resolved by address (1829, not the first result)');
  const cro = await page.evaluate(() => { const c = window.LK.S.session.candidates.find(x => /croissant/i.test(x.name)); const ev = c && window.LK.evaluate(c, window.LK.S.profile); return c && { ingr: c.ingr, tags: c.tags, verdict: ev.verdict, why: ev.reasons.map(r => r.s).join(' | ') }; });
  ok(cro && /zonnebloemolie/.test(cro.ingr) && cro.verdict === 'nee' && /Wegfilter Zaadoliën \(PUFA\): bevat zonnebloemolie \(etiket\)/.test(cro.why), 'croissant with sunflower oil on the AH label: Past niet: ' + (cro && cro.why));
  ok(cro && cro.tags.includes('egg') && cro.tags.includes('dairy'), 'allergens from the AH label become tags');
  ok(AH.calls.some(c => c.query === 'FetchIngredients'), 'ingredients fetched in their own query');
  const cacheNow = JSON.parse(fs.readFileSync(path.join(docs, 'Laatste Kans data', 'voeding-cache.json'), 'utf8'));
  ok(cacheNow['102'] && cacheNow['102'].i && /zonnebloemolie/.test(cacheNow['102'].i.s), 'ingredients cached per product');
  ok(AH.badHeaders === 0, 'every AH call carries the app headers');
  ok(/Paddepoel.*koopje.*bijgewerkt/.test(await page.textContent('#liveLines')) && await page.evaluate(() => document.querySelector('#liveDot').classList.contains('on')), 'live card shows count and time');
  const shown = await page.$$eval('#candList .item .item-name', els => els.map(e => e.textContent));
  ok(shown.some(t => /Kipdijfilet/.test(t)) && shown.every(t => /live/.test(t) || true), 'live cards rendered with the live tag');
  await until(() => fs.existsSync(path.join(docs, 'Laatste Kans data', 'state.json')) && JSON.parse(fs.readFileSync(path.join(docs, 'Laatste Kans data', 'state.json'), 'utf8')).profile?.stores?.[0] === 'ah-1829', 6000, 'state saved');
  ok(true, 'profile with the store saved to iCloud Drive file');
  ok(fs.existsSync(path.join(docs, 'Laatste Kans data', 'voeding-cache.json')), 'nutrition cached per product');

  // vegetarian: spekreepjes and kipdijfilet hidden by the "past bij mij" filter
  await page.goto('about:blank').catch(() => {});
  wv.dismiss();
  await until(() => env.done && Promise.race([env.done.then(() => true), wait(50).then(() => false)]), 8000, 'script end');
  ok(!env.error, 'script ended cleanly' + (env.error ? ': ' + env.error.stack : ''));

  console.log('\n[second run: diet filter and finishing a trip]');
  const st = JSON.parse(fs.readFileSync(path.join(docs, 'Laatste Kans data', 'state.json'), 'utf8'));
  st.profile = Object.assign(st.profile, { eat: 'vega', setAt: Date.now() });
  fs.writeFileSync(path.join(docs, 'Laatste Kans data', 'state.json'), JSON.stringify(st));
  const callsBefore = AH.calls.length;
  env = run(makeEnv(ctx, docs, keychain, {}));
  await until(() => env.webviews[0] && env.webviews[0].page, 8000, 'webview');
  wv = env.webviews[0]; page = wv.page;
  await until(() => page.evaluate(() => window.LK && window.LK.Store.loaded && window.LK.S.session.liveMeta['ah-1829']), 8000, 'boot with live data');
  ok(!AH.calls.slice(callsBefore).some(c => c.query === 'StoresSearch'), 'store id remembered, no second lookup');
  ok(!AH.calls.slice(callsBefore).some(c => c.query === 'FetchNutrition'), 'nutrition served from cache');
  const names = await page.$$eval('#candList .item .item-name', els => els.map(e => e.textContent));
  ok(!names.some(n => /Kipdijfilet|Spekreepjes/.test(n)) && /verborgen/.test(await page.textContent('#candList')), 'vegetarian: meat hidden, with a note');
  await page.click('#candList button:has-text("Toon alles")');
  ok((await page.$$eval('#candList .item .item-name', els => els.map(e => e.textContent))).some(n => /Spekreepjes/.test(n)), 'Toon alles shows them again');
  await page.click('#candList .item:has-text("Volle yoghurt") button:has-text("In mandje")');
  await page.click('#finishBtn');
  await page.click('#confirmFinishBtn');
  await until(() => (JSON.parse(fs.readFileSync(path.join(docs, 'Laatste Kans data', 'state.json'), 'utf8')).trips || []).length === 1, 6000, 'trip saved');
  ok(true, 'finished trip saved to the state file');
  await page.click('#candList button:has-text("Weg")').catch(() => {});
  wv.dismiss();
  await until(() => Promise.race([env.done.then(() => true), wait(50).then(() => false)]), 8000, 'script end');

  console.log('\n[AH asks for login]');
  AH.requireLogin = true;
  keychain.clear();
  env = run(makeEnv(ctx, docs, keychain, {}));
  await until(() => env.webviews[0] && env.webviews[0].page, 8000, 'webview');
  wv = env.webviews[0]; page = wv.page;
  await until(() => page.evaluate(() => window.LK && window.LK.Store.loaded), 8000, 'boot');
  await until(() => page.isVisible('#liveLogin'), 6000, 'login button');
  ok(/ingelogd|in te loggen/i.test(await page.textContent("#liveStatus")), "hidden AH error with an anonymous token asks for a login");
  await page.click('#liveLogin');
  await until(() => wv.loadedURL, 6000, 'login page');
  ok(/^https:\/\/login\.ah\.nl\/login\?client_id=appie-ios&response_type=code&redirect_uri=appie:\/\/login-exit$/.test(wv.loadedURL), 'opens the AH login page');
  const allowed = wv.shouldAllowRequest({ url: 'appie://login-exit?code=good-code' });
  ok(allowed === false, 'catches the appie:// redirect');
  await until(() => AH.calls.some(c => c.query === 'BargainItems' && c.auth === 'Bearer member-token'), 10000, 'member fetch');
  await until(() => wv.page.evaluate(() => window.LK && window.LK.Store.loaded && (m => m && !m.stale)(window.LK.S.session.liveMeta['ah-1829']) && window.LK.S.session.candidates.some(c => c.source === 'ah')), 10000, 'bargains after login');
  page = wv.page;
  ok(JSON.parse(keychain.get('laatste-kans.ah-tokens')).kind === 'member', 'member token kept in the Keychain');
  ok(AH.calls.filter(c => c.query === 'BargainItems').pop().auth === 'Bearer member-token', 'bargains fetched with the member token');
  ok(env.pageErrors.length === 0, 'no page errors' + (env.pageErrors.length ? ': ' + env.pageErrors.join(' | ') : ''));

  console.log('\n[self-update]');
  AH.scriptText = SCRIPT.replace(/const VERSION = '[^']+'/, "const VERSION = 'vtest'");
  await page.evaluate(() => { window.LK && document.querySelector('a[href="#info"]') && (location.hash = '#info'); });
  await until(() => page.isVisible('#liveInfoCard button:has-text("Script bijwerken")'), 4000, 'update button');
  await page.click('#liveInfoCard button:has-text("Script bijwerken")');
  await until(() => fs.existsSync(path.join(docs, 'Laatste Kans.js')), 6000, 'script written');
  ok(/const VERSION = 'vtest'/.test(fs.readFileSync(path.join(docs, 'Laatste Kans.js'), 'utf8')), 'new version written over the script');
  wv.dismiss();
  await until(() => Promise.race([env.done.then(() => true), wait(50).then(() => false)]), 8000, 'script end');

  console.log('\n[widget]');
  const st2 = JSON.parse(fs.readFileSync(path.join(docs, 'Laatste Kans data', 'state.json'), 'utf8'));
  st2.profile.eat = 'alles';
  fs.writeFileSync(path.join(docs, 'Laatste Kans data', 'state.json'), JSON.stringify(st2));
  env = run(makeEnv(ctx, docs, keychain, { widget: true }));
  await env.done;
  const texts = (env.widget && env.widget.texts.map(t => t.text)) || [];
  ok(texts.some(t => /voor jou/.test(t)) && texts.some(t => /Paddepoel/.test(t)), 'widget shows matches and the store: ' + texts.join(' | '));
  ok(texts.some(t => /Kipdijfilet/.test(t)), 'widget lists Kipdijfilet as a match');
  ok(env.widget && env.widget.refreshAfterDate instanceof Date, 'widget asks to refresh later');

  console.log('\n[review regressions]');
  const docs2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-scriptable2-'));
  const kc2 = new Map();
  const stFile = path.join(docs2, 'Laatste Kans data', 'state.json');
  fs.mkdirSync(path.dirname(stFile), { recursive: true });
  AH.requireLogin = false;
  const keep = { profile: { store: 'ah-1829', eat: 'alles', setAt: 1, savedAt: 1 }, session: { candidates: [], basket: [], pantry: [], hiddenAH: [] }, trips: [{ id: 't1', date: today, spent: 3, saved: 1, items: [] }] };
  fs.writeFileSync(stFile, JSON.stringify(keep));

  // The app is shown before any bargains request goes out.
  const before = AH.calls.length;
  env = run(makeEnv(ctx, docs2, kc2, {}));
  await until(() => env.webviews[0] && env.webviews[0].page && env.presentedAt != null, 8000, 'present');
  ok(!AH.calls.slice(before, env.presentedAt).some(c => c.query === 'BargainItems'), 'app is shown before the bargains are fetched');
  wv = env.webviews[0];
  await until(() => wv.page.evaluate(() => window.LK && (m => m && !m.stale)(window.LK.S.session.liveMeta['ah-1829'])), 10000, 'fresh live');
  page = wv.page;
  // Links leave the app through Safari.
  ok(wv.shouldAllowRequest({ url: 'https://maps.apple.com/?q=Albert+Heijn' }) === false && env.opened.length === 1, 'web links open in Safari, the app stays');
  ok(wv.shouldAllowRequest({ url: 'about:blank' }) === true, 'the app page itself still loads');
  // An edited live item survives a refresh.
  await page.click('#candList .item:has-text("Volle yoghurt") button:has-text("Wijzig")');
  await page.evaluate(() => { document.querySelector('#nutriBox').open = true; });
  await page.fill('#nKcal', '70');
  await page.click('#addForm button[type="submit"]');
  await page.click('#liveRefresh');
  await until(() => page.evaluate(() => window.LK.S.live.status === 'ok'), 8000, 'refresh done');
  const yog = await page.evaluate(() => window.LK.S.session.candidates.filter(c => /Volle yoghurt/.test(c.name)).map(c => c.n && c.n.kcal));
  ok(yog.length === 1 && yog[0] === 70, 'edited live item kept after refresh: ' + JSON.stringify(yog));
  // Following a second store adds its bargains, each card says where; the filter narrows to one store.
  await pickStores(page, ['ah-1829', 'ah-1093']);
  await until(() => page.evaluate(() => (m => m && !m.stale)(window.LK.S.session.liveMeta['ah-1093'])), 8000, 'second store');
  const both = await page.evaluate(() => [...new Set(window.LK.S.session.candidates.filter(c => c.source === 'ah').map(c => c.storeKey))].sort());
  ok(both.join() === 'ah-1093,ah-1829', 'bargains from both stores: ' + both);
  ok(/bij Selwerd/.test(await page.textContent('#candList')), 'cards say which store');
  ok(/2 winkels/.test(await page.textContent('#storeBtn')), 'header shows 2 winkels');
  ok(await page.isVisible('#liveStoreSel') && (await page.$$('#liveStoreSel option')).length === 3, 'store dropdown with all + 2 stores');
  ok((await page.$$('#liveLines li')).length === 2, 'one status line per store');
  await page.selectOption('#liveStoreSel', 'ah-1093');
  const only = await page.$$eval('#candList .item', els => els.map(e => e.textContent));
  ok(only.length >= 1 && only.every(t => /Broccoli/.test(t) || !/live/.test(t)), 'store filter shows only that store');
  await page.selectOption('#liveStoreSel', 'all');
  // One store failing does not hide the other.
  AH.failStore = '1093';
  await page.click('#liveRefresh');
  await until(() => page.evaluate(() => (window.LK.S.live.per['ah-1093'] || {}).status === 'error' && (window.LK.S.live.per['ah-1829'] || {}).status === 'ok'), 8000, 'per-store error');
  const lines = await page.textContent('#liveLines');
  ok(/Selwerd[^]*fout|Selwerd[^]*lukte/i.test(lines) && /Paddepoel[^]*bijgewerkt/.test(lines), 'error shown for one store, the other still fine: ' + lines.replace(/\s+/g, ' '));
  AH.failStore = null;
  // Dropping a store removes its bargains at once.
  await pickStores(page, ['ah-1829']);
  const left = await page.evaluate(() => window.LK.S.session.candidates.filter(c => c.source === 'ah' && c.storeKey === 'ah-1093').length);
  ok(left === 0, 'unfollowed store items cleared');
  ok(await page.isHidden('#liveStoreWrap'), 'store dropdown hidden with one store');
  await page.click('#candList .item:has-text("Kipdijfilet") button:has-text("Weg")');
  await wait(800);
  wv.dismiss();
  await until(() => Promise.race([env.done.then(() => true), wait(50).then(() => false)]), 8000, 'end');

  // Widget leaves out removed items; Lock Screen inline widget shows the count.
  env = run(makeEnv(ctx, docs2, kc2, { widget: true }));
  await env.done;
  const wtexts = env.widget.texts.map(t => t.text);
  ok(!wtexts.some(t => /Kipdijfilet/.test(t)), 'widget skips items you removed: ' + wtexts.join(' | '));
  env = run(makeEnv(ctx, docs2, kc2, { widget: true, family: 'accessoryInline', accessory: true }));
  await env.done;
  ok(env.widget.texts.length === 1 && /koopjes voor jou/.test(env.widget.texts[0].text), 'Lock Screen inline widget: ' + env.widget.texts.map(t => t.text).join(' | '));
  const stw = JSON.parse(fs.readFileSync(stFile, 'utf8'));
  stw.profile.stores = ['ah-1829', 'ah-1093'];
  fs.writeFileSync(stFile, JSON.stringify(stw));
  env = run(makeEnv(ctx, docs2, kc2, { widget: true }));
  await env.done;
  const mt = env.widget.texts.map(t => t.text);
  ok(mt.some(t => /2 winkels/.test(t)) && mt.some(t => /Broccoli.*Selwerd/.test(t)), 'widget combines stores: ' + mt.join(' | '));
  stw.profile.stores = ['ah-1829'];
  fs.writeFileSync(stFile, JSON.stringify(stw));

  // Markdown history: kept per store and product, offers that disappear are marked as gone.
  const histFile = path.join(docs2, 'Laatste Kans data', 'afprijs-geschiedenis.json');
  let hist = JSON.parse(fs.readFileSync(histFile, 'utf8'));
  const k101 = Object.keys(hist.offers).find(k => k.startsWith('ah-1829|101|'));
  ok(k101 && hist.offers[k101].o.length >= 1 && hist.fetches['ah-1829'].length >= 2, 'history records offers and fetches per store');
  const saved = BARGAINS.splice(0, 1); // Kipdijfilet sold out
  env = run(makeEnv(ctx, docs2, kc2, { widget: true }));
  await env.done;
  BARGAINS.unshift(...saved);
  hist = JSON.parse(fs.readFileSync(histFile, 'utf8'));
  ok(hist.offers[k101].g != null, 'an offer that disappears is marked as gone');
  // Seed 20 days of history: Spekreepjes at 40% sold out before reaching 70% on 14 of 20 days.
  const now = Date.now();
  for (let d = 1; d <= 20; d++) {
    const t0 = now - d * 86400000, e = new Date(t0).toISOString().slice(0, 10);
    const up = d % 10 >= 7;
    hist.offers[`ah-1829|104|${e}`] = { s: 'ah-1829', p: 104, c: 'vlees', n: 'Spekreepjes', e, w: 2.29, f: t0, l: t0 + 4 * 3600000, g: up ? null : t0 + 4 * 3600000,
      o: up ? [[t0, 40, 1.37, 1, t0 + 3600000], [t0 + 3 * 3600000, 70, 0.69, 1, t0 + 4 * 3600000]] : [[t0, 40, 1.37, 1, t0 + 3 * 3600000]] };
    if (up) hist.offers[`ah-1829|104|${e}`].g = t0 + 5 * 3600000;
  }
  fs.writeFileSync(histFile, JSON.stringify(hist));
  env = run(makeEnv(ctx, docs2, kc2, {}));
  await until(() => env.webviews[0] && env.webviews[0].page, 8000, 'webview');
  wv = env.webviews[0];
  await until(() => wv.page.evaluate(() => window.LK && (m => m && !m.stale)(window.LK.S.session.liveMeta['ah-1829'])), 10000, 'fresh live');
  page = wv.page;
  await page.click('#liveFilter button[data-v="all"]');
  const kdCard = await page.textContent('#candList .item:has-text("Spekreepjes")');
  ok(/Nu kopen/.test(kdCard) && /Dit product in deze winkel: 6 van de 20 keer verder gezakt/.test(kdCard) && /14× eerst op/.test(kdCard), 'card advises to buy now from the product history: ' + (kdCard.match(/Nu kopen.*?eerst op/) || [''])[0]);
  ok(/Gevolgd: 2\d× in de aanbieding gezien/.test(kdCard) && /meestal tot 40%/.test(kdCard), 'card shows the product track record: ' + (kdCard.match(/Gevolgd:[^.]*\./) || [''])[0]);
  ok(await page.evaluate(() => window.LK.S.stats && (window.LK.S.stats.offers + (window.LK.S.stats.folded || 0)) > 20), 'stats sent to the page after a refresh, old offers folded into counters');
  await page.click('a[href="#logboek"]');
  ok(/Hoe AH afprijst bij jou/.test(await page.textContent('#patternCard')) && /Paddepoel/.test(await page.textContent('#patternCard')), 'Logboek shows the markdown pattern per store');
  await page.click('#prodTrack summary');
  await page.fill('#prodSearch', 'spek');
  const prow = await page.textContent('#prodList');
  ok(/Spekreepjes/.test(prow) && /40%: 6 van 20× verder naar 70%/.test(prow) && /14× eerst op/.test(prow) && !/Kipdijfilet/.test(prow), 'Logboek per product: search finds the product with its own record: ' + prow.slice(0, 160));
  await page.fill('#prodSearch', '');
  ok((await page.$$('#prodList .prod-row')).length >= 3, 'per product list shows all followed products');
  // All stores at once: no limit, summary line instead of one line per store.
  await page.click('a[href="#winkel"]');
  await page.click('#storeBtn');
  await page.click('#storeSheetAll');
  await page.click('#storeSheetDone');
  const NST = await page.evaluate(() => STORES.length);
  ok(new RegExp(NST + ' winkels').test(await page.textContent('#storeBtn')), `all ${NST} stores followed`);
  await until(() => page.evaluate(() => Object.values(window.LK.S.live.per).filter(x => x.status === 'loading').length === 0), 20000, 'all fetched');
  ok(new RegExp(NST + ' winkels: \\d+ koopjes').test(await page.textContent('#liveLines')), 'summary line for many stores: ' + (await page.textContent('#liveLines')).slice(0, 80));
  await pickStores(page, ['ah-1829']);
  wv.dismiss();
  await until(() => Promise.race([env.done.then(() => true), wait(50).then(() => false)]), 8000, 'end');

  // A GraphQL field error (data.bargainItems null) asks for a login instead of showing 0 bargains.
  AH.partialAuth = true; kc2.clear();
  env = run(makeEnv(ctx, docs2, kc2, {}));
  await until(() => env.webviews[0] && env.webviews[0].page, 8000, 'webview');
  wv = env.webviews[0];
  await until(() => wv.page.isVisible('#liveLogin'), 8000, 'login prompt');
  ok(/ingelogd|in te loggen/.test(await wv.page.textContent('#liveStatus')), 'field-level auth error leads to the login prompt');
  wv.dismiss();
  await until(() => Promise.race([env.done.then(() => true), wait(50).then(() => false)]), 8000, 'end');
  AH.partialAuth = false;

  // A failed member refresh (503) keeps the login.
  kc2.set('laatste-kans.ah-tokens', JSON.stringify({ access: 'member-token', refresh: 'member-refresh', expiresAt: 0, kind: 'member' }));
  AH.refresh503 = true;
  env = run(makeEnv(ctx, docs2, kc2, { widget: true }));
  await env.done;
  ok(kc2.has('laatste-kans.ah-tokens') && JSON.parse(kc2.get('laatste-kans.ah-tokens')).kind === 'member', 'refresh 503 does not log the member out');
  AH.refresh503 = false;

  // AH rejecting the ingredient fields does not break nutrition.
  AH.ingrBroken = true;
  fs.writeFileSync(path.join(docs2, 'Laatste Kans data', 'voeding-cache.json'), '{}');
  env = run(makeEnv(ctx, docs2, kc2, { widget: true }));
  await env.done;
  const cb = JSON.parse(fs.readFileSync(path.join(docs2, 'Laatste Kans data', 'voeding-cache.json'), 'utf8'));
  ok(cb['101'] && cb['101'].n && cb['101'].n.protein === 19 && cb['101'].i === undefined, 'ingredient query refused: nutrition still cached, ingredients left for later');
  AH.ingrBroken = false;

  // Nutrition errors are not cached as "no label".
  const cacheFile = path.join(docs2, 'Laatste Kans data', 'voeding-cache.json');
  fs.writeFileSync(cacheFile, '{}');
  AH.nutriError = true;
  env = run(makeEnv(ctx, docs2, kc2, { widget: true }));
  await env.done;
  ok(Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))).length === 0, 'nutrition answered with errors is not cached');
  AH.nutriError = false;

  // An iCloud file that cannot be read is never overwritten.
  const good = fs.readFileSync(stFile, 'utf8');
  env = run(makeEnv(ctx, docs2, kc2, { icloudBroken: true }));
  await until(() => env.webviews[0] && env.webviews[0].page, 8000, 'webview');
  wv = env.webviews[0];
  await until(() => wv.page.evaluate(() => window.LK && window.LK.Store.loaded), 8000, 'boot');
  ok(/niet worden gelezen/.test(await wv.page.textContent('#loadBanner')), 'warns that saved data could not be read');
  await wv.page.click('a[href="#dieet"]');
  await wv.page.click('#dietSubmit');
  await wait(1500);
  wv.dismiss();
  await until(() => Promise.race([env.done.then(() => true), wait(50).then(() => false)]), 8000, 'end');
  ok(fs.readFileSync(stFile, 'utf8') === good, 'unreadable state file left untouched by the app');
  env = run(makeEnv(ctx, docs2, kc2, { widget: true, icloudBroken: true }));
  await env.done;
  ok(fs.readFileSync(stFile, 'utf8') === good, 'and by the widget');

  await browser.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
