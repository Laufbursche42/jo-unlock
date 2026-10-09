'use strict';
/*
 * Joyor Tuning - Web Bluetooth. Implements the BLE protocol proven from the decompiled app
 * com.yunshang.speed.joyor (a white-label of Lenzod cn.sccss.speed, ViseBluetooth stack).
 * Proven: write char 0x8877, notify char 0x8888, CCCD 0x2902; plaintext short frames
 * FF 55 REG LEN DATA CHK with an additive checksum; 8-byte long-frame queries without a checksum;
 * the Command.java write table and the onRead telemetry register map. Gated / unknown: the real GATT
 * service UUID (the app matches characteristics by UUID across all services), battery volts/amps,
 * and any register that raises the road top speed - none exists in the app.
 */

// The pre-commit cache-buster auto-bumps BUILD and every ?v= in index.html on any web-asset change.
const BUILD = 'v1';

// --------------------------- UUIDs (Web Bluetooth wants lowercase) ---------------------------
// Write 0x8877 (app -> device), notify 0x8888 (device -> app). The app never records a service UUID,
// so the real service is unknown; we accept all devices and probe a candidate list, then match the
// two characteristics by UUID across whatever services the device exposes.
const U = {
  WRITE:  '00008877-0000-1000-8000-00805f9b34fb',
  NOTIFY: '00008888-0000-1000-8000-00805f9b34fb'
};
// Candidate vendor BLE-serial services to list in optionalServices. NOT proven for Joyor; the true
// service is device-specific. The 8877/8888 forms are included in case a device exposes them as a
// service. If none matches, read the real UUID off the device (nRF Connect) and add it here.
const CANDIDATE_SERVICES = [
  '00008877-0000-1000-8000-00805f9b34fb',
  '00008888-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000ae00-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e'
];
const ALL_SERVICES = Array.from(new Set(CANDIDATE_SERVICES));

// --------------------------- registers (proven from the app) ---------------------------
// Short-frame writes (FF 55 REG LEN DATA CHK): one payload byte for most settings.
const REG = {
  STATUS: 0x01, HEARTBEAT: 0x08, DRIVE_MODE: 0x10, RGB: 0x15, JOYSTICK: 0x16, LOCK: 0x17,
  UNIT: 0x18, LAMP: 0x19, START_MODE: 0x1a, VOLTAGE: 0x1b, WHEEL: 0x1c, CRUISE: 0x1d,
  SELFTEST: 0x1e, GEAR: 0x1f, HEADLIGHT: 0x23,
  // RGB 0x15 = lamp colour (CarLampSettingsActivity.java:218, FF551503 RR GG BB); LAMP 0x19 = lamp mode
  // (CarLampSettingsActivity.java:104-113, 01 single colour / 02 RGB). JOYSTICK 0x16 is the proven
  // remote-control register (BluetoothControlActivity.java:169,339) - not exposed, it drives the scooter.
  // GOVERNOR 0x2A = sister-app Lenzod Pro drive/brake/accel/max-speed governor
  // (CarSpeedActivity.java:89-95, CommandUtil.java:49-59). Bounded %, UNTESTED on controller.
  // Joyor app itself never sends 0x2A - only Lenzod Pro, and only for controllers reporting mHardVersion.
  GOVERNOR: 0x2a,
  // 8-byte long-frame queries / set (no checksum, last byte 0x00):
  SPEED_CAP: 0x38, Q_VERSIONS: 0x3b, Q_MODEL: 0x3c, Q_SERIAL: 0x61
};
// Telemetry notify registers (device -> app). Numeric payloads are unsigned big-endian.
const TELE = {
  serial: 0x02, version: 0x03, model: 0x04, speed: 0x0a, trip: 0x0b, total: 0x0c,
  batt: 0x0d, temp: 0x11, lock: 0x17, unit: 0x18, startMode: 0x1a, voltage: 0x1b,
  wheel: 0x1c, cruise: 0x1d, fault: 0x1e, gear: 0x1f, runtime: 0x22, light: 0x23, driveMode: 0x10
};
const POLL_MS = 2000;      // status poll cadence
const HEARTBEAT_MS = 5000; // keep-alive cadence

// --------------------------- per-model info ---------------------------
// One protocol, two families. They differ only in the 0x1E self-test bit map, not in any command.
const MODELS = {
  NIUNIU: { label: 'NIUNIU', selfTest: 'body/brake/Hall/hardware/battery' },
  HUABAN: { label: 'HUABAN', selfTest: 'hardware/Hall/communication/battery/board' }
};
// Family-identifier serial frames hardcoded in the original Joyor app's Constant.java:5-6.
// First serial-reply (0x02) after connect matches exactly one of these, which classifies the family.
// Device-side classification mirrors com.yunshang.speed.joyor DeviceDiscoverActivityNew:107-128.
const CAR_TYPE_HEX = {
  NIUNIU: 'FF5502083935323730313233FB',
  HUABAN: 'FF55020839353237373839300D'
};

