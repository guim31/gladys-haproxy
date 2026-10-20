// -----------------------------------------------------------------------------
// The hub against the SDK's fake Gladys and a fake HAProxy: discovery, states,
// transitions and scene events, persistence across restarts, errors, quiet
// logs, the widget, the scene actions and the reading timer of the container.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { BACKEND_KEYS, PROXY_KEYS, SERVER_KEYS, proxyIds } from '../src/devices.js';
import { TRIGGERS, WIDGET_KEY } from '../src/hub.js';
import {
  DATAPLANE_URL,
  FIXTURES,
  FakeHaproxy,
  SOCKET_URL,
  STATS_URL,
  createClock,
  createDevices,
  createWorld,
  idsOf,
} from './helpers/world.js';

const events = (world, key) => world.fake.sceneEvents.filter((event) => event.key === key);
const proxyState = (world, key) => world.fake.lastState(proxyIds(world.gladys).feature(key));
const backendState = (world, name, key) => world.fake.lastState(idsOf(world, name).feature(key));

test('HAProxy and one device per backend with servers in Discovery, nothing polled by Gladys', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const devices = world.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.name),
    ['HAProxy', 'app', 'api', 'legacy'],
  );
  for (const device of devices) {
    assert.equal(device.should_poll, false);
    assert.equal(device.poll_frequency, undefined);
  }
  assert.equal(world.fake.states.length, 0, 'nothing published for devices not added');
  assert.equal(world.fake.connectionStatus.connected, true);
  assert.equal(world.fake.sceneEvents.length, 0, 'the server in maintenance is not news');
});

test('the server devices, when asked, with the name of their backend', async (t) => {
  const world = await createWorld({
    config: { url: STATS_URL, language: 'en', server_devices: true },
  });
  t.after(() => world.app.stop());
  const servers = world.fake.discoveredDevices.slice(4);
  assert.deepEqual(
    servers.map((d) => d.name),
    ['app/app1', 'app/app2', 'api/api1', 'api/api2', 'legacy/old'],
  );
  assert.deepEqual(servers[0].params, [{ name: 'BACKEND', value: 'app' }]);
  await createDevices(world);
  const online = (backend, server) =>
    world.fake.lastState(idsOf(world, backend, server).feature(SERVER_KEYS.ONLINE));
  assert.deepEqual(
    [online('app', 'app1'), online('api', 'api1'), online('legacy', 'old')],
    [1, 0, 1],
  );
  world.haproxy.setServer('app', 'app1', 'DOWN');
  await world.hub.pollNow();
  assert.equal(online('app', 'app1'), 0);
});

test('the states of the added devices at once, then only the changes', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  assert.equal(proxyState(world, PROXY_KEYS.REACHABLE), 1);
  assert.equal(proxyState(world, PROXY_KEYS.FRONTENDS_OPEN), 3);
  assert.equal(proxyState(world, PROXY_KEYS.BACKENDS_DOWN), 0);
  assert.equal(proxyState(world, PROXY_KEYS.SERVERS_UP), 4);
  assert.equal(proxyState(world, PROXY_KEYS.SERVERS_TOTAL), 5);
  assert.equal(proxyState(world, PROXY_KEYS.SESSIONS), 3);
  assert.equal(backendState(world, 'app', BACKEND_KEYS.AVAILABLE), 1);
  assert.equal(backendState(world, 'api', BACKEND_KEYS.SERVERS_UP), 1, 'api1 in maintenance');
  assert.equal(backendState(world, 'api', BACKEND_KEYS.SERVERS_TOTAL), 2);
  assert.equal(
    backendState(world, 'app', BACKEND_KEYS.ERRORS_5XX),
    undefined,
    'no share before two reads',
  );
  assert.deepEqual([...new Set(world.fake.transports.map((e) => e.transport))], ['local']);

  await world.hub.pollNow();
  assert.equal(backendState(world, 'app', BACKEND_KEYS.ERRORS_5XX), 0);
  const before = world.fake.states.length;
  await world.hub.pollNow();
  assert.equal(world.fake.states.length, before, 'nothing changed, nothing sent');

  world.haproxy.setServer('app', 'app2', 'DOWN');
  await world.hub.pollNow();
  assert.equal(backendState(world, 'app', BACKEND_KEYS.SERVERS_UP), 1);
  assert.equal(backendState(world, 'app', BACKEND_KEYS.AVAILABLE), 1, 'degraded is available');
  assert.equal(proxyState(world, PROXY_KEYS.SERVERS_UP), 3);
  assert.equal(events(world, TRIGGERS.BACKEND_DOWN).length, 0);
});

