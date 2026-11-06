// -----------------------------------------------------------------------------
// A CentralControl in memory, behind the `post` the app takes by injection: the
// same contract as src/rpc.js httpPost (beforeSend once "connected", timeout,
// abort signal, answers as { status, headers, body }), on the virtual clock.
// Every request that left is logged with the virtual time it left.
// -----------------------------------------------------------------------------

import { BeckerError } from '../../src/rpc.js';

export const ADDRESS = '192.168.1.70';

export const GROUPS = [
  { id: 1, name: 'Salon', device_type: 'shutter', feedback: true, backend: 'b-tronic' },
  { id: 2, name: 'Cuisine', device_type: 'shutter', feedback: true, backend: 'centronicplus' },
  { id: 3, name: 'Terrasse', device_type: 'awning', feedback: true, backend: 'b-tronic' },
  { id: 4, name: 'Chambre', device_type: 'shutter', feedback: false, backend: 'centronic' },
  { id: 5, name: 'Bureau', device_type: 'venetian', feedback: true, backend: 'b-tronic' },
  { id: 9, name: 'Garage', device_type: 'door', feedback: true, backend: 'b-tronic' },
];

export const REMOTES = [
  { id: 20, name: 'Météo', remote_type: 'sensor-sun-wind-rain-temp' },
  { id: 21, name: 'Vent', remote_type: 'sensor-wind' },
  { id: 22, name: 'Télécommande', remote_type: 'remote-4ch' },
];

/**
 * @param {{ clock: object, latency?: number|Function, mode?: Function }} options
 *   mode(method, params, host) -> undefined (answer) | 'drop' (left, never
 *   answered) | 'refuse' (never left) | 'rpcError' | { status, body?, headers? }
 *   | { latency } | a promise (answered once it resolves)
 */
export function createBox({ clock, latency = 30, mode } = {}) {
  const box = {
    groups: GROUPS.map((g) => ({ ...g })),
    remotes: REMOTES.map((r) => ({ ...r })),
    /** group id -> { value, moving_up, moving_down } */
    states: new Map(GROUPS.map((g) => [g.id, { value: 0, moving_up: 0, moving_down: 0 }])),
    /** remote id -> state */
    sensors: new Map([
      [
        20,
        { 'value-sun': 7, 'value-wind': 2, 'value-rain': 0, 'value-temp': 18.46, 'value-dawn': 3 },
      ],
      [21, { 'value-wind': 4 }],
    ]),
    log: [],
    latency,
    mode,
    /** requests in flight (left, not answered) */
    open: 0,
    peak: 0,
    commands(filter = () => true) {
      return box.log.filter((r) => r.method === 'deviced.group_send_command' && filter(r.params));
    },
    stops(id) {
      return box.commands(
        (p) => p.command === 'move' && p.value === 0 && (id === undefined || p.group_id === id),
      );
    },
    reads(id) {
      return box.log.filter(
        (r) =>
          r.method === 'deviced.group_get_state' && (id === undefined || r.params.group_id === id),
      );
    },
  };

  const apply = (method, params) => {
    if (method === 'deviced.group_send_command') {
      const state = box.states.get(params.group_id);
      if (!state) return { error: { code: -32602, message: 'unknown group' } };
      // `stuck`: the box answers but the motor never stops; `deaf`: it never moves.
      if (params.command === 'move' && params.value === 0 && box.stuck) return { result: {} };
      if (box.deaf && params.value !== 0) return { result: {} };
      if (params.command === 'move') {
        state.moving_up = params.value === -1 ? 1 : 0;
        state.moving_down = params.value === 1 ? 1 : 0;
      } else if (params.command === 'moveto') {
        state.value = params.value;
        state.moving_up = 0;
        state.moving_down = 0;
      }
      return { result: {} };
    }
    if (method === 'deviced.deviced_get_item_list') {
      return {
        result: { item_list: params.item_type === 'remote' ? box.remotes : box.groups },
      };
    }
    if (method === 'deviced.group_get_state') {
      const state = box.states.get(params.group_id);
      return state ? { result: { state: { ...state } } } : { error: { code: -32602 } };
    }
    if (method === 'deviced.item_get_state') {
      const state = box.sensors.get(params.item_id);
      return state ? { result: { state: { ...state } } } : { error: { code: -32602 } };
    }
    return { error: { code: -32601, message: 'method not found' } };
  };

  /** `box.echo`: undefined echoes the id; 'absent', null or 0 answer without it. */
  const echoed = (id, out) => {
    if (box.echo === undefined) return { jsonrpc: '2.0', id, ...out };
    if (box.echo === 'absent') return { jsonrpc: '2.0', ...out };
    return { jsonrpc: '2.0', id: box.echo, ...out };
  };

  box.post = (address, body, { timeout, signal, beforeSend, timers }) =>
    new Promise((resolve, reject) => {
      const json = JSON.parse(String(body).replace(/\u0000$/, ''));
      const { id, method, params } = json;
      let done = false;
      let sent = false;
      let answerTimer;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        if (sent) box.open -= 1;
        timers.clearTimeout(timeoutTimer);
        timers.clearTimeout(answerTimer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () =>
        finish(reject, new BeckerError('aborted', 'request cut', { sent, why: signal.reason }));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      const timeoutTimer = timers.setTimeout(
        () => finish(reject, new BeckerError('timeout', 'no answer in time', { sent })),
        timeout,
      );
      const how = box.mode?.(method, params, address.host, address.port);
      if (how === 'refuse') {
        answerTimer = timers.setTimeout(
          () =>
            finish(
              reject,
              new BeckerError('network', 'network error ECONNREFUSED', { sent: false }),
            ),
          1,
        );
        return;
      }
      // "Connected" on the next turn: the app's last check runs then.
      queueMicrotask(() => {
        if (done) return;
        try {
          beforeSend?.();
        } catch (err) {
          finish(
            reject,
            err instanceof BeckerError ? err : new BeckerError('notSent', err.message),
          );
          return;
        }
        sent = true;
        box.open += 1;
        box.peak = Math.max(box.peak, box.open);
        box.log.push({ method, params, at: clock.elapsed, host: address.host, port: address.port });
        if (how === 'drop') return;
        // The box acts (and a read sees its state) when the request arrives.
        const outcome = apply(method, params);
        const ms =
          how && typeof how === 'object' && 'latency' in how
            ? how.latency
            : typeof box.latency === 'function'
              ? box.latency(method, params)
              : box.latency;
        const answer = () => {
          if (how === 'rpcError') {
            return {
              status: 200,
              body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000 } }),
            };
          }
          if (how && typeof how === 'object' && 'status' in how) {
            return { status: how.status, headers: how.headers ?? {}, body: how.body ?? '' };
          }
          const out = outcome;
          return {
            status: 200,
            headers: {},
            body: `${JSON.stringify(echoed(id, out))}\u0000`,
          };
        };
        const reply = () => finish(resolve, answer());
        if (how && typeof how.then === 'function') {
          how.then(reply);
        } else {
          answerTimer = timers.setTimeout(reply, ms);
        }
      });
    });

  return box;
}
