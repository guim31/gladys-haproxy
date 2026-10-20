// -----------------------------------------------------------------------------
// Repeated failures write one line when they start (or change) and one when
// they end, never one per attempt: the debug level keeps the rest.
//
// Used for what fails again at every reading cycle: Gladys refusing states,
// transports or the connection status, a failing reading loop, /data that
// cannot be written. (HAProxy not answering is already reported once per
// kind of error by the hub.) (From guim31/gladys-uptime-kuma.)
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const defaultLogger = createLogger({ name: 'haproxy' });

export class ProblemLog {
  /** @param {{ debug: Function, info: Function, warn: Function, error: Function }} [log] */
  constructor(log = defaultLogger) {
    this.log = log;
    /** @type {Map<string, string>} the message last logged, per problem key */
    this.active = new Map();
  }

  /**
   * A failure: logged at `level` the first time (or when the message
   * changes), at debug after.
   * @returns {boolean} true when logged at `level`
   */
  fail(key, message, level = 'warn') {
    if (this.active.get(key) === message) {
      this.log.debug(message);
      return false;
    }
    this.active.set(key, message);
    this.log[level](message);
    return true;
  }

  /**
   * The problem is over: `message` (info) when one was logged, nothing
   * otherwise.
   * @returns {boolean} true if the problem was active
   */
  recover(key, message) {
    if (!this.active.delete(key)) {
      return false;
    }
    if (message) {
      this.log.info(message);
    }
    return true;
  }
}
