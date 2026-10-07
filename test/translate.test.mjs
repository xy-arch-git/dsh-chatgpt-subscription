/**
 * Offline conformance tests for the Codex adapter's translation layer.
 *
 * These drive synthetic Responses-protocol SSE streams through the real
 * translator and assert the emitted Harness chunks, so the wire contract is
 * verified without any network access.
 *
 * Run: node test/translate.test.mjs
 */

import assert from 'node:assert/strict';
import { buildRequestBody, parseSse, translateResponses } from '../src/translate.mjs';

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
 * Feed an array of SSE event names/objects through the real byte parser.
 * @param entries - [eventName, payloadObject] pairs.
 * @param chunkSize - bytes per simulated network chunk.
 * @returns decoded payload strings.
 */
async function feed(entries, chunkSize = 7) {
  const text = entries.map(([, payload]) => `event: message\ndata: ${JSON.stringify(payload)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  let position = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (position >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(position, position + chunkSize));
      position += chunkSize;
    },
  });
  const collected = [];
  for await (const payload of parseSse(stream)) collected.push(payload);
  return collected;
}

/**
 * Collect every chunk produced for a synthetic stream.
 * @param entries - [eventName, payloadObject] pairs.
 * @returns the emitted chunks.
 */
async function collect(entries) {
  const text = entries.map(([, payload]) => `event: message\ndata: ${JSON.stringify(payload)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  let position = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (position >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(position, position + 7));
      position += 7;
    },
  });
  const chunks = [];
  for await (const chunk of translateResponses(parseSse(stream))) chunks.push(chunk);
  return chunks;
}

/** A minimal completed-response envelope carrying usage. */
const completed = (usage, extra = {}) => ({
  type: 'response.completed',
  response: { id: 'resp_1', usage, end_turn: true, ...extra },
});

await test('SSE parser survives 1-byte fragmentation and multi-event streams', async () => {
  const payloads = await feed(
    [
      ['a', { type: 'response.created', response: { id: 'r1' } }],
      ['b', { type: 'response.output_text.delta', delta: 'hi' }],
    ],
    1,
  );
  assert.equal(payloads.length, 2);
  assert.equal(JSON.parse(payloads[1]).delta, 'hi');
});

