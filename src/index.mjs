/**
 * ChatGPT subscription provider for the DeepSeek Harness.
 *
 * Registers the `chatgpt-subscription` route with `ctx.llm`, advertising a
 * ChatGPT plan's Codex models as a selectable provider card. Authentication
 * uses the official Codex CLI OAuth flow, so a ChatGPT Plus/Pro subscription
 * pays for the traffic instead of platform.openai.com credit.
 *
 * @module index
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';
import { CodexAdapter, DEFAULT_MODELS, REASONING_EFFORTS } from './codex-adapter.mjs';
import { accessTokenExpiry, authFilePath, clearCredentials, loadCredentials } from './auth-store.mjs';
import { DEFAULT_ISSUER } from './oauth.mjs';
import { createAccountService, createAccountRpc, createAccountRoute } from './account-service.mjs';

export { CLIENT_ID, DEFAULT_ISSUER, ORIGINATOR } from './oauth.mjs';

/** Plugin name as it appears in error messages and settings rows. */
export const name = 'chatgpt-subscription';

/** The LLM registry must exist before this plugin can register its route. */
export const inject = ['llm'];

/** The single provider route this plugin owns. */
export const PROVIDER = 'chatgpt-subscription';

/** Provider label shown in the model selector. */
export const DISPLAY_NAME = 'ChatGPT 订阅';

/** Host RPC channel carrying the subscription login and usage controls. */
export const ACCOUNT_CHANNEL = '/chatgpt-subscription';

/** Idle budget for one streaming read before the request is abandoned. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

/** Endpoint serving the Codex Responses protocol. */
export const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex';

/** Every reasoning tier the Codex models declare, newest tiers included. */
const EFFORT_IDS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** One catalog row the Model settings page can edit. */
const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  defaultEffort: z.union(EFFORT_IDS),
  reasoningEfforts: z.array(z.union(EFFORT_IDS)),
});

/** Live plugin configuration. Volatile fields are editable from the Web GUI. */
export const Config = z.object({
  authFile: z.string().volatile(),
  codexHome: z.string(),
  baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
  issuer: z.string().default(DEFAULT_ISSUER),
  clientId: z.string(),
  accountId: z.string().volatile(),
  models: z.array(catalogModel).default(DEFAULT_MODELS).volatile(),
  reasoningEffort: z.union(EFFORT_IDS).default('medium').volatile(),
  streamIdleTimeoutMs: z
    .number()
    .step(1)
    .min(1)
    .max(2_147_483_647)
    .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
    .volatile(),
});

/**
 * Read one configured string, ignoring blanks.
 * @param value - the raw configured value.
 * @returns the trimmed value, or undefined.
 */
function text(value) {
  const plain = unwrap(value);
  return typeof plain === 'string' && plain.trim().length > 0 ? plain.trim() : undefined;
}

/**
 * Resolve a live configuration field to its current plain value.
 *
 * Fields declared `.volatile()` are reactive references whose value must be read
 * through `get()`; ordinary fields are already plain values. Reading through
 * this helper keeps both shapes working and always reflects the latest edit.
 *
 * @param value - a configured field, possibly a reactive reference.
 * @returns the current plain value.
 */
