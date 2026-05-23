# LUCKYPROTOCOL — Production Deployment Guide

This document covers building, hosting, and hardening the
LUCKYPROTOCOL web app for public use. Because this is a **self-custody
Bitcoin wallet** running entirely client-side, the security posture
of the deployment matters more than for most static sites — a single
XSS-allowing CSP slip can leak users' encrypted mnemonics.

If you've never deployed a wallet before, read [§ Wallet-specific
caveats](#wallet-specific-caveats) before anything else.

---

## TL;DR

| Choice | Command / file |
|---|---|
| **Build** | `npm ci && npm run build` → static files in `dist/` |
| **Host on Cloudflare Pages / Netlify** | already configured via `public/_headers` — point platform at the repo root |
| **Host on Vercel** | already configured via `vercel.json` |
| **Host on your own server** | `Caddyfile` in repo root — copy `dist/` to `/var/www/luckyprotocol/` |
| **Required** | HTTPS, CSP header, custom domain (no `*.pages.dev` for production) |

---

## Build

```bash
npm ci
npm run build
```

Outputs to `dist/`. The build is fully static — no Node server, no
backend. Production bundle is ~360 KB gzipped (1.3 MB unpacked).

### What's in `dist/`

| Path | Cache policy |
|---|---|
| `dist/index.html` | revalidate every request |
| `dist/assets/*.js`, `*.css` | content-addressed, cache 1 year |
| `dist/icon.png`, `manifest.webmanifest` | revalidate every request |
| `dist/sw.js` | revalidate every request (Service Worker) |

Cache rules are already encoded in `public/_headers`, `vercel.json`,
and `Caddyfile`.

---

## Hosting options

### Option A — Cloudflare Pages (recommended)

Easiest path. Free, global CDN, automatic HTTPS, supports `_headers`.

1. Push the repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create → Connect Git → pick the repo.
3. Build settings:
 - **Framework preset**: None (we ship our own `vite.config.js`)
 - **Build command**: `npm run build`
 - **Build output directory**: `dist`
 - **Root directory**: leave blank (repo root)
 - **Environment variables**: none
4. Deploy.
5. Add a custom domain (Pages → Custom domains → Set up). Cloudflare
 auto-issues a Let's Encrypt cert.
6. Verify headers — open DevTools → Network → click the document
 request and confirm `Content-Security-Policy` is set.

### Option B — Vercel

Same flow as Cloudflare but uses `vercel.json` instead of `_headers`.

1. `vercel deploy` from the repo root (or connect Git via dashboard).
2. Add the custom domain in project settings.
3. CSP / HSTS already configured via the checked-in `vercel.json`.

### Option C — Netlify

Same flow as Cloudflare; Netlify natively reads `public/_headers`.

### Option D — Self-hosted (Caddy)

Best for advanced users who want full control + a non-cloud trust
boundary.

```bash
# On the server
cd /opt && git clone https://github.com/you/luckyprotocol-web
cd luckyprotocol-web/frontend
npm ci && npm run build
mkdir -p /var/www/luckyprotocol
cp -r dist/* /var/www/luckyprotocol/

# Edit Caddyfile — change `luckyprotocol.example.com` to your domain.
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy auto-issues + renews Let's Encrypt certs as long as ports 80
and 443 are open and DNS points at the server.

### Option E — Self-hosted (nginx)

Equivalent nginx config:

```nginx
server {
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  server_name luckyprotocol.example.com;

  ssl_certificate     /etc/letsencrypt/live/luckyprotocol.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/luckyprotocol.example.com/privkey.pem;

  root /var/www/luckyprotocol;
  index index.html;

  gzip on;
  gzip_types text/css application/javascript application/json image/svg+xml;
  gzip_min_length 1024;

  # SPA fallback
  location / { try_files $uri $uri/ /index.html; }

  # Long-cache content-addressed bundles
  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable" always;
  }

  # Revalidate the SW + manifest
  location = /sw.js              { add_header Cache-Control "public, max-age=0, must-revalidate" always; }
  location = /manifest.webmanifest { add_header Cache-Control "public, max-age=0, must-revalidate" always; }

  # CSP + browser hardening — identical to public/_headers + vercel.json
  add_header Content-Security-Policy   "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https://mempool.space https://blockstream.info https://*.alchemy.com; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'; upgrade-insecure-requests" always;
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
  add_header X-Content-Type-Options    "nosniff"      always;
  add_header X-Frame-Options           "DENY"         always;
  add_header Referrer-Policy           "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy        "geolocation=(), microphone=(), camera=(), payment=(), usb=(), bluetooth=()" always;
}

# HTTP → HTTPS redirect
server {
  listen 80;
  listen [::]:80;
  server_name luckyprotocol.example.com;
  return 301 https://$host$request_uri;
}
```

### Option F — IPFS (truly decentralized)

```bash
npm run build
# Pin via web3.storage / Fleek / your own IPFS node:
npx @web3-storage/w3cli up dist/
```

Trade-off: you can't set HTTP headers (so CSP must move to a `<meta>`
tag in `index.html` — weaker than a real header). DNSLink + an HTTPS
gateway (e.g. `cf-ipfs.com`) get you most of the way.

---

## Wallet-specific caveats

Read these before exposing the deployment to anyone with funds.

### 1. The domain is the wallet — never change it

User data (encrypted mnemonic, Argon2id-derived AES key blob, IndexedDB
indexer snapshot) is bound to the **origin** (`https://<host>:<port>`).
If you migrate to a new domain, every user's wallet evaporates from
their perspective and they must re-import from their seed phrase. Pick
the production domain carefully and stick with it.

