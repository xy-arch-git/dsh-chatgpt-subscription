/**
 * Account-service contract tests. Every network edge is injected, so no test
 * reaches OpenAI, reads the real credential file, or touches the user's login.
 */
import assert from 'node:assert/strict';
import { createAccountService, createAccountRpc, createAccountRoute, usageWindow } from '../src/account-service.mjs';

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${error?.stack ?? error}`);
  }
}

const AUTH_FILE = '/tmp/dsh-chatgpt-subscription-test/auth.json';
const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

/** A promise the test resolves by hand, so a grant can be held mid-flight. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Build a service whose every side effect is a local stub. */
function harness(overrides = {}) {
  const calls = { request: 0, poll: 0, exchange: 0, fetch: 0, saved: [], cleared: 0 };
  let stored = overrides.initial ?? null;
  const service = createAccountService(
    { authFile: () => AUTH_FILE, issuer: () => 'https://auth.openai.com' },
    {
      load: async () => stored,
      save: async (_path, tokens) => {
        calls.saved.push(tokens);
        stored = { authMode: 'chatgpt', accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, email: 'user@example.com', planType: 'plus' };
      },
      clear: async () => { calls.cleared += 1; stored = null; return true; },
      request: async () => {
        calls.request += 1;
        if (overrides.requestError) throw overrides.requestError;
        return { issuer: 'https://auth.openai.com', deviceAuthId: 'DEVICE-AUTH-ID-LEAK', userCode: 'WXYZ-9876', intervalSeconds: 5, verificationUrl: 'https://auth.openai.com/codex/device' };
      },
      poll: async (_grant, { signal } = {}) => {
        calls.poll += 1;
        // Hold the grant open when the test wants to cancel/dispose mid-flight.
        if (overrides.pollGate) await overrides.pollGate.promise;
        signal?.throwIfAborted?.();
        if (overrides.pollError) throw overrides.pollError;
        return { authorizationCode: 'AUTH-CODE-LEAK', codeChallenge: 'CODE-CHALLENGE-LEAK', codeVerifier: 'CODE-VERIFIER-LEAK' };
      },
      exchange: async () => {
        calls.exchange += 1;
        if (overrides.exchangeError) throw overrides.exchangeError;
        return { idToken: 'i.j.k', accessToken: 'access-token', refreshToken: 'refresh-token' };
      },
      auth: { accessToken: async () => { calls.auth = (calls.auth ?? 0) + 1; if (overrides.authError) throw overrides.authError; return { accessToken: 'access-token', accountId: 'acct-1' }; } },
      fetch: async (url, init) => {
        calls.fetch += 1;
        calls.lastUrl = url;
        calls.lastAuth = init?.headers?.authorization;
        if (overrides.fetchError) throw overrides.fetchError;
        return overrides.fetchResponse ?? { ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 12.5, reset_at: 1800000000, limit_window_seconds: 18000 }, secondary_window: { used_percent: 90, reset_at: 1800100000, limit_window_seconds: 604800 } } }) };
      },
      now: () => 1_000_000,
    },
  );
  return { service, calls, getStored: () => stored };
}

await test('usageWindow converts a used-percent window into a remaining ratio', () => {
  const window = usageWindow({ used_percent: 12.5, reset_at: 1800000000, limit_window_seconds: 18000 });
  assert.equal(window.remainingRatio, 0.875);
  assert.equal(window.resetAt, 1800000000 * 1000);
  assert.equal(window.windowSeconds, 18000);
  // Out-of-range and missing fields degrade to null instead of a fake number.
  assert.equal(usageWindow({ used_percent: 250 }).remainingRatio, 0);
  assert.equal(usageWindow({}).remainingRatio, null);
  assert.equal(usageWindow({}).resetAt, null);
  assert.equal(usageWindow(undefined), null);
});

await test('an unauthenticated status is empty and exposes no secrets', async () => {
  const { service } = harness();
  const status = await service.status();
  assert.equal(status.authenticated, false);
  assert.equal(status.account, null);
  assert.equal(status.login.state, 'idle');
  assert.equal(status.usage.state, 'idle');
  assert.equal(JSON.stringify(status).includes('access-token'), false);
  await service.dispose();
});

await test('device login publishes the code and never the grant internals', async () => {
  const { service, calls, getStored } = harness();
  const pending = await service.beginLogin();
  assert.equal(pending.login.state, 'pending');
  assert.equal(pending.login.userCode, 'WXYZ-9876');
  assert.equal(pending.login.verificationUrl, 'https://auth.openai.com/codex/device');
  const wire = JSON.stringify(pending);
  // Distinctive values, so an accidental match cannot come from ordinary words.
  for (const secret of ['DEVICE-AUTH-ID-LEAK', 'AUTH-CODE-LEAK', 'CODE-CHALLENGE-LEAK', 'CODE-VERIFIER-LEAK']) {
    assert.equal(wire.includes(secret), false, `${secret} must not reach the browser`);
  }
  await flush();
  const after = await service.status();
  assert.equal(after.authenticated, true);
  assert.equal(after.login.state, 'success');
  assert.equal(calls.exchange, 1);
  assert.equal(getStored().accessToken, 'access-token');
  await service.dispose();
});

await test('the account email is masked and the plan is reported', async () => {
  const { service } = harness({ initial: { authMode: 'chatgpt', accessToken: 'a', refreshToken: 'r', email: 'someone@example.com', planType: 'pro' } });
  const status = await service.status();
  assert.equal(status.account.email, 's***@example.com');
  assert.equal(status.account.planType, 'pro');
  await service.dispose();
});

await test('an api-key credential file is not treated as a subscription session', async () => {
  const { service } = harness({ initial: { authMode: 'apikey', apiKey: 'sk-test' } });
  const status = await service.status();
  assert.equal(status.authenticated, false);
  await service.dispose();
});

await test('concurrent login clicks share one device grant', async () => {
  const { service, calls } = harness();
  const [a, b, c] = await Promise.all([service.beginLogin(), service.beginLogin(), service.beginLogin()]);
  assert.equal(calls.request, 1);
  for (const result of [a, b, c]) assert.equal(result.login.userCode, 'WXYZ-9876');
  await service.dispose();
});

await test('a pending login that finishes cannot resurrect after cancel', async () => {
  const gate = deferred();
  const { service, calls, getStored } = harness({ pollGate: gate });
  await service.beginLogin();
  const cancelled = await service.cancelLogin();
  assert.equal(cancelled.login.state, 'cancelled');
  // Release the abandoned grant: it must be ignored, not written.
  gate.resolve();
  await flush();
  const after = await service.status();
  assert.equal(after.authenticated, false);
  assert.equal(getStored(), null, 'a cancelled grant must not save credentials');
  assert.equal(calls.saved.length, 0);
  await service.dispose();
});

await test('signOut clears credentials and returns to signed out', async () => {
  const { service, calls, getStored } = harness({ initial: { authMode: 'chatgpt', accessToken: 'a', refreshToken: 'r' } });
  const status = await service.signOut();
  assert.equal(status.authenticated, false);
  assert.equal(calls.cleared, 1);
  assert.equal(getStored(), null);
  await service.dispose();
});

await test('usage reports real windows with a remaining ratio and reset time', async () => {
  const { service, calls } = harness({ initial: { authMode: 'chatgpt', accessToken: 'a', refreshToken: 'r' } });
  const status = await service.refreshUsage();
  assert.equal(status.usage.state, 'ready');
  assert.equal(status.usage.primary.remainingRatio, 0.875);
  assert.equal(status.usage.secondary.remainingRatio, 0.1);
  assert.equal(status.usage.primary.resetAt, 1800000000 * 1000);
  // The credential goes to the fixed ChatGPT origin, never a caller-supplied URL.
  assert.equal(calls.lastUrl, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(calls.lastAuth, 'Bearer access-token');
  await service.dispose();
});

await test('usage without server windows is unavailable, not full', async () => {
  const { service } = harness({ initial: { authMode: 'chatgpt', accessToken: 'a', refreshToken: 'r' }, fetchResponse: { ok: true, json: async () => ({}) } });
  const status = await service.refreshUsage();
  assert.equal(status.usage.state, 'unavailable');
  assert.equal(status.usage.primary, null);
  assert.equal(status.usage.secondary, null);
  await service.dispose();
});

await test('usage failures are reported without the upstream body', async () => {
  const { service } = harness({ initial: { authMode: 'chatgpt', accessToken: 'a', refreshToken: 'r' }, fetchError: new Error('HTTP 403: unsupported_country_region_territory secret-detail') });
  const status = await service.refreshUsage();
  assert.equal(status.usage.state, 'error');
  assert.equal(status.usage.error.includes('secret-detail'), false);
  assert.match(status.usage.error, /地区/);
  await service.dispose();
});

await test('a login failure surfaces one sanitized message', async () => {
  const { service } = harness({ requestError: new Error('HTTP 403: unsupported_country_region_territory raw-body-xyz') });
  const status = await service.beginLogin();
  assert.equal(status.login.state, 'error');
  assert.equal(status.login.error.includes('raw-body-xyz'), false);
  assert.match(status.login.error, /地区/);
  await service.dispose();
});

await test('a failing grant keeps login usable for a retry', async () => {
  const { service } = harness({ pollError: new Error('HTTP 500 boom') });
  await service.beginLogin();
  await flush();
  const failed = await service.status();
  assert.equal(failed.login.state, 'error');
  const retry = harness();
  await retry.service.beginLogin();
  await flush();
  assert.equal((await retry.service.status()).login.state, 'success');
  await service.dispose();
  await retry.service.dispose();
});

await test('the RPC layer whitelists methods and rejects extra payload', async () => {
  const { service } = harness();
  const rpc = createAccountRpc(service);
  const ok = await rpc('status', {});
  assert.equal(ok.ok, true);
  assert.equal(ok.value.authenticated, false);
  for (const [method, payload] of [['../etc/passwd', {}], ['login/start', { url: 'https://evil.example' }], ['status', null], ['status', []], ['', {}]]) {
    const result = await rpc(method, payload);
    assert.equal(result.ok, false, `${method} must be refused`);
    assert.equal(result.error.code, 'chatgpt/invalid-request');
  }
  await service.dispose();
});

await test('the RPC layer sanitizes a thrown service failure', async () => {
  const rpc = createAccountRpc({ status: async () => { throw new Error('internal path /home/user/.codex/auth.json'); } });
  const result = await rpc('status', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'chatgpt/request-failed');
  assert.equal(JSON.stringify(result).includes('/home/user'), false);
});

await test('dispose aborts in-flight work and settles', async () => {
  const gate = deferred();
  const { service, calls } = harness({ pollGate: gate });
  await service.beginLogin();
  await service.dispose();
  gate.resolve();
  await flush();
  assert.equal(calls.saved.length, 0, 'no credential write after dispose');
});

/* ------------------------------------------------------------------ *
 * Host route: the fence is load-bearing — a bare webServer route is
 * unauthenticated, so these tests assert the rejection paths.
 * ------------------------------------------------------------------ */

const CHANNEL = '/chatgpt-subscription';

function fakeRes() {
  return {
    statusCode: undefined, headers: undefined, body: undefined, writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this; },
    end(body) { this.body = body; this.writableEnded = true; },
  };
}
function fakeReq(overrides = {}) {
  const { url = `${CHANNEL}/status`, method = 'POST', headers = {}, body = '' } = overrides;
  return {
    url, method, headers,
    async *[Symbol.asyncIterator]() { if (body !== '') yield Buffer.from(body); },
    destroy() {},
  };
}
const envelope = (method = 'status', extra = {}) => JSON.stringify({ type: 'client-request', rpcId: '11111111-2222-4333-8444-555555555555', method, payload: {}, ...extra });
/** A connection whose fence admits only the `ok` cookie. */
function fence(calls) {
  return { admit: (req) => { calls.admitted = (calls.admitted ?? 0) + 1; return req.headers.cookie === 'ok' ? { peer: { operator: true } } : { rejection: 401 }; } };
}
function routeFor(handler, calls = {}) {
  return { route: createAccountRoute({ channel: CHANNEL, connection: fence(calls), handler }), calls };
}

await test('the route rejects an unauthenticated request before any handler runs', async () => {
  let ran = false;
  const { route, calls } = routeFor(async () => { ran = true; return { ok: true, value: 1 }; });
  const res = fakeRes();
  await route(fakeReq({ headers: { 'content-type': 'application/json' }, body: envelope() }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(ran, false, 'the handler must not run for an unauthenticated peer');
  assert.equal(res.body, 'unauthorized');
  assert.equal(calls.admitted, 1);
});

await test('the route enforces the method, content type, endpoint and envelope', async () => {
  const handler = async () => ({ ok: true, value: { authenticated: false } });
  const { route } = routeFor(handler);
  const auth = { cookie: 'ok' };

  const notFound = fakeRes();
  await route(fakeReq({ method: 'GET', headers: auth }), notFound);
  assert.equal(notFound.statusCode, 404);

  const wrongType = fakeRes();
  await route(fakeReq({ headers: { ...auth, 'content-type': 'text/plain' }, body: envelope() }), wrongType);
  assert.equal(wrongType.statusCode, 415);

  const badJson = fakeRes();
  await route(fakeReq({ headers: { ...auth, 'content-type': 'application/json' }, body: '{nope' }), badJson);
  assert.equal(badJson.statusCode, 400);

  const badEnvelope = fakeRes();
  await route(fakeReq({ headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'nope', rpcId: 'x' }) }), badEnvelope);
  assert.equal(badEnvelope.statusCode, 400);

  const wrongChannel = fakeRes();
  await route(fakeReq({ url: '/other/status', headers: { ...auth, 'content-type': 'application/json' }, body: envelope() }), wrongChannel);
  assert.equal(wrongChannel.statusCode, 404);

  // Path traversal inside the endpoint must not resolve.
  const traversal = fakeRes();
  await route(fakeReq({ url: `${CHANNEL}/../secret`, headers: { ...auth, 'content-type': 'application/json' }, body: envelope() }), traversal);
  assert.equal(traversal.statusCode, 404);
});

await test('a method that disagrees with the endpoint is refused', async () => {
  let ran = false;
  const { route } = routeFor(async () => { ran = true; return { ok: true, value: 1 }; });
  const res = fakeRes();
  await route(fakeReq({ url: `${CHANNEL}/status`, headers: { cookie: 'ok', 'content-type': 'application/json' }, body: envelope('logout') }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).result.error.code, 'gateway/bad-request');
  assert.equal(ran, false);
});

await test('a successful call returns the transport envelope with the same rpcId', async () => {
  const { route } = routeFor(createAccountRpc(harness().service));
  const res = fakeRes();
  await route(fakeReq({ headers: { cookie: 'ok', 'content-type': 'application/json' }, body: envelope('status') }), res);
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.type, 'server-response');
  assert.equal(parsed.rpcId, '11111111-2222-4333-8444-555555555555');
  assert.equal(parsed.result.ok, true);
  assert.equal(parsed.result.value.authenticated, false);
});

await test('a handler throw becomes a sanitized failure, never a 500 with raw text', async () => {
  const { route } = routeFor(async () => { throw new Error('ENOENT /home/user/.codex/auth.json'); });
  const res = fakeRes();
  await route(fakeReq({ headers: { cookie: 'ok', 'content-type': 'application/json' }, body: envelope() }), res);
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.result.ok, false);
  assert.equal(parsed.result.error.code, 'chatgpt/request-failed');
  assert.equal(JSON.stringify(parsed).includes('/home/user'), false);
});

await test('the route caps the request body', async () => {
  const { route } = routeFor(async () => ({ ok: true, value: 1 }));
  const res = fakeRes();
  await route(fakeReq({ headers: { cookie: 'ok', 'content-type': 'application/json', 'content-length': String(200 * 1024) }, body: envelope() }), res);
  assert.equal(res.statusCode, 413);
});

await test('a throwing fence fails closed', async () => {
  const route = createAccountRoute({ channel: CHANNEL, connection: { admit() { throw new Error('boom'); } }, handler: async () => ({ ok: true, value: 1 }) });
  const res = fakeRes();
  await route(fakeReq({ headers: { 'content-type': 'application/json' }, body: envelope() }), res);
  assert.equal(res.statusCode, 403);
});

console.log(`\n${failures === 0 ? 'all' : ''} account-service checks ${failures === 0 ? 'passed' : `FAILED (${failures})`}`);
if (failures > 0) process.exit(1);
