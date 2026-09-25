/* 中津市防災マップ PoC — Leaflet + 地理院地図 + 国土数値情報ハザードデータ */

const NAKATSU_CENTER = [33.5989, 131.1883];
const DEFAULT_ZOOM = 12;

const HAZARD_FILES = {
  flood: "public/hazard/flood_planned.geojson",
  sediment: "public/hazard/sediment.geojson",
  hightide: "public/hazard/hightide.geojson",
  tsunami: "public/hazard/tsunami.geojson",
};

// styles.cssの --hazard-* 変数と値を揃えること（2026-09-23、視認性改善のため再配色）。
const HAZARD_COLORS = {
  flood: "#2f6fb5",
  sediment: "#9c6b30",
  hightide: "#6a5acd",
  tsunami: "#7a2438",
};

// tag_edges_with_hazards.py の付与ビットと対応させる
const HAZARD_BITS = {
  flood: 1,
  sediment: 2,
  hightide: 4,
  tsunami: 8,
};

/* 標高の色分け表示（2026-09-25改修）。
   国土地理院の「色別標高図」（事前レンダリング済みタイル）は日本全国で色の割り当てが
   一律（0〜4000m超をカバーするスケール）であるため、中津市のような低平地では
   標高差がほとんど同じ緑色に収まってしまい、浸水リスクの高低を読み取れないという
   問題があった（ユーザー指摘、web調査でも同種の課題が指摘されていた：
   「段彩（標高）の表現を内水浸水リスクの把握向けに見直す」等の先行議論を参照）。

   対策として、国土地理院が無料公開している生の標高タイル（dem_png、1ピクセル=1標高値を
   RGBにエンコードしたPNG）を取得し、ブラウザ側でピクセル単位に標高を復号した上で、
   中津市の洪水浸水想定区域の実際の標高分布（事前調査：0〜25mに大半が collect、
   分析スクリプト app/scripts/analyze_flood_zone_elevation.py 参照）に合わせた
   独自のグラデーションで再配色する。低地ほど暖色（危険側）、高台ほど寒色（安全側）で
   塗り分け、0〜30m程度の低平地に色の階調を集中させることで、平地内の微妙な標高差を
   従来より判別しやすくした。 */

// 国土地理院DEMタイルのRGB→標高変換（公式仕様）。無効値(128,0,0)はnullを返す。
function decodeGsiElevation(r, g, b) {
  if (r === 128 && g === 0 && b === 0) return null;
  const x = r * 65536 + g * 256 + b;
  if (x < 8388608) return x * 0.01;
  if (x === 8388608) return null;
  return (x - 16777216) * 0.01;
}

// 洪水浸水想定区域内の標高分布（実データ調査済み：0m=0%ile, 10m≈50%ile, 20m≈75%ile,
// 40m≈90%ile）に基づき、低地に色の階調を集中させたグラデーション。
// 低い＝暖色（危険側）、高い＝寒色〜緑（安全側）。
const ELEVATION_COLOR_STOPS = [
  [0, [123, 0, 100]], // 水際・最も低い
  [2, [197, 27, 82]],
  [5, [239, 59, 44]],
  [10, [253, 141, 60]],
  [15, [254, 196, 79]],
  [20, [254, 227, 145]],
  [30, [217, 239, 139]],
  [50, [173, 221, 142]],
  [100, [120, 198, 121]],
  [250, [35, 132, 67]], // 高台・山地
];

function elevationToColor(h) {
  if (h === null || h === undefined) return null;
  if (h <= ELEVATION_COLOR_STOPS[0][0]) return ELEVATION_COLOR_STOPS[0][1];
  for (let i = 1; i < ELEVATION_COLOR_STOPS.length; i++) {
    const [hi, ci] = ELEVATION_COLOR_STOPS[i];
    if (h <= hi) {
      const [hLo, cLo] = ELEVATION_COLOR_STOPS[i - 1];
      const t = (h - hLo) / (hi - hLo);
      return [
        Math.round(cLo[0] + (ci[0] - cLo[0]) * t),
        Math.round(cLo[1] + (ci[1] - cLo[1]) * t),
        Math.round(cLo[2] + (ci[2] - cLo[2]) * t),
      ];
    }
  }
  return ELEVATION_COLOR_STOPS[ELEVATION_COLOR_STOPS.length - 1][1];
}

// 緯度経度から地理院標高タイルのタイル座標・タイル内ピクセル座標を求める
// （Webメルカトル、標準的なslippy map計算式。app/scripts/compute_node_elevations.py の
// Python版と同じ式で、事前計算値との整合性を保っている）。
function lonLatToTileAndPixel(lon, lat, z) {
  const n = Math.pow(2, z);
  const fx = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const tx = Math.floor(fx);
  const ty = Math.floor(fy);
  const px = Math.max(0, Math.min(255, Math.floor((fx - tx) * 256)));
  const py = Math.max(0, Math.min(255, Math.floor((fy - ty) * 256)));
  return { tx, ty, px, py };
}

// 地図クリック等で選んだ任意の1地点の標高を、地理院標高タイルから即時取得する
// （道路網ノードの標高は事前計算済みだが、ユーザーが指定する任意地点はその場で取得する必要がある）。
// 取得失敗時（オフライン・タイル範囲外等）はnullを返し、呼び出し側でフェイルセーフに扱う。
async function getElevationAtPoint(lat, lon) {
  const z = 14;
  const { tx, ty, px, py } = lonLatToTileAndPixel(lon, lat, z);
  const url = `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${tx}/${ty}.png`;
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("tile load failed"));
      im.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const [r, g, b] = ctx.getImageData(px, py, 1, 1).data;
    return decodeGsiElevation(r, g, b);
  } catch (e) {
    console.warn("[elevation lookup] failed", e);
    return null;
  }
}

// 国土地理院の生標高タイル（dem_png）を取得し、上記スケールで塗り直すLeafletレイヤー。
// ネイティブズームは2〜14（それ以上はLeafletが拡大表示で補う）。
const ElevationColorLayer = L.GridLayer.extend({
  createTile: function (coords, done) {
    const tile = L.DomUtil.create("canvas", "leaflet-tile");
    tile.width = 256;
    tile.height = 256;
    const ctx = tile.getContext("2d");

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, 256, 256);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
          const h = decodeGsiElevation(data[i], data[i + 1], data[i + 2]);
          const color = elevationToColor(h);
          if (color) {
            data[i] = color[0];
            data[i + 1] = color[1];
            data[i + 2] = color[2];
            data[i + 3] = 255;
          } else {
            data[i + 3] = 0; // データなし（海・タイル範囲外等）は透明にして下の地図を見せる
          }
        }
        ctx.putImageData(imageData, 0, 0);
      } catch (e) {
        console.warn("[elevation layer] tile recolor failed", e);
      }
      done(null, tile);
    };
    img.onerror = () => done(null, tile); // 取得失敗時は空タイル（致命的エラーにしない）
    const z = coords.z <= 14 ? coords.z : 14;
    const scale = Math.pow(2, coords.z - z);
    const tx = Math.floor(coords.x / scale);
    const ty = Math.floor(coords.y / scale);
    img.src = `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${tx}/${ty}.png`;
    return tile;
  },
});

const SUPPORTED_LANGS = ["ja", "ja-easy", "en", "id", "vi", "my"];
let currentLang = localStorage.getItem("nakatsu_bousai_lang") || "ja";
let i18nCache = {};
let userLocation = null;
let shelters = [];
let hazardLayers = {};
let reliefLayer = null;
let reliefVisible = false;
let map;
let userMarker;
let shelterMarkersLayer;
let routingGraph = new RoutingGraph();
let routeLayer = null;
let selectedShelter = null;
let activeHazards = new Set(); // 複数レイヤー同時表示に対応
let activeTypeFilter = new Set(["general", "building", "welfare"]);
let acceptingOnly = false;
let avoidAllHazards = false; // 表示中レイヤーに関わらず4種のハザード全てを回避する明示的トグル
let pickingLocation = false; // 地図クリックで地点を指定するモード中かどうか
let pickedPoint = null; // 地図クリックで拾った直近の座標（ポップアップのボタンから参照）
let pickedPointMarker = null; // ピン留め地点（出発地/目的地どちらにも使わなかった場合の一時マーカー）

// 経由地機能（2026-09-25追加）関連の状態
const MAX_WAYPOINTS = 6; // 経由地の巡回順序を全探索で最適化するため、現実的な範囲で上限を設ける（6!=720通りで十分高速）
let routeWaypoints = []; // {lat, lon, label} の配列。出発地→(最適順に並び替えた経由地)→目的地の順で経路を組む
let lastRouteDestination = null; // 直近に経路表示した目的地。経由地の追加・削除時に自動で経路を再計算するために使う
let savedLocationMenuEl = null; // 保存済み出発地チップの「出発地/目的地/経由地」選択ポップオーバー（DOM要素）

// 「指定標高以上のルート」機能（2026-09-25追加）関連の状態
let pickingElevationPoint = false; // 「マップから標高を指定」のピック待機中かどうか
let elevationRouteLayer = null; // 避難路（高台まで）＋避難所までの2区間を保持するレイヤーグループ
let elevationSafePointMarker = null; // 避難路の終点（指定標高以上に達した地点）を示すマーカー
let elevationFilterThreshold = null; // 指定標高以上の避難所のみを表示するフィルタ（null=無効）
let currentElevationThreshold = 10; // スライダー・地図指定で現在選択中の標高しきい値（m）。スライダーの生位置ではなく実際の値を正とする

// 標高スライダーの非線形スケール（2026-09-25改修）。実用上0〜10m付近の選択頻度が高く
// 細かい調整が必要な一方、高台側は大まかな指定で十分という指摘を踏まえ、0〜10mは1m刻みで
// スライダー全体の70%、10〜20mは2m刻みで70〜85%、20〜50mは5m刻みで85〜100%に割り当てる。
// range input自体は0〜100の「位置」を保持するのみとし、ここで実際の標高値(m)との
// 相互変換を行う。
const ELEVATION_SLIDER_ZONES = [
  { posStart: 0, posEnd: 70, valStart: 0, valEnd: 10, step: 1 },
  { posStart: 70, posEnd: 85, valStart: 10, valEnd: 20, step: 2 },
  { posStart: 85, posEnd: 100, valStart: 20, valEnd: 50, step: 5 },
];

