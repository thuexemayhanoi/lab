// chatbot-worker.js — on-device AI worker (WebLLM + Qwen2.5-0.5B-Instruct, quantized 4-bit).
// Runs ONLY on the visitor's device after they explicitly enable AI mode.
// No inference API, no API key, no backend. The single remote import below is the
// open-source WebLLM runtime served from a public package CDN; model weights come
// from the public MLC model host and are cached by the browser.
let engine = null;

self.addEventListener('message', async (ev) => {
  const data = ev.data || {};
  if (data.type === 'load') {
    if (engine) { postMessage({ type: 'ready' }); return; }
    try {
      const webllm = await import('https://esm.run/@mlc-ai/webllm');
      engine = await webllm.CreateMLCEngine('Qwen2.5-0.5B-Instruct-q4f16_1-MLC', {
        initProgressCallback: (p) => postMessage({ type: 'progress', p: p.progress ?? 0 })
      });
      postMessage({ type: 'ready' });
    } catch (err) {
      engine = null;
      postMessage({ type: 'error', message: (err && err.message) ? err.message : String(err) });
    }
    return;
  }
  if (data.type === 'generate') {
    if (!engine) { postMessage({ type: 'error', message: 'mô hình chưa được tải' }); return; }
    try {
      const reply = await engine.chat.completions.create({
        messages: data.messages,
        temperature: 0.4,
        max_tokens: 420
      });
      const text = (reply && reply.choices && reply.choices[0] && reply.choices[0].message && reply.choices[0].message.content) || '';
      postMessage({ type: 'reply', seq: data.seq, text });
    } catch (err) {
      postMessage({ type: 'error', message: (err && err.message) ? err.message : String(err) });
    }
  }
});
