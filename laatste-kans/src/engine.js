'use strict';
/* ============================================================
   Basics
   ============================================================ */
const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const fmtEur = v => (v == null || !isFinite(v)) ? '-' : EUR.format(v);
const fmtNum = (v, d = 0) => (v == null || !isFinite(v)) ? '-' : new Intl.NumberFormat('nl-NL', { maximumFractionDigits: d, minimumFractionDigits: d }).format(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round2 = v => Math.round(v * 100) / 100;
const clone = o => JSON.parse(JSON.stringify(o));
function parseNum(s) {
  if (s == null) return null;
  if (typeof s === 'number') return isFinite(s) ? s : null;
  let t = String(s).replace(/[^\d,.\-]/g, '');
  if (!t) return null;
  if (t.includes(',') && t.includes('.')) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(',', '.');
  const v = parseFloat(t);
  return isFinite(v) ? v : null;
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function isoOf(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function todayISO() { return isoOf(new Date()); }
function addDays(iso, n) { const [y, m, d] = iso.split('-').map(Number); const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + n); return isoOf(dt); }
function lerp(x, pts) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
  }
  return pts[pts.length - 1][1];
}
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9% ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

/* ============================================================
   Diet model
   ============================================================ */
const GOALS = {
  balanced: { label: 'Gezond basis', desc: 'Schijf van Vijf: veel groente en fruit, volkoren, genoeg eiwit, weinig bewerkt vlees, suiker en zout.', kcal: 2000, protein: 90, pf: 0.4, carbsMax: null },
  cut: { label: 'Afvallen, eiwitrijk', desc: 'Veel eiwit per kcal zodat je vol zit en spiermassa houdt. Calorierijke producten met weinig eiwit vallen af.', kcal: 1800, protein: 140, pf: 0.9, carbsMax: null },
  bulk: { label: 'Spieropbouw', desc: 'Veel eiwit en genoeg energie per euro. Brood, rijst en zuivel tellen mee als goedkope energie.', kcal: 2800, protein: 160, pf: 0.7, carbsMax: null },
  lowcarb: { label: 'Koolhydraatarm', desc: 'Rond de 100 g koolhydraten per dag of minder: brood, pasta en zoet worden kritisch bekeken.', kcal: 2000, protein: 110, pf: 0.6, carbsMax: 100 },
  keto: { label: 'Keto', desc: 'Onder de 30 g koolhydraten per dag. Vooral vlees, vis, eieren, kaas en groente boven de grond.', kcal: 2000, protein: 110, pf: 0.5, carbsMax: 30 },
  med: { label: 'Mediterraan', desc: 'Vis, groente, peulvruchten, volkoren en noten; weinig rood en bewerkt vlees.', kcal: 2000, protein: 90, pf: 0.4, carbsMax: null },
};
const EATS = { alles: { label: 'Alles' }, flexi: { label: 'Weinig vlees' }, pesco: { label: 'Pescotarisch' }, vega: { label: 'Vegetarisch' }, vegan: { label: 'Veganistisch' } };
const EXCL = [
  ['pork', 'Geen varkensvlees'], ['beef', 'Geen rundvlees'], ['fish', 'Geen vis'], ['shellfish', 'Geen schaaldieren'],
  ['lactose', 'Lactosevrij'], ['dairy', 'Geen zuivel'], ['gluten', 'Glutenvrij'], ['egg', 'Geen ei'],
  ['nuts', 'Notenallergie'], ['soy', 'Geen soja'], ['halal', 'Halal'],
];
const TAG_NL = { meat: 'vlees', poultry: 'gevogelte', pork: 'varkensvlees', beef: 'rundvlees', fish: 'vis', shellfish: 'schaaldieren', dairy: 'zuivel', egg: 'ei', gluten: 'gluten', lactose: 'lactose', nuts: 'noten', soy: 'soja' };
const ALLOWED_TAGS = ['meat', 'poultry', 'pork', 'beef', 'fish', 'shellfish', 'dairy', 'egg', 'gluten', 'lactose', 'nuts', 'soy', 'vegetarian', 'vegan', 'halal_possible', 'processed', 'ultraprocessed', 'wholegrain', 'high_sugar', 'fresh_produce', 'ready_meal', 'bakery'];
const CATS = { vlees: 'Vlees', gevogelte: 'Gevogelte', vis: 'Vis', vega: 'Vega', zuivel: 'Zuivel', kaas: 'Kaas', ei: 'Eieren', beleg: 'Beleg', brood: 'Brood', groente: 'Groente', fruit: 'Fruit', maaltijd: 'Maaltijd', salade: 'Salade', zetmeel: 'Pasta en co', overig: 'Overig' };

function defaultProfile() {
  return { goal: 'balanced', eat: 'alles', kcal: 2000, protein: 90, carbsMax: null, excl: {}, avoidUltra: false, freezer: true, persons: 1, budget: 40, notes: '', weight: null, store: null, setAt: null, savedAt: 0 };
}
function exclusionsFor(P) {
  const ex = new Set();
  if (P.eat === 'vega' || P.eat === 'vegan') ['meat', 'poultry', 'pork', 'beef', 'fish', 'shellfish'].forEach(t => ex.add(t));
  if (P.eat === 'vegan') ['dairy', 'egg', 'lactose'].forEach(t => ex.add(t));
  if (P.eat === 'pesco') ['meat', 'poultry', 'pork', 'beef'].forEach(t => ex.add(t));
  const e = P.excl || {};
  if (e.pork || e.halal) ex.add('pork');
  if (e.beef) ex.add('beef');
  if (e.fish) { ex.add('fish'); ex.add('shellfish'); }
  if (e.shellfish) ex.add('shellfish');
  if (e.dairy) { ex.add('dairy'); ex.add('lactose'); }
  if (e.lactose) ex.add('lactose');
  for (const k of ['gluten', 'egg', 'nuts', 'soy']) if (e[k]) ex.add(k);
  return ex;
}
const ANIMAL = ['meat', 'poultry', 'pork', 'beef', 'fish', 'shellfish', 'dairy', 'egg', 'lactose'];

