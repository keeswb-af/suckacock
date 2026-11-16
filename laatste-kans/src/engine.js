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
  return { goal: 'balanced', eat: 'alles', kcal: 2000, protein: 90, carbsMax: null, excl: {}, avoidUltra: false, freezer: true, persons: 1, budget: 40, notes: '', weight: null, stores: [], setAt: null, savedAt: 0 };
}
// The stores a profile follows (older profiles had a single "store").
const MAX_STORES = 99; // no practical limit: every AH in the list can be followed
function profileStores(P) {
  const known = id => typeof STORES === 'undefined' || STORES.some(s => s.id === id);
  // A non-empty list wins; otherwise fall back to the single store of older versions.
  const ids = P && Array.isArray(P.stores) && P.stores.length ? P.stores : P && P.store ? [P.store] : [];
  return [...new Set(ids)].filter(known).slice(0, MAX_STORES);
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
  const prices = [...s.matchAll(/€\s?(\d{1,3}(?:[.,]\d{1,2})?)|(^|[^\d.,])(\d{1,3}[.,]\d{1,2})(?![\d%])/g)];
  if (prices.length) {
    const vals = prices.map(m => parseNum(m[1] || m[3])).filter(v => v != null);
    if (vals.length >= 2) { r.price = Math.max(vals[0], vals[1]); r.now = Math.min(vals[0], vals[1]); }
    else if (vals.length) r.price = vals[0];
    for (const m of prices) s = s.replace(m[0], (m[2] || '') + ' ');
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
  if (/\bkip|kippen|kalkoen|gevogelte/.test(t)) return 'gevogelte';
  if (/zalm|tonijn|kabeljauw|garnal|sushi|makreel|haring|pangasius|\bvis\b|vissticks|kibbeling/.test(t)) return 'vis';
  if (/vega|vegetarisch|plantaardig|tofu|tempeh|falafel/.test(t)) return 'vega';
  if (/gehakt|\brund|varken|biefstuk|speklap|spekreep|\bspek|hamburger|karbonade|shoarma|gyros|\bworst|riblap|stooflap/.test(t)) return 'vlees';
  if (/\bham\b|rookvlees|salami|vleeswaren|hummus|salade.*(kip|ei|tonijn)|spread/.test(t)) return 'beleg';
  if (/kaas|mozzarella|feta|brie|camembert/.test(t)) return 'kaas';
  if (/eieren|\bei\b/.test(t)) return 'ei';
  if (/yoghurt|kwark|skyr|melk|\bvla\b|pudding|toetje|\broom\b|kefir|zuivel/.test(t)) return 'zuivel';
  if (/brood|croissant|\bbol\b|bollen|stokbrood|pistolet|bagel|wrap|pita|tortilla|krentenbol|gebak|taart|koek|muffin|donut|flap|beschuit|cracker/.test(t)) return 'brood';
  if (/siroop|\bsap\b|sappen|smoothie|drink|limonade|frisdrank|\bshot\b|juice/.test(t)) return 'overig';
  if (/maaltijd|lasagne|nasi|bami|stamppot|soep|pizza|curry|bowl|maaltijdsalade|ovenschotel|\bwok\b|quiche/.test(t)) return 'maaltijd';
  if (/pasta|tortellini|tagliatelle|gnocchi|noedel|\bmie\b|ravioli/.test(t)) return 'zetmeel';
  if (/groente|\bsla\b|slamelange|spinazie|broccoli|bloemkool|paprika|tomaat|tomaten|komkommer|champignon|courgette|wortel|\bkool\b|spitskool|boerenkool|andijvie|rucola|\bprei\b|\bui\b|uien|kruiden|aardappel|krieltjes|selderij|sperzie|bonen|peen|biet|venkel|aubergine|asperge|pompoen|taug/.test(t)) return 'groente';
  if (/fruit|aardbei|\bbes\b|bessen|druif|druiven|banaan|bananen|mango|ananas|\bappel|appels|\bpeer|peren|meloen|kiwi|framboz|citroen|sinaasappel|mandarijn|nectarine|perzik|pruim|kers|avocado/.test(t)) return 'fruit';
  if (/^groente|aardappel.*groente/.test(c)) return 'groente';
  if (/^fruit/.test(c)) return 'fruit';
  if (/maaltijd|kant en klaar|soep/.test(c)) return 'maaltijd';
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
  if (!strong && (cat === 'groente' || cat === 'fruit') && !/gesneden|salade|soep|maaltijd|smoothie|\bsap\b|flap|taart/.test(norm(title))) tags.add('fresh_produce');
  if (tags.has('vegan') && ANIMAL.some(t => tags.has(t))) tags.delete('vegan');
  const label = x.nutrition && (x.nutrition.kcal != null || x.nutrition.protein != null) ? x.nutrition : null;
  const n = label || (strong ? itemFromFood(strong).n : null);
  const was = parseNum(x.priceWas), now = parseNum(x.priceNow);
  const pctIn = x.pct != null && isFinite(+x.pct) ? Math.round(+x.pct) : null;
  const pct = pctIn != null ? pctIn : (was > 0 && now != null ? Math.round((1 - now / was) * 100) : null);
  const exp = typeof x.expDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x.expDate) ? x.expDate.slice(0, 10) : todayISO();
  const freezable = strong ? !!strong.freezable : ['vlees', 'gevogelte', 'brood', 'maaltijd', 'vega'].includes(cat);
  return {
    id: `ah-${x.storeKey ? x.storeKey.replace(/^ah-/, '') + '-' : ''}${x.productId}-${exp}-${now != null ? Math.round(now * 100) : 'x'}`,
    storeKey: x.storeKey || null, storeName: x.storeName || null, foodId: strong ? strong.id : null, name: title, cat, n, tags: [...tags], freezable,
    grams: parseUnitSize(x.unitSize) ?? (strong ? strong.pack_g : null), unitSize: x.unitSize || null,
    priceNormal: was, priceNow: now, discountPct: pct, expDate: exp,
    qty: 1, source: 'ah', productId: x.productId ?? null, stock: x.stock != null && isFinite(+x.stock) ? +x.stock : null,
    nutriSource: label ? 'etiket' : strong ? 'tabel' : null, addedAt: Date.now(),
  };
}

