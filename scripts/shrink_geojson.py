"""
public/hazard/*.geojson の座標精度を落として容量を削減する（表示用途には5桁で十分=約1m精度）。
"""
import json
import os
import glob

DIR = "../public/hazard"
PRECISION = 5


def round_coords(obj):
    if isinstance(obj, float):
        return round(obj, PRECISION)
    if isinstance(obj, list):
        return [round_coords(x) for x in obj]
    return obj


for path in glob.glob(os.path.join(DIR, "*.geojson")):
    before = os.path.getsize(path) / 1024
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    for feat in data.get("features", []):
        geom = feat.get("geometry")
        if geom and "coordinates" in geom:
            geom["coordinates"] = round_coords(geom["coordinates"])
        # drop bulky/unneeded properties, keep only what we listed
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    after = os.path.getsize(path) / 1024
    print(f"{os.path.basename(path):24s} {before:9.0f} KB -> {after:9.0f} KB")
