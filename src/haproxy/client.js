// -----------------------------------------------------------------------------
// HAProxy client: the statistics of every frontend, backend and server, read
// from one of three sources, all read-only:
//
//   stats_page  GET <stats uri>;csv          the statistics page of a frontend
//                                            (`stats enable`, `stats uri`),
//                                            optionally behind `stats auth`
//   dataplane   GET /v3/services/haproxy/stats/native   the Data Plane API
//               (or /v2/… on Data Plane 2.x), basic auth
//   socket      `show stat` on the runtime API exposed in TCP
//               (`stats socket ipv4@0.0.0.0:9999 level user`)
//
// The stats page and the socket answer the same CSV (header `# pxname,svname,…`,
// one row per frontend, backend, server and listener); the Data Plane API
// wraps the same fields in JSON. All three are normalized into one snapshot.
//
// Redirects are not followed: the basic auth credentials would be sent to
// wherever the address points (an http:// address redirected to https:// is
// reported instead).
// -----------------------------------------------------------------------------

import net from 'node:net';

export const SOURCES = Object.freeze({
  STATS_PAGE: 'stats_page',
  DATAPLANE: 'dataplane',
  SOCKET: 'socket',
});

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable', // no answer: down, wrong address, firewall
  TLS: 'tls', // the certificate does not verify
  AUTH: 'auth', // basic auth refused (or missing)
  NOT_HAPROXY: 'not_haproxy', // something answers, not HAProxy statistics
  REDIRECT: 'redirect', // the address redirects (usually HTTP to HTTPS)
  HTTP: 'http', // any other HTTP error
});

export class HaproxyError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message English, for the logs (never contains a secret)
   * @param {object} [extra] { status }
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'HaproxyError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// About 2 kB per row: a few thousand servers at most.
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

const tooLarge = () => new Error('Response too large');

/**
 * The HTTP request (fetch). The client takes it as a parameter: the tests
 * replace it with an in-memory HAProxy (test/helpers/fakeHaproxy.js).
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function httpRequest(url, { headers = {}, timeoutMs = 10_000 } = {}) {
  const response = await fetch(url, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw tooLarge();
  }
  // A chunked answer has no length: count while reading.
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      await response.body.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  return { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
}

/**
 * One command on the runtime API in TCP: HAProxy answers and closes the
 * connection (non-interactive mode). Same seam as httpRequest for the tests.
 * @returns {Promise<string>}
 */
export function socketRequest(host, port, command, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs, () => {
      const error = new Error('Timed out');
      error.code = 'ETIMEDOUT';
      socket.destroy(error);
    });
    socket.on('connect', () => socket.write(`${command}\n`));
    socket.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        socket.destroy(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    socket.on('error', reject);
    socket.on('close', (hadError) => {
      if (!hadError) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
  });
}

// --- Normalization -------------------------------------------------------------

const ROW_TYPES = { 0: 'frontend', 1: 'backend', 2: 'server', 3: 'listener' };

