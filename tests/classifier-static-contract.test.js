'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAutoMode } = require('../src/protocol');
const evidence = require('./fixtures/claude-code-2.1.304-classifier-evidence.json');

test('2.1.304 静态 severity 契约允许仅返回分数，不强制理由或类别', () => {
  assert.equal(evidence.sha256, 'b9ac5374839f14abf3f1f45610637c332b5daee5ce0d1634726cef87aab78e6a');
  for (const value of [0, 49, 50, 72, 100]) {
    const xml = `<severity>${value}</severity>`;
    assert.equal(normalizeAutoMode(xml, 'severity'), xml);
  }
  assert.equal(normalizeAutoMode('<severity>72</severity><category>Data Exfiltration</category>', 'severity'), '<severity>72</severity><category>Data Exfiltration</category>');
});
test('2.1.304 thinking 前缀允许但重复判定与残缺 thinking 仍拒绝', () => {
  const xml = '<thinking>synthetic reasoning</thinking><severity>0</severity>';
  assert.equal(normalizeAutoMode(xml, 'severity'), xml);
  for (const text of ['<thinking>unfinished<severity>0</severity>', '<severity>0</severity><severity>0</severity>', '<severity>-1</severity>', '<severity>101</severity>']) {
    assert.throws(() => normalizeAutoMode(text, 'severity'), { code: 'invalid_auto_mode_classifier_output' });
  }
});
