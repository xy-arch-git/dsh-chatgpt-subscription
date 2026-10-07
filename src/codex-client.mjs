/**
 * Codex/ChatGPT backend transport for the subscription adapter.
 *
 * Owns credential resolution (including single-flight refresh), request
 * dispatch, and mapping provider failures onto Harness `LlmError` codes.
 *
 * @module codex-client
 */

import { dirname } from 'node:path';
import { mkdir, open, unlink } from 'node:fs/promises';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { accessTokenExpiry, loadCredentials, saveCredentials } from './auth-store.mjs';
import { DEFAULT_ISSUER, ORIGINATOR, refreshTokens } from './oauth.mjs';

export { accessTokenExpiry, loadCredentials, saveCredentials };

/** Refresh this long before expiry so an in-flight request never sees a dead token. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** How long a stale refresh lock may block before it is treated as abandoned. */
const LOCK_STALE_MS = 30 * 1000;

/** Poll cadence while waiting for another process to finish refreshing. */
const LOCK_POLL_MS = 150;

/**
 * Resolve the credential directory that CODEX_HOME points at.
 * @param base - the configured auth file path.
 * @returns the directory holding the auth file.
 */
export function credentialDirectory(base) {
  return dirname(base);
}

/**
 * Whether an access token is comfortably valid.
 * @param token - the access token, or undefined.
 * @returns true when it has more than the refresh margin left, or carries no expiry.
 */
function isFresh(token) {
  if (token === undefined) return false;
  const expiry = accessTokenExpiry(token);
  if (expiry === undefined) return true;
  return expiry - Date.now() > REFRESH_MARGIN_MS;
}

/**
 * Serialize a credential refresh across processes using an exclusive lock file.
 *
 * Two DSH sessions refreshing the same rotating refresh token at once would
 * invalidate one of them, so the winner refreshes and the loser re-reads.
 *
 * @param path - the auth file path the lock protects.
 * @param fn - the critical section.
 * @param log - optional diagnostic sink.
 * @returns the critical section's value.
 */
