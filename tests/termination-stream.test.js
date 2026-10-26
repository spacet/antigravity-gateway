'use strict';
require('./helpers/gateway-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const { anthropicResponse, chatResponse, responsesResponse } = require('../src/protocol');
const { createAnthropicTextEmitter, createChatTextEmitter, createResponsesTextEmitter,
  emitAnthropicStream, emitChatStream, emitResponsesStream } = require('../antigravity-gateway');

function harness() {
  const frames = [];
  return { res: { write: value => frames.push(value), end() {}, writeHead() {} },
    events: () => frames.join('').split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map(line => JSON.parse(line.slice(6))) };
}

test('停止序列在 JSON、缓冲及实时 SSE 中一致保留', () => {
  const body = anthropicResponse('fixture', { text: 'ok', toolCalls: [], finishReason: 'STOP_SEQUENCE', stopSequence: '</severity>' });
  for (const live of [false, true]) {
    const h = harness();
    if (live) { const emitter = createAnthropicTextEmitter(h.res, 'fixture'); emitter.onDelta('ok'); emitter.finish(body); }
    else emitAnthropicStream(h.res, body);
    assert.deepEqual(h.events().find(e => e.type === 'message_delta').delta, { stop_reason: 'stop_sequence', stop_sequence: '</severity>' });
  }
});

test('JSON 与缓冲、实时 SSE 的预算、安全、正常终止状态一致', () => {
  for (const finishReason of ['MAX_TOKENS', 'SAFETY', 'STOP']) {
    const result = { text: 'fixture', toolCalls: [], finishReason };
    for (const live of [false, true]) {
      for (const [response, buffered, create, protocol] of [
        [anthropicResponse, emitAnthropicStream, createAnthropicTextEmitter, 'anthropic'],
        [chatResponse, emitChatStream, createChatTextEmitter, 'chat'],
        [responsesResponse, emitResponsesStream, createResponsesTextEmitter, 'responses']
      ]) {
        const body = response('fixture', result, 'r');
        const h = harness();
        if (live) { const emitter = create(h.res, 'fixture'); emitter.onDelta('fixture'); emitter.finish(body); }
        else buffered(h.res, body);
        const events = h.events();
        if (protocol === 'anthropic') assert.equal(events.find(e => e.type === 'message_delta').delta.stop_reason,
          finishReason === 'MAX_TOKENS' ? 'max_tokens' : finishReason === 'SAFETY' ? 'refusal' : 'end_turn');
        else if (protocol === 'chat') assert.equal(events.find(e => e.choices?.[0]?.finish_reason).choices[0].finish_reason,
          finishReason === 'MAX_TOKENS' ? 'length' : finishReason === 'SAFETY' ? 'content_filter' : 'stop');
        else assert.equal(events.at(-1).type, finishReason === 'STOP' ? 'response.completed' : 'response.incomplete');
      }
    }
  }
});
