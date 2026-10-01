/* Logic thuần của extension: dựng/điền mẫu request, đọc ticket đã tick trên trang.
 * Dùng chung cho content.js (trình duyệt) và tests/core.test.js (Node). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TTCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const DEFAULT_CODE_REGEX = '\\b\\d{9,15}\\b';
  const SKIP_HEADER = /^(host|content-length|connection|accept-encoding|user-agent|origin|referer|cookie|keep-alive|te|upgrade|priority|sec-.+)$/i;
  const SENSITIVE_HEADER = /authorization|token|csrf|xsrf|session|api-?key|secret/i;
  const PLACEHOLDER = /\{\{\s*(ticket|id|type|reason)\s*\}\}/g;

  /* ---------- Header ---------- */

  // Header nhạy cảm (token, csrf...) không lưu giá trị; chỉ lưu tên để lấy giá trị mới nhất từ trang lúc chạy.
  function splitHeaders(headers) {
    const kept = {};
    const dynamic = [];
    for (const [name, value] of Object.entries(headers || {})) {
      if (SKIP_HEADER.test(name)) continue;
      if (SENSITIVE_HEADER.test(name)) dynamic.push(name);
      else kept[name] = value;
    }
    return { headers: kept, dynamic };
  }

  function contentKind(headers) {
    const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === 'content-type');
    const ct = key ? String(headers[key]).toLowerCase() : '';
    if (ct.includes('json')) return 'json';
    if (ct.includes('x-www-form-urlencoded')) return 'form';
    return 'raw';
  }

  /* ---------- Mẫu request ---------- */

  function escapeValue(kind, value) {
    const s = String(value);
    if (kind === 'url' || kind === 'form') return encodeURIComponent(s);
    if (kind === 'json') return JSON.stringify(s).slice(1, -1);
    return s;
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Thay giá trị thật (mã ticket, giá trị loại) trong text bằng {{ticket}} / {{type}}.
  function substituteLiterals(text, literals, kind) {
    const alts = [];
    for (const { value, placeholder } of literals) {
      if (!value) continue;
      for (const v of new Set([value, escapeValue(kind, value)])) alts.push({ v, placeholder });
    }
    const counts = { ticket: 0, type: 0, id: 0, reason: 0 };
    if (!alts.length || !text) return { text, counts };
    alts.sort((a, b) => b.v.length - a.v.length);
    const re = new RegExp(alts.map((a) => escapeRegExp(a.v)).join('|'), 'g');
    const out = text.replace(re, (m) => {
      const hit = alts.find((a) => a.v === m);
      counts[hit.placeholder] += 1;
      return `{{${hit.placeholder}}}`;
    });
    return { text: out, counts };
  }

  // captured: {method, url, headers, body}. literals: giá trị thật bạn đã dùng khi thao tác tay.
  function buildTemplate(captured, literals) {
    const { headers, dynamic } = splitHeaders(captured.headers);
    const pairs = [
      { value: literals.ticket, placeholder: 'ticket' },
      { value: literals.type, placeholder: 'type' },
    ];
    const u = substituteLiterals(captured.url, pairs, 'url');
    const b = substituteLiterals(captured.body, pairs, contentKind(headers));
    return {
      template: {
        method: captured.method,
        url: u.text,
        headers,
        dynamicHeaders: dynamic,
        body: captured.body == null ? null : b.text,
      },
      counts: { ticket: u.counts.ticket + b.counts.ticket, type: u.counts.type + b.counts.type },
    };
  }

  function fill(text, vars, kind) {
    return text.replace(PLACEHOLDER, (_, key) => {
      if (vars[key] == null) throw new Error(`Thiếu giá trị cho {{${key}}}`);
      return escapeValue(kind, vars[key]);
    });
  }

  function renderTemplate(tpl, vars) {
    return {
      method: tpl.method,
      url: fill(tpl.url, vars, 'url'),
      headers: { ...tpl.headers },
      dynamicHeaders: tpl.dynamicHeaders || [],
      body: tpl.body == null ? null : fill(tpl.body, vars, contentKind(tpl.headers)),
    };
  }

  // Các request cần gửi cho một ticket: bước 1 theo mẫu; bước 2 (nếu có) cùng URL/header nhưng body khác.
  // Bước 2 chứa {{reason}} mà loại không có lý do thì bỏ qua.
  function renderSteps(tpl, vars) {
    const steps = [renderTemplate(tpl, vars)];
    if (tpl.followUpBody) {
      const needsReason = /\{\{\s*reason\s*\}\}/.test(tpl.followUpBody);
      if (!needsReason || vars.reason) steps.push(renderTemplate({ ...tpl, body: tpl.followUpBody }, vars));
    }
    return steps;
  }

  function placeholdersIn(tpl) {
    const found = new Set();
    for (const text of [tpl.url, tpl.body]) {
      for (const m of String(text || '').matchAll(PLACEHOLDER)) found.add(m[1]);
    }
    return found;
  }

  /* ---------- Danh sách loại: mỗi dòng "Tên hiển thị | giá trị gửi lên | lý do (tuỳ chọn)" ---------- */

  function parseTypes(text) {
    const types = [];
    const errors = [];
    String(text || '').split(/\r?\n/).forEach((line, i) => {
      const s = line.trim();
      if (!s || s.startsWith('#')) return;
      const [label = '', value = '', ...rest] = s.split('|').map((x) => x.trim());
      if (!label || !value) {
        errors.push(`Dòng ${i + 1}: cần dạng "Tên hiển thị | giá trị" (thêm "| lý do" nếu có)`);
        return;
      }
      const reason = rest.join(' | ');
      types.push(reason ? { label, value, reason } : { label, value });
    });
    return { types, errors };
  }

  function stringifyTypes(types) {
    return (types || []).map((t) => [t.label, t.value, t.reason].filter(Boolean).join(' | ')).join('\n');
  }

  /* ---------- Cấu hình điền sẵn cho form "Loại + Lý do Hồi Giao/Lấy/Trả" của hệ thống CS ---------- */

  function presetGhn() {
    const type = 'Hồi Giao/Lấy/Trả hàng';
    return {
      types: [
        { label: 'Hồi giao', value: type, reason: 'Hồi giao' },
        { label: 'Hồi lấy', value: type, reason: 'Hồi lấy' },
        { label: 'Hồi trả', value: type, reason: 'Hồi trả' },
      ],
      template: {
        method: 'POST',
        url: 'https://cm-gateway.ghn.vn/ticket-connector/public-api/web/cs-ticket/update',
        headers: { 'Content-Type': 'application/json' },
        dynamicHeaders: [],
        // Bước 1 đổi loại; bước 2 đặt lý do (trường này chỉ sửa được sau khi ticket đã thuộc loại Hồi Giao/Lấy/Trả).
        body: '{"id":{{id}},"custom_fields":{"type":"{{type}}"}}',
        followUpBody: '{"id":{{id}},"custom_fields":{"type":"{{type}}","ly_do_hoi_giao_lay_tra":"{{reason}}"}}',
        // Nhóm phiếu không có trường lý do (vd "Vùng 3") thì server từ chối bước 2: coi như xong, chỉ ghi chú.
        followUpSkipRegex: 'không được phép sửa theo cấu hình nhóm phiếu',
      },
    };
  }

  /* ---------- Đọc ticket đã tick trên trang ---------- */

  const CHECKED_SELECTOR = [
    'input[type="checkbox"]:checked',
    '[role="checkbox"][aria-checked="true"]',
    '[class~="checked"]',
    '[class*="-checked"]:not([class*="unchecked"])',
  ].join(',');
  const HEADER_SELECTOR = 'thead, th, [role="columnheader"]';

  function parseSelectedSummary(text) {
    const m = /Đã\s*chọn\s*(\d+)\s*\/\s*(\d+)/i.exec(text || '');
    return m ? { selected: Number(m[1]), total: Number(m[2]) } : null;
  }

  // Mã ticket trong một vùng DOM: ưu tiên text của link, sau đó mới tới toàn bộ text.
  function codesIn(node, re) {
    const fromLinks = new Set();
    node.querySelectorAll('a, [role="link"]').forEach((a) => {
      (a.textContent || '').match(re)?.forEach((c) => fromLinks.add(c));
    });
    if (fromLinks.size) return [...fromLinks];
    return [...new Set((node.textContent || '').match(re) || [])];
  }

  // Trả về {codes, ambiguous}. cfg: {codeRegex, checkedSelector, rowSelector}.
  function readSelectedTickets(doc, cfg = {}) {
    const source = cfg.codeRegex || DEFAULT_CODE_REGEX;
    const re = new RegExp(source, 'g');
    const hasCode = new RegExp(source);
    const codes = [];
    const seen = new Set();
    let ambiguous = 0;
    doc.querySelectorAll(cfg.checkedSelector || CHECKED_SELECTOR).forEach((el) => {
      if (el.closest(HEADER_SELECTOR)) return;
      let row = null;
      if (cfg.rowSelector) {
        row = el.closest(cfg.rowSelector);
      } else {
        for (let n = el; n && n !== doc.body && n !== doc.documentElement; n = n.parentElement) {
          if (hasCode.test(n.textContent || '')) { row = n; break; }
        }
      }
      if (!row) return;
      const found = codesIn(row, re);
      if (found.length === 1) {
        if (!seen.has(found[0])) { seen.add(found[0]); codes.push(found[0]); }
      } else if (found.length > 1) {
        ambiguous += 1;
      }
    });
    return { codes, ambiguous };
  }

  /* ---------- Kết quả gọi API ---------- */

  function evaluateResult(res, failRegex) {
    if (res.error) return { ok: false, note: res.error };
    const snippet = String(res.text || '').replace(/\s+/g, ' ').slice(0, 160);
    if (res.status < 200 || res.status > 299) return { ok: false, note: `HTTP ${res.status} ${snippet}`.trim() };
    if (failRegex) {
      try {
        if (new RegExp(failRegex).test(res.text || '')) return { ok: false, note: `Phản hồi khớp điều kiện lỗi: ${snippet}` };
      } catch (e) { /* regex sai thì bỏ qua điều kiện */ }
    }
    return { ok: true, note: `HTTP ${res.status} ${snippet}`.trim() };
  }

  return {
    DEFAULT_CODE_REGEX,
    splitHeaders,
    contentKind,
    escapeValue,
    buildTemplate,
    renderTemplate,
    renderSteps,
    placeholdersIn,
    parseTypes,
    stringifyTypes,
    presetGhn,
    parseSelectedSummary,
    readSelectedTickets,
    evaluateResult,
  };
});
