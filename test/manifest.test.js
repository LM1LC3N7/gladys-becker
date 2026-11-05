// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. The version is
// never pinned (the Release workflow bumps it): only its shape and that the
// four places agree.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ACTIONS, LANGUAGES, POLL_INTERVAL, SENSOR_TYPES } from '../src/constants.js';
import { buildCover, buildSensor } from '../src/model.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');
const REPO = 'gladys-becker';
const CATEGORIES = new Set([
  'climate',
  'lighting',
  'energy',
  'security',
  'multimedia',
  'appliances',
  'environment',
  'protocols',
  'network',
  'notifications',
  'assistants',
  'services',
  'transport',
  'vehicles',
  'servers',
  'leisure',
]);

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

/** Every device the integration can publish. */
function allDevices() {
  const gladys = createFakeGladys({ selector: 'becker' });
  const devices = [];
  for (const type of ['shutter', 'venetian', 'screen', 'awning', 'sun-sail']) {
    for (const feedback of [true, false]) {
      devices.push(buildCover(gladys, { id: 1, name: 'A', type, feedback }));
    }
  }
  for (const [type, values] of Object.entries(SENSOR_TYPES)) {
    devices.push(buildSensor(gladys, { id: 2, name: 'B', type, values }));
  }
  return devices;
}

test('the store basics, and one version in the four places', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/${REPO}:${manifest.version}`);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, REPO);
  assert.equal(manifest.version, pkg.version);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(
    manifest.cover_image,
    `https://raw.githubusercontent.com/LM1LC3N7/${REPO}/main/cover.png`,
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.ok(manifest.categories.every((c) => CATEGORIES.has(c)));
  // keywords and countries need Gladys 5.3.0: not yet (see TODO.md).
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`)
      .replace(/\*\*/g, '')
      .replace(/\s*\n>?\s*/g, ' ');
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+Becker|sans\s+lien\s+avec\s+Becker/);
    assert.match(
      docs,
      /never\s+been\s+tested\s+with\s+a\s+real\s+(box|device)|jamais\s+été\s+testée\s+avec\s+une?\s+vraie?\s+(box|appareil)/,
    );
  }
  assert.match(
    read('README.md').replace(/\*\*/g, '').replace(/\s+/g, ' '),
    /never been tested with a real box/,
  );
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
});

test('the MIT notice of becker_centralcontrol_has ships with the code; no name in the LICENSE', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /DominikStarke\/becker_centralcontrol_has/);
  assert.match(notices, /Copyright \(c\) 2024 Becker-Antriebe GmbH/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY .*LICENSE/);
  assert.match(dockerfile, /COPY .*THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(license, /Louis|Milcent|LM1LC3N7|Starke|Becker|Gladys/i);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
});

test('the configuration matches the code; no secret, no gladys_ key', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    if (fields[key].default !== undefined || value !== '') {
      assert.deepEqual(fields[key].default, value, key);
    }
  }
  for (const field of manifest.config_schema.filter((f) => f.type !== 'section')) {
    assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
    assert.doesNotMatch(field.key, /^gladys_/i, 'the core keeps the GLADYS_* keys');
  }
  for (const field of manifest.config_schema.filter((f) => f.type === 'secret')) {
    assert.equal(field.default, undefined, `${field.key}: never a default on a secret`);
  }
  assert.equal(fields.box_address.required, true);
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  assert.deepEqual(
    [fields.poll_interval.min, fields.poll_interval.max],
    [POLL_INTERVAL.min, POLL_INTERVAL.max],
  );
  const intro = fields.intro;
  assert.equal(intro.type, 'section');
  for (const lang of ['en', 'fr']) {
    assert.ok(intro.description[lang].length <= 1000, `intro.${lang} over 1000 characters`);
  }
  assert.ok(intro.links.every((l) => l.url.startsWith('https://')));
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  assert.ok(handlers.includes('onSetValue'), 'the commands go through onSetValue');
  for (const item of manifest.actions) {
    assert.ok(item.timeout_seconds >= 5 && item.timeout_seconds <= 120, item.key);
  }
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
});

test('devices: covers never a switch nor a binary; sensors read only', () => {
  for (const device of allDevices()) {
    for (const feature of device.features) {
      assert.notEqual(feature.category, 'switch');
      if (feature.category === 'shutter') {
        assert.notEqual(feature.type, 'binary');
        assert.equal(feature.read_only, false);
      } else {
        assert.equal(feature.read_only, true);
      }
    }
  }
});

test('the rules of the core on supported_options hold for every published feature', () => {
  // normalizeSupportedOptions of the core: one invalid entry rejects the
  // whole Discovery. None is published today; the rule is kept anyway.
  for (const device of allDevices()) {
    for (const feature of device.features) {
      const options = feature.supported_options;
      if (options === undefined) continue;
      assert.ok(Array.isArray(options));
      const values = new Set();
      for (const option of options) {
        assert.deepEqual(Object.keys(option).sort(), ['label', 'value']);
        assert.equal(typeof option.label, 'string');
        assert.ok(option.label.length > 0 && option.label === option.label.trim());
        assert.ok(Number.isInteger(option.value) || typeof option.value === 'string');
        assert.ok(!values.has(option.value), 'unique values');
        values.add(option.value);
      }
    }
  }
});

test('the units are those of the core for their category', () => {
  const allowed = {
    'temperature-sensor': ['celsius', 'fahrenheit', 'kelvin'],
    shutter: ['percent'],
  };
  for (const device of allDevices()) {
    for (const feature of device.features) {
      if (feature.unit === undefined) continue;
      assert.ok(
        allowed[feature.category]?.includes(feature.unit),
        `${feature.category}/${feature.unit}`,
      );
    }
  }
});

test('no Bluetooth, no cloud, no relay headers, no imitation of an app', () => {
  // The code without its comments (they say what is NOT sent).
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = ['src/app.js', 'src/rpc.js', 'src/config.js', 'src/constants.js', 'src/model.js']
    .map((f) => strip(read(f)))
    .join('\n');
  assert.doesNotMatch(code, /bluetooth|https?:\/\/[a-z]|['"]user-agent['"]|['"]origin['"]|cookie/i);
  assert.doesNotMatch(strip(read('src/rpc.js')), /b-tronic|Host:/);
  assert.doesNotMatch(read('package.json'), /bluetooth|noble/i);
});
