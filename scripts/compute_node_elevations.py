"""
道路網グラフの全ノードおよび避難所270件について、標高を事前計算して付与する。

「指定標高以上のルート」機能（2026-09-25追加）のために必要な前処理。この機能は
「現在地が指定標高未満の場合、まず指定標高以上の地点へ最短で避難し、そこから
指定標高以上の避難所へ向かう」という2段階の経路探索を行うため、道路網の各ノードが
何mの標高にあるかをあらかじめ知っておく必要がある（実行時に毎回ブラウザから
標高タイルを取得して判定すると、探索中に大量のリクエストが発生してしまうため）。

国土地理院の生標高タイル（dem_png、ネイティブズーム14）を使用する。まず全ノード・
避難所が属するタイルの集合を求め、並列にまとめて取得してから（I/Oバウンドなため
スレッドプールで高速化）、各点の標高をピクセル単位で復号する。

出力:
  - routing_graph.json の nodes を [lon, lat] から [lon, lat, elevation_m] に拡張
    （標高データが取得できないノードは elevation_m = null）
  - shelters.json の各要素に elevation_m フィールドを追加
"""
import json
import math
import time
import urllib.request
import io
from concurrent.futures import ThreadPoolExecutor, as_completed

from PIL import Image

ZOOM = 14
GRAPH_PATH = "../data/routing_graph_before_hazard_tagging_backup.json"
GRAPH_LIVE_PATH = "../public/data/routing_graph.json"
SHELTERS_PATH = "../public/data/shelters.json"
WORKERS = 24


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    lat_rad = math.radians(lat)
    y = int((1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2 * n)
    return x, y


def lonlat_to_pixel_in_tile(lon, lat, z, tx, ty):
    n = 2 ** z
    fx = (lon + 180) / 360 * n
    lat_rad = math.radians(lat)
    fy = (1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2 * n
    px = int((fx - tx) * 256)
    py = int((fy - ty) * 256)
    return max(0, min(255, px)), max(0, min(255, py))


def decode_elevation(r, g, b):
    if r == 128 and g == 0 and b == 0:
        return None
    x = r * 65536 + g * 256 + b
    if x < 8388608:
        return round(x * 0.01, 2)
    elif x == 8388608:
        return None
    else:
        return round((x - 16777216) * 0.01, 2)


def fetch_tile(key):
    tx, ty, z = key
    url = f"https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{tx}/{ty}.png"
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            data = resp.read()
        img = Image.open(io.BytesIO(data)).convert("RGB")
        return key, img
    except Exception:
        return key, None


def main():
    print("道路網グラフ・避難所データを読み込み中...")
    with open(GRAPH_PATH, encoding="utf-8") as f:
        graph = json.load(f)
    with open(SHELTERS_PATH, encoding="utf-8") as f:
        shelters = json.load(f)
    nodes = graph["nodes"]
    print(f"ノード数: {len(nodes)}, 避難所数: {len(shelters)}")

    # 全対象点が属するタイルの集合を求める
    point_tiles = {}  # nid_or_shelter_key -> (tx,ty)
    tile_keys = set()

    for nid, (lon, lat) in nodes.items():
        tx, ty = lonlat_to_tile(lon, lat, ZOOM)
        point_tiles[("node", nid)] = (tx, ty)
        tile_keys.add((tx, ty, ZOOM))

    for i, s in enumerate(shelters):
        if s.get("lat") is not None and s.get("lon") is not None:
            tx, ty = lonlat_to_tile(s["lon"], s["lat"], ZOOM)
            point_tiles[("shelter", i)] = (tx, ty)
            tile_keys.add((tx, ty, ZOOM))

    print(f"必要なタイル数: {len(tile_keys)}件。並列取得中（{WORKERS}並列）...")
    t0 = time.time()
    tile_images = {}
    fail_count = 0
    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as executor:
        futures = [executor.submit(fetch_tile, k) for k in tile_keys]
        for fut in as_completed(futures):
            key, img = fut.result()
            tile_images[key] = img
            if img is None:
                fail_count += 1
            done += 1
            if done % 200 == 0:
                print(f"  {done}/{len(tile_keys)} タイル取得, 失敗={fail_count}, 経過={time.time()-t0:.0f}s")

    print(f"タイル取得完了: {len(tile_keys)}件, 失敗={fail_count}, 経過={time.time()-t0:.0f}s")

    def elevation_for(lon, lat, tx, ty):
        img = tile_images.get((tx, ty, ZOOM))
        if img is None:
            return None
        px, py = lonlat_to_pixel_in_tile(lon, lat, ZOOM, tx, ty)
        r, g, b = img.getpixel((px, py))
        return decode_elevation(r, g, b)

    print("\nノード標高を復号中...")
    none_count = 0
    for nid, (lon, lat) in nodes.items():
        tx, ty = point_tiles[("node", nid)]
        elev = elevation_for(lon, lat, tx, ty)
        if elev is None:
            none_count += 1
        nodes[nid] = [lon, lat, elev]
    print(f"ノード標高復号完了: 失敗={none_count}/{len(nodes)}")

    with open(GRAPH_PATH, "w", encoding="utf-8") as f:
        json.dump(graph, f, separators=(",", ":"))
    print(f"保存: {GRAPH_PATH}")

    print("\n公開用routing_graph.json（ハザードタグ付き）にも標高を反映中...")
    with open(GRAPH_LIVE_PATH, encoding="utf-8") as f:
        live_graph = json.load(f)
    for nid in live_graph["nodes"]:
        if nid in nodes:
            live_graph["nodes"][nid] = nodes[nid]
    with open(GRAPH_LIVE_PATH, "w", encoding="utf-8") as f:
        json.dump(live_graph, f, separators=(",", ":"))
    print(f"保存: {GRAPH_LIVE_PATH}")

    print("\n避難所の標高を復号中...")
    missing_shelter_elev = 0
    for i, s in enumerate(shelters):
        key = ("shelter", i)
        if key in point_tiles:
            tx, ty = point_tiles[key]
            s["elevation_m"] = elevation_for(s["lon"], s["lat"], tx, ty)
        else:
            s["elevation_m"] = None
        if s["elevation_m"] is None:
            missing_shelter_elev += 1
    with open(SHELTERS_PATH, "w", encoding="utf-8") as f:
        json.dump(shelters, f, ensure_ascii=False, separators=(",", ":"))
    print(f"保存: {SHELTERS_PATH}")
    print(f"避難所の標高取得失敗: {missing_shelter_elev}/{len(shelters)}")

    print(f"\n完了。総経過時間={time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
