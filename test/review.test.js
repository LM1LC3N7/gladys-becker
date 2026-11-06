// -----------------------------------------------------------------------------
// The points of review r1: a box that does not echo the JSON-RPC id, any answer
// counting as a try, the read back of a stop under a pause, a slow /data at
// start, and every guard a mutant showed without a test. Virtual clock; every
// wait is bounded (a mutant fails an assertion, it never hangs a test).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { itemId, positionOf } from '../src/model.js';
import { settle } from './helpers/clock.js';
import { ADDRESS } from './helpers/fakeBox.js';
import { CONFIG, D, F, MINUTE, SECOND, cover, sensor, setup } from './helpers/app.js';

const HOUR = 60 * MINUTE;
const isStop = (m, p) =>
  m === 'deviced.group_send_command' && p.command === 'move' && p.value === 0;
const lists = (s) => s.box.log.filter((r) => r.method === 'deviced.deviced_get_item_list');

// --- I1: the id echo -----------------------------------------------------------

for (const echo of [0, 'absent', null]) {
  test(`a box that answers id ${echo} works: lists, positions, one stop`, async (t) => {
    const s = await setup({ start: false });
    s.box.echo = echo;
    t.after(() => s.stop());
    await s.app.boot();
    await s.app.start(CONFIG);
    await s.clock.advance(2000);
    assert.equal(s.gladys.fake.connectionStatus.connected, true);
    assert.equal(s.gladys.fake.lastState(F(1, 'position')), 100);
    const c = await s.click(1, 'state', 0);
    assert.equal(c.ack.success, true);
    await s.clock.advance(3 * MINUTE);
    assert.equal(s.box.stops(1).length, 1);
    assert.equal(s.app.stops.size, 0);
  });
}

// --- I2: any answer is a try; a slow answer is an answer --------------------------

for (const [label, answer] of [
  ['a 404', { status: 404 }],
  ['an HTML page', { status: 200, body: '<html>busy</html>' }],
  ['a refusal of the box', 'rpcError'],
  ['a redirection', { status: 302, headers: { location: '/x' } }],
]) {
  test(`${label} to a stop is an answered try: 3 at most, then given up`, async (t) => {
    const s = await setup({ mode: (m, p) => (isStop(m, p) ? answer : undefined) });
    t.after(() => s.stop());
    s.box.states.get(1).moving_down = 1;
    s.box.stuck = true;
    const c = await s.click(1, 'state', 0);
    assert.equal(c.ack.success, false, 'never acked "sent" when not accepted');
    assert.match(s.badge(1).message.en, /not accepted/);
    await s.clock.advance(5 * MINUTE);
    assert.equal(s.box.stops(1).length, 3);
    assert.equal(s.app.stops.size, 0);
  });
}

test('a stop answered after 1.5 s is answered: one send, never cut and sent again', async (t) => {
  const s = await setup({ latency: (m, p) => (isStop(m, p) ? 1500 : 30) });
  t.after(() => s.stop());
  s.box.states.get(1).moving_down = 1;
  const c = await s.click(1, 'state', 0);
  assert.equal(c.ack.success, true);
  await s.clock.advance(3 * MINUTE);
  assert.equal(s.box.stops(1).length, 1);
  assert.equal(s.app.stops.size, 0);
});

test('a refused connection is written again every 250 ms within the budget', async (t) => {
  let tries = 0;
  const s = await setup({
    mode: (m, p) => (isStop(m, p) ? (tries++, 'refuse') : undefined),
  });
  t.after(() => s.stop());
  await s.click(1, 'state', 0, { wait: 3400 });
  assert.ok(tries >= 10 && tries <= 14, `${tries}`);
});

// --- I3: the read back of an answered stop ---------------------------------------

