const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchedUsername, meetupHostUsername } = require('../dist/contactPrivacy');
const { joinEvent } = require('../dist/eventJoin');
const { seatsTaken } = require('../dist/eventNotify');
const { Event, participantPending } = require('../dist/models/Event');
const { User } = require('../dist/models/User');
const telegram = require('../dist/utils/telegramNotify');
const analytics = require('../dist/analytics');

const host = { telegramId: 1, hasAgreedToRules: true, username: 'host_test' };
const person = { telegramId: 2, hasAgreedToRules: true, username: 'person_test' };

test('people contacts require an active mutual connection', () => {
  assert.equal(matchedUsername(host, person, false), undefined);
  assert.equal(matchedUsername(null, person, true), undefined);
  assert.equal(matchedUsername({ ...host, isBanned: true }, person, true), undefined);
  assert.equal(matchedUsername(host, { ...person, hiddenByReports: true }, true), undefined);
  assert.equal(matchedUsername(host, { ...person, blockedUsers: [host.telegramId] }, true), undefined);
  assert.equal(matchedUsername({ ...host, blockedUsers: [person.telegramId] }, person, true), undefined);
  assert.equal(matchedUsername(host, person, true), person.username);
});

test('meetup participants see the host contact only after organizer approval', () => {
  const event = { creator: host };
  const booking = { telegramId: person.telegramId };
  assert.equal(meetupHostUsername(event, host.telegramId), host.username);
  assert.equal(meetupHostUsername(event, person.telegramId), undefined);
  assert.equal(meetupHostUsername(event, person.telegramId, booking), undefined);
  assert.equal(meetupHostUsername(event, person.telegramId, { ...booking, approvedAt: new Date() }), host.username);
  assert.equal(meetupHostUsername(event, 99, { ...booking, approvedAt: new Date() }), undefined);
});

test('repeated cancellations make an open-meetup signup pending without reserving a seat', async (t) => {
  t.mock.method(User, 'exists', async () => null);
  const count = t.mock.method(Event, 'countDocuments', () => ({ limit: async () => 3 }));
  const limit = t.mock.method(User, 'updateOne', async () => ({ matchedCount: 1 }));
  const notify = t.mock.method(telegram, 'sendTelegramMessage', async () => {});
  t.mock.method(analytics, 'captureAnalytics', () => {});
  const event = new Event({
    title: 'Тестовая сходка',
    creator: host,
    participants: [host],
    dateTime: new Date(Date.now() + 3600000),
    maxParticipants: 2
  });
  t.mock.method(event, 'save', async () => event);
  const join = () => joinEvent(event, person, { id: person.telegramId }, { guests: 0, withKids: false });

  assert.deepEqual(await join(), { ok: true, changed: true });
  const booking = event.participants[1];
  assert.equal(participantPending(event, booking), true);
  assert.equal(seatsTaken(event), 1);
  assert.equal(meetupHostUsername(event, person.telegramId, booking), undefined);
  assert.equal(count.mock.callCount(), 1);
  assert.equal(limit.mock.callCount(), 1);
  assert.match(notify.mock.calls[0].arguments[1], /хочет записаться/);
  assert.doesNotMatch(notify.mock.calls[0].arguments[1], /person_test/);
  assert.deepEqual(await join(), { ok: true, changed: false });
  assert.equal(limit.mock.callCount(), 1);
  booking.approvedAt = new Date();
  assert.equal(seatsTaken(event), 2);
  assert.equal(meetupHostUsername(event, person.telegramId, booking), host.username);
});

test('account rate limit rejects a new signup before writing or notifying', async (t) => {
  t.mock.method(User, 'exists', async () => null);
  t.mock.method(Event, 'countDocuments', () => ({ limit: async () => 0 }));
  const limit = t.mock.method(User, 'updateOne', async () => ({ matchedCount: 0 }));
  const event = new Event({ creator: host, participants: [host] });
  const save = t.mock.method(event, 'save', async () => event);
  const result = await joinEvent(event, person, { id: person.telegramId }, { guests: 0, withKids: false });

  assert.equal(result.status, 429);
  assert.equal(save.mock.callCount(), 0);
  assert.equal(event.participants.length, 1);
  const [filter, update] = limit.mock.calls[0].arguments;
  assert.equal(filter.telegramId, person.telegramId);
  assert.equal(filter.$expr.$and[0].$lt[1], 8);
  assert.ok(update[0].$set.recentJoinAttempts);
});

test('mass and fast waves stop before creating a new reaction', async (t) => {
  const { sendLike, WaveBurstError } = require('../dist/social');
  const { Reaction } = require('../dist/models/Reaction');
  t.mock.method(Reaction, 'findOne', async () => null);
  const reaction = t.mock.method(Reaction, 'findOneAndUpdate', async () => null);
  const limit = t.mock.method(User, 'updateOne', async () => ({ matchedCount: 0 }));

  await assert.rejects(sendLike(host, person, '', { free: true }), WaveBurstError);
  assert.equal(await sendLike(host, person, '', { free: true, bulk: true }), null);
  assert.equal(await sendLike({ ...host, isBanned: true }, person), null);
  assert.equal(reaction.mock.callCount(), 0);
  const [single, bulk] = limit.mock.calls;
  assert.ok(single.arguments[1][0].$set.recentWaveAttempts);
  assert.ok(bulk.arguments[1][0].$set.dailyBulkWaveAttempts);
});
