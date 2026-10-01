/* Test bộ tự bấm (extension/ui-auto.js) trên các kiểu dropdown khác nhau, không cần nạp extension.
 * Chạy: NODE_PATH=$(npm root -g) node tests/ui-auto.test.cjs */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

const OPTIONS = ['Hồi Giao/Lấy/Trả hàng', 'Khiếu nại', 'Tư vấn'];

// variant: click (mở bằng chuột) | keyboard (chỉ mở bằng phím Enter) | split (chữ tách qua nhiều thẻ) | never (không mở) | other (mở nhưng thiếu lựa chọn)
const html = (variant) => `<!doctype html><meta charset="utf-8">
<style>body{font:13px sans-serif;margin:20px} .lbl{color:#666;margin-bottom:4px} .sel{border:1px solid #ccc;padding:8px 10px;width:260px;height:36px;box-sizing:border-box;display:flex;justify-content:space-between}
.pop{position:absolute;background:#fff;border:1px solid #ccc;width:258px} .opt{padding:8px}</style>
<div class="lbl">Loại *</div>
<div class="sel" id="loai" tabindex="0"><span>Khiếu nại</span><i>⌄</i></div>
<button id="save">Cập nhật</button>
<script>
  const variant = '${variant}';
  const options = variant === 'other' ? ['Tư vấn', 'Giao hàng'] : ${JSON.stringify(OPTIONS)};
  const sel = document.getElementById('loai');
  function open() {
    if (variant === 'never' || document.querySelector('.pop')) return;
    const r = sel.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.className = 'pop'; pop.style.left = r.left + 'px'; pop.style.top = r.bottom + 'px';
    pop.innerHTML = options.map((o) => '<div class="opt">' + (variant === 'split' ? '<span>' + o.slice(0, 5) + '</span><span>' + o.slice(5) + '</span>' : o) + '</div>').join('');
    pop.onclick = (e) => { const o = e.target.closest('.opt'); if (o) { sel.querySelector('span').textContent = o.textContent; pop.remove(); } };
    document.body.append(pop);
  }
  if (variant === 'keyboard') sel.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  else sel.addEventListener('click', open);
  document.getElementById('save').onclick = () => window.postMessage({ channel: 'tt-bulk', dir: 'to-content', type: 'write', status: 200, text: 'ok' }, '*');
</script>`;

(async () => {
  const browser = await chromium.launch();
  let failed = false;
  const check = async (name, variant, assertion) => {
    const page = await browser.newPage();
    try {
      await page.setContent(html(variant));
      await page.addScriptTag({ path: path.join(__dirname, '..', 'extension', 'ui-auto.js') });
      const result = await page.evaluate(() => window.TTAuto.runJob({ loai: 'Hồi Giao/Lấy/Trả hàng' }));
      assertion(result);
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed = true;
      console.error(`  ✗ ${name}\n`, e.message);
    } finally {
      await page.close();
    }
  };

  await check('dropdown mở bằng chuột, nhãn có dấu * và mũi tên trong ô', 'click', (r) => {
    assert.equal(r.ok, true, r.note);
    assert.match(r.note, /Loại đã chọn; cập nhật OK/);
  });
  await check('dropdown chỉ mở bằng bàn phím thì vẫn chọn được', 'keyboard', (r) => assert.equal(r.ok, true, r.note));
  await check('chữ lựa chọn bị tách qua nhiều thẻ con vẫn chọn được', 'split', (r) => assert.equal(r.ok, true, r.note));
  await check('dropdown không mở: báo rõ là trang không hiện thêm gì', 'never', (r) => {
    assert.equal(r.ok, false);
    assert.match(r.note, /trang không hiện thêm gì/);
  });
  await check('dropdown mở nhưng thiếu lựa chọn: liệt kê những gì vừa hiện', 'other', (r) => {
    assert.equal(r.ok, false);
    assert.match(r.note, /Không thấy lựa chọn "Hồi Giao\/Lấy\/Trả hàng".*Tư vấn \| Giao hàng/);
  });

  await browser.close();
  if (failed) process.exit(1);
  console.log('\nui-auto: tất cả đạt');
})();
