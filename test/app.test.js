// -----------------------------------------------------------------------------
// The app: discovery, reads, commands, pauses, lifecycle. Virtual clock and
// the in-memory box (test/helpers/fakeBox.js).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { settle } from './helpers/clock.js';
import { ADDRESS } from './helpers/fakeBox.js';
import { CONFIG, D, F, MINUTE, SECOND, cover, sensor, setup } from './helpers/app.js';

const statesOf = (s, id) =>
  s.gladys.fake.states.filter((x) => x.device_feature_external_id === id).map((x) => x.state);

test('start: covers and sensors in the Discovery, positions and sensors published, connected', async (t) => {
  const s = await setup();
  t.after(() => s.stop());
  assert.deepEqual(
    s.gladys.fake.discoveredDevices.map((d) => d.external_id),
    [1, 2, 3, 4, 5].map(D).concat(['ext:becker:remote:20', 'ext:becker:remote:21']),
    'no door, no unknown sensor',
  );
  const four = s.gladys.fake.discoveredDevices.find((d) => d.external_id === D(4));
  assert.deepEqual(
    four.features.map((f) => f.external_id),
    [F(4, 'state')],
    'no position without feedback',
  );
  assert.equal(s.gladys.fake.lastState(F(1, 'position')), 100, 'Becker 0 = open = Gladys 100');
  assert.equal(s.gladys.fake.lastState(F(3, 'position')), 0, 'an awning is not reversed');
  assert.equal(s.gladys.fake.lastState('ext:becker:remote:20:temp'), 18.5);
  assert.equal(s.gladys.fake.lastState('ext:becker:remote:20:sun'), 7);
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
  assert.equal(s.box.reads(4).length, 0, 'a motor without feedback is never read');
  for (const r of s.box.log) assert.equal(r.host, ADDRESS);
});

test('the reads come back at the interval, never sooner', async (t) => {
  const s = await setup();
  t.after(() => s.stop());
  const lists = () => s.box.reads(1).map((r) => r.at);
  await s.clock.advance(3 * MINUTE);
  const at = lists();
  assert.equal(at.length, 4);
  for (let i = 1; i < at.length; i += 1) {
    assert.ok(at[i] - at[i - 1] >= 59.9 * SECOND && at[i] - at[i - 1] < 61 * SECOND, `${at}`);
  }
});

test('sensor values out of bounds, texts and nulls are never published', async (t) => {
  const s = await setup();
  t.after(() => s.stop());
  s.box.sensors.set(20, {
    'value-sun': 16,
    'value-wind': 'calm',
    'value-rain': 1,
    'value-temp': null,
    'value-dawn': 2.5,
  });
  await s.clock.advance(MINUTE);
  assert.deepEqual(statesOf(s, 'ext:becker:remote:20:sun'), [7]);
  assert.deepEqual(statesOf(s, 'ext:becker:remote:20:wind'), [2]);
  assert.deepEqual(statesOf(s, 'ext:becker:remote:20:rain'), [0, 1]);
  assert.deepEqual(statesOf(s, 'ext:becker:remote:20:temp'), [18.5]);
  assert.deepEqual(statesOf(s, 'ext:becker:remote:20:dawn'), [3]);
});

test('the sensor list failing never blocks the covers; one cover failing never stops the others', async (t) => {
  const s = await setup({
    mode: (m, p) =>
      (m === 'deviced.deviced_get_item_list' && p.item_type === 'remote') ||
      (m === 'deviced.group_get_state' && p.group_id === 2)
        ? 'rpcError'
        : undefined,
  });
  t.after(() => s.stop());
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
  assert.equal(s.gladys.fake.lastState(F(1, 'position')), 100);
  assert.equal(s.gladys.fake.lastState(F(3, 'position')), 0);
  assert.equal(s.gladys.fake.lastState(F(2, 'position')), undefined);
});

test('a read that left before a command never applies after it', async (t) => {
  const s = await setup({
    latency: (m, p) => (m === 'deviced.group_get_state' && p.group_id === 1 ? 2000 : 30),
  });
  t.after(() => s.stop());
  s.box.states.get(1).value = 80; // position 20, seen by the next read
  await s.clock.advance(59 * SECOND + 200); // the next cycle reads cover 1 (2 s)
  assert.equal(s.box.open, 1);
  await s.click(1, 'position', 90, { wait: 0 });
  await s.clock.advance(30 * SECOND);
  assert.ok(!statesOf(s, F(1, 'position')).includes(20), `${statesOf(s, F(1, 'position'))}`);
  assert.equal(s.gladys.fake.lastState(F(1, 'position')), 90);
});

