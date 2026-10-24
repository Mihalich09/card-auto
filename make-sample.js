'use strict';
// Рисует пример карточки в sample-card.png без запуска сервера: npm run sample
const fs = require('fs');
const path = require('path');
const { loadAssets, renderCard, validate } = require('../server');

(async () => {
  await loadAssets();
  const { value, errors } = validate({
    name: 'Максим', level: 12, xp: 8400, balance: 12450000, fleetValue: 38900000, respect: 2350,
    garageSlots: 6, streak: 9, donation: 1500,
    carName: 'Ferrari 488', carHp: 670, carPrice: 16000000, carClass: 'Спорткар', carId: 'demo-1',
  });
  if (errors.length) throw new Error(errors.join('; '));
  const out = await renderCard(value);
  const file = path.join(__dirname, '..', 'sample-card.png');
  fs.writeFileSync(file, out.png);
  console.log('Готово:', file, `(${out.png.length} байт)`);
})().catch((e) => { console.error(e); process.exit(1); });
