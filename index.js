// -----------------------------------------------------------------------------
// Entry point: SDK wiring only (src/handlers.js registers every handler BEFORE
// connect(), and delegates to the BeckerApp of src/app.js).
//
// The stops kept in /data leave at once (app.boot()), before Gladys is even
// reached: they need neither the configuration nor a first read.
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { BeckerApp } from './src/app.js';
import { registerHandlers } from './src/handlers.js';

const gladys = new GladysIntegration();
const app = new BeckerApp({ gladys });

registerHandlers(gladys, app, logger);
gladys.handleShutdown(() => app.stop());

logger.info('Starting the Becker CentralControl integration...');
app.boot().catch((err) => logger.error('Reading /data failed', err));
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
