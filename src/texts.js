// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, backend states, the "Test the connection"
// report, scene outputs. Four languages, the four of the Gladys interface;
// German says "du", Spanish "usted". test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './haproxy/client.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noUrl: {
    en: 'Enter the address of the HAProxy statistics in the configuration.',
    fr: "Saisissez l'adresse des statistiques HAProxy dans la configuration.",
    de: 'Gib die Adresse der HAProxy-Statistiken in der Konfiguration ein.',
    es: 'Introduzca la dirección de las estadísticas de HAProxy en la configuración.',
  },
  invalidUrl: {
    en: 'Address not understood, e.g. http://192.168.1.2:8404/stats (socket: 192.168.1.2:9999)',
    fr: 'Adresse incomprise, ex. http://192.168.1.2:8404/stats (socket : 192.168.1.2:9999)',
    de: 'Adresse nicht verstanden, z. B. http://192.168.1.2:8404/stats (Socket: 192.168.1.2:9999)',
    es: 'Dirección no válida, p. ej. http://192.168.1.2:8404/stats (socket: 192.168.1.2:9999)',
  },
};

// One short explanation per error kind (src/haproxy/client.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'HAProxy does not answer',
    fr: 'HAProxy ne répond pas',
    de: 'HAProxy antwortet nicht',
    es: 'HAProxy no responde',
  },
  [ERROR_KINDS.TLS]: {
    en: 'certificate refused: use an http:// address or a trusted certificate',
    fr: 'certificat refusé : utilisez une adresse http:// ou un certificat reconnu',
    de: 'Zertifikat abgelehnt: Nutze eine http://-Adresse oder ein vertrauenswürdiges Zertifikat',
    es: 'certificado rechazado: use una dirección http:// o un certificado reconocido',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'user or password refused',
    fr: 'utilisateur ou mot de passe refusé',
    de: 'Benutzer oder Passwort abgelehnt',
    es: 'usuario o contraseña rechazados',
  },
  [ERROR_KINDS.NOT_HAPROXY]: {
    en: 'no HAProxy statistics at this address (check the address and the source)',
    fr: "pas de statistiques HAProxy à cette adresse (vérifiez l'adresse et la source)",
    de: 'keine HAProxy-Statistiken unter dieser Adresse (prüfe Adresse und Quelle)',
    es: 'no hay estadísticas de HAProxy en esta dirección (compruebe la dirección y la fuente)',
  },
  [ERROR_KINDS.REDIRECT]: {
    en: 'the address redirects: enter the https:// address',
    fr: "l'adresse redirige : saisissez l'adresse en https://",
    de: 'die Adresse leitet um: Gib die https://-Adresse ein',
    es: 'la dirección redirige: introduzca la dirección https://',
  },
  [ERROR_KINDS.HTTP]: {
    en: 'unexpected answer, see the logs',
    fr: 'réponse inattendue, voir les logs',
    de: 'unerwartete Antwort, sieh in den Protokollen nach',
    es: 'respuesta inesperada, consulte los registros',
  },
};

// The state of a backend, in words (widget rows, scene outputs).
export const STATE_TEXT = {
  up: { en: 'OK', fr: 'OK', de: 'OK', es: 'OK' },
  degraded: { en: 'Degraded', fr: 'Dégradé', de: 'Eingeschränkt', es: 'Degradado' },
  down: { en: 'Down', fr: 'En panne', de: 'Ausgefallen', es: 'Caído' },
};

// The "Test the connection" report and the sentences of the scene actions.
export const REPORT_TEXT = {
  en: {
    ok: 'Connected',
    backends: (count) => `${count} backend(s)`,
    servers: (up, total) => `${up}/${total} server(s) up`,
    down: (count) => `${count} backend(s) down`,
    healthy: 'everything is fine',
    unreachable: 'HAProxy does not answer',
  },
  fr: {
    ok: 'Connecté',
    backends: (count) => `${count} backend(s)`,
    servers: (up, total) => `${up}/${total} serveur(s) en service`,
    down: (count) => `${count} backend(s) en panne`,
    healthy: 'tout va bien',
    unreachable: 'HAProxy ne répond pas',
  },
  de: {
    ok: 'Verbunden',
    backends: (count) => `${count} Backend(s)`,
    servers: (up, total) => `${up}/${total} Server erreichbar`,
    down: (count) => `${count} Backend(s) ausgefallen`,
    healthy: 'alles in Ordnung',
    unreachable: 'HAProxy antwortet nicht',
  },
  es: {
    ok: 'Conectado',
    backends: (count) => `${count} backend(s)`,
    servers: (up, total) => `${up}/${total} servidor(es) activo(s)`,
    down: (count) => `${count} backend(s) caído(s)`,
    healthy: 'todo está bien',
    unreachable: 'HAProxy no responde',
  },
};

export const ACTION_TEXT = {
  unknownBackend: {
    en: 'This device is not an HAProxy backend.',
    fr: "Cet appareil n'est pas un backend HAProxy.",
    de: 'Dieses Gerät ist kein HAProxy-Backend.',
    es: 'Este dispositivo no es un backend de HAProxy.',
  },
};

export const LANGUAGE_FALLBACK = 'en';

/** "Name: text", with the space French puts before a colon. */
export const labelled = (name, text, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${text}`;
export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];
