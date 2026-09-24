"""
ブラウザ側（クライアントサイド）ルーティング用に、OSM道路網をコンパクトなJSONへ変換する。
サーバー不要・静的ファイルのみで経路探索を完結させるための布石。

【重要】このスクリプトを実行してroutin_graph.jsonを作り直した後は、必ず次の順で
続けて実行すること（2026-09-22、実際の「無駄な遠回り」バグの原因究明で判明）：
  1. python export_routing_graph.py         （このファイル。生の道路網を書き出す）
  2. python repair_graph_gaps.py            （近接だが未接続なノード対を検出・修復）
  3. python tag_edges_with_hazards.py       （ハザードタグを付与）
  4. node validate_routing_graph.js         （無駄な遠回りが無いか回帰テスト）

osmnx（network_type="walk", simplify=True）が生成する歩行者網は、公園内の階段
（highway=steps）と隣接する道路が実世界では数メートル〜十数メートルしか
離れていないのにOSM上でノードを共有していない、といったトポロジー上の
細かい隙間を含むことが分かっている。手順2を省略すると、この隙間のせいで
一部の区間だけ数倍〜数十倍の「無駄な遠回り」が発生する（実例: 直線131mの
区間が経路661mになっていた）。手順4のvalidate_routing_graph.jsは、実際に
ブラウザが使うsrc/routing.jsをそのままNode.jsで実行して検証するため、
実装と検証のロジックがズレる心配がない。
"""
import json
import time
import osmnx as ox

# 中津市全域（旧5地域）をカバーするバウンディングボックス
BBOX = (130.90, 33.35, 131.32, 33.75)

print("中津市全域の道路網データを取得中（時間がかかる場合があります）...")
t0 = time.time()
G = ox.graph_from_bbox(bbox=BBOX, network_type="walk", simplify=True, retain_all=False)
print(f"取得完了: {time.time()-t0:.1f}秒, ノード数={G.number_of_nodes()}, エッジ数={G.number_of_edges()}")

# ノード: id -> [lon, lat]
nodes = {}
for n, data in G.nodes(data=True):
    nodes[str(n)] = [round(data["x"], 6), round(data["y"], 6)]

# エッジ: [from, to, length_m] （無向として扱う。歩行者網なので双方向前提）
edges = []
seen = set()
for u, v, data in G.edges(data=True):
    key = (min(u, v), max(u, v))
    if key in seen:
        continue
    seen.add(key)
    length = data.get("length", 0)
    edges.append([str(u), str(v), round(length, 1)])

graph_out = {"nodes": nodes, "edges": edges}

out_path = "../public/data/routing_graph.json"
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(graph_out, f, separators=(",", ":"))

import os
size_mb = os.path.getsize(out_path) / (1024 * 1024)
print(f"\n保存: {out_path}")
print(f"ノード数={len(nodes)}, エッジ数={len(edges)}, サイズ={size_mb:.2f} MB")