### 2. HTTPS is mandatory

The Web Crypto API (which the wallet uses for AES-256-GCM encryption)
refuses to run outside of secure contexts. The app will silently fail
on plain HTTP except for `http://localhost`. All four configured
deployment paths (Cloudflare, Vercel, Netlify, Caddy) handle TLS
automatically.

### 3. CSP is the #1 defense

The wallet's mnemonic ciphertext + the user's session password live
in browser storage. The only thing standing between a compromised
npm dependency and full mnemonic exfiltration is the
`Content-Security-Policy` header.

The CSP shipped in this repo:

- `script-src 'self' 'wasm-unsafe-eval'` — only first-party scripts,
 WASM allowed (Argon2id is WASM)
- `connect-src 'self' https://mempool.space https://blockstream.info https://*.alchemy.com`
 — every host the indexer / wallet may call is enumerated. Any new
 endpoint blocks at the browser level.
- `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`
 — close common XSS-amplification vectors.

If you let users add a custom Bitcoin Core RPC URL via Settings →
BTC ENDPOINTS, those requests will be **blocked by CSP** unless you
add that origin to `connect-src`. There's no clean fix here — the
build can't know user-config-time URLs. Two workarounds:

a. Tell power users to host their own deploy with a wider CSP.
b. Loosen `connect-src` to `https:` (acceptable for very early
 deployments; tightens hostile XSS slightly less but still blocks
 inline + data: + http:).

### 4. No analytics / tracking

The shipped build does not send any data to any third party. Do not
add Google Analytics, Plausible, Mixpanel, Sentry, or any other
tracker without explicit user opt-in. Crypto wallet users actively
flee from sites that ping out to trackers — and rightly so, the data
is wallet-fingerprinting gold.

### 5. Open source + reproducible builds

Users will want to verify that what you deployed matches what's on
GitHub. Tag releases and document:

```bash
git checkout vX.Y.Z
npm ci
npm run build
sha256sum dist/assets/index-*.js   # should match the bytes the
                                   # browser DevTools Network tab shows
```

### 6. Education, not features, is the anti-phishing tool

A clone of this UI on `lucky-protocol.com` (note hyphen) can steal
every mnemonic typed into it. The defenses:

- Pick a hard-to-confuse domain.
- Bookmark education in the README and in-app FAQ.
- Optionally: sign releases with a published PGP key.

### 7. No password reset

The wallet has no "forgot password" flow — it can't, because the
encryption key is derived from the password and the seed via Argon2id.
A user who forgets their password recovers by re-importing their
12-word mnemonic; one who has lost both is permanently locked out.
This is intentional. Do not surface a "reset" button.

---

## Health checks after deploy

| Check | How |
|---|---|
| HTTPS works | curl -I https://your-domain → 200 OK |
| CSP header present | DevTools → Network → click document → Response Headers contains `Content-Security-Policy` |
| HSTS preloads cleanly | Submit to https://hstspreload.org |
| Service Worker registers | DevTools → Application → Service Workers shows `sw.js` active |
| Offline still loads | DevTools → Network → Offline → reload → app shell renders |
| First-load size | DevTools → Network → Disable cache → reload → ~360 KB gzipped total |
| Lighthouse score | DevTools → Lighthouse → Generate report → Performance 90+, PWA installable |
| No console errors | DevTools → Console → empty |
| Indexer boots | Console shows `[indexer] boot complete` + `applied block` lines |

---

## Cohort upgrades (rare)

When the protocol's activation height bumps (see
`src/indexer-web/protocol.js::LCKPROTOCOL_V1_HEIGHT`), every existing
user's IndexedDB snapshot becomes stale. The indexer's
`SCHEMA_VERSION` bump handles auto-invalidation, but you should also:

1. Update `LCKPROTOCOL_V1_HEIGHT` in both `indexer-web/protocol.js`
 and `protocol/indexer.js`.
2. Bump `SCHEMA_VERSION` in `indexer-web/storage.js`.
3. Bump `COHORT_KEY` in `LuckyProtocolApp.jsx` (the
 `luckyprotocol.cohort.vXXXXXX` LS key).
4. Tag the release.
5. Deploy.

Returning users will silently cold-rescan from the new activation
height on next page load — no action required from them.

---

## Update strategy

Service Worker is set to `registerType: "autoUpdate"`. A new deploy
auto-replaces the cached app shell on next page load. Users do NOT
need to clear cache or hard-refresh — the SW handles it.

If you do a breaking change (e.g. a wallet format bump), bump
`schemaVersion` in `wallet-web/storage.js` so old wallets get the
re-onboard prompt rather than a silent decrypt failure.

---

## Common pitfalls

- **CSP too tight, app breaks**: try the build locally first via
 `npm run preview` (Vite's preview server respects `public/_headers`
 on Cloudflare/Netlify-style deploys; for nginx/caddy you have to
 actually deploy to test).
- **PWA caches a broken build**: bump the SW filename (Vite handles
 this automatically via content hashing).
- **Esplora 429s on cold scan**: expected on free public endpoints
 under burst. The shipped rate-gate keeps it under control; users
 can add Alchemy or their own Bitcoin Core node via Settings.
- **IndexedDB quota exceeded**: rare — the indexer snapshot is small
 (<1 MB even for thousands of UTXOs). Tell affected users to wipe
 + re-onboard via Settings → DANGER ZONE.
