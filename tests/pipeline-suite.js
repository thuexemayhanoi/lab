#!/usr/bin/env node
/**
 * pipeline-suite.js — kiểm thử pipeline viết bài tự động (scripts/factory/
 * pipeline.js + scripts/factory/writer-adapter.js), docs/PIPELINE.md.
 *
 * ISOLATION: mọi lệnh `cycle`/`refill` chạy trong SANDBOX đầy đủ (os.tmpdir,
 * copy của repo, shards được assemble thành content-matrix.csv đơn, _drafts và
 * pipeline/ bị loại để fixture kiểm soát hoàn toàn cây làm việc). Sandbox dùng
 * bản sao scripts của chính nó (scripts resolve ROOT từ __dirname) — cây
 * production KHÔNG BAO GIỜ bị đụng tới.
 *
 * MEMORY GUARD: suite chạy nhiều cycle e2e; mỗi cycle spawn pipeline+operator+
 * build-site. Trên môi trường bị giới hạn bộ nhớ (~1GB cgroup), heap của test
 * process phải được hồi thu giữa các test (beforeEach global.gc) — selftest
 * chạy với NODE_OPTIONS=--expose-gc (xem pipeline.js cmdSelftest).
 *
 * MOCK WRITER chỉ được bật qua PIPELINE_ALLOW_MOCK=1 (giống selftest):
 * `node scripts/factory/pipeline.js selftest`. Không có biến này, mọi đường
 * chạy mock phải REFUSED (fail-closed — mock prose không bao giờ ra production).
 */
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
// OOM-guard: hồi thu heap của test process giữa các test để footprint đồng
// thời (test + pipeline + operator + build-site) không vượt giới hạn cgroup.
beforeEach(() => { if (typeof global.gc === 'function') global.gc(); });
// OOM-guard: parse 10k dòng ≈ 86MB heap — chỉ giữ MỘT slot (sandbox gần nhất),
// giải phóng sau mỗi test để suite không tích tụ parses của nhiều sandbox.
afterEach(() => { _rowCacheSlot = null; if (typeof global.gc === 'function') global.gc(); });
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

// ---- module under test (pure imports — chỉ đọc config, không mutate) ----
const adapter = require(path.join(ROOT, 'scripts', 'factory', 'writer-adapter.js'));
const pipelineMod = require(path.join(ROOT, 'scripts', 'factory', 'pipeline.js'));

// ---------------- csv helpers (quote-aware, giống test-suite.js) ------------
function parseLine(l) { const out = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) { const c = l[i];
    if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } }
  out.push(cur); return out; }
function parseCSV(text) { const L = text.split('\n'); const H = parseLine(L[0]);
  return L.slice(1).filter(l => l.trim()).map(l => { const c = parseLine(l); const o = {}; H.forEach((h, i) => o[h] = c[i] || ''); return o; }); }
let _rowCacheSlot = null; // single-slot (một sandbox — KHÔNG tích luỹ nhiều sandbox)
function rowsOf(sb) { // cache theo mtime — tránh parse lại 10k dòng cho mỗi id lookup
  const f = path.join(sb, 'data', 'content-matrix.csv');
  const mtime = fs.statSync(f).mtimeMs;
  if (_rowCacheSlot && _rowCacheSlot.sb === sb && _rowCacheSlot.mtime === mtime) return _rowCacheSlot.rows;
  const rows = parseCSV(fs.readFileSync(f, 'utf8'));
  _rowCacheSlot = { sb, mtime, rows };
  return rows;
}
function statusOf(sb, id) { const r = rowsOf(sb).find(x => x.article_id === id); return r && r.status; }

// ------------------------------ sandbox ------------------------------------
let sbSeq = 0;
function mkSB(cfgOverrides) {
  const SB = path.join(os.tmpdir(), 'lab-pipeline-sb-' + process.pid + '-' + (++sbSeq));
  fs.rmSync(SB, { recursive: true, force: true });
  fs.cpSync(ROOT, SB, { recursive: true, filter: s => {
    const rel = path.relative(ROOT, s);
    return rel !== '_drafts' && !rel.startsWith('_drafts' + path.sep)
      && rel !== 'pipeline' && !rel.startsWith('pipeline' + path.sep)
      && !path.basename(s).startsWith('content-matrix.csv.part');
  } });
  const parts = fs.readdirSync(DATA).filter(f => /^content-matrix\.csv\.part/.test(f)).sort();
  if (parts.length) fs.writeFileSync(path.join(SB, 'data', 'content-matrix.csv'),
    parts.map(p => fs.readFileSync(path.join(DATA, p), 'utf8')).join(''));
  if (cfgOverrides) {
    const c = JSON.parse(fs.readFileSync(path.join(SB, 'config', 'pipeline.json'), 'utf8'));
    fs.writeFileSync(path.join(SB, 'config', 'pipeline.json'), JSON.stringify(Object.assign({}, c, cfgOverrides), null, 2));
  }
  return SB;
}
const rmSB = sb => fs.rmSync(sb, { recursive: true, force: true });
// chạy pipeline.js CỦA SANDBOX (ROOT của nó là sandbox — không phải cây này)
const PIPE = (sb, args, env) => spawnSync(process.execPath,
  [path.join(sb, 'scripts', 'factory', 'pipeline.js'), ...args],
  { cwd: sb, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    // OOM-guard: giới hạn heap của pipeline + mọi process con (operator,
    // build-site) trên môi trường ~1GB — GC chủ động thay vì rss phình to.
    env: Object.assign({}, process.env,
      { NODE_OPTIONS: ((process.env.NODE_OPTIONS || '') + ' --max-old-space-size=448').trim() }, env || {}) });
