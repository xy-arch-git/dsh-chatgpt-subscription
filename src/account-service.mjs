import { requestDeviceCode, pollForAuthorization, exchangeAuthorizationCode } from './oauth.mjs';
import { loadCredentials, saveCredentials, clearCredentials, accessTokenExpiry } from './auth-store.mjs';
import { CodexAuth } from './codex-client.mjs';

const emptyUsage = () => ({ state: 'idle', primary: null, secondary: null, updatedAt: null, error: null });
/** Round to 6 decimals so `1 - used/100` never yields 0.09999999999999998. */
const ratio = (value) => Math.round(value * 1e6) / 1e6;
export function usageWindow(value) {
  if (!value || typeof value !== 'object') return null;
  const used = value.used_percent;
  return {
    remainingRatio: typeof used === 'number' && Number.isFinite(used) ? ratio(Math.max(0, Math.min(1, 1 - used / 100))) : null,
    resetAt: typeof value.reset_at === 'number' && Number.isFinite(value.reset_at) ? value.reset_at * 1000 : null,
    windowSeconds: typeof value.limit_window_seconds === 'number' ? value.limit_window_seconds : null,
  };
}
function safeError(error) {
  const detail = String(error?.message ?? '');
  if (/unsupported_country|region.*supported/i.test(detail)) return '服务端拒绝了当前出口地区，请检查代理与出口地区。';
  if (error?.code === 'REFRESH_FAILED' || /401|invalid_grant/.test(detail)) return '登录已失效，请重新授权。';
  if (/403/.test(detail)) return '服务端拒绝访问，请检查账号权限与网络。';
  if (/429/.test(detail)) return '请求过于频繁，请稍后再试。';
  return '请求未完成，请检查网络和代理后重试。';
}