// --------------------------- helpers ---------------------------
const $ = (id) => document.getElementById(id);
const hex = (arr) => Array.from(arr, b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
const LS = { THEME: 'jou_theme', MODEL: 'jou_model', PUBLICLOG: 'jou_publiclog' };

let dev = null, server = null, chars = {}, writeC = null, notifyC = null;
let model = 'auto', busy = false, pollTimer = null, beatTimer = null, rxBuf = [];
const tele = {};       // decoded telemetry: name -> value
const liveSeen = {};   // tile id -> true once the scooter has reported a value for it
function cap() { return MODELS[model] || null; }

// Additive checksum: sum of every byte from index 0 through the byte before CHK, mod 256.
function sum8(bytes, upto) { let s = 0; const n = (upto === undefined ? bytes.length : upto); for (let i = 0; i < n; i++) s = (s + bytes[i]) & 0xff; return s; }
// Short frame: FF 55 REG LEN DATA... CHK. LEN = number of DATA bytes.
function shortFrame(reg, data) { data = data || []; const f = [0xFF, 0x55, reg & 0xff, data.length & 0xff].concat(data.map(b => b & 0xff)); f.push(sum8(f)); return f; }
// Long 8-byte frame: FF 55 REG 00 00 00 VAL 00. Last byte fixed 0x00 (NOT a checksum).
function longFrame(reg, val) { return [0xFF, 0x55, reg & 0xff, 0x00, 0x00, 0x00, (val || 0) & 0xff, 0x00]; }

// Load-time protocol self-test (mirrors Active/inokim-unlock FRAME_OK): THIS page's real builders
// must reproduce known-good command frames byte-for-byte, then every short frame must round-trip
// through the additive-checksum rule. Vectors are code-proven from the decompiled app, never guessed:
// the sccss/util/Command.java write table and the Constants.java astrictSpeed set.
// parseHex of each proven hex string is the expected value.
const parseHex = (s) => (String(s).match(/[0-9a-fA-F]{2}/g) || []).map(h => parseInt(h, 16));
const FRAME_OK = (function () {
  const eq = (a, b) => a.length === b.length && a.every((v, i) => (v & 0xff) === (b[i] & 0xff));
  // Short frames FF 55 REG LEN DATA CHK, CHK = sum of all preceding bytes mod 256.
  const SHORT = [
    [shortFrame(REG.STATUS),             'FF55010055'],   // status poll (TwoWheelActivity.java:160,401)
    [shortFrame(REG.HEARTBEAT),          'FF5508005C'],   // heartbeat (ViseBluetooth manager)
    [shortFrame(REG.DRIVE_MODE, [0x01]), 'FF5510010166'], // drive mode electro (Command.java)
    [shortFrame(REG.LOCK, [0x01]),       'FF551701016D'], // unlock (Command.java)
    [shortFrame(REG.HEADLIGHT, [0x02]),  'FF552301027A'], // light on (Command.java)
    [shortFrame(REG.SELFTEST, [0x00, 0x00]), 'FF551E02000074'],     // self-test (CheckActivity.java:180,222)
    [shortFrame(REG.RGB, [0x12, 0x34, 0x56]), 'FF55150312345608'],  // lamp colour (CarLampSettingsActivity.java:218)
    // Governor frame FF 55 2A 06 <drive> <brake> <accel> <maxspeed> 00 00 CHK.
    // maxspeed byte = governor% + 128 (0x80 base). Test vector: drive=05 brake=05 accel=05, 100% maxspeed (0xE4).
    [shortFrame(REG.GOVERNOR, [0x05, 0x05, 0x05, 0xe4, 0x00, 0x00]), 'FF552A06050505E4000077']
  ];
  // Long frame FF 55 REG 00 00 00 VAL 00: astrictSpeed set to 3.0 km/h (0x1E) (Constants.java).
  const built = eq(longFrame(REG.SPEED_CAP, 0x1E), parseHex('FF55380000001E00'))
    && SHORT.every(([f, h]) => eq(f, parseHex(h)));
  // Round-trip: the receive-side additive checksum (parseFrame) must re-derive each short frame's CHK.
  const roundTrip = SHORT.every(([f]) => sum8(f, f.length - 1) === f[f.length - 1]);
  return built && roundTrip;
})();
const numBE = (bytes) => { let v = 0; for (const x of bytes) v = v * 256 + x; return v; };
const asciiOf = (b) => b.filter(x => x >= 32 && x < 127).map(x => String.fromCharCode(x)).join('');
const valBytes = (v) => { v &= 0xffff; return v > 0xff ? [(v >> 8) & 0xff, v & 0xff] : [v & 0xff]; };

// --------------------------- log (raw buffer + one anonymize gate; copy/save use the same text) ---------------------------
// The log keeps a RAW buffer; sensitive spans (device name, serial) are wrapped in \x01 sentinels by the
// logger. anonymize() is the single filter: with Public-Log ON (default) it masks sentinel spans to XX
// and redacts MAC/hex/key-assignments/deviceId; OFF it returns the full raw line (local debugging only).
let logBuffer = [];        // [{raw, cls}]
let publicLog = true;      // anonymize on by default; persisted to LS.PUBLICLOG
let diag = false;          // diagnostics: capture every raw notify chunk; off each session, not persisted
let deviceId = null;       // BLE device id, redacted from shared text
function redact(text) {
  let s = String(text);
  if (deviceId) s = s.split(deviceId).join('[redacted-id]');
  s = s.replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, '[redacted-mac]');
  s = s.replace(/\b(secret|token|key|aes|pwd|password|pin|mac|serial|vin|uid|imei)\b(\s*[:=]\s*)("?)([^\s",]+)\3/gi,
    (m, k, sep) => k + sep + '[redacted]');
  s = s.replace(/\b[0-9A-Fa-f]{16,}\b/g, '[redacted-hex]');
  return s;
}
function anonymize(s) {
  if (publicLog === false) return s.replace(/\x01/g, '');
  return redact(s.replace(/\x01[^\x01]*\x01/g, 'XX').replace(/\x01/g, ''));
}
function logLine(cls, text) {
  const line = '[' + new Date().toTimeString().slice(0, 8) + '] ' + text;
  logBuffer.push({ raw: line, cls: cls || '' });
  const el = $('log'); if (!el) return;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = anonymize(line) + '\n';
  el.appendChild(span); el.scrollTop = el.scrollHeight;
}
// Re-render the whole pane from the raw buffer (after the Public-Log toggle flips).
function renderLog() {
  const el = $('log'); if (!el) return;
  el.textContent = '';
  logBuffer.forEach(e => { const s = document.createElement('span'); if (e.cls) s.className = e.cls; s.textContent = anonymize(e.raw) + '\n'; el.appendChild(s); });
  el.scrollTop = el.scrollHeight;
}
function clearLog() { logBuffer = []; const el = $('log'); if (el) el.textContent = ''; logDiagnosticHeader(); logLine('', t('logCleared')); }
function copyLog() {
  const text = logBuffer.map(e => anonymize(e.raw)).join('\n');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => logLine('log-ok', t('logCopied')), () => logErr('clipboard write failed'));
  else logErr('clipboard API unavailable');
}
function saveLog() {
  const text = logBuffer.map(e => anonymize(e.raw)).join('\n');
  try {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'laufbursche42-log.txt';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    logLine('log-ok', t('logSaved'));
  } catch (e) { logErr('save failed: ' + e.message); }
}
function setDiag(on) { diag = !!on; }
const logTx = (b) => logLine('log-tx', '>>> ' + hex(b));
const logRx = (b, note) => logLine('log-rx', '<<< ' + hex(b) + (note || ''));
const logSys = (t) => logLine('', '--- ' + t);
const logErr = (t) => logLine('log-err', '!!! ' + t);

