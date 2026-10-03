#!/usr/bin/env node
/**
 * agent-watchdog.js — AGENT #6: DIRECTOR / PRODUCTION WATCHDOG
 * (docs/AGENTS-OPS.md).
 *
 * Trách nhiệm DUY NHẤT: đánh thức factory nếu production THẬT SỰ dừng
 * >= 120 phút liên tục (watchdog_stall_minutes). KHÔNG BAO GIỜ repair,
 * KHÔNG sửa bài, KHÔNG đụng queue/matrix/manifests/taxonomy/content
 * strategy/kiến trúc production, KHÔNG cancel run đang chạy, KHÔNG tạo
 * cycle trùng.
 *
 * Progress HỢP LỆ (valid progress) — KHÔNG phải log/heartbeat/poll/check/
 * status message/run fail:
 *   - writer staging thật: commit đụng _drafts/;
 *   - publish/integration thật: commit đụng matrix shards (truth);
 *   - production cycle hoàn tất: pipeline-state.last_cycle_summary có
 *     published hoặc blocked (writer + QA đã chạy thật).
 *
 * Điều kiện ĐỦ IDLE mới được đánh thức (thiếu một => DO NOTHING):
 *   1. Agent #4 idle, Agent #5 idle — KHÔNG có maintenance lock còn hiệu lực
 *      (lock = đang sửa hoặc production pause chờ human);
 *   2. production KHÔNG pause chủ ý (pipeline-state.pause do #5 đặt);
 *   3. KHÔNG có writer cycle đang chạy (coordinator lock còn hiệu lực);
 *   4. KHÔNG có publisher/integration/build/deploy đang chạy (txn active /
 *      writer-lock còn hiệu lực / workflow run in_progress trên GitHub).
 *
 * Đánh thức: trigger ĐÚNG MỘT production entrypoint sẵn có (trigger-cmd do
 * workflow truyền: `gh workflow run ... -f action=pipeline`). Entry point
 * pipeline.js cycle TỰ phân bổ và fan-out cho 3 writer — #6 KHÔNG BAO GIỜ
 * start Writer 1/2/3 riêng lẻ.
 *
 * Không busy-poll: một pass mỗi lần chạy (cron nhẹ 10 * * * *).
 *
 * CLI: node scripts/factory/agent-watchdog.js check
 *        [--trigger-cmd CMD] [--dry-run] [--skip-git] [--now ISO]
 *      node scripts/factory/agent-watchdog.js status
 */
'use strict';
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const core = require(path.join(__dirname, 'agents-core.js'));
const ROOT = core.ROOT;
const ACFG = core.cfg();

function record(check) { // audit local (gitignored) — KHÔNG commit, KHÔNG mutate production
  try {
    fs.mkdirSync(core.PIPE_DIR, { recursive: true });
    fs.writeFileSync(path.join(core.PIPE_DIR, 'watchdog-last.json'), JSON.stringify(check, null, 2));
  } catch (e) { /* audit best-effort */ }
}

// GitHub Actions runs đang chạy (MỘT lệnh API duy nhất — KHÔNG poll).
// Trả về: true = có run in_progress của Factory production; false = idle;
// null = không kiểm tra được (không trong Actions / không có gh) => bỏ qua
// nhánh này ở local, nhưng trong Actions thì fail-closed (DO NOTHING).
function ghProductionActive() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
  if (!repo || !token) return null; // local/test: không có API context
  try {
    const out = execFileSync('gh', ['api', '--hostname', apiUrl.replace(/^https:\/\//, ''),
      'repos/' + repo + '/actions/runs?status=in_progress&per_page=20'], { encoding: 'utf8' });
    const j = JSON.parse(out);
    const active = (j.workflow_runs || []).filter(r => r.name === 'Factory production');
    return active.length > 0;
  } catch (e) { return null; }
}

