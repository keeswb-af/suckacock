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
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9% ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

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
  peat: { label: 'Ray Peat', rank: true, desc: 'Ray Peat: veel melk en kaas, rijp fruit en sinaasappelsap, eieren, schaaldieren en magere witvis, rund (stoofvlees voor gelatine), aardappel en rauwe wortel. Zo min mogelijk meervoudig onverzadigd vet (zaadoliën, noten en zaden, vette vis, kip- en varkensvet), soja, peulvruchten, graan en veel vezel. Suiker, verzadigd vet en zout zijn prima. Niets wordt uitgesloten: alles krijgt een Peat-score van hoog naar laag.', kcal: 2400, protein: 100, pf: 0.3, carbsMax: null },
};
// Ray Peat: share of the fat that is polyunsaturated, by kind of product (used when the label does not say).
function pufaShare(it, tags) {
  const nm = norm(it.name), c = it.cat;
  if (tags.has('seed_oil')) return 0.45;
  if (tags.has('soy') || /tofu|tempeh|soja/.test(nm)) return 0.55;
  if (tags.has('nuts') || /noot|noten|pinda|zaden|pitten|sesam|tahin/.test(nm)) return 0.35;
  if (/kokos/.test(nm)) return 0.02;
  if (c === 'zuivel' || c === 'kaas' || /roomboter|\bboter\b/.test(nm)) return 0.04;
  if (tags.has('beef') && !tags.has('pork') && !tags.has('poultry')) return 0.04;
  if (c === 'vis' || tags.has('fish')) return 0.3;
  if (tags.has('poultry')) return 0.22;
  if (tags.has('pork')) return 0.12;
  if (c === 'ei') return 0.15;
  if (/avocado/.test(nm)) return 0.12;
  if (/olijf/.test(nm)) return 0.1;
  if (tags.has('dairy') && !tags.has('ready_meal')) return 0.05;
  return 0.25;
}
// Ray Peat rating: never excludes, only moves a product up or down the list.
function peatRules(it, n, tags) {
  const R = [];
  let d = 0;
  const add = (w, txt) => { d += w; if (txt) R.push({ w, s: txt }); };
  const nm = norm(it.name), c = it.cat;
  const fat = n && n.fat != null && isFinite(+n.fat) ? +n.fat : null;
  const labelPufa = n && n.pufa != null && isFinite(+n.pufa) ? +n.pufa : null;
  const pufa = labelPufa != null ? labelPufa : fat != null ? fat * pufaShare(it, tags) : null;
  if (pufa != null) {
    const amount = `${labelPufa != null ? '' : '~'}${fmtNum(pufa, 1)} g per 100 g${labelPufa != null ? ', etiket' : ', geschat'}`;
    if (pufa >= 5) add(-25, `Veel meervoudig onverzadigd vet (${amount})`);
    else if (pufa >= 2) add(-12, `Vrij veel meervoudig onverzadigd vet (${amount})`);
    else if (pufa >= 1) add(-4, null);
    else if (fat != null && fat >= 3) add(4, 'Vet is vooral verzadigd, weinig PUFA');
  }
  // What Peat favoured.
  if ((/jus d orange|sinaasappelsap|\bsap\b|vruchtensap/.test(nm)) && !/groente/.test(nm)) add(18, 'Vruchtensap: suiker en kalium (Peat-favoriet)');
  else if (c === 'fruit' && !/avocado/.test(nm)) add(/aardbei|\bbes|bessen|framboz|druif|druiven/.test(nm) ? 6 : 12, 'Rijp fruit: suiker en kalium');
  if (c === 'zuivel' || c === 'kaas') {
    if (/melk/.test(nm) && !/chocolade/.test(nm)) add(18, 'Melk: calcium en eiwit (Peat-basis)');
    else if (c === 'kaas') add(15, 'Kaas: calcium en eiwit (Peat-basis)');
    else if (/vla|pudding|toetje/.test(nm)) add(4, 'Zuivel, maar vaak met bindmiddelen');
    else add(10, 'Zuivel: calcium en eiwit');
  }
  if (c === 'ei') add(8, 'Eieren');
  if (tags.has('shellfish')) add(14, 'Schaaldieren: mineralen, weinig PUFA');
  else if ((c === 'vis' || tags.has('fish')) && c !== 'maaltijd') { if (fat != null && fat <= 3) add(10, 'Magere witvis'); else add(-6, 'Vette vis: omega-3 is ook meervoudig onverzadigd'); }
  if (tags.has('beef') && !tags.has('pork') && (c === 'vlees' || c === 'beleg')) {
    if (/stoof|riblap|sukade|schenkel|soepvlees/.test(nm)) add(10, 'Rund om te stoven: gelatine (Peat-tip)');
    else add(6, 'Rundvlees: weinig PUFA');
  }
  if (tags.has('poultry') && c !== 'maaltijd') add(-5, 'Kip en kalkoen: het vet bevat meer PUFA');
  if (tags.has('pork') && !tags.has('beef') && c !== 'maaltijd') add(-5, 'Varkensvlees: het vet bevat meer PUFA');
  if (/\blever\b|kippenlever|runderlever/.test(nm)) add(10, 'Lever: vitamine A (een keer per week)');
  if (/aardappel|krieltjes/.test(nm)) add(8, 'Aardappel: Peat-vriendelijk zetmeel');
  if (/wortel|\bpeen\b|winterpeen/.test(nm)) add(8, 'Wortel, rauw gegeten (Peat-tip)');
  if (/spinazie|boerenkool|snijbiet/.test(nm)) add(-4, 'Blad met veel oxaalzuur');
  // What Peat advised against.
  if (tags.has('soy') || /tofu|tempeh|soja/.test(nm)) add(-18, 'Soja: Peat raadde dit sterk af');
  else if (/hummus|falafel|bonen|linzen|kikkererwt|peulvrucht/.test(nm)) add(-10, 'Peulvruchten: lastig verteerbaar');
  if (tags.has('nuts') || /\bnoot|noten|pinda|zaden|pitten/.test(nm)) add(-12, 'Noten en zaden: veel PUFA');
  if (c === 'brood' || c === 'zetmeel' || tags.has('bakery')) add(tags.has('wholegrain') ? -10 : -5, tags.has('wholegrain') ? 'Volkoren graan: fytaat en vezel' : 'Graanproduct: liever fruit of aardappel');
  if (tags.has('ultraprocessed')) add(-8, 'Ultrabewerkt: vaak bindmiddelen en olie');
  else if (tags.has('ready_meal')) add(-5, 'Kant-en-klaar: olie en toevoegingen onbekend');
  if (n && n.fiber != null && +n.fiber >= 6) add(-4, 'Veel vezel');
  return { d, R };
}
const EATS = { alles: { label: 'Alles' }, flexi: { label: 'Weinig vlees' }, pesco: { label: 'Pescotarisch' }, vega: { label: 'Vegetarisch' }, vegan: { label: 'Veganistisch' } };
const EXCL = [
  ['pork', 'Geen varkensvlees'], ['beef', 'Geen rundvlees'], ['fish', 'Geen vis'], ['shellfish', 'Geen schaaldieren'],
  ['lactose', 'Lactosevrij'], ['dairy', 'Geen zuivel'], ['gluten', 'Glutenvrij'], ['egg', 'Geen ei'],
  ['nuts', 'Notenallergie'], ['soy', 'Geen soja'], ['halal', 'Halal'],
];
const TAG_NL = { meat: 'vlees', poultry: 'gevogelte', pork: 'varkensvlees', beef: 'rundvlees', fish: 'vis', shellfish: 'schaaldieren', dairy: 'zuivel', egg: 'ei', gluten: 'gluten', lactose: 'lactose', nuts: 'noten', soy: 'soja' };
const ALLOWED_TAGS = ['meat', 'poultry', 'pork', 'beef', 'fish', 'shellfish', 'dairy', 'egg', 'gluten', 'lactose', 'nuts', 'soy', 'vegetarian', 'vegan', 'halal_possible', 'processed', 'ultraprocessed', 'wholegrain', 'high_sugar', 'fresh_produce', 'ready_meal', 'bakery', 'seed_oil'];
const CATS = { vlees: 'Vlees', gevogelte: 'Gevogelte', vis: 'Vis', vega: 'Vega', zuivel: 'Zuivel', kaas: 'Kaas', ei: 'Eieren', beleg: 'Beleg', brood: 'Brood', groente: 'Groente', fruit: 'Fruit', maaltijd: 'Maaltijd', salade: 'Salade', zetmeel: 'Pasta en co', overig: 'Overig' };