test('reads apply in the order they left, not the order they came back', async (t) => {
  let slow = false;
  const s = await setup({
    latency: (m) => (m === 'deviced.group_get_state' && slow ? 3000 : 30),
  });
  t.after(() => s.stop());
  await s.clock.advance(MINUTE + 5 * SECOND);
  s.box.states.get(1).value = 60; // position 40, seen by the first read
  const address = { host: ADDRESS, port: 80 };
  slow = true;
  const first = s.app.readGroup(1, address);
  await settle();
  slow = false;
  s.box.states.get(1).value = 10; // position 90, seen by the second
  const second = s.app.readGroup(1, address);
  await settle();
  await s.clock.advance(4000);
  await Promise.all([first, second]);
  assert.equal(s.gladys.fake.lastState(F(1, 'position')), 90);
  assert.ok(!statesOf(s, F(1, 'position')).includes(40));
});

test('a scene on five slow covers sets all five', async (t) => {
  const s = await setup({
    devices: [cover(1), cover(2), cover(3), cover(4), cover(5)],
    latency: (m) => (m === 'deviced.group_send_command' ? 900 : 30),
  });
  t.after(() => s.stop());
  const clicks = [];
  for (const id of [1, 2, 3, 4, 5]) clicks.push(await s.click(id, 'state', 1, { wait: 0 }));
  await s.clock.advance(3500);
  await Promise.all(clicks.map((c) => c.pending));
  assert.deepEqual(
    clicks.map((c) => c.ack.success),
    [true, true, true, true, true],
  );
  assert.deepEqual(
    s.box.commands().map((r) => [r.params.group_id, r.params.value]),
    [
      [1, -1],
      [2, -1],
      [3, 1],
      [4, -1],
      [5, -1],
    ],
    'an awning opens down',
  );
});

test('a command that cannot leave within 3.5 s is refused, nothing sent', async (t) => {
  const s = await setup({ latency: (m) => (m === 'deviced.group_send_command' ? 5000 : 30) });
  t.after(() => s.stop());
  const first = await s.click(1, 'position', 30, { wait: 0 });
  const second = await s.click(1, 'position', 60, { wait: 0 });
  await s.clock.advance(6000);
  await Promise.all([first.pending, second.pending]);
  assert.equal(first.ack.success, false, 'no answer by 4.3 s');
  assert.match(first.ack.error.message, /no answer/);
  assert.equal(second.ack.error.why, 'late');
  assert.equal(s.box.commands().length, 1);
  assert.match(s.badge(1).message.en, /nothing sent/);
});

test('refusals: not listed yet, another type, no position, a decimal, a text', async (t) => {
  let listDown = true;
  const s = await setup({
    devices: [cover(1), cover(2, { type: 'venetian' }), cover(4)],
    mode: (m) => (listDown && m === 'deviced.deviced_get_item_list' ? 'refuse' : undefined),
  });
  t.after(() => s.stop());
  const early = await s.click(1, 'state', 1);
  assert.equal(early.ack.success, false);
  assert.match(early.ack.error.message, /not yet read back/);
  listDown = false;
  await s.clock.advance(2 * MINUTE);
  assert.equal(s.app.listed, true);
  const other = await s.click(2, 'state', 1);
  assert.match(other.ack.error.message, /another type/);
  assert.match(s.badge(2).message.en, /another type/);
  const noPosition = await s.click(4, 'position', 50);
  assert.match(noPosition.ack.error.message, /no position/);
  for (const value of [30.5, '40%', null, true, 101, -1]) {
    const bad = await s.click(1, 'position', value);
    assert.equal(bad.ack.success, false, String(value));
  }
  assert.equal(s.box.commands().length, 0);
  const ok = await s.click(1, 'position', '30');
  assert.equal(ok.ack.success, true);
});

test('close: never blocked by the pause nor a missing list; an awning closes up', async (t) => {
  const s = await setup({
    mode: (m) =>
      m === 'deviced.deviced_get_item_list'
        ? { status: 503, headers: { 'retry-after': '120' } }
        : undefined,
  });
  t.after(() => s.stop());
  assert.ok(s.app.pauseLeft() > 0);
  const a = await s.click(1, 'state', -1);
  const b = await s.click(3, 'state', -1);
  assert.equal(a.ack.success, true);
  assert.equal(b.ack.success, true);
  assert.deepEqual(
    s.box.commands().map((r) => [r.params.group_id, r.params.value]),
    [
      [1, 1],
      [3, -1],
    ],
  );
});

