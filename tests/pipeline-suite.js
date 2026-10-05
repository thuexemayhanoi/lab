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
      { NODE_OPTIONS: ((process.env.NODE_OPTIONS || '') + ' --max-old-space-size=384').trim() }, env || {}) });
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
// AUDIT #4 test fixtures: pipeline xác nhận deployment từ env truth của step
// 'Pages deployment truth' (PAGES_BUILD_COMMIT/PAGES_BUILD_STATUS) + publication
// SHA. Sandbox KHÔNG có git binary nên merge-base được mock bằng
// PIPELINE_MOCK_GIT_ANCESTOR (chỉ test; production dùng git merge-base thật).
const PUB_SHA = 'e51f0a1bcyclepublication00000000000000000000';
const DEPLOY_OK = { PIPELINE_PUB_SHA: PUB_SHA, PAGES_BUILD_COMMIT: PUB_SHA, PAGES_BUILD_STATUS: 'success', PIPELINE_MOCK_GIT_ANCESTOR: '1', PIPELINE_SINGLE_CYCLE: '1' };
const DEPLOY_ERRORED = { PIPELINE_PUB_SHA: PUB_SHA, PAGES_BUILD_COMMIT: PUB_SHA, PAGES_BUILD_STATUS: 'errored', PIPELINE_MOCK_GIT_ANCESTOR: '1', PIPELINE_SINGLE_CYCLE: '1' };
const DEPLOY_WRONG_SHA = { PIPELINE_PUB_SHA: PUB_SHA, PAGES_BUILD_COMMIT: 'f00d' + PUB_SHA.slice(4), PAGES_BUILD_STATUS: 'success', PIPELINE_MOCK_GIT_ANCESTOR: '0', PIPELINE_SINGLE_CYCLE: '1' };
// delta-safe ledger counting (sandbox copy KẾ THỪA events baseline của repo —
// KHÔNG BAO GIỜ đếm tuyệt đối; luôn chụp độ dài trước rồi lấy phần mới)
const ledgerLen = sb => ledgerOf(sb).events.length;
const newPublishEvents = (sb, beforeLen) => ledgerOf(sb).events.slice(beforeLen).filter(e => e.op === 'publish');

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
  // AUDIT #3: publish_chunk đã bị XOÁ — MỘT transaction publish cho cả cycle
  assert.ok(!('publish_chunk' in c), 'publish_chunk phải bị XOÁ khỏi pipeline.json (audit #3: một batch/cycle, không còn chia chunk)');
  assert.ok((eng.PUBLISH_BATCH_MAX || 20) >= c.cycle_batch_max, 'PUBLISH_BATCH_MAX của engine phải đủ chứa cả cycle batch (18)');
  assert.ok((eng.PUBLISH_BATCH_MAX || 20) > (eng.CHUNK || 10), 'PUBLISH_BATCH_MAX là cap RIÊNG của cycle-batch — CHUNK vẫn là cap mặc định của mọi path khác');
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
  // AUDIT #4: pipeline job đọc Pages deployment truth (SHA + status của Pages
  // build cuối) + permissions tối thiểu (contents: write commit cycle, pages: read)
  assert.match(yml, /Pages deployment truth/, 'workflow phải có step đọc Pages build cuối (audit #4)');
  assert.match(job, /PAGES_BUILD_COMMIT/, 'step Pages truth phải export PAGES_BUILD_COMMIT cho cycle step');
  assert.match(job, /pages: read/, 'pipeline job cần pages: read (đọc deployment truth)');
  assert.ok(!/push -f|--force\b/.test(yml), 'KHÔNG force push');
  // push job (writer _drafts) KHÔNG chạy trên schedule — pipeline là job duy nhất của cron
  const pm = /  publish:\n([\s\S]*?)(\n  \w+:|\s*$)/.exec(yml);
  assert.ok(pm, 'workflow phải có job publish');
  assert.match(pm[1], /github\.event_name == 'push'/, 'publish job phải là ALLOWLIST: chỉ push draft');
  assert.match(pm[1], /inputs\.action == 'status'/, 'publish job nhận maintenance dispatch status');
  assert.match(pm[1], /inputs\.action == 'recover'/, 'publish job nhận maintenance dispatch recover');
  assert.match(pm[1], /inputs\.action == 'diagnostics'/, 'publish job nhận maintenance dispatch diagnostics');
  assert.doesNotMatch(pm[1], /github\.event_name != /, 'KHÔNG còn denylist — routing phải là allowlist rõ ràng');
  // push trigger KHÔNG dùng paths filter: GitHub tạo record đỏ 0-job
  // (conclusion failure) cho push bị filter loại → gate _drafts phải nằm
  // ở job push-gate + publish needs.push-gate.outputs.drafts.
  assert.doesNotMatch(yml, /paths: /, 'push trigger KHÔNG dùng paths filter (fix run đỏ 0-job)');
  assert.match(yml, /needs\.push-gate\.outputs\.drafts == 'true'/, 'publish chỉ chạy push có draft (gate qua push-gate outputs)');
});

