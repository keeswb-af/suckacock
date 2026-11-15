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