/* Tags guessed from a product name, for products that are not in the table.
   Deliberately broad: a wrong "contains" makes the app cautious, a missed one could make it wrong. */
const NAME_TAG_RULES = [
  [/varken|spek|\bham\b|beenham|achterham|ontbijtspek|bacon|salami|chorizo|karbonade|frikandel|knakworst|rookworst|braadworst|slavink|gyros|cervelaat|leverworst|pancetta|prosciutto|serrano|half om half|halfomhalf|\bworst/, ['meat', 'pork']],
  [/rund|biefstuk|rosbief|entrecote|tartaar|hamburger|rookvlees|ossenworst|riblap|sukade|stooflap|gehakt|kalfs/, ['meat', 'beef']],
  [/\bkip|kippen|kalkoen|\beend|chicken|drumstick|\bkuiken/, ['meat', 'poultry']],
  [/vlees|\blam\b|lams|geit|\bwild\b|hert|konijn|shoarma|doner|kebab|vleeswaren|carpaccio/, ['meat']],
  [/\bvis|zalm|tonijn|kabeljauw|pangasius|makreel|haring|tilapia|koolvis|sushi|forel|\bheek|\bschol|ansjovis|sardine|surimi|lekkerbek|kibbeling|visstick|poke/, ['fish']],
  [/garnaal|garnalen|mossel|krab|kreeft|scampi|inktvis|calamar|oester/, ['fish', 'shellfish']],
  [/melk|kaas|kwark|yoghurt|\broom|room\b|slagroom|boter|skyr|kefir|\bvla\b|pudding|mozzarella|feta|brie|camembert|ricotta|mascarpone|cottage|huttenkase|zuivel|\bijs\b|creme fraiche|zure room/, ['dairy', 'lactose']],
  [/\bei\b|eieren|\beier|omelet|mayonaise|\bmayo|scharrelei/, ['egg']],
  [/brood|tarwe|pasta|spaghetti|macaroni|lasagne|\bwrap|pita|tortilla|croissant|bagel|cracker|koek|cake|taart|muffin|pizza|noedel|\bmie\b|couscous|bulgur|spelt|rogge|gerst|paneer|schnitzel|\bbol\b|bollen|krentenbol|tosti|sandwich|broodje|gnocchi|tortellini|ravioli|seitan|quiche|bladerdeeg|pannenkoek|wafel/, ['gluten']],
  [/\bnoot|noten|pinda|amandel|hazelno|walno|cashew|pistache|pecan|macadamia|pesto|sate\b|satay/, ['nuts']],
  [/soja|tofu|tempeh|edamame|miso|ketjap/, ['soy']],
];
function inferTags(name) {
  let n = norm(name);
  const tags = new Set();
  const plantMilk = /(soja|haver|amandel|kokos|rijst|erwten)\s?(melk|drink|yoghurt|room|kwark)/;
  const vegMark = /\bvega\b|vegetarisch|plantaardig|vegan|veggie|\bterra\b/;
  const veganMark = /vegan|plantaardig/;
  n = n.replace(/pindakaas/g, 'pinda').replace(plantMilk, (_, base) => ` ${base} plantdrink `);
  for (const [re, ts] of NAME_TAG_RULES) if (re.test(n)) ts.forEach(t => tags.add(t));
  if (vegMark.test(n)) { ['meat', 'pork', 'beef', 'poultry', 'fish', 'shellfish'].forEach(t => tags.delete(t)); tags.add('vegetarian'); }
  if (veganMark.test(n)) { ['dairy', 'lactose', 'egg'].forEach(t => tags.delete(t)); tags.add('vegan'); }
  return [...tags];
}

/* ============================================================
   Food lookup and quick parsing
   ============================================================ */
