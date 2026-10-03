#!/usr/bin/env node
/**
 * agent-repair.js — AGENT #4: FIRST-LINE INFRASTRUCTURE REPAIR (docs/AGENTS-OPS.md).
 *
 * Trách nhiệm DUY NHẤT: sửa chữa hạ tầng tuyến đầu. KHÔNG BAO GIỜ viết bài,
 * KHÔNG đụng content/queue/matrix/taxonomy/content strategy.
 *
 * Trigger (event-driven, không busy-poll):
 *   - GitHub workflow_run: job production (publish/pipeline) FAIL trên main
 *     (workflow factory-production.yml job `repair` chuyển context vào CLI).
 *   - Thủ công: workflow_dispatch action=repair (incident từ người vận hành).
 *
 * Luồng MỘT pass (không vòng lặp, không poll):
 *   1. Dedup theo run_id (một failed run => một incident duy nhất).
 *   2. Circuit breaker: >= max_recent_unrepaired incident FAILED_PAUSED gần
 *      đây => REFUSED (production giữ pause, chờ human — chống loop).
 *   3. Tạo incident_id + acquire GLOBAL MAINTENANCE LOCK (pipeline/
 *      maintenance.json). Lock bận => DEFERRED (incident khác đang sửa).
 *      Giữ lock = production mutations tạm dừng (pipeline.js cycle thoát
 *      PAUSED; workflow concurrency group serialized cùng group).
 *   4. Inspect CHỈ đúng phạm vi lỗi: txn, writer-lock, coordinator lock,
 *      pipeline-state, workflow context của run fail. KHÔNG quét toàn repo.
 *   5. Auto-repair CHỈ lớp an toàn — hiểu rõ, phục hồi được, nhỏ nhất:
 *        txn-stuck / writer-lock-stale  => operator.js recover (deterministic)
 *        coord-lock-stale               => giải TTL lock hết hạn (artifact local)
 *        pipeline-state-corrupt         => backup + dựng lại state mặc định
 *      (state là derived — matrix truth giữ nguyên; KHÔNG đụng bài viết.)
 *      Mọi lớp khác (diverged drafts, ownership không rõ, content-sensitive)
 *      => ESCALATE Agent #5.
 *   6. Sau MỌI repair: regression test liên quan (operator.js verify --scope
 *      fast) — kết quả ghi vào incident (auditable).
 *   7. SUCCESS => giao quyền Agent #5 (giữ nguyên lock + incident_id để #5
 *      verify độc lập). ESCALATE => giao #5 re-diagnose (đúng 1 lần sửa
 *      second-line). KHÔNG bao giờ tự sửa tiếp.
 *
 * CLI: node scripts/factory/agent-repair.js repair
 *        --source workflow_run|manual|test [--run-id ID] [--run-url URL]
 *        [--job NAME] [--reason TEXT]
 *      node scripts/factory/agent-repair.js status
 */
'use strict';
const fs = require('fs'), path = require('path');
const { spawnSync } = require('child_process');
const core = require(path.join(__dirname, 'agents-core.js'));
const ROOT = core.ROOT;
const ACFG = core.cfg();

