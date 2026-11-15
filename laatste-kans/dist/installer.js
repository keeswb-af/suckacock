// Installeert of werkt "Laatste Kans" bij
const url = 'https://raw.githubusercontent.com/keeswb-af/suckacock/claude/optimistic-babbage-atkmd2/laatste-kans/dist/LaatsteKans.js';
const req = new Request(url);
const code = await req.loadString();
if (!/Laatste Kans/.test(code)) throw new Error('Download mislukt');
let fm; try { fm = FileManager.iCloud(); fm.documentsDirectory(); } catch (e) { fm = FileManager.local(); }
fm.writeString(fm.joinPath(fm.documentsDirectory(), 'Laatste Kans.js'), code);
const a = new Alert();
a.title = 'Geïnstalleerd';
a.message = 'Open nu het script "Laatste Kans" in Scriptable.';
await a.present();