const STOP = new Set(['ah', 'albert', 'heijn', 'excellent', 'terra', 'basic', 'biologisch', 'bio', 'de', 'het', 'een', 'van', 'met', 'g', 'gr', 'gram', 'kg', 'stuks', 'st', 'ml', 'l', 'vers', 'verse', 'korting', 'per', 'stuk']);
function tokens(s) { return norm(s).split(' ').filter(t => t && !STOP.has(t) && !/^\d/.test(t)); }
const FOOD_INDEX = (typeof FOOD !== 'undefined' ? FOOD : []).map(f => {
  const names = [f.name, ...(f.aliases || [])];
  return { f, names: names.map(norm), toks: [...new Set(names.flatMap(tokens))] };
});
function matchFood(q, limit = 6) {
  const nq = tokens(q);
  if (!nq.length) return [];
  const joined = nq.join(' ');
  const out = [];
  for (const ix of FOOD_INDEX) {
    let s = 0;
    for (const n of ix.names) {
      const nt = n.split(' ').filter(t => !STOP.has(t)).join(' ');
      if (nt === joined) s = Math.max(s, 100);
      else if (nt.startsWith(joined)) s = Math.max(s, 85);
      else if (nt.includes(joined)) s = Math.max(s, 70);
    }
    if (s < 70) {
      let hit = 0;
      for (const t of nq) {
        if (ix.toks.some(x => x === t)) hit += 1;
        else if (ix.toks.some(x => x.startsWith(t) || (t.length >= 5 && x.includes(t)) || (x.length >= 5 && t.includes(x)))) hit += 0.7;
      }
      if (hit > 0) s = Math.max(s, Math.round(60 * hit / nq.length) - Math.max(0, ix.toks.length - nq.length));
    }
    if (s >= 25) out.push({ f: ix.f, s });
  }
  out.sort((a, b) => b.s - a.s || a.f.name.length - b.f.name.length);
  return out.slice(0, limit);
}
function parseQuick(text) {
  let s = ' ' + String(text || '') + ' ';
  const r = { name: '', grams: null, price: null, now: null, pct: null };
  // Discount: prefer "NN% korting", else the last non-zero percentage. "0%" in a name (magere kwark 0%) is not a discount.
  const pcts = [...s.matchAll(/-?(\d{1,2})\s*%(\s*korting)?/gi)].map(m => ({ m, v: parseInt(m[1], 10), k: !!m[2] })).filter(x => x.v > 0);
  const pick = pcts.find(x => x.k) || pcts[pcts.length - 1];
  if (pick) { r.pct = pick.v; s = s.replace(pick.m[0], ' '); }
  const w = s.match(/(\d+(?:[.,]\d+)?)\s*(kg|kilo|g|gr|gram|ml|l|liter|cl)\b/i);
  if (w) {
    let v = parseNum(w[1]); const u = w[2].toLowerCase();
    if (u === 'kg' || u === 'kilo' || u === 'l' || u === 'liter') v *= 1000; else if (u === 'cl') v *= 10;
    r.grams = Math.round(v); s = s.replace(w[0], ' ');
  }
  const prices = [...s.matchAll(/€\s?(\d{1,3}(?:[.,]\d{1,2})?)|(?<![\d.,])(\d{1,3}[.,]\d{1,2})(?![\d%])/g)];
  if (prices.length) {
    const vals = prices.map(m => parseNum(m[1] || m[2])).filter(v => v != null);
    if (vals.length >= 2) { r.price = Math.max(vals[0], vals[1]); r.now = Math.min(vals[0], vals[1]); }
    else if (vals.length) r.price = vals[0];
    for (const m of prices) s = s.replace(m[0], ' ');
  }
  r.name = s.replace(/€/g, ' ').replace(/\s+/g, ' ').trim();
  return r;
}

/* ============================================================
   Item helpers (expiry is stored as a date, the label is derived)
   ============================================================ */
function expState(it) {
  const d = it.expDate;
  if (!d) return 'later';
  const t = todayISO();
  if (d < t) return 'verlopen';
  if (d === t) return 'vandaag';
  if (d === addDays(t, 1)) return 'morgen';
  return 'later';
}
function expDateFor(choice) { const t = todayISO(); return choice === 'vandaag' ? t : choice === 'morgen' ? addDays(t, 1) : null; }
function migrateItem(it) {
  if (!it || typeof it !== 'object') return null;
  if (!('expDate' in it)) {
    const base = it.addedAt ? isoOf(new Date(it.addedAt)) : todayISO();
    it.expDate = it.expiry === 'vandaag' ? base : it.expiry === 'morgen' ? addDays(base, 1) : null;
  }
  delete it.expiry;
  if (!Array.isArray(it.tags)) it.tags = [];
  return it;
}
function itemPriceNow(it) {
  if (it.priceNow != null && isFinite(it.priceNow)) return it.priceNow;
  if (it.priceNormal != null && it.discountPct != null) return round2(it.priceNormal * (1 - it.discountPct / 100));
  return it.priceNormal ?? null;
}

/* ============================================================
   Scoring engine (pure)
   ============================================================ */