// =====================================================================
// WORKFLOW ROUTING — evaluate điều kiện `if` THẬT của từng job cho mọi
// event (KHÔNG chỉ grep): push (không draft / có draft), dispatch
// status/recover/diagnostics/pipeline/selftest/watchdog, 2 cron, và
// factory-repair.yml (workflow_run Factory production FAIL + dispatch
// repair) — mỗi event chỉ đến đúng job của nó.
// =====================================================================
function wfJobsIf(wf = 'factory-production.yml') { // trích {job: if-expression} từ workflow yml
  const lines = fs.readFileSync(path.join(ROOT, '.github', 'workflows', wf), 'utf8').split('\n');
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
    if (peek() === '(' && /^[A-Za-z][A-Za-z0-9_]*$/.test(t)) { // hàm 0 đối số: always()
      const open = eat(); const close = eat();
      if (open !== '(' || close !== ')') throw new Error('hàm ' + t + ' parse không được');
      if (t === 'always') return true; // publish dùng always() để không bị needs-skip trên dispatch
      throw new Error('hàm chưa hỗ trợ trong evaluator: ' + t + '()');
    }
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
function routeAll(ctx, wf = 'factory-production.yml') {
  const jobs = wfJobsIf(wf);
  const gh = routeCtx(ctx);
  const out = {};
  for (const [job, expr] of Object.entries(jobs)) out[job] = evalGhExpr(expr, gh);
  return out;
}
test('workflow routing: mỗi event đến ĐÚNG job (evaluate if thật của cả 4 job factory-production.yml)', () => {
  const only = (o, jobs) => { // đúng các job trong `jobs` chạy, còn lại KHÔNG
    const run = Object.keys(o).filter(k => o[k]);
    assert.deepStrictEqual(run.sort(), [...jobs].sort(),
      'event ' + JSON.stringify(ctxOf) + ' phải chạy đúng ' + JSON.stringify(jobs) + ' (got: ' + run.join(',') + ')');
  };
  let ctxOf;
  // push KHÔNG đụng _drafts/** → CHỈ push-gate (no-op xanh → run SUCCESS,
  // không còn record đỏ 0-job của push bị paths filter loại)
  ctxOf = { event_name: 'push' }; only(routeAll(ctxOf), ['push-gate']);
  // push CÓ đụng _drafts/** (push-gate outputs.drafts == 'true') → push-gate + publish
  const gateDrafts = { 'push-gate': { outputs: { drafts: 'true' } } };
  ctxOf = { event_name: 'push', needs: gateDrafts }; only(routeAll(ctxOf), ['push-gate', 'publish']);
  const gateNoDrafts = { 'push-gate': { outputs: { drafts: 'false' } } };
  assert.equal(routeAll({ event_name: 'push', needs: gateNoDrafts })['publish'], false,
    'push không đụng draft → publish KHÔNG chạy (gate không bị nới)');
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
  // dispatch repair → đã TÁCH sang factory-repair.yml (workflow_run tự tham
  // chiếu bị GitHub từ chối parse) ⇒ KHÔNG job nào của production chạy
  ctxOf = { event_name: 'workflow_dispatch', action: 'repair' };
  assert.ok(Object.values(routeAll(ctxOf)).every(v => v === false),
    'dispatch repair KHÔNG chạy job nào trong factory-production.yml');
  // workflow_run event → factory-production.yml KHÔNG còn trigger này (self-listen bị cấm)
  const wrAll = routeAll({ event_name: 'workflow_run', workflow_run: { workflow_run: { conclusion: 'failure', name: 'Factory production', head_branch: 'main' } } });
  assert.ok(Object.values(wrAll).every(v => v === false),
    'workflow_run KHÔNG trigger job nào trong factory-production.yml (self-listen bị GitHub cấm)');
  // cron */30 → CHỈ pipeline (publish KHÔNG chạy trên schedule)
  ctxOf = { event_name: 'schedule', schedule: '*/30 * * * *' }; only(routeAll(ctxOf), ['pipeline']);
  // cron 10 * * * * → CHỈ agent-watchdog
  ctxOf = { event_name: 'schedule', schedule: '10 * * * *' }; only(routeAll(ctxOf), ['agent-watchdog']);
  // repo khác → KHÔNG job nào chạy
  const off = routeAll({ event_name: 'push', github: { repository: 'someone/else' } });
  assert.ok(Object.values(off).every(v => v === false), 'repo khác phải không chạy job nào');
});

test('workflow routing factory-repair.yml: #4/#5 lắng nghe run Factory production (KHÔNG self-listen)', () => {
  const only = (o, jobs) => {
    const run = Object.keys(o).filter(k => o[k]);
    assert.deepStrictEqual(run.sort(), [...jobs].sort(),
      'phải chạy đúng ' + JSON.stringify(jobs) + ' (got: ' + run.join(',') + ')');
  };
  // workflow_run Factory production FAIL trên main → agent-repair
  only(routeAll({ event_name: 'workflow_run', workflow_run: { workflow_run: { conclusion: 'failure', name: 'Factory production', head_branch: 'main' } } }, 'factory-repair.yml'), ['agent-repair']);
  // workflow_run KHÔNG fail / branch khác → KHÔNG agent nào chạy
  const ok = routeAll({ event_name: 'workflow_run', workflow_run: { workflow_run: { conclusion: 'success', name: 'Factory production', head_branch: 'main' } } }, 'factory-repair.yml');
  assert.ok(Object.values(ok).every(v => v === false), 'run success → không agent nào chạy');
  const dev = routeAll({ event_name: 'workflow_run', workflow_run: { workflow_run: { conclusion: 'failure', name: 'Factory production', head_branch: 'dev' } } }, 'factory-repair.yml');
  assert.ok(Object.values(dev).every(v => v === false), 'branch khác main → không agent nào chạy');
  // dispatch repair → agent-repair; #5 theo KẾT QUẢ outputs của #4 (không phải event)
  only(routeAll({ event_name: 'workflow_dispatch', action: 'repair' }, 'factory-repair.yml'), ['agent-repair']);
  const needsOk = { 'agent-repair': { result: 'success', outputs: { result: 'SUCCESS', incident_id: 'INC-1' } } };
  assert.equal(routeAll({ event_name: 'workflow_dispatch', action: 'repair', needs: needsOk }, 'factory-repair.yml')['agent-supervisor'], true);
  const needsRefused = { 'agent-repair': { result: 'success', outputs: { result: 'REFUSED_DEDUP', incident_id: 'none' } } };
  assert.equal(routeAll({ event_name: 'workflow_dispatch', action: 'repair', needs: needsRefused }, 'factory-repair.yml')['agent-supervisor'], false);
});

test('push-gate guard job: fix đỏ 0-job, KHÔNG nới gate publish', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'factory-production.yml'), 'utf8');
  // Nguyên nhân đỏ 0-job: paths filter tạo record failure cho push bị loại → phải bỏ
  assert.ok(!yml.includes("paths: ['_drafts/**']"),
    'on.push KHÔNG còn paths filter (nguyên nhân run record đỏ 0-job)');
  assert.ok(/on:\n  push:\n(    #[^\n]*\n)*    branches: \[main\]/.test(yml),
    'on.push vẫn giữ branches: [main] (không nới scope branch)');
  // push-gate là job đầu, trước publish
  const gate = yml.slice(yml.indexOf('  push-gate:'), yml.indexOf('  publish:'));
  assert.ok(gate.length > 100, 'job push-gate phải tồn tại, đặt trước publish');
  assert.ok(gate.includes("if: github.event_name == 'push' && github.repository == 'thuexemayhanoi/lab'"),
    'push-gate if: chỉ push trên repo này');
  assert.ok(gate.includes('contents: read'), 'push-gate chỉ cần contents: read (checkout fetch-depth 2)');
  assert.ok(!/uses: (?!actions\/checkout@v4)/.test(gate), 'push-gate KHÔNG dùng action nào ngoài checkout');
  assert.ok(!gate.includes('persist-credentials: true'), 'push-gate KHÔNG giữ credentials');
  assert.ok(gate.includes('outputs:') && gate.includes('drafts: ${{ steps.drafts.outputs.drafts }}'),
    'push-gate xuất outputs.drafts cho publish dùng');
  assert.ok(gate.includes('git diff --name-only') && gate.includes('toJSON(github.event.commits)'),
    'push-gate detect draft bằng git diff + payload commits (API push có thể rỗng payload)');
  // publish: cần push-gate, chỉ chạy push có draft; always() chống needs-skip trên dispatch
  const pub = yml.slice(yml.indexOf('  publish:'), yml.indexOf('\n  pipeline:\n'));
  assert.ok(pub.includes('needs: push-gate'), 'publish cần push-gate');
  assert.ok(pub.includes("needs.push-gate.outputs.drafts == 'true'"),
    'publish CHỈ chạy push khi push-gate xác nhận đụng _drafts/** (gate không nới)');
  assert.ok(pub.includes('always() &&'), 'publish luôn() để không bị needs-skip khi push-gate không chạy (dispatch)');
  assert.ok(pub.includes("github.event_name == 'push'"), 'publish if vẫn allowlist event push');
  assert.ok(pub.includes("inputs.action == 'status'") && pub.includes("inputs.action == 'recover'") &&
    pub.includes("inputs.action == 'diagnostics'"), 'publish if vẫn giữ allowlist dispatch maintenance');
});