test('a move is confirmed only by the read back', async (t) => {
  const s = await setup();
  t.after(() => s.stop());
  await s.click(1, 'position', 30, { wait: 0 });
  await s.clock.advance(1000);
  assert.match(s.badge(1).message.en, /waiting for the read back/);
  await s.clock.advance(5 * SECOND);
  assert.notEqual(s.badge(1).degraded, true, 'applied');
  s.box.deaf = true;
  await s.click(1, 'position', 80, { wait: 0 });
  await s.clock.advance(6 * SECOND);
  assert.match(s.badge(1).message.en, /not applied yet/);
  await s.clock.advance(15 * SECOND);
  assert.match(s.badge(1).message.en, /not applied \(read back unchanged\)/);
});

test('an unanswered command is "sent, without confirmation", a refused one "nothing sent"', async (t) => {
  const s = await setup({
    mode: (m, p) => {
      if (p.group_id === 1 && p.command === 'moveto') return 'drop';
      if (p.group_id === 2 && p.command === 'moveto') return 'refuse';
      return undefined;
    },
  });
  t.after(() => s.stop());
  const a = await s.click(1, 'position', 30);
  assert.equal(a.ack.success, false);
  assert.match(s.badge(1).message.en, /sent, without confirmation/);
  const b = await s.click(2, 'position', 30);
  assert.equal(b.ack.success, false);
  assert.match(s.badge(2).message.en, /nothing sent/);
});

test('a 429 pauses reads and commands, kept across a restart', async (t) => {
  const store = memoryStore();
  let limit = false;
  const s = await setup({
    store,
    mode: () => (limit ? { status: 429, headers: { 'retry-after': '900' } } : undefined),
  });
  t.after(() => s.stop());
  limit = true;
  await s.clock.advance(MINUTE);
  limit = false;
  assert.ok(store.data.pausedUntil > 0);
  const refused = await s.click(1, 'state', 1);
  assert.match(refused.ack.error.message, /slow down/);
  await s.stop();
  const again = await setup({ store, clock: s.clock });
  t.after(() => again.stop());
  assert.equal(again.box.log.length, 0, 'nothing read during the pause after a restart');
  assert.match(again.gladys.fake.connectionStatus.message.en, /paused/);
  await again.clock.advance(15 * MINUTE);
  assert.ok(again.box.log.length > 0);
});

test('a restart never reads sooner than the interval', async (t) => {
  const s = await setup();
  await s.clock.advance(10 * SECOND);
  await s.stop();
  const store = s.store;
  const again = await setup({ store, clock: s.clock });
  t.after(() => again.stop());
  assert.equal(again.box.log.length, 0);
  await again.clock.advance(50 * SECOND);
  assert.ok(again.box.log.length > 0);
});

test('getConfig failing in connected is tried again every 30 s, then starts', async (t) => {
  const s = await setup({ start: false });
  t.after(() => s.stop());
  let fail = 2;
  const getConfig = () =>
    fail-- > 0 ? Promise.reject(new Error('busy')) : Promise.resolve(CONFIG);
  await s.app.connected(getConfig);
  assert.match(s.gladys.fake.connectionStatus.message.en, /Configuration not read/);
  await s.clock.advance(31 * SECOND);
  assert.equal(s.box.log.length, 0);
  await s.clock.advance(31 * SECOND);
  await s.clock.advance(2 * SECOND);
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
});

test('configurations saved back to back apply one by one, the last one wins', async (t) => {
  const s = await setup();
  t.after(() => s.stop());
  const a = s.app.configUpdated({ ...CONFIG, box_address: '192.168.1.71' });
  const b = s.app.configUpdated({ ...CONFIG, box_address: '192.168.1.72' });
  await Promise.all([a, b]);
  const since = s.box.log.length;
  await s.clock.advance(5 * SECOND);
  const hosts = new Set(s.box.log.slice(since).map((r) => r.host));
  assert.deepEqual([...hosts], ['192.168.1.72']);
});

