# AUTO EMPIRE — сервер карточек игрока

Express-сервер: принимает JSON с данными игрока и отдаёт PNG 1000×500 («карточка игрока»).
Бот просто отправляет эту картинку в Telegram.

В комплекте уже лежат ресурсы из вашего пака: 7 картинок машин (`assets/cars`), фон гаража
(`assets/garage-bg.jpg`) и логотип (`assets/logo.jpg`), а также шрифт с кириллицей (`fonts`).
Скачивать ничего не нужно.

```
card-server/
├── server.js            — весь сервер и отрисовка
├── package.json
├── assets/              — картинки машин, фон, логотип (из вашего пака)
├── fonts/               — Carlito (кириллица) + DejaVu (только знак ₽)
├── scripts/make-sample.js
├── test/logic.test.js
├── Dockerfile, .env.example
```

## 1. Запуск у себя (проверка)

Нужен Node.js 18 или новее (лучше 20).

```bash
cd card-server
npm install
npm run sample      # создаст sample-card.png — откройте и посмотрите дизайн
npm start           # сервер на http://localhost:3000
```

Проверка в браузере: открой `http://localhost:3000/demo` — покажет тестовую карточку
(можно `?name=Вася&class=Седан&id=abc`).

Проверка запросом:

```bash
curl -X POST http://localhost:3000/card \
  -H "Content-Type: application/json" \
  -d '{"name":"Максим","level":12,"xp":8400,"balance":12450000,"fleetValue":38900000,
       "respect":2350,"garageSlots":6,"streak":9,"donation":1500,
       "carName":"Ferrari 488","carHp":670,"carPrice":16000000,"carClass":"Спорткар","carId":"c1"}' \
  --output card.png
```

Если задан `API_KEY`, добавь заголовок `-H "x-api-key: ВАШ_КЛЮЧ"`.

## 2. API

`POST /card` (то же самое на `POST /api/card`), заголовок `Content-Type: application/json`.
Ответ: `200`, `Content-Type: image/png`.

| Поле | Тип | Обязательное | Что это |
|---|---|---|---|
| `name` | строка до 32 | да | ник |
| `level` | целое ≥ 1 | нет (1) | уровень |
| `xp` | число | нет (0) | **общий** опыт, как `S.xp` в игре; полоса считается по формуле игры `уровень = 1 + floor(sqrt(xp/60))` |
| `balance` | число | нет | баланс, ₽ |
| `fleetValue` | число | нет | стоимость автопарка, ₽ |
| `respect` | число | нет | респект |
| `garageSlots` | целое | нет | слоты гаража |
| `streak` | целое | нет | серия, дней |
| `donation` | число | нет | донат, ₽ |
| `carName` | строка до 48 | нет | название машины |
| `carHp` | число | нет | показывается как «670 HP» (0 или пусто — плашки нет) |
| `carPrice` | число | нет | цена машины, ₽ |
| `carImageUrl` | строка | нет | см. ниже |
| `carClass` | строка | нет | класс машины из игры (`Седан`, `Премиум-SUV`, `Суперкар`…) или `sedan`, `suv`… — выбирает картинку из пака |
| `carId` | строка | нет | id машины: определяет **оттенок** (как в игре) и номерной знак |
| `carHue` | 0–359 | нет | задать оттенок вручную |
| `carPlate` | строка | нет | свой номер вида `А123ВС` |

Числа можно слать строками (`"1 000 000"`). Неверные данные → `400` и список ошибок.
Другие ответы: `401` — нет/неверный ключ, `429` — слишком много запросов.

**Какая машина рисуется (по порядку):**
1. `carImageUrl`, если это ссылка на картинку пака (`…/img/sedan.png`, `…/img/suv.png` и т. д.) —
   берётся локальный файл, без скачивания. Если это другой адрес и хост есть в `ALLOWED_IMAGE_HOSTS` —
   картинка скачивается (5 с, до 5 МБ, без редиректов).
2. иначе картинка по `carClass` (те же 16 классов → 7 картинок, как в `index.html`);
3. иначе по ключевым словам в `carName` (Ferrari → спорткар, Mustang → купе, Niva → внедорожник…);
4. иначе седан.

Картинки пака перекрашиваются тем же фильтром, что в игре (`hue-rotate` по хэшу `carId`),
поэтому машина на карточке того же цвета, что в гараже, если бот присылает тот же `carId`.
Без `carId` оттенок берётся от названия машины.

## 3. Подключение к Telegram-боту

grammY:

```js
import { InputFile } from 'grammy';

async function sendCard(ctx, player) {
  const res = await fetch(`${process.env.CARD_URL}/card`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.CARD_API_KEY },
    body: JSON.stringify(player),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`card server: ${res.status} ${await res.text()}`);
  const png = Buffer.from(await res.arrayBuffer());
  await ctx.replyWithPhoto(new InputFile(png, 'card.png'));
}
```

node-telegram-bot-api:

```js
const png = Buffer.from(await res.arrayBuffer());
await bot.sendPhoto(chatId, png, {}, { filename: 'card.png', contentType: 'image/png' });
```

Telegram пережимает фото в JPEG. Если нужна максимальная чёткость, отправляйте `sendDocument`.