// A tile appears only once the scooter reports a value for it (liveSeen). Null never reveals a tile.
function setTile(id, val) {
  const el = $(id); if (!el) return;
  if (val == null) { el.textContent = '-'; return; }
  el.textContent = val;
  if (!liveSeen[id]) { liveSeen[id] = true; const w = $('tile-' + id.slice(2)); if (w) w.hidden = false; updateTilesEmpty(); }
}
function updateTilesEmpty() { const e = $('tiles-empty'); if (e) e.hidden = Object.keys(liveSeen).length > 0; }
function resetTiles() {
  for (const k of Object.keys(liveSeen)) delete liveSeen[k];
  ['speed','batt','trip','total','max','lock','light','volt','current','temp','runtime','err','fw','serial','model'].forEach(n => {
    const b = $('t-' + n); if (b) b.textContent = '-';
    const w = $('tile-' + n); if (w) w.hidden = true;
  });
  for (const k of Object.keys(tele)) delete tele[k];
  updateTilesEmpty();
}
// Control cards are hidden until connected, then all revealed (one protocol serves every model).
function showControlCards(on) { ['live-card','batt-card','more-card','raw-card'].forEach(id => { const c = $(id); if (c) c.hidden = !on; }); }
function logDiagnosticHeader() {
  logLine('', '=== jo-unlock diagnostic ===');
  logLine('', 'build: ' + BUILD);
  logLine('', 'time: ' + new Date().toISOString());
  logLine('', 'userAgent: ' + (navigator.userAgent || '?'));
  logLine('', 'platform: ' + (navigator.platform || '?'));
  logLine('', 'webBluetooth: ' + (navigator.bluetooth ? 'yes' : 'no'));
  logLine('', 'protocol self-test: ' + (FRAME_OK ? 'OK' : 'FAILED'));
  if (!FRAME_OK) logErr('protocol self-test FAILED: builder did not reproduce a known-good vector');
  logLine('', '================================');
}

// --------------------------- i18n ---------------------------
let lang = 'de';
function table() { return (window.I18N && window.I18N[lang]) || {}; }
function t(key) { const v = table()[key]; return (typeof v === 'string') ? v : ''; }
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach(n => {
    const v = t(n.getAttribute('data-t'));
    if (/[<&]/.test(v)) n.innerHTML = v; else n.textContent = v;   // scan-ok: our own translation table
  });
  document.querySelectorAll('[data-t-ph]').forEach(n => { const v = t(n.getAttribute('data-t-ph')); if (v) n.setAttribute('placeholder', v); });
  { const el = $('link-guide'); if (el) el.href = docFile('GUIDE'); }
  { const el = $('link-readme'); if (el) el.href = docFile('README'); }
  { const el = $('link-license'); if (el) el.href = docFile('LICENSE'); }
  { const el = $('link-privacy'); if (el) el.href = docFile('PRIVACY'); }
  { const el = $('link-trademarks'); if (el) el.href = docFile('TRADEMARKS'); }
  { const el = $('langs'); if (el) el.setAttribute('aria-label', t('langGroup')); }
  { const el = $('build-ver'); if (el) el.textContent = t('buildLabel') + ' ' + BUILD; }
  document.querySelectorAll('#langs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  buildModelDropdown();
  { const el = $('status'); setStatus(el ? el.dataset.state : 'disconnected'); }
  { const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    const el = $('btn-theme'); if (el) { el.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); el.title = el.getAttribute('aria-label'); } }
}
function initLangSwitch() {
  document.querySelectorAll('#langs button').forEach(b => b.addEventListener('click', () => { lang = b.dataset.lang; applyLang(); }));
}

// --------------------------- theme ---------------------------
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const b = $('btn-theme');
  if (b) { b.textContent = dark ? '\u2600' : '\u263E'; b.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); b.title = b.getAttribute('aria-label'); }
  try { localStorage.setItem(LS.THEME, dark ? 'dark' : 'light'); } catch (e) {}
}
function initTheme() {
  let saved = null; try { saved = localStorage.getItem(LS.THEME); } catch (e) {}
  applyTheme(saved !== 'light');
  const b = $('btn-theme');
  if (b) b.addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'light'));
}

