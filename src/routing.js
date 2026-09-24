/* クライアントサイド経路探索（Dijkstra法＋エッジスナッピング＋ハザード回避）
   サーバー・外部APIを一切使わず、中津市道路網データ（routing_graph.json）のみで完結する。
   OSRM/GraphHopper相当の機能を、ビルド不要のブラウザ内純JSで代替する。

   実装方針（2026-09-22改修）:
   - 出発地・目的地は「最も近いノード」ではなく「最も近い道路区間（エッジ）上の点」に
     スナップする（= blending）。POIが2つのノードの中間付近にある場合、最近傍ノードだけを
     見ると本来より遠いノードに繋がってしまい、不要な迂回の原因になることがある。
     参考: 道路網へのPOI接続は「最近傍エッジへの投影点」で行うのが一般的なベストプラクティス
     （OSRM/GraphHopper/openrouteservice等も内部的に同様の処理を行っている）。
   - ハザード回避（安全ルート）は、該当ハザードと交差するエッジに重いペナルティを掛ける
     「ソフト回避」方式。エッジを完全に除外する「ハード回避」は、出発地・目的地自体が
     ハザードエリア内にある場合に経路が見つからなくなるリスクがあるため採用しない
     （OSRM/GraphHopperのavoid area実装でも一般的な考え方）。 */

const HAZARD_PENALTY = 15; // ハザード該当エッジの重みに乗じる係数（ソフト回避）

class RoutingGraph {
  constructor() {
    this.nodes = null; // id -> [lon, lat]
    this.adjacency = null; // id -> [[neighborId, weight, hazardMask], ...]
    this.edges = null; // 生のエッジ配列（最近傍エッジ探索用）
    this.nodeIds = null;
    this.loaded = false;
  }

  async load(url) {
    const res = await fetch(url);
    const data = await res.json();
    this.nodes = data.nodes;
    this.nodeIds = Object.keys(data.nodes);
    this.edges = data.edges; // [a, b, weight] または [a, b, weight, hazardMask]

    this.adjacency = {};
    for (const id of this.nodeIds) this.adjacency[id] = [];
    for (const e of data.edges) {
      const [a, b, w, mask] = e;
      this.adjacency[a].push([b, w, mask || 0]);
      this.adjacency[b].push([a, w, mask || 0]);
    }
    this.loaded = true;
    return { nodeCount: this.nodeIds.length, edgeCount: data.edges.length };
  }

