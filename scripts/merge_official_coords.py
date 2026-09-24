"""
中津市防災ポータルサイトの各避難所詳細ページ（nakatsu-bosai.jp/hinan/<name>/ 等）に
埋め込まれた Google Maps 初期化用の pos_lat/pos_lng（サイト運営者が設定した公式座標）を
避難所マスタに統合する。これまでの住所ジオコーディング・OSM施設名検索よりも
信頼性の高い一次情報として、これを最優先の座標源とする。
"""
import json

SHELTERS = "../public/data/shelters.json"
OFFICIAL = "../data/official_shelter_coords_raw.json"

with open(SHELTERS, encoding="utf-8") as f:
    shelters = json.load(f)
with open(OFFICIAL, encoding="utf-8") as f:
    official = json.load(f)

# name -> official record（同名が複数ある場合は最初の1件を採用し警告）
by_name = {}
dupes = []
for o in official:
    name = o["text"].strip()
    if name in by_name:
        dupes.append(name)
    else:
        by_name[name] = o

matched = 0
unmatched = []

for s in shelters:
    key = s["name"].strip()
    o = by_name.get(key)
    if o and o.get("ok") and o.get("lat") and o.get("lng"):
        s["lat"] = o["lat"]
        s["lon"] = o["lng"]
        s["geocode_quality"] = "official_city_source"
        s["uncertain"] = False
        # 旧手法の監査フィールドは不要になったため削除
        for f_ in ("matched_title", "osm_candidate_lat", "osm_candidate_lon", "osm_candidate_name"):
            s.pop(f_, None)
        s["official_detail_url"] = o["href"]
        matched += 1
    else:
        unmatched.append(s["name"])

with open(SHELTERS, "w", encoding="utf-8") as f:
    json.dump(shelters, f, ensure_ascii=False, separators=(",", ":"))

print(f"matched: {matched} / {len(shelters)}")
print(f"unmatched: {len(unmatched)}")
for n in unmatched:
    print("  UNMATCHED:", n)
print(f"duplicate names in official source: {len(dupes)}")
for n in dupes:
    print("  DUPE:", n)

from collections import Counter
c = Counter(s.get("geocode_quality", "") for s in shelters)
print("\nfinal quality breakdown:")
for k, v in c.most_common():
    print(f"  {k}: {v}")
