#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

function readMessage() {
  const header = Buffer.alloc(4);
  const headerBytes = fs.readSync(0, header, 0, 4, null);
  if (headerBytes === 0) return null;
  if (headerBytes < 4) return null;

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
  runAppleScript(`set volume output volume ${n}`);
  return n;
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    return { ok: false, error: 'Invalid message payload' };
  }
  if (msg.action === 'getSystemVolume') {
    return { ok: true, volume: getSystemVolume() };
  }
  if (msg.action === 'setSystemVolume') {
    const volume = setSystemVolume(msg.volume);
    return { ok: true, volume };
  }
  return { ok: false, error: 'Unsupported action' };
}

function main() {
  try {
    const msg = readMessage();
    if (!msg) {
      sendMessage({ ok: false, error: 'No input message' });
      return;
    }
    sendMessage(handleMessage(msg));
  } catch (e) {
    sendMessage({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

main();
