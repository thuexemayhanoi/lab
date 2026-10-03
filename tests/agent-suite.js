#!/usr/bin/env node
/**
 * agent-suite.js — kiểm thử Agents #4/#5/#6 (docs/AGENTS-OPS.md):
 *   #4 agent-repair.js, #5 agent-supervisor.js, #6 agent-watchdog.js,
 *   nền agents-core.js.
 *
 * MỤC TIÊU (spec): chứng minh bằng regression rằng các agent
 *   (a) KHÔNG thể overlap sai (không bao giờ #4 và #5 sửa đồng thời);
 *   (b) KHÔNG thể tạo production cycle trùng;
 *   (c) KHÔNG thể bypass maintenance lock;
 *   (d) #6 passive khi #4/#5 active / pause / production đang chạy.
 *
 * ISOLATION: mọi lệnh agent/pipeline chạy trong SANDBOX đầy đủ (os.tmpdir,
 * bản sao repo, shards assemble thành content-matrix.csv đơn, `_drafts/` và
 * `pipeline/` bị loại để fixture kiểm soát hoàn toàn cây làm việc). Cây
 * production KHÔNG BAO GIỜ bị đụng tới. Sandbox dùng bản sao scripts của
 * chính nó (ROOT resolve từ __dirname).
 *
 * MEMORY GUARD: mỗi lần agent chạy sẽ spawn operator/factory (parse 10k
 * dòng ≈ 86MB) — spawn với NODE_OPTIONS heap-guard như pipeline-suite.
 */
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
beforeEach(() => { if (typeof global.gc === 'function') global.gc(); });
afterEach(() => { if (typeof global.gc === 'function') global.gc(); });
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

// ------------------------------ sandbox ------------------------------------
let sbSeq = 0;
function mkSB() {
  const SB = path.join(os.tmpdir(), 'lab-agent-sb-' + process.pid + '-' + (++sbSeq));
  fs.rmSync(SB, { recursive: true, force: true });
  fs.cpSync(ROOT, SB, { recursive: true, filter: s => {
    const rel = path.relative(ROOT, s);
    return rel !== '_drafts' && !rel.startsWith('_drafts' + path.sep)
      && rel !== 'pipeline' && !rel.startsWith('pipeline' + path.sep)
      && !path.basename(s).startsWith('content-matrix.csv.part')
      && rel !== 'tests' && !rel.startsWith('tests' + path.sep); // tests không cần trong sandbox
  } });
  const parts = fs.readdirSync(DATA).filter(f => /^content-matrix\.csv\.part/.test(f)).sort();
  if (parts.length) fs.writeFileSync(path.join(SB, 'data', 'content-matrix.csv'),
    parts.map(p => fs.readFileSync(path.join(DATA, p), 'utf8')).join(''));
  return SB;
}
const rmSB = sb => fs.rmSync(sb, { recursive: true, force: true });

// chạy CLI CỦA SANDBOX (ROOT của script = sandbox — không phải cây này)
function SP(sb, script, args, env) {
  const r = spawnSync(process.execPath, [path.join(sb, 'scripts', 'factory', script), ...args],
    { cwd: sb, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000,
      env: Object.assign({}, process.env,
        { NODE_OPTIONS: ((process.env.NODE_OPTIONS || '') + ' --max-old-space-size=448').trim() }, env || {}) });
  return { rc: r.status, out: ((r.stdout || '') + (r.stderr || '')) };
}
const A4 = (sb, args, env) => SP(sb, 'agent-repair.js', args, env);
const A5 = (sb, args, env) => SP(sb, 'agent-supervisor.js', args, env);
const A6 = (sb, args, env) => SP(sb, 'agent-watchdog.js', args, env);
const PIPE = (sb, args, env) => SP(sb, 'pipeline.js', args, env);

// ------------------------------ fixtures ------------------------------------
const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const statePath = sb => path.join(sb, 'data', 'state', 'pipeline-state.json');
const txPath = sb => path.join(sb, 'data', 'state', 'transaction.json');
const wlPath = sb => path.join(sb, 'data', 'state', 'writer-lock.json');
const maintPath = sb => path.join(sb, 'pipeline', 'maintenance.json');
const coordPath = sb => path.join(sb, 'pipeline', 'lock.json');
const incPath = (sb, id) => path.join(sb, 'reports', 'incidents', id + '.json');
const INCIDENTS = sb => path.join(sb, 'reports', 'incidents');

