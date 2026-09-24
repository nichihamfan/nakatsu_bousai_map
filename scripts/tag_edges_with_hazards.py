"""
道路網グラフの各エッジ（区間）に、どのハザード種別のエリアと交差するかを事前計算して
付与する。ブラウザ側では毎回のポリゴン交差判定をせず、付与済みのビットマスクを見るだけで
「安全ルート」（ハザード回避）を高速に計算できるようにするための前処理。

ビットマスク: flood=1, sediment=2, hightide=4, tsunami=8

【重要】このスクリプトは3要素形式のエッジ [a,b,weight] のみを前提としており、
既にタグ付け済み（4要素形式 [a,b,weight,mask]）のファイルに対しては動作しない。
入力は必ずタグ付け前のファイル（../data/routing_graph_before_hazard_tagging_backup.json
など）を使うこと。道路網グラフ自体の再生成・修復を行う場合は export_routing_graph.py の
冒頭コメントにある実行順序（export → repair_graph_gaps → tag_edges_with_hazards →
validate_routing_graph.js）に従うこと。
"""
import json
import geopandas as gpd
from shapely.geometry import LineString
import pandas as pd

GRAPH_PATH = "../public/data/routing_graph.json"
HAZARD_FILES = {
    "flood": ("../public/hazard/flood_planned.geojson", 1),
    "sediment": ("../public/hazard/sediment.geojson", 2),
    "hightide": ("../public/hazard/hightide.geojson", 4),
    "tsunami": ("../public/hazard/tsunami.geojson", 8),
}

with open(GRAPH_PATH, encoding="utf-8") as f:
    graph = json.load(f)

nodes = graph["nodes"]
edges = graph["edges"]  # [a, b, weight]
print(f"nodes={len(nodes)} edges={len(edges)}")

# エッジをLineStringのGeoDataFrameに変換
geoms = []
for a, b, w in edges:
    la, lo_a = nodes[a][1], nodes[a][0]
    lb, lo_b = nodes[b][1], nodes[b][0]
    geoms.append(LineString([(nodes[a][0], nodes[a][1]), (nodes[b][0], nodes[b][1])]))

edges_gdf = gpd.GeoDataFrame({"idx": range(len(edges))}, geometry=geoms, crs="EPSG:4326")
mask = [0] * len(edges)

for name, (path, bit) in HAZARD_FILES.items():
    print(f"--- {name} (bit={bit}) ---")
    hz = gpd.read_file(path)
    hz = hz.set_geometry(hz.geometry.buffer(0))  # 不正なポリゴンを軽く修復
    # 空間結合: エッジがハザードポリゴンと交差するか
    joined = gpd.sjoin(edges_gdf, hz[["geometry"]], how="inner", predicate="intersects")
    hit_idx = set(joined["idx"].unique().tolist())
    print(f"  hit edges: {len(hit_idx)} / {len(edges)}")
    for i in hit_idx:
        mask[i] |= bit

# エッジ配列を [a, b, weight, mask] に更新（mask=0のものは省略して容量節約）
new_edges = []
for i, (a, b, w) in enumerate(edges):
    if mask[i]:
        new_edges.append([a, b, round(w, 1), mask[i]])
    else:
        new_edges.append([a, b, round(w, 1)])

graph["edges"] = new_edges

with open(GRAPH_PATH, "w", encoding="utf-8") as f:
    json.dump(graph, f, separators=(",", ":"))

import os
size_mb = os.path.getsize(GRAPH_PATH) / (1024 * 1024)
tagged = sum(1 for m in mask if m)
print(f"\nDONE. tagged edges: {tagged}/{len(edges)} ({tagged/len(edges)*100:.1f}%)")
print(f"file size: {size_mb:.2f} MB")
