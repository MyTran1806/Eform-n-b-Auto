/* Giao diện "Đổi loại hàng loạt" (góc phải dưới) + luồng: ghi lại request -> lưu mẫu -> chạy cho các ticket đã tick. */
(() => {
  if (window.top !== window || window.__ttBulkUI) return;
  window.__ttBulkUI = true;

  const C = window.TTCore;
  const CH = 'tt-bulk';
  const STORE_KEY = `tt:${location.host}`;
  const DEFAULTS = {
    types: [], // [{label, value}]
    template: null, // {method, url, headers, dynamicHeaders, body}
    concurrency: 2,
    delayMs: 150,
    failRegex: '',
    codeRegex: '',
    rowSelector: '',
    checkedSelector: '',
  };

  let cfg = { ...DEFAULTS };
  let hookReady = false;
  let recording = false;
  let captured = [];
  let picked = null;
  let running = false;
  let stopRequested = false;
  let codes = [];
  let seq = 0;
  const pending = new Map();
  const failed = [];
  const progress = { total: 0, done: 0, ok: 0, fail: 0 };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  };

  const loadCfg = () => new Promise((resolve) => {
    chrome.storage.local.get(STORE_KEY, (r) => resolve({ ...DEFAULTS, ...((r && r[STORE_KEY]) || {}) }));
  });
  const saveCfg = () => chrome.storage.local.set({ [STORE_KEY]: cfg });
  const toHook = (msg) => window.postMessage({ channel: CH, dir: 'to-hook', ...msg }, '*');

  /* ---------- Giao tiếp với hook.js ---------- */

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.channel !== CH || d.dir !== 'to-content') return;
    if (d.type === 'ready') {
      hookReady = true;
    } else if (d.type === 'captured') {
      if (recording) { captured.push(d.req); renderCaptures(); }
    } else if (d.type === 'replay-result') {
      const resolve = pending.get(d.id);
      if (resolve) { pending.delete(d.id); resolve(d); }
    }
  });

  async function ensureHook() {
    if (hookReady) return true;
    toHook({ type: 'ping' });
    await sleep(300);
    return hookReady;
  }

  function replay(req) {
    return new Promise((resolve) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ status: 0, error: 'Hết thời gian chờ (30 giây)' });
      }, 30000);
      pending.set(id, (res) => { clearTimeout(timer); resolve(res); });
      toHook({ type: 'replay', id, req });
    });
  }

  /* ---------- Giao diện ---------- */

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    [hidden] { display: none !important; }
    .launcher { position: fixed; right: 16px; bottom: 76px; z-index: 2147483000; display: flex; gap: 6px; align-items: center;
      padding: 8px 12px; border: 0; border-radius: 999px; background: #f26522; color: #fff; font-size: 13px; font-weight: 600;
      box-shadow: 0 2px 10px rgba(0,0,0,.25); cursor: pointer; }
    .badge { min-width: 20px; padding: 0 6px; border-radius: 999px; background: #fff; color: #f26522; font-size: 12px; text-align: center; }
    .panel { position: fixed; right: 16px; bottom: 124px; z-index: 2147483000; width: 360px; max-height: 70vh; overflow: auto;
      background: #fff; color: #222; border: 1px solid #ddd; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.28); font-size: 13px; }
    .head { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-bottom: 1px solid #eee; font-weight: 700; }
    .x { border: 0; background: none; font-size: 18px; cursor: pointer; color: #666; }
    .tabs { display: flex; border-bottom: 1px solid #eee; }
    .tab { flex: 1; padding: 8px; border: 0; background: none; cursor: pointer; font-size: 13px; color: #666; border-bottom: 2px solid transparent; }
    .tab.on { color: #f26522; border-bottom-color: #f26522; font-weight: 600; }
    .pane { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    h3 { margin: 0; font-size: 13px; }
    select, input[type=text], input[type=number], textarea { width: 100%; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; font-size: 12.5px; background: #fff; color: #222; }
    textarea { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; resize: vertical; }
    button.primary { padding: 8px 12px; border: 0; border-radius: 6px; background: #f26522; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; }
    button.ghost { padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; color: #333; font-size: 13px; cursor: pointer; }
    button.link { border: 0; background: none; color: #d4500f; cursor: pointer; font-size: 12.5px; padding: 0; text-align: left; }
    button:disabled { opacity: .45; cursor: default; }
    .row { display: flex; gap: 8px; align-items: center; }
    .row > * { flex: 1; }
    .between { display: flex; justify-content: space-between; align-items: center; }
    .muted { color: #777; font-size: 12px; }
    .warn { padding: 8px; border-radius: 6px; background: #fff4e5; color: #8a4b00; font-size: 12px; }
    .msg { font-size: 12px; color: #b00020; }
    .msg.ok { color: #1b7f3b; }
    .bar { height: 6px; border-radius: 3px; background: #eee; overflow: hidden; }
    .bar i { display: block; height: 100%; width: 0; background: #f26522; transition: width .15s; }
    .log { max-height: 160px; overflow: auto; border: 1px solid #eee; border-radius: 6px; font-size: 12px; }
    .log div { padding: 3px 8px; border-bottom: 1px solid #f3f3f3; word-break: break-all; }
    .log .ok { color: #1b7f3b; } .log .bad { color: #b00020; }
    .caps { display: flex; flex-direction: column; gap: 4px; max-height: 150px; overflow: auto; }
    .cap { text-align: left; padding: 6px 8px; border: 1px solid #ddd; border-radius: 6px; background: #fff; cursor: pointer; font-size: 12px; word-break: break-all; }
    .cap.on { border-color: #f26522; background: #fff4ec; }
    .cap:disabled { opacity: .5; cursor: default; }
    .form { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px dashed #ccc; border-radius: 6px; }
    label { font-size: 12px; color: #444; display: flex; flex-direction: column; gap: 3px; }
    details summary { cursor: pointer; font-size: 12.5px; color: #444; }
  `;

  const host = h('div');
  const shadow = host.attachShadow({ mode: 'open' });

  // --- Tab "Đổi loại"
  const selInfo = h('div', { class: 'muted' });
  const warn = h('div', { class: 'warn', hidden: true });
  const typeSel = h('select', { onchange: updateButtons });
  const startBtn = h('button', { class: 'primary', onclick: runBulk }, 'Đổi loại');
  const stopBtn = h('button', { class: 'ghost', hidden: true, onclick: () => { stopRequested = true; } }, 'Dừng');
  const needSetup = h('div', { class: 'warn', hidden: true });
  const barFill = h('i');
  const progText = h('div', { class: 'muted' });
  const logBox = h('div', { class: 'log', hidden: true });
  const copyFailBtn = h('button', { class: 'link', hidden: true, onclick: copyFailed }, 'Sao chép mã ticket lỗi');

  const runPane = h('div', { class: 'pane' },
    h('div', { class: 'between' }, selInfo, h('button', { class: 'link', onclick: refreshSelection }, 'Đọc lại')),
    warn,
    h('label', {}, 'Loại mới', typeSel),
    needSetup,
    h('div', { class: 'row' }, startBtn, stopBtn),
    h('div', { class: 'bar' }, barFill),
    progText,
    logBox,
    copyFailBtn);

  // --- Tab "Cài đặt"
  const typesTa = h('textarea', { rows: 4, placeholder: 'Khiếu nại | complaint\nHồi giao/lấy/trả hàng | return' });
  const typesMsg = h('div', { class: 'msg' });

  const tplInfo = h('div', { class: 'muted' });
  const editTplBtn = h('button', { class: 'link', hidden: true, onclick: () => openEditor(cfg.template, '') }, 'Sửa mẫu hiện tại');
  const recordBtn = h('button', { class: 'primary', onclick: toggleRecord }, 'Bắt đầu ghi');
  const recHint = h('div', { class: 'muted', hidden: true });
  const capList = h('div', { class: 'caps' });
  const capTicket = h('input', { type: 'text', placeholder: 'Ví dụ 691002569352' });
  const capType = h('input', { type: 'text', placeholder: 'Ví dụ complaint (bỏ trống nếu chưa đổi loại)' });
  const capMsg = h('div', { class: 'msg' });
  const capForm = h('div', { class: 'form', hidden: true },
    h('label', {}, 'Mã ticket bạn vừa thao tác', capTicket),
    h('label', {}, 'Giá trị "loại" bạn vừa chọn', capType),
    h('button', { class: 'primary', onclick: buildFromPicked }, 'Tạo mẫu từ request này'),
    capMsg);

  const edMethod = h('select', {}, ['POST', 'PUT', 'PATCH', 'DELETE', 'GET'].map((m) => h('option', { value: m }, m)));
  const edUrl = h('input', { type: 'text' });
  const edHeaders = h('textarea', { rows: 3 });
  const edDynamic = h('div', { class: 'muted' });
  const edBody = h('textarea', { rows: 6 });
  const edNote = h('div', { class: 'muted' });
  const edMsg = h('div', { class: 'msg' });
  const editor = h('div', { class: 'form', hidden: true },
    edNote,
    h('label', {}, 'Method', edMethod),
    h('label', {}, 'URL (dùng {{ticket}} và {{type}})', edUrl),
    h('label', {}, 'Header (mỗi dòng "Tên: giá trị")', edHeaders),
    edDynamic,
    h('label', {}, 'Body (dùng {{ticket}} và {{type}})', edBody),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: saveTemplate }, 'Lưu mẫu'),
      h('button', { class: 'ghost', onclick: () => { editor.hidden = true; } }, 'Đóng')),
    edMsg);

  const concInput = h('input', { type: 'number', min: 1, max: 5 });
  const delayInput = h('input', { type: 'number', min: 0, max: 5000 });
  const failInput = h('input', { type: 'text', placeholder: 'Ví dụ "success"\\s*:\\s*false' });
  const codeInput = h('input', { type: 'text', placeholder: String.raw`\b\d{9,15}\b` });
  const rowInput = h('input', { type: 'text', placeholder: 'Ví dụ tr.ant-table-row' });
  const checkedInput = h('input', { type: 'text', placeholder: 'Ví dụ input[type=checkbox]:checked' });
  const advMsg = h('div', { class: 'msg' });

  const setupPane = h('div', { class: 'pane', hidden: true },
    h('h3', {}, '1. Danh sách loại'),
    h('div', { class: 'muted' }, 'Mỗi dòng: Tên hiển thị | giá trị gửi lên hệ thống.'),
    typesTa,
    h('button', { class: 'primary', onclick: saveTypes }, 'Lưu danh sách loại'),
    typesMsg,
    h('h3', {}, '2. Mẫu request đổi loại'),
    tplInfo,
    editTplBtn,
    recordBtn,
    recHint,
    capList,
    capForm,
    editor,
    h('h3', {}, '3. Tốc độ & nâng cao'),
    h('div', { class: 'row' },
      h('label', {}, 'Chạy song song', concInput),
      h('label', {}, 'Nghỉ giữa các request (ms)', delayInput)),
    h('details', {},
      h('summary', {}, 'Nâng cao'),
      h('div', { class: 'pane', style: 'padding:8px 0 0' },
        h('label', {}, 'Coi là lỗi nếu phản hồi khớp regex', failInput),
        h('label', {}, 'Regex mã ticket', codeInput),
        h('label', {}, 'CSS selector của dòng (nếu không tự đọc được)', rowInput),
        h('label', {}, 'CSS selector của ô đã tick', checkedInput))),
    h('button', { class: 'primary', onclick: saveAdvanced }, 'Lưu cài đặt'),
    advMsg);

  const tabRun = h('button', { class: 'tab on', onclick: () => showTab('run') }, 'Đổi loại');
  const tabSetup = h('button', { class: 'tab', onclick: () => showTab('setup') }, 'Cài đặt');
  const badge = h('span', { class: 'badge' }, '0');
  const launcher = h('button', { class: 'launcher', onclick: togglePanel }, 'Đổi loại hàng loạt', badge);
  const panel = h('div', { class: 'panel', hidden: true },
    h('div', { class: 'head' }, 'Đổi loại hàng loạt', h('button', { class: 'x', onclick: togglePanel }, '×')),
    h('div', { class: 'tabs' }, tabRun, tabSetup),
    runPane,
    setupPane);

  shadow.append(h('style', {}, CSS), launcher, panel);

  /* ---------- Điều khiển giao diện ---------- */

  let timer = null;

  function togglePanel() {
    panel.hidden = !panel.hidden;
    clearInterval(timer);
    if (!panel.hidden) {
      refreshSelection();
      timer = setInterval(() => { if (!running && !runPane.hidden) refreshSelection(); }, 1500);
    }
  }

  function showTab(name) {
    runPane.hidden = name !== 'run';
    setupPane.hidden = name !== 'setup';
    tabRun.classList.toggle('on', name === 'run');
    tabSetup.classList.toggle('on', name === 'setup');
    if (name === 'run') refreshSelection();
  }

  function refreshSelection() {
    const r = C.readSelectedTickets(document, cfg);
    const summary = C.parseSelectedSummary(document.body.innerText);
    codes = r.codes;
    badge.textContent = String(codes.length);
    selInfo.textContent = `Đã tick: ${codes.length} ticket`;
    let w = '';
    if (!codes.length) {
      w = 'Chưa đọc được ticket nào đã tick. Hãy tick ticket trên danh sách; nếu đã tick mà vẫn không thấy, chỉnh selector ở Cài đặt → Nâng cao.';
    } else if (summary && summary.selected !== codes.length) {
      w = `Trang báo đã chọn ${summary.selected} phiếu nhưng chỉ đọc được ${codes.length} (danh sách có thể chỉ hiển thị một phần). Nên chia nhỏ rồi chạy từng đợt.`;
    } else if (r.ambiguous) {
      w = `${r.ambiguous} dòng không đọc được mã ticket (có nhiều mã trong một dòng).`;
    }
    warn.textContent = w;
    warn.hidden = !w;
    updateButtons();
  }

  function renderTypeOptions() {
    const keep = typeSel.value;
    typeSel.replaceChildren(h('option', { value: '' }, '-- Chọn loại mới --'),
      ...cfg.types.map((t, i) => h('option', { value: String(i) }, t.label)));
    typeSel.value = keep;
  }

  function updateButtons() {
    const missing = [];
    if (!cfg.types.length) missing.push('danh sách loại');
    if (!cfg.template) missing.push('mẫu request');
    needSetup.hidden = !missing.length;
    needSetup.textContent = missing.length ? `Chưa có ${missing.join(' và ')} — sang tab Cài đặt để thiết lập.` : '';
    const typeIdx = typeSel.value === '' ? -1 : Number(typeSel.value);
    startBtn.disabled = running || !codes.length || typeIdx < 0 || missing.length > 0;
    startBtn.textContent = typeIdx >= 0 && codes.length ? `Đổi ${codes.length} ticket sang "${cfg.types[typeIdx].label}"` : 'Đổi loại';
    typeSel.disabled = running;
    stopBtn.hidden = !running;
  }

  function renderTemplateInfo() {
    const t = cfg.template;
    tplInfo.textContent = t ? `Đã lưu: ${t.method} ${t.url}` : 'Chưa có mẫu. Bấm "Bắt đầu ghi", rồi đổi loại 1 ticket trên trang như bình thường.';
    editTplBtn.hidden = !t;
  }

  /* ---------- Chạy hàng loạt ---------- */

  function setProgress() {
    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    barFill.style.width = `${pct}%`;
    progText.textContent = `${progress.done}/${progress.total} · thành công ${progress.ok} · lỗi ${progress.fail}`;
  }

  function addLog(code, ok, note) {
    progress.done += 1;
    if (ok) progress.ok += 1; else { progress.fail += 1; failed.push(code); }
    logBox.append(h('div', { class: ok ? 'ok' : 'bad' }, `${ok ? '✓' : '✗'} ${code} — ${note}`));
    logBox.scrollTop = logBox.scrollHeight;
    setProgress();
  }

  async function runOne(code, type) {
    let req;
    try {
      req = C.renderTemplate(cfg.template, { ticket: code, type: type.value });
    } catch (e) {
      addLog(code, false, e.message);
      return false;
    }
    const { ok, note } = C.evaluateResult(await replay(req), cfg.failRegex);
    addLog(code, ok, note);
    return ok;
  }

  function finish(message) {
    running = false;
    progText.textContent = `${message} Thành công ${progress.ok}/${progress.total}, lỗi ${progress.fail}.`;
    copyFailBtn.hidden = !failed.length;
    updateButtons();
  }

  async function runBulk() {
    refreshSelection();
    const type = cfg.types[Number(typeSel.value)];
    const batch = [...codes];
    if (running || !batch.length || !type || !cfg.template) return;
    if (!(await ensureHook())) {
      warn.hidden = false;
      warn.textContent = 'Extension chưa gắn được vào trang. Hãy tải lại trang (F5) rồi thử lại.';
      return;
    }
    if (!window.confirm(`Đổi loại ${batch.length} ticket sang "${type.label}"?\n\nTicket đầu tiên chạy trước để kiểm tra; nếu lỗi sẽ dừng lại.`)) return;

    running = true;
    stopRequested = false;
    failed.length = 0;
    Object.assign(progress, { total: batch.length, done: 0, ok: 0, fail: 0 });
    logBox.replaceChildren();
    logBox.hidden = false;
    copyFailBtn.hidden = true;
    setProgress();
    updateButtons();

    if (!(await runOne(batch[0], type))) {
      finish('Ticket đầu tiên bị lỗi nên đã dừng, chưa đụng tới các ticket còn lại. Kiểm tra lại mẫu ở tab Cài đặt.');
      return;
    }
    let next = 1;
    const worker = async () => {
      while (!stopRequested && next < batch.length) {
        await runOne(batch[next++], type);
        if (cfg.delayMs) await sleep(cfg.delayMs);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, cfg.concurrency) }, worker));
    finish(stopRequested ? 'Đã dừng.' : 'Xong, hãy tải lại danh sách để thấy loại mới.');
  }

  function copyFailed() {
    navigator.clipboard.writeText(failed.join('\n')).then(
      () => { copyFailBtn.textContent = `Đã sao chép ${failed.length} mã`; },
      () => { copyFailBtn.textContent = failed.join(', '); });
  }

  /* ---------- Cài đặt: danh sách loại ---------- */

  function saveTypes() {
    const { types, errors } = C.parseTypes(typesTa.value);
    typesMsg.className = 'msg';
    if (errors.length) { typesMsg.textContent = errors.join(' · '); return; }
    cfg.types = types;
    saveCfg();
    renderTypeOptions();
    updateButtons();
    typesMsg.className = 'msg ok';
    typesMsg.textContent = `Đã lưu ${types.length} loại.`;
  }

  /* ---------- Cài đặt: ghi lại request ---------- */

  function toggleRecord() {
    recording = !recording;
    toHook({ type: 'record', on: recording });
    if (recording) { captured = []; picked = null; capForm.hidden = true; }
    recordBtn.textContent = recording ? 'Dừng ghi' : 'Bắt đầu ghi';
    recHint.hidden = !recording;
    recHint.textContent = 'Đang ghi. Trên trang, hãy đổi loại 1 ticket như bình thường (hoặc bấm Cập nhật), rồi chọn request tương ứng bên dưới.';
    renderCaptures();
  }

  function renderCaptures() {
    capList.replaceChildren(...[...captured].reverse().map((req) => {
      let path = req.url;
      try { const u = new URL(req.url); path = u.host + u.pathname + u.search; } catch (e) { /* giữ nguyên */ }
      const label = `${req.method} ${path.length > 70 ? `${path.slice(0, 70)}…` : path} · ${req.status || 'lỗi'}`;
      if (req.unsupported) return h('button', { class: 'cap', disabled: true }, `${label} (body ${req.unsupported} chưa hỗ trợ)`);
      return h('button', { class: `cap${picked === req ? ' on' : ''}`, onclick: () => pickCapture(req) }, label);
    }));
  }

  function pickCapture(req) {
    picked = req;
    const haystack = `${req.url} ${req.body || ''}`;
    capTicket.value = readSelectionSafe().find((c) => haystack.includes(c)) || '';
    capMsg.textContent = '';
    capForm.hidden = false;
    renderCaptures();
  }

  const readSelectionSafe = () => C.readSelectedTickets(document, cfg).codes;

  function buildFromPicked() {
    if (!picked) return;
    const ticket = capTicket.value.trim();
    if (!ticket) { capMsg.textContent = 'Nhập mã ticket bạn vừa thao tác (đúng như đã gửi trong request).'; return; }
    const { template, counts } = C.buildTemplate(picked, { ticket, type: capType.value.trim() });
    if (recording) toggleRecord();
    openEditor(template, `Thay được mã ticket ${counts.ticket} chỗ, giá trị loại ${counts.type} chỗ. Kiểm tra lại, đặc biệt nếu một giá trị bị thay nhiều chỗ.`);
  }

  let editorDynamic = [];

  function openEditor(tpl, note) {
    edNote.textContent = note;
    edMethod.value = tpl.method;
    edUrl.value = tpl.url;
    edHeaders.value = Object.entries(tpl.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
    editorDynamic = tpl.dynamicHeaders || [];
    edDynamic.textContent = editorDynamic.length
      ? `Header lấy tự động từ trang lúc chạy (không lưu giá trị): ${editorDynamic.join(', ')}`
      : '';
    edBody.value = tpl.body == null ? '' : tpl.body;
    edMsg.textContent = '';
    editor.hidden = false;
  }

  function saveTemplate() {
    edMsg.className = 'msg';
    const headers = {};
    for (const line of edHeaders.value.split(/\r?\n/)) {
      const at = line.indexOf(':');
      if (at > 0 && line.slice(0, at).trim()) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    const tpl = {
      method: edMethod.value,
      url: edUrl.value.trim(),
      headers,
      dynamicHeaders: editorDynamic,
      body: edBody.value === '' ? null : edBody.value,
    };
    if (!tpl.url) { edMsg.textContent = 'Thiếu URL.'; return; }
    const used = C.placeholdersIn(tpl);
    if (!used.has('ticket')) { edMsg.textContent = 'Mẫu chưa có {{ticket}} ở URL hoặc body nên sẽ gửi y hệt cho mọi ticket.'; return; }
    if (!used.has('type')) { edMsg.textContent = 'Mẫu chưa có {{type}}. Điền giá trị loại bạn đã chọn ở bước trước, hoặc tự gõ {{type}} vào chỗ chứa loại.'; return; }
    cfg.template = tpl;
    saveCfg();
    renderTemplateInfo();
    updateButtons();
    editor.hidden = true;
    capForm.hidden = true;
  }

  /* ---------- Cài đặt: nâng cao ---------- */

  function saveAdvanced() {
    advMsg.className = 'msg';
    for (const [name, value] of [['regex lỗi', failInput.value], ['regex mã ticket', codeInput.value]]) {
      try { if (value) new RegExp(value); } catch (e) { advMsg.textContent = `${name} không hợp lệ.`; return; }
    }
    cfg.concurrency = Math.min(5, Math.max(1, Number(concInput.value) || 1));
    cfg.delayMs = Math.min(5000, Math.max(0, Number(delayInput.value) || 0));
    cfg.failRegex = failInput.value.trim();
    cfg.codeRegex = codeInput.value.trim();
    cfg.rowSelector = rowInput.value.trim();
    cfg.checkedSelector = checkedInput.value.trim();
    saveCfg();
    advMsg.className = 'msg ok';
    advMsg.textContent = 'Đã lưu.';
    refreshSelection();
  }

  /* ---------- Khởi động ---------- */

  toHook({ type: 'ping' });
  loadCfg().then((stored) => {
    cfg = stored;
    typesTa.value = C.stringifyTypes(cfg.types);
    concInput.value = cfg.concurrency;
    delayInput.value = cfg.delayMs;
    failInput.value = cfg.failRegex;
    codeInput.value = cfg.codeRegex;
    rowInput.value = cfg.rowSelector;
    checkedInput.value = cfg.checkedSelector;
    renderTypeOptions();
    renderTemplateInfo();
    updateButtons();
    document.documentElement.append(host);
  });
})();
