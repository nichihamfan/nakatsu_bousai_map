"""
旧城下町エリア（大字なし・字名が括弧書きの住所）の再ジオコーディング。
例: "中津市1468番地（京町）" -> "大分県中津市京町1468番地" で再検索。
"""
import csv
import json
import re
import time
import urllib.parse
import urllib.request

CSV_PATH = "shelters_geocoded.csv"
API = "https://msearch.gsi.go.jp/address-search/AddressSearch?q="


def geocode(query: str):
    url = API + urllib.parse.quote(query)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 nakatsu-bousai-poc"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if not data:
        return None
    best = data[0]
    lon, lat = best["geometry"]["coordinates"]
    return {"lat": lat, "lon": lon, "matched_title": best["properties"].get("title", "")}


with open(CSV_PATH, encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

fixed = 0
for r in rows:
    if r["lat"] != "33.598331" or r["lon"] != "131.188339":
        continue
    addr = r["所在地"]
    m = re.search(r"[（(]([^）)]+)[）)]", addr)
    if not m:
        continue
    town = m.group(1)
    numpart = re.sub(r"[（(][^）)]*[）)]", "", addr).replace("中津市", "").strip()
    query = f"大分県中津市{town}{numpart}"
    try:
        res = geocode(query)
        if res:
            r["lat"] = res["lat"]
            r["lon"] = res["lon"]
            r["matched_title"] = res["matched_title"]
            r["geocode_quality"] = "partial_town_retry"
            fixed += 1
            print("FIXED:", r["避難所名"], "->", query, "=>", res["matched_title"], res["lat"], res["lon"])
        else:
            print("STILL FAIL:", r["避難所名"], query)
    except Exception as e:
        print("ERROR:", r["避難所名"], e)
    time.sleep(0.2)

print(f"\nfixed {fixed} rows")

with open(CSV_PATH, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=rows[0].keys())
    w.writeheader()
    w.writerows(rows)

# regenerate JSON too
with open("shelters_geocoded.json", "w", encoding="utf-8") as f:
    json.dump(rows, f, ensure_ascii=False, indent=1)

print("saved.")
