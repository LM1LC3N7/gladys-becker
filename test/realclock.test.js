// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and a
// real local HTTP server playing the CentralControl, sped up 20 times: the
// reads really come at 0, the interval and twice the interval; a stop clicked
// while a read hangs leaves at once; nothing is left running after stop().
// Cleanup in t.after: a failed assertion never leaves the app nor the server
// alive. Every wait is bounded.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BeckerApp } from '../src/app.js';
import { POLL_INTERVAL } from '../src/constants.js';
import { buildCover } from '../src/model.js';
import { memoryStore } from '../src/store.js';

const SPEED = 20;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const simNow = () => performance.now() * SPEED;

async function waitFor(predicate, simMs) {
  const deadline = simNow() + simMs;
  while (!predicate() && simNow() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return predicate();
}

test('real clock x20: reads at 0, the interval, twice the interval; a stop never waits', async (t) => {
  const reads = [];
  const stops = [];
  let hang = false;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(
        Buffer.concat(chunks)
          .toString()
          .replace(/\u0000$/, ''),
      );
      const answer = (result) => res.end(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\u0000`);
      if (method === 'deviced.deviced_get_item_list') {
        answer({
          item_list:
            params.item_type === 'group'
              ? [{ id: 1, name: 'Salon', device_type: 'shutter', feedback: true }]
              : [],
        });
      } else if (method === 'deviced.group_get_state') {
        reads.push(simNow());
        if (!hang) answer({ state: { value: 20, moving_up: 0, moving_down: 0 } });
      } else {
        stops.push(simNow());
        answer({});
      }
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  let timersSet = 0;
  const live = new Set();
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      const h = setTimeout(
        () => {
          live.delete(h);
          fn();
        },
        Math.max(0, ms) / SPEED,
      );
      live.add(h);
      return h;
    },
    clearTimeout(h) {
      live.delete(h);
      clearTimeout(h);
    },
  };
  const naming = createFakeGladys({ selector: 'becker' });
  const device = buildCover(naming, { id: 1, name: 'Salon', type: 'shutter', feedback: true });
  const gladys = createFakeGladys({ selector: 'becker', devices: [device] });
  await gladys.connect();
  const app = new BeckerApp({
    gladys,
    logger: quiet,
    store: memoryStore(),
    now: () => Date.now() * SPEED,
    monotonic: simNow,
    timers,
  });
  t.after(async () => {
    await app.stop();
    for (const h of live) clearTimeout(h);
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const interval = POLL_INTERVAL.min * 1000;
  const started = simNow();
  await app.start({ box_address: `127.0.0.1:${port}`, poll_interval: POLL_INTERVAL.min });
  assert.ok(await waitFor(() => reads.length >= 3, 3 * interval), `reads ${reads.length}`);
  const at = reads.map((r) => Math.round(r - started));
  assert.ok(reads[0] - started < interval / 2, `first read at once: ${at}`);
  for (let i = 1; i < 3; i += 1) {
    const gap = reads[i] - reads[i - 1];
    assert.ok(gap >= 0.9 * interval && gap < 1.5 * interval, `period: ${at}`);
  }
  assert.equal(gladys.fake.lastState(device.features[1].external_id), 80);
  // The next read hangs; a stop clicked during it leaves at once.
  hang = true;
  assert.ok(await waitFor(() => reads.length >= 4, 2 * interval));
  const clicked = simNow();
  const ack = await app.setValue(device, device.features[0], 0);
  assert.deepEqual(ack, { sent: true });
  assert.equal(stops.length, 1);
  assert.ok(stops[0] - clicked < 2000, `stop after ${Math.round(stops[0] - clicked)} simulated ms`);
  assert.ok(timersSet < 40, `${timersSet} timers`);
  await app.stop();
  assert.equal(live.size, 0, 'no timer left after stop()');
});
