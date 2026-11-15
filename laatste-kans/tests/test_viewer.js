// Run: node tests/test_viewer.js   (after: python3 build.py)
// Runs dist/index.html with a stand-in for the claude.ai viewer (window.claude with
// db, user and sample) to check private storage paths, reload, live sync from another
// device, retry and offline fallback, screenshot reading and the Claude plan.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const FILE = 'file://' + path.resolve(__dirname, '..', 'dist', 'index.html');
let failures = 0;
function ok(cond, msg) { if (cond) console.log('  ok  ' + msg); else { failures++; console.log('  FAIL ' + msg); } }

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const pngPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lk-')), 'screenshot.png');
fs.writeFileSync(pngPath, PNG);

const MOCK = () => {
  const opts = JSON.parse(localStorage.getItem('__mockopts') || '{}');
  const load = () => JSON.parse(localStorage.getItem('__mockdb') || '{}');
  const store = d => localStorage.setItem('__mockdb', JSON.stringify(d));
  window.__writes = [];
  window.__images = 0;
  const listeners = {};
  let getCount = 0;
  const segs = p => p.split('/').filter(Boolean).length;
  const snap = (p, d) => ({ id: p.split('/').pop(), exists: d != null, data: () => d == null ? undefined : JSON.parse(JSON.stringify(d)), metadata: { fromCache: false, hasPendingWrites: false } });
  const failGet = async () => {
    getCount++;
    if (opts.alwaysFailGet) throw { code: 'unavailable', message: 'down' };
    if (opts.failFirstGet && getCount === 1) { window.__getFails = 1; throw { code: 'unavailable', message: 'blip' }; }
  };
  function doc(p) {
    if (segs(p) % 2) throw new TypeError('doc path needs even segments: ' + p);
    return {
      id: p.split('/').pop(), path: p,
      async get() { await failGet(); return snap(p, load()[p]); },
      async set(d) { if (opts.failSet) throw { code: 'unavailable' }; const db = load(); db[p] = JSON.parse(JSON.stringify(d)); store(db); window.__writes.push(p); },
      async update(d) { const db = load(); db[p] = Object.assign(db[p] || {}, d); store(db); window.__writes.push(p); },
      async delete() { const db = load(); delete db[p]; store(db); window.__writes.push('DEL ' + p); },
      onSnapshot(next) { (listeners[p] = listeners[p] || []).push(next); setTimeout(() => next(snap(p, load()[p])), 5); return () => { listeners[p] = listeners[p].filter(f => f !== next); }; },
      collection(c) { return collection(p + '/' + c); },
    };
  }
  function collection(p, order, lim) {
    if (segs(p) % 2 === 0) throw new TypeError('collection path needs odd segments: ' + p);
    return {
      path: p,
      doc: id => doc(p + '/' + (id || Math.random().toString(36).slice(2))),
      orderBy: (f, dir) => collection(p, [f, dir], lim),
      limit: n => collection(p, order, n),
      async get() {
        await failGet();
        const db = load();
        let docs = Object.keys(db).filter(k => k.startsWith(p + '/') && segs(k) === segs(p) + 1).map(k => snap(k, db[k]));
        if (order) docs.sort((a, b) => (order[1] === 'desc' ? -1 : 1) * ((a.data()[order[0]] || 0) - (b.data()[order[0]] || 0)));
        if (lim) docs = docs.slice(0, lim);
        return { docs, size: docs.length, empty: !docs.length };
      },
    };
  }
  window.__remoteSet = (p, d) => { const db = load(); db[p] = d; store(db); (listeners[p] || []).forEach(f => f(snap(p, d))); };
  const db = { doc, collection };
  const user = { id: async () => 'u_test', isOwner: async () => true };
  const sample = async (input, o) => { const text = '## Kopen of laten\n- **Kipdijfilet**: meenemen\n## Maaltijden\n- Roerbak'; if (o && o.onText) o.onText({ text, delta: text }); return { text, truncated: false, modelTierApplied: 'default' }; };
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 3, maxInputBytes: 20e6, mediaTypes: ['image/jpeg', 'image/png'] } });
  sample.json = async (input, o) => {
    if (o && o.images) {
      window.__images += o.images.length;
      window.__imageIsBlob = o.images.every(b => b instanceof Blob);
      const t = new Date(); const d = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
      return { items: [
        { name: 'Kipdijfilet', grams: 400, priceNormal: 4.99, priceNow: 2.99, discountPct: 40, expiry: d, cat: 'gevogelte', per100: { kcal: 147, protein: 19, carbs: 0, sugar: 0, fat: 7.9, satfat: 2.3, fiber: 0, salt: 0.2 }, tags: ['meat'], freezable: true, confidence: 'hoog' },
        { name: 'Vegetarische schijf', grams: 200, priceNow: 1.5 },
      ] };
    }
    return { kcal: 100, protein: 10, carbs: 5, fat: 3, tags: [], cat: 'overig', freezable: false, grams: 200 };
  };
  window.claude = { use: async name => ({ db, user, sample })[name] || null };
};

