// -----------------------------------------------------------------------------
// The HAProxy hub: the statistics read on a timer of the container (the
// interval chosen in the configuration); the states of the added devices
// published when they change, the scene events fired on transitions, and the
// views the widget and the scene actions read.
//
// Gladys never polls these devices (should_poll: false): the interval goes up
// to 5 minutes, beyond the fixed list of the core scheduler, and the scene
// events must fire for every server and backend, added to Gladys or not —
// "a server goes down" spares the user one scene per device.
//
// The last state of each backend and server and the reachability of HAProxy
// are kept in /data (src/store.js): what changed while the integration or
// Gladys restarted is still announced, once.
// (Adapted from guim31/gladys-traefik.)
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import {
  backendIds,
  backendValues,
  buildBackendDevice,
  buildProxyDevice,
  buildServerDevice,
  proxyIds,
  proxyValues,
  serverIds,
  serverValues,
  stateOf,
} from './devices.js';
import { HaproxyClient, HaproxyError } from './haproxy/client.js';
import { hostOf, normalizeConfig } from './config.js';
import { ProblemLog } from './problems.js';
import { CONNECTION_TEXT, ERROR_TEXT, REPORT_TEXT, labelled, pick } from './texts.js';

const logger = createLogger({ name: 'haproxy-hub' });

export const WIDGET_KEY = 'haproxy';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  SERVER_DOWN: 'server_down',
  SERVER_UP: 'server_up',
  BACKEND_DOWN: 'backend_down',
  UNREACHABLE: 'proxy_unreachable',
});

export const HUB_TIMINGS = {
  // An unchanged value is sent again this often: Gladys shows "no recent
  // value" after 48 hours.
  heartbeatMs: 12 * 3600_000,
  // A scene action reads HAProxy again when the last read is older.
  freshMs: 15_000,
};

// Failed reads in a row before HAProxy counts as unreachable: a restart (a
// few seconds) does not fire the scenes.
export const FAILURES_BEFORE_UNREACHABLE = 2;

const MAX_TRANSPORTS_PER_REQUEST = 100;

const object = (value) => (value && typeof value === 'object' ? value : {});
const serverKey = (backend, server) => `${backend}/${server}`;

// A hand-edited or damaged /data file must not block the reads.
const entriesOf = (value, flag) =>
  Object.fromEntries(
    Object.entries(object(value)).filter(
      ([, entry]) => entry && typeof entry === 'object' && typeof entry[flag] === 'boolean',
    ),
  );

