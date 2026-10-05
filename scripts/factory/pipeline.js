#!/usr/bin/env node
/**
 * pipeline.js — AUTONOMOUS PIPELINE COORDINATOR cho /lab (docs/PIPELINE.md).
 *
 * Mô hình (3 nguyên tắc bất biến):
 *   1. WRITER (external runtime — xem writer-adapter.js) chỉ research/write/
 *      revise trong workspace riêng (pipeline/writers/w<i>/ — gitignored).
 *      Writer KHÔNG bao giờ chạm state global, KHÔNG merge/push/publish.
 *   2. COORDINATOR (file này) là NGƯỜI DUY NHẤT quản lý queue, cấp bài,
 *      state, ingest artifact, merge và publish (qua whitelist operator CLI).
 *   3. Lỗi nhỏ: retry có giới hạn; checkpoint sau mỗi phase; resume từ
 *      repository truth (matrix + artifact thật), không xử lý trùng bài.
 *      Chỉ dừng khi: hết topic hợp lệ, writer runtime chưa cấu hình (idle),
 *      hoặc lỗi lớn không recover được (fail-closed).
 *
 * Luồng 1 cycle: preflight (txn/lock/stale-drafts) → refill queue (window
 * ~300 PLANNED đầu theo matrix order) → resolve runtime (off ⇒ IDLE-STOP
 * TRƯỚC KHI claim — không bao giờ publish khi thiếu writer) → đảm bảo batch
 * (resume / adopt mồ côi / claim mới ≤18 bài) → chia đều 3 writer →
 * research + write song song (theo writer) → ingest + wrap → QA (engine,
 * ngưỡng 75/70 KHÔNG đổi) → vòng revise theo feedback QA (≤ max_repair) →
 * publish TOÀN BỘ batch PASS trong MỘT transaction/cycle (--cycle-batch,
 * cap PUBLISH_BATCH_MAX của engine — audit #3: KHÔNG còn chia chunk) →
 * PUBLISHED (pending deployment) → run kế xác nhận Pages deploy đúng SHA
 * mới finalize (audit #4). Commit/push 1 lần/cycle do workflow đảm nhiệm.
 *
 * Đúng-một-lần (exactly-once): publish gate của engine chỉ nhận PASS rows
 * với QA evidence hash-bound; PUBLISHED rows không bao giờ được claim/publish
 * lại (prepare-next refuse, publish gate refuse). Resume re-validate batch
 * với matrix truth: id đã PUBLISHED ⇒ bỏ, id hở ⇒ tự xử tiếp.
 *
 * Chống 2 coordinator: pipeline/lock.json TTL (mặc định 30 phút) + GitHub
 * Actions concurrency group 'lab-factory-production' (workflow-level).
 *
 * CLI: node scripts/factory/pipeline.js <status|refill|cycle|selftest>
 */
'use strict';
const fs = require('fs'), path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA, 'state', 'pipeline-state.json');
const PIPE_DIR = path.join(ROOT, 'pipeline');          // gitignored (workspaces + lock)
const LOCK_FILE = path.join(PIPE_DIR, 'lock.json');
const factory = require(path.join(__dirname, 'factory.js'));
const adapter = require(path.join(__dirname, 'writer-adapter.js'));
const agentsCore = require(path.join(__dirname, 'agents-core.js')); // chỉ đọc maintenance lock (side-effect free)

const PCFG = (() => {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'pipeline.json'), 'utf8'));
  const need = ['queue_refill_target', 'queue_refill_min', 'cycle_batch_min', 'cycle_batch_max',
    'writers', 'writer_retries', 'lock_ttl_minutes'];
  const missing = need.filter(k => !(k in c));
  if (missing.length) { console.error('PIPELINE REFUSED: config/pipeline.json thiếu trường: ' + missing.join(',')); process.exit(1); }
  return c;
})();
const ID_RE = /^A\d{5}$/;

// ---------------- matrix loader (single-slot, mtime-cache) -----------------
// Pipeline gọi loadMatrix nhiều lần mỗi cycle (preflight/refill/claim/QA/
// publish/finalize); mỗi parse 10k dòng tốn ~86MB heap. Cache 1 slot theo
// mtime của shards (+ assembled csv nếu có) — parse lại CHỈ khi truth đổi
// (operator con vừa rewrite shards). Giới hạn bộ nhớ live ~1 parse, không
// tích luỹ giữa các phase.
const _rowsSlot = { mtime: null, rows: null };
function loadRows() {
  let mtime = '';
  try {
    for (const f of fs.readdirSync(DATA).filter(x => /^content-matrix\.csv\.part/.test(x)).sort())
      mtime += f + ':' + fs.statSync(path.join(DATA, f)).mtimeMs + ';';
  } catch (e) { mtime = 'err:' + e.message; }
  try { mtime += 'csv:' + fs.statSync(path.join(DATA, 'content-matrix.csv')).mtimeMs; } catch (e) { mtime += 'csv:none'; }
  if (_rowsSlot.rows && _rowsSlot.mtime === mtime) return _rowsSlot.rows;
  const rows = factory.loadMatrix();
  _rowsSlot.mtime = mtime; _rowsSlot.rows = rows;
  return rows;
}