function sliderPositionToElevation(pos) {
  for (const z of ELEVATION_SLIDER_ZONES) {
    if (pos <= z.posEnd) {
      const t = (pos - z.posStart) / (z.posEnd - z.posStart);
      const raw = z.valStart + t * (z.valEnd - z.valStart);
      return Math.round(raw / z.step) * z.step;
    }
  }
  return ELEVATION_SLIDER_ZONES[ELEVATION_SLIDER_ZONES.length - 1].valEnd;
}

function elevationToSliderPosition(value) {
  const max = ELEVATION_SLIDER_ZONES[ELEVATION_SLIDER_ZONES.length - 1].valEnd;
  const clamped = Math.max(0, Math.min(max, value));
  for (const z of ELEVATION_SLIDER_ZONES) {
    if (clamped <= z.valEnd) {
      const t = (clamped - z.valStart) / (z.valEnd - z.valStart || 1);
      return z.posStart + t * (z.posEnd - z.posStart);
    }
  }
  return 100;
}

// キーボード操作（矢印キー）でスライダーの各ゾーンの刻み幅通りに1段ずつ移動できるよう、
// 選択可能な標高値を昇順の配列として持っておく（0,1,...,10,12,...,20,25,...,50）。
const ELEVATION_SLIDER_TICKS = (() => {
  const ticks = [0];
  for (const z of ELEVATION_SLIDER_ZONES) {
    for (let v = z.valStart + z.step; v <= z.valEnd + 1e-9; v += z.step) {
      ticks.push(Math.round(v * 10) / 10);
    }
  }
  return ticks;
})();

function stepElevationThreshold(direction) {
  const ticks = ELEVATION_SLIDER_TICKS;
  let idx = ticks.indexOf(currentElevationThreshold);
  if (idx === -1) {
    idx = ticks.reduce((best, v, i) => (Math.abs(v - currentElevationThreshold) < Math.abs(ticks[best] - currentElevationThreshold) ? i : best), 0);
  }
  idx = Math.max(0, Math.min(ticks.length - 1, idx + direction));
  return ticks[idx];
}

// 受入状況の表示ラベル・アイコン用キー対応
const STATUS_KEYS = {
  open: "status_open",
  crowded: "status_crowded",
  full: "status_full",
};

// 気象庁 警報・注意報API（無料・登録不要の公開JSON。サーバーを介さずブラウザから直接取得）
// 大分地方気象台（オフィスコード440000）の現在の発表状況スナップショット。
// area_code 4420300 = 中津市（class20、市町村単位）。
// 参考: https://www.jma.go.jp/bosai/warning/#area_type=class20s&area_code=4420300
const JMA_WARNING_URL = "https://www.jma.go.jp/bosai/warning/data/warning/440000.json";
const JMA_AREA_CODE_NAKATSU = "4420300";
// 津波予報区「大分県瀬戸内海沿岸」のコード。名称一覧APIが見つからなかったため、
// 気象庁公開の津波予報区境界データ（bosai/common/const/geojson/tsunami.json）の座標から
// 中津・宇佐・別府など既知の地点との距離判定で特定した（作業記録.md参照）。JMAが実際に
// 津波警報を発表した際の一次情報でのフィールド名検証はできていないため、ベストエフォートとする。
const JMA_TSUNAMI_AREA_CODE_NAKATSU = "750";
const JMA_TSUNAMI_LIST_URL = "https://www.jma.go.jp/bosai/tsunami/data/list.json";

let hazardGeoJSONCache = {};
let warningBannerDismissed = false;
let startupWarningCheckDone = false;

let checklistData = null;
let checklistChecked = JSON.parse(localStorage.getItem("nakatsu_bousai_checklist") || "{}");
let checklistHousehold = new Set(JSON.parse(localStorage.getItem("nakatsu_bousai_household") || "[]"));

// GPSが使えない場面（屋内・電波不良等）のための、名前付き出発地の保存機能。
// サーバー・アカウント不要、端末のlocalStorageにのみ保存する（他端末とは同期しない）。
let savedLocations = JSON.parse(localStorage.getItem("nakatsu_bousai_saved_locations") || "[]");

const TEXT_SIZE_STEPS = [100, 112, 125, 140]; // %
let textSizeIndex = parseInt(localStorage.getItem("nakatsu_bousai_textsize") || "0", 10);
if (isNaN(textSizeIndex) || textSizeIndex < 0 || textSizeIndex >= TEXT_SIZE_STEPS.length) textSizeIndex = 0;

async function loadI18n(lang) {
  if (i18nCache[lang]) return i18nCache[lang];
  const res = await fetch(`src/i18n/${lang}.json`);
  const data = await res.json();
  i18nCache[lang] = data;
  return data;
}

function applyI18n(dict) {
  document.querySelectorAll("[id^='t-']").forEach((el) => {
    const key = el.id.replace(/^t-/, "").replace(/(2|_f)$/, "");
    if (dict[key] !== undefined) el.textContent = dict[key];
  });
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (dict[key] !== undefined) el.textContent = dict[key];
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (dict[key] !== undefined) el.placeholder = dict[key];
  });
  document.title = dict.app_title ? `${dict.app_title}（PoC）` : document.title;
  document.documentElement.lang = currentLang === "ja-easy" ? "ja" : currentLang;
}

async function setLanguage(lang) {
  currentLang = lang;
  localStorage.setItem("nakatsu_bousai_lang", lang);
  const dict = await loadI18n(lang);
  applyI18n(dict);
  updateElevationThresholdDisplay(currentElevationThreshold);
  renderShelterList();
  renderSavedLocations();
  renderWaypointsList();
  if (checklistData && !document.getElementById("checklistModal").hidden) renderChecklist();
}

function initMap() {
  map = L.map("map", { zoomControl: true }).setView(NAKATSU_CENTER, DEFAULT_ZOOM);

  // 地理院地図 標準タイル（無料・出典表記必須）
  L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", {
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>',
    maxZoom: 18,
  }).addTo(map);

  // 標高の色分け表示（国土地理院の生標高タイルを自前で再配色）。
  // 詳細はElevationColorLayerの定義コメントを参照。
  reliefLayer = new ElevationColorLayer({
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル（標高）</a>',
    maxZoom: 18,
    maxNativeZoom: 14,
    minZoom: 5,
    opacity: 0.65,
  });

  shelterMarkersLayer = L.layerGroup().addTo(map);

  map.on("click", onMapClickForPicking);
}

// GPSが使えない場合の代替として、地図上の任意地点を出発地または目的地に設定できる機能。
// 「地図で地点を指定」ボタンでピック待機状態にし、次に地図をクリックした地点で
// ポップアップを開き、出発地/目的地のどちらにするか選ばせる。
function togglePickLocation() {
  pickingLocation = !pickingLocation;
  const btn = document.getElementById("pickOnMapBtn");
  const hint = document.getElementById("pickOnMapHint");
  const dict = i18nCache[currentLang] || {};
  btn.setAttribute("aria-pressed", pickingLocation ? "true" : "false");
  map.getContainer().style.cursor = pickingLocation ? "crosshair" : "";
  hint.textContent = pickingLocation ? dict.pick_on_map_hint || "" : "";
}

function onMapClickForPicking(e) {
  if (pickingElevationPoint) {
    pickingElevationPoint = false;
    document.getElementById("pickElevationOnMapBtn").setAttribute("aria-pressed", "false");
    document.getElementById("elevationRouteHint").textContent = "";
    map.getContainer().style.cursor = "";
    handleElevationPointPicked(e.latlng.lat, e.latlng.lng);
    return;
  }
  if (!pickingLocation) return;
  pickingLocation = false;
  document.getElementById("pickOnMapBtn").setAttribute("aria-pressed", "false");
  document.getElementById("pickOnMapHint").textContent = "";
  map.getContainer().style.cursor = "";

  pickedPoint = { lat: e.latlng.lat, lon: e.latlng.lng };
  const dict = i18nCache[currentLang] || {};

  const container = document.createElement("div");
  container.className = "map-pick-popup-actions";

  const originBtn = document.createElement("button");
  originBtn.type = "button";
  originBtn.textContent = dict.pick_set_origin || "";
  originBtn.addEventListener("click", () => {
    setUserLocation(pickedPoint.lat, pickedPoint.lon);
    map.closePopup();
  });
  container.appendChild(originBtn);

  const destBtn = document.createElement("button");
  destBtn.type = "button";
  destBtn.className = "secondary";
  destBtn.textContent = dict.pick_set_destination || "";
  destBtn.addEventListener("click", () => {
    map.closePopup();
    routeToPoint(pickedPoint.lat, pickedPoint.lon);
  });
  container.appendChild(destBtn);

  const waypointBtn = document.createElement("button");
  waypointBtn.type = "button";
  waypointBtn.className = "secondary";
  waypointBtn.textContent = dict.pick_set_waypoint || "";
  waypointBtn.addEventListener("click", () => {
    addWaypoint(pickedPoint.lat, pickedPoint.lon, dict.waypoint_default_label || "");
    map.closePopup();
  });
  container.appendChild(waypointBtn);

  L.popup({ className: "map-pick-popup" })
    .setLatLng(e.latlng)
    .setContent(container)
    .openOn(map);
}

function shelterMarkerHtml(type, uncertain, status) {
  const cls = uncertain ? "uncertain" : type;
  const dot = `<span class="shelter-marker ${cls}" style="width:12px;height:12px;display:block;border-radius:50%;"></span>`;
  const ringCls = status ? `mst-${status}` : "";
  return `<span class="shelter-marker-wrap ${ringCls}">${dot}</span>`;
}

async function loadShelters() {
  const [sheltersRes, statusRes] = await Promise.all([
    fetch("public/data/shelters.json"),
    fetch("public/data/shelter_status.json").catch(() => null),
  ]);
  shelters = await sheltersRes.json();

  try {
    const statusData = statusRes && statusRes.ok ? await statusRes.json() : null;
    if (statusData && statusData.entries) {
      shelters.forEach((s) => {
        const entry = statusData.entries[String(s.id)];
        if (entry) {
          s.status = entry.status;
          s.status_updated_at = entry.updated_at;
        } else {
          s.status = "not_open";
        }
      });
    }
  } catch (e) {
    console.warn("shelter_status.json not available", e);
  }

  renderShelterMarkers();
}

function isAccepting(s) {
  return s.status === "open" || s.status === "crowded";
}

