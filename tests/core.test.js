const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../extension/core.js');

test('splitHeaders giữ header thường, tách header nhạy cảm, bỏ header trình duyệt tự đặt', () => {
  const { headers, dynamic } = C.splitHeaders({
    'Content-Type': 'application/json',
    Token: 'secret',
    Authorization: 'Bearer x',
    'X-XSRF-TOKEN': 'abc',
    Cookie: 'a=b',
    'User-Agent': 'x',
    'sec-fetch-mode': 'cors',
    'X-Shop-Id': '12',
  });
  assert.deepEqual(headers, { 'Content-Type': 'application/json', 'X-Shop-Id': '12' });
  assert.deepEqual(dynamic.sort(), ['Authorization', 'Token', 'X-XSRF-TOKEN']);
});

test('buildTemplate thay mã ticket và giá trị loại trong URL + body JSON', () => {
  const { template, counts } = C.buildTemplate({
    method: 'POST',
    url: 'https://api.test/v1/tickets/691002569352/type',
    headers: { 'content-type': 'application/json', Token: 't' },
    body: '{"ticket":"691002569352","type":"complaint","note":"x"}',
  }, { ticket: '691002569352', type: 'complaint' });
  assert.equal(template.url, 'https://api.test/v1/tickets/{{ticket}}/type');
  assert.equal(template.body, '{"ticket":"{{ticket}}","type":"{{type}}","note":"x"}');
  assert.deepEqual(counts, { ticket: 2, type: 1 });
  assert.deepEqual(template.dynamicHeaders, ['Token']);
  assert.equal(template.headers.Token, undefined);
});

test('buildTemplate để trống loại thì không thay gì cho {{type}}', () => {
  const { template, counts } = C.buildTemplate(
    { method: 'PUT', url: 'https://a/b/1', headers: {}, body: null },
    { ticket: '1', type: '' });
  assert.equal(template.url, 'https://a/b/{{ticket}}');
  assert.equal(template.body, null);
  assert.equal(counts.type, 0);
});

test('renderTemplate escape theo ngữ cảnh: URL, JSON, form', () => {
  const vars = { ticket: '691', type: 'Hồi "giao"/lấy' };
  const json = C.renderTemplate({
    method: 'POST', url: 'https://a/{{ticket}}?t={{type}}',
    headers: { 'Content-Type': 'application/json' }, body: '{"type":"{{type}}"}',
  }, vars);
  assert.equal(json.url, 'https://a/691?t=H%E1%BB%93i%20%22giao%22%2Fl%E1%BA%A5y');
  assert.deepEqual(JSON.parse(json.body), { type: 'Hồi "giao"/lấy' });

  const form = C.renderTemplate({
    method: 'POST', url: 'https://a', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'id={{ticket}}&type={{type}}',
  }, vars);
  assert.equal(form.body, 'id=691&type=H%E1%BB%93i%20%22giao%22%2Fl%E1%BA%A5y');
});

test('renderTemplate báo lỗi khi thiếu biến', () => {
  assert.throws(() => C.renderTemplate({ method: 'POST', url: 'https://a/{{type}}', headers: {}, body: null }, { ticket: '1' }), /\{\{type\}\}/);
});

test('loại là số thì render ra số trần trong JSON', () => {
  const { template } = C.buildTemplate(
    { method: 'POST', url: 'https://a', headers: { 'content-type': 'application/json' }, body: '{"id":"777","type":5}' },
    { ticket: '777', type: '5' });
  assert.equal(template.body, '{"id":"{{ticket}}","type":{{type}}}');
  assert.deepEqual(JSON.parse(C.renderTemplate(template, { ticket: '888', type: '7' }).body), { id: '888', type: 7 });
});

test('placeholdersIn', () => {
  assert.deepEqual([...C.placeholdersIn({ url: 'x/{{ticket}}', body: '{{ type }}' })].sort(), ['ticket', 'type']);
  assert.equal(C.placeholdersIn({ url: 'x', body: null }).size, 0);
});

test('parseTypes', () => {
  const ok = C.parseTypes('Khiếu nại | complaint\n\n# ghi chú\nHồi giao | Hồi Giao/Lấy/Trả hàng | Hồi giao');
  assert.deepEqual(ok.types, [{ label: 'Khiếu nại', value: 'complaint' }, { label: 'Hồi giao', value: 'Hồi Giao/Lấy/Trả hàng', reason: 'Hồi giao' }]);
  assert.equal(ok.errors.length, 0);
  const bad = C.parseTypes('thiếu giá trị\nA |');
  assert.equal(bad.errors.length, 2);
  assert.equal(C.stringifyTypes(ok.types), 'Khiếu nại | complaint\nHồi giao | Hồi Giao/Lấy/Trả hàng | Hồi giao');
});

test('parseSelectedSummary', () => {
  assert.deepEqual(C.parseSelectedSummary('x Đã chọn 100/100 phiếu'), { selected: 100, total: 100 });
  assert.deepEqual(C.parseSelectedSummary('Đã chọn\n3 / 50'), { selected: 3, total: 50 });
  assert.equal(C.parseSelectedSummary('không có'), null);
});

test('evaluateResult', () => {
  assert.equal(C.evaluateResult({ status: 200, text: '{"ok":true}' }).ok, true);
  assert.equal(C.evaluateResult({ status: 500, text: 'boom' }).ok, false);
  assert.equal(C.evaluateResult({ status: 200, text: '{"success":false}' }, '"success"\\s*:\\s*false').ok, false);
  assert.equal(C.evaluateResult({ status: 200, text: 'ok' }, '(').ok, true); // regex sai -> bỏ qua
  assert.equal(C.evaluateResult({ status: 0, error: 'mất mạng' }).ok, false);
});

test('presetGhn render ra body đúng như request thật (id số, loại + lý do là chữ)', () => {
  const { types, template } = C.presetGhn();
  assert.deepEqual(types.map((x) => x.label), ['Hồi giao', 'Hồi lấy', 'Hồi trả']);
  const [step1, step2] = C.renderSteps(template, { id: 4914047, type: types[1].value, reason: types[1].reason });
  assert.equal(step1.url, 'https://cm-gateway.ghn.vn/ticket-connector/public-api/web/cs-ticket/update');
  assert.equal(step2.url, step1.url);
  assert.deepEqual(JSON.parse(step1.body), { id: 4914047, custom_fields: { type: 'Hồi Giao/Lấy/Trả hàng' } });
  assert.deepEqual(JSON.parse(step2.body), { id: 4914047, custom_fields: { type: 'Hồi Giao/Lấy/Trả hàng', ly_do_hoi_giao_lay_tra: 'Hồi lấy' } });
  assert.deepEqual([...C.placeholdersIn(template)].sort(), ['id', 'type']);
  // loại không có lý do thì chỉ còn bước 1
  assert.equal(C.renderSteps(template, { id: 1, type: 'x' }).length, 1);
});