test('the share of 5xx since the previous read; none after a reload of HAProxy', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  world.haproxy.answer('app', { ok: 30, errors: 10 });
  await world.hub.pollNow();
  assert.equal(backendState(world, 'app', BACKEND_KEYS.ERRORS_5XX), 25);
  await world.hub.pollNow();
  assert.equal(backendState(world, 'app', BACKEND_KEYS.ERRORS_5XX), 0, 'no answer since: 0 %');
  // A reload starts the counters again from zero: no share for that read.
  const before = world.fake.states.length;
  world.haproxy.load(FIXTURES.healthy);
  world.haproxy.row('app', 'BACKEND')[world.haproxy.col('hrsp_2xx')] = '1';
  await world.hub.pollNow();
  assert.ok(
    world.fake.states
      .slice(before)
      .every((s) => s.device_feature_external_id !== idsOf(world, 'app').feature('errors_5xx')),
  );
});

test('a server down, then back up: events with the outage length, filtered by backend', async (t) => {
  const clock = createClock();
  const world = await createWorld({ clock });
  t.after(() => world.app.stop());
  await createDevices(world);
  world.haproxy.setServer('app', 'app2', 'DOWN');
  await world.hub.pollNow();
  assert.deepEqual(events(world, TRIGGERS.SERVER_DOWN)[0].data, {
    backend: idsOf(world, 'app').device,
    backend_name: 'app',
    server: 'app2',
    status: 'DOWN',
    check: 'L4TOUT',
  });
  await world.hub.pollNow();
  assert.equal(events(world, TRIGGERS.SERVER_DOWN).length, 1, 'announced once');

  clock.advance(12 * 60_000);
  world.haproxy.setServer('app', 'app2', 'UP');
  await world.hub.pollNow();
  assert.deepEqual(events(world, TRIGGERS.SERVER_UP)[0].data, {
    backend: idsOf(world, 'app').device,
    backend_name: 'app',
    server: 'app2',
    downtime_minutes: 12,
  });
});

test('maintenance counts as out; a server "going down" (UP 1/3) does not yet', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.haproxy.setServer('app', 'app1', 'UP 1/3');
  await world.hub.pollNow();
  assert.equal(events(world, TRIGGERS.SERVER_DOWN).length, 0);
  world.haproxy.setServer('app', 'app1', 'MAINT', '');
  await world.hub.pollNow();
  assert.deepEqual(
    events(world, TRIGGERS.SERVER_DOWN).map((e) => [e.data.server, e.data.status, e.data.check]),
    [['app1', 'MAINT', '']],
  );
});

test('a backend without server left: once, with its servers; nothing for the healthy ones', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  world.haproxy.load(FIXTURES.backendDown);
  await world.hub.pollNow();
  assert.deepEqual(
    events(world, TRIGGERS.BACKEND_DOWN).map((e) => e.data),
    [
      { backend: idsOf(world, 'app').device, backend_name: 'app', servers_total: 2 },
      { backend: idsOf(world, 'api').device, backend_name: 'api', servers_total: 2 },
    ],
  );
  assert.deepEqual(
    events(world, TRIGGERS.SERVER_DOWN).map((e) => e.data.server),
    ['app1', 'app2', 'api2'],
  );
  assert.equal(backendState(world, 'app', BACKEND_KEYS.AVAILABLE), 0);
  assert.equal(proxyState(world, PROXY_KEYS.BACKENDS_DOWN), 2);
  await world.hub.pollNow();
  assert.equal(events(world, TRIGGERS.BACKEND_DOWN).length, 2, 'announced once');

  world.haproxy.load(FIXTURES.backUp);
  await world.hub.pollNow();
  assert.equal(events(world, TRIGGERS.SERVER_UP).length, 3);
  assert.equal(backendState(world, 'app', BACKEND_KEYS.AVAILABLE), 1);
});