function renderShelterMarkers() {
  shelterMarkersLayer.clearLayers();
  shelters.forEach((s) => {
    if (s.lat == null || s.lon == null) return;
    if (!activeTypeFilter.has(s.type)) return;
    if (acceptingOnly && !isAccepting(s)) return;
    if (elevationFilterThreshold != null && !(s.elevation_m != null && s.elevation_m >= elevationFilterThreshold)) return;
    const icon = L.divIcon({
      className: "",
      html: shelterMarkerHtml(s.type, s.uncertain, s.status),
      iconSize: [18, 18],
    });
    const marker = L.marker([s.lat, s.lon], { icon }).addTo(shelterMarkersLayer);
    marker.on("click", () => showShelterDetail(s));
  });
}

function showShelterDetail(s) {
  const dict = i18nCache[currentLang] || {};
  selectedShelter = s;
  document.getElementById("detailName").textContent = s.name;
  document.getElementById("detailAddress").textContent = s.address || (dict.unknown || "");
  const evacRow = document.getElementById("detailEvacRow");
  if (s.evac_location) {
    evacRow.hidden = false;
    document.getElementById("detailEvac").textContent = s.evac_location;
  } else {
    evacRow.hidden = true;
  }
  const capRow = document.getElementById("detailCapRow");
  if (s.capacity != null) {
    capRow.hidden = false;
    document.getElementById("detailCap").textContent = s.capacity + (dict.capacity_unit || "");
  } else {
    capRow.hidden = true;
  }
  document.getElementById("detailUncertainRow").hidden = !s.uncertain;

  const badge = document.getElementById("detailStatusBadge");
  const metaEl = document.getElementById("detailStatusMeta");
  if (s.status && s.status !== "not_open") {
    badge.textContent = dict[STATUS_KEYS[s.status]] || s.status;
    badge.className = "status-badge st-" + s.status;
    if (s.status_updated_at) {
      metaEl.hidden = false;
      metaEl.textContent = `${dict.status_updated_at || ""}: ${formatTimestamp(s.status_updated_at)}`;
    } else {
      metaEl.hidden = true;
    }
  } else {
    badge.textContent = dict.status_not_open || "";
    badge.className = "status-badge";
    metaEl.hidden = true;
  }

  document.getElementById("detailRouteInfo").hidden = true;

  const suggestEl = document.getElementById("detailSuggestAlt");
  if (s.status === "full" && userLocation) {
    const alt = findNearestAccepting(s.id);
    if (alt) {
      suggestEl.hidden = false;
      suggestEl.textContent = `${dict.suggest_alternative_prefix || ""} ${alt.name}（${alt.dist.toFixed(1)} ${dict.distance_unit_km || "km"}）`;
      suggestEl.onclick = () => showShelterDetail(alt);
    } else {
      suggestEl.hidden = true;
    }
  } else {
    suggestEl.hidden = true;
  }

  document.getElementById("shelterDetail").hidden = false;
}

function findNearestAccepting(excludeId) {
  if (!userLocation) return null;
  const candidates = shelters
    .filter((s) => s.id !== excludeId && s.lat != null && s.lon != null && isAccepting(s))
    .map((s) => ({ ...s, dist: haversineKm(userLocation.lat, userLocation.lon, s.lat, s.lon) }))
    .sort((a, b) => a.dist - b.dist);
  return candidates[0] || null;
}

