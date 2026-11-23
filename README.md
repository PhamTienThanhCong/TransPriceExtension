<p align="center">
  <img src="extension/icons/logo.svg" width="112" height="112" alt="TransPrice logo">
</p>

<h1 align="center">TransPrice</h1>

<p align="center">
  <b>See every price in your currency.</b> TransPrice finds prices on any web page — <code>¥189</code>,
  <code>$1,299.99</code>, <code>12,99 €</code>, <code>189元</code>, <code>1.5万円</code> — and shows them in your home
  currency (VND, USD, EUR …) right where they are. Free, open source, private.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-B45309.svg"></a>
  <a href="https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3"><img alt="Manifest V3" src="https://img.shields.io/badge/manifest-v3-EA580C.svg"></a>
  <a href="https://github.com/PhamTienThanhCong/transprice/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/PhamTienThanhCong/transprice/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  Sister project of <a href="https://github.com/PhamTienThanhCong/transpop">TransPop</a>:
  <i>TransPop translates words, TransPrice translates prices.</i>
</p>

<p align="center"><a href="#tiếng-việt">🇻🇳 Tiếng Việt</a></p>

---

## Features

- **Automatic conversion on any site** — shopping on Taobao, 1688, Amazon, Rakuten or an EU store? Prices are
  converted to your home currency as the page loads, including prices that sites split over several elements
  (`¥` `43` `.65`) and prices added later by infinite scroll or single-page apps.
- **Two display modes** — *replace* the price (the original stays one hover away) or *append* the conversion
  (`¥189 ≈ 730.373 ₫`). Optional compact numbers and a subtle highlight.
- **Smart about ambiguous symbols** — `¥` is CNY on Taobao and JPY on Rakuten, `$` can be USD, CAD, AUD, SGD …
  TransPrice decides from the site, the page language and the text, and you can pin the meaning per site from the
  popup.
- **One-click control** — a big on/off switch in the toolbar popup, a per-site switch, and `Alt`+`Shift`+`C` to toggle
  conversion everywhere. The toolbar badge shows how many prices were converted on the page.
- **Quick converter** in the popup — any amount, any of 40+ currencies, swap in one click.
- **Up-to-date rates, works offline** — free public rate tables refreshed every few hours; a built-in snapshot keeps
  the extension working without a connection.
- **Never breaks the page** — prices are rendered in an isolated (Shadow DOM) badge, nothing is removed, and turning
  TransPrice off restores the page exactly.
- **Localized** — English and Vietnamese interface, light and dark themes.
- **Private** — the only network request downloads the public exchange-rate table. No analytics, no tracking, no
  remote code. See the [privacy policy](docs/PRIVACY.md).

## Install

**From the Chrome Web Store:** coming soon.

**From source / a release zip** (developer mode — Chrome, Edge, Brave and other Chromium browsers 116+):

1. Download the source (`git clone https://github.com/PhamTienThanhCong/transprice.git`) or the `transprice-v*.zip`
   from [Releases](https://github.com/PhamTienThanhCong/transprice/releases) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`extension/`** folder (the folder that contains `manifest.json`; for a
   release zip, the unzipped folder itself).
4. Pin TransPrice from the 🧩 menu. On first run it asks for your home currency (guessed from your browser language).

## Usage

| How | What happens |
|---|---|
| Open any page with prices | Prices are converted automatically; the badge on the toolbar icon shows how many |
| Hover a converted price | Shows the original price, the rate used and its date |
| Click the toolbar icon (`Alt`+`Shift`+`P`) | Popup: on/off switch, this site's switch and currency hints, home currency, quick converter |
| `Alt`+`Shift`+`C` | Turn automatic conversion on/off everywhere |
| Popup → ⚙ | Settings: display mode, compact numbers, highlight, what `$`/`¥` mean by default, disabled sites, per-site pins, theme, language |

Shortcuts can be changed at `chrome://extensions/shortcuts`.

## How detection works

TransPrice scans the page text (cheaply pre-filtered, time-sliced so long pages stay smooth), recognises currency
markers — codes (`USD`, `RMB`), symbols (`$`, `¥`, `₫`, `€`, `R$`, `HK$` …) and words (`元`, `円`, `원`) — next to
numbers in every common format (`1,234.56`, `1.234,56`, `1 234,56`, `12,34,567`, `1.5万`, `2tr`), resolves ambiguous
symbols from the context (per-site pin → domain → page language → script of the text → your default) and converts
with the latest rates. Split prices are found by climbing a few levels up from the currency marker.