function evaluate(it, P) {
  const G = GOALS[P.goal] || GOALS.balanced;
  const pf = G.pf;
  const goal = P.goal;
  const n = it.n || null;
  const num = k => (n && n[k] != null && n[k] !== '' && isFinite(+n[k])) ? +n[k] : null;
  const g = it.grams > 0 ? it.grams : 0;
  const price = itemPriceNow(it);
  const tags = new Set(it.tags || []);
  const ex = exclusionsFor(P);
  const hits = [...ex].filter(t => tags.has(t));
  const R = [], pins = [];
  const add = (w, s) => R.push({ w, s });
  let capTwijfel = false;

  const kcal = num('kcal'), prot = num('protein'), carbs = num('carbs');
  const fiber = num('fiber'), sugar = num('sugar'), satfat = num('satfat'), salt = num('salt');
  const known = (kcal != null && kcal > 0) || (prot != null && prot > 0);
  const protPack = (prot ?? 0) * g / 100, kcalPack = (kcal ?? 0) * g / 100;
  const carbPack = carbs != null ? carbs * g / 100 : null;
  const hasNormal = it.priceNormal > 0 && price != null;
  const m = {
    protPack, kcalPack, carbPack, price,
    eurPerProt: (price > 0 && prot != null && prot >= 5 && protPack >= 5) ? price / protPack * 100 : null,
    kcalPerEur: (price > 0 && kcalPack > 0) ? kcalPack / price : null,
    perKg: (price > 0 && g > 0) ? price / g * 1000 : null,
    protPer100kcal: (kcal > 0 && prot != null) ? prot / kcal * 100 : null,
    discount: hasNormal ? clamp(1 - price / it.priceNormal, 0, 1) : (price != null && it.discountPct > 0 ? clamp(it.discountPct / 100, 0, 1) : 0),
  };
  const dens = m.protPer100kcal;
  const fresh = tags.has('fresh_produce');

  /* --- diet fit --- */
  let fit = 60;
  if (!known) {
    fit = 50;
    add(-1, 'Voedingswaarde onbekend: vul die in of laat Claude schatten');
  } else {
    if (prot != null && prot >= 8 && dens != null) {
      const b = dens >= 15 ? 25 : dens >= 10 ? 15 : dens >= 6 ? 5 : 0;
      fit += pf * b;
      if (b >= 15 && pf >= 0.5) add(pf * b, `Veel eiwit per kcal (${fmtNum(prot, 0)} g per 100 g)`);
      else if (b >= 5 && pf >= 0.5) add(pf * b, `Redelijk eiwitrijk (${fmtNum(prot, 0)} g per 100 g)`);
    }
    if (!fresh && kcal != null && kcal >= 200 && dens != null && dens < 6 && pf >= 0.5) { fit -= 10 * pf; add(-10 * pf, 'Veel kcal, weinig eiwit'); }
    if (goal === 'cut') {
      if (kcal != null && prot != null && kcal <= 150 && prot >= 10) { fit += 8; add(8, 'Weinig kcal, veel eiwit'); }
      if (kcal != null && kcal >= 350 && (dens == null || dens < 10)) { fit -= 12; add(-12, `Calorierijk (${fmtNum(kcal)} kcal per 100 g)`); }
      if (fresh) fit += 6;
    } else if (goal === 'bulk') {
      if (kcal != null && prot != null && kcal >= 200 && prot >= 10) { fit += 10; add(10, 'Eiwit plus energie'); }
      if (m.kcalPerEur != null && m.kcalPerEur >= 600) fit += 5;
    } else if (goal === 'lowcarb') {
      if (carbs == null) { add(-5, 'Koolhydraten onbekend: check het etiket'); capTwijfel = true; }
      else if (carbs <= 10) { fit += 10; add(10, `Weinig koolhydraten (${fmtNum(carbs, 0)} g per 100 g)`); }
      else if (carbs > 30) { fit -= 20; add(-20, `Veel koolhydraten (${fmtNum(carbs, 0)} g per 100 g)`); capTwijfel = true; }
      else if (carbs > 15) { fit -= 8; add(-8, `Vrij veel koolhydraten (${fmtNum(carbs, 0)} g per 100 g)`); }
    } else if (goal === 'keto') {
      if (carbs == null) { add(-5, 'Koolhydraten onbekend: check het etiket'); capTwijfel = true; }
      else if (carbs <= 5) { fit += 18; add(18, `Past in keto (${fmtNum(carbs, 1)} g koolh. per 100 g)`); }
      else if (carbs <= 10) { fit += 2; }
      else if (carbs <= 15) { fit -= 12; add(-12, `Lastig voor keto (${fmtNum(carbs, 0)} g koolh. per 100 g)`); capTwijfel = true; }
      else { fit -= 35; add(-35, `Te veel koolhydraten voor keto (${fmtNum(carbs, 0)} g per 100 g)`); }
    } else if (goal === 'med') {
      if (tags.has('fish') || tags.has('shellfish')) { fit += 10; add(10, 'Vis past goed in mediterraan'); }
      if (fresh) { fit += 8; add(8, 'Verse groente of fruit'); }
      if (tags.has('wholegrain')) { fit += 6; add(6, 'Volkoren'); }
      if (tags.has('beef') || tags.has('pork')) { fit -= 6; add(-6, 'Rood vlees: liever af en toe'); }
      if (tags.has('processed') && (tags.has('meat') || tags.has('pork') || tags.has('beef'))) { fit -= 8; add(-8, 'Bewerkt vlees'); }
    } else {
      if (fresh) { fit += 12; add(12, 'Verse groente of fruit'); }
      if (tags.has('fish')) { fit += 6; add(6, 'Vis: Schijf van Vijf raadt 1x per week aan'); }
      if (tags.has('wholegrain')) { fit += 6; add(6, 'Volkoren'); }
      if (tags.has('processed') && (tags.has('meat') || tags.has('pork') || tags.has('beef'))) { fit -= 6; add(-6, 'Bewerkt vlees: Schijf van Vijf raadt dit af'); }
    }
    // A daily carb limit (from the goal or set by the user) against the carbs in this pack.
    const lim = P.carbsMax != null ? P.carbsMax : G.carbsMax;
    if (lim != null && lim > 0 && carbPack != null) {
      const share = carbPack / (lim * Math.max(1, P.persons || 1));
      if (share > 1) { fit -= 15; add(-15, `${fmtNum(carbPack)} g koolh. in dit pak, meer dan je dagmax van ${fmtNum(lim)} g`); if (goal === 'keto' || goal === 'lowcarb') capTwijfel = true; }
      else if (share > 0.5) { fit -= 6; add(-6, `${fmtNum(carbPack)} g koolh. in dit pak, ruim de helft van je dagmax`); }
    }
    if (fiber != null && fiber >= 6) { fit += 6; add(6, `Vezelrijk (${fmtNum(fiber, 0)} g per 100 g)`); }
    else if (fiber != null && fiber >= 3) fit += 3;
    if (tags.has('high_sugar') && !fresh) {
      const p = goal === 'keto' || goal === 'lowcarb' ? 18 : goal === 'cut' ? 10 : 6;
      fit -= p; add(-p, 'Veel (toegevoegde) suiker');
    } else if (!fresh && sugar != null && sugar > 30) { fit -= 14; add(-14, `Veel suiker (${fmtNum(sugar, 0)} g per 100 g)`); }
    else if (!fresh && sugar != null && sugar > 15) { fit -= 8; add(-8, `Vrij veel suiker (${fmtNum(sugar, 0)} g per 100 g)`); }
    if (satfat != null && satfat > 8) { const p = goal === 'bulk' || goal === 'keto' ? 3 : 6; fit -= p; add(-p, `Veel verzadigd vet (${fmtNum(satfat, 0)} g per 100 g)`); }
    if (salt != null && salt > 2.5) { fit -= 9; add(-9, `Erg zout (${fmtNum(salt, 1)} g per 100 g)`); }
    else if (salt != null && salt > 1.5) { fit -= 5; add(-5, `Vrij zout (${fmtNum(salt, 1)} g per 100 g)`); }
  }
  if (tags.has('ultraprocessed')) { const p = P.avoidUltra ? 15 : 4; fit -= p; if (P.avoidUltra) add(-p, 'Ultrabewerkt'); }
  else if (tags.has('processed') && P.avoidUltra) fit -= 5;
  if (P.eat === 'vegan' && !tags.has('vegan') && !ANIMAL.some(t => tags.has(t)) && !fresh) { fit -= 10; pins.push('Check het etiket op dierlijke ingrediënten'); capTwijfel = true; }
  if (P.eat === 'flexi' && (tags.has('meat') || tags.has('beef') || tags.has('pork'))) fit -= 5;
  // Halal: regular AH meat is not halal certified, so meat can at most be "twijfel" and the warning always shows.
  if (P.excl && P.excl.halal && !hits.length && (tags.has('meat') || tags.has('poultry') || tags.has('beef'))) { pins.push('Alleen kopen met halal-keurmerk'); capTwijfel = true; }
  // Products not in the table (typed in, or live from AH): the app only knows what the name says,
  // so never give "Kopen" to someone who avoids things.
  if (!it.foodId && (it.source === 'manual' || it.source === 'ah') && ex.size && !hits.length) { pins.push('Check het etiket op wat je niet eet'); capTwijfel = true; }
  fit = clamp(fit, 0, 100);

  /* --- value for money --- */
  // Cheap protein only counts when the product is a real protein source (bread is cheap per gram of protein but mostly starch).
  const protPts = m.eurPerProt != null ? lerp(m.eurPerProt, [[0.8, 60], [1.5, 54], [2.5, 44], [4, 30], [6, 15], [10, 0]]) * clamp((dens ?? 0) / 10, 0, 1) : 0;
  const kcalPts = m.kcalPerEur != null ? lerp(m.kcalPerEur, [[50, 0], [100, 6], [250, 20], [500, 36], [900, 50], [1500, 60]]) : 0;
  const wp = goal === 'cut' ? 0.9 : 0.6;
  let eff = wp * protPts + (1 - wp) * kcalPts;
  if (known && !tags.has('processed') && !tags.has('ultraprocessed')) eff = Math.max(eff, 20);
  if (fresh) eff = Math.max(eff, 40);
  const discPts = clamp(m.discount * 80, 0, 40);
  const value = clamp(eff + discPts, 0, 100);
  if (m.eurPerProt != null && m.eurPerProt <= 2.5 && dens != null && dens >= 10 && pf >= 0.4) add(10, `Goedkoop eiwit: ${fmtEur(m.eurPerProt)} per 100 g eiwit`);
  if (m.discount >= 0.25) add(m.discount * 20, hasNormal ? `${fmtNum(m.discount * 100)}% korting, ${fmtEur(it.priceNormal - price)} goedkoper` : `${fmtNum(m.discount * 100)}% korting`);

  /* --- shelf life practicality --- */
  let risk = 0;
  const persons = Math.max(1, P.persons || 1);
  const canFreeze = !!it.freezable && !!P.freezer;
  const st = expState(it);
  if (st === 'verlopen') { risk = 30; pins.push('Datum is verstreken'); }
  else if (st === 'vandaag') {
    if (canFreeze) add(1, 'Vandaag opeten of invriezen');
    else {
      const share = kcalPack / ((P.kcal || 2000) * persons);
      if (share > 0.6) { risk = 12; add(-12, 'Veel om vandaag op te krijgen'); }
      else { risk = 3; add(-1, 'Vandaag opeten'); }
    }
  } else if (st === 'morgen' && !canFreeze) {
    const share = kcalPack / ((P.kcal || 2000) * persons);
    if (share > 1.2) { risk = 6; add(-6, 'Veel om binnen twee dagen op te eten'); }
  }

  let score = clamp(Math.round(0.6 * fit + 0.4 * value - risk), 0, 100);
  let verdict;
  if (hits.length) {
    verdict = 'nee';
    score = Math.min(score, 10);
    pins.unshift(`Bevat ${hits.map(t => TAG_NL[t] || t).join(', ')}: dat eet je niet`);
  } else if (st === 'verlopen') {
    verdict = 'laten';
  } else if (!known) {
    verdict = 'twijfel';
  } else if (fit < 42) {
    verdict = 'laten';
    score = Math.min(score, 45);
  } else {
    verdict = score >= 60 ? 'ja' : score >= 46 ? 'twijfel' : 'laten';
    if (capTwijfel && verdict === 'ja') verdict = 'twijfel';
  }
  const sorted = R.sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).map(r => ({ pos: r.w > 0, neg: r.w < 0, s: r.s }));
  const reasons = pins.map(s => ({ pos: false, neg: true, s })).concat(sorted).slice(0, Math.max(4, pins.length + 2));
  return { score, verdict, fit: Math.round(fit), value: Math.round(value), risk, reasons, m, exp: st };
}
const VERDICT_NL = { ja: 'Kopen', twijfel: 'Twijfel', laten: 'Laten liggen', nee: 'Past niet' };

