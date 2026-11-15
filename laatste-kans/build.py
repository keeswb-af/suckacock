#!/usr/bin/env python3
"""Build the app from src/app.html and data/*.json.

Outputs
  dist/artifact.html  page fragment for publishing as a claude.ai Artifact
  dist/index.html     standalone page for any static host (GitHub Pages, Netlify)
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "src" / "app.html"
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


def main():
    food = load("food.json")
    stores = load("stores.json")
    tips = load("tips.json")
    safety = load("safety.json")
    check_food(food)
    for s in stores:
        for k in ("id", "name", "street", "postcode"):
            assert s.get(k), f"store missing {k}: {s}"
    data_js = "\n".join([
        "const FOOD = " + json.dumps(food, ensure_ascii=False, separators=(",", ":")) + ";",
        "const STORES = " + json.dumps(stores, ensure_ascii=False, separators=(",", ":")) + ";",
        "const TIPS = " + json.dumps(tips, ensure_ascii=False, separators=(",", ":")) + ";",
        "const SAFETY = " + json.dumps(safety, ensure_ascii=False, separators=(",", ":")) + ";",
    ])
    src = SRC.read_text(encoding="utf-8")
    assert "/*@@DATA@@*/" in src
    page = src.replace("/*@@DATA@@*/", data_js)
    assert "—" not in page, "em dash found"
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
    print(f"built: {len(food)} foods, {len(stores)} stores, {len(page)//1024} KB")


if __name__ == "__main__":
    main()
