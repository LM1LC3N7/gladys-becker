// -----------------------------------------------------------------------------
// The integration: one CentralControl, its cover groups and sensors turned
// into Gladys devices, their states read at the configured pace, and the
// commands sent back. index.js only wires the SDK to it.
//
// Clocks: `monotonic` paces and decides everything (reads, pauses, deadlines,
// freshness); the wall clock only dates what /data keeps, through the session
// clock (wall time at start + monotonic time elapsed), never read alone.
//
// Stop: never waits for anything. It cuts the periodic read in flight, leaves
// at once on its own connection (to the address of the configuration, else the
// last one known from /data), whatever the pause, the identity check, the
// queue or the configuration; it drops the commands of that cover not yet
// sent. One send waits for its answer until the end of its 3.3 s budget (a
// slow answer is an answer); a connection that fails is written again every
// 250 ms within it. Any answer of the box counts (a refusal, a 404, a page
// that is not JSON-RPC), never a 429/5xx, a timeout or a cut. Not answered,
// the stop is kept (in memory and, without waiting, in /data) and sent again
// (5 s, 10 s, 20 s, 30 s, then every minute, and at every successful read)
// until the box answers. An answered
// stop is checked by a read started after the answer: not moving -> applied;
// still moving the same way -> sent again (3 answered tries at most); moving
// the other way -> a move started elsewhere, left alone. A newer command of
// that cover accepted by the box replaces it; a newer command without answer
// does not (the stop goes). At start, the stops of /data leave before Gladys
// is even reached.
//
// Close: the same path (never blocked, ahead of everything, cuts the reads,
// drops the older commands) within its 3.3 s budget; never sent again after a
// restart.
//
// Open and position: only for a cover listed by the box in this session with
// the type it had when created; serialized per cover, several covers at once
// (a scene); refused when they cannot leave within 2.5 s or when a stop or a
// close came after them; paused by a 429 or a 5xx.
//
// Reads: a read whose request left before a command of that cover never
// applies after it; reads apply in the order they left.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, addressOf, normalizeConfig, sameConfig } from './config.js';
import { FEATURES, LIMITS, METHODS, TIMINGS } from './constants.js';
import { T, trim } from './i18n.js';
import {
  PARAMS,
  buildCover,
  buildSensor,
  commandOf,
  directionOf,
  groupIds,
  moveOf,
  movetoOf,
  movingOf,
  paramOf,
  parseExternalId,
  parseGroupState,
  parseGroups,
  parseOtherGroupIds,
  parseRemoteState,
  parseRemotes,
  positionOf,
  positionValue,
  remoteIds,
  itemId,
} from './model.js';
import { BeckerError, call, httpPost } from './rpc.js';
import { fileStore } from './store.js';

const notSent = (why) => new BeckerError('notSent', `not sent (${why})`, { why });

/** A refusal of a command before anything was sent: its text goes to the badge and the error. */
class Refusal extends Error {
  constructor(text) {
    super(text.en);
    this.text = text;
    this.refusal = true;
  }
}

/** A value of a command: a number, or its strict decimal text (null, '', true are not numbers). */
function numeric(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,3}(\.\d+)?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

