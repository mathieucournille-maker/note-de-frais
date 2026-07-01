// sw.js — Service Worker PWA Note de Frais
// Stratégie : Cache-first pour l'app shell, network-first pour les API (ORS, jsPDF CDN)
// Toutes les données utilisateur restent en localStorage sur l'appareil — ce SW
// ne gère que la disponibilité hors-ligne de l'interface.

const CACHE_NAME = "notes-frais-v2";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/icon-180.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// ── Installation : met en cache le strict nécessaire pour démarrer hors-ligne ──
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ── Activation : purge les anciens caches ──────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Ne jamais intercepter les appels API (ORS) ou le CDN jsPDF :
  // ils doivent toujours tenter le réseau, sans fallback cache (données dynamiques)
  const isExternalAPI =
    url.hostname.includes("openrouteservice.org") ||
    url.hostname.includes("cdnjs.cloudflare.com");

  if (isExternalAPI) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(
          JSON.stringify({ error: "offline", message: "Connexion requise pour cette fonctionnalité." }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    return;
  }

  // App shell : cache-first avec mise à jour silencieuse en arrière-plan
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && event.request.method === "GET") {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached); // hors-ligne → sert le cache

      return cached || networkFetch;
    })
  );
});
