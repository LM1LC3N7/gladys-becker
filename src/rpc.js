// -----------------------------------------------------------------------------
// The JSON-RPC API of the CentralControl over HTTP (local network only), as
// Becker's reference integration speaks it (central_control.py): a POST of
// `JSON + "\0"` (Content-Type text/plain) to /cgi-bin/cc51rpc.cgi, the answer
// being one JSON-RPC object, a NUL byte possibly ending it.
//
// Each request has its own connection (no keep-alive, never two requests on
// one connection); it leaves only once its socket is connected, after the
// caller's `beforeSend` check, so a refused connection is "not sent". The
// answer is bounded in size and time, and only the answer carrying the id of
// the request is accepted. Redirections are never followed. Never the headers
// of the Becker relay (gw.b-tronic.net), never a cookie.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { BOX, LIMITS } from './constants.js';

export class BeckerError extends Error {
  /**
   * @param {'network'|'timeout'|'aborted'|'notSent'|'size'|'http'|'redirect'|'rate'|'server'|'format'|'rpc'} kind
   * @param {string} message English (logs); src/i18n.js reasonOf() translates.
   * @param {{ sent?: boolean, answered?: boolean, status?: number, retryAfter?: number, code?: number, netCode?: string, why?: string }} [details]
   *   sent: the request left (its bytes written to a connected socket);
   *   answered: an answer of the box came back (any HTTP status).
   */
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'BeckerError';
    this.kind = kind;
    this.sent = Boolean(details.sent);
    this.answered = Boolean(details.answered);
    this.status = details.status;
    this.retryAfter = details.retryAfter;
    this.code = details.code;
    this.netCode = details.netCode;
    this.why = details.why;
  }
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
]);

/** Retry-After (seconds or an HTTP date, against the Date header of the answer) -> ms, or undefined. */
export function retryAfterOf(value, dateHeader) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 64) {
    return undefined;
  }
  if (/^\s*\d{1,7}\s*$/.test(value)) {
    return Number(value) * 1000;
  }
  const at = Date.parse(value);
  const reference = typeof dateHeader === 'string' ? Date.parse(dateHeader) : NaN;
  // Without a readable Date of the box, a date is never compared to our clock.
  return Number.isFinite(at) && Number.isFinite(reference)
    ? Math.max(0, at - reference)
    : undefined;
}

/**
 * One POST; resolves `{ status, headers, body }` (body a string).
 * @param {{ host: string, port: number }} address
 * @param {string} body
 * @param {{ timeout: number, maxBytes?: number, signal?: AbortSignal, beforeSend?: () => void, timers?: object }} options
 *   `beforeSend` runs once the socket is connected, just before the bytes
 *   leave; it throws to cancel (the request then never left).
 */
export function httpPost(
  address,
  body,
  { timeout, maxBytes = LIMITS.answerBytes, signal, beforeSend, timers = globalThis },
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let answered = false;
    let timer;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        timers.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      }
    };
    const fail = (err) => {
      settle(reject, err);
      req.destroy();
    };
    const onAbort = () =>
      fail(new BeckerError('aborted', 'request cut', { sent, answered, why: signal?.reason }));
    const req = http.request(
      {
        host: address.host,
        port: address.port,
        path: BOX.path,
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'text/plain',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Connection: 'close',
        },
      },
      (res) => {
        answered = true;
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          fail(new BeckerError('size', 'answer too large', { sent: true, answered: true }));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            fail(new BeckerError('size', 'answer too large', { sent: true, answered: true }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          settle(resolve, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', () =>
          fail(new BeckerError('network', 'answer cut', { sent: true, answered: true })),
        );
      },
    );
    req.on('error', (err) => {
      const netCode = NETWORK_CODES.has(err?.code) ? err.code : undefined;
      settle(
        reject,
        new BeckerError('network', netCode ? `network error ${netCode}` : 'network error', {
          sent,
          answered,
          netCode,
        }),
      );
    });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = timers.setTimeout(
      () => fail(new BeckerError('timeout', 'no answer in time', { sent, answered })),
      timeout,
    );
    const send = () => {
      if (settled) {
        return;
      }
      try {
        beforeSend?.();
      } catch (err) {
        fail(
          err instanceof BeckerError
            ? err
            : new BeckerError('notSent', err?.message ?? 'not sent', { why: err?.why }),
        );
        return;
      }
      sent = true;
      req.end(body);
    };
    req.once('socket', (socket) => {
      if (socket.connecting) {
        socket.once('connect', send);
      } else {
        send();
      }
    });
  });
}

let nextId = 1 + Math.floor(Math.random() * 100000);

/** The JSON-RPC body of one call (and its id). */
export function requestBody(method, params) {
  nextId = nextId >= 1e9 ? 1 : nextId + 1;
  const id = nextId;
  return { id, body: `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\u0000` };
}

/**
 * The `result` of the answer to the call `id`, or the BeckerError it carries.
 * Every error here is "answered" (the box did answer).
 */
export function parseAnswer({ status, headers = {}, body }, id) {
  const answered = { sent: true, answered: true, status };
  if (status >= 300 && status < 400) {
    throw new BeckerError('redirect', `redirected (HTTP ${status})`, answered);
  }
  if (status === 429) {
    return failWith('rate', 'too many requests (HTTP 429)');
  }
  if (status >= 500) {
    return failWith('server', `HTTP ${status}`);
  }
  if (status < 200 || status >= 300) {
    throw new BeckerError('http', `HTTP ${status}`, answered);
  }
  let json;
  try {
    // The box may end its answer with a NUL byte (the reference strips it).
    json = JSON.parse(String(body).replace(/\u0000+\s*$/, ''));
  } catch {
    json = undefined;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new BeckerError('format', 'not an answer of a CentralControl', answered);
  }
  if (json.id !== id) {
    throw new BeckerError('format', 'answer to another request', answered);
  }
  if (Object.hasOwn(json, 'error') && json.error !== null) {
    const code = Number.isSafeInteger(json.error?.code) ? json.error.code : undefined;
    throw new BeckerError(
      'rpc',
      code === undefined ? 'error of the box' : `error ${code} of the box`,
      { ...answered, code },
    );
  }
  if (!Object.hasOwn(json, 'result')) {
    throw new BeckerError('format', 'answer without a result', answered);
  }
  return json.result;

  function failWith(kind, message) {
    throw new BeckerError(kind, message, {
      ...answered,
      retryAfter: retryAfterOf(headers['retry-after'], headers.date),
    });
  }
}

/**
 * One call: resolves its `result`.
 * @param {{ host: string, port: number }} address
 * @param {string} method
 * @param {object} params
 * @param {{ timeout: number, maxBytes?: number, signal?: AbortSignal, beforeSend?: () => void, timers?: object, post?: typeof httpPost }} options
 */
export async function call(address, method, params, { post = httpPost, ...options }) {
  const { id, body } = requestBody(method, params);
  const answer = await post(address, body, options);
  return parseAnswer(answer, id);
}
