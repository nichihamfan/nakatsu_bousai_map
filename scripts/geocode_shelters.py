"""
避難所データ(data/shelters/nakatsu_shelters_draft.csv)に緯度経度を付与する。
国土地理院 Geocoding API (無料・APIキー不要) を使用。
https://msearch.gsi.go.jp/address-search/AddressSearch?q=<address>
"""
import csv
import json
import re
import time
import urllib.parse
import urllib.request

SRC = "../../data/shelters/nakatsu_shelters_draft.csv"
OUT_JSON = "../data/shelters_geocoded.json"
OUT_CSV = "../data/shelters_geocoded.csv"
FAIL_LOG = "../data/shelters_geocode_failures.csv"

API = "https://msearch.gsi.go.jp/address-search/AddressSearch?q="

PREFECTURE = "大分県"
CITY = "中津市"


def clean_address(addr: str) -> str:
    addr = addr.strip()
    # drop parenthetical old-town readings e.g. （京町）（三ノ丁）
    addr = re.sub(r"[（(][^）)]*[）)]", "", addr)
    addr = addr.strip()
    return addr


def normalize_query(addr: str) -> str:
    addr = clean_address(addr)
    if not addr.startswith(CITY) and not addr.startswith(PREFECTURE):
        addr = CITY + addr
    if not addr.startswith(PREFECTURE):
        addr = PREFECTURE + addr
    return addr


def geocode(query: str):
    url = API + urllib.parse.quote(query)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 nakatsu-bousai-poc"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if not data:
        return None
    best = data[0]
    lon, lat = best["geometry"]["coordinates"]
    title = best["properties"].get("title", "")
    return {"lat": lat, "lon": lon, "matched_title": title}


def main():
    rows = []
    with open(SRC, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows.append(r)

    print(f"total rows: {len(rows)}")

    results = []
    failures = []

    for i, r in enumerate(rows):
        addr = r["所在地"]
        query = normalize_query(addr)
        lat = lon = None
        matched_title = ""
        quality = "fail"
        try:
            res = geocode(query)
            if res:
                lat, lon = res["lat"], res["lon"]
                matched_title = res["matched_title"]
                # crude quality heuristic: does matched title retain most of the block/lot number?
                digits_in_addr = re.findall(r"\d+", addr)
                digits_in_title = re.findall(r"\d+", matched_title)
                if digits_in_addr and digits_in_addr[0] in digits_in_title:
                    quality = "good"
                elif digits_in_title:
                    quality = "partial"
                else:
                    quality = "area_only"
            else:
                # retry without trailing block-lot suffix like "-1" or "の1"
                simplified = re.sub(r"[-－0-9]*$", "", clean_address(addr))
                q2 = normalize_query(simplified)
                res = geocode(q2)
                if res:
                    lat, lon = res["lat"], res["lon"]
                    matched_title = res["matched_title"]
                    quality = "area_only_retry"
        except Exception as e:
            quality = f"error:{e}"

        row_out = dict(r)
        row_out["lat"] = lat
        row_out["lon"] = lon
        row_out["geocode_quality"] = quality
        row_out["matched_title"] = matched_title
        results.append(row_out)

        if lat is None or quality.startswith("error"):
            failures.append(row_out)

        if (i + 1) % 25 == 0:
            print(f"  {i+1}/{len(rows)} processed...")

        time.sleep(0.15)  # be polite to the free public API

    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)

    fieldnames = list(results[0].keys())
    with open(OUT_CSV, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(results)

    if failures:
        with open(FAIL_LOG, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames)
            w.writeheader()
            w.writerows(failures)

    good = sum(1 for r in results if r["geocode_quality"] == "good")
    partial = sum(1 for r in results if r["geocode_quality"] in ("partial", "area_only_retry"))
    area_only = sum(1 for r in results if r["geocode_quality"] == "area_only")
    fail = sum(1 for r in results if r["lat"] is None)
    print(f"\nDONE. good={good} partial={partial} area_only={area_only} fail={fail} / total={len(results)}")


if __name__ == "__main__":
    main()
