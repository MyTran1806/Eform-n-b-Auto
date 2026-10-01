# Đổi loại ticket hàng loạt (Chrome extension)

Thêm nút **"Đổi loại hàng loạt"** ở góc phải dưới của trang danh sách ticket (ngay trên thanh *Cập nhật*).
Bạn tick ticket như bình thường, chọn loại mới, bấm một lần. Extension gửi request đổi loại cho từng ticket đã tick.

Extension không biết trước API của hệ thống, nên bạn **thao tác tay đổi loại 1 ticket một lần để nó học request**, sau đó nó lặp lại cho các ticket khác.

## Cài đặt

1. Mở `chrome://extensions` (Chrome hoặc Edge), bật **Developer mode**.
2. Bấm **Load unpacked**, chọn thư mục `extension/` của repo này.
3. Mở trang danh sách ticket, bấm biểu tượng extension → **Bật trên trang này** → cho phép. Trang tự tải lại.
   Extension chỉ chạy trên những trang bạn bật, không chạy trên trang khác.

## Thiết lập (làm một lần, lưu theo tên miền)

Bấm nút cam góc phải dưới → tab **Cài đặt**.

### Cách nhanh (đổi sang "Hồi Giao/Lấy/Trả hàng" + lý do)

Bấm **Điền sẵn cấu hình**. Extension điền sẵn mẫu request `cs-ticket/update` và 3 loại: *Hồi giao*, *Hồi lấy*, *Hồi trả*
(cùng gửi `type = "Hồi Giao/Lấy/Trả hàng"`, mỗi loại một `ly_do_hoi_giao_lay_tra` tương ứng). Xong, sang tab **Đổi loại** để dùng.
API dùng `id` nội bộ của ticket, extension tự học `id` từ dữ liệu danh sách mà trang đã tải (cần tải lại trang sau khi bật extension).
Nếu chữ loại/lý do trên hệ thống khác (đúng dấu, hoa/thường), sửa ở ô **Danh sách loại**.

### Cách thủ công (cho thao tác khác)

1. **Danh sách loại**: mỗi dòng `Tên hiển thị | giá trị gửi lên | lý do (không bắt buộc)`, ví dụ
   ```
   Khiếu nại | complaint
   Hồi giao | Hồi Giao/Lấy/Trả hàng | Hồi giao
   ```
   Giá trị gửi lên là giá trị hệ thống thật sự dùng (xem trong request ở bước 2). Trong mẫu, `{{type}}` là giá trị, `{{reason}}` là lý do.
2. **Mẫu request**:
   1. Bấm **Bắt đầu ghi**.
   2. Trên trang, đổi loại 1 ticket bằng cách hệ thống đang cho (hoặc bấm **Cập nhật** ở thanh dưới).
   3. Quay lại panel, chọn request vừa được ghi (thường là `POST`/`PUT`/`PATCH`).
   4. Nhập **mã ticket** và **giá trị loại** bạn vừa dùng. Extension thay chúng bằng `{{ticket}}` và `{{type}}` trong URL/body.
   5. Kiểm tra mẫu, rồi **Lưu mẫu**.

   Nếu hệ thống chưa có thao tác đổi loại trên giao diện, hãy ghi request của nút **Cập nhật** (đổi trạng thái/nhân viên...)
   rồi tự thêm trường loại vào body, ví dụ `"type": "{{type}}"`, và mã ticket thành `{{ticket}}`.
   Cách này chỉ chạy được nếu API chấp nhận trường đó.

Token/CSRF (header `Authorization`, `Token`, `X-XSRF-TOKEN`...) **không được lưu**. Lúc chạy, extension lấy giá trị mới nhất mà chính trang đã gửi.

## Dùng hằng ngày

1. Lọc và tick ticket trên danh sách. Panel hiển thị số ticket đọc được và cảnh báo nếu lệch với "Đã chọn N phiếu" của trang.
2. Mở panel → chọn **Loại mới** → bấm **Đổi N ticket sang "…"** → xác nhận.
3. Ticket đầu tiên chạy trước để kiểm tra. Nếu lỗi thì dừng, không đụng các ticket còn lại.
4. Có thể bấm **Dừng** giữa chừng. Ticket lỗi được liệt kê và có nút **Sao chép mã ticket lỗi**.
5. Chạy xong, tải lại danh sách để thấy loại mới.

## Giới hạn đã biết

- Mã ticket được đọc từ chữ hiển thị trên bảng (mặc định chuỗi 9-15 chữ số). Nếu API cần `id` nội bộ, dùng `{{id}}` trong mẫu: extension tìm `id` trong dữ liệu JSON mà trang đã tải (object có `id` và chứa mã ticket). Ticket không tìm thấy `id`, hoặc mã khớp nhiều `id` khác nhau, sẽ báo lỗi và không bị gửi.
- Body request phải là text (JSON hoặc `x-www-form-urlencoded`). `multipart/form-data` chưa hỗ trợ.
- Nếu danh sách chỉ hiển thị một phần số phiếu đã chọn (cuộn ảo hoặc phân trang), extension chỉ thấy các dòng đang hiển thị và sẽ cảnh báo.
- Nếu hệ thống trả HTTP 200 kể cả khi lỗi, đặt regex nhận diện lỗi ở **Cài đặt → Nâng cao** (ví dụ `"success"\s*:\s*false`).
- Nếu không đọc được ticket đã tick, đặt CSS selector ở **Cài đặt → Nâng cao**.

## Phát triển & test

```bash
npm test                                   # unit test logic (không cần cài gì thêm)
NODE_PATH=$(npm root -g) npm run test:e2e  # nạp extension thật vào Chromium, chạy trên trang + API giả lập
```

Cấu trúc `extension/`:

| File | Vai trò |
| --- | --- |
| `manifest.json`, `background.js`, `popup.*` | Bật/tắt extension theo từng trang (đăng ký script khi được cấp quyền) |
| `hook.js` | Chạy trong trang: ghi request, nhớ token mới nhất, gọi lại request theo mẫu |
| `content.js` | Giao diện góc phải dưới, luồng ghi → lưu mẫu → chạy hàng loạt |
| `core.js` | Logic thuần: dựng/điền mẫu, đọc ticket đã tick (có unit test) |
