'use strict';
/**
 * Тесты логики. Используют «строгие» заглушки canvas и express:
 * заглушка холста бросает ошибку при любом неизвестном методе/свойстве 2D-контекста,
 * поэтому опечатки в рисовании ловятся. Реальную картинку смотрите через `npm run sample`.
 */
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

/* ---------- строгая заглушка @napi-rs/canvas ---------- */
const CTX_METHODS = new Set(['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arcTo', 'arc', 'fill',
  'stroke', 'clip', 'fillRect', 'fillText', 'measureText', 'drawImage', 'createLinearGradient', 'createRadialGradient',
  'getImageData', 'putImageData', 'translate', 'scale']);
const CTX_PROPS = new Set(['fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textAlign', 'textBaseline', 'shadowColor',
  'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'imageSmoothingEnabled', 'imageSmoothingQuality']);
const fakeCanvas = { log: [], fonts: new Set(), saves: 0 };

function makeCtx() {
  const state = {};
  const gradient = () => ({ addColorStop() {} });
  const impl = {
    save() { fakeCanvas.saves++; }, restore() { fakeCanvas.saves--; },
    measureText(t) { const m = /(\d+)px/.exec(state.font || ''); return { width: String(t).length * (m ? +m[1] : 10) * 0.5 }; },
    fillText(t, x, y) { fakeCanvas.log.push({ t: String(t), x, y, font: state.font }); fakeCanvas.fonts.add(state.font); },
    createLinearGradient: gradient, createRadialGradient: gradient,
    getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4).fill(120) }; },
  };
  return new Proxy({}, {
    get(_, k) {
      if (state.hasOwnProperty(k)) return state[k];
      if (!CTX_METHODS.has(k)) throw new Error('Неизвестный метод/свойство контекста: ' + String(k));
      return impl[k] || (() => {});
    },
    set(_, k, v) {
      if (!CTX_PROPS.has(k)) throw new Error('Неизвестное свойство контекста: ' + String(k));
      state[k] = v; return true;
    },
  });
}
fakeCanvas.createCanvas = (w, h) => ({ width: w, height: h, getContext: () => makeCtx(),
  encode: async () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]) });
fakeCanvas.loadImage = async (src) => {
  const s = Buffer.isBuffer(src) ? 'buffer' : String(src);
  if (s.includes('garage-bg')) return { width: 1200, height: 675 };
  if (s.includes('logo')) return { width: 640, height: 640 };
  return { width: 330, height: 150 };
};
fakeCanvas.GlobalFonts = { registerFromPath: () => true };

/* ---------- заглушка express ---------- */
function fakeExpress() {
  function express() {
    const mws = [], routes = [];
    const app = {
      disable() {}, set() {}, use(fn) { mws.push(fn); },
      get(p, ...h) { routes.push({ m: 'GET', p, h }); }, post(p, ...h) { routes.push({ m: 'POST', p, h }); },
      async handle(method, url, { headers = {}, body } = {}) {
        const [pathname, qs] = url.split('?');
        const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
        const req = { method, url, query: Object.fromEntries(new URLSearchParams(qs || '')), headers: lower, ip: '9.9.9.9',
          get(n) { return this.headers[n.toLowerCase()]; }, _raw: body };
        const res = { statusCode: 200, headers: {}, body: null, done: false,
          set(o, v) { if (typeof o === 'string') this.headers[o.toLowerCase()] = v; else for (const k in o) this.headers[k.toLowerCase()] = o[k]; return this; },
          status(c) { this.statusCode = c; return this; },
          type() { return this; },
          json(o) { this.set('content-type', 'application/json'); this.body = JSON.stringify(o); this.fin(); },
          send(b) { this.body = b; this.fin(); }, end(b) { this.body = b; this.fin(); },
          fin() { this.done = true; this._finish(); } };
        const route = routes.find((r) => r.m === method && r.p === pathname);
        const stack = [...mws, ...(route ? route.h : [])];
        await new Promise((resolve) => {
          res._finish = resolve;
          let i = -1;
          const next = (err) => {
            if (res.done) return;
            i++;
            while (i < stack.length && ((err && stack[i].length !== 4) || (!err && stack[i].length === 4))) i++;
            if (i >= stack.length) { res.statusCode = err ? 500 : 404; res.done = true; return resolve(); }
            try {
              const r = err ? stack[i](err, req, res, next) : stack[i](req, res, next);
              if (r && r.catch) r.catch(next);
            } catch (e) { next(e); }
          };
          next();
        });
        return res;
      },
    };
    return app;
  }
  express.json = () => (req, res, next) => {
    if (typeof req._raw === 'string') {
      if (req._raw.length > 10240) return next({ type: 'entity.too.large' });
      try { req.body = JSON.parse(req._raw); } catch (e) { return next({ type: 'entity.parse.failed' }); }
    } else req.body = req._raw || {};
    next();
  };
  return express;
}

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'express') return fakeExpress();
  if (request === '@napi-rs/canvas') return fakeCanvas;
  return origLoad.call(this, request, ...rest);
};