const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const stateOf = sb => readJSON(path.join(sb, 'data', 'state', 'pipeline-state.json'));
const ckptOf = sb => readJSON(path.join(sb, 'data', 'state', 'checkpoint.json'));
const ledgerOf = sb => readJSON(path.join(sb, 'data', 'state', 'throughput-ledger.json'));
const publishCountFor = (sb, id) => ledgerOf(sb).events
  .filter(e => e.op === 'publish' && Array.isArray(e.ids) && e.ids.includes(id)).length;
const txnActive = sb => readJSON(path.join(sb, 'data', 'state', 'transaction.json')).active;
const writerLockHeld = sb => readJSON(path.join(sb, 'data', 'state', 'writer-lock.json')).locked;
const coordLock = sb => readJSON(path.join(sb, 'pipeline', 'lock.json'));
const matrixBytes = sb => fs.readFileSync(path.join(sb, 'data', 'content-matrix.csv'));
function expireCoordLock(sb) { // mô phỏng TTL 30' trôi qua sau runner chết
  const p = path.join(sb, 'pipeline', 'lock.json');
  const l = readJSON(p); l.expires_at = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(p, JSON.stringify(l, null, 2));
}
const MOCK_ENV = { WRITER_RUNTIME: 'mock', PIPELINE_ALLOW_MOCK: '1' };

// =====================================================================
// UNIT — writer-adapter.js
// =====================================================================
test('adapter: resolveRuntime — off mặc định, http cần endpoint, mock cần PIPELINE_ALLOW_MOCK (fail-closed)', () => {
  assert.equal(adapter.resolveRuntime({}).mode, 'off');
  assert.equal(adapter.resolveRuntime({ WRITER_RUNTIME: 'off' }).mode, 'off');
  const noEp = adapter.resolveRuntime({ WRITER_RUNTIME: 'http' });
  assert.equal(noEp.mode, 'off'); // endpoint rỗng => idle-stop, KHÔNG viết
  assert.match(noEp.reason, /WRITER_ENDPOINT/);
  const http = adapter.resolveRuntime({ WRITER_RUNTIME: 'http', WRITER_ENDPOINT: 'https://writer.example/run', WRITER_API_KEY: 'k' });
  assert.equal(http.mode, 'http'); assert.equal(http.endpoint, 'https://writer.example/run');
  assert.equal(http.apiKey, 'k');
  assert.throws(() => adapter.resolveRuntime({ WRITER_RUNTIME: 'http', WRITER_ENDPOINT: 'ftp://x' }), /http\(s\)/);
  assert.throws(() => adapter.resolveRuntime({ WRITER_RUNTIME: 'mock' }), /PIPELINE_ALLOW_MOCK/);
  assert.throws(() => adapter.resolveRuntime({ WRITER_RUNTIME: 'mock' }), /REFUSED/);
  assert.equal(adapter.resolveRuntime({ WRITER_RUNTIME: 'mock', PIPELINE_ALLOW_MOCK: '1' }).mode, 'mock');
  assert.throws(() => adapter.resolveRuntime({ WRITER_RUNTIME: 'bogus' }), /không hỗ trợ/);
});

