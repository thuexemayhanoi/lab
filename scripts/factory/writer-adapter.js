#!/usr/bin/env node
/**
 * writer-adapter.js — writer-runtime adapter for the autonomous pipeline
 * (scripts/factory/pipeline.js). The AI writer is ALWAYS an EXTERNAL runtime:
 *
 *   WRITER_RUNTIME=off    (default) — no runtime configured. The pipeline
 *                         ACTIVATES but idle-stops cleanly BEFORE claiming
 *                         any article (fail-closed: no writer, no content).
 *   WRITER_RUNTIME=http  — real writer service. WRITER_ENDPOINT (GitHub
 *                         Actions Variable) + optional WRITER_API_KEY
 *                         (GitHub Actions SECRET — referenced, NEVER
 *                         committed). The adapter POSTs {task, article_id,
 *                         row, packet, feedback} and expects
 *                         {ok:true, packet?|body?} JSON.
 *   WRITER_RUNTIME=mock  — deterministic mock writer, TESTS ONLY. Refused
 *                         unless PIPELINE_ALLOW_MOCK=1 (fail-closed: mock
 *                         prose can never reach production).
 *
 * WRITER ISOLATION (pipeline principle 1): every artifact the writer
 * produces is written ONLY under the per-writer workspace directory
 * (pipeline/writers/w<i>/... — gitignored). The COORDINATOR (pipeline.js)
 * is the only component that ingests artifacts into the repository tree
 * (data/research/<ID>.json, _drafts/<ID>.body.html). This adapter has no
 * code path that writes anywhere else.
 *
 * No secrets in code: the endpoint/key are read from the environment at
 * call time and are never logged in full.
 */
'use strict';
const fs = require('fs'), path = require('path');

const RESEARCH_FIELDS = ['article_id', 'primary_keyword', 'search_intent', 'research_date', 'questions_found', 'official_sources', 'unique_angle'];

