/* Extension chỉ chạy trên trang bạn bật (popup -> "Bật trên trang này").
 * Khi quyền truy cập một trang được cấp, đăng ký hook + giao diện cho trang đó; khi bị thu hồi thì gỡ. */
const SCRIPT_PREFIX = 'tt-bulk-';

const originOf = (pattern) => pattern.replace(/\/\*$/, '');
const scriptId = (origin, kind) => `${SCRIPT_PREFIX}${kind}-${origin.replace(/[^a-z0-9]/gi, '_')}`;

async function unregisterFor(origin) {
  const ids = [scriptId(origin, 'hook'), scriptId(origin, 'ui')];
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
}

async function registerFor(origin) {
  await unregisterFor(origin);
  const matches = [`${origin}/*`];
  await chrome.scripting.registerContentScripts([
    { id: scriptId(origin, 'hook'), matches, js: ['hook.js'], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true },
    { id: scriptId(origin, 'ui'), matches, js: ['core.js', 'ui-auto.js', 'content.js'], runAt: 'document_idle', persistAcrossSessions: true },
  ]);
}

async function reloadTabs(origin) {
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  tabs.forEach((t) => chrome.tabs.reload(t.id));
}

chrome.permissions.onAdded.addListener(async ({ origins = [] }) => {
  for (const o of origins.map(originOf)) {
    await registerFor(o);
    await reloadTabs(o);
  }
});

chrome.permissions.onRemoved.addListener(async ({ origins = [] }) => {
  for (const o of origins.map(originOf)) await unregisterFor(o);
});

// Sau khi cài/cập nhật: đăng ký lại cho mọi trang đã được cấp quyền.
chrome.runtime.onInstalled.addListener(async () => {
  const { origins = [] } = await chrome.permissions.getAll();
  for (const o of origins.map(originOf)) {
    if (/^https?:\/\/[^*]+$/.test(o)) await registerFor(o);
  }
});

/* ---------- Chế độ tự bấm giao diện: mỗi ticket mở một tab chi tiết, tab đó tự thao tác rồi báo kết quả ---------- */

const uiJobs = new Map(); // tabId -> {job, resolve, timer}

function finishJob(tabId, result) {
  const entry = uiJobs.get(tabId);
  if (!entry) return;
  uiJobs.delete(tabId);
  clearTimeout(entry.timer);
  chrome.tabs.remove(tabId).catch(() => {});
  entry.resolve(result);
}

async function openTicketTab({ url, job, active, timeoutMs }) {
  const tab = await chrome.tabs.create({ url, active: !!active });
  return new Promise((resolve) => {
    const timer = setTimeout(() => finishJob(tab.id, { ok: false, note: `Hết thời gian chờ ${Math.round(timeoutMs / 1000)} giây khi thao tác trên trang chi tiết` }), timeoutMs);
    uiJobs.set(tab.id, { job, resolve, timer });
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (uiJobs.has(tabId)) finishJob(tabId, { ok: false, note: 'Tab chi tiết bị đóng giữa chừng' });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ui-ticket') {
    // Chỉ mở link cùng origin với trang đang gửi yêu cầu.
    let allowed = false;
    try { allowed = new URL(msg.url).origin === new URL(sender.url).origin; } catch (e) { /* không hợp lệ */ }
    if (!allowed) { sendResponse({ ok: false, note: 'Link trang chi tiết không cùng tên miền với trang danh sách' }); return false; }
    openTicketTab({ ...msg, timeoutMs: Math.min(Number(msg.timeoutMs) || 90000, 300000) }).then(sendResponse);
    return true; // trả lời bất đồng bộ
  }
  if (msg.type === 'get-job') {
    const entry = sender.tab && uiJobs.get(sender.tab.id);
    sendResponse({ job: entry ? entry.job : null });
    return false;
  }
  if (msg.type === 'job-result') {
    if (sender.tab) finishJob(sender.tab.id, msg.result);
    sendResponse({});
    return false;
  }
  return false;
});