async function withCredentialLock(path, fn, log) {
  const lockPath = `${path}.refresh.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_STALE_MS;
  let handle;
  for (;;) {
    try {
      handle = await open(lockPath, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        // Steal an abandoned lock rather than deadlocking forever.
        log?.('chatgpt-subscription: stealing a stale credential refresh lock');
        try {
          await unlink(lockPath);
        } catch {
          // another process already released it
        }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      await handle.close();
      await unlink(lockPath);
    } catch {
      // the lock is already gone
    }
  }
}

/**
 * Turn a provider HTTP failure into a stable Harness failure code.
 * @param status - HTTP status.
 * @param body - raw response text.
 * @returns the classified `LlmError`.
 */
export function classifyHttpFailure(status, body) {
  let detail = body.trim();
  let providerCode;
  try {
    const parsed = JSON.parse(body);
    providerCode = parsed?.error?.code ?? parsed?.code;
    detail = parsed?.error?.message ?? parsed?.message ?? detail;
  } catch {
    // keep the raw text
  }
  const text = String(detail).slice(0, 400);
  if (status === 401 || status === 403) {
    return new LlmError(`chatgpt-subscription: authentication rejected (HTTP ${status}) — ${text}`, 'AUTH');
  }
  if (status === 429) {
    const quota = /usage limit|quota|insufficient/i.test(text);
    return new LlmError(
      `chatgpt-subscription: ${quota ? 'subscription usage limit reached' : 'rate limited'} — ${text}`,
      quota ? 'QUOTA' : 'RATE_LIMIT',
    );
  }
  if (status === 404 && providerCode === 'model_not_found') {
    return new LlmError(`chatgpt-subscription: model unavailable for this subscription — ${text}`, 'MODEL_NOT_FOUND');
  }
  if (status >= 500) {
    return new LlmError(`chatgpt-subscription: provider error (HTTP ${status}) — ${text}`, 'PROVIDER');
  }
  return new LlmError(`chatgpt-subscription: request failed (HTTP ${status}) — ${text}`, 'PROVIDER');
}

/**
 * Credential provider with single-flight refresh and cross-process locking.
 */
export class CodexAuth {
  /**
   * @param options - configuration accessors and diagnostics.
   */
  constructor(options) {
    this.options = options;
    this.inFlight = undefined;
  }

  /**
   * Read the current credential state without refreshing.
   * @returns the stored state, or undefined when signed out.
   */
  async peek() {
    return loadCredentials(this.options.authFile());
  }

  /**
   * Refresh the access token.
   *
   * Under the cross-process lock the file is re-read first: when another
   * process already refreshed while this one waited, and a fresh enough token
   * is on disk, that token is adopted instead of spending the rotated refresh
   * token a second time.
   *
   * @param signal - cancellation.
   * @param options - `force` demands a real refresh even if the token looks fresh.
   * @returns the refreshed credential state.
   */
  async refresh(signal, options = {}) {
    const path = this.options.authFile();
    const initial = await loadCredentials(path);
    if (initial?.refreshToken === undefined) {
      throw new LlmError(
        'chatgpt-subscription: no ChatGPT credentials found; sign in with a ChatGPT account from the Models settings page',
        'MISSING_CREDENTIAL',
      );
    }
    const log = this.options.log;
    return withCredentialLock(
      path,
      async () => {
        // Another process may have refreshed while we waited for the lock.
        const latest = (await loadCredentials(path)) ?? initial;
        const usable = latest.refreshToken === undefined ? initial : latest;
        if (options.force !== true && isFresh(usable.accessToken)) {
          log?.('chatgpt-subscription: adopting a token another process just refreshed');
          return usable;
        }
        log?.('chatgpt-subscription: refreshing ChatGPT access token');
        const refreshed = await refreshTokens(usable.refreshToken, {
          issuer: this.options.issuer(),
          clientId: this.options.clientId?.(),
          signal,
        });
        await saveCredentials(path, refreshed, usable);
        const saved = await loadCredentials(path);
        if (saved === undefined) {
          throw new LlmError('chatgpt-subscription: refreshed credentials could not be read back', 'INVALID_CREDENTIAL');
        }
        return saved;
      },
      log,
    );
  }

  /**
   * Obtain a usable access token, refreshing when it is missing or near expiry.
   * @param options - `force` refreshes unconditionally; `signal` cancels.
   * @returns the access token and the account id to bind it to.
   */
  async accessToken(options = {}) {
    if (this.inFlight !== undefined && options.force !== true) return this.inFlight;
    const run = (async () => {
      const path = this.options.authFile();
      let state = await loadCredentials(path);
      if (state === undefined) {
        throw new LlmError(
          'chatgpt-subscription: this route has no ChatGPT credentials yet; open the Models settings page and sign in with your ChatGPT plan, or run `codex login` so the shared auth file exists',
          'MISSING_CREDENTIAL',
        );
      }
      if (state.authMode === 'apikey') {
        throw new LlmError(
          'chatgpt-subscription: the credential file holds an API key, not a ChatGPT subscription session; sign in with a ChatGPT account instead',
          'INVALID_CREDENTIAL',
        );
      }
      if (options.force === true) {
        state = await this.refresh(options.signal, { force: true });
      } else if (!isFresh(state.accessToken)) {
        state = await this.refresh(options.signal);
      }
      const token = state.accessToken;
      const accountId = this.options.accountIdOverride?.() ?? state.accountId;
      if (token === undefined) {
        throw new LlmError('chatgpt-subscription: credential refresh produced no access token', 'INVALID_CREDENTIAL');
      }
      return { accessToken: token, accountId, state };
    })();
    if (options.force !== true) {
      this.inFlight = run;
      try {
        return await run;
      } finally {
        this.inFlight = undefined;
      }
    }
    return run;
  }
}

/**
 * POST one Responses request and return the raw streaming response.
 *
 * @param url - the full endpoint URL.
 * @param body - the serialized request body.
 * @param auth - access token and account binding.
 * @param sessionId - the Harness session id sent as a routing hint.
 * @param signal - cancellation.
 * @returns the streaming HTTP response.
 */
export async function postResponses(url, body, auth, sessionId, signal) {
  const headers = {
    authorization: `Bearer ${auth.accessToken}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    originator: ORIGINATOR,
    'user-agent': 'codex_cli_rs/0.0.0 (dsh-chatgpt-subscription)',
    ...(auth.accountId === undefined ? {} : { 'ChatGPT-Account-ID': auth.accountId }),
    ...(sessionId === undefined ? {} : { session_id: String(sessionId) }),
  };
  return fetch(url, { method: 'POST', headers, body, signal });
}

/** Default issuer used when configuration omits one. */
export { DEFAULT_ISSUER, ORIGINATOR };