test('the read back of a stop waits for a pause the box asked (429)', async (t) => {
  let limit = false;
  const s = await setup({
    mode: (m) =>
      limit && m === 'deviced.group_get_state'
        ? { status: 429, headers: { 'retry-after': '600' } }
        : undefined,
  });
  t.after(() => s.stop());
  s.box.states.get(1).moving_down = 1;
  s.box.stuck = true;
  limit = true;
  await s.clock.advance(MINUTE); // the cycle gets the 429: paused before the stop
  assert.ok(s.app.pauseLeft() > 0);
  const before = s.box.reads(1).length;
  await s.click(1, 'state', 0);
  await s.clock.advance(3 * MINUTE);
  assert.equal(s.box.reads(1).length - before, 0, 'nothing read during the pause');
  assert.ok(s.app.pauseLeft() > 0);
  assert.equal(s.app.stops.size, 1, 'kept: not checked yet');
  limit = false;
  s.box.stuck = false;
  await s.clock.advance(10 * MINUTE);
  assert.equal(s.app.stops.size, 0, 'checked after the pause');
});

test('the read back of a stop refused by the box (group removed) ends the stop', async (t) => {
  let gone = false;
  const s = await setup({
    mode: (m, p) =>
      gone && m === 'deviced.group_get_state' && p.group_id === 1 ? 'rpcError' : undefined,
  });
  t.after(() => s.stop());
  gone = true;
  await s.click(1, 'state', 0);
  await s.clock.advance(MINUTE);
  assert.equal(s.app.stops.size, 0);
  assert.ok(s.box.reads(1).length <= 3);
});

test('a read back that gets no answer is tried again less and less often', async (t) => {
  let silent = false;
  const s = await setup({
    devices: [cover(1)],
    mode: (m, p) =>
      silent && m === 'deviced.group_get_state' && p.group_id === 1 ? 'drop' : undefined,
  });
  t.after(() => s.stop());
  silent = true;
  await s.click(1, 'state', 0);
  const before = s.box.reads(1).length;
  await s.clock.advance(5 * MINUTE);
  const reads = s.box.reads(1).length - before;
  // Checks at 2, 12, 27, 52, 92, 157, 222, 287 s (+5 s each) plus the cycles.
  assert.ok(reads <= 14, `${reads} reads`);
  assert.equal(s.app.stops.size, 1, 'kept while not read');
});

// --- I4: a slow /data at start ------------------------------------------------------

test('/data slower than 2 s at start: read again, its stops sent, never written before', async (t) => {
  let release;
  const loading = new Promise((resolve) => (release = resolve));
  const store = memoryStore(
    { address: ADDRESS, stops: [{ id: 5, address: ADDRESS, tries: 0, feedback: true }] },
    { loading },
  );
  const s = await setup({ store, start: false });
  t.after(() => s.stop());
  let booted = false;
  s.app.boot().then(() => (booted = true));
  await settle();
  await s.clock.advance(2100);
  await settle();
  assert.equal(booted, true, 'the start never waits more than 2 s for /data');
  assert.equal(s.app.storeBroken, true);
  await s.app.start(CONFIG);
  await s.clock.advance(1000);
  await s.click(1, 'state', 0, { wait: 1000 });
  assert.equal(store.saves, 0, 'nothing written before /data is read');
  assert.match(s.gladys.fake.connectionStatus.message.en, /\/data not read yet/);
  release();
  await s.clock.advance(31 * SECOND);
  assert.equal(s.app.storeBroken, false);
  assert.ok(s.box.stops(5).length >= 1, 'the stop of /data sent');
  assert.ok(store.saves > 0);
  assert.doesNotMatch(s.gladys.fake.connectionStatus.message.en, /\/data/);
});

test('a future lastReadAt in /data is not trusted', async (t) => {
  const store = memoryStore({ address: ADDRESS, lastReadAt: Date.UTC(2030, 0, 1) });
  const s = await setup({ store });
  t.after(() => s.stop());
  await s.clock.advance(61 * SECOND);
  assert.ok(lists(s).length > 0);
});

// --- I5: guards without a test ----------------------------------------------------

