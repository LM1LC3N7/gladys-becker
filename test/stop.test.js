// -----------------------------------------------------------------------------
// The stop is never blocked, and only an answered send counts as a try.
// Every guard of the stop path has its test here; all waits are on the
// virtual clock (no test can hang on a mutant: a missing send fails an
// assertion, it never waits).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { settle } from './helpers/clock.js';
import { ADDRESS } from './helpers/fakeBox.js';
import { CONFIG, D, MINUTE, SECOND, cover, setup } from './helpers/app.js';

const isStop = (method, p) =>
  method === 'deviced.group_send_command' && p.command === 'move' && p.value === 0;

test('a stop leaves at once while a read hangs, and cuts that read', async (t) => {
  const s = await setup({ latency: (m) => (m === 'deviced.group_get_state' ? 30 * SECOND : 30) });
  t.after(() => s.stop());
  // The first cycle is stuck in the state read of cover 1.
  assert.equal(s.box.open, 1);
  const at = s.clock.elapsed;
  const c = await s.click(1, 'state', 0, { wait: 100 });
  assert.equal(s.box.stops(1).length, 1);
  assert.ok(s.box.stops(1)[0].at - at < 5, 'left at once');
  assert.equal(c.ack.success, true);
  assert.equal(s.box.open, 0, 'the read was cut');
});

test('a stop leaves during a pause (429), with frozen /data, before any list, and on another type', async (t) => {
  const store = memoryStore();
  const s = await setup({
    store,
    mode: (m) =>
      m === 'deviced.deviced_get_item_list'
        ? { status: 429, headers: { 'retry-after': '600' } }
        : undefined,
  });
  t.after(() => {
    store.hang = false;
    return s.stop();
  });
  assert.ok(s.app.pauseLeft() > 0, 'paused');
  assert.equal(s.app.listed, false);
  store.hang = true;
  // Three stops in a row, /data frozen: all leave.
  for (const id of [1, 2, 3]) await s.click(id, 'state', 0, { wait: 0 });
  await s.clock.advance(200);
  assert.deepEqual(
    s.box.stops().map((r) => r.params.group_id),
    [1, 2, 3],
  );
  // An open is refused meanwhile (pause), nothing sent.
  const o = await s.click(1, 'state', 1);
  assert.equal(o.ack.success, false);
  assert.equal(s.box.commands((p) => p.value === -1).length, 0);
});

test('a stop leaves for a cover the box now lists with another type', async (t) => {
  const s = await setup({ devices: [cover(1, { type: 'awning' })] });
  t.after(() => s.stop());
  const c = await s.click(1, 'state', 0);
  assert.equal(c.ack.success, true);
  assert.equal(s.box.stops(1).length, 1);
  const close = await s.click(1, 'state', -1);
  assert.equal(close.ack.success, false, 'a close is refused: its direction could be wrong');
  assert.equal(s.box.commands((p) => p.value === 1 || p.value === -1).length, 0);
});

test('an unanswered stop is never given up: tries count answered sends only', async (t) => {
  const store = memoryStore();
  let deaf = true;
  const s = await setup({
    store,
    mode: (m, p) => (deaf && isStop(m, p) ? 'drop' : undefined),
  });
  t.after(() => s.stop());
  const c = await s.click(1, 'state', 0);
  assert.equal(c.ack.success, false, 'never "applied" without an answer');
  const inBudget = s.box.stops(1).length;
  await s.clock.advance(40 * SECOND);
  assert.ok(s.box.stops(1).length >= inBudget + 3, 'sent again at 5, 10 and 20 s');
  assert.ok(s.box.stops(1).length >= 2, 'written again within its budget');
  assert.equal(store.data.stops.length, 1);
  assert.equal(store.data.stops[0].tries, 0);
  assert.equal(store.data.stops[0].address, ADDRESS);
  await s.clock.advance(30 * MINUTE);
  const sends = s.box.stops(1).length;
  assert.ok(sends >= 30, `still sent after 30 minutes (${sends})`);
  assert.equal(store.data.stops.length, 1, 'kept in /data, no age limit');
  assert.equal(store.data.stops[0].tries, 0, 'no answer, no try');
  assert.match(s.badge(1).message.en, /not answered yet/);
  deaf = false;
  await s.clock.advance(2 * MINUTE);
  assert.equal(store.data.stops.length, 0, 'answered, read back stopped: removed');
  assert.notEqual(s.badge(1).degraded, true);
});

