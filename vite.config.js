import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// LuckyProtocolApp.jsx is a single ~6600-line file with massive base64-
// embedded brand images. Bumping the chunk-size warning limit keeps Vite
// from logging on every build.
export default defineConfig({
  plugins: [
    react(),
    // PWA — lets users "install" the wallet to their home screen and
    // open it offline. Critical for a self-custody wallet: even with
    // zero network the user can still read their IndexedDB-backed
    // balance + see their own bet history while waiting for a node to
    // come back. The Service Worker pre-caches the JS/CSS/icon shell.
    //
    // IMPORTANT: we exclude Esplora / Alchemy / Bitcoin Core fetches
    // from caching (NetworkOnly strategy below) — the chain MUST be
    // queried live; a cached tip-height response would silently lie.
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.png"],
      manifest: {
        name: "LUCKYPROTOCOL",
        short_name: "LUCKY",
        description: "Proof of Luck on Bitcoin · self-custody wallet + browser indexer",
        theme_color: "#050203",
        background_color: "#050203",
        display: "standalone",
        orientation: "portrait",
        scope: "/",
        start_url: "/",
        icons: [
          { src: "/icon.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Pre-cache the app shell (HTML + JS + CSS + icon).
        globPatterns: ["**/*.{js,css,html,png,svg,webp,jpg,jpeg,ico,woff,woff2}"],
        // The bundled JS is ~1.3 MB; bump the size cap.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          // ALL chain RPC must hit the network — never serve a cached
          // tip-height / block / address-utxo response. A stale chain
          // view would silently corrupt the indexer + show wrong
          // balances. Same rule for Alchemy + user-configured Bitcoin
          // Core endpoints (any URL the user pastes).
          {
            urlPattern: ({ url }) =>
              /mempool\.space|blockstream\.info|alchemy\.com/.test(url.hostname),
            handler: "NetworkOnly",
          },
        ],
      },
      // Dev-mode: serve a stub Service Worker so `npm run dev` doesn't
      // try to register the production one (which would cache stale
      // chunks and break HMR).
      devOptions: { enabled: false },
    }),
  ],
  esbuild: {
    loader: "jsx",
    include: /\.(jsx?|tsx?)$/,
    exclude: [],
  },
  server: {
    port: 5180,
    // Web build — open a real browser tab on dev start.
    open: true,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    chunkSizeWarningLimit: 4000,
  },
});
