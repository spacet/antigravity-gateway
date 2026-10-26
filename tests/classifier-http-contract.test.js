'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const test = require('node:test');
process.env.ANTIGRAVITY_GATEWAY_TRANSPORT = 'direct';
process.env.ANTIGRAVITY_FAST_MODEL = '';
delete process.env.ANTIGRAVITY_GATEWAY_API_KEY;
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { createServer } = require('../antigravity-gateway');

// Exercise HTTP normalization, routing, real direct-provider decoding,
// finalization and JSON/SSE encoding. Only auth/catalog and fetch are fake.
test('正常 STOP 的无效分类仅修复一次，截断/安全/未知状态不重试', async t => {
  let attempts = 0;
  t.mock.method(DirectAntigravityProvider.prototype, 'isConfigured', () => true);
  t.mock.method(DirectAntigravityProvider.prototype, 'listModels', async () => ['gemini-3.8-flash-low']);
  t.mock.method(DirectAntigravityProvider.prototype, 'send', async (_normalized, _model, options) => {
    attempts++;
    if (attempts === 1) return { text: 'invalid', toolCalls: [], finishReason: 'STOP' };
    assert.match(options.repairInstruction, /XML verdict/);
    return { text: '<severity>0</severity>', toolCalls: [], finishReason: 'STOP' };
  });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-3.8-flash-low', system: 'Auto Mode classification process. Respond with <severity>N</severity>.', messages: [{ role: 'user', content: 'synthetic' }] })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, '<severity>0</severity>');
  assert.equal(attempts, 2);
});

test('分类真实 HTTP 链保留 thinking 与条件字段并拒绝异常判定', async t => {
  let fixture;
  t.mock.method(DirectAntigravityProvider.prototype, 'isConfigured', () => true);
  t.mock.method(DirectAntigravityProvider.prototype, 'listModels', async () => ['gemini-3.8-flash-low']);
  t.mock.method(DirectAntigravityProvider.prototype, 'access', async () => 'synthetic-token');
  t.mock.method(DirectAntigravityProvider.prototype, 'project', async () => 'synthetic-project');
  t.mock.method(DirectAntigravityProvider.prototype, 'loadAuth', () => ({ sourcePath: 'synthetic', accessToken: 'synthetic-token', refreshToken: '', projectId: 'synthetic' }));
  const send = DirectAntigravityProvider.prototype.send;
  t.mock.method(DirectAntigravityProvider.prototype, 'send', function (...args) {
    this.fetchImpl = async () => new Response(JSON.stringify({ candidates: [{
      content: { parts: fixture.text ? [{ text: fixture.text }] : [] }, finishReason: fixture.finishReason
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return send.apply(this, args);
  });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const prefix = '<thinking>synthetic reasoning</thinking>';
  const cases = [
    { format: 'severity', text: `${prefix}<severity>0</severity>`, valid: true },
    { format: 'severity', text: '<thinking>compare x < 3 and y > 2</thinking><severity>0</severity>', valid: true },
    { format: 'severity', text: '<thinking><block>yes</block></thinking><severity>0</severity>' },
    { format: 'block', text: '<block>no</block><category>Data Exfiltration</category>' },
    { format: 'block', text: '<block>yes</block><category>Data Exfiltration</category><reason>not prefixed</reason>' },
    { format: 'severity', text: `${prefix}<severity>72</severity><category>Data Exfiltration</category>`, valid: true },
    { format: 'block', text: `${prefix}<block>yes</block><category>Data Exfiltration</category><reason>[Data Exfiltration] synthetic reason</reason>`, valid: true },
    { format: 'block', text: `${prefix}<block>no</block>`, valid: true },
    { format: 'block', text: '<block>yes</block><category>Data Exfiltration</category><reason>[Data Exfiltration] command uses x < 3 and cat <input >output</reason>', valid: true },
    { format: 'block', text: '<block>yes</block><category>Data Exfiltration</category><reason>[Data Exfiltration] <block>no</block></reason>' },
    { format: 'severity', text: `${prefix}<severity>0</severity><severity>0</severity>` },
    { format: 'block', text: `${prefix}<block>yes</block><block>no</block>` },
    { format: 'severity', text: '<thinking>unfinished<severity>0</severity>' },
    { format: 'severity', text: `${prefix}<severity>0</severity>extra prose` },
    { format: 'severity', text: `${prefix}<severity>0</severity>`, finishReason: 'MAX_TOKENS' },
    { format: 'block', text: '', finishReason: 'SAFETY' },
    { format: 'severity', text: '<severity>0</severity>', finishReason: 'UNKNOWN' }
  ];
  for (const stream of [false, true]) for (const entry of cases) {
    fixture = { finishReason: 'STOP', ...entry };
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.8-flash-low', stream,
        system: entry.format === 'severity' ? 'Auto Mode classification process. Respond with <severity>N</severity>.'
          : 'Auto Mode evaluator. If the action should be blocked: <block>yes</block>. If the action should be allowed: <block>no</block>.',
        messages: [{ role: 'user', content: 'synthetic classification' }] })
    });
    assert.equal(response.status, entry.valid || stream ? 200 : 502, JSON.stringify({ stream, entry }));
    if (!entry.valid) {
      if (!stream) assert.equal((await response.json()).type, 'error');
      else {
        // Heartbeats commit SSE headers before inference; failure must be an
        // error event, never a successful classifier message_delta.
        const text = await response.text();
        assert.match(text, /event: error/);
        assert.doesNotMatch(text, /event: message_delta/);
        assert.doesNotMatch(text, /event: content_block_start/);
      }
      continue;
    }
    if (!stream) assert.equal((await response.json()).content[0].text, entry.text);
    else {
      const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      assert.equal(events.filter(e => e.delta?.type === 'text_delta').map(e => e.delta.text).join(''), entry.text);
      assert.equal(events.find(e => e.type === 'message_delta').delta.stop_reason, 'end_turn');
    }
  }
});
