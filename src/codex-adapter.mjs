/**
 * Harness LLM adapter for the ChatGPT (Codex) subscription backend.
 *
 * Registered against the Codex provider route, this adapter lists the models a
 * ChatGPT plan can reach and translates each call into one streaming
 * `POST /responses` request.
 *
 * @module codex-adapter
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { CodexAuth, classifyHttpFailure, postResponses } from './codex-client.mjs';
import { accessTokenExpiry, loadCredentials } from './auth-store.mjs';
import { buildRequestBody, parseSse, translateResponses } from './translate.mjs';

/**
 * Reasoning strengths, described the way the Codex model catalog describes them.
 *
 * The ladder is passed through to the backend verbatim, so it must never be
 * truncated: models in the `gpt-6` family accept `max` and `ultra` as well.
 */
export const REASONING_EFFORTS = [
  { id: 'low', name: 'Low', description: 'Fast responses with lighter reasoning' },
  { id: 'medium', name: 'Medium', description: 'Balances speed and reasoning depth for everyday tasks' },
  { id: 'high', name: 'High', description: 'Greater reasoning depth for complex problems' },
  { id: 'xhigh', name: 'Extra high', description: 'Extra high reasoning depth for complex problems' },
  { id: 'max', name: 'Max', description: 'Maximum reasoning depth for the hardest problems' },
  { id: 'ultra', name: 'Ultra', description: 'Maximum reasoning with automatic task delegation' },
];

/** Shorthand: every effort id, in ladder order. */
const ALL_EFFORTS = REASONING_EFFORTS.map((effort) => effort.id);

/** Shorthand: the ladder without the two newest tiers, used by `gpt-5.5`. */
const EFFORTS_TO_XHIGH = ALL_EFFORTS.slice(0, 4);

/**
 * Default catalog, transcribed from the model list the official Codex CLI ships
 * (`codex-rs/models-manager/models.json`).
 *
 * These are *presets*, not discovery: which of them a given plan may actually
 * call is decided by the backend, and an unavailable one fails with
 * `MODEL_NOT_FOUND`. Edit the list from the Models settings page.
 */
export const DEFAULT_MODELS = [
  {
    id: 'gpt-6-astra',
    name: 'GPT-6-Astra',
    description: 'Frontier intelligence for the most demanding work.',
    contextWindow: 272000,
    maxTokens: 128000,
    defaultEffort: 'low',
    reasoningEfforts: ALL_EFFORTS,
  },
  {
    id: 'gpt-6.1-sol',
    name: 'GPT-6.1-Sol',
    contextWindow: 272000,
    maxTokens: 128000,
    defaultEffort: 'low',
    reasoningEfforts: ALL_EFFORTS,
  },
  {
    id: 'gpt-6-sol',
    name: 'GPT-6-Sol',
    contextWindow: 272000,
    maxTokens: 128000,
    defaultEffort: 'medium',
    reasoningEfforts: ALL_EFFORTS,
  },
  {
    id: 'gpt-6-luna',
    name: 'GPT-6-Luna',
    contextWindow: 272000,
    maxTokens: 128000,
    defaultEffort: 'medium',
    reasoningEfforts: EFFORTS_TO_XHIGH.concat('max'),
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6-Sol',
    contextWindow: 272000,
    maxTokens: 128000,
    defaultEffort: 'low',
    reasoningEfforts: ALL_EFFORTS,
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6-Terra',
    contextWindow: 272000,
    maxTokens: 128000,
    defaultEffort: 'medium',
    reasoningEfforts: ALL_EFFORTS,
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6-Luna',
    contextWindow: 272000,
    maxTokens: 128000,
    defaultEffort: 'medium',
    reasoningEfforts: EFFORTS_TO_XHIGH.concat('max'),
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    contextWindow: 272000,
    maxTokens: 128000,
    defaultEffort: 'medium',
    reasoningEfforts: EFFORTS_TO_XHIGH,
  },
];

