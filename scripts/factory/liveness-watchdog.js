#!/usr/bin/env node
/**
 * FACTORY LIVENESS WATCHDOG — hardening F3 (Tier 4 liveness).
 *
 * Mục tiêu: phát hiện trạng thái "workflow xanh nhưng factory KHÔNG tiến"
 * (unfinished work đứng lâu, command treo, transaction/lock bất thường,
 * checkpoint + ledger ngừng tiến) — những trạng thái mà CI/invariant xanh
 * vì chúng chỉ kiểm cây snapshot, không kiểm dòng thời gian.
 *
 * HỢP ĐỒNG TUYỆT ĐỐI:
 *   - READ-ONLY tuyệt đối: không ghi, không commit, không push, không
 *     force-clear lock/transaction, không claim/publish, không sửa state.
 *   - Không coi người dùng CHỦ ĐỘNG NGHỈ là lỗi (idle sạch = PASS).
 *   - Chỉ đọc repository truth: checkpoint + matrix + transaction +
 *     writer-lock + throughput-ledger + operator-command file.
 *
 * Trạng thái:
 *   HEALTHY IDLE  : active_chunk rỗng, không command pending, tx inactive,
 *                   không lock sống → PASS.
 *   HEALTHY ACTIVE: có work-in-progress nhưng có progress event mới trong
 *                   ngưỡng → PASS.
 *   PENDING COMMAND STALE: operator-command.json tồn tại quá lâu chưa consume → FAIL.
 *   STALLED       : active_chunk có unfinished work nhưng ledger/checkpoint
 *                   không có event mới quá ngưỡng → FAIL.
 *   STALE/EXPIRED LOCK + unfinished work → FAIL; lock hết hạn nhưng idle sạch → WARN.
 *   ACTIVE TX quá tuổi an toàn → FAIL.
 *
 * Exit code (deterministic): 0 = PASS, 2 = WARN, 1 = FAIL.
 *
 * Usage:
 *   node scripts/factory/liveness-watchdog.js [root]
 *     [--now ISO] [--command-stale-minutes N] [--stalled-minutes N]
 *     [--tx-max-minutes N] [--json]
 *   API: const {evaluate, collectSnapshot, DEFAULT_THRESHOLDS, UNFINISHED}
 *        = require('./scripts/factory/liveness-watchdog.js')
 */

'use strict';

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join('data', 'state');
const CHECKPOINT = path.join(STATE_DIR, 'checkpoint.json');
const TRANSACTION = path.join(STATE_DIR, 'transaction.json');
const WRITER_LOCK = path.join(STATE_DIR, 'writer-lock.json');
const LEDGER = path.join(STATE_DIR, 'throughput-ledger.json');
const COMMAND_FILE = path.join(STATE_DIR, 'operator-command.json');
const MATRIX = path.join('data', 'content-matrix.csv');

// Non-terminal chunk states (phải khớp factory.js UNFINISHED — single truth).
const UNFINISHED = ['RESEARCH', 'WRITING', 'QA', 'REVIEW', 'REPAIR', 'PASS'];

const DEFAULT_THRESHOLDS = {
  commandStaleMinutes: 120, // command file chưa consume quá 2h = treo
  stalledMinutes: 720, // active chunk không tiến quá 12h = đứng
  txMaxMinutes: 120, // active tx quá 2h = bất thường (publish tx là giây/phút)
};

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_WARN = 2;

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function readJsonSafe(file, missing) {
  try {
    return readJson(file);
  } catch (e) {
    return missing;
  }
}

