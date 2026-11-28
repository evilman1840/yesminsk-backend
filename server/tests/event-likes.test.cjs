const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupEventLikeRoutes } = require('../dist/eventLikes');
const { Event } = require('../dist/models/Event');
const { User } = require('../dist/models/User');

const routes = new Map();
setupEventLikeRoutes({
  get: (path, ...handlers) => routes.set(`GET ${path}`, handlers.at(-1)),
  post: (path, ...handlers) => routes.set(`POST ${path}`, handlers.at(-1))
}, event => ({ id: String(event._id) }), () => false);
const id = '507f1f77bcf86cd799439011';
async function request(method, body, eventId = id) {
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await routes.get(method)({ telegramUser: { id: 42 }, params: { id: eventId }, body }, response);
  return response;
}
const route = 'POST /api/events/:id/like';
test('invalid ids and non-boolean likes are rejected before touching the database', async t => {
  const read = t.mock.method(User, 'findOne', () => { throw new Error('unexpected database access'); });
  assert.equal((await request(route, { liked: true }, 'bad-id')).statusCode, 404);
  for (const liked of [undefined, 'false', 1, null]) assert.equal((await request(route, { liked })).statusCode, 400);
  assert.equal(read.mock.callCount(), 0);
});
test('banned and missing accounts cannot change likes', async t => {
  const account = t.mock.method(User, 'findOne', () => ({ lean: async () => ({ isBanned: true }) }));
  const write = t.mock.method(Event, 'findOneAndUpdate', async () => { throw new Error('unexpected write'); });
  assert.equal((await request(route, { liked: true })).statusCode, 403);
  account.mock.mockImplementation(() => ({ lean: async () => null }));
  assert.equal((await request(route, { liked: false })).statusCode, 403);
  assert.equal(write.mock.callCount(), 0);
});
test('like uses authenticated identity and returns only count and own state', async t => {
  t.mock.method(User, 'findOne', () => ({ lean: async () => ({ gender: 'female', age: 30 }) }));
  const write = t.mock.method(Event, 'findOneAndUpdate', async () => ({ likedBy: [7, 42], participants: [{ telegramId: 7 }] }));
  const response = await request(route, { liked: true, telegramId: 999 });
  assert.deepEqual(response.body, { isLiked: true, likesCount: 2 });
  const [filter, update, options] = write.mock.calls[0].arguments;
  assert.equal(filter.isActive, true);
  assert.deepEqual(filter.stopWordsHold, { $ne: true });
  assert.ok(filter.$or);
  assert.deepEqual(update, { $addToSet: { likedBy: 42 } });
  assert.equal(options.new, true);
});
test('unlike remains possible after audience changes and uses atomic removal', async t => {
  t.mock.method(User, 'findOne', () => ({ lean: async () => ({}) }));
  const write = t.mock.method(Event, 'findOneAndUpdate', async () => ({ likedBy: [7] }));
  assert.deepEqual((await request(route, { liked: false })).body, { isLiked: false, likesCount: 1 });
  const [filter, update] = write.mock.calls[0].arguments;
  assert.equal(filter.$or, undefined);
  assert.deepEqual(update, { $pull: { likedBy: 42 } });
});
test('unavailable events and storage failures do not report a successful like', async t => {
  t.mock.method(User, 'findOne', () => ({ lean: async () => ({}) }));
  const write = t.mock.method(Event, 'findOneAndUpdate', async () => null);
  assert.equal((await request(route, { liked: true })).statusCode, 404);
  write.mock.mockImplementation(async () => { throw new Error('offline'); });
  assert.equal((await request(route, { liked: true })).statusCode, 500);
});
test('saved list is personal and excludes unavailable events', async t => {
  t.mock.method(User, 'findOne', () => ({ lean: async () => ({}) }));
  const read = t.mock.method(Event, 'find', () => ({ sort: async () => [{ _id: id }] }));
  const response = await request('GET /api/events/liked');
  assert.deepEqual(response.body, [{ id }]);
  const filter = read.mock.calls[0].arguments[0];
  assert.equal(filter.likedBy, 42);
  assert.equal(filter.isActive, true);
  assert.deepEqual(filter.stopWordsHold, { $ne: true });
  assert.ok(filter.$or);
});
