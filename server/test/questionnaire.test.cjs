const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanQuestionnaire, publicQuestionnaire } = require('../dist/profile/validation.js');
const { CORE_QUESTIONS, PERSONAL_QUESTIONS, questionnaireComplete } = require('../dist/profile/questionnaire.js');
const { User } = require('../dist/models/User.js');

test('all hidden personal answers are omitted from public payloads, with no key or value leakage', () => {
  const personal = Object.fromEntries(PERSONAL_QUESTIONS.map(q => [q.key, { values: [q.options[0]], visible: false }]));
  const input = cleanQuestionnaire({ activities: ['Кофе и разговоры'], personal });
  assert.equal(Object.keys(input.personal).length, 10);
  const output = publicQuestionnaire(input);
  assert.deepEqual(output.personal, {});
  assert.deepEqual(output.activities, ['Кофе и разговоры']);
  for (const key of Object.keys(personal)) assert.equal(JSON.stringify(output).includes(key), false);
});
test('public disclosure requires literal true, and revoking permission removes it again', () => {
  const values = ['Нормально, если другие пьют умеренно'];
  for (const visible of [false, undefined, 'true', 1]) assert.deepEqual(publicQuestionnaire({ personal: { alcohol: { values, visible } } }).personal, {});
  assert.deepEqual(publicQuestionnaire({ personal: { alcohol: { values, visible: true } } }).personal.alcohol.values, values);
});
test('all Minsk keeps chosen suburbs, but removes redundant city districts', () => {
  assert.deepEqual(cleanQuestionnaire({ meetingAreas: ['Боровляны', 'Весь Минск', 'Немига / Центр', 'Колодищи'] }).meetingAreas, ['Боровляны', 'Весь Минск', 'Колодищи']);
});
test('optional answers can be cleared; clearing wants also removes stale detail text', () => {
  const saved = cleanQuestionnaire({ wants: [], wantDetails: 'obsolete text', personal: { alcohol: { values: [], visible: true } } });
  assert.equal(saved.wantDetails, ''); assert.deepEqual(saved.personal, {}); assert.deepEqual(saved.wants, []);
  assert.equal(questionnaireComplete(saved), false);
});
test('reject invalid shapes, unknown options and over-limit selections', () => {
  for (const input of [null, [], 'text', { budget: ['unknown'] }, { activities: 'Кофе и разговоры' }, { personal: { alcohol: { values: ['unknown'], visible: true } } }, { activities: CORE_QUESTIONS.find(q => q.key === 'activities').options.slice(0, 6) }]) assert.throws(() => cleanQuestionnaire(input));
  assert.equal(publicQuestionnaire({ budget: ['unknown'] }), undefined);
});
test('exclusive choices and favourites stay consistent', () => {
  const q = cleanQuestionnaire({ companySizes: ['Вдвоём', 'Размер компании не важен'], activities: ['Кофе и разговоры'], favouriteActivity: 'Кино' });
  assert.deepEqual(q.companySizes, ['Размер компании не важен']); assert.equal(q.favouriteActivity, undefined);
});
test('questionnaire persists in the Mongoose schema without connecting to a database', async () => {
  const q = cleanQuestionnaire({ meetingAreas: ['Колодищи'], personal: { alcohol: { values: ['Хочу встречи без алкоголя'], visible: false } } });
  const user = new User({ telegramId: 1, firstName: 'Test', avatarUrl: 'https://example.com/photo.jpg', locationFuzzy: { type: 'Point', coordinates: [27.5,53.9] }, questionnaire: q, profileInviteSeenVersion: 1 });
  await user.validate(); assert.deepEqual(user.toObject().questionnaire, q); assert.equal(user.toObject().profileInviteSeenVersion, 1);
});
test('new detailed activities remain discoverable with existing people filters', () => {
  const { legacyActivities } = require('../dist/profile/questionnaire.js');
  assert.deepEqual(legacyActivities(['Кофе и разговоры','Кафе и рестораны','Настольные игры']).goals, ['cafe_bar','boardgames']);
  const custom = legacyActivities(['Концерты','Вечеринки и танцы']);
  assert.deepEqual(custom.goals, ['other']); assert.ok(custom.customGoal.length <= 30 && custom.customGoal.includes('Концерты'));
});