function formatTimestamp(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(currentLang === "ja" || currentLang === "ja-easy" ? "ja-JP" : "en-US", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (e) {
    return iso;
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// レイキャスティング法による点-多角形判定（GeoJSONは[lon,lat]順）
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInGeoJSON(lon, lat, geojson) {
  const features = geojson.type === "FeatureCollection" ? geojson.features : [geojson];
  for (const f of features) {
    const geom = f.geometry || f;
    if (!geom) continue;
    let polys = null;
    if (geom.type === "Polygon") polys = [geom.coordinates];
    else if (geom.type === "MultiPolygon") polys = geom.coordinates;
    if (!polys) continue;
    for (const poly of polys) {
      if (!poly.length) continue;
      if (pointInRing(lon, lat, poly[0])) {
        const inHole = poly.slice(1).some((hole) => pointInRing(lon, lat, hole));
        if (!inHole) return true;
      }
    }
  }
  return false;
}

// 気象庁の警報・注意報（洪水・大雨・高潮）から、現在発表中でかつ現在地を対象に含むものを判定する。
// 参考: 大雨警報(コード03)は attentions配列で「土砂災害」「浸水害」の種別を区別する。
function extractActiveWarningTypes(warningJson) {
  const active = new Set();
  const areaTypes = warningJson.areaTypes || [];
  const class20 = (areaTypes[1] && areaTypes[1].areas) || [];
  const area = class20.find((a) => a.code === JMA_AREA_CODE_NAKATSU);
  if (!area) return active;

  (area.warnings || []).forEach((w) => {
    if (!w.code) return;
    // 「発表警報・注意報はなし」「解除」以外は現在有効な発表とみなす
    if (w.status === "発表警報・注意報はなし" || w.status === "解除") return;
    if (w.code === "04") active.add("flood"); // 洪水警報
    else if (w.code === "08" || w.code === "38") active.add("hightide"); // 高潮警報・特別警報
    else if (w.code === "03" || w.code === "33") {
      // 大雨警報・特別警報：attentionsで土砂災害／浸水害を区別
      const att = w.attentions || [];
      if (att.includes("土砂災害")) active.add("sediment");
      if (att.includes("浸水害") || att.length === 0) active.add("flood");
    }
  });
  return active;
}

// 津波警報（ベストエフォート）。list.jsonのスキーマは実際の発表時に未検証のため、
// 想定される複数の項目構造を緩く探索し、見つからなければ静かに諦める（安全側に倒す）。
async function checkTsunamiWarningActive() {
  try {
    const res = await fetch(JMA_TSUNAMI_LIST_URL, { cache: "no-store" });
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) return false;
    const text = JSON.stringify(list);
    return text.includes(JMA_TSUNAMI_AREA_CODE_NAKATSU);
  } catch (e) {
    console.warn("[jma] tsunami list fetch failed", e);
    return false;
  }
}

// アプリ起動時、気象庁の警報発表状況と現在地を突き合わせ、該当するハザードマップ・
// 避難用品・受入可能な最寄り避難所をデフォルト表示する（要件定義書7.2/7.3/7.5節関連）。
// サーバーを介さず気象庁公開JSONをブラウザから直接取得するのみで、オフライン時・
// 取得失敗時は何もせず既存の挙動に留める（フェイルセーフ）。
async function checkStartupWarnings() {
  if (startupWarningCheckDone || !userLocation) return;
  startupWarningCheckDone = true;

  let warningTypes = new Set();
  try {
    const res = await fetch(JMA_WARNING_URL, { cache: "no-store" });
    const data = await res.json();
    warningTypes = extractActiveWarningTypes(data);
  } catch (e) {
    console.warn("[jma] warning fetch failed (offline?)", e);
    return;
  }

  if (await checkTsunamiWarningActive()) warningTypes.add("tsunami");
  if (warningTypes.size === 0) return;

  const dict = i18nCache[currentLang] || {};
  const typeNames = [...warningTypes].map((k) => dict["hazard_" + k] || k);
  const banner = document.getElementById("warningBanner");
  const bannerText = document.getElementById("warningBannerText");
  const checklistBtn = document.getElementById("warningOpenChecklistBtn");

  // 現在地が実際にハザードエリア内かを確認できたものだけ自動表示する
  const matchedTypes = [];
  for (const key of warningTypes) {
    try {
      const geojson = await getHazardGeoJSON(key);
      if (pointInGeoJSON(userLocation.lon, userLocation.lat, geojson)) {
        matchedTypes.push(key);
      }
    } catch (e) {
      console.warn("[warning-geofence] hazard check failed for", key, e);
    }
  }

  if (!warningBannerDismissed) {
    banner.hidden = false;
    if (matchedTypes.length > 0) {
      const matchedNames = matchedTypes.map((k) => dict["hazard_" + k] || k).join("・");
      bannerText.textContent = (dict.warning_geofence_message || "").replace("%s", matchedNames);
      checklistBtn.hidden = false;
    } else {
      bannerText.textContent = (dict.warning_active_message || "").replace("%s", typeNames.join("・"));
      checklistBtn.hidden = true;
    }
  }

  if (matchedTypes.length === 0) return;

  for (const key of matchedTypes) {
    activeHazards.add(key);
    await addHazardLayer(key);
  }
  updateHazardButtons();

  acceptingOnly = true;
  document.getElementById("acceptingOnlyCb").checked = true;
  renderShelterMarkers();
  renderShelterList();
}

function renderShelterList() {
  const dict = i18nCache[currentLang] || {};
  const list = document.getElementById("shelterList");
  const hint = document.getElementById("locateHint");
  list.innerHTML = "";

  if (!userLocation) {
    hint.textContent = dict.locating || "";
    return;
  }
  hint.textContent = "";

  const withDist = shelters
    .filter((s) => s.lat != null && s.lon != null && activeTypeFilter.has(s.type))
    .filter((s) => !acceptingOnly || isAccepting(s))
    .filter((s) => elevationFilterThreshold == null || (s.elevation_m != null && s.elevation_m >= elevationFilterThreshold))
    .map((s) => ({
      ...s,
      dist: haversineKm(userLocation.lat, userLocation.lon, s.lat, s.lon),
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 15);

  withDist.forEach((s) => {
    const li = document.createElement("li");
    li.className = "shelter-item";
    const typeLabel = { general: dict.shelter_type_general, building: dict.shelter_type_building, welfare: dict.shelter_type_welfare }[s.type] || "";
    const statusHtml =
      s.status && s.status !== "not_open"
        ? `<span class="status-badge st-${s.status}">${escapeHtml(dict[STATUS_KEYS[s.status]] || s.status)}</span>`
        : "";
    li.innerHTML = `
      <span class="name">${escapeHtml(s.name)}</span>
      <span class="meta"><span>${typeLabel}</span><span>${s.dist.toFixed(1)} ${dict.distance_unit_km || "km"}</span></span>
      <span class="item-badges">${statusHtml}${s.uncertain ? `<span class="badge badge-uncertain">${dict.geocode_uncertain || ""}</span>` : ""}</span>
    `;
    li.addEventListener("click", () => {
      map.setView([s.lat, s.lon], 15);
      showShelterDetail(s);
    });
    list.appendChild(li);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// 現在地マーカーの更新・地図移動・避難所リスト再描画・出発地保存欄の表示を一箇所にまとめる。
// GPS取得・住所検索・保存済み出発地の選択、いずれの経路からもここを通す。
function setUserLocation(lat, lon, zoom = 15) {
  userLocation = { lat, lon };
  if (userMarker) map.removeLayer(userMarker);
  userMarker = L.circleMarker([lat, lon], {
    radius: 8,
    color: "#1b4b66",
    fillColor: "#d5006d",
    fillOpacity: 1,
    weight: 3,
  }).addTo(map);
  map.setView([lat, lon], zoom);
  document.getElementById("locateHint").textContent = "";
  const saveRow = document.getElementById("saveLocationRow");
  saveRow.hidden = false;
  document.getElementById("saveLocationNameInput").value = "";
  renderShelterList();
}

function persistSavedLocations() {
  localStorage.setItem("nakatsu_bousai_saved_locations", JSON.stringify(savedLocations));
}

// 保存済み出発地のチップをクリックした際、「出発地にする／目的地にする／経由地にする」の
// 3択を示す小さなポップオーバーを表示する（2026-09-25追加。従来は出発地固定だったが、
// 目的地・経由地としても使えるようにしてほしいというユーザー要望を受けて改修）。
function closeSavedLocationMenu() {
  if (savedLocationMenuEl) {
    savedLocationMenuEl.remove();
    savedLocationMenuEl = null;
    document.removeEventListener("click", onDocClickCloseSavedLocationMenu, true);
  }
}

function onDocClickCloseSavedLocationMenu(e) {
  if (savedLocationMenuEl && !savedLocationMenuEl.contains(e.target)) closeSavedLocationMenu();
}

function showSavedLocationMenu(loc, anchorEl) {
  closeSavedLocationMenu();
  const dict = i18nCache[currentLang] || {};
  const menu = document.createElement("div");
  menu.className = "saved-location-menu";
  const rect = anchorEl.getBoundingClientRect();
  const menuWidth = 160; // .saved-location-menuのmin-widthと合わせる（狭い画面での画面外はみ出しを防ぐ）
  const left = Math.min(rect.left, window.innerWidth - menuWidth - 8);
  menu.style.left = `${Math.max(4, Math.round(left))}px`;
  menu.style.top = `${Math.round(rect.bottom + 4)}px`;

  const makeBtn = (text, onClick) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = text;
    btn.addEventListener("click", () => {
      onClick();
      closeSavedLocationMenu();
    });
    return btn;
  };

  menu.appendChild(makeBtn(dict.saved_location_set_origin || "", () => setUserLocation(loc.lat, loc.lon)));
  menu.appendChild(makeBtn(dict.saved_location_set_destination || "", () => routeToPoint(loc.lat, loc.lon, loc.label)));
  menu.appendChild(makeBtn(dict.saved_location_set_waypoint || "", () => addWaypoint(loc.lat, loc.lon, loc.label)));

  document.body.appendChild(menu);
  savedLocationMenuEl = menu;
  setTimeout(() => document.addEventListener("click", onDocClickCloseSavedLocationMenu, true), 0);
}

function renderSavedLocations() {
  const dict = i18nCache[currentLang] || {};
  const section = document.getElementById("savedLocationsSection");
  const list = document.getElementById("savedLocationsList");
  list.innerHTML = "";

  section.hidden = savedLocations.length === 0;

  savedLocations.forEach((loc) => {
    const chip = document.createElement("div");
    chip.className = "saved-location-chip";

    const selectBtn = document.createElement("button");
    selectBtn.type = "button";
    selectBtn.className = "saved-location-select";
    selectBtn.textContent = "📍 " + loc.label;
    selectBtn.addEventListener("click", () => showSavedLocationMenu(loc, selectBtn));
    chip.appendChild(selectBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "saved-location-delete";
    delBtn.textContent = "×";
    delBtn.setAttribute("aria-label", dict.save_location_delete || "delete");
    delBtn.addEventListener("click", () => {
      savedLocations = savedLocations.filter((l) => l.id !== loc.id);
      persistSavedLocations();
      renderSavedLocations();
    });
    chip.appendChild(delBtn);

    list.appendChild(chip);
  });
}

function saveCurrentLocationAs(label) {
  if (!userLocation || !label.trim()) return;
  savedLocations.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    label: label.trim().slice(0, 20),
    lat: userLocation.lat,
    lon: userLocation.lon,
  });
  persistSavedLocations();
  renderSavedLocations();
  document.getElementById("saveLocationNameInput").value = "";
}

// 経由地の追加・削除・一覧表示（2026-09-25追加）。経由地は出発地・目的地と異なり
// 複数保持できるが、巡回順序の最適化を全探索で行うため現実的な上限を設けている
// （MAX_WAYPOINTS）。既に経路が表示されている場合は、経由地の変更を即座に反映して
// 経路を再計算する（Google マップ等、主要な経路サービスの挙動を参考にした）。
function addWaypoint(lat, lon, label) {
  if (routeWaypoints.length >= MAX_WAYPOINTS) return;
  routeWaypoints.push({ lat, lon, label: label || "" });
  renderWaypointsList();
  refreshActiveRoute();
}

function removeWaypoint(index) {
  routeWaypoints.splice(index, 1);
  renderWaypointsList();
  refreshActiveRoute();
}

function renderWaypointsList() {
  const dict = i18nCache[currentLang] || {};
  const section = document.getElementById("waypointsSection");
  const list = document.getElementById("waypointsList");
  list.innerHTML = "";
  section.hidden = routeWaypoints.length === 0;

  routeWaypoints.forEach((wp, i) => {
    const chip = document.createElement("div");
    chip.className = "waypoint-chip";

    const label = document.createElement("span");
    label.className = "waypoint-chip-label";
    label.textContent = `${i + 1}. ${wp.label || dict.waypoint_default_label || ""}`;
    chip.appendChild(label);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "waypoint-chip-delete";
    delBtn.textContent = "×";
    delBtn.setAttribute("aria-label", dict.save_location_delete || "delete");
    delBtn.addEventListener("click", () => removeWaypoint(i));
    chip.appendChild(delBtn);

    list.appendChild(chip);
  });
}

// 現在表示中のルート（lastRouteDestination）がある状態で経由地が変更された場合、
// 表示を古いままにせず自動的に経路を再計算する。
async function refreshActiveRoute() {
  if (!lastRouteDestination) return;
  const dest = lastRouteDestination; // drawRouteLayer()内のclearRoute()でnullにされる前に退避する
  const { result, elapsed, waypointOrder } = await computeMultiStopRoute(dest.lat, dest.lon);
  if (!result) return;

  drawRouteLayer(result);
  const text = routeResultText(result, elapsed, waypointOrder);
  if (dest.kind === "shelter") {
    const infoEl = document.getElementById("detailRouteInfo");
    infoEl.hidden = false;
    infoEl.textContent = text;
  } else {
    if (pickedPointMarker) map.removeLayer(pickedPointMarker);
    pickedPointMarker = L.marker([dest.lat, dest.lon]).addTo(map);
    pickedPointMarker.bindPopup(text).openPopup();
  }
  lastRouteDestination = dest;
}

function locateUser() {
  const dict = i18nCache[currentLang] || {};
  const hint = document.getElementById("locateHint");
  hint.textContent = dict.locating || "";

  if (!navigator.geolocation) {
    hint.textContent = dict.location_error || "";
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setUserLocation(pos.coords.latitude, pos.coords.longitude, 14);
      checkStartupWarnings();
    },
    () => {
      hint.textContent = dict.location_error || "";
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

async function getHazardGeoJSON(key) {
  if (!hazardGeoJSONCache[key]) {
    const res = await fetch(HAZARD_FILES[key]);
    hazardGeoJSONCache[key] = await res.json();
  }
  return hazardGeoJSONCache[key];
}

async function addHazardLayer(key) {
  if (!hazardLayers[key]) {
    const geojson = await getHazardGeoJSON(key);
    hazardLayers[key] = L.geoJSON(geojson, {
      style: () => ({
        color: HAZARD_COLORS[key],
        weight: 0.5,
        fillColor: HAZARD_COLORS[key],
        fillOpacity: 0.45,
      }),
    });
  }
  hazardLayers[key].addTo(map);
}

// 中津市周辺に限定した検索範囲（bounded=1 + viewbox）。他市区町村の同名施設の誤マッチを防ぐ。
// 山間部（耶馬溪・本耶馬渓・山国地域）まで含む広めのバウンディングボックス。
const NOMINATIM_VIEWBOX = "130.90,33.85,131.55,33.30"; // left,top,right,bottom
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const NAKATSU_BBOX = { west: 130.9, south: 33.3, east: 131.55, north: 33.85 };

function inNakatsuBbox(lat, lon) {
  return lon >= NAKATSU_BBOX.west && lon <= NAKATSU_BBOX.east && lat >= NAKATSU_BBOX.south && lat <= NAKATSU_BBOX.north;
}

// 入力住所からバウンディングボックス以外の誤マッチを検出するための補助関数群
// （2026-09-25、「住所検索が異なる場所を示すことがある」というユーザー報告を受けて追加）。
// 実機調査の結果、以下2種類の実害あるバグを確認した：
// ①国土地理院APIは、入力した地区・大字名を特定できない場合でも「見つかりませんでした」
//   ではなく、市区町村レベルの代表点（例："大分県中津市"のみ、座標は市役所付近）に
//   静かにフォールバックすることがある。この代表点は当然バウンディングボックス内に
//   収まるため、従来の実装では「正しく見つかった」ものとして誤って採用していた。
//   （例："中津市四日市"「中津市駅館」等、実際には隣接する宇佐市・豊前市の地名だが、
//   いずれも中津市の代表点に化けて返ってきた）
// ②Nominatim検索にはバウンディングボックスの絞り込みが一切なかったため、
//   例えば「三毛門」（実際は隣接する豊前市の大字）で検索すると、その正しい所在地
//   （豊前市）の座標がたまたま中津市の広いバウンディングボックス内に収まることから、
//   誤って中津市内の地点として採用されてしまっていた。
// 対策として、地理院APIの結果については「市区町村名より先の部分」が入力した地区名と
// 何らかの形で対応しているかを確認し、Nominatim検索についてもバウンディングボックスで
// 絞り込むようにした。

// 住所文字列の先頭から、数字・丁目・番地・号・ハイフン類が現れるまでの部分を
// 大まかな「地区名」とみなす（例："豊田1-1-111"→"豊田"、"四日市"→"四日市"）。
function extractDistrictName(s) {
  const m = s.match(/^[^\d0-9０-９丁目番地号\-－―ー]+/);
  return m ? m[0].trim() : s.trim();
}

// 「大字」「字」は住所の正式表記に含まれることが多いが、地理院APIが返すtitleでは
// 省略されるのが一般的なため（例："耶馬溪町大字柿坂"と入力しても"耶馬溪町柿坂"が
// 返る）、比較前に取り除いて正規化する。
function normalizeDistrictForMatch(s) {
  return s.replace(/大字|字/g, "");
}

// 地理院APIの返す住所（title）が、入力した地区名と何ら対応していない場合は
// 信頼できない結果とみなして除外する。市区町村レベルのみのフォールバック
// （"中津市"の後に何も続かない）は無条件で除外する。
function gsiResultLooksValid(title, queryDistrict) {
  const idx = title.indexOf("中津市");
  const remainder = idx === -1 ? "" : title.slice(idx + "中津市".length).trim();
  if (remainder.length === 0) return false;
  if (!queryDistrict || queryDistrict.length < 2) return true;
  const normRemainder = normalizeDistrictForMatch(remainder);
  const normQuery = normalizeDistrictForMatch(queryDistrict);
  return normRemainder.includes(normQuery) || normQuery.includes(normRemainder.slice(0, normQuery.length));
}

// 国土地理院（GSI）の住所検索API。無料・登録不要。Nominatim（OpenStreetMap）は
// 「豊田1丁目1番地111」のような日本の住所表記（丁目・番地、全角/半角ハイフン等の
// 表記ゆれを含む）にほぼ対応できないことが実機検証で判明した（同じ場所を指す
// 複数の表記を試してもすべて0件だった）。国土地理院のAPIは日本の住居表示・地番
// データそのものを検索するため、こうした表記ゆれを自然に吸収できる。
// ただし都道府県・市区町村名を含まないと全国から同名地名を拾ってしまうため、
// 必ず「中津市」を前置し、かつ返ってきた候補が中津市周辺のバウンディングボックス内に
// あるものだけを採用する（他都市の同名地区への誤マッチ防止）。
const GSI_ADDRESS_SEARCH_URL = "https://msearch.gsi.go.jp/address-search/AddressSearch";

async function tryGsiAddressSearch(query, queryDistrict) {
  try {
    const url = `${GSI_ADDRESS_SEARCH_URL}?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const results = await res.json();
    if (!Array.isArray(results)) return null;
    for (const r of results) {
      const coords = r.geometry && r.geometry.coordinates;
      const title = (r.properties && r.properties.title) || "";
      if (!coords) continue;
      const [lon, lat] = coords;
      if (inNakatsuBbox(lat, lon) && gsiResultLooksValid(title, queryDistrict)) return { lat, lon };
    }
    return null;
  } catch (e) {
    console.warn("[gsi geocode] failed", e);
    return null;
  }
}

async function tryNominatimSearch(query) {
  try {
    // limit=1だと、importance（重要度）が同点の候補が複数ある場合にNominatim側の
    // 順序が不安定になり、意図しない候補（例：本庁舎ではなく山間部の支所）が返ることが
    // 実機検証で判明した。limitを増やして複数候補を取得し、同点上位の中から中津市中心部に
    // 最も近いものを選ぶことで、この揺れを吸収する。
    const url = `${NOMINATIM_URL}?format=json&limit=5&bounded=1&viewbox=${NOMINATIM_VIEWBOX}&countrycodes=jp&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const results = await res.json();
    if (!results || results.length === 0) return null;

    // bounded=1はNominatim側の絞り込みヒントに過ぎず、隣接自治体の地点が
    // バウンディングボックスの外縁付近に収まって返ってくることがある
    // （実機検証で確認：中津市に隣接する豊前市の地名「三毛門」の座標が、中津市を
    // 囲む矩形のバウンディングボックス内にそのまま収まってしまうケースを確認した。
    // 矩形のbboxは行政界の形状と一致しないため、境界付近ではこの種の誤判定を
    // 避けられない）。display_nameには実際の市区町村名が含まれているため、
    // バウンディングボックスに加えて「中津市」を含み他の市区町村名を含まないことも
    // 確認することで、行政界をまたいだ誤マッチをより確実に排除する。
    const validResults = results.filter((c) => {
      if (!inNakatsuBbox(parseFloat(c.lat), parseFloat(c.lon))) return false;
      const name = c.display_name || "";
      if (!name.includes("中津市")) return false;
      if (/(豊前市|宇佐市|玖珠町|日田市|築上郡)/.test(name)) return false;
      return true;
    });
    if (validResults.length === 0) return null;

    const topImportance = Math.max(...validResults.map((c) => c.importance || 0));
    const topCandidates = validResults.filter((c) => (c.importance || 0) >= topImportance - 1e-9);
    const r = topCandidates.reduce((best, c) => {
      const d = haversineKm(NAKATSU_CENTER[0], NAKATSU_CENTER[1], parseFloat(c.lat), parseFloat(c.lon));
      return d < best.d ? { c, d } : best;
    }, { c: topCandidates[0], d: Infinity }).c;
    return { lat: parseFloat(r.lat), lon: parseFloat(r.lon) };
  } catch (e) {
    console.warn("[nominatim geocode] failed", e);
    return null;
  }
}

// 検索の度に増やすリクエストID。ユーザーが検索語を編集して立て続けに検索した場合、
// 後発の（＝ユーザーが本来意図した）検索より先に旧い検索のレスポンスが遅れて返ってくると、
// 正しい検索結果が古い結果で上書きされてしまう競合状態が発生しうる（2026-09-25、
// 「住所検索が異なる場所を示すことがある」の一因として実装上のレビューで発見）。
// 各呼び出しの結果を反映する前に、自分が最新のリクエストであるかを確認することで防ぐ。
let searchRequestSeq = 0;

// GPSが使えない場合の代替として、住所・施設名から地点を検索する（他の防災アプリ調査で
// 「現在地取得不可時の住所検索」が広く提供されていたため追加：全国避難所ガイド等）。
// 住所表記（丁目・番地等）は国土地理院APIを優先し、施設名等はNominatimにフォールバックする
// 2段構えにすることで、双方の得意分野を組み合わせている。
async function searchLocation(query) {
  const dict = i18nCache[currentLang] || {};
  const hint = document.getElementById("locationSearchHint");
  const btn = document.getElementById("locationSearchBtn");
  const q = query.trim();
  if (!q) return;

  const myRequestSeq = ++searchRequestSeq;

  hint.classList.remove("error");
  hint.textContent = dict.loading || "";
  btn.disabled = true;

  try {
    // 国土地理院APIは都道府県・市区町村→地区→丁目→番地という階層構造で住所を
    // 解釈するため、「中津市」は先頭に付与する必要がある（末尾に付けると
    // 全国の同名地区がヒットしてしまうことを実機検証で確認した）。
    // すでに「中津市」を含む入力の場合は二重に付けない。
    const gsiQuery = q.includes("中津市") ? q : "中津市" + q;
    const afterCity = gsiQuery.slice(gsiQuery.indexOf("中津市") + "中津市".length);
    const queryDistrict = extractDistrictName(afterCity);
    const hit = (await tryGsiAddressSearch(gsiQuery, queryDistrict)) || (await tryNominatimSearch(q + " 中津市"));

    // 自分より後に開始された検索がある場合、その結果で既に上書きされているはずなので
    // このリクエストの結果は反映しない（競合状態の防止）。
    if (myRequestSeq !== searchRequestSeq) return;

    if (!hit) {
      hint.classList.add("error");
      hint.textContent = dict.location_search_not_found || "";
      return;
    }

    setUserLocation(hit.lat, hit.lon);
    hint.classList.remove("error");
    hint.textContent = "";
  } catch (e) {
    if (myRequestSeq !== searchRequestSeq) return;
    console.warn("[location search] failed", e);
    hint.classList.add("error");
    hint.textContent = dict.location_search_not_found || "";
  } finally {
    if (myRequestSeq === searchRequestSeq) btn.disabled = false;
  }
}

async function toggleHazard(key) {
  // 想定外のキー（例：ハザードボタン以外の要素が誤って同じセレクタで拾われた場合）で
  // activeHazardsが汚染されたり、fetch(undefined)のような無駄な通信が発生したりしない
  // ようにする防御的ガード（2026-09-24、標高ボタンのクラス重複バグの再発防止として追加）。
  if (!HAZARD_FILES[key] && key !== "none") return;
  if (key === "none") {
    // 「表示しない」は全レイヤーを消すクリア操作
    activeHazards.clear();
    Object.values(hazardLayers).forEach((layer) => map.removeLayer(layer));
    updateHazardButtons();
    return;
  }

  if (activeHazards.has(key)) {
    activeHazards.delete(key);
    if (hazardLayers[key]) map.removeLayer(hazardLayers[key]);
  } else {
    activeHazards.add(key);
    await addHazardLayer(key);
  }
  updateHazardButtons();
}

function updateHazardButtons() {
  document.querySelectorAll(".hazard-btn").forEach((btn) => {
    const key = btn.dataset.hazard;
    const pressed = key === "none" ? activeHazards.size === 0 : activeHazards.has(key);
    btn.setAttribute("aria-pressed", pressed ? "true" : "false");
  });
  if (checklistData && !document.getElementById("checklistModal").hidden) renderChecklist();
}

// 色別標高図のON/OFF切替。ハザードマップの指定区域外でも低地は浸水リスクが
// 相対的に高い場合があるため、地形の高低を補助的に確認できるようにする。
// あくまで参考情報であり、実際の浸水想定を示すものではない旨をUI側で明示する。
function toggleRelief() {
  reliefVisible = !reliefVisible;
  if (reliefVisible) {
    reliefLayer.addTo(map);
  } else {
    map.removeLayer(reliefLayer);
  }
  const btn = document.getElementById("reliefToggleBtn");
  btn.setAttribute("aria-pressed", reliefVisible ? "true" : "false");
  document.getElementById("reliefLegend").hidden = !reliefVisible;
}

// 凡例パネルの折りたたみ（2026-09-25追加）。スマートフォンでは地図・避難所一覧など
// 画面が限られており、凡例が常時展開されたままだと下の要素に重なって隠してしまう
// ことがユーザー報告で判明した（凡例の絶対配置がレイアウト全体を基準にしていたため、
// 縦に長いページでは地図の外側に飛び出してしまっていた不具合も併せて修正：
// 凡例をmap-wrap内に移し、地図の右下を基準に配置するよう変更した）。
// 折りたたみ時はタイトル行のみを残した小さなバーになる（web調査で確認した
// モバイル地図UIの一般的な推奨パターンに合わせた設計。作業記録.md参照）。
function toggleLegend(forceCollapsed) {
  const legend = document.getElementById("legend");
  const btn = document.getElementById("legendToggleBtn");
  const collapsed = forceCollapsed != null ? forceCollapsed : !legend.classList.contains("collapsed");
  legend.classList.toggle("collapsed", collapsed);
  btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  btn.querySelector("span").textContent = collapsed ? "▸" : "▾";
}

function applyTextSize() {
  document.documentElement.style.fontSize = TEXT_SIZE_STEPS[textSizeIndex] + "%";
  localStorage.setItem("nakatsu_bousai_textsize", String(textSizeIndex));
  document.getElementById("textSizeDownBtn").disabled = textSizeIndex === 0;
  document.getElementById("textSizeUpBtn").disabled = textSizeIndex === TEXT_SIZE_STEPS.length - 1;
}

function wireEvents() {
  document.getElementById("langPicker").value = currentLang;
  document.getElementById("langPicker").addEventListener("change", (e) => setLanguage(e.target.value));

  document.querySelectorAll(".hazard-btn").forEach((btn) => {
    btn.addEventListener("click", () => toggleHazard(btn.dataset.hazard));
  });

  document.getElementById("reliefToggleBtn").addEventListener("click", toggleRelief);

  document.getElementById("locateBtn").addEventListener("click", locateUser);

  document.getElementById("locationSearchBtn").addEventListener("click", () => {
    searchLocation(document.getElementById("locationSearchInput").value);
  });
  document.getElementById("locationSearchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchLocation(e.target.value);
  });

  document.getElementById("saveLocationBtn").addEventListener("click", () => {
    saveCurrentLocationAs(document.getElementById("saveLocationNameInput").value);
  });
  document.getElementById("saveLocationNameInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveCurrentLocationAs(e.target.value);
  });

  document.getElementById("closeModalBtn").addEventListener("click", () => {
    document.getElementById("caveatModal").hidden = true;
  });

  document.getElementById("showRouteBtn").addEventListener("click", showRouteToSelected);
  document.getElementById("clearRouteBtn").addEventListener("click", clearRoute);

  document.getElementById("textSizeDownBtn").addEventListener("click", () => {
    if (textSizeIndex > 0) textSizeIndex--;
    applyTextSize();
  });
  document.getElementById("textSizeUpBtn").addEventListener("click", () => {
    if (textSizeIndex < TEXT_SIZE_STEPS.length - 1) textSizeIndex++;
    applyTextSize();
  });
  applyTextSize();

  document.getElementById("legendToggleBtn").addEventListener("click", () => toggleLegend());
  // スマートフォン幅（.layoutの縦積みへの切替と同じ760pxを基準）では、地図の
  // 表示領域を優先し、凡例は既定で折りたたんでおく。
  toggleLegend(window.innerWidth <= 760);

  document.querySelectorAll(".type-filter-cb").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) activeTypeFilter.add(cb.value);
      else activeTypeFilter.delete(cb.value);
      renderShelterMarkers();
      renderShelterList();
    });
  });

  document.getElementById("acceptingOnlyCb").addEventListener("change", (e) => {
    acceptingOnly = e.target.checked;
    renderShelterMarkers();
    renderShelterList();
  });

  document.getElementById("avoidAllHazardsCb").addEventListener("change", (e) => {
    avoidAllHazards = e.target.checked;
  });

  document.getElementById("pickOnMapBtn").addEventListener("click", togglePickLocation);

  document.getElementById("elevationRouteToggleBtn").addEventListener("click", toggleElevationRoutePanel);
  const elevationSlider = document.getElementById("elevationThresholdSlider");
  elevationSlider.addEventListener("input", () => {
    updateElevationThresholdDisplay(sliderPositionToElevation(parseFloat(elevationSlider.value)));
  });
  elevationSlider.addEventListener("change", () => {
    const elev = sliderPositionToElevation(parseFloat(elevationSlider.value));
    updateElevationThresholdDisplay(elev);
    runElevationRoute(elev);
  });
  // 矢印キー操作は、ネイティブのstep（つまみの生位置単位）ではなく、ゾーンごとの
  // 刻み幅（0〜10mは1m、10〜20mは2m、20m以上は5m）で1段ずつ動くようにする。
  elevationSlider.addEventListener("keydown", (e) => {
    const dirKeys = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
    if (e.key in dirKeys) {
      e.preventDefault();
      const next = stepElevationThreshold(dirKeys[e.key]);
      updateElevationThresholdDisplay(next);
      runElevationRoute(next);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const ticks = ELEVATION_SLIDER_TICKS;
      const next = e.key === "Home" ? ticks[0] : ticks[ticks.length - 1];
      updateElevationThresholdDisplay(next);
      runElevationRoute(next);
    }
  });
  document.getElementById("elevationThresholdApplyBtn").addEventListener("click", () => {
    runElevationRoute(currentElevationThreshold);
  });
  document.getElementById("pickElevationOnMapBtn").addEventListener("click", togglePickElevationPoint);

  document.getElementById("checklistBtn").addEventListener("click", openChecklist);
  document.getElementById("closeChecklistBtn").addEventListener("click", () => {
    // チェック状態は各チェックボックスのchangeイベントで既にlocalStorageへ保存済みだが、
    // 「保存されずに閉じてしまうのでは」という不安なく途中でマップに戻れるよう、
    // ボタンの文言自体を「一時保存してマップに戻る」に変更した（2026-09-25、ユーザー指摘）。
    document.getElementById("checklistModal").hidden = true;
  });
  document.getElementById("clearChecklistBtn").addEventListener("click", () => {
    checklistChecked = {};
    localStorage.setItem("nakatsu_bousai_checklist", JSON.stringify(checklistChecked));
    renderChecklist();
  });
  document.querySelectorAll(".household-cb").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) checklistHousehold.add(cb.value);
      else checklistHousehold.delete(cb.value);
      localStorage.setItem("nakatsu_bousai_household", JSON.stringify([...checklistHousehold]));
      renderChecklist();
    });
  });

  document.getElementById("warningBannerCloseBtn").addEventListener("click", () => {
    warningBannerDismissed = true;
    document.getElementById("warningBanner").hidden = true;
  });
  document.getElementById("warningOpenChecklistBtn").addEventListener("click", openChecklist);

  window.addEventListener("online", updateOfflineBadge);
  window.addEventListener("offline", updateOfflineBadge);
  updateOfflineBadge();
}

