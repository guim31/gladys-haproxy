// -----------------------------------------------------------------------------
// The HAProxy client against the real statistics of HAProxy 3.2
// (test/fixtures/haproxy, recorded on haproxytech/haproxy-alpine:3.2 in Docker:
// a backend with two traefik/whoami servers behind an HTTP health check, one
// whose first server never resolves (MAINT) with a backup, one without health
// check; then a server stopped, every server stopped under 503s, all back), the
// three sources, and their errors.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_KINDS,
  HaproxyClient,
  SOURCES,
  isOnline,
  normalizeRows,
  parseCsv,
  parseDataplane,
} from '../src/haproxy/client.js';
import { normalizeConfig, parseAddress } from '../src/config.js';
import {
  DATAPLANE_URL,
  FIXTURES,
  FakeHaproxy,
  SOCKET_URL,
  STATS_URL,
  fixture,
} from './helpers/fakeHaproxy.js';

const summary = ({ frontends, backends }) => ({
  frontends: frontends.map((f) => `${f.name} ${f.status}`),
  backends: backends.map(
    (b) =>
      `${b.name} ${b.status}: ${b.servers.map((s) => `${s.name}=${s.status}${s.backup ? ' (backup)' : ''}`).join(', ')}`,
  ),
});

test('the real CSV of HAProxy 3.2: frontends, the backends with servers, their servers', () => {
  const snapshot = normalizeRows(parseCsv(FIXTURES.healthy));
  assert.deepEqual(summary(snapshot), {
    frontends: ['web OPEN', 'stats OPEN', 'stats-auth OPEN'],
    backends: [
      'app UP: app1=UP, app2=UP',
      'api UP: api1=MAINT (resolution), api2=UP (backup)',
      'legacy UP: old=no check',
    ],
  });
  const app = snapshot.backends[0];
  assert.equal(app.responses, 20);
  assert.equal(app.errors5xx, 0);
  assert.equal(snapshot.frontends[0].sessions, 2);
});

test('a server stopped, then every server: DOWN servers, DOWN backends, 5xx counted', () => {
  const one = normalizeRows(parseCsv(FIXTURES.oneServerDown));
  assert.equal(summary(one).backends[0], 'app UP: app1=UP, app2=DOWN');
  assert.equal(one.backends[0].servers[1].check, 'L4TOUT');
  const all = normalizeRows(parseCsv(FIXTURES.backendDown));
  assert.deepEqual(summary(all).backends.slice(0, 2), [
    'app DOWN: app1=DOWN, app2=DOWN',
    'api DOWN: api1=MAINT (resolution), api2=DOWN (backup)',
  ]);
  assert.deepEqual(
    all.backends.map((b) => [b.name, b.available, b.errors5xx]),
    [
      ['app', false, 20],
      ['api', false, 10],
      ['legacy', true, 0],
    ],
  );
});

test('the runtime API and the Data Plane API answer the same statistics', () => {
  const csv = summary(normalizeRows(parseCsv(FIXTURES.healthy)));
  assert.deepEqual(summary(normalizeRows(parseCsv(fixture('v3.2-healthy-socket.txt')))), csv);
  const dataplane = JSON.parse(fixture('v3.2-healthy-dataplane-v3.json'));
  assert.deepEqual(summary(normalizeRows(parseDataplane(dataplane))), csv);
  // Data Plane 2.x: one block per process, in a list.
  assert.deepEqual(summary(normalizeRows(parseDataplane([dataplane]))), csv);
  const down = parseDataplane(JSON.parse(fixture('v3.2-backend-down-dataplane-v3.json')));
  assert.deepEqual(
    normalizeRows(down).backends.map((b) => [b.name, b.available]),
    [
      ['app', false],
      ['api', false],
      ['legacy', true],
    ],
  );
});

test('which server statuses take traffic', () => {
  for (const status of ['UP', 'UP 1/3', 'no check']) {
    assert.equal(isOnline(status), true, status);
  }
  for (const status of ['DOWN', 'DOWN 1/2', 'MAINT', 'MAINT (via app/app1)', 'DRAIN', 'NOLB', '']) {
    assert.equal(isOnline(status), false, status);
  }
});

test('garbage is not HAProxy; duplicate rows (several processes) are kept once', () => {
  assert.equal(parseCsv('<html>Gladys</html>'), null);
  assert.equal(parseDataplane({ code: 404 }), null);
  const twice = `${FIXTURES.healthy.trim()}\n${FIXTURES.healthy.split('\n').slice(1).join('\n')}`;
  assert.deepEqual(
    summary(normalizeRows(parseCsv(twice))),
    summary(normalizeRows(parseCsv(FIXTURES.healthy))),
  );
});

const client = (haproxy, extra = {}) =>
  new HaproxyClient({
    source: SOURCES.STATS_PAGE,
    url: STATS_URL,
    request: haproxy.request,
    socket: haproxy.socket,
    ...extra,
  });

test('the statistics page: `;csv` appended, basic auth when configured', async () => {
  const haproxy = new FakeHaproxy({ auth: 'gladys:s3cret pw' });
  await assert.rejects(client(haproxy).snapshot(), { kind: ERROR_KINDS.AUTH });
  const snapshot = await client(haproxy, { username: 'gladys', password: 's3cret pw' }).snapshot();
  assert.equal(snapshot.backends.length, 3);
  assert.equal(haproxy.requests.at(-1).url, `${STATS_URL};csv`);
});