function loadServer(env = {}) {
  for (const k of ['API_KEY', 'RATE_LIMIT_PER_MIN', 'ALLOWED_IMAGE_HOSTS', 'DEMO', 'TRUST_PROXY']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../server')];
  return require('../server');
}

const GOOD = {
  name: 'Максим', level: 12, xp: 8400, balance: 12450000, fleetValue: 38900000, respect: 2350, garageSlots: 6,
  streak: 9, donation: 1500, carName: 'Ferrari 488', carHp: 670, carPrice: 16000000, carClass: 'Спорткар', carId: 'c1',
};
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/* ====================== тесты ====================== */
test('validate: хорошие данные проходят, числа-строки приводятся', () => {
  const s = loadServer();
  const r = s.validate({ ...GOOD, balance: '1 000 000' });
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.value.balance, 1000000);
});

test('validate: ошибки и очистка', () => {
  const s = loadServer();
  assert.ok(s.validate({}).errors.some((e) => e.startsWith('name')));
  assert.ok(s.validate({ name: 'A', balance: 'abc' }).errors.some((e) => e.startsWith('balance')));
  assert.ok(s.validate([]).errors.length);
  const r = s.validate({ name: '  <b>Hack</b>\n\n er  ', level: 99999 });
  assert.ok(!/[<>\n]/.test(r.value.name));
  assert.strictEqual(r.value.level, 9999);
  assert.strictEqual(s.validate({ name: 'x'.repeat(100) }).value.name.length, 32);
});

test('xpProgress совпадает с формулой игры (уровень = 1 + floor(sqrt(xp/60)))', () => {
  const s = loadServer();
  const p = s.xpProgress(12, 8400);
  assert.strictEqual(p.lo, 7260);
  assert.strictEqual(p.hi, 8640);
  assert.strictEqual(p.inLevel, 1140);
  assert.ok(Math.abs(p.frac - 1140 / 1380) < 1e-9);
  assert.strictEqual(s.xpProgress(1, 0).frac, 0);
  assert.strictEqual(s.xpProgress(1, 5000).frac, 1);          // не вылезает за 100%
  for (const xp of [0, 59, 60, 240, 1e5]) {                    // согласованность с формулой игры
    const lvl = 1 + Math.floor(Math.sqrt(xp / 60));
    const q = s.xpProgress(lvl, xp);
    assert.ok(q.frac >= 0 && q.frac < 1 + 1e-9);
  }
});

test('pickBody: классы игры -> 7 картинок пака', () => {
  const s = loadServer();
  const cases = [['Премиум-SUV', '', 'Внедорожник'], ['Пикап', '', 'Внедорожник'], ['Суперкар', '', 'Спорткар'],
    ['Гиперкар', '', 'Спорткар'], ['Эконом', '', 'Хэтчбек'], ['Минивэн', '', 'Универсал'], ['Ретро', '', 'Седан'],
    ['Премиум-купе', '', 'Купе'], ['Кроссовер', '', 'Кроссовер'], ['sedan', '', 'Седан'], ['sportcar', '', 'Спорткар'],
    ['', 'Ferrari 488', 'Спорткар'], ['', 'Ford Mustang', 'Купе'], ['', 'Lada Niva', 'Внедорожник'],
    ['', 'ВАЗ-2109', 'Хэтчбек'], ['', 'Lada Granta', 'Седан'], ['Неизвестный', 'Noname', 'Седан']];
  for (const [cls, name, want] of cases) assert.strictEqual(s.pickBody(cls, name), want, `${cls}|${name}`);
});