function updateOfflineBadge() {
  document.getElementById("offlineBadge").hidden = navigator.onLine;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // 初期表示に必要なリソース（CSS/JS/避難所データ/道路網データ等）が一斉に
  // 読み込まれている最中にSW登録を割り込ませると、環境によっては同時接続数の
  // 競合でSW登録自体が失敗することがある（実機検証で確認）。ページの
  // loadイベント後まで遅延させるのはPWAの標準的なベストプラクティスであり、
  // 初期表示の体感速度にも影響しない。
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("[sw] registration failed", e));
  });
}

async function loadRoutingGraph() {
  // サーバー・外部APIなし、中津市道路網データのみでブラウザ内完結する経路探索。
  try {
    const info = await routingGraph.load("public/data/routing_graph.json");
    console.log("[routing graph loaded]", info);
  } catch (e) {
    console.warn("routing graph failed to load", e);
  }
}

function clearRoute() {
  if (routeLayer) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }
  if (elevationRouteLayer) {
    map.removeLayer(elevationRouteLayer);
    elevationRouteLayer = null;
  }
  if (pickedPointMarker) {
    map.removeLayer(pickedPointMarker);
    pickedPointMarker = null;
  }
  if (elevationSafePointMarker) {
    map.removeLayer(elevationSafePointMarker);
    elevationSafePointMarker = null;
  }
  document.getElementById("clearRouteBtn").hidden = true;
  lastRouteDestination = null;
  if (elevationFilterThreshold != null) {
    elevationFilterThreshold = null;
    renderShelterMarkers();
    renderShelterList();
  }
}

