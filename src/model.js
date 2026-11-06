// -----------------------------------------------------------------------------
// The items of the CentralControl -> Gladys devices, and the states read
// (pure).
//
// One Gladys device per cover group (`deviced_get_item_list`, item_type
// "group", a `device_type` of COVER_TYPES), a `shutter` (never a switch nor a
// binary: a "turn everything off" never reaches it):
//   state     shutter/state     open, close, stop (write only)
//   position  shutter/position  0 closed .. 100 open, only when the group has
//                               feedback (B-Tronic, CentronicPLUS): read and
//                               written
// One Gladys device per sensor (item_type "remote", a `remote_type` of
// SENSOR_TYPES), read only: sun 0-15, wind 0-11, dawn 0-15 (levels of the
// sensor, no unit), rain (0 dry, 1 rain), temperature in °C.
//
// Identity rule (frozen: it fixes the external ids): the item id the box
// gives (an integer):
//   device   ext:<selector>:group:<id>   ext:<selector>:remote:<id>
//   feature  <device>:<key>
// The API gives no serial number nor MAC address of the box: a group is
// checked against the type it had when the device was created (device param
// BECKER_TYPE) at every list read; another type at that id is another cover.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  COVER_STATE,
  COVER_TYPES,
  FEATURES,
  LIMITS,
  MOVE,
  REVERSED_TYPES,
  SENSOR_BOUNDS,
  SENSOR_TYPES,
} from './constants.js';
import { label } from './i18n.js';

const KINDS = new Set(['group', 'remote']);
const SENSOR_KEYS = new Set(Object.keys(SENSOR_BOUNDS));
const COVER_KEYS = new Set(Object.values(FEATURES));
export const PARAMS = { ID: 'BECKER_ID', TYPE: 'BECKER_TYPE', FEEDBACK: 'BECKER_FEEDBACK' };

/** An item id of the box: an integer 1 .. 2^31-1 (a number or its decimal text). */
export function itemId(value) {
  if (typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value)) {
    value = Number(value);
  }
  return Number.isSafeInteger(value) && value >= 1 && value <= LIMITS.itemId ? value : undefined;
}

/** A name read from the box: no control character, trimmed, bounded. */
export function cleanText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.name);
}

/**
 * The covers of a list answer (`result.item_list`), bounded; undefined when
 * the answer is not a list.
 * @returns {{ id: number, name: string, type: string, feedback: boolean }[] | undefined}
 */
export function parseGroups(result) {
  const list = result?.item_list;
  if (!Array.isArray(list)) {
    return undefined;
  }
  const seen = new Map();
  for (const item of list.slice(0, LIMITS.items * 2)) {
    const id = itemId(item?.id);
    const type = typeof item?.device_type === 'string' ? item.device_type : '';
    if (id === undefined || !COVER_TYPES.has(type) || seen.has(id) || seen.size >= LIMITS.items) {
      continue;
    }
    seen.set(id, { id, name: cleanText(item.name), type, feedback: item.feedback === true });
  }
  return [...seen.values()];
}

