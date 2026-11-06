// -----------------------------------------------------------------------------
// The HTTP layer against a real local server (127.0.0.1, free port): what
// leaves, what is accepted back, and every bound. Short real timeouts: no test
// waits longer than 2 s, even on a mutant.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import http from 'node:http';
import { BeckerError, call, httpPost, parseAnswer, retryAfterOf } from '../src/rpc.js';

async function server(handler, t) {
  const requests = [];
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(entry);
      handler(entry, res);
    });
  });
  srv.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => srv.close(resolve));
  });
  return { address: { host: '127.0.0.1', port: srv.address().port }, requests };
}

const rpcAnswer = (entry, result, extra = '\u0000') => {
  const { id } = JSON.parse(entry.body.replace(/\u0000$/, ''));
  return `${JSON.stringify({ jsonrpc: '2.0', id, result })}${extra}`;
};

test('a call is the JSON-RPC of the reference, ended by a NUL byte, without the relay headers', async (t) => {
  const srv = await server((entry, res) => res.end(rpcAnswer(entry, { ok: 1 })), t);
  const result = await call(
    srv.address,
    'deviced.group_get_state',
    { group_id: 3 },
    { timeout: 1000 },
  );
  assert.deepEqual(result, { ok: 1 });
  const [r] = srv.requests;
  assert.equal(r.method, 'POST');
  assert.equal(r.url, '/cgi-bin/cc51rpc.cgi');
  assert.ok(r.body.endsWith('\u0000'));
  const json = JSON.parse(r.body.slice(0, -1));
  assert.equal(json.jsonrpc, '2.0');
  assert.equal(json.method, 'deviced.group_get_state');
  assert.deepEqual(json.params, { group_id: 3 });
  assert.equal(r.headers['content-type'], 'text/plain');
  assert.equal(r.headers.host, `127.0.0.1:${srv.address.port}`);
  assert.equal(r.headers.origin, undefined);
  assert.equal(r.headers.connection, 'close', 'one request per connection');
  assert.equal(r.headers.cookie, undefined);
  assert.doesNotMatch(JSON.stringify(r.headers), /b-tronic/);
});

test('an echoed id must be ours; an id not echoed (absent, null, 0) is accepted', async (t) => {
  let id;
  const srv = await server((entry, res) => {
    const body = { jsonrpc: '2.0', result: { ok: 1 } };
    if (id !== 'absent') body.id = id === 'mine' ? JSON.parse(entry.body.slice(0, -1)).id : id;
    res.end(JSON.stringify(body));
  }, t);
  for (id of ['absent', null, 0, 'mine']) {
    assert.deepEqual(await call(srv.address, 'm', {}, { timeout: 1000 }), { ok: 1 }, String(id));
  }
  for (id of [7, 'x']) {
    await assert.rejects(
      call(srv.address, 'm', {}, { timeout: 1000 }),
      (e) => e.kind === 'format' && e.answered,
      String(id),
    );
  }
});

test('an error of the box is an answered refusal with its code', async (t) => {
  const srv = await server((entry, res) => {
    const { id } = JSON.parse(entry.body.slice(0, -1));
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'wind alarm' } }));
  }, t);
  await assert.rejects(
    call(srv.address, 'm', {}, { timeout: 1000 }),
    (e) => e.kind === 'rpc' && e.code === -32000 && e.answered,
  );
});

test('an answer too large is cut before it is read whole', async (t) => {
  let written = 0;
  const srv = await server((entry, res) => {
    res.writeHead(200);
    const chunk = Buffer.alloc(8 * 1024, 0x20);
    const timer = setInterval(() => {
      written += chunk.length;
      if (!res.write(chunk) || written > 4 * 1024 * 1024) clearInterval(timer);
    }, 1);
    res.on('close', () => clearInterval(timer));
  }, t);
  await assert.rejects(
    httpPost(srv.address, 'x', { timeout: 2000, maxBytes: 16 * 1024 }),
    (e) => e.kind === 'size',
  );
  assert.ok(written < 4 * 1024 * 1024);
  const declared = await server((entry, res) => {
    res.writeHead(200, { 'content-length': String(10 * 1024 * 1024) });
    res.write('x');
  }, t);
  await assert.rejects(
    httpPost(declared.address, 'x', { timeout: 2000, maxBytes: 1024 }),
    (e) => e.kind === 'size',
  );
});

test('a refused connection never left; a silent box left without answer', async (t) => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  await assert.rejects(
    httpPost({ host: '127.0.0.1', port }, 'x', { timeout: 1000 }),
    (e) => e.kind === 'network' && e.sent === false && e.answered === false,
  );
  const silent = await server(() => {}, t);
  await assert.rejects(
    httpPost(silent.address, 'x', { timeout: 300 }),
    (e) => e.kind === 'timeout' && e.sent === true && e.answered === false,
  );
});

test('beforeSend runs once connected; when it throws nothing leaves', async (t) => {
  const srv = await server((entry, res) => res.end('{}'), t);
  await assert.rejects(
    httpPost(srv.address, 'x', {
      timeout: 1000,
      beforeSend: () => {
        throw new BeckerError('notSent', 'late', { why: 'late' });
      },
    }),
    (e) => e.kind === 'notSent' && e.why === 'late' && !e.sent,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(srv.requests.length, 0);
});

test('a cut request (stop or close) rejects at once as "aborted"', async (t) => {
  const srv = await server(() => {}, t);
  const ctl = new AbortController();
  const pending = httpPost(srv.address, 'x', { timeout: 5000, signal: ctl.signal });
  setTimeout(() => ctl.abort('protective'), 50);
  const started = performance.now();
  await assert.rejects(pending, (e) => e.kind === 'aborted');
  assert.ok(performance.now() - started < 1000);
});

test('redirections are never followed; 429 and 5xx carry their delay', async (t) => {
  const srv = await server((entry, res) => {
    res.writeHead(302, { location: '/elsewhere' });
    res.end();
  }, t);
  await assert.rejects(call(srv.address, 'm', {}, { timeout: 1000 }), (e) => e.kind === 'redirect');
  assert.equal(srv.requests.length, 1);
  assert.throws(
    () => parseAnswer({ status: 429, headers: { 'retry-after': '120' }, body: '' }, 1),
    (e) => e.kind === 'rate' && e.retryAfter === 120000,
  );
  assert.throws(
    () => parseAnswer({ status: 503, headers: {}, body: '' }, 1),
    (e) => e.kind === 'server',
  );
  // An HTTP date only against the Date of the box, never our clock.
  assert.equal(retryAfterOf('Wed, 21 Oct 2026 07:28:00 GMT', undefined), undefined);
  assert.equal(
    retryAfterOf('Wed, 21 Oct 2026 07:28:00 GMT', 'Wed, 21 Oct 2026 07:27:00 GMT'),
    60000,
  );
  assert.equal(retryAfterOf('', undefined), undefined);
});

test('an answer without result, or not an object, is not an answer of a CentralControl', () => {
  assert.throws(
    () => parseAnswer({ status: 200, body: '{"jsonrpc":"2.0","id":4}' }, 4),
    (e) => e.kind === 'format',
  );
  assert.throws(
    () => parseAnswer({ status: 200, body: '[1]' }, 4),
    (e) => e.kind === 'format',
  );
  assert.throws(
    () => parseAnswer({ status: 200, body: '<html>' }, 4),
    (e) => e.kind === 'format',
  );
  assert.deepEqual(
    parseAnswer({ status: 200, body: '{"id":4,"result":{"a":1}}\u0000\u0000\n' }, 4),
    { a: 1 },
  );
});
