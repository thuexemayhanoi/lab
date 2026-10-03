# Pipeline viết bài tự động (Autonomous Writing Pipeline)

Tài liệu này mô tả pipeline chạy nền viết bài tự động của repo /lab: coordinator duy nhất, 3 writer song song, QA từng bài, build/deploy 1 lần/cycle, publish đúng một lần (exactly-once), checkpoint/resume không trùng bài.

## Ba nguyên tắc

1. **Writer chỉ nghiên cứu, viết và sửa bài được giao** trong workspace riêng (pipeline/writers/w1..w3/, gitignored). Writer không sửa state global, không merge, không push, không publish.
2. **Coordinator duy nhất quản lý queue, cấp bài, state, merge và publish.** Mọi ghi vào data/, _drafts/ và archive đều qua coordinator (scripts/factory/pipeline.js). Concurrency group trong GitHub Actions (group: lab-factory-production, cancel-in-progress: false) + lock file TTL 30 phút chống hai coordinator chạy đồng thời.
3. **Lỗi nhỏ tự retry có giới hạn; checkpoint + resume không trùng bài/deploy.** Writer retry tối đa writer_retries (mặc định 2) mỗi giai đoạn; repair theo feedback QA tối đa max_repair của factory (3). Pipeline chỉ dừng khi: hết topic hợp lệ, hết quota, hoặc lỗi lớn không recover được (fail-closed, không publish).

## Luồng một cycle

queue PLANNED < refill_min (100) → refill lên refill_target (~300 topic từ data/content-matrix.csv shards, bỏ qua topic đã published / đang xử lý / trùng) → claim batch 12–18 bài (prepare-next, transaction fail-closed) → chia đều cho 3 writer (round-robin) → mỗi writer: research → write → (QA → repair → re-QA) trong workspace riêng → coordinator ingest packet + body về repo (_drafts/) → wrap-drafts → QA từng bài (pass_min 75, review_min 70) → bài PASS gom thành chunk ≤ publish_chunk (10) → publish qua operator.js publish --scope fast (build/verify fail-closed) → xác nhận commit/deploy → đánh dấu PUBLISHED trong ledger → checkpoint tiến trình, giải phóng transaction + writer lock → sang cycle tiếp (max_cycles_per_run = 1 mỗi lần chạy workflow).

Cron */30 * * * * chạy job pipeline trong factory-production.yml; mỗi lần chạy đúng 1 cycle, tự tiếp tục ở lần chạy sau (state nằm tại data/state/pipeline-state.json).

## Cấu hình runtime writer

Pipeline đọc biến môi trường, set qua GitHub Variables/Secrets của repo (không commit secret vào repo):

| Biến | Nơi lưu | Ý nghĩa |
|---|---|---|
| WRITER_RUNTIME | GitHub Variable | off (mặc định, IDLE-STOP an toàn), http (writer thật), mock (chỉ test, yêu cầu PIPELINE_ALLOW_MOCK=1) |
| WRITER_ENDPOINT | GitHub Variable | URL HTTP endpoint của writer runtime (bắt buộc khi WRITER_RUNTIME=http) |
| WRITER_API_KEY | GitHub Secret | API key cho endpoint (tuỳ chọn) |
| WRITER_TIMEOUT_MS | GitHub Variable | Timeout mỗi lượt gọi writer (mặc định 300000) |

Khi WRITER_RUNTIME=off, pipeline vẫn refill queue và giữ state, nhưng dừng trước khi claim bài (IDLE-STOP, exit 0) — không tạo draft, không publish. Khi thiếu WRITER_ENDPOINT với http, cycle fail-closed, không claim bài.

Writer HTTP nhận POST {task, article_id, row, packet, feedback} với task thuộc research|write|revise và trả JSON packet/body tương ứng.

## Khởi động chạy thật

1. Deploy writer runtime thật ở một endpoint HTTP ổn định.
2. Set GitHub Variables: WRITER_RUNTIME=http, WRITER_ENDPOINT=<url> (+ Secret WRITER_API_KEY nếu endpoint cần auth).
3. Lịch factory-production.yml (cron */30 * * * *) hoặc trigger thủ công: workflow_dispatch với input action=pipeline để chạy 1 cycle ngay.
4. Theo dõi: node scripts/factory/pipeline.js status (số topic trong queue, trạng thái lock, cycle gần nhất).

Kiểm thử an toàn: workflow_dispatch với action=selftest chạy node scripts/factory/pipeline.js selftest (chỉ mock + test, không publish).

## Exactly-once và resume

- **Checkpoint**: mỗi bài sau khi publish được ghi ledger event 1 dòng; resume đọc checkpoint + ledger, không cấp lại bài đã publish.
- **Crash giữa cycle**: lock TTL 30 phút; chạy sau đọc state active, adopt các bài chưa publish, bỏ bài đã publish (theo ledger), không trùng.
- **Crash giữa publish**: chunk được đánh dấu trước khi push; resume publish phần còn lại, chunk đã confirm bỏ qua.
- **Đếm**: published_count chỉ tăng khi ledger ghi PUBLISHED; mỗi ID tối đa 1 lần trong toàn bộ lịch sử.

## Hygiene / stale drafts

Đầu cycle, staleDraftSweep so sánh _drafts/ với archive:

- Draft **byte-identical** với data/published/<ID>.html → tự xoá (an toàn).
- Draft **diverged** → pipeline **STOP exit 1** (fail-closed, không bao giờ ghi đè bài đã publish). Xử lý theo docs/PROC-RECOVERY.md, hoặc xoá thủ công nếu draft rác.

push-selection.js mode stale và hygiene step trong workflow cũng dùng đúng quy tắc này: chỉ cho phép xoá draft identical; diverged từ chối.

## Lệnh CLI

node scripts/factory/pipeline.js status    # trạng thái queue/lock/cycle
node scripts/factory/pipeline.js refill   # chỉ refill queue (không claim)
node scripts/factory/pipeline.js cycle    # 1 cycle đầy đủ (cron chạy lệnh này)
node scripts/factory/pipeline.js selftest # chạy tests/pipeline-suite.js (mock)

State internal (gitignored, không commit): pipeline/ (lock, workspace writer). State commit được: data/state/pipeline-state.json (checkpoint, queue pointer).