/** Browser-facing state only. OAuth grants and tokens never leave this service. */
export function createAccountService(options, deps = {}) {
  const load = deps.load ?? loadCredentials;
  const save = deps.save ?? saveCredentials;
  const clear = deps.clear ?? clearCredentials;
  const request = deps.request ?? requestDeviceCode;
  const poll = deps.poll ?? pollForAuthorization;
  const exchange = deps.exchange ?? exchangeAuthorizationCode;
  const fetcher = deps.fetch ?? globalThis.fetch;
  const auth = deps.auth ?? new CodexAuth(options);
  const now = deps.now ?? Date.now;
  let login = { state: 'idle' }, usage = emptyUsage(), generation = 0, disposed = false;
  let grantController, usageController, beginFlight, usageFlight, timer;
  let writes = Promise.resolve();
  const serial = (fn) => {
    const next = writes.then(fn);
    writes = next.catch(() => {});
    return next;
  };
  const active = (id) => !disposed && generation === id;
  function invalidate(state) {
    generation++;
    clearTimeout(timer);
    grantController?.abort();
    usageController?.abort();
    beginFlight = undefined;
    usageFlight = undefined;
    login = { state };
  }
  async function status() {
    let state;
    try { state = await load(options.authFile()); }
    catch { return { authenticated: false, account: null, login: { ...login }, usage: { ...usage }, error: '本地凭据无法读取，请重新登录或检查文件权限。' }; }
    const authenticated = Boolean(state && state.authMode !== 'apikey' && (state.accessToken || state.refreshToken));
    const expiry = accessTokenExpiry(state?.accessToken);
    return {
      authenticated,
      account: authenticated ? {
        email: state.email?.replace(/^(.).*(@.*)$/, '$1***$2') ?? null,
        planType: state.planType ?? null,
        expired: expiry !== undefined && expiry <= now(),
        expiresAt: expiry ?? null,
      } : null,
      login: { ...login }, usage: structuredClone(usage),
    };
  }
  async function finish(grant, id, path, signal) {
    try {
      const authorization = await poll(grant, { signal });
      const tokens = await exchange(grant, authorization, { signal });
      await serial(async () => {
        if (!active(id) || signal.aborted) return;
        await save(path, tokens);
        if (active(id)) { login = { state: 'success' }; usage = emptyUsage(); }
      });
    } catch (error) {
      if (active(id) && !signal.aborted) login = { state: 'error', error: safeError(error) };
    } finally {
      if (active(id)) clearTimeout(timer);
    }
  }
  function beginLogin() {
    if (disposed) return Promise.reject(new Error('Service disposed'));
    if (beginFlight) return beginFlight;
    if (login.state === 'pending') return status();
    invalidate('requesting');
    const id = generation, path = options.authFile();
    grantController = new AbortController();
    const controller = grantController;
    const run = (async () => {
      try {
        const grant = await request({ issuer: options.issuer(), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
        if (!active(id)) return status();
        const expiresAt = now() + (deps.grantTTL ?? 15 * 60 * 1000);
        login = { state: 'pending', userCode: grant.userCode, verificationUrl: grant.verificationUrl, expiresAt };
        timer = setTimeout(() => {
          if (active(id)) { login = { state: 'expired', error: '设备码已过期，请重新获取。' }; controller.abort(); }
        }, Math.max(1, expiresAt - now()));
        timer.unref?.();
        void finish(grant, id, path, controller.signal);
      } catch (error) {
        if (active(id)) login = { state: 'error', error: safeError(error) };
      }
      return status();
    })();
    beginFlight = run;
    void run.finally(() => { if (beginFlight === run) beginFlight = undefined; }).catch(() => {});
    return run;
  }
  function refreshUsage() {
    if (disposed) return Promise.reject(new Error('Service disposed'));
    if (usageFlight) return usageFlight;
    const id = generation;
    usageController = new AbortController();
    const signal = AbortSignal.any([usageController.signal, AbortSignal.timeout(30000)]);
    usage = { ...emptyUsage(), state: 'loading' };
    const run = serial(async () => {
      try {
        signal.throwIfAborted();
        const token = await auth.accessToken({ signal });
        signal.throwIfAborted();
        // Fixed origin: do not send subscription credentials to a client-supplied URL.
        const response = await fetcher('https://chatgpt.com/backend-api/wham/usage', {
          headers: { authorization: `Bearer ${token.accessToken}`, accept: 'application/json',
            ...(token.accountId ? { 'ChatGPT-Account-ID': token.accountId } : {}) }, signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        if (active(id)) {
          const primary = usageWindow(body.rate_limit?.primary_window), secondary = usageWindow(body.rate_limit?.secondary_window);
          usage = { state: primary || secondary ? 'ready' : 'unavailable', primary, secondary, updatedAt: now(), error: primary || secondary ? null : '服务端未返回额度窗口。' };
        }
      } catch (error) {
        if (active(id)) usage = { ...emptyUsage(), state: 'error', error: safeError(error) };
      }
      return status();
    });
    usageFlight = run;
    void run.finally(() => { if (usageFlight === run) usageFlight = undefined; }).catch(() => {});
    return run;
  }
  return {
    status, beginLogin, refreshUsage,
    async cancelLogin() { invalidate('cancelled'); return status(); },
    async signOut() {
      invalidate('idle'); usage = emptyUsage();
      await serial(() => clear(options.authFile()));
      return status();
    },
    async dispose() { disposed = true; invalidate('cancelled'); await writes; },
  };
}

export function createAccountRpc(service) {
  const methods = { status: 'status', 'login/start': 'beginLogin', 'login/cancel': 'cancelLogin', 'usage/refresh': 'refreshUsage', 'logout': 'signOut' };
  return async (method, payload) => {
    if (!Object.hasOwn(methods, method) || !payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length) {
      return { ok: false, error: { code: 'chatgpt/invalid-request', message: '不支持的账号操作。', details: {} } };
    }
    try { return { ok: true, value: await service[methods[method]]() }; }
    catch { return { ok: false, error: { code: 'chatgpt/request-failed', message: '账号操作失败，请重试。', details: {} } }; }
  };
}

/** Cap for one account RPC body; every method takes an empty payload. */
const MAX_BODY_BYTES = 64 * 1024;
/** One endpoint segment, mirroring the transport's own pattern. */
const SEGMENT = /^[A-Za-z0-9_$.-]+$/;

/**
 * Serve the account channel as a Host HTTP route.
 *
 * `connection.rpc.handle()` cannot be used: it resolves its owning context to
 * the connection service's construction context, which has no `webServer` in
 * scope, so every call throws `cannot get property "webServer" without inject`
 * on this runtime. Registering the route directly means this code owns the
 * fence, so `connection.admit()` is applied explicitly — a bare `webServer`
 * route is unauthenticated.
 *
 * @param options - channel, the RPC handler, and the connection service.
 * @returns a node:http request handler.
 */
export function createAccountRoute(options) {
  const { channel, handler, connection } = options;
  const endpointOf = (pathname) => {
    const prefix = `${channel}/`;
    if (!pathname.startsWith(prefix)) return undefined;
    const endpoint = pathname.slice(prefix.length);
    if (endpoint.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || !SEGMENT.test(segment))) return undefined;
    return endpoint;
  };
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  return async (req, res) => {
    // Host/Origin fence plus browser authentication, exactly as the RPC
    // transport applies it. Without this the route would be world-readable.
    let admission;
    try {
      admission = connection.admit(req);
    } catch {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    if (admission?.rejection !== undefined) {
      res.writeHead(admission.rejection, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
      return;
    }
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
    } catch {
      res.writeHead(400).end();
      return;
    }
    const endpoint = endpointOf(pathname);
    if (req.method !== 'POST' || endpoint === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    if ((req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      res.writeHead(415, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('content type must be application/json');
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    const chunks = [];
    let received = 0;
    try {
      for await (const chunk of req) {
        received += chunk.byteLength;
        if (received > MAX_BODY_BYTES) {
          res.writeHead(413).end();
          req.destroy();
          return;
        }
        chunks.push(chunk);
      }
    } catch {
      res.writeHead(400).end();
      return;
    }
    let envelope;
    try {
      envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('body is not JSON');
      return;
    }
    if (envelope?.type !== 'client-request' || typeof envelope.rpcId !== 'string') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('invalid client-request envelope');
      return;
    }
    if (envelope.method !== endpoint) {
      send(res, 200, {
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: { ok: false, error: { code: 'gateway/bad-request', message: 'method does not match endpoint', details: {} } },
      });
      return;
    }
    // A handler throw must never become raw upstream text on the wire.
    let result;
    try {
      result = await handler(endpoint, envelope.payload, undefined, admission?.peer);
    } catch {
      result = { ok: false, error: { code: 'chatgpt/request-failed', message: '账号操作失败，请重试。', details: {} } };
    }
    if (res.writableEnded) return;
    send(res, 200, { type: 'server-response', rpcId: envelope.rpcId, result });
  };
}