function resolveRuntime(env) {
  env = env || process.env;
  const mode = String(env.WRITER_RUNTIME || 'off').trim().toLowerCase();
  if (mode === 'off') return { mode: 'off', reason: 'WRITER_RUNTIME=off — chưa cấu hình writer runtime (set GitHub Variable WRITER_RUNTIME=http + WRITER_ENDPOINT, Secret WRITER_API_KEY nếu service cần key)' };
  if (mode === 'http') {
    const endpoint = String(env.WRITER_ENDPOINT || '').trim();
    if (!endpoint) return { mode: 'off', reason: 'WRITER_RUNTIME=http nhưng WRITER_ENDPOINT rỗng — idle-stop (không claim bài khi thiếu runtime)' };
    if (!/^https?:\/\//i.test(endpoint)) throw new Error('WRITER_ENDPOINT phải là http(s) URL');
    return { mode: 'http', endpoint, apiKey: String(env.WRITER_API_KEY || '').trim() || null,
      timeoutMs: Number(env.WRITER_TIMEOUT_MS) || 300000 };
  }
  if (mode === 'mock') {
    if (env.PIPELINE_ALLOW_MOCK !== '1')
      throw new Error('REFUSED: WRITER_RUNTIME=mock chỉ dành cho kiểm thử — đặt PIPELINE_ALLOW_MOCK=1 (không bao giờ bật ở production)');
    return { mode: 'mock', timeoutMs: 60000 };
  }
  throw new Error('REFUSED: WRITER_RUNTIME không hỗ trợ: ' + JSON.stringify(mode) + ' (off | http | mock)');
}

// ---------------------------- mock writer --------------------------------
// Deterministic Vietnamese mock. NO digits anywhere in generated prose —
// grounding cannot be violated by a test fixture. Two QA flavours:
//   - first write  -> body_v1: ngắn + thiếu h1 => deterministic QA REVIEW
//   - revise       -> body_v2: đầy đủ (>=1600 từ) => PASS
//   - FAIL_ALWAYS  -> mọi revise vẫn trả body_v1 => bounded retries => BLOCKED
function hashOf(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h; }
const noDigits = s => String(s == null ? '' : s).replace(/\d+/g, '').replace(/\s+/g, ' ').trim();

const MOCK_SENTENCES = [
  'Quý vị đang tìm hiểu về {kw} và cần một nguồn thông tin rõ ràng, trung lập và dễ theo dõi cho người mới bắt đầu.',
  'Bài viết này tổng hợp lại những điểm cần chuẩn bị trước khi bắt đầu, các bước nên làm theo trình tự và những lưu ý thực tế.',
  'Trước hết, hãy xác định rõ mục tiêu của mình để lựa chọn phương án phù hợp thay vì làm theo cảm tính.',
  'Tiếp theo, quý vị nên tham khảo thông tin từ các nguồn chính thống và so sánh nhiều phương án trước khi quyết định.',
  'Trong quá trình tìm hiểu, hãy ghi chú lại các điều kiện, giấy tờ cần chuẩn bị và thời gian dự kiến cho từng bước.',
  'Nhiều người bỏ qua bước khảo sát thực tế nên dễ gặp những phát sinh không đáng có về sau.',
  'Nếu quý vị vẫn còn băn khoăn, hãy hỏi trực tiếp người có kinh nghiệm hoặc tham khảo chuyên mục liên quan dưới đây.',
  'Điểm quan trọng nhất là giữ thái độ chủ động: chuẩn bị kỹ, hỏi rõ ràng và kiểm tra lại toàn bộ trước khi chốt.',
  'Một kế hoạch tốt luôn gồm ba phần: chuẩn bị, thực hiện và rà soát lại kết quả sau khi hoàn tất.',
  'Kinh nghiệm cho thấy người chuẩn bị chu đáo luôn tiết kiệm được thời gian và công sức hơn hẳn so với người làm vội.',
  'Hãy bắt đầu từ những việc đơn giản nhất, sau đó mở rộng dần sang các nội dung chuyên sâu hơn khi đã nắm chắc cơ bản.',
  'Cuối cùng, đừng quên lưu lại toàn bộ giấy tờ và biên nhận liên quan để đối chiếu khi cần thiết về sau.'
];
const MOCK_SECTIONS = [
  ['Tổng quan về {kw}', 'Nội dung này giúp quý vị hình dung bức tranh toàn cảnh trước khi đi vào chi tiết từng bước cụ thể.'],
  ['Chuẩn bị trước khi bắt đầu', 'Hãy liệt kê toàn bộ những gì cần chuẩn bị, kiểm tra lại độ đầy đủ rồi mới tiến hành bước tiếp theo.'],
  ['Quy trình thực hiện từng bước', 'Mỗi bước nên được thực hiện đúng trình tự, có kiểm tra kết quả trước khi chuyển sang bước kế tiếp.'],
  ['Những lưu ý quan trọng', 'Đây là phần tổng hợp các điểm dễ sai mà nhiều người gặp phải trong lần đầu tiên thực hiện.'],
  ['So sánh các phương án', 'Quý vị nên đặt các phương án cạnh nhau, so sánh ưu điểm và hạn chế của từng lựa chọn trước khi quyết định.'],
  ['Kinh nghiệm thực tế', 'Chia sẻ theo góc nhìn người từng trải giúp quý vị tránh được những vòng đi vòng lại không cần thiết.'],
  ['Kết luận', 'Tóm lại, với một lộ trình chuẩn bị kỹ lưỡng, quý vị hoàn toàn có thể tự tin thực hiện mà không gặp trở ngại lớn.']
];

function mockPacket(row) {
  const kw = noDigits(row.primary_keyword) || ('chủ đề ' + row.article_id);
  return {
    article_id: row.article_id,
    primary_keyword: row.primary_keyword,
    search_intent: row.search_intent || 'informational',
    research_date: new Date().toISOString().slice(0, 10),
    questions_found: [
      'Quy trình ' + kw + ' gồm những bước nào?',
      'Cần chuẩn bị gì trước khi bắt đầu?',
      'Có những lưu ý nào cho người lần đầu thực hiện?'
    ],
    official_sources: [{
      name: 'Cổng thông tin điện tử Chính phủ',
      source_url: 'https://www.gov.vn/',
      source_domain: 'www.gov.vn',
      note: 'Nguồn chính thống dùng cho mô hình kiểm thử của pipeline (mock).'
    }],
    unique_angle: 'Hướng tiếp cận từng bước cho người mới bắt đầu, ưu tiên trình tự và danh mục chuẩn bị (mock — chỉ dùng kiểm thử).',
    claim_evidence: []
  };
}

function sentences(kw, seed, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(MOCK_SENTENCES[(seed + i * 7) % MOCK_SENTENCES.length].replace(/\{kw\}/g, kw));
  return out;
}

function mockBodyV1(row) { // deterministic QA REVIEW: word_count + missing h1
  const kw = noDigits(row.primary_keyword) || ('chủ đề ' + row.article_id);
  const seed = hashOf(row.article_id);
  return '<h2>' + noDigits(row.parent_topic || 'Tổng quan') + '</h2>\n' +
    '<p>' + sentences(kw, seed, 6).join(' ') + '</p>\n' +
    '<p>Bản nháp kiểm thử ngắn dành cho vòng sửa lỗi của pipeline (mock).</p>\n';
}

function mockBodyV2(row) { // full length, h1, no digits
  const kw = noDigits(row.primary_keyword) || ('chủ đề ' + row.article_id);
  const seed = hashOf(row.article_id);
  const parts = [];
  parts.push('<h1>' + kw + ': hướng dẫn từng bước cho người mới bắt đầu</h1>');
  parts.push('<p>' + sentences(kw, seed, 8).join(' ') + '</p>');
  for (let s = 0; s < MOCK_SECTIONS.length; s++) {
    const sec = MOCK_SECTIONS[s];
    parts.push('<h2>' + sec[0].replace(/\{kw\}/g, kw) + '</h2>');
    parts.push('<p>' + sec[1].replace(/\{kw\}/g, kw) + ' ' + sentences(kw, seed + s * 13, 9).join(' ') + '</p>');
    parts.push('<p>' + sentences(kw, seed + s * 29 + 3, 8).join(' ') + '</p>');
  }
  parts.push('<h2>Mục liên quan</h2>');
  parts.push('<p>Quý vị có thể tham khảo thêm tại <a href="/lab/thue-xe-may/">chuyên mục thuê xe máy</a>, ' +
    '<a href="/lab/kinh-nghiem/">kinh nghiệm thực tế</a> và <a href="/lab/lien-he/">trang liên hệ</a>.</p>');
  parts.push('<h2>Lời cuối</h2>');
  parts.push('<p>' + sentences(kw, seed + 101, 7).join(' ') + '</p>');
  return parts.join('\n') + '\n';
}

// ---------------------------- http writer --------------------------------
async function httpTask(runtime, payload) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), runtime.timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (runtime.apiKey) headers['Authorization'] = 'Bearer ' + runtime.apiKey;
    const res = await fetch(runtime.endpoint, {
      method: 'POST', headers, signal: ctrl.signal,
      body: JSON.stringify(Object.assign({ runtime: 'lab-pipeline', ts: new Date().toISOString() }, payload))
    });
    if (!res.ok) throw new Error('writer endpoint HTTP ' + res.status);
    const data = await res.json();
    if (!data || data.ok !== true) throw new Error('writer endpoint trả ok!=true: ' + JSON.stringify(data && data.error || data));
    return data;
  } finally { clearTimeout(t); }
}