// 現在選択中のハザード種別（表示レイヤー）に加え、「危険エリアを避けたルートにする」
// トグルがONの場合は表示状態に関わらず4種全てを回避対象とする。
function currentAvoidMask() {
  let avoidMask = 0;
  activeHazards.forEach((h) => {
    avoidMask |= HAZARD_BITS[h] || 0;
  });
  if (avoidAllHazards) {
    avoidMask |= HAZARD_BITS.flood | HAZARD_BITS.sediment | HAZARD_BITS.hightide | HAZARD_BITS.tsunami;
  }
  return avoidMask;
}

// 出発地→（経由地があれば最適順序で立ち寄り）→目的地、の経路を計算する（2026-09-25、
// 経由地機能の追加に伴いcomputeRouteTo()を置き換え）。経由地が無い場合は従来通りの
// 単純な2点間探索となる。経由地がある場合、出発地・目的地の位置は固定したまま経由地の
// 巡回順序を全探索し、実際の道路距離（ハザード回避時はソフト回避後の実距離）の総和が
// 最小となる順序を採用する。経由地数の上限（MAX_WAYPOINTS=6）は6!=720通りに収まり、
// 主要な経路探索サービスも少数の経由地では同様の全探索的な最適化を行っているため、
// ブラウザ内でも実用上問題ない速度で計算できる（web調査で確認、作業記録.md参照）。
async function computeMultiStopRoute(destLat, destLon) {
  if (!userLocation || !routingGraph.loaded) return null;
  // UIをブロックしないよう次フレームで計算（同期Dijkstraのため）
  await new Promise((r) => setTimeout(r, 20));
  const avoidMask = currentAvoidMask();
  const t0 = performance.now();

  if (routeWaypoints.length === 0) {
    const result = routingGraph.route(userLocation.lat, userLocation.lon, destLat, destLon, avoidMask);
    return { result, elapsed: performance.now() - t0, waypointOrder: null };
  }

  const points = [{ lat: userLocation.lat, lon: userLocation.lon }, ...routeWaypoints, { lat: destLat, lon: destLon }];
  const n = points.length;

  // 全ペア間（i<j）の経路をあらかじめ計算しておき、順列評価では距離の合算のみ行う
  const legCache = new Map();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = routingGraph.route(points[i].lat, points[i].lon, points[j].lat, points[j].lon, avoidMask);
      if (!r) return { result: null, elapsed: performance.now() - t0, waypointOrder: null };
      legCache.set(`${i}-${j}`, r);
    }
  }
  const legOf = (i, j) => legCache.get(i < j ? `${i}-${j}` : `${j}-${i}`);

  // 出発地(0)・目的地(n-1)を固定し、経由地(1..n-2)の順列を全探索して総距離最小の順序を求める
  const waypointIdx = [];
  for (let i = 1; i < n - 1; i++) waypointIdx.push(i);

  function permutations(arr) {
    if (arr.length <= 1) return [arr];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1));
      for (const p of permutations(rest)) out.push([arr[i], ...p]);
    }
    return out;
  }

  let bestOrder = null;
  let bestDistance = Infinity;
  for (const perm of permutations(waypointIdx)) {
    const order = [0, ...perm, n - 1];
    let total = 0;
    for (let k = 0; k < order.length - 1; k++) total += legOf(order[k], order[k + 1]).distanceM;
    if (total < bestDistance) {
      bestDistance = total;
      bestOrder = order;
    }
  }

  // 最良順序に沿って各区間のパスをつなぎ合わせ、1本の描画用パスにする
  let combinedPath = [];
  let hazardEdgeCount = 0;
  for (let k = 0; k < bestOrder.length - 1; k++) {
    const i = bestOrder[k];
    const j = bestOrder[k + 1];
    const leg = legOf(i, j);
    const path = i < j ? leg.path : [...leg.path].reverse();
    combinedPath = k === 0 ? combinedPath.concat(path) : combinedPath.concat(path.slice(1));
    hazardEdgeCount += leg.hazardEdgeCount;
  }

  const result = { path: combinedPath, distanceM: bestDistance, hazardEdgeCount, avoided: avoidMask !== 0 };
  const waypointOrder = bestOrder.slice(1, -1).map((idx) => routeWaypoints[idx - 1]);
  return { result, elapsed: performance.now() - t0, waypointOrder };
}

