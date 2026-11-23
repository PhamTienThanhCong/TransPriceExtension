# TransPrice — project notes for Claude

TransPrice ("See every price in your currency") is an open-source (MIT) Chrome MV3 extension: it detects prices on any
page (`¥189`, `$1,299.99`, `12,99 €`, `189元` …) and converts them to the user's home currency (e.g. VND), with a
toolbar popup (on/off toggle, per-site switch, quick converter) and an options page.
Repo: https://github.com/PhamTienThanhCong/TransPriceExtension — owner **PhamTienThanhCong**, who writes in Vietnamese
(reply in Vietnamese). Sister project of TransPop (same conventions).

## ⚠️ Branch workflow — mandatory on every change

| Branch | Purpose | Contents |
|---|---|---|
| `dev` | Development + guides | Everything: extension code, docs/guides, tests, dev harness/demo, tooling, CI |
| `main` | Product | Only the shippable extension and essentials. **Generated from `dev` — never commit to it directly.** |

1. Always work and commit on **`dev`** (`git switch dev`). If `CLAUDE.md` is missing you are on `main` — switch to `dev`.
2. Before committing: `npm run check` and `npm test` (and `npm run i18n` if `i18n/*.json` changed).
3. After committing, publish **both branches** with `npm run sync:main` (`scripts/sync-main.sh`): it pushes `dev`,
   rebuilds `main` from dev's committed tree minus every path in **`.mainignore`**, and pushes `main`
   (without an `origin` remote it only rebuilds the local `main` branch).
4. Guide / demo / test / tooling files stay on `dev` only: when you add one, add its path to `.mainignore`.
   Never list product files there: `extension/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `docs/PRIVACY.md`,
   images shown by `README.md`, `.github/ISSUE_TEMPLATE`, `.gitignore`.
5. `README.md` is shared by both branches: link dev-only files with absolute URLs on the dev branch
   (`https://github.com/PhamTienThanhCong/TransPriceExtension/blob/dev/<path>`), never relative paths.
6. Release tags `vX.Y.Z` go on `dev` (the CI and release workflows exist only on `dev`).

> Tóm tắt: code chính ở `dev`. Mỗi lần code xong phải push song song cả 2 nhánh bằng `npm run sync:main`. Nhánh `main`
> là bản product, tự động bỏ các file hướng dẫn, demo, test và công cụ (liệt kê trong `.mainignore`); nhánh `dev` giữ
> nguyên tất cả.

## Commands (run on `dev`)

| Command | What it does |
|---|---|
| `npm run check` | Static checks: manifest + referenced files, MV3/CSP rules, JS syntax, i18n keys |
| `npm test` | Unit tests (`tests/**/*.test.{js,mjs}`) |
| `npm run i18n` | Build `extension/_locales/*/messages.json` from `i18n/*.json` fragments (never hand-edit `_locales`) |
| `npm run package` | Zip `extension/` → `dist/transprice-v<version>.zip` (Chrome Web Store upload) |
| `npm run dev` | Dev harness on http://localhost:5180 — mocked `chrome.*`, demo shop page, algorithm playground |
| `npm run icons` | Re-render PNG icons from `extension/icons/logo.svg` |
| `npm run rates:snapshot` | Refresh the bundled offline rate table `extension/src/background/rates-snapshot.js` |
| `npm run sync:main` | Push `dev` and regenerate + push `main` |

## Conventions

- No build step, no npm dependencies: plain ES2022/HTML/CSS. MV3 CSP: no inline scripts/handlers, no `eval`, no remote code.
- The team contract (settings schema, messaging, parser API, content-script rules, file ownership) is `docs/ARCHITECTURE.md`;
  the price-detection algorithm is explained in `docs/ALGORITHM.md`.
- The content script must never break pages: no splitting/removing page text nodes, closed Shadow DOM badges,
  full restore when turned off, React/SPA-safe MutationObserver handling.
- Never put page or remote text into `innerHTML`.
- All extension-page UI strings go through i18n (`en` + `vi` required). Currency names come from `Intl.DisplayNames`.
- Brand: amber/gold — primary `#B45309`, gradient `#F59E0B → #EA580C`. Logo = two overlapping coins (`$` solid, `₫` outlined).