/**
 * runTask — chạy một tác vụ writer và ghi artifact VÀO WORKSPACE (outDir).
 * task: 'research' -> outDir/<ID>.packet.json ; 'write'/'revise' -> outDir/<ID>.body.html
 * Trả {kind:'packet'|'body', path} hoặc ném lỗi (retry do coordinator quyết định).
 */
async function runTask(opts) {
  const { task, row, packet, feedback, outDir, runtime } = opts;
  fs.mkdirSync(outDir, { recursive: true });
  const id = row.article_id;
  if (runtime.mode === 'mock') {
    if (task === 'research') {
      const p = mockPacket(row);
      const f = path.join(outDir, id + '.packet.json');
      fs.writeFileSync(f, JSON.stringify(p, null, 2));
      return { kind: 'packet', path: f };
    }
    const failAlways = process.env.PIPELINE_MOCK_FAIL_ALWAYS === '1';
    let body;
    if (task === 'write') body = mockBodyV1(row);            // vòng đầu: REVIEW (đưa repair loop vào đường chạy thật)
    else body = failAlways ? mockBodyV1(row) : mockBodyV2(row); // revise: đầy đủ (hoặc cố ý hỏng để test bound retry)
    const f = path.join(outDir, id + '.body.html');
    fs.writeFileSync(f, body);
    return { kind: 'body', path: f };
  }
  if (runtime.mode === 'http') {
    const data = await httpTask(runtime, { task, article_id: id, row, packet: packet || null, feedback: feedback || null });
    if (task === 'research') {
      const p = data.packet;
      if (!p || typeof p !== 'object') throw new Error('writer không trả research packet cho ' + id);
      const missing = RESEARCH_FIELDS.filter(k => !(k in p));
      if (missing.length) throw new Error('research packet ' + id + ' thiếu trường: ' + missing.join(','));
      const f = path.join(outDir, id + '.packet.json');
      fs.writeFileSync(f, JSON.stringify(p, null, 2));
      return { kind: 'packet', path: f };
    }
    const body = data.body;
    if (!body || typeof body !== 'string' || !body.trim()) throw new Error('writer không trả body cho ' + id);
    const f = path.join(outDir, id + '.body.html');
    fs.writeFileSync(f, body);
    return { kind: 'body', path: f };
  }
  throw new Error('runtime không hỗ trợ: ' + runtime.mode);
}

module.exports = { resolveRuntime, runTask, RESEARCH_FIELDS, mockPacket, mockBodyV1, mockBodyV2 };
