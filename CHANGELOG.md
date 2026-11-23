# Changelog

All notable changes to TransPrice are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The version always matches `extension/manifest.json`.

## [Unreleased]

## [0.1.0] — Unreleased

First version.

### Added

- **Per-site activation, off by default**: TransPrice converts only on the sites you turn on (popup → "This site"),
  and remembers them — turning it on at `s.taobao.com` covers the whole `taobao.com`. While a site is off nothing on
  the page is touched; the popup still shows how many foreign prices it found. Options → Websites offers the
  alternative "every site, except the ones I turn off".
- **Automatic price conversion**: prices such as `¥189`, `$1,299.99`, `12,99 €`, `189元` or `1.5万円`
  are detected and shown in your home currency (guessed from the browser language, e.g. Vietnamese → VND).
  - Number formats `1,234.56` · `1.234,56` · `1 234,56` · `1'234.56` · `12,34,567.89`, CJK and Vietnamese
    multipliers (`万`, `亿`, `k`, `tr`, `tỷ`), ranges (`¥10-20`).
  - Prices split over several elements (Taobao / Amazon style) and prices added later by single-page apps.
  - Ambiguous `$` and `¥` resolved from the site, the page language and the text; pin the meaning per site.
- **Display modes**: replace the price (original on hover) or append the conversion; compact numbers; highlight.
- **Toolbar popup**: global pause switch, per-site switch with detected currencies, home-currency picker, quick
  converter, rate date and source with a refresh button. The toolbar badge shows the number of converted prices.
- **Options page**: display mode with live preview, defaults for `$` and `¥`, where to convert (sites you turn on /
  every site) with the site list, per-site pins, theme,
  display language, rate information. **Welcome page** on install.
- **Keyboard shortcut** `Alt`+`Shift`+`C` to turn conversion on/off for the current site (`Alt`+`Shift`+`P` opens the popup).
- **Exchange rates** from fawazahmed0/exchange-api (jsDelivr + Cloudflare mirror) with ExchangeRate-API as a
  fallback, refreshed every 6 hours, plus a bundled snapshot for offline use.
- English and Vietnamese interface, light and dark themes.
