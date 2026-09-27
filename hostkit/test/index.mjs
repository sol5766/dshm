/**
 * Test entry point.
 *
 * Why this file exists: `node --test test/` (the command documented in the task book) resolves the
 * directory to its `index` on some Node builds — including Node 22.20 on Windows, where it fails with
 * `Cannot find module …\test`. Importing every suite here makes both `node --test` (auto-discovery)
 * and `node --test test/` work, without changing what the suites do.
 *
 * The imports are static (not dynamic) so a syntax error in a suite fails loudly at load time rather
 * than being reported as a missing test.
 */

import './crypto.test.mjs';
import './frames.test.mjs';
import './ws.test.mjs';
import './pairing.test.mjs';
import './whitelist.test.mjs';
import './audit.test.mjs';
import './qr.test.mjs';
import './config.test.mjs';
import './hostproc.test.mjs';
import './proxy.test.mjs';
import './discovery.test.mjs';
import './tunnel.e2e.test.mjs';
import './cli.test.mjs';
