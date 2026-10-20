// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from the real
// statistics of HAProxy 3.2 (test/fixtures/haproxy: every server up, one
// down, backends without server, a server without health check, one in
// maintenance), through the three sources, in every feature-name language,
// with the server devices.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../src/app.js';
import { Store } from '../src/store.js';

process.env.LOG_LEVEL ??= 'silent';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

const FIXTURES = ['v3.2-healthy.csv', 'v3.2-one-server-down.csv', 'v3.2-backend-down.csv'];
const bodies = await Promise.all(
  FIXTURES.map((name) => readFile(new URL(`./fixtures/haproxy/${name}`, import.meta.url), 'utf8')),
);
const dataplane = await readFile(
  new URL('./fixtures/haproxy/v3.2-healthy-dataplane-v3.json', import.meta.url),
  'utf8',
);

async function discover({ language, body, source = 'stats_page' }) {
  const url = {
    stats_page: 'http://192.0.2.10:8404/stats',
    dataplane: 'http://192.0.2.10:5555',
    socket: '192.0.2.10:9999',
  }[source];
  const gladys = createFakeGladys({
    config: { source, url, language, server_devices: true },
  });
  const app = registerHandlers(gladys, {
    store: new Store(mkdtempSync(join(tmpdir(), 'gladys-haproxy-rules-'))),
    timers: false,
    request: async () => ({ status: 200, body }),
    socket: async () => body,
  });
  await gladys.connect();
  await app.ready;
  await app.stop();
  return gladys.fake.discoveredDevices;
}

const scenarios = [
  { label: 'every server up, English names', language: 'en', body: bodies[0] },
  { label: 'one server down, French names', language: 'fr', body: bodies[1] },
  { label: 'backends down, German names', language: 'de', body: bodies[2] },
  { label: 'Data Plane API, Spanish names', language: 'es', body: dataplane, source: 'dataplane' },
  { label: 'runtime API, French names', language: 'fr', body: bodies[0], source: 'socket' },
];

for (const scenario of scenarios) {
  test(`every discovered device follows the Gladys rules (${scenario.label})`, async () => {
    const devices = await discover(scenario);
    assert.deepEqual(
      devices.map((device) => device.name),
      [
        'HAProxy',
        'app',
        'api',
        'legacy',
        'app/app1',
        'app/app2',
        'api/api1',
        'api/api2',
        'legacy/old',
      ],
      'HAProxy, the backends with servers and their servers',
    );
    assert.equal(
      new Set(devices.map((device) => device.external_id)).size,
      devices.length,
      'unique device external ids',
    );

    for (const device of devices) {
      const where = device.name;

      // should_poll: true if and only if poll_frequency is provided, in ms.
      if (device.poll_frequency === undefined) {
        assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
      } else {
        assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
        assert.ok(
          table.poll_frequencies_ms.includes(device.poll_frequency),
          `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
        );
      }

      assert.ok(device.features.length > 0, `${where}: no feature`);
      const externalIds = new Set();
      const names = new Set();
      for (const feature of device.features) {
        const at = `${where} / ${feature.name}`;
        const pair = table.pairs[`${feature.category}/${feature.type}`];
        assert.ok(pair, `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`);
        assert.ok(
          pair.label_en && pair.label_fr && pair.icon,
          `${at}: couple without label or icon`,
        );

        assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
        assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
        assert.ok(
          Number.isFinite(feature.min) && Number.isFinite(feature.max),
          `${at}: finite min/max`,
        );
        assert.ok(feature.min <= feature.max, `${at}: min > max`);
        assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
        assert.equal(
          typeof feature.has_feedback,
          'boolean',
          `${at}: has_feedback must be a boolean`,
        );
        if (feature.unit !== undefined) {
          assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
        }

        assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
        externalIds.add(feature.external_id);
        assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
        names.add(feature.name);
      }
    }
  });
}
