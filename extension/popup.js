const $ = (id) => document.getElementById(id);

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url;
  try { url = new URL(tab.url); } catch (e) { url = null; }
  if (!url || !/^https?:$/.test(url.protocol)) {
    $('host').textContent = 'Trang này không hỗ trợ';
    $('msg').textContent = 'Hãy mở trang danh sách ticket rồi bấm lại biểu tượng extension.';
    return;
  }
  const pattern = `${url.origin}/*`;
  $('host').textContent = url.origin;

  const enabled = await chrome.permissions.contains({ origins: [pattern] });
  const btn = $('toggle');
  btn.disabled = false;
  if (enabled) {
    $('msg').textContent = 'Đang bật. Nút "Đổi loại" nằm ở góc phải dưới của trang.';
    btn.textContent = 'Tắt trên trang này';
    btn.className = 'off';
    btn.onclick = async () => { await chrome.permissions.remove({ origins: [pattern] }); window.close(); };
  } else {
    $('msg').textContent = 'Extension chưa được phép chạy trên trang này. Bật để thêm nút "Đổi loại hàng loạt" (trang sẽ tự tải lại).';
    btn.textContent = 'Bật trên trang này';
    btn.onclick = async () => { await chrome.permissions.request({ origins: [pattern] }); window.close(); };
  }
})();
