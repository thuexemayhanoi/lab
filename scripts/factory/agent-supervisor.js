#!/usr/bin/env node
/**
 * agent-supervisor.js — AGENT #5: SUPERVISOR / SECOND-LINE RECOVERY
 * (docs/AGENTS-OPS.md).
 *
 * Trách nhiệm: verify ĐỘC LẬP kết quả Agent #4, HOẶC đúng MỘT lần sửa
 * second-line cuối cùng. KHÔNG BAO GIỜ viết bài, KHÔNG đổi content strategy.
 *
 * Bất biến:
 *   - Dùng CÙNG incident_id + CÙNG maintenance lock như #4 (takeover handoff).
 *   - #4 và #5 KHÔNG BAO GIỜ sửa đồng thời: refuse nếu lock còn do agent-4
 *     giữ mà incident CHƯA có final (tức #4 vẫn đang chạy), hoặc lock thuộc
 *     incident khác.
 *   - Chỉ khởi động sau khi #4 trả SUCCESS hoặc ESCALATE (final của incident).
 *   - Verify độc lập (KHÔNG tin kết quả #4 ghi vội): probes mới + operator
 *     verify fast + pipeline status.
 *   - Tối đa MỘT lần sửa second-line mỗi incident (đếm riêng #4 và #5).
 *   - Thành công => release maintenance lock => resume production bằng
 *     ĐÚNG MỘT entrypoint sẵn có: `pipeline.js cycle` (entrypoint sản xuất
 *     chuẩn — tự phân bổ và fan-out cho 3 writer; KHÔNG tự start writer).
 *   - Thất bại => GIỮ production pause (maintenance lock TTL pause), bảo toàn
 *     checkpoints + writer commits (không đụng gì destructive), viết incident
 *     report human-readable, STOP. KHÔNG có Agent #7 — hết đường tự sửa.
 *
 * CLI: node scripts/factory/agent-supervisor.js run --incident <id>
 *      node scripts/factory/agent-supervisor.js conclude --incident <id>
 *      node scripts/factory/agent-supervisor.js status
 */
'use strict';
const fs = require('fs'), path = require('path');
const { spawnSync } = require('child_process');
const core = require(path.join(__dirname, 'agents-core.js'));
const ROOT = core.ROOT;
const ACFG = core.cfg();

function run(cmdArr, env) {
  const r = spawnSync(process.execPath, cmdArr, { cwd: ROOT, encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024, env: Object.assign({}, process.env, env || {}) });
  return { rc: r.status, log: ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-8).join('\n') };
}
const opRun = (args) => run([path.join('scripts', 'factory', 'operator.js'), ...args]);
const pipelineCycle = (env) => run([path.join('scripts', 'factory', 'pipeline.js'), 'cycle'], env);
const pipelineStatus = () => run([path.join('scripts', 'factory', 'pipeline.js'), 'status']);

// verify battery — ĐỘC LẬP, luôn chạy lại từ đầu (không kế thừa kết quả #4)
function verifyBattery() {
  const p = core.probes();
  const problems = [];
  if (p.txn_active) problems.push('transaction ' + (p.txn && p.txn.id) + ' còn active (op=' + (p.txn && p.txn.operation) + ')');
  if (p.writer_lock_held) problems.push('writer-lock còn hiệu lực (holder=' + (p.writer_lock.raw && p.writer_lock.raw.holder) + ')');
  if (!p.pipeline_state_ok) problems.push('pipeline-state.json hỏng cú pháp: ' + p.pipeline_state_error);
  if (p.coord_lock_held) problems.push('coordinator lock còn hiệu lực — writer cycle có thể đang chạy');
  if (p.txn_error) problems.push('không đọc được transaction state: ' + p.txn_error);
  // repository/workflow/publisher/checkpoint truth: operator verify fast
  const reg = opRun(['verify', '--scope', 'fast']);
  const pstat = pipelineStatus();
  return { problems, verify_fast: reg, pipeline_status: pstat,
    healthy: problems.length === 0 && reg.rc === 0 && pstat.rc === 0 };
}

// tập hành động second-line — chỉ lớp an toàn đã hiểu (giống #4, whitelisted)
function attemptSecondLine(p, inc) {
  if (!p.pipeline_state_ok) {
    const r = require(path.join(__dirname, 'agent-repair.js')).repairStateCorrupt(inc && inc.id);
    return { kind: 'pipeline-state-corrupt', ...r };
  }
  if (p.txn_active && !p.writer_lock_held) {
    const r = require(path.join(__dirname, 'agent-repair.js')).runRecover();
    return { kind: 'txn-stuck', ...r };
  }
  if (!p.txn_active && p.writer_lock && p.writer_lock.raw && p.writer_lock.raw.locked && !p.writer_lock.held) {
    const r = require(path.join(__dirname, 'agent-repair.js')).runRecover();
    return { kind: 'writer-lock-stale', ...r };
  }
  if (p.coord_lock && p.coord_lock.locked && !p.coord_lock_held) {
    const r = require(path.join(__dirname, 'agent-repair.js')).repairCoordLockStale();
    return { kind: 'coord-lock-stale', ...r };
  }
  return null; // không còn lớp an toàn nào để thử — hết ngân sách tự sửa
}