/** Provider-reported facts worth surfacing in logs. */
const INTERESTING_HEADERS = [
  'x-codex-primary-used-percent',
  'x-codex-secondary-used-percent',
  'x-codex-primary-reset-after-seconds',
  'x-codex-secondary-reset-after-seconds',
  'x-request-id',
  'openai-model',
];

/**
 * Read numeric rate-limit headers into a plain object.
 * @param headers - the response headers.
 * @returns provider rate-limit facts, omitting absent ones.
 */
function readRateLimitHeaders(headers) {
  const out = {};
  for (const name of INTERESTING_HEADERS) {
    const value = headers.get(name);
    if (value !== null && value.length > 0) out[name] = value;
  }
  return out;
}

/** The ChatGPT (Codex) subscription adapter. */
export class CodexAdapter extends LlmAdapter {
  /**
   * @param options - configuration accessors and diagnostics.
   */
  constructor(options) {
    super();
    this.options = options;
    this.auth = new CodexAuth({
      authFile: options.authFile,
      issuer: options.issuer,
      clientId: options.clientId,
      accountIdOverride: options.accountIdOverride,
      log: options.log,
    });
  }

  /**
   * Describe the provider route this adapter owns.
   * @param provider - the registered route id.
   * @returns display metadata for the GUI.
   */
  providerInfo(provider) {
    return { id: provider, name: 'ChatGPT 订阅' };
  }

  /**
   * Advertise the models the GUI may offer.
   * @param provider - the registered route id.
   * @returns the configured catalog.
   */
  listModels(provider) {
    return Promise.resolve(
      this.options.models().map((model) => ({
        provider,
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        inputModalities: ['text'],
      })),
    );
  }

  /**
   * Resolve capabilities for one exact model id.
   * @param provider - the registered route id.
   * @param model - the exact model id.
   * @returns resolved model metadata.
   */
  resolveModel(provider, model) {
    const configured = this.options.models().find((entry) => entry.id === model);
    // Each model carries its own ladder: the backend rejects an effort the model
    // does not declare, so never widen one model's options to another's.
    const allowed = configured?.reasoningEfforts ?? REASONING_EFFORTS.map((effort) => effort.id);
    const efforts = REASONING_EFFORTS.filter((effort) => allowed.includes(effort.id)).map((effort) => ({ ...effort }));
    const preferred = configured?.defaultEffort ?? this.options.reasoningEffort();
    const defaultEffort = efforts.some((effort) => effort.id === preferred) ? preferred : efforts[0]?.id;
    return Promise.resolve({
      provider,
      id: model,
      name: configured?.name ?? model,
      ...(configured?.description === undefined ? {} : { description: configured.description }),
      inputModalities: ['text'],
      context: { contextWindow: configured?.contextWindow ?? 272000 },
      defaultMaxTokens: configured?.maxTokens ?? 128000,
      reasoning: {
        efforts,
        ...(defaultEffort === undefined ? {} : { defaultEffort }),
      },
    });
  }

  /**
   * Bind the endpoint generation and stream entry point for one call.
   * @param provider - the registered route id.
   * @param model - the exact model id.
   * @param signal - cancellation for model resolution.
   * @returns resolved model facts plus a stream function.
   */
  async prepareCall(provider, model, signal) {
    const info = await this.resolveModel(provider, model, signal);
    return { model: info, stream: (options) => this.stream(options) };
  }

  /**
   * Report the current sign-in state for diagnostics.
   * @returns a human-readable status record.
   */
  async status() {
    const state = await loadCredentials(this.options.authFile());
    if (state === undefined) return { signedIn: false, detail: '未登录：没有找到 ChatGPT 凭据' };
    if (state.authMode === 'apikey') return { signedIn: false, detail: '凭据文件里是 API key，不是 ChatGPT 订阅会话' };
    const expiresAt = state.accessToken === undefined ? undefined : accessTokenExpiry(state.accessToken);
    return {
      signedIn: true,
      email: state.email,
      planType: state.planType,
      accountId: state.accountId,
      expiresAt: expiresAt === undefined ? undefined : new Date(expiresAt).toISOString(),
      detail: `已登录${state.email === undefined ? '' : `：${state.email}`}${state.planType === undefined ? '' : `（${state.planType}）`}`,
    };
  }

