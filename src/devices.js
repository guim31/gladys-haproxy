// -----------------------------------------------------------------------------
// Gladys devices, proposed in the Discovery tab (the user adds the ones to
// follow, nothing is created on their behalf):
//
//   - one "HAProxy" device:
//       reachable            input/binary    1 the statistics answer, 0 otherwise
//       frontends_open       counter-sensor  frontends accepting connections
//       backends_down        counter-sensor  backends without any server available
//       servers_up           counter-sensor  servers taking traffic, every backend
//       servers_total        counter-sensor  servers declared, every backend
//       sessions             counter-sensor  current sessions on the frontends
//
//   - one device per backend with servers, identified by its HAProxy name:
//       available            input/binary    1 HAProxy has a server for it (UP)
//       servers_up           counter-sensor  servers taking traffic
//       servers_total        counter-sensor  servers declared (backups included)
//       sessions             counter-sensor  current sessions
//       errors_5xx           counter-sensor  share of 5xx among the HTTP
//                            (percent)       answers since the previous read
//
//   - optionally (configuration), one device per server, `backend/server`:
//       online               input/binary    1 UP or without health check
//
// Published with should_poll: false: the integration reads HAProxy on its own
// timer (src/hub.js), at the interval chosen in the configuration.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

export const PROXY_TYPE = 'proxy';
export const PROXY_ID = 'main';
export const BACKEND_TYPE = 'backend';
export const SERVER_TYPE = 'server';
export const MODEL = 'HAProxy';

// Suffixes of the feature external ids: permanent once published.
export const PROXY_KEYS = Object.freeze({
  REACHABLE: 'reachable',
  FRONTENDS_OPEN: 'frontends_open',
  BACKENDS_DOWN: 'backends_down',
  SERVERS_UP: 'servers_up',
  SERVERS_TOTAL: 'servers_total',
  SESSIONS: 'sessions',
});

export const BACKEND_KEYS = Object.freeze({
  AVAILABLE: 'available',
  SERVERS_UP: 'servers_up',
  SERVERS_TOTAL: 'servers_total',
  SESSIONS: 'sessions',
  ERRORS_5XX: 'errors_5xx',
});

export const SERVER_KEYS = Object.freeze({
  ONLINE: 'online',
});

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    reachable: 'Reachable',
    frontends_open: 'Frontends open',
    backends_down: 'Backends down',
    servers_up: 'Servers up',
    servers_total: 'Servers in total',
    sessions: 'Current sessions',
    available: 'Available',
    errors_5xx: '5xx errors',
    online: 'Online',
  },
  fr: {
    reachable: 'Joignable',
    frontends_open: 'Frontaux ouverts',
    backends_down: 'Backends en panne',
    servers_up: 'Serveurs en service',
    servers_total: 'Serveurs au total',
    sessions: 'Sessions en cours',
    available: 'Disponible',
    errors_5xx: 'Erreurs 5xx',
    online: 'En ligne',
  },
  de: {
    reachable: 'Erreichbar',
    frontends_open: 'Offene Frontends',
    backends_down: 'Ausgefallene Backends',
    servers_up: 'Erreichbare Server',
    servers_total: 'Server insgesamt',
    sessions: 'Aktuelle Sitzungen',
    available: 'Verfügbar',
    errors_5xx: '5xx-Fehler',
    online: 'Online',
  },
  es: {
    reachable: 'Accesible',
    frontends_open: 'Frontends abiertos',
    backends_down: 'Backends caídos',
    servers_up: 'Servidores activos',
    servers_total: 'Servidores en total',
    sessions: 'Sesiones actuales',
    available: 'Disponible',
    errors_5xx: 'Errores 5xx',
    online: 'En línea',
  },
};

// Display bounds (the core never applies them on write).
export const MAX_COUNT = 10_000;
export const MAX_SERVERS = 1_000;
export const MAX_SESSIONS = 1_000_000;

/**
 * The state of a backend: up (every server takes traffic), degraded (some
 * do: a server down, in maintenance, or only a backup left), down (HAProxy
 * has no server for it).
 * @returns {'up'|'degraded'|'down'}
 */
export function stateOf(backend) {
  if (!backend.available) {
    return 'down';
  }
  return backend.serversUp < backend.serversTotal ? 'degraded' : 'up';
}

// HAProxy names hold letters, digits, `-`, `_`, `.` and `:`; anything else
// would only make the external id harder to read.
export const platformIdOf = (name) => name.replace(/[^A-Za-z0-9._:-]/g, '_');

export const proxyIds = (gladys) => gladys.externalIds(PROXY_TYPE, PROXY_ID);
export const backendIds = (gladys, name) => gladys.externalIds(BACKEND_TYPE, platformIdOf(name));
// A name never holds a slash: `backend/server` is unique.
export const serverIds = (gladys, backend, server) =>
  gladys.externalIds(SERVER_TYPE, `${platformIdOf(backend)}/${platformIdOf(server)}`);

const sensor = (name, externalId, category, type, extra) => ({
  name,
  external_id: externalId,
  category,
  type,
  read_only: true,
  has_feedback: false,
  ...extra,
});

