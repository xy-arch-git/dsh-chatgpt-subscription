/**
 * Translation from the Codex/ChatGPT backend Responses protocol into the
 * Harness stream chunk vocabulary.
 *
 * Two directions live here:
 *   - {@link buildRequestBody} turns Harness messages and tools into the JSON
 *     body `POST {base}/responses` expects.
 *   - {@link translateResponses} turns that endpoint's SSE event stream into
 *     `block-start` / `*-delta` / `block-end` / `usage` / `finish` chunks that
 *     `BlockAssembler` consumes.
 *
 * @module translate
 */

import { LlmError } from '@deepseek-ai/dsh-llm';

/** Harness content block types that can carry user-visible or model-authored text. */
const TEXT_BLOCK = 'text';

/**
 * Render one Harness message into the Responses `input` items it contributes.
 *
 * Assistant tool calls become `function_call` items and tool-role results become
 * `function_call_output` items, which is the linkage the backend needs to
 * continue a tool loop.
 *
 * @param message - a Harness message or request-only user input.
 * @param out - the array accumulating `input` items.
 */
function pushMessage(message, out) {
  const role = message.role;
  const content = Array.isArray(message.content) ? message.content : [];

  if (role === 'tool') {
    const callId = message.toolCallId ?? message.source?.callId;
    out.push({
      type: 'function_call_output',
      call_id: callId === undefined ? '' : String(callId),
      output: contentToText(content, message.isError === true),
    });
    return;
  }

  if (role === 'assistant') {
    const text = content
      .filter((block) => block?.type === TEXT_BLOCK)
      .map((block) => String(block.text ?? ''))
      .join('');
    if (text.length > 0) out.push({ role: 'assistant', content: text });
    for (const block of content) {
      if (block?.type !== 'tool-call') continue;
      out.push({
        type: 'function_call',
        call_id: String(block.id ?? ''),
        name: String(block.name ?? ''),
        arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
      });
    }
    // Reasoning replay is deliberately dropped: the backend owns its own
    // reasoning state and rejects foreign reasoning items.
    return;
  }

  // system / developer / user all arrive as chat roles.
  const wireRole = role === 'system' ? 'system' : role === 'developer' ? 'developer' : 'user';
  out.push({ role: wireRole, content: contentToText(content, false) });
}

/**
 * Flatten Harness content blocks into plain text for the Responses wire.
 *
 * Image and file blocks are projected to the deterministic placeholder the
 * Harness already substituted for non-vision routes; anything unexpected is
 * described rather than silently dropped.
 *
 * @param content - Harness content blocks.
 * @param isError - whether these blocks are a failed tool result.
 * @returns the text an `input` item carries.
 */
function contentToText(content, isError) {
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === TEXT_BLOCK) {
      parts.push(String(block.text ?? ''));
    } else if (block.type === 'image') {
      parts.push('[image omitted: Codex subscription routes are text-only]');
    } else if (block.type === 'file') {
      parts.push(`[file: ${String(block.path ?? block.name ?? 'attachment')}]`);
    } else if (typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  let text = parts.join('');
  if (isError) text = text.length > 0 ? `ERROR: ${text}` : 'ERROR';
  return text;
}

/**
 * Convert Harness tool declarations into Responses `tools` entries.
 * @param tools - the request's tool list, if any.
 * @returns function tool entries, or an empty array.
 */
function buildTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object') continue;
    const name = tool.name ?? tool.function?.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    if (tool.type !== undefined && tool.type !== 'function') continue;
    const schema = tool.parameters ?? tool.inputSchema ?? tool.function?.parameters ?? { type: 'object', properties: {} };
    out.push({
      type: 'function',
      name,
      ...(typeof tool.description === 'string' && tool.description.length > 0 ? { description: tool.description } : {}),
      parameters: schema,
    });
  }
  return out;
}

/**
 * Build the `POST {base}/responses` body for one Harness request.
 *
 * @param options - the Harness generate options.
 * @param call - resolved model facts for this request.
 * @returns the serializable request body.
 */