test('factory-repair.yml: #4/#5 tách riêng — KHÔNG self-listen workflow_run (root cause đỏ 0-job)', () => {
  // factory-production.yml KHÔNG còn trigger workflow_run: GitHub từ chối
  // workflow lắng nghe chính nó ("cannot listen to itself") — cả workflow
  // fail to parse ⇒ mọi run 0-job failure, cron không chạy.
  const prod = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'factory-production.yml'), 'utf8');
  assert.ok(!/workflow_run:/.test(prod),
    'factory-production.yml KHÔNG được chứa trigger workflow_run (self-listen bị GitHub cấm parse)');
  assert.ok(!/jobs:\n  agent-repair:/.test(prod), 'agent-repair đã tách sang factory-repair.yml');
  assert.ok(!/jobs:\n  agent-supervisor:/.test(prod), 'agent-supervisor đã tách sang factory-repair.yml');

  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'factory-repair.yml'), 'utf8');
  assert.match(yml, /name: Factory repair/);
  // lắng nghe run của Factory production — workflow KHÁC (hợp lệ), không tự tham chiếu
  assert.match(yml, /workflow_run:\n    workflows: \['Factory production'\]/,
    'factory-repair.yml lắng nghe run Factory production');
  assert.ok(!/workflows: \['Factory repair'\]/.test(yml), 'KHÔNG tự tham chiếu (self-listen bị cấm)');
  assert.match(yml, /types: \[completed\]/);
  assert.match(yml, /workflow_dispatch:/, 'vẫn dispatch action=repair được');
  // serialized với production: CÙNG concurrency group
  assert.match(yml, /group: lab-factory-production/, 'cùng concurrency group với production');
  assert.match(yml, /cancel-in-progress: false/, 'không cancel production đang chạy');
  assert.match(yml, /permissions:\n  contents: write/, 'cần contents: write để commit incident');
  // đủ 2 job: #4 + #5, handoff head_sha nguyên vẹn
  assert.match(yml, /jobs:\n(  #[^\n]*\n)*  agent-repair:\n/, 'jobs: (cho phép comment block) rồi agent-repair');
  assert.match(yml, /  agent-supervisor:\n    #[\s\S]*?needs: \[agent-repair\]/);
  assert.match(yml, /head_sha: \$\{\{ steps\.a4commit\.outputs\.head_sha \}\}/, 'agent-repair outputs head_sha');
  assert.match(yml, /ref: \$\{\{ needs\.agent-repair\.outputs\.head_sha \|\| github\.sha \}\}/,
    'supervisor checkout đúng SHA #4');
  assert.ok(!/--force\b/.test(yml), 'KHÔNG force push');
});

test('factory-soak.yml: Tier 4 battery THẬT tồn tại trên CI (không còn docs ghi ENFORCED cho workflow không tồn tại)', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'factory-soak.yml'), 'utf8');
  // trigger: push main + pull_request + dispatch, KHÔNG paths filter (tránh đỏ 0-job)
  assert.match(yml, /name: Factory soak \(Tier 4\)/);
  assert.ok(/on:\n  push:\n    branches: \[main\]/.test(yml) && !/paths:/.test(yml),
    'push main KHÔNG dùng paths filter (GitHub ghi record FAILURE 0-job cho push bị filter loại)');
  assert.match(yml, /pull_request:\n    branches: \[main\]/, 'Tier 4 chạy trên pull_request (theo hợp đồng AGENTS.md)');
  assert.match(yml, /workflow_dispatch:/, 'Tier 4 re-dispatch thủ công được');
  // gate ở JOB level: reliability-relevant files → engine=true
  const gate = yml.slice(yml.indexOf('  tier4-gate:'), yml.indexOf('  tier4:'));
  assert.ok(gate.length > 100, 'job tier4-gate phải tồn tại, trước tier4');
  assert.match(gate, /outputs:\n      engine: \$\{\{ steps\.scope\.outputs\.engine \}\}/);
  assert.match(gate, /scripts\/factory\/\|config\/\|tests\/\|\\\.github\/workflows\//,
    'gate detect files reliability-relevant');
  // tier4 job: chỉ chạy khi gate xác nhận engine=true (gate KHÔNG nới)
  const tier4 = yml.slice(yml.indexOf('  tier4:'));
  assert.match(tier4, /needs: tier4-gate/);
  assert.match(tier4, /needs\.tier4-gate\.outputs\.engine == 'true'/,
    'tier4 chỉ chạy khi thay đổi reliability-relevant');
  // bộ Tier 4 đầy đủ: agent-suite + pipeline-suite + soak
  assert.match(tier4, /node --test tests\/agent-suite\.js/);
  assert.match(tier4, /node --test tests\/pipeline-suite\.js/);
  assert.match(tier4, /node --max-old-space-size=2048 --test tests\/soak\/factory-soak\.js/);
  // an toàn: read-only repo, không force push
  assert.match(yml, /permissions:\n  contents: read/, 'workflow chỉ đọc (contents: read)');
  assert.ok(!/--force\b|-f /.test(yml), 'KHÔNG force push');
});