test('adapter: runTask mock — chỉ ghi artifact trong workspace writer (isolation), đúng flavour theo vòng', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-writer-ws-'));
  try {
    const row = { article_id: 'A99999', primary_keyword: 'thue xe may quan Hoan Kiem', search_intent: 'informational', parent_topic: 'Thuê xe máy' };
    const tmpBefore = fs.readdirSync(os.tmpdir()).sort();
    // research: packet đầy đủ trường, viết VÀO outDir
    const rp = await adapter.runTask({ task: 'research', row, outDir: ws, runtime: { mode: 'mock' } });
    assert.equal(rp.kind, 'packet');
    assert.equal(path.dirname(rp.path), ws, 'artifact chỉ được ghi trong workspace writer');
    const packet = readJSON(rp.path);
    for (const f of adapter.RESEARCH_FIELDS) assert.ok(f in packet, 'packet thiếu ' + f);
    // write vòng đầu: body_v1 — ngắn, KHÔNG h1 => QA sẽ chấm REVIEW/REPAIR
    const r1 = await adapter.runTask({ task: 'write', row, outDir: ws, runtime: { mode: 'mock' } });
    const v1 = fs.readFileSync(r1.path, 'utf8');
    assert.ok(!/<h1/.test(v1), 'body_v1 phải thiếu h1 (đưa repair loop vào đường chạy thật)');
    assert.ok(v1.length < 2000, 'body_v1 phải ngắn');
    // revise: body_v2 — đủ dài, có h1, >=3 internal links, KHÔNG chữ số (grounding an toàn)
    const r2 = await adapter.runTask({ task: 'revise', row, outDir: ws, runtime: { mode: 'mock' } });
    const v2 = fs.readFileSync(r2.path, 'utf8');
    assert.ok(/<h1/.test(v2));
    assert.ok((v2.match(/href="\//g) || []).length >= 3, 'body_v2 phải có >=3 internal links');
    assert.ok(!/\d/.test(v2.replace(/<[^>]+>/g, ' ').replace(/href="[^"]*"/g, '')), 'mock prose không chứa chữ số (grounding không thể vi phạm)');
    // FAIL_ALWAYS: revise vẫn trả body_v1 => bounded retry => BLOCKED (test e2e riêng)
    process.env.PIPELINE_MOCK_FAIL_ALWAYS = '1';
    try {
      const r3 = await adapter.runTask({ task: 'revise', row, outDir: ws, runtime: { mode: 'mock' } });
      assert.ok(!/<h1/.test(fs.readFileSync(r3.path, 'utf8')), 'FAIL_ALWAYS: revise vẫn hỏng');
    } finally { delete process.env.PIPELINE_MOCK_FAIL_ALWAYS; }
    // isolation: mọi artifact nằm trong ws; tmpdir không có file/dir mới nào ngoài ws
    assert.deepEqual(fs.readdirSync(ws).sort(), ['A99999.body.html', 'A99999.packet.json']);
    const tmpAfter = fs.readdirSync(os.tmpdir()).filter(f => f !== path.basename(ws)).sort();
    assert.deepEqual(tmpAfter, tmpBefore.filter(f => f !== path.basename(ws)), 'adapter KHÔNG ghi gì ngoài workspace writer');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// =====================================================================
// UNIT — pipeline.js (hàm thuần)
// =====================================================================
test('pipeline unit: grantsOf chia đều 3 writer, mỗi id đúng 1 lần, deterministic', () => {
  const ids = Array.from({ length: 12 }, (_, i) => 'A' + String(100 + i).padStart(5, '0'));
  const g = pipelineMod.grantsOf(ids, 3);
  assert.equal(Object.keys(g).length, 12);
  const byW = { w1: [], w2: [], w3: [] };
  for (const [id, w] of Object.entries(g)) byW[w].push(id);
  assert.deepEqual(Object.keys(byW).sort(), ['w1', 'w2', 'w3']);
  for (const w of Object.keys(byW)) assert.equal(byW[w].length, 4, w + ' phải nhận 4 bài');
  assert.deepEqual(pipelineMod.grantsOf(ids, 3), g, 'phải deterministic');
});

test('pipeline unit: chunk chia đúng kích thước, phần dư ở chunk cuối', () => {
  assert.deepEqual(pipelineMod.chunk([1, 2, 3, 4, 5, 6, 7], 2), [[1, 2], [3, 4], [5, 6], [7]]);
  assert.deepEqual(pipelineMod.chunk([], 10), []);
});

test('pipeline config: pipeline.json hợp lệ và nằm trong giới hạn engine', () => {
  const c = readJSON(path.join(ROOT, 'config', 'pipeline.json'));
  assert.equal(c.queue_refill_target, 300);
  assert.ok(c.queue_refill_min >= 0 && c.queue_refill_min < c.queue_refill_target);
  assert.equal(c.writers, 3);
  assert.ok(c.cycle_batch_min >= 12 && c.cycle_batch_max <= 18, 'mỗi cycle cấp 12..18 bài');
  const eng = readJSON(path.join(ROOT, 'config', 'content-factory.json'));
  assert.ok(c.cycle_batch_max <= (eng.QUEUE_MAX || 20), 'batch phải nằm trong QUEUE_MAX của engine');
  assert.ok(c.publish_chunk <= (eng.CHUNK || 10), 'publish chunk phải nằm trong CHUNK của engine');
  assert.ok(c.writer_retries >= 1 && c.writer_retries <= 3);
  assert.ok(c.lock_ttl_minutes > 0);
});

// =====================================================================
// WORKFLOW pin — kích hoạt & an toàn của coordinator trong CI
// =====================================================================
test('workflow: factory-production.yml kích hoạt pipeline đúng (cron 30 phút, job pipeline, an toàn)', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'factory-production.yml'), 'utf8');
  assert.match(yml, /cron: '\*\/30 \* \* \* \*'/, 'schedule mỗi 30 phút');
  assert.match(yml, /concurrency:/);
  assert.match(yml, /lab-factory-production/);
  assert.match(yml, /cancel-in-progress: false/);
  const m = /  pipeline:\n([\s\S]*)/.exec(yml);
  assert.ok(m, 'workflow phải có job pipeline');
  const job = m[1];
  assert.match(job, /node scripts\/factory\/pipeline\.js cycle/);
  assert.match(job, /github\.event_name == 'schedule'/);
  assert.match(job, /inputs\.action == 'pipeline'/);
  assert.ok(!/push -f|--force\b/.test(yml), 'KHÔNG force push');
  // push job (writer _drafts) KHÔNG chạy trên schedule — pipeline là job duy nhất của cron
  const pm = /  publish:\n([\s\S]*?)(\n  \w+:|\s*$)/.exec(yml);
  assert.ok(pm, 'workflow phải có job publish');
  assert.match(pm[1], /github\.event_name == 'push'/, 'publish job phải là ALLOWLIST: chỉ push draft');
  assert.match(pm[1], /inputs\.action == 'status'/, 'publish job nhận maintenance dispatch status');
  assert.match(pm[1], /inputs\.action == 'recover'/, 'publish job nhận maintenance dispatch recover');
  assert.match(pm[1], /inputs\.action == 'diagnostics'/, 'publish job nhận maintenance dispatch diagnostics');
  assert.doesNotMatch(pm[1], /github\.event_name != /, 'KHÔNG còn denylist — routing phải là allowlist rõ ràng');
  assert.match(yml, /paths: \['_drafts\/\*\*'\]/, 'push trigger chỉ _drafts');
});

// =====================================================================
// WORKFLOW ROUTING — evaluate điều kiện `if` THẬT của từng job cho mọi
// event (KHÔNG chỉ grep): push draft, dispatch status/recover/diagnostics/
// pipeline/selftest/repair/watchdog, workflow_run failure, 2 cron — mỗi
// event chỉ đến đúng job của nó.
// =====================================================================
function wfJobsIf() { // trích {job: if-expression} từ factory-production.yml
  const lines = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'factory-production.yml'), 'utf8').split('\n');
  const jobs = {}; let inJobs = false, cur = null, fold = null;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    const jm = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jm) { cur = jm[1]; jobs[cur] = null; fold = null; continue; }
    if (!cur) continue;
    const ifInline = /^    if: (.+)$/.exec(line);
    if (ifInline && jobs[cur] === null && !/^    if: >-\s*$/.test(line)) { jobs[cur] = ifInline[1].trim(); fold = null; continue; }
    if (/^    if: >-\s*$/.test(line) && jobs[cur] === null) { fold = []; continue; }
    if (fold !== null) {
      const fm = /^      (.+)$/.exec(line);
      if (fm) { fold.push(fm[1].trim()); continue; }
      jobs[cur] = fold.join(' '); fold = null; continue; // hết folded scalar
    }
  }
  if (fold !== null && cur) jobs[cur] = fold.join(' ');
  for (const [k, v] of Object.entries(jobs))
    assert.ok(typeof v === 'string' && v.length > 0, 'job ' + k + ' phải có điều kiện if parse được (got: ' + v + ')');
  return jobs;
}
function evalGhExpr(expr, ctx) { // subset: == != && || ! ( ) 'string' a.b.c
  const toks = []; let rest = expr;
  const TOK = /^(\s*)('(?:[^']*)'|&&|\|\||==|!=|[()]|!|[A-Za-z_][A-Za-z0-9_.-]*)/;
  while (rest.length) {
    const m = TOK.exec(rest);
    if (!m || m[0].trim() === '') throw new Error('token không parse được: ' + JSON.stringify(rest.slice(0, 30)));
    if (m[0].trim()) toks.push(m[0].trim());
    rest = rest.slice(m[0].length);
  }
  let p = 0;
  const peek = () => toks[p], eat = () => toks[p++];
  const resolve = name => {
    if (name === 'null' || name === 'true' || name === 'false') return JSON.parse(name);
    let v = ctx;
    for (const part of name.split('.')) v = (v == null) ? null : v[part];
    return v === undefined ? null : v;
  };
  function primary() {
    const t = eat();
    if (t === '(') { const v = or(); const c = eat(); if (c !== ')') throw new Error('thiếu )'); return v; }
    if (t === '!') return !truthy(primary());
    if (/^'/.test(t)) return t.slice(1, -1);
    return resolve(t);
  }
  const truthy = v => v !== null && v !== false && v !== '' && v !== 0;
  function cmp() {
    let l = primary();
    while (peek() === '==' || peek() === '!=') {
      const op = eat(); const r = primary();
      l = op === '==' ? String(l) === String(r) : String(l) !== String(r);
    }
    return l;
  }
  function and() { let l = cmp(); while (peek() === '&&') { eat(); const r = cmp(); l = truthy(l) && truthy(r); } return l; }
  function or() { let l = and(); while (peek() === '||') { eat(); const r = and(); l = truthy(l) || truthy(r); } return l; }
  const val = or();
  if (p !== toks.length) throw new Error('token dư ở ' + p + ': ' + toks.slice(p).join(' '));
  return truthy(val);
}
const GH_REPO = 'thuexemayhanoi/lab';
function routeCtx(ctx) { // ctx = {event_name, schedule?, action?, workflow_run?, needs?}
  return { github: Object.assign({ repository: GH_REPO, event_name: ctx.event_name,
      event: ctx.schedule ? { schedule: ctx.schedule } : ctx.workflow_run || {} }, ctx.github || {}),
    inputs: { action: ctx.action || null }, needs: ctx.needs || {} };
}
function routeAll(ctx) {
  const jobs = wfJobsIf();
  const gh = routeCtx(ctx);
  const out = {};
  for (const [job, expr] of Object.entries(jobs)) out[job] = evalGhExpr(expr, gh);
  return out;
}
test('workflow routing: mỗi event đến ĐÚNG job (evaluate if thật của cả 5 job)', () => {
  const only = (o, jobs) => { // đúng các job trong `jobs` chạy, còn lại KHÔNG
    const run = Object.keys(o).filter(k => o[k]);
    assert.deepStrictEqual(run.sort(), [...jobs].sort(),
      'event ' + JSON.stringify(ctxOf) + ' phải chạy đúng ' + JSON.stringify(jobs) + ' (got: ' + run.join(',') + ')');
  };
  let ctxOf;
  // push draft → publish
  ctxOf = { event_name: 'push' }; only(routeAll(ctxOf), ['publish']);
  // dispatch maintenance → publish (job bảo trì)
  for (const a of ['status', 'recover', 'diagnostics']) {
    ctxOf = { event_name: 'workflow_dispatch', action: a }; only(routeAll(ctxOf), ['publish']);
  }
  // dispatch pipeline | selftest → pipeline
  for (const a of ['pipeline', 'selftest']) {
    ctxOf = { event_name: 'workflow_dispatch', action: a }; only(routeAll(ctxOf), ['pipeline']);
  }
  // dispatch watchdog → agent-watchdog
  ctxOf = { event_name: 'workflow_dispatch', action: 'watchdog' }; only(routeAll(ctxOf), ['agent-watchdog']);
  // dispatch repair → agent-repair (#5 theo KẾT QUẢ outputs của #4, không phải event)
  ctxOf = { event_name: 'workflow_dispatch', action: 'repair' }; only(routeAll(ctxOf), ['agent-repair']);
  //   ... #4 SUCCESS|ESCALATE + job xanh => #5 chạy
  const needsOk = { 'agent-repair': { result: 'success', outputs: { result: 'SUCCESS', incident_id: 'INC-1' } } };
  const withSup = routeAll({ event_name: 'workflow_dispatch', action: 'repair', needs: needsOk });
  assert.equal(withSup['agent-supervisor'], true);
  const needsRefused = { 'agent-repair': { result: 'success', outputs: { result: 'REFUSED_DEDUP', incident_id: 'none' } } };
  assert.equal(routeAll({ event_name: 'workflow_dispatch', action: 'repair', needs: needsRefused })['agent-supervisor'], false);
  // workflow_run failure của Factory production trên main → CHỈ agent-repair, publish KHÔNG chạy
  ctxOf = { event_name: 'workflow_run', workflow_run: { workflow_run: { conclusion: 'failure', name: 'Factory production', head_branch: 'main' } } };
  only(routeAll(ctxOf), ['agent-repair']);
  //   ... run KHÔNG fail / branch khác → không agent nào chạy
  assert.equal(routeAll({ event_name: 'workflow_run', workflow_run: { workflow_run: { conclusion: 'success', name: 'Factory production', head_branch: 'main' } } })['agent-repair'], false);
  assert.equal(routeAll({ event_name: 'workflow_run', workflow_run: { workflow_run: { conclusion: 'failure', name: 'Factory production', head_branch: 'dev' } } })['agent-repair'], false);
  // cron */30 → CHỈ pipeline (publish KHÔNG chạy trên schedule)
  ctxOf = { event_name: 'schedule', schedule: '*/30 * * * *' }; only(routeAll(ctxOf), ['pipeline']);
  // cron 10 * * * * → CHỈ agent-watchdog
  ctxOf = { event_name: 'schedule', schedule: '10 * * * *' }; only(routeAll(ctxOf), ['agent-watchdog']);
  // repo khác → KHÔNG job nào chạy
  const off = routeAll({ event_name: 'push', github: { repository: 'someone/else' } });
  assert.ok(Object.values(off).every(v => v === false), 'repo khác phải không chạy job nào');
});

