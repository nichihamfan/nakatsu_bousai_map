"""
regeocode_via_osm_poi.py が「conflict_needs_review」とした8件を個別に確認した結果、
6件は明らかな誤マッチ（施設名が全く異なる／隣接自治体の無関係な施設）と判明したため、
OSM再取得前の値に復元する。残り2件（なのみ、三光園）は名称的に一定の妥当性があるため
要確認のまま維持する。
"""
import json

CURRENT = "../public/data/shelters.json"
BACKUP = "../data/shelters_before_osm_regeocode_backup.json"

# 個別確認の結果、OSM候補が明らかに別施設だったもの（学校名不一致・他自治体等）
FALSE_MATCHES = [
    "沖代小学校 （特別教室棟２階・多目的ホール）",
    "中津東高等学校",
    "大幡小学校",
    "東中津中学校",
    "今津小学校",
    "今津中学校",
]

with open(CURRENT, encoding="utf-8") as f:
    current = json.load(f)
with open(BACKUP, encoding="utf-8") as f:
    backup = json.load(f)

backup_by_id = {s["id"]: s for s in backup}

reverted = 0
for s in current:
    if s["name"] in FALSE_MATCHES and s.get("geocode_quality") == "conflict_needs_review":
        orig = backup_by_id.get(s["id"])
        if orig:
            s["lat"] = orig["lat"]
            s["lon"] = orig["lon"]
            s["geocode_quality"] = orig["geocode_quality"]
            s["uncertain"] = orig["uncertain"]
            s.pop("osm_candidate_lat", None)
            s.pop("osm_candidate_lon", None)
            s.pop("osm_candidate_name", None)
            s.pop("matched_title", None)
            reverted += 1
            print(f"REVERTED: {s['name']} -> quality={s['geocode_quality']}")

# 残り2件は「要確認」のまま維持するが、ラベルをわかりやすく
for s in current:
    if s["name"] in ("なのみ", "三光園") and s.get("geocode_quality") == "conflict_needs_review":
        s["geocode_quality"] = "osm_name_partial_match_needs_review"
        print(f"KEPT FLAGGED: {s['name']} (OSM候補と数km差、名称は部分一致)")

with open(CURRENT, "w", encoding="utf-8") as f:
    json.dump(current, f, ensure_ascii=False, separators=(",", ":"))

print(f"\nreverted {reverted} false matches")

from collections import Counter
c = Counter(s.get("geocode_quality", "") for s in current)
for k, v in c.most_common():
    print(f"  {k}: {v}")
