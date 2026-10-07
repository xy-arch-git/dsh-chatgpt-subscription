#!/usr/bin/env node
/**
 * Install the ChatGPT subscription plugin into a DSH profile.
 *
 * Does everything the profile needs, idempotently, and backs up every file it
 * touches:
 *
 *   1. copies the plugin into the profile's `node_modules`
 *   2. adds it to the profile's `package.json` dependency + `dsh.profile.bundles`
 *   3. optionally writes proxy variables into `$DSH_HOME/.env` so the DSH host
 *      routes its outbound model traffic through the proxy
 *
 * A DSH restart is required afterwards, because profile bundles are composed at
 * boot.
 *
 *   node bin/chatgpt-install.mjs --profile <dir> [--proxy URL | --unset-proxy] [--dry-run]
 */

import { parseArgs } from 'node:util';
import { cp, mkdir, readFile, writeFile, access, symlink, lstat, rm } from 'node:fs/promises';
import { constants, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');

const { values } = parseArgs({
  options: {
    profile: { type: 'string' },
    'dsh-home': { type: 'string' },
    proxy: { type: 'string' },
    'unset-proxy': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
});

const PLUGIN_NAME = 'dsh-plugin-chatgpt-subscription';

if (values.help === true || typeof values.profile !== 'string') {
  process.stdout.write(
    [
      'Usage: node bin/chatgpt-install.mjs --profile <profile-dir> [options]',
      '',
      '  --profile DIR    DSH profile directory, e.g. $DSH_HOME/profiles/web',
      '  --dsh-home DIR   DSH home; defaults to the profile\'s grandparent',
      '  --proxy URL      route the DSH host through this proxy (opt-in; see below)',
      '  --unset-proxy    remove the proxy block a previous run of this script wrote',
      '  --dry-run        report the changes without writing anything',
      '',
      'No proxy is configured unless you pass --proxy. Setting one routes ALL of the',
      'DSH host\'s outbound traffic through it, not just OpenAI traffic, so an',
      'unstable proxy also breaks every other provider the host talks to.',
      '',
    ].join('\n'),
  );
  process.exit(values.help === true ? 0 : 1);
}

const profileDir = resolve(values.profile);
const dshHome = values['dsh-home'] !== undefined ? resolve(values['dsh-home']) : dirname(dirname(profileDir));
const dryRun = values['dry-run'] === true;

/** Lines describing what happened, for the final report. */
const report = [];

/**
 * Whether a path exists *and* its symlink target resolves.
 *
 * The shipped profile contains symlinks into `resources/app/node_modules`,
 * which only the Harness loader can follow (that tree lives inside `app.asar`).
 * Plain `access()` reports ENOENT for them, so a link that fails to resolve
 * must not be treated as an available dependency.
 *
 * @param path - the path to test.
 * @returns true when the path resolves to something real.
 */
async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    // ELOOP/ENOENT from a broken symlink, or a genuine absence.
    void error;
    return false;
  }
}

/**
 * Locate the Electron app's unbundled `node_modules`.
 *
 * `@deepseek-ai/*` packages inside `app.asar` are exposed at
 * `resources/app.asar.unpacked/node_modules`, which is a real directory tree
 * Node can import from. That directory is usually *not* an ancestor of the
 * profile, so it is probed explicitly rather than only by walking up.
 *
 * @returns the unpacked `node_modules` path, or undefined.
 */
