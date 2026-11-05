// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, the in-memory box and a virtual clock.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BeckerApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { buildCover, buildSensor, parseGroups, parseRemotes } from '../../src/model.js';
import { memoryStore } from '../../src/store.js';
import { settle, testClock } from './clock.js';
import { ADDRESS, GROUPS, REMOTES, createBox } from './fakeBox.js';

export const SELECTOR = 'becker';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const CONFIG = { box_address: ADDRESS, poll_interval: 60, language: 'fr' };
export const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const naming = createFakeGladys({ selector: SELECTOR });
const listedGroups = parseGroups({ item_list: GROUPS });
const listedRemotes = parseRemotes({ item_list: REMOTES });

/** The Gladys device of a cover as the user created it from the Discovery. */
export function cover(id, overrides = {}) {
  const group = { ...listedGroups.find((g) => g.id === id), ...overrides };
  return buildCover(naming, group);
}
export function sensor(id) {
  return buildSensor(
    naming,
    listedRemotes.find((r) => r.id === id),
  );
}

export const F = (id, key) => `ext:${SELECTOR}:group:${id}:${key}`;
export const D = (id) => `ext:${SELECTOR}:group:${id}`;

/**
 * A started app. `devices`: created in Gladys; `start: false` leaves it
 * unstarted (boot only).
 */
export async function setup({
  devices = [cover(1), cover(2), cover(3), cover(4), sensor(20)],
  store = memoryStore(),
  config = CONFIG,
  latency,
  mode,
  start = true,
  clock = testClock(),
} = {}) {
  const box = createBox({ clock, latency, mode });
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  const app = new BeckerApp({
    gladys,
    logger: quiet,
    store,
    post: box.post,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  // Unstarted: no handler, so the 'connected' event does not start it either.
  if (start) registerHandlers(gladys, app, quiet);
  await gladys.connect();
  if (start) {
    await app.boot();
    await app.start(config);
    await clock.advance(1); // the first cycle
    await clock.advance(1000);
  }
  const t = {
    app,
    gladys,
    box,
    clock,
    store,
    /** setValue as Gladys does it, the ack resolved (never awaited past the clock). */
    async click(id, key, value, { wait = 4500 } = {}) {
      const device = gladys.fake.devices.find((d) => d.external_id === D(id)) ?? cover(id);
      const feature = device.features.find((f) => f.external_id === F(id, key)) ?? {
        external_id: F(id, key),
      };
      let ack;
      const pending = app.setValue(device, feature, value).then(
        (v) => (ack = { success: true, data: v }),
        (err) => (ack = { success: false, error: err }),
      );
      // The app's first turns run before the virtual time moves.
      await settle();
      if (wait > 0) {
        await clock.advance(wait);
      }
      return {
        pending,
        get ack() {
          return ack;
        },
      };
    },
    badge(id) {
      const list = gladys.fake.transports.filter((e) => e.device_external_id === D(id));
      return list.at(-1);
    },
    async stop() {
      await app.stop();
    },
  };
  return t;
}