const binary = (name, externalId) =>
  sensor(name, externalId, DEVICE_FEATURE_CATEGORIES.INPUT, DEVICE_FEATURE_TYPES.SENSOR.BINARY, {
    keep_history: true,
    min: 0,
    max: 1,
  });

const counter = (name, externalId, max, extra = {}) =>
  sensor(
    name,
    externalId,
    DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
    DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
    { keep_history: true, min: 0, max, ...extra },
  );

const namesOf = (language) => NAMES[language] ?? NAMES.en;

/** The discovery payload of HAProxy itself. */
export function buildProxyDevice(gladys, language = 'en') {
  const ids = proxyIds(gladys);
  const names = namesOf(language);
  const max = {
    [PROXY_KEYS.FRONTENDS_OPEN]: MAX_COUNT,
    [PROXY_KEYS.BACKENDS_DOWN]: MAX_COUNT,
    [PROXY_KEYS.SERVERS_UP]: MAX_COUNT,
    [PROXY_KEYS.SERVERS_TOTAL]: MAX_COUNT,
    [PROXY_KEYS.SESSIONS]: MAX_SESSIONS,
  };
  return {
    name: 'HAProxy',
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params: [],
    features: [
      binary(names.reachable, ids.feature(PROXY_KEYS.REACHABLE)),
      ...Object.entries(max).map(([key, bound]) => counter(names[key], ids.feature(key), bound)),
    ],
  };
}

/** The discovery payload of a backend. */
export function buildBackendDevice(gladys, backend, language = 'en') {
  const ids = backendIds(gladys, backend.name);
  const names = namesOf(language);
  return {
    name: backend.name.slice(0, 255),
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params: [],
    features: [
      binary(names.available, ids.feature(BACKEND_KEYS.AVAILABLE)),
      counter(names.servers_up, ids.feature(BACKEND_KEYS.SERVERS_UP), MAX_SERVERS),
      counter(names.servers_total, ids.feature(BACKEND_KEYS.SERVERS_TOTAL), MAX_SERVERS),
      counter(names.sessions, ids.feature(BACKEND_KEYS.SESSIONS), MAX_SESSIONS),
      counter(names.errors_5xx, ids.feature(BACKEND_KEYS.ERRORS_5XX), 100, {
        unit: DEVICE_FEATURE_UNITS.PERCENT,
      }),
    ],
  };
}

/** The discovery payload of a server. */
export function buildServerDevice(gladys, backend, server, language = 'en') {
  const ids = serverIds(gladys, backend.name, server.name);
  return {
    name: `${backend.name}/${server.name}`.slice(0, 255),
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params: [{ name: 'BACKEND', value: backend.name.slice(0, 255) }],
    features: [binary(namesOf(language).online, ids.feature(SERVER_KEYS.ONLINE))],
  };
}

/** The values of a backend device (the 5xx share once two reads compare). */
export function backendValues(gladys, backend) {
  const ids = backendIds(gladys, backend.name);
  const values = [
    { key: BACKEND_KEYS.AVAILABLE, state: backend.available ? 1 : 0 },
    { key: BACKEND_KEYS.SERVERS_UP, state: backend.serversUp },
    { key: BACKEND_KEYS.SERVERS_TOTAL, state: backend.serversTotal },
    { key: BACKEND_KEYS.SESSIONS, state: backend.sessions },
  ];
  if (backend.errorShare !== null) {
    values.push({ key: BACKEND_KEYS.ERRORS_5XX, state: backend.errorShare });
  }
  return values.map(({ key, state }) => ({ device_feature_external_id: ids.feature(key), state }));
}

export function serverValues(gladys, backend, server) {
  return [
    {
      device_feature_external_id: serverIds(gladys, backend.name, server.name).feature(
        SERVER_KEYS.ONLINE,
      ),
      state: server.online ? 1 : 0,
    },
  ];
}

/**
 * The values of the HAProxy device: only "reachable" when HAProxy does not
 * answer (the counts keep their last value).
 */
export function proxyValues(gladys, { reachable, frontends, backends }) {
  const ids = proxyIds(gladys);
  const values = [{ key: PROXY_KEYS.REACHABLE, state: reachable ? 1 : 0 }];
  if (reachable && frontends) {
    const sum = (list, read) => list.reduce((total, item) => total + read(item), 0);
    values.push(
      {
        key: PROXY_KEYS.FRONTENDS_OPEN,
        state: frontends.filter((frontend) => frontend.status !== 'STOP').length,
      },
      { key: PROXY_KEYS.BACKENDS_DOWN, state: backends.filter((b) => !b.available).length },
      { key: PROXY_KEYS.SERVERS_UP, state: sum(backends, (b) => b.serversUp) },
      { key: PROXY_KEYS.SERVERS_TOTAL, state: sum(backends, (b) => b.serversTotal) },
      { key: PROXY_KEYS.SESSIONS, state: sum(frontends, (f) => f.sessions) },
    );
  }
  return values.map(({ key, state }) => ({ device_feature_external_id: ids.feature(key), state }));
}