// ------------------------------ state -------------------------------------
function defaultState() {
  return { version: 1, updated_at: null, cycle: 0, pending: [], planned_total: null,
    active: null, last_cycle_summary: null, last_stop: null, stopped_reason: null };
}
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return Object.assign(defaultState(), s);
  } catch (e) { return defaultState(); }
}
// Load STRICT: THIẾU file = default state (hợp lệ — chưa có cycle nào); file có
// sẵn mà hỏng cú pháp => THROW. KHÔNG bao giờ âm thầm dùng state rỗng để chạy
// production; state.pause là khóa bền vững duy nhất QUA RUNNER (committed truth).
function loadStateStrict() {
  let raw;
  try { raw = fs.readFileSync(STATE_FILE, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return defaultState(); throw e; }
  let s;
  try { s = JSON.parse(raw); }
  catch (e) { throw new Error('pipeline-state.json hỏng cú pháp: ' + e.message); }
  return Object.assign(defaultState(), s);
}
function saveState(s) {
  s.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// --------------------------- coordinator lock ------------------------------
function lockRaw() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch (e) { return null; }
}
function lockHeld() {
  const l = lockRaw();
  return !!(l && l.locked && l.expires_at && new Date(l.expires_at) > new Date());
}
function acquireLock() {
  if (lockHeld()) return false;
  fs.mkdirSync(PIPE_DIR, { recursive: true });
  const holder = 'pipeline-' + process.pid + '-' + new Date().toISOString();
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ locked: true, holder,
    acquired_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + PCFG.lock_ttl_minutes * 60000).toISOString() }, null, 2));
  return true;
}
function releaseLock() {
  fs.mkdirSync(PIPE_DIR, { recursive: true });
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ locked: false, holder: null, acquired_at: null, expires_at: null }, null, 2));
}