The full write-up with examples and edge cases:
[docs/ALGORITHM.md](https://github.com/PhamTienThanhCong/transprice/blob/dev/docs/ALGORITHM.md).

## Exchange rates

Rates are "units per 1 USD" tables downloaded from free, keyless public sources, tried in this order:

1. [fawazahmed0/exchange-api](https://github.com/fawazahmed0/exchange-api) via jsDelivr (`cdn.jsdelivr.net`)
2. the same data from its Cloudflare mirror (`latest.currency-api.pages.dev`)
3. [ExchangeRate-API](https://www.exchangerate-api.com) open access endpoint (`open.er-api.com`) —
   <a href="https://www.exchangerate-api.com">Rates By Exchange Rate API</a>

The table is cached on your device, refreshed every 6 hours (stale rates keep working while a refresh runs), and a
snapshot bundled with the extension is used when every source is unreachable. Rates are for information — banks and
card networks apply their own rates and fees.

## Privacy

TransPrice reads the pages you visit **only on your device** to find and convert prices. The only network traffic is
downloading the public rate table (no page content, no URLs, no identifiers are sent). Settings live in
`chrome.storage.sync`, the rate table in `chrome.storage.local`; nothing is ever sent to the developer. No analytics,
no ads, no tracking. Full policy: [docs/PRIVACY.md](docs/PRIVACY.md).

## Development

> **Branches:** `main` is the product branch — only the extension and the essentials. All development happens on
> [`dev`](https://github.com/PhamTienThanhCong/transprice/tree/dev), which also holds the tooling, tests, the dev
> harness and the guides. Clone `dev` to contribute and open pull requests against `dev`.

No build step, no frameworks, no npm dependencies — plain ES2022, HTML and CSS. The `extension/` folder is loaded
unpacked and zipped as-is. You need **Node.js 22+** and **Chrome 116+**.

```bash
git clone -b dev https://github.com/PhamTienThanhCong/transprice.git && cd transprice
npm run check      # manifest + referenced files, MV3/CSP rules, JS syntax, i18n keys, .mainignore
npm test           # unit tests (node --test)
npm run dev        # http://localhost:5180 — popup, options and a demo shop page with a mocked chrome.* API
```

| Command | What it does |
|---|---|
| `npm run check` | Static checks: manifest + referenced files, MV3/CSP rules, JS syntax, i18n keys |
| `npm test` | Unit tests (`tests/**/*.test.{js,mjs}`) |
| `npm run i18n` | Build `extension/_locales/*/messages.json` from the `i18n/*.json` fragments |
| `npm run package` | Zip `extension/` → `dist/transprice-v<version>.zip` (Chrome Web Store upload) |
| `npm run dev` | Dev harness on http://localhost:5180 — real background logic, mocked `chrome.*`, demo pages |
| `npm run icons` | Re-render the PNG icons from `extension/icons/logo.svg` (headless Chrome) |
| `npm run rates:snapshot` | Refresh the bundled offline rate table |
| `npm run sync:main` | Push `dev` and regenerate + push `main` |

More: [contributing guide](https://github.com/PhamTienThanhCong/transprice/blob/dev/CONTRIBUTING.md) ·
[architecture & team contract](https://github.com/PhamTienThanhCong/transprice/blob/dev/docs/ARCHITECTURE.md) ·
[publishing guide](https://github.com/PhamTienThanhCong/transprice/blob/dev/docs/PUBLISHING.md) ·
[changelog](CHANGELOG.md).

## License

[MIT](LICENSE) © 2026 PhamTienThanhCong. Exchange-rate data belongs to its providers (see above). Icons in the
interface are adapted from [Lucide](https://lucide.dev) (ISC).

---

## Tiếng Việt

**TransPrice — xem mọi giá tiền bằng tiền của bạn.** Tiện ích Chrome miễn phí, mã nguồn mở: tự tìm giá trên mọi trang
web (`¥189`, `$1,299.99`, `12,99 €`, `189元` …) và quy đổi sang loại tiền của bạn (ví dụ VND) ngay tại chỗ.
Dự án anh em của [TransPop](https://github.com/PhamTienThanhCong/transpop): *TransPop dịch chữ, TransPrice dịch giá.*

- **Tự động quy đổi** khi mua sắm trên Taobao, 1688, Amazon, Rakuten… kể cả giá bị tách thành nhiều phần (`¥` `43`
  `.65`) và giá hiện thêm khi cuộn trang.
- **Hai kiểu hiển thị**: *thay thế* giá gốc (rê chuột để xem lại) hoặc *hiện kèm* (`¥189 ≈ 730.373 ₫`).
- **Hiểu ký hiệu dễ nhầm**: `¥` trên Taobao là nhân dân tệ, trên Rakuten là yên Nhật; `$` có thể là USD, CAD, AUD…
  Bạn có thể ghim ý nghĩa cho từng trang ngay trong popup.
- **Bật/tắt một chạm** trên biểu tượng tiện ích, tắt riêng từng trang, phím tắt `Alt`+`Shift`+`C`; huy hiệu trên
  biểu tượng cho biết đã quy đổi bao nhiêu giá.
- **Máy tính quy đổi nhanh** trong popup, hơn 40 loại tiền.
- **Tỷ giá cập nhật** từ nguồn công khai miễn phí (6 giờ/lần), vẫn dùng được khi mất mạng nhờ bảng tỷ giá có sẵn.
- **Riêng tư**: chỉ tải bảng tỷ giá công khai, không gửi nội dung trang, không theo dõi, không quảng cáo.

**Cài đặt (chế độ nhà phát triển):** tải mã nguồn hoặc file `transprice-v*.zip` ở mục
[Releases](https://github.com/PhamTienThanhCong/transprice/releases) → mở `chrome://extensions` → bật **Developer mode**
→ **Load unpacked** → chọn thư mục **`extension/`**. Bản trên Chrome Web Store sẽ có sớm.

**Phát triển:** mọi thay đổi làm trên nhánh `dev` (có công cụ, kiểm thử, trang demo, tài liệu); nhánh `main` là bản
sản phẩm được tạo tự động từ `dev` bằng `npm run sync:main`. Cách nhận diện giá được giải thích chi tiết trong
[docs/ALGORITHM.md](https://github.com/PhamTienThanhCong/transprice/blob/dev/docs/ALGORITHM.md).
