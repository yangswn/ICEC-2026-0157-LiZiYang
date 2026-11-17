'use strict';

/* Run every test file in one Node process (works under restricted sandboxes
   where node:test's child-process runner is unavailable). */
require('./parser.test.js');
require('./store.test.js');
require('./scheduler.test.js');
require('./telemetry.test.js');
require('./single-instance.test.js');
require('./upgrade-preserve.test.js');
require('./overwrite-install.test.js');
require('./detail-enrichment.test.js');
require('./regression-1.6.1.test.js');
require('./tray-menu.test.js');
require('./regression-1.6.3.test.js');
require('./estimate.test.js');
require('./model-optin.test.js');
require('./model-toggle-ux.test.js');
require('./float-window.test.js');
require('./float-window-recover.test.js');
require('./occurrence-reset.test.js');
require('./state-reset-and-position.test.js');
require('./wrong-questions.test.js');
require('./media-proxy.test.js');
require('./toast-layout.test.js');