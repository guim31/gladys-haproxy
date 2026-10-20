// -----------------------------------------------------------------------------
// An in-memory HAProxy, starting from the real CSV of HAProxy 3.2
// (test/fixtures/haproxy), served the three ways the integration reads it —
// the statistics page, the Data Plane API, the runtime API in TCP — with the
// helpers the tests need to break things the way the Docker test did: a
// server DOWN or in maintenance, a backend without server, 5xx answers,
// HAProxy down or behind basic auth.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const BASE = 'http://192.0.2.10:8404';
export const STATS_URL = `${BASE}/stats`;
export const DATAPLANE_URL = 'http://192.0.2.10:5555';
export const SOCKET_URL = 'tcp://192.0.2.10:9999';

export const fixture = (name) =>
  readFileSync(new URL(`../fixtures/haproxy/${name}`, import.meta.url), 'utf8');

export const FIXTURES = {
  healthy: fixture('v3.2-healthy.csv'),
  oneServerDown: fixture('v3.2-one-server-down.csv'),
  backendDown: fixture('v3.2-backend-down.csv'),
  backUp: fixture('v3.2-back-up.csv'),
};

const NUMERIC = /^-?\d+$/;

export class FakeHaproxy {
  constructor({ csv = FIXTURES.healthy, auth = null, dataplaneVersion = 'v3' } = {}) {
    this.load(csv);
    /** 'user:password' required in basic auth, or null. */
    this.auth = auth;
    this.dataplaneVersion = dataplaneVersion;
    /** 'down': nothing answers; a number: that HTTP status; 'text': not HAProxy. */
    this.failure = null;
    this.requests = [];
  }

  load(csv) {
    const lines = csv.split('\n').filter(Boolean);
    this.columns = lines[0].slice(2).split(',');
    this.rows = lines.slice(1).map((line) => line.split(','));
  }

  col(name) {
    return this.columns.indexOf(name);
  }

  row(proxy, name) {
    return this.rows.find((row) => row[0] === proxy && row[1] === name);
  }

  /** A server's status; its backend follows (UP while a server is online). */
  setServer(backend, server, status, check = status.startsWith('DOWN') ? 'L4TOUT' : 'L7OK') {
    const row = this.row(backend, server);
    row[this.col('status')] = status;
    row[this.col('check_status')] = check;
    const online = this.rows
      .filter((r) => r[0] === backend && !['FRONTEND', 'BACKEND'].includes(r[1]))
      .some((r) => /^(UP|no check)/.test(r[this.col('status')]));
    this.row(backend, 'BACKEND')[this.col('status')] = online ? 'UP' : 'DOWN';
  }

  /** HTTP answers on a backend (cumulative counters). */
  answer(backend, { ok = 0, errors = 0 }) {
    const row = this.row(backend, 'BACKEND');
    for (const [column, add] of [
      ['hrsp_2xx', ok],
      ['hrsp_5xx', errors],
    ]) {
      row[this.col(column)] = String(Number(row[this.col(column)] || 0) + add);
    }
  }

  removeBackend(name) {
    this.rows = this.rows.filter((row) => row[0] !== name);
  }

  csv() {
    return `# ${this.columns.join(',')}\n${this.rows.map((row) => row.join(',')).join('\n')}\n\n`;
  }

  /** The same rows as the Data Plane API wraps them. */
  dataplane() {
    const type = { 0: 'frontend', 1: 'backend', 2: 'server' };
    const stats = this.rows
      .filter((row) => type[row[this.col('type')]])
      .map((row) => {
        const kind = type[row[this.col('type')]];
        const fields = {};
        this.columns.forEach((column, i) => {
          if (row[i] !== '' && !['pxname', 'svname', 'type'].includes(column)) {
            fields[column] = NUMERIC.test(row[i]) ? Number(row[i]) : row[i];
          }
        });
        return kind === 'server'
          ? { backend_name: row[0], name: row[1], stats: fields, type: kind }
          : { name: row[0], stats: fields, type: kind };
      });
    const block = { runtimeAPI: '/var/run/haproxy.sock', stats };
    return JSON.stringify(this.dataplaneVersion === 'v2' ? [block] : block);
  }

  denied(headers) {
    if (!this.auth) {
      return false;
    }
    return headers.authorization !== `Basic ${Buffer.from(this.auth).toString('base64')}`;
  }

  /** The HTTP seam of src/haproxy/client.js. */
  request = async (url, { headers = {} } = {}) => {
    this.requests.push({ url, headers });
    if (this.failure === 'down') {
      const error = new TypeError('fetch failed');
      error.cause = { code: 'ECONNREFUSED' };
      throw error;
    }
    if (typeof this.failure === 'number') {
      return { status: this.failure, body: '' };
    }
    if (this.failure === 'text') {
      return { status: 200, body: '<html>Gladys</html>' };
    }
    if (this.denied(headers)) {
      return { status: 401, body: '<html><body><h1>401 Unauthorized</h1></body></html>' };
    }
    if (url === `${STATS_URL};csv`) {
      return { status: 200, body: this.csv() };
    }
    if (url === `${DATAPLANE_URL}/${this.dataplaneVersion}/services/haproxy/stats/native`) {
      return { status: 200, body: this.dataplane() };
    }
    return { status: 404, body: '{"code":404,"message":"not found"}' };
  };

  /** The runtime API seam of src/haproxy/client.js. */
  socket = async (host, port, command) => {
    this.requests.push({ url: `tcp://${host}:${port}`, command });
    if (this.failure === 'down') {
      const error = new Error('connect ECONNREFUSED');
      error.code = 'ECONNREFUSED';
      throw error;
    }
    if (this.failure === 'text') {
      return 'Unknown command. Please enter one of the following commands only :\n';
    }
    return command === 'show stat' ? this.csv() : '';
  };
}
