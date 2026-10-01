#!/usr/bin/env node
/**
 * writer-request.js — STRICT request contract for the API-only 2-article
 * writer workflow (vanchinh-style continuous loop, /lab safety preserved).
 *
 * CHANNEL: a writer with ONLY a GitHub connector (no local git, no local
 * Node, no local _drafts/) creates a TRANSIENT branch `writer/<REQUEST_ID>`,
 * pushes temporary article input there, and finishes with a READY MARKER:
 *
 *   writer-input/<ID>.body.html        semantic body fragment (one <h1>)
 *   writer-input/<ID>.body.html        (exactly 2 — the production pair)
 *   data/research/<ID>.json            research packet (engine policy applies)
 *   .factory/requests/<REQUEST_ID>.json  READY MARKER — written LAST
 *
 * The marker is the ONLY workflow trigger (`.github/workflows/
 * writer-pair-publish.yml` fires on `.factory/requests/**` under `writer/**`).
 * Pages is served ONLY from main/root; a writer branch is never a Pages
 * source, and temporary writer input NEVER enters main (the publish branch
 * is built from a sanitized extraction — see scripts/factory/writer-pair.js).
 *
 * REQUEST SCHEMA (unknown field => REFUSE):
 *   {
 *     "request_id":   "A00015-A00016-001",           // safe id, == marker filename
 *     "base_main_sha": "<40-hex main sha>",          // STALE_BASE guard
 *     "ids":          ["A00015", "A00016"],          // EXACTLY the next 2 claimable
 *     "scope":        "fast",                        // pair loop is FAST only
 *     "coordinator":  "external-writer"              // optional, informational
 *   }
 *
 * CONTRACT ENFORCED HERE (every refusal has a stable machine-readable code):
 *   - exactly 2 ids, unique, format A##### (PAIR contract)
 *   - ids must be EXACTLY the next two claimable rows of the canonical
 *     matrix truth (no skipping, no arbitrary ids, no PUBLISHED rows) —
 *     or, when a stranded unfinished pair exists, exactly that pair
 *     (resume semantics; any other unfinished shape REFUSES)
 *   - scope = fast (the normal pair loop; deep/full are engine gates)
 *   - safe request_id; marker filename MUST equal request_id
 *   - base_main_sha required (full 40-hex); must equal the live origin/main
 *     HEAD at run time (STALE_BASE — never auto-rebase production state)
 *   - branch must match writer/** (the transient non-Pages writer branch)
 *   - body input writer-input/<ID>.body.html must exist for BOTH ids
 *   - research packet data/research/<ID>.json must exist and be valid JSON
 *
 * This module NEVER writes prose, NEVER scores, NEVER mutates production
 * truth. It only validates. Thresholds/gates stay in the canonical engine.
 *
 * CLI:
 *   writer-request.js validate <marker.json> --branch <refname> --origin-main-sha <sha>
 *     exit 0 = accepted (prints WRITER_REQUEST_OK {…})
 *     exit 3 = refused  (prints WRITER_REQUEST_REFUSED <CODE>: <detail>)
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const ID_RE = /^A\d{5}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const REQ_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BRANCH_RE = /^writer\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MARKER_RE = /^\.factory\/requests\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.json$/;
const FIELDS = ['request_id', 'base_main_sha', 'ids', 'scope', 'coordinator'];
const REQUIRED_FIELDS = ['request_id', 'base_main_sha', 'ids', 'scope'];
const SCOPE = 'fast';                 // the writer pair loop is FAST by contract
const PAIR = 2;                        // exactly 2 articles per request
const TERMINAL = new Set(['PLANNED', 'PUBLISHED', 'BLOCKED']);
const UNFINISHED = ['RESEARCH', 'WRITING', 'QA', 'REVIEW', 'REPAIR', 'PASS'];

function refuse(code, message) { return { ok: false, code, message }; }

// ---- next-two contract: what the canonical matrix truth allows next ----
// fresh:  no unfinished rows => the next pair = the FIRST TWO PLANNED rows
//         in matrix (row) order — no skipping, no arbitrary ids.
// resume: unfinished rows exist => the request must target EXACTLY that
//         stranded set, and it must itself be a pair (any other shape —
//         1, 3+ stranded rows — cannot be handled by the pair contract and
//         is an operator/recovery matter, never silently claimed around).
function nextPair(rows) {
  const unfinished = rows.filter(r => UNFINISHED.includes(r.status));
  if (!unfinished.length) {
    const planned = rows.filter(r => r.status === 'PLANNED');
    return { mode: 'fresh', expected: planned.slice(0, PAIR).map(r => r.article_id), unfinished: [] };
  }
  return { mode: 'resume', expected: null, unfinished: unfinished.map(r => r.article_id) };
}

// ---- strict request validation (pure: all truth passed in) ----
// ctx: { rows }        canonical matrix rows of the BASE truth
// Returns { ok: true, resolved } or { ok: false, code, message }.
function validateRequest(req, ctx) {
  if (!req || typeof req !== 'object' || Array.isArray(req))
    return refuse('BAD_REQUEST', 'request must be a JSON object');
  for (const k of Object.keys(req)) if (!FIELDS.includes(k))
    return refuse('UNKNOWN_FIELD', 'unknown request field: ' + k + ' (accepted: ' + FIELDS.join(', ') + ')');
  for (const k of REQUIRED_FIELDS) if (!(k in req))
    return refuse('MISSING_FIELD', 'missing required request field: ' + k);
  if (typeof req.request_id !== 'string' || !REQ_ID_RE.test(req.request_id) || req.request_id.includes('..'))
    return refuse('BAD_REQUEST_ID', 'request_id must match ' + REQ_ID_RE + ' (no whitespace/slashes): ' + JSON.stringify(req.request_id));
  if (typeof req.base_main_sha !== 'string' || !SHA_RE.test(req.base_main_sha))
    return refuse('BAD_BASE_SHA', 'base_main_sha must be a full 40-hex commit SHA of main (got ' + JSON.stringify(req.base_main_sha) + ')');
  if (!Array.isArray(req.ids))
    return refuse('BAD_IDS', 'ids must be an array of article ids');
  if (req.ids.length !== PAIR)
    return refuse('NOT_TWO_IDS', 'ids must contain EXACTLY ' + PAIR + ' article ids (the standard production pair), got ' + req.ids.length);
  for (const id of req.ids) {
    if (typeof id !== 'string' || !ID_RE.test(id))
      return refuse('BAD_ID_FORMAT', 'malformed article id ' + JSON.stringify(id) + ' (expected A#####, exactly 5 digits)');
  }
  if (new Set(req.ids).size !== req.ids.length)
    return refuse('DUPLICATE_ID', 'duplicate id in ids: ' + req.ids.join(','));
  if (req.scope !== SCOPE)
    return refuse('BAD_SCOPE', 'scope must be exactly "' + SCOPE + '" for a writer pair request (got ' + JSON.stringify(req.scope) + ') — deep/full are engine verification gates, never writer requests');
  if (req.coordinator !== undefined) {
    if (typeof req.coordinator !== 'string' || !req.coordinator.length || req.coordinator.length > 100 || /[\r\n]/.test(req.coordinator))
      return refuse('BAD_COORDINATOR', 'coordinator must be a short single-line string');
  }
  // ---- canonical matrix truth (rows of the BASE state) ----
  const rows = (ctx && ctx.rows) || [];
  if (!rows.length) return refuse('MATRIX_MISSING', 'canonical matrix truth is empty/missing');
  const byId = {}; rows.forEach(r => byId[r.article_id] = r);
  for (const id of req.ids) {
    const r = byId[id];
    if (!r) return refuse('NOT_IN_MATRIX', id + ' not in the canonical matrix');
    if (r.status === 'PUBLISHED') return refuse('PUBLISHED_ID', id + ' is already PUBLISHED — the pair contract never overwrites production');
    if (r.status === 'BLOCKED') return refuse('PUBLISHED_ID', id + ' is BLOCKED — blocked rows are terminal; resolve per docs/PROC-RECOVERY.md');
  }
  const np = nextPair(rows);
  if (np.mode === 'fresh') {
    const want = new Set(np.expected);
    const got = new Set(req.ids);
    if (want.size !== PAIR || [...got].some(id => !want.has(id)) || [...want].some(id => !got.has(id)))
      return refuse('NOT_NEXT_TWO', 'requested ids [' + req.ids.join(',') + '] are not EXACTLY the next two claimable rows [' + np.expected.join(',') + '] — no skipping, no arbitrary ids');
  } else {
    if (np.unfinished.length !== PAIR || new Set(np.unfinished).size !== new Set(req.ids).size ||
        [...new Set(req.ids)].some(id => !np.unfinished.includes(id)))
      return refuse('CHUNK_NOT_A_PAIR', 'unfinished rows exist [' + np.unfinished.join(',') + '] — a writer request must resume EXACTLY that pair; any other unfinished shape is an operator/recovery matter (docs/PROC-RECOVERY.md)');
  }
  return { ok: true, resolved: {
    request_id: req.request_id,
    base_main_sha: req.base_main_sha,
    ids: req.ids.slice().sort(),           // canonical (sorted) pair order
    scope: req.scope,
    coordinator: req.coordinator || null,
    mode: np.mode                          // fresh | resume (runner semantics)
  } };
}

// ---- runtime input checks (runner tree: the writer branch checkout) ----
function validateInputs(resolved, root) {
  const R = root || ROOT;
  for (const id of resolved.ids) {
    const body = path.join(R, 'writer-input', id + '.body.html');
    if (!fs.existsSync(body)) return refuse('MISSING_BODY', 'writer-input/' + id + '.body.html is missing on the writer branch (exactly 2 body inputs are required)');
    const packet = path.join(R, 'data', 'research', id + '.json');
    if (!fs.existsSync(packet)) return refuse('MISSING_RESEARCH', 'data/research/' + id + '.json is missing — research BEFORE write is mandatory (docs/RESEARCH-BEFORE-WRITE.md)');
    try { JSON.parse(fs.readFileSync(packet, 'utf8')); }
    catch (e) { return refuse('BAD_RESEARCH', 'data/research/' + id + '.json is not valid JSON: ' + e.message); }
  }
  return { ok: true };
}

// ---- branch + stale-base + marker contracts ----
function validateBranch(branch) {
  const name = String(branch || '').replace(/^refs\/heads\//, '');
  if (!name || !BRANCH_RE.test(name) || name.includes('..') || name.endsWith('.lock'))
    return refuse('BAD_BRANCH', 'branch ' + JSON.stringify(name) + ' is not a transient writer branch — the writer request channel only accepts writer/** (temporary input never enters main; Pages serves main/root only)');
  return { ok: true, branch: name };
}
function validateStaleBase(baseMainSha, originMainSha) {
  if (!SHA_RE.test(String(originMainSha || '')))
    return refuse('BAD_ORIGIN_MAIN', 'origin/main HEAD is not a full 40-hex SHA: ' + JSON.stringify(originMainSha));
  if (originMainSha !== baseMainSha)
    return refuse('STALE_BASE', 'origin/main HEAD ' + originMainSha + ' != request.base_main_sha ' + baseMainSha + ' — main moved since the request was written. REFUSING (never auto-rebase stale production state): fetch fresh main, re-create the writer branch + inputs + marker against the new base.');
  return { ok: true };
}
function validateMarkerPath(markerPath) {
  const rel = String(markerPath || '').replace(/\\/g, '/');
  const m = MARKER_RE.exec(rel);
  if (!m) return refuse('BAD_MARKER_PATH', 'ready marker must live at .factory/requests/<REQUEST_ID>.json (got ' + rel + ')');
  return { ok: true, request_id_from_filename: m[1] };
}

// ---- full validation used by the workflow and the runner ----
// ctx: { branch, originMainSha, rows, markerPath, root }
function validateAll(req, ctx) {
  const marker = validateMarkerPath(ctx.markerPath);
  if (!marker.ok) return marker;
  const branch = validateBranch(ctx.branch);
  if (!branch.ok) return branch;
  const v = validateRequest(req, ctx);   // schema first: BAD_BASE_SHA before STALE_BASE
  if (!v.ok) return v;
  const stale = validateStaleBase(req.base_main_sha, ctx.originMainSha);
  if (!stale.ok) return stale;
  if (marker.request_id_from_filename !== v.resolved.request_id)
    return refuse('MARKER_MISMATCH', 'marker filename request id "' + marker.request_id_from_filename + '" != request.request_id "' + v.resolved.request_id + '" (the marker file name MUST equal the request id)');
  const inputs = validateInputs(v.resolved, ctx.root);
  if (!inputs.ok) return inputs;
  return { ok: true, resolved: v.resolved, branch: branch.branch };
}

// ---- CLI ----
function failRefused(code, message) {
  console.error('WRITER_REQUEST_REFUSED ' + code + ': ' + message);
  process.exit(3);
}
function usage() {
  console.error('Usage: writer-request.js validate <marker.json> --branch <refname> --origin-main-sha <40-hex>');
  process.exit(1);
}
function main(argv) {
  const [sub, file, ...rest] = argv;
  if (sub !== 'validate' || !file || file.startsWith('--')) usage();
  let branch = '', originMainSha = '';
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--branch') branch = rest[++i];
    else if (rest[i] === '--origin-main-sha') originMainSha = rest[++i];
    else usage();
  }
  const markerPath = path.isAbsolute(file) ? path.relative(ROOT, file) : file;
  let raw;
  try { raw = fs.readFileSync(path.join(ROOT, markerPath), 'utf8'); }
  catch (e) { failRefused('MARKER_MISSING', 'cannot read ready marker ' + markerPath + ': ' + e.message); }
  let req;
  try { req = JSON.parse(raw); }
  catch (e) { failRefused('BAD_MARKER_JSON', markerPath + ' is not valid JSON: ' + e.message); }
  const rows = (() => {
    const factory = require(path.join(__dirname, 'factory.js'));
    return factory.loadMatrix();
  })();
  const v = validateAll(req, { branch, originMainSha, rows, markerPath, root: ROOT });
  if (!v.ok) failRefused(v.code, v.message);
  console.log('WRITER_REQUEST_OK ' + JSON.stringify(v.resolved));
  if (process.env.GITHUB_OUTPUT) {
    const env = { REQUEST_ID: v.resolved.request_id, IDS: v.resolved.ids.join(','), BASE_MAIN_SHA: v.resolved.base_main_sha, PAIR_MODE: v.resolved.mode };
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(env).map(([k, val]) => k + '=' + val).join('\n') + '\n');
  }
}
if (require.main === module) main(process.argv.slice(2));
module.exports = { validateRequest, validateInputs, validateBranch, validateStaleBase, validateMarkerPath, validateAll, nextPair,
  FIELDS, REQUIRED_FIELDS, ID_RE, SHA_RE, REQ_ID_RE, BRANCH_RE, MARKER_RE, SCOPE, PAIR, UNFINISHED, TERMINAL };
