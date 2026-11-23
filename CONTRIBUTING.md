# Contributing to TransPrice

Thanks for helping! Bug reports (especially prices TransPrice misses or misreads), ideas, translations and pull
requests are all welcome. *Góp ý bằng tiếng Việt cũng hoàn toàn được nhé.*

## Ground rules

TransPrice is intentionally simple. Please keep these properties:

1. **No build step, no dependencies.** Plain ES2022 JavaScript, HTML and CSS. The `extension/` folder must load
   unpacked exactly as it is in the repo. Dev tooling uses Node.js built-ins only.
2. **Manifest V3 rules.** No remote code, no `eval` / `new Function`, no inline `<script>` or `on*=` handlers.
3. **Security.** Never put page, remote or user text into `innerHTML` — use `textContent` or build DOM nodes.
4. **Privacy.** The only network traffic is downloading the public exchange-rate table. No page content, URLs or
   identifiers are ever sent. No analytics, tracking, remote fonts or third-party scripts.
5. **Never break the page.** The content script must be invisible when it has nothing to do, never throw, be
   React/SPA-safe, and restore the page completely when turned off.
6. **Minimal permissions.** New permissions need a very good reason (they're reviewed by the Chrome Web Store and
   shown to users). Open an issue first.
7. **Accessible and localized.** Keyboard reachable, `aria-label` on icon buttons, light + dark themes, and every
   user-visible string on extension pages goes through i18n (English **and** Vietnamese).

The full contract (file layout, settings, messaging, parser API, design tokens) is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the price-detection algorithm in [docs/ALGORITHM.md](docs/ALGORITHM.md).

## Branches

- **`dev`** — where all development happens: the extension plus guides, tests, the dev harness and tooling.
  Branch off `dev` and open pull requests against `dev`.
- **`main`** — the product branch: only the extension and the essentials (README, LICENSE, CHANGELOG, privacy
  policy). It is **generated** from `dev` by `npm run sync:main`, which removes every path listed in `.mainignore`.
  Never commit to `main` directly.

When you add a guide, demo, test or tooling file, list it in `.mainignore` so it stays off `main`
(`npm run check` fails if a product path is listed there).

## Getting started

Requirements: **Node.js 22+** and **Chrome 116+**. Nothing to install.

```bash
git clone -b dev https://github.com/PhamTienThanhCong/TransPriceExtension.git
cd transprice
npm run check
npm test
npm run dev        # http://localhost:5180
```

Load the extension: `chrome://extensions` → **Developer mode** → **Load unpacked** → select `extension/`.
After editing, click ↻ on the extension card and reload the page you're testing on.

`npm run dev` serves the extension pages and demo shop pages with a mocked `chrome.*` API that runs the **real**
service worker in the page (the dev bar at the bottom-right shows the toolbar badge and switches language/theme).
`/dev/index.html?view=split` shows a demo page next to the real popup.

## Making a change

1. Create a branch from `dev`: `git switch -c fix/split-price-amazon`.
2. Make your change. Keep functions small and files focused; follow the surrounding style (2-space indent, single
   quotes, semicolons, JSDoc on exported functions).
3. User-visible text: edit the matching `i18n/<area>.json` fragment (English **and** Vietnamese) and run
   `npm run i18n`. Never edit `extension/_locales/` by hand.
4. Add or update tests in `tests/<area>/` (`*.test.mjs`, `node --test`). A missed or misread price is best reported
   as a parser test case.
5. Run `npm run check` and `npm test` — both must pass (CI runs them on every push and pull request).
6. Test manually with **Load unpacked**: light and dark theme, a couple of real shopping sites.
7. Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for user-facing changes.
8. Open a pull request against `dev` and fill in the checklist.

## Translating the UI

Strings live in `i18n/<area>.json`:

```json
{
  "popup_power_title": { "en": "Auto-convert prices", "vi": "Tự động quy đổi giá", "description": "Main switch" }
}
```

- `$1`…`$9` are placeholders — keep them in your translation.
- To add a UI language, add its [Chrome locale code](https://developer.chrome.com/docs/extensions/reference/api/i18n#locales)
  (e.g. `"fr"`) to entries in every fragment and run `npm run i18n`. Missing strings fall back to English.
- Currency names are not translated here — they come from the browser (`Intl.DisplayNames`).

## Reporting bugs

Use the **Bug report** issue template. Include the TransPrice version, browser + OS, the page URL (if public), the
price text as shown on the page and what TransPrice showed instead.

## Security

If you find a security problem, please **don't open a public issue**. Use GitHub's
[private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (Security → Report a vulnerability).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