/* ============================================================
   Markdown history: how far and how fast stickers drop, per store
   and product, so the app can say "buy now" or "wait".

   history = { v, offers: { key: offer }, fetches: { storeKey: [ts] } }
   offer   = { s: store, p: productId, c: category, n: name, e: expiry date,
               w: normal price, f: first seen, l: last seen,
               g: first time seen missing (sold out or taken away) or null,
               o: [[ts, pct, priceNow, stock, lastSeenTs], ...] (one row per change;
                   lastSeenTs is the last look at which that row still held) }
   ============================================================ */
const HISTORY_DAYS = 45, HISTORY_MAX = 8000;
function pctBucket(p) { return p == null || !isFinite(p) ? null : Math.max(0, Math.min(95, Math.round(p / 5) * 5)); }
function offerKey(storeKey, productId, expDate) { return `${storeKey}|${productId}|${expDate || ''}`; }
function median(a) { if (!a || !a.length) return null; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }
function recordObservations(hist, payload, now) {
  hist = hist && typeof hist === 'object' ? hist : {};
  hist.v = 1; hist.offers = hist.offers || {}; hist.fetches = hist.fetches || {};
  if (!payload || !payload.storeKey || !Array.isArray(payload.items)) return hist;
  const sk = payload.storeKey;
  const t = now || payload.fetchedAt || Date.now();
  const seen = new Set();
  for (const x of payload.items) {
    if (x == null || x.productId == null) continue;
    const it = itemFromAH(Object.assign({}, x, { storeKey: sk }));
    const k = offerKey(sk, x.productId, it.expDate);
    seen.add(k);
    let o = hist.offers[k];
    if (!o) o = hist.offers[k] = { s: sk, p: x.productId, c: it.cat, n: it.name, e: it.expDate, w: it.priceNormal, f: t, l: t, g: null, o: [] };
    const last = o.o[o.o.length - 1];
    const obs = [t, it.discountPct, it.priceNow, it.stock, t];
    if (!last || last[1] !== obs[1] || last[2] !== obs[2] || last[3] !== obs[3]) o.o.push(obs);
    else last[4] = t;
    if (o.o.length > 40) o.o.splice(1, o.o.length - 40);
    o.l = t; o.g = null;
    if (it.priceNormal > 0) o.w = it.priceNormal;
  }
  // Offers this store had at the previous look that are missing now: sold out or taken off the shelf.
  // An empty answer while there were offers before is more likely a hiccup than an empty shelf: skip.
  const before = Object.values(hist.offers).filter(o => o.s === sk && o.g == null && o.l < t);
  if (seen.size || before.length < 3) for (const o of before) if (!seen.has(offerKey(o.s, o.p, o.e))) o.g = t;
  const fl = hist.fetches[sk] = hist.fetches[sk] || [];
  fl.push(t);
  if (fl.length > 300) fl.splice(0, fl.length - 300);
  return hist;
}
function pruneHistory(hist, now) {
  if (!hist || !hist.offers) return hist;
  const cut = (now || Date.now()) - HISTORY_DAYS * 86400000;
  for (const k in hist.offers) if (hist.offers[k].l < cut) delete hist.offers[k];
  const keys = Object.keys(hist.offers);
  if (keys.length > HISTORY_MAX) keys.sort((a, b) => hist.offers[a].l - hist.offers[b].l).slice(0, keys.length - HISTORY_MAX).forEach(k => delete hist.offers[k]);
  return hist;
}
// For every discount level an offer was seen at: did it later get a deeper discount (when, how deep),
// or was it gone first? Offers still on the shelf at the last look are left out (outcome unknown).
function buildTimingStats(hist) {
  const out = { v: 1, offers: 0, stores: {}, keys: {} };
  if (!hist || !hist.offers) return out;
  const acc = {};
  const add = (key, b, rec) => {
    const K = acc[key] = acc[key] || {};
    const B = K[b] = K[b] || { up: 0, gone: 0, hrs: [], tos: [], dts: [] };
    if (rec.up) { B.up++; B.hrs.push(rec.h); B.tos.push(rec.to); B.dts.push(rec.dt); } else B.gone++;
  };
  for (const k in hist.offers) {
    const o = hist.offers[k], obs = o.o || [];
    if (!obs.length) continue;
    out.offers++;
    out.stores[o.s] = (out.stores[o.s] || 0) + 1;
    const firsts = [];
    obs.forEach((ob, i) => { const b = pctBucket(ob[1]); if (b != null && (!firsts.length || firsts[firsts.length - 1].b !== b)) firsts.push({ b, t: ob[0], i }); });
    firsts.forEach((cur, j) => {
      const higher = firsts.slice(j + 1).find(x => x.b > cur.b);
      let rec;
      if (higher) {
        const prev = higher.i > 0 ? obs[higher.i - 1] : null;
        const prevT = prev ? (prev[4] || prev[0]) : cur.t;
        const tt = (prevT + higher.t) / 2, d = new Date(tt);
        rec = { up: true, h: d.getHours() + d.getMinutes() / 60, to: higher.b, dt: Math.max(0, (tt - cur.t) / 3600000) };
      } else if (o.g != null) rec = { up: false };
      else return;
      for (const key of [`sp:${o.s}|${o.p}`, `sc:${o.s}|${o.c}`, `c:${o.c}`, `s:${o.s}`, 'all']) add(key, cur.b, rec);
    });
  }
  const r1 = v => v == null ? null : Math.round(v * 10) / 10;
  for (const key in acc) {
    for (const b in acc[key]) {
      const B = acc[key][b], n = B.up + B.gone;
      if (key.startsWith('sp:') && n < 2) continue; // keep the file small: single sightings say little
      // The next level is the most common one (a median of 40 and 70 would be a 55% that never happens),
      // and the hour and wait are taken from the cases that went to that level.
      let to = null, best = 0;
      const cnt = {};
      for (const v of B.tos) { cnt[v] = (cnt[v] || 0) + 1; if (cnt[v] > best || (cnt[v] === best && v > to)) { best = cnt[v]; to = v; } }
      const sel = i => B.tos[i] === to;
      (out.keys[key] = out.keys[key] || {})[b] = { n, up: B.up, h: r1(median(B.hrs.filter((_, i) => sel(i)))), to, dt: r1(median(B.dts.filter((_, i) => sel(i)))) };
    }
  }
  return out;
}
function fmtHour(h) { let H = Math.floor(h), M = Math.round((h - H) * 4) * 15; if (M === 60) { H += 1; M = 0; } return `${String(H % 24).padStart(2, '0')}:${String(M).padStart(2, '0')}`; }
// Buy now or wait? Uses the most specific history that has enough cases.
function timingAdvice(it, stats, now) {
  if (!it || it.discountPct == null || !(it.priceNormal > 0)) return null;
  const st = expState(it);
  if (st === 'verlopen') return null;
  const p = pctBucket(it.discountPct);
  if (p >= 70) return { kind: 'nu', text: 'Dit is al de hoogste korting die AH meestal geeft; wachten levert weinig op.' };
  const catName = it.cat && CATS[it.cat] ? CATS[it.cat].toLowerCase() : 'dit soort product';
  const chain = [
    [it.storeKey && it.productId != null ? `sp:${it.storeKey}|${it.productId}` : null, 'dit product in deze winkel', 3],
    [it.storeKey ? `sc:${it.storeKey}|${it.cat}` : null, `${catName} in deze winkel`, 5],
    [`c:${it.cat}`, `${catName} in je winkels`, 8],
    [it.storeKey ? `s:${it.storeKey}` : null, 'een koopje in deze winkel', 8],
    ['all', 'een koopje in je winkels', 10],
  ];
  const K = (stats && stats.keys) || {};
  let pick = null;
  for (const [key, label, min] of chain) { const B = key && K[key] && K[key][p]; if (B && B.n >= min) { pick = { B, label }; break; } }
  const hourNow = new Date(now || Date.now()).getHours();
  if (!pick) {
    if (st === 'vandaag' && p <= 40 && hourNow < 18) return { kind: 'info', weak: true, text: 'AH verhoogt de korting door de dag heen (25%, 40%, tot 70%). Er zijn nog te weinig eigen metingen om te zeggen of dit product het haalt.' };
    return null;
  }
  const { B, label } = pick;
  const raw = B.up / B.n;
  const lastOne = it.stock != null && it.stock <= 1;
  const late = B.h != null && st === 'vandaag' && hourNow > B.h + 1.5;
  let pUp = raw;
  if (lastOne) pUp *= 0.75;
  if (late) pUp *= 0.4;
  const nextPct = B.to || Math.min(70, p + 15);
  const save = round2((itemPriceNow(it) || 0) - round2(it.priceNormal * (1 - nextPct / 100)));
  const when = B.h != null ? ` rond ${fmtHour(B.h)}` : B.dt != null ? ` na zo'n ${Math.max(1, Math.round(B.dt))} uur` : '';
  const upTxt = Math.round(raw * 100), basis = ` (${B.n}× gezien)`, one = lastOne ? ' Er ligt er nog maar één.' : '';
  if (late && pUp < 0.6) return { kind: 'nu', p: pUp, text: `${label[0].toUpperCase() + label.slice(1)} zakt meestal${when} verder, en dat moment is al voorbij zonder dat het gebeurde.${one}${basis}` };
  if (pUp >= 0.6 && save >= 0.3) return { kind: 'wacht', p: pUp, save, text: `In ${upTxt}% van de gevallen zakte ${label} verder naar ${nextPct}%${when}, ${fmtEur(save)} goedkoper.${one}${basis}` };
  if (pUp <= 0.4) return { kind: 'nu', p: pUp, text: `In ${100 - upTxt}% van de gevallen was ${label} op voordat de korting verder zakte.${one}${basis}` };
  return { kind: 'gok', p: pUp, save, text: `In ${upTxt}% van de gevallen zakte ${label} verder naar ${nextPct}%${when} (${fmtEur(Math.max(0, save))} goedkoper), maar regelmatig was hij ook eerder op.${one}${basis}` };
}