function defaultProfile() {
  return { goal: 'balanced', eat: 'alles', kcal: 2000, protein: 90, carbsMax: null, excl: {}, avoidUltra: false, freezer: true, persons: 1, budget: 40, notes: '', weight: null, stores: [], filters: defaultFilters(), setAt: null, savedAt: 0 };
}

/* ============================================================
   Wegfilter: ingredients you never want. The seed-oil filter is built in
   and on by default; people can add their own (a name and some words).
   Live AH products are checked on their label; others on name and on what
   that kind of product usually contains.
   ============================================================ */
// High-PUFA seed oils (the "hateful eight" plus sesame and linseed). Olive, palm, coconut,
// avocado and butter are fine and are never matched.
const SEED_OIL_WORDS = ['zonnebloem', 'raapzaad', 'koolzaad', 'canola', 'soja', 'sojabonen', 'mais', 'maiskiem', 'katoenzaad', 'druivenpit', 'saffloer', 'distel', 'rijst', 'rijstzemel', 'rijstzemelen', 'sesam', 'lijnzaad'];
const SEED_OIL_TERMS = ['zonnebloemolie', 'zonnebloempitolie', 'raapzaadolie', 'koolzaadolie', 'canola olie', 'canolaolie', 'sojaolie', 'soja olie', 'sojabonenolie', 'maisolie', 'maiskiemolie', 'katoenzaadolie', 'druivenpitolie', 'saffloerolie', 'distelolie', 'rijstolie', 'rijstzemelolie', 'rijstzemelenolie', 'sesamolie', 'lijnzaadolie', 'sunflower oil', 'rapeseed oil', 'soybean oil', 'corn oil', 'cottonseed oil', 'grapeseed oil', 'safflower oil', 'rice bran oil'];
const SEED_OIL_OK = ['olijf', 'palm', 'kokos', 'avocado', 'shea', 'cacao', 'boter', 'roomboter'];
// Products that nearly always contain seed oil when no label is known.
const SEED_OIL_NAME_RE = /mayonaise|\bmayo\b|fritessaus|frietsaus|halvarine|margarine|frituur|\bchips\b|tortillachips|dressing|saladesaus|hummus|pesto|satesaus|loempia|kroket|bitterbal|frikandel|nugget|falafel|\bwrap|tortilla|\b\w*salade\b(?!.*\bsla\b)/;
const FILTER_PRESETS = {
  pufa: { id: 'pufa', label: 'Zaadoliën (PUFA)', note: 'Zonnebloem, raapzaad (koolzaad), soja, maïs, katoenzaad, druivenpit, saffloer, rijstzemel, sesam en lijnzaad. Olijf, palm, kokos, avocado en boter mogen.' },
};
function defaultFilters() { return [{ id: 'pufa', on: true }]; }
function normalizeFilters(list) {
  const out = [];
  for (const f of Array.isArray(list) ? list : []) {
    if (!f || typeof f !== 'object') continue;
    if (FILTER_PRESETS[f.id]) { if (!out.some(x => x.id === f.id)) out.push({ id: f.id, on: f.on !== false }); continue; }
    const terms = (Array.isArray(f.terms) ? f.terms : String(f.terms || '').split(',')).map(t => norm(t)).filter(t => t.length >= 2).slice(0, 30);
    if (!terms.length) continue;
    out.push({ id: String(f.id || 'f' + uid()), label: String(f.label || terms[0]).slice(0, 40), terms, on: f.on !== false });
  }
  if (!out.some(x => x.id === 'pufa')) out.unshift({ id: 'pufa', on: true });
  return out;
}
// Seed oil in an ingredient list: a named oil, an oil list "(zonnebloem, raapzaad)", or an unnamed
// "plantaardige olie" (usually sunflower or rapeseed). Returns {level, term} or null.
function seedOilHit(text) {
  const t = norm(text);
  if (!t) return null;
  for (const term of SEED_OIL_TERMS) if (t.includes(norm(term))) return { level: 'zeker', term };
  // "plantaardige olie (zonnebloem, raapzaad)", "plantaardige oliën en vetten (palm, zonnebloem)"
  const raw = String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const lists = [...raw.matchAll(/(olie|olien|vet|vetten)[^()]{0,30}\(([^)]*)\)/g)].map(m => m[2]);
  for (const inner of lists) {
    const words = inner.split(/[^a-z]+/).filter(Boolean);
    const seed = words.find(w => SEED_OIL_WORDS.includes(w));
    if (seed) return { level: 'zeker', term: `${seed}olie` };
  }
  if (/plantaardige oli(e|en)\b/.test(t)) {
    const after = raw.slice(raw.search(/plantaardige oli/));
    const m = after.match(/^plantaardige oli[a-z]*[^()]{0,30}\(([^)]*)\)/);
    if (m && m[1].split(/[^a-z]+/).filter(Boolean).every(w => SEED_OIL_OK.includes(w) || ['en', 'in', 'wisselende', 'verhouding', 'olie', 'vet', 'gehard', 'deels'].includes(w))) return null;
    return { level: 'waarschijnlijk', term: 'plantaardige olie (soort niet vermeld)' };
  }
  return null;
}
// Which active filters hit this product. level: 'zeker' (on the label or in the name),
// 'waarschijnlijk' (this kind of product nearly always has it), 'onbekend' (processed, label unknown).
function filterHits(it, P) {
  const out = [];
  const filters = normalizeFilters(P && P.filters);
  const ingr = it.ingr ? String(it.ingr) : '';
  const name = String(it.name || '');
  const tags = new Set(it.tags || []);
  for (const f of filters) {
    if (!f.on) continue;
    if (f.id === 'pufa') {
      const label = FILTER_PRESETS.pufa.label;
      if (ingr) { const hit = seedOilHit(ingr); if (hit) out.push({ id: f.id, label, level: hit.level, term: hit.term, from: 'etiket' }); continue; }
      const byName = seedOilHit(name);
      if (byName) { out.push({ id: f.id, label, level: 'zeker', term: byName.term, from: 'naam' }); continue; }
      if (tags.has('seed_oil') || SEED_OIL_NAME_RE.test(norm(name))) { out.push({ id: f.id, label, level: 'waarschijnlijk', term: 'zaadolie', from: 'soort' }); continue; }
      const processed = tags.has('processed') || tags.has('ultraprocessed') || tags.has('ready_meal') || tags.has('bakery') || ['maaltijd', 'beleg', 'vega', 'salade'].includes(it.cat);
      if (processed && !tags.has('fresh_produce')) out.push({ id: f.id, label, level: 'onbekend', term: null, from: 'soort' });
      continue;
    }
    const hay = norm(name + ' ' + ingr);
    const term = f.terms.find(w => hay.includes(w));
    if (term) out.push({ id: f.id, label: f.label, level: 'zeker', term, from: ingr && norm(ingr).includes(term) ? 'etiket' : 'naam' });
  }
  return out;
}
// Allergens and animal ingredients from an AH label.
function tagsFromIngredients(stmt, contains) {
  const tags = new Set();
  const c = norm(contains), s = norm(stmt);
  const has = (txt, re) => re.test(txt);
  if (c) {
    if (has(c, /\bmelk|lactose|zuivel/)) { tags.add('dairy'); tags.add('lactose'); }
    if (has(c, /\bei\b|\beieren|\beiproduct/)) tags.add('egg');
    if (has(c, /gluten|tarwe|rogge|gerst|spelt|haver|kamut/)) tags.add('gluten');
    if (has(c, /\bsoja/)) tags.add('soy');
    if (has(c, /noten|amandel|hazelno|walno|cashew|pistache|pecan|macadamia|paranoot|pinda|aardnoot/)) tags.add('nuts');
    if (has(c, /\bvis\b/)) tags.add('fish');
    if (has(c, /schaaldier|weekdier|kreeft|garnaal|mossel/)) { tags.add('fish'); tags.add('shellfish'); }
  }
  if (s) {
    if (has(s, /varkensvlees|varkens|\bspek\b|\bham\b|reuzel/)) { tags.add('meat'); tags.add('pork'); }
    if (has(s, /rundvlees|runder|\brund\b|kalfsvlees/)) { tags.add('meat'); tags.add('beef'); }
    if (has(s, /kippenvlees|kipfilet|\bkip\b|kalkoen|gevogelte/)) { tags.add('meat'); tags.add('poultry'); }
    if (has(s, /gelatine/)) tags.add('meat');
    if (has(s, /\bvlees\b/)) tags.add('meat');
  }
  return [...tags];
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
  const fhits = filterHits(it, P);
  const fhard = fhits.filter(x => x.level !== 'onbekend');
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
    } else if (goal === 'peat') {
      // rated below, also when the nutrition is unknown
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
    if (goal !== 'peat') {
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
  }
  if (goal === 'peat') { const pr = peatRules(it, n, tags); fit += pr.d; for (const r of pr.R) add(r.w, r.s); }
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

  for (const x of fhits) if (x.level === 'onbekend') { pins.push(`Wegfilter ${x.label}: ingrediënten onbekend, check het etiket`); capTwijfel = true; }
  // A ranking diet (Ray Peat) is about the food first, the deal second.
  const wFit = G.rank ? 0.75 : 0.6;
  let score = clamp(Math.round(wFit * fit + (1 - wFit) * value - risk), 0, 100);
  let verdict;
  const fmsg = x => x.level === 'zeker'
    ? `Wegfilter ${x.label}: bevat ${x.term}${x.from === 'etiket' ? ' (etiket)' : ''}`
    : `Wegfilter ${x.label}: ${x.from === 'etiket' ? 'bevat ' + x.term : 'zit meestal in dit soort product; check het etiket'}`;
  if (hits.length || fhard.length) {
    verdict = 'nee';
    score = Math.min(score, 10);
    for (const x of fhard.slice().reverse()) pins.unshift(fmsg(x));
    if (hits.length) pins.unshift(`Bevat ${hits.map(t => TAG_NL[t] || t).join(', ')}: dat eet je niet`);
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
// Diets that rank instead of exclude (Ray Peat) name the levels as a rating.
const RANK_NL = { ja: 'Top', twijfel: 'Matig', laten: 'Laag', nee: 'Past niet' };
function verdictName(v, P) { return (GOALS[P && P.goal] || {}).rank ? RANK_NL[v] : VERDICT_NL[v]; }

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
    if (/meervoudig|polyunsat|polyonverzadig/.test(key)) { set('pufa', num); continue; }
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
  const ing = x.ingredients && typeof x.ingredients === 'object' ? x.ingredients : null;
  const tags = new Set([...(strong ? strong.tags : []), ...inferTags(raw), ...(ing ? tagsFromIngredients(ing.s, ing.c) : [])]);
  // A known label decides about seed oil, not what this kind of product usually has.
  if (ing && ing.s) tags.delete('seed_oil');
  if (['meat', 'poultry', 'pork', 'beef', 'fish', 'shellfish'].some(t => tags.has(t))) { tags.delete('vegetarian'); tags.delete('vegan'); }
  else if (['dairy', 'egg', 'lactose'].some(t => tags.has(t))) tags.delete('vegan');
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
    ingr: ing && ing.s ? String(ing.s).slice(0, 1500) : null, allergens: ing && ing.c ? String(ing.c).slice(0, 300) : null,
  };
}

