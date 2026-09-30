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
 * CANONICAL MATRIX TRUTH (hardening session 5 — Finding 1):
 *   - data/content-matrix.csv là assembled form (GITIGNORED); canonical
 *     committed form = shards data/content-matrix.csv.part00..NN.
 *   - Watchdog dùng assembled CSV nếu nó tồn tại VÀ hợp lệ; nếu KHÔNG tồn tại
 *     (clean checkout CI chỉ có shards) thì assemble READ-ONLY IN-MEMORY từ
 *     canonical shards — thứ tự deterministic (part00..NN liền mạch), verify
 *     header + có row. KHÔNG BAO GIỜ ghi assembled CSV xuống production tree
 *     chỉ để watchdog đọc; direct CLI và Actions đọc giống nhau.
 *
 * FAIL CLOSED (không fallback im lặng):
 *   - Matrix thiếu (không assembled + không shards / shards gãy thứ tự)
 *     => STATE_MISSING; malformed (header sai, 0 row, parse không được)
 *     => STATE_INVALID. KHÔNG fallback matrixRows=0.
 *   - State critical checkpoint.json / transaction.json / writer-lock.json /
 *     throughput-ledger.json: missing => STATE_MISSING; JSON hỏng hoặc sai
 *     schema tối thiểu => STATE_INVALID. KHÔNG fallback {active:false} hay
 *     trạng thái lành giả. Mọi fatal => FAIL exit 1.
 *   - operator-command.json vẫn OPTIONAL: KHÔNG có command = bình thường;
 *     nếu TỒN TẠI nhưng hỏng => STATE_INVALID (FAIL CLOSED).
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

// ---- FAIL-CLOSED critical truth (hardening session 5 — Finding 1) ----
// Critical state files: missing => STATE_MISSING; invalid JSON / sai schema
// tối thiểu => STATE_INVALID. KHÔNG BAO GIỜ fallback giá trị lành giả —
// snapshot có fatals thì evaluate() luôn FAIL (exit 1).
const CRITICAL_STATE = [
  { rel: CHECKPOINT,
    min: (v) => v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.active_chunk),
    need: 'object với active_chunk array' },
  { rel: TRANSACTION,
    min: (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.active === 'boolean',
    need: 'object với active boolean' },
  { rel: WRITER_LOCK,
    min: (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.locked === 'boolean',
    need: 'object với locked boolean' },
  { rel: LEDGER,
    min: (v) => v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.events),
    need: 'object với events array' },
];

function loadCritical(root, rel, minSchema, need) {
  const abs = path.join(root, rel);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    throw { code: 'STATE_MISSING', file: rel,
      message: 'state critical ' + rel + ' không đọc được — FAIL CLOSED, không fallback trạng thái lành giả.' };
  }
  let v;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    throw { code: 'STATE_INVALID', file: rel,
      message: 'state critical ' + rel + ' không phải JSON hợp lệ — FAIL CLOSED.' };
  }
  if (!minSchema(v)) {
    throw { code: 'STATE_INVALID', file: rel,
      message: 'state critical ' + rel + ' sai schema tối thiểu (' + need + ') — FAIL CLOSED.' };
  }
  return v;
}

// ---- CANONICAL MATRIX LOADER (read-only, deterministic, fail-closed) ----
// Ưu tiên assembled CSV nếu tồn tại và hợp lệ; nếu không tồn tại, assemble
// IN-MEMORY từ canonical shards (clean checkout chỉ có shards). Không ghi
// assembled matrix xuống production tree.
function parseMatrixText(text, label) {
  const lines = text.split(/\r?\n/);
  if (!lines[0] || !lines[0].trim()) {
    throw { code: 'STATE_INVALID', file: label,
      message: 'matrix ' + label + ' thiếu header — FAIL CLOSED.' };
  }
  const header = lines[0].split(',');
  const idIdx = header.indexOf('article_id');
  const stIdx = header.indexOf('status');
  if (idIdx < 0 || stIdx < 0) {
    throw { code: 'STATE_INVALID', file: label,
      message: 'matrix ' + label + ' header thiếu cột article_id/status — FAIL CLOSED.' };
  }
  const statuses = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cols = lines[i].split(','); // cột id/status không bao giờ chứa dấu phẩy
    if (cols.length <= Math.max(idIdx, stIdx)) {
      throw { code: 'STATE_INVALID', file: label,
        message: 'matrix ' + label + ' row ' + (i + 1) + ' thiếu cột — FAIL CLOSED.' };
    }
    statuses.set(cols[idIdx], cols[stIdx]);
  }
  if (statuses.size === 0) {
    throw { code: 'STATE_INVALID', file: label,
      message: 'matrix ' + label + ' không có row nào — FAIL CLOSED.' };
  }
  return statuses;
}

