#!/usr/bin/env node
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makePack } = require('../scripts/factory/writer-pack.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-writer-pack-'));
  const state = path.join(root, 'data', 'state');
  fs.mkdirSync(state, { recursive: true });
  const header = 'article_id,cluster,parent_topic,primary_keyword,search_intent,output_path,canonical,requires_official_sources,status,requires_research,province,locality,actual_service_area\n';
  const row = (id, status) => [
    id, 'RENTAL', 'Rentals', 'keyword ' + id, 'informational',
    'thue-xe-may/' + id + '/', 'https://example.org/lab/thue-xe-may/' + id + '/',
    '0', status, '1', '', '', 'informational_only'
  ].join(',') + '\n';
  fs.writeFileSync(path.join(root, 'data', 'content-matrix.csv.part00'), header +
    row('A00001', 'PUBLISHED') + row('A00002', 'PUBLISHED') +
    row('A00003', 'PLANNED') + row('A00004', 'PLANNED') +
    row('A00005', 'PLANNED') + row('A00006', 'PLANNED'));
  const write = (name, x) => fs.writeFileSync(path.join(state, name), JSON.stringify(x));
  write('production-control.json', { enabled: true, chunk_size: 2, queue_min: 2, queue_max: 10 });
  write('checkpoint.json', { matrix_rows: 6, published_count: 2, next_claimable_id: 'A00003', active_chunk: [] });
  write('transaction.json', { active: false });
  write('writer-lock.json', { locked: false });
  return { root, state, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('three offline lanes distribute one contiguous queue without duplicate IDs or writes', () => {
  const x = fixture();
  try {
    const before = fs.readFileSync(path.join(x.state, 'checkpoint.json'), 'utf8');
    const pack = makePack(x.root, { count: 4, writers: 3 });
    assert.equal(pack.status, 'READY');
    assert.deepEqual(pack.queue.map(r => r.id), ['A00003','A00004','A00005','A00006']);
    assert.deepEqual(pack.lanes.map(l => l.ids), [['A00003','A00006'], ['A00004'], ['A00005']]);
    assert.equal(new Set(pack.lanes.flatMap(l => l.ids)).size, 4);
    assert.equal(pack.queue[0].related_published_candidates.length, 2);
    assert.equal(fs.readFileSync(path.join(x.state, 'checkpoint.json'), 'utf8'), before);
  } finally { x.cleanup(); }
});

test('default producer target is two articles so verified pairs can be pushed promptly', () => {
  const x = fixture();
  try {
    const p = makePack(x.root);
    assert.equal(p.status, 'READY');
    assert.deepEqual(p.queue.map(r => r.id), ['A00003', 'A00004']);
    assert.equal(p.count, 2);
  } finally { x.cleanup(); }
});

test('pause stops new queue without editing state', () => {
  const x = fixture();
  try {
    x.write('production-control.json', { enabled: false, queue_min: 2, queue_max: 10 });
    assert.equal(makePack(x.root).status, 'PAUSED');
  } finally { x.cleanup(); }
});

test('unfinished pair takes priority over new queue', () => {
  const x = fixture();
  try {
    x.write('checkpoint.json', { matrix_rows: 6, published_count: 2, next_claimable_id: 'A00003', active_chunk: ['A00003'] });
    const p = makePack(x.root);
    assert.equal(p.status, 'RESUME_FIRST');
    assert.deepEqual(p.open_ids, ['A00003']);
  } finally { x.cleanup(); }
});

test('transaction/lock refuse new work', () => {
  const x = fixture();
  try {
    x.write('transaction.json', { active: true });
    assert.equal(makePack(x.root).status, 'WAIT_STATE');
    x.write('transaction.json', { active: false });
    x.write('writer-lock.json', { locked: true });
    assert.equal(makePack(x.root).status, 'WAIT_STATE');
  } finally { x.cleanup(); }
});

test('fail closed on checkpoint drift', () => {
  const x = fixture();
  try {
    x.write('checkpoint.json', { matrix_rows: 6, published_count: 2, next_claimable_id: 'A00004', active_chunk: [] });
    assert.throws(() => makePack(x.root), /CHECKPOINT_DRIFT/);
  } finally { x.cleanup(); }
});

test('partial draft cannot be silently skipped', () => {
  const x = fixture();
  try {
    fs.mkdirSync(path.join(x.root, '_drafts'));
    fs.writeFileSync(path.join(x.root, '_drafts', 'A00003.body.html'), '<h2>draft</h2>');
    assert.equal(makePack(x.root).status, 'WAIT_PUSH');
  } finally { x.cleanup(); }
});

test('bad controls or broken shards refuse', () => {
  const x = fixture();
  try {
    assert.throws(() => makePack(x.root, { count: 11 }), /count/);
    assert.throws(() => makePack(x.root, { writers: 4 }), /writers/);
    fs.renameSync(path.join(x.root, 'data', 'content-matrix.csv.part00'),
      path.join(x.root, 'data', 'content-matrix.csv.part01'));
    assert.throws(() => makePack(x.root), /shards not contiguous/);
  } finally { x.cleanup(); }
});
