# LUCKYPROTOCOL — Web Edition

**Proof of Luck.** A Bitcoin-mainnet probabilistic-minting protocol + UTXO-bound token system, packaged as a **pure browser wallet** with an **in-browser indexer**. No servers. No backend. No cloud database. Open the page → your device runs the whole stack.

Token issuance is settled by Bitcoin's own proof-of-work entropy: each MINE tx's outcome is a deterministic function of the confirming block's hash. No miner can grind a profitable tail without out-spending the prize. No deployer can pre-mint. No indexer can override the ledger. Luck — the bit-for-bit equidistribution of block-hash bits — is the consensus.

**Fair launch by construction.** Not by promise — by code.

- **No premine.** No team allocation. No VC round. No advisor grant. No early-access list. The author of this protocol receives zero tokens at deploy. Every token in existence is minted by users paying real Bitcoin fees against a block-hash predicate no one can bias.
- **No admin key.** No upgrade authority. No address can rewrite consensus constants; changing them requires a new activation cohort that every node MUST opt into.
- **Mainnet only.** Every MINE / DEPLOY / SEND is a real Bitcoin tx. No testnet handoff where insiders accumulate balance before public launch.
- **Trustless indexer.** Deterministic projection of the chain — anyone can run their own and arrive at byte-identical state. The reference indexer has no oracle role.

🚀 [**DEPLOY.md**](DEPLOY.md) — production deployment guide (Cloudflare / Vercel / Netlify / self-hosted Caddy + nginx)

---

## What changed from the desktop edition

The original LUCKYPROTOCOL was a Tauri 2 desktop app with a Rust backend (wallet signing, tx construction, indexer sidecar). This repo is the **web port**:

| Concern | Desktop (Tauri / Rust) | Web (this repo) |
|---|---|---|
| Wallet | Argon2id + AES-GCM in `bdk_wallet` | `@noble/hashes` Argon2id + Web Crypto AES-GCM + IndexedDB |
| Tx construction | `bdk_wallet::TxBuilder` | `@scure/btc-signer` |
| Chain queries | `bdk_esplora` (Rust) + Alchemy + optional `bitcoind` RPC | direct browser `fetch` to mempool.space / blockstream.info / Alchemy + Bitcoin Core (via CORS-fronted reverse proxy) |
| Protocol indexer | `luckyprotocol-indexer/` (Rust binary, sidecar) | `src/indexer-web/` (JS, IndexedDB-backed) |
| Block scan | RPC `getblock <hash> 3` | raw-block fetch + local parser (`raw_block.js`) |
| Update path | Tauri auto-updater | Service Worker (`vite-plugin-pwa`) |

The protocol itself is unchanged — same activation height (950,382), same OP_RETURN payload format, same consensus fee gates. A wallet built with the web edition can broadcast a SEND that the desktop indexer will apply byte-identically.

---

## Layout

```
src/
  LuckyProtocolApp.jsx — single-file React UI
  wallet-web/          — Argon2id + AES-GCM + IndexedDB persistence
  tx-web/              — @scure/btc-signer-based tx construction
  chain-web/           — Esplora REST + Bitcoin Core JSON-RPC adapters
  indexer-web/         — fast-bootstrap + follow-spends + catch-up scan
  protocol/            — wrapper modules with stable signatures
public/                — favicon, _headers, PWA assets
vite.config.js         — build + PWA config
vercel.json            — Vercel-specific CSP/HSTS headers
Caddyfile              — self-hosted Caddy config (HTTPS auto)
DEPLOY.md              — full deployment + hardening guide
scripts/release.sh     — reproducible-build helper
```

---

## Quick start

### Dev

```bash
npm ci
npm run dev
# Open http://127.0.0.1:5180/
```

The wallet generates a fresh BIP39 seed, encrypts it with AES-GCM under an Argon2id-derived key, stores the ciphertext in IndexedDB. The indexer cold-scans from activation height to chain tip (~1–3 minutes on first boot, sub-second on subsequent visits).

### Production build

```bash
./scripts/release.sh v0.1.0
# Outputs dist/ + dist/CHECKSUMS.txt
```

See [DEPLOY.md](DEPLOY.md) for hosting + hardening.

---

## Why a browser wallet at all

The desktop edition gave us Rust-grade signing isolation but pinned the user to a download + install ritual. The web edition trades a small additional security surface (CSP-hardened browser env vs. native sandbox) for **frictionless first contact**: a new user clicks a link, sees the lobby, generates a wallet, and bets within 90 seconds. The full indexer comes along for free — no oracle, no centralized API key, no backend to trust.

The trade-off is documented in [DEPLOY.md § Wallet-specific caveats](DEPLOY.md#wallet-specific-caveats). Short version: **CSP is the only thing between an XSS in a dependency and a stolen mnemonic**. Treat the deployed CSP header as a first-class consensus parameter — not a config knob.

---

## Reproducible builds

Every tagged release has a `CHECKSUMS.txt` next to the build output. Users can verify what their browser downloads matches what came out of the public source:

```bash
# What's deployed
curl -s https://luckyprotocol.example.com/ -o /tmp/index.html
# What this commit builds
git checkout vX.Y.Z
cd frontend && npm ci && ./scripts/release.sh
diff <(grep -oE 'src="/assets/[^"]+"' /tmp/index.html) \
     <(grep -oE 'src="/assets/[^"]+"' dist/index.html)
```

A mismatch is a tampering signal. Bookmark the official domain. Verify before sending non-test amounts.

---

## License

See [LICENSE](LICENSE).
