/* KeJu Fit Tracker — offline-first shell */
const ASSET_VER = "127";
const CACHE = `keju-shell-v${ASSET_VER}`;

const SHELL = [
  "./",
  "./index.html",
  `./styles.css?v=${ASSET_VER}`,
  "./styles.css",
  "./config.js",
  `./db.js?v=${ASSET_VER}`,
  "./db.js",
  `./app.js?v=${ASSET_VER}`,
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  `./templates/packs.js?v=${ASSET_VER}`,
  "./templates/packs.js",
  "./templates/manifest.json",
  "./templates/phase-cut-weeks-3-4.json",
  "./templates/phase-cut-10week.json",
  "./templates/phase-cut-12week-julia.json",
];

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isApiPath(pathname) {
  return pathname.includes("/api/");
}

function isStaticAsset(pathname) {
  return /\.(?:css|js|png|svg|jpg|jpeg|webp|gif|ico|webmanifest|json|woff2?|ttf|otf)$/i.test(pathname);
}

function isDocumentRequest(req, pathname) {
  return (
    req.mode === "navigate" ||
    pathname.endsWith("/") ||
    pathname.endsWith(".html") ||
    pathname === new URL("./", self.registration.scope).pathname
  );
}

async function precacheShell() {
  const cache = await caches.open(CACHE);
  await Promise.all(
    SHELL.map((url) =>
      cache.add(url).catch((err) => {
        console.warn("[keju-sw] skip cache", url, err);
      })
    )
  );
}

async function putInCache(req, res) {
  if (!res || !res.ok) return;
  try {
    const cache = await caches.open(CACHE);
    await cache.put(req, res.clone());
  } catch (_) {
    /* ignore quota / opaque failures */
  }
}

async function matchCache(req) {
  return (
    (await caches.match(req, { ignoreSearch: true })) ||
    (await caches.match(req)) ||
    null
  );
}

/** Serve cache immediately; refresh in background when online. */
async function staleWhileRevalidate(req) {
  const cached = await matchCache(req);
  const networkPromise = fetch(req)
    .then((res) => {
      if (res && res.ok) void putInCache(req, res);
      return res;
    })
    .catch(() => null);

  if (cached) {
    void networkPromise;
    return cached;
  }

  const network = await networkPromise;
  if (network) return network;
  return new Response("Offline", { status: 504, statusText: "Offline" });
}

/** Try network first for HTML; fall back to cached app shell. */
async function networkFirstDocument(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) void putInCache(req, res);
    return res;
  } catch (_) {
    const cached = await matchCache(req);
    if (cached) return cached;
    const shell =
      (await caches.match("./index.html", { ignoreSearch: true })) ||
      (await caches.match("./index.html")) ||
      (await caches.match("./"));
    if (shell) return shell;
    return new Response("Offline — open the app once online to install the shell.", {
      status: 504,
      statusText: "Offline",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Cache Google Fonts after first online load so typography works offline.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  if (!isSameOrigin(url)) return;
  if (isApiPath(url.pathname)) return;

  if (isDocumentRequest(req, url.pathname)) {
    event.respondWith(networkFirstDocument(req));
    return;
  }

  if (isStaticAsset(url.pathname) || url.pathname.includes("/templates/")) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  event.respondWith(staleWhileRevalidate(req));
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
