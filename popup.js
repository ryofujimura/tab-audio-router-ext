const tabsRoot = document.getElementById('tabs');
const statusEl = document.getElementById('status');
const systemVolumeRoot = document.getElementById('systemVolume');

/** @type {Map<number, { deviceId: string, volume: number }>} */
const localState = new Map();
/** @type {Map<number, { deviceId: string, label: string }[]>} */
const outputOptionsByTab = new Map();

init().catch((err) => {
  showStatus(`Could not load popup: ${String(err)}`);
});

async function init() {
  showStatus('Loading...');
  const [state, systemVolumeState] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'POPUP_GET_STATE' }),
    chrome.runtime.sendMessage({ type: 'POPUP_GET_SYSTEM_VOLUME' }),
  ]);
  if (!state?.ok) {
    showStatus(state?.error || 'Could not load state');
    return;
  }
  await renderSystemVolume(systemVolumeState);

  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  const outputsByTab = state.outputsByTab && typeof state.outputsByTab === 'object'
    ? state.outputsByTab
    : {};
  tabsRoot.replaceChildren();

  if (tabs.length === 0) {
    showStatus('No audible tabs right now');
    return;
  }

  showStatus('');
  tabs.forEach((tab) => {
    const outputOptions = normalizeOutputs(outputsByTab[String(tab.id)] || []);
    outputOptionsByTab.set(tab.id, outputOptions);
    const initialDeviceId = pickInitialDeviceId(tab.deviceId, outputOptions);
    localState.set(tab.id, {
      deviceId: initialDeviceId,
      volume: typeof tab.volume === 'number' ? tab.volume : 1,
    });
    tabsRoot.appendChild(renderTabCard(tab));
  });
}

/**
 * @param {{ deviceId: string, label: string }[]} raw
 */
function normalizeOutputs(raw) {
  /** @type {Map<string, string>} */
  const byId = new Map();
  byId.set('default', 'Default output');

  raw.forEach((item) => {
    const id = String(item.deviceId || '').trim();
    if (!id) return;
    const label = String(item.label || '').trim() || shortId(id);
    byId.set(id, label);
  });

  return Array.from(byId.entries()).map(([deviceId, label]) => ({
    deviceId,
    label,
  }));
}

/**
 * @param {{ id: number, title: string, deviceId: string, volume: number }} tab
 */
function renderTabCard(tab) {
  const card = document.createElement('article');
  card.className = 'tab-card';

  const title = document.createElement('div');
  title.className = 'tab-title';
  title.textContent = tab.title || 'Untitled tab';
  card.appendChild(title);

  const outputField = document.createElement('div');
  outputField.className = 'field';
  const outputLabel = document.createElement('label');
  outputLabel.textContent = 'Output';
  outputField.appendChild(outputLabel);

  const select = document.createElement('select');
  const outputOptions = outputOptionsByTab.get(tab.id) || [
    { deviceId: 'default', label: 'Default output' },
  ];
  outputOptions.forEach((output) => {
    const opt = document.createElement('option');
    opt.value = output.deviceId;
    opt.textContent = output.label;
    select.appendChild(opt);
  });
  const initialDeviceId = localState.get(tab.id)?.deviceId || 'default';
  select.value = pickInitialDeviceId(initialDeviceId, outputOptions);
  select.addEventListener('change', async () => {
    const current = localState.get(tab.id);
    if (!current) return;
    current.deviceId = select.value;
    await applyTabAudio(tab.id, current.deviceId, current.volume);
  });
  outputField.appendChild(select);
  card.appendChild(outputField);

  const volumeField = document.createElement('div');
  volumeField.className = 'field';
  const volumeLabel = document.createElement('label');
  volumeLabel.textContent = 'Volume';
  volumeField.appendChild(volumeLabel);

  const volumeRow = document.createElement('div');
  volumeRow.className = 'volume-row';

  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0';
  range.max = '100';
  range.step = '1';
  range.value = String(Math.round((tab.volume ?? 1) * 100));

  const volumeValue = document.createElement('span');
  volumeValue.className = 'volume-value';
  volumeValue.textContent = `${range.value}%`;

  let commitTimer = null;
  range.addEventListener('input', () => {
    volumeValue.textContent = `${range.value}%`;
    const current = localState.get(tab.id);
    if (!current) return;
    current.volume = Number(range.value) / 100;
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      void applyTabAudio(tab.id, current.deviceId, current.volume);
    }, 140);
  });

  volumeRow.appendChild(range);
  volumeRow.appendChild(volumeValue);
  volumeField.appendChild(volumeRow);
  card.appendChild(volumeField);

  return card;
}

async function applyTabAudio(tabId, deviceId, volume) {
  showStatus('Applying...');
  const result = await chrome.runtime.sendMessage({
    type: 'POPUP_SET_TAB_AUDIO',
    tabId,
    deviceId,
    volume,
  });

  if (result?.ok || result?.updatedCount > 0) {
    showStatus('');
    return;
  }
  showStatus(result?.error || 'Could not apply to tab');
}

