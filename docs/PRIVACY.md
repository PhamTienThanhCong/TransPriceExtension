# TransPrice — Privacy Policy / Chính sách quyền riêng tư

**Effective date / Ngày hiệu lực: 2026-11-23**

[English](#english) · [Tiếng Việt](#tiếng-việt)

---

## English

TransPrice ("the extension") is a free, open-source (MIT) browser extension that finds prices on web pages and shows
them in your home currency. It is built to collect nothing: **the developer does not run any server and never
receives your data.**

### 1. What is processed, and where

| Data | Where it is processed | Sent anywhere? |
|---|---|---|
| The **text of the pages you visit** (to find prices such as `¥189` and replace or annotate them) | Locally, inside the page, by the extension's content script | **No.** Page text, page addresses and your browsing history never leave your device. |
| A request for the **public exchange-rate table** | Your browser downloads a file listing the value of each currency against the US dollar | Yes — a plain download (no page content, no URLs, no identifiers, no cookies set by TransPrice) from one of: `cdn.jsdelivr.net` (fawazahmed0/exchange-api via jsDelivr), `latest.currency-api.pages.dev` (its Cloudflare mirror), `open.er-api.com` (ExchangeRate-API). Sources are tried in that order; at most one successful download every few hours. |

As with any web request, the rate provider receives your IP address and standard browser headers (user agent,
language). Their own policies apply:
[jsDelivr](https://www.jsdelivr.com/terms/privacy-policy-jsdelivr-net) ·
[Cloudflare](https://www.cloudflare.com/privacypolicy/) ·
[ExchangeRate-API](https://www.exchangerate-api.com/terms). TransPrice is not affiliated with these providers.

### 2. What is stored — only on your device

| Data | Where | Notes |
|---|---|---|
| Settings: on/off, home currency, display mode, compact numbers, highlight, default meaning of `$` and `¥`, sites where conversion is off, per-site currency pins, theme, display language | `chrome.storage.sync` | If you are signed in to your browser with sync enabled, the browser syncs them between your own devices. The developer never receives them. |
| The latest exchange-rate table (rates, date, source) | `chrome.storage.local` | Public data. |
| The quick converter's last amount and currencies | `chrome.storage.local` | So the popup can restore it. |
| The number of prices converted on the current tab | Memory only (toolbar badge) | Discarded when the tab closes. |

Uninstalling the extension deletes all of it. You can also turn conversion off for a site, or everywhere, at any
time from the toolbar popup.

### 3. Permissions and why they are needed

| Permission | Why |
|---|---|
| Content script on all sites | To find and convert prices on the pages you visit. It runs locally and sends nothing. |
| `storage` | To save your settings and the rate table on your device. |
| `alarms` | To refresh the rate table every few hours. |
| Host access to `cdn.jsdelivr.net/npm/@fawazahmed0/*`, `latest.currency-api.pages.dev`, `open.er-api.com` | To download the public exchange-rate table — nothing else is requested from these hosts. |

### 4. What TransPrice does not do

No analytics, telemetry, advertising, tracking, fingerprinting or remote code. No accounts. Your data is not sold,
shared or transferred to anyone, and is not used for anything unrelated to converting prices. TransPrice complies
with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements.

### 5. Children

TransPrice is a general-purpose tool and does not knowingly collect any information from anyone, including children.

### 6. Changes and contact

Changes to this policy are published in this file, with a new effective date, and summarised in the
[changelog](../CHANGELOG.md). Questions: open an issue at
[github.com/PhamTienThanhCong/transprice/issues](https://github.com/PhamTienThanhCong/transprice/issues).

---

## Tiếng Việt

TransPrice ("tiện ích") là tiện ích trình duyệt miễn phí, mã nguồn mở (MIT), tìm giá tiền trên trang web và hiển thị
bằng loại tiền của bạn. Tiện ích được làm ra để không thu thập gì cả: **nhà phát triển không có máy chủ nào và
không bao giờ nhận dữ liệu của bạn.**

### 1. Dữ liệu được xử lý ở đâu

| Dữ liệu | Xử lý ở đâu | Có gửi đi không? |
|---|---|---|
| **Nội dung các trang bạn mở** (để tìm giá như `¥189` và quy đổi) | Ngay trên máy bạn, trong trang, bởi content script của tiện ích | **Không.** Nội dung trang, địa chỉ trang và lịch sử duyệt web không bao giờ rời khỏi máy. |
| Yêu cầu tải **bảng tỷ giá công khai** | Trình duyệt tải một tệp liệt kê giá trị từng loại tiền so với đô la Mỹ | Có — chỉ là một lượt tải tệp (không kèm nội dung trang, địa chỉ trang hay mã định danh nào) từ một trong các nguồn: `cdn.jsdelivr.net` (fawazahmed0/exchange-api qua jsDelivr), `latest.currency-api.pages.dev` (bản sao trên Cloudflare), `open.er-api.com` (ExchangeRate-API), thử lần lượt theo thứ tự đó, tối đa vài giờ một lần. |

Như mọi yêu cầu web, nhà cung cấp tỷ giá nhận được địa chỉ IP và thông tin trình duyệt tiêu chuẩn; chính sách
riêng của họ được áp dụng. TransPrice không liên kết với các nhà cung cấp này.

### 2. Dữ liệu được lưu — chỉ trên máy bạn

| Dữ liệu | Nơi lưu | Ghi chú |
|---|---|---|
| Cài đặt: bật/tắt, tiền tệ của bạn, kiểu hiển thị, số rút gọn, tô sáng, ý nghĩa mặc định của `$` và `¥`, các trang đã tắt, ký hiệu đã ghim cho từng trang, giao diện, ngôn ngữ hiển thị | `chrome.storage.sync` | Nếu bạn đăng nhập trình duyệt và bật đồng bộ, trình duyệt sẽ đồng bộ giữa các thiết bị của chính bạn. Nhà phát triển không nhận được. |
| Bảng tỷ giá mới nhất | `chrome.storage.local` | Dữ liệu công khai. |
| Số tiền và loại tiền nhập gần nhất trong máy tính quy đổi | `chrome.storage.local` | Để popup hiển thị lại. |
| Số giá đã quy đổi trên tab hiện tại | Chỉ trong bộ nhớ (huy hiệu trên biểu tượng) | Mất khi đóng tab. |

Gỡ tiện ích sẽ xóa toàn bộ dữ liệu trên. Bạn có thể tắt quy đổi cho từng trang hoặc cho mọi trang bất cứ lúc nào
từ popup của tiện ích.

### 3. Quyền truy cập và lý do

| Quyền | Lý do |
|---|---|
| Content script trên mọi trang | Để tìm và quy đổi giá trên trang bạn mở. Chạy hoàn toàn trên máy, không gửi gì đi. |
| `storage` | Lưu cài đặt và bảng tỷ giá trên máy bạn. |
| `alarms` | Cập nhật bảng tỷ giá vài giờ một lần. |
| Truy cập `cdn.jsdelivr.net/npm/@fawazahmed0/*`, `latest.currency-api.pages.dev`, `open.er-api.com` | Chỉ để tải bảng tỷ giá công khai. |

### 4. TransPrice không làm gì

Không phân tích hành vi, không đo lường, không quảng cáo, không theo dõi, không chạy mã từ xa, không cần tài khoản.
Dữ liệu của bạn không bị bán, chia sẻ hay chuyển cho bất kỳ ai.

### 5. Thay đổi và liên hệ

Mọi thay đổi chính sách được đăng trong tệp này kèm ngày hiệu lực mới. Mọi thắc mắc xin mở issue tại
[github.com/PhamTienThanhCong/transprice/issues](https://github.com/PhamTienThanhCong/transprice/issues).