test('the Data Plane API: v3, else v2, with its user', async () => {
  for (const version of ['v3', 'v2']) {
    const haproxy = new FakeHaproxy({ auth: 'admin:pw', dataplaneVersion: version });
    const dataplane = client(haproxy, {
      source: SOURCES.DATAPLANE,
      url: DATAPLANE_URL,
      username: 'admin',
      password: 'pw',
    });
    assert.equal((await dataplane.snapshot()).backends.length, 3, version);
    await dataplane.snapshot();
    assert.equal(
      haproxy.requests.at(-1).url,
      `${DATAPLANE_URL}/${version}/services/haproxy/stats/native`,
      'the version that answered is remembered',
    );
  }
  const none = new FakeHaproxy();
  await assert.rejects(
    client(none, { source: SOURCES.DATAPLANE, url: 'http://192.0.2.99:5555' }).snapshot(),
    { kind: ERROR_KINDS.NOT_HAPROXY },
  );
});

test('the runtime API in TCP: `show stat`, and what else may answer', async () => {
  const haproxy = new FakeHaproxy();
  const socket = client(haproxy, { source: SOURCES.SOCKET, url: SOCKET_URL });
  assert.equal((await socket.snapshot()).backends.length, 3);
  assert.deepEqual(haproxy.requests.at(-1), { url: SOCKET_URL, command: 'show stat' });
  haproxy.failure = 'text';
  await assert.rejects(socket.snapshot(), { kind: ERROR_KINDS.NOT_HAPROXY });
  haproxy.failure = 'down';
  await assert.rejects(socket.snapshot(), { kind: ERROR_KINDS.UNREACHABLE });
});

test('errors: down, TLS, redirect, 404, 5xx, not CSV', async () => {
  const haproxy = new FakeHaproxy();
  haproxy.failure = 'down';
  await assert.rejects(client(haproxy).snapshot(), { kind: ERROR_KINDS.UNREACHABLE });
  for (const [status, kind] of [
    [302, ERROR_KINDS.REDIRECT],
    [404, ERROR_KINDS.NOT_HAPROXY],
    [503, ERROR_KINDS.HTTP],
    [403, ERROR_KINDS.AUTH],
  ]) {
    haproxy.failure = status;
    await assert.rejects(client(haproxy).snapshot(), { kind }, `HTTP ${status}`);
  }
  haproxy.failure = 'text';
  await assert.rejects(client(haproxy).snapshot(), { kind: ERROR_KINDS.NOT_HAPROXY });
  const tls = async () => {
    const error = new TypeError('fetch failed');
    error.cause = { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' };
    throw error;
  };
  await assert.rejects(client(haproxy, { request: tls }).snapshot(), { kind: ERROR_KINDS.TLS });
});

test('the address: as copied from the browser, per source; no credentials in it', () => {
  const page = (raw) => parseAddress(raw, SOURCES.STATS_PAGE);
  assert.equal(page('192.0.2.10:8404/stats'), 'http://192.0.2.10:8404/stats');
  assert.equal(page('http://192.0.2.10:8404/stats;up;csv#x'), 'http://192.0.2.10:8404/stats');
  assert.equal(page('http://192.0.2.10/haproxy?stats'), 'http://192.0.2.10/haproxy?stats');
  assert.equal(page('https://lb.example.com:8405'), 'https://lb.example.com:8405/');
  assert.equal(page('http://user:pw@192.0.2.10:8404/stats'), null);
  assert.equal(page('ftp://192.0.2.10'), null);
  const dataplane = (raw) => parseAddress(raw, SOURCES.DATAPLANE);
  assert.equal(dataplane('192.0.2.10:5555'), 'http://192.0.2.10:5555');
  assert.equal(dataplane('http://192.0.2.10:5555/v3/services/haproxy'), 'http://192.0.2.10:5555');
  const socket = (raw) => parseAddress(raw, SOURCES.SOCKET);
  assert.equal(socket('192.0.2.10:9999'), 'tcp://192.0.2.10:9999');
  assert.equal(socket('tcp://lb.local:9999'), 'tcp://lb.local:9999');
  assert.equal(socket('192.0.2.10'), null, 'a port is needed');
  assert.equal(socket('http://192.0.2.10:9999'), null);
  assert.equal(normalizeConfig({}).url, '');
  assert.equal(normalizeConfig({ url: 'ftp://x' }).url, null);
  assert.deepEqual(normalizeConfig({ url: ' 192.0.2.10:8404/stats ', poll_interval: '7' }), {
    source: 'stats_page',
    url: 'http://192.0.2.10:8404/stats',
    username: '',
    password: '',
    serverDevices: false,
    pollIntervalMs: 30_000,
    language: 'fr',
  });
});

test('a timeout reads as such in the logs', async () => {
  const timeout = async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  await assert.rejects(client(new FakeHaproxy(), { request: timeout }).snapshot(), {
    kind: ERROR_KINDS.UNREACHABLE,
    message: 'Timed out',
  });
});
