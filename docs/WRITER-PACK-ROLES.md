# /lab — Writer Pack + Coordinator Lite (tham khảo /total)

## Nguyên tắc

/total production hiện có **1 external Writer** và 1 publisher; không có 3 Writer cùng push vào production.
Pilot /lab giữ kiến trúc tương tự, chỉ bổ sung **tùy chọn chia nghiên cứu/soạn thảo thành 1–3 lane** trước khi tích hợp.
Đây là phân chia công việc trên giấy/dữ liệu JSON, **KHÔNG phải distributed lease registry**.
Ba phiên AI độc lập KHÔNG được đồng thời ghi trực tiếp main hay tự claim ID; không coi ba lane là ba worker đang chạy.

**Factory main** vẫn là nguồn sự thật: 10.000 matrix rows, checkpoint, research, draft, QA >=75, publish 2/pair,
tối đa 10/push; mọi published HTML/URL/canonical/sitemap hiện tại bất biến.

## Gói Writer chỉ đọc (trong checkout mới nhất của main)

    git fetch origin main
    git checkout main
    git pull --ff-only
    node scripts/factory/writer-pack.js --count 10 --writers 3 --json

Kết quả JSON bao gồm đúng 10 ID PLANNED liên tiếp (nếu đủ), intent, keyword, file path, canonical,
cờ bắt buộc nguồn chính thức, gợi ý liên kết nội bộ tới PUBLISHED và 3 lane không trùng nhau.

- Chỉ có MỘT **integrator/lead Writer** làm chủ working tree và commit/push.
- Worker phụ nhận ID được phân, nghiên cứu và viết body/research packet ngoài production.
  Chỉ trả văn bản/file cho integrator; không push main, không mutate Matrix/checkpoint/state.
- Integrator xác minh tất cả ID liên tiếp, đối chiếu nguồn, đưa các file vào
  \`_drafts/<ID>.body.html\` và \`data/research/<ID>.json\`.
- Chạy \`node scripts/factory/wrap-drafts.js\`, scoped FAST QA, **một commit chứa toàn bộ queue** rồi push.
- \`factory-production.yml\` là cổng duy nhất nhận queue và xuất bản sau QA (không cho worker tự publish).
- Nếu QA/claim fail, repair xong mới mở queue mới. Không đụng ID đã PUBLISHED.

Trạng thái \`PAUSED\` đọc từ \`data/state/production-control.json.enabled\` — không tạo
file pause thứ hai khác source of truth. \`RESUME_FIRST\` nghĩa là cần xử lý row mở.
\`WAIT_STATE\` nghĩa là lock/transaction đang active, không lấy queue.
\`WAIT_PUSH\` nghĩa là có draft tồn tại cần xử lý trước.

## Điều phối và cảnh báo (không dùng API trả phí)

\`.github/workflows/factory-coordinator-lite.yml\` kiểm tra tình trạng Matrix/lock/transaction
và watchdog **read-only** mỗi giờ (và chạy tay). Nó **không tự tạo content, không bật Writer,
không recover mutating, không push, không tạo cron production**.
Repair #4 → Supervisor #5 vẫn qua \`factory-repair.yml\`; #6 legacy/manual.
Không cấp thêm credential, không cài API AI vào Actions.

## Khi muốn thật sự chạy 3 Writer độc lập

Cần **giai đoạn sau**: durable central lease registry với token/expiry, atomic
reservation + reconciliation trên fresh main, ownership-safe finalize, exactly-once
publish, crash/restart và race tests. Không mở trước khi các bài kiểm thử và
owner approval cho concurrency ở production. Ba lane hiện tại giúp cộng tác chuẩn
mà không phải sửa write path hoặc liều trùng ID.

## QA/rollback

    node --test tests/writer-pack-suite.js
    node --test tests/agent-suite.js
    node --test tests/pipeline-suite.js

Rollback giai đoạn này: revert các file writer-pack/coordinator và docs/tests;
không cần reset checkpoint, manifest, matrix, URL hoặc bài đã xuất bản.
