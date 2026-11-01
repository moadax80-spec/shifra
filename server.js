#!/usr/bin/env node
/*
  Shifra (Arabic Codenames) - local network server.
  No dependencies. Needs Node.js 14 or newer.
  Run:  node server.js        (optional: PORT=3000 node server.js)
  Players on the same Wi-Fi open the address printed below. No internet needed.
*/
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const SAVE = path.join(ROOT, 'rooms.json');

const docs = new Map();      // doc path -> JSON object
const watchers = new Set();  // { res, kind, path, last }

try {
  const saved = JSON.parse(fs.readFileSync(SAVE, 'utf8'));
  for (const k of Object.keys(saved)) docs.set(k, saved[k]);
} catch (e) { /* first run */ }

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(SAVE, JSON.stringify(Object.fromEntries(docs))); } catch (e) { /* read-only folder is fine */ }
  }, 800);
}

const DOC_RE = /^games\/[A-Z0-9]{5}(\/players\/[A-Za-z0-9_-]{1,40})?$/;
const COL_RE = /^games\/[A-Z0-9]{5}\/players$/;
const GAME_RE = /^games\/[A-Z0-9]{5}$/;
// limits that keep a public server safe from spam
const MAX_DOCS = 4000;
const MAX_ROOMS = 300;
const MAX_PLAYERS_PER_ROOM = 40;
const MAX_WATCHERS = 800;
const MAX_DOC_CHARS = 24576;
const parentOf = (p) => p.slice(0, p.lastIndexOf('/'));
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function merge(a, b) {
  const out = Object.assign({}, a);
  for (const k of Object.keys(b)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const v = b[k];
    out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
  }
  return out;
}

function docSnap(p) { return docs.has(p) ? { exists: true, data: docs.get(p) } : { exists: false }; }
function colSnap(c) {
  const list = [];
  for (const [k, v] of docs) {
    if (k.startsWith(c + '/') && k.indexOf('/', c.length + 1) < 0) list.push({ id: k.slice(c.length + 1), data: v });
  }
  list.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { docs: list };
}
function push(w) {
  const s = JSON.stringify(w.kind === 'doc' ? docSnap(w.path) : colSnap(w.path));
  if (s === w.last) return;
  w.last = s;
  try { w.res.write('data: ' + s + '\n\n'); } catch (e) { /* closed */ }
}
function notify(p) {
  for (const w of watchers) {
    if ((w.kind === 'doc' && w.path === p) || (w.kind === 'col' && parentOf(p) === w.path)) push(w);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 65536) { reject(new Error('too big')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (e) { return sendJson(res, 400, { code: 'invalid_argument' }); }
  try {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(ROOT, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (u.pathname === '/api/ice') {
      // optional: set ICE_JSON on the host to your own STUN/TURN list (JSON array)
      let list = null;
      try { if (process.env.ICE_JSON) list = JSON.parse(process.env.ICE_JSON); } catch (e) { /* ignore */ }
      return sendJson(res, 200, Array.isArray(list) ? list : []);
    }
    if (u.pathname === '/api/time') return sendJson(res, 200, { t: Date.now() });
    if (u.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }

    if (u.pathname === '/api/doc') {
      const p = u.searchParams.get('path') || '';
      if (!DOC_RE.test(p)) return sendJson(res, 400, { code: 'invalid_argument' });
      if (req.method === 'GET') return sendJson(res, 200, docSnap(p));
      if (req.method === 'POST') {
        const { op, data } = JSON.parse(await readBody(req));
        let next = null;
        if (op === 'set') {
          if (!isObj(data)) return sendJson(res, 400, { code: 'invalid_argument' });
          next = data;
        } else if (op === 'update') {
          if (!isObj(data) || !docs.has(p)) return sendJson(res, 400, { code: 'invalid_argument' });
          next = merge(docs.get(p), data);
        } else if (op === 'delete') {
          docs.delete(p);
        } else {
          return sendJson(res, 400, { code: 'invalid_argument' });
        }
        if (next) {
          if (JSON.stringify(next).length > MAX_DOC_CHARS) return sendJson(res, 413, { code: 'quota_exceeded' });
          if (!docs.has(p)) {
            if (docs.size >= MAX_DOCS) return sendJson(res, 507, { code: 'quota_exceeded' });
            if (GAME_RE.test(p)) {
              let rooms = 0;
              for (const k of docs.keys()) if (GAME_RE.test(k)) rooms++;
              if (rooms >= MAX_ROOMS) return sendJson(res, 507, { code: 'quota_exceeded' });
            } else {
              const room = p.slice(0, p.indexOf('/', 6));
              let n = 0;
              for (const k of docs.keys()) if (k.startsWith(room + '/players/')) n++;
              if (n >= MAX_PLAYERS_PER_ROOM) return sendJson(res, 507, { code: 'quota_exceeded' });
            }
          }
          docs.set(p, next);
        }
        scheduleSave();
        notify(p);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { code: 'invalid_argument' });
    }

    if (u.pathname === '/api/watch') {
      const kind = u.searchParams.get('kind');
      const p = u.searchParams.get('path') || '';
      const ok = kind === 'doc' ? DOC_RE.test(p) : kind === 'col' ? COL_RE.test(p) : false;
      if (!ok) return sendJson(res, 400, { code: 'invalid_argument' });
      if (watchers.size >= MAX_WATCHERS) return sendJson(res, 429, { code: 'resource_exhausted' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write('retry: 2000\n\n');
      const w = { res, kind, path: p, last: null };
      watchers.add(w);
      push(w);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) { /* closed */ } }, 15000);
      req.on('close', () => { clearInterval(hb); watchers.delete(w); });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { code: 'unavailable' });
  }
});

// remove rooms older than 24 hours
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of Array.from(docs)) {
    if (GAME_RE.test(k) && v && v.created && t - v.created > 86400000) {
      for (const kk of Array.from(docs.keys())) if (kk.startsWith(k + '/')) docs.delete(kk);
      docs.delete(k);
      notify(k);
    }
  }
  scheduleSave();
}, 3600000).unref();

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
    }
  }
  const rank = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('\nPort ' + PORT + ' is already in use. Close the other program, or run with another port:');
    console.error('  PORT=3000 node server.js     (Windows: set PORT=3000 && node server.js)\n');
  } else {
    console.error(e);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanAddresses();
  console.log('\n  SHIFRA is running. No internet is needed.\n');
  console.log('  On this computer:            http://localhost:' + PORT);
  if (ips.length) {
    console.log('  Other devices (same Wi-Fi):');
    ips.forEach((ip) => console.log('                               http://' + ip + ':' + PORT));
  } else {
    console.log('  No network address found. Connect to a Wi-Fi network or a phone hotspot first.');
  }
  console.log('\n  If other devices cannot open the address, allow Node.js through the firewall');
  console.log('  (Private networks) and make sure all devices are on the same Wi-Fi.');
  console.log('  Press Ctrl+C to stop.\n');
});
