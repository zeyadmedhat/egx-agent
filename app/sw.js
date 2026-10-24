// The website's offline copy (a service worker), written into the site by app/static_site.py. It keeps this version's
// page code and the last close's data on the device, so the Home Screen app opens at once, even with weak or no
// signal, then refreshes when the network answers. Everything it keeps is what the site publishes: the data stays
// encrypted, and nothing personal passes through it.
const VERSION = "__VERSION__";
const FILES = __FILES__;                 // this version's page code (static/<VERSION>/…)
const CODE = `egx-code-${VERSION}`, DATA = "egx-data", PAGE = "egx-page";
const WAIT_MS = 4000;                    // a slow network: show the kept copy after this long
const BASE = new URL(self.registration.scope).pathname;

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    await (await caches.open(CODE)).addAll(FILES);
    await (await caches.open(PAGE)).add(new Request("./", { cache: "reload" }));    // the front page of this version
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("egx-code-") && k !== CODE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// The network, or the kept copy if it fails or takes longer than WAIT_MS. A fresh answer replaces the kept copy.
async function networkFirst(e, key) {
  const cache = await caches.open(PAGE);
  const net = fetch(e.request).then(res => {
    if (res.ok) e.waitUntil(cache.put(key, res.clone()));
    return res;
  });
  net.catch(() => null);                 // answered from the kept copy instead
  try {
    return await Promise.race([net, new Promise((_, no) => setTimeout(no, WAIT_MS))]);
  } catch {
    return (await cache.match(key)) || net;
  }
}

// Page code never changes under its address (static/<version>/…): the kept copy is always right.
async function codeFirst(e) {
  const hit = await caches.match(e.request);
  if (hit) return hit;
  const res = await fetch(e.request);
  if (res.ok) e.waitUntil(caches.open(CODE).then(c => c.put(e.request, res.clone())));
  return res;
}

// data/<name>.bin?v=<stamp>: the same address always holds the same data. Only the latest scan's files are kept.
async function dataFirst(e, url) {
  const cache = await caches.open(DATA);
  const hit = await cache.match(e.request);
  if (hit) return hit;
  const res = await fetch(e.request);
  if (res.ok) {
    e.waitUntil((async () => {
      await cache.put(e.request, res.clone());
      const stamp = url.searchParams.get("v");
      for (const r of await cache.keys()) if (new URL(r.url).searchParams.get("v") !== stamp) await cache.delete(r);
    })());
  }
  return res;
}

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith(BASE)) return;
  const path = url.pathname.slice(BASE.length);
  if (path.startsWith("static/")) e.respondWith(codeFirst(e));
  else if (path.startsWith("data/") && path.endsWith(".bin") && url.searchParams.get("v")) e.respondWith(dataFirst(e, url));
  else if (e.request.mode === "navigate" || path === "" || path === "index.html") e.respondWith(networkFirst(e, "./"));
  else if (path === "data/site.json" || path === "manifest.webmanifest") e.respondWith(networkFirst(e, path));
});