// =====================================================================
// BEHAVIOR — refill (queue tự nạp ~300 topic hợp lệ)
// =====================================================================
test('refill: nạp window 300 topic PLANNED đầu theo matrix order, không trùng, idempotent, KHÔNG đổi matrix', () => {
  const SB = mkSB();
  try {
    // fixture: drain queue dưới queue_refill_min để refill THẬT SỰ có việc.
    // State production trên main có thể đã có queue đầy (scheduler refill
    // sẵn sau mỗi cycle) — khi đó lần gọi đầu là no-op và test không còn
    // đo được hành vi refill. KHÔNG đổi matrix; chỉ drain pending của SB.
    const stF = path.join(SB, 'data', 'state', 'pipeline-state.json');
    fs.writeFileSync(stF, JSON.stringify(Object.assign(stateOf(SB), { pending: [] }), null, 2));
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
// BEHAVIOR — refill stale hygiene (bug main 2026-10-05: pending còn
// A00129..A00174 dù các row này đã PUBLISHED qua vòng writer push-driven)
// =====================================================================
test('refill: dọn ID đã rời PLANNED khỏi pending (stale hygiene), giữ matrix order, top-up đủ window', () => {
  const SB = mkSB();
  try {
    const rows = rowsOf(SB);
    const planned = rows.filter(r => r.status === 'PLANNED').map(r => r.article_id);
    const firstPlanned = planned[0];
    // fixture: pending chứa row PUBLISHED (stale) ở đầu + trùng lặp — mô phỏng
    // state production bị lỗi trên main (queue đầy 300, không bao giờ được prune)
    const staleId = rows.find(r => r.status === 'PUBLISHED').article_id;
    const dirty = [staleId, staleId, firstPlanned, ...planned.slice(1, 10)];
    const stF = path.join(SB, 'data', 'state', 'pipeline-state.json');
    fs.writeFileSync(stF, JSON.stringify(Object.assign(stateOf(SB), { pending: dirty }), null, 2));
    const before = matrixBytes(SB);
    const r1 = PIPE(SB, ['refill']);
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    const st = stateOf(SB);
    assert.ok(!st.pending.includes(staleId), 'ID đã PUBLISHED phải bị dọn khỏi pending');
    assert.equal(new Set(st.pending).size, st.pending.length, 'không trùng topic');
    assert.equal(st.pending.length, 300, 'queue được top-up đủ window sau khi dọn stale');
    assert.deepEqual(st.pending, planned.slice(0, 300), 'queue = 300 PLANNED đầu theo matrix order');
    assert.equal(st.pending[0], firstPlanned, 'đầu queue = PLANNED đầu matrix (next claim đúng tiếp)');
    assert.deepEqual(matrixBytes(SB), before, 'refill KHÔNG bao giờ sửa matrix');
    // idempotent
    const r2 = PIPE(SB, ['refill']);
    assert.equal(r2.status, 0);
    assert.deepEqual(stateOf(SB).pending, st.pending);
  } finally { rmSB(SB); }
});
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
test('e2e mock cycle audit #3+#4: 6 bài publish MỘT transaction (pending deployment) → thiếu Pages truth KHÔNG finalize → deploy đúng SHA → COMPLETE, KHÔNG build lại', () => {
  const SB = mkSB({ cycle_batch_min: 6, cycle_batch_max: 6 });
  try {
    const ckBefore = ckptOf(SB).published_count;
    const ledBefore = ledgerLen(SB);
    // run 1: full cycle — publish xong phải dừng ở PENDING DEPLOYMENT (audit #4:
    // push/commit thành công KHÔNG được coi là deploy thành công)
    const r1 = PIPE(SB, ['cycle'], MOCK_ENV);
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    assert.match(r1.stdout, /PIPELINE PUBLISHED \(pending deployment\)/);
    assert.doesNotMatch(r1.stdout, /PIPELINE CYCLE COMPLETE/, 'chưa có deployment truth — KHÔNG được finalize');
    const st1 = stateOf(SB);
    assert.ok(st1.active && st1.active.deployment && st1.active.deployment.pending === true, 'state phải lưu pending deployment (ids + published_at — audit #4)');
    const batch = st1.active.batch;
    assert.equal(batch.length, 6);
    assert.equal(new Set(batch).size, 6);
    // MỘT publish transaction chứa đủ cả batch (audit #3 — không chia chunk)
    const evs1 = newPublishEvents(SB, ledBefore);
    assert.equal(evs1.length, 1, 'publish đúng MỘT transaction cho cả cycle');
    assert.deepEqual(evs1[0].ids.slice().sort(), batch.slice().sort());
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
    assert.equal(ckptOf(SB).published_count, ckBefore + 6);
    assert.equal(txnActive(SB), false, 'transaction phải inactive');
    assert.equal(writerLockHeld(SB), false, 'writer lock phải free');
    assert.equal(coordLock(SB).locked, false, 'coordinator lock phải free');
    // run 2: thiếu Pages truth => DEPLOYMENT-PENDING, KHÔNG mutate gì
    const before2 = { matrix: matrixBytes(SB), led: ledgerLen(SB) };
    const r2 = PIPE(SB, ['cycle'], MOCK_ENV);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.match(r2.stdout, /PIPELINE DEPLOYMENT-PENDING/);
    assert.doesNotMatch(r2.stdout, /PIPELINE CYCLE COMPLETE/);
    assert.deepEqual(matrixBytes(SB), before2.matrix, 'pending KHÔNG được mutate matrix');
    assert.equal(ledgerLen(SB), before2.led, 'pending KHÔNG được publish thêm gì');
    assert.equal(stateOf(SB).active.deployment.pending, true, 'vẫn pending (trạng thái recoverable)');
    // run 3: Pages build THÀNH CÔNG + chứa publication SHA => COMPLETE
    const r3 = PIPE(SB, ['cycle'], Object.assign({}, MOCK_ENV, DEPLOY_OK));
    assert.equal(r3.status, 0, r3.stdout + r3.stderr);
    assert.match(r3.stdout, /PIPELINE CYCLE COMPLETE/);
    const st3 = stateOf(SB);
    assert.equal(st3.active, null, 'state.active phải sạch sau confirm');
    assert.equal(st3.cycle, 1);
    assert.equal(st3.stopped_reason, null);
    const sum = st3.last_cycle_summary;
    assert.deepEqual(sum.published.slice().sort(), batch.slice().sort());
    assert.deepEqual(sum.blocked, []);
    assert.deepEqual(sum.failed_publish, []);
    assert.ok(sum.publication && sum.publication.deployed_sha === PUB_SHA, 'summary phải lưu deployed_sha đã xác nhận (audit #4)');
    assert.equal(ledgerLen(SB), before2.led, 'confirm KHÔNG publish lại (exactly-once, KHÔNG build lại)');
    assert.equal(ckptOf(SB).published_count, ckBefore + 6, 'published_count không đổi sau confirm');
    assert.equal(txnActive(SB), false);
    assert.equal(writerLockHeld(SB), false);
    assert.equal(coordLock(SB).locked, false);
    // 3 writer workspace riêng — mỗi writer xử lý tuần tự 2 bài, artifact chỉ nằm dưới pipeline/writers/
    const wsRoot = path.join(SB, 'pipeline', 'writers');
    const ws = fs.readdirSync(wsRoot).sort();
    assert.deepEqual(ws, ['w1', 'w2', 'w3'], 'phải có đúng 3 writer workspace');
    for (const w of ws) {
      const files = fs.readdirSync(path.join(wsRoot, w));
      assert.equal(files.length, 4, w + ' xử lý 2 bài × (packet + body)');
      for (const f of files) assert.match(f, /^A\d{5}\.(packet\.json|body\.html)$/, 'artifact chỉ được ghi trong workspace writer');
    }
    // queue tự refill sau finalize cho cycle kế tiếp
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
    // TTL trôi qua => resume từ checkpoint: repair -> PASS -> publish MỘT batch
    // (audit #3), dừng ở pending deployment (audit #4); confirm xong mới COMPLETE
    expireCoordLock(SB);
    const r3 = PIPE(SB, ['cycle'], MOCK_ENV);
    assert.equal(r3.status, 0, r3.stdout + r3.stderr);
    assert.match(r3.stdout, /PIPELINE PUBLISHED \(pending deployment\)/);
    for (const id of batch) {
      assert.equal(statusOf(SB, id), 'PUBLISHED', id);
      assert.equal(publishCountFor(SB, id), 1, id + ' publish ĐÚNG MỘT LẦN qua crash+resume');
    }
    const st3 = stateOf(SB);
    assert.equal(st3.active.cycle, st1.active.cycle, 'cycle resumed phải giữ số cycle, không claim batch mới');
    assert.equal(st3.active.deployment.pending, true, 'resume publish xong phải ở pending deployment');
    // xác nhận deployment (audit #4) => finalize, KHÔNG publish lại
    const r4 = PIPE(SB, ['cycle'], Object.assign({}, MOCK_ENV, DEPLOY_OK));
    assert.equal(r4.status, 0, r4.stdout + r4.stderr);
    assert.match(r4.stdout, /PIPELINE CYCLE COMPLETE/);
    const st4 = stateOf(SB);
    assert.equal(st4.active, null);
    assert.equal(st4.cycle, st1.active.cycle);
    for (const id of batch) assert.equal(publishCountFor(SB, id), 1, id + ' confirm KHÔNG publish lại');
    assert.equal(txnActive(SB), false);
    assert.equal(writerLockHeld(SB), false);
    assert.equal(coordLock(SB).locked, false);
  } finally { rmSB(SB); }
});

test('crash/resume mid-publish (audit #3): chết NGAY SAU batch publish op => pending deployment đã persist, KHÔNG double-publish', () => {
  const SB = mkSB({ cycle_batch_min: 3, cycle_batch_max: 3 });
  try {
    const ledBefore = ledgerLen(SB);
    // run 1: crash SAU khi pending deployment được saveState (truth persist TRƯỚC khi thoát)
    const r1 = PIPE(SB, ['cycle'], Object.assign({}, MOCK_ENV, { PIPELINE_CRASH_AT: 'after-publish-batch' }));
    assert.equal(r1.status, 75, 'crash injection phải exit 75 (error=' + (r1.error && r1.error.message) + ' signal=' + r1.signal + ')');
    const st1 = stateOf(SB);
    const batch = st1.active.batch;
    assert.ok(st1.active.deployment && st1.active.deployment.pending === true, 'crash SAU saveState: pending deployment phải đã được persist (audit #4)');
    for (const id of batch) assert.equal(statusOf(SB, id), 'PUBLISHED', id);
    const evs = newPublishEvents(SB, ledBefore);
    assert.equal(evs.length, 1, 'publish đúng MỘT transaction (audit #3 — không chia chunk)');
    assert.deepEqual(evs[0].ids.slice().sort(), batch.slice().sort(), 'MỘT event chứa đủ cả batch');
    // runner chết => coordinator lock TTL còn sống => run kế SKIP sạch
    const r2 = PIPE(SB, ['cycle'], MOCK_ENV);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /PIPELINE SKIP/);
    expireCoordLock(SB);
    // resume: KHÔNG có deployment truth => DEPLOYMENT-PENDING, KHÔNG double-publish
    const r3 = PIPE(SB, ['cycle'], MOCK_ENV);
    assert.equal(r3.status, 0, r3.stdout + r3.stderr);
    assert.match(r3.stdout, /PIPELINE DEPLOYMENT-PENDING/);
    for (const id of batch) assert.equal(publishCountFor(SB, id), 1, id + ' không bao giờ publish 2 lần (ledger là truth)');
    // xác nhận deployment => finalize đúng batch, KHÔNG build lại
    const r4 = PIPE(SB, ['cycle'], Object.assign({}, MOCK_ENV, DEPLOY_OK));
    assert.equal(r4.status, 0, r4.stdout + r4.stderr);
    assert.match(r4.stdout, /PIPELINE CYCLE COMPLETE/);
    const st4 = stateOf(SB);
    assert.equal(st4.active, null);
    assert.deepEqual(st4.last_cycle_summary.published.slice().sort(), batch.slice().sort());
    assert.equal(newPublishEvents(SB, ledBefore).length, 1, 'toàn bộ crash/resume/confirm chỉ có MỘT publish event (research/qa events không tính)');
    assert.equal(txnActive(SB), false);
    assert.equal(coordLock(SB).locked, false);
  } finally { rmSB(SB); }
});

test('crash/resume mid-transaction (audit #3): FACTORY_CRASH_AT=publish-staged => staged tx + live lock, cycle fail-closed exit 1; engine REFUSED trước lock; resume publish đúng 1 lần', () => {
  const SB = mkSB({ cycle_batch_min: 3, cycle_batch_max: 3 });
  try {
    const ledBefore = ledgerLen(SB);
    // run 1: operator chết NGAY SAU journal STAGED được persist (giữa stage và commit)
    const r1 = PIPE(SB, ['cycle'], Object.assign({}, MOCK_ENV, { FACTORY_CRASH_AT: 'publish-staged' }));
    assert.equal(r1.status, 1, 'publish batch FAIL phải fail-closed exit 1 (KHÔNG publish từng phần)');
    assert.match(r1.stdout + r1.stderr, /publish batch FAIL/);
    const st1 = stateOf(SB);
    assert.ok(st1.active, 'active batch phải được GIỮ NGUYÊN để resume (KHÔNG finalize mù)');
    assert.ok(st1.stopped_reason && /publish batch FAIL/.test(st1.stopped_reason), 'stopped_reason phải ghi rõ fail-closed');
    const batch = st1.active.batch;
    // staged: matrix đã ghi PUBLISHED NHƯNG transaction CHƯA commit (drafts
    // intact, ledger trống) — half-PUBLISHED window, KHÔNG được coi là publish
    for (const id of batch) assert.equal(statusOf(SB, id), 'PUBLISHED', id + ' staged (chưa commit)');
    assert.equal(newPublishEvents(SB, ledBefore).length, 0, 'chưa có ledger publish event nào (chưa commit; research/qa events là hoạt động bình thường của cycle)');
    assert.equal(txnActive(SB), true, 'staged transaction còn active');
    assert.equal(writerLockHeld(SB), true, 'writer-lock còn LIVE (TTL chưa hết — ownership unclear, KHÔNG force-unlock)');
    assert.equal(coordLock(SB).locked, false, 'coordinator lock được release bởi finish(1)');
    // probe engine refusal TRƯỚC khi hết hạn lock (audit #3): mọi REFUSED phải
    // xảy ra TRƯỚC acquireLock — không mở transaction, không đổi trạng thái lock
    const FACT = (args) => spawnSync(process.execPath,
      [path.join(SB, 'scripts', 'factory', 'factory.js'), ...args],
      { cwd: SB, encoding: 'utf8', env: Object.assign({}, process.env) });
    const rf1 = FACT(['publish', 'X00000', '--cycle-batch']);
    assert.notEqual(rf1.status, 0);
    assert.match(rf1.stderr + rf1.stdout, /REFUSED: cycle-batch publish chỉ nhận id thuộc active batch/);
    assert.equal(writerLockHeld(SB), true, 'REFUSED trước lock: KHÔNG đụng lock đang sống');
    assert.equal(txnActive(SB), true, 'REFUSED trước lock: KHÔNG mở transaction mới');
    const rf2 = FACT(['publish', batch[0], '--cycle-batch']);
    assert.notEqual(rf2.status, 0);
    assert.match(rf2.stderr + rf2.stdout, /REFUSED: cycle-batch publish phải nhận ĐÚNG BẰNG eligible-set/);
    assert.equal(writerLockHeld(SB), true);
    // TTL trôi qua (cả 2 lock) => resume: recover rollback staged tx từ journal
    // => rows về PASS => publish lại MỘT batch đúng 1 lần
    const wl = path.join(SB, 'data', 'state', 'writer-lock.json');
    const wlj = readJSON(wl); wlj.expires_at = new Date(Date.now() - 60000).toISOString();
    fs.writeFileSync(wl, JSON.stringify(wlj, null, 2));
    expireCoordLock(SB);
    const r2 = PIPE(SB, ['cycle'], MOCK_ENV);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.match(r2.stdout, /PIPELINE PUBLISHED \(pending deployment\)/);
    for (const id of batch) {
      assert.equal(statusOf(SB, id), 'PUBLISHED', id);
      assert.equal(publishCountFor(SB, id), 1, id + ' staged chết giữa chừng KHÔNG được tính là publish');
    }
    const evs = newPublishEvents(SB, ledBefore);
    assert.equal(evs.length, 1, 'MỘT publish event cho cả mid-transaction crash/resume');
    const r3 = PIPE(SB, ['cycle'], Object.assign({}, MOCK_ENV, DEPLOY_OK));
    assert.equal(r3.status, 0, r3.stdout + r3.stderr);
    assert.match(r3.stdout, /PIPELINE CYCLE COMPLETE/);
    assert.equal(stateOf(SB).active, null);
    assert.equal(newPublishEvents(SB, ledBefore).length, 1, 'ledger vẫn chỉ có MỘT publish event sau confirm');
  } finally { rmSB(SB); }
});

test('e2e audit #3: cycle 18 bài — MỘT build site, MỘT publication commit (1 publish event đủ 18 ID), confirm KHÔNG build lại', () => {
  const SB = mkSB({ cycle_batch_min: 18, cycle_batch_max: 18 });
  try {
    const ledBefore = ledgerLen(SB);
    const r1 = PIPE(SB, ['cycle'], MOCK_ENV);
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    assert.match(r1.stdout, /PIPELINE PUBLISHED \(pending deployment\)/);
    const builds1 = (r1.stdout.match(/BUILD MANIFEST:/g) || []).length;
    assert.equal(builds1, 1, 'cả cycle 18 bài phải build site đúng MỘT lần (audit #3)');
    const st1 = stateOf(SB);
    const batch = st1.active.batch;
    assert.equal(batch.length, 18);
    for (const id of batch) assert.equal(statusOf(SB, id), 'PUBLISHED', id);
    const evs = newPublishEvents(SB, ledBefore);
    assert.equal(evs.length, 1, 'MỘT publication commit cho cả cycle — KHÔNG chia chunk 10+8');
    assert.equal(evs[0].ids.length, 18);
    assert.deepEqual(evs[0].ids.slice().sort(), batch.slice().sort());
    const r2 = PIPE(SB, ['cycle'], Object.assign({}, MOCK_ENV, DEPLOY_OK));
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.match(r2.stdout, /PIPELINE CYCLE COMPLETE/);
    const builds2 = (r2.stdout.match(/BUILD MANIFEST:/g) || []).length;
    assert.equal(builds2, 0, 'confirm deployment KHÔNG build lại bài');
    assert.equal(newPublishEvents(SB, ledBefore).length, 1, 'confirm KHÔNG publish lại');
    const st2 = stateOf(SB);
    assert.equal(st2.active, null);
    assert.equal(st2.last_cycle_summary.published.length, 18);
  } finally { rmSB(SB); }
});

test('engine refusal (audit #3): --cycle-batch validate cap + pipeline-state TRƯỚC lock — mọi REFUSED không để lại lock/tx', () => {
  const SB = mkSB({ cycle_batch_min: 3, cycle_batch_max: 3 });
  try {
    const FACT = (args) => spawnSync(process.execPath,
      [path.join(SB, 'scripts', 'factory', 'factory.js'), ...args],
      { cwd: SB, encoding: 'utf8', env: Object.assign({}, process.env) });
    const ids21 = Array.from({ length: 21 }, (_, i) => 'A' + String(10001 + i)); // A10001..A10021
    // (a) 21 ids với flag => REFUSED PUBLISH_BATCH_MAX=20 (TRƯỚC state/lock)
    const ra = FACT(['publish'].concat(ids21, ['--cycle-batch']));
    assert.notEqual(ra.status, 0);
    assert.match(ra.stderr + ra.stdout, /REFUSED: cycle-batch publish received 21 ids > PUBLISH_BATCH_MAX=20/);
    assert.equal(writerLockHeld(SB), false, 'REFUSED trước acquireLock — không giữ lock');
    assert.equal(txnActive(SB), false, 'KHÔNG mở transaction');
    // (b) 11 ids KHÔNG flag => REFUSED CHUNK=10 (cap thường KHÔNG bị nới)
    const rb = FACT(['publish'].concat(ids21.slice(0, 11)));
    assert.notEqual(rb.status, 0);
    assert.match(rb.stderr + rb.stdout, /REFUSED: publish received 11 ids > CHUNK=10/);
    assert.equal(writerLockHeld(SB), false);
    // (c) sandbox tươi KHÔNG có pipeline-state active batch => REFUSED (fail-closed)
    const rc1 = FACT(['publish', 'A10001', '--cycle-batch']);
    assert.notEqual(rc1.status, 0);
    assert.match(rc1.stderr + rc1.stdout, /REFUSED: cycle-batch publish yêu cầu data\/state\/pipeline-state\.json/);
    assert.equal(writerLockHeld(SB), false);
    // (d) có active batch nhưng id NGOÀI batch => REFUSED foreign
    const stPath = path.join(SB, 'data', 'state', 'pipeline-state.json');
    fs.mkdirSync(path.dirname(stPath), { recursive: true });
    fs.writeFileSync(stPath, JSON.stringify({ version: 1, cycle: 1, pending: [],
      active: { cycle: 1, started_at: new Date().toISOString(), batch: ['A10001', 'A10002', 'A10003'],
        grants: {}, qa_rounds: {}, published: [], blocked: [] } }, null, 2));
    const rd = FACT(['publish', 'A10001', 'X00000', '--cycle-batch']);
    assert.notEqual(rd.status, 0);
    assert.match(rd.stderr + rd.stdout, /REFUSED: cycle-batch publish chỉ nhận id thuộc active batch/);
    assert.equal(writerLockHeld(SB), false);
    // (e) id trong batch nhưng KHÔNG đúng eligible-set (không row PASS+draft) => REFUSED
    const re_ = FACT(['publish', 'A10001', '--cycle-batch']);
    assert.notEqual(re_.status, 0);
    assert.match(re_.stderr + re_.stdout, /REFUSED: cycle-batch publish phải nhận ĐÚNG BẰNG eligible-set/);
    assert.equal(writerLockHeld(SB), false, 'mọi path REFUSED đều xảy ra TRƯỚC acquireLock');
    assert.equal(txnActive(SB), false, 'không sót transaction nào');
  } finally { rmSB(SB); }
});

test('pipeline unit (audit #4): deploymentDecision — chỉ confirmed khi Pages build success VÀ chứa publication SHA', () => {
  const dd = pipelineMod.deploymentDecision;
  const sha = 'a'.repeat(40), build = 'b'.repeat(40);
  // (1) thiếu publication SHA => KHÔNG confirmed
  assert.equal(dd('', build, 'success', true).confirmed, false);
  // (2) thiếu Pages truth (commit/status rỗng) => KHÔNG confirmed
  assert.equal(dd(sha, '', '', null).confirmed, false);
  // (3) Pages build KHÔNG success (errored) => KHÔNG confirmed
  assert.equal(dd(sha, build, 'errored', true).confirmed, false);
  // (4) build KHÔNG chứa publication SHA => KHÔNG confirmed (recoverable)
  const d4 = dd(sha, build, 'success', false);
  assert.equal(d4.confirmed, false);
  assert.match(d4.reason, /WRONG_SHA/);
  // (5) build success VÀ chứa SHA => confirmed, deployed_sha = Pages build commit
  const d5 = dd(sha, build, 'success', true);
  assert.equal(d5.confirmed, true);
  assert.equal(d5.deployed_sha, build);
  // (6) không có git (containsSha null) => chỉ khớp trực tiếp pubSha === buildCommit
  assert.equal(dd(sha, sha, 'success', null).confirmed, true);
  assert.equal(dd(sha, build, 'success', null).confirmed, false);
});

test('e2e audit #4 sai-SHA/errored: Pages deploy KHÔNG chứa publication SHA => giữ recoverable, KHÔNG finalize; sau đó đúng SHA => hoàn tất', () => {
  const SB = mkSB({ cycle_batch_min: 3, cycle_batch_max: 3 });
  try {
    const r1 = PIPE(SB, ['cycle'], MOCK_ENV);
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    assert.match(r1.stdout, /PIPELINE PUBLISHED \(pending deployment\)/);
    const batch = stateOf(SB).active.batch;
    // sai SHA: Pages build OK nhưng KHÔNG chứa publication commit => KHÔNG finalize
    const r2 = PIPE(SB, ['cycle'], Object.assign({}, MOCK_ENV, DEPLOY_WRONG_SHA));
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.match(r2.stdout, /PIPELINE DEPLOYMENT-PENDING/);
    assert.match(r2.stdout, /WRONG_SHA/);
    assert.equal(stateOf(SB).active.deployment.pending, true, 'giữ trạng thái recoverable (KHÔNG build/push lại bài)');
    // Pages build lỗi (errored) => vẫn recoverable, KHÔNG finalize mù
    const r3 = PIPE(SB, ['cycle'], Object.assign({}, MOCK_ENV, DEPLOY_ERRORED));
    assert.equal(r3.status, 0, r3.stdout + r3.stderr);
    assert.match(r3.stdout, /PIPELINE DEPLOYMENT-PENDING/);
    assert.match(r3.stdout, /PAGES_BUILD_STATUS=errored/);
    assert.equal(stateOf(SB).active.deployment.pending, true);
    // deployment sau đó đúng SHA (Pages đã build lại từ commit thật) => hoàn tất
    const r4 = PIPE(SB, ['cycle'], Object.assign({}, MOCK_ENV, DEPLOY_OK));
    assert.equal(r4.status, 0, r4.stdout + r4.stderr);
    assert.match(r4.stdout, /PIPELINE CYCLE COMPLETE/);
    const st4 = stateOf(SB);
    assert.equal(st4.active, null);
    assert.deepEqual(st4.last_cycle_summary.published.slice().sort(), batch.slice().sort());
  } finally { rmSB(SB); }
});

test('workflow handoff #4→#5 QUA COMMIT: head_sha output + commit incident if:always() + supervisor checkout đúng SHA #4 + verify nằm trên main', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'factory-repair.yml'), 'utf8');
  // (a) job agent-repair export head_sha sau khi commit incident
  assert.match(yml, /head_sha: \$\{\{ steps\.a4commit\.outputs\.head_sha \}\}/, 'agent-repair outputs head_sha');
  // (b) commit step #4 có id a4commit + if: always() (incident audit được push kể cả khi step #4 fail)
  const ai = yml.indexOf('id: a4commit');
  assert.ok(ai > 0, 'commit step #4 phải có id a4commit');
  assert.match(yml.slice(ai - 300, ai + 300), /if: always\(\)/, 'commit incident #4 phải if: always()');
  // (c) head_sha = SHA cuối cùng sau push (KHÔNG phải SHA cũ của event)
  assert.match(yml, /echo "head_sha=\$\(git rev-parse HEAD\)" >> "\$GITHUB_OUTPUT"/);
  // (d) supervisor checkout ĐÚNG commit #4 (fallback github.sha), KHÔNG mặc định SHA event
  assert.match(yml, /ref: \$\{\{ needs\.agent-repair\.outputs\.head_sha \|\| github\.sha \}\}/, 'supervisor checkout head_sha của #4');
  // (e) trước khi chạy #5: verify commit #4 nằm trên origin/main (fail-closed, không chạy trên SHA lạ)
  assert.match(yml, /git merge-base --is-ancestor.*origin\/main/, 'supervisor phải verify head_sha nằm trên origin/main');
  assert.ok(yml.includes('Handoff verify: commit #4 PHẢI nằm trên origin/main'), 'step verify handoff phải có tên rõ ràng');
});