function routeResultText(result, elapsed, waypointOrder) {
  const dict = i18nCache[currentLang] || {};
  const km = (result.distanceM / 1000).toFixed(2);
  let text = `${dict.routing_distance || ""}: ${km} km （${Math.round(elapsed)}ms）`;
  if (result.avoided) {
    text += result.hazardEdgeCount > 0
      ? ` ／ ${dict.routing_hazard_unavoidable || ""}`
      : ` ／ ${dict.routing_hazard_avoided || ""}`;
  }
  if (waypointOrder && waypointOrder.length > 0) {
    const names = waypointOrder.map((w) => w.label || dict.waypoint_default_label || "").join(" → ");
    text = `${dict.route_via_prefix || ""}: ${names} ／ ${text}`;
  }
  return text;
}

function drawRouteLayer(result) {
  clearRoute();
  routeLayer = L.polyline(result.path, {
    color: "#009e73",
    weight: 5,
    opacity: 0.85,
    dashArray: "1,8",
    lineCap: "round",
  }).addTo(map);
  map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
  document.getElementById("clearRouteBtn").hidden = false;
}

async function showRouteToSelected() {
  const dict = i18nCache[currentLang] || {};
  const infoEl = document.getElementById("detailRouteInfo");

  if (!userLocation) {
    infoEl.hidden = false;
    infoEl.textContent = dict.routing_need_location || "";
    return;
  }
  if (!selectedShelter || !routingGraph.loaded) return;

  infoEl.hidden = false;
  infoEl.textContent = dict.routing_calculating || "";

  const { result, elapsed, waypointOrder } = await computeMultiStopRoute(selectedShelter.lat, selectedShelter.lon);

  if (!result) {
    infoEl.textContent = dict.routing_no_route || "";
    return;
  }

  drawRouteLayer(result);
  infoEl.textContent = routeResultText(result, elapsed, waypointOrder);
  document.getElementById("shelterDetail").hidden = true;
  lastRouteDestination = { lat: selectedShelter.lat, lon: selectedShelter.lon, kind: "shelter" };
}

// 地図上で指定した任意の地点、または保存済み地点を目的地としてルート表示する
// （避難所一覧に無い地点でも危険性を確認できるようにするための機能）。
// 結果は目的地マーカーに紐づくポップアップで表示する。
async function routeToPoint(destLat, destLon, label) {
  const dict = i18nCache[currentLang] || {};

  if (pickedPointMarker) {
    map.removeLayer(pickedPointMarker);
    pickedPointMarker = null;
  }

  if (!userLocation) {
    pickedPointMarker = L.marker([destLat, destLon])
      .addTo(map)
      .bindPopup(dict.routing_need_location || "")
      .openPopup();
    return;
  }
  if (!routingGraph.loaded) return;

  const { result, elapsed, waypointOrder } = await computeMultiStopRoute(destLat, destLon);

  if (!result) {
    pickedPointMarker = L.marker([destLat, destLon]).addTo(map).bindPopup(dict.routing_no_route || "").openPopup();
    return;
  }

  // drawRouteLayer()内部のclearRoute()がpickedPointMarkerも消してしまうため、
  // マーカーの作成は必ずdrawRouteLayer()の後で行う。
  drawRouteLayer(result);
  pickedPointMarker = L.marker([destLat, destLon]).addTo(map);
  const popupText = label ? `${label} - ${routeResultText(result, elapsed, waypointOrder)}` : routeResultText(result, elapsed, waypointOrder);
  pickedPointMarker.bindPopup(popupText).openPopup();
  lastRouteDestination = { lat: destLat, lon: destLon, kind: "point", label };
}

// 「指定標高以上のルート」機能（2026-09-25追加）。
// ハザードマップの危険範囲は行政が想定した一定の条件下での浸水域であり、実際の
// 浸水がそれを超えて広がる可能性がある（ユーザー指摘）。そのため「ハザードエリア外か」
// ではなく「標高が十分に高いか」という、より安全側に倒した基準で避難路を確認できる
// ようにする。現在地が指定標高未満の場合は、まず道路網上で最も近い「指定標高以上の
// 地点」（＝高台）までの経路（避難路）を求め、続けてその地点を起点に指定標高以上の
// 避難所までの経路を求める、という2段階の探索を行う。
function togglePickElevationPoint() {
  pickingElevationPoint = !pickingElevationPoint;
  const btn = document.getElementById("pickElevationOnMapBtn");
  const hint = document.getElementById("elevationRouteHint");
  const dict = i18nCache[currentLang] || {};
  btn.setAttribute("aria-pressed", pickingElevationPoint ? "true" : "false");
  map.getContainer().style.cursor = pickingElevationPoint ? "crosshair" : "";
  hint.classList.remove("error");
  hint.textContent = pickingElevationPoint ? dict.pick_elevation_on_map_hint || "" : "";
}

function toggleElevationRoutePanel() {
  const panel = document.getElementById("elevationRoutePanel");
  const btn = document.getElementById("elevationRouteToggleBtn");
  const opening = panel.hidden;
  panel.hidden = !opening;
  btn.setAttribute("aria-pressed", opening ? "true" : "false");
}

// スライダーの数値表示を更新する。currentElevationThresholdを正として保持し、
// スライダーのつまみ位置はそこから導出する（つまみの生位置は0〜100の非線形スケール
// であり、標高そのものではないため）。地図で標高を指定した場合、スライダーの可動域
// （0〜50m、洪水浸水想定区域の実データに基づく範囲）を超えることがあるが、その場合は
// つまみを可動域の端に留めつつ、実際に検索へ使う値（表示テキスト）は丸めずそのまま示す。
function updateElevationThresholdDisplay(value) {
  currentElevationThreshold = value;
  const slider = document.getElementById("elevationThresholdSlider");
  const readout = document.getElementById("elevationThresholdValue");
  const dict = i18nCache[currentLang] || {};
  slider.value = String(elevationToSliderPosition(value));
  const label = Number.isInteger(value) ? String(value) : value.toFixed(1);
  readout.textContent = `${label}${dict.elevation_route_unit_suffix || ""}`;
}

async function handleElevationPointPicked(lat, lon) {
  const dict = i18nCache[currentLang] || {};
  const hint = document.getElementById("elevationRouteHint");
  hint.classList.remove("error");
  hint.textContent = dict.routing_calculating || "";

  const elev = await getElevationAtPoint(lat, lon);
  if (elev == null) {
    hint.classList.add("error");
    hint.textContent = dict.elevation_route_pick_failed || "";
    return;
  }
  updateElevationThresholdDisplay(elev);
  document.getElementById("elevationRoutePanel").hidden = false;
  document.getElementById("elevationRouteToggleBtn").setAttribute("aria-pressed", "true");
  await runElevationRoute(elev);
}