function resetCore(sb) { // txn + writer-lock sạch
  fs.mkdirSync(path.dirname(txPath(sb)), { recursive: true });
  fs.writeFileSync(txPath(sb), JSON.stringify({ active: false, id: null, started_at: null,
    operation: null, articles: [], notes: '' }, null, 2));
  fs.writeFileSync(wlPath(sb), JSON.stringify({ locked: false, holder: null,
    acquired_at: null, expires_at: null }, null, 2));
}
function setTxn(sb, id, op) {
  fs.writeFileSync(txPath(sb), JSON.stringify({ active: true, id, started_at: new Date().toISOString(),
    operation: op, articles: [] }, null, 2));
}
function setWriterLock(sb, holder, minLeft) {
  fs.writeFileSync(wlPath(sb), JSON.stringify({ locked: true, holder,
    acquired_at: new Date(Date.now() - 5 * 60000).toISOString(),
    expires_at: new Date(Date.now() + minLeft * 60000).toISOString() }, null, 2));
}
function setMaint(sb, holder, incidentId, minLeft) {
  fs.mkdirSync(path.dirname(maintPath(sb)), { recursive: true });
  fs.writeFileSync(maintPath(sb), JSON.stringify({ active: true, holder, incident_id: incidentId,
    reason: 'test', acquired_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + minLeft * 60000).toISOString() }, null, 2));
}
function clearMaint(sb) {
  fs.mkdirSync(path.dirname(maintPath(sb)), { recursive: true });
  fs.writeFileSync(maintPath(sb), JSON.stringify({ active: false, holder: null,
    incident_id: null, reason: null, acquired_at: null, expires_at: null }, null, 2));
}
function setState(sb, st) {
  fs.mkdirSync(path.dirname(statePath(sb)), { recursive: true });
  fs.writeFileSync(statePath(sb), JSON.stringify(Object.assign({
    updated_at: new Date().toISOString(), cycle: 0, pending: [], planned_total: null,
    active: null, last_cycle_summary: null, last_stop: null, stopped_reason: null }, st), null, 2));
}
function mkIncident(sb, id, runId, finalStatus, extra) {
  fs.mkdirSync(INCIDENTS(sb), { recursive: true });
  const inc = Object.assign({ id, created_at: new Date().toISOString(),
    source: { kind: 'test', run_id: runId || null }, actions: [], final: null }, extra || {});
  if (finalStatus) inc.final = { status: finalStatus, summary: 'fixture', at: new Date().toISOString() };
  fs.writeFileSync(incPath(sb, id), JSON.stringify(inc, null, 2));
  return inc;
}
function grab(out, tag) {
  const m = out.split('\n').find(l => l.startsWith(tag + '='));
  return m ? m.slice(tag.length + 1).trim() : null;
}
const maintHeld = sb => { try { const m = readJSON(maintPath(sb));
  return !!(m.active && m.expires_at && new Date(m.expires_at) > new Date()); } catch (e) { return false; } };

// =====================================================================
// UNIT — agents-core.js (lock, takeover, release-chỉ-of-mình, incident store)
// =====================================================================
test('agents-core: maintenance lock — acquire/second-acquire refused/release chỉ đúng incident', () => {
  const sb = mkSB();
  try {
    const core = require(path.join(sb, 'scripts', 'factory', 'agents-core.js'));
    assert.equal(core.maintHeld(), false);
    assert.equal(core.acquireMaintenance('INC-A', 'agent-4', 60, 't'), true);
    assert.equal(core.maintHeld(), true);
    // MỘT incident duy nhất: incident khác KHÔNG giành được lock
    assert.equal(core.acquireMaintenance('INC-B', 'agent-4', 60, 't'), false);
    // release của incident khác KHÔNG có hiệu lực (không bypass lock)
    assert.equal(core.releaseMaintenance('INC-B'), false);
    assert.equal(core.maintHeld(), true);
    assert.equal(core.releaseMaintenance('INC-A'), true);
    assert.equal(core.maintHeld(), false);
  } finally { rmSB(sb); }
});

test('agents-core: takeover — cùng incident OK (handoff #4→#5), incident khác REFUSED', () => {
  const sb = mkSB();
  try {
    const core = require(path.join(sb, 'scripts', 'factory', 'agents-core.js'));
    core.acquireMaintenance('INC-A', 'agent-4', 60, 't');
    assert.equal(core.takeoverMaintenance('INC-B', 'agent-5', 60, 't'), false); // khác incident
    assert.equal(core.takeoverMaintenance('INC-A', 'agent-5', 60, 't'), true);  // handoff cùng incident
    const m = core.maintRaw();
    assert.equal(m.holder, 'agent-5'); assert.equal(m.incident_id, 'INC-A');
    // lock hết TTL => takeover tự acquire mới
    fs.writeFileSync(core.MAINT_FILE, JSON.stringify({ active: true, holder: 'agent-4',
      incident_id: 'INC-A', expires_at: new Date(Date.now() - 60000).toISOString() }, null, 2));
    assert.equal(core.maintHeld(), false);
    assert.equal(core.takeoverMaintenance('INC-A', 'agent-5', 60, 't'), true);
    assert.equal(core.maintHeld(), true);
  } finally { rmSB(sb); }
});

test('agents-core: pauseMaintenance giữ production pause (holder agent-5)', () => {
  const sb = mkSB();
  try {
    const core = require(path.join(sb, 'scripts', 'factory', 'agents-core.js'));
    core.acquireMaintenance('INC-A', 'agent-4', 60, 't');
    assert.equal(core.pauseMaintenance('INC-A', 'agent-5', 120, 'paused'), true);
    assert.equal(core.maintHeld(), true);
    assert.equal(core.maintRaw().holder, 'agent-5');
    assert.equal(core.pauseMaintenance('INC-B', 'agent-5', 120, 'paused'), false); // khác incident
  } finally { rmSB(sb); }
});

