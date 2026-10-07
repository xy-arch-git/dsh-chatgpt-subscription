#!/usr/bin/env node
/**
 * Regional reachability self-check for the ChatGPT subscription provider.
 *
 * OpenAI refuses traffic from unsupported countries with
 * `unsupported_country_region_territory`. On a NAT'd VM the usual cause is that
 * egress leaves through an unsupported region — either directly, or through a
 * proxy node that is itself in one.
 *
 * This reports the effective egress IP and whether each required endpoint is
 * reachable, so "the plugin is broken" can be distinguished from "the network
 * path is blocked" before blaming the adapter.
 *
 *   node bin/chatgpt-doctor.mjs [--proxy URL]
 */

import { parseArgs } from 'node:util';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const { values } = parseArgs({
  options: {
    proxy: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
});

if (values.help === true) {
  process.stdout.write(
    [
      'Usage: node bin/chatgpt-doctor.mjs [--proxy http://HOST:PORT] [--json]',
      '',
      'Checks: egress IP, api.openai.com reachability, auth.openai.com device',
      'endpoint reachability, and chatgpt.com backend reachability.',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

/** Proxy URL from the flag, then the ambient environment. */
const proxy =
  values.proxy ??
  process.env.HTTPS_PROXY ??
  process.env.https_proxy ??
  process.env.ALL_PROXY ??
  process.env.all_proxy ??
  process.env.HTTP_PROXY ??
  process.env.http_proxy;

/**
 * Resolve a proxy URL into host/port, accepting http:// and socks forms.
 * @param url - the proxy URL.
 * @returns `{ host, port, scheme }`, or undefined when unusable.
 */
function parseProxy(url) {
  if (typeof url !== 'string' || url.length === 0) return undefined;
  try {
    const parsed = new URL(url.includes('://') ? url : `http://${url}`);
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    return { host: parsed.hostname, port, scheme: parsed.protocol.replace(':', '') };
  } catch {
    return undefined;
  }
}

const proxyInfo = parseProxy(proxy);

/**
 * Issue one request, optionally through an HTTP CONNECT proxy.
 *
 * Only HTTP(S) proxies are supported here; SOCKS is reported as unsupported
 * because Node's core modules cannot speak it without a dependency.
 *
 * @param url - absolute target URL.
 * @param options - `timeoutMs` and whether to read the body.
 * @returns status, body text and timing.
 */
function probe(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const target = new URL(url);
  return new Promise((resolve) => {
    const started = Date.now();
    const finish = (result) => resolve({ url, elapsedMs: Date.now() - started, ...result });

    if (proxyInfo !== undefined && proxyInfo.scheme === 'socks5') {
      finish({ ok: false, error: 'socks proxy unsupported by this check (use --proxy http://host:port)' });
      return;
    }

    const onResponse = (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        finish({
          ok: true,
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8').slice(0, 600),
        }),
      );
    };

    const fail = (error) => finish({ ok: false, error: error.message });

    if (proxyInfo === undefined) {
      const request = (target.protocol === 'http:' ? httpRequest : httpsRequest)(
        {
          method: 'GET',
          hostname: target.hostname,
          port: target.port || (target.protocol === 'http:' ? 80 : 443),
          path: `${target.pathname}${target.search}`,
          headers: { accept: '*/*', 'user-agent': 'dsh-chatgpt-doctor' },
        },
        onResponse,
      );
      request.setTimeout(timeoutMs, () => request.destroy(new Error(`timeout after ${timeoutMs}ms`)));
      request.on('error', fail);
      request.end();
      return;
    }

    // Tunnel through the proxy with CONNECT.
    const connect = httpRequest({
      method: 'CONNECT',
      hostname: proxyInfo.host,
      port: proxyInfo.port,
      path: `${target.hostname}:${target.port || 443}`,
      headers: { host: `${target.hostname}:${target.port || 443}` },
    });
    connect.setTimeout(timeoutMs, () => connect.destroy(new Error(`proxy connect timeout after ${timeoutMs}ms`)));
    connect.on('error', fail);
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        finish({ ok: false, error: `proxy refused CONNECT with HTTP ${res.statusCode}` });
        return;
      }
      const inner = httpsRequest(
        {
          method: 'GET',
          hostname: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          headers: { accept: '*/*', 'user-agent': 'dsh-chatgpt-doctor' },
          socket,
          agent: false,
          createConnection: () => socket,
        },
        onResponse,
      );
      inner.setTimeout(timeoutMs, () => inner.destroy(new Error(`timeout after ${timeoutMs}ms`)));
      inner.on('error', fail);
      inner.end();
    });
    connect.end();
  });
}

