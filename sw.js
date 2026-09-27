/* KeJu Fit Tracker — network-first shell; updates apply quietly */
const CACHE = "keju-shell-v126";
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
  "./templates/phase-cut-weeks-3-4.json",
  "./templates/phase-cut-10week.json",
  "./templates/phase-cut-12week-julia.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(async (c) => {
        // Cache each shell URL individually so one 404 does not block the whole SW install.
        await Promise.all(
          SHELL.map((url) =>
            c.add(url).catch((err) => {
              console.warn("[keju-sw] skip cache", url, err);
            })
          )
        );
      })
      .then(() => self.skipWaiting())
  );
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
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  if (path.includes("/api/")) return;
  const isDoc =
    req.mode === "navigate" ||
    path.endsWith("/") ||
    path.endsWith(".html") ||
    path === new URL("./", self.registration.scope).pathname;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then((cached) => {
          if (cached) return cached;
          if (isDoc) return caches.match("./index.html");
          return new Response("", { status: 504, statusText: "Offline" });
        })
      )
  );
});
