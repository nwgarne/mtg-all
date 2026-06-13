#!/usr/bin/env python3
"""Build per-year data for mtg-all.dirtyshoulders.com from the Scryfall default_cards
bulk export (streamed, constant memory). Groups every printing by release year, then by
card-type category (decklist-style). Writes site/data/<year>.json + site/data/years.json
(homepage index, with each year's highest-value 'title card')."""
import json, os, datetime
from collections import defaultdict

BULK = os.environ.get("BULK", "default-cards.json")  # Scryfall default_cards bulk export
OUT = os.environ.get("OUT", "build/data")

CATEGORY_ORDER = ["Legendary Creatures", "Creatures", "Planeswalkers", "Artifacts",
                  "Enchantments", "Instants", "Sorceries", "Lands", "Art Cards", "Other"]

def categorize(tl):
    leg = "Legendary" in tl
    if "Creature" in tl:   return "Legendary Creatures" if leg else "Creatures"
    if "Planeswalker" in tl: return "Planeswalkers"
    if "Land" in tl:       return "Lands"
    if "Artifact" in tl:   return "Artifacts"
    if "Enchantment" in tl: return "Enchantments"
    if "Instant" in tl:    return "Instants"
    if "Sorcery" in tl:    return "Sorceries"
    return "Other"

def fval(s):
    try: return float(s)
    except (TypeError, ValueError): return 0.0

def imgs(c):
    # Returns (small, normal, art_crop, back_normal). back_normal is set only for true
    # double-faced cards (transform / modal DFC) where the second face has its own image.
    faces = c.get("card_faces") or []
    front = c.get("image_uris")
    back = ""
    if not front and faces:
        front = faces[0].get("image_uris")
        if len(faces) >= 2 and faces[1].get("image_uris"):
            back = faces[1]["image_uris"].get("normal", "")
    front = front or {}
    return front.get("small", ""), front.get("normal", ""), front.get("art_crop", ""), back

# year -> category -> [card records]; plus per-year sets + title card
by_year = defaultdict(lambda: defaultdict(list))
year_sets = defaultdict(set)
year_value = defaultdict(float)
year_title = {}  # year -> (value, record)
year_setinfo = defaultdict(lambda: defaultdict(lambda: {"name": "", "count": 0, "topval": -1.0, "art": "", "top": "", "topval2": -1.0, "art2": "", "top2": ""}))  # year -> set -> top-card (+ distinct-art runner-up) + counts

with open(BULK) as f:
    for line in f:
        line = line.strip()
        if not line or line in ("[", "]"):
            continue
        if line.endswith(","):
            line = line[:-1]
        try:
            c = json.loads(line)
        except json.JSONDecodeError:
            continue
        rel = c.get("released_at") or ""
        if len(rel) < 4:
            continue
        year = rel[:4]
        small, normal, art, back = imgs(c)
        faces = c.get("card_faces") or []
        # Double-faced cards carry no top-level type_line; fall back to the FRONT face's
        # type so a DFC creature lands under Creatures, not the catch-all "Other" bucket.
        tl = c.get("type_line") or (faces[0].get("type_line", "") if faces else "")
        usd, usdf = c.get("prices", {}).get("usd"), c.get("prices", {}).get("usd_foil")
        val = max(fval(usd), fval(usdf))
        rec = {
            "n": c.get("name", ""), "s": c.get("set", ""), "cn": c.get("collector_number", ""),
            "t": tl, "m": c.get("mana_cost", "") or "",
            "c": round(c.get("cmc", 0) or 0, 2),
            "r": c.get("rarity", ""), "p": usd, "pf": usdf,
            "img": small, "big": normal, "u": (c.get("scryfall_uri") or "").split("?")[0],
        }
        if back:
            rec["b2"] = back  # back face image (double-faced cards only)
        # Art-series collectibles type as "Card // Card" with no gameplay type; give them
        # their own section instead of swelling the genuine Other (schemes, planes, tokens).
        cat = "Art Cards" if (c.get("layout") == "art_series" or tl in ("Card", "Card // Card")) else categorize(tl)
        by_year[year][cat].append(rec)
        year_sets[year].add(rec["s"])
        si = year_setinfo[year][rec["s"]]
        si["name"] = c.get("set_name") or rec["s"]
        si["count"] += 1
        if art:
            if val > si["topval"]:
                # Keep a distinct-art runner-up so sets that share a top card (e.g. the
                # 1993 reprints all topping out at Black Lotus) can show different art.
                if si["art"] and si["art"] != art:
                    si["topval2"], si["art2"], si["top2"] = si["topval"], si["art"], si["top"]
                si["topval"] = val; si["art"] = art; si["top"] = rec["n"]
            elif art != si["art"] and val > si["topval2"]:
                si["topval2"], si["art2"], si["top2"] = val, art, rec["n"]
        year_value[year] += fval(usd)  # nonfoil sum as the year's "market" figure
        # title card = highest single-card value, prefer one with art
        if year not in year_title or val > year_title[year][0]:
            if art:
                year_title[year] = (val, {"name": rec["n"], "set": rec["s"], "cn": rec["cn"],
                                          "art": art, "value": round(val, 2), "u": rec["u"]})

os.makedirs(OUT, exist_ok=True)
years_index = []
for year in sorted(by_year):
    cats = by_year[year]
    total = sum(len(v) for v in cats.values())
    cat_blocks = []
    for name in CATEGORY_ORDER:
        cards = cats.get(name)
        if not cards:
            continue
        cards.sort(key=lambda r: (r["n"].lower(), r["s"], r["cn"]))
        cat_blocks.append({"name": name, "count": len(cards), "cards": cards})
    # Build the set cards, deduping art: if a set's top-card art is already shown by an
    # earlier (larger) set this year, fall back to its distinct-art runner-up so adjacent
    # set cards stay visually distinct.
    sets_list = []
    used_art = set()
    for k, v in sorted(year_setinfo[year].items(), key=lambda kv: (-kv[1]["count"], kv[1]["name"])):
        art_c, top_c, val_c = v["art"], v["top"], v["topval"]
        if art_c and art_c in used_art and v["art2"]:
            art_c, top_c, val_c = v["art2"], v["top2"], v["topval2"]
        if art_c:
            used_art.add(art_c)
        sets_list.append({"code": k, "name": v["name"], "count": v["count"], "art": art_c,
                          "top": top_c, "value": round(max(val_c, 0.0), 2)})
    with open(f"{OUT}/{year}.json", "w") as fo:
        json.dump({"year": year, "totalCards": total, "sets": sets_list, "categories": cat_blocks},
                  fo, separators=(",", ":"))
    t = year_title.get(year, (0, None))[1]
    years_index.append({"year": year, "sets": len(year_sets[year]), "cards": total,
                        "value": round(year_value[year], 2), "title": t})

years_index.sort(key=lambda y: y["year"], reverse=True)
with open(f"{OUT}/years.json", "w") as fo:
    json.dump({"years": years_index, "totalCards": sum(y["cards"] for y in years_index),
               "generated": datetime.date.today().isoformat()}, fo, separators=(",", ":"))

print(f"years: {len(years_index)} | total cards: {sum(y['cards'] for y in years_index)}")
big = max(years_index, key=lambda y: y["cards"])
print(f"biggest year {big['year']}: {big['cards']} cards, {big['sets']} sets, title card: {big['title']['name'] if big['title'] else None} (${big['title']['value'] if big['title'] else 0})")
for y in years_index[:3]:
    print(f"  {y['year']}: {y['cards']} cards | title: {y['title']['name']} ${y['title']['value']}")