test('a new backend or server after the first read: announced only when it starts out', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const app2 = world.haproxy.row('app', 'app2');
  world.haproxy.rows.push(
    Object.assign([...app2], { 1: 'app3' }),
    Object.assign([...app2], { 1: 'app4' }),
  );
  world.haproxy.setServer('app', 'app4', 'DOWN');
  await world.hub.pollNow();
  assert.deepEqual(
    events(world, TRIGGERS.SERVER_DOWN).map((e) => e.data.server),
    ['app4'],
  );
});

test('a backend gone from the configuration is forgotten, without event', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.haproxy.removeBackend('legacy');
  await world.hub.pollNow();
  assert.deepEqual(world.fake.sceneEvents, []);
  assert.equal(world.hub.saved.backends.legacy, undefined);
  assert.equal(world.hub.saved.servers['legacy/old'], undefined);
  assert.deepEqual(
    world.fake.discoveredDevices.map((d) => d.name),
    ['HAProxy', 'app', 'api'],
  );
});

test('HAProxy unreachable: one failed read is tolerated, the second fires once', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  world.haproxy.failure = 'down';
  await world.hub.pollNow();
  assert.equal(events(world, TRIGGERS.UNREACHABLE).length, 0);
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.equal(proxyState(world, PROXY_KEYS.REACHABLE), 1);
  await world.hub.pollNow();
  await world.hub.pollNow();
  assert.deepEqual(
    events(world, TRIGGERS.UNREACHABLE).map((e) => e.data),
    [{ error: 'HAProxy does not answer' }],
  );
  assert.equal(proxyState(world, PROXY_KEYS.REACHABLE), 0);
  assert.equal(world.fake.transports.at(-1).transport, 'unreachable');
  assert.equal(events(world, TRIGGERS.SERVER_DOWN).length, 0, 'no server event for that');

  world.haproxy.failure = null;
  await world.hub.pollNow();
  assert.equal(proxyState(world, PROXY_KEYS.REACHABLE), 1);
  assert.equal(world.fake.connectionStatus.connected, true);
  assert.equal(world.fake.transports.at(-1).transport, 'local');
});

test('a restart keeps the last states: a change during it is announced once', async (t) => {
  const first = await createWorld();
  await first.app.stop();
  const haproxy = new FakeHaproxy({ csv: FIXTURES.backendDown });
  const second = await createWorld({ haproxy, dataDir: first.dataDir });
  t.after(() => second.app.stop());
  assert.equal(events(second, TRIGGERS.BACKEND_DOWN).length, 2);
  assert.equal(events(second, TRIGGERS.SERVER_DOWN).length, 3);
  await second.hub.store.flush();
  const third = await createWorld({ haproxy, dataDir: first.dataDir });
  t.after(() => third.app.stop());
  assert.equal(third.fake.sceneEvents.length, 0, 'nothing new after a second restart');
});

test('another HAProxy, or another source, starts afresh', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.haproxy.setServer('app', 'app1', 'DOWN');
  await world.fake.configUpdated({ url: `${STATS_URL};csv`, language: 'en' });
  assert.equal(events(world, TRIGGERS.SERVER_DOWN).length, 1, 'same address: still known');
  await world.fake.configUpdated({ source: 'socket', url: SOCKET_URL, language: 'en' });
  assert.equal(world.fake.connectionStatus.connected, true);
  assert.equal(world.fake.sceneEvents.length, 1, 'the first read of a new source is not news');
  await world.fake.configUpdated({ url: 'http://198.51.100.7:8404/stats', language: 'en' });
  assert.equal(world.fake.connectionStatus.connected, false, 'nothing answers there');
  assert.deepEqual(world.fake.discoveredDevices, [], 'the devices of the old HAProxy are gone');
});

test('the Data Plane API as source, with its user', async (t) => {
  const haproxy = new FakeHaproxy({ auth: 'admin:pw' });
  const world = await createWorld({
    haproxy,
    config: { source: 'dataplane', url: DATAPLANE_URL, username: 'admin', password: 'pw' },
  });
  t.after(() => world.app.stop());
  assert.equal(world.fake.connectionStatus.connected, true);
  assert.equal(world.fake.discoveredDevices.length, 4);
  await world.fake.configUpdated({ source: 'dataplane', url: DATAPLANE_URL, username: 'admin' });
  assert.match(world.fake.connectionStatus.message.en, /refused/);
});

