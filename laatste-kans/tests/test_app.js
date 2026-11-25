// Run: node tests/test_app.js   (after: python3 build.py)
// Loads dist/index.html in headless Chromium, checks the scoring engine,
// a full shopping flow, phone layout in light and dark, and console errors.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const FILE = 'file://' + path.resolve(__dirname, '..', 'dist', 'index.html');
const SHOTS = process.env.SHOTS || '';
let failures = 0;
function ok(cond, msg) { if (cond) console.log('  ok  ' + msg); else { failures++; console.log('  FAIL ' + msg); } }

(async () => {
  const browser = await chromium.launch();
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text()) && !/ERR_|net::/.test(m.text())) errors.push(m.text()); });
    await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await page.goto(FILE);
    await page.waitForFunction(() => window.LK && window.LK.Store.loaded);
    console.log(`\n[${scheme}]`);

    if (scheme === 'light') {
      const r = await page.evaluate(() => {
        const { evaluate, matchFood, parseQuick, itemFromFood, defaultProfile, mealIdeas } = window.LK;
        const F = id => FOOD.find(f => f.id === id);
        const prof = o => Object.assign(defaultProfile(), o);
        const ev = (id, p, o) => evaluate(itemFromFood(F(id), o || {}), prof(p));
        const out = {};
        out.foodCount = FOOD.length;
        out.storeCount = STORES.length;
        out.pq1 = parseQuick('kipfilet 500g 6,49 35%');
        out.pq2 = parseQuick('AH zalmfilet 250 gr €5,99 €3,89');
        out.pq3 = parseQuick('rundergehakt 1kg 9.99');
        out.m1 = (matchFood('kipfilet')[0] || {}).f?.id;
        out.m2 = (matchFood('kwark mager')[0] || {}).f?.id;
        out.m3 = (matchFood('AH Spinazie 300 g')[0] || {}).f?.id;
        out.cutChicken = ev('kipfilet', { goal: 'cut', kcal: 1800, protein: 140 });
        out.cutCroissant = ev('croissant', { goal: 'cut', kcal: 1800, protein: 140 }, { discountPct: 50 });
        out.vegChicken = ev('kipfilet', { eat: 'vega' });
        out.ketoBanana = F('bananen') ? ev('bananen', { goal: 'keto' }) : null;
        out.ketoEggs = F('eieren') ? ev('eieren', { goal: 'keto' }) : null;
        out.lactoseKwark = ev('magere_kwark', { excl: { lactose: true } });
        const all = FOOD.map(f => ({ id: f.id, e: evaluate(itemFromFood(f), prof({})) }));
        out.allFinite = all.every(x => Number.isFinite(x.e.score) && x.e.score >= 0 && x.e.score <= 100);
        out.verdicts = all.reduce((a, x) => (a[x.e.verdict] = (a[x.e.verdict] || 0) + 1, a), {});
        out.meals = mealIdeas([itemFromFood(F('kipfilet')), itemFromFood(F('spinazie')), itemFromFood(F('eieren') || F('kipfilet'))], prof({})).map(x => x.meal.id);
        // Regressions from the code review
        out.pq4 = parseQuick('magere kwark 0% 500g 1,89 35%');
        out.pq5 = parseQuick('kip 500g 6,5 35%');
        const manual = (name, n, o) => Object.assign({ id: 'm', foodId: null, name, cat: 'overig', tags: window.LK.inferTags(name), source: 'manual', grams: 500, priceNormal: 7.99, discountPct: 35, priceNow: null, expDate: null, n }, o || {});
        out.vegaManualPork = evaluate(manual('Varkenshaas', { kcal: 120, protein: 22 }), prof({ goal: 'cut', eat: 'vega' })).verdict;
        out.halalManualPork = evaluate(manual('Varkenshaas', { kcal: 120, protein: 22 }), prof({ goal: 'cut', excl: { halal: true } })).verdict;
        out.glutenUnknown = evaluate(manual('Appelflap', { kcal: 300, protein: 4 }), prof({ excl: { gluten: true } })).verdict;
        out.ketoNoCarbs = evaluate(manual('Croissant', { kcal: 410, protein: 8 }), prof({ goal: 'keto' }));
        out.halalChicken = evaluate(itemFromFood(F('kipfilet')), prof({ goal: 'cut', excl: { halal: true } }));
        const onlyNow = window.LK.itemFromClaude({ name: 'Kipfilet', grams: 500, priceNow: 3.89 });
        out.onlyNow = evaluate(onlyNow, prof({ goal: 'cut' })).reasons.map(r => r.s).join(' | ');
        out.onlyNowPct = onlyNow.discountPct;
        out.tagPinda = window.LK.inferTags('AH pindakaas');
        out.tagSoja = window.LK.inferTags('Alpro sojamelk');
        out.tagVega = window.LK.inferTags('Vegetarische burger');
        out.tagHam = window.LK.inferTags('Beenham plakjes');
        out.ketoMeals = mealIdeas([itemFromFood(F('kipfilet')), itemFromFood(F('lasagne')), itemFromFood(F('spinazie'))], prof({ goal: 'keto' })).map(x => x.meal.id);
        out.slagSalad = mealIdeas([itemFromFood(F('kipfilet')), itemFromFood(F('slagroom'))], prof({})).map(x => x.meal.id);
        const y = new Date(); y.setDate(y.getDate() - 1);
        out.expired = window.LK.expState({ expDate: `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}` });
        out.unknownN = evaluate(manual('Broccoli', null, { tags: ['fresh_produce'] }), prof({})).verdict;
        out.soyRoerbak = mealIdeas([itemFromFood(F('kipfilet')), itemFromFood(F('broccoli'))], prof({ excl: { soy: true } })).find(x => x.meal.id === 'roerbak').how;
        return out;
      });
      ok(r.foodCount >= 100, `food table has ${r.foodCount} items`);
      ok(r.storeCount >= 8, `store list has ${r.storeCount} stores`);
      ok(r.pq1.name === 'kipfilet' && r.pq1.grams === 500 && r.pq1.price === 6.49 && r.pq1.pct === 35, 'parseQuick basic ' + JSON.stringify(r.pq1));
      ok(r.pq2.price === 5.99 && r.pq2.now === 3.89 && r.pq2.grams === 250, 'parseQuick two prices ' + JSON.stringify(r.pq2));
      ok(r.pq3.grams === 1000 && r.pq3.price === 9.99, 'parseQuick kg + dot decimal ' + JSON.stringify(r.pq3));
      ok(r.m1 === 'kipfilet', 'match kipfilet -> ' + r.m1);
      ok(r.m2 === 'magere_kwark', 'match "kwark mager" -> ' + r.m2);
      ok(r.m3 === 'spinazie', 'match "AH Spinazie 300 g" -> ' + r.m3);
      ok(r.cutChicken.verdict === 'ja', `cut + chicken 35% = ${r.cutChicken.verdict} (${r.cutChicken.score})`);
      ok(r.cutCroissant.verdict !== 'ja', `cut + croissant 50% = ${r.cutCroissant.verdict} (${r.cutCroissant.score})`);
      ok(r.vegChicken.verdict === 'nee', `vegetarian + chicken = ${r.vegChicken.verdict}`);
      ok(!r.ketoBanana || r.ketoBanana.verdict === 'laten' || r.ketoBanana.verdict === 'twijfel', `keto + banana = ${r.ketoBanana && r.ketoBanana.verdict} (${r.ketoBanana && r.ketoBanana.score})`);
      ok(!r.ketoEggs || r.ketoEggs.verdict === 'ja', `keto + eggs = ${r.ketoEggs && r.ketoEggs.verdict} (${r.ketoEggs && r.ketoEggs.score})`);
      ok(r.lactoseKwark.verdict === 'nee', `lactose-free + kwark = ${r.lactoseKwark.verdict}`);
      ok(r.allFinite, 'every food scores 0-100');
      console.log('       verdict spread (default profile): ' + JSON.stringify(r.verdicts));
      ok(r.meals.includes('roerbak') && r.meals.includes('salade'), 'meal ideas ' + r.meals.join(','));
      ok(r.pq4.pct === 35 && r.pq4.price === 1.89, 'parseQuick ignores 0% in name ' + JSON.stringify(r.pq4));
      ok(r.pq5.price === 6.5 && r.pq5.pct === 35, 'parseQuick one-decimal price ' + JSON.stringify(r.pq5));
      ok(r.vegaManualPork === 'nee', 'vega + typed "Varkenshaas" = ' + r.vegaManualPork);
      ok(r.halalManualPork === 'nee', 'halal + typed "Varkenshaas" = ' + r.halalManualPork);
      ok(r.glutenUnknown !== 'ja', 'gluten-free + unknown typed product is not Kopen: ' + r.glutenUnknown);
      ok(r.ketoNoCarbs.verdict !== 'ja' && !/Past in keto/.test(JSON.stringify(r.ketoNoCarbs.reasons)), 'keto + unknown carbs not Kopen: ' + r.ketoNoCarbs.verdict);
      ok(r.halalChicken.verdict !== 'ja' && /halal/.test(JSON.stringify(r.halalChicken.reasons)), 'halal + chicken capped with pinned reason: ' + r.halalChicken.verdict);
      ok(!/goedkoper/.test(r.onlyNow) && r.onlyNowPct == null, 'sticker-only price: no invented discount: ' + r.onlyNow);
      ok(!r.tagPinda.includes('dairy') && r.tagPinda.includes('nuts'), 'pindakaas tags ' + r.tagPinda);
      ok(!r.tagSoja.includes('dairy') && r.tagSoja.includes('soy'), 'sojamelk tags ' + r.tagSoja);
      ok(!r.tagVega.includes('meat'), 'vegetarische burger tags ' + r.tagVega);
      ok(r.tagHam.includes('pork'), 'beenham tags ' + r.tagHam);
      ok(!r.ketoMeals.includes('kantklaar'), 'keto meals skip ready meals: ' + r.ketoMeals);
      ok(!r.slagSalad.includes('salade'), 'slagroom is not salad leaves: ' + r.slagSalad);
      ok(r.expired === 'verlopen', 'yesterday = verlopen');
      ok(r.unknownN === 'twijfel', 'unknown nutrition = twijfel, not laten: ' + r.unknownN);
      ok(!/soja/i.test(r.soyRoerbak), 'soy-free roerbak text: ' + r.soyRoerbak);

      const ms = await page.evaluate(() => ({
        old: window.LK.profileStores({ store: 'ah-1330', stores: [] }),
        both: window.LK.profileStores({ stores: ['ah-1330', 'ah-1829', 'nope'] }),
        cap: window.LK.profileStores({ stores: STORES.map(s => s.id) }).length, total: STORES.length, borch: STORES.some(s => s.id === 'ah-4191' && s.city === 'Eelderwolde'),
      }));
      ok(ms.old.join() === 'ah-1330', 'old single-store profile migrates: ' + ms.old);
      ok(ms.both.join() === 'ah-1330,ah-1829', 'unknown store ids dropped');
      ok(ms.cap === ms.total && ms.total >= 24, `all ${ms.total} stores can be followed: ` + ms.cap);
      ok(ms.borch, 'AH Ter Borch (Borchsingel, Eelderwolde) is in the list');
      await page.click('#storeBtn');
      await page.click('#storeSheetList input[data-id="ah-1330"]');
      await page.click('#storeSheetList input[data-id="ah-1829"]');
      await page.click('#storeSheetDone');
      ok(/2 winkels/.test(await page.textContent('#storeBtn')), 'store sheet picks two stores');
      ok((await page.evaluate(() => window.LK.S.profile.stores)).join() === 'ah-1330,ah-1829', 'stores saved in profile');
      const tim = await page.evaluate(() => {
        const { recordObservations, buildTimingStats, timingAdvice, itemFromAH } = window.LK;
        let hist = {};
        const day0 = Date.now() - 25 * 86400000;
        for (let d = 0; d < 20; d++) {
          const base = new Date(day0 + d * 86400000); base.setHours(0, 0, 0, 0);
          const iso = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
          for (const hr of [8, 10, 12, 14, 16, 18, 20, 22]) {
            const t = base.getTime() + hr * 3600000, items = [];
            const sold = d % 10 < 7 && hr >= 17;
            if (hr >= 9 && !sold) { const pct = hr >= 20 ? 70 : hr >= 15 ? 40 : 25; items.push({ productId: 101, title: 'AH Kipdijfilet', unitSize: '400 g', pct, expDate: iso, stock: 3, priceWas: '4.99', priceNow: (4.99 * (1 - pct / 100)).toFixed(2) }); }
            items.push({ productId: 103, title: 'Campina Volle yoghurt', brand: 'Campina', unitSize: '1 l', pct: 35, expDate: iso, stock: 4, priceWas: '1.95', priceNow: '1.27' });
            hist = recordObservations(hist, { storeKey: 'ah-1829', items }, t);
          }
        }
        const stats = buildTimingStats(hist);
        const today = new Date(); const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const at = h => { const x = new Date(); x.setHours(h, 0, 0, 0); return x.getTime(); };
        const mk = (pct, now) => itemFromAH({ productId: 101, title: 'AH Kipdijfilet', unitSize: '400 g', pct, expDate: iso, stock: 3, priceWas: '4.99', priceNow: now, storeKey: 'ah-1829' });
        return { b25: stats.keys['sp:ah-1829|101'][25], b40: stats.keys['sp:ah-1829|101'][40], w: timingAdvice(mk(25, '3.74'), stats, at(10)), n: timingAdvice(mk(40, '2.99'), stats, at(16)), top: timingAdvice(mk(70, '1.50'), stats, at(20)), none: timingAdvice(mk(25, '3.74'), { keys: {} }, at(10)) };
      });
      ok(tim.b25.up === 20 && Math.round(tim.b25.h) === 15 && tim.b25.to === 40, '25% always went to 40% around 15:00: ' + JSON.stringify(tim.b25));
      ok(tim.b40.n === 20 && tim.b40.up === 6, '40% reached 70% on 6 of 20 days: ' + JSON.stringify(tim.b40));
      ok(tim.w.kind === 'wacht' && /15:00/.test(tim.w.text), 'advice at 25% in the morning: wait');
      ok(tim.n.kind === 'nu', 'advice at 40% in the afternoon: buy now');
      ok(tim.top.kind === 'nu', 'advice at 70%: buy now');
      ok(tim.none && tim.none.kind === 'info', 'no history: general hint only');
      const hr = await page.evaluate(() => {
        const { recordObservations, buildTimingStats, timingAdvice, itemFromAH } = window.LK;
        const T = (d, h, m = 0) => { const x = new Date(); x.setDate(x.getDate() - d); x.setHours(h, m, 0, 0); return x.getTime(); };
        const iso = d => { const x = new Date(); x.setDate(x.getDate() - d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
        const it = (pid, pct, e, extra) => Object.assign({ productId: pid, title: 'AH Kipdijfilet', unitSize: '400 g', pct, expDate: e, stock: 2, priceWas: '4.99', priceNow: (4.99 * (1 - pct / 100)).toFixed(2) }, extra || {});
        const out = {};
        // Long gap: seen at 40% at 10:00, next look at 18:00 it is gone -> unknown, not "sold out at 40%".
        let h1 = recordObservations({}, { storeKey: 's1', items: [it(1, 40, iso(1))] }, T(1, 10));
        h1 = recordObservations(h1, { storeKey: 's1', items: [it(2, 25, iso(1))] }, T(1, 18));
        out.gap = (buildTimingStats(h1).keys['sp:s1|1'] || {})[40] || null;
        // Overnight step: 25% at 20:00, 40% next morning -> counted as a step, but no time of day.
        let h2 = {};
        for (let d = 1; d <= 3; d++) { h2 = recordObservations(h2, { storeKey: 's1', items: [it(3, 25, iso(d - 1))] }, T(d, 20)); h2 = recordObservations(h2, { storeKey: 's1', items: [it(3, 40, iso(d - 1))] }, T(d - 1, 10)); }
        out.night = buildTimingStats(h2).keys['sp:s1|3'][25];
        // The same product listed twice in one answer counts once.
        const h3 = recordObservations({}, { storeKey: 's1', items: [it(4, 25, iso(0)), it(4, 40, iso(0))] }, T(0, 9));
        out.dup = Object.values(h3.offers).map(o => o.o.length + ':' + o.o[0][1]);
        // No expiry date: keyed without a date, so midnight does not split it.
        const h4 = recordObservations({}, { storeKey: 's1', items: [it(5, 40, null)] }, T(1, 23));
        out.noDate = Object.keys(h4.offers);
        // Fractional hour for the late check; small savings say so instead of "gok".
        const stats = { keys: { 'sp:s1|6': { 40: { n: 10, up: 10, h: 17.75, to: 70, dt: 2 } } } };
        const today = iso(0);
        const at = (h, m) => { const x = new Date(); x.setHours(h, m, 0, 0); return x.getTime(); };
        const kp = Object.assign(itemFromAH(it(6, 40, today, { storeKey: 's1' })), {});
        out.at1955 = timingAdvice(kp, stats, at(19, 55)).kind;
        const cheap = itemFromAH({ productId: 6, title: 'AH Kipdijfilet', unitSize: '400 g', pct: 40, expDate: today, stock: 2, priceWas: '0.89', priceNow: '0.53', storeKey: 's1' });
        out.cheap = timingAdvice(cheap, stats, at(12, 0));
        // General hint only for live AH items on a dynamic step, not for the fixed 35% sticker or typed items.
        const live25 = itemFromAH({ productId: 7, title: 'AH Kipdijfilet', pct: 25, expDate: today, priceWas: '4.99', priceNow: '3.74', storeKey: 's1' });
        const live35 = itemFromAH({ productId: 7, title: 'AH Kipdijfilet', pct: 35, expDate: today, priceWas: '4.99', priceNow: '3.24', storeKey: 's1' });
        out.hint25 = (timingAdvice(live25, { keys: {} }, at(10, 0)) || {}).kind || null;
        out.hint35 = timingAdvice(live35, { keys: {} }, at(10, 0));
        out.hintNoStats = timingAdvice(live25, null, at(10, 0));
        // Old price: no "the moment passed" claim.
        out.stale = timingAdvice(kp, stats, at(21, 0), at(11, 0));
        return out;
      });
      ok(hr.gap === null, 'long gap before disappearing is unknown, not sold out: ' + JSON.stringify(hr.gap));
      ok(hr.night && hr.night.up === 3 && hr.night.h === null, 'overnight step counted without a time of day: ' + JSON.stringify(hr.night));
      ok(hr.dup.length === 1 && hr.dup[0] === '1:40', 'duplicate listing recorded once at the deepest discount: ' + hr.dup);
      ok(hr.noDate.length === 1 && /\|$/.test(hr.noDate[0]), 'offer without expiry keyed without a date: ' + hr.noDate);
      ok(hr.at1955 === 'nu', 'at 19:55 the 17:45 moment counts as passed: ' + hr.at1955);
      ok(hr.cheap.kind === 'nu' && /scheelt maar/.test(hr.cheap.text), 'small saving: no contradictory gamble text: ' + hr.cheap.text);
      ok(hr.hint25 === 'info' && hr.hint35 === null && hr.hintNoStats === null, 'general hint only for live dynamic steps');
      ok(hr.stale && hr.stale.kind !== 'nu' || !/voorbij/.test((hr.stale || {}).text || ''), 'old price does not claim the moment passed: ' + JSON.stringify(hr.stale && hr.stale.text));
      const pp = await page.evaluate(() => {
        const { recordObservations, buildTimingStats, timingAdvice, itemFromAH, pruneHistory, mergeHistory } = window.LK;
        const T = (d, h, m = 0) => { const x = new Date(); x.setDate(x.getDate() - d); x.setHours(h, m, 0, 0); return x.getTime(); };
        const iso = d => { const x = new Date(); x.setDate(x.getDate() - d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
        const it = (pid, title, pct, e, was) => ({ productId: pid, title, unitSize: '1 l', pct, expDate: e, stock: 3, priceWas: was, priceNow: (was * (1 - pct / 100)).toFixed(2) });
        const out = {};
        // Two dairy products in one store: Yoghurt always reaches 70% around 19:00, Kwark is always gone at 40%.
        let hist = {};
        for (const d of [2, 1]) {
          hist = recordObservations(hist, { storeKey: 's1', items: [it(11, 'AH Volle yoghurt', 40, iso(d), 1.99), it(12, 'AH Magere kwark', 40, iso(d), 2.49)] }, T(d, 16));
          hist = recordObservations(hist, { storeKey: 's1', items: [it(11, 'AH Volle yoghurt', 70, iso(d), 1.99)] }, T(d, 18));
          hist = recordObservations(hist, { storeKey: 's1', items: [it(11, 'AH Volle yoghurt', 70, iso(d), 1.99)] }, T(d, 20));
        }
        let st = buildTimingStats(hist);
        const today = iso(0), at = h => { const x = new Date(); x.setHours(h, 0, 0, 0); return x.getTime(); };
        const live = (pid, title, was, sk) => itemFromAH(Object.assign(it(pid, title, 40, today, was), { storeKey: sk || 's1' }));
        out.yog = timingAdvice(live(11, 'AH Volle yoghurt', 1.99), st, at(12));
        out.kwark = timingAdvice(live(12, 'AH Magere kwark', 2.49), st, at(12));
        out.pKey = st.keys['p:11'] && st.keys['p:11'][40];
        // The same yoghurt in another store, never seen there: its record in your other stores counts.
        out.other = timingAdvice(live(11, 'AH Volle yoghurt', 1.99, 's2'), st, at(12));
        // Product summary: offers seen, deepest discount, lowest price, stores.
        hist = recordObservations(hist, { storeKey: 's2', items: [it(11, 'AH Volle yoghurt', 25, today, 1.99)] }, at(9));
        st = buildTimingStats(hist);
        out.sum = st.prod['11'];
        // Folding old offers keeps the per-product record; merging keeps it from disk.
        const old = recordObservations({}, { storeKey: 's1', items: [it(13, 'AH Karnemelk', 40, iso(10), 1.29)] }, T(10, 16));
        recordObservations(old, { storeKey: 's1', items: [it(13, 'AH Karnemelk', 70, iso(10), 1.29)] }, T(10, 18));
        recordObservations(old, { storeKey: 's1', items: [] }, T(10, 19));
        pruneHistory(old, Date.now());
        out.folded = { raw: Object.keys(old.offers).length, prod: old.prod['13'], p40: buildTimingStats(old).keys['p:13'] };
        out.merged = !!(mergeHistory(old, { v: 2, offers: {}, fetches: {}, agg: {} }).prod || {})['13'];
        // A history from before per-product keys: the per-store product counters are added up once.
        const legacy = { v: 2, offers: {}, fetches: {}, aggSeen: { 'sp:s1|14': Date.now(), 'sp:s2|14': Date.now() },
          agg: { 'sp:s1|14': { 40: { up: 2, gone: 1, lv: { 70: { n: 2, hh: {}, ds: 4, dn: 2 } } } }, 'sp:s2|14': { 40: { up: 1, gone: 0, lv: { 70: { n: 1, hh: {}, ds: 2, dn: 1 } } } } } };
        out.legacyStats = buildTimingStats(legacy).keys['p:14'];
        pruneHistory(legacy, Date.now());
        out.legacyPruned = legacy.agg['p:14'] && legacy.agg['p:14'][40];
        pruneHistory(legacy, Date.now());
        out.legacyTwice = legacy.agg['p:14'][40].up;
        return out;
      });
      ok(pp.yog.kind === 'wacht' && /^\d+% kans dat hij rond 17:00 naar 70% zakt/.test(pp.yog.text) && /Dit product in deze winkel: 2 van de 2 keer verder gezakt/.test(pp.yog.text), 'per product: yoghurt that always drops says wait, from its own record: ' + pp.yog.text);
      ok(pp.kwark.kind === 'nu' && /Dit product in deze winkel: 0 van de 2 keer verder gezakt, 2× eerst op/.test(pp.kwark.text), 'per product: kwark in the same store and category says buy now: ' + pp.kwark.text);
      ok(pp.pKey && pp.pKey.n === 2 && pp.pKey.up === 2 && pp.pKey.to === 70, 'product key across stores: ' + JSON.stringify(pp.pKey));
      ok(pp.other.kind === 'wacht' && /Dit product in je winkels: 2 van de 2/.test(pp.other.text), 'same product in a new store uses its record elsewhere: ' + pp.other.text);
      ok(pp.sum && /Volle yoghurt/.test(pp.sum.n) && pp.sum.k === 3 && pp.sum.ns === 2 && pp.sum.mx[70] === 2 && Math.abs(pp.sum.lo - 0.6) < 0.01, 'product summary: offers, stores, deepest discount, lowest price: ' + JSON.stringify(pp.sum));
      ok(pp.folded.raw === 0 && pp.folded.prod && pp.folded.prod.k === 1 && pp.folded.prod.mx[70] === 1 && pp.folded.p40 && pp.folded.p40[40] && pp.folded.p40[40].up === 1, 'old offers fold into the product record: ' + JSON.stringify(pp.folded));
      ok(pp.merged, 'merging keeps the folded product record');
      const fade = await page.evaluate(() => {
        const { timingAdvice, itemFromAH } = window.LK;
        const t = new Date(); const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
        const at = h => { const x = new Date(); x.setHours(h, 0, 0, 0); return x.getTime(); };
        const yog = itemFromAH({ productId: 21, title: 'AH Volle yoghurt', unitSize: '1 l', pct: 40, expDate: today, stock: 3, priceWas: '1.99', priceNow: '1.19', storeKey: 's1' });
        const one = { keys: { 'sp:s1|21': { 40: { n: 1, up: 0, h: null, to: null } }, 'p:21': { 40: { n: 1, up: 0 } }, 'sc:s1|zuivel': { 40: { n: 9, up: 7, h: 19, to: 70 } } } };
        const six = { keys: { 'sp:s1|21': { 40: { n: 6, up: 1, h: 19, to: 70 } }, 'p:21': { 40: { n: 6, up: 1 } }, 'sc:s1|zuivel': { 40: { n: 30, up: 28, h: 19, to: 70 } } } };
        return { one: timingAdvice(yog, one, at(12)), six: timingAdvice(yog, six, at(12)) };
      });
      ok(fade.one.kind === 'wacht' && /Zuivel \(andere producten\) in deze winkel: 88% zakte verder \(8×\)/.test(fade.one.text), 'one own case: the other dairy in this store weighs in, without this product: ' + fade.one.text);
      ok(fade.six.kind === 'nu' && /Kleine kans \(17%\)/.test(fade.six.text) && !/Zuivel/.test(fade.six.text), 'six own cases: only the product itself counts: ' + fade.six.text);
      ok(pp.legacyStats && pp.legacyStats[40].n === 4 && pp.legacyStats[40].up === 3, 'old history: product key built from per-store counters: ' + JSON.stringify(pp.legacyStats));
      ok(pp.legacyPruned && pp.legacyPruned.up === 3 && pp.legacyTwice === 3, 'migration runs once');
      const wf = await page.evaluate(() => {
        const { seedOilHit, filterHits, evaluate, itemFromFood, itemFromAH, defaultProfile } = window.LK;
        const F = id => FOOD.find(f => f.id === id);
        const lv = t => (seedOilHit(t) || {}).level || null;
        const P = defaultProfile();
        const off = Object.assign(defaultProfile(), { filters: [{ id: 'pufa', on: false }] });
        const sugar = Object.assign(defaultProfile(), { filters: [{ id: 'pufa', on: true }, { id: 'f1', label: 'Suiker', terms: ['suiker', 'glucosestroop'], on: true }] });
        const ah = ingr => itemFromAH({ productId: 9, title: 'AH Hummus naturel', pct: 35, expDate: '2026-11-20', priceWas: '1.49', priceNow: '0.97', ingredients: ingr });
        const reasons = ev => ev.reasons.map(r => r.s).join(' | ');
        return {
          terms: ['Tarwebloem, zonnebloemolie', 'plantaardige olie (raapzaad, zonnebloem)', 'plantaardige olie, suiker', 'olijfolie, palmolie, kokosolie', 'plantaardige vetten (palm, kokos)', 'plantaardige olie (olijf)', 'Soja-olie', 'Maïsolie', 'maïszetmeel', 'sesamzaad', 'koolzaadolie', 'roomboter'].map(lv),
          defaultOn: P.filters.some(f => f.id === 'pufa' && f.on),
          hummus: evaluate(itemFromFood(F('hummus')), P),
          chicken: evaluate(itemFromFood(F('kipfilet')), P).verdict,
          bread: evaluate(itemFromFood(F('volkoren_brood')), P),
          hummusOff: evaluate(itemFromFood(F('hummus')), off).verdict,
          olive: filterHits(ah({ s: 'kikkererwten, sesampasta, olijfolie, citroensap', c: 'sesam' }), P).length,
          sun: evaluate(ah({ s: 'kikkererwten, zonnebloemolie, citroensap', c: null }), P),
          sugarHit: evaluate(ah({ s: 'kikkererwten, olijfolie, suiker', c: null }), sugar),
          allergens: ah({ s: 'kikkererwten, kippenvlees, olijfolie', c: 'Bevat: melk, tarwe, ei' }).tags.sort().join(','),
          vegaChicken: evaluate(ah({ s: 'kikkererwten, kippenvlees, olijfolie', c: null }), Object.assign(defaultProfile(), { eat: 'vega' })).verdict,
        };
      });
      ok(JSON.stringify(wf.terms) === JSON.stringify(['zeker', 'zeker', 'waarschijnlijk', null, null, null, 'zeker', 'zeker', null, null, 'zeker', null]), 'seed oils on labels recognised, olive/palm/coconut/butter allowed: ' + JSON.stringify(wf.terms));
      ok(wf.defaultOn, 'seed-oil filter is on by default');
      ok(wf.hummus.verdict === 'nee' && /Wegfilter Zaadoliën/.test(JSON.stringify(wf.hummus.reasons)), 'hummus (usually seed oil): Past niet');
      ok(wf.chicken === 'ja', 'plain chicken not affected');
      ok(wf.bread.verdict === 'twijfel' && /ingrediënten onbekend/.test(JSON.stringify(wf.bread.reasons)), 'bread without label: twijfel, check the label');
      ok(wf.hummusOff !== 'nee', 'filter off: hummus judged normally again');
      ok(wf.olive === 0, 'AH label with olive oil overrides the product type');
      ok(wf.sun.verdict === 'nee' && /zonnebloemolie \(etiket\)/.test(JSON.stringify(wf.sun.reasons)), 'AH label with sunflower oil: Past niet, says it is from the label');
      ok(wf.sugarHit.verdict === 'nee' && /Suiker/.test(JSON.stringify(wf.sugarHit.reasons)), 'own filter (suiker) works on the label');
      ok(wf.allergens.includes('dairy') && wf.allergens.includes('gluten') && wf.allergens.includes('egg') && wf.allergens.includes('poultry') && !wf.allergens.includes('vegetarian'), 'allergens and meat read from the AH label, no longer vegetarian: ' + wf.allergens);
      ok(wf.vegaChicken === 'nee', 'vegetarian + chicken on the label: Past niet');
      // Wegfilter card in Dieet: preset on, add own filter, switch the preset off.
      await page.goto(FILE + '#dieet');
      await page.waitForFunction(() => window.LK.Store.loaded);
      ok(await page.isChecked('#wf-pufa'), 'Dieet shows the seed-oil filter switched on');
      await page.fill('#wfName', 'Suiker');
      await page.fill('#wfTerms', 'suiker, glucosestroop');
      await page.click('#wfAdd');
      await page.click('#wf-pufa');
      await page.click('#dietSubmit');
      const fl = await page.evaluate(() => window.LK.S.profile.filters);
      ok(fl.length === 2 && fl.find(f => f.id === 'pufa').on === false && fl.some(f => f.label === 'Suiker' && f.terms.join() === 'suiker,glucosestroop'), 'own filter saved, preset switched off: ' + JSON.stringify(fl));
      await page.click('#wf-pufa');
      await page.click('#dietSubmit');
      ok((await page.evaluate(() => window.LK.S.profile.filters.find(f => f.id === 'pufa').on)) === true, 'preset switched back on');
      await page.goto(FILE + '#winkel');
      await page.waitForFunction(() => window.LK.Store.loaded);
      const peat = await page.evaluate(() => {
        const { evaluate, itemFromFood, defaultProfile, nutritionFromAH } = window.LK;
        const F = id => FOOD.find(f => f.id === id);
        const P = Object.assign(defaultProfile(), { goal: 'peat', filters: [{ id: 'pufa', on: false }] });
        const sc = id => evaluate(itemFromFood(F(id), { expDate: null }), P);
        const all = FOOD.map(f => evaluate(itemFromFood(f, { expDate: null }), P).verdict);
        return {
          goal: !!GOALS.peat && GOALS.peat.rank === true,
          milk: sc('volle_melk').score, tofu: sc('tofu_naturel').score, cod: sc('kabeljauwfilet').score, salmon: sc('zalmfilet').score,
          beef: sc('biefstuk').score, chicken: sc('kipfilet').score, hummus: sc('hummus').score, oj: sc('jus_dorange').score, nuts: sc('kip_sate_salade').score,
          noExclusion: !all.includes('nee'),
          withFilter: evaluate(itemFromFood(F('hummus')), Object.assign(defaultProfile(), { goal: 'peat' })).verdict,
          labelPufa: nutritionFromAH([{ type: 'ENERGY', value: '250 kcal' }, { type: 'FAT', name: 'Vet', value: '20 g' }, { name: 'waarvan meervoudig onverzadigd', value: '11 g' }, { name: 'waarvan verzadigd', value: '2 g' }, { type: 'PROTEIN', value: '5 g' }]),
        };
      });
      ok(peat.goal, 'Ray Peat is a ranking diet');
      ok(peat.milk > peat.tofu && peat.cod > peat.salmon && peat.beef > peat.chicken && peat.oj > peat.hummus && peat.milk > peat.nuts, 'Peat order: milk>tofu, cod>salmon, beef>chicken, juice>hummus: ' + JSON.stringify(peat));
      ok(peat.noExclusion, 'Peat itself excludes nothing (no Past niet with the wegfilter off)');
      ok(peat.withFilter === 'nee', 'the wegfilter still hides seed-oil products when it is on');
      ok(peat.labelPufa && peat.labelPufa.pufa === 11 && peat.labelPufa.satfat === 2 && peat.labelPufa.fat === 20, 'PUFA read from the AH label: ' + JSON.stringify(peat.labelPufa));
      await page.goto(FILE + '#dieet');
      await page.waitForFunction(() => window.LK.Store.loaded);
      await page.click('#dGoal button[data-v="peat"]');
      await page.click('#dietSubmit');
      await page.goto(FILE + '#winkel');
      await page.waitForFunction(() => window.LK.Store.loaded);
      for (const q of ['tofu', 'volle melk']) { await page.fill('#q', q); await page.click('#suggest li:first-child button'); await page.click('#addForm button[type="submit"]'); }
      const cards = await page.$$eval('#candList .item', els => els.map(e => e.textContent));
      ok(/Volle melk/.test(cards[0]) && /#1/.test(cards[0]) && /Top/.test(cards[0]) && /#2/.test(cards[1]) && /Tofu/.test(cards[1]) && !/Past niet/.test(cards[1]), 'Peat list: ranked top to bottom with #1, #2 and Top/Matig/Laag');
      for (let i = 0; i < 2; i++) await page.click('#candList .item button:has-text("Weg")');
      // Full flow: set diet, add product via search, basket, finish, logboek.
      await page.goto(FILE + '#dieet');
      await page.fill('#dNotes', 'Ik lust geen champignons');
      await page.click('#dGoal button[data-v="cut"]');
      ok((await page.inputValue('#dNotes')) === 'Ik lust geen champignons', 'goal tap keeps typed note');
      await page.click('#dEat button[data-v="vega"]');
      await page.goto(FILE + '#winkel');
      ok((await page.evaluate(() => window.LK.S.profile.eat)) === 'alles', 'leaving Dieet without Opslaan keeps profile');
      await page.goto(FILE + '#dieet');
      await page.waitForFunction(() => window.LK.Store.loaded);
      await page.click('#dGoal button[data-v="cut"]');
      await page.fill('#dWeight', '80');
      await page.click('#calcProt');
      await page.click('#dietForm button[type="submit"]');
      ok((await page.inputValue('#dProt')) === '160', 'protein from weight (80 kg cut) = 160');
      await page.goto(FILE + '#winkel');
      await page.waitForFunction(() => window.LK.Store.loaded);
      ok(await page.isHidden('#dietBanner'), 'diet banner hidden after saving diet');
      await page.fill('#q', 'kipfilet 500g 6,49 35%');
      await page.click('#suggest li:first-child button');
      ok(await page.isVisible('#addForm'), 'add form opens');
      ok((await page.inputValue('#fPrice')) === '6,49', 'price prefilled from quick text');
      await page.click('#addForm button[type="submit"]');
      const cand = await page.textContent('#candList');
      ok(/Kipfilet/i.test(cand) && /Kopen/.test(cand), 'candidate shown with verdict Kopen');
      ok(/4,22/.test(cand), 'sticker price 35% of 6,49 = 4,22');
      await page.click('#candList .item button:has-text("In mandje")');
      const sum = await page.textContent('#summary');
      ok(/4,22/.test(sum) && /2,27/.test(sum), 'summary shows spent 4,22 and saved 2,27: ' + sum.replace(/\s+/g, ' '));
      await page.click('#basketList button[aria-label^="Eén"][aria-label$="meer"]');
      ok(/8,44/.test(await page.textContent('#summary')), 'qty 2 doubles spend');
      await page.click('#finishBtn');
      await page.click('#basketList button[aria-label^="Eén"][aria-label$="meer"]');
      ok(await page.isHidden('#finishConfirm'), 'finish banner closes when basket changes');
      await page.click('#basketList button[aria-label^="Eén"][aria-label$="minder"]');
      await page.click('#finishBtn');
      await page.evaluate(() => { const b = document.querySelector('#confirmFinishBtn'); b.click(); b.click(); });
      await page.waitForTimeout(100);
      ok(/leeg/.test(await page.textContent('#basketList')), 'basket emptied after finishing');
      await page.goto(FILE + '#logboek');
      await page.waitForFunction(() => window.LK.Store.loaded);
      const k = (await page.textContent('#tripKpis')).replace(/\s+/g, ' ');
      ok(/4,54/.test(k) && /Ritten ?1\b/.test(k), 'logboek: one trip, month saved = 4,54: ' + k);
      await page.goto(FILE + '#winkel');
      await page.waitForFunction(() => window.LK.Store.loaded);
      await page.click('text=Laat voorbeelden zien');
      ok((await page.$$('#candList .item')).length >= 4, 'examples render');
      await page.goto(FILE + '#koken');
      await page.waitForFunction(() => window.LK.Store.loaded);
      ok(/Kipfilet/.test(await page.textContent('#urgCard')), 'Koken shows bought items (pantry)');
      await page.goto(FILE + '#winkel');
      await page.waitForFunction(() => window.LK.Store.loaded);
      await page.click('#candList .item:has-text("Spinazie") button:has-text("In mandje")');
      await page.goto(FILE + '#koken');
      await page.waitForFunction(() => window.LK.Store.loaded);
      ok((await page.$$('#mealList .meal')).length >= 1, 'meal ideas from pantry + basket');
    }

    for (const tab of ['winkel', 'koken', 'logboek', 'dieet', 'info']) {
      await page.goto(FILE + '#' + tab);
      await page.waitForFunction(() => window.LK.Store.loaded);
      const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      ok(w.sw <= w.cw, `${tab}: no horizontal scroll (${w.sw} <= ${w.cw})`);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${scheme}-${tab}.png`), fullPage: true });
    }
    ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    await ctx.close();
  }
  await browser.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