test('agents-core: incident store — act audit, findBySourceRun dedup, recentUnrepaired cửa sổ', () => {
  const sb = mkSB();
  try {
    const core = require(path.join(sb, 'scripts', 'factory', 'agents-core.js'));
    const inc = { id: 'INC-X1', created_at: new Date().toISOString(),
      source: { kind: 'workflow_run', run_id: 'run-42' }, actions: [], final: null };
    core.saveIncident(inc);
    core.act(inc, 'agent-4', 'inspect', 'txn_active=true');
    const loaded = core.loadIncident('INC-X1');
    assert.equal(loaded.actions.length, 1);
    assert.ok(loaded.actions[0].at);
    assert.equal(core.findBySourceRun('run-42').id, 'INC-X1');
    assert.equal(core.findBySourceRun('run-none'), null);
    assert.equal(core.recentUnrepaired(), 0);
    core.setFinal(inc, 'FAILED_PAUSED', 'x');
    assert.equal(core.recentUnrepaired(), 1);
    // ngoài cửa sổ => không đếm
    const c = core.cfg();
    const old = Object.assign({}, inc, { id: 'INC-X-OLD', final: { status: 'FAILED_PAUSED', at: new Date(Date.now() - (c.unrepaired_window_minutes + 10) * 60000).toISOString() } });
    core.saveIncident(old);
    const held = core.recentUnrepaired();
    assert.equal(held, 1); // INC-X1 (mới) + old (ngoài cửa sổ không đếm)
  } finally { rmSB(sb); }
});

test('agents-core: probes — state thiếu=OK, state hỏng=corrupt, txn/writer-lock/coord-lock đọc đúng', () => {
  const sb = mkSB();
  try {
    resetCore(sb);
    const core = require(path.join(sb, 'scripts', 'factory', 'agents-core.js'));
    let p = core.probes();
    assert.equal(p.pipeline_state_ok, true);  // ENOENT = bình thường
    assert.equal(p.txn_active, false);
    assert.equal(p.writer_lock_held, false);
    setTxn(sb, 'TX-1', 'prepare-next');
    setWriterLock(sb, 'w', 20);
    fs.mkdirSync(path.dirname(coordPath(sb)), { recursive: true });
    fs.writeFileSync(coordPath(sb), JSON.stringify({ locked: true, holder: 'c1',
      expires_at: new Date(Date.now() + 600000).toISOString() }, null, 2));
    p = core.probes();
    assert.equal(p.txn_active, true);
    assert.equal(p.writer_lock_held, true);
    assert.equal(p.coord_lock_held, true);
    // coord lock hết TTL => không còn held
    fs.writeFileSync(coordPath(sb), JSON.stringify({ locked: true, holder: 'c1',
      expires_at: new Date(Date.now() - 60000).toISOString() }, null, 2));
    assert.equal(core.probes().coord_lock_held, false);
    setState(sb, { cycle: 1 });
    assert.equal(core.probes().pipeline_state_ok, true);
    fs.writeFileSync(statePath(sb), '{ NOT JSON !!!');
    assert.equal(core.probes().pipeline_state_ok, false);
  } finally { rmSB(sb); }
});

// =====================================================================
// UNIT — agent-watchdog (#6): decision matrix
// =====================================================================
function a6check(sb, extraArgs) {
  const r = A6(sb, ['check', '--skip-git', ...(extraArgs || [])]);
  let j = null; try { j = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1)); } catch (e) {}
  return { rc: r.rc, out: r.out, j };
}

test('#6: progress hợp lệ 90 phút trước (< 2h) => DO_NOTHING', () => {
  const sb = mkSB();
  try {
    resetCore(sb);
    setState(sb, { last_cycle_summary: { published: ['A00001'], blocked: [],
      finished_at: new Date(Date.now() - 90 * 60000).toISOString() } });
    const { rc, j } = a6check(sb);
    assert.equal(rc, 0);
    assert.equal(j.stalled, false);
    assert.equal(j.action, 'DO_NOTHING');
  } finally { rmSB(sb); }
});

test('#6: cycle RỖNG (không publish/blocked) KHÔNG phải progress hợp lệ — 130 phút => stalled', () => {
  const sb = mkSB();
  try {
    resetCore(sb);
    setState(sb, { last_cycle_summary: { published: [], blocked: [],
      finished_at: new Date(Date.now() - 130 * 60000).toISOString() } });
    const { j } = a6check(sb);
    assert.equal(j.stalled, true);
  } finally { rmSB(sb); }
});

test('#6: stalled NHƯNG idle chủ ý (chưa có writer runtime) => DO_NOTHING', () => {
  const sb = mkSB();
  try {
    resetCore(sb);
    setState(sb, { last_stop: { kind: 'idle', reason: 'WRITER_RUNTIME=off',
      at: new Date(Date.now() - 10 * 60000).toISOString() } });
    const { j } = a6check(sb);
    assert.equal(j.stalled, true);
    assert.equal(j.action, 'DO_NOTHING');
    assert.ok(j.blockers.some(b => b.includes('IDLE chủ ý')));
  } finally { rmSB(sb); }
});

test('#6: stalled + maintenance lock (#4/#5 active) => DO_NOTHING — không bypass lock', () => {
  const sb = mkSB();
  try {
    resetCore(sb);
    setMaint(sb, 'agent-4', 'INC-M', 30);
    const { j } = a6check(sb);
    assert.equal(j.action, 'DO_NOTHING');
    assert.ok(j.blockers.some(b => b.includes('maintenance lock')));
  } finally { rmSB(sb); }
});

