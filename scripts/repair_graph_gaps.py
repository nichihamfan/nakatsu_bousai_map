"""
道路網グラフの「トポロジー上の隙間」を検出・修復する。

背景（2026-09-22 発見）:
  実際のユーザー報告（豊田小学校付近で無駄な遠回りが発生）を調査した結果、
  export_routing_graph.py（osmnx, network_type="walk"）が生成するグラフには、
  実世界では数メートル〜十数メートルしか離れていない2点が、OSM上では別々の
  way（例: 公園内の階段=highway=steps のノード群と、隣接する道路=highway=secondary
  の終端ノード）としてノードを共有しておらず、結果としてグラフ上は数百メートル
  遠回りしないと繋がらない、という実例が見つかった（例: 直線131mの区間で
  実際の経路が661m＝5倍以上になっていた）。

  これはOSMの歩行者データの粒度・整備状況に起因するものであり、export側の
  バグではないが、防災アプリとしては「無駄な遠回り」としてユーザー体験を
  損なうため、以下の方針で機械的に緩和する：

  実世界で近接している（threshold以下）にもかかわらず、既存のグラフ上の経路
  （bounded Dijkstra）で遠回りが必要なノード対を検出し、直線距離を重みとする
  「合成エッジ」を追加して繋ぐ。歩行者が実際に数メートル〜十数メートルの
  隙間を歩いて越えられない状況は稀であるため、この程度の近接ノードを
  直接繋いでも現実の歩行動線として不自然にはならないと判断した。

  安全側の配慮として:
  - 閾値は20m以内とかなり保守的に設定（川・大きな建物を挟んで隣接するような
    誤った接続を避けるため）
  - 既存のグラフ経路で「十分近い（4倍未満）」場合は接続を追加しない
    （些細な遠回りまで機械的に「修復」して不自然なショートカットを作らないため）

  実行後は必ず tag_edges_with_hazards.py を再実行し、新規追加した合成エッジに
  ハザードタグを付け直すこと（このスクリプト単体ではタグ付けしない）。
  ハザードタグ付け前のバックアップ（routing_graph_before_hazard_tagging_backup.json）
  を入力として使うこと（tag_edges_with_hazards.py は3要素形式のエッジのみを
  前提としており、既にタグ付け済み(4要素)のファイルに対しては動作しない）。
"""
import json
import heapq
import math
import sys

GRAPH_PATH = "../data/routing_graph_before_hazard_tagging_backup.json"
OUT_PATH = "../public/data/routing_graph.json"

CLOSE_THRESHOLD_M = 25.0       # これ以下の実距離にある未接続ノード対を「候補」とする
BOUNDED_SEARCH_CUTOFF_M = 400.0  # 既存経路の探索を打ち切る距離（これ以上遠ければ「未到達」扱い）
GAP_RATIO_THRESHOLD = 4.0      # 既存経路が直線距離の何倍を超えたら「隙間」とみなすか


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def main():
    with open(GRAPH_PATH, encoding="utf-8") as f:
        graph = json.load(f)

    nodes = graph["nodes"]  # id -> [lon, lat]
    edges = graph["edges"]  # [a, b, weight]
    print(f"入力: nodes={len(nodes)} edges={len(edges)}")

    adjacency = {nid: [] for nid in nodes}
    existing_pairs = set()
    for a, b, w in edges:
        adjacency[a].append((b, w))
        adjacency[b].append((a, w))
        existing_pairs.add((a, b) if a < b else (b, a))

    # --- 空間グリッドでノードをバケット化（近傍探索の高速化） ---
    CELL_DEG = 0.00025  # 経度方向で約23m、緯度方向で約28m相当（中津市付近の緯度）
    grid = {}
    for nid, (lon, lat) in nodes.items():
        key = (int(lon / CELL_DEG), int(lat / CELL_DEG))
        grid.setdefault(key, []).append(nid)

    def nearby_candidates(nid):
        lon, lat = nodes[nid]
        cx, cy = int(lon / CELL_DEG), int(lat / CELL_DEG)
        seen = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                seen.extend(grid.get((cx + dx, cy + dy), []))
        return seen

    # --- 近接だが未接続のノード対を収集 ---
    checked_pairs = set()
    close_pairs = []
    for nid in nodes:
        lon, lat = nodes[nid]
        for other in nearby_candidates(nid):
            if other == nid:
                continue
            key = (nid, other) if nid < other else (other, nid)
            if key in checked_pairs:
                continue
            checked_pairs.add(key)
            if key in existing_pairs:
                continue
            olon, olat = nodes[other]
            d = haversine_m(lat, lon, olat, olon)
            if d <= CLOSE_THRESHOLD_M:
                close_pairs.append((key[0], key[1], d))

    print(f"近接（{CLOSE_THRESHOLD_M}m以内）だが未接続のノード対候補: {len(close_pairs)}件")

    # --- 各候補について、既存グラフ上での距離をbounded Dijkstraで確認 ---
    def bounded_dijkstra_dist(start, goal, cutoff):
        dist = {start: 0.0}
        heap = [(0.0, start)]
        visited = set()
        while heap:
            d, u = heapq.heappop(heap)
            if u in visited:
                continue
            visited.add(u)
            if u == goal:
                return d
            if d > cutoff:
                break
            for v, w in adjacency.get(u, []):
                nd = d + w
                if nd > cutoff:
                    continue
                if nd < dist.get(v, math.inf):
                    dist[v] = nd
                    heapq.heappush(heap, (nd, v))
        return dist.get(goal)  # Noneなら未到達

    gaps = []
    for a, b, direct_d in close_pairs:
        cutoff = max(BOUNDED_SEARCH_CUTOFF_M, direct_d * GAP_RATIO_THRESHOLD)
        existing_d = bounded_dijkstra_dist(a, b, cutoff)
        if existing_d is None or existing_d > direct_d * GAP_RATIO_THRESHOLD:
            gaps.append((a, b, direct_d, existing_d))

    print(f"\n実際に「隙間」と判定: {len(gaps)}件（既存経路が直線の{GAP_RATIO_THRESHOLD}倍超、または{BOUNDED_SEARCH_CUTOFF_M}m以内に未到達）")
    for a, b, direct_d, existing_d in gaps:
        ex = f"{existing_d:.0f}m" if existing_d is not None else "未到達"
        (lon_a, lat_a), (lon_b, lat_b) = nodes[a], nodes[b]
        print(f"  {a}({lat_a:.5f},{lon_a:.5f}) <-> {b}({lat_b:.5f},{lon_b:.5f})  直線={direct_d:.1f}m  既存経路={ex}")

    if not gaps:
        print("\n修復対象なし。ファイルは変更しません。")
        return

    new_edges = list(edges)
    for a, b, direct_d, _ in gaps:
        new_edges.append([a, b, round(direct_d, 1)])

    graph["edges"] = new_edges
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(graph, f, separators=(",", ":"))

    print(f"\n修復エッジ {len(gaps)}件を追加し、{OUT_PATH} に保存しました。")
    print(f"edges: {len(edges)} -> {len(new_edges)}")
    print("\n次のステップ: tag_edges_with_hazards.py を再実行し、ハザードタグを付け直してください。")


if __name__ == "__main__":
    main()
