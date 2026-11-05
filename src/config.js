// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. There is no
// secret: the CentralControl API has no authentication on the local network.
// -----------------------------------------------------------------------------

import { BOX, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  box_address: '',
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** An IPv4 address that can never be one box: any, broadcast, multicast. */
function unusableIpv4(host) {
  const [a, b, c, d] = host.split('.').map(Number);
  if (a === 0 || a >= 224) {
    return true; // 0.0.0.0/8, multicast, reserved, 255.255.255.255
  }
  return d === 255 && a === 255 && b === 255 && c === 255;
}

/**
 * The address typed by the user: an IPv4 address or a host name, with an
 * optional port (80 by default). A pasted URL is reduced to its host (the path
 * of the API is fixed). Credentials in it are refused and never shown; names
 * in .local are refused (mDNS does not resolve in the container). An invalid
 * entry is never shown back: only its length.
 * @returns {{ address?: { host: string, port: number }, invalid?: number, credentials?: boolean, local?: boolean, unusable?: boolean }}
 */
export function parseHost(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return {};
  }
  if (text.includes('@')) {
    return { credentials: true };
  }
  if (text.length > 260 || /[\u0000-\u001f\u007f\s]/.test(text)) {
    return { invalid: Math.min(text.length, 999) };
  }
  const length = text.length;
  text = text.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(text.toLowerCase());
  if (!match) {
    return { invalid: length };
  }
  const [, host, portText] = match;
  const port = portText === undefined ? BOX.port : Number(portText);
  if (port < 1 || port > 65535 || host.length > 253) {
    return { invalid: length };
  }
  if (/\.local\.?$/.test(host)) {
    return { local: true, invalid: length };
  }
  if (IPV4.test(host)) {
    return unusableIpv4(host) ? { unusable: true, invalid: length } : { address: { host, port } };
  }
  const valid = !/^[\d.]+$/.test(host) && host.split('.').every((l) => LABEL.test(l));
  return valid ? { address: { host, port } } : { invalid: length };
}

/** `host` or `host:port` (port 80 left out): the key of a box. */
export const addressKey = (address) =>
  address ? (address.port === BOX.port ? address.host : `${address.host}:${address.port}`) : '';

/** The address of a key written by addressKey (from /data), or undefined. */
export function addressOf(key) {
  if (typeof key !== 'string' || key.length > 260) {
    return undefined;
  }
  const parsed = parseHost(key);
  return parsed.address && addressKey(parsed.address) === key ? parsed.address : undefined;
}

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,6}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

const bounded = (value, { default: fallback, min, max }) => {
  const number = numberOf(value);
  return number === undefined ? fallback : Math.min(max, Math.max(min, Math.round(number)));
};

/**
 * @returns {{ address?: { host: string, port: number }, key: string,
 *   error?: 'missing'|'invalid'|'credentials'|'local'|'unusable', length?: number,
 *   pollInterval: number, language: 'fr'|'en' }}
 */
export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value != null) {
      c[key] = value;
    }
  }
  const parsed = parseHost(typeof c.box_address === 'string' ? c.box_address : '');
  let error;
  if (parsed.credentials) {
    error = 'credentials';
  } else if (parsed.local) {
    error = 'local';
  } else if (parsed.unusable) {
    error = 'unusable';
  } else if (parsed.invalid !== undefined) {
    error = 'invalid';
  } else if (!parsed.address) {
    error = 'missing';
  }
  return {
    address: parsed.address,
    key: addressKey(parsed.address),
    error,
    length: parsed.invalid,
    pollInterval: bounded(c.poll_interval, POLL_INTERVAL),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** Whether two configurations are the same (a change starts over). */
export const sameConfig = (a, b) =>
  a.key === b.key &&
  a.error === b.error &&
  a.pollInterval === b.pollInterval &&
  a.language === b.language;
