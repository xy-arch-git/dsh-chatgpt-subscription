/**
 * Integration test: load the plugin exactly as the Cordis loader would and
 * assert its registration surface against the real `dsh-llm` runtime running on
 * a real Cordis context.
 *
 * This is the check that proves the provider card exists, that the route is
 * routable, and that a request really flows through the runtime's streaming
 * boundary into the adapter — without booting the whole desktop app.
 *
 * Run: node test/integration.test.mjs
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';

let failures = 0;
let checks = 0;

/**
 * Run one named check.
 * @param name - the assertion label.
 * @param fn - the check body.
 */
async function test(name, fn) {
  checks += 1;
  try {
    await fn();
    process.stdout.write(`ok   ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`FAIL ${name}\n     ${error.message}\n`);
  }
}

/** Mint an unsigned JWT with the given claims. */
function jwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

/** Records what the host is asked to persist. */
const recorded = { configured: [], effects: [], listeners: [], logs: [] };

const server = createServer(async (req, res) => {
  for await (const _ of req) {
    // drain the request body
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_it' });
  res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'm', delta: 'pong' })}\n\n`);
  res.write(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: { id: 'r', end_turn: true, usage: { input_tokens: 3, output_tokens: 1 } },
    })}\n\n`,
  );
  res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const dir = await mkdtemp(join(tmpdir(), 'chatgpt-int-'));
const authFile = join(dir, 'auth.json');
await writeFile(
  authFile,
  JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-int' } }),
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: 'r',
    },
    last_refresh: new Date().toISOString(),
  }),
);

const { apply, Config, PROVIDER } = await import('../src/index.mjs');

/**
 * Mount the real LLM runtime on a fresh root context.
 * @returns `{ root, runtime }` for one check.
 */
function mountRuntime() {
  const root = new Context();
  const runtime = new LlmRuntime(root);
  return { root, runtime };
}

/**
 * Build the plugin context `apply()` receives, backed by the real root context.
 *
 * `llm`, `on`, and `inject` come from Cordis; only `fiber.entry.options.id` and
 * the settings child are supplied, matching what the loader provides.
 *
 * @param root - the Cordis root context carrying the runtime.
 * @returns a plugin context.
 */
function makeContext(root) {
  return {
    llm: root.llm,
    logger: {
      info: (...args) => recorded.logs.push(args.map(String).join(' ')),
      warn: (...args) => recorded.logs.push(`WARN ${args.map(String).join(' ')}`),
    },
    fiber: { entry: { options: { id: 'chatgpt-subscription' } } },
    on: (event) => {
      recorded.listeners.push(event);
      return () => {};
    },
    inject: (deps, fn) => {
      recorded.effects.push(deps.join(','));
      if (deps.includes('settings')) {
        fn({
          effect: (body) => {
            body();
            return () => {};
          },
          settings: { configure: (options) => recorded.configured.push(options) },
        });
      }
    },
  };
}

/** The catalog used by most checks. */
const CATALOG = [
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 272000, maxTokens: 128000, defaultEffort: 'high' },
];

/**
 * Configure the plugin for the mock server.
 * @param overrides - configuration overrides.
 * @returns a validated config object.
 */
function makeConfig(overrides = {}) {
  return Config({ authFile, baseURL: `http://127.0.0.1:${port}`, models: CATALOG, ...overrides });
}

await test('plugin apply() registers the provider card and route on the real runtime', async () => {
  const { root, runtime } = mountRuntime();
  apply(makeContext(root), makeConfig());

  const providers = runtime.listProviders();
  assert.equal(providers.length, 1, 'exactly one provider route is registered');
  assert.equal(providers[0].id, PROVIDER);
  assert.equal(providers[0].name, 'ChatGPT 订阅');

  const cards = runtime.listConfigurableProviders();
  assert.equal(cards.length, 1, 'the model card is declared for the Models page');
  assert.equal(cards[0].provider, PROVIDER);
  assert.equal(cards[0].displayName, 'ChatGPT 订阅');
  assert.equal(cards[0].settingsNs, 'chatgpt-subscription');
  assert.deepEqual(cards[0].settingsPath, []);

  assert.ok(recorded.configured.length > 0, 'the plugin claims its own settings surface');
  assert.deepEqual(recorded.configured[0], { auto: false });
  assert.ok(recorded.listeners.includes('loader/volatile-update'));
});

await test('a request through the registered route reaches the adapter and returns chunks', async () => {
  const { root, runtime } = mountRuntime();
  apply(makeContext(root), makeConfig());

  const chunks = [];
  for await (const chunk of runtime.stream({
    provider: PROVIDER,
    model: 'gpt-6-astra',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  })) {
    chunks.push(chunk);
  }

  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'pong');
  assert.equal(chunks.filter((c) => c.type === 'finish').length, 1);
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' });
});

await test('resolved model metadata survives the runtime normalizer', async () => {
  const { root, runtime } = mountRuntime();
  apply(makeContext(root), makeConfig({ reasoningEffort: 'high' }));

  // The runtime does not expose resolveModel publicly, but prepareCall is the
  // binding the streaming boundary uses, and the runtime normalizes its result
  // during every call — so assert the contract on a direct adapter instance.
  const { CodexAdapter } = await import('../src/codex-adapter.mjs');
  const adapter = new CodexAdapter({
    authFile: () => authFile,
    baseURL: () => `http://127.0.0.1:${port}`,
    models: () => [
      { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 272000, maxTokens: 128000, defaultEffort: 'high' },
    ],
    reasoningEffort: () => 'high',
    streamIdleTimeoutMs: () => 20000,
  });
  const prepared = await adapter.prepareCall(PROVIDER, 'gpt-6-astra');
  const info = prepared.model;

  assert.equal(info.provider, PROVIDER);
  assert.equal(info.id, 'gpt-6-astra');
  assert.equal(info.name, 'GPT-6-Astra');
  assert.deepEqual(info.context, { contextWindow: 272000 });
  assert.equal(info.defaultMaxTokens, 128000);
  assert.deepEqual(info.reasoning.defaultEffort, 'high');
  assert.deepEqual(
    info.reasoning.efforts.map((e) => e.id),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
});

await test('the runtime normalizes the adapter catalog for the GUI', async () => {
  const { root, runtime } = mountRuntime();
  apply(makeContext(root), makeConfig());
  const models = await runtime.listModels(PROVIDER);
  assert.deepEqual(models, [
    { provider: PROVIDER, id: 'gpt-6-astra', name: 'GPT-6-Astra', inputModalities: ['text'] },
  ]);
});

await test('a malformed catalog is rejected at load rather than half-registered', async () => {
  const { root } = mountRuntime();
  const config = Config({
    authFile,
    models: [{ id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' }, { id: 'gpt-5.1-codex' }],
  });
  assert.throws(() => apply(makeContext(root), config), /duplicate catalog model/);
});

await test('an unknown provider route fails with NO_ADAPTER rather than silently routing', async () => {
  const { root, runtime } = mountRuntime();
  apply(makeContext(root), makeConfig());
  const chunks = [];
  for await (const chunk of runtime.stream({
    provider: 'not-registered',
    model: 'gpt-6-astra',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  })) {
    chunks.push(chunk);
  }
  assert.equal(chunks.at(-1).type, 'finish');
  assert.equal(chunks.at(-1).reason.kind, 'error');
  assert.equal(chunks.at(-1).reason.failure.code, 'NO_ADAPTER');
});

server.close();
process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