test('32 commands wait at most; the next ones are refused at once', async (t) => {
  const s = await setup({ latency: (m, p) => (p.command === 'moveto' ? 3000 : 30) });
  t.after(() => s.stop());
  const clicks = [];
  for (let i = 0; i < 40; i += 1) clicks.push(await s.click(1, 'position', i, { wait: 0 }));
  await settle();
  await s.clock.advance(10 * SECOND);
  await Promise.all(clicks.map((c) => c.pending));
  const full = clicks.filter((c) => /too many commands/.test(c.ack.error?.message ?? ''));
  assert.equal(full.length, 8);
});

test('a close cuts the periodic read in flight', async (t) => {
  const s = await setup({
    latency: (m) => (m === 'deviced.group_get_state' ? 30 * SECOND : 30),
  });
  t.after(() => s.stop());
  assert.equal(s.box.open, 1);
  await s.click(1, 'state', -1, { wait: 200 });
  assert.equal(s.box.open, 0);
});

test('an open the box refuses is never shown as sent', async (t) => {
  const s = await setup({
    mode: (m, p) => (p.command === 'move' && p.value === -1 ? 'rpcError' : undefined),
  });
  t.after(() => s.stop());
  const c = await s.click(1, 'state', 1);
  assert.equal(c.ack.success, false);
  assert.match(s.badge(1).message.en, /refused by the box/);
});

test('every successful read sends the stops still waiting for an answer', async (t) => {
  let deaf = true;
  const s = await setup({ mode: (m, p) => (deaf && isStop(m, p) ? 'drop' : undefined) });
  t.after(() => s.stop());
  await s.click(1, 'state', 0, { wait: 0 });
  await s.clock.advance(150 * SECOND);
  const cycle = s.box.reads(2).at(-1).at; // the read of the cycle near 120 s
  const after = s.box.stops(1).filter((r) => r.at >= cycle - 100 && r.at <= cycle + 500);
  assert.ok(
    after.length >= 1,
    `stops at ${s.box.stops(1).map((r) => Math.round(r.at))}, cycle ${cycle}`,
  );
  deaf = false;
});

test('Scan reads the box at most every 10 s', async (t) => {
  const s = await setup();
  t.after(() => s.stop());
  await s.clock.advance(20 * SECOND);
  const before = lists(s).length;
  const a = s.app.scan();
  await settle();
  await s.clock.advance(500);
  await a;
  const b = s.app.scan();
  await settle();
  await s.clock.advance(500);
  await b;
  assert.equal(lists(s).length - before, 2, 'groups and sensors, once');
});

test('the read back of an older command never speaks over a newer one', async (t) => {
  const s = await setup();
  t.after(() => s.stop());
  await s.click(1, 'position', 30, { wait: 1000 });
  s.box.deaf = true;
  const second = s.clock.elapsed;
  const readsBefore = s.box.reads(1).length;
  await s.click(1, 'position', 80, { wait: 0 });
  const mark = s.gladys.fake.transports.length;
  await s.clock.advance(30 * SECOND);
  // Only the read backs of the newer command (5 s and 20 s), none of the older one.
  assert.equal(s.box.reads(1).length - readsBefore, 2);
  const later = s.gladys.fake.transports.slice(mark).filter((e) => e.device_external_id === D(1));
  assert.ok(later.length > 0);
  for (const e of later) {
    // The first one (30 %) is applied: its "applied" badge (green) must never cover the second.
    assert.equal(e.degraded, true, `${second}: ${JSON.stringify(e)}`);
    assert.doesNotMatch(e.message?.en ?? '', /30 %/);
  }
});

test('clicking stop again replaces the stop: one loop, never two', async (t) => {
  let calls = 0;
  const s = await setup({ mode: (m, p) => (isStop(m, p) ? (calls++, 'refuse') : undefined) });
  t.after(() => s.stop());
  await s.click(1, 'state', 0, { wait: 1000 });
  const before = calls;
  await s.click(1, 'state', 0, { wait: 2000 });
  assert.ok(calls - before <= 10, `${calls - before} tries in 2 s`);
});