test('hashHue: тот же результат, что формула из игры', () => {
  const s = loadServer();
  const game = (id) => { var t = String(id), h = 2166136261; for (var i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % 360; };
  for (const id of ['a', 'car-1', 'c_17123456789', 'Ferrari 488', 'Лада']) {
    assert.strictEqual(s.hashHue(id), game(id));
    assert.ok(s.hashHue(id) >= 0 && s.hashHue(id) < 360);
  }
});

test('colorMatrix: серый остаётся серым при любом оттенке (яркость x1.05)', () => {
  const s = loadServer();
  for (const hue of [0, 45, 120, 200, 300]) {
    const M = s.colorMatrix(hue);
    const out = M.map((row) => row[0] * 128 + row[1] * 128 + row[2] * 128);
    for (const v of out) assert.ok(Math.abs(v - 128 * 1.05) < 0.01, `hue ${hue}: ${out}`);
  }
});

test('fmt и номерной знак', () => {
  const s = loadServer();
  assert.strictEqual(s.fmt(12450000), '12 450 000');
  assert.strictEqual(s.fmt(-1500), '−1 500');
  assert.strictEqual(s.fmt(0), '0');
  const p1 = s.makePlate('abc'), p2 = s.makePlate('abc');
  assert.deepStrictEqual(p1, p2);                              // детерминированно
  assert.match(p1.main, /^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}$/);
});

test('renderCard: рисует всё нужное, возвращает PNG, не оставляет save() без restore()', async () => {
  const s = loadServer();
  await s.loadAssets();
  fakeCanvas.log = []; fakeCanvas.fonts.clear(); fakeCanvas.saves = 0;
  const { value } = s.validate(GOOD);
  const out = await s.renderCard(value);
  assert.ok(out.png.subarray(0, 4).equals(PNG_SIG));
  assert.strictEqual(out.source, 'pack');
  assert.strictEqual(fakeCanvas.saves, 0, 'несбалансированные save/restore');
  const texts = fakeCanvas.log.map((l) => l.t);
  for (const want of ['Максим', 'УРОВЕНЬ 12', '12 450 000', '38 900 000', '2 350', '1 500', 'Ferrari 488', '16 000 000', '670 HP', 'БАЛАНС', 'АВТОПАРК', 'РЕСПЕКТ', 'ЦЕНА', 'дн.', '₽']) {
    assert.ok(texts.includes(want), 'нет текста: ' + want);
  }
  for (const f of fakeCanvas.fonts) assert.match(f, /AE|AEB|AEC/);   // только зарегистрированные шрифты
  for (const l of fakeCanvas.log) {                                  // всё в пределах 1000x500
    assert.ok(l.x >= 0 && l.x <= 1000 && l.y >= 0 && l.y <= 500, `за границами: ${l.t} ${l.x},${l.y}`);
  }
});

test('renderCard: минимальные данные и очень длинные строки', async () => {
  const s = loadServer();
  await s.loadAssets();
  const a = s.validate({ name: 'X' });
  assert.deepStrictEqual(a.errors, []);
  await s.renderCard(a.value);
  const b = s.validate({ ...GOOD, name: 'Ж'.repeat(32), carName: 'Ш'.repeat(60), balance: 9.9e14, carHp: 0 });
  await s.renderCard(b.value);
});