// ============================================================================
// PHẦN AUDIT #2 — push Agent #5 sau handoff (detached HEAD phải ghi refspec)
// Sandbox không có binary git → mô hình mini-git THUẦN NODE mô tả đúng các
// tính chất mà workflow dựa vào: DAG ancestry, refs, detached HEAD, push
// fast-forward theo refspec, fetch/rebase. Đây là MÔ HÌNH, không phải git thật
// (binaries bị cấm trong sandbox); contract push thật được pin bằng YAML test
// ngay sau khối này.
// ============================================================================
function miniRemote(initialFiles) {
  const commits = new Map();
  let seq = 0;
  const mk = (parents, own, msg) => {
    const sha = 'c' + String(++seq).padStart(4, '0');
    const base = parents.length ? Object.assign({}, ...parents.map(p => commits.get(p).files)) : {};
    commits.set(sha, { parents: parents.slice(), own: Object.assign({}, own), files: Object.assign(base, own), msg });
    return sha;
  };
  const root = mk([], initialFiles || {}, 'root');
  const remote = { main: root, pushes: 0 };
  const isAncestor = (a, b) => {
    if (a === b) return true;
    const stack = [b], seen = new Set([b]);
    while (stack.length) {
      const c = commits.get(stack.pop());
      if (!c) return false;
      if (c.parents.includes(a)) return true;
      for (const p of c.parents) if (!seen.has(p)) { seen.add(p); stack.push(p); }
    }
    return false;
  };
  // actions/checkout@v4 để runner ở DETACHED HEAD trên SHA của event/handoff
  const checkout = sha => ({ head: sha, branch: null, remoteMain: remote.main });
  // push PHẢI ghi refspec; không refspec → git từ chối ("not on a branch")
  const push = (wt, refspec) => {
    if (refspec !== 'HEAD:refs/heads/main') throw new Error('fatal: you are not on a branch (detached HEAD — git push không refspec bị từ chối)');
    remote.pushes++;
    if (!isAncestor(remote.main, wt.head)) return { ok: false, reason: 'non-fast-forward (remote đã tiến)' };
    remote.main = wt.head;
    return { ok: true };
  };
  const commit = (wt, files, msg) => { wt.head = mk([wt.head], files, msg); return wt.head; };
  const fetch = wt => { wt.remoteMain = remote.main; };
  const rebase = (wt, onto) => {
    const local = commits.get(wt.head);
    wt.head = mk([onto], local.own, local.msg + ' (rebase)');
    return wt.head;
  };
  return { commits, remote, isAncestor, checkout, push, commit, fetch, rebase, filesOf: sha => commits.get(sha).files };
}

