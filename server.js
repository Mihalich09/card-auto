'use strict';
/**
 * AUTO EMPIRE — сервер карточек игрока.
 * POST /card  (JSON с данными игрока)  ->  PNG 1000x500
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

/* ====================== НАСТРОЙКИ (через переменные окружения) ====================== */
const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.API_KEY || '';                       // ключ для бота (заголовок x-api-key)
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 60;
const TRUST_PROXY = process.env.TRUST_PROXY || '';               // '1' на Render/Railway/за nginx
const DEMO_ENABLED = process.env.DEMO !== '0';                   // GET /demo
const XP_K = Number(process.env.XP_K) || 60;                     // как в игре: уровень = 1 + floor(sqrt(xp / 60))
const ALLOWED_IMAGE_HOSTS = (process.env.ALLOWED_IMAGE_HOSTS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const IMAGE_TIMEOUT_MS = 5000;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const W = 1000;
const H = 500;
const COLORS = {
  bg: '#1A1B1E',
  panel: '#232428',
  line: '#2F3137',
  track: '#2B2D33',
  text: '#F3F4F6',
  muted: '#8B8F98',
  green: '#34D399',
  purple: '#A78BFA',
  purpleDark: '#8B5CF6',
};
const FONT = { reg: 'AE', bold: 'AEB', sym: 'AEC' };

/* ====================== РЕСУРСЫ: картинки из пака и шрифты ====================== */
const ASSETS = path.join(__dirname, 'assets');
const FONTS = path.join(__dirname, 'fonts');

// 7 базовых картинок пака (те же, что в игре: img/*.png)
const BODY_FILES = {
  'Хэтчбек': 'hatchback.png',
  'Седан': 'sedan.png',
  'Универсал': 'wagon.png',
  'Кроссовер': 'crossover.png',
  'Внедорожник': 'suv.png',
  'Купе': 'coupe.png',
  'Спорткар': 'sportcar.png',
};
// 16 классов игры -> 7 картинок (копия CLS2IMG из index.html)
const CLASS_TO_BODY = {
  'Эконом': 'Хэтчбек', 'Хэтчбек': 'Хэтчбек',
  'Седан': 'Седан', 'Ретро': 'Седан', 'Премиум-седан': 'Седан',
  'Универсал': 'Универсал', 'Минивэн': 'Универсал',
  'Кроссовер': 'Кроссовер',
  'Внедорожник': 'Внедорожник', 'Премиум-SUV': 'Внедорожник', 'Пикап': 'Внедорожник',
  'Купе': 'Купе', 'Премиум-купе': 'Купе',
  'Спорткар': 'Спорткар', 'Суперкар': 'Спорткар', 'Гиперкар': 'Спорткар',
};
// латинские алиасы: carClass: "sedan" и т.п.
const ALIASES = {
  hatchback: 'Хэтчбек', hatch: 'Хэтчбек', sedan: 'Седан', wagon: 'Универсал',
  crossover: 'Кроссовер', suv: 'Внедорожник', coupe: 'Купе', sportcar: 'Спорткар', sport: 'Спорткар',
};
// запасной вариант, если бот прислал только название машины (как BD в игре)
const NAME_HINTS = [
  ['Спорткар', ['Ferrari', 'Lamborghini', 'McLaren', 'Bugatti', 'Koenigsegg', 'Pagani']],
  ['Купе', ['Mustang', 'Camaro', 'M3', '911', 'R8', 'Huracán', 'Huracan', '488', 'Continental', 'Evo']],
  ['Внедорожник', ['Niva', 'X5', 'Cayenne', 'Qashqai', 'RAV4', 'Forester', 'XC90', 'RX', 'Prado', 'G63',
    'Range Rover', 'Patriot', 'Hilux', 'F-150']],
  ['Хэтчбек', ['ИЖ', '2109', 'Москвич', 'Таврия', 'Focus', 'Golf', 'Octavia']],
];

const images = { cars: {}, bg: null, logo: null };

async function loadAssets() {
  // шрифты (нужна кириллица; в контейнерах системных шрифтов обычно нет)
  const reg = path.join(FONTS, 'Carlito-Regular.ttf');
  const bold = path.join(FONTS, 'Carlito-Bold.ttf');
  const sym = path.join(FONTS, 'DejaVuSans-Bold.ttf'); // только для знака ₽
  const ok1 = GlobalFonts.registerFromPath(reg, FONT.reg);
  const ok2 = GlobalFonts.registerFromPath(bold, FONT.bold);
  const ok3 = GlobalFonts.registerFromPath(sym, FONT.sym);
  if (!ok1 || !ok2 || !ok3) console.warn('[fonts] не удалось зарегистрировать шрифты из ./fonts — русский текст может отображаться квадратиками');

  for (const [body, file] of Object.entries(BODY_FILES)) {
    images.cars[body] = await loadImage(path.join(ASSETS, 'cars', file));
  }
  images.bg = await loadImage(path.join(ASSETS, 'garage-bg.jpg'));
  images.logo = await loadImage(path.join(ASSETS, 'logo.jpg'));
}

/* ====================== ВСПОМОГАТЕЛЬНОЕ ====================== */
// тот же хэш, что в игре: id машины -> оттенок 0..359 (FNV-1a)
function hashHue(id) {
  const s = String(id);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

function fmt(n) {
  const neg = n < 0;
  const s = String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '−' : '') + s;
}

// порог XP для уровня L в игре: 60 * (L-1)^2
function xpProgress(level, xp) {
  const lo = XP_K * (level - 1) * (level - 1);
  const hi = XP_K * level * level;
  const inLevel = Math.max(0, Math.min(xp - lo, hi - lo));
  return { lo, hi, inLevel, need: hi - lo, frac: (hi - lo) > 0 ? inLevel / (hi - lo) : 0, left: Math.max(0, hi - xp) };
}

function pickBody(carClass, carName) {
  if (carClass) {
    const c = String(carClass).trim();
    if (BODY_FILES[c]) return c;
    if (CLASS_TO_BODY[c]) return CLASS_TO_BODY[c];
    const a = ALIASES[c.toLowerCase()];
    if (a) return a;
  }
  const n = String(carName || '');
  for (const [body, words] of NAME_HINTS) {
    if (words.some((w) => n.includes(w))) return body;
  }
  return 'Седан';
}

// Российский номер: А123ВС 77 (только буквы, которые есть на реальных номерах)
function makePlate(seed) {
  const L = 'АВЕКМНОРСТУХ';
  const regions = ['77', '99', '97', '78', '50', '16', '23', '61', '52', '63', '02', '74'];
  let h = hashHue(seed) * 7919 + 13;
  const next = (m) => { h = (Math.imul(h, 1103515245) + 12345) >>> 0; return (h >>> 8) % m; };
  const main = L[next(12)] + next(10) + next(10) + next(10) + L[next(12)] + L[next(12)];
  return { main, region: regions[next(regions.length)] };
}

/* ====================== ПЕРЕКРАСКА МАШИНЫ (как CSS-фильтр в игре) ======================
 * В игре: filter: hue-rotate(Hdeg) saturate(1.1) brightness(1.05)
 * Здесь та же математика по пикселям. */
function colorMatrix(hue) {
  const a = Math.cos((hue * Math.PI) / 180), b = Math.sin((hue * Math.PI) / 180);
  const Hm = [
    [0.213 + 0.787 * a - 0.213 * b, 0.715 - 0.715 * a - 0.715 * b, 0.072 - 0.072 * a + 0.928 * b],
    [0.213 - 0.213 * a + 0.143 * b, 0.715 + 0.285 * a + 0.140 * b, 0.072 - 0.072 * a - 0.283 * b],
    [0.213 - 0.213 * a - 0.787 * b, 0.715 - 0.715 * a + 0.715 * b, 0.072 + 0.928 * a + 0.072 * b],
  ];
  const s = 1.1;
  const Sm = [
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
  ];
  const br = 1.05;
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let v = 0;
    for (let k = 0; k < 3; k++) v += Sm[i][k] * Hm[k][j];
    M[i][j] = v * br;
  }
  return M;
}

