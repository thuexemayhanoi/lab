#!/usr/bin/env node
/** push-selection.js — deterministic push-scope selector for the push-driven
 * production hot path (factory-production.yml). Node port of /blog
 * scripts/factory/push-selection.py, adapted to the /lab draft layout:
 * the writer pushes _drafts/A#####.html (wrapped) + _drafts/A#####.body.html
 * (body) — the article id IS the filename (no front matter, like /vanchinh).
 *
 * The workflow reads the ADDED/MODIFIED list from `git diff HEAD~1..HEAD --
 * _drafts/` and calls this script to derive the EXACT article ids to
 * claim/QA/publish — the factory NEVER claims random PLANNED rows and NEVER
 * touches PUBLISHED rows.
 *
 * Input : --added <file> / --modified <file> (one path per line, repo-relative)
 * Output: one JSON line on stdout; exit 0 = selected/skip/paused, 3 = REFUSED.
 *
 * Rules (fail-closed; the matrix is the source of truth):
 *   - only _drafts/A#####.html and _drafts/A#####.body.html are drafts; any
 *     OTHER path under _drafts/ is a contract violation => REFUSED
 *   - id must exist in the matrix; PUBLISHED/BLOCKED rows are REFUSED
 *   - PLANNED rows   -> mode=new    (claim_ids + qa_ids)
 *   - RESEARCH/WRITING/QA/REVIEW/REPAIR/PASS rows -> mode=repair (qa_ids only)
 *   - a push mixing new + repair => REFUSED (finish the open chunk first)
 *   - more unique ids than chunk_size => REFUSED
 *   - every id needs the wrapped _drafts/A#####.html (body-only push refused)
 *   - new ids (and REPAIR ids still in RESEARCH) need a parseable
 *     data/research/<ID>.json packet (research BEFORE write is mandatory)
 *   - production-control enabled=false + new push -> mode=paused (exit 0,
 *     clean stop BEFORE claiming; repair of open work still proceeds)
 *   - no drafts in the push -> mode=skip (exit 0) — e.g. the publish commit
 *     removes drafts (D-only diff) so it must never re-trigger the loop
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const CONTROL = path.join(DATA, 'state', 'production-control.json');
const DRAFT_FILE_RE = /^_drafts\/(A\d{5})(\.body)?\.html$/;
const ANY_DRAFT_RE = /^_drafts\//;
const REPAIRABLE = ['RESEARCH', 'WRITING', 'QA', 'REVIEW', 'REPAIR', 'PASS'];

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

function loadControl() {
  try { const c = JSON.parse(fs.readFileSync(CONTROL, 'utf8')) || {};
    return { enabled: c.enabled !== false,
             chunk_size: Math.max(1, parseInt(c.chunk_size, 10) || 2) };
  } catch (e) { return { enabled: true, chunk_size: 2 }; }
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

function select(added, modified) {
  const control = loadControl();
  const out = { proceed: false, mode: 'skip', claim_ids: [], qa_ids: [], refuse: null,
                control_enabled: control.enabled, chunk_size: control.chunk_size };
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
  const ids = Array.from(seen.keys()).sort();
  const newIds = [], repairIds = [];
  for (const id of ids) {
    const row = byId[id];
    if (!row) return refuse(id + ' not in matrix — refusing to claim an unknown id');
    if (row.status === 'PUBLISHED') return refuse(id + ' is PUBLISHED — never overwrite a published article');
    if (row.status === 'BLOCKED') return refuse(id + ' is BLOCKED — protected row, no push-driven handling');
    if (row.status === 'PLANNED') newIds.push(id);
    else if (REPAIRABLE.includes(row.status)) repairIds.push(id);
    else return refuse(id + ' status ' + row.status + ' cannot be handled via push');
  }
  if (newIds.length && repairIds.length)
    return refuse('push mixes new (' + newIds.join(',') + ') and repair (' + repairIds.join(',') + ') — finish the open chunk (qa/publish the repair) before claiming new');
  const all = newIds.length ? newIds : repairIds;
  if (all.length > control.chunk_size)
    return refuse('push contains ' + all.length + ' article id(s) > chunk_size ' + control.chunk_size + ' — at most ' + control.chunk_size + ' article(s) per push; split the push');
  for (const id of all)
    if (!fs.existsSync(path.join(ROOT, '_drafts', id + '.html')))
      return refuse(id + ' has no wrapped draft _drafts/' + id + '.html (run wrap-drafts before push; a body-only push is refused)');
  for (const id of newIds.concat(repairIds.filter(id => byId[id].status === 'RESEARCH')))
    if (!packetParseable(id))
      return refuse(id + ' needs a parseable research packet data/research/' + id + '.json (research BEFORE write is mandatory)');
  if (newIds.length) {
    if (!control.enabled) { out.mode = 'paused'; return out; } // clean stop BEFORE claiming
    out.mode = 'new'; out.claim_ids = newIds; out.qa_ids = newIds.slice(); out.proceed = true; return out;
  }
  out.mode = 'repair'; out.qa_ids = repairIds; out.proceed = true; return out; // open work proceeds even while paused
}

function main() {
  const argv = process.argv.slice(2);
  const argFor = (flag) => { const i = argv.indexOf(flag); return (i >= 0 && i + 1 < argv.length) ? argv[i + 1] : null; };
  const out = select(readPaths(argFor('--added')), readPaths(argFor('--modified')));
  console.log(JSON.stringify(out));
  if (out.refuse) { console.error('REFUSED: ' + out.refuse); process.exit(3); }
}
if (require.main === module) main();
module.exports = { select };