/* ============================================================
   Markdown history: how far and how fast stickers drop, per store
   and product, so the app can say "buy now" or "wait".

   history = { v, offers: { key: offer }, fetches: { storeKey: [ts] }, agg }
   offer   = { s: store, p: productId, c: category, n: name, e: expiry date ('' if unknown),
               w: normal price, f: first seen, l: last seen,
               g: first look at which it was missing (sold out or taken away) or null,
               o: [[ts, pct, priceNow, stock, lastSeenTs], ...] (one row per change;
                   lastSeenTs is the last look at which that row still held) }
   agg     = outcomes of offers older than a week, folded into counters so
             the history can cover many weeks without growing:
             { key: { bucket: { up, gone, lv: { toPct: { n, hh: { quarterHour: n }, ds, dn } } } } }
             keys: sp:store|product, p:product (all stores), sc:store|category, c:category, s:store, all
   prod    = per product, also folded: { productId: { n: name, c, f, t: last seen, lo: lowest price,
               w: normal price, s: [stores], k: offers seen, mx: { deepest discount: offers } } }
   ============================================================ */
const HISTORY_DAYS = 120, HISTORY_RAW_DAYS = 7, HISTORY_MAX = 8000;
const GONE_GAP_MS = 2 * 3600000; // a disappearance only counts if the last sighting was at most this long before
const STEP_GAP_MS = 3 * 3600000; // a step only gets a time of day if the looks before and after are this close
function pctBucket(p) { return p == null || !isFinite(p) ? null : Math.max(0, Math.min(95, Math.round(p / 5) * 5)); }
function offerKey(storeKey, productId, expDate) { return `${storeKey}|${productId}|${expDate || ''}`; }
function median(a) { const b = (a || []).filter(v => v != null && isFinite(v)).sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }
function rawExpiry(x) { return typeof x.expDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x.expDate) ? x.expDate.slice(0, 10) : ''; }
function recordObservations(hist, payload, now) {
  hist = hist && typeof hist === 'object' ? hist : {};
  hist.v = 2; hist.offers = hist.offers || {}; hist.fetches = hist.fetches || {}; hist.agg = hist.agg || {};
  if (!payload || !payload.storeKey || !Array.isArray(payload.items)) return hist;
  const sk = payload.storeKey;
  const t = now || payload.fetchedAt || Date.now();
  // One observation per offer: the same product and date listed twice counts once (deepest discount, stock added up).
  const one = new Map();
  for (const x of payload.items) {
    if (x == null || x.productId == null) continue;
    const it = itemFromAH(Object.assign({}, x, { storeKey: sk }));
    const e = rawExpiry(x);
    const k = offerKey(sk, x.productId, e);
    const prev = one.get(k);
    if (!prev) one.set(k, { it, e, x, stock: it.stock });
    else {
      const sum = (prev.stock ?? 0) + (it.stock ?? 0);
      if ((it.discountPct ?? -1) > (prev.it.discountPct ?? -1)) one.set(k, { it, e, x, stock: sum }); else prev.stock = sum;
    }
  }
  for (const [k, { it, e, x, stock }] of one) {
    let o = hist.offers[k];
    if (!o) o = hist.offers[k] = { s: sk, p: x.productId, c: it.cat, n: it.name, e, w: it.priceNormal, f: t, l: t, g: null, o: [] };
    const last = o.o[o.o.length - 1];
    const obs = [t, it.discountPct, it.priceNow, stock ?? null, t];
    if (!last || last[1] !== obs[1] || last[2] !== obs[2] || last[3] !== obs[3]) o.o.push(obs);
    else last[4] = t;
    if (o.o.length > 40) o.o.splice(1, o.o.length - 40);
    o.l = Math.max(o.l, t); o.g = null;
    if (it.priceNormal > 0) o.w = it.priceNormal;
  }
  // Offers this store had at the previous look that are missing now: sold out or taken off the shelf.
  // An empty answer while there were offers before is more likely a hiccup than an empty shelf: skip.
  const before = Object.values(hist.offers).filter(o => o.s === sk && o.g == null && o.l < t);
  if (one.size || before.length < 3) for (const o of before) if (!one.has(offerKey(o.s, o.p, o.e))) o.g = t;
  const fl = hist.fetches[sk] = hist.fetches[sk] || [];
  fl.push(t);
  if (fl.length > 300) fl.splice(0, fl.length - 300);
  return hist;
}
// What one offer says, per discount level it was seen at: went deeper (to which level, at what time
// of day, after how long) or was gone first. Unknown outcomes are left out: still on the shelf at the
// last look, or missing only after a long gap in which the price may well have dropped first.
function offerOutcomes(o) {
  const obs = o.o || [], out = [];
  const firsts = [];
  obs.forEach((ob, i) => { const b = pctBucket(ob[1]); if (b != null && (!firsts.length || firsts[firsts.length - 1].b !== b)) firsts.push({ b, t: ob[0], i }); });
  const done = new Set();
  firsts.forEach((cur, j) => {
    if (done.has(cur.b)) return; // one vote per level per offer
    done.add(cur.b);
    const higher = firsts.slice(j + 1).find(x => x.b > cur.b);
    if (higher) {
      const prev = higher.i > 0 ? obs[higher.i - 1] : null;
      const prevT = prev ? (prev[4] || prev[0]) : cur.t;
      const close = higher.t - prevT <= STEP_GAP_MS && new Date(prevT).toDateString() === new Date(higher.t).toDateString();
      const tt = (prevT + higher.t) / 2, d = new Date(tt);
      out.push({ b: cur.b, up: true, to: higher.b, h: close ? d.getHours() + d.getMinutes() / 60 : null, dt: Math.max(0, (tt - cur.t) / 3600000) });
    } else if (o.g != null && o.g - o.l <= GONE_GAP_MS) out.push({ b: cur.b, up: false });
  });
  return out;
}
function offerAggKeys(o) { return [`sp:${o.s}|${o.p}`, `p:${o.p}`, `sc:${o.s}|${o.c}`, `c:${o.c}`, `s:${o.s}`, 'all']; }
function offerMaxPct(o) { let m = null; for (const r of o.o || []) { const b = pctBucket(r[1]); if (b != null && (m == null || b > m)) m = b; } return m; }
function offerLowPrice(o) { let m = null; for (const r of o.o || []) if (r[2] != null && isFinite(r[2]) && r[2] > 0 && (m == null || r[2] < m)) m = r[2]; return m; }
// Add one offer to a per-product summary (deepest discount it reached, lowest price, stores).
function addProductOffer(P, o) {
  const mx = offerMaxPct(o), lo = offerLowPrice(o);
  if (!P.n || (o.l || 0) >= (P.t || 0)) { if (o.n) P.n = o.n; if (o.c) P.c = o.c; if (o.w > 0) P.w = o.w; }
  P.t = Math.max(P.t || 0, o.l || 0);
  P.f = Math.min(P.f || Infinity, o.f || o.l || Infinity);
  if (lo != null && (P.lo == null || lo < P.lo)) P.lo = lo;
  P.s = P.s || [];
  if (o.s && !P.s.includes(o.s)) { P.s.push(o.s); if (P.s.length > 40) P.s.shift(); }
  P.k = (P.k || 0) + 1;
  P.mx = P.mx || {};
  if (mx != null) P.mx[mx] = (P.mx[mx] || 0) + 1;
  return P;
}
function mergeOutcomeBucket(dst, src) {
  dst.up += src.up || 0; dst.gone += src.gone || 0;
  for (const to in src.lv || {}) {
    const a = src.lv[to], L = dst.lv[to] = dst.lv[to] || { n: 0, hh: {}, ds: 0, dn: 0 };
    L.n += a.n || 0; L.ds += a.ds || 0; L.dn += a.dn || 0;
    for (const q in a.hh || {}) L.hh[q] = (L.hh[q] || 0) + a.hh[q];
  }
}
// Histories from before the per-product key: add up the per-store product counters once.
function productKeysFromStores(agg, seen) {
  for (const key of Object.keys(agg)) {
    if (!key.startsWith('sp:')) continue;
    const pk = 'p:' + key.slice(key.indexOf('|') + 1);
    for (const b in agg[key]) { const K = agg[pk] = agg[pk] || {}; mergeOutcomeBucket(K[b] = K[b] || { up: 0, gone: 0, lv: {} }, agg[key][b]); }
    if (seen) seen[pk] = Math.max(seen[pk] || 0, seen[key] || 0);
  }
}
function addOutcome(acc, key, r) {
  const K = acc[key] = acc[key] || {};
  const B = K[r.b] = K[r.b] || { up: 0, gone: 0, lv: {} };
  if (!r.up) { B.gone++; return; }
  B.up++;
  const L = B.lv[r.to] = B.lv[r.to] || { n: 0, hh: {}, ds: 0, dn: 0 };
  L.n++;
  if (r.h != null) { const q = Math.min(95, Math.floor(r.h * 4)); L.hh[q] = (L.hh[q] || 0) + 1; }
  if (r.dt != null) { L.ds += r.dt; L.dn++; }
}
// Fold offers older than a week (or beyond the size cap) into the counters, drop very old counters.
function pruneHistory(hist, now) {
  if (!hist || !hist.offers) return hist;
  const t = now || Date.now();
  hist.agg = hist.agg || {};
  hist.aggSeen = hist.aggSeen || {};
  hist.prod = hist.prod || {};
  if (!hist.pv) { productKeysFromStores(hist.agg, hist.aggSeen); hist.pv = 1; }
  const fold = o => {
    for (const r of offerOutcomes(o)) for (const key of offerAggKeys(o)) { addOutcome(hist.agg, key, r); hist.aggSeen[key] = t; }
    if (o.p != null) addProductOffer(hist.prod[o.p] = hist.prod[o.p] || {}, o);
  };
  const rawCut = t - HISTORY_RAW_DAYS * 86400000;
  for (const k in hist.offers) { const o = hist.offers[k]; if (o.l < rawCut) { fold(o); delete hist.offers[k]; } }
  const keys = Object.keys(hist.offers);
  if (keys.length > HISTORY_MAX) keys.sort((a, b) => hist.offers[a].l - hist.offers[b].l).slice(0, keys.length - HISTORY_MAX).forEach(k => { fold(hist.offers[k]); delete hist.offers[k]; });
  const aggCut = t - HISTORY_DAYS * 86400000;
  for (const key in hist.aggSeen) if (hist.aggSeen[key] < aggCut) { delete hist.agg[key]; delete hist.aggSeen[key]; }
  for (const pid in hist.prod) if (!(hist.prod[pid].t >= aggCut)) delete hist.prod[pid];
  for (const sk in hist.fetches) hist.fetches[sk] = hist.fetches[sk].filter(x => x >= rawCut);
  return hist;
}
// Merge a history read from disk with one held in memory (the app and the widget can both write it).
function mergeHistory(disk, mem) {
  if (!disk || !disk.offers) return mem;
  if (!mem || !mem.offers) return disk;
  const out = { v: 2, offers: {}, fetches: {}, agg: disk.agg || {}, aggSeen: disk.aggSeen || {}, prod: disk.prod || {}, pv: disk.pv };
  const cut = Date.now() - HISTORY_RAW_DAYS * 86400000;
  for (const k of new Set([...Object.keys(disk.offers), ...Object.keys(mem.offers)])) {
    const a = disk.offers[k], b = mem.offers[k];
    if (!a) { if (b.l >= cut) out.offers[k] = b; continue; } // older ones were folded into disk.agg already
    if (!b) { out.offers[k] = a; continue; }
    const rows = new Map();
    for (const r of [...a.o, ...b.o]) { const prev = rows.get(r[0]); rows.set(r[0], prev ? [r[0], r[1], r[2], r[3], Math.max(prev[4] || 0, r[4] || 0)] : r.slice()); }
    const o = Object.assign({}, a, { f: Math.min(a.f, b.f), l: Math.max(a.l, b.l), o: [...rows.values()].sort((x, y) => x[0] - y[0]).slice(-40) });
    const g = [a.g, b.g].filter(x => x != null && x >= o.l);
    o.g = g.length ? Math.min(...g) : null;
    out.offers[k] = o;
  }
  for (const sk of new Set([...Object.keys(disk.fetches || {}), ...Object.keys(mem.fetches || {})])) {
    out.fetches[sk] = [...new Set([...(disk.fetches[sk] || []), ...(mem.fetches[sk] || [])])].sort((x, y) => x - y).slice(-300);
  }
  return out;
}
function buildTimingStats(hist) {
  const out = { v: 3, offers: 0, stores: {}, keys: {}, prod: {} };
  if (!hist || !hist.offers) return out;
  const acc = JSON.parse(JSON.stringify(hist.agg || {}));
  if (!hist.pv) productKeysFromStores(acc, null);
  const prod = JSON.parse(JSON.stringify(hist.prod || {}));
  for (const k in hist.offers) {
    const o = hist.offers[k];
    if (!o.o || !o.o.length) continue;
    out.offers++;
    out.stores[o.s] = (out.stores[o.s] || 0) + 1;
    for (const r of offerOutcomes(o)) for (const key of offerAggKeys(o)) addOutcome(acc, key, r);
    if (o.p != null) addProductOffer(prod[o.p] = prod[o.p] || {}, o);
  }
  // Per-product summary for the cards and the Logboek; the most followed products first.
  const plist = Object.keys(prod).filter(id => prod[id].n).sort((a, b) => (prod[b].k || 0) - (prod[a].k || 0) || (prod[b].t || 0) - (prod[a].t || 0)).slice(0, 1200);
  for (const id of plist) { const P = prod[id]; out.prod[id] = { n: P.n, c: P.c || null, f: isFinite(P.f) ? P.f : null, t: P.t || null, lo: P.lo ?? null, w: P.w ?? null, ns: (P.s || []).length, k: P.k || 0, mx: P.mx || {} }; }
  for (const key in hist.agg || {}) if (key === 'all') for (const b in hist.agg.all) out.folded = (out.folded || 0) + hist.agg.all[b].up + hist.agg.all[b].gone;
  const r1 = v => v == null ? null : Math.round(v * 10) / 10;
  for (const key in acc) {
    for (const b in acc[key]) {
      const B = acc[key][b], n = B.up + B.gone;
      if (key.startsWith('sp:') && n < 2) continue; // single sightings per store: the p: key holds them
      // The next level is the most common one (a median of 40 and 70 would be a 55% that never happens);
      // its time of day and wait come from the cases that went to that level.
      let to = null, best = 0;
      for (const lv in B.lv) { const c = B.lv[lv].n; if (c > best || (c === best && +lv > to)) { best = c; to = +lv; } }
      const L = to != null ? B.lv[to] : null;
      let h = null;
      if (L) {
        const bins = Object.keys(L.hh).map(Number).sort((x, y) => x - y), total = bins.reduce((s2, q) => s2 + L.hh[q], 0);
        let run = 0;
        for (const q of bins) { run += L.hh[q]; if (run * 2 >= total) { h = (q + 0.5) / 4; break; } }
      }
      (out.keys[key] = out.keys[key] || {})[b] = { n, up: B.up, h: r1(h), to, dt: L && L.dn ? r1(L.ds / L.dn) : null };
    }
  }
  return out;
}
function fmtHour(h) { let H = Math.floor(h), M = Math.round((h - H) * 4) * 15; if (M === 60) { H += 1; M = 0; } return `${String(H % 24).padStart(2, '0')}:${String(M).padStart(2, '0')}`; }
// Buy now or wait? Starts from this product's own history (in this store, else in all your stores).
// While the product has few cases (under 6), the pattern of other products of its kind weighs in,
// like 3 extra cases at first and less with every case of its own.
// seenAt: when this price was seen (old data cannot prove a drop "did not happen").
const PRIOR_WEIGHT = 3;
function timingAdvice(it, stats, now, seenAt) {
  if (!it || it.discountPct == null || !(it.priceNormal > 0)) return null;
  const st = expState(it);
  if (st === 'verlopen') return null;
  const p = pctBucket(it.discountPct);
  if (p >= 70) return { kind: 'nu', text: 'Dit is al de hoogste korting die AH meestal geeft; wachten levert weinig op.' };
  const catName = it.cat && CATS[it.cat] ? CATS[it.cat].toLowerCase() : 'dit soort product';
  const K = (stats && stats.keys) || {};
  const at = key => (key && K[key] && K[key][p]) || null;
  const hasPid = it.productId != null && it.productId !== '';
  const sp = it.storeKey && hasPid ? at(`sp:${it.storeKey}|${it.productId}`) : null;
  const pa = hasPid ? at(`p:${it.productId}`) : null;
  let prod = null, prodLabel = '';
  if (sp && (sp.n >= 3 || !pa || sp.n >= pa.n)) { prod = sp; prodLabel = 'dit product in deze winkel'; }
  else if (pa) { prod = pa; prodLabel = pa.n > (sp ? sp.n : 0) && it.storeKey ? 'dit product in je winkels' : 'dit product'; }
  const chain = [
    [it.storeKey ? `sc:${it.storeKey}|${it.cat}` : null, `${catName} in deze winkel`, 5],
    [`c:${it.cat}`, `${catName} in je winkels`, 8],
    [it.storeKey ? `s:${it.storeKey}` : null, 'koopjes in deze winkel', 8],
    ['all', 'koopjes in je winkels', 10],
  ];
  let prior = null, priorLabel = '';
  for (const [key, label, min] of chain) {
    const B = at(key);
    if (!B || B.n < min) continue;
    // Leave this product's own cases out of the general pattern (they are counted already).
    const own = key.startsWith('sc:') || key.startsWith('s:') ? sp : (pa || sp);
    const up = B.up - (own ? own.up : 0), n = B.n - (own ? own.n : 0);
    if (n >= 3) { prior = { up, n, to: B.to, h: B.h, dt: B.dt }; priorLabel = own ? label.replace(/ in (deze|je) winkel(s?)$/, ' (andere producten) in $1 winkel$2') : label; }
    break;
  }
  const tNow = now || Date.now();
  const dNow = new Date(tNow), hourNow = dNow.getHours() + dNow.getMinutes() / 60;
  const fresh = seenAt == null || tNow - seenAt <= 3600000;
  if (!prod && !prior) {
    // Only for live AH bargains on a dynamic step; the fixed 35% sticker does not move.
    if (stats && it.source === 'ah' && it.storeKey && p !== 35 && st === 'vandaag' && p <= 40 && hourNow < 18) return { kind: 'info', weak: true, text: 'AH verhoogt de korting door de dag heen (25%, 40%, tot 70%). Dit product is nog te weinig gevolgd om te zeggen of het die haalt.' };
    return null;
  }
  // Chance it drops further: the product's own count, pulled towards the general pattern while it is small.
  const base = prior ? prior.up / prior.n : 0.5;
  const w = prod ? Math.max(0, PRIOR_WEIGHT - prod.n / 2) : 0;
  const raw = prod ? (prod.up + w * base) / (prod.n + w) : base;
  // Where and when it goes: the product's own next step when it has one.
  const src = prod && prod.up > 0 && prod.to != null ? prod : prior || prod;
  const nextTo = src && src.to, nextH = src ? src.h : null, nextDt = src ? src.dt : null;
  const lastOne = it.stock != null && it.stock <= 1;
  const late = fresh && nextH != null && st === 'vandaag' && hourNow > nextH + 1.5;
  let pUp = raw;
  if (lastOne) pUp *= 0.75;
  if (late) pUp *= 0.4;
  const nextPct = nextTo || Math.min(70, p + 15);
  const save = round2((itemPriceNow(it) || 0) - round2(it.priceNormal * (1 - nextPct / 100)));
  const when = nextH != null ? ` rond ${fmtHour(nextH)}` : nextDt != null ? ` na zo'n ${Math.max(1, Math.round(nextDt))} uur` : '';
  const kans = Math.round(pUp * 100), one = lastOne ? ' Er ligt er nog maar één.' : '';
  const Up = x => x[0].toUpperCase() + x.slice(1);
  // The evidence: this product first, then the general pattern when it still counts.
  const ev = [];
  if (prod) {
    const gone = prod.n - prod.up;
    ev.push(`${Up(prodLabel)}: ${prod.up} van de ${prod.n} keer verder gezakt${prod.up && prod.to ? ` (meestal naar ${prod.to}%${prod.h != null ? ` rond ${fmtHour(prod.h)}` : ''})` : ''}${gone ? `, ${gone}× eerst op` : ''}.`);
  } else ev.push('Dit product is op deze korting nog niet gevolgd.');
  if (prior && (!prod || w > 0)) ev.push(`${Up(priorLabel)}: ${Math.round(prior.up / prior.n * 100)}% zakte verder (${prior.n}×).`);
  const stale = !fresh && seenAt ? ` Prijs van ${fmtHour(new Date(seenAt).getHours() + new Date(seenAt).getMinutes() / 60)}.` : '';
  const tail = `${one} ${ev.join(' ')}${stale}`;
  const out = (kind, head) => ({ kind, p: pUp, save, own: prod ? prod.n : 0, text: head + tail });
  if (late && pUp < 0.6) return out('nu', `Meestal zakt hij${when} verder, en dat moment is al voorbij zonder dat het gebeurde.`);
  if (pUp >= 0.6 && save >= 0.3) return out('wacht', `${kans}% kans dat hij${when} naar ${nextPct}% zakt: ${fmtEur(save)} goedkoper.`);
  if (pUp >= 0.6) return out('nu', `Hij zakt waarschijnlijk nog naar ${nextPct}%${when}, maar dat scheelt maar ${fmtEur(Math.max(0, save))}.`);
  if (pUp <= 0.4) return out('nu', `Kleine kans (${kans}%) dat hij eerst nog verder zakt.`);
  return out('gok', `${kans}% kans dat hij${when} naar ${nextPct}% zakt (${fmtEur(Math.max(0, save))} goedkoper), maar hij kan ook eerder op zijn.`);
}
