#!/usr/bin/env node
/**
 * agents-core.js — nền chung cho 3 agent vận hành (docs/AGENTS-OPS.md):
 *   #4 agent-repair.js   (first-line repair)
 *   #5 agent-supervisor.js (verify độc lập / 1 lần sửa second-line)
 *   #6 agent-watchdog.js  (production watchdog — chỉ đánh thức factory)
 *
 * NGUYÊN TẮC:
 *   - KHÔNG bao giờ viết/sửa bài viết, queue, matrix, taxonomy, content
 *     strategy. Agents chỉ đụng state vận hành (locks, incident reports,
 *     pipeline-state lỗi cú pháp) qua tập hành động an toàn whitelisted.
 *   - MAINTENANCE LOCK (pipeline/maintenance.json — gitignored, run-local):
 *     chỉ MỘT incident được mutate infrastructure tại một thời điểm.
 *     #4 và #5 KHÔNG BAO GIỜ sửa đồng thời (lock + handoff cùng incident_id).
 *   - INCIDENT STORE (reports/incidents/<id>.json — committed, auditable):
 *     mọi hành động có timestamp + actor + kết quả regression tests.
 *   - Fail-closed: không rõ ownership / ambiguous / content-sensitive =>
 *     ESCALATE hoặc STOP, KHÔNG bao giờ force-clear state.
 *   - Không busy-poll: mọi agent chạy một pass duy nhất rồi thoát.
 */
'use strict';
const fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PIPE_DIR = path.join(ROOT, 'pipeline');                     // gitignored — RUN-LOCAL: không đi theo runner mới
const MAINT_FILE = path.join(PIPE_DIR, 'maintenance.json');        // gitignored — RUN-LOCAL; khóa bền vững duy nhất là state.pause (committed)
const COORD_LOCK_FILE = path.join(PIPE_DIR, 'lock.json');          // gitignored (coordinator, run-local)
const STATE_FILE = path.join(ROOT, 'data', 'state', 'pipeline-state.json'); // committed truth
const INCIDENTS_DIR = path.join(ROOT, 'reports', 'incidents');     // committed audit

const DEFAULTS = {
  maintenance_ttl_minutes: 60,     // agent #4/#5 giữ lock khi đang chạy
  pause_ttl_minutes: 120,          // giữ production pause sau khi #5 fail (chờ human)
  watchdog_stall_minutes: 120,     // #6: 2 giờ không có progress hợp lệ => đánh thức
  max_recent_unrepaired: 2,        // circuit breaker: >= 2 incident fail gần đây => STOP
  unrepaired_window_minutes: 120
};

function cfg() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'agents.json'), 'utf8'));
    return Object.assign({}, DEFAULTS, raw);
  } catch (e) { return Object.assign({}, DEFAULTS); } // thiếu config => mặc định an toàn
}

// ------------------------------ maintenance lock -----------------------------
// pipeline/maintenance.json: {active, holder: 'agent-4'|'agent-5',
//   incident_id, reason, acquired_at, expires_at}
function maintRaw() {
  try { return JSON.parse(fs.readFileSync(MAINT_FILE, 'utf8')); } catch (e) { return null; }
}
function maintHeld() {
  const m = maintRaw();
  return !!(m && m.active && m.expires_at && new Date(m.expires_at) > new Date());
}
function writeMaint(m) {
  fs.mkdirSync(PIPE_DIR, { recursive: true });
  fs.writeFileSync(MAINT_FILE, JSON.stringify(m, null, 2));
}
// Acquire: REFUSE nếu có lock còn hiệu lực (kể cả incident khác) — một
// incident duy nhất được mutate infrastructure tại một thời điểm.
function acquireMaintenance(incidentId, holder, ttlMinutes, reason) {
  if (maintHeld()) return false;
  writeMaint({ active: true, holder, incident_id: incidentId, reason,
    acquired_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttlMinutes * 60000).toISOString() });
  return true;
}
// Takeover #4 -> #5: CHỈ cho phép khi lock trống (acquire mới) hoặc cùng
// incident_id (handoff theo spec — "same incident_id and maintenance_lock").
// Lock của incident khác => REFUSED (không bao giờ giành lock người khác).
function takeoverMaintenance(incidentId, holder, ttlMinutes, reason) {
  const m = maintRaw();
  if (!m || !m.active || !(new Date(m.expires_at) > new Date())) return acquireMaintenance(incidentId, holder, ttlMinutes, reason);
  if (m.incident_id !== incidentId) return false;
  writeMaint({ active: true, holder, incident_id: incidentId, reason,
    acquired_at: m.acquired_at, took_over_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttlMinutes * 60000).toISOString() });
  return true;
}
// Release: CHỈ giải phóng lock của đúng incident mình (không đụng lock người khác).
function releaseMaintenance(incidentId) {
  const m = maintRaw();
  if (m && m.incident_id !== incidentId) return false;
  writeMaint({ active: false, holder: null, incident_id: null, reason: null,
    acquired_at: null, expires_at: null, released_at: new Date().toISOString() });
  return true;
}
// Pause-keep: đường fail của #5 — GIỮ production pause (TTL pause_ttl_minutes).
// Lock này RUN-LOCAL (chết theo runner): tính bền vững nằm ở state.pause
// (committed) — setDurablePause/keepPaused đặt kèm; KHÔNG self-heal sau TTL.
function pauseMaintenance(incidentId, holder, ttlMinutes, reason) {
  const m = maintRaw();
  if (m && m.active && m.incident_id !== incidentId) return false;
  writeMaint({ active: true, holder, incident_id: incidentId, reason,
    acquired_at: (m && m.acquired_at) || new Date().toISOString(),
    paused_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttlMinutes * 60000).toISOString() });
  return true;
}