function itemFromFood(f, over = {}) {
  return Object.assign({
    id: uid(), foodId: f.id, name: f.name, cat: f.cat,
    n: { kcal: f.kcal, protein: f.protein, carbs: f.carbs, sugar: f.sugar, fat: f.fat, satfat: f.satfat, fiber: f.fiber, salt: f.salt },
    tags: f.tags.slice(), freezable: !!f.freezable, grams: f.pack_g, priceNormal: f.price_eur, discountPct: 35, priceNow: null,
    expDate: todayISO(), qty: 1, source: 'db', addedAt: Date.now(),
  }, over);
}
function basketTotals(list, P) {
  let spent = 0, saved = 0, kcal = 0, prot = 0;
  for (const it of list) {
    const q = it.qty || 1, now = itemPriceNow(it) || 0;
    spent += now * q;
    if (it.priceNormal > 0) saved += Math.max(0, it.priceNormal - now) * q;
    if (it.n) { kcal += (+it.n.kcal || 0) * (it.grams || 0) / 100 * q; prot += (+it.n.protein || 0) * (it.grams || 0) / 100 * q; }
  }
  const persons = Math.max(1, P.persons || 1);
  return { spent: round2(spent), saved: round2(saved), kcal, prot, protDays: P.protein > 0 ? prot / (P.protein * persons) : 0, kcalDays: P.kcal > 0 ? kcal / (P.kcal * persons) : 0 };
}

