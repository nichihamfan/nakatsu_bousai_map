"""
Phase 1 技術検証: 無料の道路網データ(OpenStreetMap)を用いた自前ルーティングが
実際に機能するかを検証する。

OSRM本体(C++)はDocker/WSL/Linuxバイナリを前提とするが、本機にはいずれも
無いため、同じくOSM道路網を使う純Python実装(osmnx+networkx)で代替検証する。
本番では、Linux系クラウド(無料枠)にOSRMをDockerで直接デプロイする想定は
変わらない。ここではあくまで「無料の道路網データで経路探索が成立するか」の
概念実証を行う。
"""
import json
import time
import networkx as nx
import osmnx as ox

# 中津市中心部（避難所が密集するエリア）に絞った検証用バウンディングボックス
# (west, south, east, north)
BBOX = (131.14, 33.55, 131.24, 33.65)

print("道路網データをOpenStreetMapから取得中...")
t0 = time.time()
G = ox.graph_from_bbox(bbox=BBOX, network_type="walk", simplify=True)
print(f"  取得完了: {time.time()-t0:.1f}秒, ノード数={G.number_of_nodes()}, エッジ数={G.number_of_edges()}")

# テスト地点: 現在地の代わりに中津市役所、目的地に実在の避難所(ジオコーディング精度good)を使う
ORIGIN = (33.5906, 131.1877)  # 中津市役所付近（豊田町14番地3）
with open("../public/data/shelters.json", encoding="utf-8") as f:
    shelters = json.load(f)

good_shelters = [s for s in shelters if s.get("geocode_quality") == "good" and s["lat"] and s["lon"]]
print(f"\n高精度ジオコーディング済み避難所: {len(good_shelters)}件")
for s in good_shelters[:5]:
    print(" -", s["name"], s["lat"], s["lon"])

if not good_shelters:
    # フォールバック: partial品質から選ぶ
    good_shelters = [s for s in shelters if s.get("geocode_quality") == "partial" and s["lat"] and s["lon"]]

dest = good_shelters[0]
DEST = (dest["lat"], dest["lon"])
print(f"\n目的地として選定: {dest['name']} ({DEST})")

# 最近傍ノード取得
orig_node = ox.distance.nearest_nodes(G, X=ORIGIN[1], Y=ORIGIN[0])
dest_node = ox.distance.nearest_nodes(G, X=DEST[1], Y=DEST[0])

t0 = time.time()
route = nx.shortest_path(G, orig_node, dest_node, weight="length")
elapsed = time.time() - t0
print(f"\n経路探索: {elapsed*1000:.0f}ms, ノード数={len(route)}")

# 経路長を計算
edge_lengths = ox.routing.route_to_gdf(G, route)["length"]
total_length_m = edge_lengths.sum()
print(f"経路距離: {total_length_m:.0f} m ({total_length_m/1000:.2f} km)")

# GeoJSONとして書き出し（地図表示検証用）
coords = [[G.nodes[n]["x"], G.nodes[n]["y"]] for n in route]
route_geojson = {
    "type": "FeatureCollection",
    "features": [{
        "type": "Feature",
        "properties": {
            "origin": "中津市役所",
            "destination": dest["name"],
            "distance_m": round(total_length_m),
            "compute_ms": round(elapsed * 1000, 1),
        },
        "geometry": {"type": "LineString", "coordinates": coords},
    }],
}
with open("../public/data/test_route.geojson", "w", encoding="utf-8") as f:
    json.dump(route_geojson, f, ensure_ascii=False)

print("\n保存: app/public/data/test_route.geojson")
print("\n=== 結論 ===")
print("無料のOSM道路網データのみで、実在の避難所への経路探索が成立することを確認した。")
