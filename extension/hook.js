/* Chạy trong "main world" của trang (cùng ngữ cảnh với JS của hệ thống) để:
 *  1. Ghi lại request ghi dữ liệu (POST/PUT/PATCH/DELETE) khi người dùng bấm "Ghi lại request".
 *  2. Nhớ giá trị mới nhất của các header nhạy cảm (token, csrf...) mà chính trang đã gửi.
 *  3. Gọi lại request theo mẫu bằng fetch gốc, kèm token đó, cho từng ticket.
 * Giao tiếp với content.js qua window.postMessage. */
(() => {
  if (window.__ttBulkHook) return;
  window.__ttBulkHook = true;

  const CH = 'tt-bulk';
  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  const SENSITIVE = /authorization|token|csrf|xsrf|session|api-?key|secret/i;
  const origFetch = window.fetch.bind(window);
  const lastSensitive = new Map(); // "host|ten-header" -> giá trị mới nhất (chỉ giữ trong bộ nhớ)
  let recording = false;
  let seq = 0;

  const post = (msg) => window.postMessage({ channel: CH, dir: 'to-content', ...msg }, '*');
  const hostOf = (url) => { try { return new URL(url, location.href).host; } catch (e) { return ''; } };

  function headersToObject(h) {
    const out = {};
    if (!h) return out;
    if (Array.isArray(h)) h.forEach(([k, v]) => { out[k] = v; });
    else if (typeof h.forEach === 'function') h.forEach((v, k) => { out[k] = v; });
    else Object.keys(h).forEach((k) => { out[k] = h[k]; });
    return out;
  }

  function noteHeaders(url, headers) {
    const host = hostOf(url);
    for (const [name, value] of Object.entries(headers)) {
      if (!value || !SENSITIVE.test(name)) continue;
      lastSensitive.set(`${host}|${name.toLowerCase()}`, value);
      lastSensitive.set(`*|${name.toLowerCase()}`, value);
    }
  }

  function describeBody(b) {
    if (b == null) return { body: null };
    if (typeof b === 'string') return { body: b };
    if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return { body: b.toString() };
    return { body: null, unsupported: Object.prototype.toString.call(b).slice(8, -1) };
  }

  /* ---------- Quan sát fetch ---------- */

  window.fetch = function (input, init) {
    let entry = null;
    try {
      const isReq = typeof Request !== 'undefined' && input instanceof Request;
      const url = new URL(isReq ? input.url : String(input), location.href).href;
      const method = String((init && init.method) || (isReq ? input.method : 'GET')).toUpperCase();
      const headers = Object.assign({}, isReq ? headersToObject(input.headers) : {}, headersToObject(init && init.headers));
      noteHeaders(url, headers);
      if (recording && !SAFE_METHODS.has(method)) {
        entry = { id: ++seq, method, url, headers, ...describeBody(init && init.body) };
        if (isReq && !(init && init.body)) {
          const pending = input.clone().text().then((t) => { entry.body = t || null; }, () => {});
          entry.ready = pending;
        }
      }
    } catch (e) { /* không để lỗi quan sát làm hỏng request của trang */ }

    const p = origFetch(input, init);
    if (entry) {
      const send = (status) => Promise.resolve(entry.ready).then(() => {
        delete entry.ready;
        post({ type: 'captured', req: { ...entry, status } });
      });
      p.then((r) => send(r.status), () => send(0));
    }
    return p;
  };

  /* ---------- Quan sát XMLHttpRequest (axios, jQuery...) ---------- */

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__tt = { method: String(method).toUpperCase(), url, headers: {} };
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__tt) this.__tt.headers[name] = value;
    return xhrSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const t = this.__tt;
    if (t) {
      try {
        const url = new URL(t.url, location.href).href;
        noteHeaders(url, t.headers);
        if (recording && !SAFE_METHODS.has(t.method)) {
          const entry = { id: ++seq, method: t.method, url, headers: { ...t.headers }, ...describeBody(body) };
          this.addEventListener('loadend', () => post({ type: 'captured', req: { ...entry, status: this.status } }));
        }
      } catch (e) { /* bỏ qua */ }
    }
    return xhrSend.apply(this, arguments);
  };

  /* ---------- Gọi lại request theo mẫu ---------- */

  async function replay(id, req) {
    try {
      const headers = Object.assign({}, req.headers);
      const host = hostOf(req.url);
      for (const name of req.dynamicHeaders || []) {
        const key = name.toLowerCase();
        const value = lastSensitive.get(`${host}|${key}`) || lastSensitive.get(`*|${key}`);
        if (!value) {
          throw new Error(`Chưa thấy trang gửi header "${name}". Hãy thao tác bất kỳ trên trang (ví dụ lọc lại danh sách) rồi chạy lại.`);
        }
        headers[name] = value;
      }
      const res = await origFetch(req.url, {
        method: req.method,
        headers,
        body: req.body == null ? undefined : req.body,
        credentials: 'include',
      });
      const text = await res.text();
      post({ type: 'replay-result', id, status: res.status, text: text.slice(0, 2000) });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      post({ type: 'replay-result', id, status: 0, error: msg === 'Failed to fetch' ? 'Failed to fetch (mất mạng hoặc bị chặn CORS)' : msg });
    }
  }

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.channel !== CH || d.dir !== 'to-hook') return;
    if (d.type === 'record') recording = !!d.on;
    else if (d.type === 'replay') replay(d.id, d.req);
    else if (d.type === 'ping') post({ type: 'ready' });
  });

  post({ type: 'ready' });
})();
