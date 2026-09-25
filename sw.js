/* 中津市防災マップ PWA Service Worker
   災害時の通信断・輻輳を想定し、地図・ハザードデータ・避難所データをオフラインでも
   閲覧できるようにする。外部サービス・サーバーには依存しない。

   キャッシュ戦略（重要）:
   - アプリ本体（HTML/JS/CSS/i18n）と、頻繁に更新されうるデータ（避難所受入状況等）は
     「ネットワーク優先」とする。7.4節で採用した手動更新方式では、担当者が
     shelter_status.json を差し替えても、キャッシュファーストのままだとオンライン中の
     利用者にすら更新が届かないため、ここを優先することが重要。
   - 大容量で更新頻度が低いデータ（ハザードGeoJSON・道路網グラフ）は「キャッシュ優先」とし、
     通信量とオフライン耐性を優先する。
   - 地理院地図タイルは stale-while-revalidate（表示速度とオフライン閲覧の両立）。 */

const CACHE_VERSION = "v29";
const CACHE_NAME = `nakatsu-bousai-${CACHE_VERSION}`;

const NETWORK_FIRST_URLS = [
  "./",
  "index.html",
  "manifest.json",
  "src/styles.css",
  "src/main.js",
  "src/routing.js",
  "src/i18n/ja.json",
  "src/i18n/ja-easy.json",
  "src/i18n/en.json",
  "src/i18n/id.json",
  "src/i18n/vi.json",
  "src/i18n/my.json",
  "public/data/shelters.json",
  "public/data/shelter_status.json",
];

const CACHE_FIRST_URLS = [
  "public/data/checklist.json",
  "public/data/routing_graph.json",
  "public/hazard/flood_planned.geojson",
  "public/hazard/sediment.geojson",
  "public/hazard/hightide.geojson",
  "public/hazard/tsunami.geojson",
  "public/icons/icon-192.png",
  "public/icons/icon-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
];

const PRECACHE_URLS = [...NETWORK_FIRST_URLS, ...CACHE_FIRST_URLS];

self.addEventListener("install", (event) => {
  // cache.addAll()は内部でfetch()を使うが、既定ではブラウザのHTTPキャッシュを
  // 経由してしまい、サーバー側でファイルを更新してもSWのプリキャッシュ自体が
  // 古い内容を取り込んでしまうことがある。{cache:"reload"}で必ずネットワークから
  // 取得させ、CACHE_VERSIONを上げた際に確実に最新化されるようにする。
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          PRECACHE_URLS.map((url) =>
            fetch(url, { cache: "reload" })
              .then((res) => {
                if (res && res.status === 200) return cache.put(url, res);
              })
              .catch((err) => console.warn("[sw] precache failed:", url, err))
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  if (req.url.includes("cyberjapandata.gsi.go.jp")) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // 気象庁の警報・注意報APIはリアルタイム性が安全に直結するため、SWでは一切
  // キャッシュせずブラウザの通常のネットワーク取得に任せる（介入しない）。
  if (req.url.includes("jma.go.jp/bosai/warning/") || req.url.includes("jma.go.jp/bosai/tsunami/")) {
    return;
  }
  // 住所検索（国土地理院API・Nominatim）も同様にキャッシュ対象外とする
  // （クエリ文字列ごとにキャッシュが際限なく増えるのを防ぎ、常に最新の検索結果を返す）。
  if (req.url.includes("nominatim.openstreetmap.org") || req.url.includes("msearch.gsi.go.jp")) {
    return;
  }

  const urlNoQuery = req.url.split("?")[0];
  const isNetworkFirst = NETWORK_FIRST_URLS.some((u) => urlNoQuery.endsWith(u) || urlNoQuery.endsWith(u.replace("./", "/")));
  event.respondWith(isNetworkFirst ? networkFirst(req) : cacheFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req, { cache: "reload" });
    if (res && res.status === 200) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req, { cache: "reload" });
  if (res && res.status === 200) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const network = fetch(req, { cache: "reload" })
    .then((res) => {
      if (res && res.status === 200) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || new Response("", { status: 504 });
}