// =====================================================================
// BEHAVIOR — refill (queue tự nạp ~300 topic hợp lệ)
// =====================================================================
test('refill: nạp window 300 topic PLANNED đầu theo matrix order, không trùng, idempotent, KHÔNG đổi matrix', () => {
  const SB = mkSB();
  try {
    const before = matrixBytes(SB);
    const r1 = PIPE(SB, ['refill']);
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    assert.match(r1.stdout, /đã nạp lại/);
    const rows = rowsOf(SB);
    const planned = rows.filter(r => r.status === 'PLANNED').map(r => r.article_id);
    const st = stateOf(SB);
    assert.equal(st.pending.length, 300, 'queue phải có đúng 300 topic');
    assert.equal(st.planned_total, planned.length);
    assert.deepEqual(st.pending, planned.slice(0, 300), 'queue = 300 PLANNED đầu theo matrix order');
    assert.equal(new Set(st.pending).size, 300, 'không trùng topic');
    assert.ok(!st.pending.some(id => rows.find(r => r.article_id === id).status !== 'PLANNED'), 'chỉ nhận PLANNED (không PUBLISHED/đang xử lý)');
    // idempotent: chạy lại không đổi gì, không đổi matrix
    const r2 = PIPE(SB, ['refill']);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /đủ — không đổi/);
    assert.deepEqual(stateOf(SB).pending, st.pending);
    assert.deepEqual(matrixBytes(SB), before, 'refill KHÔNG bao giờ sửa matrix');
  } finally { rmSB(SB); }
});

