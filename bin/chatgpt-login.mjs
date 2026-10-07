#!/usr/bin/env node
/**
 * Device-code sign-in for the ChatGPT subscription provider.
 *
 * Mirrors `codex login` so either tool can consume the credential file the
 * other wrote. Run it from a terminal; it prints a URL and a one-time code,
 * then waits for the browser step to finish.
 *
 *   node bin/chatgpt-login.mjs [--auth-file PATH] [--issuer URL]
 */

import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { authFilePath, readIdTokenClaims, saveCredentials } from '../src/auth-store.mjs';
import { DEFAULT_ISSUER, exchangeAuthorizationCode, pollForAuthorization, requestDeviceCode } from '../src/oauth.mjs';

const { values } = parseArgs({
  options: {
    'auth-file': { type: 'string' },
    'codex-home': { type: 'string' },
    issuer: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
});

if (values.help === true) {
  process.stdout.write(
    [
      'Usage: node bin/chatgpt-login.mjs [options]',
      '',
      '  --auth-file PATH    credential file to write (default: $CODEX_HOME/auth.json)',
      '  --codex-home DIR    Codex home directory',
      '  --issuer URL        OAuth issuer (default: https://auth.openai.com)',
      '',
      'Signs in with a ChatGPT account so the ChatGPT subscription provider can',
      'reach the Codex backend. A subscription is required; API credit is not used.',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

/**
 * Resolve the credential path from flags, then the environment.
 * @returns an absolute path.
 */
function targetPath() {
  if (typeof values['auth-file'] === 'string' && values['auth-file'].length > 0) return values['auth-file'];
  const home =
    typeof values['codex-home'] === 'string' && values['codex-home'].length > 0
      ? values['codex-home']
      : process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0
        ? process.env.CODEX_HOME
        : join(homedir(), '.codex');
  return authFilePath(join(home, 'auth.json'));
}

const path = targetPath();
const issuer = typeof values.issuer === 'string' && values.issuer.length > 0 ? values.issuer : DEFAULT_ISSUER;

process.stdout.write(`\nChatGPT 订阅登录（Codex OAuth 设备码流程）\n凭据文件：${path}\n\n`);

let pending;
try {
  pending = await requestDeviceCode({ issuer });
} catch (error) {
  process.stderr.write(`\n请求设备码失败：${error.message}\n`);
  process.stderr.write(
    '\n如果错误提到国家/地区不受支持，请先把出口节点换成 OpenAI 支持的地区（见插件 README 的代理一节）。\n\n',
  );
  process.exit(1);
}

process.stdout.write(`1. 在浏览器打开：${pending.verificationUrl}\n`);
process.stdout.write(`2. 输入一次性代码：${pending.userCode}\n\n`);
process.stdout.write('等待授权完成（最多 15 分钟，Ctrl+C 取消）...\n');

let lastTick = 0;
const authorization = await pollForAuthorization(pending, {
  onPending: () => {
    const now = Date.now();
    if (now - lastTick > 15_000) {
      lastTick = now;
      process.stdout.write('  仍在等待浏览器授权...\n');
    }
  },
});

const tokens = await exchangeAuthorizationCode(pending, authorization);
const claims = readIdTokenClaims(tokens.idToken);
await saveCredentials(path, { ...tokens, accountId: claims.accountId }, undefined);

process.stdout.write(
  [
    '',
    '登录成功。',
    `  账号：${claims.email ?? '（未知）'}`,
    `  套餐：${claims.planType ?? '（未知）'}`,
    `  账号 ID：${claims.accountId ?? '（未知）'}`,
    '',
    '现在可以在 DSH 的模型选择器里选 “ChatGPT 订阅” 下的模型了。',
    '如果模型列表没有刷新，重新打开一次 DSH 或切换一次模型面板即可。',
    '',
  ].join('\n'),
);