test('#6: stalled + pause chủ ý (#5 đặt trong state) => DO_NOTHING', () => {
  const sb = mkSB();
  try {
    resetCore(sb);
    setState(sb, { pause: { by: 'agent-5', incident_id: 'INC-P', at: new Date().toISOString() } });
    const { j } = a6check(sb);
    assert.equal(j.action, 'DO_NOTHING');
    assert.ok(j.blockers.some(b => b.includes('pause CHỦ Ý') || b.includes('pause chủ ý')));
  } finally { rmSB(sb); }
});

test('#6: stalled + coordinator lock (writer cycle đang chạy) => DO_NOTHING', () => {
  const sb = mkSB();
  try {
    resetCore(sb);
    fs.mkdirSync(path.dirname(coordPath(sb)), { recursive: true });
    fs.writeFileSync(coordPath(sb), JSON.stringify({ locked: true, holder: 'pipeline-runner',
      expires_at: new Date(Date.now() + 20 * 60000).toISOString() }, null, 2));
    const { j } = a6check(sb);
    assert.equal(j.action, 'DO_NOTHING');
    assert.ok(j.blockers.some(b => b.includes('coordinator lock')));
  } finally { rmSB(sb); }
});

test('#6: stalled + txn active / writer-lock (publisher đang chạy) => DO_NOTHING', () => {
  const sb = mkSB();
  try {
    resetCore(sb);
    setTxn(sb, 'TX-9', 'publish');
    const r1 = a6check(sb);
    assert.ok(r1.j.blockers.some(b => b.includes('transaction')));
    resetCore(sb);
    setWriterLock(sb, 'writer-1', 20);
    const r2 = a6check(sb);
    assert.ok(r2.j.blockers.some(b => b.includes('writer-lock')));
    assert.equal(r1.j.action, 'DO_NOTHING'); assert.equal(r2.j.action, 'DO_NOTHING');
  } finally { rmSB(sb); }
});

test('#6: stalled + đủ idle => trigger ĐÚNG MỘT entrypoint (dry-run: KHÔNG chạy)', () => {
  const sb = mkSB();
  try {
    resetCore(sb);
    setState(sb, { last_cycle_summary: { published: ['A00001'], blocked: [],
      finished_at: new Date(Date.now() - 130 * 60000).toISOString() } });
    const { j } = a6check(sb, ['--dry-run', '--trigger-cmd', 'gh workflow run x']);
    assert.equal(j.action, 'TRIGGER_ONE_ENTRYPOINT');
    assert.equal(j.triggered, false); // dry-run: KHÔNG chạy thật
    assert.ok(j.detail.includes('WOULD TRIGGER'));
  } finally { rmSB(sb); }
});

test('#6: đủ idle + trigger-cmd thật => chạy đúng MỘT lần, KHÔNG mutate cây repo', () => {
  const sb = mkSB();
  try {
    resetCore(sb);
    setState(sb, { last_cycle_summary: { published: ['A00001'], blocked: [],
      finished_at: new Date(Date.now() - 130 * 60000).toISOString() } });
    const marker = path.join(sb, 'pipeline', 'watchdog-trigger-marker.txt');
    // pipeline/ có thể chưa tồn tại lúc trigger chạy (record() mkdir SAU trigger)
    // => cmd tự mkdir -p thư mục marker.
    const cmd = 'node -e "const f=require(\'fs\');f.mkdirSync(require(\'path\').dirname(process.argv[1]),{recursive:true});f.appendFileSync(process.argv[1],\'x\\n\')" "' + marker + '"';
    const before = fs.readFileSync(txPath(sb), 'utf8');
    const { j } = a6check(sb, ['--trigger-cmd', cmd]);
    assert.equal(j.action, 'TRIGGER_ONE_ENTRYPOINT');
    assert.equal(j.triggered, true);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'x\n'); // đúng 1 lần
    assert.equal(fs.readFileSync(txPath(sb), 'utf8'), before); // KHÔNG mutate state
  } finally { rmSB(sb); }
});

// ---------- fake `gh` cho ghProductionActive (GITHUB API contract) ----------
function mkFakeGh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-fake-gh-'));
  const gh = path.join(dir, 'gh');
  fs.writeFileSync(gh, [
    '#!/usr/bin/env node',
    "'use strict';",
    'const fs = require("fs");',
    'const args = process.argv.slice(2);',
    'if (process.env.FAKE_GH_FAIL === "1") { process.stderr.write("gh: HTTP 500\\n"); process.exit(1); }',
    'const url = args.filter(a => a.includes("actions/runs")).pop() || "";',
    'const st = (/[?&]status=([^&]+)/.exec(url) || [])[1] || "";',
    'const pg = Number((/[?&]page=(\\d+)/.exec(url) || [])[1] || 1);',
    'const data = JSON.parse(fs.readFileSync(process.env.FAKE_GH_DATA, "utf8"));',
    'const spec = data[st] || { runs: [] };',
    'const runs = spec.runs.slice((pg - 1) * 100, pg * 100);',
    'process.stdout.write(JSON.stringify({ total_count: spec.runs.length, workflow_runs: runs }));',
    ''
  ].join('\n'));
  fs.chmodSync(gh, 0o755);
  return dir;
}
const ghRun = (id, name, status) => ({ id, name: name || 'Factory production', status: status || 'in_progress' });
function ghEnv(ghDir, data, extra) {
  const dataFile = path.join(ghDir, 'data.json');
  fs.writeFileSync(dataFile, JSON.stringify(data || {}));
  return Object.assign({ GITHUB_REPOSITORY: 'thuexemayhanoi/lab', GITHUB_TOKEN: 'test-token',
    FAKE_GH_DATA: dataFile, PATH: ghDir + path.delimiter + process.env.PATH }, extra || {});
}
const rmGh = ghDir => fs.rmSync(ghDir, { recursive: true, force: true });