test('a stop is in /data as soon as it is clicked', async (t) => {
  const store = memoryStore();
  const s = await setup({ store, mode: (m, p) => (isStop(m, p) ? 'drop' : undefined) });
  t.after(() => s.stop());
  await s.click(1, 'state', 0, { wait: 100 });
  assert.equal(store.data.stops?.[0]?.id, 1);
});

test('the direction of a stop never comes from a stale read', async (t) => {
  let blind = false;
  const s = await setup({
    mode: (m, p) =>
      blind && m === 'deviced.group_get_state' && p.group_id === 1 ? 'rpcError' : undefined,
  });
  t.after(() => s.stop());
  s.box.states.get(1).moving_down = 1;
  await s.clock.advance(MINUTE); // seen going down
  blind = true;
  await s.clock.advance(3 * MINUTE); // that read is now 3 min old
  blind = false;
  await s.click(1, 'state', 0, { wait: 0 });
  await s.clock.advance(200);
  s.box.stuck = true;
  Object.assign(s.box.states.get(1), { moving_up: 1, moving_down: 0 });
  await s.clock.advance(2 * MINUTE);
  assert.ok(s.box.stops(1).length >= 2, 'unknown direction: sent again');
});

test('a cover the box lists with another type is not read', async (t) => {
  const s = await setup({ devices: [cover(1, { type: 'awning' }), cover(2)] });
  t.after(() => s.stop());
  await s.clock.advance(2 * MINUTE);
  assert.equal(s.box.reads(1).length, 0);
  assert.ok(s.box.reads(2).length > 0);
});

test('a pause is never longer than 6 h, whatever the box asks', async (t) => {
  let limit = false;
  const s = await setup({
    mode: () => (limit ? { status: 503, headers: { 'retry-after': '9999999' } } : undefined),
  });
  t.after(() => s.stop());
  limit = true;
  await s.clock.advance(MINUTE);
  limit = false;
  const before = s.box.log.length;
  await s.clock.advance(6 * HOUR + 5 * MINUTE);
  assert.ok(s.box.log.length > before);
});

// --- Minor points -------------------------------------------------------------------

test('300 states a minute even when publications run at the same time', async (t) => {
  const s = await setup({ devices: [sensor(20)] });
  t.after(() => s.stop());
  await s.clock.advance(61 * SECOND);
  const before = s.gladys.fake.states.length;
  const batch = (n) =>
    Array.from({ length: 200 }, (_, i) => ({
      device_feature_external_id: `ext:becker:remote:${300 + n * 200 + i}:temp`,
      state: i,
    }));
  await Promise.all([s.app.publish(batch(0)), s.app.publish(batch(1))]);
  assert.ok(s.gladys.fake.states.length - before <= 300, `${s.gladys.fake.states.length - before}`);
});

test('a box that seems to serve one request at a time gets one command at a time', async (t) => {
  let slow = true;
  const s = await setup({
    latency: (m) => (slow && m === 'deviced.group_send_command' ? 5000 : 30),
  });
  t.after(() => s.stop());
  const a = await s.click(1, 'state', 1, { wait: 0 });
  const b = await s.click(2, 'state', 1, { wait: 0 });
  await s.clock.advance(4000);
  await Promise.all([a.pending, b.pending]);
  assert.equal(s.app.parallel, 1);
  slow = false;
  const clicks = [];
  for (const id of [1, 2, 5]) clicks.push(await s.click(id, 'position', 50, { wait: 0 }));
  await s.clock.advance(3000);
  const at = s.box.commands((p) => p.command === 'moveto').map((r) => r.at);
  assert.equal(at.length, 3);
  assert.ok(at[1] - at[0] >= 29 && at[2] - at[1] >= 29, `${at}`);
});