test('mini-git #4→#5 happy: push incident bằng refspec từ detached HEAD, #5 checkout đúng SHA, commit + push main', () => {
  const R = miniRemote({ 'README.md': 'base' });
  // ---- Agent #4: checkout detached tại origin/main, ghi incident, push refspec
  const a4 = R.checkout(R.remote.main);
  assert.equal(a4.branch, null, 'checkout@v4 phải ở detached HEAD');
  const incidentSha = R.commit(a4, { 'reports/incidents/inc-42.json': '{"id":"inc-42"}' }, 'agent-incident: inc-42 (#4)');
  const p4 = R.push(a4, 'HEAD:refs/heads/main');
  assert.equal(p4.ok, true, '#4 push refspec phải fast-forward được');
  assert.equal(R.remote.main, incidentSha, 'origin/main phải trỏ commit incident #4');
  const headSha = a4.head; // handoff output
  // ---- Agent #5: checkout ĐÚNG head_sha (detached), đọc incident, commit kết quả
  const a5 = R.checkout(headSha);
  assert.ok('reports/incidents/inc-42.json' in R.filesOf(a5.head), '#5 phải đọc được incident #4 từ handoff SHA');
  R.commit(a5, { 'reports/incidents/inc-42.result.json': '{"verified":true}' }, 'agent-incident: inc-42 (#5 final)');
  const p5 = R.push(a5, 'HEAD:refs/heads/main');
  assert.equal(p5.ok, true, '#5 push refspec phải được');
  assert.ok(R.filesOf(R.remote.main)['reports/incidents/inc-42.result.json'], 'kết quả #5 phải nằm trên main');
  assert.ok(R.filesOf(R.remote.main)['reports/incidents/inc-42.json'], 'incident #4 vẫn bảo toàn trên main');
  assert.ok(R.isAncestor(incidentSha, R.remote.main), 'chuỗi handoff #4→#5 phải tuyến tính trên main');
});

