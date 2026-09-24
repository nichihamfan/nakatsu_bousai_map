/* 道路網グラフ（routing_graph.json）の「無駄な遠回り」を機械的に検出する回帰テスト。
   2026-09-22、実際のユーザー報告（豊田小学校付近で直線131mの区間が実経路661mになる
   =5倍以上）を受けて作成した。原因はOSM由来データのトポロジー上の隙間
   （近接しているのに未接続なノード対）で、repair_graph_gaps.pyで417箇所を修復した。

   このスクリプトは、ブラウザ本体が実際に使うapp/src/routing.jsをそのままNode.jsで
   動かして検証する（Pythonでロジックを再実装すると、ブラウザ側の実装とズレて
   「テストは通るのに実際のアプリでは壊れている」という事態になりかねないため）。

   使い方:
     node scripts/validate_routing_graph.js
   routing_graph.json・hazardデータ・shelters.jsonを変更した後は必ず実行し、
   異常（無駄な遠回り）が検出された場合は原因を調査してから公開すること。
   異常が見つかった場合は非ゼロの終了コードを返す（CI等での自動チェックに使える）。 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_DIR = path.join(__dirname, "..");
const ROUTING_JS = path.join(APP_DIR, "src", "routing.js");
const GRAPH_JSON = path.join(APP_DIR, "public", "data", "routing_graph.json");
const SHELTERS_JSON = path.join(APP_DIR, "public", "data", "shelters.json");

// ratioだけで判定すると、短距離区間では「街区を回り込むだけ」でも比率が
// 大きく出てしまい誤検知になる（過去の検証で確認済み）。そのため
// 「比率が閾値を超え、かつ超過距離（絶対値）も一定以上」の場合のみ異常とする。
const RATIO_THRESHOLD = 2.5;
const ABS_EXCESS_THRESHOLD_M = 150;
const MIN_STRAIGHT_M = 30; // これ未満の極端な近距離は比率が不安定になるため除外

function loadRoutingGraphClass() {
  // routing.jsはクラス宣言（let/const相当のレキシカルバインディング）のため、
  // グローバルオブジェクトのプロパティにはならない。runInContextの返り値
  // （最後の式の評価結果）として取り出す。
  const code = fs.readFileSync(ROUTING_JS, "utf-8");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "routing.js" });
  return vm.runInContext("RoutingGraph", sandbox);
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

async function main() {
  const RoutingGraph = loadRoutingGraphClass();
  const graphData = JSON.parse(fs.readFileSync(GRAPH_JSON, "utf-8"));
  const shelters = JSON.parse(fs.readFileSync(SHELTERS_JSON, "utf-8"));

  // RoutingGraph.load()はfetch()前提なので、ここではその後半部分だけを再現する
  const g = new RoutingGraph();
  g.nodes = graphData.nodes;
  g.nodeIds = Object.keys(graphData.nodes);
  g.edges = graphData.edges;
  g.adjacency = {};
  for (const id of g.nodeIds) g.adjacency[id] = [];
  for (const e of graphData.edges) {
    const [a, b, w, mask] = e;
    g.adjacency[a].push([b, w, mask || 0]);
    g.adjacency[b].push([a, w, mask || 0]);
  }
  g.loaded = true;

  console.log(`グラフ読み込み: ノード=${g.nodeIds.length} エッジ=${g.edges.length}`);

  // 市内に広く分布する代表地点を出発地として使う
  const origins = [
    { name: "中津市役所付近", lat: 33.598297, lon: 131.188313 },
    { name: "中津駅付近", lat: 33.605, lon: 131.186 },
    { name: "豊田地区", lat: 33.597, lon: 131.1855 },
    { name: "三光地区", lat: 33.555, lon: 131.235 },
    { name: "本耶馬渓地区", lat: 33.5, lon: 131.1 },
    { name: "耶馬溪地区", lat: 33.48, lon: 131.02 },
    { name: "山国地区", lat: 33.42, lon: 131.02 },
  ];

  const validShelters = shelters.filter((s) => s.lat != null && s.lon != null);
  console.log(`検証対象: 出発地${origins.length}地点 × 避難所${validShelters.length}件`);

  const anomalies = [];
  let tested = 0;
  const t0 = Date.now();

  for (const o of origins) {
    for (const s of validShelters) {
      const straight = haversineM(o.lat, o.lon, s.lat, s.lon);
      if (straight < MIN_STRAIGHT_M || straight > 5000) continue;
      const r = g.route(o.lat, o.lon, s.lat, s.lon, 0);
      tested++;
      if (!r) {
        anomalies.push({ origin: o.name, shelter: s.name, id: s.id, issue: "経路が見つからない", straight: Math.round(straight) });
        continue;
      }
      const excess = r.distanceM - straight;
      const ratio = r.distanceM / straight;
      if (ratio > RATIO_THRESHOLD && excess > ABS_EXCESS_THRESHOLD_M) {
        anomalies.push({
          origin: o.name,
          shelter: s.name,
          id: s.id,
          straight: Math.round(straight),
          routed: Math.round(r.distanceM),
          excess: Math.round(excess),
          ratio: +ratio.toFixed(2),
        });
      }
    }
  }

  const elapsed = Date.now() - t0;
  console.log(`検証完了: ${tested}組, ${elapsed}ms`);
  anomalies.sort((a, b) => (b.excess || 0) - (a.excess || 0));

  if (anomalies.length === 0) {
    console.log("\n✅ 異常な遠回りは検出されませんでした。");
    process.exit(0);
  }

  console.log(`\n⚠ 異常な遠回りを${anomalies.length}件検出しました（比率>${RATIO_THRESHOLD}倍 かつ 超過>${ABS_EXCESS_THRESHOLD_M}m）:\n`);
  for (const a of anomalies.slice(0, 30)) {
    if (a.issue) {
      console.log(`  [${a.origin}] -> ${a.shelter}(id=${a.id}): ${a.issue}`);
    } else {
      console.log(`  [${a.origin}] -> ${a.shelter}(id=${a.id}): 直線${a.straight}m 経路${a.routed}m 超過${a.excess}m (${a.ratio}倍)`);
    }
  }
  if (anomalies.length > 30) console.log(`  ...他${anomalies.length - 30}件`);
  process.exit(1);
}

main();
