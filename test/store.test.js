// -----------------------------------------------------------------------------
// /data: bounded, never a special file, never overwritten when unreadable.
// Each test works in its own mkdtemp directory, removed after it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, openSync, closeSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore } from '../src/store.js';

async function dir(t) {
  const path = await mkdtemp(join(tmpdir(), 'becker-store-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

/**
 * A FIFO in its own directory. Its waker is registered BEFORE the removal of
 * the directory (t.after runs in order): a reader left blocked on it (a mutant
 * without O_NONBLOCK) is released while the path still exists.
 */
async function fifo(t, name) {
  const base = await mkdtemp(join(tmpdir(), 'becker-fifo-'));
  const path = join(base, name);
  execFileSync('mkfifo', [path]);
  t.after(() => {
    try {
      closeSync(openSync(path, constants.O_RDWR | constants.O_NONBLOCK));
    } catch {
      // nothing blocked on it
    }
  });
  t.after(() => rm(base, { recursive: true, force: true }));
  return path;
}

test('a round trip, written 0600; a missing file is "missing", not broken', async (t) => {
  const path = join(await dir(t), 'state.json');
  const store = fileStore({ path });
  assert.deepEqual(await store.load(), { missing: true });
  await store.save({ stops: [{ id: 1 }] });
  assert.deepEqual(await store.load(), { data: { stops: [{ id: 1 }] } });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('saves asked while one runs: the latest wins', async (t) => {
  const path = join(await dir(t), 'state.json');
  const store = fileStore({ path });
  await Promise.all([1, 2, 3, 4].map((n) => store.save({ n })));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { n: 4 });
});

test('a FIFO, a link or a huge file is refused at once, never waited for', async (t) => {
  const base = await dir(t);
  const pipe = await fifo(t, 'pipe.json');
  const started = performance.now();
  assert.deepEqual(await fileStore({ path: pipe, timeout: 1000 }).load(), { broken: true });
  assert.ok(performance.now() - started < 900, 'refused, not timed out');
  const target = join(base, 'real.json');
  await writeFile(target, '{}');
  const link = join(base, 'link.json');
  await symlink(target, link);
  assert.deepEqual(await fileStore({ path: link }).load(), { broken: true });
  const big = join(base, 'big.json');
  await writeFile(big, `"${'x'.repeat(70 * 1024)}"`);
  assert.deepEqual(await fileStore({ path: big }).load(), { broken: true });
  const bad = join(base, 'bad.json');
  await writeFile(bad, '{not json');
  assert.deepEqual(await fileStore({ path: bad }).load(), { broken: true });
});

test('a FIFO planted as the temporary file: the save fails at once', async (t) => {
  const planted = await fifo(t, 'state.json.tmp');
  const path = planted.slice(0, -'.tmp'.length);
  const started = performance.now();
  await assert.rejects(fileStore({ path, timeout: 1000 }).save({ a: 1 }));
  assert.ok(performance.now() - started < 900);
});

test('a read of /data that never ends is given up after its bound', async () => {
  const started = performance.now();
  const store = fileStore({
    path: '/nonexistent/x',
    timeout: 200,
    read: () => new Promise(() => {}),
  });
  let bound;
  const outcome = await Promise.race([
    store.load(),
    new Promise((resolve) => {
      bound = setTimeout(() => resolve('still waiting'), 1000);
    }),
  ]);
  clearTimeout(bound);
  assert.deepEqual(outcome, { broken: true });
  assert.ok(performance.now() - started < 1000);
});
