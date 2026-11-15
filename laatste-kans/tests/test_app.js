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

      // Full flow: set diet, add product via search, basket, finish, logboek.
      await page.goto(FILE + '#dieet');
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
      await page.click('#basketList button[aria-label="Eén meer"]');
      ok(/8,44/.test(await page.textContent('#summary')), 'qty 2 doubles spend');
      await page.click('#finishBtn');
      await page.click('#finishConfirm button:has-text("Opslaan")');
      await page.waitForTimeout(100);
      ok(/leeg/.test(await page.textContent('#basketList')), 'basket emptied after finishing');
      await page.goto(FILE + '#logboek');
      await page.waitForFunction(() => window.LK.Store.loaded);
      ok(/4,54/.test(await page.textContent('#tripKpis')), 'logboek month saved = 4,54');
      await page.goto(FILE + '#winkel');
      await page.waitForFunction(() => window.LK.Store.loaded);
      await page.click('text=Laat voorbeelden zien');
      ok((await page.$$('#candList .item')).length >= 4, 'examples render');
      await page.goto(FILE + '#koken');
      ok((await page.$$('#mealList .meal')).length >= 1, 'meal ideas render from candidates');
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