// ------------------------------ pause & report --------------------------------
function keepPaused(inc, why) {
  // (a) maintenance lock giữ TTL pause (RUN-LOCAL: chết theo runner — KHÔNG
  //     phải khóa bền vững; serialize giữa run là workflow concurrency group)
  core.pauseMaintenance(inc.id, 'agent-5', ACFG.pause_ttl_minutes,
    'production PAUSED — incident ' + inc.id + ' không sửa được tự động, chờ human (docs/PROC-RECOVERY.md)');
  // (b) durable pause flag trong pipeline-state (COMMITTED truth — bền vững
  //     qua runner mới và qua hết TTL; #6 cũng thấy). MỖI incident CHỈ set
  //     pause của chính nó — KHÔNG bao giờ đè pause của incident khác.
  try {
    const stPath = core.STATE_FILE;
    const st = core.loadStateFileStrict() || {};
    if (!(st.pause && st.pause.incident_id && st.pause.incident_id !== inc.id)) {
      st.pause = { by: 'agent-5', incident_id: inc.id, at: new Date().toISOString(),
        reason: 'incident ' + inc.id + ' FAILED_PAUSED — production pause chờ human (reports/incidents/' + inc.id + '.md)' };
      st.stopped_reason = 'incident ' + inc.id + ' FAILED_PAUSED — Agent #4+#5 không sửa được tự động; production pause chờ human (xem reports/incidents/' + inc.id + '.md)';
      st.updated_at = new Date().toISOString();
      fs.mkdirSync(path.dirname(stPath), { recursive: true });
      fs.writeFileSync(stPath, JSON.stringify(st, null, 2));
    } // pause của incident khác còn giữ => KHÔNG đè (pause đó vẫn chặn production)
  } catch (e) { /* state hỏng cú pháp: cycle đã fail-closed ở loadStateStrict — production KHÔNG tự chạy */ }
  // (c) incident report human-readable (committed, auditable)
  const md = [];
  md.push('# Incident ' + inc.id + ' — KHÔNG sửa được tự động (FAILED_PAUSED)');
  md.push('');
  md.push('- **Trạng thái:** production ĐANG PAUSE chờ xử lý của người vận hành (durable pause trong pipeline-state.json — KHÔNG tự tiếp tục sau TTL; chỉ clear sau khi incident này được verify thành công hoặc human xử lý).');
  md.push('- **Nguồn:** ' + JSON.stringify(inc.source));
  md.push('- **Tổng kết:** ' + (inc.final ? inc.final.summary : ''));
  md.push('- **Audit trail:**');
  for (const a of inc.actions) md.push('  - `' + a.at + '` **' + a.actor + '** ' + a.action + (a.detail ? ' — ' + a.detail : '') + (a.ok === false ? ' [FAIL]' : a.ok === true ? ' [OK]' : ''));
  md.push('- **Hành động đề xuất:** kiểm tra ' + why + ' theo docs/PROC-RECOVERY.md. KHÔNG force-clear state; checkpoints + writer commits vẫn nguyên vẹn.');
  md.push('');
  fs.mkdirSync(core.INCIDENTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(core.INCIDENTS_DIR, inc.id + '.md'), md.join('\n'));
  core.setFinal(inc, 'FAILED_PAUSED', inc.final ? inc.final.summary : '', { reason_detail: why, paused_until_lock: 'maintenance TTL ' + ACFG.pause_ttl_minutes + ' phút' });
}

// Durable pause resolution: CHỈ clear pause SAU verify thành công VÀ CHỈ đúng
// incident sở hữu pause. Pause của incident khác => KHÔNG clear, KHÔNG resume
// (fail-closed — incident này khoẻ nhưng production vẫn bị pause bởi chủ sở
// hữu pause; chờ incident đó được xử lý xong).
function pauseResolvedForResume(inc) {
  let pause = null;
  try { pause = core.durablePause(); }
  catch (e) { return { ok: false, reason: 'pipeline-state.json hỏng cú pháp — KHÔNG resume mù: ' + e.message }; }
  if (!pause) return { ok: true };
  if (pause.incident_id !== inc.id)
    return { ok: false, reason: 'durable pause thuộc incident ' + pause.incident_id + ' (không phải ' + inc.id + ') — KHÔNG clear pause của incident khác' };
  const r = core.clearPause(inc.id);
  if (!r.cleared) return { ok: false, reason: r.reason };
  core.act(inc, 'agent-5', 'clear-durable-pause', 'Verify thành công — clear pause của đúng incident ' + inc.id + ' (pause do incident này đặt).');
  return { ok: true };
}

