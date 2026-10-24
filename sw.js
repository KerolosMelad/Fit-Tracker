/* KeJu Fit Tracker — network-first shell; updates apply quietly */
const CACHE = "keju-shell-v129";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./config.js",
  "./db.js",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  "./templates/packs.js",
  "./templates/manifest.json",
  "./templates/phase-restart-3day.json",
  "./templates/phase-cut-weeks-3-4.json",
  "./templates/phase-cut-10week.json",
  "./templates/phase-cut-12week-julia.json",
];

/* Redirected / no-store responses cannot be replayed for navigations offline; store clean copies. */
async function cleanResponse(res) {
  const headers = new Headers(res.headers);
  headers.delete("cache-control");
  const body = await res.clone().blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

async function putClean(cache, key, res) {
  if (!res || !res.ok) return;
  await cache.put(key, await cleanResponse(res));
}

async function precache() {
  const c = await caches.open(CACHE);
  await Promise.all(
    SHELL.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: "reload" }));
        await putClean(c, url, res);
        if (url === "./") await putClean(c, "./index.html", res);
      } catch (err) {
        console.warn("[keju-sw] skip cache", url, err);
      }
    })
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const NETWORK_TIMEOUT_MS = 4000;

function fetchWithTimeout(req) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
  return fetch(req, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function fromCache(req, isDoc) {
  const c = await caches.open(CACHE);
  const opts = { ignoreSearch: true };
  let hit = await c.match(req, opts);
  if (!hit && isDoc) hit = (await c.match("./", opts)) || (await c.match("./index.html", opts));
  return hit || new Response("", { status: 504, statusText: "Offline" });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  if (path.includes("/api/")) return;
  const isDoc =
    req.mode === "navigate" ||
    path.endsWith("/") ||
    path.endsWith(".html") ||
    path === new URL("./", self.registration.scope).pathname;

  event.respondWith(
    fetchWithTimeout(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          event.waitUntil(
            caches.open(CACHE).then((c) => putClean(c, req, copy)).catch(() => {})
          );
        }
        return res;
      })
      .catch(() => fromCache(req, isDoc))
  );
});
