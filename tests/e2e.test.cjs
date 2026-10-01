/* E2E: nạp extension thật vào Chromium, dùng trang + API giả lập có bảng ticket giống hệ thống thật.
 * Chạy: NODE_PATH=$(npm root -g) node tests/e2e.test.cjs   (cần playwright + chromium) */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const EXT_SRC = path.join(__dirname, '..', 'extension');
const TOKEN = 'tok-123';

/* ---------- Trang + API giả lập ---------- */

const received = []; // request đổi loại server nhận được
let failCodes = new Set();
const updates = []; // request tới /cs-ticket/update (mô phỏng API thật: body {id, custom_fields})
let summaryOverride = null; // mô phỏng trang báo 'Đã chọn N' khác số dòng đọc được

const ROWS = ['691000001', '691000002', '691000003', '691000004', '691000005'];
const checkedRows = new Set(['691000001', '691000002', '691000003']);

function page(variant) {
  const checkbox = (code) => {
    const on = checkedRows.has(code);
    return variant === 'aria'
      ? `<div role="checkbox" aria-checked="${on}" class="cb ${on ? 'cb-checked' : ''}"></div>`
      : `<input type="checkbox" ${on ? 'checked' : ''}>`;
  };
  const headBox = variant === 'aria' ? '<div role="checkbox" aria-checked="true" class="cb cb-checked"></div>' : '<input type="checkbox" checked>';
  return `<!doctype html><meta charset="utf-8"><title>Mock</title>
  <style>body{font:13px sans-serif} .bar{position:fixed;left:0;right:0;bottom:0;height:60px;background:#fff;border-top:1px solid #ccc;padding:20px}</style>
  <table>
    <thead><tr><th>${headBox}</th><th>#</th><th>Mã đơn hàng</th><th>Loại</th></tr></thead>
    <tbody>${ROWS.map((c, i) => `<tr><td>${checkbox(c)}</td>
      <td><a href="#">${c}</a><div>14:11 26/09/2026</div></td><td>GYR73QV${i}</td><td>Khiếu nại</td></tr>`).join('')}</tbody>
  </table>
  <div class="bar">Đã chọn <b>${summaryOverride ?? checkedRows.size}</b>/<b>${summaryOverride ?? ROWS.length}</b> phiếu <button id="update">Cập nhật</button></div>
  <button id="sim-fetch">sim fetch</button> <button id="sim-xhr">sim xhr</button>
  <script>
    // Trang tự gửi request kèm Token như app thật (extension học token từ đây).
    fetch('${apiOrigin}/api/list', { headers: { Token: '${TOKEN}', 'X-Shop': '7', 'X-Extra': '1' } });
    document.getElementById('sim-fetch').onclick = () => fetch('/api/tickets/691000001/type', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Token: '${TOKEN}' },
      body: JSON.stringify({ ticket: '691000001', type: 'complaint', note: 'tay' }) });
    document.getElementById('sim-xhr').onclick = () => {
      const x = new XMLHttpRequest(); x.open('PUT', '/api/tickets/691000002/type');
      x.setRequestHeader('Content-Type', 'application/json'); x.setRequestHeader('Token', '${TOKEN}');
      x.send(JSON.stringify({ ticket: '691000002', type: 'complaint' })); };
  </script>`;
}

let apiOrigin = '';
const noReasonGroup = new Set([4900003]); // nhóm phiếu không có trường lý do (như nhóm "Vùng 3")
const ticketType = new Map(); // id -> loại hiện tại (mô phỏng luật của hệ thống thật)
let rejectExtraHeader = false; // true: preflight của /cs-ticket/update từ chối header X-Extra mà trang vẫn hay gửi