/** The ids the box lists as groups that are not covers (doors, lights, heaters...). */
export function parseOtherGroupIds(result) {
  const ids = new Set();
  const list = Array.isArray(result?.item_list) ? result.item_list : [];
  for (const item of list.slice(0, LIMITS.items * 2)) {
    const id = itemId(item?.id);
    if (
      id !== undefined &&
      typeof item?.device_type === 'string' &&
      !COVER_TYPES.has(item.device_type)
    ) {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * The sensors of a list answer (item_type "remote"), bounded; undefined when
 * the answer is not a list.
 * @returns {{ id: number, name: string, type: string, values: string[] }[] | undefined}
 */
export function parseRemotes(result) {
  const list = result?.item_list;
  if (!Array.isArray(list)) {
    return undefined;
  }
  const seen = new Map();
  for (const item of list.slice(0, LIMITS.items * 2)) {
    const id = itemId(item?.id);
    const type = typeof item?.remote_type === 'string' ? item.remote_type : '';
    if (
      id === undefined ||
      !Object.hasOwn(SENSOR_TYPES, type) ||
      seen.has(id) ||
      seen.size >= LIMITS.items
    ) {
      continue;
    }
    seen.set(id, { id, name: cleanText(item.name), type, values: SENSOR_TYPES[type] });
  }
  return [...seen.values()];
}

const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 1000 ? value : undefined;

/**
 * The state of a group (`group_get_state` result): its value (0 open .. 100
 * closed in Becker terms) and how many motors move up and down. Anything out
 * of bounds is unknown, never 0.
 * @returns {{ value?: number, up?: number, down?: number }}
 */
export function parseGroupState(result) {
  const state = result?.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return {};
  }
  const out = {};
  if (typeof state.value === 'number' && Number.isFinite(state.value)) {
    if (state.value >= 0 && state.value <= 100) {
      out.value = state.value;
    }
  }
  const up = count(state.moving_up);
  const down = count(state.moving_down);
  if (up !== undefined) out.up = up;
  if (down !== undefined) out.down = down;
  return out;
}

/** Whether a group state says it moves: true, false, or undefined (not said). */
export function movingOf(state) {
  if (state.up === undefined || state.down === undefined) {
    if ((state.up ?? 0) > 0 || (state.down ?? 0) > 0) {
      return true;
    }
    return undefined;
  }
  return state.up > 0 || state.down > 0;
}

/** The direction a group state moves, in Becker terms: 'up', 'down', or undefined. */
export function directionOf(state) {
  const up = (state.up ?? 0) > 0;
  const down = (state.down ?? 0) > 0;
  if (up === down) {
    return undefined;
  }
  return up ? 'up' : 'down';
}

/**
 * The values of a sensor (`item_get_state` result, `value-<key>`), only those
 * of its type and within their bounds (a text, null, '' are never 0).
 * @returns {Record<string, number>}
 */
export function parseRemoteState(result, keys) {
  const state = result?.state;
  const out = {};
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return out;
  }
  for (const key of keys) {
    const raw = state[`value-${key}`];
    const bounds = SENSOR_BOUNDS[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !bounds) {
      continue;
    }
    if (raw < bounds.min || raw > bounds.max || (bounds.integer && !Number.isInteger(raw))) {
      continue;
    }
    out[key] = bounds.integer ? raw : Math.round(raw * 10) / 10;
  }
  return out;
}

export const isReversed = (type) => REVERSED_TYPES.has(type);

/** Becker value (0 open .. 100 closed) -> Gladys position (0 closed .. 100 open). */
export const positionOf = (type, value) => Math.round(isReversed(type) ? value : 100 - value);

/** Gladys position -> Becker `moveto` value. */
export const movetoOf = (type, position) => (isReversed(type) ? position : 100 - position);

/** The Becker `move` value of a Gladys command. */
export function moveOf(type, command) {
  if (command === 'stop') {
    return MOVE.STOP;
  }
  const close = command === 'close';
  if (isReversed(type)) {
    return close ? MOVE.UP : MOVE.DOWN;
  }
  return close ? MOVE.DOWN : MOVE.UP;
}

/** The Gladys command of a shutter `state` value, or undefined. */
export function commandOf(value) {
  if (value === COVER_STATE.STOP) return 'stop';
  if (value === COVER_STATE.OPEN) return 'open';
  if (value === COVER_STATE.CLOSE) return 'close';
  return undefined;
}

export const groupIds = (gladys, id) => gladys.externalIds('group', String(id));
export const remoteIds = (gladys, id) => gladys.externalIds('remote', String(id));

/**
 * `{ kind: 'group'|'remote', id, key }` of an external id of this integration
 * (key undefined for a device), or undefined. The prefix is matched exactly
 * and the id checked like the box's: never a wildcard.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 200) {
    return undefined;
  }
  const prefix = gladys.externalId('');
  if (!externalId.startsWith(prefix)) {
    return undefined;
  }
  const [kind, idText, key, ...rest] = externalId.slice(prefix.length).split(':');
  const id = /^[1-9]\d{0,9}$/.test(idText ?? '') ? itemId(idText) : undefined;
  if (!KINDS.has(kind) || id === undefined || rest.length > 0) {
    return undefined;
  }
  if (key !== undefined && !(kind === 'group' ? COVER_KEYS : SENSOR_KEYS).has(key)) {
    return undefined;
  }
  return { kind, id, key };
}

/** A param of a Gladys device. */
export const paramOf = (device, name) =>
  (device?.params ?? []).find((p) => p?.name === name)?.value;

const coverName = (group, language) =>
  group.name || `${language === 'en' ? 'Cover' : 'Volet'} ${group.id}`;
const sensorName = (remote, language) =>
  remote.name || `${language === 'en' ? 'Sensor' : 'Capteur'} ${remote.id}`;

/** The Gladys device of a cover group. */
export function buildCover(gladys, group, { language = 'fr' } = {}) {
  const ids = groupIds(gladys, group.id);
  const features = [
    {
      name: label(FEATURES.STATE, language),
      external_id: ids.feature(FEATURES.STATE),
      category: C.SHUTTER,
      type: T.SHUTTER.STATE,
      min: COVER_STATE.CLOSE,
      max: COVER_STATE.OPEN,
      read_only: false,
      has_feedback: false,
      keep_history: false,
    },
  ];
  if (group.feedback) {
    features.push({
      name: label(FEATURES.POSITION, language),
      external_id: ids.feature(FEATURES.POSITION),
      category: C.SHUTTER,
      type: T.SHUTTER.POSITION,
      unit: U.PERCENT,
      min: 0,
      max: 100,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    });
  }
  return {
    name: coverName(group, language),
    external_id: ids.device,
    should_poll: false,
    params: [
      { name: PARAMS.ID, value: String(group.id) },
      { name: PARAMS.TYPE, value: group.type },
      { name: PARAMS.FEEDBACK, value: group.feedback ? '1' : '0' },
    ],
    features,
  };
}

const SENSOR_FEATURES = {
  sun: { category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 15 },
  wind: { category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 11 },
  dawn: { category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 15 },
  rain: { category: C.RAIN_SENSOR, type: T.SENSOR.BINARY, min: 0, max: 1 },
  temp: {
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: -40,
    max: 80,
  },
};

/** The Gladys device of a sensor (read only). */
export function buildSensor(gladys, remote, { language = 'fr' } = {}) {
  const ids = remoteIds(gladys, remote.id);
  return {
    name: sensorName(remote, language),
    external_id: ids.device,
    should_poll: false,
    params: [
      { name: PARAMS.ID, value: String(remote.id) },
      { name: PARAMS.TYPE, value: remote.type },
    ],
    features: remote.values.map((key) => ({
      name: label(key, language),
      external_id: ids.feature(key),
      ...SENSOR_FEATURES[key],
      read_only: true,
      has_feedback: false,
      keep_history: true,
    })),
  };
}

/** A position typed in Gladys: an integer 0..100 (null, '', a decimal, a boolean are refused). */
export function positionValue(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : undefined;
}
