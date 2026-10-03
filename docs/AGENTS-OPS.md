# AGENTS-OPS.md — Operational Agents #4 / #5 / #6 (docs/PIPELINE.md tiếp theo)

Ba agent vận hành BÊN CẠNH pipeline viết bài (không thay thế, không can thiệp
nội dung). **Tất cả KHÔNG BAO GIỜ viết bài, không đụng queue/matrix/taxonomy/
content strategy.** Writers (w1–w3) vẫn content-only như cũ.

| Agent | File | CLI | Trigger | Trách nhiệm |
|---|---|---|---|---|
| **#4 repair** | `scripts/factory/agent-repair.js` | `repair --source … \| status` | `workflow_run` (Factory production FAIL trên main) hoặc dispatch `action=repair` | First-line infra repair — MỘT pass, không poll |
| **#5 supervisor** | `scripts/factory/agent-supervisor.js` | `run --incident <id> \| conclude --incident <id> \| status` | Chỉ sau khi #4 trả `SUCCESS` hoặc `ESCALATE` (job `agent-supervisor`, `needs: agent-repair`) | Verify độc lập HOẶC đúng MỘT lần sửa second-line; fail ⇒ pause + report + STOP |
| **#6 watchdog** | `scripts/factory/agent-watchdog.js` | `check [--trigger-cmd CMD] [--dry-run] \| status` | Cron `10 * * * *` (job `agent-watchdog`, dispatch `action=watchdog`) | Đánh thức factory nếu không có progress hợp lệ ≥ 2 giờ |

Nền chung: `scripts/factory/agents-core.js` (maintenance lock + incident
store + probes). Cấu hình: `config/agents.json`.

## Locks & state

- **Maintenance lock** — `pipeline/maintenance.json` (gitignored, **RUN-LOCAL**:
  KHÔNG đi theo runner mới — chết theo workspace). `{active, holder:
  agent-4|agent-5, incident_id, expires_at}`. CHỈ MỘT incident được mutate hạ
  tầng tại một thời điểm, TRONG MỘT workspace. `pipeline.js cycle` đọc lock
  này: còn hiệu lực ⇒ `PIPELINE PAUSED`, thoát sạch exit 0 (không claim/viết/
  publish). Serialization GIỮA các run là workflow `concurrency:
  lab-factory-production` + durable pause dưới đây — KHÔNG phải lock run-local.
- **Coordinator lock** — `pipeline/lock.json` (run-local, chống 2 coordinator
  trong cùng workspace); #6 coi lock còn hiệu lực = writer cycle đang chạy ⇒
  DO NOTHING.
- **Incident store** — `reports/incidents/<INC-…>.json` (committed, auditable:
  timestamp + actor + action + kết quả regression tests mỗi bước) + bản
  human-readable `<INC-…>.md` khi FAILED_PAUSED. Một failed run ⇒ một incident
  duy nhất (dedup theo `source.run_id`).