test('безопасность URL картинки', async () => {
  const s = loadServer({ ALLOWED_IMAGE_HOSTS: 'example.com' });
  assert.strictEqual(s.hostAllowed('example.com'), true);
  assert.strictEqual(s.hostAllowed('cdn.example.com'), true);
  assert.strictEqual(s.hostAllowed('evilexample.com'), false);
  assert.strictEqual(s.hostAllowed('127.0.0.1'), false);
  assert.strictEqual(s.hostAllowed('localhost'), false);
  assert.strictEqual(s.hostAllowed('[::1]'), false);
  assert.strictEqual(s.localBodyFromUrl(new URL('https://x.github.io/img/sedan.png')), 'Седан');
  assert.strictEqual(s.localBodyFromUrl(new URL('https://x.github.io/a/sportcar.png?v=1')), 'Спорткар');
  assert.strictEqual(s.localBodyFromUrl(new URL('https://x.github.io/photo.png')), null);

  await s.loadAssets();
  let fetched = 0;
  const realFetch = global.fetch;
  global.fetch = async () => { fetched++; throw new Error('не должно вызываться'); };
  try {
    for (const url of ['file:///etc/passwd', 'http://127.0.0.1/x.png', 'https://evil.com/x.png', 'ftp://example.com/x.png', 'not a url']) {
      const out = await s.renderCard(s.validate({ ...GOOD, carImageUrl: url }).value);
      assert.strictEqual(out.source, 'pack', url);
    }
    const local = await s.renderCard(s.validate({ ...GOOD, carImageUrl: 'https://anyone.github.io/img/suv.png' }).value);
    assert.strictEqual(local.source, 'pack');
    assert.strictEqual(fetched, 0, 'для небезопасных/локальных URL не должно быть сетевых запросов');

    // разрешённый хост: скачивание работает
    global.fetch = async (url, opts) => {
      fetched++;
      assert.strictEqual(opts.redirect, 'error');
      assert.ok(opts.signal);
      return { ok: true, headers: { get: (h) => ({ 'content-type': 'image/png', 'content-length': '1000' })[h.toLowerCase()] },
        body: (async function* () { yield Buffer.alloc(1000); })() };
    };
    const remote = await s.renderCard(s.validate({ ...GOOD, carImageUrl: 'https://cdn.example.com/car.png' }).value);
    assert.strictEqual(remote.source, 'remote');
    assert.strictEqual(fetched, 1);

    // не картинка / слишком большая -> запасной вариант из пака
    global.fetch = async () => ({ ok: true, headers: { get: (h) => ({ 'content-type': 'text/html' })[h.toLowerCase()] }, body: (async function* () {})() });
    assert.strictEqual((await s.renderCard(s.validate({ ...GOOD, carImageUrl: 'https://example.com/a' }).value)).source, 'pack');
    global.fetch = async () => ({ ok: true, headers: { get: (h) => ({ 'content-type': 'image/png', 'content-length': '99999999' })[h.toLowerCase()] }, body: (async function* () {})() });
    assert.strictEqual((await s.renderCard(s.validate({ ...GOOD, carImageUrl: 'https://example.com/a.png' }).value)).source, 'pack');
  } finally { global.fetch = realFetch; }
});

test('HTTP: /card, ошибки, ключ API, лимит запросов', async () => {
  const s = loadServer({ API_KEY: 'secret', RATE_LIMIT_PER_MIN: '6' });
  await s.loadAssets();
  const app = s.createApp();
  const body = JSON.stringify(GOOD);

  let r = await app.handle('POST', '/card', { body });
  assert.strictEqual(r.statusCode, 401);
  r = await app.handle('POST', '/card', { body, headers: { 'x-api-key': 'wrong' } });
  assert.strictEqual(r.statusCode, 401);

  r = await app.handle('POST', '/card', { body, headers: { 'X-API-Key': 'secret' } });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.headers['content-type'], 'image/png');
  assert.ok(Buffer.isBuffer(r.body) && r.body.subarray(0, 4).equals(PNG_SIG));

  r = await app.handle('POST', '/api/card', { body, headers: { authorization: 'Bearer secret' } });
  assert.strictEqual(r.statusCode, 200);

  r = await app.handle('POST', '/card', { body: JSON.stringify({ level: 3 }), headers: { 'x-api-key': 'secret' } });
  assert.strictEqual(r.statusCode, 400);
  assert.ok(JSON.parse(r.body).details.length);

  r = await app.handle('POST', '/card', { body: '{oops', headers: { 'x-api-key': 'secret' } });
  assert.strictEqual(r.statusCode, 400);

  // лимит считается по IP: запросы 401 тоже учитываются, подмена x-api-key его не обходит
  r = await app.handle('POST', '/card', { body, headers: { 'x-api-key': 'secret' } });   // 6-й запрос за минуту — ещё можно
  assert.strictEqual(r.statusCode, 200);
  r = await app.handle('POST', '/card', { body, headers: { 'x-api-key': 'другой-ключ' } }); // 7-й — лимит, даже с другим ключом
  assert.strictEqual(r.statusCode, 429);
  assert.ok(r.headers['retry-after']);

  r = await app.handle('GET', '/health');
  assert.strictEqual(r.statusCode, 200);
});

test('HTTP: без API_KEY сервер открыт, demo отдаёт PNG, DEMO=0 отключает', async () => {
  let s = loadServer();
  await s.loadAssets();
  let app = s.createApp();
  let r = await app.handle('POST', '/card', { body: JSON.stringify(GOOD) });
  assert.strictEqual(r.statusCode, 200);
  r = await app.handle('GET', '/demo?name=Тест&class=Седан');
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.headers['content-type'], 'image/png');
  assert.ok(fakeCanvas.log.some((l) => l.t === 'Тест'));

  s = loadServer({ DEMO: '0' });
  await s.loadAssets();
  app = s.createApp();
  r = await app.handle('GET', '/demo');
  assert.strictEqual(r.statusCode, 404);
});