const op = (args) => spawnSync(process.execPath, [path.join('scripts', 'factory', 'operator.js'), ...args],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

function out(line) { console.log(line); }

// ------------------------------ diagnose -------------------------------------
// Chỉ trả về lớp repair ĐÃ HIỂU: {kind, detail, fix()} hoặc null (không rõ => ESCALATE)
function diagnose(p, inc) {
  if (!p.pipeline_state_ok) {
    return { kind: 'pipeline-state-corrupt',
      detail: 'pipeline-state.json không parse được: ' + String(p.pipeline_state_error).slice(0, 200),
      fix: () => repairStateCorrupt(inc && inc.id) };
  }
  if (p.txn_active && !p.writer_lock_held) {
    return { kind: 'txn-stuck',
      detail: 'transaction ' + (p.txn && p.txn.id) + ' active (op=' + (p.txn && p.txn.operation) + '), writer-lock free',
      fix: () => runRecover() };
  }
  if (!p.txn_active && p.writer_lock && p.writer_lock.raw && p.writer_lock.raw.locked && !p.writer_lock.held) {
    return { kind: 'writer-lock-stale',
      detail: 'writer-lock hết hạn (holder=' + p.writer_lock.raw.holder + ') — stale, deterministic clear',
      fix: () => runRecover() };
  }
  if (p.coord_lock && p.coord_lock.locked && !p.coord_lock_held) {
    return { kind: 'coord-lock-stale',
      detail: 'coordinator lock hết hạn TTL (holder=' + p.coord_lock.holder + ') — artifact run-local',
      fix: () => repairCoordLockStale() };
  }
  if (p.txn_active && p.writer_lock_held) {
    return { kind: 'ownership-unclear',
      detail: 'txn ' + (p.txn && p.txn.id) + ' active + writer-lock còn hiệu lực (holder=' + p.writer_lock.raw.holder + ') — ownership không rõ, fail-closed', fix: null };
  }
  return null; // không xác định được lớp an toàn — ESCALATE
}

// ------------------------------ safe repairs ---------------------------------
function runRecover() {
  const r = op(['recover']);
  return { ok: r.status === 0, log: tail(r) };
}
function repairCoordLockStale() {
  fs.mkdirSync(core.PIPE_DIR, { recursive: true });
  fs.writeFileSync(core.COORD_LOCK_FILE, JSON.stringify({ locked: false, holder: null,
    acquired_at: null, expires_at: null }, null, 2));
  return { ok: true, log: 'coordinator lock stale — đã giải (artifact TTL, KHÔNG đụng state chung).' };
}
function repairStateCorrupt(incidentId) {
  const stPath = core.STATE_FILE;
  fs.mkdirSync(core.PIPE_DIR, { recursive: true });
  const bak = path.join(core.PIPE_DIR, 'backup', 'pipeline-state.' + Date.now() + '.json');
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  try { fs.copyFileSync(stPath, bak); } catch (e) {} // state hỏng vẫn được giữ làm bằng chứng
  fs.mkdirSync(path.dirname(stPath), { recursive: true });
  // Rebuild là DERIVED state (matrix là truth) — nhưng production KHÔNG được
  // tự chạy tiếp chỉ vì state mới dựng: đặt DURABLE PAUSE thuộc chính incident
  // này (fail-closed). #5 của cùng incident verify thành công => clear đúng
  // pause => resume. KHÔNG bao giờ dựng state "sạch" để production chạy ngay.
  fs.writeFileSync(stPath, JSON.stringify({ version: 1, updated_at: new Date().toISOString(),
    cycle: 0, pending: [], planned_total: null, active: null, last_cycle_summary: null,
    last_stop: null,
    stopped_reason: 'pipeline-state được Agent #4 dựng lại từ default (file cũ backup ở pipeline/backup — matrix là truth; queue/active sẽ được refill/adopt từ repository truth ở cycle kế tiếp SAU khi incident được verify)',
    pause: incidentId ? { by: 'agent-4', incident_id: incidentId, at: new Date().toISOString(),
      reason: 'pipeline-state rebuilt sau corruption — production giữ pause cho đến khi Agent #5 verify thành công (đúng incident sở hữu pause)' } : null }, null, 2));
  return { ok: true, log: 'pipeline-state.json corrupt — backup ' + path.basename(bak) + ', dựng lại default + durable pause' + (incidentId ? ' (incident ' + incidentId + ')' : '') + ' (derived state; KHÔNG đụng matrix/checkpoint).' };
}
function tail(r) { return ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-6).join('\n'); }

function runRegression() { // regression test LIÊN QUAN, fast, không full test-suite
  const r = op(['verify', '--scope', 'fast']);
  return { ok: r.status === 0, log: tail(r) };
}