// =====================================================================
// BEHAVIOR — runtime off => IDLE-STOP trước khi claim (fail-closed)
// =====================================================================
test('idle: WRITER_RUNTIME chưa cấu hình => pipeline IDLE, KHÔNG claim/viết/publish, queue sẵn sàng', () => {
  const SB = mkSB();
  try {
    const before = matrixBytes(SB);
    const ckBefore = ckptOf(SB).published_count;
    const r = PIPE(SB, ['cycle'], {}); // KHÔNG có WRITER_RUNTIME
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PIPELINE IDLE/);
    assert.match(r.stdout, /KHÔNG claim, KHÔNG viết, KHÔNG publish/);
    assert.deepEqual(matrixBytes(SB), before, 'matrix phải nguyên vẹn');
    assert.equal(ckptOf(SB).published_count, ckBefore, 'published_count không đổi');
    assert.equal(txnActive(SB), false);
    assert.equal(writerLockHeld(SB), false);
    assert.equal(coordLock(SB).locked, false, 'coordinator lock phải được giải phóng sạch');
    const st = stateOf(SB);
    assert.equal(st.pending.length, 300, 'queue vẫn được refill');
    assert.equal(st.active, null, 'KHÔNG có batch nào được claim');
    assert.ok(!fs.existsSync(path.join(SB, '_drafts')), 'không draft nào được tạo');
  } finally { rmSB(SB); }
});