export function buildRequestBody(options, call) {
  const input = [];
  const instructions = [];
  for (const message of options.messages ?? []) {
    if (message?.role === 'system') {
      instructions.push(contentToText(Array.isArray(message.content) ? message.content : [], false));
      continue;
    }
    pushMessage(message, input);
  }
  const tools = buildTools(options.tools);
  const reasoningEffort = call.reasoningEffort ?? options.reasoningEffort;
  const body = {
    model: options.model,
    instructions: instructions.filter((text) => text.length > 0).join('\n\n'),
    input,
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    store: false,
    stream: true,
    ...(typeof call.promptCacheKey === 'string' ? { prompt_cache_key: call.promptCacheKey } : {}),
    ...(reasoningEffort === undefined || reasoningEffort === 'off'
      ? {}
      : { reasoning: { effort: reasoningEffort, summary: 'auto' } }),
  };
  if (reasoningEffort !== undefined && reasoningEffort !== 'off') {
    body.include = ['reasoning.encrypted_content'];
  }
  return body;
}

/**
 * Parse a byte stream into decoded SSE `data:` payloads.
 *
 * Handles chunk boundaries mid-event, multi-line data fields, comments, and
 * CRLF, so it is safe over arbitrary network fragmentation.
 *
 * @param body - a ReadableStream of bytes.
 * @param onActivity - called whenever bytes arrive, for idle watchdogs.
 * @returns decoded event payload strings in arrival order.
 */
export async function* parseSse(body, onActivity) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = findEventBoundary(buffer);
        if (boundary === -1) break;
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^(\r?\n){2}/, '');
        const payload = extractData(raw);
        if (payload !== undefined) yield payload;
      }
    }
    const tail = extractData(buffer);
    if (tail !== undefined) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // the response is already settled
    }
  }
}

/**
 * Find the end of the first complete SSE record.
 * @param buffer - accumulated text.
 * @returns the index just past the blank-line separator, or -1.
 */
function findEventBoundary(buffer) {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) return crlf === -1 ? -1 : crlf + 4;
  if (crlf === -1) return lf + 2;
  return Math.min(lf + 2, crlf + 4);
}

/**
 * Pull the joined `data:` payload out of one raw SSE record.
 * @param raw - one record's text.
 * @returns the payload, or undefined for comments and empty records.
 */
function extractData(raw) {
  const lines = raw.split(/\r?\n/);
  const data = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue;
    data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length === 0) return undefined;
  const joined = data.join('\n');
  return joined.length === 0 ? undefined : joined;
}

/**
 * Map the Responses `usage` object onto the Harness usage shape.
 * @param raw - the provider usage object.
 * @returns Harness token counts, or undefined when unusable.
 */
function readUsage(raw) {
  if (raw === null || typeof raw !== 'object') return undefined;
  const input = numberOrUndefined(raw.input_tokens);
  const output = numberOrUndefined(raw.output_tokens);
  const cached = numberOrUndefined(raw.input_tokens_details?.cached_tokens);
  const reasoning = numberOrUndefined(raw.output_tokens_details?.reasoning_tokens);
  if (input === undefined && output === undefined) return undefined;
  const usage = { inputTokens: input ?? 0, outputTokens: output ?? 0 };
  if (cached !== undefined) usage.cacheReadTokens = cached;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  return usage;
}

/** Coerce a wire number to a non-negative integer. */
function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

/**
 * Translate the Responses SSE stream into Harness stream chunks.
 *
 * Block indices follow `response.output_item.added` order, matching the order
 * the response reports its items in.
 *
 * @param events - decoded SSE payload strings.
 * @param onUnknown - reports event types this adapter intentionally ignores.
 * @returns Harness stream chunks ending in exactly one `finish`.
 */