test('down from the first read after a restart: reachable 0 and the unreachable badge', async (t) => {
  const first = await createWorld();
  await createDevices(first);
  await first.app.stop();
  const haproxy = new FakeHaproxy();
  haproxy.failure = 'down';
  const second = await createWorld({
    haproxy,
    dataDir: first.dataDir,
    devices: first.fake.devices,
  });
  t.after(() => second.app.stop());
  await second.hub.pollNow();
  assert.equal(events(second, TRIGGERS.UNREACHABLE).length, 1);
  assert.equal(proxyState(second, PROXY_KEYS.REACHABLE), 0);
  assert.equal(second.fake.transports.at(-1).transport, 'unreachable');
});

test('configuration missing or wrong: a readable status, no request', async (t) => {
  const world = await createWorld({ config: { language: 'fr' } });
  t.after(() => world.app.stop());
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.fr, /Saisissez l'adresse/);
  assert.equal(world.haproxy.requests.length, 0);
  assert.deepEqual(world.fake.discoveredDevices, []);
  const widget = await world.fake.widgetGet(WIDGET_KEY, { settings: {}, language: 'de' });
  assert.match(widget.data.content.components[0].text, /Gib die Adresse/);
  const ack = await world.fake.sceneAction('get_proxy_status', {});
  assert.equal(ack.success, false);
  await world.fake.configUpdated({ source: 'socket', url: '192.0.2.10', language: 'fr' });
  assert.match(world.fake.connectionStatus.message.fr, /Adresse incomprise/);
});

async function captureLogs(t, level, fn) {
  const lines = [];
  const write = (chunk) => {
    lines.push(...String(chunk).split('\n').filter(Boolean));
    return true;
  };
  const before = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  const stdout = t.mock.method(process.stdout, 'write', write);
  const stderr = t.mock.method(process.stderr, 'write', write);
  try {
    await fn();
  } finally {
    stdout.mock.restore();
    stderr.mock.restore();
    process.env.LOG_LEVEL = before;
  }
  return lines;
}

test('a normal reading cycle writes nothing at the info level', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const sent = world.fake.states.length;
  const lines = await captureLogs(t, 'info', async () => {
    for (let cycle = 0; cycle < 6; cycle += 1) {
      // Traffic and a few 5xx: figures change, nothing to announce.
      world.haproxy.answer('app', { ok: 10 + cycle, errors: cycle % 2 });
      world.clock.advance(30_000);
      await world.hub.pollNow();
    }
  });
  assert.ok(world.fake.states.length > sent, 'states were published');
  assert.deepEqual(lines, []);
});

test('a lasting failure writes one line, not one per read, and no credentials', async (t) => {
  const world = await createWorld({
    config: { url: STATS_URL, username: 'gladys', password: 'pw' },
  });
  t.after(() => world.app.stop());
  world.haproxy.failure = 'down';
  const lines = await captureLogs(t, 'info', async () => {
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await world.hub.pollNow();
    }
  });
  assert.equal(lines.length, 2, lines.join('\n')); // the error, then "unreachable"
  assert.ok(!/Basic|pw|Authorization/.test(lines.join('\n')));
});

test('the widget: tiles, backends down first, servers out, within the budget', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.haproxy.load(FIXTURES.backendDown);
  await world.hub.pollNow();
  for (const language of ['en', 'fr', 'de', 'es']) {
    const ack = await world.fake.widgetGet(WIDGET_KEY, { settings: {}, language });
    assert.equal(ack.success, true, ack.error);
    validateWidgetContent(ack.data.content);
    assert.ok(ack.data.content.components.length <= 8);
  }
  const {
    data: { content: data },
  } = await world.fake.widgetGet(WIDGET_KEY, { settings: {}, language: 'fr' });
  assert.deepEqual(
    data.components.filter((c) => c.type === 'value').map((c) => [c.label, c.value]),
    [
      ['Backends KO', 2],
      ['Serveurs HS', 4],
      ['Backends OK', 1],
    ],
  );
  const [backends, servers] = data.components.filter((c) => c.type === 'status');
  assert.deepEqual(
    backends.items.map((i) => [i.label, i.value]),
    [
      ['api', 'En panne · 0/2'],
      ['app', 'En panne · 0/2'],
      ['legacy', 'OK · 1/1'],
    ],
  );
  assert.deepEqual(
    servers.items.map((i) => [i.label, i.value]),
    [
      ['api/api1', 'MAINT (resolution)'],
      ['api/api2', 'DOWN · L4TOUT'],
      ['app/app1', 'DOWN · L4TOUT'],
      ['app/app2', 'DOWN · L4TOUT'],
    ],
  );

  const ack = await world.fake.widgetAction(WIDGET_KEY, 'refresh', {});
  assert.equal(ack.success, true, ack.error);
});