function check(a) {
  const stallMs = (a.stall_minutes ? Number(a.stall_minutes) : ACFG.watchdog_stall_minutes) * 60000;
  const now = a.now ? new Date(a.now).getTime() : Date.now();
  const skipGit = a['skip-git'] === true || a['skip-git'] === 'true';

  // (1) progress hợp lệ gần nhất (repo truth — KHÔNG tin log/heartbeat)
  const lastValid = core.validProgressAt({ skipGit });
  const idleForMs = lastValid === null ? Infinity : now - lastValid;
  const stalled = idleForMs >= stallMs;

  const p = core.probes();
  const blockers = [];
  // (2) điều kiện đủ-idle
  if (p.maintenance_held) blockers.push('maintenance lock còn hiệu lực (holder=' + (p.maintenance && p.maintenance.holder) + ', incident=' + (p.maintenance && p.maintenance.incident_id) + ') — Agent #4/#5 đang chạy hoặc production đang pause chờ human');
  if (p.intentional_pause) blockers.push('pipeline-state.pause: production pause CHỦ Ý (incident ' + (p.pipeline_state.pause && p.pipeline_state.pause.incident_id) + ')');
  const lastStop = p.pipeline_state && p.pipeline_state.last_stop;
  if (lastStop && lastStop.kind === 'idle') blockers.push('pipeline IDLE chủ ý: writer runtime chưa cấu hình (WRITER_RUNTIME=off) — KHÔNG phải production chết, là chờ cấu hình');
  if (p.coord_lock_held) blockers.push('coordinator lock còn hiệu lực — writer cycle đang chạy');
  if (p.txn_active) blockers.push('transaction ' + (p.txn && p.txn.id) + ' active — publisher/integration đang chạy');
  if (p.writer_lock_held) blockers.push('writer-lock còn hiệu lực (holder=' + (p.writer_lock.raw && p.writer_lock.raw.holder) + ')');
  const ghActive = ghProductionActive();
  if (ghActive === true) blockers.push('GitHub Actions: có run in_progress của Factory production');
  if (ghActive === null && process.env.GITHUB_REPOSITORY && (process.env.GITHUB_TOKEN || process.env.GH_TOKEN))
    blockers.push('GitHub Actions: KHÔNG kiểm tra được trạng thái run (fail-closed — giả định có run đang chạy)');

  const result = { agent: 'agent-6 (watchdog)', at: new Date(now).toISOString(),
    last_valid_progress_at: lastValid === null ? null : new Date(lastValid).toISOString(),
    idle_for_minutes: lastValid === null ? null : Math.round(idleForMs / 60000),
    stall_threshold_minutes: Math.round(stallMs / 60000),
    stalled, blockers, action: 'DO_NOTHING', triggered: false, detail: '' };

  if (!stalled) {
    result.detail = 'progress hợp lệ gần nhất ' + result.idle_for_minutes + ' phút trước (< ngưỡng ' + result.stall_threshold_minutes + ' phút) — production ĐANG chạy, KHÔNG can thiệp.';
    record(result);
    return { result, exitCode: 0 };
  }
  result.idle_for_minutes = lastValid === null ? null : result.idle_for_minutes;
  if (blockers.length) {
    result.detail = 'production stalled NHƯNG chưa đủ idle: ' + blockers.join(' | ');
    record(result);
    return { result, exitCode: 0 };
  }

  // (3) đủ idle => trigger ĐÚNG MỘT production entrypoint (KHÔNG start writer riêng lẻ)
  result.action = 'TRIGGER_ONE_ENTRYPOINT';
  const cmd = a['trigger-cmd'];
  if (!cmd || a['dry-run'] === true || a['dry-run'] === 'true') {
    result.triggered = false;
    result.detail = 'WOULD TRIGGER: ' + (cmd || 'node scripts/factory/pipeline.js cycle') + (a['dry-run'] ? ' (dry-run)' : ' (không có trigger-cmd — chỉ báo cáo)');
    record(result);
    return { result, exitCode: 0 };
  }
  try {
    const r = execFileSync('sh', ['-c', cmd], { encoding: 'utf8', cwd: ROOT, timeout: 60000 });
    result.triggered = true; result.detail = 'ĐÃ TRIGGER đúng một entrypoint: ' + cmd + ' — output: ' + String(r).trim().slice(0, 200);
  } catch (e) {
    result.triggered = false; result.detail = 'trigger THẤT BẠI (KHÔNG retry — lần check sau sẽ đánh giá lại): ' + String(e.message).slice(0, 200);
  }
  record(result);
  return { result, exitCode: 0 };
}

function cmdCheck(a) {
  const { result, exitCode } = check(a);
  console.log(JSON.stringify(result, null, 2));
  return exitCode;
}
function cmdStatus() {
  let last = null;
  try { last = JSON.parse(fs.readFileSync(path.join(core.PIPE_DIR, 'watchdog-last.json'), 'utf8')); } catch (e) {}
  console.log(JSON.stringify({ agent: 'agent-6 (watchdog)', maintenance_held: core.maintHeld(),
    intentional_pause: core.probes().intentional_pause, last_check: last }, null, 2));
}
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++)
    if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? (i++, argv[i]) : true; }
  return o;
}
function main(argv) {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest);
  if (cmd === 'check') return cmdCheck(a);
  if (cmd === 'status') return cmdStatus();
  console.error('Usage: agent-watchdog.js <check [--trigger-cmd CMD] [--dry-run] | status>');
  return 1;
}
if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { check, ghProductionActive, parseArgs };