/* ============================================================
   Meal ideas (rule based)
   ============================================================ */
function rolesOf(it) {
  const r = new Set(); const t = new Set(it.tags || []); const c = it.cat; const nm = norm(it.name);
  const words = nm.split(' ');
  const starchy = c === 'zetmeel' || /pasta|tortellini|gnocchi|noedel|rijst|aardappel|krieltjes|friet/.test(nm);
  if (['vlees', 'gevogelte', 'vis', 'vega'].includes(c)) r.add('eiwit');
  if (c === 'vis' || ((t.has('fish') || t.has('shellfish')) && c !== 'maaltijd' && c !== 'beleg')) r.add('vis');
  if (c === 'ei' || words.includes('eieren') || words.includes('ei')) { if (c !== 'maaltijd' && c !== 'beleg') { r.add('ei'); r.add('eiwit'); } }
  if ((c === 'vlees' || c === 'gevogelte') && /gehakt|burger|gehaktbal/.test(nm)) r.add('gehakt');
  if (c === 'groente' && !starchy) r.add('groente');
  if (c === 'groente' && words.some(w => /^(\w*sla|slamelange|slamix|spinazie|rucola|veldsla|andijvie|ijsberg\w*)$/.test(w))) r.add('blad');
  if (c === 'fruit') r.add('fruit');
  if (starchy) r.add('zetmeel');
  if (c === 'brood') r.add('brood');
  if (c === 'zuivel' && /kwark|yoghurt|skyr|kefir|cottage|hutten/.test(nm)) r.add('zuivel');
  if (c === 'kaas') r.add('kaas');
  if (c === 'maaltijd' || c === 'salade') r.add('maaltijd');
  if (c === 'beleg') r.add('beleg');
  if (c === 'groente' && /tomaat|tomaten|paprika/.test(nm)) r.add('tomaat');
  return r;
}
const MEALS = [
  { id: 'roerbak', name: 'Roerbakschotel', needs: ['eiwit', 'groente'], opt: ['zetmeel'],
    how: ex => `Snijd alles in reepjes. Bak het eiwit 4 tot 6 minuten heet aan, groente erbij voor 3 tot 4 minuten. ${ex.has('soy') || ex.has('gluten') ? 'Breng op smaak met knoflook, gember, limoen en zout.' : 'Sojasaus, knoflook en gember erdoor.'}` },
  { id: 'tray', name: 'Traybake uit de oven', needs: ['eiwit', 'groente'], how: () => 'Alles in stukken op een bakplaat met olie, zout en kruiden. 25 tot 30 minuten op 200 °C. Kip en gehakt moeten helemaal gaar zijn.' },
  { id: 'vis', name: 'Vis uit de oven met groente', needs: ['vis', 'groente'], how: () => 'Groente 15 minuten voorroosteren op 200 °C, vis erop met citroen en olie, nog 10 tot 12 minuten.' },
  { id: 'gehakt', name: 'Gehaktballen of burgers met groente', needs: ['gehakt'], opt: ['groente', 'brood'],
    how: ex => `Kneed het gehakt met zout, peper${ex.has('gluten') && ex.has('egg') ? '' : ex.has('gluten') ? ' en een ei' : ex.has('egg') ? ' en wat paneermeel' : ' en wat paneermeel of een ei'}. Bak rondom bruin en daarna op laag vuur gaar, zonder roze binnenkant.` },
  { id: 'wrap', name: 'Wraps of pita', needs: ['eiwit', 'brood'], opt: ['groente', 'kaas', 'blad'],
    how: ex => `Eiwit kruidig bakken, wraps of pita kort verwarmen, vullen met rauwe groente en ${ex.has('dairy') ? 'hummus' : 'yoghurtsaus of hummus'}.` },
  { id: 'omelet', name: 'Omelet of frittata', needs: ['ei', 'groente'], opt: ['kaas'],
    how: ex => `Bak de groente zacht, giet losgeklopte eieren erover${ex.has('dairy') ? '' : ', kaas erop'} en laat op laag vuur met deksel stollen.` },
  { id: 'shakshuka', name: 'Shakshuka', needs: ['ei', 'tomaat'], opt: ['kaas', 'brood'], how: () => 'Ui, paprika en tomaat met komijn en paprikapoeder inkoken, kuiltjes maken, eieren erin, deksel erop tot het eiwit gestold is.' },
  { id: 'salade', name: 'Maaltijdsalade', needs: ['blad', 'eiwit'], opt: ['kaas', 'groente', 'brood'], how: () => 'Blad als basis, eiwit gebakken of koud erop, groente erbij, dressing van olie, azijn en mosterd.' },
  { id: 'pasta', name: 'Pasta met groente', needs: ['zetmeel', 'groente'], opt: ['eiwit', 'kaas'], carb: true,
    how: ex => `Pasta koken, groente in de pan met knoflook en olie, alles mengen. ${ex.has('dairy') ? 'Eiwit' : 'Kaas of eiwit'} erbij voor een volledige maaltijd.` },
  { id: 'soep', name: 'Groentesoep', needs: ['groente', 'groente'], opt: ['eiwit'], how: () => 'Groente fruiten, bouillon erbij, 20 minuten trekken en eventueel pureren. Soep kan prima de vriezer in.' },
  { id: 'bowl', name: 'Kwark- of yoghurtbowl', needs: ['zuivel', 'fruit'], how: ex => `Kwark of yoghurt met fruit${ex.has('nuts') ? (ex.has('gluten') ? '' : ' en havermout') : (ex.has('gluten') ? ' en noten' : ' en havermout of noten')}. Snel ontbijt of toetje met veel eiwit.` },
  { id: 'smoothie', name: 'Smoothie', needs: ['fruit'], opt: ['zuivel', 'blad'], how: ex => `Fruit, ook bijna overrijp, blenden met ${ex.has('dairy') ? 'plantaardige drink of water' : 'yoghurt, melk of water'}. Rijp fruit kun je in stukjes invriezen.` },
  { id: 'tosti', name: 'Tosti of broodmaaltijd', needs: ['brood', 'kaas'], opt: ['beleg', 'groente'], carb: true, how: () => 'Brood met kaas en beleg in de tostiapparaat of koekenpan. Rauwkost erbij.' },
  { id: 'kantklaar', name: 'Kant-en-klaar, aangevuld', needs: ['maaltijd'], opt: ['groente', 'blad'], carb: true, how: () => 'Volg de bereiding op de verpakking en voeg een portie groente of salade toe, dan is het een volwaardige maaltijd.' },
];
function mealIdeas(items, P) {
  const ex = exclusionsFor(P);
  const lowCarb = P.goal === 'keto' || P.goal === 'lowcarb' || (P.carbsMax != null && P.carbsMax <= 100);
  const carbCut = P.goal === 'keto' ? 10 : 30;
  const usable = items.filter(it => {
    if ((it.tags || []).some(t => ex.has(t))) return false;
    if (expState(it) === 'verlopen') return false;
    if (lowCarb && it.n && it.n.carbs != null && +it.n.carbs > carbCut) return false;
    return true;
  });
  const withRoles = usable.map(it => ({ it, roles: rolesOf(it) }));
  const res = [];
  for (const meal of MEALS) {
    if (lowCarb && (meal.carb || meal.needs.includes('zetmeel') || meal.needs.includes('brood'))) continue;
    if (P.goal === 'keto' && meal.needs.includes('fruit')) continue;
    const used = new Set(); let ok = true;
    for (const role of meal.needs) {
      const cand = withRoles.filter(x => x.roles.has(role) && !used.has(x.it)).sort((a, b) => urgencyRank(a.it) - urgencyRank(b.it))[0];
      if (!cand) { ok = false; break; }
      used.add(cand.it);
    }
    if (!ok) continue;
    for (const role of meal.opt || []) {
      if (lowCarb && (role === 'zetmeel' || role === 'brood')) continue;
      const cand = withRoles.filter(x => x.roles.has(role) && !used.has(x.it)).sort((a, b) => urgencyRank(a.it) - urgencyRank(b.it))[0];
      if (cand) used.add(cand.it);
    }
    const list = [...used];
    res.push({ meal, items: list, urgent: list.filter(it => expState(it) === 'vandaag').length, how: meal.how(ex) });
  }
  res.sort((a, b) => b.urgent - a.urgent || b.items.length - a.items.length);
  return res;
}
function urgencyRank(it) { const s = expState(it); return s === 'vandaag' ? 0 : s === 'morgen' ? 1 : 2; }

