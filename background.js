/**
 * Tab Audio Router — list audiooutput devices under a context submenu and apply the
 * choice with HTMLMediaElement.setSinkId() on the element that was right-clicked.
 * Choosing the default output runs getUserMedia({ audio: true }) first so sites that
 * never requested mic access still get a permission prompt and labeled devices.
 *
 * Chromium limitation: contextMenus has no onShown hook, so the menu is rebuilt on a
 * timer / focus / contextmenu ping; the first right-click after a change may still show
 * the previous list until the next open. See refresh triggers below.
 */

const PARENT_ID = 'tab-audio-outputs-parent';
const MAX_OUTPUT_ITEMS = 64;
const ALARM_NAME = 'refresh-audio-devices';

/** @type {Map<string, string>} menuItemId -> deviceId */
const deviceIdByMenuId = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  scheduleRefreshActiveTab();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleRefreshActiveTab();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    scheduleRefreshActiveTab();
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  refreshMenuForTab(activeInfo.tabId);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ active: true, windowId }).then((tabs) => {
    const id = tabs[0]?.id;
    if (id != null) refreshMenuForTab(id);
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'TRIGGER_MENU_REFRESH' && sender.tab?.id != null) {
    refreshMenuForTab(sender.tab.id);
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  const deviceId = deviceIdByMenuId.get(id);
  if (deviceId == null || tab?.id == null) return;
  void applySinkIdToContextMenuTarget(tab.id, info, deviceId);
});

/**
 * @param {number} tabId
 * @param {chrome.contextMenus.OnClickData} info
 * @param {string} deviceId
 */
/**
 * @param {string} id
 */
function isDefaultSinkId(id) {
  const s = (id ?? '').trim();
  return s === '' || s === 'default';
}

async function applySinkIdToContextMenuTarget(tabId, info, deviceId) {
  const frameId = info.frameId ?? 0;
  const srcUrl = info.srcUrl || '';
  const mediaType = info.mediaType === 'audio' ? 'audio' : 'video';
  const primeMic = isDefaultSinkId(deviceId);

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: async (src, type, sinkId, shouldPrimeMic) => {
        function pickMedia() {
          const tag = type === 'audio' ? 'audio' : 'video';
          const list = Array.from(document.querySelectorAll(tag));
          if (list.length === 0) return null;
          if (src) {
            const hit = list.find((el) => {
              try {
                return (
                  el.src === src ||
                  el.currentSrc === src ||
                  el.getAttribute('src') === src
                );
              } catch {
                return false;
              }
            });
            if (hit) return hit;
          }
          return list[0];
        }

        const el = pickMedia();
        if (!el) {
          return { ok: false, error: 'No matching media element' };
        }
        if (typeof el.setSinkId !== 'function') {
          return {
            ok: false,
            error: 'setSinkId is not available (browser or site policy)',
          };
        }
        try {
          if (shouldPrimeMic) {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({
                audio: true,
              });
              stream.getTracks().forEach((t) => t.stop());
            } catch {
              /* denied or blocked — still try setSinkId */
            }
          }
          await el.setSinkId(sinkId);
          return { ok: true };
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      },
      args: [srcUrl, mediaType, deviceId, primeMic],
    });

    const result = res?.result;
    if (result?.ok) {
      console.log('[Tab Audio Router] Output set to', deviceId, 'tab', tabId);
    } else {
      console.warn('[Tab Audio Router] setSinkId failed:', result?.error);
    }
  } catch (e) {
    console.warn('[Tab Audio Router] executeScript failed:', e);
  }
}

function scheduleRefreshActiveTab() {
  chrome.windows.getLastFocused({ populate: true }).then((win) => {
    const tab = win.tabs?.find((t) => t.active);
    if (tab?.id != null) refreshMenuForTab(tab.id);
  }).catch(() => {});
}

/**
 * @param {string} url
 */
function canInject(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  return (
    u.startsWith('http://') ||
    u.startsWith('https://') ||
    u.startsWith('file://')
  );
}

/**
 * @param {string} title
 */
function truncateTitle(title) {
  const t = title.trim();
  if (t.length <= 60) return t;
  return `${t.slice(0, 57)}...`;
}

/**
 * @param {{ deviceId: string, label: string, groupId: string }[]} outputs
 */
function deviceTitle(d) {
  const label = d.label?.trim();
  if (label) return truncateTitle(label);
  const id = d.deviceId || '';
  if (!id || id === 'default') return 'Default';
  return truncateTitle(id.length > 24 ? `${id.slice(0, 21)}...` : id);
}

async function refreshMenuForTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    await rebuildMenuError('Tab unavailable');
    return;
  }

  if (!canInject(tab.url || '')) {
    await rebuildMenuError('Not available on this page');
    return;
  }

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const list = await navigator.mediaDevices.enumerateDevices();
        return list
          .filter((d) => d.kind === 'audiooutput')
          .map((d) => ({
            deviceId: d.deviceId,
            label: d.label || '',
            groupId: d.groupId || '',
          }));
      },
    });
    const outputs = res?.result;
    if (!Array.isArray(outputs)) {
      await rebuildMenuError('No device list');
      return;
    }
    await rebuildMenuOutputs(outputs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await rebuildMenuError(msg);
  }
}

async function rebuildMenuOutputs(outputs) {
  deviceIdByMenuId.clear();
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: PARENT_ID,
    title: 'Audio outputs',
    contexts: ['video', 'audio'],
  });

  const slice = outputs.slice(0, MAX_OUTPUT_ITEMS);
  if (slice.length === 0) {
    chrome.contextMenus.create({
      id: 'tab-audio-no-devices',
      parentId: PARENT_ID,
      title: 'No output devices found',
      enabled: false,
      contexts: ['video', 'audio'],
    });
    return;
  }

  slice.forEach((d, i) => {
    const menuId = `tab-audio-out-${i}`;
    deviceIdByMenuId.set(menuId, d.deviceId);
    chrome.contextMenus.create({
      id: menuId,
      parentId: PARENT_ID,
      title: deviceTitle(d),
      contexts: ['video', 'audio'],
    });
  });
}

async function rebuildMenuError(message) {
  deviceIdByMenuId.clear();
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: PARENT_ID,
    title: 'Audio outputs',
    contexts: ['video', 'audio'],
  });
  chrome.contextMenus.create({
    id: 'tab-audio-error',
    parentId: PARENT_ID,
    title: truncateTitle(`Could not list devices (${message})`),
    enabled: false,
    contexts: ['video', 'audio'],
  });
}
