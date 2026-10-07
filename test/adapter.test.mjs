/**
 * End-to-end adapter test against a local mock of the Codex backend.
 *
 * Proves the whole path without network access: config schema load, credential
 * load, single-flight token refresh, request body and headers on the wire, SSE
 * translation, and error classification.
 *
 * Run: node test/adapter.test.mjs
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexAdapter } from '../src/codex-adapter.mjs';
import { classifyHttpFailure } from '../src/codex-client.mjs';
import { accessTokenExpiry, readIdTokenClaims } from '../src/auth-store.mjs';
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
import { LlmError } from '@deepseek-ai/dsh-llm';

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

/**
 * Mint an unsigned JWT carrying the claims the provider reads.
 * @param payload - claim object.
 * @returns a compact JWS string.
 */
function jwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

/** Build a fresh credential file with a soon-to-expire access token. */
async function seedCredentials(expiresInSeconds = 60) {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-sub-test-'));
  const path = join(dir, 'auth.json');
  const idToken = jwt({
    email: 'user@example.com',
    'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct-777' },
  });
  const accessToken = jwt({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds });
  await writeFile(
    path,
    JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken,
        access_token: accessToken,
        refresh_token: 'refresh-old',
        account_id: 'acct-777',
      },
      last_refresh: new Date().toISOString(),
    }),
  );
  return { dir, path, idToken };
}