const tintCache = new Map();
function tintedCar(body, hue) {
  const key = body + '|' + hue;
  if (tintCache.has(key)) return tintCache.get(key);
  const img = images.cars[body];
  const c = createCanvas(img.width, img.height);
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0);
  const id = cx.getImageData(0, 0, c.width, c.height);
  const d = id.data, M = colorMatrix(hue);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], bl = d[i + 2];
    d[i] = Math.max(0, Math.min(255, M[0][0] * r + M[0][1] * g + M[0][2] * bl));
    d[i + 1] = Math.max(0, Math.min(255, M[1][0] * r + M[1][1] * g + M[1][2] * bl));
    d[i + 2] = Math.max(0, Math.min(255, M[2][0] * r + M[2][1] * g + M[2][2] * bl));
  }
  cx.putImageData(id, 0, 0);
  if (tintCache.size >= 300) tintCache.delete(tintCache.keys().next().value);
  tintCache.set(key, c);
  return c;
}

/* ====================== КАРТИНКА МАШИНЫ ПО URL (безопасно) ====================== */
function localBodyFromUrl(u) {
  // ссылки вида https://.../img/sedan.png берём из локального пака, без скачивания
  const m = /\/(hatchback|sedan|wagon|crossover|suv|coupe|sportcar)\.png$/i.exec(u.pathname);
  return m ? ALIASES[m[1].toLowerCase()] : null;
}

