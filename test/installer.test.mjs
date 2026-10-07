import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-installer-'));
const installer = resolve('bin/chatgpt-install.mjs');
const home = join(root, 'dsh');
const profile = join(root, 'profile');
const envPath = join(home, '.env');
const run = (...args) => execFileSync(process.execPath, [installer, '--profile', profile, '--dsh-home', home, ...args], { encoding: 'utf8', timeout: 30000 });
try {
  await mkdir(home, { recursive: true });
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), '{"name":"isolated-test-profile","dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n');
  const original = '# my proxy\r\nHTTPS_PROXY=http://other.invalid:8080\r\nKEEP=1';
  await writeFile(envPath, original);
  const preview = run('--unset-proxy', '--dry-run');
  assert.match(preview, /未改动/);
  assert.equal(await readFile(envPath, 'utf8'), original);
  assert.deepEqual(await readdir(profile), ['package.json'], 'dry-run must not create node_modules');
  run('--unset-proxy');
  assert.equal(await readFile(envPath, 'utf8'), original, 'unmarked user proxy must survive unset');
  run('--proxy', 'http://chosen.invalid:8080');
  const configured = await readFile(envPath, 'utf8');
  assert.ok(configured.startsWith(`${original}\r\n# BEGIN dsh-plugin-chatgpt-subscription proxy [joined]\r\n`));
  assert.match(configured, /HTTP_PROXY=http:\/\/chosen\.invalid:8080/);
  run('--unset-proxy');
  assert.equal(await readFile(envPath, 'utf8'), original, 'removal must restore CRLF file byte-for-byte');
  await writeFile(envPath, `${original}\r\n# BEGIN dsh-plugin-chatgpt-subscription proxy\r\nUSER_SETTING=keep\r\n`);
  run('--unset-proxy');
  assert.equal(await readFile(envPath, 'utf8'), `${original}\r\n# BEGIN dsh-plugin-chatgpt-subscription proxy\r\nUSER_SETTING=keep\r\n`, 'malformed marker must not erase user lines');
  console.log('ok   installer preserves user proxy and supports documented --dsh-home');
} finally {
  await rm(root, { recursive: true, force: true });
}