test('lock: coordinator lock đang giữ => SKIP sạch (exit 0), KHÔNG mutate gì', () => {
  const SB = mkSB();
  try {
    fs.mkdirSync(path.join(SB, 'pipeline'), { recursive: true });
    fs.writeFileSync(path.join(SB, 'pipeline', 'lock.json'), JSON.stringify({
      locked: true, holder: 'other-coordinator',
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 20 * 60000).toISOString() }, null, 2));
    const before = matrixBytes(SB);
    const r = PIPE(SB, ['cycle'], {});
    assert.equal(r.status, 0);
    assert.match(r.stdout, /PIPELINE SKIP/);
    assert.match(r.stdout, /coordinator lock/);
    assert.deepEqual(matrixBytes(SB), before);
    assert.equal(fs.readFileSync(path.join(SB, 'pipeline', 'lock.json'), 'utf8').includes('other-coordinator'), true, 'lock của process khác phải còn nguyên');
  } finally { rmSB(SB); }
});

test('mock guard: WRITER_RUNTIME=mock mà KHÔNG có PIPELINE_ALLOW_MOCK => REFUSED (fail-closed), matrix nguyên vẹn', () => {
  const SB = mkSB();
  try {
    const before = matrixBytes(SB);
    const r = PIPE(SB, ['cycle'], { WRITER_RUNTIME: 'mock', PIPELINE_ALLOW_MOCK: '' });
    assert.equal(r.status, 1, 'phải exit 1 — mock không bao giờ được chạy trong production');
    assert.match(r.stdout + r.stderr, /REFUSED/);
    assert.match(stateOf(SB).stopped_reason || '', /PIPELINE_ALLOW_MOCK/);
    assert.deepEqual(matrixBytes(SB), before);
    assert.equal(coordLock(SB).locked, false, 'lock phải được giải phóng kể cả khi STOP');
  } finally { rmSB(SB); }
});

// =====================================================================
// BEHAVIOR — stale-draft hygiene (không tạo content mới)
// =====================================================================
test('hygiene: stale draft của row PUBLISHED byte-identical archive => auto-clean (không publish lại gì)', () => {
  const SB = mkSB();
  try {
    const pub = rowsOf(SB).find(r => r.status === 'PUBLISHED' && fs.existsSync(path.join(SB, 'data', 'published', r.article_id + '.html')));
    assert.ok(pub, 'sandbox phải có row PUBLISHED với archive');
    const id = pub.article_id;
    fs.mkdirSync(path.join(SB, '_drafts'), { recursive: true });
    fs.copyFileSync(path.join(SB, 'data', 'published', id + '.html'), path.join(SB, '_drafts', id + '.html'));
    const before = matrixBytes(SB);
    const r = PIPE(SB, ['cycle'], {}); // runtime off vẫn phải dọn hygiene
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /đã dọn stale draft/);
    assert.equal(fs.existsSync(path.join(SB, '_drafts', id + '.html')), false, 'draft lint phải bị xóa');
    assert.deepEqual(matrixBytes(SB), before, 'hygiene KHÔNG sửa matrix');
    assert.match(r.stdout, /PIPELINE IDLE/);
  } finally { rmSB(SB); }
});