test('a 429 or a refused connection never counts as a try', async (t) => {
  let answers = 0;
  const store = memoryStore();
  const s = await setup({
    store,
    mode: (m, p) => {
      if (!isStop(m, p)) return undefined;
      answers += 1;
      return answers % 2 ? { status: 429 } : 'refuse';
    },
  });
  t.after(() => s.stop());
  s.box.stuck = true;
  await s.click(1, 'state', 0);
  await s.clock.advance(10 * MINUTE);
  assert.ok(answers > 10);
  assert.equal(store.data.stops[0].tries, 0);
  assert.equal(s.app.stops.size, 1);
});

test('answered but still moving the same way: sent again, three answered tries at most', async (t) => {
  const store = memoryStore();
  const s = await setup({ store });
  t.after(() => s.stop());
  s.box.states.get(1).moving_down = 1;
  s.box.stuck = true;
  await s.click(1, 'state', 0);
  await s.clock.advance(5 * MINUTE);
  assert.equal(s.box.stops(1).length, 3);
  assert.equal(s.app.stops.size, 0);
  assert.equal(store.data.stops.length, 0);
  assert.match(s.badge(1).message.en, /after 3 answered tries/);
});

test('each check is a read that left after the answer of the stop', async (t) => {
  const s = await setup();
  t.after(() => s.stop());
  s.box.states.get(1).moving_down = 1;
  s.box.stuck = true;
  await s.click(1, 'state', 0, { wait: 0 });
  await s.clock.advance(5 * MINUTE);
  const stops = s.box.stops(1);
  for (let i = 1; i < stops.length; i += 1) {
    const reads = s.box.reads(1).filter((r) => r.at > stops[i - 1].at && r.at < stops[i].at);
    assert.ok(reads.length >= 1, `a read between send ${i} and ${i + 1}`);
  }
});

test('a move the other way started elsewhere is never stopped by a resend', async (t) => {
  const s = await setup();
  t.after(() => s.stop());
  s.box.states.get(1).moving_down = 1;
  await s.clock.advance(MINUTE); // a read sees it go down
  await s.click(1, 'state', 0, { wait: 0 });
  await s.clock.advance(200);
  // The remote sends it up right after the stop.
  s.box.stuck = true;
  Object.assign(s.box.states.get(1), { moving_up: 1, moving_down: 0 });
  await s.clock.advance(2 * MINUTE);
  assert.equal(s.box.stops(1).length, 1);
  assert.equal(s.app.stops.size, 0);
  assert.match(s.badge(1).message.en, /other direction/);
});

test('a motor without feedback: one answered stop is all there is', async (t) => {
  const s = await setup();
  t.after(() => s.stop());
  await s.click(4, 'state', 0);
  await s.clock.advance(MINUTE / 2);
  assert.equal(s.box.stops(4).length, 1);
  assert.equal(s.box.reads(4).length, 0);
  assert.equal(s.app.stops.size, 0);
});

test('nothing clicked before a stop leaves after it: queued moves and closes are dropped', async (t) => {
  const s = await setup({ latency: (m, p) => (p.command === 'moveto' ? 3000 : 30) });
  t.after(() => s.stop());
  const first = await s.click(1, 'position', 30, { wait: 0 });
  const second = await s.click(1, 'position', 50, { wait: 0 });
  const stop = await s.click(1, 'state', 0, { wait: 0 });
  await s.clock.advance(5000);
  await Promise.all([first.pending, second.pending, stop.pending]);
  const sent = s.box.commands((p) => p.group_id === 1).map((r) => r.params);
  assert.deepEqual(sent, [
    { group_id: 1, command: 'moveto', value: 70 },
    { group_id: 1, command: 'move', value: 0 },
  ]);
  assert.equal(second.ack.success, false);
  assert.equal(second.ack.error.why, 'stopped');
});

test('a close still trying when a stop is clicked never leaves after it', async (t) => {
  let refuse = true;
  const s = await setup({
    mode: (m, p) => (refuse && p.command === 'move' && p.value === 1 ? 'refuse' : undefined),
  });
  t.after(() => s.stop());
  const close = await s.click(1, 'state', -1, { wait: 0 });
  await s.clock.advance(600);
  const stop = await s.click(1, 'state', 0, { wait: 0 });
  refuse = false;
  await s.clock.advance(5000);
  await Promise.all([close.pending, stop.pending]);
  assert.equal(s.box.commands((p) => p.value === 1).length, 0);
  assert.equal(s.box.stops(1).length, 1);
});

