const CACHE_NAME = 'speedreader-v16';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
];

// Domains that should NEVER be intercepted by the service worker.
// These need direct network access — caching or cloning SSE/streaming
// responses breaks them silently on mobile Chrome.
const PASSTHROUGH_DOMAINS = [
  'hf.space',
  'huggingface.co',
  'gradio.live',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;
  
  // Skip .onnx and .wasm files (large model files, let browser handle)
  const url = new URL(event.request.url);
  if (url.pathname.includes('.onnx') || url.pathname.includes('.wasm')) return;
  
  // CRITICAL: Skip passthrough domains entirely.
  // On mobile Chrome, intercepting cross-origin SSE (text/event-stream)
  // or streaming responses and calling response.clone() + cache.put()
  // can cause the response to hang or fail silently.
  const hostname = url.hostname;
  for (const domain of PASSTHROUGH_DOMAINS) {
    if (hostname.endsWith(domain)) return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((response) => {
        if (!response.ok) return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      });
    }).catch(() => {
      if (event.request.mode === 'navigate') return caches.match('./index.html');
    })
  );
});