/** A recorded inbound request. */
const seen = { requests: [] };
let refreshCount = 0;
let respondWith = 'ok';

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');

  if (req.url === '/oauth/token') {
    refreshCount += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: `refresh-new-${refreshCount}`,
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-777' } }),
      }),
    );
    return;
  }

  seen.requests.push({ url: req.url, headers: req.headers, body });

  if (respondWith === 'unauthorized-once' && seen.requests.length === 1) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'token expired' } }));
    return;
  }
  if (respondWith === 'quota') {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'You have hit your usage limit' } }));
    return;
  }
  if (respondWith === 'server-error') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'boom' } }));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_test' });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ type: 'response.created', response: { id: 'resp_1' } });
  send({ type: 'response.output_item.added', item: { id: 'msg_1', type: 'message' } });
  send({ type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Hi ' });
  send({ type: 'response.output_text.delta', item_id: 'msg_1', delta: 'there' });
  send({
    type: 'response.completed',
    response: { id: 'resp_1', end_turn: true, usage: { input_tokens: 9, output_tokens: 2 } },
  });
  res.end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseURL = `http://127.0.0.1:${port}`;

/**
 * Build an adapter pointed at the mock server.
 * @param authFilePath - credential file to read.
 * @param overrides - per-test configuration overrides.
 * @returns a configured adapter.
 */
function makeAdapter(authFilePath, overrides = {}) {
  return new CodexAdapter({
    authFile: () => authFilePath,
    baseURL: () => baseURL,
    issuer: () => baseURL,
    clientId: () => undefined,
    accountIdOverride: () => overrides.accountId,
    models: () =>
      overrides.models ?? [
        { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 272000, maxTokens: 128000, defaultEffort: 'medium' },
      ],
    reasoningEffort: () => overrides.reasoningEffort ?? 'medium',
    streamIdleTimeoutMs: () => 20000,
  });
}

/**
 * Drain a stream into a chunk array.
 *
 * Every chunk is pushed through the runtime's own lossless-JSON snapshot first.
 * The runtime rejects any chunk that fails it with "Assistant stream chunk must
 * be losslessly JSON-serializable", so a live class instance (an `LlmError`, for
 * one) silently escalates a clean provider failure into an unrelated session
 * error. Guarding here makes every test below cover that contract.
 */
async function drain(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    assert.notEqual(
      snapshotJsonValue(chunk),
      undefined,
      `chunk is not losslessly JSON-serializable: ${Object.prototype.toString.call(chunk)} ${JSON.stringify(chunk)}`,
    );
    chunks.push(chunk);
  }
  return chunks;
}

await test('config schema loads and exposes editable fields', async () => {
  const { Config } = await import('../src/index.mjs');
  assert.equal(typeof Config, 'function');
  const value = Config({});
  // Volatile fields are reactive refs, so their value is read through get().
  assert.equal(value.baseURL.get(), 'https://chatgpt.com/backend-api/codex');
  assert.equal(value.reasoningEffort.get(), 'medium');
  assert.equal(value.streamIdleTimeoutMs.get(), 300000);
  const models = value.models.get();
  assert.ok(Array.isArray(models));
  assert.ok(models.length > 0);
  for (const model of models) assert.equal(typeof model.id, 'string');
  // Non-volatile fields arrive as plain values.
  assert.equal(typeof value.issuer, 'string');
});

await test('status reports the signed-in plan from stored credentials', async () => {
  const { path } = await seedCredentials();
  const adapter = makeAdapter(path);
  const status = await adapter.status();
  assert.equal(status.signedIn, true);
  assert.equal(status.email, 'user@example.com');
  assert.equal(status.planType, 'plus');
  assert.equal(status.accountId, 'acct-777');
});

await test('the shipped preset catalog covers the gpt-6 family', async () => {
  const { DEFAULT_MODELS, REASONING_EFFORTS, CodexAdapter } = await import('../src/codex-adapter.mjs');
  const ids = DEFAULT_MODELS.map((model) => model.id);
  assert.ok(ids.includes('gpt-6-astra'), 'gpt-6-astra is offered');
  assert.ok(ids.includes('gpt-6.1-sol'), 'gpt-6.1-sol is offered');
  assert.ok(ids.includes('gpt-6-luna'), 'gpt-6-luna is offered');
  // The ladder must not be truncated at xhigh: the newest tiers exist.
  assert.deepEqual(
    REASONING_EFFORTS.map((e) => e.id),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
  for (const model of DEFAULT_MODELS) {
    assert.ok(model.reasoningEfforts.length > 0, `${model.id} declares a ladder`);
    assert.ok(
      model.reasoningEfforts.includes(model.defaultEffort),
      `${model.id} default effort is one it supports`,
    );
  }
  // A row with no explicit ladder inherits every tier.
  const adapter = new CodexAdapter({
    authFile: () => '/dev/null',
    baseURL: () => 'http://127.0.0.1:1',
    models: () => [{ id: 'gpt-6-astra', name: 'Astra', contextWindow: 272000, maxTokens: 128000, defaultEffort: 'ultra' }],
    reasoningEffort: () => 'ultra',
    streamIdleTimeoutMs: () => 1000,
  });
  const info = await adapter.resolveModel('chatgpt-subscription', 'gpt-6-astra');
  assert.deepEqual(
    info.reasoning.efforts.map((e) => e.id),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
  assert.equal(info.reasoning.defaultEffort, 'ultra');
});

await test('a model that lacks a tier falls back instead of sending an unsupported effort', async () => {
  const { CodexAdapter } = await import('../src/codex-adapter.mjs');
  const adapter = new CodexAdapter({
    authFile: () => '/dev/null',
    baseURL: () => 'http://127.0.0.1:1',
    // gpt-5.5 stops at xhigh; 'ultra' must not leak through the plugin default.
    models: () => [
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        contextWindow: 272000,
        maxTokens: 128000,
        defaultEffort: 'medium',
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      },
    ],
    reasoningEffort: () => 'ultra',
    streamIdleTimeoutMs: () => 1000,
  });
  const info = await adapter.resolveModel('chatgpt-subscription', 'gpt-5.5');
  assert.deepEqual(
    info.reasoning.efforts.map((e) => e.id),
    ['low', 'medium', 'high', 'xhigh'],
  );
  assert.equal(info.reasoning.defaultEffort, 'medium');
});

await test('listModels advertises the configured catalog for the GUI', async () => {
  const { path } = await seedCredentials();
  const adapter = makeAdapter(path);
  const models = await adapter.listModels('chatgpt-subscription');
  assert.deepEqual(models, [
    { provider: 'chatgpt-subscription', id: 'gpt-6-astra', name: 'GPT-6-Astra', inputModalities: ['text'] },
  ]);
});

await test('resolveModel returns metadata the runtime accepts', async () => {
  const { path } = await seedCredentials();
  const adapter = makeAdapter(path);
  const info = await adapter.resolveModel('chatgpt-subscription', 'gpt-6-astra');
  assert.equal(info.provider, 'chatgpt-subscription');
  assert.equal(info.id, 'gpt-6-astra');
  assert.equal(info.name, 'GPT-6-Astra');
  assert.deepEqual(info.context, { contextWindow: 272000 });
  assert.equal(info.defaultMaxTokens, 128000);
  assert.deepEqual(
    info.reasoning.efforts.map((e) => e.id),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
  assert.equal(info.reasoning.defaultEffort, 'medium');
  for (const effort of info.reasoning.efforts) assert.ok(effort.name.length > 0);
});

await test('a full call streams text, refreshes the near-expiry token, and binds the account header', async () => {
  const { path } = await seedCredentials(30);
  refreshCount = 0;
  seen.requests.length = 0;
  respondWith = 'ok';
  const adapter = makeAdapter(path);

  const chunks = await drain(
    adapter.stream({
      provider: 'chatgpt-subscription',
      model: 'gpt-6-astra',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'You are DSH.' }] },
        { role: 'user', content: [{ type: 'text', text: 'say hi' }] },
      ],
      tools: [{ name: 'shell', parameters: { type: 'object', properties: {} } }],
    }),
  );

  assert.equal(refreshCount, 1, 'a near-expiry token is refreshed before dispatch');
  assert.equal(seen.requests.length, 1);
  const request = seen.requests[0];
  assert.equal(request.url, '/responses');
  assert.match(request.headers.authorization, /^Bearer /);
  assert.equal(request.headers['chatgpt-account-id'], 'acct-777');
  assert.equal(request.headers.originator, 'codex_cli_rs');
  assert.match(request.headers['user-agent'], /codex_cli_rs/);
  const sent = JSON.parse(request.body);
  assert.equal(sent.model, 'gpt-6-astra');
  assert.equal(sent.instructions, 'You are DSH.');
  assert.equal(sent.stream, true);
  assert.equal(sent.store, false);
  assert.equal(sent.input[0].role, 'user');
  assert.equal(sent.tools.length, 1);

  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'Hi there');
  const usage = chunks.find((c) => c.type === 'usage');
  assert.equal(usage.usage.inputTokens, 9);
  assert.equal(chunks.filter((c) => c.type === 'finish').length, 1);
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' });

  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.tokens.refresh_token, 'refresh-new-1', 'the rotated refresh token is persisted');
});