test('an invalid address is never shown back; the status says what is wrong', async (t) => {
  const s = await setup({ start: false });
  t.after(() => s.stop());
  await s.app.start({ box_address: 'my box is 10.0.0.1' });
  assert.doesNotMatch(JSON.stringify(s.gladys.fake.connectionStatus), /10\.0\.0\.1/);
  await s.app.start({ box_address: 'user:pw@10.0.0.1' });
  assert.doesNotMatch(JSON.stringify(s.gladys.fake.connectionStatus), /pw/);
  await s.app.start({ box_address: '224.0.0.1' });
  assert.match(s.gladys.fake.connectionStatus.message.en, /multicast/);
  assert.equal(s.box.log.length, 0);
});

test('a cover the box lists no longer, or with another type, is shown on its badge', async (t) => {
  const s = await setup();
  t.after(() => s.stop());
  s.box.groups = s.box.groups
    .filter((g) => g.id !== 2)
    .map((g) => (g.id === 1 ? { ...g, device_type: 'awning' } : g));
  await s.clock.advance(11 * MINUTE);
  assert.match(s.badge(1).message.en, /another type/);
  assert.equal(s.badge(2).transport, 'unreachable');
});

test('stop() leaves no timer and no request behind', async (t) => {
  const s = await setup();
  await s.click(1, 'position', 30, { wait: 100 });
  await s.app.stop();
  const count = s.box.log.length;
  assert.equal(s.clock.pending, 0);
  await s.clock.advance(30 * MINUTE);
  assert.equal(s.box.log.length, count);
  t.after(() => {});
});

test('the test button reads the box, at most every 10 s', async (t) => {
  const s = await setup();
  t.after(() => s.stop());
  await s.clock.advance(20 * SECOND);
  const pending = s.app.testConnection();
  await settle();
  await s.clock.advance(1000);
  const first = await pending;
  assert.match(first.en, /answered: 5 covers/);
  const second = await s.app.testConnection();
  assert.match(second.en, /try again/);
});

test('Gladys reconnecting with the same configuration republishes, without reading again', async (t) => {
  const s = await setup();
  t.after(() => s.stop());
  const count = s.box.log.length;
  await s.app.connected(() => Promise.resolve(CONFIG));
  assert.equal(s.box.log.length, count);
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
});

test('a sensor is read only', async (t) => {
  const s = await setup({ devices: [sensor(20)] });
  t.after(() => s.stop());
  await assert.rejects(
    s.app.setValue(sensor(20), { external_id: 'ext:becker:remote:20:wind' }, 1),
    /read-only/,
  );
});

test('300 states a minute at most, all devices together', async (t) => {
  const s = await setup();
  t.after(() => s.stop());
  const before = s.gladys.fake.states.length;
  const many = Array.from({ length: 400 }, (_, i) => ({
    device_feature_external_id: `ext:becker:remote:${100 + i}:temp`,
    state: i,
  }));
  await s.app.publish(many);
  await s.app.publish(many.map((x) => ({ ...x, state: x.state + 1 })));
  assert.ok(s.gladys.fake.states.length - before <= 300);
  await s.clock.advance(61 * SECOND);
  const mid = s.gladys.fake.states.length;
  await s.app.publish(many.map((x) => ({ ...x, state: x.state + 2 })));
  assert.ok(s.gladys.fake.states.length > mid, 'room again after a minute');
});

test('a command that arrived before a pause never leaves during it', async (t) => {
  const s = await setup({
    latency: (m, p) => (p.command === 'moveto' ? 1000 : 30),
    mode: (m, p) => (p.command === 'moveto' && p.value === 70 ? { status: 429 } : undefined),
  });
  t.after(() => s.stop());
  const first = await s.click(1, 'position', 30, { wait: 0 });
  const second = await s.click(1, 'position', 50, { wait: 0 });
  await s.clock.advance(4500);
  await Promise.all([first.pending, second.pending]);
  assert.equal(second.ack.error.why, 'paused');
  assert.equal(s.box.commands().length, 1);
});

test('the box stopped answering: open refused until it lists the covers again', async (t) => {
  let down = false;
  const s = await setup({ mode: () => (down ? 'refuse' : undefined) });
  t.after(() => s.stop());
  down = true;
  await s.clock.advance(MINUTE);
  assert.equal(s.app.listed, false);
  down = false;
  const open = await s.click(1, 'state', 1);
  assert.match(open.ack.error.message, /not yet read back/);
  assert.equal(s.box.commands().length, 0);
});