- **Circuit breaker** — ≥ `max_recent_unrepaired` (2) incident FAILED_PAUSED
  trong `unrepaired_window_minutes` (120') ⇒ #4 REFUSED: production giữ pause,
  chờ human (chống loop repair⇒fail⇒repair).
- **Durable pause (khóa bền vững DUY NHẤT qua runner)** — `data/state/
  pipeline-state.json` là COMMITTED truth: khi có `state.pause =
  {by, incident_id, at, reason}` thì MỌI runner mới đều thấy `PIPELINE PAUSED
  (durable)`, KHÔNG claim/viết/publish. Pause KHÔNG hết hạn theo
  `pause_ttl_minutes` (TTL chỉ áp cho maintenance lock run-local) — KHÔNG có
  self-heal: FAILED_PAUSED giữ nguyên qua runner mới và qua hết TTL, chờ human
  hoặc #5 của ĐÚNG incident đó verify thành công. Ownership fail-closed:
  chỉ đúng incident sở hữu pause mới được clear (`clearPause(incidentId)`);
  incident khác KHÔNG clear/đè được pause của người khác.
- **Open-incident guard** — #4 gián đoạn SAU khi commit incident nhưng chưa có
  `final` (runner chết giữa chừng): run mới (không có maintenance.json
  run-local) vẫn nhận biết qua incident store committed ⇒ `PIPELINE PAUSED:
  incident chưa hoàn tất` — KHÔNG tiếp tục production cho đến khi incident có
  kết luận (cửa sổ `unrepaired_window_minutes`).
- **Operator pause gate** — `operator.js` từ chối op MUTATING (prepare-next/
  research/qa/publish) khi durable pause active (entrypoint publish cũ
  KHÔNG bypass maintenance/pause). Ngoại lệ duy nhất: maintenance lock cùng
  `incident_id` với pause owner (#4/#5 đang sửa chính incident đó). `status`/
  `verify`/`recover` không bị gate.
- **Handoff #4 → #5 QUA COMMIT** — job `agent-repair` push incident audit lên
  main (kể cả khi step #4 fail: `if: always()`) và export `head_sha`; job
  `agent-supervisor` checkout ĐÚNG `head_sha` đó + verify commit nằm trên
  origin/main (`git merge-base --is-ancestor`) trước khi chạy #5. KHÔNG dùng
  SHA cũ của event.
- **State hỏng cú pháp fail-closed** — `pipeline-state.json` có sẵn mà không
  parse được ⇒ cycle `PIPELINE REFUSED` exit 1 (KHÔNG âm thầm dựng state rỗng
  để chạy production); #4 rebuild state ⇒ đặt durable pause thuộc incident
  đó (production KHÔNG tự chạy trên state vừa dựng).

## Luồng sự cố điển hình

1. Job publish/pipeline FAIL trên main ⇒ `workflow_run` ⇒ job `agent-repair` ⇒
   #4 tạo `incident_id`, giữ maintenance lock (production PAUSED), inspect
   txn/writer-lock/coordinator-lock/pipeline-state.
2. Lớp an toàn đã hiểu ⇒ sửa nhỏ nhất: `txn-stuck`/`writer-lock-stale` ⇒
   `operator.js recover` (deterministic); `coord-lock-stale` ⇒ giải TTL lock;
   `pipeline-state-corrupt` ⇒ backup + dựng lại default (matrix là truth).
   Sau MỌI repair: regression `operator.js verify --scope fast`, ghi vào
   incident. OK ⇒ `SUCCESS`; không rõ/ambiguous/content-sensitive ⇒ `ESCALATE`.
   Cả hai đều giữ nguyên lock + incident_id rồi giao #5.
3. #5 takeover lock (KHÔNG bao giờ đồng thời với #4): verify ĐỘC LẬP (probes
   mới + verify fast + pipeline status). Khoẻ ⇒ clear pause (chỉ đúng
   incident sở hữu) ⇒ release lock ⇒ resume bằng đúng MỘT entrypoint
   `pipeline.js cycle` (tự fan-out 3 writer). Kết quả resume được PHÂN LOẠI
   TRUNG THỰC: cycle rc≠0 ⇒ `RESUME_FAILED` (KHÔNG báo VERIFIED_RESUMED;
   giữ checkpoint, incident đỏ); cycle PAUSED ⇒ production KHÔNG chạy ⇒
   FAILED_PAUSED; cycle IDLE-STOP (writer runtime chưa cấu hình) ⇒
   VERIFIED_RESUMED nhưng summary ghi rõ "KHÔNG bài nào được viết"; cycle SKIP
   (coordinator khác đang chạy) ⇒ VERIFIED_RESUMED, không chạy trùng. Không
   khoẻ ⇒ đúng MỘT lần sửa second-line ⇒ khoẻ thì release + resume (phân
   loại như trên); không được ⇒ **FAILED_PAUSED**: durable pause + lock TTL,
   bảo toàn checkpoints/writer commits, viết `<INC-…>.md`, job đỏ (conclude
   exit 1), STOP — KHÔNG có Agent #7.
4. #6 (cron 10 * * * *, read-only): đếm progress HỢP LỆ (commit đụng
   `_drafts/` hoặc matrix shards, hoặc cycle hoàn tất có published/blocked —
   KHÔNG phải log/heartbeat/status). < 2h ⇒ DO NOTHING. ≥ 2h NHƯNG còn
   maintenance lock / pause chủ ý / idle chưa có writer runtime /
   coordinator lock / txn / writer-lock / Actions run in_progress ⇒ DO
   NOTHING. Ngược lại ⇒ trigger ĐÚNG MỘT entrypoint
   (`gh workflow run factory-production.yml -f action=pipeline`) — không
   start writer riêng lẻ, không cancel run, không tạo cycle trùng (concurrency
   group `lab-factory-production` + coordinator lock serialize mọi thứ).

## Bất biến an toàn (regression-checked: `tests/agent-suite.js`)

- #4 và #5 KHÔNG sửa đồng thời (lock + handoff cùng incident_id).
- Tối đa 1 lần sửa/incident cho #4 và 1 cho #5; #4 → #5 là đường escalation
  duy nhất; sau #5 fail không agent nào tự sửa tiếp.
- #6 passive khi #4/#5 active hoặc production đang chạy/pause.
- Production không mutate khi maintenance lock còn hiệu lực.
- Production không mutate khi durable pause active (qua runner mới, qua hết
  TTL) — chỉ clear sau verify thành công của ĐÚNG incident sở hữu pause.
- #5 KHÔNG bao giờ báo VERIFIED_RESUMED khi resume cycle fail/paused; IDLE-STOP
  được báo đúng trạng thái (không bài nào được viết).
- Một failed run ⇒ một incident (dedup); không loop sửa vô hạn (breaker).
- Không force-clear state mù; không giành lock của incident khác; mọi hành
  động auditable theo thời gian.
