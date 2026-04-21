/**
 * Tab Audio Router — context menu on video/audio only. Uses activeTab: device listing and
 * setSinkId run only after the user clicks a menu item (chrome.scripting.executeScript).
 */

const PARENT_ID = 'tab-audio-outputs-parent';
const MENU_CHOOSE = 'tab-audio-choose-output';
const MENU_DEFAULT = 'tab-audio-use-default';

/**
 * Injected into the page when the user chooses "Choose output…". Must stay self-contained
 * (serialized for executeScript).
 * @param {string} src
 * @param {'audio' | 'video'} type
 */
async function runAudioOutputPicker(src, type) {
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
    window.alert('Tab Audio Router: No matching media element found.');
    return;
  }
  if (typeof el.setSinkId !== 'function') {
    window.alert('Tab Audio Router: setSinkId is not available here.');
    return;
  }

  async function outputsWithLabels() {
    let list = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === 'audiooutput',
    );
    const needsLabels = list.some((d) => !d.label);
    if (needsLabels) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* labels may still be empty */
      }
      list = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === 'audiooutput',
      );
    }
    return list;
  }

  const outputs = await outputsWithLabels();
  if (outputs.length === 0) {
    window.alert('Tab Audio Router: No audio output devices found.');
    return;
  }

  const prev = document.getElementById('tab-audio-router-picker-root');
  if (prev) prev.remove();

  const root = document.createElement('div');
  root.id = 'tab-audio-router-picker-root';
  root.setAttribute(
    'style',
    'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;',
  );

  const panel = document.createElement('div');
  panel.setAttribute(
    'style',
    'background:#1e1e1e;color:#eee;padding:16px 20px;border-radius:12px;max-width:90vw;max-height:70vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,.4);',
  );

  const title = document.createElement('div');
  title.textContent = 'Choose audio output';
  title.setAttribute(
    'style',
    'font-weight:600;margin-bottom:12px;font-size:15px;',
  );
  panel.appendChild(title);

  const hint = document.createElement('div');
  hint.textContent = 'Applies to this player only.';
  hint.setAttribute(
    'style',
    'font-size:12px;opacity:.75;margin-bottom:14px;',
  );
  panel.appendChild(hint);

  function close() {
    document.removeEventListener('keydown', onKey, true);
    root.remove();
  }

  function onKey(/** @type {KeyboardEvent} */ e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey, true);

  root.addEventListener('click', (e) => {
    if (e.target === root) close();
  });

  /**
   * @param {string} labelText
   * @param {string} sinkId
   * @param {boolean} isDefault
   */
  function addRow(labelText, sinkId, isDefault) {
    const row = document.createElement('button');
    row.type = 'button';
    row.textContent = labelText;
    row.setAttribute(
      'style',
      'display:block;width:100%;text-align:left;padding:10px 12px;margin:4px 0;border:none;border-radius:8px;background:#2d2d2d;color:#eee;cursor:pointer;font-size:14px;',
    );
    row.addEventListener('mouseenter', () => {
      row.style.background = '#3d3d3d';
    });
    row.addEventListener('mouseleave', () => {
      row.style.background = '#2d2d2d';
    });
    row.addEventListener('click', async () => {
      try {
        if (isDefault) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
            });
            stream.getTracks().forEach((t) => t.stop());
          } catch {
            /* still try setSinkId */
          }
        }
        await el.setSinkId(sinkId);
        close();
      } catch (err) {
        window.alert(
          'Tab Audio Router: ' +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    });
    panel.appendChild(row);
  }

  addRow('Default (system)', '', true);
  outputs.forEach((d) => {
    const lab = d.label?.trim() || d.deviceId || 'Unknown';
    addRow(lab, d.deviceId, false);
  });

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.setAttribute(
    'style',
    'margin-top:14px;padding:8px 14px;border-radius:8px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;font-size:13px;',
  );
  cancel.addEventListener('click', close);
  panel.appendChild(cancel);

  root.appendChild(panel);
  document.documentElement.appendChild(root);
}

chrome.runtime.onInstalled.addListener(() => {
  void createStaticMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id == null) return;
  const id = String(info.menuItemId);
  if (id === MENU_CHOOSE) {
    void openOutputPicker(tab.id, info);
    return;
  }
  if (id === MENU_DEFAULT) {
    void applySinkIdToContextMenuTarget(tab.id, info, '');
  }
});

/**
 * @param {number} tabId
 * @param {chrome.contextMenus.OnClickData} info
 */
async function openOutputPicker(tabId, info) {
  const frameId = info.frameId ?? 0;
  const srcUrl = info.srcUrl || '';
  const mediaType = info.mediaType === 'audio' ? 'audio' : 'video';
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: runAudioOutputPicker,
      args: [srcUrl, mediaType],
    });
  } catch (e) {
    console.warn('[Tab Audio Router] picker inject failed:', e);
  }
}

/**
 * @param {string} id
 */
function isDefaultSinkId(id) {
  const s = (id ?? '').trim();
  return s === '' || s === 'default';
}

/**
 * @param {number} tabId
 * @param {chrome.contextMenus.OnClickData} info
 * @param {string} deviceId
 */
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

async function createStaticMenus() {
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: PARENT_ID,
    title: 'Audio outputs',
    contexts: ['video', 'audio'],
  });

  chrome.contextMenus.create({
    id: MENU_CHOOSE,
    parentId: PARENT_ID,
    title: 'Choose output…',
    contexts: ['video', 'audio'],
  });

  chrome.contextMenus.create({
    id: MENU_DEFAULT,
    parentId: PARENT_ID,
    title: 'Use system default',
    contexts: ['video', 'audio'],
  });
}