function parseMinutes(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ageMinutes(nowMs, iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (nowMs - t) / 60000;
}

/**
 * Đọc toàn bộ repository truth cần thiết — READ-ONLY, không bao giờ ghi.
 * Trả về snapshot thuần dữ liệu để evaluate() thuần hàm dùng cho unit test.
 */
function collectSnapshot(root, nowIso) {
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  if (!Number.isFinite(now)) throw new Error('invalid --now: ' + nowIso);
  const abs = (p) => path.join(root, p);

  const checkpoint = readJsonSafe(abs(CHECKPOINT), null);
  const transaction = readJsonSafe(abs(TRANSACTION), null);
  const lock = readJsonSafe(abs(WRITER_LOCK), null);
  const ledger = readJsonSafe(abs(LEDGER), { events: [] });

  // Pending command + tuổi của FILE (thời điểm coordinator commit nó).
  let command = null;
  let commandFileMinutes = null;
  try {
    const st = fs.statSync(abs(COMMAND_FILE));
    command = readJson(abs(COMMAND_FILE));
    commandFileMinutes = (now - st.mtimeMs) / 60000;
  } catch (e) {
    /* không có command pending — bình thường */
  }

  // Matrix truth: map article_id -> status (split(',') an toàn vì các cột
  // id/status không bao giờ chứa dấu phẩy).
  const statuses = new Map();
  if (fs.existsSync(abs(MATRIX))) {
    const lines = fs.readFileSync(abs(MATRIX), 'utf8').split(/\r?\n/);
    const header = lines[0].split(',');
    const idIdx = header.indexOf('article_id');
    const stIdx = header.indexOf('status');
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const cols = lines[i].split(',');
      if (cols.length > Math.max(idIdx, stIdx)) statuses.set(cols[idIdx], cols[stIdx]);
    }
  }

  // Progress event mới nhất trong ledger (mọi op đều là dấu hiệu tiến).
  const events = Array.isArray(ledger.events) ? ledger.events : [];
  let lastProgressMinutes = null;
  let lastProgressAt = null;
  for (const ev of events) {
    const t = ev && (ev.finished_at || ev.started_at);
    if (!t) continue;
    const age = ageMinutes(now, t);
    if (age !== null && (lastProgressMinutes === null || age < lastProgressMinutes)) {
      lastProgressMinutes = age;
      lastProgressAt = t;
    }
  }

  const activeChunk = checkpoint && Array.isArray(checkpoint.active_chunk) ? checkpoint.active_chunk : [];

  return {
    nowIso: new Date(now).toISOString(),
    checkpoint,
    activeChunk,
    activeChunkUnfinished: activeChunk.filter((id) => UNFINISHED.includes(statuses.get(id))).length,
    matrixRows: statuses.size,
    transaction: transaction || { active: false },
    lock: lock || { locked: false },
    ledgerEvents: events.length,
    lastProgressMinutes,
    lastProgressAt,
    command,
    commandFileMinutes,
  };
}

function lockIsExpired(lock, nowIso) {
  if (!lock || !lock.locked) return false;
  const age = ageMinutes(Date.parse(nowIso), lock.expires_at);
  return age !== null && age > 0; // expires_at đã qua
}

function unfinishedWorkPresent(snap) {
  return snap.activeChunk.length > 0 || snap.transaction.active || snap.command !== null;
}

/**
 * evaluate(snapshot, thresholds) — THUẦN HÀM, không I/O, dùng được cho unit
 * test với snapshot tổng hợp. Trả về {status, exitCode, findings}.
 */
function evaluate(snap, thresholdsIn) {
  const th = Object.assign({}, DEFAULT_THRESHOLDS, thresholdsIn || {});
  const findings = [];
  let worst = EXIT_PASS;

  const add = (status, code, message) => {
    findings.push({ status, code, message });
    if (code === EXIT_FAIL) worst = EXIT_FAIL;
    else if (code === EXIT_WARN && worst === EXIT_PASS) worst = EXIT_WARN;
  };

  const tx = snap.transaction || {};
  const lock = snap.lock || {};

  // 1) PENDING COMMAND STALE — command file treo chưa được consume.
  if (snap.command !== null) {
    const age = snap.commandFileMinutes;
    if (age !== null && age > th.commandStaleMinutes) {
      add('PENDING_COMMAND_STALE', EXIT_FAIL,
        'operator-command.json đã ' + Math.round(age) + ' phút chưa được consume (> ' +
        th.commandStaleMinutes + ' phút) — lệnh đang treo, không op nào tiêu thụ nó.');
    } else {
      findings.push({ status: 'PENDING_COMMAND_FRESH', code: EXIT_PASS,
        message: 'command pending (tuổi ' + Math.round(age || 0) + ' phút) — trong ngưỡng bình thường.' });
    }
  }

  // 2) ACTIVE TRANSACTION quá tuổi an toàn.
  if (tx.active) {
    const age = ageMinutes(Date.parse(snap.nowIso), tx.started_at);
    if (age === null) {
      add('TX_NO_START', EXIT_FAIL, 'transaction active nhưng thiếu started_at — state không đọc được tuổi.');
    } else if (age > th.txMaxMinutes) {
      add('ACTIVE_TX_TOO_OLD', EXIT_FAIL,
        'transaction ' + tx.id + ' (op=' + tx.operation + ') active ' + Math.round(age) +
        ' phút (> ' + th.txMaxMinutes + ' phút) — publish tx chỉ nên kéo dài giây/phút.');
    } else {
      findings.push({ status: 'TX_ACTIVE_FRESH', code: EXIT_PASS,
        message: 'transaction active ' + Math.round(age) + ' phút — trong ngưỡng an toàn.' });
    }
  }

  // 3) LOCK hết hạn: có unfinished work = FAIL; idle sạch chỉ là vệ sinh = WARN.
  if (lock.locked && lockIsExpired(lock, snap.nowIso)) {
    if (unfinishedWorkPresent(snap)) {
      add('EXPIRED_LOCK_UNFINISHED_WORK', EXIT_FAIL,
        'writer lock của ' + lock.holder + ' đã hết hạn (expires_at ' + lock.expires_at +
        ') trong khi vẫn còn unfinished work (active_chunk ' + snap.activeChunk.length +
        ' / tx active=' + Boolean(tx.active) + ') — chạy op recover qua kênh chuẩn, KHÔNG force-clear.');
    } else {
      add('EXPIRED_LOCK_IDLE', EXIT_WARN,
        'writer lock của ' + lock.holder + ' đã hết hạn nhưng không có unfinished work — vệ sinh qua op recover (watchdog READ-ONLY, không tự clear).');
    }
  }

  // 4) STALLED — có work-in-progress nhưng không có progress event mới.
  const hasUnfinishedChunk = snap.activeChunkUnfinished > 0;
  if (hasUnfinishedChunk) {
    const age = snap.lastProgressMinutes;
    if (age === null) {
      add('STALLED', EXIT_FAIL,
        'active chunk có ' + snap.activeChunkUnfinished + ' row unfinished (' +
        UNFINISHED.join('/') + ') nhưng ledger không có event nào — checkpoint/ledger không tiến.');
    } else if (age > th.stalledMinutes) {
      add('STALLED', EXIT_FAIL,
        'active chunk có ' + snap.activeChunkUnfinished + ' row unfinished nhưng progress event mới nhất đã ' +
        Math.round(age) + ' phút trước (> ' + th.stalledMinutes + ' phút) — factory không tiến.');
    } else {
      findings.push({ status: 'PROGRESS_OK', code: EXIT_PASS,
        message: 'active chunk đang có unfinished work nhưng progress mới (' + Math.round(age) + ' phút trước).' });
    }
  }

  // 5) Kết luận tổng.
  let status;
  if (worst === EXIT_FAIL) status = 'FAIL';
  else if (worst === EXIT_WARN) status = 'WARN';
  else if (unfinishedWorkPresent(snap)) status = 'HEALTHY ACTIVE';
  else status = 'HEALTHY IDLE';

  return { status, exitCode: worst, findings };
}