test('#6 ghProductionActive (unit): chỉ có run watchdog HIỆN TẠI => false — không tự chặn mình', () => {
  const ghDir = mkFakeGh(); const sb = mkSB();
  try {
    resetCore(sb);
    const wd = require(path.join(sb, 'scripts', 'factory', 'agent-watchdog.js'));
    const stashes = { repo: process.env.GITHUB_REPOSITORY, tok: process.env.GITHUB_TOKEN, run: process.env.GITHUB_RUN_ID };
    Object.assign(process.env, ghEnv(ghDir, { in_progress: { runs: [ghRun(555)] } }, { GITHUB_RUN_ID: '555' }));
    assert.equal(wd.ghProductionActive(), false); // run hiện tại bị loại qua GITHUB_RUN_ID
    Object.assign(process.env, { GITHUB_RUN_ID: '999' });
    assert.equal(wd.ghProductionActive(), true);  // cùng run đó nhưng từ run khác => active
    Object.assign(process.env, stashes); // phục hồi env
  } finally { rmSB(sb); rmGh(ghDir); }
});

test('#6 ghProductionActive (unit): run khác queued/waiting/pending => true; không có run nào => false; API lỗi => null (fail-closed)', () => {
  const ghDir = mkFakeGh(); const sb = mkSB();
  try {
    resetCore(sb);
    const wd = require(path.join(sb, 'scripts', 'factory', 'agent-watchdog.js'));
    const stashes = { repo: process.env.GITHUB_REPOSITORY, tok: process.env.GITHUB_TOKEN, run: process.env.GITHUB_RUN_ID, fail: process.env.FAKE_GH_FAIL };
    Object.assign(process.env, ghEnv(ghDir, { queued: { runs: [ghRun(777, 'Factory production', 'queued')] } }, { GITHUB_RUN_ID: '999' }));
    assert.equal(wd.ghProductionActive(), true); // đã XẾP HÀNG => không dispatch trùng
    Object.assign(process.env, ghEnv(ghDir, { waiting: { runs: [ghRun(778, 'Factory production', 'waiting')] } }, { GITHUB_RUN_ID: '999' }));
    assert.equal(wd.ghProductionActive(), true);
    Object.assign(process.env, ghEnv(ghDir, { in_progress: { runs: [{ id: 556, name: 'Other workflow', status: 'in_progress' }] } }, { GITHUB_RUN_ID: '999' }));
    assert.equal(wd.ghProductionActive(), false); // workflow khác không liên quan
    Object.assign(process.env, ghEnv(ghDir, { in_progress: { runs: [ghRun(555)] } }, { GITHUB_RUN_ID: '555' }));
    assert.equal(wd.ghProductionActive(), false); // trống (sau khi loại run hiện tại)
    Object.assign(process.env, { FAKE_GH_FAIL: '1' });
    assert.equal(wd.ghProductionActive(), null); // API lỗi => fail-closed
    Object.assign(process.env, stashes);
    delete process.env.FAKE_GH_FAIL;
  } finally { rmSB(sb); rmGh(ghDir); }
});

test('#6 ghProductionActive (unit): pagination — run active ở trang 2 vẫn được thấy', () => {
  const ghDir = mkFakeGh(); const sb = mkSB();
  try {
    resetCore(sb);
    const wd = require(path.join(sb, 'scripts', 'factory', 'agent-watchdog.js'));
    const stashes = { repo: process.env.GITHUB_REPOSITORY, tok: process.env.GITHUB_TOKEN, run: process.env.GITHUB_RUN_ID };
    // 101 run in_progress: 100 run khác tên (trang 1) + Factory production ở trang 2
    const runs = [];
    for (let i = 1; i <= 100; i++) runs.push({ id: 1000 + i, name: 'CI', status: 'in_progress' });
    runs.push(ghRun(555));
    Object.assign(process.env, ghEnv(ghDir, { in_progress: { runs } }, { GITHUB_RUN_ID: '999' }));
    assert.equal(wd.ghProductionActive(), true); // không bị bỏ sót do pagination
    Object.assign(process.env, stashes);
  } finally { rmSB(sb); rmGh(ghDir); }
});

test('#6 check (gh context): run hiện tại duy nhất + đủ idle/stalled => vẫn TRIGGER (không self-block)', () => {
  const ghDir = mkFakeGh(); const sb = mkSB();
  try {
    resetCore(sb);
    setState(sb, { last_cycle_summary: { published: ['A00001'], blocked: [],
      finished_at: new Date(Date.now() - 130 * 60000).toISOString() } });
    const r = A6(sb, ['check', '--skip-git', '--dry-run', '--trigger-cmd', 'gh workflow run x'],
      ghEnv(ghDir, { in_progress: { runs: [ghRun(555)] } }, { GITHUB_RUN_ID: '555' }));
    const j = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1));
    assert.equal(j.stalled, true);
    assert.equal(j.action, 'TRIGGER_ONE_ENTRYPOINT'); // run watchdog hiện tại KHÔNG chặn
    assert.ok(!j.blockers.some(b => b.includes('GitHub Actions')), j.blockers.join(' | '));
    assert.equal(j.triggered, false); // dry-run — đúng MỘT lần khi chạy thật
  } finally { rmSB(sb); rmGh(ghDir); }
});