async function renderSystemVolume(systemState) {
  systemVolumeRoot.replaceChildren();

  const field = document.createElement('div');
  field.className = 'field';
  const label = document.createElement('label');
  label.textContent = 'System output volume';
  field.appendChild(label);

  const volumeRow = document.createElement('div');
  volumeRow.className = 'volume-row';
  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0';
  range.max = '100';
  range.step = '1';

  const value = document.createElement('span');
  value.className = 'volume-value';

  if (!systemState?.ok) {
    range.disabled = true;
    range.value = '0';
    value.textContent = '--';

    const hint = document.createElement('p');
    hint.className = 'subtle setup-copy';
    hint.textContent =
      'Install the helper once, then this slider controls macOS volume directly.';

    const actions = document.createElement('div');
    actions.className = 'setup-actions';
    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'btn';
    downloadBtn.textContent = 'Download installer';
    downloadBtn.addEventListener('click', () => {
      downloadInstaller();
      showStatus('Installer downloaded. Run it, then click retry.');
    });

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'btn btn-secondary';
    retryBtn.textContent = 'I installed it, retry';
    retryBtn.addEventListener('click', async () => {
      showStatus('Checking helper...');
      const retryState = await chrome.runtime.sendMessage({
        type: 'POPUP_GET_SYSTEM_VOLUME',
      });
      await renderSystemVolume(retryState);
      showStatus(retryState?.ok ? 'Helper connected.' : 'Helper not detected yet.');
    });
    actions.appendChild(downloadBtn);
    actions.appendChild(retryBtn);

    systemVolumeRoot.appendChild(field);
    volumeRow.appendChild(range);
    volumeRow.appendChild(value);
    field.appendChild(volumeRow);
    systemVolumeRoot.appendChild(hint);
    systemVolumeRoot.appendChild(actions);
    return;
  }

  const initial = clampPercent(systemState.volume);
  range.value = String(initial);
  value.textContent = `${initial}%`;

  let commitTimer = null;
  range.addEventListener('input', () => {
    value.textContent = `${range.value}%`;
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      void applySystemVolume(Number(range.value));
    }, 120);
  });

  volumeRow.appendChild(range);
  volumeRow.appendChild(value);
  field.appendChild(volumeRow);
  systemVolumeRoot.appendChild(field);
  const connected = document.createElement('p');
  connected.className = 'subtle';
  connected.textContent = 'Helper connected';
  systemVolumeRoot.appendChild(connected);
}

async function applySystemVolume(volume) {
  const result = await chrome.runtime.sendMessage({
    type: 'POPUP_SET_SYSTEM_VOLUME',
    volume: clampPercent(volume),
  });
  if (!result?.ok) {
    showStatus(result?.error || 'Could not set system volume');
    return;
  }
  showStatus('');
}

function showStatus(message) {
  statusEl.textContent = message;
}

function shortId(id) {
  if (id.length <= 24) return id;
  return `${id.slice(0, 21)}...`;
}

function pickInitialDeviceId(deviceId, options) {
  const wanted = String(deviceId || 'default');
  if (options.some((o) => o.deviceId === wanted)) return wanted;
  return 'default';
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function downloadInstaller() {
  const extensionId = chrome.runtime.id;
  const script = buildMacInstallerScript(extensionId);
  const blob = new Blob([script], { type: 'text/x-shellscript' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'install-tab-audio-router.command';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function buildMacInstallerScript(extensionId) {
  return `#!/bin/bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display dialog "Node.js is required to install Tab Audio Router helper." buttons {"OK"} default button "OK"'
  exit 1
fi

HOST_DIR="$HOME/Library/Application Support/TabAudioRouterNativeHost"
HOST_JS="$HOST_DIR/host.js"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_PATH="$MANIFEST_DIR/com.tab_audio_router.host.json"

mkdir -p "$HOST_DIR"
mkdir -p "$MANIFEST_DIR"

cat > "$HOST_JS" <<'EOF_HOST'
#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
function readMessage() {
  const header = Buffer.alloc(4);
  const headerBytes = fs.readSync(0, header, 0, 4, null);
  if (headerBytes === 0 || headerBytes < 4) return null;
  const length = header.readUInt32LE(0);
  const body = Buffer.alloc(length);
  const bodyBytes = fs.readSync(0, body, 0, length, null);
  if (bodyBytes < length) return null;
  return JSON.parse(body.toString('utf8'));
}
function sendMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(header);
  process.stdout.write(body);
}
function runAppleScript(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
}
function getSystemVolume() {
  const out = runAppleScript('output volume of (get volume settings)');
  const volume = Number.parseInt(out, 10);
  if (!Number.isFinite(volume)) return 0;
  return Math.max(0, Math.min(100, volume));
}
function setSystemVolume(volume) {
  const n = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
  runAppleScript(\`set volume output volume \${n}\`);
  return n;
}
function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, error: 'Invalid message payload' };
  if (msg.action === 'getSystemVolume') return { ok: true, volume: getSystemVolume() };
  if (msg.action === 'setSystemVolume') return { ok: true, volume: setSystemVolume(msg.volume) };
  return { ok: false, error: 'Unsupported action' };
}
try {
  const msg = readMessage();
  if (!msg) sendMessage({ ok: false, error: 'No input message' });
  else sendMessage(handleMessage(msg));
} catch (e) {
  sendMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
}
EOF_HOST

chmod +x "$HOST_JS"

cat > "$MANIFEST_PATH" <<EOF_MANIFEST
{
  "name": "com.tab_audio_router.host",
  "description": "Tab Audio Router native host for macOS system volume",
  "path": "$HOST_JS",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${extensionId}/"
  ]
}
EOF_MANIFEST

osascript -e 'display dialog "Tab Audio Router helper installed. Reopen extension popup and click retry." buttons {"OK"} default button "OK"'
`;
}
