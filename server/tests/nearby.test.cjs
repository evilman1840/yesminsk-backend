const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const out = mkdtempSync(join(tmpdir(), 'gulyai-nearby-test-'));
process.on('exit', () => rmSync(out, { recursive: true, force: true }));
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', 'src/nearbyInvite.ts', '--outDir', out,
  '--module', 'commonjs', '--target', 'es2022', '--skipLibCheck', '--esModuleInterop', '--strict']);
symlinkSync(join(process.cwd(), 'node_modules'), join(out, 'node_modules'), 'dir');
const { nearbyMatchScore: score, nearbyDescription } = require(join(out, 'nearbyMatch.js'));
const event = { category: 'cinema', dateTime: new Date('2026-11-21T15:00:00Z'), isPaid: true, price: 20 };
const user = (activities, extra = {}) => ({ questionnaire: { version: 1, activities, ...extra } });

test('detailed interests override broad legacy interests; favourite and concrete wishes lead', () => {
  const cinema = user(['Кино']);
  const expo = { ...user(['Выставки и музеи']), goals: ['expo_cinema'] };
  assert.ok(score(event, cinema, null) > score(event, {}, null));
  assert.ok(score(event, {}, null) > score(event, expo, null));
  assert.ok(score(event, user(['Кино'], { favouriteActivity: 'Кино' }), null) > score(event, cinema, null));
  assert.ok(score(event, expo, null, true) > score(event, user(['Кино'], { favouriteActivity: 'Кино' }), null));
  assert.ok(score(event, { goals: ['expo_cinema'] }, null) > score(event, {}, null));
  assert.equal(score({ ...event, category: 'other' }, user(['Кино']), null), score({ ...event, category: 'other' }, {}, null));
});

test('schedule uses Minsk weekend/night boundaries and flexible schedule stays neutral', () => {
  const q = a => user(['Кино'], { availability: [a] });
  assert.ok(score(event, q('В выходные вечером'), null) > score(event, q('В будни вечером'), null));
  const fridayNight = { ...event, dateTime: new Date('2026-11-20T21:00:00Z') };
  assert.ok(score(fridayNight, q('Поздним вечером и ночью'), null) > score(fridayNight, q('В выходные днём'), null));
  assert.equal(score(event, q('У меня плавающий график'), null), score(event, user(['Кино']), null));
});

test('budget and area are soft tie breakers; unknown prices and donations are neutral', () => {
  const budget = user(['Кино'], { budget: ['До 15 BYN'] });
  assert.ok(score(event, user(['Кино'], { budget: ['Больше 15, но не больше 35 BYN'] }), null) > score(event, budget, null));
  assert.equal(score({ ...event, price: undefined }, budget, null), score({ ...event, price: undefined }, user(['Кино']), null));
  assert.equal(score({ ...event, donation: true }, budget, null), score({ ...event, donation: true }, user(['Кино']), null));
  assert.ok(score(event, user(['Кино'], { meetingAreas: ['Уручье'] }), 'Уручье') > score(event, user(['Кино']), 'Уручье'));
  assert.ok(score(event, budget, null) > score(event, {}, null));
});

test('private answers and free text never influence ranking; descriptions stay short and preserve emoji', () => {
  const basic = user(['Кино']);
  const privateUser = { ...basic, questionnaire: { ...basic.questionnaire, personal: { alcohol: { values: ['secret'], visible: false } }, wantDetails: 'secret' } };
  assert.equal(score(event, basic, null), score(event, privateUser, null));
  assert.equal(nearbyDescription('  Играем\n вместе  '), 'Играем вместе');
  assert.equal(Array.from(nearbyDescription('😀'.repeat(300))).length, 240);
});

