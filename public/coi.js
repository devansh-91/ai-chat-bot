/*
 * Cross-origin isolation from the service worker.
 *
 * Multi-threaded WebAssembly (SharedArrayBuffer) needs the page to be cross-origin isolated, which
 * requires COOP/COEP response headers. GitHub Pages cannot set headers, so this worker adds them to
 * page and worker-script responses. It makes the CPU model ~4x faster on multi-core devices.
 *
 * COEP "credentialless" keeps cross-origin loads working (model downloads, Supabase, avatars) without
 * those servers opting in. Browsers that don't support it (Safari) simply stay single-threaded.
 *
 * Imported at the top of the generated Workbox service worker, so this listener runs first.
 */
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
}

function withIsolation(res) {
  if (!res || res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(ISOLATION_HEADERS)) headers.set(k, v)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

async function fromCacheOrNetwork(request, fallbackUrl) {
  // Same cache-first behaviour Workbox uses for the app shell, so offline still works.
  const cached = await caches.match(fallbackUrl ?? request, { ignoreSearch: true })
  if (cached) return cached
  try {
    return await fetch(request)
  } catch (e) {
    if (fallbackUrl) {
      const shell = await caches.match(fallbackUrl, { ignoreSearch: true })
      if (shell) return shell
    }
    throw e
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return
  if (req.mode === 'navigate') {
    const shell = new URL('index.html', self.registration.scope).href
    event.respondWith(fromCacheOrNetwork(req, shell).then(withIsolation))
  } else if (req.destination === 'worker' || req.destination === 'sharedworker') {
    event.respondWith(fromCacheOrNetwork(req).then(withIsolation))
  }
})