test('hygiene fail-closed: stale draft DIVERGED của row PUBLISHED => STOP, KHÔNG đè bài đã publish', () => {
  const SB = mkSB();
  try {
    const pub = rowsOf(SB).find(r => r.status === 'PUBLISHED' && fs.existsSync(path.join(SB, 'data', 'published', r.article_id + '.html')));
    const id = pub.article_id;
    fs.mkdirSync(path.join(SB, '_drafts'), { recursive: true });
    fs.writeFileSync(path.join(SB, '_drafts', id + '.html'),
      fs.readFileSync(path.join(SB, 'data', 'published', id + '.html'), 'utf8') + '\n<!-- diverged -->');
    const before = matrixBytes(SB);
    const r = PIPE(SB, ['cycle'], {});
    assert.equal(r.status, 1, 'phải STOP fail-closed');
    assert.match(r.stdout + r.stderr, /PIPELINE STOPPED/);
    assert.match(stateOf(SB).stopped_reason || '', /DIVERGED/);
    assert.equal(fs.existsSync(path.join(SB, '_drafts', id + '.html')), true, 'draft diverged PHẢI được giữ lại cho xử lý thủ công (không tự đè)');
    assert.deepEqual(matrixBytes(SB), before);
    assert.equal(fs.existsSync(path.join(SB, 'data', 'published', id + '.html')), true, 'bài đã publish nguyên vẹn');
  } finally { rmSB(SB); }
});

// =====================================================================
// E2E — 1 cycle mock đầy đủ (claim → 3 writer song song → QA sửa bài → publish đúng một lần)
// =====================================================================
test('e2e mock cycle: 6 bài, 3 writer, QA chưa-PASS→revise→PASS, publish đúng một lần, state/lock sạch', () => {
  const SB = mkSB({ cycle_batch_min: 6, cycle_batch_max: 6 });
  try {
    const ckBefore = ckptOf(SB).published_count;
    const r = PIPE(SB, ['cycle'], MOCK_ENV);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PIPELINE CYCLE COMPLETE/);
    const st = stateOf(SB);
    const batch = st.last_cycle_summary.batch;
    assert.equal(batch.length, 6);
    assert.equal(new Set(batch).size, 6);
    // mọi bài batch -> PUBLISHED, publish đúng MỘT lần mỗi id (ledger)
    for (const id of batch) {
      assert.equal(statusOf(SB, id), 'PUBLISHED', id);
      assert.equal(publishCountFor(SB, id), 1, id + ' phải publish đúng 1 lần');
      assert.equal(fs.existsSync(path.join(SB, '_drafts', id + '.html')), false, 'draft phải bị xóa sau publish');
      assert.equal(fs.existsSync(path.join(SB, '_drafts', id + '.body.html')), false);
      assert.ok(fs.existsSync(path.join(SB, 'data', 'published', id + '.html')), id + ' phải có archive');
      const ev = readJSON(path.join(SB, 'data', 'qa', id + '.json'));
      assert.equal(ev.result, 'PASS');
      assert.ok(Number(ev.score) >= 75, 'QA evidence phải >= pass_min (75), được ' + ev.score);
    }
    assert.deepEqual(st.last_cycle_summary.published.slice().sort(), batch.slice().sort());
    assert.deepEqual(st.last_cycle_summary.blocked, []);
    assert.deepEqual(st.last_cycle_summary.failed_publish, []);
    assert.equal(st.active, null, 'state.active phải sạch sau cycle');
    assert.equal(st.cycle, 1);
    assert.equal(st.stopped_reason, null);
    // đúng một lần — state trong repo khớp engine truth
    assert.equal(ckptOf(SB).published_count, ckBefore + 6);
    assert.equal(txnActive(SB), false, 'transaction phải inactive');
    assert.equal(writerLockHeld(SB), false, 'writer lock phải free');
    assert.equal(coordLock(SB).locked, false, 'coordinator lock phải free');
    // 3 writer workspace riêng — mỗi writer xử lý tuần tự 2 bài, artifact chỉ nằm dưới pipeline/writers/
    const wsRoot = path.join(SB, 'pipeline', 'writers');
    const ws = fs.readdirSync(wsRoot).sort();
    assert.deepEqual(ws, ['w1', 'w2', 'w3'], 'phải có đúng 3 writer workspace');
    for (const w of ws) {
      const files = fs.readdirSync(path.join(wsRoot, w));
      assert.equal(files.length, 4, w + ' xử lý 2 bài × (packet + body)');
      for (const f of files) assert.match(f, /^A\d{5}\.(packet\.json|body\.html)$/, 'artifact chỉ được ghi trong workspace writer');
    }
    // queue tự refill sau cycle cho cycle kế tiếp
    assert.ok(stateOf(SB).pending.length >= 100);
  } finally { rmSB(SB); }
});