export async function* translateResponses(events, onUnknown) {
  /** Wire item id -> assigned block index and accumulated state. */
  const blocks = new Map();
  let nextIndex = 0;
  let usage;
  let finishReason;
  let sawContent = false;
  let failure;
  let stopped = false;

  const indexFor = (itemId) => {
    let index = blocks.get(itemId);
    if (index === undefined) {
      index = { index: nextIndex++, type: undefined, callId: undefined, name: undefined, arguments: '' };
      blocks.set(itemId, index);
    }
    return index;
  };

  for await (const payload of events) {
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (event === null || typeof event !== 'object') continue;
    const kind = typeof event.type === 'string' ? event.type : '';

    if (kind === 'response.output_text.delta') {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (delta.length === 0) continue;
      const target = indexFor(event.item_id ?? 'output_text');
      target.type ??= 'text';
      sawContent = true;
      yield { type: 'text-delta', index: target.index, text: delta };
      continue;
    }

    if (kind === 'response.reasoning_summary_text.delta' || kind === 'response.reasoning_text.delta') {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (delta.length === 0) continue;
      const target = indexFor(`${event.item_id ?? 'reasoning'}#${event.summary_index ?? event.content_index ?? 0}`);
      target.type ??= 'reasoning';
      sawContent = true;
      yield { type: 'reasoning-delta', index: target.index, text: delta };
      continue;
    }

    if (kind === 'response.output_item.added') {
      const item = event.item;
      if (item === null || typeof item !== 'object') continue;
      if (item.type === 'reasoning') continue;
      const target = indexFor(item.id ?? item.call_id ?? `item-${nextIndex}`);
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        target.type = 'tool-call';
        target.callId = typeof item.call_id === 'string' ? item.call_id : target.callId;
        target.name = typeof item.name === 'string' ? item.name : target.name;
        if (typeof item.arguments === 'string') target.arguments = item.arguments;
        yield {
          type: 'tool-call-delta',
          index: target.index,
          id: target.callId ?? '',
          name: target.name ?? '',
          argumentsDelta: '',
        };
      } else if (item.type === 'message' || item.type === 'output_text') {
        target.type ??= 'text';
      }
      continue;
    }

    if (kind === 'response.function_call_arguments.delta' || kind === 'response.custom_tool_call_input.delta') {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      const target = indexFor(event.item_id ?? event.call_id ?? 'tool');
      target.type = 'tool-call';
      target.callId ??= typeof event.call_id === 'string' ? event.call_id : undefined;
      target.arguments += delta;
      if (delta.length === 0) continue;
      yield {
        type: 'tool-call-delta',
        index: target.index,
        id: target.callId ?? '',
        ...(target.name === undefined ? {} : { name: target.name }),
        argumentsDelta: delta,
      };
      continue;
    }

    if (kind === 'response.output_item.done') {
      const item = event.item;
      if (item === null || typeof item !== 'object') continue;
      if (item.type === 'reasoning') continue;
      const target = indexFor(item.id ?? item.call_id ?? `item-${nextIndex}`);
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        const callId = typeof item.call_id === 'string' ? item.call_id : target.callId ?? '';
        const name = typeof item.name === 'string' ? item.name : target.name ?? '';
        const args = typeof item.arguments === 'string' ? item.arguments : target.arguments;
        sawContent = true;
        yield {
          type: 'block-end',
          index: target.index,
          block: { type: 'tool-call', id: String(callId), name: String(name), arguments: args.length > 0 ? args : '{}' },
        };
        continue;
      }
      if (target.type === 'text') {
        const text = typeof item.content === 'string' ? item.content : undefined;
        if (text !== undefined) {
          yield { type: 'block-end', index: target.index, block: { type: 'text', text } };
        }
      } else if (target.type === 'reasoning') {
        sawContent = true;
      }
      continue;
    }

    if (kind === 'response.completed' || kind === 'response.incomplete') {
      const response = event.response;
      usage = readUsage(response?.usage) ?? usage;
      if (kind === 'response.incomplete') {
        const reason = response?.incomplete_details?.reason;
        finishReason =
          reason === 'max_output_tokens'
            ? { kind: 'max-tokens' }
            : reason === 'content_filter'
              ? { kind: 'stop' }
              : { kind: 'stop' };
      } else if (response?.end_turn === false) {
        finishReason = { kind: 'tool-calls' };
      } else {
        finishReason = { kind: 'stop' };
      }
      if (blocks.size > 0) {
        for (const [id, target] of blocks) {
          if (target.type === 'tool-call') {
            finishReason = { kind: 'tool-calls' };
            void id;
            break;
          }
        }
      }
      sawContent = sawContent || blocks.size > 0;
      stopped = true;
      continue;
    }

    if (kind === 'response.failed' || kind === 'error') {
      const detail =
        event.response?.error?.message ?? event.error?.message ?? event.message ?? 'Codex reported a failed response';
      failure = new LlmError(`chatgpt-subscription: ${String(detail)}`, 'PROVIDER');
      continue;
    }

    onUnknown?.(kind);
  }

  if (failure !== undefined) {
    yield { type: 'finish', reason: { kind: 'error', failure } };
    return;
  }
  if (!stopped && blocks.size === 0 && usage === undefined) {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: new LlmError('chatgpt-subscription: response stream ended without completion', 'TRANSPORT') },
    };
    return;
  }
  if (!sawContent && finishReason?.kind === 'stop') {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: new LlmError('chatgpt-subscription: provider returned no content', 'EMPTY_RESPONSE') },
    };
    return;
  }
  if (usage !== undefined) yield { type: 'usage', usage };
  yield { type: 'finish', reason: finishReason ?? { kind: 'stop' } };
}
