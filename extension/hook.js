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
  const SKIP_HEADER = /^(host|content-length|connection|accept-encoding|user-agent|origin|referer|cookie|keep-alive|te|upgrade|priority|sec-.+)$/i;
  const CODE = /^\d{9,15}$/;
  const lastSensitive = new Map(); // "host|ten-header" -> giá trị mới nhất (chỉ giữ trong bộ nhớ)
  const lastHeaders = new Map(); // host -> header trang vừa gửi tới host đó (token, header tuỳ biến...), chỉ trong bộ nhớ
  const idByCode = new Map(); // mã ticket hiển thị -> id nội bộ, học từ phản hồi JSON của trang
  const ambiguousCodes = new Set();
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
    const seen = lastHeaders.get(host) || {};
    for (const [name, value] of Object.entries(headers)) {
      if (!value) continue;
      if (!SKIP_HEADER.test(name)) seen[name.toLowerCase()] = value;
      if (!SENSITIVE.test(name)) continue;
      lastSensitive.set(`${host}|${name.toLowerCase()}`, value);
      lastSensitive.set(`*|${name.toLowerCase()}`, value);
    }
    lastHeaders.set(host, seen);
  }

  // Duyệt JSON phản hồi: object có "id" và chứa chuỗi giống mã ticket -> ghi nhớ mã -> id.
  function indexIds(root) {
    const stack = [root];
    let visited = 0;
    while (stack.length && visited < 300000) {
      const n = stack.pop();
      visited += 1;
      if (!n || typeof n !== 'object') continue;
      if (Array.isArray(n)) { n.forEach((x) => stack.push(x)); continue; }
      const id = n.id;
      const hasId = (typeof id === 'number' && Number.isFinite(id)) || (typeof id === 'string' && /^\d+$/.test(id));
      for (const v of Object.values(n)) {
        if (typeof v === 'string') {
          if (!hasId || !CODE.test(v)) continue;
          if (idByCode.has(v) && String(idByCode.get(v)) !== String(id)) ambiguousCodes.add(v);
          idByCode.set(v, id);
        } else if (v && typeof v === 'object') {
          stack.push(v);
        }
      }
    }
    if (idByCode.size > 200000) { idByCode.clear(); ambiguousCodes.clear(); }
  }

  function indexText(text) {
    if (!text || text.length > 5e6) return;
    try { indexIds(JSON.parse(text)); } catch (e) { /* không phải JSON */ }
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
    p.then((r) => {
      if (/json/i.test(r.headers.get('content-type') || '')) r.clone().text().then(indexText, () => {});
    }, () => {});
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
        this.addEventListener('loadend', () => {
          try {
            if (!/json/i.test(this.getResponseHeader('content-type') || '')) return;
            if (this.responseType === 'json') indexIds(this.response);
            else if (this.responseType === '' || this.responseType === 'text') indexText(this.responseText);
          } catch (e) { /* bỏ qua */ }
        });
        if (recording && !SAFE_METHODS.has(t.method)) {
          const entry = { id: ++seq, method: t.method, url, headers: { ...t.headers }, ...describeBody(body) };
          this.addEventListener('loadend', () => post({ type: 'captured', req: { ...entry, status: this.status } }));
        }
      } catch (e) { /* bỏ qua */ }
    }
    return xhrSend.apply(this, arguments);
  };

  /* ---------- Gọi lại request theo mẫu ---------- */

  // Gọi cross-origin có thể bị CORS chặn tuỳ cách gửi, nên thử lần lượt (chỉ chuyển cách khác khi lỗi mạng/CORS):
  //  A. Header đầy đủ như trang vẫn gửi, không kèm cookie (giống axios/fetch mặc định)
  //  B. Như A nhưng kèm cookie
  //  C. Chỉ header của mẫu + token/CSRF (phòng khi một header tuỳ biến bị preflight từ chối)
  async function replay(id, req) {
    try {
      const host = hostOf(req.url);
      const tokensOnly = {};
      for (const [key, value] of lastSensitive) {
        if (key.startsWith(`${host}|`)) tokensOnly[key.slice(host.length + 1)] = value;
      }
      const build = (base) => {
        const headers = Object.assign({}, base);
        const setHeader = (name, value) => {
          for (const k of Object.keys(headers)) if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
          headers[name] = value;
        };
        for (const [name, value] of Object.entries(req.headers || {})) setHeader(name, value);
        for (const name of req.dynamicHeaders || []) {
          const key = name.toLowerCase();
          const value = lastSensitive.get(`${host}|${key}`) || lastSensitive.get(`*|${key}`);
          if (!value) {
            throw new Error(`Chưa thấy trang gửi header "${name}". Hãy thao tác bất kỳ trên trang (ví dụ lọc lại danh sách) rồi chạy lại.`);
          }
          setHeader(name, value);
        }
        return headers;
      };
      const pageHeaders = lastHeaders.get(host);
      const attempts = [
        { headers: build(pageHeaders), credentials: 'same-origin' },
        { headers: build(pageHeaders), credentials: 'include' },
        { headers: build(tokensOnly), credentials: 'same-origin' },
      ];
      let lastError;
      for (const attempt of attempts) {
        try {
          const res = await origFetch(req.url, {
            method: req.method,
            headers: attempt.headers,
            body: req.body == null ? undefined : req.body,
            credentials: attempt.credentials,
          });
          const text = await res.text();
          post({ type: 'replay-result', id, status: res.status, text: text.slice(0, 2000) });
          return;
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          lastError = e;
        }
      }
      throw new Error(`${lastError && lastError.message} (đã thử 3 cách gửi; mất mạng hoặc API không cho phép gọi từ trang này)`);
    } catch (e) {
      post({ type: 'replay-result', id, status: 0, error: e && e.message ? e.message : String(e) });
    }
  }

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.channel !== CH || d.dir !== 'to-hook') return;
    if (d.type === 'record') recording = !!d.on;
    else if (d.type === 'replay') replay(d.id, d.req);
    else if (d.type === 'resolve-ids') {
      const ids = {};
      const ambiguous = [];
      for (const code of d.codes || []) {
        if (ambiguousCodes.has(code)) ambiguous.push(code);
        else if (idByCode.has(code)) ids[code] = idByCode.get(code);
      }
      post({ type: 'ids', id: d.id, ids, ambiguous });
    }
    else if (d.type === 'ping') post({ type: 'ready' });
  });

  post({ type: 'ready' });
})();