function usage() {
  console.error('Usage: node scripts/factory/liveness-watchdog.js [root] [--now ISO]');
  console.error('  [--command-stale-minutes N] [--stalled-minutes N] [--tx-max-minutes N] [--json]');
  console.error('Exit codes: 0 = PASS, 2 = WARN, 1 = FAIL. READ-ONLY: never mutates state.');
  process.exit(1);
}

function main(argv) {
  let root = process.cwd();
  const flags = {};
  const valueFlags = ['--now', '--command-stale-minutes', '--stalled-minutes', '--tx-max-minutes'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (valueFlags.includes(a)) {
      const v = argv[++i];
      if (v === undefined) usage();
      flags[a.slice(2)] = v;
    } else if (a === '--help' || a === '-h') usage();
    else if (!a.startsWith('--')) root = path.resolve(a);
    else usage();
  }

  const thresholds = {
    commandStaleMinutes: parseMinutes(flags['command-stale-minutes'], DEFAULT_THRESHOLDS.commandStaleMinutes),
    stalledMinutes: parseMinutes(flags['stalled-minutes'], DEFAULT_THRESHOLDS.stalledMinutes),
    txMaxMinutes: parseMinutes(flags['tx-max-minutes'], DEFAULT_THRESHOLDS.txMaxMinutes),
  };

  const snap = collectSnapshot(root, flags.now);
  const result = evaluate(snap, thresholds);

  if (flags.json) {
    console.log(JSON.stringify({ snapshot: snap, result }, null, 2));
  } else {
    console.log('FACTORY LIVENESS WATCHDOG — ' + result.status + ' (exit ' + result.exitCode + ')');
    console.log('  now: ' + snap.nowIso + ' | matrix rows: ' + snap.matrixRows + ' | ledger events: ' + snap.ledgerEvents);
    console.log('  active_chunk: ' + snap.activeChunk.length + ' row(s) | unfinished: ' + snap.activeChunkUnfinished +
      ' | tx active: ' + Boolean(snap.transaction.active) + ' | lock held: ' + Boolean(snap.lock.locked) +
      ' | pending command: ' + (snap.command !== null));
    for (const f of result.findings) {
      console.log('  [' + f.status + '] ' + f.message);
    }
    console.log('WATCHDOG READ-ONLY: không mutate state; với unfinished work treo, chạy op recover qua kênh chuẩn.');
  }
  process.exit(result.exitCode);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  evaluate,
  collectSnapshot,
  DEFAULT_THRESHOLDS,
  UNFINISHED,
  EXIT_PASS,
  EXIT_WARN,
  EXIT_FAIL,
};
