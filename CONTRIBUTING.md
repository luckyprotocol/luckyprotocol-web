# Contributing

LUCKYPROTOCOL is a self-custody Bitcoin wallet + protocol indexer. Code that ships here runs on users' devices with their mnemonics in memory. That sets the bar.

## Ground rules

1. **No telemetry, no analytics, no third-party scripts.** Wallet users actively flee from any sign of tracking. The CSP-allowed `connect-src` list in `public/_headers` is the canonical surface; PRs that add a new outbound host need explicit justification in the description.

2. **No new runtime dependencies without a strong case.** Every npm dep is supply-chain risk. The current list:
   - `@noble/hashes`, `@scure/{base,bip32,bip39,btc-signer}` — audited crypto primitives
   - `lucide-react`, `qrcode`, `recharts`, `three` — UI / asset rendering
   - `react`, `react-dom` — framework

   Adding to this list needs (a) why nothing existing does it, (b) author / audit reputation, (c) bundle-size impact.

3. **Don't bypass the indexer's deterministic projection.** The whole point of LUCKYPROTOCOL's design is that anyone can build state from chain bytes and arrive at identical results. PRs that read state from a centralized API instead of chain data are a no-go.

4. **CSP is non-negotiable.** If your change needs `eval`, `unsafe-inline` scripts, or a new outbound host, the PR description must explain why CSP can't be tightened differently.

5. **Mainnet only.** This repo doesn't support testnet / signet / regtest. Adding network-switching code is out of scope.

6. **Cohort changes** (activation-height bumps, protocol-fee changes, payload format changes) require:
   - WHITEPAPER.md / PROTOCOL.md update
   - `LCKPROTOCOL_V1_HEIGHT` bumped in BOTH `indexer-web/protocol.js` AND `protocol/indexer.js`
   - `SCHEMA_VERSION` bumped in `indexer-web/storage.js`
   - `COHORT_KEY` bumped in `LuckyProtocolApp.jsx`
   - Documentation in DEPLOY.md § Cohort upgrades

## Code style

- React: function components + hooks. No class components.
- Bigint for token amounts. Never `Number` past 2^53.
- Modules under `src/{wallet,tx,chain,indexer}-web/` are leaves — they may not import from `LuckyProtocolApp.jsx` or `protocol/`. The dependency direction is leaves → wrappers → UI.
- ESLint must pass (`npm run lint`). The `check` script in `package.json` runs lint + build.

## Workflow

```bash
git clone https://github.com/you/luckyprotocol-web
cd luckyprotocol-web/frontend
npm ci
npm run dev               # http://127.0.0.1:5180
npm run check             # lint + build
```

Before opening a PR:
- `npm run check` passes
- DevTools console has no errors after a fresh wallet onboard + first 30s of indexer scan
- If you touched the CSP, `npm run preview` and verify the relevant feature still works under the production CSP

## Reporting bugs

If the bug is **security-sensitive** (mnemonic exposure, CSP bypass, signature forgery), email rather than file a public issue. For everything else, GitHub issues are fine — include browser, OS, console errors, and `window.__INDEXER__.status()` output.