function findUnpackedNodeModules() {
  const suffixes = [
    join('resources', 'app.asar.unpacked', 'node_modules'),
    join('app.asar.unpacked', 'node_modules'),
  ];
  // Conventional install locations for the desktop app, not paths on any
  // particular machine. `DSH_APP_ROOT` overrides all of them; the walk below
  // covers profiles kept beside the app.
  const appRoots = [
    process.env.DSH_APP_ROOT,
    '/opt/dsh-desktop',
    join(homedir(), 'Applications', 'dsh-desktop'),
    '/Applications/dsh-desktop',
    '/usr/lib/dsh-desktop',
  ].filter((root) => typeof root === 'string' && root.length > 0);

  // Also consider anything reachable by walking up from the profile.
  const walkRoots = [];
  for (let dir = resolve(profileDir); ; dir = dirname(dir)) {
    walkRoots.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
  }

  for (const root of [...appRoots, ...walkRoots]) {
    for (const suffix of suffixes) {
      const candidate = join(root, suffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Synchronous existence probe used while locating the app tree.
 * @param path - the path to test.
 * @returns true when it exists.
 */
function existsSync(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a file, first copying any existing content to `<path>.bak-<stamp>`.
 * @param path - destination.
 * @param content - new content.
 * @param stamp - backup suffix.
 */
async function writeWithBackup(path, content, stamp) {
  if (dryRun) {
    report.push(`   would write ${path}`);
    return;
  }
  if (await exists(path)) {
    const backup = `${path}.bak-${stamp}`;
    await cp(path, backup);
    report.push(`   备份 ${backup}`);
  }
  await writeFile(path, content);
}

/**
 * Delete a file this installer owns, after backing it up.
 * @param path - the file to remove.
 * @param stamp - backup suffix shared by every write in this run.
 */
async function removeWithBackup(path, stamp) {
  if (dryRun) {
    report.push(`   would remove ${path}`);
    return;
  }
  if (await exists(path)) {
    const backup = `${path}.bak-${stamp}`;
    await cp(path, backup);
    report.push(`   备份 ${backup}`);
  }
  await rm(path, { force: true });
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

process.stdout.write(`\n安装 ChatGPT 订阅插件\n  插件源：${pluginRoot}\n  profile：${profileDir}\n  DSH home：${dshHome}\n\n`);

if (!(await exists(profileDir))) {
  process.stderr.write(`错误：profile 目录不存在：${profileDir}\n`);
  process.exit(1);
}

// 1. Copy the plugin into the profile's node_modules.
const target = join(profileDir, 'node_modules', PLUGIN_NAME);
if (!dryRun) await mkdir(dirname(target), { recursive: true });
if (dryRun) {
  report.push(`   would copy ${pluginRoot} -> ${target}`);
} else {
  /** Keep only runtime material: source, CLIs, and the bundle patch. */
  const SKIP = new Set(['refs', 'test', 'node_modules', '.git']);
  // Replace rather than merge: a stale file left by a previous install (or by
  // an earlier version of this plugin) would otherwise survive forever.
  await rm(target, { recursive: true, force: true });
  await cp(pluginRoot, target, {
    recursive: true,
    force: true,
    filter: (source) => {
      if (source === pluginRoot) return true;
      const relative = source.slice(pluginRoot.length + 1);
      const top = relative.split('/')[0];
      return !SKIP.has(top);
    },
  });
  report.push(`已复制插件到 ${target}`);
}

// 2. Make the harness packages resolvable from the profile.
//
// Node stops walking up at the first `node_modules` that contains the scope
// directory. A profile usually has an empty `node_modules/@deepseek-ai/`, which
// shadows the populated one a level up in `profiles/node_modules`, so the
// plugin's imports of `@deepseek-ai/dsh-llm` and friends would fail at load.
// Linking just the packages this plugin imports fixes resolution.
const REQUIRED_DEPS = ['dsh-llm', 'schemastery', 'cordis'];
const scopeDir = join(profileDir, 'node_modules', '@deepseek-ai');
if (!dryRun) await mkdir(scopeDir, { recursive: true });
for (const dep of REQUIRED_DEPS) {
  const linkPath = join(scopeDir, dep);
  if (await exists(linkPath)) {
    report.push(`@deepseek-ai/${dep} 已可解析，跳过`);
    continue;
  }
  // Search this profile, then each ancestor `node_modules`, for a real
  // installation to link to — skipping the scope directory we are filling.
  const candidates = [];
  for (let dir = resolve(profileDir); ; dir = dirname(dir)) {
    candidates.push(join(dir, 'node_modules', '@deepseek-ai', dep));
    const parent = dirname(dir);
    if (parent === dir) break;
  }
  let source;
  for (const candidate of candidates) {
    if (resolve(candidate) === resolve(linkPath)) continue;
    if (await exists(candidate)) {
      source = resolve(candidate);
      break;
    }
  }
  if (source === undefined) {
    // Fall back to the app's unpacked tree, where these packages really live and
    // where plain Node can import them from.
    const unpacked = findUnpackedNodeModules();
    if (unpacked !== undefined) {
      const candidate = join(unpacked, '@deepseek-ai', dep);
      if (await exists(candidate)) source = candidate;
    }
  }
  if (source === undefined) {
    report.push(`⚠ 找不到 @deepseek-ai/${dep}，插件加载可能失败`);
    continue;
  }
  if (dryRun) {
    report.push(`   would link ${linkPath} -> ${source}`);
    continue;
  }
  // A pre-existing dangling symlink would make symlink() fail with EEXIST.
  try {
    await lstat(linkPath);
    await rm(linkPath, { force: true });
  } catch {
    // nothing to clear
  }
  try {
    await symlink(source, linkPath, 'dir');
    report.push(`已链接 @deepseek-ai/${dep} -> ${source}`);
  } catch (error) {
    // A concurrent install may have created it; only real failures matter.
    if (!(await exists(linkPath))) throw error;
    report.push(`@deepseek-ai/${dep} 已存在（并发创建），跳过`);
  }
}

// 3. Register the bundle in the profile manifest.
const manifestPath = join(profileDir, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.dependencies ??= {};
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];

let manifestChanged = false;
if (manifest.dependencies[PLUGIN_NAME] === undefined) {
  manifest.dependencies[PLUGIN_NAME] = `file:./node_modules/${PLUGIN_NAME}`;
  manifestChanged = true;
}
if (!manifest.dsh.profile.bundles.includes(PLUGIN_NAME)) {
  manifest.dsh.profile.bundles.push(PLUGIN_NAME);
  manifestChanged = true;
}

if (manifestChanged) {
  await writeWithBackup(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, stamp);
  report.push(`已在 package.json 注册 bundle：${PLUGIN_NAME}`);
} else {
  report.push(`package.json 已包含 ${PLUGIN_NAME}，跳过`);
}

// 4. Optionally record a proxy for the DSH host process.
//
// Opt-in on purpose. The host installs a global fetch dispatcher from these
// variables, so whatever is written here covers *every* provider the host talks
// to — an unstable proxy then takes down unrelated models too. Nothing is
// written unless the caller asks for it.
const envPath = join(dshHome, '.env');
// Only a balanced, uniquely marked block belongs to this installer. Legacy
// unmarked proxy lines may be user-owned; never guess and delete them.
const PROXY_BEGIN = '# BEGIN dsh-plugin-chatgpt-subscription proxy';
const PROXY_END = '# END dsh-plugin-chatgpt-subscription proxy';
function stripOwnedProxyBlock(text) {
  const pattern = /^# BEGIN dsh-plugin-chatgpt-subscription proxy( \[joined\])?\r?\n# NOTE: this covers ALL host outbound traffic, not just OpenAI\.\r?\nHTTPS_PROXY=[^\r\n]*\r?\nHTTP_PROXY=[^\r\n]*\r?\nNO_PROXY=127\.0\.0\.1,localhost,::1\r?\n# END dsh-plugin-chatgpt-subscription proxy\r?(?:\n|$)/gm;
  const match = pattern.exec(text);
  if (!match) return { text, found: false };
  // [joined] records the one newline we inserted when the original .env had
  // no trailing newline, so removal restores its exact original bytes.
  const separator = text.slice(0, match.index).endsWith('\r\n') ? '\r\n' : '\n';
  if (match[1] && match.index === 0) return { text, found: false };
  const start = match[1] ? match.index - separator.length : match.index;
  return { text: text.slice(0, start) + text.slice(match.index + match[0].length), found: true };
}

if (values['unset-proxy'] === true) {
  const existing = (await exists(envPath)) ? await readFile(envPath, 'utf8') : '';
  const { text: next, found } = stripOwnedProxyBlock(existing);
  if (!found) {
    report.push(`未在 ${envPath} 找到本脚本写入的代理配置，未改动`);
  } else if (next.length === 0) {
    // The file held nothing but our marked block.
    if (dryRun) {
      report.push(`（dry-run）将删除 ${envPath}`);
    } else {
      await removeWithBackup(envPath, stamp);
      report.push(`已删除 ${envPath}（其中只有本脚本写入的代理配置）`);
    }
  } else if (dryRun) {
    report.push(`（dry-run）将从 ${envPath} 移除本脚本代理配置`);
  } else {
    await writeWithBackup(envPath, next, stamp);
    report.push(`已从 ${envPath} 移除本脚本代理配置`);
  }
} else if (typeof values.proxy === 'string') {
  const proxy = values.proxy;
  const existing = (await exists(envPath)) ? await readFile(envPath, 'utf8') : '';
  const kept = stripOwnedProxyBlock(existing).text;
  const joined = kept.length > 0 && !kept.endsWith('\n');
  const newline = kept.includes('\r\n') ? '\r\n' : '\n';
  const block = [
    `${PROXY_BEGIN}${joined ? ' [joined]' : ''}`,
    '# NOTE: this covers ALL host outbound traffic, not just OpenAI.',
    `HTTPS_PROXY=${proxy}`,
    `HTTP_PROXY=${proxy}`,
    'NO_PROXY=127.0.0.1,localhost,::1',
    PROXY_END,
    '',
  ].join(newline);
  const next = `${kept}${joined ? newline : ''}${block}`;
  if (dryRun) {
    report.push(`（dry-run）将写入代理配置到 ${envPath}`);
  } else if (next !== existing) {
    await writeWithBackup(envPath, next, stamp);
    report.push(`已写入代理配置到 ${envPath}`);
  } else {
    report.push(`代理配置已在 ${envPath}，未改动`);
  }
} else {
  report.push('未配置代理（如需请显式传 --proxy URL；这会接管宿主所有出站流量）');
}

// 5. Verify the installed copy actually loads and registers its route.
//
// Module resolution inside a profile is not the same as inside the workspace:
// an empty `node_modules/@deepseek-ai/` shadows the populated one above it, and
// the shipped symlinks point into `app.asar`. Loading the plugin against the
// real runtime here turns a broken install into a visible failure now instead
// of a profile that will not boot later.
let verified;
if (dryRun) {
  verified = { ok: true, detail: '（dry-run 跳过加载自检）' };
} else {
  try {
    const module = await import(pathToFileURL(join(target, 'src', 'index.mjs')).href);
    const { Context } = await import(pathToFileURL(join(scopeDir, 'cordis', 'lib', 'index.js')).href);
    const { LlmRuntime } = await import(pathToFileURL(join(scopeDir, 'dsh-llm', 'lib', 'index.js')).href);
    const root = new Context();
    const runtime = new LlmRuntime(root);
    module.apply(
      {
        llm: root.llm,
        logger: { info: () => {}, warn: () => {} },
        fiber: { entry: { options: { id: PLUGIN_NAME } } },
        on: () => () => {},
        inject: () => {},
      },
      module.Config({}),
    );
    const routes = runtime.listProviders().map((provider) => provider.id);
    if (!routes.includes(module.PROVIDER)) {
      verified = { ok: false, detail: `路由未注册：${routes.join(', ') || '(空)'}` };
    } else {
      verified = { ok: true, detail: `路由 ${module.PROVIDER} 与 ${routes.length} 个 provider 已注册` };
    }
  } catch (error) {
    verified = { ok: false, detail: error.message };
  }
}

process.stdout.write(`${report.map((line) => `  ${line}`).join('\n')}\n`);
process.stdout.write(`  ${verified.ok ? '✓' : '✗'} 加载自检：${verified.detail}\n`);
if (!verified.ok) {
  process.stderr.write(
    [
      '',
      '插件加载失败，重启 DSH 会导致整个 profile 起不来，请先修复。',
      '常见原因：profile 里 @deepseek-ai 依赖链接缺失或指向 asar 内路径。',
      '可以手动重跑本脚本，或检查 profile 的 node_modules/@deepseek-ai/ 下的链接是否可解析。',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

process.stdout.write(
  [
    '',
    '下一步：',
    '  1. 自检出口地区（必须先通过，否则登录会以地区不受支持失败）：',
    `       node ${join(target, 'bin', 'chatgpt-doctor.mjs')}`,
    '  2. 登录 ChatGPT 订阅：',
    `       node ${join(target, 'bin', 'chatgpt-login.mjs')}`,
    '  3. 重启 DSH 桌面端（profile bundle 只在启动时组合）。',
    '  4. 打开模型选择器，应能看到 “ChatGPT 订阅” 分组。',
    '',
  ].join('\n'),
);