await test('plain text stream yields deltas, usage and a stop finish', async () => {
  const chunks = await collect([
    ['e', { type: 'response.created', response: { id: 'r1' } }],
    ['e', { type: 'response.output_item.added', item: { id: 'msg_1', type: 'message' } }],
    ['e', { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Hello' }],
    ['e', { type: 'response.output_text.delta', item_id: 'msg_1', delta: ' world' }],
    ['e', completed({ input_tokens: 11, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } })],
  ]);
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  assert.equal(text, 'Hello world');
  const usage = chunks.find((c) => c.type === 'usage');
  assert.equal(usage.usage.inputTokens, 11);
  assert.equal(usage.usage.outputTokens, 3);
  assert.equal(usage.usage.cacheReadTokens, 4);
  assert.equal(usage.usage.totalTokens, 14);
  const finals = chunks.filter((c) => c.type === 'finish');
  assert.equal(finals.length, 1, 'exactly one terminal finish');
  assert.deepEqual(finals[0].reason, { kind: 'stop' });
});

await test('function call streams as one tool-call block and finishes with tool-calls', async () => {
  const chunks = await collect([
    ['e', { type: 'response.output_item.added', item: { id: 'fc_1', type: 'function_call', call_id: 'call_abc', name: 'shell' } }],
    ['e', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"cmd":' }],
    ['e', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"ls"}' }],
    ['e', { type: 'response.output_item.done', item: { id: 'fc_1', type: 'function_call', call_id: 'call_abc', name: 'shell', arguments: '{"cmd":"ls"}' } }],
    ['e', completed({ input_tokens: 5, output_tokens: 7 })],
  ]);
  const deltas = chunks.filter((c) => c.type === 'tool-call-delta');
  assert.ok(deltas.length >= 1);
  assert.equal(deltas[0].id, 'call_abc');
  assert.equal(deltas[0].name, 'shell');
  const ends = chunks.filter((c) => c.type === 'block-end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].block.type, 'tool-call');
  assert.equal(ends[0].block.id, 'call_abc');
  assert.equal(ends[0].block.name, 'shell');
  assert.equal(ends[0].block.arguments, '{"cmd":"ls"}');
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' });
});

await test('custom tool call input deltas are accumulated too', async () => {
  const chunks = await collect([
    ['e', { type: 'response.output_item.added', item: { id: 'ct_1', type: 'custom_tool_call', call_id: 'call_ct', name: 'apply_patch' } }],
    ['e', { type: 'response.custom_tool_call_input.delta', item_id: 'ct_1', call_id: 'call_ct', delta: '*** Begin' }],
    ['e', { type: 'response.output_item.done', item: { id: 'ct_1', type: 'custom_tool_call', call_id: 'call_ct', name: 'apply_patch', arguments: '*** Begin Patch' } }],
    ['e', completed({ input_tokens: 1, output_tokens: 1 })],
  ]);
  const end = chunks.find((c) => c.type === 'block-end');
  assert.equal(end.block.name, 'apply_patch');
  assert.equal(end.block.arguments, '*** Begin Patch');
});

await test('reasoning summaries become reasoning deltas, never tool calls', async () => {
  const chunks = await collect([
    ['e', { type: 'response.output_item.added', item: { id: 'rs_1', type: 'reasoning' } }],
    ['e', { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', summary_index: 0, delta: 'Thinking' }],
    ['e', { type: 'response.output_item.added', item: { id: 'msg_1', type: 'message' } }],
    ['e', { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Answer' }],
    ['e', completed({ input_tokens: 2, output_tokens: 2 })],
  ]);
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('');
  assert.equal(reasoning, 'Thinking');
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  assert.equal(text, 'Answer');
  const indices = new Set(chunks.filter((c) => c.type.endsWith('delta')).map((c) => c.index));
  assert.equal(indices.size, 2, 'reasoning and text occupy distinct block indices');
});

await test('truncation reports max-tokens so the loop can drop unexecutable tool calls', async () => {
  const chunks = await collect([
    ['e', { type: 'response.output_text.delta', item_id: 'm', delta: 'partial' }],
    ['e', { type: 'response.incomplete', response: { id: 'r', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1, output_tokens: 900 } } }],
  ]);
  assert.deepEqual(chunks.at(-1).reason, { kind: 'max-tokens' });
});

await test('response.failed becomes a single error finish, not an exception', async () => {
  const chunks = await collect([
    ['e', { type: 'response.created', response: { id: 'r' } }],
    ['e', { type: 'response.failed', response: { error: { message: 'quota exceeded' } } }],
  ]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].type, 'finish');
  assert.equal(chunks[0].reason.kind, 'error');
  assert.match(chunks[0].reason.failure.message, /quota exceeded/);
});

await test('an empty stream is an error finish rather than a silent success', async () => {
  const chunks = await collect([['e', completed({ input_tokens: 1, output_tokens: 0 })]]);
  assert.equal(chunks.at(-1).reason.kind, 'error');
  assert.equal(chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE');
});

await test('unknown event types are ignored and reported', async () => {
  const seen = [];
  const chunks = [];
  async function* payloads() {
    for (const payload of await feed([
      ['e', { type: 'response.in_progress' }],
      ['e', { type: 'some.future.event', delta: 'x' }],
      ['e', { type: 'response.output_text.delta', item_id: 'm', delta: 'ok' }],
      ['e', completed({ input_tokens: 1, output_tokens: 1 })],
    ])) {
      yield payload;
    }
  }
  for await (const chunk of translateResponses(payloads(), (kind) => seen.push(kind))) {
    chunks.push(chunk);
  }
  assert.deepEqual(seen, ['response.in_progress', 'some.future.event']);
  assert.equal(chunks.filter((c) => c.type === 'text-delta').length, 1);
});

await test('request builder separates system instructions and links tool results by call id', async () => {
  const body = buildRequestBody(
    {
      provider: 'chatgpt-subscription',
      model: 'gpt-6-astra',
      reasoningEffort: 'high',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'You are DSH.' }] },
        { role: 'user', content: [{ type: 'text', text: 'list files' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'sure' },
            { type: 'tool-call', id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' },
          ],
        },
        { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'a.txt' }] },
      ],
      tools: [
        { name: 'shell', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
        { type: 'not-a-function', name: 'skipme' },
      ],
    },
    { reasoningEffort: 'high' },
  );
  assert.equal(body.instructions, 'You are DSH.');
  assert.equal(body.model, 'gpt-6-astra');
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(body.tool_choice, 'auto');
  assert.equal(body.tools.length, 1, 'non-function tools are excluded');
  assert.equal(body.tools[0].name, 'shell');
  assert.equal(body.input[0].role, 'user');
  assert.equal(body.input[0].content, 'list files');
  const call = body.input.find((i) => i.type === 'function_call');
  assert.equal(call.call_id, 'call_1');
  assert.equal(call.name, 'shell');
  assert.equal(call.arguments, '{"cmd":"ls"}');
  const output = body.input.find((i) => i.type === 'function_call_output');
  assert.equal(output.call_id, 'call_1');
  assert.equal(output.output, 'a.txt');
  assert.ok(!('reasoning' in body) === false);
});

await test('request builder omits reasoning entirely when effort is off', async () => {
  const body = buildRequestBody(
    { provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] },
    { reasoningEffort: 'off' },
  );
  assert.equal('reasoning' in body, false);
  assert.equal('include' in body, false);
  assert.deepEqual(body.tools, []);
});

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
