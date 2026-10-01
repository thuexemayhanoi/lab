#!/usr/bin/env node
/**
 * writer-submission.js — deterministic GitHub-only WRITER SUBMISSION channel
 * for the /lab content factory (ephemeral writer-branch inbox).
 *
 * PROBLEM THIS SOLVES (the last architectural gap vs /vanchinh):
 *   A writer with ONLY the GitHub connector (no local git, no local Node, no
 *   local _drafts/) must be able to submit exactly 2 articles and have GitHub
 *   Actions perform deterministic QA + atomic publish. Until now qa/publish
 *   were writer-direct-CLI only (drafts are gitignored, never committed), so a
 *   GitHub-only writer session could never produce articles.
 *
 * CHANNEL CONTRACT (docs/WRITER-SUBMIT.md):
 *   - The writer pushes ONLY candidate input to an ephemeral branch
 *     `writer/<pair>` (e.g. writer/A00015-A00016):
 *       writer-inbox/A00015.body.html   (semantic body fragment, one <h1>)
 *       writer-inbox/A00016.body.html
 *       writer-inbox/submission.json    ({ "base_main_sha": "<40-hex>", "ids": ["A00015","A00016"] })
 *       data/research/A00015.json       (research packet, engine policy applies)
 *       data/research/A00016.json
 *   - `.github/workflows/factory-writer-submit.yml` runs on push to
 *     `writer/**` and drives this module through the stages:
 *       validate-submission -> [base freshness + branch scope checks in shell]
 *       claim               -> canonical `operator.js prepare-next --count 2`
 *                              then an EXACT truth assert (claimed == submitted)
 *                              with byte-exact truth restore on mismatch
 *       materialize         -> copy writer-inbox/<ID>.body.html into
 *                              _drafts/<ID>.body.html INSIDE THE RUNNER ONLY
 *                              (_drafts/ stays gitignored, NEVER committed)
 *       [wrap-drafts.js -> operator.js research/qa/publish --scope fast]
 *       assert-pass         -> both rows PASS or the submission fails safely
 *                              (nothing pushed to main; branch preserved for repair)
 *       assert-published    -> post-publish invariants (tx inactive, lock free,
 *                              archives/public/sitemap, exactly-once ledger event)
 *       production-tree-check -> the clean main production commit may contain
 *                              ONLY canonical outputs (writer-inbox/** and
 *                              _drafts/** hard-denied).
 *
 * SAFETY (nothing here weakens /lab safety — QA thresholds, gates, atomic
 * publish, rollback, writer lock, transaction, checkpoint/matrix consistency
 * and the no-force-push discipline are ALL reused from the canonical engine):
 *   - This module NEVER writes prose, NEVER scores articles, NEVER redefines
 *     thresholds (rubric stays the single authority), NEVER invents IDs.
 *   - The canonical operator remains the ONLY QA/publish implementation; this
 *     runner IS the writer execution environment (drafts materialized here),
 *     so qa/publish run via the default writer channel ('cli'), never
 *     the actions command-file channel.
 *   - The production commit's parent is EXACTLY the submission base main SHA;
 *     the writer branch is NEVER merged into main and writer-inbox/** /
 *     _drafts/** can never reach main (temp-index exclusion + ls-files guard
 *     + path allowlist + ci-validate inbox-leak guard).
 *   - If origin/main moved: refuse (STALE_WRITER_BASE / MAIN_MOVED_DURING_PUBLISH).
 *     Never rebase prose automatically, never force push, never guess merges.
 *
 * Usage (workflow stages; see .github/workflows/factory-writer-submit.yml):
 *   writer-submission.js validate-submission [--branch <name>]
 *   writer-submission.js claim --ids A00015,A00016
 *   writer-submission.js materialize --ids A00015,A00016
 *   writer-submission.js assert-pass --ids A00015,A00016
 *   writer-submission.js assert-published --ids A00015,A00016
 *   writer-submission.js production-tree-check --base <sha> --tree <sha>
 */
