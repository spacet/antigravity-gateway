'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAutoMode, finalizeModelResult, anthropicResponse } = require('../src/protocol');

test('正常停止序列保留结束原因和序列本身', () => {
  const body = anthropicResponse('fixture', { text: 'ok', toolCalls: [], finishReason: 'STOP_SEQUENCE', stopSequence: '</severity>' });
  assert.equal(body.stop_reason, 'stop_sequence');
  assert.equal(body.stop_sequence, '</severity>');
});
test('工具选择和结构约束不能覆盖无工具的安全及预算终止', () => {
  for (const finishReason of ['SAFETY', 'MAX_TOKENS']) for (const toolChoice of ['required', { type: 'tool', name: 'shell' }]) {
    const result = finalizeModelResult({ tools: [], toolChoice, structuredSchema: { type: 'object' } }, { text: '', toolCalls: [], finishReason });
    assert.equal(anthropicResponse('fixture', result).stop_reason, finishReason === 'SAFETY' ? 'refusal' : 'max_tokens');
  }
});
test('完整 thinking 可以包含普通尖括号，但不能隐藏冲突或多余正文', () => {
  for (const format of ['severity', 'block']) {
    const verdict = format === 'severity' ? '<severity>0</severity>' : '<block>no</block>';
    const text = `<thinking>compare x < 3 and y > 2</thinking>${verdict}`;
    assert.equal(normalizeAutoMode(text, format), text);
    for (const prefix of ['<thinking><block>yes</block></thinking>', '<thinking><severity>99</severity></thinking>', '<thinking>unfinished', '<thinking>a<thinking>b</thinking>']) {
      assert.throws(() => normalizeAutoMode(prefix + verdict, format), { code: 'invalid_auto_mode_classifier_output' });
    }
  }
});
test('双版本 reason 正文保留比较符和重定向但拒绝嵌套标签', () => {
  for (const version of ['2.1.284', '2.1.304']) {
    const evidence = require(`./fixtures/claude-code-${version}-classifier-evidence.json`);
    assert.ok(evidence.excerpts.find(e => e.label === 'parsers').text.includes('<reason>([\\s\\S]*?)'));
  }
  const wrap = reason => `<block>yes</block><category>Data Exfiltration</category><reason>[Data Exfiltration] ${reason}</reason>`;
  for (const reason of ['command uses x < 3 and y > 2', 'cat <input >output', 'x <= 3 && y >= 2']) {
    assert.equal(normalizeAutoMode(wrap(reason)), wrap(reason));
  }
  for (const reason of ['<block>no</block>', '<severity>0</severity>', '<reason>nested</reason>', '<category>Other</category>', '<thinking>hidden</thinking>', '<unknown>body</unknown>']) {
    assert.throws(() => normalizeAutoMode(wrap(reason)), { code: 'invalid_auto_mode_classifier_output' });
  }
});

test('block 条件字段拒绝放行解释冲突和阻断理由缺少规则前缀', () => {
  for (const text of [
    '<block>no</block><category>Data Exfiltration</category>',
    '<block>no</block><reason>dangerous</reason>',
    '<block>yes</block><category>Data Exfiltration</category><reason>not prefixed</reason>',
    '<block>yes</block><category>Data Exfiltration</category><reason>[Other Rule] mismatch</reason>'
  ]) assert.throws(() => normalizeAutoMode(text), { code: 'invalid_auto_mode_classifier_output' });
  const text = '<block>yes</block><category>Data Exfiltration</category><reason>[Data Exfiltration] synthetic</reason>';
  assert.equal(normalizeAutoMode(text), text);
});