test('mini-git reconcile: remote có commit mới → push non-FF fail → fetch+rebase → verify origin/main & head_sha là ancestor → push OK, thay đổi mới bảo toàn', () => {
  const R = miniRemote({ 'README.md': 'base' });
  const a4 = R.checkout(R.remote.main);
  const incidentSha = R.commit(a4, { 'reports/incidents/inc-7.json': '{}' }, 'agent-incident: inc-7 (#4)');
  assert.equal(R.push(a4, 'HEAD:refs/heads/main').ok, true);
  const headSha = a4.head;
  // ---- #5 checkout handoff SHA, commit kết quả
  const a5 = R.checkout(headSha);
  R.commit(a5, { 'reports/incidents/inc-7.result.json': '{"ok":1}' }, '#5 final');
  // ---- commit X ĐỘC LẬP được push lên main giữa chừng (parent = incident #4)
  const x = R.remote.main; // hiện = incidentSha
  const xSha = (() => { const wt = R.checkout(x); R.commit(wt, { 'docs/NEW.md': 'x' }, 'x: commit mới từ người khác'); return wt.head; })();
  R.remote.main = xSha; // X đã lên origin/main
  // ---- push #5: non-FF fail
  const p1 = R.push(a5, 'HEAD:refs/heads/main');
  assert.equal(p1.ok, false, 'push phải fail non-FF khi remote đã tiến');
  assert.match(p1.reason, /non-fast-forward/);
  // ---- fetch + rebase AN TOÀN + verify trước khi retry
  R.fetch(a5);
  assert.equal(a5.remoteMain, xSha, 'fetch cập nhật remote-tracking ref');
  R.rebase(a5, a5.remoteMain);
  assert.ok(R.isAncestor(a5.remoteMain, a5.head), 'origin/main PHẢI là tổ tiên của HEAD sau rebase (không push mù)');
  assert.ok(R.isAncestor(headSha, a5.head), 'commit handoff #4 PHẢI vẫn là tổ tiên của HEAD sau rebase');
  const p2 = R.push(a5, 'HEAD:refs/heads/main');
  assert.equal(p2.ok, true, 'sau rebase push phải được');
  assert.equal(R.filesOf(R.remote.main)['docs/NEW.md'], 'x', 'thay đổi X PHẢI được bảo toàn (không ghi đè)');
  assert.ok(R.filesOf(R.remote.main)['reports/incidents/inc-7.result.json'], 'kết quả #5 vẫn nằm trên main');
  assert.ok(R.isAncestor(xSha, R.remote.main) && R.isAncestor(incidentSha, R.remote.main), 'lịch sử tuyến tính: #4 → X → #5');
});