'use strict';
const fs = require('fs'), path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');

const ID_RE = /^A\d{5}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^writer\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EXACT_PAIR = 2;             // the standard production pair: exactly 2 ids
const INBOX = 'writer-inbox';
const MANIFEST_REL = INBOX + '/submission.json';

class SubmissionError extends Error {
  // The machine-readable refusal code is part of the message too, so both the
  // CLI stderr AND direct module callers can match it deterministically.
  constructor(code, message) {
    super(String(message).startsWith(code) ? message : code + ': ' + message);
    this.code = code;
  }
}
function fail(code, msg) { throw new SubmissionError(code, msg); }

function readJsonFile(p, code, what) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) { fail(code, 'cannot read ' + what + ' (' + p + '): ' + e.message); }
  let m;
  try { m = JSON.parse(raw); }
  catch (e) { fail(code, what + ' is not valid JSON: ' + e.message); }
  return m;
}

// ---- branch name contract: ephemeral writer branches live under writer/ ----
function parseBranchName(ref) {
  const name = String(ref || '').replace(/^refs\/heads\//, '');
  if (!name) fail('BAD_WRITER_BRANCH', 'branch name missing (expected writer/<pair>)');
  if (!BRANCH_RE.test(name) || name.includes('..') || name.endsWith('.lock'))
    fail('BAD_WRITER_BRANCH', 'branch ' + JSON.stringify(name) + ' is not a writer submission branch — the submission channel only accepts ephemeral branches writer/<pair> (e.g. writer/A00015-A00016)');
  return name;
}

// ---- submission manifest: deterministic, strict, exactly one pair ----
function readManifest(root) {
  const p = path.join(root, MANIFEST_REL);
  if (!fs.existsSync(p)) fail('SUBMISSION_MANIFEST_MISSING', MANIFEST_REL + ' is required ({ "base_main_sha": "<40-hex main sha the branch was created from>", "ids": ["A#####","A#####"] })');
  const m = readJsonFile(p, 'SUBMISSION_MANIFEST_INVALID_JSON', 'submission manifest');
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('SUBMISSION_MANIFEST_INVALID_JSON', 'submission manifest must be a JSON object');
  for (const k of Object.keys(m)) if (!['base_main_sha', 'ids'].includes(k))
    fail('SUBMISSION_MANIFEST_UNKNOWN_FIELD', 'unknown submission manifest field: ' + k + ' (only base_main_sha and ids are accepted)');
  if (!SHA_RE.test(String(m.base_main_sha || '')))
    fail('SUBMISSION_MANIFEST_BAD_BASE', 'base_main_sha must be a full 40-hex commit SHA of main (got ' + JSON.stringify(m.base_main_sha) + ')');
  if (!Array.isArray(m.ids))
    fail('SUBMISSION_MUST_BE_A_PAIR', 'ids must contain EXACTLY ' + EXACT_PAIR + ' article ids (the standard production pair), got ' + JSON.stringify(m.ids));
  for (const id of m.ids) {
    if (typeof id !== 'string' || !ID_RE.test(id))
      fail('SUBMISSION_BAD_ID', 'malformed article id ' + JSON.stringify(id) + ' (expected A#####, exactly 5 digits)');
  }
  if (m.ids.length !== EXACT_PAIR)
    fail('SUBMISSION_MUST_BE_A_PAIR', 'ids must contain EXACTLY ' + EXACT_PAIR + ' article ids (the standard production pair), got ' + JSON.stringify(m.ids));
  if (new Set(m.ids).size !== m.ids.length)
    fail('SUBMISSION_DUPLICATE_ID', 'duplicate id in ids: ' + m.ids.join(','));
  return { base_main_sha: String(m.base_main_sha), ids: m.ids.slice() };
}

// ---- inbox contract: EXACTLY the pair bodies + the manifest, nothing else ----
function validateInbox(root, ids) {
  if (!fs.existsSync(path.join(root, MANIFEST_REL)))
    fail('SUBMISSION_MANIFEST_MISSING', MANIFEST_REL + ' is required ({ "base_main_sha": "<40-hex main sha the branch was created from>", "ids": ["A#####","A#####"] }) — the inbox must contain the pair bodies AND the manifest');
  const dir = path.join(root, INBOX);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
    fail('INBOX_MISSING', INBOX + '/ is missing — the writer must push ' + ids.map(i => i + '.body.html').join(', ') + ' and submission.json to ' + INBOX + '/');
  const entries = fs.readdirSync(dir).sort();
  for (const f of entries) if (!fs.statSync(path.join(dir, f)).isFile())
    fail('INBOX_NOT_FLAT', INBOX + '/ must be flat (no subdirectories): ' + f);
  const expected = ids.map(id => id + '.body.html').concat(['submission.json']).sort();
  const missing = expected.filter(f => !entries.includes(f));
  const extra = entries.filter(f => !expected.includes(f));
  if (missing.length || extra.length)
    fail('INBOX_FILESET_MISMATCH', INBOX + '/ must contain EXACTLY ' + expected.join(', ') +
      (missing.length ? ' — missing: ' + missing.join(', ') : '') +
      (extra.length ? ' — unexpected: ' + extra.join(', ') : ''));
  for (const id of ids) {
    const b = path.join(dir, id + '.body.html');
    const st = fs.statSync(b);
    if (st.size === 0) fail('INBOX_EMPTY_BODY', id + '.body.html is empty');
    if (st.size > 512 * 1024) fail('INBOX_BODY_TOO_LARGE', id + '.body.html exceeds 512KB');
    const txt = fs.readFileSync(b, 'utf8');
    if (txt.includes('\uFFFD')) fail('INBOX_BODY_NOT_UTF8', id + '.body.html is not valid UTF-8');
    if (/<!DOCTYPE|<\/html>/i.test(txt))
      fail('INBOX_BODY_MUST_BE_FRAGMENT', id + '.body.html must be a semantic BODY FRAGMENT (one <h1>, content), not a full HTML document — wrap-drafts.js adds the shell, head, canonical and schema');
    if (!/<h1[^>]*>/.test(txt))
      fail('INBOX_BODY_NO_H1', id + '.body.html has no <h1> (wrap-drafts derives the title and QA requires it)');
  }
  // DRAFT BOUNDARY: _drafts/ is gitignored FOREVER and must never be committed
  // on any branch — the runner materializes drafts from the inbox instead.
  if (fs.existsSync(path.join(root, '_drafts')))
    fail('DRAFT_DIR_ON_BRANCH', '_drafts/ must NEVER be committed (gitignored forever; Pages serves the repo root). Remove it from the writer branch; push candidate bodies to ' + INBOX + '/ instead');
  // Never race the Actions command-file channel: a pending coordinator command
  // means main-truth operations are in flight on another channel.
  if (fs.existsSync(path.join(root, 'data', 'state', 'operator-command.json')))
    fail('OPERATOR_COMMAND_PENDING', 'data/state/operator-command.json is present — a coordinator command is pending on the Actions command-file channel; wait for it to be consumed before submitting');
}

// ---- research packets: exist + parse + belong to the submitted ids.
// The FULL source policy (required fields, official sources, dates) is enforced
// by the canonical `operator.js research` op — this is deliberately NOT a
// second policy implementation, only an early, deterministic refusal. ----
function validatePackets(root, ids) {
  for (const id of ids) {
    const p = path.join(root, 'data', 'research', id + '.json');
    if (!fs.existsSync(p))
      fail('RESEARCH_PACKET_MISSING', 'data/research/' + id + '.json is missing — research BEFORE write is mandatory (docs/RESEARCH-BEFORE-WRITE.md)');
    const m = readJsonFile(p, 'RESEARCH_PACKET_INVALID_JSON', 'research packet ' + id);
    if (!m || typeof m !== 'object' || Array.isArray(m))
      fail('RESEARCH_PACKET_INVALID_JSON', 'research packet ' + id + ' must be a JSON object');
    if (m.article_id !== id)
      fail('RESEARCH_PACKET_ID_MISMATCH', 'research packet article_id ' + JSON.stringify(m.article_id) + ' != submitted id ' + id);
  }
}

// ---- base freshness: origin/main must equal the manifest base exactly ----
function assertFreshBase(baseMainSha, originMainSha) {
  const base = String(baseMainSha || ''), origin = String(originMainSha || '');
  if (!SHA_RE.test(base)) fail('SUBMISSION_MANIFEST_BAD_BASE', 'base_main_sha is not a 40-hex SHA');
  if (base !== origin)
    fail('STALE_WRITER_BASE', 'STALE_WRITER_BASE — origin/main (' + origin + ') != submission base_main_sha (' + base + '). Main moved since the writer branch was created. Refusing to rebase prose automatically: recreate the writer branch from FRESH main, re-apply the candidate files and resubmit. Nothing was claimed, nothing was published.');
  return true;
}

// ---- truth snapshot/restore (byte-exact; used by claim on refusal) ----
function truthSnapshot(root) {
  const rels = [];
  const dataDir = path.join(root, 'data');
  for (const f of fs.readdirSync(dataDir).filter(f => /^content-matrix\.csv\.part/.test(f)).sort())
    rels.push(path.join('data', f));
  if (fs.existsSync(path.join(root, 'data', 'content-matrix.csv')))
    rels.push(path.join('data', 'content-matrix.csv'));
  for (const rel of ['data/state/checkpoint.json', 'data/state/transaction.json',
    'data/state/writer-lock.json', 'data/state/throughput-ledger.json'])
    rels.push(rel);
  const repDir = path.join(root, 'reports', 'factory');
  if (fs.existsSync(repDir)) for (const f of fs.readdirSync(repDir)) rels.push(path.join('reports', 'factory', f));
  return rels.map(rel => ({ rel, bytes: fs.readFileSync(path.join(root, rel)) }));
}
function restoreSnapshot(root, snap) {
  for (const e of snap) fs.writeFileSync(path.join(root, e.rel), e.bytes);
}

// ---- claim EXACTLY the submitted pair via the canonical operator ----
// Runs `operator.js prepare-next --count 2 --scope fast` (the canonical
// claim), then asserts that the ids claimed by REPOSITORY TRUTH are EXACTLY
// the submitted ids. On ANY mismatch or refusal the pre-claim truth is
// restored byte-exact and the submission is refused — a different pair is
// never silently published.
function claimPair(root, ids) {
  const factory = require(path.join(root, 'scripts', 'factory', 'factory.js'));
  const before = truthSnapshot(root);
  const restore = () => restoreSnapshot(root, before);
  const op = path.join(root, 'scripts', 'factory', 'operator.js');
  const r = spawnSync(process.execPath, [op, 'prepare-next', '--count', String(ids.length), '--scope', 'fast'],
    { cwd: root, encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    restore();
    fail('PREPARE_NEXT_FAILED', 'canonical prepare-next refused the claim (unfinished chunk present? no PLANNED rows? active transaction/live lock?). Pre-claim truth restored byte-exact; nothing was claimed, nothing published.');
  }
  const rows = factory.loadMatrix();
  const claimed = rows.filter(x => factory.UNFINISHED.includes(x.status)).map(x => x.article_id).sort();
  const want = ids.slice().sort();
  let ck = null;
  try { ck = JSON.parse(fs.readFileSync(path.join(root, 'data', 'state', 'checkpoint.json'), 'utf8')); } catch (e) { ck = null; }
  const lastBatch = ck && Array.isArray(ck.last_batch) ? ck.last_batch.slice().sort() : null;
  if (JSON.stringify(claimed) !== JSON.stringify(want) || JSON.stringify(lastBatch) !== JSON.stringify(want)) {
    restore();
    fail('CLAIM_MISMATCH', 'CLAIM_MISMATCH — submitted ids (' + ids.join(',') + ') are not the pair claimed by repository truth (' + claimed.join(',') + '; checkpoint last_batch ' + JSON.stringify(lastBatch) + '). The claim was rolled back byte-exact; nothing was published. Submit EXACTLY the next claimable pair (checkpoint next_claimable_id) — never a different pair.');
  }
  return { claimed };
}

// ---- materialize candidate drafts INSIDE the runner (never committed) ----
function materializeDrafts(root, ids) {
  const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  if (!/(^|\n)_drafts\//.test(gi))
    fail('DRAFT_BOUNDARY_BROKEN', '.gitignore no longer excludes _drafts/ — refusing to materialize drafts (they would become public: Pages serves the repo root)');
  const drafts = path.join(root, '_drafts');
  fs.mkdirSync(drafts, { recursive: true });
  for (const id of ids) {
    const src = path.join(root, INBOX, id + '.body.html');
    if (!fs.existsSync(src)) fail('INBOX_MISSING', INBOX + '/' + id + '.body.html missing');
    fs.copyFileSync(src, path.join(drafts, id + '.body.html'));
  }
  return ids.slice();
}

// ---- QA gate for the submission channel: BOTH rows must be PASS.
// Thresholds come from the rubric (single authority). REVIEW (70–74) is never
// publishable; REPAIR rows keep the writer branch for editing. No fake repair,
// no invented prose, no new ids. ----
function assertPass(root, ids) {
  const factory = require(path.join(root, 'scripts', 'factory', 'factory.js'));
  const rubric = factory.rubric;
  const rows = factory.loadMatrix();
  const byId = {};
  rows.forEach(r => byId[r.article_id] = r);
  const problems = [];
  for (const id of ids) {
    const r = byId[id];
    if (!r) { problems.push(id + ': not in matrix'); continue; }
    if (r.status !== 'PASS')
      problems.push(id + ': status ' + r.status + ' — the submission requires PASS (qa_score >= ' + rubric.pass_min + '); REVIEW (' + rubric.review_min + '-' + (rubric.pass_min - 1) + ') is never publishable. Repair the candidate ON THE WRITER BRANCH and push again (max ' + rubric.max_repair_attempts + ' attempts); nothing was pushed to main.');
    const ev = factory.qaEvidence(id);
    if (!ev) problems.push(id + ': no QA evidence (data/qa/' + id + '.json)');
    else if (ev.result !== 'PASS' || Number(ev.score || 0) < rubric.pass_min)
      problems.push(id + ': QA evidence result=' + ev.result + ' score=' + ev.score + ' (must be PASS >= ' + rubric.pass_min + ')');
  }
  if (problems.length) fail('WRITER_QA_NOT_PASS', problems.join('; '));
  return true;
}

// ---- post-publish invariants on the pair (fast, deterministic) ----
function assertPublished(root, ids) {
  const factory = require(path.join(root, 'scripts', 'factory', 'factory.js'));
  const rubric = factory.rubric;
  const rows = factory.loadMatrix();
  const byId = {};
  rows.forEach(r => byId[r.article_id] = r);
  const problems = [];
  for (const id of ids) {
    const r = byId[id];
    if (!r) { problems.push(id + ': not in matrix'); continue; }
    if (r.status !== 'PUBLISHED') { problems.push(id + ': status ' + r.status + ' (expected PUBLISHED)'); continue; }
    const archive = path.join(root, 'data', 'published', id + '.html');
    if (!fs.existsSync(archive)) problems.push(id + ': missing durable archive data/published/' + id + '.html');
    const pubPage = path.join(root, r.output_path.replace(/^\//, ''), 'index.html');
    if (!fs.existsSync(pubPage)) problems.push(id + ': missing public page ' + r.output_path);
    const shards = fs.readdirSync(root).filter(f => /^sitemap-.*\.xml$/.test(f) && f !== 'sitemap-index.xml');
    if (!shards.some(f => fs.readFileSync(path.join(root, f), 'utf8').includes(r.canonical)))
      problems.push(id + ': canonical ' + r.canonical + ' not present in any sitemap shard');
    const ev = factory.qaEvidence(id);
    if (!ev) problems.push(id + ': no QA evidence');
    else {
      if (ev.result !== 'PASS' || Number(ev.score || 0) < rubric.pass_min) problems.push(id + ': QA evidence not PASS >= ' + rubric.pass_min);
      if (!ev.draft_sha256 || !fs.existsSync(archive) || factory.sha256Of(archive) !== ev.draft_sha256)
        problems.push(id + ': archive sha256 != evidence draft_sha256 (QA evidence must bind the exact published bytes)');
    }
  }
  // transaction/lock clean, checkpoint coherent with matrix truth, no draft leak
  const tx = factory.readTx();
  if (tx.active) problems.push('transaction ' + tx.id + ' (op=' + tx.operation + ') still ACTIVE — publish did not complete');
  const lock = factory.lockState();
  if (lock.held) problems.push('writer lock still held by ' + lock.raw.holder);
  const ck = JSON.parse(fs.readFileSync(path.join(root, 'data', 'state', 'checkpoint.json'), 'utf8'));
  const prog = factory.progressOf(rows);
  if (Number(ck.published_count) !== prog.published_count) problems.push('checkpoint published_count ' + ck.published_count + ' != matrix ' + prog.published_count);
  if (String(ck.next_claimable_id || '') !== String(prog.next_claimable_id || '')) problems.push('checkpoint next_claimable_id ' + ck.next_claimable_id + ' != matrix ' + prog.next_claimable_id);
  if (JSON.stringify((ck.active_chunk || []).slice().sort()) !== JSON.stringify(prog.active_chunk.slice().sort())) problems.push('checkpoint active_chunk != matrix unfinished rows');
  if (fs.existsSync(path.join(root, 'site', '_drafts'))) problems.push('drafts leaked into site/ staging tree');
  if (!/(^|\n)_drafts\//.test(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'))) problems.push('.gitignore no longer excludes _drafts/');
  // exactly-one durable publish event for this pair in the REAL ledger
  const ledger = factory.readLedger();
  const events = ledger.events.filter(e => e.op === 'publish' && Array.isArray(e.ids) &&
    JSON.stringify(e.ids.slice().sort()) === JSON.stringify(ids.slice().sort()));
  if (events.length !== 1) problems.push('expected EXACTLY ONE real ledger publish event for ' + ids.join(',') + ', found ' + events.length);
  if (problems.length) fail('PUBLISH_INVARIANTS_FAILED', problems.join('; '));
  return true;
}

// ---- clean-main production tree: canonical outputs ONLY ----
// The production commit may contain only legitimate canonical outputs; the
// submission channel artifacts (writer-inbox/**) and drafts (_drafts/**) are
// HARD-DENIED, plus every non-canonical path (engine sources, infra files,
// the gitignored assembled CSV, the operator command file).
const HARD_DENY = [
  [/^writer-inbox\//, 'writer-inbox/** must NEVER reach main (submission-only candidate input)'],
  [/^_drafts\//, '_drafts/** must NEVER be committed (gitignored forever)'],
  [/^site\//, 'site/ is the gitignored build intermediate — never committed'],
  [/^data\/content-matrix\.csv$/, 'the assembled matrix CSV is gitignored (canonical truth = the 4 shards)'],
  [/^data\/state\/operator-command\.json$/, 'the operator command file is command-channel metadata, never a writer-submission output'],
  [/^(scripts|tests|docs|\.github)\//, 'engine/source tree changed in a production publish commit'],
  [/^config\/(?!content-factory\.json$)/, 'config changed in a production publish commit (only config/content-factory.json runtime grounding ids are canonical)'],
  [/^(AGENTS|README)\.md$/, 'documentation changed in a production publish commit'],
  [/^\.gitignore$/, 'infra dotfile changed in a production publish commit'],
];
const ALLOWED = [
  /^data\/(research|qa|published)\/A\d{5}\.(json|html)$/,
  /^data\/content-matrix\.csv\.part\d+$/,
  /^data\/state\/(checkpoint|transaction|writer-lock|throughput-ledger|build-manifest)\.json$/,
  /^reports\/[A-Za-z0-9_./-]+$/,
  /^config\/content-factory\.json$/, // runtime grounding ids appended by publishCommit
  /^sitemap-[a-z0-9-]+\.xml$/,
  /^sitemap-index\.xml$/,
  /^(index\.html|404\.html|robots\.txt|\.nojekyll)$/,
  /^assets\/[A-Za-z0-9._-]+$/,
  /^([a-z0-9-]+\/){1,4}index\.html$/, // promoted public pages (hubs, geo hubs, articles)
];
// public outputs must be exactly what the deterministic build generated
// (build-site writes data/state/build-manifest.json) — writer-inbox can never
// be a public output.
function checkProductionPaths(root, changedPaths) {
  const manifestPath = path.join(root, 'data', 'state', 'build-manifest.json');
  let manifestFiles = new Set();
  try { manifestFiles = new Set(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files || []); } catch (e) { /* absence is itself a production-tree invariant failure below */ }
  const problems = [];
  if (!manifestFiles.size) problems.push('data/state/build-manifest.json missing/empty — the deterministic build manifest is required to validate public outputs');
  for (const p of changedPaths) {
    const s = String(p);
    const denied = HARD_DENY.find(([re, why]) => re.test(s));
    if (denied) { problems.push(s + ': ' + denied[1]); continue; }
    if (!ALLOWED.some(re => re.test(s))) { problems.push(s + ': not a canonical production output (allowlist: data/research|qa|published, matrix shards, data/state, reports, config/content-factory.json, sitemaps, assets indexes, promoted public pages)'); continue; }
    const isPublic = /^(index\.html|404\.html|robots\.txt|\.nojekyll)$/.test(s) ||
      /^sitemap-[a-z0-9-]+\.xml$/.test(s) || /^sitemap-index\.xml$/.test(s) ||
      /^assets\//.test(s) || /^([a-z0-9-]+\/){1,4}index\.html$/.test(s);
    if (isPublic && !manifestFiles.has(s)) problems.push(s + ': public output is NOT in the deterministic build manifest (data/state/build-manifest.json)');
  }
  return { ok: !problems.length, problems };
}

// ---- CLI ----
function parseIdsArg(v) {
  const list = String(v || '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.length !== EXACT_PAIR) fail('SUBMISSION_MUST_BE_A_PAIR', 'exactly ' + EXACT_PAIR + ' ids required, got ' + JSON.stringify(v));
  for (const id of list) if (!ID_RE.test(id)) fail('SUBMISSION_BAD_ID', 'malformed id ' + JSON.stringify(id) + ' (expected A#####, exactly 5 digits)');
  if (new Set(list).size !== list.length) fail('SUBMISSION_DUPLICATE_ID', 'duplicate id: ' + list.join(','));
  return list;
}

function exportEnv(obj) {
  if (!process.env.GITHUB_ENV) return;
  fs.appendFileSync(process.env.GITHUB_ENV, Object.entries(obj).map(([k, v]) => k + '=' + v).join('\n') + '\n');
}

function gitOut(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) fail('GIT_COMMAND_FAILED', 'git ' + args.join(' ') + ' failed: ' + String(r.stderr || r.stdout).slice(0, 500));
  return String(r.stdout || '').trim();
}

function usage() {
  console.error('Usage:');
  console.error('  writer-submission.js validate-submission [--branch <writer/...>]   # full submission preflight; exports SUBMISSION_IDS/SUBMISSION_BASE');
  console.error('  writer-submission.js claim --ids A00015,A00016                    # canonical prepare-next + EXACT truth assert (restore on mismatch)');
  console.error('  writer-submission.js materialize --ids A00015,A00016            # copy writer-inbox bodies into gitignored _drafts/ (runner only)');
  console.error('  writer-submission.js assert-pass --ids A00015,A00016            # BOTH rows must be PASS (rubric thresholds)');
  console.error('  writer-submission.js assert-published --ids A00015,A00016        # post-publish invariants on the pair');
  console.error('  writer-submission.js production-tree-check --base <sha> --tree <sha>  # clean-main production tree validation');
  process.exit(1);
}

function main(argv) {
  const root = ROOT;
  const [cmd, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) { const k = rest[i].slice(2); flags[k] = rest[++i]; if (flags[k] === undefined) usage(); }
    else usage();
  }
  let result;
  switch (cmd) {
    case 'validate-submission': {
      const branch = parseBranchName(flags.branch || process.env.GITHUB_REF_NAME || '');
      const manifest = readManifest(root);
      validateInbox(root, manifest.ids);
      validatePackets(root, manifest.ids);
      result = { ok: true, branch, ids: manifest.ids, base_main_sha: manifest.base_main_sha };
      exportEnv({ SUBMISSION_IDS: manifest.ids.join(','), SUBMISSION_BASE: manifest.base_main_sha, SUBMISSION_BRANCH: branch });
      break;
    }
    case 'claim': {
      const ids = parseIdsArg(flags.ids);
      validateInbox(root, ids);
      validatePackets(root, ids);
      const { claimed } = claimPair(root, ids);
      result = { ok: true, claimed };
      break;
    }
    case 'materialize': {
      const ids = parseIdsArg(flags.ids);
      result = { ok: true, materialized: materializeDrafts(root, ids) };
      break;
    }
    case 'assert-pass': {
      const ids = parseIdsArg(flags.ids);
      assertPass(root, ids);
      result = { ok: true, pass: ids };
      break;
    }
    case 'assert-published': {
      const ids = parseIdsArg(flags.ids);
      assertPublished(root, ids);
      result = { ok: true, published: ids };
      break;
    }
    case 'production-tree-check': {
      const base = String(flags.base || ''), tree = String(flags.tree || '');
      if (!SHA_RE.test(base) || !SHA_RE.test(tree)) fail('PRODUCTION_TREE_BAD_ARGS', '--base and --tree must be full 40-hex SHAs');
      // HARD assertions first: the production tree must not even CONTAIN
      // writer-inbox/** or _drafts/** (regardless of the diff).
      const treeFiles = gitOut(root, ['ls-tree', '-r', '--name-only', tree]).split('\n').filter(Boolean);
      const leak = treeFiles.filter(f => /^(writer-inbox|_drafts)\//.test(f));
      if (leak.length) fail('PRODUCTION_TREE_LEAK', 'production tree contains submission/draft artifacts: ' + leak.slice(0, 10).join(', '));
      const changed = gitOut(root, ['diff', '--name-only', base, tree]).split('\n').filter(Boolean);
      const check = checkProductionPaths(root, changed);
      if (!check.ok) fail('PRODUCTION_TREE_NOT_CANONICAL', 'the production commit changes non-canonical paths:\n' + check.problems.join('\n'));
      result = { ok: true, changed_files: changed.length, changed };
      break;
    }
    default:
      usage();
  }
  console.log('WRITER SUBMISSION ' + cmd.toUpperCase() + ' OK ' + JSON.stringify(result));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (e) {
    if (e instanceof SubmissionError) { console.error('WRITER SUBMISSION REFUSED (' + e.code + '): ' + e.message); process.exit(1); }
    throw e;
  }
}

module.exports = {
  SubmissionError, fail, parseBranchName, readManifest, validateInbox, validatePackets,
  assertFreshBase, truthSnapshot, restoreSnapshot, claimPair, materializeDrafts,
  assertPass, assertPublished, checkProductionPaths, parseIdsArg,
};