async function setOpts(ctx, o) {
  const p = await ctx.newPage();
  await p.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await p.goto(FILE);
  await p.evaluate(v => localStorage.setItem('__mockopts', v), JSON.stringify(o));
  await p.close();
}
async function open(ctx, hash = '') {
  const page = await ctx.newPage();
  page.on('pageerror', e => ok(false, 'page error: ' + e));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(FILE + hash);
  await page.waitForFunction(() => window.LK && window.LK.Store.loaded, null, { timeout: 15000 });
  return page;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(MOCK);

  console.log('\n[viewer: first visit]');
  let page = await open(ctx);
  ok(await page.evaluate(() => window.LK.Store.mode === 'db' && window.LK.Store.uid === 'u_test'), 'uses private account storage');
  await page.waitForFunction(() => !document.querySelector('#photoRow').hidden);
  ok(true, 'screenshot and photo buttons shown when Claude can read images');
  await page.fill('#q', 'kipfilet 500g 6,49 35%');
  await page.click('#suggest li:first-child button');
  await page.click('#addForm button[type="submit"]');
  await page.waitForTimeout(800);
  let writes = await page.evaluate(() => window.__writes);
  ok(writes.includes('data/users/u_test/session'), 'session written under data/users/<id>');
  ok(writes.every(w => w.replace('DEL ', '').startsWith('data/users/u_test/')), 'no writes outside the private subtree: ' + writes.join(','));

  await page.setInputFiles('#shotIn', pngPath);
  await page.waitForFunction(() => /toegevoegd/.test(document.querySelector('#photoStatus').textContent), null, { timeout: 10000 });
  const imgs = await page.evaluate(() => ({ n: window.__images, blob: window.__imageIsBlob }));
  ok(imgs.n === 1 && imgs.blob, 'screenshot sent to Claude as an image blob');
  const kd = await page.evaluate(() => window.LK.S.session.candidates.find(c => c.name === 'Kipdijfilet'));
  ok(kd && kd.tags.includes('poultry') && kd.source === 'claude', 'read item gets table tags merged in: ' + (kd && kd.tags));
  const vs = await page.evaluate(() => window.LK.S.session.candidates.find(c => c.name === 'Vegetarische schijf'));
  ok(vs && vs.discountPct == null && vs.priceNormal == null, 'sticker-only item has no invented discount');
  ok(/gelezen door Claude/.test(await page.textContent('#candList')), 'card marks items read by Claude');

  await page.goto(FILE + '#koken');
  await page.waitForFunction(() => window.LK.Store.loaded);
  await page.waitForFunction(() => !document.querySelector('#aiCard').hidden);
  await page.click('#adviceBtn');
  await page.waitForFunction(() => /Kopen of laten/.test(document.querySelector('#adviceOut').textContent));
  ok(true, 'Claude plan renders as headings and bullets');
  await page.close();

  console.log('\n[viewer: reload and other device]');
  page = await open(ctx);
  const n = await page.evaluate(() => window.LK.S.session.candidates.length);
  ok(n === 3, 'reload restores Gevonden from account storage: ' + n);
  await page.evaluate(() => {
    const s = JSON.parse(JSON.stringify(window.LK.S.session)); s.candidates = s.candidates.slice(0, 1); s.savedAt = Date.now() + 5000;
    window.__remoteSet('data/users/u_test/session', s);
  });
  await page.waitForTimeout(100);
  ok((await page.$$('#candList .item')).length === 1, 'change from another device shows up live');
  await page.click('#candList .item button:has-text("In mandje")');
  await page.click('#finishBtn');
  await page.click('#confirmFinishBtn');
  await page.waitForTimeout(800);
  writes = await page.evaluate(() => window.__writes);
  ok(writes.some(w => /^data\/users\/u_test\/log\/trips\/t/.test(w)), 'trip stored under the private log');
  await page.close();

  console.log('\n[viewer: transient error]');
  await setOpts(ctx, { failFirstGet: true });
  page = await open(ctx);
  ok(await page.evaluate(() => window.LK.Store.mode === 'db' && window.LK.S.trips.length === 1 && window.__getFails === 1), 'one failed read is retried, account storage kept');
  await page.close();

  console.log('\n[viewer: storage down, then back]');
  await setOpts(ctx, { alwaysFailGet: true });
  page = await open(ctx);
  ok(await page.evaluate(() => window.LK.Store.mode === 'local'), 'falls back to this device');
  ok(/niet bereikbaar/.test(await page.textContent('#loadBanner')), 'tells the user');
  ok(await page.evaluate(() => window.LK.S.trips.length === 1), 'cached trips still visible offline');
  await page.click('text=Laat voorbeelden zien');
  await page.fill('#q', 'broccoli');
  await page.click('#suggest li:first-child button');
  await page.click('#addForm button[type="submit"]');
  await page.click('#candList .item:has-text("Broccoli") button:has-text("In mandje")');
  await page.click('#finishBtn');
  await page.click('#confirmFinishBtn');
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => (JSON.parse(localStorage.getItem('lk:u_test:unsyncedTrips')) || []).length === 1), 'offline trip queued for sync');
  await page.close();
  await setOpts(ctx, {});
  page = await open(ctx);
  const st = await page.evaluate(() => ({ trips: window.LK.S.trips.length, mode: window.LK.Store.mode, q: (JSON.parse(localStorage.getItem('lk:u_test:unsyncedTrips')) || []).length, pantry: window.LK.S.session.pantry.map(x => x.name) }));
  ok(st.mode === 'db' && st.trips === 2 && st.q === 0, 'offline trip synced on next visit: ' + JSON.stringify(st));
  ok(st.pantry.includes('Broccoli'), 'newer offline session wins over older account copy');
  await page.waitForTimeout(800);
  await page.close();

  await browser.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
