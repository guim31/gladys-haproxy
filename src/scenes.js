// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// "Is this backend available?" is already a scene condition on the device
// feature. The actions are about what a condition cannot do: put the state in
// a message ("app: degraded, 1/2 server(s) up (app2: DOWN)"), and sum up the
// whole HAProxy — backends down and servers out, added to Gladys or not, or
// that HAProxy does not answer. Both read HAProxy again when the last read is
// older than 15 seconds. The integration is read-only: nothing to command.
// -----------------------------------------------------------------------------

import { stateOf } from './devices.js';
import { ACTION_TEXT, REPORT_TEXT, STATE_TEXT, labelled, pick } from './texts.js';

// Names listed in a text output, at most (the rest is counted).
export const MAX_LISTED_NAMES = 20;

const listed = (names) => {
  const shown = names.slice(0, MAX_LISTED_NAMES);
  return names.length > shown.length
    ? `${shown.join(', ')}, +${names.length - shown.length}`
    : shown.join(', ');
};

const byName = (a, b) => a.localeCompare(b);

export const SCENE_ACTIONS = {
  async get_backend_status(hub, { fields = {} }) {
    if (!hub.client) {
      hub.assertReadable(); // no address: the configuration to fix
    }
    await hub.refreshIfStale();
    hub.assertReadable();
    const language = hub.config.language;
    const backend = hub.find(fields.device);
    if (!backend) {
      throw new Error(pick(ACTION_TEXT.unknownBackend, language));
    }
    const text = REPORT_TEXT[language] ?? REPORT_TEXT.en;
    const state = pick(STATE_TEXT[stateOf(backend)], language);
    const out = backend.servers
      .filter((server) => !server.online)
      .map((server) => labelled(server.name, server.status, language))
      .sort(byName);
    const servers = text.servers(backend.serversUp, backend.serversTotal);
    return {
      available: backend.available,
      state,
      servers_up: backend.serversUp,
      servers_total: backend.serversTotal,
      sessions: backend.sessions,
      servers_out: listed(out),
      sentence: `${labelled(backend.name, state, language)}, ${servers}${
        out.length > 0 ? ` (${listed(out)})` : ''
      }.`,
    };
  },

  async get_proxy_status(hub) {
    if (!hub.client) {
      hub.assertReadable(); // no address: the configuration to fix
    }
    await hub.refreshIfStale();
    const language = hub.config.language;
    const text = REPORT_TEXT[language] ?? REPORT_TEXT.en;
    if (hub.error || !hub.reachable) {
      // "HAProxy does not answer" is an answer: the scene goes on with it.
      return {
        reachable: false,
        backends_down: 0,
        names: '',
        servers_up: 0,
        servers_total: 0,
        sentence: `${labelled('HAProxy', text.unreachable, language)}.`,
      };
    }
    const backends = [...hub.backends.values()];
    const down = backends
      .filter((backend) => !backend.available)
      .map((backend) => backend.name)
      .sort(byName);
    const up = backends.reduce((sum, backend) => sum + backend.serversUp, 0);
    const total = backends.reduce((sum, backend) => sum + backend.serversTotal, 0);
    const parts = [];
    if (down.length > 0) {
      parts.push(`${text.down(down.length)} (${listed(down)})`);
    }
    if (up < total || down.length > 0) {
      parts.push(text.servers(up, total));
    }
    return {
      reachable: true,
      backends_down: down.length,
      names: listed(down),
      servers_up: up,
      servers_total: total,
      sentence: `${labelled('HAProxy', parts.length > 0 ? parts.join(', ') : text.healthy, language)}.`,
    };
  },
};