/* ============================================================
   Day plan: what to eat today and what to buy for it. Staples with
   prices per chain (data/staples.json) fill a day template that is
   scaled to the kcal and protein goal. Bargains you already have take
   a slot first; bargains in the shop are suggested when they are
   cheaper. Pure functions, shared by the page and the widget.
   ============================================================ */
const STAPLE_LIST = typeof STAPLES !== 'undefined' && STAPLES && Array.isArray(STAPLES.items) ? STAPLES.items : [];
const STAPLE_BY_ID = Object.fromEntries(STAPLE_LIST.map(s => [s.id, s]));
const SHOP_NL = { ah: 'AH', jumbo: 'Jumbo', lidl: 'Lidl', cheapest: 'Goedkoopst' };
// Walking order through a typical shop: fresh produce, bread, dairy, meat, dry goods, freezer.
const AISLE = ['banaan', 'wortel', 'broccoli', 'aardappelen', 'brood', 'melk', 'kwark', 'roomboter', 'eieren', 'kipfilet', 'rundergehakt', 'kippenlever', 'tofu', 'rijst', 'havermout', 'linzen', 'sardines', 'olijfolie', 'cacao', 'koolvis', 'spinazie'];
const fmtDec = v => new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 2 }).format(v);
function stapleById(id) { return STAPLE_BY_ID[id] || null; }
function weekdayOf(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getDay(); }
function stapleGrams(st, amount) { return st.unit === 'st' ? amount * (st.per || 100) : amount; }
function defaultShop(P) { return P && SHOP_NL[P.baseShop] ? P.baseShop : 'ah'; }
function stapleOffers(st) { return Object.entries((st && st.offers) || {}).map(([chain, o]) => ({ chain, product: o.product, pack: o.pack, price: o.price, unit: o.price / o.pack })); }
function offerFor(st, shop) {
  const all = stapleOffers(st);
  if (!all.length) return null;
  const own = shop && shop !== 'cheapest' ? all.find(o => o.chain === shop) : null;
  return own || all.sort((a, b) => a.unit - b.unit)[0];
}
function fmtAmt(st, a) {
  if (!st) return fmtDec(a);
  if (st.unit === 'st') return `${fmtDec(a)} ${a === 1 ? st.one : st.many}`;
  if (st.portion && a > 0 && Math.abs(a / st.portion.g - Math.round(a / st.portion.g)) < 1e-9) { const n = Math.round(a / st.portion.g); return `${n} ${n === 1 ? st.portion.one : st.portion.many}`; }
  const big = a >= 1000, u = st.unit === 'ml' ? (big ? 'L' : 'ml') : (big ? 'kg' : 'g');
  return `${big ? fmtDec(a / 1000) : fmtDec(Math.round(a))} ${u}`;
}
// "havermout 80 g", "2 eieren", "4 sneetjes bruinbrood"
function stapleLabel(st, a) {
  const amt = fmtAmt(st, a);
  if (st.unit === 'st') return amt;
  const nm = st.name.charAt(0).toLowerCase() + st.name.slice(1);
  return st.portion && !/ (g|kg|ml|L)$/.test(amt) ? `${amt} ${nm}` : `${nm} ${amt}`;
}
function expStateOn(it, iso) {
  const d = it.expDate;
  if (!d) return 'later';
  if (d < iso) return 'verlopen';
  if (d === iso) return 'vandaag';
  if (d === addDays(iso, 1)) return 'morgen';
  return 'later';
}
// The slot a bargain can take, and what "as much" means there: protein for meat and kwark, energy for starch and bread, weight for the rest.
function roleMetric(role) { return role === 'eiwit' || role === 'zuivel' ? 'prot' : role === 'zetmeel' || role === 'brood' ? 'kcal' : 'g'; }
function itemPer100(it, metric) {
  if (metric === 'g') return 100;
  const n = it.n || {};
  const v = metric === 'prot' ? +n.protein : +n.kcal;
  return v > 0 ? v : null;
}
function staplePer100(st, metric) { return metric === 'g' ? 100 : metric === 'prot' ? st.protein : st.kcal; }
function bargainFits(it, role) {
  const roles = rolesOf(it);
  if (!roles.has(role)) return false;
  const nm = norm(it.name);
  if (role === 'brood') return /brood|volkoren|spelt|rogge|pistolet|bollen/.test(nm) && !/croissant|krenten|rozijn|suiker|koek|cake|gebak|brioche|choco/.test(nm);
  if (role === 'eiwit') return !roles.has('maaltijd') && !roles.has('beleg');
  return true;
}
// What you have that the plan may use: the basket and bought bargains that are still good on that day.
// A freezable product past its date counts when you have a freezer: the app told you to freeze it.
function planHave(session, P, iso) {
  const out = [];
  for (const it of [...((session && session.basket) || []), ...((session && session.pantry) || [])]) {
    if (!it || it.example || !(it.grams > 0)) continue;
    const st = expStateOn(it, iso);
    const frozen = st === 'verlopen' && !!it.freezable && !!P.freezer;
    if (st === 'verlopen' && !frozen) continue;
    if (evaluate(it, P).verdict === 'nee') continue;
    const left = it.grams * (it.qty || 1) - (it.usedG || 0);
    if (left < 30) continue;
    out.push({ it, left, frozen, rank: st === 'vandaag' ? 0 : st === 'morgen' ? 1 : frozen ? 3 : 2 });
  }
  return out.sort((a, b) => a.rank - b.rank);
}
function lineNut(l) {
  let per, g;
  if (l.item) {
    const n = l.item.n && (+l.item.n.kcal > 0 || +l.item.n.protein > 0) ? l.item.n : null;
    const st = stapleById(l.replaces);
    per = n ? { kcal: +n.kcal || 0, prot: +n.protein || 0, carbs: +n.carbs || 0 } : st ? { kcal: st.kcal, prot: st.protein, carbs: st.carbs } : { kcal: 0, prot: 0, carbs: 0 };
    g = l.grams;
  } else {
    const st = stapleById(l.id);
    per = { kcal: st.kcal, prot: st.protein, carbs: st.carbs };
    g = stapleGrams(st, l.amount);
  }
  return { kcal: per.kcal * g / 100, prot: per.prot * g / 100, carbs: per.carbs * g / 100 };
}
function sumNut(lines) { return lines.reduce((a, l) => { const n = lineNut(l); a.kcal += n.kcal; a.prot += n.prot; a.carbs += n.carbs; return a; }, { kcal: 0, prot: 0, carbs: 0 }); }