test('the widget limited to chosen backends, and when HAProxy does not answer', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const chosen = { backends: [idsOf(world, 'legacy').device] };
  const {
    data: { content: data },
  } = await world.fake.widgetGet(WIDGET_KEY, { settings: chosen, language: 'en' });
  const backends = data.components.find((c) => c.type === 'status');
  assert.deepEqual(
    backends.items.map((i) => i.label),
    ['legacy'],
  );
  world.haproxy.failure = 'down';
  await world.hub.pollNow();
  const down = await world.fake.widgetGet(WIDGET_KEY, { settings: {}, language: 'en' });
  validateWidgetContent(down.data.content);
  assert.ok(down.data.content.components.some((c) => c.text === 'HAProxy does not answer'));
});

test('scene actions: a backend in a sentence, the whole HAProxy, unreachable as an answer', async (t) => {
  const clock = createClock();
  const world = await createWorld({ clock, config: { url: STATS_URL, language: 'fr' } });
  t.after(() => world.app.stop());
  await createDevices(world);
  world.haproxy.setServer('app', 'app2', 'DOWN');
  clock.advance(20_000);
  const backend = await world.fake.sceneAction('get_backend_status', {
    device: idsOf(world, 'app').device,
  });
  assert.deepEqual(backend.data.outputs, {
    available: true,
    state: 'Dégradé',
    servers_up: 1,
    servers_total: 2,
    sessions: 0,
    servers_out: 'app2 : DOWN',
    sentence: 'app : Dégradé, 1/2 serveur(s) en service (app2 : DOWN).',
  });
  const unknown = await world.fake.sceneAction('get_backend_status', { device: 'nope' });
  assert.equal(unknown.success, false);

  world.haproxy.setServer('app', 'app1', 'DOWN');
  clock.advance(20_000);
  const proxy = await world.fake.sceneAction('get_proxy_status', {});
  assert.deepEqual(proxy.data.outputs, {
    reachable: true,
    backends_down: 1,
    names: 'app',
    servers_up: 2,
    servers_total: 5,
    sentence: 'HAProxy : 1 backend(s) en panne (app), 2/5 serveur(s) en service.',
  });

  world.haproxy.failure = 'down';
  clock.advance(20_000);
  const down = await world.fake.sceneAction('get_proxy_status', {});
  assert.equal(down.success, true);
  assert.equal(down.data.outputs.reachable, false);
  assert.equal(down.data.outputs.sentence, 'HAProxy : HAProxy ne répond pas.');
});

test('"Test the connection" sums up HAProxy in the four languages', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const ack = await world.fake.action('test_connection', {});
  assert.equal(ack.success, true, ack.error);
  assert.equal(ack.data.message.en, 'HAProxy: Connected, 3 backend(s), 4/5 server(s) up');
  assert.match(ack.data.message.fr, /^HAProxy : Connecté/);
});

test('the internal timer reads HAProxy and publishes the changes, without any poll from Gladys', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const world = await createWorld({ timers: true });
  t.after(() => world.app.stop());
  await createDevices(world);
  const reads = world.haproxy.requests.length;
  world.haproxy.load(FIXTURES.backendDown);
  t.mock.timers.tick(30_000);
  // Let the read and the publications settle.
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(world.haproxy.requests.length > reads);
  assert.equal(backendState(world, 'app', BACKEND_KEYS.AVAILABLE), 0);
});

test('a damaged /data file does not block the reads', async (t) => {
  const first = await createWorld();
  await first.app.stop();
  writeFileSync(
    join(first.dataDir, 'haproxy-state.json'),
    JSON.stringify({
      url: `stats_page ${STATS_URL}`,
      initialized: true,
      reachable: true,
      backends: { x: null, app: 'oops', api: { available: 'yes' } },
      servers: { 'y/z': 3 },
    }),
  );
  const second = await createWorld({ dataDir: first.dataDir });
  t.after(() => second.app.stop());
  await second.hub.pollNow();
  assert.equal(second.fake.connectionStatus.connected, true);
  assert.equal(second.hub.backends.size, 3);
});
