// chatbot.js — local reading assistant for Bản Đồ Xe 2 Bánh Việt Nam.
// Retrieval-first over /lab/assets/knowledge-index.json (published content only).
// Optional on-device AI: WebLLM + Qwen2.5-0.5B-Instruct loads lazily in a Web Worker,
// only after the visitor explicitly taps "Bật AI cục bộ". No inference API, no API key,
// conversation stays in the browser (sessionStorage). No service/NAP advertising.
(function () {
  'use strict';
  var PANEL_ID = 'chat-panel', LAUNCHER_ID = 'chat-launcher';
  var MODEL_ID = 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';
  var MODEL_SIZE = '≈ 0,5 GB';
  var STORE_KEY = 'bdx2b-chat-v1';
  var panel = document.getElementById(PANEL_ID);
  var launcher = document.getElementById(LAUNCHER_ID);
  if (!panel || !launcher) return;
  var log = document.getElementById('chat-log');
  var form = document.getElementById('chat-form');
  var input = document.getElementById('chat-q');
  var statusEl = document.getElementById('chat-status');
  var modeEl = document.getElementById('chat-mode');
  var aiBtn = document.getElementById('chat-ai-toggle');
  var aiLabel = aiBtn ? (aiBtn.querySelector('.ai-txt') || aiBtn) : null;
  var clearBtn = document.getElementById('chat-clear');
  var closeBtn = document.getElementById('chat-close');
  var moreBtn = document.getElementById('chat-more-btn');
  var menuEl = document.getElementById('chat-menu');
  var sendBtn = document.getElementById('chat-send');
  var MODE_LOOKUP = 'Tra cứu nội dung';
  var MODE_LOOKUP_FULL = 'Chế độ tra cứu nội dung — trả lời từ nội dung đã xuất bản của trang.';
  var AI_UNAVAILABLE = 'AI cục bộ chưa khả dụng trên thiết bị này. Trợ lý vẫn hoạt động ở chế độ tra cứu nội dung.';

  // ---------- state ----------
  var KB = null;            // knowledge index {records:[...]}
  var idxChunks = [];       // retrieval chunks
  var df = {}, N = 0, avgLen = 1;
  var worker = null, aiReady = false, aiBusy = false, genSeq = 0;
  var msgs = [];            // {role:'bot'|'user', html, src:[{t,u}]}

  // ---------- helpers ----------
  var esc = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  var fold = function (s) {
    return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  };
  var STOP = {};
  ('va va0 cua co khong nhung ca la duoc cho toi ban mot nhu the gi o e voi tren trong tu den khi neu da se phai vo bi tuong nay do ay thi ma bao nhieu it cung hon chang giua roi').split(' ').forEach(function (w) { if (w) STOP[w] = 1; });
  var tokenize = function (s) {
    var t = fold(s).match(/[a-z0-9]+/g) || [];
    var out = [];
    for (var i = 0; i < t.length; i++) if (t[i].length > 1 && !STOP[t[i]]) out.push(t[i]);
    return out;
  };

  // ---------- retrieval (BM25-lite over folded tokens) ----------
  function buildIndex() {
    idxChunks = []; df = {}; N = 0; var total = 0;
    KB.records.forEach(function (r) {
      var rtoks = {};
      tokenize(r.t).forEach(function (w) { rtoks[w] = 1; });
      r.chunks.forEach(function (c) {
        var toks = tokenize(c.h + ' ' + c.t);
        if (!toks.length) return;
        var seen = {};
        toks.forEach(function (w) { if (!seen[w]) { seen[w] = 1; df[w] = (df[w] || 0) + 1; } });
        idxChunks.push({ rid: r, rtoks: rtoks, h: c.h, t: c.t, toks: toks, len: toks.length });
        N++; total += toks.length;
      });
    });
    avgLen = N ? total / N : 1;
  }
  function idfOf(w) { return Math.log(1 + (N - (df[w] || 0) + 0.5) / ((df[w] || 0) + 0.5)); }
  function search(q) {
    var qtoks = tokenize(q);
    if (!qtoks.length || !N) return [];
    var scored = idxChunks.map(function (ch) {
      var tf = {};
      ch.toks.forEach(function (w) { tf[w] = (tf[w] || 0) + 1; });
      var s = 0;
      for (var i = 0; i < qtoks.length; i++) {
        var w = qtoks[i], f = tf[w];
        if (!f) continue;
        var idf = idfOf(w);
        s += idf * (f * 2.5) / (f + 1.5 * (0.25 + 0.75 * ch.len / avgLen));
        if (ch.rtoks[w]) s += idf * 1.2; // record title match boost
      }
      return { ch: ch, s: s };
    }).filter(function (x) { return x.s > 0; }).sort(function (a, b) { return b.s - a.s; });
    return scored;
  }
  function coverage(q, chunks) {
    var qtoks = tokenize(q), have = {};
    chunks.forEach(function (c) { c.toks.forEach(function (w) { have[w] = 1; }); });
    var hit = 0;
    qtoks.forEach(function (w) { if (have[w]) hit++; });
    return qtoks.length ? hit / qtoks.length : 0;
  }
  function retrieve(q) {
    var hits = search(q);
    var picked = [], recs = [], seen = {};
    for (var i = 0; i < hits.length; i++) {
      var r = hits[i].ch.rid;
      if (picked.length < 4) picked.push(hits[i].ch);
      if (!seen[r.u]) { seen[r.u] = 1; if (recs.length < 3) recs.push(r); }
      if (picked.length >= 4 && recs.length >= 3) break;
    }
    // honesty gate: the best chunk must cover ≥50% of the question tokens (or the
    // retrieved set ≥70%) — otherwise the corpus does not contain enough verified
    // information for this query and we say so instead of answering with noise
    if (!picked.length) return { chunks: [], recs: [] };
    var c1 = coverage(q, picked.slice(0, 1)), c4 = coverage(q, picked);
    if (c1 < 0.5 && c4 < 0.7) return { chunks: [], recs: [] };
    return { chunks: picked, recs: recs };
  }

  // ---------- conversation UI ----------
  function linkOf(u) { return '/lab/' + (u || ''); }
  function srcBlock(recs) {
    if (!recs || !recs.length) return '';
    return '<span class="src">Nguồn trên trang:<br>' + recs.map(function (r) {
      return '<a href="' + esc(linkOf(r.u)) + '">' + esc(r.t) + '</a><span class="s-meta">' + esc(r.topic || '') + '</span>';
    }).join('') + '</span>';
  }
  function pushMsg(role, html, src) {
    var m = { role: role, html: html, src: src || [] };
    msgs.push(m);
    var div = document.createElement('div');
    div.className = 'chat-msg ' + (role === 'user' ? 'user' : 'bot');
    div.innerHTML = html + (role === 'bot' ? srcBlock(src) : '');
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    save();
  }
  function rerender() {
    log.innerHTML = msgs.length ? '' : '<p class="chat-empty">Xin chào! Tôi trả lời dựa trên nội dung đã xuất bản của Bản Đồ Xe 2 Bánh.<br>Hỏi về thuê xe, cứu hộ, bảo dưỡng, giấy tờ, xe điện hoặc phụ tùng.</p>';
    msgs.forEach(function (m) {
      var div = document.createElement('div');
      div.className = 'chat-msg ' + (m.role === 'user' ? 'user' : 'bot');
      div.innerHTML = m.html + (m.role === 'bot' ? srcBlock(m.src) : '');
      log.appendChild(div);
    });
    log.scrollTop = log.scrollHeight;
  }
  function save() {
    try {
      if (msgs.length) sessionStorage.setItem(STORE_KEY, JSON.stringify({ msgs: msgs, ai: aiReady }));
      else sessionStorage.removeItem(STORE_KEY);
    } catch (e) { /* storage unavailable — conversation stays in memory only */ }
  }
  function restore() {
    try {
      var raw = sessionStorage.getItem(STORE_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (d && Array.isArray(d.msgs)) msgs = d.msgs;
    } catch (e) { msgs = []; }
  }
  function setStatus(t) { statusEl.textContent = t || ''; }
  // compact mode badge: short label + full explanation via title/aria-label
  function setMode(short, full) {
    if (!modeEl) return;
    modeEl.textContent = short;
    modeEl.title = full;
    modeEl.setAttribute('aria-label', full);
  }
  function setAiLabel(t) {
    if (aiLabel) aiLabel.textContent = t;
    if (aiBtn) aiBtn.setAttribute('aria-label', t);
  }
  // transient busy state on the send control — never moves layout
  function setBusy(b) {
    if (sendBtn) sendBtn.disabled = !!b;
    if (input) input.setAttribute('aria-busy', b ? 'true' : 'false');
  }
  function excerpt(t, n) {
    t = String(t);
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  // ---------- lookup mode (default) ----------
  function answerLookup(q) {
    var r = retrieve(q);
    if (!r.chunks.length) {
      pushMsg('bot', 'Cơ sở kiến thức hiện tại của trang chưa có đủ thông tin đã xác thực cho câu hỏi này. Bạn có thể thử câu hỏi khác về thuê xe máy, cứu hộ, bảo dưỡng, bằng lái, đăng ký xe, xe máy điện hoặc phụ tùng.', []);
      return;
    }
    var best = r.chunks[0];
    var head = best.h ? '<strong>' + esc(best.h) + '</strong> — ' : '';
    pushMsg('bot', 'Theo nội dung đã xuất bản của trang: ' + head + esc(excerpt(best.t, 320)) +
      (r.chunks.length > 1 ? ' … và ' + (r.chunks.length - 1) + ' đoạn liên quan khác.' : ''), r.recs);
  }

  // ---------- local AI mode (explicit opt-in, lazy) ----------
  function hasWebGPU() {
    return !!(navigator.gpu && navigator.gpu.requestAdapter);
  }
  function aiOff() { return !aiReady; }
  function startAI() {
    if (aiReady || aiBusy) return;
    if (!hasWebGPU()) {
      setStatus('Thiết bị/trình duyệt này chưa hỗ trợ WebGPU nên không chạy được mô hình AI cục bộ. Trợ lý tiếp tục ở chế độ tra cứu nội dung.');
      setMode(MODE_LOOKUP, MODE_LOOKUP_FULL);
      aiBtn.disabled = false;
      return;
    }
    aiBusy = true;
    aiBtn.disabled = true;
    setAiLabel('Đang tải…');
    setMode('Đang tải AI…', 'Đang tải mô hình AI cục bộ về trình duyệt của bạn — chỉ khi bạn chủ động bật.');
    setStatus('Đang tải mô hình ' + MODEL_ID + ' (' + MODEL_SIZE + ') về trình duyệt của bạn — chỉ tải một lần, lần sau dùng lại từ bộ nhớ đệm.');
    try {
      worker = new Worker('/lab/assets/chatbot-worker.js', { type: 'module' });
    } catch (e) {
      aiBusy = false; aiBtn.disabled = false; setAiLabel('Bật AI cục bộ');
      setStatus(AI_UNAVAILABLE);
      try { console.warn('[trợ lý] không khởi động được worker AI cục bộ:', e && e.message); } catch (e2) {}
      return;
    }
    worker.addEventListener('message', function (ev) {
      var d = ev.data || {};
      if (d.type === 'progress') {
        setStatus('Đang tải mô hình AI cục bộ… ' + Math.round((d.p || 0) * 100) + '% — xử lý hoàn toàn trên thiết bị của bạn.');
      } else if (d.type === 'ready') {
        aiReady = true; aiBusy = false;
        setAiLabel('AI cục bộ đang bật');
        setMode('AI cục bộ', 'Chế độ AI cục bộ — mô hình chạy trên thiết bị của bạn, trả lời kèm nguồn từ trang.');
        setStatus('Mô hình AI cục bộ đã sẵn sàng. Hội thoại vẫn không rời khỏi thiết bị của bạn.');
        pushMsg('bot', 'Đã bật AI cục bộ. Từ giờ mình trả lời tự nhiên hơn, vẫn dựa trên nội dung đã xuất bản của trang.', []);
        save();
      } else if (d.type === 'reply') {
        finishAI(d.text);
      } else if (d.type === 'error') {
        aiBusy = false;
        aiReady = false;
        setBusy(false);
        aiBtn.disabled = false;
        setAiLabel('Bật AI cục bộ');
        setMode(MODE_LOOKUP, MODE_LOOKUP_FULL);
        // raw technical detail stays in the console — never in the UI
        try { console.warn('[trợ lý] lỗi mô hình AI cục bộ:', d.message || 'không rõ'); } catch (e) {}
        setStatus(AI_UNAVAILABLE);
      }
    });
    worker.postMessage({ type: 'load' });
  }
  var pendingAI = null;
  function finishAI(text) {
    setBusy(false);
    setStatus('');
    var src = (pendingAI && pendingAI.length) ? pendingAI : [];
    pendingAI = null;
    pushMsg('bot', esc(String(text)).replace(/\n/g, '<br>'), src);
  }

  // ---------- ask ----------
  function ask(q) {
    q = (q || '').trim();
    if (!q) return;
    pushMsg('user', esc(q));
    if (aiReady && worker) {
      var r = retrieve(q);
      var recs = r.recs.map(function (x) { return { t: x.t, u: x.u }; });
      pendingAI = recs;
      var ctx = r.chunks.map(function (c, i) {
        return '[' + (i + 1) + '] ' + c.rid.t + ' (' + c.rid.u + ')' + (c.h ? ' — ' + c.h : '') + ': ' + c.t;
      }).join('\n');
      var sys = 'Bạn là trợ lý đọc bản địa của trang Bản Đồ Xe 2 Bánh Việt Nam. CHỈ trả lời dựa trên NGỮ CẢNH lấy từ nội dung đã xuất bản của trang. Nếu ngữ cảnh không đủ, hãy nói rõ trang chưa có đủ thông tin đã xác thực. Tuyệt đối không bịa giá, quy định, địa chỉ, cơ quan hay doanh nghiệp. Trả lời ngắn gọn, tự nhiên bằng tiếng Việt. Không quảng cáo dịch vụ, không đưa số điện thoại hay lời chào mời.';
      var usr = 'NGỮ CẢNH TỪ TRANG:\n' + ctx + '\n\nCÂU HỎI CỦA NGƯỜI ĐỌC: ' + q;
      genSeq++;
      setBusy(true);
      setStatus('Đang tìm nội dung liên quan trên Bản Đồ Xe 2 Bánh…');
      setTimeout(function () { setStatus('Đang đọc các bài phù hợp…'); }, 450);
      worker.postMessage({ type: 'generate', seq: genSeq, messages: [
        { role: 'system', content: sys },
        { role: 'user', content: usr }
      ] });
    } else {
      answerLookup(q);
    }
  }

  // ---------- panel open/close + a11y ----------
  var lastFocus = null;
  function closeMenu() {
    if (!menuEl) return;
    menuEl.hidden = true;
    if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
  }
  if (moreBtn && menuEl) {
    moreBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      menuEl.hidden = !menuEl.hidden;
      moreBtn.setAttribute('aria-expanded', menuEl.hidden ? 'false' : 'true');
    });
    menuEl.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('button')) closeMenu();
    });
    document.addEventListener('click', function (e) {
      if (!menuEl.hidden && !(e.target.closest && e.target.closest('#chat-more'))) closeMenu();
    });
    // ESC closes the overflow menu first; only then closes the panel
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menuEl.hidden) { e.stopPropagation(); closeMenu(); }
    }, true);
  }
  function openPanel() {
    lastFocus = document.activeElement;
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    document.body.classList.add('chat-open');
    input.focus();
    if (!KB) {
      setStatus('Đang tải chỉ mục nội dung đã xuất bản…');
      fetch('/lab/assets/knowledge-index.json').then(function (r) { return r.json(); }).then(function (d) {
        KB = d;
        buildIndex();
        setStatus('Đã sẵn sàng: ' + KB.records.length + ' trang đã xuất bản trong cơ sở kiến thức.');
        setTimeout(function () { setStatus(''); }, 2500);
      }).catch(function () {
        setStatus('Không tải được chỉ mục nội dung. Trợ lý tạm thời không thể tra cứu.');
      });
    }
  }
  function closePanel() {
    closeMenu();
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('chat-open');
    if (lastFocus && lastFocus.focus) lastFocus.focus(); else launcher.focus();
  }
  launcher.addEventListener('click', function () {
    if (panel.hidden) openPanel(); else closePanel();
  });
  if (closeBtn) closeBtn.addEventListener('click', closePanel);
  panel.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.stopPropagation(); closePanel(); return; }
    if (e.key !== 'Tab') return;
    var f = [].filter.call(panel.querySelectorAll('button, input, textarea, a[href]'), function (el) {
      return !el.disabled && el.offsetParent !== null; // skip hidden overflow-menu items
    });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !panel.hidden) closePanel();
  });

  // ---------- clear conversation ----------
  if (clearBtn) clearBtn.addEventListener('click', function () {
    msgs = [];
    pendingAI = null;
    try { sessionStorage.removeItem(STORE_KEY); } catch (e) {}
    rerender();
    setStatus('Đã xóa hội thoại khỏi trình duyệt của bạn.');
    setTimeout(function () { setStatus(''); }, 2500);
  });

  // ---------- AI toggle (explicit opt-in before any model download) ----------
  if (aiBtn) aiBtn.addEventListener('click', function () {
    if (aiReady || aiBusy) return;
    var ok = confirm('Bật AI cục bộ?\n\n• Mô hình ' + MODEL_ID + ' (' + MODEL_SIZE + ') sẽ được tải về trình duyệt của bạn, chỉ khi bạn đồng ý.\n• Yêu cầu trình duyệt hỗ trợ WebGPU (Chrome/Edge mới; một số thiết bị di động chưa hỗ trợ).\n• Mọi xử lý diễn ra trên thiết bị của bạn; hội thoại không được gửi tới dịch vụ suy luận nào.\n• Không tải mô hình = trang vẫn hoạt động như thường.');
    if (ok) startAI();
  });

  // ---------- input (auto-grow textarea; Enter sends, Shift+Enter = newline) ----------
  var AUTO_GROW_MAX = 96; // px — matches .chat-input textarea max-height (3–4 lines) in style.css
  function autoGrow() {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, AUTO_GROW_MAX) + 'px';
  }
  if (input) {
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (form.requestSubmit) form.requestSubmit();
        else form.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });
  }
  if (form) form.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = input.value;
    input.value = '';
    autoGrow();
    ask(q);
  });

  // ---------- mobile keyboard: keep composer visible (visual viewport) ----------
  var vv = window.visualViewport || null;
  var mq = window.matchMedia ? window.matchMedia('(max-width:767px)') : null;
  function syncViewport() {
    if (!vv) return;
    // 1) dynamic height unit: panels size themselves to the VISIBLE viewport
    panel.style.setProperty('--chat-vh', Math.round(vv.height) + 'px');
    // 2) bottom-sheet: lift the panel above the on-screen keyboard
    if (mq && mq.matches) {
      var kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      panel.style.bottom = kb > 4 ? kb + 'px' : '';
    } else {
      panel.style.bottom = '';
    }
    if (!panel.hidden && log) log.scrollTop = log.scrollHeight;
  }
  if (vv) {
    vv.addEventListener('resize', syncViewport);
    vv.addEventListener('scroll', syncViewport);
    syncViewport();
  }
  if (mq && mq.addEventListener) mq.addEventListener('change', syncViewport);

  // ---------- boot ----------
  restore();
  rerender();
})();