// --------------------------- model dropdown ---------------------------
function buildModelDropdown() {
  const sel = $('model-in'); if (!sel) return;
  const prev = sel.value || model;
  sel.textContent = '';
  const auto = document.createElement('option');
  auto.value = 'auto'; auto.textContent = t('modelAuto'); sel.appendChild(auto);
  for (const key of Object.keys(MODELS)) {
    const o = document.createElement('option'); o.value = key; o.textContent = MODELS[key].label; sel.appendChild(o);
  }
  sel.value = prev && (prev === 'auto' || MODELS[prev]) ? prev : 'auto';
}
function setModel(key, persist) {
  model = (key === 'auto' || MODELS[key]) ? key : 'auto';
  const sel = $('model-in'); if (sel) sel.value = model;
  if (persist !== false) { try { localStorage.setItem(LS.MODEL, model); } catch (e) {} }
}

// --------------------------- status ---------------------------
function statusLabel(s) {
  const map = { disconnected: 'stDisconnected', connecting: 'stConnecting', linking: 'stLinking', connected: 'stConnected', 'no-service': 'stNoService', 'no-char': 'stNoChar' };
  return t(map[s] || 'stDisconnected') || s;
}
function setStatus(s) {
  const el = $('status'); if (el) { el.dataset.state = s; el.textContent = statusLabel(s); }
  const cb = $('btn-conn');
  if (cb) { const on = (s === 'connecting' || s === 'linking' || s === 'connected'); cb.textContent = on ? t('btnDisconnect') : t('btnConnect'); cb.dataset.act = on ? 'disconnect' : 'connect'; }
}
function setControlsEnabled(on) {
  ['btn-setspeed','speed-kmh','btn-mode','mode-in','btn-light','light-in','btn-cruise','cruise-in',
   'btn-startmode','startmode-in','btn-unit','unit-in','btn-gear','gear-in','btn-lamp','lamp-in',
   'btn-rgb','rgb-in','btn-voltage','voltage-in','btn-wheel','wheel-in','btn-selftest','btn-info',
   'btn-immob-unlock','btn-immob-lock','btn-writereg','reg-nr','reg-val','btn-readreg','read-addr',
   'read-val','btn-raw','btn-raw-plain','raw-hex','btn-governor','gov-drive','gov-brake','gov-accel','gov-max']
    .forEach(id => { const e = $(id); if (e) e.disabled = !on; });
}

// --------------------------- connect ---------------------------
async function connect() {
  if (!navigator.bluetooth) { logErr('This browser has no Web Bluetooth. Use Chrome, Edge or Bluefy.'); return; }
  try {
    setStatus('connecting');
    // The app filters by no service UUID, so accept all devices and probe the candidate services.
    dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ALL_SERVICES });
    dev.addEventListener('gattserverdisconnected', onDisconnected);
    deviceId = dev.id || null;
    resetTiles();
    logSys('device: \x01' + (dev.name || '(no name)') + '\x01');
    setStatus('linking');
    server = await dev.gatt.connect();
    await discover();
    writeC = chars[U.WRITE] || null;
    notifyC = chars[U.NOTIFY] || null;
    if (!writeC || !notifyC) {
      setStatus('no-char');
      logErr('chars 0x8877/0x8888 not found under any probed service. Read the real service UUID from the device (nRF Connect) and add it to CANDIDATE_SERVICES in app.js.');
      return;
    }
    await subscribe(notifyC, onNotify);
    setStatus('connected');
    setControlsEnabled(true);
    showControlCards(true);
    { const el = $('devinfo'); if (el) el.textContent = t('devPrefix') + ' ' + (dev.name || 'Joyor'); }
    logSys('connected, ' + Object.keys(chars).length + ' characteristics');
    // Ask for the identity strings once (serial / versions / model), then start the polling loop.
    await query(REG.Q_SERIAL); await query(REG.Q_VERSIONS); await query(REG.Q_MODEL);
    startPoll();
  } catch (e) {
    logErr('connect failed: ' + (e && e.message ? e.message : e));
    setStatus('disconnected');
  }
}
async function discover() {
  chars = {};
  const svcs = await server.getPrimaryServices();
  for (const s of svcs) { let cs; try { cs = await s.getCharacteristics(); } catch (_) { continue; } for (const c of cs) chars[c.uuid] = c; }
}
function startPoll() {
  stopPoll();
  writeFrame(shortFrame(REG.STATUS));
  pollTimer = setInterval(() => { if (dev && dev.gatt.connected) writeFrame(shortFrame(REG.STATUS)); }, POLL_MS);
  beatTimer = setInterval(() => { if (dev && dev.gatt.connected) writeFrame(shortFrame(REG.HEARTBEAT)); }, HEARTBEAT_MS);
}
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } if (beatTimer) { clearInterval(beatTimer); beatTimer = null; } }
function onDisconnected() {
  stopPoll(); rxBuf = []; writeC = null; notifyC = null; deviceId = null;
  setStatus('disconnected'); setControlsEnabled(false); showControlCards(false); resetTiles();
  const el = $('devinfo'); if (el) el.textContent = ''; logSys('disconnected');
}
function disconnect() { if (dev && dev.gatt.connected) dev.gatt.disconnect(); }

