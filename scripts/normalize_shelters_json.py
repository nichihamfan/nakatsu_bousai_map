import json

SRC = "../public/data/shelters.json"

with open(SRC, encoding="utf-8") as f:
    rows = json.load(f)

out = []
for r in rows:
    lat = r.get("lat")
    lon = r.get("lon")
    try:
        lat = float(lat) if lat not in (None, "") else None
        lon = float(lon) if lon not in (None, "") else None
    except ValueError:
        lat = lon = None
    cap = r.get("収容人数") or ""
    try:
        cap = int(cap) if cap != "" else None
    except ValueError:
        cap = None

    quality = r.get("geocode_quality", "")
    uncertain = quality in ("area_only", "area_only_reverted_suspect_match", "area_only_retry")

    type_map = {"避難所": "general", "避難ビル": "building", "福祉避難所": "welfare"}
    ftype = type_map.get(r.get("施設種別", ""), "general")

    out.append({
        "name": r.get("避難所名", ""),
        "region": r.get("地域区分", ""),
        "district": r.get("地区", ""),
        "type": ftype,
        "address": r.get("所在地", ""),
        "evac_location": r.get("避難場所(避難ビルのみ)", ""),
        "capacity": cap,
        "lat": lat,
        "lon": lon,
        "geocode_quality": quality,
        "uncertain": uncertain,
    })

with open(SRC, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

print("normalized", len(out), "shelters")
uncertain_count = sum(1 for o in out if o["uncertain"])
print("uncertain (needs manual check):", uncertain_count)
