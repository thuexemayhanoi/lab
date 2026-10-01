#!/usr/bin/env node
/**
 * tests/writer-submit-tests.js — regression contracts for the GitHub-only
 * WRITER SUBMISSION CHANNEL (scripts/factory/writer-submission.js +
 * .github/workflows/factory-writer-submit.yml).
 *
 * Run together with the canonical suite:
 *   node --test tests/test-suite.js tests/writer-submit-tests.js
 *
 * Proven contracts (mission audit items A–Q):
 *   A. main production tree never contains writer-inbox/**
 *   B. main production tree never contains _drafts/**
 *   C. writer branch cannot publish if base_main_sha is stale (STALE_WRITER_BASE)
 *   D. exactly 2 IDs only (manifest + CLI contracts)
 *   E. submitted IDs must equal the IDs claimed by repository truth
 *      (prepare-next); mismatch = byte-exact restore + refusal
 *   F. the Actions workflow uses the canonical operator QA/publish (writer
 *      channel), NO duplicate scorer/policy implementation
 *   G. QA thresholds remain the rubric (75/70) — never redefined
 *   H. critical failures still block (informational_only fake claims)
 *   I. failed QA can never mutate main into PUBLISHED (assert-pass refuses)
 *   J. publish failure rolls back (engine contract reused; grounding-gate and
 *      build-failure refusals leave truth untouched)
 *   K. a successful submission produces exactly ONE durable production result
 *      (exactly-one ledger event; single clean production tree)
 *   L. no force push anywhere
 *   M. two concurrent writer branches serialize (global lab-factory-production)
 *   N. a normal article publish does NOT trigger Tier 4 / deep batteries
 *   O. engine/workflow edits DO trigger Tier 4 (writer-submit workflow +
 *      tests are in the path contracts)
 *   P. Pages/public build contains only PUBLISHED rows
 *   Q. writer-inbox never lands in sitemap/search/knowledge index/public tree
 *
 * Mutating tests run inside throwaway sandboxes (os.tmpdir), NEVER on the
 * production tree. Production truth stays byte-identical.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const wfText = f => fs.readFileSync(path.join(ROOT, '.github', 'workflows', f), 'utf8');
const WS = path.join(ROOT, 'scripts', 'factory', 'writer-submission.js');
const wsMod = require(WS);

// ---------- sandbox: full repo copy (single-csv mode; no _drafts, no shards) ----------
// Same isolation rule as tests/test-suite.js: every spawned canonical script
// must be the SANDBOX's own copy (scripts resolve ROOT from __dirname/../..).
const SBW = path.join(os.tmpdir(), 'lab-writer-submit-' + process.pid);
function sbwCopy() {
  fs.rmSync(SBW, { recursive: true, force: true });
  fs.cpSync(ROOT, SBW, { recursive: true, filter: (s) => {
    const rel = path.relative(ROOT, s);
    return rel !== '_drafts' && !rel.startsWith('_drafts' + path.sep)
      && !rel.startsWith('writer-inbox' + path.sep) && rel !== 'writer-inbox';
  } });
  // single-csv mode: canonical truth (the 4 shards) is assembled ONCE into the
  // sandbox's gitignored data/content-matrix.csv, then the shards are removed.
  // The real runner keeps the shards (the canonical diff is the shards); the
  // E2E test maps the sandbox csv diff back to a shard path accordingly.
  const r = spawnSync(process.execPath, [path.join(SBW, 'scripts', 'factory', 'factory.js'), 'status'],
    { cwd: SBW, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'sandbox status (matrix assembly) failed: ' + r.stdout + r.stderr);
  for (const f of fs.readdirSync(path.join(SBW, 'data')).filter(f => /^content-matrix\.csv\.part/.test(f)))
    fs.rmSync(path.join(SBW, 'data', f));
}
const WSC = (args) => spawnSync(process.execPath,
  [path.join(SBW, 'scripts', 'factory', 'writer-submission.js'), ...args], { cwd: SBW, encoding: 'utf8' });
const OPW = (args) => spawnSync(process.execPath,
  [path.join(SBW, 'scripts', 'factory', 'operator.js'), ...args], { cwd: SBW, encoding: 'utf8' });
const WRAP = () => spawnSync(process.execPath,
  [path.join(SBW, 'scripts', 'factory', 'wrap-drafts.js')], { cwd: SBW, encoding: 'utf8' });
const sbFactory = () => require(path.join(SBW, 'scripts', 'factory', 'factory.js'));
const statusOf = (id) => sbFactory().loadMatrix().find(r => r.article_id === id).status;
const refusal = (r, re) => {
  assert.notStrictEqual(r.status, 0, 'expected a refusal, got exit ' + r.status + ': ' + r.stdout);
  assert.match(r.stderr, re);
};
const wordsOf = (html) => (String(html).replace(/<[^>]+>/g, ' ').match(/[A-Za-zÀ-ỹ0-9]+/g) || []).length;

// ---------- submission fixtures ----------
// A long, purely qualitative Vietnamese body (NO quantitative tokens at all —
// the fixture packets carry claim_evidence: [] so the grounding gate must see
// zero VND/%/duration tokens), one <h1>, internal links to EXISTING pages.
const SECTIONS = [
  'Tổng quan về nhu cầu và bối cảnh', 'Các lựa chọn phổ biến trên thị trường',
  'Điều kiện và giấy tờ cần chuẩn bị', 'Quy trình đặt xe theo từng bước',
  'Những điểm cần kiểm tra trước khi nhận xe', 'Trải nghiệm thực tế trên các cung đường',
  'Cách so sánh giữa các đơn vị cung cấp', 'Yếu tố an toàn luôn đặt lên hàng đầu',
  'Thói quen của khách hàng địa phương', 'Khoảnh khắc thuận tiện trong tuần',
  'Địa bàn và đặc điểm giao thông', 'Thời tiết và các mùa trong năm',
  'Gợi ý lịch trình tham quan hợp lý', 'Kinh nghiệm chụp ảnh lưu niệm',
  'Cách tiết kiệm chi phí thông minh', 'Những sai lầm thường gặp cần né',
  'Câu hỏi thường gặp từ khách mới', 'Tình huống phát sinh và cách xử lý',
  'Chi tiết hợp đồng cần đọc kỹ', 'Chế độ hỗ trợ khi có sự cố',
  'Bảo trì phương tiện định kỳ', 'Tiêu chí đánh giá một đơn vị uy tín',
  'So sánh phương án đi lại khác', 'Lịch sử hình thành của dịch vụ này',
  'Góc nhìn từ người dân bản địa', 'Cẩm nang cho lần đầu trải nghiệm',
  'Gợi ý điểm dừng nghỉ trên tuyến', 'Những cung đường đẹp nên thử',
  'Cách liên hệ và đặt trước nhanh chóng', 'Cam kết minh bạch về giá',
  'Trách nhiệm của hai bên', 'Hướng dẫn trả xe đúng quy trình',
  'Lưu ý về bảo quản đồ cá nhân', 'Chuẩn bị cho chuyến đi dài',
  'Thủ tục nhanh gọn cho người mới', 'Cách chọn loại phương tiện phù hợp',
  'Sự khác biệt giữa các dòng xe', 'Độ thoải mái trong những chặng xa',
  'Nhiên liệu và các trạm tiếp tế', 'Chân dung khách hàng thường gặp',
  'Gợi ý dành cho nhóm bạn đi cùng', 'Kế hoạch cho gia đình nhiều người',
  'Chuyến đi công tác gấp rút', 'Sự linh hoạt về thời gian',
  'Cách đóng góp ý kiến sau chuyến đi', 'Tính bền vững của mô hình này',
  'Xu hướng trong tương la gần', 'Sự kết nối với du lịch địa phương',
  'Câu chuyện từ chính khách hàng', 'Lời khuyên từ người có kinh nghiệm',
  'Những điều chỉ dẫn địa phương mới rõ', 'Bản đồ tư duy cho chuyến đi',
  'Danh sách kiểm tra trước xuất phát', 'Chia sẻ về trải nghiệm tổng thể',
  'Đánh giá cuối cùng và khuyến nghị', 'Bước tiếp theo cho người đọc',
  'Một vài lưu ý pháp lý cơ bản', 'Trách nhiệm cộng đồng và môi trường',
  'Lời kết cho bài viết này'
];
function submissionBody(id) {
  const name = id === 'A00015' ? 'Phú Thọ' : id === 'A00016' ? 'Bắc Ninh' : id;
  const parts = ['<h1>Trải nghiệm ' + name + ' cùng dịch vụ này</h1>'];
  parts.push('<p>Bài viết này tổng hợp kinh nghiệm thực tế để bạn chuẩn bị tốt cho một hành trình trọn vẹn. ' +
    'Nếu bạn mới tìm hiểu, hãy đọc thêm <a href="/lab/thue-xe-may/">hướng dẫn tổng quan</a> và ' +
    '<a href="/lab/kinh-nghiem/">chuyên mục kinh nghiệm</a> trước khi quyết định.</p>');
  for (const s of SECTIONS) {
    parts.push('<h2>' + s + '</h2>');
    parts.push('<p>Đối với ' + s.toLowerCase() + ', kinh nghiệm cho thấy sự chuẩn bị kỹ lưỡng luôn mang lại ' +
      'kết quả như ý. Nhiều người đã chia sẻ rằng việc lên kế hoạch sớm giúp hành trình trở nên nhẹ nhàng hơn, ' +
      'dù đó là chuyến đi ngắn hay hành trình kéo dài nhiều ngày. Hãy nhớ rằng mỗi cung đường đều có đặc điểm ' +
      'riêng, và việc lắng nghe người đi trước luôn là một lợi thế không thể phủ nhận.</p>');
    parts.push('<p>Bên cạnh đó, bạn cũng nên tham khảo trải nghiệm từ <a href="/lab/thue-xe-may/thue-xe-may-ha-noi/">vùng lân cận</a> ' +
      'để có góc nhìn so sánh. Sự khác biệt về thói quen, cảnh quan và nhịp sống sẽ khiến bạn có thêm nhiều lựa chọn ' +
      'cho kỳ nghỉ sắp tới. Trong mọi trường hợp, sự an toàn và thoải mái vẫn phải là ưu tiên hàng đầu, ' +
      'bởi một chuyến đi vui vẻ bắt đầu từ những điều cơ bản nhất.</p>');
  }
  parts.push('<p>Chúc bạn có một hành trình an toàn và đáng nhớ. Hãy quay lại ' +
    '<a href="/lab/">trang chủ</a> để đọc thêm nhiều bài viết bổ ích khác.</p>');
  return parts.join('\n');
}
function makeSubmission(root, ids, baseSha) {
  fs.mkdirSync(path.join(root, 'writer-inbox'), { recursive: true });
  fs.writeFileSync(path.join(root, 'writer-inbox', 'submission.json'),
    JSON.stringify({ base_main_sha: baseSha, ids }, null, 2));
  for (const id of ids) {
    fs.writeFileSync(path.join(root, 'writer-inbox', id + '.body.html'), submissionBody(id));
    fs.writeFileSync(path.join(root, 'data', 'research', id + '.json'), JSON.stringify({
      article_id: id,
      primary_keyword: 'trải nghiệm ' + id,
      search_intent: 'informational',
      research_date: '2026-09-30',
      questions_found: ['cần chuẩn bị gì', 'lưu ý nào quan trọng'],
      official_sources: [],
      sources: [],
      claim_evidence: [],
      unique_angle: 'góc nhìn kinh nghiệm thực tế, không claim định lượng'
    }, null, 2));
  }
}
// production-tree diff fingerprint: skip ephemeral / gitignored trees
function fileFingerprint(root) {
  const skip = new Set(['_drafts', 'site', 'writer-inbox', 'node_modules', '.git']);
  const map = {};
  const walk = (rel) => {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      if (skip.has(path.basename(abs)) && rel !== '') return;
      for (const e of fs.readdirSync(abs)) walk(rel ? rel + '/' + e : e);
    } else if (st.isFile()) map[rel] = fs.readFileSync(abs);
  };
  walk('');
  return map;
}
function changedPaths(root, before) {
  const after = fileFingerprint(root);
  const out = [];
  for (const rel of Object.keys(after))
    if (!before[rel] || !before[rel].equals(after[rel])) out.push(rel);
  return out;
}

// =====================================================================
// WORKFLOW CONTRACTS (static)
// =====================================================================
test('writer-submit A: main production tree never contains writer-inbox/** — clean production commit contract', () => {
  const y = wfText('factory-writer-submit.yml');
  assert.match(y, /branches:\s*\n\s*-\s*'writer\/\*\*'/, 'trigger must be ephemeral writer/** branches only');
  assert.ok(!/branches:\s*\[\s*main\s*\]/.test(y), 'the submission workflow must never run on main');
  assert.match(y, /paths:\s*\n\s*-\s*'writer-inbox\/\*\*'/, 'trigger paths must include the inbox');
  assert.match(y, /-\s*'data\/research\/\*\*'/, 'trigger paths must include the research packets');
  // the production index is seeded at the base and leak-guarded before write-tree
  assert.match(y, /git read-tree \"\$SUBMISSION_BASE\"/, 'production index must be seeded at the submission base');
  assert.match(y, /git ls-files/, 'staged-index leak guard (ls-files) required');
  assert.match(y, /git commit-tree \"\$TREE\" -p \"\$SUBMISSION_BASE\"/, 'production commit parent = base (the writer branch is NEVER merged)');
  assert.match(y, /git push origin \"\$PROD_COMMIT\":refs\/heads\/main/, 'main is updated by ONE plain fast-forward push');
  assert.match(y, /git worktree add --detach/, 'final verify must use the exact production tree');
  assert.match(y, /test ! -d writer-inbox/, 'worktree must prove writer-inbox absent');
  assert.match(y, /test ! -d _drafts/, 'worktree must prove _drafts absent');
  // ci-validate also guards main against an inbox leak (defense in depth)
  const ci = wfText('ci-validate.yml').replace(/^\s*#.*$/gm, '');
  assert.match(ci, /test ! -e writer-inbox/, 'ci-validate must fail if writer-inbox ever lands on main');
  assert.match(ci, /writer-inbox/, 'ci-validate must grep the public indexes for writer-inbox');
});

test('writer-submit B: _drafts stays gitignored forever; writer-inbox is NOT gitignored (committable on writer branches)', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(gi, /(^|\n)_drafts\//, '_drafts/ must stay out of the public root tree');
  assert.ok(!/writer-inbox/.test(gi), 'writer-inbox must NOT be gitignored — the GitHub-connector writer must be able to commit candidate files on writer/** branches');
  // the materialize stage itself refuses when the draft boundary is broken
  assert.match(fs.readFileSync(WS, 'utf8'), /DRAFT_BOUNDARY_BROKEN/, 'materialize must refuse if .gitignore drops _drafts/');
});

test('writer-submit C: stale base_main_sha refuses STALE_WRITER_BASE (never auto-rebase prose)', () => {
  const base = '0cb7e936d85eaf04ee0d6632a2610bc5af544a82';
  assert.throws(() => wsMod.assertFreshBase(base, '1111111111111111111111111111111111111111'), /STALE_WRITER_BASE/);
  assert.doesNotThrow(() => wsMod.assertFreshBase(base, base));
  const y = wfText('factory-writer-submit.yml');
  assert.match(y, /STALE_WRITER_BASE/, 'workflow must report STALE_WRITER_BASE');
  // main moving mid-publish is a hard refusal too — never merge, never force
  assert.match(y, /MAIN_MOVED_DURING_PUBLISH/, 'workflow must report MAIN_MOVED_DURING_PUBLISH');
  const pushSteps = y.split('git push').filter(s => /origin/.test(s.slice(0, 60)));
  assert.ok(pushSteps.length >= 2, 'workflow must push the production commit (and may delete the writer branch)');
});

test('writer-submit D: exactly 2 candidate IDs only (manifest + CLI refuse anything else)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-manifest-'));
  const mk = (ids) => {
    fs.rmSync(path.join(tmp, 'writer-inbox'), { recursive: true, force: true });
    fs.mkdirSync(path.join(tmp, 'writer-inbox'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'writer-inbox', 'submission.json'), JSON.stringify({ base_main_sha: 'f'.repeat(40), ids }));
    return () => wsMod.readManifest(tmp);
  };
  assert.throws(mk(['A00015']), /SUBMISSION_MUST_BE_A_PAIR/);
  assert.throws(mk(['A00015', 'A00016', 'A00017']), /SUBMISSION_MUST_BE_A_PAIR/);
  assert.throws(mk(['A00015', 'A00015']), /SUBMISSION_DUPLICATE_ID/);
  assert.throws(mk(['A00015', 'A1']), /SUBMISSION_BAD_ID/);
  assert.throws(mk(['A00015;rm -rf /', 'A00016']), /SUBMISSION_BAD_ID/);
  assert.throws(mk([{ ids: 'x' }]), /SUBMISSION_BAD_ID/);
  const good = mk(['A00015', 'A00016']);
  assert.deepStrictEqual(good().ids, ['A00015', 'A00016']);
  // unknown manifest fields are refused (strict schema)
  fs.writeFileSync(path.join(tmp, 'writer-inbox', 'submission.json'),
    JSON.stringify({ base_main_sha: 'f'.repeat(40), ids: ['A00015', 'A00016'], coordinator: 'evil' }));
  assert.throws(() => wsMod.readManifest(tmp), /SUBMISSION_MANIFEST_UNKNOWN_FIELD/);
  fs.writeFileSync(path.join(tmp, 'writer-inbox', 'submission.json'), JSON.stringify({ ids: ['A00015', 'A00016'] }));
  assert.throws(() => wsMod.readManifest(tmp), /SUBMISSION_MANIFEST_BAD_BASE/);
  fs.rmSync(tmp, { recursive: true, force: true });
  // CLI ids contract
  assert.throws(() => wsMod.parseIdsArg('A00015'), /SUBMISSION_MUST_BE_A_PAIR/);
  assert.throws(() => wsMod.parseIdsArg('A00015,A00016,A00017'), /SUBMISSION_MUST_BE_A_PAIR/);
  assert.deepStrictEqual(wsMod.parseIdsArg('A00015,A00016'), ['A00015', 'A00016']);
  // branch contract: ephemeral writer/** branches only
  assert.strictEqual(wsMod.parseBranchName('refs/heads/writer/A00015-A00016'), 'writer/A00015-A00016');
  for (const bad of ['main', 'writer/', 'feature/x', 'writer/a..b', 'refs/heads/develop', 'writer/A00015-A00016.lock'])
    assert.throws(() => wsMod.parseBranchName(bad), /BAD_WRITER_BRANCH/, bad + ' must be refused');
});

test('writer-submit F/G: canonical operator QA/publish only — no duplicate scorer, no channel actions, thresholds stay in the rubric', () => {
  const y = wfText('factory-writer-submit.yml');
  assert.match(y, /operator\.js research --ids \"\$SUBMISSION_IDS\" --scope fast/, 'research must run the canonical op');
  assert.match(y, /operator\.js qa --ids \"\$SUBMISSION_IDS\" --scope fast/, 'QA must run the canonical op');
  assert.match(y, /operator\.js publish --ids \"\$SUBMISSION_IDS\" --scope fast/, 'publish must run the canonical op');
  assert.ok(!/--channel actions/.test(y), 'the writer runner is the writer environment (default cli channel) — never the actions command-file channel');
  const src = fs.readFileSync(WS, 'utf8');
  // no second QA implementation: the module never scores, never redefines thresholds
  assert.ok(!/pass_min\s*[:=]\s*\d/.test(src), 'writer-submission must not define its own thresholds');
  assert.ok(!/\bqa\s*\(/.test(src.replace(/assertPass|factory\.qaEvidence/g, '')), 'writer-submission must not re-implement QA scoring');
  assert.match(src, /factory\.rubric|rubric\.pass_min/, 'assert-pass must read the canonical rubric');
  assert.match(src, /qaEvidence/, 'assert-pass must require canonical QA evidence');
  const rub = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'article-rubric.json'), 'utf8'));
  assert.strictEqual(rub.pass_min, 75);
  assert.strictEqual(rub.review_min, 70);
  assert.strictEqual(rub.max_repair_attempts, 3);
});

test('writer-submit L/M: no force push anywhere; concurrent writer branches serialize on the global production group', () => {
  const y = wfText('factory-writer-submit.yml');
  assert.ok(!/push --force|push -f|force-with-lease/.test(y), 'never force push');
  assert.match(y, /branches:\s*\n\s*-\s*'writer\/\*\*'/, 'trigger must be writer/** branches only');
  assert.match(y, /- 'writer-inbox\/\*\*'/, 'trigger paths must include the inbox');
  assert.match(y, /- 'data\/research\/\*\*'/, 'trigger paths must include research packets');
  assert.match(y, /group:\s*lab-factory-production/, 'must use the SAME global production serialization group as factory-operator.yml');
  assert.match(y, /cancel-in-progress:\s*false/, 'must never cancel an in-flight production run');
  assert.ok(!/lab-factory-production-\$\{\{/.test(y), 'production group must NOT be per-ref');
  assert.match(y, /permissions:\s*\n\s*contents:\s*write/, 'needs contents:write to build the production commit');
  assert.ok(!/pages:\s*write|id-token:\s*write/.test(y), 'no Pages permissions (Pages serves main only — a writer branch is never a Pages source)');
  // cleanup failure is a warning, never a publish failure
  assert.match(y, /::warning::could not delete writer branch/, 'branch cleanup must be non-fatal');
});

test('writer-submit N/O: normal content publish does NOT trigger Tier 4; engine/workflow edits DO', () => {
  for (const f of ['factory-soak.yml', 'factory-validate.yml', 'factory-capacity-validate.yml']) {
    const y = wfText(f);
    // O: the writer-submission channel IS reliability-relevant engine surface
    const c = (y.match(/- '\.github\/workflows\/factory-writer-submit\.yml'\n/g) || []).length;
    assert.ok(c >= 2, f + ' must trigger on factory-writer-submit.yml changes (pull_request + push)');
    assert.ok(/- 'tests\/writer-submit-tests\.js'|- 'tests\/\*\*'/.test(y), f + ' must include the writer-submit regression tests');
    // N: content runtime state must NOT trigger the deep batteries
    assert.ok(!/- 'data\/published\/\*\*'/.test(y), f + ' must not trigger on published archives');
    assert.ok(!/- 'data\/state\/\*\*'/.test(y), f + ' must not trigger on runtime state');
    assert.ok(!/- 'writer-inbox\/\*\*'/.test(y), f + ' must not trigger on writer submissions');
    assert.ok(!/- 'config\/content-factory\.json'/.test(y), f + ' must not trigger on runtime grounding ids');
  }
  // the CI batteries run BOTH regression files
  for (const f of ['factory-validate.yml', 'factory-capacity-validate.yml']) {
    assert.match(wfText(f), /node --test tests\/test-suite\.js tests\/writer-submit-tests\.js/, f + ' must run the writer-submit regressions');
  }
  // the lightweight content gate (ci-validate) checks the changed pair and
  // passes ids to factory.js grounding as SEPARATE argv entries (comma-joined
  // ids would never match a matrix row and would falsely fail the gate)
  const ci = wfText('ci-validate.yml').replace(/^\s*#.*$/gm, '');
  assert.match(ci, /tr ',' ' /, 'ci-validate grounding must split comma-joined changed ids into separate argv ids');
});

// =====================================================================
// UNIT: inbox + packet contracts (tmp fixtures)
// =====================================================================
test('writer-submit: inbox must contain EXACTLY the pair bodies + submission.json (no extras, flat, non-empty fragments)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-inbox-'));
  const ids = ['A00015', 'A00016'];
  fs.mkdirSync(path.join(tmp, 'writer-inbox'), { recursive: true });
  const writeBodies = () => ids.forEach(id => fs.writeFileSync(path.join(tmp, 'writer-inbox', id + '.body.html'), '<h1>x ' + id + '</h1><p>Nội dung.</p>'));
  const withManifest = () => fs.writeFileSync(path.join(tmp, 'writer-inbox', 'submission.json'), JSON.stringify({ base_main_sha: 'f'.repeat(40), ids }));
  writeBodies();
  assert.throws(() => wsMod.validateInbox(tmp, ids), /SUBMISSION_MANIFEST_MISSING/);
  withManifest();
  assert.doesNotThrow(() => wsMod.validateInbox(tmp, ids));
  // extra file (a sneaky public page) => refuse (Q)
  fs.writeFileSync(path.join(tmp, 'writer-inbox', 'index.html'), '<h1>sneaky</h1>');
  assert.throws(() => wsMod.validateInbox(tmp, ids), /INBOX_FILESET_MISMATCH/);
  fs.rmSync(path.join(tmp, 'writer-inbox', 'index.html'));
  // missing one body => refuse
  fs.rmSync(path.join(tmp, 'writer-inbox', 'A00016.body.html'));
  assert.throws(() => wsMod.validateInbox(tmp, ids), /INBOX_FILESET_MISMATCH/);
  fs.writeFileSync(path.join(tmp, 'writer-inbox', 'A00016.body.html'), '<h1>x A00016</h1><p>Nội dung.</p>');
  // empty body => refuse
  fs.writeFileSync(path.join(tmp, 'writer-inbox', 'A00016.body.html'), '');
  assert.throws(() => wsMod.validateInbox(tmp, ids), /INBOX_EMPTY_BODY/);
  // full document instead of a body fragment => refuse (wrap-drafts owns the shell)
  fs.writeFileSync(path.join(tmp, 'writer-inbox', 'A00016.body.html'), '<!DOCTYPE html><html><body><h1>x</h1></body></html>');
  assert.throws(() => wsMod.validateInbox(tmp, ids), /INBOX_BODY_MUST_BE_FRAGMENT/);
  fs.writeFileSync(path.join(tmp, 'writer-inbox', 'A00016.body.html'), '<h1>x A00016</h1><p>Nội dung.</p>');
  // a subdirectory inside the inbox => refuse (flat only)
  fs.mkdirSync(path.join(tmp, 'writer-inbox', 'sub'));
  assert.throws(() => wsMod.validateInbox(tmp, ids), /INBOX_NOT_FLAT/);
  fs.rmSync(path.join(tmp, 'writer-inbox', 'sub'), { recursive: true, force: true });
  // DRAFT BOUNDARY: a committed _drafts/ on the branch => hard refusal (B)
  fs.mkdirSync(path.join(tmp, '_drafts'));
  assert.throws(() => wsMod.validateInbox(tmp, ids), /DRAFT_DIR_ON_BRANCH/);
  fs.rmSync(path.join(tmp, '_drafts'), { recursive: true });
  // a pending operator command means the other channel is mid-flight => refuse
  fs.mkdirSync(path.join(tmp, 'data', 'state'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'data', 'state', 'operator-command.json'), '{"op":"status"}');
  assert.throws(() => wsMod.validateInbox(tmp, ids), /OPERATOR_COMMAND_PENDING/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('writer-submit: research packets must exist for exactly the submitted ids (canonical policy stays in the research op)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-packets-'));
  fs.mkdirSync(path.join(tmp, 'data', 'research'), { recursive: true });
  const ids = ['A00015', 'A00016'];
  assert.throws(() => wsMod.validatePackets(tmp, ids), /RESEARCH_PACKET_MISSING/);
  fs.writeFileSync(path.join(tmp, 'data', 'research', 'A00015.json'), JSON.stringify({ article_id: 'A00015' }));
  fs.writeFileSync(path.join(tmp, 'data', 'research', 'A00016.json'), 'not json');
  assert.throws(() => wsMod.validatePackets(tmp, ids), /RESEARCH_PACKET_INVALID_JSON/);
  fs.writeFileSync(path.join(tmp, 'data', 'research', 'A00016.json'), JSON.stringify({ article_id: 'A00017' }));
  assert.throws(() => wsMod.validatePackets(tmp, ids), /RESEARCH_PACKET_ID_MISMATCH/);
  fs.writeFileSync(path.join(tmp, 'data', 'research', 'A00016.json'), JSON.stringify({ article_id: 'A00016', official_sources: [] }));
  assert.doesNotThrow(() => wsMod.validatePackets(tmp, ids));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// =====================================================================
// UNIT: production-tree path allowlist (A, B, K, Q)
// =====================================================================
test('writer-submit K/Q: checkProductionPaths accepts ONLY canonical outputs and hard-denies submission artifacts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-paths-'));
  fs.mkdirSync(path.join(tmp, 'data', 'state'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'data', 'state', 'build-manifest.json'),
    JSON.stringify({ version: 1, files: ['index.html', 'sitemap-index.xml', 'sitemap-rental.xml', 'assets/search-index.json', 'assets/knowledge-index.json', '404.html', 'robots.txt', '.nojekyll', 'thue-xe-may/index.html', 'thue-xe-may/thue-xe-may-phu-tho/index.html'] }));
  const ok = [
    'data/research/A00015.json', 'data/qa/A00015.json', 'data/published/A00015.html',
    'data/content-matrix.csv.part00', 'data/content-matrix.csv.part03',
    'data/state/checkpoint.json', 'data/state/transaction.json', 'data/state/writer-lock.json',
    'data/state/throughput-ledger.json', 'data/state/build-manifest.json',
    'reports/factory/status-report.json', 'reports/factory/throughput.json',
    'config/content-factory.json',
    'sitemap-rental.xml', 'sitemap-index.xml', 'index.html', '404.html', 'robots.txt', '.nojekyll',
    'assets/search-index.json', 'assets/knowledge-index.json',
    'thue-xe-may/index.html', 'thue-xe-may/thue-xe-may-phu-tho/index.html'
  ];
  const r = wsMod.checkProductionPaths(tmp, ok);
  assert.deepStrictEqual(r, { ok: true, problems: [] }, JSON.stringify(r.problems));
  // hard denials (A, B, Q + infra)
  const deny = [
    ['writer-inbox/A00015.body.html', /writer-inbox/],
    ['writer-inbox/submission.json', /writer-inbox/],
    ['_drafts/A00015.html', /_drafts/],
    ['site/index.html', /site\//],
    ['data/content-matrix.csv', /assembled matrix CSV/],
    ['data/state/operator-command.json', /operator command file/],
    ['scripts/factory/factory.js', /engine\/source tree/],
    ['tests/writer-submit-tests.js', /engine\/source tree/],
    ['docs/WRITER-SUBMIT.md', /engine\/source tree/],
    ['.github/workflows/factory-writer-submit.yml', /engine\/source tree/],
    ['config/site.json', /config changed/],
    ['AGENTS.md', /documentation changed/],
    ['.gitignore', /infra dotfile/]
  ];
  for (const [p, why] of deny) {
    const rr = wsMod.checkProductionPaths(tmp, [p]);
    assert.ok(!rr.ok, p + ' must be denied');
    assert.match(rr.problems[0], why, p + ' denial reason');
  }
  // public outputs must be members of the deterministic build manifest (Q)
  const notBuilt = wsMod.checkProductionPaths(tmp, ['cuu-ho-xe-may/cuu-ho-xe-may-thu-duc/index.html']);
  assert.ok(!notBuilt.ok && /build manifest/.test(notBuilt.problems[0]), 'un-manifested public page must be refused');
  fs.rmSync(path.join(tmp, 'data', 'state', 'build-manifest.json'));
  const noM = wsMod.checkProductionPaths(tmp, ['index.html']);
  assert.ok(!noM.ok && /build-manifest/.test(noM.problems[0]), 'missing build manifest must fail the public-output validation');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// =====================================================================
// SANDBOX E2E — the full writer-submission bridge
// =====================================================================

test('writer-submit E: claim EXACTLY the submitted pair — prepare-next truth assert (happy path)', () => {
  sbwCopy();
  makeSubmission(SBW, ['A00015', 'A00016'], 'f'.repeat(40));
  const r = WSC(['claim', '--ids', 'A00015,A00016']);
  assert.strictEqual(r.status, 0, 'claim must succeed:\n' + r.stdout + r.stderr);
  assert.match(r.stdout, /WRITER SUBMISSION CLAIM OK/);
  assert.strictEqual(statusOf('A00015'), 'RESEARCH');
  assert.strictEqual(statusOf('A00016'), 'RESEARCH');
  const ck = JSON.parse(fs.readFileSync(path.join(SBW, 'data', 'state', 'checkpoint.json'), 'utf8'));
  assert.deepStrictEqual(ck.last_batch.sort(), ['A00015', 'A00016']);
  assert.deepStrictEqual(ck.active_chunk.sort(), ['A00015', 'A00016']);
  fs.rmSync(SBW, { recursive: true, force: true });
});

test('writer-submit E: submitted ids != claimed truth => byte-exact restore + CLAIM_MISMATCH refusal (never publish a different pair)', () => {
  sbwCopy();
  const before = {};
  for (const rel of ['data/content-matrix.csv', 'data/state/checkpoint.json', 'data/state/transaction.json', 'data/state/writer-lock.json', 'data/state/throughput-ledger.json', 'reports/factory/status-report.json', 'reports/factory/throughput.json'])
    before[rel] = fs.readFileSync(path.join(SBW, rel));
  // the writer submits a WRONG pair (A00017/A00018) while truth's next
  // claimable pair is A00015/A00016
  makeSubmission(SBW, ['A00017', 'A00018'], 'f'.repeat(40));
  const r = WSC(['claim', '--ids', 'A00017,A00018']);
  assert.notStrictEqual(r.status, 0, 'mismatched pair must be refused');
  assert.match(r.stderr, /CLAIM_MISMATCH/, 'must report CLAIM_MISMATCH: ' + r.stderr);
  // pre-claim truth restored byte-exact — A00015/A00016 back to PLANNED
  for (const [rel, bytes] of Object.entries(before))
    assert.deepStrictEqual(fs.readFileSync(path.join(SBW, rel)), bytes, rel + ' must be restored byte-exact');
  assert.strictEqual(statusOf('A00015'), 'PLANNED');
  assert.strictEqual(statusOf('A00016'), 'PLANNED');
  fs.rmSync(SBW, { recursive: true, force: true });
});

test('writer-submit: materialize copies inbox bodies into gitignored _drafts/ ONLY (runner bridge); broken draft boundary refuses', () => {
  sbwCopy();
  makeSubmission(SBW, ['A00015', 'A00016'], 'f'.repeat(40));
  assert.strictEqual(WSC(['claim', '--ids', 'A00015,A00016']).status, 0);
  const r = WSC(['materialize', '--ids', 'A00015,A00016']);
  assert.strictEqual(r.status, 0, r.stderr);
  for (const id of ['A00015', 'A00016']) {
    assert.ok(fs.existsSync(path.join(SBW, '_drafts', id + '.body.html')), 'body materialized for ' + id);
    assert.strictEqual(fs.readFileSync(path.join(SBW, '_drafts', id + '.body.html'), 'utf8'),
      fs.readFileSync(path.join(SBW, 'writer-inbox', id + '.body.html'), 'utf8'), 'body must be byte-identical');
  }
  // the canonical wrap produces a QA-able draft (canonical + breadcrumb + schema from the matrix row)
  const wrap = WRAP();
  assert.strictEqual(wrap.status, 0, wrap.stderr);
  const draft = fs.readFileSync(path.join(SBW, '_drafts', 'A00015.html'), 'utf8');
  assert.match(draft, /rel=\"canonical\" href=\"https:\/\/thuexemayhanoi\.github\.io\/lab\/thue-xe-may\/thue-xe-may-phu-tho\/\"/);
  assert.match(draft, /BreadcrumbList/);
  assert.match(draft, /ld\+json/);
  // sabotage .gitignore -> materialize must refuse (draft boundary guard)
  fs.writeFileSync(path.join(SBW, '.gitignore'), 'node_modules/\n');
  refusal(WSC(['materialize', '--ids', 'A00015,A00016']), /DRAFT_BOUNDARY_BROKEN/);
  fs.rmSync(SBW, { recursive: true, force: true });
});

test('writer-submit H/I: full happy-path submission E2E — claim, research, wrap, QA PASS, atomic publish, production-path allowlist, no inbox/draft leak (K, P, Q)', () => {
  sbwCopy();
  const before = fileFingerprint(SBW);
  makeSubmission(SBW, ['A00015', 'A00016'], 'f'.repeat(40));
  // preflight via the CLI (branch contract + inbox + packets)
  const pre = WSC(['validate-submission', '--branch', 'writer/A00015-A00016']);
  assert.strictEqual(pre.status, 0, pre.stderr);
  assert.match(pre.stdout, /\"ids\":\[\"A00015\",\"A00016\"\]/);
  assert.strictEqual(WSC(['claim', '--ids', 'A00015,A00016']).status, 0);
  assert.strictEqual(WSC(['materialize', '--ids', 'A00015,A00016']).status, 0);
  assert.strictEqual(WRAP().status, 0);
  assert.strictEqual(OPW(['research', '--ids', 'A00015,A00016', '--scope', 'fast']).status, 0);
  assert.ok(wordsOf(fs.readFileSync(path.join(SBW, '_drafts', 'A00015.html'), 'utf8')) >= 1600, 'fixture body must clear the word gate');
  const qa = OPW(['qa', '--ids', 'A00015,A00016', '--scope', 'fast']);
  assert.strictEqual(qa.status, 0, qa.stdout + qa.stderr);
  assert.strictEqual(statusOf('A00015'), 'PASS');
  assert.strictEqual(statusOf('A00016'), 'PASS');
  assert.strictEqual(WSC(['assert-pass', '--ids', 'A00015,A00016']).status, 0);
  const pub = OPW(['publish', '--ids', 'A00015,A00016', '--scope', 'fast']);
  assert.strictEqual(pub.status, 0, pub.stdout + pub.stderr);
  assert.match(pub.stdout, /PUBLISHED \(atomic, build\+verify PASS\) 2: A00015, A00016/);
  assert.strictEqual(WSC(['assert-published', '--ids', 'A00015,A00016']).status, 0);
  // K/P/Q: exactly-once ledger event; public tree clean of submission artifacts
  const ledger = JSON.parse(fs.readFileSync(path.join(SBW, 'data', 'state', 'throughput-ledger.json'), 'utf8'));
  const events = ledger.events.filter(e => e.op === 'publish' && JSON.stringify(e.ids.slice().sort()) === JSON.stringify(['A00015', 'A00016']));
  assert.strictEqual(events.length, 1, 'exactly ONE durable publish event for the pair');
  for (const f of fs.readdirSync(SBW).filter(f => /^sitemap-.*\.xml$/.test(f)))
    assert.ok(!fs.readFileSync(path.join(SBW, f), 'utf8').includes('writer-inbox'), 'writer-inbox must not be in ' + f);
  assert.ok(!fs.readFileSync(path.join(SBW, 'assets', 'search-index.json'), 'utf8').includes('writer-inbox'));
  assert.ok(!fs.readFileSync(path.join(SBW, 'assets', 'knowledge-index.json'), 'utf8').includes('writer-inbox'));
  // A/B/K: the changed-path diff (what the production commit would carry) must
  // pass the allowlist. Sandbox is single-csv mode: the matrix change would be
  // the 4 canonical shards in the real runner.
  const changed = changedPaths(SBW, before).map(p =>
    p === 'data/content-matrix.csv' ? 'data/content-matrix.csv.part00' : p);
  assert.ok(changed.some(p => /^data\/content-matrix\.csv\.part/.test(p)), 'matrix shards must be part of the production diff: ' + changed.join(','));
  const check = wsMod.checkProductionPaths(SBW, changed);
  assert.ok(check.ok, 'production diff must be canonical-only:\n' + check.problems.join('\n'));
  assert.ok(changed.includes('data/published/A00015.html') && changed.includes('data/qa/A00016.json'), 'archives + QA evidence must be part of the production diff');
  assert.ok(!changed.some(p => /^writer-inbox\//.test(p)), 'writer-inbox can never be in the production diff');
  assert.ok(!changed.some(p => /^_drafts\//.test(p)), '_drafts can never be in the production diff');
  fs.rmSync(SBW, { recursive: true, force: true });
});

test('writer-submit I: failed QA can never mutate main into PUBLISHED — assert-pass refuses REVIEW/REPAIR and publish never runs', () => {
  sbwCopy();
  makeSubmission(SBW, ['A00015', 'A00016'], 'f'.repeat(40));
  assert.strictEqual(WSC(['claim', '--ids', 'A00015,A00016']).status, 0);
  assert.strictEqual(WSC(['materialize', '--ids', 'A00015,A00016']).status, 0);
  assert.strictEqual(WRAP().status, 0);
  assert.strictEqual(OPW(['research', '--ids', 'A00015,A00016', '--scope', 'fast']).status, 0);
  // sabotage: make one body SHORT (word gate) -> QA lands REVIEW (70-74) or REPAIR (<70)
  fs.writeFileSync(path.join(SBW, '_drafts', 'A00016.body.html'), '<h1>short</h1><p>Quá ngắn.</p>');
  assert.strictEqual(WRAP().status, 0);
  const qa = OPW(['qa', '--ids', 'A00015,A00016', '--scope', 'fast']);
  assert.strictEqual(qa.status, 0, 'FAST qa itself succeeds (scoring is not a hard error)');
  assert.ok(['REVIEW', 'REPAIR'].includes(statusOf('A00016')), 'sabotaged short row must land REVIEW or REPAIR (never PASS): ' + statusOf('A00016'));
  // the submission channel refuses to publish; nothing lands on main
  refusal(WSC(['assert-pass', '--ids', 'A00015,A00016']), /WRITER_QA_NOT_PASS/);
  assert.match(qa.stdout, /QA A00016 score=/, 'the canonical engine scored the draft');
  // even a direct operator publish is refused by the engine gate (double lock)
  const pub = OPW(['publish', '--ids', 'A00015,A00016', '--scope', 'fast']);
  assert.notStrictEqual(pub.status, 0, 'publish gate must refuse non-PASS rows');
  assert.match(pub.stderr, /publish gate only accepts PASS/);
  assert.ok(['REVIEW', 'REPAIR'].includes(statusOf('A00016')), 'main truth never became PUBLISHED');
  assert.ok(!fs.existsSync(path.join(SBW, 'data', 'published', 'A00016.html')), 'no durable archive for the failed row');
  fs.rmSync(SBW, { recursive: true, force: true });
});

test('writer-submit G/H: REVIEW (70-74) is never publishable; critical informational_only violations still FAIL hard', () => {
  sbwCopy();
  makeSubmission(SBW, ['A00015', 'A00016'], 'f'.repeat(40));
  assert.strictEqual(WSC(['claim', '--ids', 'A00015,A00016']).status, 0);
  assert.strictEqual(WSC(['materialize', '--ids', 'A00015,A00016']).status, 0);

  // sabotage: a fake owner-service claim on an informational_only row (CRITICAL)
  const body = fs.readFileSync(path.join(SBW, 'writer-inbox', 'A00015.body.html'), 'utf8');
  fs.writeFileSync(path.join(SBW, 'writer-inbox', 'A00015.body.html'),
    body + '\n<p>Hãy gọi ngay đội cứu hộ của chúng tôi để được hỗ trợ.</p>\n');
  fs.writeFileSync(path.join(SBW, '_drafts', 'A00015.body.html'),
    fs.readFileSync(path.join(SBW, 'writer-inbox', 'A00015.body.html'), 'utf8'));
  assert.strictEqual(WRAP().status, 0);
  assert.strictEqual(OPW(['research', '--ids', 'A00015,A00016', '--scope', 'fast']).status, 0);
  const qa = OPW(['qa', '--ids', 'A00015,A00016', '--scope', 'fast']);
  assert.strictEqual(qa.status, 0);
  assert.match(qa.stdout, /CRITICAL fake local service claim/, 'critical violation must be flagged');
  const score = Number(String(qa.stdout.match(/QA A00015 score=\d+/)[0].split('=')[1]));
  assert.ok(score <= 55, 'critical failure caps the score hard (got ' + score + ')');
  assert.ok(['REVIEW', 'REPAIR', 'BLOCKED'].includes(statusOf('A00015')), 'critical row is not PASS');
  refusal(WSC(['assert-pass', '--ids', 'A00015,A00016']), /WRITER_QA_NOT_PASS/);
  fs.rmSync(SBW, { recursive: true, force: true });
});

test('writer-submit J: publish refusal (grounding gate) leaves truth untouched — rollback contract reused from the engine', () => {
  sbwCopy();
  makeSubmission(SBW, ['A00015', 'A00016'], 'f'.repeat(40));
  assert.strictEqual(WSC(['claim', '--ids', 'A00015,A00016']).status, 0);
  assert.strictEqual(WSC(['materialize', '--ids', 'A00015,A00016']).status, 0);
  assert.strictEqual(WRAP().status, 0);
  assert.strictEqual(OPW(['research', '--ids', 'A00015,A00016', '--scope', 'fast']).status, 0);
  assert.strictEqual(OPW(['qa', '--ids', 'A00015,A00016', '--scope', 'fast']).status, 0);
  assert.strictEqual(WSC(['assert-pass', '--ids', 'A00015,A00016']).status, 0);
  // sabotage: inject an UNGROUNDED quantitative claim into the scored draft and
  // re-wrap — the publish grounding gate must refuse (evidence hash also stale)
  fs.writeFileSync(path.join(SBW, '_drafts', 'A00015.body.html'),
    fs.readFileSync(path.join(SBW, '_drafts', 'A00015.body.html'), 'utf8') +
    '\n<p>Giá tham khảo 100.000đ/ngày.</p>\n');
  assert.strictEqual(WRAP().status, 0);
  const pub = OPW(['publish', '--ids', 'A00015,A00016', '--scope', 'fast']);
  assert.notStrictEqual(pub.status, 0, 'ungrounded quantitative claim must refuse the publish');
  assert.match(pub.stderr, /QA_EVIDENCE_STALE|GROUNDING_FAIL|publish gate/, 'grounding/evidence gate must fire');
  // truth untouched: rows PASS, no archive, no ledger event for the pair, clean state
  assert.strictEqual(statusOf('A00015'), 'PASS');
  for (const id of ['A00015', 'A00016'])
    assert.ok(!fs.existsSync(path.join(SBW, 'data', 'published', id + '.html')), 'no archive for ' + id);
  const ledger = JSON.parse(fs.readFileSync(path.join(SBW, 'data', 'state', 'throughput-ledger.json'), 'utf8'));
  const pairEvents = ledger.events.filter(e => e.op === 'publish' && Array.isArray(e.ids) &&
    JSON.stringify(e.ids.slice().sort()) === JSON.stringify(['A00015', 'A00016']));
  assert.strictEqual(pairEvents.length, 0, 'no publish event for the pair after refusal');
  const tx = JSON.parse(fs.readFileSync(path.join(SBW, 'data', 'state', 'transaction.json'), 'utf8'));
  assert.strictEqual(tx.active, false, 'no dangling transaction');
  fs.rmSync(SBW, { recursive: true, force: true });
});

test('writer-submit J: mid-publish build failure rolls back deterministically (staged journal restore)', () => {
  sbwCopy();
  makeSubmission(SBW, ['A00015', 'A00016'], 'f'.repeat(40));
  assert.strictEqual(WSC(['claim', '--ids', 'A00015,A00016']).status, 0);
  assert.strictEqual(WSC(['materialize', '--ids', 'A00015,A00016']).status, 0);
  assert.strictEqual(WRAP().status, 0);
  assert.strictEqual(OPW(['research', '--ids', 'A00015,A00016', '--scope', 'fast']).status, 0);
  assert.strictEqual(OPW(['qa', '--ids', 'A00015,A00016', '--scope', 'fast']).status, 0);
  assert.strictEqual(WSC(['assert-pass', '--ids', 'A00015,A00016']).status, 0);
  // sabotage the deterministic build AFTER staging begins (corrupt site config)
  fs.writeFileSync(path.join(SBW, 'config', 'site.json'), '{ broken json');
  const pub = OPW(['publish', '--ids', 'A00015,A00016', '--scope', 'fast']);
  assert.notStrictEqual(pub.status, 0, 'build failure must refuse the publish');
  assert.match(pub.stderr, /NOT committed|Rolling back/, 'staged publish must roll back deterministically');
  // rollback restores truth: rows back to PASS, no archive, tx clean, no ledger event
  assert.strictEqual(statusOf('A00015'), 'PASS');
  assert.strictEqual(statusOf('A00016'), 'PASS');
  for (const id of ['A00015', 'A00016'])
    assert.ok(!fs.existsSync(path.join(SBW, 'data', 'published', id + '.html')), 'no archive for ' + id);
  const tx = JSON.parse(fs.readFileSync(path.join(SBW, 'data', 'state', 'transaction.json'), 'utf8'));
  assert.strictEqual(tx.active, false, 'no dangling transaction after rollback');
  const ledger = JSON.parse(fs.readFileSync(path.join(SBW, 'data', 'state', 'throughput-ledger.json'), 'utf8'));
  const pairEvents = ledger.events.filter(e => e.op === 'publish' && Array.isArray(e.ids) &&
    JSON.stringify(e.ids.slice().sort()) === JSON.stringify(['A00015', 'A00016']));
  assert.strictEqual(pairEvents.length, 0, 'no publish event for the pair after rollback');
  fs.rmSync(SBW, { recursive: true, force: true });
});

test('writer-submit K: assert-published catches a missing durable result (fail-closed post-publish gate)', () => {
  sbwCopy();
  makeSubmission(SBW, ['A00015', 'A00016'], 'f'.repeat(40));
  assert.strictEqual(WSC(['claim', '--ids', 'A00015,A00016']).status, 0);
  assert.strictEqual(WSC(['materialize', '--ids', 'A00015,A00016']).status, 0);
  assert.strictEqual(WRAP().status, 0);
  assert.strictEqual(OPW(['research', '--ids', 'A00015,A00016', '--scope', 'fast']).status, 0);
  assert.strictEqual(OPW(['qa', '--ids', 'A00015,A00016', '--scope', 'fast']).status, 0);
  assert.strictEqual(WSC(['assert-pass', '--ids', 'A00015,A00016']).status, 0);
  assert.strictEqual(OPW(['publish', '--ids', 'A00015,A00016', '--scope', 'fast']).status, 0);
  // sabotage: remove a durable archive -> the post-publish gate must refuse
  fs.rmSync(path.join(SBW, 'data', 'published', 'A00015.html'));
  refusal(WSC(['assert-published', '--ids', 'A00015,A00016']), /PUBLISH_INVARIANTS_FAILED/);
  fs.rmSync(SBW, { recursive: true, force: true });
});

test('cleanup: remove writer-submit sandbox', () => {
  fs.rmSync(SBW, { recursive: true, force: true });
  assert.ok(!fs.existsSync(SBW));
});
