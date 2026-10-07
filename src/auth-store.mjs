/**
 * Codex CLI compatible credential storage.
 *
 * The file layout matches what `codex login` writes, so a machine that already
 * signed in with the official CLI is reused as-is, and a machine that signed in
 * here can keep using the CLI:
 *
 * ```json
 * {
 *   "auth_mode": "chatgpt",
 *   "OPENAI_API_KEY": null,
 *   "tokens": {
 *     "id_token": "<jwt>",
 *     "access_token": "<jwt>",
 *     "refresh_token": "<opaque>",
 *     "account_id": "<uuid>"
 *   },
 *   "last_refresh": "2026-01-01T00:00:00Z"
 * }
 * ```
 *
 * @module auth-store
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';

/** Resolve the Codex home directory, honouring `CODEX_HOME` like the CLI does. */
export function codexHome() {
  const override = process.env.CODEX_HOME;
  return override && override.trim().length > 0 ? override : join(homedir(), '.codex');
}

/**
 * Resolve the credential file path.
 * @param override - explicit path from plugin configuration; wins when non-empty.
 * @returns an absolute path to the auth file.
 */
export function authFilePath(override) {
  if (typeof override === 'string' && override.trim().length > 0) return override;
  return join(codexHome(), 'auth.json');
}

/**
 * Decode a JWT payload without verifying its signature.
 *
 * Used only to read local metadata (expiry, account id, plan). Verification is
 * the server's job; nothing here is trusted for authorization decisions.
 *
 * @param token - a compact JWS string.
 * @returns the decoded payload object, or undefined when unparseable.
 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1].length === 0) return undefined;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the ChatGPT auth claims Codex keeps in the id_token.
 * @param idToken - the raw id_token JWT.
 * @returns plan/account/email facts, with absent fields left undefined.
 */
export function readIdTokenClaims(idToken) {
  const payload = decodeJwtPayload(idToken);
  if (payload === undefined) return {};
  const auth = payload['https://api.openai.com/auth'] ?? {};
  const profile = payload['https://api.openai.com/profile'] ?? {};
  return {
    email: typeof payload.email === 'string' ? payload.email : typeof profile.email === 'string' ? profile.email : undefined,
    planType: typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined,
    userId: typeof auth.chatgpt_user_id === 'string' ? auth.chatgpt_user_id : typeof auth.user_id === 'string' ? auth.user_id : undefined,
    accountId: typeof auth.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined,
    exp: typeof payload.exp === 'number' ? payload.exp : undefined,
  };
}

/**
 * Read an access token's absolute expiry.
 * @param accessToken - the raw access_token JWT.
 * @returns epoch milliseconds, or undefined when the token carries no `exp`.
 */
export function accessTokenExpiry(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  return typeof payload?.exp === 'number' ? payload.exp * 1000 : undefined;
}

/**
 * Load stored credentials.
 * @param path - auth file path from configuration.
 * @returns the parsed state, or undefined when no usable file exists.
 */
export async function loadCredentials(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`chatgpt-subscription: ${path} is not valid JSON`);
  }
  const tokens = parsed?.tokens ?? {};
  const authMode = typeof parsed?.auth_mode === 'string' ? parsed.auth_mode : undefined;
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : undefined;
  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined;
  if (authMode === 'apikey' && typeof parsed?.OPENAI_API_KEY === 'string') {
    return { path, authMode: 'apikey', apiKey: parsed.OPENAI_API_KEY };
  }
  if (accessToken === undefined && refreshToken === undefined) return undefined;
  const idToken = typeof tokens.id_token === 'string' ? tokens.id_token : undefined;
  const claims = idToken === undefined ? {} : readIdTokenClaims(idToken);
  return {
    path,
    authMode: authMode ?? 'chatgpt',
    idToken,
    accessToken,
    refreshToken,
    accountId: typeof tokens.account_id === 'string' && tokens.account_id.length > 0 ? tokens.account_id : claims.accountId,
    email: claims.email,
    planType: claims.planType,
    lastRefresh: typeof parsed?.last_refresh === 'string' ? parsed.last_refresh : undefined,
  };
}

/**
 * Persist ChatGPT credentials in the Codex CLI layout.
 *
 * The write is atomic (temp file plus rename) so a crash cannot leave a
 * half-written credential file behind, and the file is chmod 0600.
 *
 * @param path - auth file path from configuration.
 * @param session - the token set to store.
 * @param previous - the state being replaced, so unrelated fields survive.
 */
export async function saveCredentials(path, session, previous) {
  const accountId = session.accountId ?? previous?.accountId;
  const state = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: session.idToken ?? previous?.idToken ?? '',
      access_token: session.accessToken,
      refresh_token: session.refreshToken ?? previous?.refreshToken ?? '',
      ...(accountId === undefined ? {} : { account_id: accountId }),
    },
    last_refresh: new Date().toISOString(),
  };
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
  try {
    await chmod(path, 0o600);
  } catch {
    // best effort on filesystems without POSIX modes
  }
}

/**
 * Delete stored credentials, returning to a signed-out state.
 * @param path - auth file path from configuration.
 * @returns true when a file was removed.
 */
export async function clearCredentials(path) {
  const { rm } = await import('node:fs/promises');
  try {
    await rm(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