test('#6 check (gh context): production KHÁC đang chạy => DO_NOTHING (không trigger)', () => {
  const ghDir = mkFakeGh(); const sb = mkSB();
  try {
    resetCore(sb);
    setState(sb, { last_cycle_summary: { published: ['A00001'], blocked: [],
      finished_at: new Date(Date.now() - 130 * 60000).toISOString() } });
    const r = A6(sb, ['check', '--skip-git', '--dry-run'],
      ghEnv(ghDir, { in_progress: { runs: [ghRun(555)] } }, { GITHUB_RUN_ID: '999' }));
    const j = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1));
    assert.equal(j.action, 'DO_NOTHING');
    assert.ok(j.blockers.some(b => b.includes('chưa hoàn tất')));
  } finally { rmSB(sb); rmGh(ghDir); }
});

test('#6 check (gh context): production đã XẾP HÀNG (queued) => KHÔNG dispatch trùng', () => {
  const ghDir = mkFakeGh(); const sb = mkSB();
  try {
    resetCore(sb);
    setState(sb, { last_cycle_summary: { published: ['A00001'], blocked: [],
      finished_at: new Date(Date.now() - 130 * 60000).toISOString() } });
    const r = A6(sb, ['check', '--skip-git', '--dry-run'],
      ghEnv(ghDir, { queued: { runs: [ghRun(777, 'Factory production', 'queued')] } }, { GITHUB_RUN_ID: '999' }));
    const j = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1));
    assert.equal(j.action, 'DO_NOTHING');
    assert.ok(j.blockers.some(b => b.includes('chưa hoàn tất')));
  } finally { rmSB(sb); rmGh(ghDir); }
});

test('#6 check (gh context): API lỗi => fail-closed, KHÔNG trigger', () => {
  const ghDir = mkFakeGh(); const sb = mkSB();
  try {
    resetCore(sb);
    setState(sb, { last_cycle_summary: { published: ['A00001'], blocked: [],
      finished_at: new Date(Date.now() - 130 * 60000).toISOString() } });
    const r = A6(sb, ['check', '--skip-git', '--dry-run'],
      ghEnv(ghDir, {}, { FAKE_GH_FAIL: '1', GITHUB_RUN_ID: '999' }));
    const j = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1));
    assert.equal(j.action, 'DO_NOTHING');
    assert.ok(j.blockers.some(b => b.includes('fail-closed')));
  } finally { rmSB(sb); rmGh(ghDir); }
});

// =====================================================================
// INTEGRATION — #4 repair + #5 supervisor (sandbox CLI), pipeline PAUSED
// =====================================================================
test('#4: txn-stuck => repair deterministic + regression + SUCCESS; GIỮ lock cho #5; dedop run_id', () => {
  const sb = mkSB();
  try {
    resetCore(sb); clearMaint(sb);
    setTxn(sb, 'TX-STUCK-1', 'prepare-next');
    const r = A4(sb, ['repair', '--source', 'workflow_run', '--run-id', 'run-100', '--job', 'pipeline', '--reason', 'runner chết']);
    assert.equal(r.rc, 0);
    assert.equal(grab(r.out, 'AGENT4_RESULT'), 'SUCCESS');
    const incId = grab(r.out, 'AGENT4_INCIDENT_ID');
    assert.ok(incId);
    const inc = readJSON(incPath(sb, incId));
    assert.equal(inc.final.status, 'SUCCESS');
    assert.ok(inc.actions.some(a => a.action === 'repair:txn-stuck'));
    assert.ok(inc.actions.some(a => a.action.startsWith('regression')));
    assert.equal(readJSON(txPath(sb)).active, false); // txn đã được recover
    // lock GIỮ NGUYÊN cho #5 handoff (không release sớm)
    assert.equal(maintHeld(sb), true);
    assert.equal(readJSON(maintPath(sb)).holder, 'agent-4');
    // dedup: cùng run_id => REFUSED, KHÔNG incident mới
    const r2 = A4(sb, ['repair', '--source', 'workflow_run', '--run-id', 'run-100']);
    assert.equal(grab(r2.out, 'AGENT4_RESULT'), 'REFUSED_DEDUP');
    assert.equal(fs.readdirSync(INCIDENTS(sb)).length, 1);
  } finally { rmSB(sb); }
});

test('#4: lock bận (incident khác) => DEFERRED — KHÔNG sửa, KHÔNG bypass', () => {
  const sb = mkSB();
  try {
    resetCore(sb); clearMaint(sb);
    setTxn(sb, 'TX-KEEP', 'prepare-next');
    setMaint(sb, 'agent-5', 'INC-OTHER', 30);
    const r = A4(sb, ['repair', '--source', 'manual', '--run-id', 'run-101']);
    assert.equal(grab(r.out, 'AGENT4_RESULT'), 'DEFERRED_LOCK_BUSY');
    assert.equal(readJSON(txPath(sb)).active, true); // KHÔNG đụng gì cả
    assert.equal(readJSON(maintPath(sb)).incident_id, 'INC-OTHER'); // lock nguyên vẹn
  } finally { rmSB(sb); }
});