function hostAllowed(host) {
  host = host.toLowerCase();
  if (host === 'localhost' || host.includes(':') || /^[\d.]+$/.test(host)) return false; // без IP и localhost
  return ALLOWED_IMAGE_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

async function fetchRemoteImage(u) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
  try {
    const res = await fetch(u.href, { signal: ctrl.signal, redirect: 'error', headers: { accept: 'image/*' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (!/^image\//i.test(res.headers.get('content-type') || '')) throw new Error('не картинка');
    if (Number(res.headers.get('content-length')) > IMAGE_MAX_BYTES) throw new Error('слишком большая');
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > IMAGE_MAX_BYTES) throw new Error('слишком большая');
      chunks.push(chunk);
    }
    return await loadImage(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
  }
}

/** Возвращает { img, source, tint } для машины на карточке */
async function resolveCarImage(p) {
  const hue = Number.isFinite(p.carHue) ? ((p.carHue % 360) + 360) % 360 : hashHue(p.carId || p.carName);
  if (p.carImageUrl) {
    try {
      const u = new URL(p.carImageUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('протокол');
      const local = localBodyFromUrl(u);
      if (local) return { img: tintedCar(local, hue), source: 'pack' };
      if (hostAllowed(u.hostname)) return { img: await fetchRemoteImage(u), source: 'remote' };
      console.warn('[img] хост не в ALLOWED_IMAGE_HOSTS:', u.hostname);
    } catch (e) {
      console.warn('[img] не удалось использовать carImageUrl:', e.message);
    }
  }
  const body = pickBody(p.carClass, p.carName);
  return { img: tintedCar(body, hue), source: 'pack' };
}

/* ====================== ВАЛИДАЦИЯ ====================== */
function validate(b) {
  const errors = [];
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { errors: ['Тело запроса должно быть JSON-объектом'] };

  const str = (v, max) => String(v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const num = (key, { min = 0, max = 1e15, def = 0, int = false } = {}) => {
    const v = b[key];
    if (v === undefined || v === null || v === '') return def;
    const n = typeof v === 'string' ? Number(v.replace(/\s/g, '')) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) { errors.push(`${key}: ожидается число`); return def; }
    const c = Math.max(min, Math.min(max, n));
    return int ? Math.floor(c) : c;
  };

  const name = b.name === undefined || b.name === null ? '' : str(b.name, 32);
  if (!name) errors.push('name: обязательное поле (строка до 32 символов)');

  const value = {
    name,
    level: num('level', { min: 1, max: 9999, def: 1, int: true }),
    xp: num('xp'),
    balance: num('balance', { min: -1e15 }),
    fleetValue: num('fleetValue'),
    respect: num('respect'),
    garageSlots: num('garageSlots', { int: true }),
    streak: num('streak', { int: true }),
    donation: num('donation'),
    carName: b.carName ? str(b.carName, 48) : 'Нет машины',
    carHp: num('carHp', { max: 99999 }),
    carPrice: num('carPrice'),
    carImageUrl: b.carImageUrl ? String(b.carImageUrl).slice(0, 500) : '',
    // необязательные: цвет и тип кузова как в игре
    carClass: b.carClass ? str(b.carClass, 32) : '',
    carId: b.carId !== undefined && b.carId !== null ? str(b.carId, 64) : '',
    carHue: b.carHue === undefined || b.carHue === null || b.carHue === '' ? NaN : Number(b.carHue),
    carPlate: b.carPlate ? str(b.carPlate, 12) : '',
  };
  return { value, errors };
}

/* ====================== РИСОВАНИЕ ====================== */
function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function setFont(ctx, bold, size) {
  ctx.font = `${size}px ${bold ? FONT.bold : FONT.reg}, sans-serif`;
}

function fitFont(ctx, text, bold, maxW, size, min) {
  let s = size;
  setFont(ctx, bold, s);
  while (s > min && ctx.measureText(text).width > maxW) { s -= 1; setFont(ctx, bold, s); }
  return s;
}

function ellipsize(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

function coverDraw(ctx, img, x, y, w, h) {
  const k = Math.max(w / img.width, h / img.height);
  const sw = w / k, sh = h / k;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

/** Число + единица (₽ рисуется шрифтом с этим символом). Возвращает использованный размер. */
function drawStat(ctx, { num, unit, cur }, x, y, maxW, size, color) {
  let s = size, wNum = 0, wUnit = 0, gap = 0;
  for (;;) {
    setFont(ctx, true, s);
    wNum = ctx.measureText(num).width;
    gap = Math.round(s * 0.22);
    wUnit = 0;
    if (cur) { ctx.font = `${Math.round(s * 0.92)}px ${FONT.sym}, sans-serif`; wUnit = ctx.measureText('₽').width; }
    else if (unit) { setFont(ctx, true, Math.round(s * 0.62)); wUnit = ctx.measureText(unit).width; }
    if (wNum + (wUnit ? gap + wUnit : 0) <= maxW || s <= 14) break;
    s -= 1;
  }
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  setFont(ctx, true, s);
  ctx.fillText(num, x, y);
  if (cur) {
    ctx.font = `${Math.round(s * 0.92)}px ${FONT.sym}, sans-serif`;
    ctx.fillText('₽', x + wNum + gap, y);
  } else if (unit) {
    setFont(ctx, true, Math.round(s * 0.62));
    ctx.fillText(unit, x + wNum + gap, y);
  }
  return s;
}

function drawTile(ctx, x, y, w, h, label, stat, color) {
  rr(ctx, x, y, w, h, 14);
  ctx.fillStyle = COLORS.panel;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = COLORS.line;
  ctx.stroke();
  rr(ctx, x + 12, y + 14, 4, h - 28, 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COLORS.muted;
  setFont(ctx, false, 13);
  ctx.fillText(label, x + 28, y + 26);
  drawStat(ctx, stat, x + 28, y + 56, w - 28 - 16, 28, color);
}

function drawPlate(ctx, cx, y, plate) {
  const w = 206, h = 42, x = cx - w / 2;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  rr(ctx, x, y, w, h, 7);
  ctx.fillStyle = '#F7F7F2';
  ctx.fill();
  ctx.restore();
  rr(ctx, x + 1.5, y + 1.5, w - 3, h - 3, 6);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#111111';
  ctx.stroke();
  // основная часть: символы с фиксированным шагом, как на реальном номере
  const step = 21, startX = x + 14 + step / 2;
  ctx.fillStyle = '#111111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  setFont(ctx, true, 29);
  Array.from(plate.main).forEach((ch, i) => ctx.fillText(ch, startX + i * step, y + 31));
  // разделитель и регион
  const rx = x + w - 62;
  ctx.beginPath();
  ctx.moveTo(rx, y + 5);
  ctx.lineTo(rx, y + h - 5);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#111111';
  ctx.stroke();
  setFont(ctx, true, 22);
  ctx.fillText(plate.region, rx + 31 - 2, y + 23);
  setFont(ctx, true, 9);
  ctx.fillText('RUS', rx + 31 - 2, y + h - 7);
}

async function renderCard(p) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.textBaseline = 'alphabetic';

  /* --- фон --- */
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);
  let g = ctx.createRadialGradient(120, 40, 10, 120, 40, 420);
  g.addColorStop(0, 'rgba(139,92,246,0.16)');
  g.addColorStop(1, 'rgba(139,92,246,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  g = ctx.createRadialGradient(880, 470, 10, 880, 470, 380);
  g.addColorStop(0, 'rgba(52,211,153,0.10)');
  g.addColorStop(1, 'rgba(52,211,153,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  /* --- шапка: логотип --- */
  ctx.save();
  ctx.beginPath();
  ctx.arc(56, 54, 20, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(images.logo, 36, 34, 40, 40);
  ctx.restore();
  ctx.fillStyle = COLORS.muted;
  setFont(ctx, true, 17);
  ctx.textAlign = 'left';
  ctx.fillText('AUTO EMPIRE', 88, 60);

  /* --- ник, уровень, XP --- */
  const LX = 36, LW = 540;
  ctx.fillStyle = COLORS.text;
  fitFont(ctx, p.name, true, LW, 46, 24);
  ctx.fillText(p.name, LX, 124);

  const lvlText = `УРОВЕНЬ ${p.level}`;
  setFont(ctx, true, 15);
  const pillW = Math.ceil(ctx.measureText(lvlText).width) + 28;
  rr(ctx, LX, 140, pillW, 30, 15);
  ctx.fillStyle = COLORS.purpleDark;
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.fillText(lvlText, LX + pillW / 2, 160);

  const xp = xpProgress(p.level, p.xp);
  rr(ctx, LX, 184, LW, 14, 7);
  ctx.fillStyle = COLORS.track;
  ctx.fill();
  if (xp.frac > 0) {
    ctx.save();
    rr(ctx, LX, 184, LW, 14, 7);
    ctx.clip();
    const fw = Math.max(14, LW * xp.frac);
    const xg = ctx.createLinearGradient(LX, 0, LX + LW, 0);
    xg.addColorStop(0, COLORS.purpleDark);
    xg.addColorStop(1, COLORS.green);
    rr(ctx, LX, 184, fw, 14, 7);
    ctx.fillStyle = xg;
    ctx.fill();
    ctx.restore();
  }
  ctx.textAlign = 'left';
  setFont(ctx, false, 14);
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(`${fmt(xp.inLevel)} / ${fmt(xp.need)} XP`, LX, 220);
  ctx.textAlign = 'right';
  ctx.fillText(`до ${p.level + 1} ур.: ${fmt(xp.left)} XP`, LX + LW, 220);

  /* --- плитки 2x3 --- */
  const tw = (LW - 12) / 2, th = 70, gx = 12, gy = 10, ty = 238;   // низ плиток = низ правой панели (468)
  const tiles = [
    ['БАЛАНС', { num: fmt(p.balance), cur: true }, COLORS.green],
    ['АВТОПАРК', { num: fmt(p.fleetValue), cur: true }, COLORS.purple],
    ['РЕСПЕКТ', { num: fmt(p.respect) }, COLORS.green],
    ['СЛОТЫ ГАРАЖА', { num: fmt(p.garageSlots) }, COLORS.purple],
    ['СЕРИЯ', { num: fmt(p.streak), unit: 'дн.' }, COLORS.green],
    ['ДОНАТ', { num: fmt(p.donation), cur: true }, COLORS.purple],
  ];
  tiles.forEach(([label, stat, color], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    drawTile(ctx, LX + col * (tw + gx), ty + row * (th + gy), tw, th, label, stat, color);
  });

  /* --- правая панель: фото машины --- */
  const PX = 604, PY = 32, PW = 360, PH = 436, PHOTO_H = 286;
  ctx.save();
  rr(ctx, PX, PY, PW, PH, 22);
  ctx.clip();
  ctx.fillStyle = COLORS.panel;
  ctx.fillRect(PX, PY, PW, PH);
  coverDraw(ctx, images.bg, PX, PY, PW, PHOTO_H);
  ctx.fillStyle = 'rgba(10,10,14,0.35)';
  ctx.fillRect(PX, PY, PW, PHOTO_H);
  g = ctx.createLinearGradient(0, PY + 120, 0, PY + PHOTO_H);
  g.addColorStop(0, 'rgba(35,36,40,0)');
  g.addColorStop(1, 'rgba(35,36,40,1)');
  ctx.fillStyle = g;
  ctx.fillRect(PX, PY + 120, PW, PHOTO_H - 120);

  // машина
  const car = await resolveCarImage(p);
  const maxCW = 316, maxCH = 150;
  const k = Math.min(maxCW / car.img.width, maxCH / car.img.height, 1.1);
  const cw = car.img.width * k, ch = car.img.height * k;
  const ccx = PX + PW / 2, cbottom = PY + 218;
  ctx.save();
  ctx.translate(ccx, cbottom + 2);
  ctx.scale(1, 0.13);
  const sg = ctx.createRadialGradient(0, 0, 0, 0, 0, cw * 0.5);
  sg.addColorStop(0, 'rgba(0,0,0,0.65)');
  sg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sg;
  ctx.fillRect(-cw * 0.5, -cw * 0.5, cw, cw);
  ctx.restore();
  ctx.drawImage(car.img, ccx - cw / 2, cbottom - ch, cw, ch);

  // HP
  if (p.carHp > 0) {
    const hpText = `${fmt(p.carHp)} HP`;
    setFont(ctx, true, 15);
    ctx.textAlign = 'left';
    const hw = Math.ceil(ctx.measureText(hpText).width) + 24;
    rr(ctx, PX + 16, PY + 16, hw, 28, 14);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(167,139,250,0.7)';
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(hpText, PX + 16 + 12, PY + 16 + 19);
  }

  // номерной знак
  const plate = p.carPlate && /^[А-ЯA-Z]\d{3}[А-ЯA-Z]{2}$/i.test(p.carPlate.replace(/\s/g, ''))
    ? { main: p.carPlate.replace(/\s/g, '').toUpperCase(), region: '77' }
    : makePlate(p.carId || p.carName);
  drawPlate(ctx, ccx, PY + 236, plate);
  ctx.restore();

  // название и цена
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.text;
  fitFont(ctx, p.carName, true, PW - 40, 28, 18);
  ctx.fillText(ellipsize(ctx, p.carName, PW - 40), PX + 20, PY + PHOTO_H + 42);
  ctx.fillStyle = COLORS.muted;
  setFont(ctx, false, 13);
  ctx.fillText('ЦЕНА', PX + 20, PY + PHOTO_H + 72);
  drawStat(ctx, { num: fmt(p.carPrice), cur: true }, PX + 20, PY + PHOTO_H + 112, PW - 40, 36, COLORS.green);

  // рамка панели
  rr(ctx, PX, PY, PW, PH, 22);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = COLORS.line;
  ctx.stroke();

  const png = await canvas.encode('png');
  return { png, source: car.source };
}

/* ====================== HTTP ====================== */
function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (TRUST_PROXY) app.set('trust proxy', TRUST_PROXY === 'true' ? true : (Number(TRUST_PROXY) || TRUST_PROXY));
  app.use(express.json({ limit: '10kb' }));

  // простой лимит запросов (в памяти), по IP
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, 60000).unref();
  const rateLimit = (req, res, next) => {
    const key = req.ip;                                  // по IP: подмена заголовков лимит не обходит
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset <= now) { h = { n: 0, reset: now + 60000 }; hits.set(key, h); }
    if (++h.n > RATE_LIMIT_PER_MIN) {
      res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: 'Слишком много запросов' });
    }
    next();
  };

  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const auth = (req, res, next) => {
    if (!API_KEY) return next();
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const got = req.get('x-api-key') || bearer;
    if (got && crypto.timingSafeEqual(sha(got), sha(API_KEY))) return next();
    return res.status(401).json({ error: 'Неверный или отсутствующий API-ключ (заголовок x-api-key)' });
  };

  const send = (res, out) => {
    res.set({ 'Content-Type': 'image/png', 'Content-Length': out.png.length, 'Cache-Control': 'no-store',
      'Content-Disposition': 'inline; filename="player-card.png"', 'X-Car-Image': out.source });
    res.end(out.png);
  };

  app.get('/', (req, res) => res.type('text/plain').send('AUTO EMPIRE card server. POST /card, GET /health'));
  app.get('/health', (req, res) => res.json({ ok: true }));

  const cardHandler = async (req, res, next) => {
    try {
      const { value, errors } = validate(req.body);
      if (errors.length) return res.status(400).json({ error: 'Неверные данные', details: errors });
      send(res, await renderCard(value));
    } catch (e) { next(e); }
  };
  app.post('/card', rateLimit, auth, cardHandler);
  app.post('/api/card', rateLimit, auth, cardHandler);

  if (DEMO_ENABLED) {
    app.get('/demo', rateLimit, async (req, res, next) => {
      try {
        const { value } = validate({
          name: String(req.query.name || 'Максим'), level: 12, xp: 8400, balance: 12450000, fleetValue: 38900000,
          respect: 2350, garageSlots: 6, streak: 9, donation: 1500,
          carName: 'Ferrari 488', carHp: 670, carPrice: 16000000, carClass: String(req.query.class || 'Спорткар'),
          carId: String(req.query.id || 'demo-1'),
        });
        send(res, await renderCard(value));
      } catch (e) { next(e); }
    });
  }

  // ошибки
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный JSON' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Слишком большой запрос' });
    console.error('[error]', err);
    res.status(500).json({ error: 'Не удалось сгенерировать карточку' });
  });
  return app;
}

async function main() {
  await loadAssets();
  if (!API_KEY) console.warn('[security] API_KEY не задан — сервер доступен всем. Задайте API_KEY в переменных окружения.');
  const app = createApp();
  const server = app.listen(PORT, () => console.log(`Card server: http://localhost:${PORT}  (POST /card)`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) {
  main().catch((e) => { console.error('Не удалось запустить сервер:', e); process.exit(1); });
}

module.exports = { createApp, renderCard, validate, loadAssets, hashHue, pickBody, xpProgress, makePlate, fmt, colorMatrix, hostAllowed, localBodyFromUrl };