  // 単純な最近傍ノード探索（デバッグ・粗い用途向けに残置）
  nearestNode(lat, lon) {
    let best = null;
    let bestD = Infinity;
    for (const id of this.nodeIds) {
      const [nlon, nlat] = this.nodes[id];
      const d = (nlat - lat) ** 2 + (nlon - lon) ** 2;
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  // 緯度経度をローカル平面座標(m)に変換するための係数（対象範囲が狭いので等距円筒近似で十分）
  _localScale(refLat) {
    const rad = (refLat * Math.PI) / 180;
    return { mPerLon: 111320 * Math.cos(rad), mPerLat: 111320 };
  }

  // 最も近い「道路区間上の点」を探す（ノードではなくエッジへの投影＝スナッピング）
  nearestEdgeSnap(lat, lon) {
    const { mPerLon, mPerLat } = this._localScale(lat);
    const px = lon * mPerLon;
    const py = lat * mPerLat;

    let best = null;
    let bestD = Infinity;

    for (const e of this.edges) {
      const [a, b] = e;
      const na = this.nodes[a];
      const nb = this.nodes[b];
      if (!na || !nb) continue;
      const ax = na[0] * mPerLon,
        ay = na[1] * mPerLat;
      const bx = nb[0] * mPerLon,
        by = nb[1] * mPerLat;

      const abx = bx - ax,
        aby = by - ay;
      const abLenSq = abx * abx + aby * aby;
      let t = abLenSq > 0 ? ((px - ax) * abx + (py - ay) * aby) / abLenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const sx = ax + t * abx,
        sy = ay + t * aby;
      const d = (px - sx) ** 2 + (py - sy) ** 2;

      if (d < bestD) {
        bestD = d;
        const snapLon = sx / mPerLon;
        const snapLat = sy / mPerLat;
        best = { a, b, snapLat, snapLon, t };
      }
    }

    if (!best) return null;

    best.distToA = haversineM(best.snapLat, best.snapLon, this.nodes[best.a][1], this.nodes[best.a][0]);
    best.distToB = haversineM(best.snapLat, best.snapLon, this.nodes[best.b][1], this.nodes[best.b][0]);
    best.distToPoint = Math.sqrt(bestD);
    return best;
  }

  _addVirtualNode(id, snap) {
    this.adjacency[id] = [
      [snap.a, snap.distToA, 0],
      [snap.b, snap.distToB, 0],
    ];
    this.adjacency[snap.a].push([id, snap.distToA, 0]);
    this.adjacency[snap.b].push([id, snap.distToB, 0]);
  }

  _removeVirtualNode(id, snap) {
    delete this.adjacency[id];
    this.adjacency[snap.a] = this.adjacency[snap.a].filter(([n]) => n !== id);
    this.adjacency[snap.b] = this.adjacency[snap.b].filter(([n]) => n !== id);
  }

  // Dijkstra法（二分ヒープ）。avoidMaskで指定したハザードに該当するエッジは
  // 重みにペナルティを掛けて経路上避けやすくする（完全排除はしない＝ソフト回避）。
  _dijkstra(startId, endId, avoidMask) {
    const dist = new Map([[startId, 0]]);
    const prev = new Map();
    const visited = new Set();
    const heap = new MinHeap();
    heap.push(startId, 0);

    while (!heap.isEmpty()) {
      const { item: u, priority: d } = heap.pop();
      if (visited.has(u)) continue;
      visited.add(u);
      if (u === endId) break;

      const neighbors = this.adjacency[u] || [];
      for (const [v, w, mask] of neighbors) {
        const penalized = avoidMask && mask & avoidMask ? w * HAZARD_PENALTY : w;
        const nd = d + penalized;
        if (nd < (dist.get(v) ?? Infinity)) {
          dist.set(v, nd);
          prev.set(v, u);
          heap.push(v, nd);
        }
      }
    }

    if (!dist.has(endId)) return null;

    const path = [];
    let cur = endId;
    while (cur !== undefined) {
      path.unshift(cur);
      cur = prev.get(cur);
    }
    return path;
  }

  // 実際の物理距離（ペナルティ抜き）を、確定した経路のエッジを辿って再計算する
  _realDistanceOf(path) {
    let total = 0;
    let hazardEdgeCount = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const neighbors = this.adjacency[path[i]] || [];
      const found = neighbors.find(([v]) => v === path[i + 1]);
      if (found) {
        total += found[1];
        if (found[2]) hazardEdgeCount++;
      }
    }
    return { distanceM: total, hazardEdgeCount };
  }

  /**
   * 出発地・目的地（緯度経度）から経路を計算する。
   * avoidMask: 回避したいハザードのビットマスク（0なら通常の最短経路）
   */
  route(originLat, originLon, destLat, destLon, avoidMask = 0) {
    const originSnap = this.nearestEdgeSnap(originLat, originLon);
    const destSnap = this.nearestEdgeSnap(destLat, destLon);
    if (!originSnap || !destSnap) return null;

    const ORIGIN_ID = "__origin__";
    const DEST_ID = "__dest__";
    this._addVirtualNode(ORIGIN_ID, originSnap);
    this._addVirtualNode(DEST_ID, destSnap);
    // 出発地・目的地が同じ区間上にスナップされた場合のショートカットも許可
    if (originSnap.a === destSnap.a && originSnap.b === destSnap.b) {
      const direct = haversineM(originSnap.snapLat, originSnap.snapLon, destSnap.snapLat, destSnap.snapLon);
      this.adjacency[ORIGIN_ID].push([DEST_ID, direct, 0]);
      this.adjacency[DEST_ID].push([ORIGIN_ID, direct, 0]);
    }

    let path;
    try {
      path = this._dijkstra(ORIGIN_ID, DEST_ID, avoidMask);
    } finally {
      this._removeVirtualNode(ORIGIN_ID, originSnap);
      this._removeVirtualNode(DEST_ID, destSnap);
    }

    if (!path) return null;

    const { distanceM, hazardEdgeCount } = this._realDistanceOf(path);
    const latlngs = path.map((id) => {
      if (id === ORIGIN_ID) return [originSnap.snapLat, originSnap.snapLon];
      if (id === DEST_ID) return [destSnap.snapLat, destSnap.snapLon];
      const [lon, lat] = this.nodes[id];
      return [lat, lon];
    });
    // 実際の出発地・目的地（道路上のスナップ点ではなく生の座標）まで最後の一区間を足す
    latlngs.unshift([originLat, originLon]);
    latlngs.push([destLat, destLon]);

    return {
      path: latlngs,
      distanceM: distanceM + originSnap.distToPoint + destSnap.distToPoint,
      hazardEdgeCount,
      avoided: avoidMask !== 0,
    };
  }

  pathToLatLngs(path) {
    return path.map((id) => {
      const [lon, lat] = this.nodes[id];
      return [lat, lon];
    });
  }
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// 単純な二分ヒープ（優先度付きキュー）
class MinHeap {
  constructor() {
    this.heap = [];
  }
  isEmpty() {
    return this.heap.length === 0;
  }
  push(item, priority) {
    this.heap.push({ item, priority });
    let i = this.heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent].priority <= this.heap[i].priority) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]];
      i = parent;
    }
  }
  pop() {
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = last;
      let i = 0;
      const n = this.heap.length;
      while (true) {
        let smallest = i;
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        if (l < n && this.heap[l].priority < this.heap[smallest].priority) smallest = l;
        if (r < n && this.heap[r].priority < this.heap[smallest].priority) smallest = r;
        if (smallest === i) break;
        [this.heap[smallest], this.heap[i]] = [this.heap[i], this.heap[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}