// API khác origin với trang (như cm-gateway.ghn.vn): CORS ACAO "*" (không cho cookie) và preflight chỉ cho vài header.
const apiServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const cors = { 'access-control-allow-origin': '*' };
    if (req.method === 'OPTIONS') {
      const allow = req.url === '/api/list' || !rejectExtraHeader ? req.headers['access-control-request-headers'] : 'content-type, token, x-shop';
      const requested = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map((h) => h.trim()).filter(Boolean);
      const allowed = String(allow).toLowerCase().split(',').map((h) => h.trim());
      const ok = requested.every((h) => allowed.includes(h));
      res.writeHead(ok ? 204 : 403, { ...cors, 'access-control-allow-headers': allow, 'access-control-allow-methods': 'GET, POST', 'access-control-max-age': '0' }).end();
      return;
    }
    if (req.url === '/api/list') {
      // Danh sách có id nội bộ; cố ý thiếu ticket cuối để thử trường hợp không tìm thấy id.
      const data = ROWS.slice(0, 4).map((c, i) => ({ id: 4900001 + i, ticket_code: c, order_code: `GYR${i}`, assignee: { id: 77, name: 'x' } }));
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ data }));
      return;
    }
    if (req.url === '/cs-ticket/update') {
      updates.push({ headers: req.headers, body });
      if (req.headers.token !== TOKEN) { res.writeHead(401, cors).end('{"error":"unauthorized"}'); return; }
      // Luật thật: lý do Hồi giao/lấy/trả chỉ sửa được khi ticket ĐÃ thuộc loại đó (kiểm tra trên trạng thái trước request).
      const { id, custom_fields: cf = {} } = JSON.parse(body);
      const current = ticketType.get(id) || 'Khiếu nại';
      if ('ly_do_hoi_giao_lay_tra' in cf && (current !== 'Hồi Giao/Lấy/Trả hàng' || noReasonGroup.has(id))) {
        res.writeHead(400, { ...cors, 'content-type': 'application/json' }).end('{"code":400,"message":"field không được phép sửa theo cấu hình nhóm phiếu: ly_do_hoi_giao_lay_tra"}');
        return;
      }
      if (cf.type) ticketType.set(id, cf.type);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end('{"success":true}');
      return;
    }
    res.writeHead(404, cors).end();
  });
});

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const m = /^\/api\/tickets\/(\d+)\/type$/.exec(req.url);
    if (m) {
      const record = { method: req.method, code: m[1], token: req.headers.token, body };
      received.push(record);
      if (req.headers.token !== TOKEN) { res.writeHead(401).end('{"error":"unauthorized"}'); return; }
      if (failCodes.has(m[1])) { res.writeHead(400).end('{"error":"ticket đã đóng"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"success":true}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(req.url.startsWith('/aria') ? 'aria' : 'input'));
  });
});

/* ---------- Dựng bản extension dùng cho test ---------- */

function prepareExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-ext-'));
  fs.cpSync(EXT_SRC, dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  // Bản test cấp sẵn quyền host (thật ra người dùng cấp qua popup); luồng đăng ký script vẫn là code thật.
  manifest.host_permissions = ['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

/* ---------- Test ---------- */

let passed = 0;
const step = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await new Promise((r) => apiServer.listen(0, '127.0.0.1', r));
  apiOrigin = `http://127.0.0.1:${apiServer.address().port}`;
  const origin = `http://127.0.0.1:${server.address().port}`;
  const extDir = prepareExtension();
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-prof-')), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    await step('background đăng ký hook + UI cho origin', async () => {
      await sw.evaluate((o) => registerFor(o), origin);
      const ids = await sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
      const port = new URL(origin).port;
      assert.deepEqual(ids.filter((id) => id.endsWith(`_${port}`)).sort(), [`tt-bulk-hook-http___127_0_0_1_${port}`, `tt-bulk-ui-http___127_0_0_1_${port}`]);
    });

    const p = await ctx.newPage();
    p.on('dialog', (d) => d.accept());
    if (process.env.DEBUG) {
      p.on('console', (m) => console.log('  [page]', m.text()));
      p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
    }
    const $ = (sel) => p.locator(sel);
    await p.goto(`${origin}/`);
    await $('.launcher').waitFor();

    await step('nút nổi hiện góc phải dưới và đếm đúng 3 ticket đã tick (bỏ qua ô chọn tất cả)', async () => {
      const box = await $('.launcher').boundingBox();
      const vp = p.viewportSize();
      assert.ok(box.x + box.width > vp.width * 0.7 && box.y > vp.height * 0.6, 'launcher phải ở góc phải dưới');
      await $('.launcher').click();
      await $('text=Đã tick: 3 ticket').waitFor();
      assert.equal(await $('.badge').innerText(), '3');
      assert.equal(await $('.warn:not([hidden])').filter({ hasText: 'Trang báo' }).count(), 0);
    });

    await step('chưa cài đặt thì nút chạy bị khóa và báo thiếu gì', async () => {
      await $('text=Chưa có danh sách loại và mẫu request').waitFor();
      assert.equal(await $('button.primary:has-text("Đổi loại")').first().isDisabled(), true);
    });

    await step('lưu danh sách loại; dòng sai bị báo lỗi', async () => {
      await $('.tab:has-text("Cài đặt")').click();
      await $('textarea').first().fill('thiếu giá trị');
      await $('button:has-text("Lưu danh sách loại")').click();
      await $('text=cần dạng').waitFor();
      await $('textarea').first().fill('Khiếu nại | complaint\nHồi giao/lấy/trả hàng | return');
      await $('button:has-text("Lưu danh sách loại")').click();
      await $('text=Đã lưu 2 loại.').waitFor();
    });

    await step('ghi lại request fetch, tự đoán mã ticket, tạo mẫu', async () => {
      await $('button:has-text("Bắt đầu ghi")').click();
      await p.waitForTimeout(200);
      await p.evaluate(() => document.getElementById('sim-fetch').click());
      await $('.cap:has-text("POST")').waitFor();
      await $('.cap:has-text("POST")').click();
      assert.equal(await $('input[placeholder^="Ví dụ 6910"]').inputValue(), '691000001');
      await $('input[placeholder^="Ví dụ complaint"]').fill('complaint');
      await $('button:has-text("Tạo mẫu từ request này")').click();
      await $('text=Thay được mã ticket 2 chỗ, giá trị loại 1 chỗ').waitFor();
      const body = await $('textarea >> nth=2').inputValue();
      assert.match(body, /"ticket":"\{\{ticket\}\}"/);
      assert.match(body, /"type":"\{\{type\}\}"/);
      const headers = await $('textarea >> nth=1').inputValue();
      assert.ok(!headers.includes(TOKEN), 'không được lưu giá trị token');
      assert.match(await p.locator('text=Header lấy tự động').innerText(), /Token/);
      await $('button:has-text("Lưu mẫu")').click();
      await $('text=Đã lưu: POST').waitFor();
    });

    await step('request XHR cũng được ghi lại', async () => {
      await $('button:has-text("Bắt đầu ghi")').click();
      await p.waitForTimeout(200); // postMessage "bật ghi" cần thời gian tới hook; người dùng thật thao tác chậm hơn nhiều
      await p.evaluate(() => document.getElementById('sim-xhr').click());
      await $('.cap:has-text("PUT")').waitFor();
      await $('button:has-text("Dừng ghi")').click();
    });

    await step('chạy hàng loạt: 3 ticket đều nhận đúng loại và token lấy từ trang', async () => {
      received.length = 0;
      await $('.tab:has-text("Đổi loại")').click();
      await $('select').first().selectOption({ label: 'Hồi giao/lấy/trả hàng' });
      await $('button:has-text("Đổi 3 ticket sang")').click();
      await $('text=Xong, hãy tải lại danh sách').waitFor();
      assert.deepEqual(received.map((r) => r.code).sort(), ['691000001', '691000002', '691000003']);
      for (const r of received) {
        assert.equal(r.method, 'POST');
        assert.equal(r.token, TOKEN);
        assert.deepEqual(JSON.parse(r.body), { ticket: r.code, type: 'return', note: 'tay' });
      }
      await $('text=Thành công 3/3, lỗi 0').waitFor();
    });

    await step('ticket đầu lỗi thì dừng, không đụng các ticket còn lại', async () => {
      received.length = 0;
      failCodes = new Set(['691000001']);
      await $('button:has-text("Đổi 3 ticket sang")').click();
      await $('text=Ticket đầu tiên bị lỗi nên đã dừng').waitFor();
      assert.equal(received.length, 1);
      await $('text=HTTP 400').waitFor();
    });

    if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT });
    await step('lỗi giữa chừng: chạy tiếp, báo đúng ticket lỗi và cho sao chép', async () => {
      received.length = 0;
      failCodes = new Set(['691000002']);
      await $('button:has-text("Đổi 3 ticket sang")').click();
      await $('text=Xong, hãy tải lại danh sách').waitFor();
      assert.equal(received.length, 3);
      await $('text=Thành công 2/3, lỗi 1').waitFor();
      await $('button:has-text("Sao chép mã ticket lỗi")').waitFor();
      failCodes = new Set();
    });

    await step('mẫu và danh sách loại còn nguyên sau khi tải lại trang', async () => {
      await p.reload();
      await $('.launcher').click();
      await $('.tab:has-text("Cài đặt")').click();
      await $('text=Đã lưu: POST').waitFor();
      assert.match(await $('textarea').first().inputValue(), /Khiếu nại \| complaint/);
    });

    await step('điền sẵn cấu hình: có 3 loại, dùng {{id}} + lý do, header token tự lấy từ trang', async () => {
      await $('button:has-text("Điền sẵn cấu hình")').click();
      await $('text=Đã điền sẵn.').waitFor();
      assert.match(await $('textarea').first().inputValue(), /Hồi lấy \| Hồi Giao\/Lấy\/Trả hàng \| Hồi lấy/);
      await $('button:has-text("Sửa mẫu hiện tại")').click();
      assert.match(await $('label:has-text("URL") input').inputValue(), /cm-gateway\.ghn\.vn.*cs-ticket\/update$/);
      await $('label:has-text("URL") input').fill(`${apiOrigin}/cs-ticket/update`); // API khác origin, CORS chặt như thật
      await $('button:has-text("Lưu mẫu")').click();
      await $('.tab:has-text("Đổi loại")').click();
      updates.length = 0;
      ticketType.clear();
      await $('select').first().selectOption({ label: 'Hồi lấy' });
      await $('button:has-text("Đổi 3 ticket sang")').click();
      await $('text=Xong, hãy tải lại danh sách').waitFor();
      // Mỗi ticket 2 request: bước 1 đổi loại, bước 2 đặt lý do (gửi cả hai cùng lúc sẽ bị server từ chối với ticket Khiếu nại).
      assert.equal(updates.length, 6);
      for (const id of [4900001, 4900002, 4900003]) {
        const mine = updates.map((u) => JSON.parse(u.body)).filter((b) => b.id === id);
        assert.deepEqual(mine, [
          { id, custom_fields: { type: 'Hồi Giao/Lấy/Trả hàng' } },
          { id, custom_fields: { type: 'Hồi Giao/Lấy/Trả hàng', ly_do_hoi_giao_lay_tra: 'Hồi lấy' } },
        ]);
      }
      await $('text=2 bước OK').first().waitFor();
      // Ticket 3 thuộc nhóm không có trường lý do: loại đã đổi, bước 2 bị từ chối nhưng vẫn tính là xong và có ghi chú.
      await $('text=691000003 — đã đổi loại; bỏ qua lý do').waitFor();
      await $('text=Thành công 3/3, lỗi 0').waitFor();
      for (const u of updates) assert.equal(u.headers['content-type'], 'application/json');
      // API chỉ gửi ACAO "*" (không cho cookie): vẫn thành công và mang đủ header trang đang dùng.
      for (const u of updates) { assert.equal(u.headers['x-shop'], '7'); assert.equal(u.headers['x-extra'], '1'); }
    });

    await step('một header của trang bị preflight từ chối thì tự gửi lại chỉ với token + header mẫu', async () => {
      rejectExtraHeader = true;
      updates.length = 0;
      ticketType.clear();
      await $('select').first().selectOption({ label: 'Hồi trả' });
      await $('button:has-text("Đổi 3 ticket sang")').click();
      const t0 = Date.now();
      while (updates.length < 6) { // không dựa vào chữ tổng kết vì lần chạy trước vẫn còn hiển thị
        assert.ok(Date.now() - t0 < 15000, 'hết thời gian chờ server nhận request');
        await new Promise((r) => setTimeout(r, 50));
      }
      await $('button:has-text("Đổi 3 ticket sang")').waitFor();
      for (const u of updates) { assert.equal(u.headers.token, TOKEN); assert.equal(u.headers['x-extra'], undefined); }
      rejectExtraHeader = false;
    });

    await step('ticket không có id trong dữ liệu trang thì báo lỗi riêng, không gửi', async () => {
      checkedRows.add('691000005');
      await p.reload();
      await $('.launcher').click();
      await $('text=Đã tick: 4 ticket').waitFor();
      updates.length = 0;
      ticketType.clear();
      await $('select').first().selectOption({ label: 'Hồi trả' });
      await $('button:has-text("Đổi 4 ticket sang")').click();
      await $('text=Xong, hãy tải lại danh sách').waitFor();
      await $('text=Thành công 3/4, lỗi 1').waitFor();
      await $('text=691000005 — Không tìm thấy id nội bộ').waitFor();
      assert.equal(updates.length, 6);
      checkedRows.delete('691000005');
    });

    await step('chọn ô theo role=checkbox/aria-checked + class "-checked" cũng đọc được', async () => {
      const p2 = await ctx.newPage();
      await p2.goto(`${origin}/aria`);
      await p2.locator('.launcher').click();
      await p2.locator('text=Đã tick: 3 ticket').waitFor();
      await p2.close();
    });

    await step('trang báo nhiều phiếu hơn số đọc được thì cảnh báo', async () => {
      summaryOverride = 100;
      const p3 = await ctx.newPage();
      await p3.goto(`${origin}/`);
      await p3.locator('.launcher').click();
      await p3.locator('text=Trang báo đã chọn 100 phiếu nhưng chỉ đọc được 3').waitFor();
      summaryOverride = null;
      await p3.close();
    });

    await step('gỡ đăng ký khi tắt', async () => {
      await sw.evaluate((o) => unregisterFor(o), origin);
      const port = new URL(origin).port;
      const ids = await sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
      assert.equal(ids.filter((id) => id.endsWith(`_${port}`)).length, 0);
    });

    console.log(`\nE2E: ${passed} bước đạt`);
  } catch (e) {
    console.error(`\nE2E THẤT BẠI sau ${passed} bước:\n`, e);
    for (const pg of ctx.pages()) {
      const text = await pg.locator('.panel').innerText().catch(() => '(không có panel)');
      console.error(`--- panel ${pg.url()} ---\n${text}`);
    }
    process.exitCode = 1;
  } finally {
    await ctx.close();
    server.close();
    apiServer.close();
  }
})();
