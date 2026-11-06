// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), readable by the container user only (0600):
//   - `stops`: the stops not yet confirmed by a read back, with the address of
//     the box they were clicked for: sent again at start, before Gladys is
//     even reached, until a read shows them applied (or they are answered 3
//     times and the cover still moves, or a newer command accepted by the box
//     replaces them). No age limit.
//   - `pausedUntil`: the end of a pause asked by the box (429, 5xx);
//   - `lastReadAt`: when the box was last read, so a restart never reads
//     sooner than the interval.
// Times are wall-clock milliseconds (for the restart only); a time in the
// future is not trusted.
//
// Nothing ever waits for /data without a bound: a read or a write that takes
// longer than TIMINGS.storeTimeout fails (the stop path never waits for a
// write at all), a special file (FIFO, device, link) is refused, and an
// unreadable file is never overwritten (it may hold stops).
// -----------------------------------------------------------------------------

import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { LIMITS, TIMINGS } from './constants.js';

export const STATE_FILE = '/data/becker-state.json';

const { O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW, O_NONBLOCK } = constants;

/** `promise`, or a rejection after `ms` (the work itself may go on, never awaited). */
function bounded(promise, ms, timers = globalThis) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = timers.setTimeout(() => reject(new Error('/data too slow')), ms);
    }),
  ]).finally(() => timers.clearTimeout(timer));
}

async function readSmallFile(path) {
  // O_NONBLOCK: opening a FIFO never blocks; O_NOFOLLOW: never a link.
  const handle = await open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error('not a regular file');
    }
    if (stat.size > LIMITS.stateBytes) {
      throw new Error('too large');
    }
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close().catch(() => {});
  }
}

async function writeSmallFile(path, text) {
  const temporary = `${path}.tmp`;
  const handle = await open(
    temporary,
    O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_NONBLOCK,
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error('not a regular file');
    }
    await handle.writeFile(text, 'utf8');
  } finally {
    await handle.close().catch(() => {});
  }
  await rename(temporary, path);
}

/**
 * The /data file. `load()` resolves `{ data }`, `{ missing: true }` or
 * `{ broken: true }`; `save(data)` writes the latest data given (a save asked
 * while another runs replaces any one still waiting) and rejects after the
 * bound.
 */
export function fileStore({
  path = process.env.BECKER_STATE_FILE || STATE_FILE,
  timeout = TIMINGS.storeTimeout,
  timers = globalThis,
  read = readSmallFile,
  write = writeSmallFile,
} = {}) {
  let running = null;
  let waiting = null;
  const run = () => {
    const job = waiting;
    waiting = null;
    running = write(path, job.text).then(
      () => job.resolve(),
      (err) => job.reject(err),
    );
    running.finally(() => {
      running = null;
      if (waiting) run();
    });
  };
  return {
    async load() {
      try {
        const text = await bounded(read(path), timeout, timers);
        return { data: JSON.parse(text) };
      } catch (err) {
        return err?.code === 'ENOENT' ? { missing: true } : { broken: true };
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const promise = new Promise((resolve, reject) => {
        // A save still waiting is replaced: only the latest data matters.
        waiting?.resolve();
        waiting = { text, resolve, reject };
      });
      if (!running) run();
      return bounded(promise, timeout, timers);
    },
  };
}

/** For the tests: the same JSON round trip as the file; `hang` freezes the writes, `fail` breaks them, `broken` the reads. */
export function memoryStore(initial = null, { broken = false, loading } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    hang: false,
    fail: false,
    broken,
    loads: 0,
    /** `loading`: a promise the load waits for (a slow disk). */
    loading,
    async load() {
      this.loads += 1;
      if (this.loading) await this.loading;
      if (this.broken) return { broken: true };
      return this.data === null
        ? { missing: true }
        : { data: JSON.parse(JSON.stringify(this.data)) };
    },
    save(data) {
      if (this.hang) return new Promise(() => {});
      if (this.fail) return Promise.reject(new Error('disk full'));
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
      return Promise.resolve();
    },
  };
}
