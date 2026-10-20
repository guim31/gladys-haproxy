// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `haproxy`.
//
// The use case: a glance at the wall tablet tells whether the services behind
// HAProxy have their servers, and which server is out. So the widget shows the
// backends down, the servers out and the backends working, then one row per
// backend — down first, then degraded, then the others — with its servers up,
// and the servers out with their HAProxy status.
//
// Every backend by default, or the ones chosen in the widget settings
// (devices added to Gladys). The figures are sent as values, not bound to
// device features: the widget works before the devices are added.
//
// Budget (8 components, 2 texts): three tiles, one text when HAProxy does not
// answer, two status lists (backends, servers out), a Refresh button.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { stateOf } from './devices.js';
import { WIDGET_KEY } from './hub.js';
import { ERROR_TEXT, STATE_TEXT, pick } from './texts.js';

// Action key of the button: permanent once published.
export const ACTIONS = Object.freeze({ REFRESH: 'refresh' });

export const MAX_ROWS = 10;
export const MAX_SERVER_ROWS = 6;

export const TEXT = {
  pick: {
    en: 'Enter the address of the HAProxy statistics in the configuration of the integration.',
    fr: "Saisissez l'adresse des statistiques HAProxy dans la configuration de l'intégration.",
    de: 'Gib die Adresse der HAProxy-Statistiken in der Konfiguration der Integration ein.',
    es: 'Introduzca la dirección de las estadísticas de HAProxy en la configuración de la integración.',
  },
  empty: {
    en: 'No backend with servers in HAProxy.',
    fr: 'Aucun backend avec des serveurs dans HAProxy.',
    de: 'Kein Backend mit Servern in HAProxy.',
    es: 'Ningún backend con servidores en HAProxy.',
  },
  down: { en: 'Backends down', fr: 'Backends KO', de: 'Backends aus', es: 'Backends KO' },
  out: { en: 'Servers out', fr: 'Serveurs HS', de: 'Server aus', es: 'Servidores KO' },
  up: { en: 'Backends OK', fr: 'Backends OK', de: 'Backends OK', es: 'Backends OK' },
  more: { en: 'Others', fr: 'Autres', de: 'Weitere', es: 'Otros' },
  refresh: { en: 'Refresh', fr: 'Actualiser', de: 'Aktualisieren', es: 'Actualizar' },
  refreshed: {
    en: 'HAProxy read again.',
    fr: 'HAProxy relu.',
    de: 'HAProxy neu gelesen.',
    es: 'HAProxy leído de nuevo.',
  },
};

// Row order: what needs attention first.
const SEVERITY = ['down', 'degraded', 'up'];

const ROW_STYLE = {
  down: { icon: 'x-circle', color: WIDGET_COLORS.DANGER },
  degraded: { icon: 'alert-triangle', color: WIDGET_COLORS.WARNING },
  up: { icon: 'check-circle', color: WIDGET_COLORS.SUCCESS },
};

const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function message(text, language) {
  return {
    ttl_seconds: 300,
    components: [{ type: 'text', variant: 'body', text: pick(text, language) }],
  };
}

/** The backends the widget shows: the chosen devices, or every backend. */
export function selectBackends(hub, settings) {
  const chosen = [settings?.backends ?? []].flat().filter((id) => typeof id === 'string' && id);
  if (chosen.length === 0) {
    return [...hub.backends.values()];
  }
  return [...new Set(chosen)].map((id) => hub.find(id)).filter(Boolean);
}

export function sortBackends(backends) {
  return [...backends].sort(
    (a, b) =>
      SEVERITY.indexOf(stateOf(a)) - SEVERITY.indexOf(stateOf(b)) || a.name.localeCompare(b.name),
  );
}

/** A status list, the last row counting what did not fit. */
function statusList(rows, max, language) {
  const shown = rows.length > max ? rows.slice(0, max - 1) : rows;
  const items = [...shown];
  if (rows.length > shown.length) {
    items.push({
      label: pick(TEXT.more, language),
      value: `+${rows.length - shown.length}`,
      icon: 'more-horizontal',
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  return { type: 'status', items };
}

async function get(hub, { settings, language = 'en' }) {
  if (!hub.client) {
    return message(TEXT.pick, language);
  }
  const backends = sortBackends(selectBackends(hub, settings));
  if (backends.length === 0 && !hub.error) {
    return message(TEXT.empty, language);
  }

  const down = backends.filter((backend) => stateOf(backend) === 'down').length;
  const out = backends.flatMap((backend) =>
    backend.servers
      .filter((server) => !server.online)
      .map((server) => ({ backend: backend.name, ...server })),
  );
  const components = [
    {
      type: 'value',
      value: down,
      label: pick(TEXT.down, language),
      icon: 'x-circle',
      color: down > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
    },
    {
      type: 'value',
      value: out.length,
      label: pick(TEXT.out, language),
      icon: 'alert-triangle',
      color: out.length > 0 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
    },
    {
      type: 'value',
      value: backends.length - down,
      label: pick(TEXT.up, language),
      icon: 'check-circle',
      color: WIDGET_COLORS.SUCCESS,
    },
  ];

  if (hub.error) {
    components.push({
      type: 'text',
      variant: 'body',
      text: pick(ERROR_TEXT[hub.error.kind], language),
    });
  }

  if (backends.length > 0) {
    const rows = backends.map((backend) => ({
      label: fit(backend.name, 40),
      value: fit(
        `${pick(STATE_TEXT[stateOf(backend)], language)} · ${backend.serversUp}/${backend.serversTotal}`,
        40,
      ),
      ...ROW_STYLE[stateOf(backend)],
    }));
    components.push(statusList(rows, MAX_ROWS, language));
  }

  if (out.length > 0) {
    const rows = out.map((server) => ({
      label: fit(`${server.backend}/${server.name}`, 40),
      value: fit([server.status, server.check].filter(Boolean).join(' · ') || '-', 40),
      icon: server.status.startsWith('MAINT') ? 'tool' : 'x-circle',
      color: server.status.startsWith('MAINT') ? WIDGET_COLORS.NEUTRAL : WIDGET_COLORS.WARNING,
    }));
    components.push(statusList(rows, MAX_SERVER_ROWS, language));
  }

  components.push({
    type: 'button',
    label: pick(TEXT.refresh, language),
    icon: 'refresh-cw',
    style: 'secondary',
    action: { key: ACTIONS.REFRESH },
  });

  // Something broken moves: refresh sooner.
  const moving = hub.error || down > 0 || out.length > 0;
  return { ttl_seconds: moving ? 30 : 60, components };
}

async function action(hub, { actionKey }) {
  if (actionKey !== ACTIONS.REFRESH) {
    throw new Error(`Unknown action ${actionKey}`);
  }
  await hub.pollNow();
  if (hub.error) {
    return { message: ERROR_TEXT[hub.error.kind] };
  }
  return { message: TEXT.refreshed };
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
