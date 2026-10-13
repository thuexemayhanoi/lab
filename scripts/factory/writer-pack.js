#!/usr/bin/env node
'use strict';

/**
 * /lab Writer Pack — READ ONLY, inspired by /total writer-pack.
 * Generates one exact contiguous PLANNED queue and optional offline lanes.
 * Does NOT claim IDs, update checkpoints, create drafts or publish.
 * Only ONE integrator may push the completed queue to main.
 */
const fs = require('node:fs');
const path = require('node:path');

function readJSON(file) {
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('Invalid state object: ' + file);
  return result;
}

function parseLine(line) {
  const cells = [];
  let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { value += '"'; i++; }
      else if (c === '"') quoted = false;
      else value += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { cells.push(value); value = ''; }
    else value += c;
  }
  if (quoted) throw new Error('Malformed quoted CSV record');
  cells.push(value);
  return cells;
}

function loadMatrix(root) {
  const dir = path.join(root, 'data');
  const parts = fs.readdirSync(dir).filter(f => /^content-matrix\.csv\.part\d+$/.test(f)).sort();
  if (!parts.length) throw new Error('Canonical matrix shards missing');
  parts.forEach((f, i) => {
    if (f !== 'content-matrix.csv.part' + String(i).padStart(2, '0'))
      throw new Error('Canonical matrix shards not contiguous: ' + f);
  });
  const raw = parts.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  const lines = raw.trimEnd().split(/\r?\n/);
  const headers = parseLine(lines.shift());
  const required = ['article_id', 'status', 'primary_keyword', 'search_intent',
    'output_path', 'canonical', 'requires_official_sources'];
  for (const field of required) if (!headers.includes(field)) throw new Error('Matrix missing ' + field);
  const rows = lines.filter(Boolean).map((line, i) => {
    const cells = parseLine(line);
    if (cells.length !== headers.length) throw new Error('Malformed matrix row ' + (i + 2));
    return Object.fromEntries(headers.map((h, j) => [h, cells[j]]));
  });
  if (!rows.length) throw new Error('Empty matrix');
  if (new Set(rows.map(r => r.article_id)).size !== rows.length)
    throw new Error('Duplicate article ID in matrix');
  return rows;
}

function makePack(root, { count = 2, writers = 1 } = {}) {
  if (!Number.isInteger(count) || count < 2 || count > 10)
    throw new Error('--count must be an integer from 2 to 10');
  if (!Number.isInteger(writers) || writers < 1 || writers > 3)
    throw new Error('--writers must be 1, 2 or 3');
  const state = path.join(root, 'data', 'state');
  const control = readJSON(path.join(state, 'production-control.json'));
  const checkpoint = readJSON(path.join(state, 'checkpoint.json'));
  const transaction = readJSON(path.join(state, 'transaction.json'));
  const lock = readJSON(path.join(state, 'writer-lock.json'));
  const rows = loadMatrix(root);
  const published = rows.filter(r => r.status === 'PUBLISHED');
  if (checkpoint.matrix_rows !== rows.length || checkpoint.published_count !== published.length)
    throw new Error('CHECKPOINT_DRIFT: row or published count differs from matrix; abort');
  if (!Array.isArray(checkpoint.active_chunk) || typeof transaction.active !== 'boolean' || typeof lock.locked !== 'boolean')
    throw new Error('Invalid critical checkpoint/transaction/lock schema');
  const summary = {
    mode: 'external-writer-push-driven', matrix_rows: rows.length,
    published_count: published.length, next_claimable_id: checkpoint.next_claimable_id,
    queue_min: control.queue_min, queue_max: control.queue_max,
    requested_count: count, requested_writers: writers
  };
  const result = (status, reason, extra = {}) => ({ status, reason, ...summary, ...extra });
  if (transaction.active || lock.locked)
    return result('WAIT_STATE', 'Active transaction/lock; recover through canonical operator before writing');
  const unfinished = rows.filter(r => ['RESEARCH', 'WRITING', 'QA', 'REVIEW', 'REPAIR', 'PASS'].includes(r.status));
  if (unfinished.length || checkpoint.active_chunk.length)
    return result('RESUME_FIRST', 'Repair existing open IDs before claiming new work',
      { open_ids: [...new Set([...checkpoint.active_chunk, ...unfinished.map(r => r.article_id)])] });
  if (control.enabled !== true)
    return result('PAUSED', 'Owner production-control.enabled is not true; no new claims');
  const min = control.queue_min, max = control.queue_max;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 2 || max > 10 || min > max)
    throw new Error('Invalid production-control queue bounds');
  if (count < min || count > max) throw new Error('Requested count outside active production-control queue bounds');
  const first = rows.find(r => r.status === 'PLANNED');
  if (!first) return result('DONE', 'No PLANNED IDs remain');
  if (first.article_id !== checkpoint.next_claimable_id)
    throw new Error('CHECKPOINT_DRIFT: next_claimable_id != first PLANNED in matrix');
  const pending = rows.filter(r => r.status === 'PLANNED').slice(0, count);
  if (pending.length < min) return result('WAIT_BATCH', 'Fewer PLANNED IDs than queue_min; no invalid partial push');
  // Fail closed if a draft for the new queue already exists on main.
  if (pending.some(r => fs.existsSync(path.join(root, '_drafts', r.article_id + '.html')) ||
    fs.existsSync(path.join(root, '_drafts', r.article_id + '.body.html'))))
    return result('WAIT_PUSH', 'Existing draft files for next queue; verify/repair the open push first');
  const queue = pending.map((r, i) => {
    const related = published
      .filter(p => p.cluster === r.cluster && p.article_id !== r.article_id)
      .slice(-3).map(p => ({ id: p.article_id, keyword: p.primary_keyword, canonical: p.canonical }));
    return {
      id: r.article_id, order: i + 1, keyword: r.primary_keyword,
      cluster: r.cluster, parent_topic: r.parent_topic, intent: r.search_intent,
      output_path: r.output_path, canonical: r.canonical, province: r.province,
      locality: r.locality, actual_service_area: r.actual_service_area,
      requires_research: r.requires_research === '1',
      requires_official_sources: r.requires_official_sources === '1',
      research_path: 'data/research/' + r.article_id + '.json',
      body_path: '_drafts/' + r.article_id + '.body.html',
      wrapped_path: '_drafts/' + r.article_id + '.html',
      related_published_candidates: related
    };
  });
  const lanes = Array.from({ length: writers }, (_, i) => ({ writer: i + 1, ids: [] }));
  queue.forEach((item, i) => lanes[i % writers].ids.push(item.id));
  return result('READY', 'Read-only plan. One integrator must gather all bodies, wrap, QA and push one complete queue.',
    { queue, lanes, first_id: queue[0].id, last_id: queue[queue.length - 1].id, count: queue.length });
}

function main(argv) {
  let count = 2, writers = 1, root = path.join(__dirname, '..', '..');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--count') count = Number(argv[++i]);
    else if (arg === '--writers') writers = Number(argv[++i]);
    else if (arg === '--root') root = path.resolve(argv[++i]);
    else if (arg === '--json') { /* output is always JSON */ }
    else throw new Error('Unknown writer-pack argument: ' + arg);
  }
  const pack = makePack(root, { count, writers });
  console.log(JSON.stringify(pack, null, 2));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error('WRITER_PACK_REFUSED: ' + e.message); process.exitCode = 1; }
}
module.exports = { makePack, loadMatrix, parseLine };
