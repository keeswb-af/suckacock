#!/usr/bin/env python3
"""Build the app from src/ and data/*.json.

Sources
  src/page.html       markup and style, with slots for the scripts
  src/engine.js       pure logic: diet scoring, food matching, AH item conversion
  src/ui.js           screens, storage, Claude features, host bridge
  src/scriptable.js   the Scriptable (iPhone) wrapper that fetches AH bargains live

Outputs
  dist/artifact.html    page fragment for publishing as a claude.ai Artifact
  dist/index.html       standalone page for any static host
  dist/LaatsteKans.js   Scriptable script (embeds dist/index.html)
  dist/installer.js     the few lines a user pastes into Scriptable once
"""
import hashlib
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "src"
SCRIPT_URL = "https://raw.githubusercontent.com/keeswb-af/suckacock/claude/optimistic-babbage-atkmd2/laatste-kans/dist/LaatsteKans.js"
DATA = ROOT / "data"
DIST = ROOT / "dist"

CATS = {"vlees", "gevogelte", "vis", "vega", "zuivel", "kaas", "ei", "beleg", "brood",
        "groente", "fruit", "maaltijd", "salade", "zetmeel", "overig"}
TAGS = {"meat", "poultry", "pork", "beef", "fish", "shellfish", "dairy", "egg", "gluten",
        "lactose", "nuts", "soy", "vegetarian", "vegan", "halal_possible", "processed",
        "ultraprocessed", "wholegrain", "high_sugar", "fresh_produce", "ready_meal", "bakery"}
NUM = ["kcal", "protein", "carbs", "sugar", "fat", "satfat", "fiber", "salt", "pack_g", "price_eur"]


def load(name):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def check_food(food):
    seen = set()
    for f in food:
        assert f["id"] not in seen, f"duplicate id {f['id']}"
        seen.add(f["id"])
        assert f["cat"] in CATS, f"{f['id']}: bad cat {f['cat']}"
        bad = set(f["tags"]) - TAGS
        assert not bad, f"{f['id']}: bad tags {bad}"
        for k in NUM:
            v = f.get(k)
            assert isinstance(v, (int, float)) and v >= 0, f"{f['id']}: bad {k}={v!r}"
        assert f["kcal"] < 950 and f["protein"] <= 100 and f["carbs"] <= 100 and f["fat"] <= 100, f["id"]
        # Energy sanity: Atwater estimate within 30% (+25 kcal slack) of stated kcal.
        est = 4 * f["protein"] + 4 * f["carbs"] + 9 * f["fat"] + 2 * f["fiber"]
        assert abs(est - f["kcal"]) <= 0.3 * f["kcal"] + 25, f"{f['id']}: kcal {f['kcal']} vs macros {est:.0f}"
        assert f["sugar"] <= f["carbs"] + 0.5, f"{f['id']}: sugar > carbs"
        assert f["satfat"] <= f["fat"] + 0.5, f"{f['id']}: satfat > fat"
        assert isinstance(f["freezable"], bool), f["id"]


ROLES = {"eiwit", "zetmeel", "groente", "fruit", "brood", "zuivel"}
CHAINS = {"ah", "jumbo", "lidl"}


def check_staples(st):
    """Staples for the day plan: nutrition per 100 g (or ml), prices per chain, and the day template."""
    assert st.get("checked") and st.get("source"), "staples need a price date and source"
    ids = {}
    for s in st["items"]:
        sid = s["id"]
        assert sid not in ids, f"duplicate staple {sid}"
        ids[sid] = s
        assert s["unit"] in ("g", "ml", "st"), f"{sid}: unit"
        if s["unit"] == "st":
            assert s.get("per", 0) > 0 and s.get("one") and s.get("many"), f"{sid}: pieces need per/one/many"
        bad = set(s["tags"]) - TAGS
        assert not bad, f"{sid}: bad tags {bad}"
        for k in ("kcal", "protein", "carbs", "fat", "fiber"):
            assert isinstance(s.get(k), (int, float)) and s[k] >= 0, f"{sid}: bad {k}"
        est = 4 * s["protein"] + 4 * s["carbs"] + 9 * s["fat"] + 2 * s["fiber"]
        assert abs(est - s["kcal"]) <= 0.3 * s["kcal"] + 25, f"{sid}: kcal {s['kcal']} vs macros {est:.0f}"
        lo, hi, step = s["scale"]
        assert 0 <= lo <= hi and step > 0, f"{sid}: scale"
        assert s["offers"], f"{sid}: no prices"
        for chain, o in s["offers"].items():
            assert chain in CHAINS, f"{sid}: chain {chain}"
            assert o["product"] and o["pack"] > 0 and 0 < o["price"] < 50, f"{sid}: offer {chain}"
    for meal in st["plan"]["meals"]:
        assert meal["id"] and meal["name"] and meal["slots"], "meal"
        for slot in meal["slots"]:
            lists = [slot.get("items"), slot.get("lc"), slot.get("keto")] + list(slot.get("rot", {}).values()) + [[a] for a in slot.get("alt", [])]
            if "rot" in slot:
                assert set(slot["rot"]) == {str(d) for d in range(7)}, f"{meal['id']}: rotation needs all 7 days"
            else:
                assert slot.get("items") or "lc" in slot or "keto" in slot, f"{meal['id']}: slot without items"
            assert isinstance(slot.get("min", 0), (int, float)) and isinstance(slot.get("optional", False), bool), f"{meal['id']}: min/optional"
            for lst in lists:
                for entry in lst or []:
                    sid, amount = entry[0], entry[1]
                    assert sid in ids, f"{meal['id']}: unknown staple {sid}"
                    lo, hi, _ = ids[sid]["scale"]
                    assert lo <= amount <= hi, f"{meal['id']}: {sid} {amount} outside {lo}-{hi}"
                    assert len(entry) == 2 or entry[2] == "vast", f"{meal['id']}: {entry}"
            assert slot.get("flex") in (None, "prot", "kcal"), f"{meal['id']}: flex"
            assert slot.get("role") in (None, *ROLES), f"{meal['id']}: role"
            assert slot.get("needs") in (None, *ids), f"{meal['id']}: needs"


