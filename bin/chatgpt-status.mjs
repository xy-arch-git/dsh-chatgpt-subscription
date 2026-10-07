#!/usr/bin/env node
/**
 * Report whether the ChatGPT subscription provider is signed in.
 *
 *   node bin/chatgpt-status.mjs [--auth-file PATH]
 */

import { parseArgs } from 'node:util';
import { inspect } from '../src/index.mjs';

const { values } = parseArgs({
  options: {
    'auth-file': { type: 'string' },
    'codex-home': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
});

if (values.help === true) {
  process.stdout.write('Usage: node bin/chatgpt-status.mjs [--auth-file PATH] [--codex-home DIR]\n');
  process.exit(0);
}

const status = await inspect({
  authFile: values['auth-file'],
  codexHome: values['codex-home'],
});

process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
process.exit(status.signedIn === true && status.expired !== true ? 0 : 1);