function loadCanonicalMatrix(root) {
  const dataDir = path.join(root, 'data');
  const assembledRel = 'data/content-matrix.csv';
  const assembled = path.join(dataDir, 'content-matrix.csv');
  if (fs.existsSync(assembled)) {
    return { statuses: parseMatrixText(fs.readFileSync(assembled, 'utf8'), assembledRel), source: 'assembled' };
  }
  // Clean checkout: chỉ có canonical shards. Thứ tự deterministic + verify
  // shards liền mạch part00..partNN (thiếu shard => STATE_MISSING).
  let entries = [];
  try {
    entries = fs.readdirSync(dataDir);
  } catch (e) {
    throw { code: 'STATE_MISSING', file: 'data/',
      message: 'không đọc được data/ — matrix truth thiếu — FAIL CLOSED.' };
  }
  const shards = entries.filter((f) => /^content-matrix\.csv\.part\d+$/.test(f)).sort();
  if (shards.length === 0) {
    throw { code: 'STATE_MISSING', file: 'data/content-matrix.csv.part*',
      message: 'không có assembled CSV và không có canonical shards — matrix truth thiếu — FAIL CLOSED (không fallback im lặng matrixRows=0).' };
  }
  for (let i = 0; i < shards.length; i++) {
    const expected = 'content-matrix.csv.part' + String(i).padStart(2, '0');
    if (shards[i] !== expected) {
      throw { code: 'STATE_MISSING', file: 'data/content-matrix.csv.part*',
        message: 'canonical shards không liền mạch — kỳ vọng ' + expected + ', thấy ' + shards[i] + ' — shard thiếu/sai thứ tự — FAIL CLOSED.' };
    }
  }
  const label = 'data/content-matrix.csv.part00..' + String(shards.length - 1).padStart(2, '0');
  const text = shards.map((f) => fs.readFileSync(path.join(dataDir, f), 'utf8')).join('');
  return { statuses: parseMatrixText(text, label), source: 'shards' };
}

/**
 * Đọc toàn bộ repository truth cần thiết — READ-ONLY, không bao giờ ghi.
 * Trả về snapshot thuần dữ liệu, kèm `fatals` khi critical truth thiếu/hỏng
 * (evaluate() FAIL CLOSED), để evaluate() thuần hàm dùng cho unit test.
 */
function collectSnapshot(root, nowIso) {
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  if (!Number.isFinite(now)) throw new Error('invalid --now: ' + nowIso);
  const abs = (p) => path.join(root, p);

  const fatals = [];
  const guard = (fn) => {
    try { return fn(); }
    catch (e) {
      if (e && (e.code === 'STATE_MISSING' || e.code === 'STATE_INVALID')) { fatals.push(e); return null; }
      throw e;
    }
  };

  let checkpoint = null;
  let transaction = null;
  let lock = null;
  let ledger = null;
  for (const c of CRITICAL_STATE) {
    const v = guard(() => loadCritical(root, c.rel, c.min, c.need));
    if (c.rel === CHECKPOINT) checkpoint = v;
    else if (c.rel === TRANSACTION) transaction = v;
    else if (c.rel === WRITER_LOCK) lock = v;
    else ledger = v;
  }

  // Pending command + tuổi của FILE (thời điểm coordinator commit nó).
  // OPTIONAL: không có command = bình thường; command TỒN TẠI nhưng hỏng
  // => STATE_INVALID (FAIL CLOSED) — không bỏ lọt command treo.
  let command = null;
  let commandFileMinutes = null;
  let st = null;
  try { st = fs.statSync(abs(COMMAND_FILE)); }
  catch (e) {
    if (e.code !== 'ENOENT') fatals.push({ code: 'STATE_INVALID', file: COMMAND_FILE,
      message: 'operator-command.json stat lỗi: ' + e.message });
  }
  if (st !== null) {
    commandFileMinutes = (now - st.mtimeMs) / 60000;
    try {
      command = readJson(abs(COMMAND_FILE));
    } catch (e) {
      fatals.push({ code: 'STATE_INVALID', file: COMMAND_FILE,
        message: 'operator-command.json tồn tại nhưng không đọc/parse được — FAIL CLOSED (không có command là bình thường; command hỏng thì không).' });
      command = null;
      commandFileMinutes = null;
    }
  }

  // Matrix truth qua canonical loader. Giá trị neutral bên dưới (Map rỗng /
  // {active:false}) CHỈ để in báo cáo khi đã có fatal — fatals khác rỗng thì
  // evaluate() luôn FAIL; không bao giờ được dùng để "giả lành".
  const matrix = guard(() => loadCanonicalMatrix(root));
  const statuses = matrix ? matrix.statuses : new Map();

  // Progress event mới nhất trong ledger (mọi op đều là dấu hiệu tiến).
  const events = ledger && Array.isArray(ledger.events) ? ledger.events : [];
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
    fatals,
    checkpoint,
    activeChunk,
    activeChunkUnfinished: activeChunk.filter((id) => UNFINISHED.includes(statuses.get(id))).length,
    matrixRows: statuses.size,
    matrixSource: matrix ? matrix.source : null,
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

  // 0) FAIL CLOSED — critical repository truth thiếu/hỏng: snapshot mang
  // fatals thì KHÔNG thể HEALTHY, bất kể phần còn lại trông thế nào.
  for (const f of snap.fatals || []) {
    add(f.code, EXIT_FAIL, f.file + ': ' + f.message);
  }

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
    console.log('  now: ' + snap.nowIso + ' | matrix rows: ' + snap.matrixRows +
      ' (source: ' + (snap.matrixSource || 'UNAVAILABLE — FAIL CLOSED') + ')' + ' | ledger events: ' + snap.ledgerEvents);
    if (snap.fatals && snap.fatals.length) {
      console.log('  FAIL CLOSED: ' + snap.fatals.length + ' critical truth issue(s) — trạng thái này KHÔNG thể coi là HEALTHY.');
    }
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