const number = (value) => {
  if (value === '' || value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * The CSV of the stats page and of `show stat`: one object per row, keyed by
 * the header. Names never contain a comma (HAProxy refuses them).
 * @returns {object[]|null} null when the text is not HAProxy statistics
 */
export function parseCsv(text) {
  const lines = String(text).split(/\r?\n/);
  const header = lines.findIndex((line) => line.startsWith('# pxname,svname,'));
  if (header === -1) {
    return null;
  }
  const columns = lines[header].slice(2).split(',');
  const rows = [];
  for (const line of lines.slice(header + 1)) {
    if (!line || line.startsWith('#')) {
      continue;
    }
    const cells = line.split(',');
    const raw = Object.fromEntries(columns.map((column, i) => [column, cells[i] ?? '']));
    rows.push({
      type: ROW_TYPES[raw.type] ?? null,
      proxy: raw.pxname,
      name: raw.svname,
      fields: raw,
    });
  }
  return rows;
}

/**
 * The answer of the Data Plane API: `{ runtimeAPI, stats: [...] }` (v3), or a
 * list of them, one per process (v2). Same rows as the CSV.
 * @returns {object[]|null}
 */
export function parseDataplane(data) {
  const blocks = (Array.isArray(data) ? data : [data]).filter(
    (block) => block && typeof block === 'object' && Array.isArray(block.stats),
  );
  if (blocks.length === 0) {
    return null;
  }
  const rows = [];
  for (const item of blocks.flatMap((block) => block.stats)) {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string') {
      continue;
    }
    const type = ['frontend', 'backend', 'server'].includes(item.type) ? item.type : null;
    rows.push({
      type,
      proxy: type === 'server' ? String(item.backend_name ?? '') : item.name,
      name: { frontend: 'FRONTEND', backend: 'BACKEND' }[type] ?? item.name,
      fields: item.stats && typeof item.stats === 'object' ? item.stats : {},
    });
  }
  return rows;
}

/**
 * A server takes traffic: UP (also "UP 1/3", going down but not yet), or
 * without health check. DOWN, MAINT (maintenance, failed DNS resolution),
 * DRAIN and NOLB (no new traffic) do not.
 */
export const isOnline = (status) => /^(UP\b|no check)/i.test(status);

const HTTP_CODES = ['hrsp_1xx', 'hrsp_2xx', 'hrsp_3xx', 'hrsp_4xx', 'hrsp_5xx', 'hrsp_other'];

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * The rows, as the integration sees them.
 * @returns {{ frontends: object[], backends: object[] }}
 *   frontends: { name, status, sessions };
 *   backends (the ones with servers): { name, status, available, sessions,
 *   responses, errors5xx, servers: [{ name, status, online, backup, check }] }
 *   — responses and errors5xx are the cumulative HTTP counters.
 */
export function normalizeRows(rows) {
  const frontends = [];
  const backends = new Map();
  const servers = new Map();
  for (const { type, proxy, name, fields } of rows) {
    if (!proxy || !name) {
      continue;
    }
    if (type === 'frontend') {
      if (!frontends.some((frontend) => frontend.name === proxy)) {
        frontends.push({
          name: proxy,
          status: text(fields.status),
          sessions: number(fields.scur) ?? 0,
        });
      }
    } else if (type === 'backend') {
      if (!backends.has(proxy)) {
        const status = text(fields.status);
        backends.set(proxy, {
          name: proxy,
          status,
          available: /^UP\b/i.test(status),
          sessions: number(fields.scur) ?? 0,
          responses: HTTP_CODES.reduce((sum, key) => sum + (number(fields[key]) ?? 0), 0),
          errors5xx: number(fields.hrsp_5xx) ?? 0,
          servers: [],
        });
      }
    } else if (type === 'server') {
      const list = servers.get(proxy) ?? [];
      if (!list.some((server) => server.name === name)) {
        const status = text(fields.status);
        list.push({
          name,
          status,
          online: isOnline(status),
          backup: number(fields.bck) === 1,
          check: text(fields.check_status),
        });
        servers.set(proxy, list);
      }
    }
  }
  const retained = [];
  for (const backend of backends.values()) {
    backend.servers = servers.get(backend.name) ?? [];
    // A backend without server (a redirect, the stats page) has nothing to watch.
    if (backend.servers.length > 0) {
      retained.push(backend);
    }
  }
  return { frontends, backends: retained };
}

export class HaproxyClient {
  /**
   * @param {object} options
   * @param {string} options.source one of SOURCES
   * @param {string} options.url normalized address (src/config.js)
   * @param {string} [options.username] basic auth (stats page, Data Plane API)
   * @param {string} [options.password]
   * @param {typeof httpRequest} [options.request] test seam
   * @param {typeof socketRequest} [options.socket] test seam
   * @param {number} [options.timeoutMs]
   */
  constructor({
    source,
    url,
    username = '',
    password = '',
    request = httpRequest,
    socket = socketRequest,
    timeoutMs = 10_000,
  }) {
    this.source = source;
    this.url = url;
    this.headers = {};
    if (username) {
      const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
      this.headers.authorization = `Basic ${token}`;
    }
    this.request = request;
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    /** The Data Plane API version that answered (v3, else v2). */
    this.dataplanePath = null;
  }

  static unreachable(err) {
    const code = err.cause?.code ?? err.code;
    if (TLS_CODES.has(code)) {
      return new HaproxyError(ERROR_KINDS.TLS, `Certificate refused (${code})`);
    }
    return new HaproxyError(ERROR_KINDS.UNREACHABLE, code ?? err.name ?? err.message);
  }

  async get(url) {
    let response;
    try {
      response = await this.request(url, { headers: this.headers, timeoutMs: this.timeoutMs });
    } catch (err) {
      throw HaproxyClient.unreachable(err);
    }
    const { status } = response;
    if (status === 401 || status === 403) {
      throw new HaproxyError(ERROR_KINDS.AUTH, `Credentials refused (HTTP ${status})`, { status });
    }
    if (status >= 300 && status < 400) {
      throw new HaproxyError(ERROR_KINDS.REDIRECT, `Redirected (HTTP ${status})`, { status });
    }
    if (status === 404) {
      throw new HaproxyError(ERROR_KINDS.NOT_HAPROXY, 'No HAProxy statistics here (HTTP 404)', {
        status,
      });
    }
    if (status < 200 || status >= 300) {
      throw new HaproxyError(ERROR_KINDS.HTTP, `Unexpected answer (HTTP ${status})`, { status });
    }
    return response.body;
  }

  async rows() {
    if (this.source === SOURCES.SOCKET) {
      const { hostname, port } = new URL(this.url);
      let body;
      try {
        body = await this.socket(hostname.replace(/^\[|\]$/g, ''), Number(port), 'show stat', {
          timeoutMs: this.timeoutMs,
        });
      } catch (err) {
        throw HaproxyClient.unreachable(err);
      }
      const rows = parseCsv(body);
      if (!rows) {
        const said = body.trim().split('\n')[0]?.slice(0, 80) || 'nothing';
        throw new HaproxyError(ERROR_KINDS.NOT_HAPROXY, `The socket answered: ${said}`);
      }
      return rows;
    }
    if (this.source === SOURCES.DATAPLANE) {
      return this.dataplaneRows();
    }
    const rows = parseCsv(await this.get(`${this.url};csv`));
    if (!rows) {
      throw new HaproxyError(ERROR_KINDS.NOT_HAPROXY, 'The answer is not the HAProxy CSV');
    }
    return rows;
  }

  async dataplaneRows() {
    const paths = this.dataplanePath
      ? [this.dataplanePath]
      : ['/v3/services/haproxy/stats/native', '/v2/services/haproxy/stats/native'];
    let lastError;
    for (const path of paths) {
      let body;
      try {
        body = await this.get(`${this.url}${path}`);
      } catch (err) {
        // Data Plane 2.x has no /v3: try /v2.
        if (err.kind === ERROR_KINDS.NOT_HAPROXY) {
          lastError = err;
          continue;
        }
        throw err;
      }
      let rows = null;
      try {
        rows = parseDataplane(JSON.parse(body));
      } catch {
        // reported below
      }
      if (!rows) {
        throw new HaproxyError(ERROR_KINDS.NOT_HAPROXY, 'The answer is not Data Plane statistics');
      }
      this.dataplanePath = path;
      return rows;
    }
    throw lastError;
  }

  /**
   * One read of HAProxy.
   * @returns {Promise<{ frontends: object[], backends: object[] }>}
   * @throws {HaproxyError}
   */
  async snapshot() {
    return normalizeRows(await this.rows());
  }
}