// ------------------------------ helpers -----------------------------------
function crashPoint(name) { // test-only fault injection (never set in production)
  if (process.env.PIPELINE_CRASH_AT === name) {
    console.error('PIPELINE CRASH INJECTION tại "' + name + '" — thoát đột ngột (mô phỏng runner chết giữa cycle).');
    process.exit(75);
  }
}
function run(cmdArr) {
  const r = spawnSync(cmdArr[0], cmdArr.slice(1), { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status == null ? 1 : r.status;
}
// operator op với retry + recover có giới hạn (nguyên tắc 3: lỗi nhỏ tự retry)
function opSafe(args, tries) {
  tries = tries == null ? 2 : tries;
  let rc = 1;
  for (let t = 0; t < tries; t++) {
    rc = run([process.execPath, path.join('scripts', 'factory', 'operator.js'), ...args]);
    if (rc === 0) return 0;
    console.error('pipeline: op ' + args.join(' ') + ' FAIL (rc=' + rc + ', lần ' + (t + 1) + '/' + tries + ') — recover và retry.');
    run([process.execPath, path.join('scripts', 'factory', 'operator.js'), 'recover']);
  }
  return rc;
}
const draftPath = id => path.join(ROOT, '_drafts', id + '.html');
const bodyPath = id => path.join(ROOT, '_drafts', id + '.body.html');
const packetPath = id => path.join(DATA, 'research', id + '.json');
const qaPath = id => path.join(DATA, 'qa', id + '.json');
function chunk(a, n) { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }
function grantsOf(batch, writers) { // map id -> writer (chia đều, round-robin)
  const g = {};
  batch.forEach((id, i) => g[id] = 'w' + (1 + (i % writers)));
  return g;
}
function workspaceOf(w) { return path.join(PIPE_DIR, 'writers', w); }

// ------------------------- stale-draft hygiene -----------------------------
// Draft của row PUBLISHED: byte-identical với archive ⇒ auto-clean (xóa bản
// lint); diverged ⇒ REFUSE (fail-closed — không bao giờ đè bài đã publish).
function staleDraftSweep(rows) {
  const byId = {}; rows.forEach(r => byId[r.article_id] = r);
  const removed = [], refused = [];
  const draftDir = path.join(ROOT, '_drafts');
  for (const f of fs.existsSync(draftDir) ? fs.readdirSync(draftDir) : []) {
    const m = /^(A\d{5})(\.body)?\.html$/.exec(f);
    if (!m) continue;
    const id = m[1], r = byId[id];
    if (!r || r.status !== 'PUBLISHED') continue;
    const archive = path.join(DATA, 'published', id + '.html');
    const dp = path.join(draftDir, f);
    let identical = false;
    if (fs.existsSync(archive)) identical = fs.readFileSync(dp, 'utf8') === fs.readFileSync(archive, 'utf8');
    if (identical) { if (!removed.includes(id)) removed.push(id); }
    else if (!refused.includes(id)) refused.push(id);
  }
  for (const id of removed) {
    for (const p of [draftPath(id), bodyPath(id)]) if (fs.existsSync(p)) fs.rmSync(p);
  }
  return { removed: [...new Set(removed)].sort(), refused: [...new Set(refused)].sort() };
}

// ------------------------------ refill ------------------------------------
function plannedIds(rows) { return rows.filter(r => r.status === 'PLANNED').map(r => r.article_id); }
function refill(state, rows) {
  const planned = plannedIds(rows);
  const plannedPos = new Map(planned.map((id, i) => [id, i]));
  state.planned_total = planned.length;
  // STALE HYGIENE: queue là write-ahead window, KHÔNG phải snapshot vĩnh viễn.
  // Row đã rời PLANNED (PUBLISHED/BLOCKED/đang xử lý qua vòng writer push-driven
  // hay cycle trước) PHẢI bị dọn khỏi pending — nếu không queue stale mãi mãi
  // (lỗi đã xảy ra trên main: pending còn A00129..A00174 dù các row này đã
  // PUBLISHED). Đồng thời: bỏ trùng, sắp lại theo matrix order.
  const kept = [];
  const seen = new Set();
  for (const id of state.pending) {
    if (plannedPos.has(id) && !seen.has(id)) { seen.add(id); kept.push(id); }
  }
  if (kept.length) kept.sort((a, b) => plannedPos.get(a) - plannedPos.get(b));
  // top-up window: sau khi dọn stale, nạp tiếp PLANNED đầu theo matrix order
  // cho đủ queue_refill_target (giữ hành vi cũ khi queue rỗng/thiếu).
  if (kept.length < PCFG.queue_refill_target) {
    for (const id of planned) {
      if (seen.has(id)) continue;
      seen.add(id); kept.push(id);
      if (kept.length >= PCFG.queue_refill_target) break;
    }
  }
  const changed = kept.length !== state.pending.length ||
    kept.some((id, i) => state.pending[i] !== id);
  state.pending = kept;
  return changed;
}

// --------------------------- writer phase ---------------------------------
// Chạy song song THEO WRITER: mỗi writer xử lý tuần tự các bài được cấp,
// các writer chạy đồng thời với nhau. Writer chỉ ghi vào workspace riêng;
// coordinator ingest artifact vào cây repo (nguyên tắc 1 + 2).
async function writerTasks(runtime, tasks) {
  const byWriter = {};
  tasks.forEach(t => { (byWriter[t.writer] = byWriter[t.writer] || []).push(t); });
  const results = {}; // id -> {ok, error}
  await Promise.all(Object.entries(byWriter).map(async ([w, list]) => {
    const outDir = workspaceOf(w);
    for (const t of list) {
      let ok = false, error = null;
      for (let attempt = 1; attempt <= PCFG.writer_retries && !ok; attempt++) {
        try {
          const res = await adapter.runTask({ task: t.task, row: t.row, packet: t.packet,
            feedback: t.feedback, outDir, runtime });
          const dest = t.task === 'research' ? packetPath(t.row.article_id) : bodyPath(t.row.article_id);
          fs.mkdirSync(path.dirname(dest), { recursive: true }); // ingest target dir có thể chưa tồn tại (checkout sạch)
          fs.copyFileSync(res.path, dest);
          ok = true;
        } catch (e) { error = e; console.error('pipeline: writer ' + w + ' ' + t.task + ' ' + t.row.article_id + ' FAIL (lần ' + attempt + '/' + PCFG.writer_retries + '): ' + e.message); }
      }
      results[t.row.article_id] = ok ? { ok: true } : { ok: false, error: error ? error.message : 'unknown' };
    }
  }));
  return results;
}
function qaFeedback(id) {
  try { return JSON.parse(fs.readFileSync(qaPath(id), 'utf8')); } catch (e) { return null; }
}
// Đưa row REVIEW/REPAIR (không terminal, chưa PASS) về BLOCKED — đúng lifecycle
// "QA → REPAIR → QA (max 3) → BLOCKED": hết lượt sửa ⇒ BLOCKED, chunk kết thúc.
function blockIds(ids, reason) {
  if (!ids.length) return;
  const rows = loadRows();
  for (const id of ids) {
    const r = rows.find(x => x.article_id === id);
    if (r && !factory.TERMINAL.has(r.status)) { r.status = 'BLOCKED'; console.log('pipeline: ' + id + ' BLOCKED (' + reason + ')'); }
  }
  factory.saveMatrix(rows);
  factory.syncCheckpoint(rows);
}

// ---------------- AUDIT #4: deployment truth (push OK ≠ deploy OK) ----------
// Pure decision: cycle chỉ hoàn tất khi Pages build cuối THÀNH CÔNG và cây
// nó build (buildCommit) CHỨA publication commit (pubSha). Thiếu truth /
// sai SHA / build lỗi => KHÔNG confirmed (giữ trạng thái recoverable).
function deploymentDecision(pubSha, buildCommit, buildStatus, containsSha) {
  if (!pubSha) return { confirmed: false, reason: 'NO_PUBLICATION_SHA (chưa xác định được publication commit của cycle)' };
  if (!buildCommit || !buildStatus) return { confirmed: false, reason: 'NO_PAGES_TRUTH (chưa có PAGES_BUILD_COMMIT/PAGES_BUILD_STATUS — Pages chưa build hoặc API fail)' };
  if (buildStatus !== 'success') return { confirmed: false, reason: 'PAGES_BUILD_STATUS=' + buildStatus };
  let contains = containsSha;
  if (contains == null) contains = pubSha === buildCommit; // không có git (sandbox) => chỉ khớp trực tiếp
  if (!contains) return { confirmed: false, reason: 'WRONG_SHA (pages build ' + buildCommit + ' KHÔNG chứa publication commit ' + pubSha + ')' };
  return { confirmed: true, deployed_sha: buildCommit };
}
// Publication commit = commit cuối cùng chạm archive của bài đầu batch
// (workflow đã commit cả cycle; SHA này phải là tổ tiên của Pages build).
function gitPublicationSha(ids) {
  const first = (ids && ids[0]) || '';
  if (!first) return '';
  const r = spawnSync('git', ['log', '-1', '--format=%H', '--', 'data/published/' + first + '.html'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}
function gitContains(pubSha, buildCommit) {
  if (!pubSha || !buildCommit) return null;
  const r = spawnSync('git', ['merge-base', '--is-ancestor', pubSha, buildCommit], { cwd: ROOT, encoding: 'utf8' });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null; // git error (sandbox không có binary / cây sạch) => thiếu truth, fail-closed
}
// Env truth: PAGES_BUILD_COMMIT/PAGES_BUILD_STATUS do step 'Pages deployment
// truth' của workflow export (từ GitHub API pages/builds/latest). Test-only:
// PIPELINE_PUB_SHA (override publication SHA), PIPELINE_MOCK_GIT_ANCESTOR=1|0
// (mock kết quả merge-base khi sandbox không có git binary).
function resolveDeployment(active) {
  const dep = (active && active.deployment) || {};
  const ids = (dep.ids && dep.ids.length ? dep.ids : (active && active.batch) || []);
  const pubSha = process.env.PIPELINE_PUB_SHA || gitPublicationSha(ids);
  const buildCommit = process.env.PAGES_BUILD_COMMIT || '';
  const buildStatus = process.env.PAGES_BUILD_STATUS || '';
  let containsSha = null;
  const mock = process.env.PIPELINE_MOCK_GIT_ANCESTOR;
  if (mock === '1' || mock === '0') containsSha = mock === '1';
  else if (pubSha && buildCommit) containsSha = gitContains(pubSha, buildCommit);
  return Object.assign(deploymentDecision(pubSha, buildCommit, buildStatus, containsSha), { publication_sha: pubSha });
}
// AUDIT #4: finalize là chỗ DUY NHẤT đặt last_cycle_summary + publication
// truth + refill + clear active — chỉ chạy SAU deployment confirm (hoặc khi
// cycle KHÔNG publish gì: blocked/claim-fail path vẫn phải kết thúc được).
function finalizeCycle(state, active, runtimeMode, failedPublish) {
  const finRows = loadRows();
  const publishedNow = active.batch.filter(id => { const r = finRows.find(x => x.article_id === id); return r && r.status === 'PUBLISHED'; });
  const blockedNow = active.batch.filter(id => { const r = finRows.find(x => x.article_id === id); return r && r.status === 'BLOCKED'; });
  state.cycle = active.cycle;
  state.last_cycle_summary = { cycle: active.cycle, adopted: !!active.adopted,
    started_at: active.started_at, finished_at: new Date().toISOString(),
    elapsed_ms: active.started_at ? Date.now() - new Date(active.started_at).getTime() : 0,
    batch: active.batch, published: publishedNow, blocked: blockedNow,
    failed_publish: failedPublish, writer_runtime: runtimeMode,
    publication: active.deployment && active.deployment.confirmed
      ? { publication_sha: active.deployment.publication_sha || null,
          deployed_sha: active.deployment.deployed_sha || null,
          confirmed_at: active.deployment.confirmed_at || null }
      : null };
  state.active = null;
  state.stopped_reason = null;
  state.last_stop = null;
  refill(state, finRows);
  saveState(state);
  console.log('PIPELINE CYCLE COMPLETE: cycle=' + state.last_cycle_summary.cycle +
    ' published=' + (publishedNow.length ? publishedNow.join(',') : 'none') +
    ' blocked=' + (blockedNow.length ? blockedNow.join(',') : 'none') +
    (failedPublish.length ? ' failed_publish=' + failedPublish.join(',') : '') +
    ' — queue còn ' + state.pending.length + ' topic.');
}

// ------------------------------- cycle ------------------------------------
async function cycle() {
  const t0 = Date.now();
  if (!acquireLock()) {
    console.log('PIPELINE SKIP: coordinator lock đang được giữ bởi process khác — một coordinator duy nhất, thoát sạch (exit 0).');
    return 0;
  }
  let held = true;
  const finish = (code) => { if (held) { releaseLock(); held = false; } process.exitCode = code; return code; };

  // ---- AGENTS #4/#5 (docs/AGENTS-OPS.md): durable pause + maintenance + open
  //      incident => PAUSED. TẤT CẢ check chặn chạy TRƯỚC preflight/recover/
  //      refill/claim — coordinator KHÔNG mutate gì cho đến khi sạch hết.
  // state.pause (committed truth) là khóa bền vững duy nhất QUA RUNNER:
  // maintenance.json / lock.json là RUN-LOCAL (gitignored, chết theo runner).
  let state;
  try { state = loadStateStrict(); }
  catch (e) {
    console.error('PIPELINE REFUSED: ' + (e && e.message) + ' — KHÔNG âm thầm dựng state rỗng để chạy production (fail-closed; xử lý theo docs/PROC-RECOVERY.md).');
    return finish(1);
  }
  if (state.pause) {
    console.log('PIPELINE PAUSED (durable): incident ' + state.pause.incident_id + ' giữ pause production (by ' + state.pause.by + ' lúc ' + state.pause.at + ') — KHÔNG claim, KHÔNG viết, KHÔNG publish. Chỉ clear sau khi incident này được verify thành công (agent #5).');
    return finish(0);
  }
  if (agentsCore.maintHeld()) {
    const m = agentsCore.maintRaw();
    console.log("PIPELINE PAUSED: maintenance lock đang được giữ (incident " + (m && m.incident_id) + ", holder " + (m && m.holder) + ") — Agent #4/#5 đang sửa hạ tầng; KHÔNG claim, KHÔNG viết, KHÔNG publish (exit 0).");
    return finish(0);
  }
  // #4 gián đoạn SAU khi commit incident nhưng TRƯỚC khi có final => run mới
  // (runner mới, KHÔNG có maintenance.json) vẫn nhận biết qua incident store.
  const openInc = agentsCore.openIncidents();
  if (openInc.length) {
    console.log('PIPELINE PAUSED: incident chưa hoàn tất (committed, chưa có kết luận): ' + openInc.map(i => i.id).join(', ') + ' — Agent #4 có thể đã bị gián đoạn; KHÔNG claim, KHÔNG viết, KHÔNG publish cho đến khi incident có final (docs/AGENTS-OPS.md).');
    return finish(0);
  }
  if (state.stopped_reason) console.error('PIPELINE STOPPED (lần trước): ' + state.stopped_reason);

  // ---- preflight: txn + writer lock (fail-closed, recover trước khi mutate) ----
  let tx = factory.readTx();
  if (tx.active) {
    run([process.execPath, path.join('scripts', 'factory', 'operator.js'), 'recover']);
    tx = factory.readTx();
    if (tx.active) { state.stopped_reason = 'transaction ' + tx.id + ' (op=' + tx.operation + ') active — recover KHÔNG giải được (fail-closed, dừng coordinator; xử lý thủ công theo docs/PROC-RECOVERY.md)'; saveState(state); return finish(1); }
  }
  let wl = factory.lockState();
  if (wl.held) {
    run([process.execPath, path.join('scripts', 'factory', 'operator.js'), 'recover']);
    wl = factory.lockState();
    if (wl.held) { state.stopped_reason = 'writer lock held bởi ' + wl.raw.holder + ' (chưa hết hạn) — không rõ ownership, STOP (fail-closed)'; saveState(state); return finish(1); }
  }

  // ---- stale-draft hygiene: auto-clean bản identical, refuse bản diverged ----
  let rows = loadRows();
  const sweep = staleDraftSweep(rows);
  if (sweep.refused.length) {
    state.stopped_reason = 'stale draft DIVERGED của row PUBLISHED: ' + sweep.refused.join(', ') + ' — không đè bài đã publish (fail-closed); xử lý theo docs/PROC-RECOVERY.md (qa-repair)';
    saveState(state);
    console.error('PIPELINE STOPPED: ' + state.stopped_reason);
    return finish(1);
  }
  if (sweep.removed.length) console.log('pipeline hygiene: đã dọn stale draft byte-identical của row PUBLISHED: ' + sweep.removed.join(', '));

  // ---- refill queue (window ~300 PLANNED đầu theo matrix order) ----
  rows = loadRows();
  refill(state, rows);

  // ---- resolve writer runtime — OFF ⇒ IDLE-STOP TRƯỚC KHI CLAIM ----
  let runtime;
  try { runtime = adapter.resolveRuntime(); }
  catch (e) { state.stopped_reason = e.message; saveState(state); console.error('PIPELINE STOPPED: ' + e.message); return finish(1); }
  // ---- AUDIT #4: deployment-confirmation gate (TRƯỚC idle-stop/claim) ----
  // Cycle trước đã publish nhưng còn pending deployment: run này KHÔNG claim
  // bài mới. Chỉ finalize khi Pages build cuối thành công VÀ chứa publication
  // SHA; thiếu truth/sai SHA => giữ nguyên trạng thái recoverable và thoát
  // sạch (KHÔNG mutate, KHÔNG build lại/push lại bài — resume kiểm tra lại
  // deployment cũ ở run sau; không đợi deployment trong run này).
  if (state.active && state.active.deployment && state.active.deployment.pending) {
    const dep = resolveDeployment(state.active);
    if (!dep.confirmed) {
      console.log('PIPELINE DEPLOYMENT-PENDING: cycle ' + state.active.cycle + ' đã publish ' +
        (state.active.deployment.ids || []).length + ' bài, đang chờ Pages deployment được xác nhận' +
        (dep.reason ? ' — ' + dep.reason : '') +
        ' — KHÔNG finalize, KHÔNG claim cycle mới (fail-closed; state giữ nguyên để resume).');
      return finish(0);
    }
    state.active.deployment.confirmed = true;
    state.active.deployment.confirmed_at = new Date().toISOString();
    state.active.deployment.publication_sha = dep.publication_sha || null;
    state.active.deployment.deployed_sha = dep.deployed_sha || null;
    finalizeCycle(state, state.active, runtime.mode, []);
    if (process.env.PIPELINE_SINGLE_CYCLE === '1') return finish(0); // test-only: dừng sau confirm
    console.log('PIPELINE DEPLOYMENT CONFIRMED (pages build ' + dep.deployed_sha + ' chứa publication ' + dep.publication_sha + ') — cycle ' + state.cycle + ' hoàn tất; tiếp tục batch mới trên run này.');
  }
  if (runtime.mode === 'off') {
    state.stopped_reason = null;
    state.last_stop = { kind: 'idle', reason: runtime.reason, at: new Date().toISOString(),
      pending: state.pending.length, planned_total: state.planned_total };
    saveState(state);
    console.log('PIPELINE IDLE — pipeline ĐÃ KÍCH HOẠT nhưng writer runtime chưa cấu hình: ' + runtime.reason);
    console.log('PIPELINE IDLE — KHÔNG claim, KHÔNG viết, KHÔNG publish bài nào. Queue sẵn sàng: ' + state.pending.length + ' topic (tổng PLANNED: ' + state.planned_total + ').');
    return finish(0);
  }

  // ---- đảm bảo batch: resume active / adopt mồ côi / claim mới ----
  const UNFINISHED = factory.UNFINISHED;
  let active = state.active;
  const unfinishedIds = rows.filter(r => UNFINISHED.includes(r.status)).map(r => r.article_id);
  if (!active) {
    if (unfinishedIds.length) {
      // adopt mồ côi: matrix có row đang mở nhưng state.active mất (run trước
      // crash trước khi commit state) — nhận lại theo matrix truth, KHÔNG claim lại.
      active = { cycle: state.cycle + 1, started_at: new Date().toISOString(), adopted: true, runtime_mode: runtime.mode,
        batch: unfinishedIds.slice(0, 20), grants: null, qa_rounds: {}, published: [], blocked: [] };
      active.grants = grantsOf(active.batch, PCFG.writers);
      console.log('pipeline: ADOPT orphan batch từ matrix truth: ' + active.batch.join(', ') + ' (không claim lại — engine đã giữ trạng thái mở)');
    } else {
      // batch mới từ pending head: 12..18 bài/cycle (ít hơn nếu topic sắp hết)
      const ids = state.pending.slice(0, PCFG.cycle_batch_max).filter(id => ID_RE.test(id));
      if (!ids.length) {
        state.stopped_reason = 'NO_PLANNED_TOPICS — không còn topic hợp lệ (queue rỗng, matrix không còn PLANNED).';
        saveState(state); console.log('PIPELINE STOPPED: ' + state.stopped_reason); return finish(0);
      }
      const rc = opSafe(['prepare-next', '--ids', ids.join(',')]);
      if (rc !== 0) { state.stopped_reason = 'prepare-next claim FAIL (rc=' + rc + ') — KHÔNG có gì được claim (fail-closed)'; saveState(state); return finish(1); }
      active = { cycle: state.cycle + 1, started_at: new Date().toISOString(), adopted: false, runtime_mode: runtime.mode,
        batch: ids, grants: grantsOf(ids, PCFG.writers), qa_rounds: {}, published: [], blocked: [] };
      console.log('pipeline: CLAIM batch ' + active.cycle + ' — ' + ids.length + ' bài chia đều ' + PCFG.writers + ' writer: ' + ids.join(', '));
    }
    state.active = active; saveState(state);
  } else {
    console.log('pipeline: RESUME active cycle ' + active.cycle + ' từ checkpoint (batch: ' + active.batch.join(', ') + ')');
  }

  // ---- phase: research (writer song song; coordinator ingest) ----
  rows = loadRows();
  const byId = {}; rows.forEach(r => byId[r.article_id] = r);
  const openIds = active.batch.filter(id => UNFINISHED.includes((byId[id] || {}).status));
  const needResearch = openIds.filter(id => (byId[id] || {}).status === 'RESEARCH' && !fs.existsSync(packetPath(id)));
  if (needResearch.length) {
    const tasks = needResearch.map(id => ({ task: 'research', writer: active.grants[id] || 'w1', row: byId[id] }));
    const res = await writerTasks(runtime, tasks);
    const failed = needResearch.filter(id => !res[id] || !res[id].ok);
    if (failed.length) { blockIds(failed, 'writer research fail sau ' + PCFG.writer_retries + ' lần retry'); active.blocked.push(...failed); saveState(state); }
  }
  rows = loadRows();
  const readyResearch = active.batch.filter(id => {
    const r = rows.find(x => x.article_id === id);
    return r && r.status === 'RESEARCH' && fs.existsSync(packetPath(id));
  });
  if (readyResearch.length) {
    let rc = 1;
    for (const part of chunk(readyResearch, 20)) { rc = opSafe(['research', '--ids', part.join(',')]); if (rc !== 0) break; }
    if (rc !== 0) { state.stopped_reason = 'research op FAIL sau retry — dừng cycle (fail-closed; batch giữ nguyên để resume)'; saveState(state); return finish(1); }
  }
  crashPoint('after-research');
  saveState(state);

  // ---- phase: write body (writer song song; coordinator ingest) ----
  rows = loadRows();
  const safePacket = id => { try { return JSON.parse(fs.readFileSync(packetPath(id), 'utf8')); } catch (e) { return null; } };
  const writeTargets = active.batch.filter(id => { const r = rows.find(x => x.article_id === id);
      return r && r.status === 'WRITING' && !fs.existsSync(bodyPath(id)) && !!safePacket(id); });
  const writeTasks = writeTargets.map(id => ({ task: 'write', writer: active.grants[id] || 'w1',
    row: rows.find(x => x.article_id === id), packet: safePacket(id) }));
  if (writeTasks.length) {
    const res = await writerTasks(runtime, writeTasks);
    const failed = writeTargets.filter(id => !res[id] || !res[id].ok);
    if (failed.length) { blockIds(failed, 'writer write fail sau ' + PCFG.writer_retries + ' lần retry'); active.blocked.push(...failed); }
    saveState(state);
  }
  crashPoint('after-write');

  // ---- phase: wrap + QA vòng đầu ----
  const qaInitial = (() => {
    const rs = loadRows();
    return active.batch.filter(id => { const r = rs.find(x => x.article_id === id);
      return r && !factory.TERMINAL.has(r.status) && r.status !== 'PASS' && fs.existsSync(bodyPath(id)); });
  })();
  if (qaInitial.length) {
    run([process.execPath, path.join('scripts', 'factory', 'wrap-drafts.js')]);
    let rc = 1;
    for (const part of chunk(qaInitial, 20)) { rc = opSafe(['qa', '--ids', part.join(',')]); if (rc !== 0) break; }
    if (rc !== 0) { state.stopped_reason = 'qa op FAIL sau retry — dừng cycle (fail-closed; batch giữ nguyên để resume)'; saveState(state); return finish(1); }
  }
  crashPoint('after-qa');
  saveState(state);

  // ---- phase: repair rounds (feedback QA → writer revise → re-QA; bounded) ----
  const maxRounds = Number(factory.rubric.max_repair_attempts) || 3;
  for (let round = 1; round <= maxRounds; round++) {
    const rs = loadRows();
    const open = active.batch.filter(id => { const r = rs.find(x => x.article_id === id);
      return r && (r.status === 'REVIEW' || r.status === 'REPAIR'); });
    if (!open.length) break;
    console.log('pipeline: repair round ' + round + '/' + maxRounds + ' — ' + open.join(', '));
    const tasks = open.map(id => ({ task: 'revise', writer: active.grants[id] || 'w1',
      row: rs.find(x => x.article_id === id), feedback: qaFeedback(id) }));
    const res = await writerTasks(runtime, tasks);
    const revised = open.filter(id => res[id] && res[id].ok);
    if (revised.length) {
      run([process.execPath, path.join('scripts', 'factory', 'wrap-drafts.js')]);
      for (const part of chunk(revised, 20)) opSafe(['qa', '--ids', part.join(',')]);
    }
    for (const id of open) active.qa_rounds[id] = (active.qa_rounds[id] || 0) + 1;
    const failed = open.filter(id => !(res[id] && res[id].ok));
    if (failed.length) { blockIds(failed, 'writer revise fail sau retry'); active.blocked.push(...failed); }
    saveState(state);
    crashPoint('after-repair-' + round);
  }
  // hết lượt sửa: REVIEW/REPAIR/WRITING còn lại ⇒ BLOCKED (chunk kết thúc được)
  {
    const rs = loadRows();
    const stuck = active.batch.filter(id => { const r = rs.find(x => x.article_id === id);
      return r && !factory.TERMINAL.has(r.status) && r.status !== 'PASS'; });
    if (stuck.length) { blockIds(stuck, 'hết ' + maxRounds + ' lượt sửa, QA vẫn chưa PASS'); active.blocked.push(...stuck); saveState(state); }
  }

  // ---- AUDIT #3: phase publish — MỘT transaction cho cả cycle ----
  // Toàn bộ tập PASS eligible của batch được publish trong MỘT op atomic qua
  // operator.js (publish --ids <tất cả> --scope fast --cycle-batch): engine tự
  // validate ids ĐÚNG BẰNG eligible-set của active batch (pipeline-state)
  // TRƯỚC lock và cap PUBLISH_BATCH_MAX. Op FAIL => fail-closed finish(1):
  // KHÔNG publish từng phần, KHÔNG bỏ qua âm thầm — rows giữ PASS, active
  // batch giữ nguyên để cycle sau/qa-repair resume (rollback deterministic
  // đã chạy trong op).
  rows = loadRows();
  const passIds = active.batch.filter(id => { const r = rows.find(x => x.article_id === id);
      return r && r.status === 'PASS' && fs.existsSync(draftPath(id)); });
  const failedPublish = [];
  if (passIds.length) {
    const rc = opSafe(['publish', '--ids', passIds.join(','), '--scope', 'fast', '--cycle-batch']);
    if (rc !== 0) {
      state.stopped_reason = 'publish batch FAIL (op đã rollback deterministic) — KHÔNG publish từng phần; giữ PASS để cycle sau/qa-repair: ' + passIds.join(', ');
      saveState(state);
      console.error('PIPELINE STOPPED: ' + state.stopped_reason);
      return finish(1);
    }
    active.published.push(...passIds);
    // AUDIT #4: push/commit thành công ≠ deploy thành công — cycle KHÔNG hoàn
    // tất ở đây. Lưu trạng thái pending deployment (ids + thời điểm + runtime
    // mode); run kế đọc Pages build truth (step 'Pages deployment truth' export
    // PAGES_BUILD_COMMIT/PAGES_BUILD_STATUS) và chỉ finalize khi deploy THÀNH
    // CÔNG VÀ chứa publication SHA. KHÔNG đợi deployment trong run này (Pages
    // build cần run kết thúc trước — tránh tự chặn dependency deploy), KHÔNG
    // commit riêng chỉ-để-đánh-dấu (state pending được commit cùng cycle).
    active.deployment = { pending: true, ids: passIds.slice(),
      published_at: new Date().toISOString(), runtime_mode: runtime.mode };
    saveState(state);
    crashPoint('after-publish-batch');
    console.log('PIPELINE PUBLISHED (pending deployment): cycle=' + active.cycle + ' — ' + passIds.length + ' bài (' + passIds.join(', ') +
      ') đã publish trong MỘT transaction; chờ xác nhận Pages deploy đúng SHA (audit #4) trước khi hoàn tất cycle. KHÔNG chạy cycle mới trên run này.');
    return finish(0);
  }

  // ---- finalize (AUDIT #4: chỉ chạy khi cycle KHÔNG publish gì — blocked/
  //      claim-fail path; cycle đã publish thì finalize sau deployment confirm
  //      ở run kế) ----
  finalizeCycle(state, active, runtime.mode, failedPublish);
  return finish(0);
}

// ------------------------------ commands -----------------------------------
function cmdStatus() {
  const state = loadState();
  const rows = loadRows();
  const by = {}; rows.forEach(r => by[r.status] = (by[r.status] || 0) + 1);
  let runtime = null;
  try { runtime = adapter.resolveRuntime(); } catch (e) { runtime = { mode: 'invalid', reason: e.message }; }
  const s = { updated_at: state.updated_at, cycle: state.cycle,
    pending_queue: state.pending.length, planned_total: state.planned_total || (by.PLANNED || 0),
    active: state.active ? { cycle: state.active.cycle, batch: state.active.batch, adopted: !!state.active.adopted } : null,
    last_cycle_summary: state.last_cycle_summary, stopped_reason: state.stopped_reason,
    pause: state.pause || null, maintenance_held: agentsCore.maintHeld(),
    open_incidents: agentsCore.openIncidents().map(i => i.id),
    writer_runtime: runtime.mode === 'off' ? 'off (idle — ' + runtime.reason + ')' : runtime.mode,
    matrix_by_status: by, coordinator_lock: lockHeld() ? 'HELD' : 'free' };
  console.log(JSON.stringify(s, null, 2));
}
function cmdRefill() {
  let state;
  try { state = loadStateStrict(); }
  catch (e) { console.error('PIPELINE REFILL REFUSED: ' + (e && e.message) + ' (fail-closed)'); process.exitCode = 1; return; }
  if (state.pause) {
    console.log('PIPELINE REFILL SKIPPED: durable pause của incident ' + state.pause.incident_id + ' — KHÔNG đụng state khi production pause.');
    return;
  }
  const rows = loadRows();
  const changed = refill(state, rows);
  saveState(state);
  console.log('PIPELINE REFILL ' + (changed ? '(đã nạp lại)' : '(đủ — không đổi)') + ': queue=' + state.pending.length + ' topic, tổng PLANNED=' + state.planned_total + ', đầu queue: ' + state.pending.slice(0, 5).join(', ') + (state.pending.length > 5 ? ', ...' : ''));
}
function cmdSelftest() {
  console.log('PIPELINE SELFTEST: node --test tests/pipeline-suite.js (PIPELINE_ALLOW_MOCK=1, sandbox os.tmpdir — KHÔNG đụng production tree)');
  // --max-old-space-size: OOM-guard cho môi trường ~1GB (Actions 7GB không bị ảnh hưởng)
  const r = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=400', '--test', 'tests/pipeline-suite.js'], {
    cwd: ROOT, env: Object.assign({}, process.env, { PIPELINE_ALLOW_MOCK: '1' }),
    stdio: 'inherit' });
  let rc = r.status == null ? 1 : r.status;
  if (rc !== 0) { console.error('SELFTEST FAIL: pipeline-suite — bỏ qua agent-suite'); process.exitCode = rc; return; }
  console.log('AGENTS SELFTEST: node --test tests/agent-suite.js (Agent #4/#5/#6 — không overlap, không bypass lock, không duplicate cycle)');
  const r2 = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=400', '--test', 'tests/agent-suite.js'], {
    cwd: ROOT, env: Object.assign({}, process.env), stdio: 'inherit' });
  const rc2 = r2.status == null ? 1 : r2.status;
  process.exitCode = rc2;
}

async function main(argv) {
  const [cmd] = argv;
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'refill') return cmdRefill();
  if (cmd === 'cycle') return cycle();
  if (cmd === 'selftest') return cmdSelftest();
  console.error('Usage: pipeline.js <status|refill|cycle|selftest>');
  process.exit(1);
}

if (require.main === module) main(process.argv.slice(2)).catch(e => {
  console.error('PIPELINE FATAL: ' + (e && e.stack || e));
  try { releaseLock(); } catch (_) {}
  process.exit(1);
});
module.exports = { loadState, loadStateStrict, saveState, grantsOf, refill, staleDraftSweep, chunk, deploymentDecision, resolveDeployment };