// --------------------------- telemetry (device -> app) ---------------------------
function onNotify(bytes) {
  if (diag) logLine('log-rx', '<<< raw ' + hex(bytes));   // diagnostics: every arriving chunk, pre-reassembly
  for (const x of bytes) rxBuf.push(x);
  while (rxBuf.length >= 5) {
    if (rxBuf[0] !== 0xFF || rxBuf[1] !== 0x55) { rxBuf.shift(); continue; }
    const total = rxBuf[3] + 5;              // FF 55 REG LEN + LEN data + CHK
    if (rxBuf.length < total) break;
    parseFrame(rxBuf.slice(0, total)); rxBuf = rxBuf.slice(total);
  }
}
function parseFrame(f) {
  const reg = f[2], payload = f.slice(4, f.length - 1), chk = f[f.length - 1];
  logRx(f, sum8(f, f.length - 1) === chk ? '' : ' [chk?]');
  autoDetectModel(f);
  decode(reg, payload);
  refreshTele();
}
// Auto-detect the NIUNIU/HUABAN family from the first matching serial reply (same string match as the
// original Joyor app's DeviceDiscoverActivityNew:107-128). Only runs while model is still 'auto'; a
// manual dropdown pick wins and is never overridden.
function autoDetectModel(f) {
  if (model !== 'auto') return;
  if (f[2] !== TELE.serial) return;
  const h = f.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  for (const key of Object.keys(CAR_TYPE_HEX)) {
    if (CAR_TYPE_HEX[key] === h) {
      setModel(key, true);
      logSys('family auto-detected: ' + key + ' (serial match on ' + h + ')');
      return;
    }
  }
}
function decode(reg, payload) {
  switch (reg) {
    case TELE.speed:    tele.speed = numBE(payload) / 1000; break;                 // km/h
    case TELE.trip:     tele.trip = numBE(payload) / 1000; break;                  // km
    case TELE.total:    tele.total = numBE(payload) / 1000; break;                 // km
    case TELE.batt:     tele.batt = numBE(payload); break;                         // percent
    case TELE.temp:     tele.temp = numBE(payload); break;                         // degrees C
    case TELE.runtime:  tele.runtime = numBE(payload) / 60; break;                 // minutes (raw seconds)
    case TELE.serial:   tele.serial = asciiOf(payload); logSys('serial \x01' + tele.serial + '\x01'); break;
    case TELE.version:  tele.version = asciiOf(payload); logSys('version ' + tele.version); break;
    case TELE.model:    tele.model = asciiOf(payload); logSys('model ' + tele.model); break;
    case TELE.lock:     tele.lock = numBE(payload); break;                         // 01 unlocked / 02 locked
    case TELE.light:    tele.light = numBE(payload); break;                        // 01 off / 02 on
    case TELE.fault:    tele.fault = numBE(payload); logSys('self-test bitfield 0x' + tele.fault.toString(16)); break;
    default: /* setting echo or unmapped register - already in the RX log */ break;
  }
}
function refreshTele() {
  setTile('t-speed', tele.speed != null ? tele.speed.toFixed(1) + ' km/h' : null);
  setTile('t-batt', tele.batt != null ? tele.batt + ' %' : null);
  setTile('t-trip', tele.trip != null ? tele.trip.toFixed(2) + ' km' : null);
  setTile('t-total', tele.total != null ? tele.total.toFixed(1) + ' km' : null);
  setTile('t-max', null);       // no top-speed register exists in the app
  setTile('t-lock', tele.lock != null ? (tele.lock === 2 ? t('valLocked') : t('valOpen')) : null);
  setTile('t-light', tele.light != null ? (tele.light === 2 ? t('valOn') : t('valOff')) : null);
  setTile('t-volt', null);      // voltage is not reported by this protocol
  setTile('t-current', null);   // current is not reported by this protocol
  setTile('t-temp', tele.temp != null ? tele.temp + ' C' : null);
  setTile('t-runtime', tele.runtime != null ? tele.runtime.toFixed(1) + ' min' : null);
  setTile('t-err', tele.fault != null ? (tele.fault ? '0x' + tele.fault.toString(16) : '0') : null);
  setTile('t-fw', tele.version || null);
  setTile('t-serial', tele.serial || null);
  setTile('t-model', tele.model || null);
}

// --------------------------- commands (app -> device) ---------------------------
async function writeReg(reg, data, label) { await writeFrame(shortFrame(reg, data)); if (label) logSys(label); }
async function query(reg, val) { await writeFrame(longFrame(reg, val)); }
async function setSpeedCap(kmh) {
  const val = Math.max(0, Math.min(255, Math.round(kmh * 10)));
  await writeFrame(longFrame(REG.SPEED_CAP, val));
  logSys('walk-assist cap ' + kmh + ' km/h (0x38 VAL 0x' + val.toString(16).padStart(2, '0').toUpperCase() + ')');
  if (kmh > 18) logSys('note: the app resets this above 18 km/h; 0x38 caps DOWN only, it never raises the top speed');
}
// Governor command 0x2A - EXPERIMENTAL. Sister-app Lenzod Pro only; Joyor app never sends this.
// Frame FF 55 2A 06 <drive> <brake> <accel> <maxspeed> 00 00 CHK. maxspeed = percent + 128 (0x80 base).
// Controller acceptance is UNKNOWN - documented as untested in the research. Only controllers
// reporting mHardVersion were originally targeted by Lenzod Pro.
async function setGovernor(drivePct, brakePct, accelPct, maxPct) {
  const clamp = (v) => Math.max(0, Math.min(127, Math.round(v)));
  const d = clamp(drivePct), b = clamp(brakePct), a = clamp(accelPct), m = clamp(maxPct);
  const frame = shortFrame(REG.GOVERNOR, [d, b, a, 0x80 + m, 0x00, 0x00]);
  await writeFrame(frame);
  logSys('governor 0x2A sent: drive=' + d + '% brake=' + b + '% accel=' + a + '% maxspeed=' + m + '% (byte 0x' + (0x80 + m).toString(16).padStart(2, '0').toUpperCase() + ')');
  logSys('note: 0x2A is UNTESTED on the controller - only Lenzod Pro sends it, and only for controllers reporting mHardVersion');
}

