#!/usr/bin/env node
/**
 * FACTORY SOAK — hardening F4 (Tier 4: long-run / failure recovery).
 *
 * Multi-chunk soak trong SANDBOX (os.tmpdir) — KHÔNG đụng production truth.
 * 6 chu kỳ × 10 articles: prepare-next → research → QA → PASS → atomic publish
 * (operator, --scope deep) → verify, với fault injection có kiểm soát:
 *
 *   chunk 1: clean
 *   chunk 2: crash-after-beginTx       (tx active + lock treo → restart recover → retry)
 *   chunk 3: crash-after-publishStage  (STAGED tx + journal + staged files → recover rollback → retry)
 *   chunk 4: build-failure             (patch build-site.js → opPublish rollback → restore → retry)
 *   chunk 5: editorial-audit-failure + verify-failure (2 lần patch → 2 rollback → retry)
 *   chunk 6: stale-lock               (lock ngoại sống → opPublish refuse 0 mutation → expire → recover → retry)
 *
 * Sau MỖI iteration assert: tx inactive, lock free, checkpoint khớp matrix,
 * prefix contiguous, không skip, không duplicate publish, ledger publish
 * exactly-once, archive/public đồng bộ, không draft leak, deterministic
 * rebuild không drift.
 *
 * Chạy: node --test tests/soak/factory-soak.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const SB = path.join(os.tmpdir(), 'lab-soak-' + process.pid);
const CHUNKS = 6;
const CHUNK = 10;
const FAULTS = ['clean', 'crash-after-begintx', 'crash-after-publishstage',
  'build-failure', 'editorial-audit-failure+verify-failure', 'stale-lock'];

// ---- sandbox bootstrap: full copy, no shards (single-csv mode), no drafts ----
fs.rmSync(SB, { recursive: true, force: true });
fs.cpSync(ROOT, SB, { recursive: true, filter: (s) => {
  const rel = path.relative(ROOT, s);
  return rel !== '_drafts' && !rel.startsWith('_drafts' + path.sep)
    && rel !== 'site' && !rel.startsWith('site' + path.sep)
    && !path.basename(s).startsWith('content-matrix.csv.part');
} });
fs.mkdirSync(path.join(SB, '_drafts'), { recursive: true });

// Clean checkout CI không có data/content-matrix.csv (gitignored; canonical
// committed form = 4 shards part00..03 — .gitignore). Assemble trong SANDBOX
// từ shards của ROOT để soak tự chạy được ở mọi môi trường (writer local hoặc
// CI clean checkout). Chỉ đọc ROOT, không ghi ROOT — production truth bất biến.
const sbCsv = path.join(SB, 'data', 'content-matrix.csv');
if (!fs.existsSync(sbCsv)) {
  const shards = fs.readdirSync(path.join(ROOT, 'data'))
    .filter((f) => f.startsWith('content-matrix.csv.part')).sort();
  if (!shards.length) throw new Error('FATAL: không có data/content-matrix.csv và không có shards part00..03 để assemble');
  fs.writeFileSync(sbCsv, shards.map((f) => fs.readFileSync(path.join(ROOT, 'data', f))).join(''));
}

// Tier-4 soak must be independent from legitimate live production work.
// If main currently has PASS/REPAIR/etc. in-flight, reset ONLY those rows in
// the TEMP sandbox back to PLANNED so the soak can claim its own deterministic
// 6×10 sequence. Production bytes are never mutated.
(function normalizeSoakSandbox() {
  const parse = (l) => { const out = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) { const ch = l[i];
      if (q) { if (ch === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else { if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; } }
    out.push(cur); return out; };
  const quote = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = fs.readFileSync(sbCsv, 'utf8').split('\n');
  const H = parse(lines[0]);
  const ix = (n) => H.indexOf(n);
  const iId = ix('article_id'), iStatus = ix('status'), iResearch = ix('research_status'),
    iQa = ix('qa_score'), iRepair = ix('repair_attempts'), iPub = ix('published_date'), iOut = ix('output_path');
  const open = new Set(['RESEARCH', 'WRITING', 'QA', 'REVIEW', 'REPAIR', 'PASS']);
  const reset = [];
  const out = [lines[0]];
  for (const l of lines.slice(1)) {
    if (!l.trim()) continue;
    const row = parse(l);
    if (open.has(row[iStatus])) {
      reset.push({ id: row[iId], output_path: row[iOut] });
      row[iStatus] = 'PLANNED';
      if (iResearch >= 0) row[iResearch] = 'NOT_STARTED';
      if (iQa >= 0) row[iQa] = '';
      if (iRepair >= 0) row[iRepair] = '0';
      if (iPub >= 0) row[iPub] = '';
    }
    out.push(row.map(quote).join(','));
  }
  fs.writeFileSync(sbCsv, out.join('\n') + '\n');

  for (const x of reset) {
    fs.rmSync(path.join(SB, 'data', 'research', x.id + '.json'), { force: true });
    fs.rmSync(path.join(SB, 'data', 'qa', x.id + '.json'), { force: true });
    fs.rmSync(path.join(SB, 'data', 'published', x.id + '.html'), { force: true });
    if (x.output_path) fs.rmSync(path.join(SB, x.output_path), { recursive: true, force: true });
  }

  const parsed = out.slice(1).map(parse);
  const firstPlanned = parsed.find(row => row[iStatus] === 'PLANNED');
  const ckF = path.join(SB, 'data', 'state', 'checkpoint.json');
  const ck = JSON.parse(fs.readFileSync(ckF, 'utf8'));
  ck.active_chunk = [];
  ck.next_claimable_id = firstPlanned ? firstPlanned[iId] : null;
  ck.notes = 'factory-soak isolated sandbox baseline';
  fs.writeFileSync(ckF, JSON.stringify(ck, null, 2) + '\n');
  fs.writeFileSync(path.join(SB, 'data', 'state', 'writer-lock.json'),
    JSON.stringify({ locked: false, holder: null, acquired_at: null, expires_at: null }, null, 2) + '\n');
  fs.writeFileSync(path.join(SB, 'data', 'state', 'transaction.json'),
    JSON.stringify({ active: false, id: null, started_at: null, operation: null, articles: [], notes: 'soak sandbox baseline' }, null, 2) + '\n');
})();

const FACT = (args) => spawnSync(process.execPath, [path.join(SB, 'scripts', 'factory', 'factory.js'), ...args], { cwd: SB, encoding: 'utf8' });
const OP = (args) => spawnSync(process.execPath, [path.join(SB, 'scripts', 'factory', 'operator.js'), ...args], { cwd: SB, encoding: 'utf8' });
const NODE = (rel, args) => spawnSync(process.execPath, [path.join(SB, rel), ...(args || [])], { cwd: SB, encoding: 'utf8' });
const sbFactory = require(path.join(SB, 'scripts', 'factory', 'factory.js'));

// baseline STATIC sitemap URLs (homepage, contact, privacy, terms — pages owned
// by sitemap-static.xml, not matrix articles); article canonicals live in the
// category shards and are asserted against PUBLISHED below.
const baseStaticLocs = new Set();
for (const f of fs.readdirSync(SB).filter(f => f === 'sitemap-static.xml')) {
  for (const m of fs.readFileSync(path.join(SB, f), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)) baseStaticLocs.add(m[1]);
}

// ---- quote-aware CSV helpers ----
function parseLine(l) { const out = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) { const c = l[i];
    if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } }
  out.push(cur); return out; }
function rows() {
  const lines = fs.readFileSync(path.join(SB, 'data', 'content-matrix.csv'), 'utf8').split('\n');
  const H = parseLine(lines[0]);
  return lines.slice(1).filter(l => l.trim()).map(l => { const c = parseLine(l); const o = {}; H.forEach((h, i) => o[h] = c[i] || ''); return o; });
}
const state = (f) => JSON.parse(fs.readFileSync(path.join(SB, 'data', 'state', f), 'utf8'));
const sbPath = (p) => path.join(SB, p);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function walkPrefix(rs) { let last = null; for (const r of rs) { if (r.status === 'PUBLISHED') last = r.article_id; else break; } return last; }
function plannedIds(rs) { return rs.filter(r => r.status === 'PLANNED').map(r => r.article_id).sort(); }
function ledger() { return JSON.parse(fs.readFileSync(sbPath('data/state/throughput-ledger.json'), 'utf8')); }

// ---- deterministic synthetic writer artifacts (digit-free body => grounding-safe) ----
function writePacket(id, r) {
  const packet = {
    article_id: id,
    primary_keyword: r.primary_keyword,
    search_intent: r.search_intent,
    research_date: new Date().toISOString().slice(0, 10),
    questions_found: [
      { question: 'Tổng quan ' + r.primary_keyword + ' cần biết những gì?', answer_source: 'synthetic soak fixture' },
      { question: 'Cần chuẩn bị gì cho ' + r.primary_keyword + '?', answer_source: 'synthetic soak fixture' },
    ],
    official_sources: [{ url: 'https://www.gov.vn/', domain: 'gov.vn', title: 'Cổng thông tin chính phủ (soak fixture)' }],
    unique_angle: 'soak fixture: góc nhìn cấu trúc và quy trình cho ' + r.primary_keyword,
    claim_evidence: [],
  };
  fs.writeFileSync(sbPath(path.join('data', 'research', id + '.json')), JSON.stringify(packet, null, 2));
}
const FILLER = 'mô tả chi tiết quy trình thực hiện các bước cơ bản cho người mới bắt đầu tìm hiểu thông tin tổng quan đầy đủ và rõ ràng nhất hiện nay';
function draftFor(r) {
  const paras = [];
  for (let i = 0; i < 30; i++) paras.push('<p>' + r.primary_keyword + ' — ' + FILLER + ' ' + FILLER + ' ' + FILLER + '</p>');
  return '<!DOCTYPE html>\n<html lang="vi">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + r.primary_keyword + ' — hướng dẫn tổng quan chi tiết cho người mới tìm hiểu</title>\n' +
    '<link rel="canonical" href="' + r.canonical + '">\n<meta name="description" content="' + r.primary_keyword + ': nội dung tổng quan, quy trình, lưu ý và câu hỏi thường gặp dành cho người mới bắt đầu tìm hiểu thông tin đầy đủ, rõ ràng và dễ theo dõi.">\n</head>\n<body>\n' +
    '<header class="site-head"><nav class="site-menu"><a href="/lab/">Trang chủ</a></nav></header>\n' +
    '<nav class="breadcrumb"><a href="/lab/">Trang chủ</a> › <span>' + r.primary_keyword + '</span></nav>\n' +
    '<main>\n<h1>' + r.primary_keyword + ' — hướng dẫn tổng quan chi tiết</h1>\n' +
    '<p class="quick">Tóm tắt nhanh: nội dung dưới đây mô tả ' + r.primary_keyword + ' theo cấu trúc rõ ràng cho người mới.</p>\n' +
    '<ul class="key-points"><li>Quy trình cơ bản</li><li>Lưu ý quan trọng</li><li>Câu hỏi thường gặp</li></ul>\n' +
    '<h2>Tổng quan về ' + r.primary_keyword + '</h2>\n' + paras.slice(0, 6).join('\n') +
    '\n<h2>Quy trình cơ bản</h2>\n' + paras.slice(6, 12).join('\n') +
    '\n<h2>Các yếu tố cần lưu ý</h2>\n' + paras.slice(12, 18).join('\n') +
    '\n<h2>So sánh các phương án</h2>\n<p>Bảng so sánh dưới đây tóm tắt các phương án phổ biến. Xem thêm <a href="/lab/thue-xe-may/">chuyên mục chính</a>, <a href="/lab/kinh-nghiem/">kinh nghiệm thực tế</a> và <a href="/lab/lien-he/">trang liên hệ</a> để tham khảo thêm.</p>\n' +
    '<div class="table-scroll"><table><thead><tr><th>Phương án</th><th>Đặc điểm</th></tr></thead><tbody><tr><td>Phương án cơ bản</td><td>Phù hợp người mới</td></tr><tr><td>Phương án nâng cao</td><td>Phù hợp nhu cầu chuyên sâu</td></tr></tbody></table></div>\n' +
    '\n<h2>Câu hỏi thường gặp</h2>\n<details class="faq"><summary>Nên bắt đầu từ đâu?</summary><p>Hãy bắt đầu từ phần tổng quan rồi đến quy trình cơ bản.</p></details>\n' +
    '<details class="faq"><summary>Nội dung này có phù hợp người mới không?</summary><p>Có, nội dung được trình bày theo cấu trúc từng bước, dễ theo dõi.</p></details>\n' +
    '\n<h2>Kết luận</h2>\n' + paras.slice(18, 24).join('\n') +
    '\n<details class="toc"><summary>Mục lục</summary><ol><li>Tổng quan</li><li>Quy trình cơ bản</li><li>Lưu ý</li><li>So sánh</li><li>Hỏi đáp</li></ol></details>\n' +
    '</main>\n' +
    '<footer class="site-foot"><p>Nội dung mang tính tham khảo tổng quan.</p></footer>\n' +
    '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"' + r.primary_keyword + ' — hướng dẫn tổng quan","mainEntityOfPage":{"@type":"WebPage","@id":"' + r.canonical + '"},"author":{"@type":"Organization","name":"Soak Fixture"},"description":"Soak fixture article"}</script>\n' +
    '<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Trang chủ","item":"/lab/"},{"@type":"ListItem","position":2,"name":"' + r.primary_keyword + '","item":"' + r.canonical + '"}]}</script>\n' +
    '</body>\n</html>\n';
}

// ---- fault helpers ----
const patched = [];
function patch(rel) {
  const p = sbPath(rel);
  const orig = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, 'process.exit(1);\n' + orig);
  patched.push({ rel, orig });
}
function restore(rel) {
  const p = sbPath(rel);
  const rec = patched.find(x => x.rel === rel);
  fs.writeFileSync(p, rec.orig);
  patched.splice(patched.indexOf(rec), 1);
}
function expireLock() {
  const l = state('writer-lock.json');
  l.expires_at = new Date(Date.now() - 3600000).toISOString();
  fs.writeFileSync(sbPath('data/state/writer-lock.json'), JSON.stringify(l, null, 2));
}
function liveForeignLock() {
  fs.writeFileSync(sbPath('data/state/writer-lock.json'), JSON.stringify({
    locked: true, holder: 'foreign-writer', acquired_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600000).toISOString() }, null, 2));
}

// ---- per-iteration state battery ----
function battery(tag, claimedAll, ledgerBase, basePublished) {
  const tx = state('transaction.json');
  assert.strictEqual(tx.active, false, tag + ': tx must be inactive');
  const lock = state('writer-lock.json');
  assert.strictEqual(lock.locked, false, tag + ': writer lock must be free');

  const rs = rows();
  const ck = state('checkpoint.json');
  const published = rs.filter(r => r.status === 'PUBLISHED').map(r => r.article_id);
  assert.strictEqual(published.length, basePublished + claimedAll.length, tag + ': published count must equal base + claimed');
  assert.strictEqual(new Set(published).size, published.length, tag + ': no duplicate PUBLISHED rows');
  // checkpoint == matrix truth
  assert.strictEqual(ck.published_count, published.length, tag + ': checkpoint.published_count must match matrix');
  assert.strictEqual(ck.last_completed_id, walkPrefix(rs), tag + ': last_completed_id == contiguous completed prefix');
  assert.strictEqual(ck.next_claimable_id, (plannedIds(rs)[0] || null), tag + ': next_claimable_id == first PLANNED');
  assert.deepStrictEqual(ck.active_chunk, [], tag + ': active_chunk must be empty (no unfinished work)');
  // claimed ids are exactly the contiguous prefix of the newly published set
  assert.ok(claimedAll.every(id => rs.find(r => r.article_id === id && r.status === 'PUBLISHED')), tag + ': every claimed id must be PUBLISHED');
  // ledger publish exactly-once per claimed id, one event per successful publish
  const led = ledger();
  const pubEvents = led.events.filter(e => e.op === 'publish');
  assert.strictEqual(pubEvents.length, ledgerBase, tag + ': ledger publish events must grow by exactly one per committed publish');
  const count = {};
  for (const e of pubEvents) for (const id of e.ids || []) count[id] = (count[id] || 0) + 1;
  for (const id of claimedAll) assert.strictEqual(count[id], 1, tag + ': ledger publish exactly-once for ' + id);
  // archive + public page synced
  for (const id of claimedAll) {
    const r = rs.find(x => x.article_id === id);
    assert.ok(fs.existsSync(sbPath('data/published/' + id + '.html')), tag + ': archive missing for ' + id);
    assert.ok(fs.existsSync(sbPath(path.join(r.output_path.replace(/^\//, ''), 'index.html'))), tag + ': public page missing for ' + id);
    assert.ok(!fs.existsSync(sbPath('_drafts/' + id + '.html')), tag + ': draft leak — _drafts/' + id + '.html must be removed at commit');
  }
  // consistency (checkpoint/matrix/sitemap/public sync contract)
  const cons = FACT(['consistency']);
  assert.strictEqual(cons.status, 0, tag + ': consistency must PASS\n' + cons.stdout + cons.stderr);
}

function hashTrackedTree() {
  const list = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'site' || e.name === '_drafts') continue;
    const q = path.join(d, e.name);
    if (e.isDirectory()) walk(q); else if (/\.(html|xml|json|js|css|txt|svg)$/i.test(e.name) && !q.includes(path.join('data', 'content-matrix.csv'))) list.push(q);
  } })(SB);
  list.sort();
  return crypto.createHash('sha256').update(list.map(p => p + ':' + sha(p)).join('\n')).digest('hex');
}

// ---- THE SOAK ----
test('factory soak: 6 chunks, fault injection, recovery, no state drift', () => {
  const baseRows = rows();
  const basePublished = baseRows.filter(r => r.status === 'PUBLISHED').length;
  const ledgerBase = ledger().events.filter(e => e.op === 'publish').length;
  const claimedAll = [];
  let recoveries = 0, rollbacks = 0, retries = 0, injections = 0, publishSuccess = 0;

  try {
    for (let i = 0; i < CHUNKS; i++) {
      const fault = FAULTS[i];
      // --- prepare-next: claim exactly the next 10 PLANNED rows (no skip) ---
      const plannedBefore = plannedIds(rows());
      const expected = plannedBefore.slice(0, CHUNK);
      assert.strictEqual(expected.length, CHUNK, 'chunk ' + (i + 1) + ': enough PLANNED rows');
      const pn = FACT(['prepare-next', String(CHUNK)]);
      assert.strictEqual(pn.status, 0, 'prepare-next failed: ' + pn.stdout + pn.stderr);
      const unfinished = rows().filter(r => ['RESEARCH', 'WRITING', 'QA', 'REVIEW', 'REPAIR', 'PASS'].includes(r.status)).map(r => r.article_id);
      assert.deepStrictEqual(unfinished, expected, 'chunk ' + (i + 1) + ': claimed set must be exactly the first 10 PLANNED (no skip)');
      claimedAll.push(...expected);

      // --- research (packet) + write draft + qa → PASS (writer direct CLI) ---
      for (const id of expected) {
        const r = rows().find(x => x.article_id === id);
        writePacket(id, r);
        assert.strictEqual(FACT(['research', id]).status, 0, 'research failed for ' + id);
        fs.writeFileSync(sbPath('_drafts/' + id + '.html'), draftFor(r));
        const qa = FACT(['qa', id]);
        assert.strictEqual(qa.status, 0, 'qa spawn failed for ' + id);
        assert.match(qa.stdout, new RegExp('QA ' + id + ' score='));
        assert.ok(/status=PASS/.test(qa.stdout), 'qa must PASS for ' + id + ': ' + qa.stdout);
      }

      // --- fault injection + atomic publish ---
      const matrixBefore = sha(sbPath('data/content-matrix.csv'));
      const ledgerBefore = sha(sbPath('data/state/throughput-ledger.json'));
      let publishAttempt = null;

      if (fault === 'clean') {
        publishAttempt = OP(['publish', '--ids', expected.join(','), '--scope', 'deep']);
        assert.strictEqual(publishAttempt.status, 0, 'clean publish must succeed: ' + publishAttempt.stdout + publishAttempt.stderr);
        publishSuccess++;
      } else if (fault === 'crash-after-begintx') {
        // in-process: acquireLock + beginTx, then the "process crashes" (we abandon)
        sbFactory.acquireLock('publish');
        sbFactory.beginTx('publish', expected);
        injections++;
        const tx = state('transaction.json');
        assert.strictEqual(tx.active, true, 'begintx crash: tx must be active');
        assert.strictEqual(state('writer-lock.json').locked, true, 'begintx crash: lock must be held');
        expireLock(); // crash = holder never returns; lock passes its expiry
        const rec = FACT(['recover']);
        assert.strictEqual(rec.status, 0, 'recover must resolve crashed begintx deterministically: ' + rec.stdout + rec.stderr);
        assert.match(rec.stdout, /RECOVERED/);
        assert.strictEqual(state('transaction.json').active, false, 'recover must close the tx');
        assert.strictEqual(state('writer-lock.json').locked, false, 'recover must free the lock');
        recoveries++;
        const retry = OP(['publish', '--ids', expected.join(','), '--scope', 'deep']);
        assert.strictEqual(retry.status, 0, 'retry publish after begintx recovery must succeed: ' + retry.stdout + retry.stderr);
        retries++; publishSuccess++;
      } else if (fault === 'crash-after-publishstage') {
        // in-process publishStage: STAGED tx + journal + staged files, then crash
        const staged = sbFactory.publishStage(expected);
        assert.strictEqual(staged.ids.length, CHUNK, 'publishStage must stage all ' + CHUNK);
        injections++;
        const tx = state('transaction.json');
        assert.strictEqual(tx.active && tx.phase === 'STAGED', true, 'staged crash: tx must be STAGED');
        assert.ok(tx.journal, 'staged crash: journal must exist');
        expireLock();
        const rec = FACT(['recover']);
        assert.strictEqual(rec.status, 0, 'recover must roll back the staged publish deterministically: ' + rec.stdout + rec.stderr);
        assert.match(rec.stdout, /staged \(uncommitted\) publish|ROLLBACK COMPLETE/);
        assert.strictEqual(state('transaction.json').active, false, 'staged rollback must close the tx');
        assert.strictEqual(state('writer-lock.json').locked, false, 'staged rollback must free the lock');
        rollbacks++; recoveries++;
        // matrix restored to pre-stage truth (PASS rows), staged files removed
        const rs = rows();
        for (const id of expected) {
          assert.strictEqual(rs.find(r => r.article_id === id).status, 'PASS', 'staged rollback must restore PASS for ' + id);
          assert.ok(!fs.existsSync(sbPath('data/published/' + id + '.html')), 'staged rollback must remove the staged archive for ' + id);
        }
        const retry = OP(['publish', '--ids', expected.join(','), '--scope', 'deep']);
        assert.strictEqual(retry.status, 0, 'retry publish after staged rollback must succeed: ' + retry.stdout + retry.stderr);
        retries++; publishSuccess++;
      } else if (fault === 'build-failure' || fault === 'editorial-audit-failure+verify-failure') {
        const patches = fault === 'build-failure'
          ? ['scripts/site/build-site.js']
          : ['scripts/factory/editorial-audit.js', 'scripts/factory/capacity-check.js'];
        for (const rel of patches) {
          patch(rel); injections++;
          const bad = OP(['publish', '--ids', expected.join(','), '--scope', 'deep']);
          assert.notStrictEqual(bad.status, 0, 'publish must fail with ' + rel + ' broken');
          assert.match(bad.stdout + bad.stderr, /NOT committed|Rolling back/);
          // deterministic rollback: matrix PASS, tx closed, lock free, no staged residue
          const rs = rows();
          for (const id of expected) {
            assert.strictEqual(rs.find(r => r.article_id === id).status, 'PASS', 'rollback must restore PASS for ' + id);
            assert.ok(!fs.existsSync(sbPath('data/published/' + id + '.html')), 'rollback must remove the staged archive for ' + id);
          }
          assert.strictEqual(state('transaction.json').active, false, 'rollback must close the tx');
          assert.strictEqual(state('writer-lock.json').locked, false, 'rollback must free the lock');
          rollbacks++;
          restore(rel);
        }
        const retry = OP(['publish', '--ids', expected.join(','), '--scope', 'deep']);
        assert.strictEqual(retry.status, 0, 'retry publish after rollback must succeed: ' + retry.stdout + retry.stderr);
        retries++; publishSuccess++;
      } else if (fault === 'stale-lock') {
        liveForeignLock(); injections++;
        const refused = OP(['publish', '--ids', expected.join(','), '--scope', 'deep']);
        assert.notStrictEqual(refused.status, 0, 'publish must refuse while a live foreign lock is held');
        assert.match(refused.stderr, /writer lock held/);
        // ZERO mutation on refusal
        assert.strictEqual(sha(sbPath('data/content-matrix.csv')), matrixBefore, 'refused publish must not touch the matrix');
        assert.strictEqual(sha(sbPath('data/state/throughput-ledger.json')), ledgerBefore, 'refused publish must not touch the ledger');
        assert.strictEqual(state('transaction.json').active, false, 'refused publish must not open a tx');
        assert.strictEqual(state('writer-lock.json').holder, 'foreign-writer', 'refused publish must NOT force-clear the lock');
        expireLock();
        const rec = FACT(['recover']);
        assert.strictEqual(rec.status, 0, 'recover must clear the expired stale lock: ' + rec.stdout + rec.stderr);
        assert.strictEqual(state('writer-lock.json').locked, false, 'recover must free the expired lock');
        recoveries++;
        const retry = OP(['publish', '--ids', expected.join(','), '--scope', 'deep']);
        assert.strictEqual(retry.status, 0, 'retry publish after stale-lock recovery must succeed: ' + retry.stdout + retry.stderr);
        retries++; publishSuccess++;
      } else { throw new Error('unknown fault ' + fault); }

      // --- per-iteration battery ---
      battery('chunk ' + (i + 1) + ' (' + fault + ')', claimedAll, ledgerBase + i + 1, basePublished);

      // --- deterministic rebuild (no drift between two consecutive builds) ---
      assert.strictEqual(NODE('scripts/site/build-site.js').status, 0, 'build 1 failed');
      const h1 = hashTrackedTree();
      assert.strictEqual(NODE('scripts/site/build-site.js').status, 0, 'build 2 failed');
      assert.strictEqual(hashTrackedTree(), h1, 'chunk ' + (i + 1) + ': deterministic rebuild must not drift');
    }

    // ---- END-OF-SOAK invariants ----
    const rs = rows();
    const publishedIds = rs.filter(r => r.status === 'PUBLISHED').map(r => r.article_id).sort();
    assert.strictEqual(publishedIds.length, basePublished + CHUNKS * CHUNK, 'soak must complete exactly ' + CHUNKS * CHUNK + ' new articles');
    assert.strictEqual(state('transaction.json').active, false, 'no stale transaction');
    assert.strictEqual(state('writer-lock.json').locked, false, 'no stale writer lock');

    // no orphan archive: data/published ↔ matrix PUBLISHED 1:1
    const archives = fs.readdirSync(sbPath('data/published')).filter(f => f.endsWith('.html')).map(f => f.replace('.html', '')).sort();
    assert.deepStrictEqual(archives, publishedIds, 'archive set must equal PUBLISHED set (no orphan archive)');
    // no orphan public page: every PUBLISHED row has exactly its canonical public page
    for (const id of publishedIds) {
      const r = rs.find(x => x.article_id === id);
      assert.ok(fs.existsSync(sbPath(path.join(r.output_path.replace(/^\//, ''), 'index.html'))), 'public page missing for ' + id);
    }
    // sitemap: exactly the PUBLISHED canonicals, each exactly once, never a non-PUBLISHED URL
    const locs = [];
    for (const f of fs.readdirSync(SB).filter(f => /^sitemap-.*\.xml$/.test(f) && f !== 'sitemap-index.xml')) {
      const xml = fs.readFileSync(path.join(SB, f), 'utf8');
      for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) locs.push(m[1]);
    }
    const pubCanonicals = rs.filter(r => r.status === 'PUBLISHED').map(r => r.canonical);
    const locCount = {};
    for (const l of locs) locCount[l] = (locCount[l] || 0) + 1;
    for (const c of pubCanonicals) assert.strictEqual(locCount[c], 1, 'sitemap must contain the PUBLISHED canonical exactly once: ' + c);
    for (const l of locs) assert.ok(pubCanonicals.includes(l) || baseStaticLocs.has(l),
      'sitemap must never contain a non-PUBLISHED article URL (static pages allowed): ' + l);
    // search-index + knowledge-index regenerated in sync (post-final-build)
    assert.ok(fs.existsSync(sbPath('assets/search-index.json')), 'search-index must exist');
    assert.ok(fs.existsSync(sbPath('assets/knowledge-index.json')), 'knowledge-index must exist');
    const searchIdx = JSON.parse(fs.readFileSync(sbPath('assets/search-index.json'), 'utf8'));
    assert.strictEqual(searchIdx.length, publishedIds.length, 'search-index must cover exactly the PUBLISHED articles');
    const idxUrls = new Set(searchIdx.map(x => x.u));
    for (const r of rs.filter(x => x.status === 'PUBLISHED')) assert.ok(idxUrls.has(r.output_path),
      'search-index must include the PUBLISHED article path: ' + r.output_path);

    // Tier 3 invariants inside the sandbox
    assert.strictEqual(FACT(['consistency']).status, 0, 'final consistency must PASS');
    const ground = FACT(['grounding']);
    assert.strictEqual(ground.status, 0, 'final grounding must PASS: ' + ground.stdout + ground.stderr);
    assert.strictEqual(NODE('scripts/factory/capacity-check.js').status, 0, 'final capacity-check must PASS');
    // liveness watchdog on the post-soak state: clean idle must be PASS
    const wd = spawnSync(process.execPath, [path.join(SB, 'scripts', 'factory', 'liveness-watchdog.js'), SB], { encoding: 'utf8' });
    assert.strictEqual(wd.status, 0, 'watchdog must report PASS on the clean post-soak state: ' + wd.stdout);

    console.log('SOAK SUMMARY: iterations=' + CHUNKS + ' completed_chunks=' + CHUNKS +
      ' articles_published=' + CHUNKS * CHUNK + ' fault_injections=' + injections +
      ' recoveries=' + recoveries + ' rollbacks=' + rollbacks + ' retries=' + retries +
      ' publish_success=' + publishSuccess +
      ' ledger_publish_events=' + (ledger().events.filter(e => e.op === 'publish').length - ledgerBase) +
      ' base_published=' + basePublished + ' final_published=' + publishedIds.length);
  } finally {
    for (const p of patched.slice()) { try { fs.writeFileSync(sbPath(p.rel), p.orig); } catch (e) {} }
    patched.length = 0;
    fs.rmSync(SB, { recursive: true, force: true });
  }
});