test('#4: circuit breaker — 2 incident FAILED_PAUSED gần đây => REFUSED (không loop repair)', () => {
  const sb = mkSB();
  try {
    resetCore(sb); clearMaint(sb);
    mkIncident(sb, 'INC-F1', 'run-201', 'FAILED_PAUSED');
    mkIncident(sb, 'INC-F2', 'run-202', 'FAILED_PAUSED');
    setTxn(sb, 'TX-STUCK-2', 'prepare-next');
    const r = A4(sb, ['repair', '--source', 'workflow_run', '--run-id', 'run-203']);
    assert.equal(grab(r.out, 'AGENT4_RESULT'), 'REFUSED_BREAKER');
    assert.equal(readJSON(txPath(sb)).active, true); // không sửa gì
    assert.equal(maintHeld(sb), false);
  } finally { rmSB(sb); }
});

test('#5: REFUSE khi #4 vẫn giữ lock và incident chưa final — KHÔNG sửa đồng thời', () => {
  const sb = mkSB();
  try {
    resetCore(sb); clearMaint(sb);
    mkIncident(sb, 'INC-RUNNING', 'run-300', null); // chưa final
    setMaint(sb, 'agent-4', 'INC-RUNNING', 30);
    const r = A5(sb, ['run', '--incident', 'INC-RUNNING']);
    assert.equal(r.rc, 1);
    assert.ok(r.out.includes('KHÔNG sửa đồng thời'));
    assert.equal(readJSON(maintPath(sb)).holder, 'agent-4'); // lock không bị giành
  } finally { rmSB(sb); }
});

test('#5: REFUSE khi maintenance lock thuộc incident khác — không bypass lock', () => {
  const sb = mkSB();
  try {
    resetCore(sb); clearMaint(sb);
    mkIncident(sb, 'INC-MINE', 'run-301', 'ESCALATE');
    setMaint(sb, 'agent-4', 'INC-OTHER', 30);
    const r = A5(sb, ['run', '--incident', 'INC-MINE']);
    assert.equal(r.rc, 1);
    assert.ok(r.out.includes('incident khác'));
    assert.equal(readJSON(maintPath(sb)).incident_id, 'INC-OTHER');
  } finally { rmSB(sb); }
});

test('#5 (mode verify sau SUCCESS): verify độc lập khoẻ => release lock + resume MỘT entrypoint + conclude XANH', () => {
  const sb = mkSB();
  try {
    resetCore(sb); clearMaint(sb);
    setTxn(sb, 'TX-STUCK-3', 'prepare-next');
    const r4 = A4(sb, ['repair', '--source', 'workflow_run', '--run-id', 'run-400']);
    const incId = grab(r4.out, 'AGENT4_INCIDENT_ID');
    assert.equal(grab(r4.out, 'AGENT4_RESULT'), 'SUCCESS');
    // #5 takeover + verify + resume (WRITER_RUNTIME off => idle-stop an toàn)
    const r5 = A5(sb, ['run', '--incident', incId], { WRITER_RUNTIME: 'off' });
    assert.equal(r5.rc, 0);
    assert.ok(r5.out.includes('AGENT5_RESULT=VERIFIED_RESUMED'));
    const inc = readJSON(incPath(sb, incId));
    assert.equal(inc.final.status, 'VERIFIED_RESUMED');
    assert.ok(inc.actions.some(a => a.actor === 'agent-5' && a.action === 'takeover-maintenance-lock'));
    assert.ok(inc.actions.some(a => a.actor === 'agent-5' && a.action === 'resume-production'));
    assert.equal(maintHeld(sb), false); // lock đã release
    // resume đã chạy entrypoint pipeline cycle: state được tạo + refill queue
    const st = readJSON(statePath(sb));
    assert.ok(Array.isArray(st.pending) && st.pending.length > 0);
    const rc = A5(sb, ['conclude', '--incident', incId]).rc;
    assert.equal(rc, 0);
  } finally { rmSB(sb); }
});

test('#5 (mode redesign sau ESCALATE): writer-lock hết TTL giữa #4 và #5 => đúng MỘT lần second-line sửa được => VERIFIED_RESUMED', () => {
  const sb = mkSB();
  try {
    resetCore(sb); clearMaint(sb);
    // #4 thấy ownership-unclear (txn active + writer-lock còn hiệu lực) => ESCALATE
    setTxn(sb, 'TX-STUCK-4', 'publish');
    setWriterLock(sb, 'writer-run-old', 25);
    const r4 = A4(sb, ['repair', '--source', 'workflow_run', '--run-id', 'run-500', '--reason', 'crash']);
    const incId = grab(r4.out, 'AGENT4_INCIDENT_ID');
    assert.equal(grab(r4.out, 'AGENT4_RESULT'), 'ESCALATE');
    // TTL writer-lock trôi qua giữa #4 và #5 => ownership rõ ràng (stale)
    setWriterLock(sb, 'writer-run-old', -5);
    const r5 = A5(sb, ['run', '--incident', incId], { WRITER_RUNTIME: 'off' });
    assert.ok(r5.out.includes('AGENT5_RESULT=VERIFIED_RESUMED'), r5.out);
    const inc = readJSON(incPath(sb, incId));
    assert.ok(inc.actions.some(a => a.actor === 'agent-5' && /second-line-repair/.test(a.action)));
    assert.equal(readJSON(txPath(sb)).active, false);
    assert.equal(maintHeld(sb), false);
  } finally { rmSB(sb); }
});