Откуда брать данные из сохранения игры (`users/{uid}.state`, поле `S`):
имя — `S.pf.n`, опыт — `S.xp`, уровень — `1 + floor(sqrt(S.xp / 60))`, баланс — `S.money`,
слоты — `S.slots`, респект — `S.rep`, машина — элемент `S.cars` (`n` — название, `id` — id).
Серии (`streak`) и суммы доната в сохранении игры сейчас нет — бот должен брать их из своей базы
или слать 0. Стоимость автопарка и цену машины считает функция `value()` в игре; если в боте её нет,
можно слать `c.paid` (цену покупки).

## 4. Как запустить на хостинге

Сервер — обычное Node.js-приложение, постоянная база не нужна. Важно: хостинг должен быть на
Linux с Node 18+ (подходят все варианты ниже).

В переменных окружения на хостинге обязательно задайте **`API_KEY`** (длинная случайная строка,
например результат `openssl rand -hex 32`) — иначе любой сможет нагружать ваш сервер. Тот же ключ
положите в настройки бота (`CARD_API_KEY`). Также поставьте `TRUST_PROXY=1`.

### Вариант A. Render (проще всего)

1. Залейте папку `card-server` в репозиторий GitHub (отдельный репозиторий, например `auto-empire-cards`).
2. На render.com: **New → Web Service** → выберите репозиторий.
3. Настройки: Runtime **Node**; Build Command `npm install`; Start Command `npm start`.
4. **Environment**: `API_KEY=...`, `TRUST_PROXY=1`, `NODE_VERSION=20`.
5. **Health Check Path**: `/health`. Нажмите Deploy.
6. Адрес вида `https://auto-empire-cards.onrender.com` — это `CARD_URL` для бота.
   Проверьте `https://…onrender.com/demo`.

Бесплатный тариф «засыпает» через 15 минут без запросов, и первый запрос после сна идёт 30–60 секунд
(у бота может сработать таймаут). Решения: платный тариф Starter, либо бесплатный пинг
`/health` каждые 10 минут (например, UptimeRobot).

### Вариант B. Railway

1. **New Project → Deploy from GitHub repo** → выберите репозиторий.
2. Во вкладке **Variables** добавьте `API_KEY` и `TRUST_PROXY=1`.
3. **Settings → Networking → Generate Domain**. Railway сам определит Node и запустит `npm start`.

### Вариант C. Свой VPS (Ubuntu 22.04/24.04)

```bash
# Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# проект
sudo mkdir -p /opt/card-server && sudo chown $USER /opt/card-server
# загрузите туда файлы проекта (git clone или scp), затем:
cd /opt/card-server && npm install --omit=dev
```

Служба `/etc/systemd/system/card-server.service`:

```ini
[Unit]
Description=AUTO EMPIRE card server
After=network.target

[Service]
WorkingDirectory=/opt/card-server
ExecStart=/usr/bin/node server.js
Restart=always
User=www-data
Environment=PORT=3000
Environment=TRUST_PROXY=1
Environment=API_KEY=ВАШ_ДЛИННЫЙ_КЛЮЧ

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now card-server
curl http://localhost:3000/health
```

Чтобы открыть сервер наружу по HTTPS, поставьте nginx с проксированием на `127.0.0.1:3000`
и сертификат (`sudo apt install nginx certbot python3-certbot-nginx`, затем `sudo certbot --nginx`).
Если бот работает на том же сервере, наружу открывать не нужно: `CARD_URL=http://127.0.0.1:3000`.

### Вариант D. Docker

```bash
docker build -t card-server .
docker run -d --restart=always -p 3000:3000 -e API_KEY=ВАШ_КЛЮЧ -e TRUST_PROXY=1 card-server
```

(Образ на базе Debian. Alpine не берите: проще без сюрпризов с нативной библиотекой canvas.)

## 5. Настройки (переменные окружения)

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PORT` | 3000 | порт (хостинги задают сами) |
| `API_KEY` | пусто | ключ в заголовке `x-api-key` (или `Authorization: Bearer …`) |
| `TRUST_PROXY` | пусто | `1` за прокси хостинга |
| `RATE_LIMIT_PER_MIN` | 60 | лимит карточек в минуту с одного IP |
| `ALLOWED_IMAGE_HOSTS` | пусто | хосты, откуда можно скачивать `carImageUrl` |
| `DEMO` | 1 | `0` отключает `GET /demo` |
| `XP_K` | 60 | коэффициент формулы уровня (как в игре) |

Цвета меняются в объекте `COLORS` в начале `server.js`, координаты — в функции `renderCard`.
Чтобы сменить шрифт (например, Manrope, как в игре), положите `.ttf` с кириллицей в `fonts/`
и поправьте имена файлов в `loadAssets()`.

## 6. Если что-то не работает

- **Вместо русских букв квадраты** — нет папки `fonts/` рядом с `server.js`; в логах будет предупреждение `[fonts]`.
- **`Cannot find module '@napi-rs/canvas'`** — не выполнен `npm install`.
- **`401`** — ключ в боте не совпадает с `API_KEY` на сервере.
- **`400`** — смотрите поле `details` в ответе. Часто забывают `Content-Type: application/json`.
- **Бот получает таймаут только после простоя** — бесплатный тариф «спит» (см. вариант A).
- **Своя `carImageUrl` не рисуется** — добавьте её хост в `ALLOWED_IMAGE_HOSTS`; смотрите логи `[img]`.
  Заголовок ответа `X-Car-Image` показывает, откуда взята машина: `pack` или `remote`.
- **Тесты:** `npm test` (проверяют логику; сама картинка — через `npm run sample`).