// --------------------------- GATT primitives ---------------------------
async function subscribe(c, handler) {
  try {
    await c.startNotifications();
    c.addEventListener('characteristicvaluechanged', ev => { const b = Array.from(new Uint8Array(ev.target.value.buffer)); handler(b); });
    return true;
  } catch (e) { logErr('notify failed: ' + e.message); return false; }
}
async function writeFrame(bytes) {
  if (!writeC) { logErr('not connected'); return; }
  const arr = Uint8Array.from(bytes);
  logTx(bytes);
  if (writeC.properties && writeC.properties.write) await writeC.writeValueWithResponse(arr);
  else await writeC.writeValueWithoutResponse(arr);
}
async function guard(fn) { if (busy) return; busy = true; try { await fn(); } catch (e) { logErr(e && e.message ? e.message : String(e)); } finally { busy = false; } }

// --------------------------- document viewer (markdown of our own docs) ---------------------------
const DOC_TITLES = {
  'GUIDE.de.md': 'footGuide', 'GUIDE.en.md': 'footGuide',
  'PRIVACY.de.md': 'footPrivacy', 'PRIVACY.md': 'footPrivacy',
  'LICENSE.de.md': 'footLicense', 'LICENSE.md': 'footLicense',
  'DISCLAIMER.de.md': 'footDisclaimer', 'DISCLAIMER.md': 'footDisclaimer',
  'TRADEMARKS.de.md': 'footTrademarks', 'TRADEMARKS.md': 'footTrademarks',
  'README.md': 'footReadme'
};
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const esc = escHtml;
const slug = s => s.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/ /g, '-');
// inlineMd receives ALREADY-escaped text (mdToHtml escapes first); DOC_TITLES hrefs stay in-modal.
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, href) {
      if (DOC_TITLES[href]) return '<a href="' + href + '" data-docfile="' + href + '">' + text + '</a>';
      return '<a href="' + href + '" target="_blank" rel="noopener">' + text + '</a>';
    });
}
function mdToHtml(md) {
  var codeBlocks = [];
  // 1) pull fenced code blocks out first so their content is never treated as markdown
  md = String(md).replace(/```[^\n]*\n?([\s\S]*?)```/g, function (m, code) {
    var i = codeBlocks.length;
    codeBlocks.push('<pre><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>');
    return '\x00CB' + i + '\x00';
  });
  var lines = md.split(/\r?\n/);
  var out = [], para = [], list = null;
  function flushPara() { if (para.length) { out.push('<p>' + inlineMd(esc(para.join(' '))) + '</p>'); para = []; } }
  function flushList() { if (list) { out.push('<' + list.type + '>' + list.items.join('') + '</' + list.type + '>'); list = null; } }
  function isTableSep(s) { var tt = s.replace(/\s/g, ''); return /^\|?:?-+:?(\|:?-+:?)+\|?$/.test(tt); }
  function splitRow(s) { return s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }); }
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    var cb = ln.match(/^\x00CB(\d+)\x00$/);
    if (cb) { flushPara(); flushList(); out.push(codeBlocks[Number(cb[1])]); continue; }
    if (/^\s*$/.test(ln)) { flushPara(); flushList(); continue; }
    var h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushList(); var lvl = Math.min(h[1].length, 4); out.push('<h' + lvl + '>' + inlineMd(esc(h[2])) + '</h' + lvl + '>'); continue; }
    if (/^---+$/.test(ln.trim())) { flushPara(); flushList(); out.push('<hr>'); continue; }
    if (ln.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {   // GFM table: header, |---| sep, rows
      flushPara(); flushList();
      var head = splitRow(ln); i++;   // consume the separator row
      var body = '';
      while (i + 1 < lines.length && lines[i + 1].indexOf('|') >= 0 && lines[i + 1].trim() !== '') {
        body += '<tr>' + splitRow(lines[++i]).map(function (c) { return '<td>' + inlineMd(esc(c)) + '</td>'; }).join('') + '</tr>';
      }
      out.push('<table><thead><tr>' + head.map(function (c) { return '<th>' + inlineMd(esc(c)) + '</th>'; }).join('') + '</tr></thead><tbody>' + body + '</tbody></table>');
      continue;
    }
    if (/^\s*>/.test(ln)) {                             // merge consecutive > lines into ONE callout
      flushPara(); flushList();
      var q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      i--;                                              // step back; the for-loop re-increments
      while (q.length && /^\s*$/.test(q[0])) q.shift();
      while (q.length && /^\s*$/.test(q[q.length - 1])) q.pop();
      if (q.length) out.push('<blockquote>' + mdToHtml(q.join('\n')) + '</blockquote>');  // inner rendered as markdown
      continue;
    }
    var ul = ln.match(/^\s*[-*]\s+(.*)$/);
    var ol = ln.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      var type = ul ? 'ul' : 'ol';
      if (!list || list.type !== type) { flushList(); list = { type: type, items: [] }; }
      list.items.push('<li>' + inlineMd(esc((ul ? ul[1] : ol[1]))) + '</li>');
      continue;
    }
    para.push(ln.trim());
  }
  flushPara(); flushList();
  return out.join('\n');
}
const docCache = {};
const docFile = name => { if (name === 'GUIDE') return 'GUIDE.' + lang + '.md'; if (name === 'README') return 'README.md'; return lang === 'de' ? name + '.de.md' : name + '.md'; };
function openDocFile(file, titleKey) {
  const dlg = $('doc'), body = $('doc-body'); if (!dlg || !body) return;
  const mark = (lang === 'de' && !file.includes('.de.') && file !== 'README.md') ? ' ' + t('docEnglish') : '';
  $('doc-title').textContent = (t(titleKey || DOC_TITLES[file] || '') || file) + mark;
  if (typeof dlg.showModal === 'function') dlg.showModal();
  const showDoc = html => { body.innerHTML = html; const h1 = body.querySelector('h1'); if (h1) { $('doc-title').textContent = h1.textContent.trim() + mark; h1.remove(); } body.scrollTop = 0; }; // scan-ok: markdown of our own documents, escaped by mdToHtml first
  if (docCache[file]) { showDoc(docCache[file]); return; }
  body.innerHTML = '<p>' + escHtml(t('docLoading')) + '</p>'; // scan-ok: escaped
  fetch(file + '?v=' + BUILD).then(r => { if (!r.ok) throw new Error(r.status + ' ' + r.statusText); return r.text(); })
    .then(txt => { docCache[file] = mdToHtml(txt); showDoc(docCache[file]); })
    .catch(e => { body.innerHTML = '<p>' + escHtml(t('docFail')) + '</p><pre class="log-err">' + escHtml(file + ': ' + (e && e.message ? e.message : e)) + '</pre>'; }); // scan-ok: escaped
}
function wireDocViewer() {
  document.addEventListener('click', e => {
    if (!e.target.closest) return;
    const disc = e.target.closest('[data-open-disclaimer]'); if (disc) { e.preventDefault(); openDocFile(docFile('DISCLAIMER'), 'footDisclaimer'); return; }
    const a = e.target.closest('[data-doc], [data-docfile]'); if (!a) return;
    e.preventDefault();
    const file = a.getAttribute('data-docfile');
    if (file) openDocFile(file, a.getAttribute('data-t') || '');
    else openDocFile(docFile(a.getAttribute('data-doc')), a.getAttribute('data-t') || '');
  });
  ['doc-x', 'doc-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', () => { const d = $('doc'); if (d) d.close(); }); });
}

