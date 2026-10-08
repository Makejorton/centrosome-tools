/* Centrosome Tools: firmware updater + patch editor. Static page, no build step, no dependencies.
 *
 * STATUS: the page and the DEMO DEVICE work. The USB side is written against a PROPOSED line protocol
 * (newline-delimited JSON over Web Serial, see SerialTransport). The device-side daemon that would
 * answer it (plan Phase U2) does not exist yet, so a real unit will not respond until it does.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- small helpers ---------- */
  function log(msg) {
    var el = $('log');
    el.textContent += (el.textContent ? '\n' : '') + msg;
    el.scrollTop = el.scrollHeight;
  }
  function store(key, val) { try { if (val === undefined) return JSON.parse(localStorage.getItem(key)); localStorage.setItem(key, JSON.stringify(val)); } catch (e) { return null; } }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  var CRC_T = (function () { var t = [], c, n, k; for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(bytes) { var c = 0xFFFFFFFF; for (var i = 0; i < bytes.length; i++) c = CRC_T[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function b64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }

  /* ---------- transports ---------- */
  /* PROVISIONAL protocol (device side not built; the unit's author will adopt it with these changes): one JSON
     object per line. Requests {"id":N,"cmd":...}, replies {"id":N,"ok":true,...} or {"id":N,"ok":false,"error":"..."}.
       hello        -> {fw, build, slot, freeMb, imageVersion, patchStateVersion, fields:[PatchState keys it supports]}
       update.begin {size, sha256, version, release, keyId, allowDowngrade, sig}   sig = Ed25519 over the manifest, made
                    offline; the unit refuses unsigned, untrusted-key, and older-release packages (downgrade protection)
       update.chunk {seq, crc32, data(base64)}     -> {next}: the offset the unit wants next, so a dropped cable resumes
       update.end   -> {state:"verifying"}; then poll `status` -> {state: verifying|healthy|rolled_back|failed, detail}
       patch.get    {index} -> {values}   what the unit has saved for that patch
       patch.put    {index, patchStateVersion, values} -> {state:"applying"}; poll status for patch_saved / patch_failed.
                    Only changed fields are sent; the unit stops the firmware for a few seconds to write the file.
     The serial baud rate is a placeholder (a USB CDC-ACM gadget ignores it): never estimate time from it. */
  function SerialTransport() { this.name = 'USB SERIAL'; this.port = null; this.nextId = 1; this.pending = {}; }
  SerialTransport.prototype.connect = async function () {
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: 115200 });
    var self = this, dec = new TextDecoderStream();
    this.port.readable.pipeTo(dec.writable).catch(function () {});
    var reader = dec.readable.getReader(), buf = '';
    (async function () {
      try { for (;;) { var r = await reader.read(); if (r.done) break; buf += r.value; var nl;
        while ((nl = buf.indexOf('\n')) >= 0) { var line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue; var m; try { m = JSON.parse(line); } catch (e) { continue; }
          var p = self.pending[m.id]; if (p) { delete self.pending[m.id]; p(m); } } } } catch (e) {}
    })();
    var enc = new TextEncoderStream(); enc.readable.pipeTo(this.port.writable).catch(function () {});
    this.writer = enc.writable.getWriter();
  };
  SerialTransport.prototype.request = function (cmd, args) {
    var self = this, id = this.nextId++, msg = Object.assign({ id: id, cmd: cmd }, args || {});
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { delete self.pending[id]; reject(new Error('no reply from the unit (' + cmd + ')')); }, 8000);
      self.pending[id] = function (m) { clearTimeout(t); m.ok ? resolve(m) : reject(new Error(m.error || 'unit refused ' + cmd)); };
      self.writer.write(JSON.stringify(msg) + '\n').catch(reject);
    });
  };
  SerialTransport.prototype.close = async function () { try { if (this.writer) await this.writer.close(); if (this.port) await this.port.close(); } catch (e) {} };

  function DemoTransport() { this.name = 'DEMO (NO HARDWARE)'; }
  DemoTransport.prototype.connect = async function () {};
  DemoTransport.prototype.close = async function () {};
  DemoTransport.prototype.request = async function (cmd, args) {
    await sleep(cmd === 'update.chunk' ? 4 : 120);
    if (cmd === 'hello') return { ok: true, fw: '0.0.0-demo', build: 'demo00000', slot: 'A', freeMb: 49000, imageVersion: '0.0.0-demo', patchStateVersion: 3,
      fields: Object.keys(SCHEMA).filter(function (k) { return k !== 'sessionTempoBPM'; }) };   // demo leaves one out to show the greyed state
    if (cmd === 'update.chunk') return { ok: true, next: args.seq + 1 };
    if (cmd === 'patch.get') { var v = {}; Object.keys(SCHEMA).forEach(function (k) { v[k] = SCHEMA[k].def; }); return { ok: true, values: v }; }
    if (cmd === 'patch.put') return { ok: true, state: 'applying', skipped: [] };
    if (cmd === 'status') return { ok: true, state: 'patch_saved' };
    return { ok: true };
  };

  /* ---------- connection + status ---------- */
  var transport = null, mode = 'off', hello = null, deviceFields = null;
  function setMode(m, label) {
    mode = m;
    var st = $('status');
    st.className = 'status' + (m === 'on' ? ' on' : m === 'demo' ? ' demo' : '');
    st.querySelector('span').textContent = label;
    $('c-status').textContent = label;
    $('btn-connect').hidden = $('btn-demo').hidden = m !== 'off';
    $('btn-disconnect').hidden = m === 'off';
    $('pt-send').disabled = m === 'off';
    refreshUpdate();
  }
  async function connect(t) {
    try {
      transport = t; await t.connect();
      $('c-transport').textContent = t.name;
      log('Connected: ' + t.name);
      var h = await t.request('hello'); hello = h;
      deviceFields = h.fields ? new Set(h.fields) : null; renderParams(); loadFromUnit();
      $('d-fw').textContent = h.fw + (h.release != null ? ' (release ' + h.release + ')' : ''); $('d-psv').textContent = h.patchStateVersion != null ? 'v' + h.patchStateVersion : '–'; $('d-build').textContent = h.build; $('d-slot').textContent = h.slot;
      $('d-free').textContent = h.freeMb != null ? Math.round(h.freeMb / 1024) + ' GB' : '–';
      setMode(t instanceof DemoTransport ? 'demo' : 'on', t instanceof DemoTransport ? 'DEMO DEVICE' : 'CONNECTED');
    } catch (e) {
      log('Could not connect: ' + (e.name === 'NotFoundError' ? 'no port chosen' : e.message));
      if (transport) { try { await transport.close(); } catch (x) {} }
      transport = null; setMode('off', 'NOT CONNECTED');
    }
  }
  async function disconnect() {
    if (transport) await transport.close();
    transport = null; hello = null; deviceFields = null; renderParams(); $('c-transport').textContent = '–';
    ['d-fw', 'd-psv', 'd-build', 'd-slot', 'd-free'].forEach(function (i) { $(i).textContent = '–'; });
    setMode('off', 'NOT CONNECTED'); log('Disconnected.');
  }

  /* ---------- update ---------- */
  var pkg = null, man = null;
  function refreshUpdate() {
    var ok = mode !== 'off' && pkg && man && man.sha256 === pkg.sha;
    $('btn-update').disabled = !ok;
    $('u-hint').textContent = ok ? (mode === 'demo' ? 'Demo device: nothing real is written.' : 'Ready. Keep the unit powered and plugged in.')
                                 : (mode === 'off' ? 'Connect a unit first.' : !pkg ? 'Choose a package.' : !man ? 'Choose its signed manifest (.json).' : 'The manifest does not match this package.');
  }
  $('p-input').addEventListener('change', async function (e) {
    var f = e.target.files[0]; if (!f) return;
    var bytes = new Uint8Array(await f.arrayBuffer());
    pkg = { name: f.name, bytes: bytes };
    $('p-file').textContent = f.name; $('p-size').textContent = (bytes.length / 1048576).toFixed(2) + ' MB';
    try { pkg.sha = hex(await crypto.subtle.digest('SHA-256', bytes)); $('p-hash').textContent = pkg.sha.slice(0, 16) + '…'; $('p-hash').title = pkg.sha; }
    catch (x) { $('p-hash').textContent = 'unavailable'; }
    log('Package ready: ' + f.name); refreshUpdate();
  });
  $('m-input').addEventListener('change', async function (e) {
    var f = e.target.files[0]; if (!f) return;
    try {
      var m = JSON.parse(await f.text());
      if (typeof m.sha256 !== 'string' || typeof m.version !== 'string' || typeof m.sig !== 'string' || typeof m.keyId !== 'string' || typeof m.release !== 'number')
        throw new Error('needs version, release, sha256, keyId and sig (make it with make-package.py)');
      man = m; $('m-ver').textContent = m.version + ' (release ' + m.release + (m.allowDowngrade ? ', downgrade allowed' : '') + ')'; log('Manifest loaded: version ' + m.version + '. The unit checks the signature itself.');
    } catch (x) { man = null; $('m-ver').textContent = '–'; log('Manifest not usable: ' + x.message); }
    refreshUpdate();
  });
  function progress(p) { $('u-bar').style.width = p + '%'; $('u-pct').textContent = Math.round(p) + '%'; }
  $('btn-update').addEventListener('click', async function () {
    if (!pkg || mode === 'off') return;
    if (!confirm('Update the unit with ' + pkg.name + '?\nDo not unplug it until this page says the update is finished.')) return;
    var btn = $('btn-update'); btn.disabled = true; progress(0);
    try {
      log('Starting update…');
      await transport.request('update.begin', { size: pkg.bytes.length, sha256: pkg.sha, version: man.version, release: man.release,
                                                 keyId: man.keyId, allowDowngrade: !!man.allowDowngrade, sig: man.sig });
      var CH = 4096, n = Math.ceil(pkg.bytes.length / CH), i = 0, guard = 0;
      while (i < n) {                         // the unit says which chunk it wants next, so a resume or a repeat is its call
        var part = pkg.bytes.subarray(i * CH, (i + 1) * CH);
        var r = await transport.request('update.chunk', { seq: i, crc32: crc32(part), data: b64(part) });
        if (typeof r.next !== 'number' || r.next < 0 || r.next > n) throw new Error('unit asked for an impossible chunk');
        if (++guard > n * 3 + 10) throw new Error('too many repeated chunks');
        i = r.next; progress((i / n) * 95);
      }
      log('Sent. The unit is checking the signature…');
      var end = await transport.request('update.end');
      progress(97);
      if (end.state === 'verifying') {          // the unit swapped the firmware and is restarting; wait for its verdict
        log('Installed. The unit is restarting and checking the new firmware\u2026');
        var verdict = null;
        for (var k = 0; k < 90 && !verdict; k++) {
          await sleep(2000);
          try { var st = await transport.request('status'); if (st.state && st.state !== 'verifying') verdict = st; } catch (x) { /* the port may drop for a moment during the restart */ }
        }
        if (!verdict) throw new Error('no answer from the unit after the restart; check it before using it');
        if (verdict.state !== 'healthy') throw new Error('the unit went back to its previous firmware (' + verdict.state + (verdict.detail ? ': ' + verdict.detail : '') + ')');
        log('New firmware confirmed: ' + (verdict.detail || 'healthy') + '.');
      }
      progress(100); log('Update finished.');
    } catch (e) { log('UPDATE FAILED: ' + e.message); }
    refreshUpdate();
  });
  $('btn-connect').addEventListener('click', function () { connect(new SerialTransport()); });
  $('btn-demo').addEventListener('click', function () { connect(new DemoTransport()); });
  $('btn-disconnect').addEventListener('click', disconnect);

  /* ---------- patch editor ---------- */
  var NAMES = ['My Mood Master', 'Colours', 'Blood Cancer', 'Lace Monitor', 'Overwhelm', 'Vintage Fashion', 'Chikuma-Type', 'Kaseo-Sama',
    'Dangerous Men', 'UNO!', "Worley's Cicadas", 'Cruel Futility', 'War on Time', 'Gigantic Knot', 'Time = God', 'LIVE'];
  var BANKS = ['MAIN', 'SUB', 'OCT'];
  var FILTERS = ['LPF', 'HPF', 'BPF'];
  /* Defaults mirror PatchState in BelaMain.cpp; ranges follow the firmware clamps where one exists
     (tune +-24 st, fine +-50 cents, EQ +-18 dB, comp threshold -60..0 dBFS, Q 0.3..8). Others are
     conservative display ranges. Check them against the firmware before enabling SEND on real units. */
  function bank(key, label, o) { return BANKS.map(function (b, i) { return Object.assign({ key: key + '.' + i, label: b + ' ' + label }, o); }); }
  var GROUPS = [
    { id: 'A', title: 'PITCH & SOURCE', f: [].concat(
      [{ key: 'tuneSemis', label: 'GLOBAL TUNE', t: 'int', min: -24, max: 24, def: 0, unit: 'st' },
       { key: 'sensitivityIdx', label: 'SLICE SENSITIVITY', t: 'int', min: 0, max: 7, def: 1, unit: '0-7' }],
      bank('bankTuneSemis', 'TUNE', { t: 'int', min: -24, max: 24, def: 0, unit: 'st' }),
      bank('bankFineCents', 'FINE', { t: 'num', min: -50, max: 50, step: 1, def: 0, unit: 'ct' })) },
    { id: 'B', title: 'PLAY MODE', f: [].concat(
      bank('bankStretchMode', 'STRETCH', { t: 'bool', def: false }),
      bank('bankGateMode', 'GATE', { t: 'bool', def: true }),
      [{ key: 'velCurveIdx', label: 'VELOCITY CURVE', t: 'sel', opts: ['OFF', 'LINEAR', 'POWER 2', 'POWER 3', 'EXP', 'POWER 4'], def: 5 },
       { key: 'velDepth', label: 'VELOCITY DEPTH', t: 'num', min: 0, max: 1, step: .01, def: 1 }]) },
    { id: 'C', title: 'ENVELOPE', hint: 'PER-BANK VALUES OF -1 FOLLOW THE GLOBAL ONE', f: [].concat(
      [{ key: 'envAttack', label: 'ATTACK', t: 'num', min: .001, max: 2, step: .001, def: .001, unit: 's' },
       { key: 'envRelease', label: 'RELEASE', t: 'num', min: .01, max: 2, step: .001, def: .025, unit: 's' }],
      bank('bankEnvAttack', 'ATTACK', { t: 'num', min: -1, max: 2, step: .001, def: -1, unit: 's' }),
      bank('bankEnvRelease', 'RELEASE', { t: 'num', min: -1, max: 2, step: .001, def: -1, unit: 's' })) },
    { id: 'D', title: 'FX SENDS', f: [
      ['fxReverbSend', 'REVERB', 0], ['fxDelaySend', 'DELAY', 0], ['fxChorusSend', 'CHORUS', 0], ['fxDriveAmount', 'DRIVE', 0],
      ['fxReverseSend', 'REVERSE', 0], ['fxCrushAmount', 'CRUSH', 0], ['fxDelayFeedback', 'DELAY FEEDBACK', .3], ['fxReverbSize', 'REVERB SIZE', .5]
    ].map(function (a) { return { key: a[0], label: a[1], t: 'num', min: 0, max: 1, step: .01, def: a[2] }; }) },
    { id: 'E', title: 'BANK SENDS', hint: '-1 FOLLOWS THE GLOBAL SEND', f: [].concat(
      bank('bankReverbSend', 'REVERB', { t: 'num', min: -1, max: 1, step: .01, def: -1, unit: '' }),
      bank('bankDelaySend', 'DELAY', { t: 'num', min: -1, max: 1, step: .01, def: -1, unit: '' })) },
    { id: 'F', title: 'BANK FILTER / DRIVE', f: [].concat(
      bank('bankFilterType', 'FILTER', { t: 'sel', opts: FILTERS, def: 0 }),
      bank('bankFilterCutoff', 'CUTOFF', { t: 'num', min: 20, max: 20000, step: 1, def: 20000, unit: 'Hz' }),
      bank('bankFilterResonance', 'RESONANCE', { t: 'num', min: .3, max: 8, step: .01, def: .707 }),
      bank('bankDriveAmount', 'DRIVE', { t: 'num', min: 0, max: 1, step: .01, def: 0 }),
      bank('bankCrushAmount', 'CRUSH', { t: 'num', min: 0, max: 1, step: .01, def: 0 })) },
    { id: 'G', title: 'MASTER EQ', f: [].concat(
      [['eqLowGain', 'LOW GAIN'], ['eqLowMidGain', 'LOW-MID GAIN'], ['eqHighMidGain', 'HIGH-MID GAIN'], ['eqHighGain', 'HIGH GAIN']]
        .map(function (a) { return { key: a[0], label: a[1], t: 'num', min: -18, max: 18, step: .5, def: 0, unit: 'dB' }; }),
      [['eqLowFreq', 'LOW FREQ', 100], ['eqLowMidFreq', 'LOW-MID FREQ', 800], ['eqHighMidFreq', 'HIGH-MID FREQ', 3300], ['eqHighFreq', 'HIGH FREQ', 10000]]
        .map(function (a) { return { key: a[0], label: a[1], t: 'num', min: 20, max: 20000, step: 1, def: a[2], unit: 'Hz' }; }),
      [{ key: 'eqLowIsShelf', label: 'LOW IS SHELF', t: 'bool', def: false }, { key: 'eqHighIsShelf', label: 'HIGH IS SHELF', t: 'bool', def: false },
       { key: 'eqBypassed', label: 'EQ BYPASS', t: 'bool', def: false }]) },
    { id: 'H', title: 'COMPRESSOR / FILTER / TEMPO', f: [
      { key: 'compThreshold', label: 'COMP THRESHOLD', t: 'num', min: -60, max: 0, step: .5, def: -20, unit: 'dBFS' },
      { key: 'compRatio', label: 'COMP RATIO', t: 'num', min: 1, max: 20, step: .1, def: 2, unit: ': 1' },
      { key: 'filterType', label: 'MASTER FILTER', t: 'sel', opts: FILTERS, def: 0 },
      { key: 'sessionTempoBPM', label: 'SESSION TEMPO', t: 'num', min: 30, max: 300, step: .1, def: 120, unit: 'BPM' }] }
  ];
  var SCHEMA = {}; GROUPS.forEach(function (g) { g.f.forEach(function (f) { SCHEMA[f.key] = f; }); });
  function defaults() { var v = {}; Object.keys(SCHEMA).forEach(function (k) { v[k] = SCHEMA[k].def; }); return v; }
  function clamp(f, x) {
    if (f.t === 'bool') return !!x;
    if (f.t === 'sel') { x = Math.round(+x); return x >= 0 && x < f.opts.length ? x : f.def; }
    x = +x; if (!isFinite(x)) return f.def;
    x = Math.min(f.max, Math.max(f.min, x)); return f.t === 'int' ? Math.round(x) : x;
  }

  var patches = (function () {
    var saved = store('centrosome.patches.v1') || {}, out = [];
    for (var i = 0; i < 16; i++) { var v = defaults(); Object.keys(saved[i] || {}).forEach(function (k) { if (SCHEMA[k]) v[k] = clamp(SCHEMA[k], saved[i][k]); }); out.push(v); }
    return out;
  })();
  var cur = 0;
  function persist() { var o = {}; patches.forEach(function (p, i) { var d = {}; Object.keys(p).forEach(function (k) { if (p[k] !== SCHEMA[k].def) d[k] = p[k]; }); if (Object.keys(d).length) o[i] = d; }); store('centrosome.patches.v1', o); }
  function edited(i) { return Object.keys(patches[i]).some(function (k) { return patches[i][k] !== SCHEMA[k].def; }); }

  function renderList() {
    var ol = $('plist'); ol.textContent = '';
    NAMES.forEach(function (n, i) {
      var li = document.createElement('li'); li.tabIndex = 0; li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === cur ? 'true' : 'false'); li.className = edited(i) ? 'edited' : '';
      li.textContent = (i + 1) + '. ' + n;
      li.onclick = function () { cur = i; renderList(); renderParams(); loadFromUnit(); };
      li.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.onclick(); } };
      ol.appendChild(li);
    });
  }
  function renderParams() {
    var root = $('params'); root.textContent = ''; var v = patches[cur];
    GROUPS.forEach(function (g) {
      var box = document.createElement('section'); box.className = 'pgroup';
      var h = document.createElement('h3'); h.innerHTML = '<b class="tag">' + g.id + '</b>'; h.appendChild(document.createTextNode(g.title)); box.appendChild(h);
      if (g.hint) { var hp = document.createElement('p'); hp.className = 'note small'; hp.textContent = g.hint; hp.style.margin = '0 0 6px'; box.appendChild(hp); }
      g.f.forEach(function (f, n) {
        var row = document.createElement('div'), id = 'f-' + f.key.replace('.', '-'), inp;
        row.className = 'prow' + (v[f.key] !== f.def ? ' chg' : '');
        var lab = document.createElement('label'); lab.htmlFor = id; lab.textContent = f.label;
        if (f.unit) { var u = document.createElement('span'); u.className = 'unit'; u.textContent = ' ' + f.unit; lab.appendChild(u); }
        if (f.t === 'bool') { inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!v[f.key]; }
        else if (f.t === 'sel') { inp = document.createElement('select'); f.opts.forEach(function (o, k) { var op = document.createElement('option'); op.value = k; op.textContent = o; inp.appendChild(op); }); inp.value = v[f.key]; }
        else { inp = document.createElement('input'); inp.type = 'number'; inp.min = f.min; inp.max = f.max; inp.step = f.step || 1; inp.value = v[f.key]; }
        inp.id = id;
        if (deviceFields && !deviceFields.has(f.key)) { inp.disabled = true; row.title = 'This unit does not support this setting'; row.style.opacity = '.4'; }
        inp.onchange = function () {
          v[f.key] = clamp(f, f.t === 'bool' ? inp.checked : inp.value);
          if (f.t !== 'bool') inp.value = v[f.key];
          row.className = 'prow' + (v[f.key] !== f.def ? ' chg' : ''); persist();
          var li = $('plist').children[cur]; li.className = edited(cur) ? 'edited' : '';
        };
        row.appendChild(lab); row.appendChild(inp); box.appendChild(row);
      });
      root.appendChild(box);
    });
  }
  /* With a unit connected, each patch is read from the unit when you open it, and SEND writes only the settings you
     changed since then, so nothing you did not touch is overwritten. */
  var baseline = {};
  async function loadFromUnit() {
    if (!transport || !deviceFields || !deviceFields.size) return;
    var i = cur;
    try {
      var r = await transport.request('patch.get', { index: i });
      Object.keys(r.values).forEach(function (k) { if (SCHEMA[k]) patches[i][k] = clamp(SCHEMA[k], r.values[k]); });
      baseline[i] = Object.assign({}, patches[i]); persist();
      if (i === cur) { renderList(); renderParams(); }
    } catch (e) { baseline[i] = null; log('Patch ' + (i + 1) + ' not read from the unit: ' + e.message); }
  }
  $('pt-reset').onclick = function () { if (!edited(cur) || confirm('Reset patch ' + (cur + 1) + ' (' + NAMES[cur] + ') to factory values?')) { patches[cur] = defaults(); persist(); renderList(); renderParams(); } };
  $('pt-export').onclick = function () {
    var blob = new Blob([JSON.stringify({ format: 'centrosome-patch', version: 3, index: cur + 1, name: NAMES[cur], values: patches[cur] }, null, 2)], { type: 'application/json' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'centrosome-patch-' + (cur + 1) + '.json'; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  };
  $('pt-import').onclick = function () { $('pt-file').click(); };
  $('pt-file').onchange = async function (e) {
    var f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      var d = JSON.parse(await f.text()); if (d.format !== 'centrosome-patch' || !d.values) throw new Error('not a Centrosome patch file');
      var v = defaults(), n = 0; Object.keys(d.values).forEach(function (k) { if (SCHEMA[k]) { v[k] = clamp(SCHEMA[k], d.values[k]); n++; } });
      patches[cur] = v; persist(); renderList(); renderParams(); alert('Imported ' + n + ' values into patch ' + (cur + 1) + '.');
    } catch (x) { alert('Could not import: ' + x.message); }
  };
  $('pt-send').onclick = async function () {
    if (!transport) return;
    if (!baseline[cur]) { alert('Read this patch from the unit first: select it again while connected.'); return; }
    var vals = {}, n = 0;
    Object.keys(patches[cur]).forEach(function (k) { if (deviceFields && deviceFields.has(k) && patches[cur][k] !== baseline[cur][k]) { vals[k] = patches[cur][k]; n++; } });
    if (!n) { alert('Nothing changed since this patch was read from the unit.'); return; }
    if (!confirm('Save ' + n + ' changed setting(s) to patch ' + (cur + 1) + ' (' + NAMES[cur] + ') on the unit?\nThe unit goes silent for a few seconds while it saves.')) return;
    try {
      var put = await transport.request('patch.put', { index: cur, patchStateVersion: hello ? hello.patchStateVersion : undefined, values: vals });
      log('Saving ' + n + ' setting(s) to patch ' + (cur + 1) + '\u2026');
      if (put.skipped && put.skipped.length) log('Not stored (older patch file on the unit): ' + put.skipped.join(', '));
      var done = false;
      for (var k = 0; k < 60 && !done; k++) {
        await sleep(1000);
        var st; try { st = await transport.request('status'); } catch (x) { continue; }
        if (st.state === 'patch_saved') { done = true; baseline[cur] = Object.assign({}, patches[cur]); log('Patch ' + (cur + 1) + ' saved on the unit.'); }
        else if (st.state === 'patch_failed') throw new Error(st.detail || 'the unit could not save it');
      }
      if (!done) throw new Error('no answer from the unit; check the patch on the instrument');
      if (mode === 'demo') alert('Demo device: nothing was written.');
    } catch (e) { alert('Not saved: ' + e.message); }
  };

  /* ---------- tabs, banner ---------- */
  function showTab(name) {
    ['update', 'patches'].forEach(function (t) {
      var on = t === name; $('view-' + t).hidden = !on; var b = $('tab-' + t);
      b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }
  document.querySelectorAll('.tab').forEach(function (b) { b.onclick = function () { showTab(b.dataset.tab); }; });

  var banner = $('banner');
  if (window.top !== window) { banner.hidden = false; banner.textContent = 'This page is inside a frame, so the browser will not let it use USB. Open it in its own tab.'; $('btn-connect').disabled = true; }
  else if (!('serial' in navigator)) { banner.hidden = false; banner.textContent = 'This browser cannot talk to USB devices. Use Chrome or Edge on a computer. The DEMO DEVICE and the patch editor still work.'; $('btn-connect').disabled = true; }

  renderList(); renderParams(); refreshUpdate();
  if (location.hash === '#patches') showTab('patches');
})();