/* ============================================================
   Live Laatste Kans Koopjes from the AH app API (used by the
   Scriptable host): turn one bargain into an item the engine scores
   ============================================================ */
function parseUnitSize(s) {
  if (!s) return null;
  const t = String(s).toLowerCase().replace(/(\d),(\d)/g, '$1.$2');
  const unit = (v, u) => { v = +v; return u === 'kg' || u === 'kilo' || u === 'l' || u === 'liter' ? v * 1000 : u === 'cl' ? v * 10 : v; };
  const multi = t.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(kg|kilo|gram|gr|g|ml|liter|cl|l)\b/);
  if (multi) return Math.round(+multi[1] * unit(multi[2], multi[3]));
  const one = t.match(/(\d+(?:\.\d+)?)\s*(kg|kilo|gram|gr|g|ml|liter|cl|l)\b/);
  return one ? Math.round(unit(one[1], one[2])) : null;
}
// AH returns nutrients as [{type, name, value: "15.5 g" | "1046 kJ (250 kcal)"}], per 100 g first.
function nutritionFromAH(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const n = {};
  const set = (k, v) => { if (n[k] == null && isFinite(v)) n[k] = v; };
  for (const x of list) {
    if (!x) continue;
    const key = (String(x.type || '') + ' ' + String(x.name || '')).toLowerCase();
    const val = String(x.value || '').toLowerCase().replace(/(\d),(\d)/g, '$1.$2');
    const first = val.match(/-?\d+(?:\.\d+)?/);
    if (!first) continue;
    const num = parseFloat(first[0]);
    if (/onverzadig|unsatur|enkelvoudig|meervoudig|mono|poly|transvet|trans fat/.test(key)) continue;
    if (/energ/.test(key)) {
      const kc = val.match(/(\d+(?:\.\d+)?)\s*kcal/);
      const kj = val.match(/(\d+(?:\.\d+)?)\s*kj/);
      if (kc) set('kcal', parseFloat(kc[1])); else if (kj) set('kcal', Math.round(parseFloat(kj[1]) / 4.184)); else if (/kcal/.test(key)) set('kcal', num);
    }
    else if (/satur|verzadig/.test(key)) set('satfat', num);
    else if (/sugar|suiker/.test(key)) set('sugar', num);
    else if (/fib|vezel/.test(key)) set('fiber', num);
    else if (/salt|zout/.test(key)) set('salt', num);
    else if (/sodium|natrium/.test(key)) { if (n.salt == null) n.salt = round2(num * 2.5 / (/mg/.test(val) ? 1000 : 1)); }
    else if (/prot|eiwit/.test(key)) set('protein', num);
    else if (/carbo|koolhydr/.test(key)) set('carbs', num);
    else if (/\bfat\b|vet\b|vetten/.test(key)) set('fat', num);
  }
  return n.kcal != null || n.protein != null ? n : null;
}
function catFromAH(category, title) {
  const t = norm(title), c = norm(category);
  const both = t + ' | ' + c;
  if (/\bkip|kippen|kalkoen|gevogelte/.test(t)) return 'gevogelte';
  if (/zalm|tonijn|kabeljauw|garnal|sushi|makreel|haring|pangasius|\bvis\b|vissticks|kibbeling/.test(t)) return 'vis';
  if (/vega|vegetarisch|plantaardig|tofu|tempeh|falafel/.test(t)) return 'vega';
  if (/gehakt|\brund|varken|biefstuk|speklap|hamburger|karbonade|shoarma|gyros|\bworst|riblap|stooflap/.test(t)) return 'vlees';
  if (/\bham\b|rookvlees|kipfilet beleg|salami|vleeswaren|hummus|salade.*(kip|ei|tonijn)|spread/.test(t)) return 'beleg';
  if (/kaas|mozzarella|feta|brie|camembert/.test(t)) return 'kaas';
  if (/eieren|\bei\b/.test(t)) return 'ei';
  if (/yoghurt|kwark|skyr|melk|vla\b|pudding|toetje|room\b|kefir|zuivel/.test(t)) return 'zuivel';
  if (/brood|croissant|\bbol|bollen|stokbrood|pistolet|bagel|wrap|pita|tortilla|krentenbol|gebak|taart|koek|muffin|donut/.test(t)) return 'brood';
  if (/maaltijd|lasagne|nasi|bami|stamppot|soep|pizza|curry|bowl|maaltijdsalade|ovenschotel|wok|quiche/.test(both)) return 'maaltijd';
  if (/pasta|tortellini|tagliatelle|gnocchi|noedel|\bmie\b|ravioli/.test(t)) return 'zetmeel';
  if (/fruit|aardbei|bes|bessen|druif|druiven|banaan|bananen|mango|ananas|appel|peer|meloen|kiwi|framboz|citrus|sinaasappel/.test(both)) return 'fruit';
  if (/groente|sla\b|slamelange|spinazie|broccoli|bloemkool|paprika|tomaat|tomaten|komkommer|champignon|courgette|wortel|kool|andijvie|rucola|prei|ui\b|uien|kruiden|aardappel|krieltjes/.test(both)) return 'groente';
  if (/vlees|vis|kip/.test(c)) return 'vlees';
  return 'overig';
}
function itemFromAH(x) {
  const raw = String(x.title || 'Product').trim();
  const title = raw.replace(/^AH\s+(Excellent\s+|Terra\s+|Biologisch\s+|Basic\s+)?/i, '').trim() || raw;
  let core = title;
  const brand = String(x.brand || '').trim();
  if (brand && !/^ah$/i.test(brand) && core.toLowerCase().startsWith(brand.toLowerCase() + ' ')) core = core.slice(brand.length).trim();
  const match = matchFood(core, 1)[0];
  const strong = match && match.s >= 70 ? match.f : null;
  const cat = strong ? strong.cat : catFromAH(x.category, title);
  const tags = new Set([...(strong ? strong.tags : []), ...inferTags(raw)]);
  if (!strong && (cat === 'groente' || cat === 'fruit') && !/gesneden|salade|mix|soep|maaltijd/.test(norm(title))) tags.add('fresh_produce');
  if (tags.has('vegan') && ANIMAL.some(t => tags.has(t))) tags.delete('vegan');
  const label = x.nutrition && (x.nutrition.kcal != null || x.nutrition.protein != null) ? x.nutrition : null;
  const n = label || (strong ? itemFromFood(strong).n : null);
  const was = parseNum(x.priceWas), now = parseNum(x.priceNow);
  const pctIn = x.pct != null && isFinite(+x.pct) ? Math.round(+x.pct) : null;
  const pct = pctIn != null ? pctIn : (was > 0 && now != null ? Math.round((1 - now / was) * 100) : null);
  const exp = typeof x.expDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x.expDate) ? x.expDate.slice(0, 10) : todayISO();
  const freezable = strong ? !!strong.freezable : ['vlees', 'gevogelte', 'brood', 'maaltijd', 'vega'].includes(cat);
  return {
    id: `ah-${x.productId}-${exp}`, foodId: strong ? strong.id : null, name: title, cat, n, tags: [...tags], freezable,
    grams: parseUnitSize(x.unitSize) ?? (strong ? strong.pack_g : null), unitSize: x.unitSize || null,
    priceNormal: was, priceNow: now, discountPct: pct, expDate: exp,
    qty: 1, source: 'ah', productId: x.productId ?? null, stock: x.stock != null && isFinite(+x.stock) ? +x.stock : null,
    nutriSource: label ? 'etiket' : strong ? 'tabel' : null, addedAt: Date.now(),
  };
}