function dayPlan(P, iso, ctx) {
  ctx = ctx || {};
  const persons = Math.max(1, Math.round(P.persons || 1));
  const shop = ctx.shop || defaultShop(P);
  const wd = weekdayOf(iso);
  const G = GOALS[P.goal] || GOALS.balanced;
  const kT = P.kcal > 0 ? P.kcal : G.kcal, pT = P.protein > 0 ? P.protein : G.protein;
  const lim = P.carbsMax != null ? P.carbsMax : G.carbsMax;
  const keto = P.goal === 'keto' || (lim != null && lim <= 40);
  const lc = keto || P.goal === 'lowcarb' || (lim != null && lim <= 180);
  const ex = exclusionsFor(P);
  const skip = new Set(Array.isArray(P.skipStaples) ? P.skipStaples : []);
  const meatDay = P.eat !== 'flexi' || [0, 2, 6].includes(wd);
  const allowed = id => { const st = stapleById(id); return !!st && !skip.has(id) && !st.tags.some(t => ex.has(t)) && (meatDay || !st.tags.includes('meat')); };
  const okAll = list => !!list && list.length > 0 && list.every(([id]) => allowed(id));
  const used = new Set();
  const meals = [];
  const tpl = STAPLE_LIST.length && STAPLES.plan ? STAPLES.plan.meals : [];

  /* 1. pick an item for every slot */
  for (const meal of tpl) {
    const lines = [];
    meal.slots.forEach((slot, si) => {
      let base = slot.items || (slot.rot ? slot.rot[String(wd)] || [] : []);
      let variant = false;
      if (keto && 'keto' in slot) { base = slot.keto; variant = true; }
      else if (lc && 'lc' in slot) { base = slot.lc; variant = true; }
      const alts = variant ? [] : (slot.alt || []).map(a => [a]);
      // Dinner protein goes round the alternatives by weekday, so a diet without chicken still gets variety.
      const off = slot.role === 'eiwit' && alts.length ? wd % alts.length : 0;
      const ordered = alts.map((_, k) => alts[(k + off) % alts.length]);
      const fresh = list => list.every(([id]) => !used.has(id));
      const pick = okAll(base) && fresh(base) ? base : ordered.find(a => okAll(a) && fresh(a)) || (okAll(base) ? base : ordered.find(okAll));
      if (!pick) return;
      for (const [id, amount, mark] of pick) {
        const sc = stapleById(id).scale || [amount, amount, 1];
        const vast = mark === 'vast';
        const a = clamp(amount, sc[0], sc[1]);
        used.add(id);
        lines.push({ meal: meal.id, slot: si, id, amount: a, base: a, min: Math.max(sc[0], slot.min || 0), optional: !!slot.optional, vast, flex: vast ? null : slot.flex || null, order: slot.order || 9, role: vast ? null : slot.role || null, needs: slot.needs || null, item: null, grams: null, replaces: null });
      }
    });
    meals.push({ id: meal.id, name: meal.name, lines });
  }
  const live = () => meals.flatMap(m => m.lines);
  const prune = () => {
    for (const m of meals) {
      m.lines = m.lines.filter(l => l.item ? l.grams > 0 : l.amount > 0);
      m.lines = m.lines.filter(l => !l.needs || m.lines.some(o => o !== l && (o.id === l.needs || o.replaces === l.needs)));
    }
  };
  prune();

  /* 2. bargains you have take their slot, most urgent first */
  const have = (ctx.have || []).map(x => Object.assign({}, x));
  for (const l of live()) {
    if (!l.role || l.vast) continue;
    const st = stapleById(l.id), metric = roleMetric(l.role), sp = staplePer100(st, metric);
    const sg = stapleGrams(st, l.amount) * persons;
    for (const x of have) {
      if (x.left <= 0 || !bargainFits(x.it, l.role)) continue;
      const p = itemPer100(x.it, metric) || sp;
      const needG = Math.min(sg * 2, sp * sg / p);
      const useG = Math.round(Math.min(x.left, needG) / 5) * 5;
      if (useG < 0.6 * needG) continue;
      Object.assign(l, { item: x.it, grams: useG / persons, replaces: l.id, id: null, flex: null, frozen: x.frozen });
      x.left -= useG;
      break;
    }
  }

  /* 3. scale to the goal: protein first, then energy; balanced over the flexible items */
  const sc = l => stapleById(l.id).scale || [l.amount, l.amount, 1];
  const flex = kind => live().filter(l => l.flex === kind && !l.item);
  const step = l => lineNut(Object.assign({}, l, { amount: sc(l)[2] }));
  const carbsOk = l => lim == null || sumNut(live()).carbs + step(l).carbs <= lim + 0.5;
  // Which flexible item moves: 'balanced' keeps portions in proportion, 'lean' and 'fat' go by kcal per gram of protein.
  const kpp = l => { const st = stapleById(l.id); return st.kcal / Math.max(0.5, st.protein); };
  const eurPerProt = l => { const st = stapleById(l.id), off = offerFor(st, shop); return off ? off.unit / (stapleGrams(st, 1) * Math.max(0.5, st.protein) / 100) : Infinity; };
  const pickUp = { balanced: (a, b) => a.amount / a.base - b.amount / b.base || a.order - b.order, fat: (a, b) => kpp(b) - kpp(a) };
  const pickDown = { balanced: (a, b) => b.amount / b.base - a.amount / a.base || b.order - a.order, fat: (a, b) => kpp(b) - kpp(a) };
  const inc = (list, guard, how) => {
    let cs = list.filter(l => l.amount + sc(l)[2] <= sc(l)[1] + 1e-9 && carbsOk(l) && (!guard || guard(l)));
    // 'lean': of the protein sources with few kcal per gram of protein, the cheapest.
    if (how === 'lean' && cs.length) { const m = Math.min(...cs.map(kpp)); cs = cs.filter(l => kpp(l) <= m * 1.3).sort((a, b) => eurPerProt(a) - eurPerProt(b)); }
    else cs.sort(pickUp[how || 'balanced']);
    const c = cs[0];
    if (!c) return false;
    c.amount += sc(c)[2]; return true;
  };
  // One step down, or the whole item gone when the slot is optional and already at its smallest sensible amount.
  const down = l => { const a = l.amount - sc(l)[2]; return a >= l.min - 1e-9 && a > 0 ? a : l.optional && l.amount > 0 ? 0 : null; };
  const loss = (l, a) => { const now = lineNut(l), then = lineNut(Object.assign({}, l, { amount: a })); return { kcal: now.kcal - then.kcal, prot: now.prot - then.prot }; };
  const dec = (list, guard, how) => {
    const c = list.filter(l => { const a = down(l); return a != null && (!guard || guard(l, a)); }).sort(pickDown[how || 'balanced'])[0];
    if (!c) return false;
    c.amount = down(c);
    if (c.amount <= 0) prune();
    return true;
  };
  const protIfDec = (l, a) => sumNut(live()).prot - loss(l, a).prot;
  // Steps never jump over the kcal band when a smaller step can land in it, so the loop settles.
  for (let i = 0; i < 400; i++) {
    const t = sumNut(live());
    const fits = l => t.kcal + step(l).kcal <= kT * 1.03;
    const stays = (l, a) => t.kcal - loss(l, a).kcal >= kT * 0.97;
    // More protein: the leanest source when energy is tight, otherwise in proportion.
    if (t.prot < pT * 0.98 && inc(flex('prot'), null, t.kcal >= kT * 0.97 ? 'lean' : 'balanced')) continue;
    if (t.kcal < kT * 0.97) { if (inc(flex('kcal'), fits) || inc(flex('prot'), fits, 'fat')) continue; break; }
    if (t.kcal > kT * 1.03) {
      if (t.prot > pT * 1.15 && dec(flex('prot'), (l, a) => protIfDec(l, a) >= pT * 1.15)) continue;
      if (dec(flex('kcal'), stays) || dec(flex('kcal'))) continue;
      if (dec(flex('prot'), (l, a) => protIfDec(l, a) >= pT, 'fat')) continue;
      // Still too much energy at the protein goal: take out some of a fatter protein, the next round adds a leaner one.
      const lean = flex('prot').filter(l => l.amount + sc(l)[2] <= sc(l)[1] + 1e-9).map(kpp);
      const leanest = lean.length ? Math.min(...lean) : Infinity;
      if (dec(flex('prot'), (l, a) => kpp(l) > leanest * 1.3 && protIfDec(l, a) >= pT * 0.85, 'fat')) continue;
      break;
    }
    break;
  }
  // A carb limit the template could not meet: take carbs away where it hurts least.
  for (let i = 0; i < 60 && lim != null && sumNut(live()).carbs > lim + 0.5; i++) {
    if (!dec(flex('kcal').filter(l => stapleById(l.id).carbs >= 10))) break;
  }
  prune();

  /* 4. money: what today's food costs at the chosen shop, and cheaper bargains in the shop */
  const lines = live();
  for (const l of lines) {
    if (l.item) {
      const price = itemPriceNow(l.item);
      l.cost = price != null && l.item.grams > 0 ? price / l.item.grams * l.grams * persons : 0;
    } else {
      l.offer = offerFor(stapleById(l.id), shop);
      l.cost = l.offer ? l.offer.unit * l.amount * persons : 0;
    }
  }
  const swaps = [];
  const taken = new Set();
  for (const l of lines) {
    if (!l.role || l.vast || l.item || !l.offer) continue;
    const st = stapleById(l.id), metric = roleMetric(l.role), sp = staplePer100(st, metric);
    if (!(sp > 0)) continue;
    const perStaple = l.offer.unit / (stapleGrams(st, 1) * sp / 100);
    const needM = sp * stapleGrams(st, l.amount) * persons / 100;
    let best = null;
    for (const c of ctx.cands || []) {
      if (!c || c.example || taken.has(c.id) || !(c.grams > 0) || !bargainFits(c, l.role)) continue;
      const price = itemPriceNow(c), p = itemPer100(c, metric);
      if (!(price > 0) || !p) continue;
      const packM = p * c.grams / 100, per = price / packM;
      if (per > perStaple * 0.95 || packM < needM * 0.75) continue;
      if (!((c.freezable && P.freezer) || packM <= needM * 2.5 || expStateOn(c, iso) === 'later')) continue;
      if (evaluate(c, P).verdict !== 'ja') continue;
      if (!best || per < best.per) best = { it: c, per, packM };
    }
    if (best) {
      taken.add(best.it.id);
      swaps.push({ line: l, staple: st, it: best.it, metric, per: best.per, perStaple, save: (perStaple - best.per) * Math.min(needM, best.packM) });
    }
  }
  swaps.sort((a, b) => b.save - a.save);

  /* 5. what the day adds up to */
  const t = sumNut(lines);
  const notes = [];
  if (t.kcal < kT * 0.93) {
    const extra = [!ex.has('dairy') && 'kaas', !ex.has('nuts') && 'noten', !ex.has('nuts') && 'pindakaas', 'avocado'].filter(Boolean);
    notes.push(`Dit menu haalt ${fmtNum(kT - t.kcal)} kcal te weinig. Vul aan met bijvoorbeeld ${extra.slice(0, -1).join(', ')} of ${extra[extra.length - 1]}.`);
  }
  if (t.prot < pT * 0.93) notes.push(`Dit menu haalt ${fmtNum(pT - t.prot)} g eiwit te weinig voor je doel.`);
  if (lim != null && t.carbs > lim + 0.5) notes.push(`Dit menu heeft ${fmtNum(t.carbs)} g koolhydraten, meer dan je ${fmtNum(lim)} g.`);
  for (const l of lines) { const st = stapleById(l.id); if (st && st.note && !notes.includes(st.note)) notes.push(st.note); }
  if (P.excl && P.excl.halal && lines.some(l => l.id && stapleById(l.id).tags.includes('meat'))) notes.push('Vlees: koop het met een halal-keurmerk.');
  if (lines.some(l => l.frozen)) notes.push('Koopjes uit de vriezer: laat ze ontdooien in de koelkast.');
  return {
    iso, wd, persons, shop, target: { kcal: kT, prot: pT, carbs: lim },
    meals: meals.filter(m => m.lines.length), lines, totals: t, cost: round2(lines.reduce((a, l) => a + l.cost, 0)),
    swaps: swaps.slice(0, 3), notes,
  };
}
// The plan in the shape the day log keeps: staple amounts and bargain grams for the whole household.
function compactPlan(plan) { return plan.lines.map(l => l.item ? { i: l.item.id, g: Math.round(l.grams * plan.persons) } : { s: l.id, a: round2(l.amount * plan.persons) }); }
function planNeeds(plan) { const m = {}; for (const l of plan.lines) if (l.id && l.amount > 0) m[l.id] = (m[l.id] || 0) + l.amount * plan.persons; return m; }
function buyList(plan, stock, shop) {
  shop = shop || plan.shop;
  const need = planNeeds(plan), out = [];
  for (const id of Object.keys(need)) {
    const st = stapleById(id), n = need[id], have = Math.max(0, +(stock && stock[id]) || 0);
    if (have + 1e-6 >= n) continue;
    const off = offerFor(st, shop);
    if (!off) continue;
    const short = n - have, packs = Math.max(1, Math.ceil(short / off.pack - 1e-9));
    let alt = null;
    for (const o of stapleOffers(st)) {
      if (o.chain === off.chain || o.unit > off.unit * 0.8 || (off.unit - o.unit) * short < 0.3) continue;
      if (!alt || o.unit < alt.unit) alt = o;
    }
    out.push({ id, st, need: n, have, short, offer: off, packs, cost: round2(packs * off.price), alt, rest: packs * off.pack - short });
  }
  const own = shop === 'cheapest' ? null : shop;
  out.sort((a, b) => ((a.offer.chain === own ? 0 : 1) - (b.offer.chain === own ? 0 : 1)) || a.offer.chain.localeCompare(b.offer.chain) || AISLE.indexOf(a.id) - AISLE.indexOf(b.id));
  return { lines: out, total: round2(out.reduce((a, l) => a + l.cost, 0)) };
}
// Take a day's food out of the stock: staples by amount, bargains by grams used.
function consumeDay(s, lines) {
  const items = [...(s.basket || []), ...(s.pantry || [])];
  for (const x of lines || []) {
    if (x && x.s) {
      const v = (+s.stock[x.s] || 0) - (+x.a || 0);
      if (v > 0.5) s.stock[x.s] = Math.round(v * 10) / 10; else delete s.stock[x.s];
    } else if (x && x.i) {
      const it = items.find(y => y.id === x.i);
      if (it && it.grams > 0) it.usedG = Math.min(it.grams * (it.qty || 1), (it.usedG || 0) + (+x.g || 0));
    }
  }
}
// Move the stock to today: every day since the last visit is eaten as planned
// (the logged plan of that day, or the plan the app would have made).
function rollStock(s, iso, P) {
  let changed = false;
  if (!s.stock || typeof s.stock !== 'object' || Array.isArray(s.stock)) { s.stock = {}; changed = true; }
  if (!s.dayLog || typeof s.dayLog !== 'object' || Array.isArray(s.dayLog)) { s.dayLog = {}; changed = true; }
  const valid = typeof s.stockDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.stockDay);
  if (!valid || s.stockDay > iso) {
    if (s.stockDay !== iso) { s.stockDay = iso; changed = true; }
  } else if (s.stockDay < iso) {
    let d = s.stockDay < addDays(iso, -7) ? addDays(iso, -7) : s.stockDay;
    while (d < iso) {
      const log = Array.isArray(s.dayLog[d]) ? s.dayLog[d] : compactPlan(dayPlan(P, d, { have: planHave(s, P, d) }));
      consumeDay(s, log);
      d = addDays(d, 1);
    }
    s.stockDay = iso; changed = true;
  }
  for (const k of Object.keys(s.dayLog)) if (k < addDays(iso, -8)) { delete s.dayLog[k]; changed = true; }
  return changed;
}
// Stock and bargains as they will be tomorrow, if today's list is bought and today's menu eaten.
function projectAfter(s, lines, bought) {
  const p = { stock: Object.assign({}, s.stock || {}), basket: clone(s.basket || []), pantry: clone(s.pantry || []) };
  for (const b of bought || []) p.stock[b.id] = (+p.stock[b.id] || 0) + b.packs * b.offer.pack;
  consumeDay(p, lines);
  return p;
}
