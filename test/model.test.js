// -----------------------------------------------------------------------------
// Pure parts: the configuration, the items and states of the box, the ids.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULT_CONFIG, addressOf, normalizeConfig, parseHost } from '../src/config.js';
import {
  buildCover,
  cleanText,
  directionOf,
  itemId,
  moveOf,
  movetoOf,
  movingOf,
  parseExternalId,
  parseGroupState,
  parseGroups,
  parseRemoteState,
  positionOf,
  positionValue,
} from '../src/model.js';

test('the address: IP or host name, port 80 by default, never shown back when invalid', () => {
  assert.deepEqual(parseHost('192.168.1.70'), { address: { host: '192.168.1.70', port: 80 } });
  assert.deepEqual(parseHost(' http://192.168.1.70/cgi-bin/cc51rpc.cgi '), {
    address: { host: '192.168.1.70', port: 80 },
  });
  assert.deepEqual(parseHost('cc51.lan:8080'), { address: { host: 'cc51.lan', port: 8080 } });
  assert.equal(parseHost('cc51.local').local, true);
  assert.equal(parseHost('admin:pw@1.2.3.4').credentials, true);
  for (const bad of ['0.0.0.0', '255.255.255.255', '224.0.0.251', '239.1.1.1']) {
    assert.equal(parseHost(bad).unusable, true, bad);
  }
  for (const bad of ['1.2.3', '1.2.3.4:0', '1.2.3.4:70000', 'a b', 'x\r\nHost: evil', 'ftp://x']) {
    assert.equal(parseHost(bad).address, undefined, bad);
  }
  assert.equal(addressOf('192.168.1.70:8080').port, 8080);
  assert.equal(addressOf('192.168.1.70:80'), undefined, 'only the key form');
});

test('the configuration: defaults, bounds, a missing address is an error', () => {
  const empty = normalizeConfig();
  assert.equal(empty.error, 'missing');
  assert.equal(empty.pollInterval, DEFAULT_CONFIG.poll_interval);
  const c = normalizeConfig({ box_address: '10.0.0.5', poll_interval: '5', language: 'en' });
  assert.equal(c.error, undefined);
  assert.equal(c.key, '10.0.0.5');
  assert.equal(c.pollInterval, 30);
  assert.equal(normalizeConfig({ box_address: '10.0.0.5', poll_interval: '' }).pollInterval, 60);
  assert.equal(
    normalizeConfig({ box_address: '10.0.0.5', poll_interval: 99999 }).pollInterval,
    3600,
  );
  assert.equal(normalizeConfig({ box_address: '10.0.0.5', language: 'de' }).language, 'fr');
});

test('groups: only covers, ids checked, names cleaned, bounded', () => {
  const groups = parseGroups({
    item_list: [
      { id: 1, name: 'Salon\u0000\n  sud', device_type: 'shutter', feedback: true },
      { id: '2', name: 'x', device_type: 'awning', feedback: 'yes' },
      { id: 3, device_type: 'door' },
      { id: 0, device_type: 'shutter' },
      { id: 1.5, device_type: 'shutter' },
      { id: 1, name: 'dup', device_type: 'shutter' },
      { id: '__proto__', device_type: 'shutter' },
      null,
    ],
  });
  assert.deepEqual(groups, [
    { id: 1, name: 'Salon sud', type: 'shutter', feedback: true },
    { id: 2, name: 'x', type: 'awning', feedback: false },
  ]);
  assert.equal(parseGroups({}), undefined);
  const many = parseGroups({
    item_list: Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, device_type: 'shutter' })),
  });
  assert.equal(many.length, 200);
  assert.equal(cleanText('a'.repeat(100)).length, 60);
  assert.equal(itemId('0012'), undefined);
});

test('states: out of range is unknown, never 0; moving and direction', () => {
  assert.deepEqual(parseGroupState({ state: { value: 101, moving_up: 0, moving_down: 0 } }), {
    up: 0,
    down: 0,
  });
  assert.deepEqual(parseGroupState({ state: { value: '50' } }), {});
  assert.deepEqual(parseGroupState({ state: [] }), {});
  assert.equal(movingOf({ up: 0, down: 0 }), false);
  assert.equal(movingOf({ up: 0, down: 1 }), true);
  assert.equal(movingOf({}), undefined);
  assert.equal(movingOf({ up: 1 }), true);
  assert.equal(directionOf({ up: 1, down: 0 }), 'up');
  assert.equal(directionOf({ up: 0, down: 2 }), 'down');
  assert.equal(directionOf({ up: 1, down: 1 }), undefined);
  assert.deepEqual(
    parseRemoteState(
      { state: { 'value-wind': 11, 'value-sun': 15.5, 'value-rain': '1', 'value-temp': -3.04 } },
      ['wind', 'sun', 'rain', 'temp'],
    ),
    { wind: 11, temp: -3 },
  );
});

test('directions and positions: the awning is reversed, nothing else', () => {
  assert.equal(moveOf('shutter', 'close'), 1);
  assert.equal(moveOf('shutter', 'open'), -1);
  assert.equal(moveOf('awning', 'close'), -1);
  assert.equal(moveOf('awning', 'open'), 1);
  assert.equal(moveOf('venetian', 'stop'), 0);
  assert.equal(positionOf('shutter', 0), 100);
  assert.equal(positionOf('awning', 0), 0);
  assert.equal(movetoOf('shutter', 30), 70);
  assert.equal(movetoOf('awning', 30), 30);
  assert.equal(positionValue(50), 50);
  for (const bad of [50.5, -1, 101, '50', null, true, NaN])
    assert.equal(positionValue(bad), undefined);
});

test('external ids: exact prefix, integer ids, known keys only', () => {
  const gladys = createFakeGladys({ selector: 'becker' });
  assert.deepEqual(parseExternalId(gladys, 'ext:becker:group:12:position'), {
    kind: 'group',
    id: 12,
    key: 'position',
  });
  assert.deepEqual(parseExternalId(gladys, 'ext:becker:remote:20'), {
    kind: 'remote',
    id: 20,
    key: undefined,
  });
  for (const bad of [
    'ext:becker:group:*:state',
    'ext:becker:group:012:state',
    'ext:becker:group:1:wind',
    'ext:becker:remote:1:state',
    'ext:beckerx:group:1:state',
    'ext:becker:group:1:state:x',
    'ext:becker:scene:1',
  ]) {
    assert.equal(parseExternalId(gladys, bad), undefined, bad);
  }
  const device = buildCover(gladys, { id: 7, name: '', type: 'screen', feedback: false });
  assert.equal(device.name, 'Volet 7');
  assert.deepEqual(
    device.params.map((p) => p.value),
    ['7', 'screen', '0'],
  );
});