  /**
   * Stream one model call.
   * @param options - Harness generate options.
   * @yields Harness stream chunks ending in exactly one `finish`.
   */
  async *stream(options) {
    const provider = options.provider;
    let body;
    try {
      body = JSON.stringify(buildRequestBody(options, { reasoningEffort: options.reasoningEffort }));
    } catch (error) {
      yield finishError(new LlmError(`chatgpt-subscription: could not serialize the request (${error.message})`, 'INVALID_REQUEST'));
      return;
    }

    const url = `${this.options.baseURL().replace(/\/+$/, '')}/responses`;
    const timeoutMs = this.options.streamIdleTimeoutMs();
    let attempt = 0;

    for (;;) {
      attempt += 1;
      const consumer = new AbortController();
      const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([consumer.signal, options.signal]);
      let idleTimer;
      const armIdle = () => {
        if (timeoutMs <= 0) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => consumer.abort(new Error('idle timeout')), timeoutMs);
      };
      try {
        const auth = await this.auth.accessToken({ force: attempt > 1, signal });
        armIdle();
        const response = await postResponses(url, body, auth, options.sessionId, signal);
        if (!response.ok) {
          const text = await response.text();
          // A rejected token may simply have been revoked mid-flight; refresh once.
          if ((response.status === 401 || response.status === 403) && attempt === 1) continue;
          yield finishError(classifyHttpFailure(response.status, text));
          return;
        }
        if (response.body === null) {
          yield finishError(new LlmError('chatgpt-subscription: provider returned no response body', 'EMPTY_RESPONSE'));
          return;
        }
        const rateLimits = readRateLimitHeaders(response.headers);
        if (Object.keys(rateLimits).length > 0) this.options.onRateLimits?.(rateLimits);
        const events = parseSse(response.body, armIdle);
        yield* translateResponses(events, (kind) => {
          if (kind.length > 0) this.options.log?.(`chatgpt-subscription: ignoring provider event "${kind}"`);
        });
        return;
      } catch (error) {
        if (options.signal?.aborted === true) {
          yield finishError(new LlmError('chatgpt-subscription: request aborted', 'ABORTED', { cause: error }));
          return;
        }
        if (error instanceof LlmError) {
          yield finishError(error);
          return;
        }
        yield finishError(
          new LlmError(
            `chatgpt-subscription: transport failed — ${error?.message ?? String(error)}`,
            'TRANSPORT',
            { cause: error },
          ),
        );
        return;
      } finally {
        clearTimeout(idleTimer);
        consumer.abort();
      }
    }
  }
}

/**
 * Wrap a failure in the single terminal finish chunk the stream protocol requires.
 *
 * The chunk has to be a *lossless JSON value*, so the live `LlmError` cannot be
 * carried inside it: an Error is a class instance, which the stream snapshot
 * rejects outright with "Assistant stream chunk must be losslessly
 * JSON-serializable" — turning every provider failure into a second, unrelated
 * session error instead of a clean failure. `LlmError` already exposes the
 * plain frozen snapshot the runtime itself stores, so carry that.
 *
 * @param failure - the classified failure.
 * @returns a terminal finish chunk.
 */
function finishError(failure) {
  if (failure instanceof LlmError) {
    return {
      type: 'finish',
      reason: {
        // Mirrors the runtime's own adapterFailureChunk classification.
        kind: failure.code === 'ABORTED' ? 'aborted' : 'error',
        failure: failure.failure,
      },
    };
  }
  return {
    type: 'finish',
    reason: { kind: 'error', failure: { message: String(failure?.message ?? failure), code: 'UNKNOWN' } },
  };
}