def main():
    food = load("food.json")
    stores = load("stores.json")
    tips = load("tips.json")
    safety = load("safety.json")
    staples = load("staples.json")
    check_food(food)
    check_staples(staples)
    for s in stores:
        for k in ("id", "name", "street", "postcode"):
            assert s.get(k), f"store missing {k}: {s}"
    data_js = "\n".join([
        "const FOOD = " + json.dumps(food, ensure_ascii=False, separators=(",", ":")) + ";",
        "const STORES = " + json.dumps(stores, ensure_ascii=False, separators=(",", ":")) + ";",
        "const TIPS = " + json.dumps(tips, ensure_ascii=False, separators=(",", ":")) + ";",
        "const SAFETY = " + json.dumps(safety, ensure_ascii=False, separators=(",", ":")) + ";",
        "const STAPLES = " + json.dumps(staples, ensure_ascii=False, separators=(",", ":")) + ";",
    ])
    engine = (SRC / "engine.js").read_text(encoding="utf-8")
    ui = (SRC / "ui.js").read_text(encoding="utf-8").replace("@@SCRIPT_URL@@", SCRIPT_URL)
    tpl = (SRC / "page.html").read_text(encoding="utf-8")
    for slot in ("/*@@DATA@@*/", "/*@@ENGINE@@*/", "/*@@UI@@*/"):
        assert tpl.count(slot) == 1, slot
    page = tpl.replace("/*@@DATA@@*/", data_js).replace("/*@@ENGINE@@*/", engine).replace("/*@@UI@@*/", ui)
    DIST.mkdir(exist_ok=True)
    (DIST / "artifact.html").write_text(page, encoding="utf-8")
    standalone = (
        "<!doctype html>\n<html lang=\"nl\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n"
        "<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n"
        "<meta name=\"mobile-web-app-capable\" content=\"yes\">\n"
        "<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"default\">\n"
        "<meta name=\"apple-mobile-web-app-title\" content=\"Laatste Kans\">\n"
        "<link rel=\"apple-touch-icon\" href=\"icon-180.png\">\n"
        "<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}"
        "body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n"
        "</head>\n<body>\n" + page + "\n</body>\n</html>\n"
    )
    (DIST / "index.html").write_text(standalone, encoding="utf-8")
    version = "v" + hashlib.sha1((standalone + (SRC / "scriptable.js").read_text(encoding="utf-8")).encode()).hexdigest()[:8]
    app_html = json.dumps(standalone, ensure_ascii=False).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    sc = (SRC / "scriptable.js").read_text(encoding="utf-8")
    for slot in ("/*@@DATA@@*/", "/*@@ENGINE@@*/", "/*@@APP_HTML@@*/''"):
        assert sc.count(slot) == 1, slot
    sc = sc.replace("/*@@DATA@@*/", data_js).replace("/*@@ENGINE@@*/", engine).replace("/*@@APP_HTML@@*/''", app_html)
    sc = sc.replace("@@VERSION@@", version).replace("@@SCRIPT_URL@@", SCRIPT_URL)
    (DIST / "LaatsteKans.js").write_text(sc, encoding="utf-8")
    start = ui.index("const INSTALLER = `") + len("const INSTALLER = `")
    installer = ui[start:ui.index("`;", start)].replace("${SCRIPT_URL}", SCRIPT_URL)
    (DIST / "installer.js").write_text(installer + "\n", encoding="utf-8")
    for name in ("artifact.html", "index.html", "LaatsteKans.js", "installer.js"):
        text = (DIST / name).read_text(encoding="utf-8")
        assert "\u2014" not in text, f"em dash in {name}"
        assert "@@" not in text.replace("@@DATA@@", ""), f"unfilled slot in {name}"
    print(f"built {version}: {len(food)} foods, {len(staples['items'])} staples, {len(stores)} stores, page {len(page)//1024} KB, Scriptable {len(sc)//1024} KB")


if __name__ == "__main__":
    main()