// ------------------------------ incident store -------------------------------
function newIncidentId() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  const rnd = Math.random().toString(36).slice(2, 6);
  return 'INC-' + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate())
    + '-' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + '-' + rnd;
}
function incidentPath(id) { return path.join(INCIDENTS_DIR, id + '.json'); }
function listIncidents() {
  try { return fs.readdirSync(INCIDENTS_DIR).filter(f => f.endsWith('.json')).sort(); }
  catch (e) { return []; }
}
function loadIncident(id) {
  try { return JSON.parse(fs.readFileSync(incidentPath(id), 'utf8')); } catch (e) { return null; }
}
function saveIncident(inc) {
  fs.mkdirSync(INCIDENTS_DIR, { recursive: true });
  inc.updated_at = new Date().toISOString();
  fs.writeFileSync(incidentPath(inc.id), JSON.stringify(inc, null, 2));
}
// Mọi hành động đều được audit: timestamp + actor + action + chi tiết.
function act(inc, actor, action, detail, extra) {
  inc.actions.push(Object.assign({ at: new Date().toISOString(), actor, action, detail: detail || '' }, extra || {}));
  saveIncident(inc);
}
function setFinal(inc, status, summary, extra) {
  inc.final = Object.assign({ status, summary, at: new Date().toISOString() }, extra || {});
  saveIncident(inc);
}
// Circuit breaker: đếm incident KHÔNG sửa được (production pause chờ human)
// trong cửa sổ gần nhất — chống vòng lặp repair tự kích theo workflow_run.
const UNREPAIRED = ['FAILED_PAUSED'];
function recentUnrepaired(cfgA) {
  const c = cfgA || cfg();
  const cutoff = Date.now() - c.unrepaired_window_minutes * 60000;
  return listIncidents().map(f => loadIncident(f.replace(/\.json$/, '')))
    .filter(Boolean)
    .filter(i => i.final && UNREPAIRED.includes(i.final.status) && new Date(i.final.at).getTime() > cutoff)
    .length;
}
// Exactly-once incident: một failed run => một incident duy nhất.
function findBySourceRun(runId) {
  if (!runId) return null;
  for (const f of listIncidents()) {
    const i = loadIncident(f.replace(/\.json$/, ''));
    if (i && i.source && String(i.source.run_id) === String(runId)) return i;
  }
  return null;
}