test('mini-git fail-closed: handoff SHA KHÔNG nằm trên main → từ chối chạy #5, KHÔNG push, KHÔNG kết luận resume', () => {
  const R = miniRemote({ 'README.md': 'base' });
  // #4 commit incident nhưng push THẤT BẠI (chưa từng lên main)
  const a4 = R.checkout(R.remote.main);
  const lostSha = R.commit(a4, { 'reports/incidents/inc-9.json': '{}' }, '#4 chưa push được');
  assert.notEqual(R.remote.main, lostSha, 'giả lập: push #4 fail → SHA handoff KHÔNG trên main');
  // remote có lịch sử riêng (force từ ngoài? — anyway handoff không thuộc main)
  const mainBefore = R.remote.main;
  // ---- step "Handoff verify" của #5: head_sha phải là ancestor của origin/main
  const handoffOnMain = R.isAncestor(lostSha, R.remote.main);
  let concluded = false, pushed = 0;
  if (!handoffOnMain) {
    // exit 1 TRƯỚC khi chạy #5 → không commit, không push, không conclude
  } else {
    pushed++; concluded = true; // (nhánh không xảy ra)
  }
  assert.equal(handoffOnMain, false, 'head_sha không trên main phải bị phát hiện');
  assert.equal(pushed, 0, 'KHÔNG được push gì');
  assert.equal(concluded, false, 'KHÔNG được báo VERIFIED_RESUMED / persist thành công');
  assert.equal(R.remote.main, mainBefore, 'remote phải nguyên vẹn');
});

test('mini-git #4 retry-exhaust: push fail 3 lần (remote liên tục tiến) → exit 1, incident KHÔNG lên main', () => {
  const R = miniRemote({ 'README.md': 'base' });
  const a4 = R.checkout(R.remote.main);
  R.commit(a4, { 'reports/incidents/inc-3.json': '{}' }, '#4 incident');
  // remote ĐUA: mỗi lần #4 fetch+rebase xong thì main lại tiến (truth di chuyển liên tục)
  const raceRemote = () => { const racer = R.checkout(R.remote.main); R.remote.main = R.commit(racer, { ['docs/race-' + R.remote.pushes + '.md']: 'r' }, 'racing commit'); };
  raceRemote(); // remote đã tiến TRƯỚC lần push đầu
  let attempts = 0, lastErr = null;
  while (attempts < 5) {
    attempts++;
    if (R.push(a4, 'HEAD:refs/heads/main').ok) break;
    if (attempts >= 3) { lastErr = 'push FAIL sau ' + attempts + ' lần — STOP, không force push'; break; }
    R.fetch(a4);
    R.rebase(a4, a4.remoteMain); // reconcile an toàn
    if (!R.isAncestor(a4.remoteMain, a4.head)) { lastErr = 'reconcile FAIL'; break; }
    raceRemote(); // remote lại tiến trước lần push kế tiếp
  }
  assert.ok(lastErr && /push FAIL sau 3 lần/.test(lastErr), 'phải STOP sau 3 lần thử: ' + lastErr);
  assert.ok(R.filesOf(R.remote.main)['reports/incidents/inc-3.json'] === undefined, 'fail-closed: incident KHÔNG được lên main qua force/đường mù (audit nằm trên runner)');
});

test('workflow pin: MỌI git push trong 3 workflow đều ghi refspec origin HEAD:refs/heads/main (detached-HEAD safe), KHÔNG force', () => {
  for (const wf of ['factory-production.yml', 'factory-repair.yml', 'factory-soak.yml']) {
    const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', wf), 'utf8');
    yml.split('\n').forEach((ln, i) => {
      const m = ln.match(/^\s*(?:until\s+|!\s*)?git push\b(.*)$/);
      if (!m) return; // không phải dòng lệnh push thật (comment/echo không match)
      const rest = m[1].trim();
      assert.ok(rest.includes('HEAD:refs/heads/main'),
        wf + ':' + (i + 1) + ' push phải ghi rõ refspec đích (detached HEAD): ' + ln.trim());
      assert.ok(!/(^|\s)(--force|-f)(\s|$)/.test(rest), wf + ':' + (i + 1) + ' KHÔNG force push');
    });
  }
});

test('workflow pin #5: commit step agent-supervisor push refspec + verify ancestor (origin/main & head_sha) sau rebase; Kết luận bị skip khi push fail', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'factory-repair.yml'), 'utf8');
  const s5 = yml.indexOf('Commit incident final + cycle outputs');
  assert.ok(s5 > 0, 'phải có commit step của #5');
  const seg5 = yml.slice(s5, yml.indexOf('Kết luận incident'));
  // (a) push ghi refspec rõ ràng
  assert.match(seg5, /git push origin HEAD:refs\/heads\/main/, '#5 push phải refspec (detached HEAD)');
  // (b) sau rebase: verify origin/main là tổ tiên của HEAD (không push mù)
  assert.match(seg5, /git merge-base --is-ancestor origin\/main HEAD/, 'phải verify origin/main là ancestor của HEAD sau rebase');
  // (c) sau rebase: verify commit handoff #4 vẫn là tổ tiên của HEAD (fail-closed)
  assert.match(seg5, /git merge-base --is-ancestor "\$\{\{ needs\.agent-repair\.outputs\.head_sha \}\}" HEAD/, 'phải verify head_sha #4 là ancestor của HEAD sau rebase');
  // (d) stop sau 3 lần thử, không force
  assert.match(seg5, /"\$A5_PUSH" -ge 3/, 'giới hạn 3 lần thử');
  // (e) step "Kết luận incident" KHÔNG if: always()/failure() → bị skip mặc định khi push fail
  const k = yml.indexOf('Kết luận incident');
  const kseg = yml.slice(k, k + 500);
  assert.ok(!/if:\s*(always|failure)\(\)/.test(kseg), 'Kết luận phải bị skip khi push fail (không có VERIFIED_RESUMED giả)');
});