// ------------------------------ main flow ------------------------------------
function cmdRepair(a) {
  const source = a.source || 'manual';
  const runId = a['run-id'] || a.runId || '';
  const runUrl = a['run-url'] || a.runUrl || '';
  const job = a.job || '';
  const reason = a.reason || '';

  // (1) dedup exactly-once theo run_id
  const dup = core.findBySourceRun(runId);
  if (dup) {
    out('AGENT4_REFUSED: run ' + runId + ' đã có incident ' + dup.id + ' (final=' + (dup.final ? dup.final.status : 'in-progress') + ') — KHÔNG tạo incident trùng.');
    out('AGENT4_RESULT=REFUSED_DEDUP');
    return 0;
  }
  // (2) circuit breaker: chống loop repair => repair fail => workflow_run repair...
  if (core.recentUnrepaired(ACFG) >= ACFG.max_recent_unrepaired) {
    out('AGENT4_REFUSED: circuit breaker — đã có >= ' + ACFG.max_recent_unrepaired
      + ' incident FAILED_PAUSED trong ' + ACFG.unrepaired_window_minutes + ' phút gần nhất. Production GIỮ pause, chờ human (docs/PROC-RECOVERY.md).');
    out('AGENT4_RESULT=REFUSED_BREAKER');
    return 0;
  }

  const inc = { id: core.newIncidentId(), created_at: new Date().toISOString(),
    source: { kind: source, run_id: runId || null, run_url: runUrl || null, job: job || null, reason: reason || null },
    actions: [], final: null };
  core.saveIncident(inc);
  out('AGENT4_INCIDENT_ID=' + inc.id);
  out('AGENT4: incident ' + inc.id + ' — source=' + source + (runId ? ' run=' + runId : '') + (job ? ' job=' + job : ''));

  // (3) global maintenance lock — một incident duy nhất mutate infra
  if (!core.acquireMaintenance(inc.id, 'agent-4', ACFG.maintenance_ttl_minutes,
      'agent-4 repairing: ' + (reason || source))) {
    const m = core.maintRaw();
    core.setFinal(inc, 'DEFERRED_LOCK_BUSY', 'maintenance lock đang được giữ bởi incident khác (holder=' + (m && m.holder) + ') — KHÔNG sửa đồng thời, thoát sạch.');
    out('AGENT4_RESULT=DEFERRED_LOCK_BUSY');
    return 0;
  }
  core.act(inc, 'agent-4', 'acquire-maintenance-lock', 'Đã giữ global maintenance lock — production mutations tạm dừng trong lúc sửa (pipeline cycle => PAUSED).');
  out('AGENT4: maintenance lock acquired — production mutations PAUSED trong lúc sửa.');

  try {
    // (4) inspect — chỉ đúng phạm vi lỗi
    const p = core.probes();
    core.act(inc, 'agent-4', 'inspect', 'txn_active=' + p.txn_active + ' writer_lock_held=' + p.writer_lock_held
      + ' coord_lock_held=' + p.coord_lock_held + ' state_ok=' + p.pipeline_state_ok
      + ' stopped_reason=' + (p.pipeline_state && p.pipeline_state.stopped_reason ? String(p.pipeline_state.stopped_reason).slice(0, 160) : 'null'));

    // (5) chẩn đoán + auto-repair lớp an toàn
    const d = diagnose(p, inc);
    if (!d) {
      core.setFinal(inc, 'ESCALATE', 'Không xác định được lớp hỏng an toàn nào từ probes (hoặc không có hỏng infra nào) — giao Agent #5 re-diagnose độc lập. Probes: ' + JSON.stringify({ txn_active: p.txn_active, writer_lock_held: p.writer_lock_held, coord_lock_held: p.coord_lock_held, state_ok: p.pipeline_state_ok }));
      out('AGENT4_RESULT=ESCALATE');
      return 0;
    }
    out('AGENT4: diagnosed ' + d.kind + ' — ' + d.detail);
    if (!d.fix) { // hiểu rõ nhưng KHÔNG an toàn để tự sửa
      core.setFinal(inc, 'ESCALATE', d.kind + ': ' + d.detail + ' — KHÔNG tự sửa (fail-closed), giao Agent #5.');
      out('AGENT4_RESULT=ESCALATE');
      return 0;
    }

    core.act(inc, 'agent-4', 'repair:' + d.kind, d.detail);
    const res = d.fix();
    core.act(inc, 'agent-4', 'repair-result:' + d.kind, res.log, { ok: res.ok });
    if (!res.ok) {
      core.setFinal(inc, 'ESCALATE', 'Repair ' + d.kind + ' KHÔNG thành công (operator recover từ chối — ambiguous/ownership). Giao Agent #5. Log:\n' + res.log);
      out('AGENT4_RESULT=ESCALATE');
      return 0;
    }

    // (6) regression tests sau MỌI repair
    core.act(inc, 'agent-4', 'regression-test', 'operator.js verify --scope fast');
    const reg = runRegression();
    core.act(inc, 'agent-4', 'regression-result', reg.log, { ok: reg.ok, test: 'operator.js verify --scope fast' });
    if (!reg.ok) {
      core.setFinal(inc, 'ESCALATE', 'Repair ' + d.kind + ' xong nhưng regression verify fast FAIL — giao Agent #5 (không sửa thêm). Log:\n' + reg.log);
      out('AGENT4_RESULT=ESCALATE');
      return 0;
    }

    // (7) SUCCESS — giữ nguyên lock + incident_id, giao Agent #5 verify độc lập
    core.setFinal(inc, 'SUCCESS', 'Đã repair ' + d.kind + ' + regression PASS. Maintenance lock GIỮ NGUYÊN cho Agent #5 verify độc lập (cùng incident_id, KHÔNG sửa đồng thời).');
    out('AGENT4_RESULT=SUCCESS');
    out('AGENT4: repair xong — giao Agent #5 verify (incident ' + inc.id + ').');
    return 0;
  } catch (e) {
    core.act(inc, 'agent-4', 'fatal', String(e && e.stack || e).slice(0, 500));
    core.setFinal(inc, 'ESCALATE', 'Agent #4 lỗi không lường trước: ' + (e && e.message) + ' — giao Agent #5. KHÔNG sửa thêm.');
    out('AGENT4_RESULT=ESCALATE');
    return 0; // giao #5 (workflow cần job continuation, KHÔNG crash)
  }
}

function cmdStatus() {
  const p = core.probes();
  const m = core.maintRaw();
  console.log(JSON.stringify({
    agent: 'agent-4 (repair)',
    maintenance_lock: m, maintenance_held: core.maintHeld(),
    txn_active: p.txn_active, writer_lock_held: p.writer_lock_held,
    coord_lock_held: p.coord_lock_held, pipeline_state_ok: p.pipeline_state_ok,
    recent_unrepaired: core.recentUnrepaired(ACFG),
    incidents: core.listIncidents().slice(-5).reverse()
  }, null, 2));
}

// ------------------------------ CLI -------------------------------------------
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); a[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true; if (a[k] === true) { /* flag */ } else i++; }
  }
  return a;
}
function main(argv) {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest);
  if (cmd === 'repair') return cmdRepair(a);
  if (cmd === 'status') return cmdStatus();
  console.error('Usage: agent-repair.js <repair --source ... | status>');
  return 1;
}
if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { diagnose, runRecover, repairStateCorrupt, repairCoordLockStale, parseArgs };
