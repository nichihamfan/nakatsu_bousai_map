"""
ハザードデータ(国土数値情報)を中津市域にクリップし、Web配信向けに軽量化する。
出力先: app/public/hazard/*.geojson
"""
import json
import geopandas as gpd
from shapely.geometry import box

WORK = "../data/_work"
OUT = "../public/hazard"

import os
os.makedirs(OUT, exist_ok=True)

# 中津市全域をやや余裕をもってカバーするバウンディングボックス
NAKATSU_BBOX = box(130.90, 33.35, 131.32, 33.75)
NAKATSU_GDF_CRS = "EPSG:4326"

SIMPLIFY_TOL = 0.0003  # ざっくり30m相当。PoC向けの軽量化


def process(src_path, out_name, category_field=None, keep_cols=None, simplify=True):
    print(f"--- {out_name} ---")
    gdf = gpd.read_file(src_path)
    print("  loaded:", len(gdf), "features, crs=", gdf.crs)
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:6668")  # JGD2011 lat/lon (KSJ標準)
    gdf = gdf.to_crs(NAKATSU_GDF_CRS)

    clip_gdf = gpd.GeoDataFrame(geometry=[NAKATSU_BBOX], crs=NAKATSU_GDF_CRS)
    gdf = gpd.clip(gdf, clip_gdf)
    print("  after clip:", len(gdf))

    if len(gdf) == 0:
        print("  WARNING: no features remain after clip, skipping")
        return

    if keep_cols:
        cols = [c for c in keep_cols if c in gdf.columns] + ["geometry"]
        gdf = gdf[cols]

    if simplify:
        gdf["geometry"] = gdf["geometry"].simplify(SIMPLIFY_TOL, preserve_topology=True)

    out_path = os.path.join(OUT, out_name)
    gdf.to_file(out_path, driver="GeoJSON")
    size_kb = os.path.getsize(out_path) / 1024
    print(f"  saved {out_path} ({size_kb:.0f} KB)")


# 1) 洪水（計画規模・想定最大規模）
process(f"{WORK}/flood/A31-10-22_10_5031.geojson", "flood_planned.geojson",
        keep_cols=["A31_101", "A31_101_code"])
process(f"{WORK}/flood/A31-20-22_10_5031.geojson", "flood_max.geojson",
        keep_cols=["A31_201", "A31_201_code"])

# 2) 土砂災害警戒区域
process(f"{WORK}/sediment/A33-22_44Polygon.geojson", "sediment.geojson",
        keep_cols=["A33_004", "A33_001"])

# 3) 高潮浸水想定区域
process(f"{WORK}/hightide/A49-21_44.geojson", "hightide.geojson")

# 4) 津波浸水想定（シェープファイルから読み込み）
process(f"{WORK}/tsunami/A40-16_44.shp", "tsunami.geojson")

print("\nALL DONE")
