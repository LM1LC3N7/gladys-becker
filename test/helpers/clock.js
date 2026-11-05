// Virtual clock, copied from gladys-testkit (src/clock.mjs, Apache-2.0, same author):
// the repository tests must not depend on a path outside the repository.

/** Lets pending promises and I/O callbacks run (a few turns of the event loop). */
export async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const handle = (id) => ({
  id,
  ref() {
    return this;
  },
  unref() {
    return this;
  },
  hasRef: () => true,
});

/**
 * A virtual clock: nothing fires by itself. Every read of `now()` (wall,
 * epoch ms) or `monotonic()` moves the time on by `step` (1 µs): a decision
 * reading the clock twice sees it move, as on a real clock. `advance(ms)`
 * fires every timer due on the way, in order, WITHOUT awaiting the promise a
 * callback returns (as Node does), with a turn of the event loop between two.
 */
export function testClock({ start = Date.UTC(2026, 0, 1), step = 0.001 } = {}) {
  let t = 0;
  let seq = 0;
  const pending = new Map();
  const read = () => (t += step);
  const add = (fn, ms, args, every) => {
    const h = handle((seq += 1));
    const delay = Math.max(0, Number(ms) || 0);
    pending.set(h, { fn, args, at: t + delay, seq, every: every ? Math.max(1, delay) : 0 });
    return h;
  };
  const remove = (h) => pending.delete(h);
  const clock = {
    now: () => start + read(),
    monotonic: () => read(),
    /** Virtual ms since the start, without moving the clock. */
    get elapsed() {
      return t;
    },
    get pending() {
      return pending.size;
    },
    timers: {
      setTimeout: (fn, ms, ...args) => add(fn, ms, args, false),
      setInterval: (fn, ms, ...args) => add(fn, ms, args, true),
      clearTimeout: remove,
      clearInterval: remove,
    },
    async advance(ms) {
      const target = t + ms;
      for (let guard = 0; guard < 100_000; guard += 1) {
        let next;
        for (const [h, timer] of pending) {
          if (
            timer.at <= target &&
            (!next || timer.at < next[1].at || (timer.at === next[1].at && timer.seq < next[1].seq))
          ) {
            next = [h, timer];
          }
        }
        if (!next) break;
        const [h, timer] = next;
        t = Math.max(t, timer.at);
        if (timer.every) timer.at += timer.every;
        else pending.delete(h);
        timer.fn(...timer.args);
        await settle(1);
      }
      t = Math.max(t, target);
      await settle(1);
    },
  };
  return clock;
}