// --------------- durable pause (committed truth, sống qua runner) ------------
// Load state strict: THIẾU file = hợp lệ (chưa có cycle — trả null để caller dựng
// default); file CÓ SẴN mà hỏng cú pháp => THROW (fail-closed — không âm thầm
// dùng state rỗng để chạy production).
function loadStateFileStrict() {
  let raw;
  try { raw = fs.readFileSync(STATE_FILE, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return null; // thiếu file = bình thường
    throw e;                                  // lỗi I/O khác: fail-closed
  }
  try { return JSON.parse(raw); }
  catch (e) { throw new Error('pipeline-state.json hỏng cú pháp (fail-closed): ' + e.message); }
}
// Pause durable hiện tại (state.pause) — null nếu không có. File hỏng => ném.
function durablePause() {
  const st = loadStateFileStrict();
  return (st && st.pause && st.pause.incident_id) ? st.pause : null;
}
// Set pause durable: MỘT incident CHỈ set pause của chính nó; KHÔNG bao giờ
// đè pause của incident khác (keepPaused của incident mới không clobber pause
// cũ). Trả false khi pause hiện tại thuộc incident khác.
function setDurablePause(incidentId, by, reason) {
  const st = loadStateFileStrict() || {};
  if (st.pause && st.pause.incident_id !== incidentId) return false;
  st.pause = { by, incident_id: incidentId, at: new Date().toISOString(), reason: reason || null };
  st.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  return true;
}
// Clear pause durable: CHỈ SAU verify thành công VÀ CHỈ đúng incident sở hữu
// pause. Incident khác KHÔNG clear được pause của người khác (fail-closed).
function clearPause(incidentId) {
  const st = loadStateFileStrict();
  if (!st || !st.pause) return { cleared: false, reason: 'no-pause' };
  if (st.pause.incident_id !== incidentId)
    return { cleared: false, reason: 'pause thuộc incident ' + st.pause.incident_id + ' — KHÔNG đụng pause của incident khác' };
  delete st.pause;
  st.updated_at = new Date().toISOString();
  st.stopped_reason = 'pause ' + incidentId + ' đã clear sau verify thành công (đúng incident sở hữu pause)';
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  return { cleared: true };
}
// Incident chưa hoàn tất (committed, chưa có final, còn mới): dấu hiệu #4 bị
// gián đoạn SAU KHI lưu incident (runner chết giữa chừng). Run mới (runner
// mới, không có maintenance.json run-local) PHẢI nhận biết qua incident store
// committed này và KHÔNG tiếp tục production cho đến khi incident có kết luận.
function openIncidents(opts) {
  const c = cfg();
  const windowMs = ((opts && Number(opts.window_minutes)) || c.unrepaired_window_minutes) * 60000;
  const cutoff = Date.now() - windowMs;
  return listIncidents().map(f => loadIncident(f.replace(/\.json$/, '')))
    .filter(Boolean)
    .filter(i => !i.final && new Date(i.created_at || 0).getTime() > cutoff);
}

// ------------------------------ probes (read-only) ---------------------------
function probes() {
  const factory = require(path.join(__dirname, 'factory.js'));
  let tx = null, txErr = null;
  try { tx = factory.readTx(); } catch (e) { txErr = e.message; }
  let wl = { raw: null, held: false }, wlErr = null;
  try { wl = factory.lockState(); } catch (e) { wlErr = e.message; }
  let coord = null;
  try { coord = JSON.parse(fs.readFileSync(COORD_LOCK_FILE, 'utf8')); } catch (e) {}
  const coordHeld = !!(coord && coord.locked && coord.expires_at && new Date(coord.expires_at) > new Date());
  let st = null, stErr = null, stOk = true;
  try { st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) {
    stErr = e.message;
    // THIẾU file = bình thường (chưa có cycle nào — pipeline.js loadState coi
    // như default state). CHỈ file có sẵn mà KHÔNG parse được mới là corrupt.
    stOk = e.code === 'ENOENT';
    if (e.code === 'ENOENT') stErr = null;
  }
  return {
    txn: tx, txn_error: txErr, txn_active: !!(tx && tx.active),
    writer_lock: wl, writer_lock_error: wlErr,
    writer_lock_held: !!(wl && wl.held),
    coord_lock: coord, coord_lock_held: coordHeld,
    pipeline_state: st, pipeline_state_ok: stOk, pipeline_state_error: stErr,
    intentional_pause: !!(st && st.pause),
    maintenance: maintRaw(), maintenance_held: maintHeld()
  };
}

// Progress hợp lệ cho #6: KHÔNG phải log/heartbeat/poll — chỉ (a) writer
// staging thật (commit đụng _drafts/), (b) publish/integration thật (commit
// đụng matrix shards / archive), (c) cycle hoàn tất có bài published|blocked.
function validProgressAt(stateOnly) {
  let best = null;
  const consider = iso => { if (!iso) return; const t = new Date(iso).getTime();
    if (!isNaN(t) && (best === null || t > best)) best = t; };
  const st = (stateOnly && stateOnly.probe) ? stateOnly.probe.pipeline_state : (() => {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return null; } })();
  const last = st && st.last_cycle_summary;
  if (last && last.finished_at && Array.isArray(last.published) && Array.isArray(last.blocked)
    && (last.published.length > 0 || last.blocked.length > 0)) consider(last.finished_at);
  if (!stateOnly || !stateOnly.skipGit) {
    try {
      const { execFileSync } = require('child_process');
      // commits đụng writer staging (_drafts/) hoặc production truth (shards)
      const out = execFileSync('git', ['-C', ROOT, 'log', '-1', '--format=%cI',
        '--', '_drafts', 'data/content-matrix.csv.part00', 'data/content-matrix.csv.part01',
        'data/content-matrix.csv.part02', 'data/content-matrix.csv.part03'], { encoding: 'utf8' }).trim();
      if (out) consider(out);
    } catch (e) { /* không có git / repo rỗng: bỏ qua nhánh git */ }
  }
  return best; // epoch-ms hoặc null (không tìm thấy progress hợp lệ nào)
}

module.exports = { ROOT, PIPE_DIR, MAINT_FILE, COORD_LOCK_FILE, STATE_FILE, INCIDENTS_DIR,
  cfg, maintRaw, maintHeld, acquireMaintenance, takeoverMaintenance, releaseMaintenance,
  pauseMaintenance, newIncidentId, incidentPath, listIncidents, loadIncident, saveIncident,
  act, setFinal, recentUnrepaired, findBySourceRun, probes, validProgressAt, UNREPAIRED,
  loadStateFileStrict, durablePause, setDurablePause, clearPause, openIncidents };