test('a close without a known type is refused; a stop still goes', async (t) => {
  const bare = cover(7, { id: 7, type: undefined, name: 'X', feedback: false });
  bare.params = bare.params.filter((p) => p.name !== 'BECKER_TYPE');
  const s = await setup({ devices: [bare] });
  t.after(() => s.stop());
  const close = await s.click(7, 'state', -1);
  assert.match(close.ack.error.message, /type of cover unknown/);
  const stop = await s.click(7, 'state', 0);
  assert.equal(s.box.stops(7).length, 1);
  assert.ok(stop.ack);
});

test('a new address of the box: only the stop goes until "Test the connection"', async (t) => {
  const store = memoryStore();
  const s = await setup({ store });
  t.after(() => s.stop());
  await s.app.configUpdated({ ...CONFIG, box_address: '192.168.1.80' });
  await s.clock.advance(5 * SECOND);
  const open = await s.click(1, 'state', 1);
  assert.match(open.ack.error.message, /press Test the connection/);
  const close = await s.click(2, 'state', -1);
  assert.match(close.ack.error.message, /press Test the connection/);
  assert.match(s.gladys.fake.connectionStatus.message.en, /New address/);
  assert.equal(store.data.confirm, true, 'kept across a restart');
  await s.click(1, 'state', 0);
  assert.equal(s.box.stops(1).length, 1);
  await s.clock.advance(20 * SECOND);
  const test = s.app.testConnection();
  await settle();
  await s.clock.advance(500);
  await test;
  const again = await s.click(1, 'state', 1);
  assert.equal(again.ack.success, true);
});

test('every cover read failing is not "connected", and the covers say so', async (t) => {
  const s = await setup({
    mode: (m) => (m === 'deviced.group_get_state' ? 'rpcError' : undefined),
  });
  t.after(() => s.stop());
  assert.equal(s.gladys.fake.connectionStatus.connected, false);
  assert.equal(s.badge(1).transport, 'unreachable');
  assert.match(s.badge(1).message.en, /Not read/);
});

test('rounding of positions and the bounds of ids', () => {
  assert.equal(positionOf('shutter', 33.4), 67);
  assert.equal(positionOf('awning', 33.6), 34);
  assert.equal(itemId(2 ** 31 - 1), 2 ** 31 - 1);
  assert.equal(itemId(2 ** 31), undefined);
});

test('a stop clicked while /data is still loading (under 2 s) writes nothing before the load', async (t) => {
  let release;
  const loading = new Promise((resolve) => (release = resolve));
  const store = memoryStore({ stops: [{ id: 5, address: ADDRESS, feedback: true }] }, { loading });
  const s = await setup({ store, start: false });
  t.after(() => s.stop());
  const boot = s.app.boot();
  // Not awaited: the start waits for /data (bounded by the virtual clock).
  const started = s.app.connected(() => Promise.resolve(CONFIG));
  await settle();
  await s.click(1, 'state', 0, { wait: 0 });
  await s.clock.advance(500);
  assert.equal(store.saves, 0);
  release();
  await settle();
  await s.clock.advance(1000);
  await boot;
  await started;
  assert.ok(store.saves > 0);
  assert.ok(s.box.stops(5).length >= 1);
});

test('a 429 on the read back of a stop pauses the reads', async (t) => {
  let limit = false;
  const s = await setup({
    mode: (m) =>
      limit && m === 'deviced.group_get_state'
        ? { status: 429, headers: { 'retry-after': '600' } }
        : undefined,
  });
  t.after(() => s.stop());
  s.box.states.get(1).moving_down = 1;
  s.box.stuck = true;
  limit = true;
  await s.click(1, 'state', 0, { wait: 5000 }); // the check read at 2 s gets the 429
  assert.ok(s.app.pauseLeft() > 5 * MINUTE, 'paused by the read back itself');
  const before = s.box.log.length;
  await s.clock.advance(3 * MINUTE);
  assert.equal(s.box.log.length, before, 'nothing read during the pause');
});