// ------------------------------ main flow ------------------------------------
function cmdRun(a) {
  const incId = a.incident;
  if (!incId) { console.error('AGENT5 REFUSED: thiếu --incident <id>'); return 1; }
  const inc = core.loadIncident(incId);
  if (!inc) { console.error('AGENT5 REFUSED: không tìm thấy incident ' + incId + ' (reports/incidents/) — không verify mù.'); return 1; }
  console.log('AGENT5: incident ' + incId + ' — final từ #4: ' + (inc.final ? inc.final.status : '(none)'));

  // (1) takeover maintenance lock — KHÔNG BAO GIỜ sửa đồng thời với #4
  const m = core.maintRaw();
  const held = core.maintHeld();
  if (held && m.incident_id !== incId) {
    console.error('AGENT5 REFUSED: maintenance lock thuộc incident khác (' + m.incident_id + ') — một incident duy nhất tại một thời điểm.');
    return 1;
  }
  if (held && m.holder === 'agent-4' && !(inc.final && (inc.final.status === 'SUCCESS' || inc.final.status === 'ESCALATE'))) {
    console.error('AGENT5 REFUSED: agent-4 vẫn đang giữ lock và incident chưa có kết luận (SUCCESS|ESCALATE) — KHÔNG sửa đồng thời.');
    return 1;
  }
  if (!core.takeoverMaintenance(incId, 'agent-5', ACFG.maintenance_ttl_minutes, 'agent-5 supervising incident ' + incId)) {
    console.error('AGENT5 REFUSED: không takeover được maintenance lock (lock còn hiệu lực do incident khác).');
    return 1;
  }
  core.act(inc, 'agent-5', 'takeover-maintenance-lock', 'Cùng incident_id + cùng maintenance lock (handoff #4 -> #5, KHÔNG đồng thời).');

  const mode = inc.final && inc.final.status === 'SUCCESS' ? 'verify' : 'redesign';
  try {
    // (2) verify ĐỘC LẬP (mode verify sau SUCCESS) — và cũng là re-diagnose
    //     đầu tiên của mode redesign (spec: #5 re-diagnose độc lập).
    const v = verifyBattery();
    core.act(inc, 'agent-5', 'independent-verify', v.problems.length ? 'problems: ' + v.problems.join('; ') : 'repo/workflow/writer-staging/publisher/queue/checkpoint/CI: HEALTHY',
      { ok: v.healthy, verify_fast_rc: v.verify_fast.rc, pipeline_status_rc: v.pipeline_status.rc });

    if (v.healthy) {
      // (3a) khoẻ mạnh => clear pause (đúng incident) + release lock + resume
      //      bằng MỘT entrypoint sẵn có
      const pr = pauseResolvedForResume(inc);
      if (!pr.ok) {
        core.act(inc, 'agent-5', 'resume-blocked-pause', 'KHÔNG resume: ' + pr.reason, { ok: false });
        keepPaused(inc, 'verify PASS nhưng KHÔNG resume được: ' + pr.reason);
        console.error('AGENT5_RESULT=FAILED_PAUSED');
        return 0;
      }
      core.releaseMaintenance(incId);
      core.act(inc, 'agent-5', 'release-maintenance-lock', 'Verify PASS — production được phép chạy lại.');
      const cyc = pipelineCycle(pipelineEnv());
      core.act(inc, 'agent-5', 'resume-production', 'Entrypoint: pipeline.js cycle (một entrypoint duy nhất — tự phân bổ + fan-out 3 writer).',
        { ok: cyc.rc === 0, rc: cyc.rc, log: cyc.log });
      core.setFinal(inc, 'VERIFIED_RESUMED', 'Verify độc lập PASS (txn/locks/state/verify-fast/pipeline-status). Đã release lock và resume production qua đúng một entrypoint pipeline.js cycle.');
      console.log('AGENT5_RESULT=VERIFIED_RESUMED');
      return cyc.rc === 0 ? 0 : 0; // resume đã chạy; lỗi cycle là việc của coordinator/incident kế tiếp
    }

    // (3b) KHÔNG khoẻ => đúng MỘT lần sửa second-line (tổng ngân sách: 1 (#4) + 1 (#5))
    const attemptedBefore = inc.actions.some(x => x.actor === 'agent-5' && /^repair(:|-)|second-line/.test(x.action));
    if (attemptedBefore) {
      keepPaused(inc, 'đã dùng hết ngân sách sửa của #5 (đúng 1 lần/incident)');
      console.error('AGENT5_RESULT=FAILED_PAUSED');
      return 0;
    }
    const p = core.probes();
    const att = attemptSecondLine(p, inc);
    if (!att) {
      keepPaused(inc, 'không còn lớp sửa an toàn nào (ownership/content-sensitive/ambiguous — fail-closed)');
      console.error('AGENT5_RESULT=FAILED_PAUSED');
      return 0;
    }
    core.act(inc, 'agent-5', 'second-line-repair:' + att.kind, 'MỘT lần sửa cuối (ngân sách #5).', { ok: att.ok });
    if (!att.ok) {
      keepPaused(inc, 'second-line repair ' + att.kind + ' bị từ chối bởi operator (ambiguous)');
      console.error('AGENT5_RESULT=FAILED_PAUSED');
      return 0;
    }
    const reg = opRun(['verify', '--scope', 'fast']);
    core.act(inc, 'agent-5', 'regression-test', 'operator.js verify --scope fast sau second-line repair', { ok: reg.rc === 0 });
    if (reg.rc !== 0) {
      keepPaused(inc, 'second-line repair ' + att.kind + ' xong nhưng regression FAIL');
      console.error('AGENT5_RESULT=FAILED_PAUSED');
      return 0;
    }
    // sửa xong khoẻ => clear pause (đúng incident) + release + resume
    const pr2 = pauseResolvedForResume(inc);
    if (!pr2.ok) {
      core.act(inc, 'agent-5', 'resume-blocked-pause', 'KHÔNG resume sau second-line repair: ' + pr2.reason, { ok: false });
      keepPaused(inc, 'second-line repair PASS nhưng KHÔNG resume được: ' + pr2.reason);
      console.error('AGENT5_RESULT=FAILED_PAUSED');
      return 0;
    }
    core.releaseMaintenance(incId);
    core.act(inc, 'agent-5', 'release-maintenance-lock', 'Second-line repair PASS + regression PASS — resume production.');
    const cyc = pipelineCycle(pipelineEnv());
    core.act(inc, 'agent-5', 'resume-production', 'Entrypoint: pipeline.js cycle (một entrypoint duy nhất).', { ok: cyc.rc === 0, rc: cyc.rc });
    core.setFinal(inc, 'VERIFIED_RESUMED', 'Second-line repair ' + att.kind + ' thành công + regression PASS. Đã release lock và resume production.');
    console.log('AGENT5_RESULT=VERIFIED_RESUMED');
    return 0;
  } catch (e) {
    core.act(inc, 'agent-5', 'fatal', String(e && e.stack || e).slice(0, 500));
    keepPaused(inc, 'lỗi không lường trước của Agent #5 (fail-closed — pause an toàn hơn sửa mù)');
    console.error('AGENT5_RESULT=FAILED_PAUSED');
    return 0;
  }
}

