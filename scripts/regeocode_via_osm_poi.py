"""
避難所の所在地を、住所文字列のパースではなく「施設名」でOpenStreetMap Nominatimを
検索することで再取得する。学校・公民館等はOSM上に実在の建物としてマッピングされて
いることが多く、古い番地表記（大字なし等）に起因する誤ジオコーディングを回避できる。

安全のため bounded=1 + viewbox（中津市周辺）で検索し、市外の同名施設への誤マッチを
防止する。ヒットしない場合は既存のGSI住所ジオコーディング結果を維持する。
"""
import json
import time
import urllib.parse
import urllib.request

SRC = "../public/data/shelters.json"
OUT_CSV = "../data/shelters_osm_regeocoded.csv"
LOG = "../data/osm_regeocode_log.txt"

UA = "nakatsu-bousai-research/1.0 (+educational municipal disaster-prevention app research; contact via project owner)"
BBOX = "130.90,33.75,131.32,33.35"  # left,top,right,bottom (Nominatim: left,top,right,bottom)

NOMINATIM = "https://nominatim.openstreetmap.org/search"


def nominatim_search(query, bounded=True):
    params = {
        "q": query,
        "format": "json",
        "limit": 3,
        "countrycodes": "jp",
    }
    if bounded:
        params["viewbox"] = BBOX
        params["bounded"] = 1
    url = NOMINATIM + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def haversine_km(lat1, lon1, lat2, lon2):
    import math

    R = 6371
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def main():
    with open(SRC, encoding="utf-8") as f:
        shelters = json.load(f)

    print(f"total: {len(shelters)}")
    log_lines = []
    upgraded = 0
    kept = 0
    conflict = 0

    for i, s in enumerate(shelters):
        name = s["name"]
        old_lat, old_lon = s.get("lat"), s.get("lon")
        old_quality = s.get("geocode_quality", "")

        results = []
        try:
            results = nominatim_search(name, bounded=True)
            time.sleep(1.1)
            if not results:
                # 施設種別の接尾辞を除いた短縮名でも試す（例:「南部小学校（管理及び教室棟...）」の括弧部分を除去）
                import re

                short_name = re.sub(r"[（(].*?[）)]", "", name).strip()
                if short_name and short_name != name:
                    results = nominatim_search(short_name, bounded=True)
                    time.sleep(1.1)
        except Exception as e:
            log_lines.append(f"ERROR {name}: {e}")
            results = []

        if results:
            best = results[0]
            new_lat, new_lon = float(best["lat"]), float(best["lon"])

            if old_lat is not None and old_lon is not None:
                dist = haversine_km(old_lat, old_lon, new_lat, new_lon)
            else:
                dist = None

            # 既存が信頼度の高い実測値(good/partial)で、かつOSM結果が2km以上離れている場合は
            # どちらが正しいか自動判断せず、既存を維持した上で要確認フラグを立てる
            if old_quality in ("good", "partial") and dist is not None and dist > 2.0:
                s["geocode_quality"] = "conflict_needs_review"
                s["uncertain"] = True
                s["osm_candidate_lat"] = new_lat
                s["osm_candidate_lon"] = new_lon
                s["osm_candidate_name"] = best["display_name"]
                conflict += 1
                log_lines.append(f"CONFLICT {name}: old=({old_lat},{old_lon}) osm=({new_lat},{new_lon}) dist={dist:.1f}km")
            else:
                s["lat"] = new_lat
                s["lon"] = new_lon
                s["geocode_quality"] = "osm_poi"
                s["uncertain"] = False
                s["matched_title"] = best["display_name"]
                upgraded += 1
                log_lines.append(f"UPGRADED {name}: -> ({new_lat},{new_lon}) {best['display_name']}")
        else:
            kept += 1
            log_lines.append(f"KEEP     {name}: no OSM match, quality={old_quality}")

        if (i + 1) % 25 == 0:
            print(f"  {i+1}/{len(shelters)} processed... upgraded={upgraded} kept={kept} conflict={conflict}")

    with open(SRC, "w", encoding="utf-8") as f:
        json.dump(shelters, f, ensure_ascii=False, separators=(",", ":"))

    with open(LOG, "w", encoding="utf-8") as f:
        f.write("\n".join(log_lines))

    print(f"\nDONE. upgraded={upgraded} kept(no match)={kept} conflict={conflict} / total={len(shelters)}")

    # 品質サマリ
    from collections import Counter

    c = Counter(s.get("geocode_quality", "") for s in shelters)
    for k, v in c.most_common():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
