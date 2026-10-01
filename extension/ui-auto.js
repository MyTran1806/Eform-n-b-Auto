/* Tự bấm giao diện trang chi tiết ticket: chọn "Loại", chọn "Lý do" trong danh sách trang hiện ra (không gõ/dán chữ vào ô), bấm "Cập nhật", rồi chờ request lưu của chính trang.
 * Không biết trước HTML của hệ thống nên tìm ô theo nhãn chữ + vị trí trên màn hình, và bấm bằng chuỗi sự kiện chuột thật.
 * Khi lỗi, thông báo kèm những gì đang thấy trên trang để dễ chỉnh. */
(function (root, factory) {
  root.TTAuto = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function (win) {
  const CH = 'tt-bulk';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  // So sánh chữ bỏ qua ký hiệu/biểu tượng (mũi tên, dấu * ...): "Loại *" và "Hồi Giao ⌄" vẫn khớp.
  const key = (s) => norm(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const allElements = () => Array.from(document.body.querySelectorAll('*'));

  async function waitFor(fn, timeout = 15000, step = 200) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(step);
    }
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  // Text nằm trực tiếp trong phần tử (không tính phần tử con).
  const ownText = (el) => key(Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '));
  const valueOf = (el) => key(el.innerText || el.textContent || (el.value != null ? el.value : ''));

  function realClick(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const target = document.elementFromPoint(x, y) || el;
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: win };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(type, init));
    }
  }

  /* ---------- Tìm ô theo nhãn ---------- */

  // Nhãn là phần tử có text trực tiếp khớp; nếu trùng nhiều chỗ thì lấy cái nằm bên phải nhất (khung "Thông tin phiếu").
  function findLabel(match) {
    const found = allElements().filter((el) => visible(el) && match(ownText(el)));
    found.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left || a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return found[0] || null;
  }

  // Hộp chọn là phần tử rộng nhất nằm ngay dưới nhãn và thẳng hàng với nhãn.
  function findControl(label) {
    label.scrollIntoView({ block: 'center' });
    const lr = label.getBoundingClientRect();
    let best = null;
    let bestArea = 0;
    for (const el of allElements()) {
      if (el === label || el.contains(label) || label.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.height < 20 || r.height > 80) continue;
      if (r.top < lr.bottom - 2 || r.top > lr.bottom + 40 || Math.abs(r.left - lr.left) > 40) continue;
      if (!visible(el)) continue;
      const area = r.width * r.height;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    return best;
  }

  function optionCandidates(want, control) {
    const outside = (el) => !(control && control.contains(el));
    const exact = allElements().filter((el) => visible(el) && ownText(el) === want && outside(el));
    if (exact.length) return exact;
    // Chữ lựa chọn bị tách qua nhiều thẻ con: lấy phần tử sâu nhất có toàn bộ chữ khớp.
    const whole = allElements().filter((el) => visible(el) && outside(el) && key(el.textContent) === want);
    return whole.filter((el) => !whole.some((o) => o !== el && el.contains(o)));
  }

  // Những gì vừa xuất hiện trên màn hình so với trước khi bấm (để báo lỗi dễ hiểu).
  function newlyVisibleTexts(before) {
    const texts = [];
    for (const el of allElements()) {
      if (before.has(el) || !visible(el) || el.children.length > 0) continue;
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (t && t.length <= 60 && !texts.includes(t)) texts.push(t);
      if (texts.length >= 12) break;
    }
    return texts;
  }

  function pressKey(el, k) {
    for (const type of ['keydown', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: k, code: k === ' ' ? 'Space' : k, bubbles: true, cancelable: true }));
    }
  }

  function visibleOptionTexts() {
    const texts = [];
    for (const el of document.querySelectorAll('[role="option"], li')) {
      const t = (el.innerText || '').trim();
      if (visible(el) && t && t.length <= 60 && !texts.includes(t)) texts.push(t);
      if (texts.length >= 12) break;
    }
    return texts;
  }

  function visibleMessages() {
    const out = [];
    for (const el of document.querySelectorAll('[role="alert"], [class*="error" i], [class*="invalid" i], [class*="toast" i], [class*="notif" i], [class*="message" i]')) {
      const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
      if (visible(el) && t.length >= 3 && t.length <= 200 && !out.includes(t)) out.push(t);
      if (out.length >= 3) break;
    }
    return out;
  }

  /* ---------- Chọn một lựa chọn trong dropdown ---------- */

  async function chooseOption(fieldName, labelMatch, wantText) {
    const want = key(wantText);
    const label = await waitFor(() => findLabel(labelMatch), 25000);
    if (!label) throw new Error(`Không thấy ô "${fieldName}" trên trang chi tiết (trang chưa tải xong hoặc nhãn khác tên)`);
    const getControl = () => {
      const l = findLabel(labelMatch);
      return l ? findControl(l) : null;
    };
    const control = await waitFor(getControl, 4000);
    if (!control) throw new Error(`Thấy nhãn "${fieldName}" nhưng không tìm được hộp chọn bên dưới`);
    if (valueOf(control) === want) return 'đã đúng sẵn';

    const before = new Set(optionCandidates(want, control));
    const beforeVisible = new Set(allElements().filter(visible));
    const findOption = () => {
      const now = optionCandidates(want, control);
      return now.find((e) => !before.has(e)) || now[0] || null;
    };
    // Danh sách lựa chọn có thể được tải sau khi trang mở (dropdown hiện "No data" lúc đầu): chờ, nếu vẫn rỗng
    // thì đóng lại, đợi rồi mở lại. Xen kẽ các cách mở khác nhau phòng khi dropdown cần kiểu bấm khác.
    const inner = control.querySelector('input, button, [role="combobox"], [tabindex]');
    const clickOpen = () => realClick(control);
    const plainOpen = () => control.click();
    const focusOpen = () => { (inner || control).focus(); (inner || control).click(); };
    const keyOpen = () => { const t = inner || control; t.focus(); pressKey(t, ' '); pressKey(t, 'Enter'); pressKey(t, 'ArrowDown'); };
    const attempts = [
      [clickOpen, 6000], [clickOpen, 5000], [plainOpen, 2500], [focusOpen, 2500], [keyOpen, 2500], [clickOpen, 8000], [clickOpen, 8000],
    ];
    const closeDropdown = async () => {
      const t = document.activeElement || document.body;
      pressKey(t, 'Escape');
      if (t.blur) t.blur();
      await sleep(400);
    };
    let option = null;
    let sawNoData = false;
    let appeared = []; // những gì từng hiện ra sau khi mở (lưu lại vì dropdown sẽ bị đóng giữa các lần thử)
    for (let i = 0; i < attempts.length && !option; i++) {
      const [open, patience] = attempts[i];
      if (i > 0) { await closeDropdown(); await sleep(1500); }
      open();
      option = await waitFor(findOption, patience);
      const seen = newlyVisibleTexts(beforeVisible);
      if (seen.length) appeared = seen;
      if (!option && /no data|không có dữ liệu|trống/.test(key(document.body.innerText).replace(/\s+/g, ' '))) sawNoData = true;
    }
    if (!option) {
      throw new Error(`Không thấy lựa chọn "${wantText}" của ô "${fieldName}" (ô đang hiện "${(control.innerText || '').trim().replace(/\s+/g, ' ')}"). `
        + (appeared.length
          ? `Sau khi bấm, trang hiện thêm: ${appeared.join(' | ')}${sawNoData ? ' — danh sách rỗng, có thể chưa tải xong hoặc ticket này không có lựa chọn đó' : ''}`
          : 'Sau khi bấm, trang không hiện thêm gì (dropdown không mở; thử bật "Mở tab chi tiết ở phía trước" ở Cài đặt → Nâng cao)'));
    }
    realClick(option);
    const applied = await waitFor(() => { const c = getControl(); return c && valueOf(c) === want; }, 4000);
    if (!applied) {
      const c = getControl();
      throw new Error(`Đã bấm "${wantText}" nhưng ô "${fieldName}" đang hiện "${c ? (c.innerText || '').trim().replace(/\s+/g, ' ') : '?'}"`);
    }
    return 'đã chọn';
  }

  /* ---------- Bấm Cập nhật và chờ kết quả ---------- */

  function watchWrites() {
    const writes = [];
    const onMessage = (ev) => {
      const d = ev.data;
      if (ev.source === win && d && d.channel === CH && d.dir === 'to-content' && d.type === 'write') writes.push(d);
    };
    win.addEventListener('message', onMessage);
    return { writes, stop: () => win.removeEventListener('message', onMessage) };
  }

  const CONFIRM_TEXTS = ['xác nhận', 'đồng ý', 'ok', 'có'];

  function clickConfirmDialog() {
    const dialogs = document.querySelectorAll('[role="dialog"], [class*="modal" i]');
    for (const d of dialogs) {
      if (!visible(d)) continue;
      const btn = Array.from(d.querySelectorAll('button, [role="button"]')).find((b) => visible(b) && CONFIRM_TEXTS.includes(key(b.innerText)));
      if (btn) { realClick(btn); return true; }
    }
    return false;
  }

  async function save(watcher, evaluate) {
    const findButton = () => Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter((b) => visible(b) && key(b.innerText) === 'cập nhật').pop() || null;
    const button = await waitFor(findButton, 8000);
    if (!button) throw new Error('Không thấy nút "Cập nhật" trên trang chi tiết');
    const disabled = (b) => b.disabled || b.getAttribute('aria-disabled') === 'true';
    if (disabled(button) && !(await waitFor(() => !disabled(findButton() || button), 3000))) {
      throw new Error('Nút "Cập nhật" đang bị khóa sau khi chọn (có thể thiếu trường bắt buộc)');
    }
    realClick(findButton() || button);

    let confirmed = false;
    const first = await waitFor(() => {
      if (!confirmed) confirmed = clickConfirmDialog();
      return watcher.writes.length > 0;
    }, 20000, 250);
    if (!first) {
      const msgs = visibleMessages();
      throw new Error(`Bấm "Cập nhật" nhưng không thấy trang gửi yêu cầu lưu${msgs.length ? `. Trang đang hiện: ${msgs.join(' | ')}` : ''}`);
    }
    await sleep(800); // chờ các request lưu đi kèm
    for (const w of watcher.writes) {
      const r = evaluate({ status: w.status, text: w.text });
      if (!r.ok) throw new Error(`Lưu thất bại: ${r.note}`);
    }
    return `HTTP ${watcher.writes[0].status}`;
  }

  /* ---------- Chạy cho một ticket ---------- */

  // job: {loai, lyDo}. opts.evaluate(res) -> {ok, note}
  async function runJob(job, opts = {}) {
    const evaluate = opts.evaluate || ((res) => ({ ok: res.status >= 200 && res.status < 300, note: `HTTP ${res.status} ${String(res.text || '').slice(0, 160)}` }));
    const watcher = watchWrites();
    try {
      const parts = [];
      const loai = await chooseOption('Loại', (t) => t === 'loại', job.loai);
      parts.push(`Loại ${loai}`);
      let changed = loai === 'đã chọn';
      if (job.lyDo) {
        const lyDo = await chooseOption('Lý do', (t) => t.startsWith('lý do'), job.lyDo);
        parts.push(`Lý do ${lyDo}`);
        changed = changed || lyDo === 'đã chọn';
      }
      if (!changed) return { ok: true, note: `${parts.join(', ')}; không cần cập nhật` };
      const saved = await save(watcher, evaluate);
      return { ok: true, note: `${parts.join(', ')}; cập nhật OK (${saved})` };
    } catch (e) {
      return { ok: false, note: e && e.message ? e.message : String(e) };
    } finally {
      watcher.stop();
    }
  }

  return { runJob, norm };
});