export class HaproxyHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.request] HTTP seam (src/haproxy/client.js)
   * @param {Function} [options.socket] runtime API seam (src/haproxy/client.js)
   * @param {boolean} [options.timers] the reading timer (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, store, request, socket, timers = true, timings, now }) {
    this.gladys = gladys;
    this.store = store;
    this.request = request;
    this.socket = socket;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    // Defaults until start(): a handler reached after a failed start still
    // answers with a readable message.
    this.config = normalizeConfig({});
    this.client = null;
    this.signature = null;
    this.resetReads();
    /** Set when the address changed: the Discovery list of the old HAProxy goes. */
    this.clearDiscovery = false;
    this.transports = new Map();
    this.connection = null;
    this.discovered = null;
    this.saved = { initialized: false, reachable: null, url: null, backends: {}, servers: {} };
    this.pollTimer = null;
    this.stopped = false;
    // What fails again at every cycle (Gladys refusing, the reading loop):
    // one line when it starts, one when it ends.
    this.problems = new ProblemLog(logger);
  }

  resetReads() {
    /** @type {Map<string, object>} backends of the last read, by name */
    this.backends = new Map();
    this.frontends = null;
    /** Cumulative HTTP counters of the previous read, by backend (5xx share). */
    this.counters = new Map();
    this.readAt = 0;
    this.error = null;
    this.failures = 0;
    this.polling = null;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = object(await this.store.load());
    this.saved = {
      initialized: saved.initialized === true,
      reachable: typeof saved.reachable === 'boolean' ? saved.reachable : null,
      url: typeof saved.url === 'string' ? saved.url : null,
      backends: entriesOf(saved.backends, 'available'),
      servers: entriesOf(saved.servers, 'online'),
    };
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.gladys.forgetPublishedStates?.();
    this.transports.clear();
    this.connection = null;
    this.discovered = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const listChanged =
      this.signature !== null &&
      (this.config.language !== config.language ||
        this.config.serverDevices !== config.serverDevices);
    this.config = config;
    const signature = JSON.stringify([config.source, config.url, config.username, config.password]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.client = config.url
        ? new HaproxyClient({
            source: config.source,
            url: config.url,
            username: config.username,
            password: config.password,
            request: this.request,
            socket: this.socket,
          })
        : null;
      this.resetReads();
      // Another HAProxy: what was saved about the previous one means nothing.
      const place = `${config.source} ${config.url}`;
      if (config.url && this.saved.url !== place) {
        this.clearDiscovery = this.saved.url !== null;
        this.saved = { initialized: false, reachable: null, url: place, backends: {}, servers: {} };
      }
    }
    if (listChanged) {
      this.discovered = null; // new feature names or server devices for Discovery
    }
    try {
      if (this.client) {
        await this.pollNow({ publish: true });
      } else {
        await this.afterChanges(true, { publish: true });
      }
    } finally {
      this.schedulePoll();
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    await this.store.flush();
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (!this.timersEnabled || this.stopped || !this.client) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollNow();
        this.problems.recover('poll', 'Reading HAProxy works again');
      } catch (err) {
        this.problems.fail('poll', `Poll failed: ${err.message}`, 'error');
      }
      this.schedulePoll();
    }, this.config.pollIntervalMs);
  }

  // --- Reading HAProxy ---------------------------------------------------------

  /** Read HAProxy now and publish what changed. */
  async pollNow({ publish = false } = {}) {
    const changed = await this.poll();
    await this.afterChanges(changed, { publish });
  }

  /** Read again when the last read is older than `freshMs` (scene actions). */
  async refreshIfStale() {
    if (this.client && this.now() - this.readAt >= this.timings.freshMs) {
      await this.pollNow();
    }
  }

  /**
   * Read HAProxy and apply what changed. Concurrent calls share the read.
   * @returns {Promise<boolean>} whether the widget shows something new
   */
  poll() {
    if (!this.client) {
      return Promise.resolve(false);
    }
    if (!this.polling) {
      const polling = this.read(this.client).finally(() => {
        // A read of a previous client must not drop the promise of the current one.
        if (this.polling === polling) {
          this.polling = null;
        }
      });
      this.polling = polling;
    }
    return this.polling;
  }

  async read(client) {
    let snapshot;
    try {
      snapshot = await client.snapshot();
    } catch (err) {
      if (!(err instanceof HaproxyError)) {
        throw err;
      }
      return client === this.client && this.applyFailure(err);
    }
    return client === this.client && this.applySuccess(snapshot);
  }

  /** Whether HAProxy counts as reachable (after a few failed reads in a row). */
  get reachable() {
    return this.readAt > 0 && this.saved.reachable !== false && this.frontends !== null;
  }

  /**
   * The share of 5xx among the HTTP answers since the previous read, in
   * percent; null on the first read and after a reload of HAProxy (its
   * counters start again from zero).
   */
  errorShare(backend) {
    const previous = this.counters.get(backend.name);
    this.counters.set(backend.name, { responses: backend.responses, errors: backend.errors5xx });
    if (!previous || backend.responses < previous.responses) {
      return null;
    }
    const responses = backend.responses - previous.responses;
    const errors = Math.max(0, backend.errors5xx - previous.errors);
    return responses > 0 ? Math.min(100, Math.round((errors / responses) * 100)) : 0;
  }

  async applySuccess({ frontends, backends }) {
    // Everything below up to the scene events is synchronous: a configuration
    // change cannot slip between the reading and the saved state it updates.
    const saved = this.saved;
    const client = this.client;
    const now = this.now();
    let widgetChanged = this.error !== null || this.readAt === 0;
    if (this.error || saved.reachable === false) {
      logger.info('HAProxy answers again');
    }
    if (this.readAt === 0 || backends.length !== this.backends.size) {
      const servers = backends.reduce((sum, backend) => sum + backend.servers.length, 0);
      logger.info(
        `HAProxy (${hostOf(this.config.url)}): ${frontends.length} frontend(s), ${backends.length} backend(s), ${servers} server(s)`,
      );
    }
    let dirty = saved.reachable !== true || !saved.initialized;
    const initialized = saved.initialized;
    this.error = null;
    this.failures = 0;
    saved.reachable = true;
    saved.initialized = true;
    this.frontends = frontends;
    this.readAt = now;
    const events = [];

    const next = new Map();
    const seenServers = new Set();
    for (const raw of backends) {
      const backend = {
        ...raw,
        serversUp: raw.servers.filter((server) => server.online).length,
        serversTotal: raw.servers.length,
        errorShare: this.errorShare(raw),
      };
      next.set(backend.name, backend);
      const previous = this.backends.get(backend.name);
      if (
        !previous ||
        stateOf(previous) !== stateOf(backend) ||
        previous.serversUp !== backend.serversUp
      ) {
        widgetChanged = true;
      }
      for (const server of backend.servers) {
        const key = serverKey(backend.name, server.name);
        seenServers.add(key);
        dirty = this.serverTransition(saved, backend, server, initialized, events) || dirty;
      }
      dirty = this.backendTransition(saved, backend, initialized, events) || dirty;
    }
    if ([...this.backends.keys()].some((name) => !next.has(name))) {
      widgetChanged = true; // a backend gone from the configuration
    }
    this.backends = next;
    for (const name of this.counters.keys()) {
      if (!next.has(name)) {
        this.counters.delete(name);
      }
    }
    // Gone from the configuration of HAProxy: a deliberate change, forgotten.
    for (const name of Object.keys(saved.backends)) {
      if (!next.has(name)) {
        delete saved.backends[name];
        dirty = true;
      }
    }
    for (const key of Object.keys(saved.servers)) {
      if (!seenServers.has(key)) {
        delete saved.servers[key];
        dirty = true;
      }
    }

    // Written only when something changed: no wear of the SD card at every read.
    if (dirty) {
      this.store.save(saved);
    }
    for (const [key, data] of events) {
      if (client !== this.client) {
        return false; // reconfigured meanwhile: the old HAProxy's news are stale
      }
      await this.fire(key, data);
    }
    if (client === this.client) {
      await this.publishStates();
    }
    return widgetChanged;
  }

  async applyFailure(err) {
    const wasError = this.error?.kind;
    this.error = { kind: err.kind, message: err.message };
    this.failures += 1;
    this.readAt = this.now();
    if (wasError !== err.kind) {
      logger.warn(`HAProxy: ${err.message}`);
    }
    if (this.failures >= FAILURES_BEFORE_UNREACHABLE && this.saved.reachable !== false) {
      const wasReachable = this.saved.reachable === true;
      this.saved.reachable = false;
      this.store.save(this.saved);
      if (wasReachable) {
        logger.info('HAProxy is unreachable');
        await this.fire(TRIGGERS.UNREACHABLE, {
          error: pick(ERROR_TEXT[err.kind], this.config.language),
        });
      }
    }
    // Every failed read: "reachable" 0 once unreachable, and its heartbeat
    // during a long outage (the SDK skips the repeats).
    await this.publishStates();
    return wasError !== err.kind;
  }

  /**
   * Compare a server with its last state; queue the scene events. Nothing is
   * announced on the very first read; after it, a server seen for the first
   * time is announced only when it appears already offline.
   * @returns {boolean} whether the saved state changed
   */
  serverTransition(saved, backend, server, initialized, events) {
    const key = serverKey(backend.name, server.name);
    const previous = saved.servers[key];
    if (previous?.online === server.online) {
      return false;
    }
    const now = this.now();
    saved.servers[key] = { online: server.online, since: now };
    if (!initialized || (!previous && server.online)) {
      return true;
    }
    const data = {
      backend: backendIds(this.gladys, backend.name).device,
      backend_name: backend.name,
      server: server.name,
    };
    if (!server.online) {
      logger.info(`Server ${key} is ${server.status}`);
      events.push([
        TRIGGERS.SERVER_DOWN,
        { ...data, status: server.status.slice(0, 60), check: server.check.slice(0, 60) },
      ]);
    } else {
      const minutes = Math.max(0, Math.round((now - (previous.since ?? now)) / 60_000));
      logger.info(`Server ${key} is up again after ${minutes} min`);
      events.push([TRIGGERS.SERVER_UP, { ...data, downtime_minutes: minutes }]);
    }
    return true;
  }

  /** Same for a backend: announced when HAProxy no longer has a server for it. */
  backendTransition(saved, backend, initialized, events) {
    const previous = saved.backends[backend.name];
    if (previous?.available === backend.available) {
      return false;
    }
    saved.backends[backend.name] = { available: backend.available, since: this.now() };
    if (!initialized || backend.available) {
      if (initialized && previous) {
        logger.info(`Backend ${backend.name} is available again`);
      }
      return true;
    }
    logger.info(`Backend ${backend.name} has no server available`);
    events.push([
      TRIGGERS.BACKEND_DOWN,
      {
        backend: backendIds(this.gladys, backend.name).device,
        backend_name: backend.name,
        servers_total: backend.serversTotal,
      },
    ]);
    return true;
  }

  async fire(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
    } catch (err) {
      logger.warn(`Scene event ${key} refused: ${err.message}`);
    }
  }

  // --- Publishing to Gladys ----------------------------------------------------

  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  discoveredDevices() {
    if (!this.client || !this.reachable) {
      return null; // nothing read: keep the list Gladys has
    }
    const language = this.config.language;
    const devices = [buildProxyDevice(this.gladys, language)];
    for (const backend of this.backends.values()) {
      devices.push(buildBackendDevice(this.gladys, backend, language));
    }
    if (this.config.serverDevices) {
      for (const backend of this.backends.values()) {
        for (const server of backend.servers) {
          devices.push(buildServerDevice(this.gladys, backend, server, language));
        }
      }
    }
    return devices;
  }

  /** Publish the Discovery list when it changed (a backend added, a language…). */
  async publishDevices({ force = false } = {}) {
    const devices = this.discoveredDevices() ?? (!this.client || this.clearDiscovery ? [] : null);
    if (devices === null) {
      return;
    }
    const key = JSON.stringify(devices);
    if (!force && key === this.discovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovered = key;
      this.clearDiscovery = false;
      this.problems.recover('discovered', 'Discovered devices accepted again');
    } catch (err) {
      this.problems.fail('discovered', `Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: read HAProxy, publish the list again. */
  async rediscover() {
    await this.poll();
    await this.afterChanges(true, { publish: true });
  }

  /**
   * The user added (or updated) a device: its states sent before were dropped
   * by Gladys, and a device deleted then added again needs its badge.
   */
  async onDeviceCreated(device) {
    this.transports.delete(device.external_id);
    await this.publishStates();
    await this.publishTransports();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  /** Gladys asks for a refresh (onPoll, only if it polls anyway). */
  async pollDevice() {
    await this.pollNow();
  }

  /** Every device of the last read: [external id, values()] pairs. */
  *devices() {
    for (const backend of this.backends.values()) {
      yield [
        backendIds(this.gladys, backend.name).device,
        () => backendValues(this.gladys, backend),
      ];
      for (const server of backend.servers) {
        yield [
          serverIds(this.gladys, backend.name, server.name).device,
          () => serverValues(this.gladys, backend, server),
        ];
      }
    }
  }

  /**
   * The states of the added devices. The SDK skips the values Gladys already
   * has (and sends an unchanged one again after `heartbeatMs`).
   */
  async publishStates() {
    if (this.readAt === 0) {
      return; // never read: nothing to tell
    }
    const states = [];
    if (this.reachable) {
      for (const [externalId, values] of this.devices()) {
        if (this.isCreated(externalId)) {
          states.push(...values());
        }
      }
    }
    if (this.isCreated(proxyIds(this.gladys).device)) {
      states.push(
        ...proxyValues(this.gladys, {
          reachable: this.reachable,
          frontends: this.frontends,
          backends: [...this.backends.values()],
        }),
      );
    }
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.problems.recover('states', 'States accepted again');
    } catch (err) {
      this.problems.fail('states', `States refused: ${err.message}`);
    }
  }

  async afterChanges(widgetChanged, { publish = false } = {}) {
    await this.publishDevices({ force: publish });
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (widgetChanged) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  /** The badge of the added devices: local, or unreachable. */
  async publishTransports() {
    if (!this.client || this.readAt === 0) {
      return;
    }
    const transport = this.reachable ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
    const entries = [];
    const ids = [proxyIds(this.gladys).device, ...[...this.devices()].map(([id]) => id)];
    for (const externalId of ids) {
      if (this.isCreated(externalId) && this.transports.get(externalId) !== transport) {
        entries.push({ external_id: externalId, transport });
      }
    }
    for (let at = 0; at < entries.length; at += MAX_TRANSPORTS_PER_REQUEST) {
      const batch = entries.slice(at, at + MAX_TRANSPORTS_PER_REQUEST);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.transports.set(entry.external_id, entry.transport);
        }
        this.problems.recover('transports', 'Transports accepted again');
      } catch (err) {
        this.problems.fail('transports', `Transports refused: ${err.message}`);
      }
    }
  }

  /** The status under the integration name. */
  connectionStatus() {
    if (this.config.url === '') {
      return { connected: false, message: CONNECTION_TEXT.noUrl };
    }
    if (!this.config.url) {
      return { connected: false, message: CONNECTION_TEXT.invalidUrl };
    }
    if (this.error) {
      return { connected: false, message: ERROR_TEXT[this.error.kind] };
    }
    return { connected: true };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.problems.recover('connection', 'Connection status accepted again');
    } catch (err) {
      this.problems.fail('connection', `Connection status refused: ${err.message}`);
    }
  }

  // --- Views (widget, scene actions, report) -----------------------------------

  /** The backend of a device external id, null when it is not one of ours. */
  find(externalId) {
    if (typeof externalId !== 'string') {
      return null;
    }
    for (const backend of this.backends.values()) {
      if (backendIds(this.gladys, backend.name).device === externalId) {
        return backend;
      }
    }
    return null;
  }

  /** Throws the reason HAProxy cannot answer, if any. */
  assertReadable() {
    const status = this.connectionStatus();
    if (!status.connected) {
      throw new Error(pick(status.message, this.config.language));
    }
  }

  /** "Test the connection": read HAProxy now, one line. */
  async testConnection() {
    await this.pollNow({ publish: true });
    const message = {};
    const backends = [...this.backends.values()];
    const up = backends.reduce((sum, backend) => sum + backend.serversUp, 0);
    const total = backends.reduce((sum, backend) => sum + backend.serversTotal, 0);
    const down = backends.filter((backend) => !backend.available).length;
    for (const [language, text] of Object.entries(REPORT_TEXT)) {
      const status = this.connectionStatus();
      if (!status.connected) {
        message[language] = pick(status.message, language);
        continue;
      }
      const parts = [text.ok, text.backends(backends.length), text.servers(up, total)];
      if (down > 0) {
        parts.push(text.down(down));
      }
      message[language] = labelled('HAProxy', parts.join(', '), language);
    }
    return message;
  }
}
