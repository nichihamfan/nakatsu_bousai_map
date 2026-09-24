"""
洪水浸水想定区域内の標高分布を調査する（一回限りの分析スクリプト）。
標高の色分け表示を「中津市の低地に合わせた」スケールに再設計するにあたり、
勘に頼らず実データに基づいて色の閾値を決めるための事前調査。

手順:
1. flood_planned.geojson（洪水浸水想定区域）の範囲内に均等なグリッド点を生成
2. 各点が実際にポリゴン内かどうかをgeopandasで判定
3. 生き残った点について、該当する標高タイル（dem_png, z=14）を取得し
   （同じタイルは使い回してキャッシュ）、国土地理院のRGB→標高変換式で標高を算出
4. 分布（パーセンタイル）を出力する
"""
import json
import math
import time
import urllib.request

import geopandas as gpd
from shapely.geometry import Point, box
from PIL import Image
import io

FLOOD_PATH = "../public/hazard/flood_planned.geojson"
ZOOM = 14

print("洪水浸水想定区域を読み込み中...")
flood = gpd.read_file(FLOOD_PATH)
flood = flood.set_geometry(flood.geometry.buffer(0))
minx, miny, maxx, maxy = flood.total_bounds
print(f"bbox: {minx:.4f},{miny:.4f} - {maxx:.4f},{maxy:.4f}")

# グリッド点生成（約300m間隔相当。緯度1度=111km換算）
step_deg = 300 / 111000
points = []
y = miny
while y <= maxy:
    x = minx
    while x <= maxx:
        points.append(Point(x, y))
        x += step_deg
    y += step_deg
print(f"候補グリッド点: {len(points)}件")

grid_gdf = gpd.GeoDataFrame(geometry=points, crs="EPSG:4326")
joined = gpd.sjoin(grid_gdf, flood[["geometry"]], how="inner", predicate="within")
inside_points = [ (p.x, p.y) for p in joined.geometry ]
print(f"浸水想定区域内の点: {len(inside_points)}件")


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
        return x * 0.01
    elif x == 8388608:
        return None
    else:
        return (x - 16777216) * 0.01


tile_cache = {}


def get_tile_image(tx, ty, z):
    key = (tx, ty, z)
    if key in tile_cache:
        return tile_cache[key]
    url = f"https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{tx}/{ty}.png"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = resp.read()
        img = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        img = None
    tile_cache[key] = img
    return img


elevations = []
t0 = time.time()
for i, (lon, lat) in enumerate(inside_points):
    tx, ty = lonlat_to_tile(lon, lat, ZOOM)
    img = get_tile_image(tx, ty, ZOOM)
    if img is None:
        continue
    px, py = lonlat_to_pixel_in_tile(lon, lat, ZOOM, tx, ty)
    r, g, b = img.getpixel((px, py))
    h = decode_elevation(r, g, b)
    if h is not None:
        elevations.append(h)
    if i % 200 == 0:
        print(f"  {i}/{len(inside_points)} 件処理, タイル数={len(tile_cache)}, 経過={time.time()-t0:.0f}s")

print(f"\n標高取得成功: {len(elevations)}件 / タイル取得数: {len(tile_cache)}")
elevations.sort()


def pct(p):
    idx = int(len(elevations) * p / 100)
    idx = min(idx, len(elevations) - 1)
    return elevations[idx]


print("\n=== 洪水浸水想定区域内の標高分布 ===")
for p in [0, 5, 10, 25, 50, 75, 90, 95, 99, 100]:
    print(f"  {p:3d}パーセンタイル: {pct(p):.2f} m")