test('a newer open accepted by the box replaces the stop; one without answer does not', async (t) => {
  const store = memoryStore();
  let dropStop = true;
  let dropOpen = true;
  const s = await setup({
    store,
    mode: (m, p) => {
      if (dropStop && isStop(m, p)) return 'drop';
      if (dropOpen && p.command === 'move' && p.value === -1) return 'drop';
      return undefined;
    },
  });
  t.after(() => s.stop());
  await s.click(1, 'state', 0);
  assert.equal(s.app.stops.size, 1);
  // Open without answer: in doubt the stop still goes, at once.
  dropStop = false;
  const before = s.box.stops(1).length;
  const open = await s.click(1, 'state', 1, { wait: 4400 });
  assert.equal(open.ack.success, false);
  assert.equal(s.app.stops.size, 1);
  await s.clock.advance(1000);
  assert.ok(s.box.stops(1).length > before, 'the stop went right after the unanswered open');
  await s.clock.advance(MINUTE);
  assert.equal(s.app.stops.size, 0);
  // Again, the open answered this time: the stop is replaced and never sent after it.
  dropStop = true;
  await s.click(1, 'state', 0);
  dropOpen = false;
  const open2 = await s.click(1, 'state', 1);
  assert.equal(open2.ack.success, true);
  assert.equal(s.app.stops.size, 0);
  assert.equal(store.data.stops.length, 0);
  const openAt = s.box.commands((p) => p.value === -1).at(-1).at;
  await s.clock.advance(10 * MINUTE);
  assert.equal(s.box.stops(1).filter((r) => r.at > openAt).length, 0);
});

test('the stops of /data leave at boot, before Gladys and its configuration', async (t) => {
  const store = memoryStore({
    stops: [
      {
        id: 2,
        address: ADDRESS,
        clickedAt: Date.UTC(2026, 0, 1),
        tries: 1,
        dir: 'down',
        feedback: true,
      },
      { id: 'x', address: ADDRESS },
      { id: 3, address: 'not an address!' },
    ],
  });
  const s = await setup({ store, start: false });
  t.after(() => s.stop());
  await s.app.boot();
  await s.clock.advance(100);
  assert.deepEqual(
    s.box.stops().map((r) => [r.params.group_id, r.host]),
    [[2, ADDRESS]],
  );
  assert.equal(s.box.log.length, 1, 'no list, no read before it');
  // Cover 3 had no valid address: kept, and sent with the configuration.
  assert.equal(s.app.stops.size, 2);
  await s.app.start(CONFIG);
  await s.clock.advance(5 * SECOND);
  assert.ok(s.box.stops(3).length >= 1);
});

test('a stop without any address known is kept and leaves with the configuration', async (t) => {
  const s = await setup({ start: false });
  t.after(() => s.stop());
  await s.app.boot();
  const c = await s.click(1, 'state', 0);
  assert.equal(c.ack.success, false);
  assert.equal(s.box.log.length, 0);
  await s.app.start(CONFIG);
  await s.clock.advance(2000);
  assert.equal(s.box.stops(1).length, 1);
});

test('getConfig failing: the stop goes to the address kept in /data', async (t) => {
  const store = memoryStore({ address: ADDRESS });
  const s = await setup({ store, start: false });
  t.after(() => s.stop());
  await s.app.boot();
  await s.app.connected(() => Promise.reject(new Error('Gladys busy')));
  const c = await s.click(5, 'state', 0);
  assert.equal(c.ack.success, true);
  assert.equal(s.box.stops(5)[0].host, ADDRESS);
});

test('/data unreadable: never overwritten, stops still go', async (t) => {
  const store = memoryStore(null, { broken: true });
  const s = await setup({ store });
  t.after(() => s.stop());
  await s.click(1, 'state', 0);
  assert.equal(store.saves, 0);
  assert.equal(s.box.stops(1).length, 1);
  assert.match(s.gladys.fake.connectionStatus.message.en, /\/data unreadable/);
});

test('the check of a stop is armed before /data is written, and a slow /data holds nothing', async (t) => {
  const store = memoryStore();
  const s = await setup({ store });
  t.after(() => {
    store.hang = false;
    return s.stop();
  });
  store.hang = true;
  s.box.states.get(1).moving_down = 1;
  s.box.stuck = true;
  await s.click(1, 'state', 0, { wait: 0 });
  await s.clock.advance(MINUTE);
  assert.equal(s.box.stops(1).length, 3, 'checked and sent again, /data frozen');
  await settle();
  assert.equal(s.badge(1).device_external_id, D(1));
});

test('a read that left before the answer of the stop never decides it', async (t) => {
  const s = await setup();
  t.after(() => s.stop());
  const token = {};
  const stop = {
    id: 1,
    address: ADDRESS,
    clickSeq: 0,
    clickedAt: 0,
    tries: 1,
    feedback: true,
    answered: true,
    answeredSeq: s.app.seq + 1000,
    retryIndex: 0,
    token,
  };
  s.app.stops.set(1, stop);
  const check = s.app.checkStop(stop, token);
  await settle();
  await s.clock.advance(100);
  await check;
  assert.equal(s.app.stops.get(1), stop, 'not decided by an older read');
  assert.ok(stop.timer !== undefined, 'checked again later');
});