await test('a 401 is retried once with a forced refresh', async () => {
  const { path } = await seedCredentials(3600);
  refreshCount = 0;
  seen.requests.length = 0;
  respondWith = 'unauthorized-once';
  const adapter = makeAdapter(path);

  const chunks = await drain(
    adapter.stream({
      provider: 'chatgpt-subscription',
      model: 'gpt-6-astra',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }),
  );

  assert.equal(seen.requests.length, 2, 'the request is attempted twice');
  assert.equal(refreshCount, 1);
  assert.equal(chunks.filter((c) => c.type === 'text-delta').length, 2);
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' });
});

await test('a quota rejection surfaces as a QUOTA failure with one terminal finish', async () => {
  const { path } = await seedCredentials(3600);
  seen.requests.length = 0;
  respondWith = 'quota';
  const adapter = makeAdapter(path);
  const chunks = await drain(
    adapter.stream({
      provider: 'chatgpt-subscription',
      model: 'gpt-6-astra',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }),
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].reason.kind, 'error');
  assert.equal(chunks[0].reason.failure.code, 'QUOTA');
});

await test('every failure finish carries a plain snapshot, never a live Error', async () => {
  // A real Error instance inside the chunk is rejected by the runtime's
  // lossless-JSON snapshot, which used to turn each provider failure into a
  // second "Assistant stream chunk must be losslessly JSON-serializable" error.
  for (const scenario of ['quota', 'error', 'empty', 'truncated']) {
    const { path } = await seedCredentials(3600);
    seen.requests.length = 0;
    respondWith = scenario;
    const chunks = await drain(
      makeAdapter(path).stream({
        provider: 'chatgpt-subscription',
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    );
    const terminal = chunks.at(-1);
    assert.equal(terminal.type, 'finish', `${scenario} ends with a finish`);
    if (terminal.reason.kind !== 'error') continue;
    const failure = terminal.reason.failure;
    assert.equal(failure instanceof Error, false, `${scenario} failure is not an Error instance`);
    assert.equal(Object.getPrototypeOf(failure), Object.prototype, `${scenario} failure is a plain object`);
    assert.equal(typeof failure.message, 'string', `${scenario} failure carries a message`);
    assert.equal(typeof failure.code, 'string', `${scenario} failure carries a code`);
  }
});

await test('a failed transport reports a plain TRANSPORT failure', async () => {
  const { path } = await seedCredentials(3600);
  const adapter = makeAdapter(path);
  // Point at a closed port so the fetch itself fails, exercising finishError
  // with a genuine underlying Error as the cause.
  const broken = new CodexAdapter({
    ...adapter.options,
    baseURL: () => 'http://127.0.0.1:1',
  });
  const chunks = await drain(
    broken.stream({
      provider: 'chatgpt-subscription',
      model: 'gpt-6-astra',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }),
  );
  const terminal = chunks.at(-1);
  assert.equal(terminal.type, 'finish');
  assert.equal(terminal.reason.kind, 'error');
  assert.equal(terminal.reason.failure.code, 'TRANSPORT');
  assert.equal(terminal.reason.failure instanceof Error, false);
  // The cause must not leak into the chunk as a live object.
  assert.equal(JSON.stringify(chunks).includes('ECONNREFUSED'), false);
});

await test('a missing credential file fails as MISSING_CREDENTIAL without any request', async () => {
  seen.requests.length = 0;
  respondWith = 'ok';
  const adapter = makeAdapter('/nonexistent/definitely/missing/auth.json');
  const chunks = await drain(
    adapter.stream({
      provider: 'chatgpt-subscription',
      model: 'gpt-6-astra',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }),
  );
  assert.equal(seen.requests.length, 0);
  assert.equal(chunks[0].reason.failure.code, 'MISSING_CREDENTIAL');
});

await test('an API-key credential file is refused as INVALID_CREDENTIAL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-sub-test-'));
  const path = join(dir, 'auth.json');
  await writeFile(path, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test', tokens: {} }));
  const adapter = makeAdapter(path);
  const chunks = await drain(
    adapter.stream({
      provider: 'chatgpt-subscription',
      model: 'gpt-6-astra',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }),
  );
  assert.equal(chunks[0].reason.failure.code, 'INVALID_CREDENTIAL');
});

await test('failure classification maps provider statuses onto stable codes', () => {
  assert.equal(classifyHttpFailure(401, '{}').code, 'AUTH');
  assert.equal(classifyHttpFailure(429, '{"error":{"message":"slow down"}}').code, 'RATE_LIMIT');
  assert.equal(classifyHttpFailure(429, '{"error":{"message":"usage limit reached"}}').code, 'QUOTA');
  assert.equal(classifyHttpFailure(500, 'boom').code, 'PROVIDER');
  assert.equal(classifyHttpFailure(404, '{"error":{"code":"model_not_found"}}').code, 'MODEL_NOT_FOUND');
});

await test('JWT helpers read expiry and account claims', async () => {
  const future = Math.floor(Date.now() / 1000) + 600;
  const token = jwt({ exp: future, 'https://api.openai.com/auth': { chatgpt_account_id: 'a-1' } });
  assert.equal(accessTokenExpiry(token), future * 1000);
  assert.equal(readIdTokenClaims(token).accountId, 'a-1');
});

server.close();
process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
