// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container. Every handler is registered
// before connect(). Read-only: no command handler, no pricing handler (the
// contracts are priced by the Gladys rule engine from the calendar).
// -----------------------------------------------------------------------------

import { ACTION_TEST } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Configuration screen button.
  gladys.onAction(ACTION_TEST, () => app.testKey());

  // Configuration saved by the user: a new key is tried at once (never sooner
  // than a minute after the last request).
  gladys.onConfigUpdated((config) => app.configure(config));

  // Every connection (the first one and each reconnection): /data once, the
  // configuration read again (retried for ever), the status sent again, the
  // reads when due (never sooner than their gap).
  gladys.on('connected', async () => {
    try {
      await app.connected();
    } catch (err) {
      logger?.error(`Start failed (${err?.name ?? 'Error'})`);
    }
  });
  gladys.on('disconnected', () => {
    app.stop().catch((err) => logger?.error(`Stop failed (${err?.name ?? 'Error'})`));
  });
  gladys.handleShutdown(() => app.stop());
}
