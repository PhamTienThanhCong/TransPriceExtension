# Hướng dẫn phát hành TransPrice

> Bản rút gọn. Quy trình chi tiết từng bước (tạo tài khoản 5 USD, xác minh 2 bước, từng tab của Developer Dashboard,
> lý do bị từ chối thường gặp) giống hệt TransPop — xem `docs/PUBLISHING.md` trên nhánh `dev` của TransPop.
> Phần dưới chỉ ghi những gì **riêng của TransPrice**: lệnh, nội dung cần dán và các câu trả lời cho tab Privacy.

## 1. Trước khi phát hành

```bash
git switch dev
npm run i18n && npm run check && npm test   # phải xanh hết
npm run icons                                # chỉ khi đã sửa extension/icons/logo.svg
npm run rates:snapshot                       # làm mới bảng tỷ giá dự phòng đi kèm tiện ích
```

1. Tăng `version` trong `extension/manifest.json` (ví dụ `0.1.0` → `0.2.0`).
2. Thêm mục `## [0.2.0] — YYYY-MM-DD` vào `CHANGELOG.md` (chuyển các dòng trong `[Unreleased]` xuống).
3. Thử bằng **Load unpacked** (`chrome://extensions` → Developer mode → chọn thư mục `extension/`): Taobao, Amazon,
   một trang EU, chế độ sáng/tối, tiếng Việt/tiếng Anh, bật/tắt từ popup và `Alt`+`Shift`+`C`.
4. Commit trên `dev`, rồi `npm run sync:main` để đẩy cả hai nhánh.

## 2. Đóng gói và tải lên

```bash
npm run package        # → dist/transprice-v<version>.zip (manifest.json nằm ở gốc file zip)
```

Hoặc gắn tag để GitHub Actions tự đóng gói và tạo Release (workflow chỉ có trên `dev`):

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Tải file zip lên [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) → **Items** →
**New item** (lần đầu) hoặc **Package** → **Upload new package** (các lần sau).

## 3. Store listing (dán nguyên văn, tiếng Anh)

- **Name:** lấy tự động từ `extName` (en: "TransPrice — Currency Converter for Shopping").
- **Summary:** lấy từ `extDescription`.
- **Category:** Shopping. **Language:** English (thêm Vietnamese ở mục localized listing).
- **Description:**

  > See every price in your currency. TransPrice finds prices on any web page — ¥189, $1,299.99, 12,99 €, 189元,
  > 1.5万円 — and shows them in your home currency (VND, USD, EUR, …) right where they are.
  >
  > • Automatic conversion on every site, including prices split over several elements and prices loaded later.
  > • Replace the price or show the conversion next to it; the original is always one hover away.
  > • Understands ambiguous symbols: ¥ on Taobao is CNY, on Rakuten it's JPY — and you can pin it per site.
  > • Big on/off switch, per-site switch, Alt+Shift+C shortcut, converted-price count on the toolbar icon.
  > • Quick converter for 40+ currencies. Rates refreshed every 6 hours; works offline with built-in rates.
  > • Private: page text never leaves your device. The only request downloads the public exchange-rate table.
  > • Free and open source (MIT): https://github.com/PhamTienThanhCong/transprice
  >
  > Rates By Exchange Rate API (https://www.exchangerate-api.com) and fawazahmed0/exchange-api.

- **Icon:** `store-assets/store-icon-128.png` (tạo bởi `npm run icons`).
- **Screenshots:** 1280×800, ít nhất 1 ảnh (trang Taobao đã quy đổi, popup, trang cài đặt). Chụp bằng `npm run dev`
  (`/dev/index.html?view=split`) hoặc trên trang thật.
- **Small promo tile:** 440×280 (tùy chọn nhưng nên có).

## 4. Tab Privacy (câu trả lời gợi ý)

- **Single purpose:** "Detects prices on web pages and converts them to the user's chosen currency."
- **Permission justifications:**
  - `storage` — "Saves the user's settings (home currency, display options, disabled sites) and the cached
    exchange-rate table locally."
  - `alarms` — "Refreshes the public exchange-rate table every 6 hours."
  - Host permissions (`cdn.jsdelivr.net/npm/@fawazahmed0/*`, `latest.currency-api.pages.dev`, `open.er-api.com`) —
    "Downloads the public exchange-rate table (JSON). No user data is sent; these are the only hosts contacted."
  - Content script on `<all_urls>` — "Prices can appear on any shopping site; the script reads page text locally to
    find and convert prices and never sends page content anywhere."
- **Remote code:** No, I am not using remote code.
- **Data usage:** không đánh dấu loại dữ liệu nào (tiện ích không thu thập dữ liệu người dùng); tích cả ba cam kết
  (không bán, không dùng cho mục đích khác, không dùng để xét tín dụng).
- **Privacy policy URL:** `https://github.com/PhamTienThanhCong/transprice/blob/main/docs/PRIVACY.md`

## 5. Checklist trước khi bấm "Submit for review"

- [ ] `npm run check` và `npm test` xanh; `dist/transprice-v<version>.zip` mới tạo.
- [ ] Phiên bản trong manifest khớp `CHANGELOG.md`; nhánh `main` đã đồng bộ (`npm run sync:main`).
- [ ] Không thêm quyền mới (nếu có: cập nhật phần justification ở trên và `docs/PRIVACY.md`).
- [ ] Chính sách quyền riêng tư truy cập được qua URL ở trên.
- [ ] Sau khi được duyệt: thay `EXTENSION_ID` bằng ID thật nếu có dùng trong README / issue template.