export class BeckerApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'becker' }),
    store = fileStore(),
    post = httpPost,
    now = () => Date.now(),
    monotonic = () => performance.now(),
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.post = post;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    // Session clock: the wall clock read once, then the monotonic time elapsed.
    this.mono0 = monotonic();
    this.wall0 = now();

    this.config = normalizeConfig();
    this.running = false;
    this.closed = false;
    this.generation = 0;
    this.configChain = Promise.resolve();
    this.configTimer = undefined;

    /** Session (reset at every start and when the box stops answering). */
    this.groups = new Map();
    this.missingOnce = new Set();
    /** item ids the box lists as groups that are not covers (doors, lights...) */
    this.notCovers = new Set();
    this.remotes = new Map();
    this.listed = false;
    this.listedAt = -Infinity;
    this.remotesListed = false;

    /** Order of what leaves: every request and click gets the next number. */
    this.seq = 0;
    /** cover id -> number of the last command sent (or stop / close clicked) */
    this.commandSeq = new Map();
    /** cover id -> number of the last stop or close clicked: older commands never leave */
    this.barrier = new Map();
    /** item id -> number of the read last applied */
    this.applied = new Map();
    /** cover id -> last state read { value, up, down, mono } */
    this.states = new Map();

    /** cover id -> the stop kept until confirmed */
    this.stops = new Map();
    /** cover id -> the close in its budget */
    this.closes = new Map();
    /** cover id -> tail of its command chain */
    this.chains = new Map();
    this.queued = 0;
    this.active = 0;
    /** Commands of different covers in flight at once (1 once the box looks serial). */
    this.parallel = LIMITS.parallelCommands;
    this.slotWaiters = [];

    this.cycleTimer = undefined;
    this.cycleCtl = undefined;
    this.reading = false;
    this.failures = 0;
    this.lastError = undefined;
    this.pauseUntil = -Infinity;
    this.lastReadWall = 0;
    this.lastReadMono = -Infinity;
    this.lastTestMono = -Infinity;
    this.lastAddressKey = '';
    this.timersSet = new Set();

    this.loaded = false;
    this.storeBroken = false;
    this.lastStatus = undefined;
    this.badges = new Map();
    this.publishedBadges = new Map();
    this.discovery = undefined;
    this.warned = new Set();
    /** Monotonic times of the states published in the last minute. */
    this.publishedAt = [];
  }

  // --- Clocks and timers -------------------------------------------------------

  /** Wall time of a monotonic instant, on the session clock. */
  sessionWall(mono = this.monotonic()) {
    return this.wall0 + (mono - this.mono0);
  }

  /** A timer that dies with the app (never one after stop()). */
  later(ms, fn) {
    if (this.closed) {
      return undefined;
    }
    const handle = this.timers.setTimeout(
      () => {
        this.timersSet.delete(handle);
        if (!this.closed) {
          Promise.resolve()
            .then(fn)
            .catch((err) => this.logger.warn(`Becker timer: ${err?.message}`));
        }
      },
      Math.max(0, ms),
    );
    this.timersSet.add(handle);
    return handle;
  }

  cancel(handle) {
    if (handle !== undefined) {
      this.timers.clearTimeout(handle);
      this.timersSet.delete(handle);
    }
  }

  sleep(ms) {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve();
        return;
      }
      const handle = this.timers.setTimeout(() => {
        this.timersSet.delete(handle);
        resolve();
      }, ms);
      this.timersSet.add(handle);
    });
  }

  pauseLeft(mono = this.monotonic()) {
    // Capped at every use: a pause never outlives its maximum.
    return Math.max(0, Math.min(this.pauseUntil - mono, TIMINGS.pauseMax));
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  // --- /data ---------------------------------------------------------------------

  /** Loads /data and sends the stops it keeps, before Gladys is reached. */
  boot() {
    this.booting ??= this.bootNow();
    return this.booting;
  }

  async bootNow() {
    const loaded = await this.loadStore();
    this.applyLoad(loaded);
  }

  /** store.load(), bounded here too (a store that never answers is "broken" for now). */
  async loadStore() {
    let bound;
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.store.load()),
        new Promise((resolve) => {
          bound = this.timers.setTimeout(() => resolve({ broken: true }), TIMINGS.storeTimeout);
        }),
      ]);
    } catch {
      return { broken: true };
    } finally {
      this.timers.clearTimeout(bound);
    }
  }

  applyLoad(loaded) {
    if (this.closed || this.loaded) {
      return;
    }
    if (loaded?.broken) {
      // Unreadable (or too slow) is not empty: never overwritten (it may hold
      // stops). Read again every 30 s until it can be; nothing is written meanwhile.
      this.storeBroken = true;
      this.warnOnce('store', 'The /data file could not be read: read again every 30 s');
      this.cancel(this.reloadTimer);
      this.reloadTimer = this.later(TIMINGS.storeRetry, async () => {
        this.applyLoad(await this.loadStore());
      });
      this.updateStatus().catch(() => {});
      return;
    }
    this.storeBroken = false;
    if (loaded?.data) {
      this.restore(loaded.data);
    }
    this.loaded = true;
    // What happened before the load (a stop clicked meanwhile) is written now.
    this.persist();
    this.updateStatus().catch(() => {});
    for (const stop of this.stops.values()) {
      if (stop.fromBoot) {
        stop.fromBoot = false;
        this.kickStop(stop);
      }
    }
  }

  restore(raw) {
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const mono = this.monotonic();
    const wall = this.sessionWall(mono);
    const time = (v) => (Number.isFinite(v) && v > 0 ? v : undefined);
    const lastRead = time(data.lastReadAt);
    if (lastRead !== undefined) {
      // A date in the future is not trusted: taken as now.
      const at = Math.min(lastRead, wall);
      this.lastReadWall = at;
      this.lastReadMono = mono - (wall - at);
    }
    const paused = time(data.pausedUntil);
    if (paused !== undefined && paused > wall) {
      this.pauseUntil = mono + Math.min(paused - wall, TIMINGS.pauseMax);
    }
    if (typeof data.address === 'string' && addressOf(data.address)) {
      if (!this.lastAddressKey) {
        this.lastAddressKey = data.address;
      } else if (this.lastAddressKey !== data.address) {
        // /data read late: the box changed since it was written.
        this.confirmNeeded = true;
      }
    }
    if (data.confirm === true) {
      this.confirmNeeded = true;
    }
    const list = Array.isArray(data.stops) ? data.stops.slice(0, LIMITS.pendingStops) : [];
    for (const entry of list) {
      const id = itemId(entry?.id);
      if (id === undefined || this.stops.has(id)) {
        continue; // a stop clicked since the start is newer
      }
      const address = addressOf(entry.address) ? entry.address : undefined;
      const tries = Number.isSafeInteger(entry.tries) && entry.tries >= 0 ? entry.tries : 0;
      const at = time(entry.clickedAt);
      this.stops.set(id, {
        id,
        address,
        // Restored stops are older than anything of this run.
        clickSeq: 0,
        clickedAt: at === undefined ? wall : Math.min(at, wall),
        tries: Math.min(tries, TIMINGS.stopTries - 1),
        dir: entry.dir === 'up' || entry.dir === 'down' ? entry.dir : undefined,
        feedback: entry.feedback === true,
        answered: false,
        retryIndex: 0,
        fromBoot: true,
        token: {},
      });
    }
  }

  snapshot() {
    return {
      v: 1,
      address: this.lastAddressKey || undefined,
      confirm: this.confirmNeeded || undefined,
      lastReadAt: this.lastReadWall || undefined,
      pausedUntil:
        this.pauseLeft() > 0 ? Math.round(this.sessionWall() + this.pauseLeft()) : undefined,
      stops: [...this.stops.values()].slice(0, LIMITS.pendingStops).map((s) => ({
        id: s.id,
        address: s.address,
        clickedAt: Math.round(s.clickedAt),
        tries: s.tries,
        dir: s.dir,
        feedback: s.feedback,
      })),
    };
  }

  /** Writes /data in the background: nothing ever waits for it. */
  persist() {
    if (!this.loaded || this.storeBroken) {
      return undefined;
    }
    let saving;
    try {
      saving = Promise.resolve(this.store.save(this.snapshot()));
    } catch (err) {
      saving = Promise.reject(err);
    }
    const done = saving.catch((err) =>
      this.warnOnce('save', `Could not write /data: ${err?.message}`),
    );
    this.lastSave = done;
    return done;
  }

  // --- Lifecycle -------------------------------------------------------------------

  /**
   * Gladys (re)connected: the configuration is read (tried again every 30 s
   * without end when it cannot be); the same configuration keeps everything
   * and publishes again what Gladys keeps in memory only.
   */
  connected(getConfig) {
    const run = this.configChain.then(() => this.connectedNow(getConfig));
    this.configChain = run.catch(() => {});
    return run;
  }

  async connectedNow(getConfig) {
    this.cancel(this.configTimer);
    this.configTimer = undefined;
    if (this.closed) {
      return;
    }
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      this.logger.warn(`getConfig failed: ${err?.message}`);
      await this.setStatus(false, T.configUnread(TIMINGS.configRetry));
      this.configTimer = this.later(TIMINGS.configRetry, () => this.connected(getConfig));
      return;
    }
    if (this.closed) {
      return;
    }
    const config = normalizeConfig(raw);
    if (this.running && sameConfig(config, this.config)) {
      // Gladys restarted: it keeps the status, the Discovery and the badges in memory only.
      this.lastStatus = undefined;
      this.discovery = undefined;
      this.publishedBadges.clear();
      await this.publishDiscovery();
      await this.updateStatus();
      await this.publishBadges();
      return;
    }
    await this.start(raw);
  }

  /** The configuration was saved: applied one after the other, the last one wins. */
  configUpdated(raw) {
    const run = this.configChain.then(() => this.start(raw));
    this.configChain = run.catch(() => {});
    return run;
  }

  async start(raw = {}) {
    if (this.closed) {
      return;
    }
    this.generation += 1;
    const generation = this.generation;
    this.cancel(this.cycleTimer);
    this.cycleTimer = undefined;
    this.cycleCtl?.abort('restart');
    const previous = this.config;
    this.config = normalizeConfig(raw);
    const sameBox = previous.key === this.config.key;
    // A new session: nothing is known of the box until it is listed again.
    this.groups.clear();
    this.missingOnce.clear();
    this.remotes.clear();
    this.listed = false;
    this.remotesListed = false;
    this.listedAt = -Infinity;
    this.failures = 0;
    this.lastError = undefined;
    this.lastStatus = undefined;
    if (!sameBox) {
      this.states.clear();
      this.applied.clear();
      this.discovery = undefined;
    }
    if (this.config.error) {
      this.running = false;
      await this.setStatus(false, T.configError(this.config.error, this.config.length));
      return;
    }
    // /data first (bounded): the time of the last read and the last address.
    await this.boot();
    if (!this.current(generation)) {
      return;
    }
    this.running = true;
    const readSoon = this.config.key !== this.lastAddressKey;
    if (this.config.key !== this.lastAddressKey) {
      // Another box may hold the same ids and types: the covers are confirmed
      // by "Test the connection" before anything but a stop goes there.
      if (this.lastAddressKey) {
        this.confirmNeeded = true;
      }
      this.lastAddressKey = this.config.key;
      this.persist();
    }
    // Stops clicked before any address was known leave now.
    for (const stop of this.stops.values()) {
      if (!stop.address) {
        stop.address = this.config.key;
        this.kickStop(stop);
      }
    }
    await this.updateStatus();
    if (!this.current(generation)) {
      return;
    }
    await this.publishDiscovery();
    // Never sooner than the interval after the last read (restart, same box);
    // the lists (two small requests, no state) are read at once, so open and
    // position are not refused for up to an interval after a restart.
    const wait = readSoon
      ? 0
      : Math.max(0, this.lastReadMono + this.config.pollInterval * 1000 - this.monotonic());
    this.scheduleCycle(generation, wait);
    if (wait > 0) {
      this.later(0, () => this.listSoon(generation));
    }
  }

  current(generation) {
    return !this.closed && generation === this.generation;
  }

  /** Clean stop of the container: no timer, no request after it; /data written (bounded). */
  async stop() {
    this.closed = true;
    this.running = false;
    this.generation += 1;
    this.cycleCtl?.abort('stopping');
    for (const handle of this.timersSet) {
      this.timers.clearTimeout(handle);
    }
    this.timersSet.clear();
    for (const waiter of this.slotWaiters.splice(0)) {
      waiter(false);
    }
    if (this.loaded && !this.storeBroken) {
      let saving;
      try {
        saving = Promise.resolve(this.store.save(this.snapshot())).catch(() => {});
      } catch {
        saving = Promise.resolve();
      }
      let bound;
      await Promise.race([
        saving,
        new Promise((resolve) => {
          bound = setTimeout(resolve, TIMINGS.storeTimeout);
          bound.unref?.();
        }),
      ]);
      clearTimeout(bound);
    }
  }

  // --- Status and badges -------------------------------------------------------------

  async setStatus(connected, message) {
    const text = message ? trim(message) : undefined;
    const key = JSON.stringify([connected, text ?? null]);
    if (key === this.lastStatus || this.closed) {
      return;
    }
    this.lastStatus = key;
    try {
      await this.gladys.setConnectionStatus(connected, text);
    } catch (err) {
      this.logger.warn(`setConnectionStatus failed: ${err?.message}`);
    }
  }

  counts() {
    return { covers: this.groups.size, sensors: this.remotes.size };
  }

  /** The status from what is known now. */
  async updateStatus() {
    if (!this.running) {
      if (this.config.error) {
        await this.setStatus(false, T.configError(this.config.error, this.config.length));
      }
      return;
    }
    const extra = [];
    if (this.stops.size > 0) extra.push(T.stopsPending(this.stops.size));
    if (this.storeBroken) extra.push(T.storeBroken);
    if (this.confirmNeeded) extra.push(T.confirmNeeded);
    const join = (base, connected) => {
      const message = {
        en: [base.en, ...extra.map((e) => e.en)].join(' · '),
        fr: [base.fr, ...extra.map((e) => e.fr)].join(' · '),
      };
      return this.setStatus(connected, message);
    };
    const left = this.pauseLeft();
    if (left > 0) {
      await join(T.paused(left), false);
    } else if (this.lastError) {
      await join(T.failure(this.lastError, this.retryDelay()), false);
    } else if (this.listed) {
      await join(T.connected(this.counts(), this.config.pollInterval), true);
    } else {
      await join(T.connecting, false);
    }
  }

  /** Sets the badge of a device (published in the background, never awaited by a command). */
  badge(externalId, message, { degraded = false, transport = 'local' } = {}) {
    this.badges.set(externalId, {
      external_id: externalId,
      transport,
      degraded,
      // The SDK takes a message only on a degraded badge: a nominal one is just green.
      message: message && degraded ? trim(message) : undefined,
    });
    this.publishBadges().catch(() => {});
  }

  async publishBadges() {
    if (this.closed) {
      return;
    }
    const created = new Set(this.createdDevices().map((d) => d.external_id));
    const entries = [];
    for (const [id, entry] of this.badges) {
      if (!created.has(id)) continue;
      const json = JSON.stringify(entry);
      if (this.publishedBadges.get(id) !== json) {
        entries.push(entry);
        this.publishedBadges.set(id, json);
      }
    }
    try {
      for (let i = 0; i < entries.length; i += 100) {
        await this.gladys.publishTransports(entries.slice(i, i + 100));
      }
    } catch (err) {
      for (const entry of entries) this.publishedBadges.delete(entry.external_id);
      this.logger.warn(`Transport badges failed: ${err?.message}`);
    }
  }

  // --- Devices ---------------------------------------------------------------------------

  createdDevices() {
    const list = Array.isArray(this.gladys.devices) ? this.gladys.devices : [];
    return list.filter((d) => {
      const parsed = parseExternalId(this.gladys, d?.external_id);
      return parsed && parsed.key === undefined;
    });
  }

  async publishDiscovery() {
    if (this.closed) {
      return;
    }
    const language = this.config.language;
    const list = [
      ...[...this.groups.values()].map((g) => buildCover(this.gladys, g, { language })),
      ...[...this.remotes.values()].map((r) => buildSensor(this.gladys, r, { language })),
    ];
    const json = JSON.stringify(list);
    if (json === this.discovery) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(list);
      this.discovery = json;
    } catch (err) {
      this.logger.warn(`Discovery failed: ${err?.message}`);
    }
  }

  async scan() {
    if (!this.running) {
      return;
    }
    if (this.pauseLeft() === 0 && this.monotonic() - this.listedAt >= TIMINGS.testGap) {
      try {
        await this.readLists(this.generation, undefined);
      } catch (err) {
        this.logger.warn(`Scan failed: ${err?.message}`);
      }
    }
    this.discovery = undefined;
    await this.publishDiscovery();
  }

  deviceCreated() {
    // Nothing old is published as new: the next read gives its values.
    this.publishBadges().catch(() => {});
  }

  deviceDeleted(device) {
    const parsed = parseExternalId(this.gladys, device?.external_id);
    if (parsed) {
      this.badges.delete(device.external_id);
      this.publishedBadges.delete(device.external_id);
    }
  }

  /** The created device of a cover id, or undefined. */
  coverDevice(id) {
    const ext = groupIds(this.gladys, id).device;
    return this.createdDevices().find((d) => d.external_id === ext);
  }

  /** Whether the listing of this session contradicts the type a device was created with. */
  otherType(id, device) {
    const listed = this.groups.get(id);
    const type = paramOf(device, PARAMS.TYPE);
    return Boolean(listed && type && listed.type !== type);
  }

  // --- Requests ----------------------------------------------------------------------------

  rpc(address, method, params, options) {
    return call(address, method, params, { post: this.post, timers: this.timers, ...options });
  }

  // --- Reads -------------------------------------------------------------------------------

  scheduleCycle(generation, ms) {
    this.cancel(this.cycleTimer);
    this.cycleTimer = this.later(ms, () => {
      this.cycleTimer = undefined;
      return this.cycle(generation);
    });
  }

  retryDelay() {
    const backoff = Math.min(
      TIMINGS.retryMax,
      TIMINGS.retryMin * 2 ** Math.max(0, this.failures - 1),
    );
    return Math.max(backoff, this.config.pollInterval * 1000);
  }

  /** A 429 or a 5xx: reads and ordinary commands pause (never the stops and closes). */
  pauseFor(err) {
    const asked = err.retryAfter ?? TIMINGS.pauseMin;
    const ms = Math.min(TIMINGS.pauseMax, Math.max(TIMINGS.pauseMin, asked));
    const until = this.monotonic() + ms;
    if (until > this.pauseUntil) {
      this.pauseUntil = until;
      this.persist();
    }
  }

  /** The cycle: the lists when due, then the state of every created device, one at a time. */
  async cycle(generation) {
    if (!this.current(generation) || !this.running) {
      return;
    }
    const startedAt = this.monotonic();
    const left = this.pauseLeft(startedAt);
    if (left > 0) {
      await this.updateStatus();
      this.scheduleCycle(generation, left);
      return;
    }
    if (this.reading) {
      // The read of a previous session still ends: this one starts just after.
      this.scheduleCycle(generation, TIMINGS.readResume);
      return;
    }
    this.reading = true;
    // The attempt is kept before the read: a restart never reads sooner.
    this.lastReadMono = startedAt;
    this.lastReadWall = this.sessionWall(startedAt);
    this.persist();
    const ctl = new AbortController();
    this.cycleCtl = ctl;
    let next;
    try {
      if (!this.listed || startedAt - this.listedAt >= TIMINGS.listEvery) {
        await this.readLists(generation, ctl.signal);
      }
      if (!this.current(generation)) return;
      const outcome = await this.readTargets(generation, ctl.signal);
      if (!this.current(generation)) return;
      if (outcome.cut) {
        next = TIMINGS.readResume;
      } else if (
        (outcome.ok === 0 && outcome.failed > 0) ||
        (outcome.coversOk === 0 && outcome.coversFailed > 0)
      ) {
        // Every read failing (or every cover, a sensor answering) is not "connected".
        throw outcome.coverError ?? outcome.error;
      } else {
        this.failures = 0;
        this.lastError = undefined;
        next = Math.max(0, startedAt + this.config.pollInterval * 1000 - this.monotonic());
        // The box answers: the stops still waiting for an answer go now.
        for (const stop of this.stops.values()) {
          if (!stop.answered && !stop.sending) this.kickStop(stop);
        }
      }
    } catch (err) {
      if (!this.current(generation)) return;
      if (err?.kind === 'aborted') {
        next = TIMINGS.readResume;
      } else {
        this.failures += 1;
        this.lastError = err;
        // The box no longer answers: the session starts over (identity read again).
        this.listed = false;
        if (err?.kind === 'rate' || err?.kind === 'server') {
          this.pauseFor(err);
        }
        this.logger.warn(`CentralControl read failed: ${err?.message}`);
        next = Math.max(
          this.pauseLeft(),
          startedAt + this.retryDelay() - this.monotonic(),
          TIMINGS.readResume,
        );
      }
    } finally {
      if (this.cycleCtl === ctl) this.cycleCtl = undefined;
      this.reading = false;
    }
    if (!this.current(generation)) return;
    await this.updateStatus();
    this.scheduleCycle(generation, next);
  }

  /** The lists alone, out of the interval (start within the interval). */
  async listSoon(generation) {
    if (!this.current(generation) || !this.running || this.reading || this.listed) {
      return;
    }
    if (this.pauseLeft() > 0) {
      return;
    }
    this.reading = true;
    const ctl = new AbortController();
    this.cycleCtl = ctl;
    try {
      await this.readLists(generation, ctl.signal);
    } catch (err) {
      this.logger.warn(`CentralControl lists not read: ${err?.message}`);
      if (err?.kind === 'rate' || err?.kind === 'server') this.pauseFor(err);
    } finally {
      if (this.cycleCtl === ctl) this.cycleCtl = undefined;
      this.reading = false;
    }
    if (this.current(generation)) await this.updateStatus();
  }

  /** Cuts the periodic read in flight (a stop or a close); it does not count as a failure. */
  cutCycleRead() {
    this.cycleCtl?.abort('protective');
  }

  async readLists(generation, signal) {
    const address = this.config.address;
    const groupsResult = await this.rpc(
      address,
      METHODS.LIST,
      { item_type: 'group' },
      { timeout: TIMINGS.readTimeout, maxBytes: LIMITS.listBytes, signal },
    );
    const groups = parseGroups(groupsResult);
    const notCovers = parseOtherGroupIds(groupsResult);
    if (!groups) {
      throw new BeckerError('format', 'not a list of the box', { sent: true, answered: true });
    }
    if (!this.current(generation)) return;
    // The sensors are secondary: a failure keeps the previous list and never blocks the covers.
    let remotes;
    try {
      remotes = parseRemotes(
        await this.rpc(
          address,
          METHODS.LIST,
          { item_type: 'remote' },
          { timeout: TIMINGS.readTimeout, maxBytes: LIMITS.listBytes, signal },
        ),
      );
    } catch (err) {
      if (err?.kind === 'aborted') throw err;
      this.warnOnce('remotes', `Sensor list not read: ${err?.message}`);
    }
    if (!this.current(generation)) return;
    const next = new Map(groups.map((g) => [g.id, g]));
    // The box may list only part of its items (reference README): a created
    // cover missing from one list is kept until the next list, read at once.
    let missing = false;
    for (const device of this.createdDevices()) {
      const parsed = parseExternalId(this.gladys, device.external_id);
      if (parsed.kind !== 'group' || next.has(parsed.id)) {
        this.missingOnce.delete(parsed.id);
        continue;
      }
      const previous = this.groups.get(parsed.id);
      if (previous && !this.missingOnce.has(parsed.id)) {
        this.missingOnce.add(parsed.id);
        next.set(parsed.id, previous);
        missing = true;
      } else {
        this.missingOnce.delete(parsed.id);
      }
    }
    this.groups = next;
    this.notCovers = notCovers;
    if (remotes) {
      this.remotes = new Map(remotes.map((r) => [r.id, r]));
      this.remotesListed = true;
    }
    this.listed = true;
    this.listedAt = missing ? -Infinity : this.monotonic();
    await this.publishDiscovery();
    this.checkIdentities();
  }

  /** Badges of the created devices the listing contradicts. */
  checkIdentities() {
    for (const device of this.createdDevices()) {
      const parsed = parseExternalId(this.gladys, device.external_id);
      const listed =
        parsed.kind === 'group' ? this.groups.get(parsed.id) : this.remotes.get(parsed.id);
      if (parsed.kind === 'remote' && !this.remotesListed) continue;
      const type = paramOf(device, PARAMS.TYPE);
      if (!listed) {
        this.badge(device.external_id, T.badge.gone, { degraded: true, transport: 'unreachable' });
      } else if (type && listed.type !== type) {
        this.badge(device.external_id, T.badge.identity, { degraded: true });
      } else if (this.badges.get(device.external_id)?.transport === 'unreachable') {
        this.badge(device.external_id, undefined);
      }
    }
  }

  async readTargets(generation, signal) {
    const outcome = { ok: 0, failed: 0, coversOk: 0, coversFailed: 0, cut: false };
    for (const device of this.createdDevices()) {
      if (!this.current(generation)) return outcome;
      if (signal.aborted) {
        outcome.cut = true;
        return outcome;
      }
      const parsed = parseExternalId(this.gladys, device.external_id);
      try {
        if (parsed.kind === 'group') {
          const group = this.groups.get(parsed.id);
          if (!group?.feedback || this.otherType(parsed.id, device)) continue;
          await this.readGroup(parsed.id, this.config.address, signal);
          outcome.coversOk += 1;
          if (this.badges.get(device.external_id)?.transport === 'unreachable') {
            this.badge(device.external_id, undefined);
          }
        } else {
          const remote = this.remotes.get(parsed.id);
          const type = paramOf(device, PARAMS.TYPE);
          if (!remote || (type && remote.type !== type)) continue;
          await this.readRemote(remote, this.config.address, signal);
        }
        outcome.ok += 1;
      } catch (err) {
        if (err?.kind === 'aborted') {
          outcome.cut = true;
          return outcome;
        }
        if (err?.kind === 'rate' || err?.kind === 'server') {
          throw err; // the box asked to slow down: the whole cycle stops
        }
        if (err?.kind === 'rpc') {
          // The box answered and refuses this item (removed from it): not a
          // failure of the box, the others and the pace are untouched.
          this.badge(device.external_id, T.badge.readFailed(err), {
            degraded: true,
            transport: 'unreachable',
          });
          continue;
        }
        // One cover that fails never stops the others.
        outcome.failed += 1;
        outcome.error = err;
        if (parsed.kind === 'group') {
          outcome.coversFailed += 1;
          outcome.coverError = err;
          this.badge(device.external_id, T.badge.readFailed(err), {
            degraded: true,
            transport: 'unreachable',
          });
        }
        this.logger.warn(`Read of item ${parsed.id} failed: ${err?.message}`);
      }
    }
    return outcome;
  }

  /**
   * Reads the state of a cover; applies it only when no command of that cover
   * left after this read left, and no later read was applied. Resolves
   * `{ state, startSeq, fresh }`.
   */
  async readGroup(id, address, signal) {
    let startSeq = 0;
    const result = await this.rpc(
      address,
      METHODS.GROUP_STATE,
      { group_id: id },
      {
        timeout: TIMINGS.readTimeout,
        signal,
        beforeSend: () => {
          startSeq = ++this.seq;
        },
      },
    );
    const state = parseGroupState(result);
    const fresh =
      (this.commandSeq.get(id) ?? 0) < startSeq && (this.applied.get(id) ?? 0) < startSeq;
    if (fresh && address && addressKey(address) === this.config.key) {
      this.applied.set(id, startSeq);
      this.states.set(id, { ...state, mono: this.monotonic() });
      const device = this.coverDevice(id);
      const group = this.groups.get(id);
      if (device && group && !this.otherType(id, device) && state.value !== undefined) {
        const feature = groupIds(this.gladys, id).feature(FEATURES.POSITION);
        if (device.features?.some((f) => f.external_id === feature)) {
          await this.publish([
            { device_feature_external_id: feature, state: positionOf(group.type, state.value) },
          ]);
        }
      }
    }
    return { state, startSeq, fresh };
  }

  async readRemote(remote, address, signal) {
    let startSeq = 0;
    const result = await this.rpc(
      address,
      METHODS.ITEM_STATE,
      { item_id: remote.id },
      {
        timeout: TIMINGS.readTimeout,
        signal,
        beforeSend: () => {
          startSeq = ++this.seq;
        },
      },
    );
    if ((this.applied.get(-remote.id) ?? 0) >= startSeq) {
      return;
    }
    this.applied.set(-remote.id, startSeq);
    const values = parseRemoteState(result, remote.values);
    const ids = remoteIds(this.gladys, remote.id);
    const states = Object.entries(values).map(([key, value]) => ({
      device_feature_external_id: ids.feature(key),
      state: value,
    }));
    if (states.length > 0) {
      await this.publish(states);
    }
  }

  async publish(states) {
    // 300 states a minute at most, all devices together (a dropped one is
    // still changed at the next read, and published then).
    const mono = this.monotonic();
    this.publishedAt = this.publishedAt.filter((at) => mono - at < 60 * 1000);
    const room = LIMITS.statesPerMinute - this.publishedAt.length;
    if (room <= 0) {
      this.warnOnce('rate', 'More than 300 states a minute: some wait for the next read');
      return;
    }
    const batch = states.slice(0, room);
    // Reserved before the await: publications at the same time share the room.
    const reserved = batch.map(() => mono);
    this.publishedAt.push(...reserved);
    try {
      const result = await this.gladys.publishChangedStates(batch);
      const count = Number.isSafeInteger(result?.count) ? result.count : batch.length;
      for (let i = count; i < batch.length; i += 1) {
        const at = this.publishedAt.indexOf(mono);
        if (at !== -1) this.publishedAt.splice(at, 1);
      }
    } catch (err) {
      this.logger.warn(`Publication failed: ${err?.message}`);
    }
  }

  // --- Test button -------------------------------------------------------------------------

  async testConnection() {
    if (this.config.error || !this.config.address) {
      return T.configError(this.config.error ?? 'missing', this.config.length);
    }
    const mono = this.monotonic();
    if (mono - this.lastTestMono < TIMINGS.testGap) {
      return T.test.tooSoon(mono - this.lastTestMono);
    }
    const paused = this.pauseLeft(mono);
    if (paused > 0) {
      return T.paused(paused);
    }
    this.lastTestMono = mono;
    try {
      // The lists, as a read does: the covers are known for this session after it.
      await this.readLists(this.generation, undefined);
      if (this.confirmNeeded) {
        // The user saw this box answer at the new address: its covers are confirmed.
        this.confirmNeeded = false;
        this.persist();
        this.updateStatus().catch(() => {});
      }
      await this.updateStatus();
      return T.test.ok({ covers: this.groups.size, sensors: this.remotes.size });
    } catch (err) {
      if (err?.kind === 'rate' || err?.kind === 'server') this.pauseFor(err);
      return T.test.failed(err);
    }
  }

  // --- Commands ------------------------------------------------------------------------------

  /** A command from Gladys. Resolves once sent and answered; rejects otherwise (within ~3.5 s). */
  async setValue(device, feature, value) {
    const parsed = parseExternalId(this.gladys, feature?.external_id);
    if (!parsed || parsed.key === undefined) {
      throw new Refusal(T.why.unknownDevice);
    }
    if (parsed.kind !== 'group') {
      throw new Refusal(T.why.readOnly);
    }
    const id = parsed.id;
    const deviceExt = groupIds(this.gladys, id).device;
    const known = this.coverDevice(id) ?? device;
    if (parsed.key === FEATURES.STATE) {
      const command = commandOf(numeric(value));
      if (command === 'stop') {
        return this.stopClicked(id, known);
      }
      if (command === 'close') {
        return this.closeClicked(id, known);
      }
      if (command === 'open') {
        return this.command(id, known, 'open', undefined);
      }
      throw this.refuse(deviceExt, 'open', value, T.why.value);
    }
    const position = positionValue(numeric(value));
    if (position === undefined) {
      throw this.refuse(deviceExt, 'position', value, T.why.value);
    }
    return this.command(id, known, 'position', position);
  }

  refuse(deviceExt, command, value, why) {
    const text = T.badge.refused(command, String(value).slice(0, 8), why);
    this.badge(deviceExt, text, { degraded: true });
    return new Refusal(text);
  }

  /** The address a protective command goes to: the configuration's, else the last one known. */
  protectiveAddress() {
    if (this.config.address && !this.config.error) {
      return this.config.key;
    }
    return this.lastAddressKey || undefined;
  }

  /** Drops what is older than a stop or a close of this cover. */
  barrierFor(id, seq) {
    this.barrier.set(id, seq);
    this.commandSeq.set(id, seq);
    const close = this.closes.get(id);
    if (close && close.seq < seq) {
      close.cancelled = true;
    }
  }

  // --- Stop ----------------------------------------------------------------------------------

  async stopClicked(id, device) {
    const seq = ++this.seq;
    this.barrierFor(id, seq);
    this.cutCycleRead();
    const old = this.stops.get(id);
    if (old) {
      old.token = {}; // its timers and loops end
      this.cancel(old.timer);
    }
    const mono = this.monotonic();
    const last = this.states.get(id);
    const dir = last && mono - last.mono <= TIMINGS.stateFresh ? directionOf(last) : undefined;
    const group = this.groups.get(id);
    const feedback = group ? group.feedback : paramOf(device, PARAMS.FEEDBACK) === '1';
    const stop = {
      id,
      address: this.protectiveAddress(),
      clickSeq: seq,
      clickedAt: this.sessionWall(mono),
      tries: 0,
      dir,
      feedback,
      answered: false,
      retryIndex: 0,
      token: {},
    };
    this.stops.set(id, stop);
    const outcome = await this.runStop(stop, true);
    if (outcome.answered && !outcome.refused) {
      return { sent: true };
    }
    throw outcome.error ?? notSent('unknown');
  }

  /** Sends the stop again soon (a retry, a successful read, a newer command that failed). */
  kickStop(stop) {
    if (this.closed || stop.sending || this.stops.get(stop.id) !== stop) {
      return;
    }
    this.cancel(stop.timer);
    stop.timer = undefined;
    stop.answered = false;
    this.runStop(stop, false).catch((err) => this.logger.warn(`Stop: ${err?.message}`));
  }

  /**
   * One round of a stop: written until the box answers within the budget;
   * then the check (answered) or the next retry (not answered) is armed
   * BEFORE /data is written.
   */
  async runStop(stop, clicked) {
    const token = stop.token;
    const deviceExt = groupIds(this.gladys, stop.id).device;
    stop.sending = true;
    this.badge(deviceExt, T.badge.stopSending(stop.tries), { degraded: true });
    if (clicked) this.persist();
    let outcome;
    try {
      outcome = await this.sendProtective(stop, 'stop', () => stop.token === token);
    } finally {
      stop.sending = false;
    }
    if (this.closed || stop.token !== token || this.stops.get(stop.id) !== stop) {
      return outcome;
    }
    if (outcome.answered) {
      stop.tries += 1;
      stop.answered = true;
      stop.answeredSeq = outcome.sendSeq;
      if (!stop.feedback) {
        // Nothing to read back: an answered stop is all there is.
        this.finishStop(stop, T.badge.stopNoFeedback, false);
      } else {
        stop.checkFails = 0;
        stop.timer = this.later(TIMINGS.stopCheck, () => this.checkStop(stop, token));
        this.badge(
          deviceExt,
          outcome.refused
            ? T.badge.stopRefused(stop.tries, outcome.error)
            : T.badge.stopChecking(stop.tries),
          { degraded: true },
        );
        this.persist();
      }
    } else if (outcome.suspended) {
      // A newer command is in flight: its answer decides (kickStop when it fails).
      this.persist();
    } else {
      const delays = TIMINGS.stopRetries;
      const delay = delays[Math.min(stop.retryIndex, delays.length - 1)];
      stop.retryIndex += 1;
      stop.timer = this.later(delay, () => this.kickStop(stop));
      this.badge(deviceExt, T.badge.stopSending(stop.tries), { degraded: true });
      this.persist();
    }
    this.updateStatus().catch(() => {});
    return outcome;
  }

  finishStop(stop, text, degraded) {
    this.cancel(stop.timer);
    stop.token = {};
    if (this.stops.get(stop.id) === stop) {
      this.stops.delete(stop.id);
    }
    this.badge(groupIds(this.gladys, stop.id).device, text, { degraded });
    this.persist();
    this.updateStatus().catch(() => {});
  }

  /** The read back of an answered stop: a read that left after its answer. */
  async checkStop(stop, token) {
    stop.timer = undefined;
    if (stop.token !== token || this.stops.get(stop.id) !== stop) {
      return;
    }
    // The read back is a read: it waits for the end of a pause the box asked.
    const paused = this.pauseLeft();
    if (paused > 0) {
      stop.timer = this.later(paused, () => this.checkStop(stop, token));
      return;
    }
    const address = addressOf(stop.address);
    let read;
    try {
      read = await this.readGroup(stop.id, address, undefined);
    } catch (err) {
      if (stop.token !== token || this.stops.get(stop.id) !== stop) {
        return;
      }
      this.logger.warn(`Stop check of cover ${stop.id} failed: ${err?.message}`);
      if (err?.kind === 'rate' || err?.kind === 'server') {
        this.pauseFor(err);
      }
      if (err?.kind === 'rpc') {
        // The box refuses to give this state (group removed): nothing to check.
        this.finishStop(stop, T.badge.stopNoFeedback, false);
        return;
      }
      stop.checkFails = (stop.checkFails ?? 0) + 1;
      const delay = Math.min(
        TIMINGS.stopCheckRetryMax,
        TIMINGS.stopCheckRetry * 2 ** (stop.checkFails - 1),
      );
      stop.timer = this.later(Math.max(delay, this.pauseLeft()), () => this.checkStop(stop, token));
      return;
    }
    if (stop.token !== token || this.stops.get(stop.id) !== stop || stop.sending) {
      return;
    }
    if (read.startSeq <= (stop.answeredSeq ?? Infinity) || stop.suspendedBy) {
      // Left before the answer, or a newer command decides: check again later.
      stop.timer = this.later(TIMINGS.stopCheckRetry, () => this.checkStop(stop, token));
      return;
    }
    const moving = movingOf(read.state);
    if (moving === false) {
      this.finishStop(stop, T.badge.stopApplied, false);
      return;
    }
    if (moving === undefined) {
      this.finishStop(stop, T.badge.stopNoFeedback, false);
      return;
    }
    const direction = directionOf(read.state);
    if (stop.dir && direction && direction !== stop.dir) {
      this.finishStop(stop, T.badge.stopContradicted, true);
      return;
    }
    if (stop.tries >= TIMINGS.stopTries) {
      this.logger.warn(`Cover ${stop.id} still moves after ${stop.tries} answered stops`);
      this.finishStop(stop, T.badge.stopGaveUp, true);
      return;
    }
    // Still moving the same way: sent again (a reads started before never decides).
    this.kickStop(stop);
  }

  // --- Close ------------------------------------------------------------------------------

  async closeClicked(id, device) {
    const deviceExt = groupIds(this.gladys, id).device;
    if (this.notCovers.has(id)) {
      // The box lists this id as something else than a cover (a door, a light):
      // the only refusal of a close.
      throw this.refuse(deviceExt, 'close', '', T.why.notCover);
    }
    // The direction: the type the box lists now, else the one the device was
    // created with, else a shutter (down).
    const type = this.groups.get(id)?.type ?? paramOf(device, PARAMS.TYPE) ?? 'shutter';
    const seq = ++this.seq;
    this.barrierFor(id, seq);
    this.cutCycleRead();
    const close = { id, seq, type, address: this.protectiveAddress(), cancelled: false };
    this.closes.set(id, close);
    const stop = this.stops.get(id);
    const before = this.states.get(id);
    let outcome;
    try {
      outcome = await this.sendProtective(close, 'close', () => !close.cancelled, stop);
    } finally {
      if (this.closes.get(id) === close) this.closes.delete(id);
    }
    return this.afterMove(id, device, 'close', undefined, outcome, before);
  }

  /**
   * Writes a stop (`kind` 'stop') or a close every 250 ms until the box
   * answers, within the budget. Never waits for a read, a pause, the queue or
   * /data. `suspends`: the pending stop a close (a newer command) holds
   * while it is in flight.
   * @returns {Promise<{ answered: boolean, sent: boolean, error?: BeckerError, sendSeq?: number, suspended?: boolean }>}
   */
  async sendProtective(target, kind, alive, suspends) {
    const started = this.monotonic();
    const id = target.id;
    let sent = false;
    let error;
    for (;;) {
      if (this.closed || !alive()) {
        return { answered: false, sent, error: error ?? notSent('stopped') };
      }
      if (kind === 'stop' && target.suspendedBy) {
        return { answered: false, sent, suspended: true, error: notSent('stopped') };
      }
      const left = started + TIMINGS.protectiveBudget - this.monotonic();
      if (left <= 0) {
        break;
      }
      const address = addressOf(target.address);
      if (!address) {
        error = new BeckerError('notSent', 'no address', { why: 'config' });
        break;
      }
      let sendSeq;
      const marker = { kind };
      try {
        await this.rpc(
          address,
          METHODS.COMMAND,
          {
            group_id: id,
            command: 'move',
            value: kind === 'stop' ? 0 : moveOf(target.type, 'close'),
          },
          {
            // Never cut before the end of the budget: a slow answer is an answer.
            timeout: left,
            beforeSend: () => {
              if (this.closed || !alive()) throw notSent('stopped');
              if (kind === 'stop' && target.suspendedBy) throw notSent('stopped');
              sendSeq = ++this.seq;
              this.commandSeq.set(id, Math.max(this.commandSeq.get(id) ?? 0, sendSeq));
              if (suspends && this.stops.get(id) === suspends) {
                suspends.suspendedBy = marker;
              }
            },
          },
        );
        if (suspends && suspends.suspendedBy === marker) {
          // A newer move accepted by the box replaces the stop.
          suspends.suspendedBy = undefined;
          this.finishStop(suspends, T.badge.stopOverridden, false);
        }
        return { answered: true, sent: true, sendSeq };
      } catch (err) {
        error = err;
        sent = sent || err.sent;
        if (suspends && suspends.suspendedBy === marker) {
          suspends.suspendedBy = undefined;
          if (!alive() || this.monotonic() - started >= TIMINGS.protectiveBudget) {
            this.kickStop(suspends);
          }
        }
        if (err.kind === 'rate' || err.kind === 'server') {
          // Not an answer to the command: the others pause, this one tries again.
          this.pauseFor(err);
        } else if (err.answered) {
          // The box answered (a refusal, a 404, a page that is not JSON-RPC):
          // an answered try; the read back decides.
          return { answered: true, refused: true, sent: true, error: err, sendSeq };
        }
        if (err.kind === 'notSent' && err.why === 'stopped') {
          return { answered: false, sent, error: err, suspended: Boolean(target.suspendedBy) };
        }
      }
      const rest = started + TIMINGS.protectiveBudget - this.monotonic();
      if (rest <= 0) break;
      await this.sleep(Math.min(TIMINGS.protectiveRetry, rest));
    }
    if (suspends && !suspends.suspendedBy && this.stops.get(id) === suspends) {
      this.kickStop(suspends);
    }
    return { answered: false, sent, error };
  }

  // --- Open and position -----------------------------------------------------------------

  async command(id, device, command, position) {
    const deviceExt = groupIds(this.gladys, id).device;
    const value = command === 'position' ? position : undefined;
    if (!this.running || !this.config.address) {
      throw this.refuse(deviceExt, command, value ?? '', T.why.config);
    }
    const left = this.pauseLeft();
    if (left > 0) {
      throw this.refuse(deviceExt, command, value ?? '', T.why.paused(left));
    }
    if (this.confirmNeeded) {
      throw this.refuse(deviceExt, command, value ?? '', T.why.confirm);
    }
    const group = this.groups.get(id);
    if (!this.listed || !group) {
      throw this.refuse(deviceExt, command, value ?? '', T.why.identity);
    }
    if (this.otherType(id, device)) {
      throw this.refuse(deviceExt, command, value ?? '', T.why.otherType);
    }
    if (command === 'position' && !group.feedback) {
      throw this.refuse(deviceExt, command, value, T.why.noPosition);
    }
    if (this.queued >= LIMITS.queue) {
      throw this.refuse(deviceExt, command, value ?? '', T.why.queueFull);
    }
    const arrival = this.monotonic();
    const seq = ++this.seq;
    const address = this.config.address;
    const generation = this.generation;
    const params =
      command === 'position'
        ? { group_id: id, command: 'moveto', value: movetoOf(group.type, position) }
        : { group_id: id, command: 'move', value: moveOf(group.type, 'open') };
    this.queued += 1;
    const previous = this.chains.get(id) ?? Promise.resolve();
    const task = previous.then(() =>
      this.sendCommand({ id, seq, arrival, address, generation, params }),
    );
    this.chains.set(
      id,
      task.then(
        () => {},
        () => {},
      ),
    );
    const before = this.states.get(id);
    let outcome;
    try {
      outcome = await task;
    } finally {
      this.queued -= 1;
    }
    return this.afterMove(id, device, command, value, outcome, before);
  }

  async acquireSlot(deadline) {
    if (this.active < this.parallel) {
      this.active += 1;
      return true;
    }
    const wait = deadline - this.monotonic();
    if (wait <= 0) return false;
    return new Promise((resolve) => {
      let handle;
      const waiter = (ok) => {
        this.cancel(handle);
        resolve(ok);
      };
      handle = this.later(wait, () => {
        const i = this.slotWaiters.indexOf(waiter);
        if (i !== -1) this.slotWaiters.splice(i, 1);
        resolve(false);
      });
      this.slotWaiters.push(waiter);
    });
  }

  releaseSlot() {
    const next = this.slotWaiters.shift();
    if (next) {
      next(true); // the slot passes on
    } else {
      this.active -= 1;
    }
  }

  /** @returns {Promise<{ answered: boolean, sent: boolean, error?: BeckerError, sendSeq?: number }>} */
  async sendCommand({ id, seq, arrival, address, generation, params }) {
    // One at a time (a serial box), a scene of five covers needs longer windows.
    const serial = this.parallel === 1;
    const sendBy = arrival + (serial ? TIMINGS.serialSendBy : TIMINGS.commandSendBy);
    const answerBy = arrival + (serial ? TIMINGS.serialAnswerBy : TIMINGS.commandAnswerBy);
    const check = () => {
      if (this.closed || generation !== this.generation) throw notSent('stopping');
      if ((this.barrier.get(id) ?? 0) > seq) throw notSent('stopped');
      const mono = this.monotonic();
      if (mono > sendBy) throw notSent('late');
      if (this.pauseLeft(mono) > 0) throw notSent('paused');
    };
    try {
      check();
    } catch (err) {
      return { answered: false, sent: false, error: err };
    }
    if (!(await this.acquireSlot(sendBy))) {
      return { answered: false, sent: false, error: notSent(this.closed ? 'stopping' : 'late') };
    }
    const marker = { kind: 'command' };
    let sendSeq;
    let crowded = false;
    try {
      await this.rpc(address, METHODS.COMMAND, params, {
        timeout: Math.max(1, answerBy - this.monotonic()),
        beforeSend: () => {
          check();
          sendSeq = ++this.seq;
          this.commandSeq.set(id, sendSeq);
          // Other commands in flight when this one leaves (serial box detection).
          crowded = this.active > 1;
          const stop = this.stops.get(id);
          if (stop) stop.suspendedBy = marker;
        },
      });
      const stop = this.stops.get(id);
      if (stop && stop.suspendedBy === marker) {
        stop.suspendedBy = undefined;
        this.finishStop(stop, T.badge.stopOverridden, false);
      }
      return { answered: true, sent: true, sendSeq };
    } catch (err) {
      const stop = this.stops.get(id);
      if (stop && stop.suspendedBy === marker) {
        // In doubt, the stop goes.
        stop.suspendedBy = undefined;
        this.kickStop(stop);
      }
      if (err.kind === 'rate' || err.kind === 'server') {
        this.pauseFor(err);
      }
      if (err.kind === 'timeout' && err.sent && crowded && this.parallel > 1) {
        // A box that may serve one request at a time (unknown, see TODO.md):
        // its covers are commanded one after the other for the rest of the run.
        this.parallel = 1;
        this.logger.warn('A command got no answer while others were in flight: one at a time now');
      }
      if (err.kind === 'rpc') {
        return { answered: true, refused: true, sent: true, error: err, sendSeq };
      }
      return { answered: false, sent: err.sent, error: err };
    } finally {
      this.releaseSlot();
    }
  }

  /** The badge and the follow-up reads of a move (open, close, position). */
  afterMove(id, device, command, value, outcome, before) {
    const deviceExt = groupIds(this.gladys, id).device;
    if (outcome.answered && !outcome.refused) {
      const group = this.groups.get(id);
      const feedback = group ? group.feedback : paramOf(device, PARAMS.FEEDBACK) === '1';
      if (feedback) {
        this.badge(deviceExt, T.badge.sent(command, value), { degraded: true });
        this.followMove(id, command, value, outcome.sendSeq, before, 0);
      } else {
        this.badge(deviceExt, T.badge.sentNoFeedback(command, value));
      }
      return { sent: true };
    }
    if (outcome.refused) {
      this.badge(deviceExt, T.badge.boxRefused(command, value, outcome.error), { degraded: true });
      throw outcome.error;
    }
    if (outcome.sent) {
      this.badge(deviceExt, T.badge.unconfirmed(command, value, outcome.error), { degraded: true });
      this.followMove(id, command, value, undefined, before, 0);
    } else {
      this.badge(deviceExt, T.badge.nothingSent(command, value, outcome.error), {
        degraded: true,
      });
    }
    throw outcome.error ?? notSent('unknown');
  }

  /** Read backs of a move at 5 s and 20 s; a newer command of the cover ends them. */
  followMove(id, command, value, sendSeq, before, index) {
    const delays = TIMINGS.commandChecks;
    if (index >= delays.length) return;
    const mark = this.commandSeq.get(id);
    const generation = this.generation;
    this.later(delays[index] - (index > 0 ? delays[index - 1] : 0), async () => {
      if (!this.current(generation) || this.commandSeq.get(id) !== mark) return;
      if (this.pauseLeft() > 0 || !this.config.address) return;
      let read;
      try {
        read = await this.readGroup(id, this.config.address, undefined);
      } catch {
        this.followMove(id, command, value, sendSeq, before, index + 1);
        return;
      }
      if (!read.fresh || this.commandSeq.get(id) !== mark) return;
      const group = this.groups.get(id);
      if (!group || read.state.value === undefined) return;
      const deviceExt = groupIds(this.gladys, id).device;
      const position = positionOf(group.type, read.state.value);
      const target = command === 'open' ? 100 : command === 'close' ? 0 : value;
      const last = index === delays.length - 1;
      const wasStill = before && movingOf(before) === false;
      if (position === target) {
        this.badge(deviceExt, T.badge.applied(command, value));
        return;
      }
      if (movingOf(read.state) === true && wasStill) {
        this.badge(deviceExt, T.badge.moving(command, value), { degraded: true });
      } else {
        this.badge(
          deviceExt,
          last ? T.badge.notApplied(command, value) : T.badge.notYet(command, value),
          { degraded: true },
        );
      }
      this.followMove(id, command, value, sendSeq, before, index + 1);
    });
  }
}
