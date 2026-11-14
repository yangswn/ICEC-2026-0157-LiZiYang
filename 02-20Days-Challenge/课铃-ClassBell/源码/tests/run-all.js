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