// --------------------------- help ---------------------------
const HELP = { live: ['liveTitle', 'liveHint'], batt: ['help_batt_t', 'help_batt_b'], speed: ['s3Title', 'speedValuesHint'], mode: ['modeTitle', 'modeHint'], more: ['moreTitle', 'moreHint'], immob: ['immobTitle', 'immobHint'], expert: ['expertTitle', 'expertHint'], publiclog: ['publicLogTitle', 'publicLogHelpHtml'], diaglog: ['diagLogTitle', 'diagLogHelpHtml'] };
function openHelp(key) {
  const m = HELP[key]; if (!m) return; const dlg = $('help'); if (!dlg) return;
  $('help-title').textContent = t(m[0]);
  const bo = $('help-body'); if (bo) { const v = t(m[1]); if (/[<&]/.test(v)) bo.innerHTML = v; else bo.textContent = v; } // scan-ok: our own translation table
  if (dlg.showModal) { try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); } } else dlg.setAttribute('open', '');
}
function closeHelp() { const dlg = $('help'); if (dlg && dlg.close) dlg.close(); }

// --------------------------- init ---------------------------
window.addEventListener('DOMContentLoaded', () => {
  initLangSwitch();
  initTheme();
  wireDocViewer();
  buildModelDropdown();

  let savedModel = null; try { savedModel = localStorage.getItem(LS.MODEL); } catch (e) {}
  setModel((savedModel === 'auto' || MODELS[savedModel]) ? savedModel : 'auto', false);
  applyLang();
  setStatus('disconnected');
  setControlsEnabled(false);
  logDiagnosticHeader();

  $('model-in').addEventListener('change', e => { setModel(e.target.value, true); const c = cap(); logLine('', 'model: ' + (c ? c.label : 'auto detect') + ' [self-test: ' + (c ? c.selfTest : 'family unknown') + ']'); });
  $('btn-conn').addEventListener('click', () => { if ($('btn-conn').dataset.act === 'disconnect') disconnect(); else guard(connect); });

  $('btn-setspeed').addEventListener('click', () => guard(() => {
    const v = parseFloat($('speed-kmh').value);
    if (!(v >= 1 && v <= 25.5)) { logErr('enter a value 1..25 km/h'); return Promise.resolve(); }
    return setSpeedCap(v);
  }));
  $('btn-mode').addEventListener('click', () => guard(() => writeReg(REG.DRIVE_MODE, [parseInt($('mode-in').value, 10) & 0xff], 'drive mode ' + $('mode-in').value)));
  $('btn-light').addEventListener('click', () => guard(() => writeReg(REG.HEADLIGHT, [parseInt($('light-in').value, 10) & 0xff], 'light ' + ($('light-in').value === '2' ? 'on' : 'off'))));
  $('btn-cruise').addEventListener('click', () => guard(() => writeReg(REG.CRUISE, [parseInt($('cruise-in').value, 10) & 0xff], 'cruise ' + ($('cruise-in').value === '1' ? 'on' : 'off'))));
  $('btn-startmode').addEventListener('click', () => guard(() => writeReg(REG.START_MODE, [parseInt($('startmode-in').value, 10) & 0xff], 'start mode ' + $('startmode-in').value)));
  $('btn-unit').addEventListener('click', () => guard(() => writeReg(REG.UNIT, [parseInt($('unit-in').value, 10) & 0xff], 'unit ' + ($('unit-in').value === '1' ? 'km/h' : 'mph'))));
  $('btn-gear').addEventListener('click', () => guard(() => writeReg(REG.GEAR, [parseInt($('gear-in').value, 10) & 0xff], 'gear ' + $('gear-in').value)));
  $('btn-lamp').addEventListener('click', () => guard(() => writeReg(REG.LAMP, [parseInt($('lamp-in').value, 10) & 0xff], 'lamp mode ' + $('lamp-in').value)));
  // RGB lamp colour (0x15, FF551503 RR GG BB): three data bytes from the colour picker, additive checksum.
  $('btn-rgb').addEventListener('click', () => guard(() => {
    const h = ($('rgb-in').value || '#000000').replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) || 0, g = parseInt(h.slice(2, 4), 16) || 0, b = parseInt(h.slice(4, 6), 16) || 0;
    return writeReg(REG.RGB, [r, g, b], 'lamp colour #' + h.toUpperCase());
  }));
  $('btn-voltage').addEventListener('click', () => guard(() => writeReg(REG.VOLTAGE, [parseInt($('voltage-in').value, 10) & 0xff], 'voltage class ' + $('voltage-in').value)));
  $('btn-wheel').addEventListener('click', () => guard(() => writeReg(REG.WHEEL, [parseInt($('wheel-in').value, 10) & 0xff], 'wheel size index ' + $('wheel-in').value)));
  $('btn-selftest').addEventListener('click', () => guard(() => writeReg(REG.SELFTEST, [0x00, 0x00], 'self-test requested')));
  // Vehicle-info: re-request the proven identity strings (serial 0x61, versions 0x3B, model 0x3C).
  $('btn-info').addEventListener('click', () => guard(async () => { logSys('vehicle-info query'); await query(REG.Q_SERIAL); await query(REG.Q_VERSIONS); await query(REG.Q_MODEL); }));

  $('btn-immob-unlock').addEventListener('click', () => guard(() => writeReg(REG.LOCK, [0x01], 'unlock')));
  $('btn-immob-lock').addEventListener('click', () => guard(() => writeReg(REG.LOCK, [0x02], 'lock')));

  $('btn-writereg').addEventListener('click', () => guard(() => writeReg(parseInt($('reg-nr').value, 10) & 0xff, valBytes(parseInt($('reg-val').value, 10) || 0), 'expert write')));
  $('btn-readreg').addEventListener('click', () => guard(() => query(parseInt($('read-addr').value, 10) & 0xff, parseInt($('read-val').value, 10) & 0xff)));
  $('btn-raw').addEventListener('click', () => guard(() => { const b = parseHex($('raw-hex').value); if (b.length < 3) { logErr('too short'); return Promise.resolve(); } b.push(sum8(b)); return writeFrame(b); }));
  $('btn-raw-plain').addEventListener('click', () => guard(() => { const b = parseHex($('raw-hex').value); if (!b.length) { logErr('no bytes'); return Promise.resolve(); } return writeFrame(b); }));
  $('btn-governor').addEventListener('click', () => guard(() => {
    const d = parseInt($('gov-drive').value, 10) || 0;
    const b = parseInt($('gov-brake').value, 10) || 0;
    const a = parseInt($('gov-accel').value, 10) || 0;
    const m = parseInt($('gov-max').value, 10) || 0;
    return setGovernor(d, b, a, m);
  }));

  document.querySelectorAll('.help-btn').forEach(btn => btn.addEventListener('click', () => openHelp(btn.getAttribute('data-help'))));
  ['help-x', 'help-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', closeHelp); });
  { const b = $('link-disclaimer'); if (b) b.addEventListener('click', e => { e.preventDefault(); openDocFile(docFile('DISCLAIMER'), 'footDisclaimer'); }); }

  $('btn-copy-log').addEventListener('click', copyLog);
  $('btn-clear-log').addEventListener('click', clearLog);
  $('btn-save-log').addEventListener('click', saveLog);

  // Public-Log anonymize: default ON, persisted; flipping it re-renders the pane from the raw buffer.
  { const cb = $('public-log');
    if (cb) {
      let saved = '1'; try { saved = localStorage.getItem(LS.PUBLICLOG) || '1'; } catch (e) {}
      publicLog = saved !== '0'; cb.checked = publicLog;
      cb.addEventListener('change', () => { publicLog = cb.checked; try { localStorage.setItem(LS.PUBLICLOG, cb.checked ? '1' : '0'); } catch (e) {} logSys('public-log: ' + (cb.checked ? 'on (anonymizing device name/id)' : 'off')); renderLog(); });
    } }
  // Diagnostics: default OFF each session (not persisted); taps every raw notify chunk.
  { const cb = $('diag-log');
    if (cb) { diag = false; cb.checked = false; cb.addEventListener('change', () => { setDiag(cb.checked); logSys('diag-log: ' + (cb.checked ? 'on' : 'off')); logLine('log-rx', diag ? t('diagOn') : t('diagOff')); }); } }
  // Show-all-devices toggle: no scan-side effect here (requestDevice already uses acceptAllDevices), just log the flip.
  { const sa = $('showall'); if (sa) sa.addEventListener('change', () => { logSys('show-all-devices: ' + (sa.checked ? 'on' : 'off')); }); }
});
