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
  renderShelterList();
  renderSavedLocations();
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
    selectBtn.addEventListener("click", () => setUserLocation(loc.lat, loc.lon));
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

// 国土地理院（GSI）の住所検索API。無料・登録不要。Nominatim（OpenStreetMap）は
// 「豊田1丁目1番地111」のような日本の住所表記（丁目・番地、全角/半角ハイフン等の
// 表記ゆれを含む）にほぼ対応できないことが実機検証で判明した（同じ場所を指す
// 複数の表記を試してもすべて0件だった）。国土地理院のAPIは日本の住居表示・地番
// データそのものを検索するため、こうした表記ゆれを自然に吸収できる。
// ただし都道府県・市区町村名を含まないと全国から同名地名を拾ってしまうため、
// 必ず「中津市」を前置し、かつ返ってきた候補が中津市周辺のバウンディングボックス内に
// あるものだけを採用する（他都市の同名地区への誤マッチ防止）。
const GSI_ADDRESS_SEARCH_URL = "https://msearch.gsi.go.jp/address-search/AddressSearch";

async function tryGsiAddressSearch(query) {
  try {
    const url = `${GSI_ADDRESS_SEARCH_URL}?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const results = await res.json();
    if (!Array.isArray(results)) return null;
    for (const r of results) {
      const coords = r.geometry && r.geometry.coordinates;
      if (!coords) continue;
      const [lon, lat] = coords;
      if (inNakatsuBbox(lat, lon)) return { lat, lon };
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

    const topImportance = Math.max(...results.map((c) => c.importance || 0));
    const topCandidates = results.filter((c) => (c.importance || 0) >= topImportance - 1e-9);
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

  hint.classList.remove("error");
  hint.textContent = dict.loading || "";
  btn.disabled = true;

  try {
    // 国土地理院APIは都道府県・市区町村→地区→丁目→番地という階層構造で住所を
    // 解釈するため、「中津市」は先頭に付与する必要がある（末尾に付けると
    // 全国の同名地区がヒットしてしまうことを実機検証で確認した）。
    // すでに「中津市」を含む入力の場合は二重に付けない。
    const gsiQuery = q.includes("中津市") ? q : "中津市" + q;
    const hit = (await tryGsiAddressSearch(gsiQuery)) || (await tryNominatimSearch(q + " 中津市"));

    if (!hit) {
      hint.classList.add("error");
      hint.textContent = dict.location_search_not_found || "";
      return;
    }

    setUserLocation(hit.lat, hit.lon);
    hint.classList.remove("error");
    hint.textContent = "";
  } catch (e) {
    console.warn("[location search] failed", e);
    hint.classList.add("error");
    hint.textContent = dict.location_search_not_found || "";
  } finally {
    btn.disabled = false;
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

  document.getElementById("checklistBtn").addEventListener("click", openChecklist);
  document.getElementById("closeChecklistBtn").addEventListener("click", () => {
    document.getElementById("checklistModal").hidden = true;
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
  if (pickedPointMarker) {
    map.removeLayer(pickedPointMarker);
    pickedPointMarker = null;
  }
  document.getElementById("clearRouteBtn").hidden = true;
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

async function computeRouteTo(destLat, destLon) {
  if (!userLocation || !routingGraph.loaded) return null;
  // UIをブロックしないよう次フレームで計算（同期Dijkstraのため）
  await new Promise((r) => setTimeout(r, 20));
  const avoidMask = currentAvoidMask();
  const t0 = performance.now();
  const result = routingGraph.route(userLocation.lat, userLocation.lon, destLat, destLon, avoidMask);
  const elapsed = performance.now() - t0;
  return { result, elapsed };
}

function routeResultText(result, elapsed) {
  const dict = i18nCache[currentLang] || {};
  const km = (result.distanceM / 1000).toFixed(2);
  let text = `${dict.routing_distance || ""}: ${km} km （${Math.round(elapsed)}ms）`;
  if (result.avoided) {
    text += result.hazardEdgeCount > 0
      ? ` ／ ${dict.routing_hazard_unavoidable || ""}`
      : ` ／ ${dict.routing_hazard_avoided || ""}`;
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

  const { result, elapsed } = await computeRouteTo(selectedShelter.lat, selectedShelter.lon);

  if (!result) {
    infoEl.textContent = dict.routing_no_route || "";
    return;
  }

  drawRouteLayer(result);
  infoEl.textContent = routeResultText(result, elapsed);
  document.getElementById("shelterDetail").hidden = true;
}

// 地図上で指定した任意の地点を目的地としてルート表示する（避難所一覧に無い地点でも
// 危険性を確認できるようにするための機能）。結果は目的地マーカーに紐づくポップアップで表示する。
async function routeToPoint(destLat, destLon) {
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

  const { result, elapsed } = await computeRouteTo(destLat, destLon);

  if (!result) {
    pickedPointMarker = L.marker([destLat, destLon]).addTo(map).bindPopup(dict.routing_no_route || "").openPopup();
    return;
  }

  // drawRouteLayer()内部のclearRoute()がpickedPointMarkerも消してしまうため、
  // マーカーの作成は必ずdrawRouteLayer()の後で行う。
  drawRouteLayer(result);
  pickedPointMarker = L.marker([destLat, destLon]).addTo(map);
  pickedPointMarker.bindPopup(routeResultText(result, elapsed)).openPopup();
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