test('#5 (mode redesign): ownership VẪN không rõ => FAILED_PAUSED — pause lock + state flag + report human + conclude ĐỎ, KHÔNG sửa gì mù', () => {
  const sb = mkSB();
  try {
    resetCore(sb); clearMaint(sb);
    setTxn(sb, 'TX-STUCK-5', 'publish');
    setWriterLock(sb, 'writer-run-live', 25); // còn sống — #4 và #5 đều không được đụng
    const r4 = A4(sb, ['repair', '--source', 'workflow_run', '--run-id', 'run-600']);
    const incId = grab(r4.out, 'AGENT4_INCIDENT_ID');
    assert.equal(grab(r4.out, 'AGENT4_RESULT'), 'ESCALATE');
    const r5 = A5(sb, ['run', '--incident', incId]);
    assert.ok(r5.out.includes('AGENT5_RESULT=FAILED_PAUSED'), r5.out);
    // (a) production GIỮ pause: maintenance lock active, holder agent-5
    assert.equal(maintHeld(sb), true);
    assert.equal(readJSON(maintPath(sb)).holder, 'agent-5');
    // (b) durable pause flag cho #6
    const st = readJSON(statePath(sb));
    assert.equal(st.pause && st.pause.by, 'agent-5');
    assert.ok(st.stopped_reason && st.stopped_reason.includes(incId));
    // (c) report human-readable
    assert.ok(fs.existsSync(path.join(INCIDENTS(sb), incId + '.md')));
    // (d) KHÔNG sửa state mù: txn + writer-lock nguyên vẹn (bảo toàn checkpoints)
    assert.equal(readJSON(txPath(sb)).active, true);
    assert.equal(readJSON(wlPath(sb)).holder, 'writer-run-live');
    // (e) conclude => exit 1 (STOP, chờ human)
    assert.equal(A5(sb, ['conclude', '--incident', incId]).rc, 1);
    // (f) #6 passive khi #5 giữ pause lock + pause flag
    const r6 = A6(sb, ['check', '--skip-git', '--dry-run']);
    const j6 = JSON.parse(r6.out.slice(r6.out.indexOf('{'), r6.out.lastIndexOf('}') + 1));
    assert.equal(j6.action, 'DO_NOTHING');
    assert.ok(j6.blockers.some(b => b.includes('maintenance lock')));
    assert.ok(j6.blockers.some(b => b.toLowerCase().includes('pause')));
  } finally { rmSB(sb); }
});

test('production pause: maintenance lock held => pipeline.js cycle PAUSED (exit 0, KHÔNG mutate) —KHÔNG tạo cycle trùng', () => {
  const sb = mkSB();
  try {
    resetCore(sb); clearMaint(sb);
    setState(sb, { cycle: 0 });
    setMaint(sb, 'agent-4', 'INC-PAUSE', 30);
    const r = PIPE(sb, ['cycle']);
    assert.equal(r.rc, 0);
    assert.ok(r.out.includes('PIPELINE PAUSED'));
    // KHÔNG claim/viết/publish: state KHÔNG đổi (cycle vẫn 0, không active)
    const st = readJSON(statePath(sb));
    assert.equal(st.cycle, 0);
    assert.equal(st.active, null);
    // bỏ lock => cycle chạy lại bình thường (resume sau repair)
    clearMaint(sb);
    const r2 = PIPE(sb, ['cycle'], { WRITER_RUNTIME: 'off' });
    assert.ok(r2.out.includes('PIPELINE IDLE') || r2.out.includes('PIPELINE CYCLE'));
  } finally { rmSB(sb); }
});

test('không cycle trùng: coordinator lock còn hiệu lực => pipeline SKIP — #6 cũng DO NOTHING', () => {
  const sb = mkSB();
  try {
    resetCore(sb); clearMaint(sb);
    setState(sb, { cycle: 0 });
    fs.mkdirSync(path.dirname(coordPath(sb)), { recursive: true });
    fs.writeFileSync(coordPath(sb), JSON.stringify({ locked: true, holder: 'pipeline-run-1',
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 20 * 60000).toISOString() }, null, 2));
    const r = PIPE(sb, ['cycle']);
    assert.equal(r.rc, 0);
    assert.ok(r.out.includes('PIPELINE SKIP')); // coordinator thứ 2 bị từ chối
    const r6 = A6(sb, ['check', '--skip-git', '--dry-run']);
    const j6 = JSON.parse(r6.out.slice(r6.out.indexOf('{'), r6.out.lastIndexOf('}') + 1));
    assert.equal(j6.action, 'DO_NOTHING'); // #6 không đạp vào cycle đang chạy
    assert.ok(j6.blockers.some(b => b.includes('coordinator lock')));
  } finally { rmSB(sb); }
});
