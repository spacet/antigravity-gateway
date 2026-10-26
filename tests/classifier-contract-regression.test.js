'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { anthropicResponse, normalizeAutoMode } = require('../src/protocol');

test('上游截断必须保留为 Anthropic max_tokens', () => {
  const response = anthropicResponse('fixture', { text: 'partial', toolCalls: [], finishReason: 'MAX_TOKENS' });
  assert.equal(response.stop_reason, 'max_tokens');
});

test('上游安全终止必须保留为 Anthropic refusal', () => {
  const response = anthropicResponse('fixture', { text: '', toolCalls: [], finishReason: 'SAFETY' });
  assert.equal(response.stop_reason, 'refusal');
});

test('严重度分类不得丢弃理由字段', () => {
  const xml = '<severity>85</severity><category>fixture</category><reason>合成理由</reason>';
  assert.equal(normalizeAutoMode(xml, 'severity'), xml);
});

test('分类重复字段必须拒绝而非静默取第一个', () => {
  assert.throws(() => normalizeAutoMode('<block>yes</block><reason>a</reason><reason>b</reason>'), { code: 'invalid_auto_mode_classifier_output' });
});