// 指定標高以上の避難所のうち、直線距離が近い上位候補について実際の道路距離を比較し、
// 最短のものを採用する（直線距離のみで選ぶfindNearestAccepting()よりも精度を高めた設計。
// 全候補について経路計算すると重いため、直線距離上位5件に絞って計算する）。
//
// 条件（受入可否・標高）に完全一致する避難所が1件も無い場合でも「見つかりませんでした」
// という行き止まりの応答にはせず、段階的に条件を緩めて代替を探す（2026-09-25、ユーザー
// 指摘を受けて追加）。受入状況データはサンプル18件のみで大半の避難所が「未確認」扱いに
// なるため、受入可能フィルタを有効にしたまま標高条件も課すと候補が0件になりやすい、という
// 実際に確認された問題への対処。種別フィルタ（避難所／避難ビル／福祉避難所）に一致する
// 避難所が1件も無い場合のみ、最終的にnullを返す。
function bestQualifyingShelterRoute(fromLat, fromLon, minElevation, avoidMask) {
  const typeMatched = shelters.filter((s) => s.lat != null && s.lon != null && activeTypeFilter.has(s.type));
  if (typeMatched.length === 0) return null;

  // 優先度順に候補プールを用意する: ①受入可否＋標高の両方を満たす ②標高のみ満たす
  // （受入状況が未確認でも表示） ③種別のみ満たす（標高が最も高い避難所を代替として提示）
  const pools = [
    { shelters: typeMatched.filter((s) => (!acceptingOnly || isAccepting(s)) && s.elevation_m != null && s.elevation_m >= minElevation), relaxedAccepting: false, relaxedElevation: false },
    { shelters: typeMatched.filter((s) => s.elevation_m != null && s.elevation_m >= minElevation), relaxedAccepting: true, relaxedElevation: false },
    { shelters: typeMatched, relaxedAccepting: true, relaxedElevation: true },
  ];

  for (const pool of pools) {
    if (pool.shelters.length === 0) continue;
    const topCandidates = pool.relaxedElevation
      ? [...pool.shelters].sort((a, b) => (b.elevation_m ?? -Infinity) - (a.elevation_m ?? -Infinity)).slice(0, 5)
      : pool.shelters
          .map((s) => ({ ...s, straightDist: haversineKm(fromLat, fromLon, s.lat, s.lon) }))
          .sort((a, b) => a.straightDist - b.straightDist)
          .slice(0, 5);

    let best = null;
    for (const cand of topCandidates) {
      const result = routingGraph.route(fromLat, fromLon, cand.lat, cand.lon, avoidMask);
      if (result && (!best || result.distanceM < best.result.distanceM)) {
        best = { shelter: cand, result };
      }
    }
    if (best) {
      return { ...best, metTarget: !pool.relaxedAccepting && !pool.relaxedElevation, relaxedAccepting: pool.relaxedAccepting, relaxedElevation: pool.relaxedElevation };
    }
  }
  return null;
}

async function runElevationRoute(minElevation) {
  const dict = i18nCache[currentLang] || {};
  const hint = document.getElementById("elevationRouteHint");

  if (!userLocation) {
    hint.classList.add("error");
    hint.textContent = dict.routing_need_location || "";
    return;
  }
  if (!routingGraph.loaded) return;

  hint.classList.remove("error");
  hint.textContent = dict.routing_calculating || "";
  await new Promise((r) => setTimeout(r, 20));

  const avoidMask = currentAvoidMask();
  const originElev = await getElevationAtPoint(userLocation.lat, userLocation.lon);

  let escapeResult = null;
  let searchFromLat = userLocation.lat;
  let searchFromLon = userLocation.lon;

  if (originElev == null || originElev < minElevation) {
    escapeResult = routingGraph.findNearestNodeAtElevation(userLocation.lat, userLocation.lon, minElevation, avoidMask);
    if (!escapeResult) {
      hint.classList.add("error");
      hint.textContent = dict.elevation_route_no_safe_point || "";
      return;
    }
    searchFromLat = escapeResult.lat;
    searchFromLon = escapeResult.lon;
  }

  const best = bestQualifyingShelterRoute(searchFromLat, searchFromLon, minElevation, avoidMask);
  if (!best) {
    hint.classList.add("error");
    hint.textContent = dict.elevation_route_no_shelter || "";
    return;
  }

  drawElevationRoute(escapeResult, best.result, minElevation);
  const resultText = elevationRouteResultText(escapeResult, best, originElev == null);
  hint.classList.remove("error");
  hint.textContent = resultText;

  // 実際に表示している避難所が指定標高に届いていない場合、一覧・マーカーの絞り込みを
  // 掛けると当の避難所自体が非表示になってしまうため、その場合のみフィルタを掛けない
  // （受入可否のみ緩和した場合は、標高条件自体は満たしているのでフィルタして問題ない）。
  elevationFilterThreshold = best.relaxedElevation ? null : minElevation;
  renderShelterMarkers();
  renderShelterList();

  showShelterDetail(best.shelter);
  const infoEl = document.getElementById("detailRouteInfo");
  infoEl.hidden = false;
  infoEl.textContent = resultText;
}

function elevationRouteResultText(escapeResult, best, originUnknown) {
  const dict = i18nCache[currentLang] || {};
  const shelterResult = best.result;
  const kmShelter = (shelterResult.distanceM / 1000).toFixed(2);

  let text;
  if (escapeResult) {
    const kmEscape = (escapeResult.distanceM / 1000).toFixed(2);
    const elevText = escapeResult.elevation != null ? escapeResult.elevation.toFixed(1) + "m" : "?";
    text = `${dict.elevation_route_escape_leg || ""}: ${kmEscape} km（${elevText}）／ ${dict.elevation_route_shelter_leg || ""}: ${kmShelter} km`;
  } else {
    text = `${dict.elevation_route_direct || ""}: ${kmShelter} km`;
  }

  const notes = [];
  if (originUnknown) notes.push(dict.elevation_route_origin_unknown || "");
  if (escapeResult && !escapeResult.metTarget) notes.push(dict.elevation_route_escape_not_met || "");
  if (best.relaxedElevation) notes.push(dict.elevation_route_shelter_not_met || "");
  else if (best.relaxedAccepting) notes.push(dict.elevation_route_shelter_relaxed_accepting || "");
  if (notes.length) text += ` ／ ${notes.join(" ")}`;

  return text;
}

function drawElevationRoute(escapeResult, shelterResult, minElevation) {
  clearRoute();
  const layers = [];

  if (escapeResult) {
    layers.push(
      L.polyline(escapeResult.path, {
        color: "#c9871f",
        weight: 5,
        opacity: 0.9,
        dashArray: "2,10",
        lineCap: "round",
      })
    );
    elevationSafePointMarker = L.circleMarker([escapeResult.lat, escapeResult.lon], {
      radius: 7,
      color: "#8a5f14",
      fillColor: "#c9871f",
      fillOpacity: 1,
      weight: 2,
    })
      .addTo(map)
      .bindPopup(`${escapeResult.elevation != null ? escapeResult.elevation.toFixed(1) : "?"}m`);
  }

  layers.push(
    L.polyline(shelterResult.path, {
      color: "#009e73",
      weight: 5,
      opacity: 0.85,
      dashArray: "1,8",
      lineCap: "round",
    })
  );

  elevationRouteLayer = L.layerGroup(layers).addTo(map);
  const bounds = L.latLngBounds(layers.flatMap((l) => l.getLatLngs()));
  map.fitBounds(bounds, { padding: [40, 40] });
  document.getElementById("clearRouteBtn").hidden = false;
}

async function loadChecklist() {
  try {
    const res = await fetch("public/data/checklist.json");
    checklistData = await res.json();
  } catch (e) {
    console.warn("checklist.json failed to load", e);
  }
}

function itemLabel(item) {
  return item.label[currentLang] || item.label.ja;
}

function renderChecklist() {
  if (!checklistData) return;
  const dict = i18nCache[currentLang] || {};
  const body = document.getElementById("checklistBody");
  body.innerHTML = "";

  checklistData.categories.forEach((cat) => {
    const isOptional = !!cat.optionalHousehold;
    if (isOptional && !checklistHousehold.has(cat.optionalHousehold)) return;

    const section = document.createElement("div");
    section.className = "checklist-category";

    const title = document.createElement("h3");
    title.className = "checklist-category-title";
    title.textContent = cat.name[currentLang] || cat.name.ja;
    section.appendChild(title);

    cat.items.forEach((item) => {
      // household指定つきの項目（乳幼児/子ども向け等）は該当世帯のみ表示
      if (item.household && !item.household.some((h) => checklistHousehold.has(h))) return;

      const row = document.createElement("div");
      row.className = "checklist-item";
      const checked = !!checklistChecked[item.id];
      if (checked) row.classList.add("checked");

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = "chk-" + item.id;
      cb.checked = checked;
      cb.addEventListener("change", () => {
        checklistChecked[item.id] = cb.checked;
        localStorage.setItem("nakatsu_bousai_checklist", JSON.stringify(checklistChecked));
        row.classList.toggle("checked", cb.checked);
        updateChecklistProgress();
      });
      row.appendChild(cb);

      const label = document.createElement("label");
      label.htmlFor = cb.id;
      label.textContent = itemLabel(item);
      row.appendChild(label);

      if (item.highlight && item.highlight.some((h) => activeHazards.has(h))) {
        const badge = document.createElement("span");
        badge.className = "checklist-relevant";
        badge.textContent = dict.checklist_relevant_badge || "";
        row.appendChild(badge);
      }

      section.appendChild(row);
    });

    body.appendChild(section);
  });

  document.getElementById("checklistSourceNote").textContent =
    (dict.checklist_source_label || "Source") + ": " + (checklistData.source_note || "");

  updateChecklistProgress();
}

function updateChecklistProgress() {
  if (!checklistData) return;
  const dict = i18nCache[currentLang] || {};
  let total = 0;
  let done = 0;

  checklistData.categories.forEach((cat) => {
    const isOptional = !!cat.optionalHousehold;
    if (isOptional && !checklistHousehold.has(cat.optionalHousehold)) return;
    cat.items.forEach((item) => {
      if (item.household && !item.household.some((h) => checklistHousehold.has(h))) return;
      total++;
      if (checklistChecked[item.id]) done++;
    });
  });

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById("checklistProgressFill").style.width = pct + "%";
  document.getElementById("checklistProgressText").textContent = `${dict.checklist_progress || ""} ${done}/${total} (${pct}%)`;
}

function openChecklist() {
  document.querySelectorAll(".household-cb").forEach((cb) => {
    cb.checked = checklistHousehold.has(cb.value);
  });
  renderChecklist();
  document.getElementById("checklistModal").hidden = false;
}

async function main() {
  initMap();
  wireEvents();
  registerServiceWorker();
  await setLanguage(currentLang);
  await loadShelters();
  await loadRoutingGraph();
  await loadChecklist();
  document.getElementById("caveatModal").hidden = false;
  // 起動時に現在地を取得できれば、発表中の警報と突き合わせて該当ハザードマップ等を
  // 自動表示する（7.2/7.3/7.5節）。位置情報が拒否・失敗した場合は静かに諦める。
  // GPSが使えない場合は、保存済みの出発地（savedLocationsSection）から
  // ワンタップで選択できる代替導線をアプリ起動時から常時表示する。
  locateUser();
}

main();
