/**
 * Tab Audio Router — list audiooutput devices under a context submenu and apply the
 * choice with HTMLMediaElement.setSinkId() on the element that was right-clicked.
 * Before listing or setting outputs, the tab runs getUserMedia({ audio: true }) (then
 * stops tracks) so deviceIds match the fully resolved list; on macOS this keeps the
 * built-in output distinct from 3.5mm when the OS default is the jack.
 *
 * Chromium limitation: contextMenus has no onShown hook, so the menu is rebuilt on a
 * timer / focus / contextmenu ping; the first right-click after a change may still show
 * the previous list until the next open. See refresh triggers below.
 */

const PARENT_ID = 'tab-audio-outputs-parent';
const MAX_OUTPUT_ITEMS = 64;
const ALARM_NAME = 'refresh-audio-devices';
const DEFAULT_VOLUME = 1;
const NATIVE_HOST_NAME = 'com.tab_audio_router.host';

/** @type {Map<string, string>} menuItemId -> deviceId */
const deviceIdByMenuId = new Map();
/** @type {Map<number, { deviceId: string, volume: number }>} */
const tabAudioPrefs = new Map();

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'TRIGGER_MENU_REFRESH' && sender.tab?.id != null) {
    refreshMenuForTab(sender.tab.id);
    return;
  }

  if (msg?.type === 'POPUP_GET_STATE') {
    void handlePopupGetState().then(sendResponse);
    return true;
  }

  if (msg?.type === 'POPUP_SET_TAB_AUDIO') {
    void handlePopupSetTabAudio(msg).then(sendResponse);
    return true;
  }

  if (msg?.type === 'POPUP_GET_SYSTEM_VOLUME') {
    void handlePopupGetSystemVolume().then(sendResponse);
    return true;
  }

  if (msg?.type === 'POPUP_SET_SYSTEM_VOLUME') {
    void handlePopupSetSystemVolume(msg).then(sendResponse);
    return true;
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
async function applySinkIdToContextMenuTarget(tabId, info, deviceId) {
  const frameId = info.frameId ?? 0;
  const srcUrl = info.srcUrl || '';
  const mediaType = info.mediaType === 'audio' ? 'audio' : 'video';

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: async (src, type, sinkId) => {
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
          // Prime permission so output deviceId matches a fully resolved list; required
          // to distinguish built-in output vs 3.5mm default on macOS.
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
            });
            stream.getTracks().forEach((t) => t.stop());
          } catch {
            /* denied or blocked — still try setSinkId */
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
      args: [srcUrl, mediaType, deviceId],
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

/**
 * @param {number} tabId
 * @param {string} deviceId
 * @param {number} volume
 */
async function applyAudioForTab(tabId, deviceId, volume) {
  const normalizedVolume = Number.isFinite(volume)
    ? Math.max(0, Math.min(1, volume))
    : DEFAULT_VOLUME;

  const [res] = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: async (sinkId, vol) => {
      if (typeof navigator.mediaDevices?.enumerateDevices !== 'function') {
        return {
          ok: false,
          updatedCount: 0,
          error: 'Device enumeration is not available on this page',
        };
      }

      // Match enumerateDevices to the same resolution Chrome uses for setSinkId, so
      // explicit output ids (e.g. built-in speakers) are not confused with the system
      // default when 3.5mm headphones are the OS default.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* still try enumerate + setSinkId */
      }

      const outputs = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === 'audiooutput'
      );
      const sinkExists =
        sinkId === 'default' || outputs.some((d) => d.deviceId === sinkId);
      if (!sinkExists) {
        return {
          ok: false,
          updatedCount: 0,
          error: 'Requested device not found for this tab',
        };
      }

      const media = Array.from(document.querySelectorAll('audio,video'));
      if (media.length === 0) {
        return {
          ok: false,
          updatedCount: 0,
          error: 'No media elements found in this tab',
        };
      }

      let updatedCount = 0;
      /** @type {string[]} */
      const errors = [];
      for (const el of media) {
        try {
          if (typeof el.setSinkId === 'function') {
            await el.setSinkId(sinkId);
          }
          el.volume = vol;
          updatedCount += 1;
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
      }

      return {
        ok: errors.length === 0,
        updatedCount,
        error: errors[0] || null,
      };
    },
    args: [deviceId, normalizedVolume],
  });

  return res?.result ?? {
    ok: false,
    updatedCount: 0,
    error: 'No result from tab script',
  };
}