// writer runtime env passthrough — đúng như job pipeline truyền (KHÔNG hardcode)
function pipelineEnv() {
  const env = {};
  for (const k of ['WRITER_RUNTIME', 'WRITER_ENDPOINT', 'WRITER_API_KEY', 'WRITER_TIMEOUT_MS', 'PIPELINE_ALLOW_MOCK'])
    if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

function cmdConclude(a) {
  const inc = core.loadIncident(a.incident);
  if (!inc) { console.error('AGENT5 CONCLUDE: không tìm thấy incident ' + a.incident); return 1; }
  const s = inc.final && inc.final.status;
  console.log('AGENT5_CONCLUDE: incident ' + inc.id + ' final=' + s);
  if (s === 'VERIFIED_RESUMED') { console.log('AGENT5: production đã được verify + resume — SUCCESS.'); return 0; }
  console.error('AGENT5: KHÔNG sửa được tự động — production PAUSED chờ human. Báo cáo: reports/incidents/' + inc.id + '.md');
  return 1; // job đỏ: tín hiệu dừng rõ ràng, KHÔNG escalate tiếp
}

function cmdStatus() {
  console.log(JSON.stringify({ agent: 'agent-5 (supervisor)', maintenance: core.maintRaw(),
    maintenance_held: core.maintHeld(), incidents: core.listIncidents().slice(-5).reverse() }, null, 2));
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
  if (cmd === 'run') return cmdRun(a);
  if (cmd === 'conclude') return cmdConclude(a);
  if (cmd === 'status') return cmdStatus();
  console.error('Usage: agent-supervisor.js <run --incident ID | conclude --incident ID | status>');
  return 1;
}
if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { verifyBattery, attemptSecondLine, keepPaused, pipelineEnv };