/**
 * Interpret an OpenAI error body into a verdict.
 * @param body - response text.
 * @returns a short verdict, or undefined when the body is not an OpenAI refusal.
 */
function openAiVerdict(body) {
  if (typeof body !== 'string' || body.length === 0) return undefined;
  try {
    const parsed = JSON.parse(body);
    const code = parsed?.error?.code;
    if (code === 'unsupported_country_region_territory') return '地区不受支持（unsupported_country_region_territory）';
    if (code === 'invalid_api_key' || code === 'missing_api_key') return '端点可达（缺少凭据属正常）';
  } catch {
    return undefined;
  }
  return undefined;
}

const results = [];
results.push({ name: '出口 IP', ...(await probe('https://api.ipify.org')) });
results.push({ name: 'api.openai.com', ...(await probe('https://api.openai.com/v1/models')) });
results.push({ name: 'auth.openai.com', ...(await probe('https://auth.openai.com/api/accounts/deviceauth/usercode')) });
results.push({ name: 'chatgpt.com 后端', ...(await probe('https://chatgpt.com/backend-api/codex/responses')) });

if (values.json === true) {
  process.stdout.write(`${JSON.stringify({ proxy: proxyInfo ?? null, results }, null, 2)}\n`);
  process.exit(0);
}

const egress = results[0];
process.stdout.write(`\nChatGPT 订阅连通性自检\n`);
process.stdout.write(`代理：${proxyInfo === undefined ? '未设置（直连）' : `${proxyInfo.scheme}://${proxyInfo.host}:${proxyInfo.port}`}\n`);
process.stdout.write(`出口 IP：${egress.ok === true ? egress.body.trim() : `探测失败（${egress.error}）`}\n\n`);

let unsupported = false;
for (const result of results.slice(1)) {
  if (result.ok !== true) {
    process.stdout.write(`  ✗ ${result.name}：${result.error}\n`);
    continue;
  }
  const verdict = openAiVerdict(result.body) ?? `HTTP ${result.status}`;
  if (verdict.includes('地区不受支持')) unsupported = true;
  const mark = verdict.includes('地区不受支持') ? '✗' : '✓';
  process.stdout.write(`  ${mark} ${result.name}：${verdict}\n`);
}

process.stdout.write('\n');
if (unsupported) {
  process.stdout.write(
    [
      '结论：当前出口地区被 OpenAI 拒绝。插件本身没有问题，换一个受支持地区的节点即可。',
      '',
      '要点：',
      '  1. 出口 IP 必须落在 OpenAI 支持的国家/地区（香港不在其中）。',
      '  2. 代理必须在 DSH 启动前生效：写进 $DSH_HOME/.env，或导出 HTTPS_PROXY。',
      '  3. 只改浏览器代理没用；DSH 的请求由宿主进程直接发起。',
      '  4. 透明代理/TUN 若把 api.openai.com 直连绕过，出口 IP 不会变。',
      '     可先用本脚本确认出口 IP 是否真的变了。',
      '  5. 若 HTTPS_PROXY 已设但出口 IP 与直连相同，说明环境变量是多余的，',
      '     反而让宿主所有出站流量都依赖该代理——建议去掉。',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
process.stdout.write('结论：端点可达且地区未被拒绝，插件应能正常联网。\n\n');