// =====================================================================
// E2E — writer hỏng mọi vòng sửa => BLOCKED, KHÔNG publish (fail-closed có giới hạn)
// =====================================================================
test('e2e fail-closed: PIPELINE_MOCK_FAIL_ALWAYS => hết lượt sửa => BLOCKED, không publish gì', () => {
  const SB = mkSB({ cycle_batch_min: 3, cycle_batch_max: 3 });
  try {
    const ckBefore = ckptOf(SB).published_count;
    const r = PIPE(SB, ['cycle'], Object.assign({}, MOCK_ENV, { PIPELINE_MOCK_FAIL_ALWAYS: '1' }));
    assert.equal(r.status, 0, 'chunk phải KẾT THÚC ĐƯỢC (blocked là kết quả hợp lệ, không treo)');
    assert.match(r.stdout, /PIPELINE CYCLE COMPLETE/);
    const st = stateOf(SB);
    const batch = st.last_cycle_summary.batch;
    assert.equal(batch.length, 3);
    for (const id of batch) {
      assert.equal(statusOf(SB, id), 'BLOCKED', id);
      assert.equal(publishCountFor(SB, id), 0, id + ' KHÔNG được publish');
      assert.ok(!fs.existsSync(path.join(SB, 'data', 'published', id + '.html')), id + ' không có archive');
    }
    assert.equal(ckptOf(SB).published_count, ckBefore, 'published_count không đổi');
    assert.equal(st.active, null);
    assert.equal(txnActive(SB), false);
    assert.equal(writerLockHeld(SB), false);
    assert.equal(coordLock(SB).locked, false);
  } finally { rmSB(SB); }
});

// =====================================================================
// CRASH / RESUME — checkpoint + đúng-một-lần publish khi runner chết giữa cycle
// =====================================================================
test('crash/resume: chết sau QA vòng 1 => SKIP do lock TTL còn sống => hết TTL => resume, KHÔNG trùng bài, publish đúng 1 lần', () => {
  const SB = mkSB({ cycle_batch_min: 3, cycle_batch_max: 3 });
  try {
    // run 1: crash ngay sau QA vòng đầu (rows chưa PASS — repair loop chưa chạy)
    const r1 = PIPE(SB, ['cycle'], Object.assign({}, MOCK_ENV, { PIPELINE_CRASH_AT: 'after-qa' }));
    assert.equal(r1.status, 75, 'crash injection phải exit 75 (signal=' + r1.signal + ')');
    const st1 = stateOf(SB);
    assert.ok(st1.active, 'checkpoint phải còn active batch để resume');
    const batch = st1.active.batch;
    assert.equal(batch.length, 3);
    for (const id of batch) assert.ok(['REVIEW', 'REPAIR'].includes(statusOf(SB, id)),
      id + ' vòng QA đầu phải chưa PASS (REVIEW/REPAIR) — mock body_v1, được ' + statusOf(SB, id));
    assert.ok(coordLock(SB).locked, 'lock còn held ngay sau crash (TTL chưa hết)');
    // run 2 ngay sau đó: lock còn sống => SKIP sạch, KHÔNG mutate
    const before = matrixBytes(SB);
    const r2 = PIPE(SB, ['cycle'], MOCK_ENV);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /PIPELINE SKIP/);
    assert.deepEqual(matrixBytes(SB), before, 'SKIP không được mutate gì');
    // TTL trôi qua => resume từ checkpoint: repair -> PASS -> publish, mỗi id đúng 1 lần
    expireCoordLock(SB);
    const r3 = PIPE(SB, ['cycle'], MOCK_ENV);
    assert.equal(r3.status, 0, r3.stdout + r3.stderr);
    assert.match(r3.stdout, /PIPELINE CYCLE COMPLETE/);
    for (const id of batch) {
      assert.equal(statusOf(SB, id), 'PUBLISHED', id);
      assert.equal(publishCountFor(SB, id), 1, id + ' publish ĐÚNG MỘT LẦN qua crash+resume');
    }
    const st3 = stateOf(SB);
    assert.equal(st3.active, null);
    assert.equal(st3.cycle, st1.active.cycle, 'cycle resumed phải giữ số cycle, không claim batch mới');
    assert.equal(txnActive(SB), false);
    assert.equal(writerLockHeld(SB), false);
    assert.equal(coordLock(SB).locked, false);
  } finally { rmSB(SB); }
});

test('crash/resume mid-publish: chết giữa các publish chunk => resume publish phần còn lại, KHÔNG double-publish', () => {
  const SB = mkSB({ cycle_batch_min: 3, cycle_batch_max: 3, publish_chunk: 2 });
  try {
    const r1 = PIPE(SB, ['cycle'], Object.assign({}, MOCK_ENV, { PIPELINE_CRASH_AT: 'after-publish-chunk' }));
    assert.equal(r1.status, 75, 'crash injection phải exit 75 (error=' + (r1.error && r1.error.message) + ' signal=' + r1.signal + ')');
    const batch = stateOf(SB).active.batch;
    const publishedAtCrash = batch.filter(id => statusOf(SB, id) === 'PUBLISHED');
    assert.equal(publishedAtCrash.length, 2, 'chunk đầu (2 bài) đã publish trước khi chết');
    expireCoordLock(SB);
    const r2 = PIPE(SB, ['cycle'], MOCK_ENV);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    for (const id of batch) {
      assert.equal(statusOf(SB, id), 'PUBLISHED', id);
      assert.equal(publishCountFor(SB, id), 1, id + ' không bao giờ publish 2 lần (ledger là truth)');
    }
    const st = stateOf(SB);
    assert.equal(st.active, null);
    assert.deepEqual(st.last_cycle_summary.published.slice().sort(), batch.slice().sort());
    assert.equal(txnActive(SB), false);
    assert.equal(coordLock(SB).locked, false);
  } finally { rmSB(SB); }
});
