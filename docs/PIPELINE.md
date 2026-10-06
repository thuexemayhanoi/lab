# Pipeline viết bài tự động (Autonomous Writing Pipeline)

Tài liệu này mô tả **legacy/internal pipeline tooling** của repo /lab. Từ Simple Production Mode 2026-10-06, pipeline này KHÔNG còn được schedule trong `factory-production.yml`; normal production dùng external writer push-driven theo `docs/CONTINUOUS-WRITER.md`. Tooling này được giữ cho recovery/manual testing và regression coverage.

## Ba nguyên tắc

1. **Writer chỉ nghiên cứu, viết và sửa bài được giao** trong workspace riêng (pipeline/writers/w1..w3/, gitignored). Writer không sửa state global, không merge, không push, không publish.
2. **Coordinator duy nhất quản lý queue, cấp bài, state, merge và publish.** Mọi ghi vào data/, _drafts/ và archive đều qua coordinator (scripts/factory/pipeline.js). Concurrency group trong GitHub Actions (group: lab-factory-production, cancel-in-progress: false) + lock file TTL 30 phút chống hai coordinator chạy đồng thời.
3. **Lỗi nhỏ tự retry có giới hạn; checkpoint + resume không trùng bài/deploy.** Writer retry tối đa writer_retries (mặc định 2) mỗi giai đoạn; repair theo feedback QA tối đa max_repair của factory (3). Pipeline chỉ dừng khi: hết topic hợp lệ, hết quota, hoặc lỗi lớn không recover được (fail-closed, không publish).

## Luồng một cycle

queue PLANNED < refill_min (100) → refill lên refill_target (~300 topic từ data/content-matrix.csv shards, bỏ qua topic đã published / đang xử lý / trùng) → claim batch 12–18 bài (prepare-next, transaction fail-closed) → chia đều cho 3 writer (round-robin) → mỗi writer: research → write → (QA → repair → re-QA) trong workspace riêng → coordinator ingest packet + body về repo (_drafts/) → wrap-drafts → QA từng bài (pass_min 75, review_min 70) → toàn bộ bài PASS của batch được publish trong MỘT transaction của cycle (operator.js publish --scope fast --cycle-batch, cap PUBLISH_BATCH_MAX=20 của engine — audit #3, không còn chia chunk) → trạng thái pending deployment (lưu ids + published_at vào state) → run kế xác nhận Pages build cuối thành công VÀ chứa publication SHA rồi mới finalize (audit #4) → đánh dấu PUBLISHED trong ledger → checkpoint tiến trình, giải phóng transaction + writer lock → sang cycle tiếp.

Không còn cron production cho pipeline. Nếu cần kiểm thử/recovery thủ công, chạy CLI trực tiếp trong môi trường được kiểm soát; state vẫn nằm tại `data/state/pipeline-state.json`.

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
3. Không dùng `factory-production.yml` để khởi động pipeline. Chỉ chạy CLI thủ công khi đang làm recovery/test có chủ đích.
4. Theo dõi: node scripts/factory/pipeline.js status (số topic trong queue, trạng thái lock, cycle gần nhất).

Kiểm thử an toàn: `node scripts/factory/pipeline.js selftest` (chỉ mock + test, không publish).

## Exactly-once và resume

- **Checkpoint**: mỗi bài sau khi publish được ghi ledger event 1 dòng; resume đọc checkpoint + ledger, không cấp lại bài đã publish.
- **Crash giữa cycle**: lock TTL 30 phút; chạy sau đọc state active, adopt các bài chưa publish, bỏ bài đã publish (theo ledger), không trùng.
- **Crash giữa publish (audit #3 — một transaction/commit cho cả cycle)**: stage chết giữa chừng ⇒ recover rollback deterministic từ journal (không có trạng thái half-PUBLISHED); op batch FAIL ⇒ fail-closed exit 1, rows giữ PASS để cycle sau resume — KHÔNG publish từng phần, và khi thành công đúng MỘT build + MỘT publication commit cho cả cycle.
- **Xác nhận deployment trước khi hoàn tất cycle (audit #4)**: push thành công ≠ deploy thành công. Sau publish, cycle ở trạng thái `deployment.pending`; run kế đọc Pages build cuối (PAGES_BUILD_COMMIT/PAGES_BUILD_STATUS do step "Pages deployment truth" export) và chỉ finalize khi build thành công VÀ chứa publication SHA (git merge-base). Sai SHA/build lỗi/thiếu truth ⇒ giữ trạng thái recoverable (không viết lại, không build lại, không push lại bài); pipeline không đợi deployment trong chính run vừa commit.
- **Đếm**: published_count chỉ tăng khi ledger ghi PUBLISHED; mỗi ID tối đa 1 lần trong toàn bộ lịch sử.

## Hygiene / stale drafts

Đầu cycle, staleDraftSweep so sánh _drafts/ với archive:

- Draft **byte-identical** với data/published/<ID>.html → tự xoá (an toàn).
- Draft **diverged** → pipeline **STOP exit 1** (fail-closed, không bao giờ ghi đè bài đã publish). Xử lý theo docs/PROC-RECOVERY.md, hoặc xoá thủ công nếu draft rác.

push-selection.js mode stale và hygiene step trong workflow cũng dùng đúng quy tắc này: chỉ cho phép xoá draft identical; diverged từ chối.

## Lệnh CLI

node scripts/factory/pipeline.js status    # trạng thái queue/lock/cycle
node scripts/factory/pipeline.js refill   # chỉ refill queue (không claim)
node scripts/factory/pipeline.js cycle    # 1 cycle thủ công/recovery; KHÔNG có cron production
node scripts/factory/pipeline.js selftest # chạy tests/pipeline-suite.js (mock)

State internal (gitignored, không commit, **RUN-LOCAL — không đi theo runner mới**): pipeline/ (lock.json coordinator lock, maintenance.json maintenance lock #4/#5, workspace writer). Serialize giữa các workflow run: concurrency group `lab-factory-production`.

State commit được: data/state/pipeline-state.json (checkpoint, queue pointer, **durable pause**). Ghi chú quan trọng:

- **Durable pause**: khi state có `pause` (incident FAILED_PAUSED / #4 rebuild state), MỌI runner mới đều thấy `PIPELINE PAUSED (durable)` — KHÔNG claim/viết/publish; pause KHÔNG tự hết theo TTL (maintenance TTL chỉ là lock run-local). Chỉ #5 của đúng incident sở hữu pause được clear sau verify thành công.
- **Load strict (fail-closed)**: pipeline-state.json có sẵn mà hỏng cú pháp ⇒ `PIPELINE REFUSED` exit 1, KHÔNG âm thầm dựng state rỗng để chạy production. Thiếu file = bình thường (chưa có cycle nào).
