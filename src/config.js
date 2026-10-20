// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// One HAProxy: where its statistics are read (src/haproxy/client.js), with an
// optional basic auth user (`stats auth`, or the Data Plane API user).
// -----------------------------------------------------------------------------

import { SOURCES } from './haproxy/client.js';

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

export const SOURCE_VALUES = Object.values(SOURCES);

// Refresh intervals offered in the configuration, in seconds.
export const POLL_INTERVALS = ['15', '30', '60', '120', '300'];

export const DEFAULT_CONFIG = {
  source: SOURCES.STATS_PAGE,
  url: '',
  username: '',
  password: '',
  server_devices: false,
  poll_interval: '30',
  language: 'fr',
};

const parseUrl = (text, defaultScheme) => {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${defaultScheme}://${text}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
};

/**
 * Parse the address typed by the user, for the chosen source:
 *   stats_page  the URL of the statistics page as opened in the browser
 *               (`192.0.2.10:8404/stats`, `http://host/haproxy?stats`); the
 *               `;csv`, `;up`… options and the fragment are dropped
 *   dataplane   the base URL of the Data Plane API (`http://host:5555`); a
 *               copied `/v3/…` path is dropped
 *   socket      `host:port` (or `tcp://host:port`) of the runtime API in TCP
 * HTTP by default for a bare host.
 * @param {unknown} raw
 * @param {string} source one of SOURCES
 * @returns {string|null} the normalized address, null when unusable
 */
export function parseAddress(raw, source = SOURCES.STATS_PAGE) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }
  const typed = raw.trim();
  if (source === SOURCES.SOCKET) {
    const url = parseUrl(typed, 'tcp');
    if (!url || url.protocol !== 'tcp:' || !url.hostname || !url.port) {
      return null;
    }
    return `tcp://${url.hostname}:${url.port}`;
  }
  const url = parseUrl(typed, 'http');
  if (!url || !['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return null;
  }
  // Credentials in the address would end up in the logs: they have their fields.
  if (url.username || url.password) {
    return null;
  }
  if (source === SOURCES.DATAPLANE) {
    const path = url.pathname.replace(/\/v[23](\/.*)?$/i, '').replace(/\/+$/, '');
    return `${url.origin}${path}`;
  }
  // The stats page: the path and query as typed, without the page options.
  const target = `${url.pathname}${url.search}`.replace(/(;[^/?;]*)+$/, '');
  return `${url.origin}${target || '/'}`;
}

/** Host part shown to the user (no scheme, no credentials ever). */
export const hostOf = (url) => url.replace(/^[a-z]+:\/\//, '');

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const kind = SOURCE_VALUES.includes(source.source) ? source.source : DEFAULT_CONFIG.source;
  const typed = text('url');
  const pollInterval = POLL_INTERVALS.includes(String(source.poll_interval))
    ? String(source.poll_interval)
    : DEFAULT_CONFIG.poll_interval;
  return {
    source: kind,
    // '' when nothing was typed yet, null when what was typed is unusable.
    url: typed ? parseAddress(typed, kind) : '',
    username: text('username'),
    // A password may legitimately start or end with a space: kept as typed.
    password: typeof source.password === 'string' ? source.password : '',
    serverDevices: source.server_devices === true || source.server_devices === 'true',
    pollIntervalMs: Number(pollInterval) * 1000,
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
