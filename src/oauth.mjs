/**
 * Codex CLI compatible OAuth device-code login for a ChatGPT subscription.
 *
 * This mirrors the flow implemented by the official OpenAI Codex CLI
 * (`codex-rs/login/src/device_code_auth.rs` and `.../server.rs`):
 *
 *   1. POST {issuer}/api/accounts/deviceauth/usercode   -> device_auth_id + user_code
 *   2. user opens {issuer}/codex/device and enters user_code
 *   3. POST {issuer}/api/accounts/deviceauth/token      -> authorization_code + PKCE pair
 *   4. POST {issuer}/oauth/token                        -> id/access/refresh tokens
 *
 * The `originator` header is part of the request identity envelope. The shared
 * public client id is tied to a server-side originator allowlist, so the value
 * must stay `codex_cli_rs`; any other originator makes auth.openai.com refuse
 * the exchange.
 *
 * @module oauth
 */

/** The public Codex CLI OAuth client id. Tied to the originator allowlist. */
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** Default OAuth issuer used by the Codex CLI. */
export const DEFAULT_ISSUER = 'https://auth.openai.com';

/**
 * Request identity marker the auth server allowlists for {@link CLIENT_ID}.
 * Do not change: a foreign literal is rejected during the token exchange.
 */
export const ORIGINATOR = 'codex_cli_rs';

/** Device codes are short-lived; match the CLI's 15 minute budget. */
const MAX_WAIT_MS = 15 * 60 * 1000;

/** Default poll interval when the server omits one. */
const DEFAULT_INTERVAL_SECONDS = 5;

/** Everything the OAuth requests send, so a caller can route them through a proxy. */
function baseHeaders() {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    originator: ORIGINATOR,
    'user-agent': 'codex_cli_rs/0.0.0 (dsh-chatgpt-subscription)',
  };
}

/**
 * Exchange an OAuth error body for a readable message without leaking tokens.
 * @param status - HTTP status of the failed response.
 * @param body - raw response text.
 * @returns a single-line diagnostic.
 */
function describeFailure(status, body) {
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body);
    const error = parsed?.error;
    if (typeof error === 'string') {
      detail = `${error}${parsed.error_description ? `: ${parsed.error_description}` : ''}`;
    } else if (error && typeof error.message === 'string') {
      detail = error.message;
    }
  } catch {
    // keep the raw text
  }
  return `HTTP ${status}${detail.length > 0 ? ` — ${detail.slice(0, 300)}` : ''}`;
}

/**
 * POST a JSON body and decode a JSON response, raising a readable error otherwise.
 * @param url - absolute endpoint.
 * @param payload - JSON request body.
 * @param signal - cancellation for the request.
 * @returns the decoded JSON value.
 */
