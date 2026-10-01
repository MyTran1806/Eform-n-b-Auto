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
    { id: scriptId(origin, 'ui'), matches, js: ['core.js', 'content.js'], runAt: 'document_idle', persistAcrossSessions: true },
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
