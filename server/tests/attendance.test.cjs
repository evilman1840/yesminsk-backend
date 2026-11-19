const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/attendanceStats.ts'), 'utf8');
const exports_ = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: exports_, Map, Set, Date });
const { countAttendance } = exports_;
const now = Date.parse('2026-11-19T12:00:00Z');
const event = (extra = {}) => ({ dateTime: new Date(now - 86400000), participants: [{ telegramId: 1 }, { telegramId: 2 }], ...extra });

test('counts each participant once per held meetup, including its organiser', () => {
  const counts = countAttendance([event({ participants: [{ telegramId: 1 }, { telegramId: 1 }, { telegramId: 2 }] }), event()], now);
  assert.equal(counts.get(1), 2);
  assert.equal(counts.get(2), 2);
});
test('does not count future, cancelled, single-person or no-show meetups', () => {
  const counts = countAttendance([
    event({ dateTime: new Date(now + 1) }), event({ dateTime: new Date(now) }), event({ isActive: false }),
    event({ participants: [{ telegramId: 1 }, { telegramId: 1 }] }),
    event({ participants: [{ telegramId: 1 }, { telegramId: 2, noShowAt: new Date(now) }] }),
    event({ participants: [] }), event({ dateTime: 'invalid' })
  ], now);
  assert.equal(counts.size, 0);
});
test('excludes a no-show without discarding other attendees when two remain', () => {
  const counts = countAttendance([event({ participants: [{ telegramId: 1 }, { telegramId: 2 }, { telegramId: 3, noShowAt: new Date(now) }] })], now);
  assert.equal(counts.get(1), 1);
  assert.equal(counts.get(2), 1);
  assert.equal(counts.has(3), false);
});