async function postJson(url, payload, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: baseHeaders(),
    body: JSON.stringify(payload),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`chatgpt-subscription: ${url} failed: ${describeFailure(response.status, text)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`chatgpt-subscription: ${url} returned a non-JSON body`);
  }
}

/**
 * Ask the issuer for a device code and the URL the user must visit.
 * @param options - issuer override plus cancellation.
 * @returns the pending grant the polling step consumes.
 */
export async function requestDeviceCode(options = {}) {
  const issuer = (options.issuer ?? DEFAULT_ISSUER).replace(/\/+$/, '');
  const body = await postJson(
    `${issuer}/api/accounts/deviceauth/usercode`,
    { client_id: CLIENT_ID },
    options.signal,
  );
  const deviceAuthId = body.device_auth_id;
  const userCode = body.user_code ?? body.usercode;
  if (typeof deviceAuthId !== 'string' || typeof userCode !== 'string') {
    throw new Error('chatgpt-subscription: device code response lacked device_auth_id/user_code');
  }
  const interval = Number.parseInt(String(body.interval ?? DEFAULT_INTERVAL_SECONDS), 10);
  return {
    issuer,
    deviceAuthId,
    userCode,
    intervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_SECONDS,
    verificationUrl: `${issuer}/codex/device`,
  };
}

/**
 * Poll until the user finishes the browser step.
 *
 * The server answers 403/404 while the grant is still pending, so those two
 * statuses mean "keep waiting" rather than "failed".
 *
 * @param pending - the grant returned by {@link requestDeviceCode}.
 * @param options - cancellation and progress reporting.
 * @returns the authorization code plus the PKCE pair the token exchange needs.
 */
export async function pollForAuthorization(pending, options = {}) {
  const deadline = Date.now() + MAX_WAIT_MS;
  const url = `${pending.issuer}/api/accounts/deviceauth/token`;
  for (;;) {
    options.signal?.throwIfAborted?.();
    if (Date.now() >= deadline) {
      throw new Error('chatgpt-subscription: device authorization timed out after 15 minutes');
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: baseHeaders(),
      body: JSON.stringify({
        device_auth_id: pending.deviceAuthId,
        user_code: pending.userCode,
      }),
      signal: options.signal,
    });
    if (response.ok) {
      const body = await response.json();
      if (typeof body.authorization_code !== 'string') {
        throw new Error('chatgpt-subscription: device token response lacked authorization_code');
      }
      return {
        authorizationCode: body.authorization_code,
        codeChallenge: body.code_challenge,
        codeVerifier: body.code_verifier,
      };
    }
    const text = await response.text();
    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`chatgpt-subscription: device authorization failed: ${describeFailure(response.status, text)}`);
    }
    options.onPending?.(pending);
    const remaining = deadline - Date.now();
    await sleep(Math.min(pending.intervalSeconds * 1000, Math.max(remaining, 0)), options.signal);
  }
}

/**
 * Exchange the authorization code for subscription tokens.
 * @param pending - the pending grant, supplying the issuer.
 * @param authorization - the successful poll result.
 * @param options - cancellation.
 * @returns the decoded token response.
 */
export async function exchangeAuthorizationCode(pending, authorization, options = {}) {
  const issuer = pending.issuer;
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorization.authorizationCode,
    redirect_uri: `${issuer}/deviceauth/callback`,
    client_id: CLIENT_ID,
  });
  if (typeof authorization.codeVerifier === 'string' && authorization.codeVerifier.length > 0) {
    form.set('code_verifier', authorization.codeVerifier);
  }
  const response = await fetch(`${issuer}/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      originator: ORIGINATOR,
      'user-agent': 'codex_cli_rs/0.0.0 (dsh-chatgpt-subscription)',
    },
    body: form.toString(),
    signal: options.signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`chatgpt-subscription: token exchange failed: ${describeFailure(response.status, text)}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('chatgpt-subscription: token exchange returned a non-JSON body');
  }
  if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
    throw new Error('chatgpt-subscription: token exchange response lacked access_token/refresh_token');
  }
  return {
    idToken: typeof body.id_token === 'string' ? body.id_token : '',
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
  };
}

/**
 * Refresh an access token using the stored refresh token.
 * @param refreshToken - the long-lived refresh credential.
 * @param options - issuer override, cancellation, and a custom client id.
 * @returns refreshed tokens, including a rotated refresh token when the server sends one.
 */
export async function refreshTokens(refreshToken, options = {}) {
  const issuer = (options.issuer ?? DEFAULT_ISSUER).replace(/\/+$/, '');
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: options.clientId ?? CLIENT_ID,
    scope: 'openid profile email',
  });
  const response = await fetch(`${issuer}/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      originator: ORIGINATOR,
      'user-agent': 'codex_cli_rs/0.0.0 (dsh-chatgpt-subscription)',
    },
    body: form.toString(),
    signal: options.signal,
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`chatgpt-subscription: token refresh failed: ${describeFailure(response.status, text)}`);
    error.code = 'REFRESH_FAILED';
    throw error;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('chatgpt-subscription: token refresh returned a non-JSON body');
  }
  if (typeof body.access_token !== 'string') {
    throw new Error('chatgpt-subscription: token refresh response lacked access_token');
  }
  return {
    idToken: typeof body.id_token === 'string' ? body.id_token : undefined,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
  };
}

/**
 * Abortable sleep that rejects promptly when its signal fires.
 * @param ms - milliseconds to wait.
 * @param signal - optional cancellation.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