async function handlePopupGetState() {
  const audibleTabs = await chrome.tabs.query({ audible: true, currentWindow: true });
  const tabs = audibleTabs
    .filter((tab) => tab.id != null)
    .map((tab) => {
      const pref = tabAudioPrefs.get(tab.id);
      return {
        id: tab.id,
        title: truncateTitle(tab.title || 'Untitled tab'),
        url: tab.url || '',
        audible: Boolean(tab.audible),
        deviceId: pref?.deviceId || 'default',
        volume: pref?.volume ?? DEFAULT_VOLUME,
      };
    });

  const outputsByTab = {};
  await Promise.all(
    tabs.map(async (tab) => {
      outputsByTab[String(tab.id)] = await getAudioOutputsForTab(tab.id);
    })
  );

  return { ok: true, tabs, outputsByTab };
}

/**
 * @param {number | undefined} tabId
 */
async function getAudioOutputsForTab(tabId) {
  if (tabId == null) return [];

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop());
        } catch {
          /* unlabeled or partial list if denied */
        }
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

    const outputs = Array.isArray(res?.result) ? res.result : [];
    return outputs.slice(0, MAX_OUTPUT_ITEMS);
  } catch {
    return [];
  }
}

/**
 * @param {{ tabId?: number, deviceId?: string, volume?: number }} msg
 */
async function handlePopupSetTabAudio(msg) {
  const tabId = msg.tabId;
  const deviceId = (msg.deviceId || 'default').trim() || 'default';
  const volume = Number(msg.volume);
  if (tabId == null || !Number.isInteger(tabId)) {
    return { ok: false, error: 'Invalid tab id' };
  }

  const result = await applyAudioForTab(tabId, deviceId, volume);
  if (result?.ok || result?.updatedCount > 0) {
    tabAudioPrefs.set(tabId, {
      deviceId,
      volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : DEFAULT_VOLUME,
    });
  }
  return result;
}

async function handlePopupGetSystemVolume() {
  const res = await callNativeHost({ action: 'getSystemVolume' });
  if (!res?.ok) {
    return {
      ok: false,
      error: res?.error || 'Native helper unavailable',
    };
  }
  return {
    ok: true,
    volume: Number.isFinite(res.volume) ? res.volume : 0,
  };
}

/**
 * @param {{ volume?: number }} msg
 */
async function handlePopupSetSystemVolume(msg) {
  const vol = Number(msg?.volume);
  const volume = Number.isFinite(vol) ? Math.max(0, Math.min(100, Math.round(vol))) : 0;
  const res = await callNativeHost({ action: 'setSystemVolume', volume });
  if (!res?.ok) {
    return {
      ok: false,
      error: res?.error || 'Failed to set system volume',
    };
  }
  return { ok: true, volume };
}

function callNativeHost(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, payload, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: err.message || 'Native messaging error' });
        return;
      }
      resolve(response ?? { ok: false, error: 'No response from native host' });
    });
  });
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

/** Context menu ids are fixed; overlapping refreshMenuForTab runs caused duplicate-id errors. */
let contextMenuRefreshChain = Promise.resolve();

function refreshMenuForTab(tabId) {
  contextMenuRefreshChain = contextMenuRefreshChain
    .then(() => runRefreshMenuForTab(tabId))
    .catch(() => {});
}

async function runRefreshMenuForTab(tabId) {
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
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop());
        } catch {
          /* unlabeled or partial list if denied */
        }
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
