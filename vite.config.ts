import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// BASE_PATH lets the same build serve from a sub-path (e.g. GitHub Pages: /ai-chat-bot/).
const base = process.env.BASE_PATH ?? '/'

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Shreyan.ai',
        short_name: 'Shreyan.ai',
        description: 'Private, offline-first AI assistant that runs on your device.',
        theme_color: '#0b5cad',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: base,
        scope: base,
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache only the small app shell so first load stays light on phones. The heavy AI
        // runtimes (WebLLM, wllama, Whisper/ONNX) are cached on first use; their filenames are
        // content-hashed, so cache-first is safe. Model weights are cached by the runtimes themselves.
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        globIgnores: ['**/webllm*', '**/wllama*', '**/whisper*', '**/ort-*', '**/transformers*'],
        navigateFallback: `${base}index.html`,
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.includes('/assets/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'ai-runtimes',
              expiration: { maxEntries: 40 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    // The package's "main" points at a file it doesn't ship; use its ESM build directly.
    alias: [{ find: /^@wllama\/wllama$/, replacement: '@wllama/wllama/esm/index.js' }],
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@wllama/wllama'] },
})