function unwrap(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/**
 * Resolve the Codex home directory the way the CLI does.
 * @param configured - the plugin's `codexHome` value.
 * @returns an absolute directory path.
 */
function resolveCodexHome(configured) {
  const explicit = text(configured);
  if (explicit !== undefined) return explicit;
  const ambient = text(process.env.CODEX_HOME);
  return ambient ?? join(homedir(), '.codex');
}

/**
 * Validate the configured catalog, rejecting rows the runtime would refuse.
 * @param models - configured model rows.
 * @returns a detached, validated catalog.
 */
function resolveModels(models) {
  const list = Array.isArray(models) && models.length > 0 ? models : DEFAULT_MODELS;
  const seen = new Set();
  return list.map((model) => {
    const id = text(model?.id);
    if (id === undefined) throw new Error('chatgpt-subscription: every catalog model needs a non-empty id');
    if (seen.has(id)) throw new Error(`chatgpt-subscription: duplicate catalog model "${id}"`);
    seen.add(id);
    const declared = Array.isArray(model?.reasoningEfforts)
      ? model.reasoningEfforts.filter((effort) => REASONING_EFFORTS.some((known) => known.id === effort))
      : [];
    // A row that names no ladder inherits every tier this adapter knows.
    const reasoningEfforts =
      declared.length > 0 ? [...new Set(declared)] : REASONING_EFFORTS.map((effort) => effort.id);
    const requested = model?.defaultEffort;
    const defaultEffort = reasoningEfforts.includes(requested)
      ? requested
      : reasoningEfforts.includes('medium')
        ? 'medium'
        : reasoningEfforts[0];
    return {
      id,
      name: text(model?.name) ?? id,
      ...(text(model?.description) === undefined ? {} : { description: text(model.description) }),
      contextWindow: Number.isInteger(model?.contextWindow) ? model.contextWindow : 272000,
      maxTokens: Number.isInteger(model?.maxTokens) ? model.maxTokens : 128000,
      defaultEffort,
      reasoningEfforts,
    };
  });
}

/**
 * Register the ChatGPT subscription provider.
 * @param ctx - the plugin context, with `llm` injected.
 * @param config - validated live configuration.
 */
export function apply(ctx, config) {
  const authFile = () => authFilePath(text(config.authFile) ?? join(resolveCodexHome(unwrap(config.codexHome)), 'auth.json'));
  const models = () => resolveModels(unwrap(config.models));
  const reasoningEffort = () => text(config.reasoningEffort) ?? 'medium';
  const baseURL = () => text(config.baseURL) ?? DEFAULT_BASE_URL;
  const issuer = () => text(config.issuer) ?? DEFAULT_ISSUER;
  const clientId = () => text(config.clientId);
  const accountIdOverride = () => text(config.accountId);
  // The Models page drives its own editing surface for this route, so the
  // automatic settings page is turned off for this instance.
  ctx.inject(['settings'], (child) => {
    child.effect(() => {
      try {
        return child.settings.configure({ auto: false }, ctx.fiber);
      } catch (error) {
        // `configure` is keyed by owning fiber and throws when this instance
        // already holds a policy (the same plugin entry activating twice). The
        // earlier policy still stands, so adopt it rather than failing
        // activation and logging a spurious startup error.
        if (/already configured/i.test(String(error?.message ?? ''))) return undefined;
        throw error;
      }
    });
  });

  // Browser-facing subscription controls. `connection.rpc.handle()` is unusable
  // here (see createAccountRoute), so the route is registered directly and the
  // connection's own Host/Origin + browser-auth fence is applied per request.
  ctx.inject(['connection', 'webServer'], (child) => {
    const service = createAccountService({ authFile, issuer, clientId, accountIdOverride });
    const route = createAccountRoute({
      channel: ACCOUNT_CHANNEL,
      connection: child.connection,
      handler: createAccountRpc(service),
    });
    child.effect(() => child.webServer.register({ kind: 'prefix', path: ACCOUNT_CHANNEL, handler: route }));
    child.effect(() => () => service.dispose());
  });

  const adapter = new CodexAdapter({
    authFile,
    baseURL,
    issuer,
    clientId,
    accountIdOverride,
    models,
    reasoningEffort,
    streamIdleTimeoutMs: () => {
      const configured = Number(unwrap(config.streamIdleTimeoutMs));
      return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    },
    log: (message) => ctx.logger?.info?.(message),
    onRateLimits: (limits) => ctx.logger?.info?.('chatgpt-subscription: provider limits %o', limits),
  });

  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: DISPLAY_NAME,
      settingsNs: ctx.fiber.entry?.options.id ?? name,
      settingsPath: [],
    },
  ]);

  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);

  // Advertised catalogs are captured at registration time, so republish when the
  // model list changes rather than waiting for a restart.
  let registeredModels = JSON.stringify(models());
  ctx.on('loader/volatile-update', () => {
    let next;
    try {
      next = JSON.stringify(models());
    } catch (error) {
      ctx.logger?.warn?.(error);
      return;
    }
    if (next === registeredModels) return;
    registration.replace([PROVIDER]);
    registeredModels = next;
  });

  ctx.logger?.info?.('chatgpt-subscription: registered provider "%s" (auth file %s)', PROVIDER, authFile());
}

/**
 * Describe the current sign-in state for diagnostics and tooling.
 * @param config - raw configuration; only the auth path is read.
 * @returns a status record safe to print.
 */
export async function inspect(config = {}) {
  const path = authFilePath(text(config.authFile) ?? join(resolveCodexHome(unwrap(config.codexHome)), 'auth.json'));
  const state = await loadCredentials(path);
  if (state === undefined) return { authFile: path, signedIn: false };
  if (state.authMode === 'apikey') return { authFile: path, signedIn: false, reason: 'api-key-credentials' };
  const expiresAt = state.accessToken === undefined ? undefined : accessTokenExpiry(state.accessToken);
  return {
    authFile: path,
    signedIn: true,
    email: state.email,
    planType: state.planType,
    accountId: state.accountId,
    expiresAt: expiresAt === undefined ? undefined : new Date(expiresAt).toISOString(),
    expired: expiresAt === undefined ? undefined : expiresAt <= Date.now(),
  };
}

/**
 * Forget the stored ChatGPT credentials.
 * @param config - raw configuration; only the auth path is read.
 * @returns whether a credential file was removed.
 */
export async function signOut(config = {}) {
  const path = authFilePath(text(config.authFile) ?? join(resolveCodexHome(unwrap(config.codexHome)), 'auth.json'));
  return clearCredentials(path);
}