test('loop ranks before the 60-person cap, keeps limits/radius, and sends escaped public event context', async () => {
  const { Event } = require(join(out, 'models/Event.js'));
  const { User } = require(join(out, 'models/User.js'));
  const { Wish } = require(join(out, 'models/Wish.js'));
  const { RecruitPing } = require(join(out, 'recruitHelp.js'));
  const { NearbyPing, startNearbyLoop } = require(join(out, 'nearbyInvite.js'));
  const originals = [];
  const replace = (obj, key, value) => { originals.push(() => obj[key] = value); obj[key] = value; };
  const env = { ...process.env };
  const now = new Date('2026-11-20T12:00:00Z').getTime();
  const ev = { ...event, _id: '000000000000000000000001', title: 'Кино', description: '<b>Смотрим вместе</b> & обсуждаем',
    category: 'cinema', creator: { telegramId: 999, name: '<Миша>' }, participants: [{ telegramId: 999 }],
    location: { coordinates: [27.552, 53.9045] }, locationName: 'Кинотеатр', maxParticipants: 0,
    createdAt: new Date(now - 3600000), isActive: true };
  const people = Array.from({ length: 60 }, (_, i) => ({ telegramId: i + 1, areaName: 'Немига / Центр', ...user(['Выставки и музеи']) }));
  people.push({ telegramId: 61, areaName: 'Немига / Центр', ...user(['Кино']) });
  people.push({ telegramId: 62, areaName: 'Немига / Центр', ...user(['Кино']), nearbyPerDay: 1 });
  people.push({ telegramId: 63, areaName: 'Уручье', ...user(['Кино']) });
  const sent = [], updates = [];
  let scheduled;
  try {
    process.env.TELEGRAM_BOT_TOKEN = 'fake'; process.env.MINI_APP_URL = 'https://example.test';
    replace(Date, 'now', () => now);
    replace(Event, 'find', async () => [ev]);
    replace(Event, 'updateOne', async (filter, update) => { updates.push(update); return { modifiedCount: 1 }; });
    replace(User, 'findOne', () => ({ lean: async () => ({ gender: 'male', age: 25 }) }));
    replace(User, 'find', (query, projection) => {
      assert.equal(query.nearbyNotify.$ne, false);
      assert.equal(query.canMessage.$ne, false);
      assert.ok(query.telegramId.$nin.includes(999));
      assert.equal(projection.questionnaire, undefined);
      assert.equal(projection['questionnaire.personal'], undefined);
      return { lean: async () => people };
    });
    replace(RecruitPing, 'distinct', async () => []);
    replace(RecruitPing, 'aggregate', async () => []);
    replace(NearbyPing, 'aggregate', async () => [{ _id: 62, n: 1 }]);
    replace(NearbyPing, 'create', async p => ({ toObject: () => ({ ...p, _id: '000000000000000000000002' }) }));
    replace(NearbyPing, 'updateOne', async () => ({}));
    replace(Wish, 'find', () => { throw new Error('No template: no wish query expected'); });
    replace(global, 'fetch', async (_url, options) => { sent.push(JSON.parse(options.body)); return { json: async () => ({ ok: true }) }; });
    replace(global, 'setTimeout', (fn, delay) => { if (delay === 60) fn(); else scheduled = fn; return 1; });
    replace(global, 'setInterval', () => 1);
    startNearbyLoop(); await scheduled();
    const invitations = sent.filter(s => s.chat_id !== 999);
    assert.equal(invitations.length, 60);
    assert.equal(invitations[0].chat_id, 61);
    assert.equal(invitations.some(s => [62, 63].includes(s.chat_id)), false);
    assert.match(invitations[0].text, /Организатор: &lt;Миша&gt;/);
    assert.match(invitations[0].text, /&lt;b&gt;Смотрим вместе&lt;\/b&gt; &amp; обсуждаем/);
    assert.match(invitations[0].reply_markup.inline_keyboard[0][0].web_app.url, /\?event=.*&near=/);
    assert.equal(updates.at(-1).$set.nearbyInvitedCount, 60);

    // A concrete matching wish leads even before a favourite, without bypassing caps.
    ev.templateId = 'cinema'; ev.placeId = 'public-place';
    Wish.find = query => {
      assert.equal(query.kind, 'cinema');
      assert.deepEqual(query.status, { $in: ['active', 'matched'] });
      assert.equal(query.windowStart.$lte, ev.dateTime);
      assert.equal(query.windowEnd.$gte, ev.dateTime);
      assert.deepEqual(query.$or.at(-1), { placeId: 'public-place' });
      return { lean: async () => [{ telegramId: 60 }, { telegramId: 62 }] };
    };
    sent.length = 0;
    startNearbyLoop(); await scheduled();
    assert.equal(sent[0].chat_id, 60);
    assert.equal(sent[1].chat_id, 61);
    assert.equal(sent.some(s => s.chat_id === 62), false);

    // Failure of the optional wishes read still delivers the invitations.
    Wish.find = () => ({ lean: async () => { throw new Error('temporary read failure'); } });
    sent.length = 0;
    startNearbyLoop(); await scheduled();
    assert.equal(sent[0].chat_id, 61);
    assert.equal(sent.filter(s => s.chat_id !== 999).length, 60);
  } finally { for (const restore of originals.reverse()) restore(); process.env = env; }
});
