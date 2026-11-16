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

      // Day plan: menus hit the goal for every goal and weekday, diets are respected, stock and bargains work.
      const dp = await page.evaluate(() => {
        const { dayPlan, buyList, rollStock, planHave, compactPlan, projectAfter, defaultProfile, stapleById, itemFromFood } = window.LK;
        const prof = o => Object.assign(defaultProfile(), o);
        const week = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']; // Monday to Sunday
        const out = {};
        const goals = { balanced: [2000, 90], cut: [1800, 140], bulk: [2800, 160], lowcarb: [2000, 110], keto: [2000, 110], med: [2000, 90] };
        out.miss = [];
        for (const [g, [k, p]] of Object.entries(goals)) for (const d of week) {
          const t = dayPlan(prof({ goal: g, kcal: k, protein: p }), d, {}).totals;
          if (t.kcal < k * 0.95 || t.kcal > k * 1.05 || t.prot < p * 0.95) out.miss.push(`${g} ${d}: ${Math.round(t.kcal)} kcal ${Math.round(t.prot)} g`);
        }
        const tagsOf = p => p.lines.flatMap(l => l.id ? stapleById(l.id).tags : []);
        const anyTag = (P, bad) => week.some(d => tagsOf(dayPlan(prof(P), d, {})).some(t => bad.includes(t)));
        out.vegaMeat = anyTag({ eat: 'vega' }, ['meat', 'poultry', 'beef', 'pork', 'fish']);
        out.veganAnimal = anyTag({ eat: 'vegan' }, ['meat', 'poultry', 'beef', 'fish', 'dairy', 'lactose', 'egg']);
        out.pescoMeat = anyTag({ eat: 'pesco' }, ['meat', 'poultry', 'beef']);
        out.glutenFree = anyTag({ excl: { gluten: true } }, ['gluten']);
        out.lactoseFree = anyTag({ excl: { lactose: true } }, ['lactose']);
        out.maxCarbs = g => Math.max(...week.map(d => dayPlan(prof({ goal: g, kcal: 2000, protein: 110 }), d, {}).totals.carbs));
        out.lowcarbCarbs = out.maxCarbs('lowcarb'); out.ketoCarbs = out.maxCarbs('keto'); delete out.maxCarbs;
        out.vegaVariety = new Set(week.map(d => dayPlan(prof({ eat: 'vega' }), d, {}).meals.find(m => m.id === 'diner').lines[0].id)).size;
        out.thuFish = dayPlan(prof({}), week[3], {}).lines.some(l => l.id === 'koolvis');
        out.liverWeek = week.reduce((a, d) => a + dayPlan(prof({}), d, {}).lines.filter(l => l.id === 'kippenlever').reduce((x, l) => x + l.amount, 0), 0);
        out.liverNote = dayPlan(prof({}), week[5], {}).notes.some(n => /vitamine A/.test(n));
        out.skipLiver = dayPlan(prof({ skipStaples: ['kippenlever'] }), week[5], {}).lines.some(l => l.id === 'kippenlever');
        // Shopping list: everything on an empty shelf, nothing once bought, and the stock rolls to the next day.
        const P = prof({ kcal: 2400, protein: 140 });
        const plan = dayPlan(P, week[0], { shop: 'ah' });
        const b0 = buyList(plan, {}, 'ah');
        const full = {}; for (const l of b0.lines) full[l.id] = l.packs * l.offer.pack;
        out.buyEmpty = b0.lines.length; out.buyFull = buyList(plan, full, 'ah').lines.length;
        out.allAh = b0.lines.every(l => l.offer.chain === 'ah');
        out.jumboNames = buyList(dayPlan(P, week[0], { shop: 'jumbo' }), {}, 'jumbo').lines.filter(l => l.offer.chain === 'jumbo').length;
        const s = { stock: Object.assign({}, full), stockDay: week[0], dayLog: { [week[0]]: compactPlan(plan) }, basket: [], pantry: [] };
        rollStock(s, week[1], P);
        out.milk = [s.stock.melk, full.melk - plan.lines.filter(l => l.id === 'melk').reduce((a, l) => a + l.amount, 0)];
        out.stockDay = s.stockDay;
        // A missed day (no log) is eaten as the app would have planned it; a later visit the same day changes nothing.
        const s2 = { stock: { melk: 4000 }, stockDay: week[0], dayLog: {}, basket: [], pantry: [] };
        rollStock(s2, week[2], P);
        const milkOn = d => dayPlan(P, d, {}).lines.filter(l => l.id === 'melk').reduce((x, l) => x + l.amount, 0);
        out.twoDaysMilk = [s2.stock.melk, 4000 - milkOn(week[0]) - milkOn(week[1])];
        out.rollAgain = rollStock(s2, week[2], P);
        const two = dayPlan(prof({ kcal: 2400, protein: 140, persons: 2 }), week[0], {});
        out.twoPersonsMilk = [buyList(two, {}, 'ah').lines.find(l => l.id === 'melk').need, 2 * milkOn(week[0])];
        // Bargains: one you have takes the dinner slot and leaves the list; one in the shop is suggested only when cheaper.
        const kd = { id: 'kd1', name: 'Kipdijfilet', cat: 'gevogelte', foodId: null, tags: ['meat', 'poultry'], n: { kcal: 147, protein: 19, carbs: 0 }, grams: 400, qty: 1, priceNormal: 4.99, priceNow: 2.99, expDate: week[0], freezable: true, source: 'ah' };
        const ph = dayPlan(P, week[0], { have: planHave({ basket: [], pantry: [kd] }, P, week[0]) });
        out.haveUsed = ph.lines.some(l => l.item && l.item.id === 'kd1' && l.replaces === 'kipfilet');
        out.haveNotBought = !buyList(ph, {}, 'ah').lines.some(l => l.id === 'kipfilet');
        const proj = projectAfter({ stock: {}, basket: [], pantry: [kd] }, compactPlan(ph), []);
        out.kdUsed = proj.pantry[0].usedG;
        const veg = prof({ eat: 'vega' });
        out.vegaSkipsMeat = !dayPlan(veg, week[0], { have: planHave({ basket: [], pantry: [kd] }, veg, week[0]) }).lines.some(l => l.item);
        const F = id => FOOD.find(f => f.id === id);
        const cheap = itemFromFood(F('kipfilet'), { id: 'c1', discountPct: 50, expDate: null });
        const dear = itemFromFood(F('kipfilet'), { id: 'c2', discountPct: 0, priceNormal: 12.99, expDate: null });
        out.swapCheap = dayPlan(P, week[0], { cands: [cheap] }).swaps.map(x => x.it.id);
        out.swapDear = dayPlan(P, week[0], { cands: [dear] }).swaps.length;
        out.swapExample = dayPlan(P, week[0], { cands: [Object.assign({}, cheap, { example: true })] }).swaps.length;
        return out;
      });
      ok(!dp.miss.length, 'day plans within 5% of kcal and protein for every goal and weekday' + (dp.miss.length ? ': ' + dp.miss.join('; ') : ''));
      ok(!dp.vegaMeat && !dp.veganAnimal && !dp.pescoMeat, 'vega, vegan and pesco menus skip what they do not eat');
      ok(!dp.glutenFree && !dp.lactoseFree, 'gluten-free and lactose-free menus skip gluten and lactose');
      ok(dp.lowcarbCarbs <= 100 && dp.ketoCarbs <= 30, `low-carb ${Math.round(dp.lowcarbCarbs)} g and keto ${Math.round(dp.ketoCarbs)} g carbs at most`);
      ok(dp.vegaVariety >= 2, 'vegetarian dinners vary over the week: ' + dp.vegaVariety);
      ok(dp.thuFish && dp.liverWeek === 100 && dp.liverNote, 'fish on Thursday, 100 g liver a week with the vitamin A note');
      ok(!dp.skipLiver, 'a skipped staple stays out of the menu');
      ok(dp.buyEmpty >= 10 && dp.buyFull === 0 && dp.allAh, `empty shelf: ${dp.buyEmpty} things to buy at AH; none once bought`);
      ok(dp.jumboNames >= 10, 'Jumbo prices when Jumbo is picked');
      ok(dp.milk[0] === dp.milk[1] && dp.stockDay === '2026-11-17', `stock rolls a day: milk ${dp.milk[0]} ml left`);
      ok(dp.twoDaysMilk[0] === dp.twoDaysMilk[1] && dp.twoDaysMilk[0] < 4000 && !dp.rollAgain, 'two missed days are eaten as planned, once: ' + dp.twoDaysMilk.join(' = '));
      ok(dp.twoPersonsMilk[0] === dp.twoPersonsMilk[1] && dp.twoPersonsMilk[0] > 0, 'two persons need twice the milk: ' + dp.twoPersonsMilk.join(' = '));
      ok(dp.haveUsed && dp.haveNotBought && dp.kdUsed > 0, `a bargain at home takes the dinner slot (${dp.kdUsed} g used), no chicken to buy`);
      ok(dp.vegaSkipsMeat, 'a vegetarian plan does not use meat from the pantry');
      ok(dp.swapCheap.join() === 'c1' && dp.swapDear === 0 && dp.swapExample === 0, 'cheaper bargain suggested; dearer one and examples not');

      const ms = await page.evaluate(() => ({
        old: window.LK.profileStores({ store: 'ah-1330', stores: [] }),
        both: window.LK.profileStores({ stores: ['ah-1330', 'ah-1829', 'nope'] }),
        cap: window.LK.profileStores({ stores: STORES.map(s => s.id) }).length,
      }));
      ok(ms.old.join() === 'ah-1330', 'old single-store profile migrates: ' + ms.old);
      ok(ms.both.join() === 'ah-1330,ah-1829', 'unknown store ids dropped');
      ok(ms.cap === 23, 'all 23 stores can be followed: ' + ms.cap);
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

      // Vandaag halen: today's shopping list, using what you bought.
      await page.goto(FILE + '#winkel');
      await page.waitForFunction(() => window.LK.Store.loaded);
      const ids = () => page.$$eval('#todayBuy .buy-row', els => els.map(e => e.dataset.id));
      ok(await page.isVisible('#todayCard') && /Vandaag halen/.test(await page.textContent('#todayCard')), 'Vandaag halen card shows');
      const rows = await ids();
      ok(rows.length >= 5 && !rows.includes('kipfilet'), 'list leaves out chicken: the kipfilet you bought is dinner: ' + rows.join(','));
      ok(/Kipfilet/.test(await page.textContent('#todayMenu')), 'menu uses the kipfilet from the pantry');
      const first = rows[0];
      await page.click(`#todayBuy .buy-row[data-id="${first}"] button:has-text("Gekocht")`);
      ok(!(await ids()).includes(first) && (await page.evaluate(id => window.LK.S.session.stock[id], first)) > 0, `Gekocht takes ${first} off the list and into the stock`);
      const second = (await ids())[0];
      await page.click(`#todayBuy .buy-row[data-id="${second}"] button:has-text("Heb ik")`);
      ok(!(await ids()).includes(second), `Heb ik takes ${second} off the list`);
      await page.click('#todayShop button[data-v="jumbo"]');
      ok((await page.evaluate(() => window.LK.S.profile.baseShop)) === 'jumbo' && /Jumbo/.test(await page.textContent('#todayBuy')), 'switching to Jumbo shows Jumbo products');
      await page.reload();
      await page.waitForFunction(() => window.LK.Store.loaded);
      const after = await ids();
      ok(!after.includes(first) && !after.includes(second) && /Jumbo/.test(await page.textContent('#todayBuy')), 'stock and shop survive a reload');
      await page.evaluate(() => { document.querySelector('#todayMenu').open = true; });
      const chip = await page.$('#todayMenu .menu-item button');
      const chipLabel = await chip.getAttribute('aria-label');
      await chip.click();
      ok((await page.evaluate(() => window.LK.S.profile.skipStaples.length)) === 1 && await page.isVisible('#todayMenu .menu-skip'), 'a staple can leave the menu: ' + chipLabel);
      ok(await page.evaluate(() => document.querySelector('#todayMenu').open), 'the menu stays open after a change');
      await page.goto(FILE + '#dieet');
      await page.waitForFunction(() => window.LK.Store.loaded);
      await page.click('#dietForm button[type="submit"]');
      const kept = await page.evaluate(() => [window.LK.S.profile.baseShop, window.LK.S.profile.skipStaples.length]);
      ok(kept[0] === 'jumbo' && kept[1] === 1, 'saving the diet keeps the shop and the skipped staple');
      await page.goto(FILE + '#winkel');
      await page.waitForFunction(() => window.LK.Store.loaded);
      await page.evaluate(() => { document.querySelector('#todayMenu').open = true; });
      await page.click('#todayMenu .menu-skip button');
      ok((await page.evaluate(() => window.LK.S.profile.skipStaples.length)) === 0, 'and comes back');
      const kw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      ok(kw[0] <= kw[1], 'today card fits the phone width');
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
