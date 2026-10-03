#!/usr/bin/env node
/** push-selection.js — deterministic push-scope selector for the push-driven
 * production hot path (factory-production.yml). Node port of /blog
 * scripts/factory/push-selection.py, adapted to the /lab draft layout:
 * the writer pushes _drafts/A#####.html (wrapped) + _drafts/A#####.body.html
 * (body) — the article id IS the filename (no front matter, like /vanchinh).
 *
 * TURBO WRITE-AHEAD QUEUE CONTRACT (replaces the old EXACT-2-per-push):
 * the workflow reads the ADDED/MODIFIED list from `git diff HEAD~1..HEAD --
 * _drafts/` and calls this script to derive the article ids to consume.
 *   - NEW pushes: 2..queue_max (default 20) PLANNED ids in ONE writer push
 *     (the write-ahead queue). The ids must be a CONTIGUOUS run in matrix
 *     order, starting at the FIRST PLANNED row (next_claimable) — no
 *     duplicate, no PUBLISHED/BLOCKED row, no skip against matrix order.
 *     The queue is returned sorted by repository/matrix order and split
 *     into deterministic PAIRS of 2 (`pairs`); the factory consumes the
 *     pairs sequentially inside ONE production run.
 *   - REPAIR pushes: unchanged — at most chunk_size (2) open rows.
 *
 * Input : --added <file> / --modified <file> (one path per line, repo-relative)
 * Output: one JSON line on stdout; exit 0 = selected/skip/paused, 3 = REFUSED.
 *
 * Rules (fail-closed; the matrix is the source of truth):
 *   - only _drafts/A#####.html and _drafts/A#####.body.html are drafts; any
 *     OTHER path under _drafts/ is a contract violation => REFUSED
 *   - id must exist in the matrix; PUBLISHED/BLOCKED rows are REFUSED
 *   - PLANNED rows   -> mode=new (write-ahead queue: claim_ids + qa_ids + pairs)
 *   - RESEARCH/WRITING/QA/REVIEW/REPAIR/PASS rows -> mode=repair (qa_ids only)
 *   - a push mixing new + repair => REFUSED (finish the open chunk first)
 *   - new queue size must be queue_min..queue_max (default 2..20)
 *   - new queue must be contiguous in matrix order and start at the first
 *     PLANNED row (repository truth order); an unclaimed PLANNED row inside
 *     the span => REFUSED (skip against matrix order); PUBLISHED/BLOCKED
 *     rows inside the span are skipped over legally (dead/finished rows)
 *   - repair pushes: at most chunk_size (2) ids
 *   - every id needs the wrapped _drafts/A#####.html (body-only push refused)
 *   - new ids (and REPAIR ids still in RESEARCH) need a parseable
 *     data/research/<ID>.json packet (research BEFORE write is mandatory)
 *   - production-control enabled=false + new push -> mode=paused (exit 0,
 *     clean stop BEFORE claiming; repair of open work still proceeds)
 *   - no drafts in the push -> mode=skip (exit 0) — e.g. the publish commit
 *     removes drafts (D-only diff) so it must never re-trigger the loop
 *   - STALE pushes: a push containing ONLY drafts of already-PUBLISHED rows
 *     is hygiene, not production. Every wrapped _drafts/A#####.html must be
 *     BYTE-IDENTICAL to data/published/A#####.html -> mode=stale, proceed
 *     false, exit 0 (the workflow hygiene step deletes the stale drafts);
 *     a DIVERGED draft of a PUBLISHED row -> REFUSED (never overwrite a
 *     published article; resolve per docs/PROC-RECOVERY.md); a push mixing
 *     stale + new/repair ids -> REFUSED.
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const CONTROL = path.join(DATA, 'state', 'production-control.json');
const DRAFT_FILE_RE = /^_drafts\/(A\d{5})(\.body)?\.html$/;
const ANY_DRAFT_RE = /^_drafts\//;
const REPAIRABLE = ['RESEARCH', 'WRITING', 'QA', 'REVIEW', 'REPAIR', 'PASS'];
const DEFAULT_QUEUE_MIN = 2, DEFAULT_QUEUE_MAX = 20, PAIR_SIZE = 2;

// shards-first: on a clean Actions checkout the assembled
// data/content-matrix.csv is gitignored and absent — the .part shards are
// the canonical committed form (same contract as build-site.js).
const partFiles = fs.readdirSync(DATA).filter(f => /^content-matrix\.csv\.part/.test(f)).sort();
let csvText = partFiles.length ? partFiles.map(p => fs.readFileSync(path.join(DATA, p), 'utf8')).join('') : '';
if (!csvText) csvText = fs.readFileSync(path.join(DATA, 'content-matrix.csv'), 'utf8');

function parseCSV(text) {
  const L = text.split('\n');
  const parseLine = line => { const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) { const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } }
    out.push(cur); return out; };
  const H = parseLine(L[0]);
  return L.slice(1).filter(l => l.trim()).map(l => { const c = parseLine(l); const o = {}; H.forEach((h, i) => o[h] = c[i] || ''); return o; });
}
const rows = parseCSV(csvText);
const byId = {}; rows.forEach(r => byId[r.article_id] = r);
const matrixOrder = {}; rows.forEach((r, i) => matrixOrder[r.article_id] = i); // repository/matrix order

function loadControl() {
  try { const c = JSON.parse(fs.readFileSync(CONTROL, 'utf8')) || {};
    return { enabled: c.enabled !== false,
             chunk_size: Math.max(1, parseInt(c.chunk_size, 10) || 2),
             queue_min: Math.max(1, parseInt(c.queue_min, 10) || DEFAULT_QUEUE_MIN),
             queue_max: Math.max(2, parseInt(c.queue_max, 10) || DEFAULT_QUEUE_MAX) };
  } catch (e) { return { enabled: true, chunk_size: 2, queue_min: DEFAULT_QUEUE_MIN, queue_max: DEFAULT_QUEUE_MAX }; }
}
function readPaths(p) {
  if (!p) return [];
  try { return fs.readFileSync(p, 'utf8').split('\n').map(s => s.trim()).filter(Boolean); }
  catch (e) { return []; }
}
function packetParseable(id) {
  try { JSON.parse(fs.readFileSync(path.join(DATA, 'research', id + '.json'), 'utf8')); return true; }
  catch (e) { return false; }
}
function pairUp(ids) { // deterministic sequential pairs of PAIR_SIZE, in given order
  const pairs = [];
  for (let i = 0; i < ids.length; i += PAIR_SIZE) pairs.push(ids.slice(i, i + PAIR_SIZE));
  return pairs;
}

function select(added, modified) {
  const control = loadControl();
  const out = { proceed: false, mode: 'skip', claim_ids: [], qa_ids: [], pairs: [], stale_ids: [], refuse: null,
                control_enabled: control.enabled, chunk_size: control.chunk_size,
                queue_min: control.queue_min, queue_max: control.queue_max };
  const refuse = (msg) => { out.refuse = msg; return out; };
  const seen = new Map(); // article id -> draft path (added wins over modified)
  for (const list of [added, modified]) {
    for (const p of list) {
      if (!ANY_DRAFT_RE.test(p)) continue; // non-draft files in the push are no-ops
      const m = DRAFT_FILE_RE.exec(p);
      if (!m) return refuse('stray file under _drafts/ (only A#####.html / A#####.body.html allowed): ' + p);
      if (!seen.has(m[1])) seen.set(m[1], p);
    }
  }
  if (!seen.size) return out; // no drafts in the push -> skip
  const ids = Array.from(seen.keys());
  const newIds = [], repairIds = [], staleIds = [];
  for (const id of ids) {
    const row = byId[id];
    if (!row) return refuse(id + ' not in matrix — refusing to claim an unknown id');
    if (row.status === 'PUBLISHED') { staleIds.push(id); continue; } // hygiene path (below)
    if (row.status === 'BLOCKED') return refuse(id + ' is BLOCKED — protected row, no push-driven handling');
    if (row.status === 'PLANNED') newIds.push(id);
    else if (REPAIRABLE.includes(row.status)) repairIds.push(id);
    else return refuse(id + ' status ' + row.status + ' cannot be handled via push');
  }
  if (newIds.length && repairIds.length)
    return refuse('push mixes new (' + newIds.join(',') + ') and repair (' + repairIds.join(',') + ') — finish the open chunk (qa/publish the repair) before claiming new');
  // ---- STALE push: chỉ draft của row PUBLISHED (hygiene, không production) ----
  if (staleIds.length) {
    if (newIds.length || repairIds.length)
      return refuse('push mixes stale (PUBLISHED: ' + staleIds.join(',') + ') with ' + (newIds.length ? 'new (' + newIds.join(',') + ')' : 'repair (' + repairIds.join(',') + ')') + ' — stale drafts are hygiene-only; push them alone or resolve per docs/PROC-RECOVERY.md');
    const sorted = staleIds.slice().sort((a, b) => matrixOrder[a] - matrixOrder[b]);
    for (const id of sorted) {
      const draft = path.join(ROOT, '_drafts', id + '.html');
      const arch = path.join(DATA, 'published', id + '.html');
      if (!fs.existsSync(draft)) return refuse(id + ' has no wrapped draft _drafts/' + id + '.html (stale push needs the exact draft to compare)');
      if (!fs.existsSync(arch)) return refuse(id + ' has no archive data/published/' + id + '.html — cannot verify a stale draft without the published truth');
      const db = fs.readFileSync(draft), ab = fs.readFileSync(arch);
      if (!db.equals(ab))
        return refuse(id + ' is PUBLISHED and the pushed draft DIVERGED from data/published/' + id + '.html — never overwrite a published article; diverged drafts are NOT auto-deleted (resolve per docs/PROC-RECOVERY.md, e.g. qa-repair)');
    }
    out.mode = 'stale'; out.stale_ids = sorted; out.proceed = false;
    return out; // exit 0 — the workflow hygiene step deletes the byte-identical stale drafts
  }
  if (newIds.length) {
    // ---- TURBO write-ahead queue (new/PLANNED ids) ----
    const queue = newIds.slice().sort((a, b) => matrixOrder[a] - matrixOrder[b]); // repository/matrix order
    if (queue.length < control.queue_min)
      return refuse('queue push contains ' + queue.length + ' PLANNED id(s) < queue_min ' + control.queue_min + ' — a write-ahead queue push must carry ' + control.queue_min + '..' + control.queue_max + ' consecutive PLANNED ids');
    if (queue.length > control.queue_max)
      return refuse('queue push contains ' + queue.length + ' PLANNED id(s) > queue_max ' + control.queue_max + ' — at most ' + control.queue_max + ' article(s) per write-ahead queue push; split the push');
    const firstPlanned = rows.find(r => r.status === 'PLANNED');
    if (!firstPlanned || queue[0] !== firstPlanned.article_id)
      return refuse('queue must start at the first PLANNED row ' + (firstPlanned ? firstPlanned.article_id : '(none)') + ' in matrix order (repository truth) — got ' + queue[0] + ' (skip against matrix order)');
    // contiguity: inside the queue span every row is claimed, or already
    // PUBLISHED/BLOCKED (legally dead/finished). An unclaimed PLANNED row
    // inside the span is a skip against matrix order.
    const span = rows.slice(matrixOrder[queue[0]], matrixOrder[queue[queue.length - 1]] + 1);
    const claimed = new Set(queue);
    const hole = span.find(r => !claimed.has(r.article_id) && r.status === 'PLANNED');
    if (hole) return refuse('queue skips PLANNED row ' + hole.article_id + ' inside its span (skip against matrix order) — push ' + queue[0] + '..' + queue[queue.length - 1] + ' as one contiguous queue or repair the hole first');
    for (const id of queue)
      if (!fs.existsSync(path.join(ROOT, '_drafts', id + '.html')))
        return refuse(id + ' has no wrapped draft _drafts/' + id + '.html (run wrap-drafts before push; a body-only push is refused)');
    for (const id of queue)
      if (!packetParseable(id))
        return refuse(id + ' needs a parseable research packet data/research/' + id + '.json (research BEFORE write is mandatory)');
    if (!control.enabled) { out.mode = 'paused'; return out; } // clean stop BEFORE claiming
    out.mode = 'new'; out.claim_ids = queue; out.qa_ids = queue.slice(); out.pairs = pairUp(queue);
    out.proceed = true; return out;
  }
  // ---- repair push (open work): unchanged per-pair semantics ----
  const all = repairIds.slice().sort((a, b) => matrixOrder[a] - matrixOrder[b]);
  if (all.length > control.chunk_size)
    return refuse('push contains ' + all.length + ' article id(s) > chunk_size ' + control.chunk_size + ' — at most ' + control.chunk_size + ' repair article(s) per push; split the push');
  for (const id of all)
    if (!fs.existsSync(path.join(ROOT, '_drafts', id + '.html')))
      return refuse(id + ' has no wrapped draft _drafts/' + id + '.html (run wrap-drafts before push; a body-only push is refused)');
  for (const id of all.filter(id => byId[id].status === 'RESEARCH'))
    if (!packetParseable(id))
      return refuse(id + ' needs a parseable research packet data/research/' + id + '.json (research BEFORE write is mandatory)');
  out.mode = 'repair'; out.qa_ids = all; out.pairs = pairUp(all); out.proceed = true; return out; // open work proceeds even while paused
}

function main() {
  const argv = process.argv.slice(2);
  const argFor = (flag) => { const i = argv.indexOf(flag); return (i >= 0 && i + 1 < argv.length) ? argv[i + 1] : null; };
  const out = select(readPaths(argFor('--added')), readPaths(argFor('--modified')));
  console.log(JSON.stringify(out));
  if (out.refuse) { console.error('REFUSED: ' + out.refuse); process.exit(3); }
}
if (require.main === module) main();
module.exports = { select, pairUp };
