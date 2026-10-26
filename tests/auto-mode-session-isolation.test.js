'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionManager } = require('../src/session-manager');
const { normalizeAnthropic } = require('../src/protocol');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { AgySessionStore } = require('../src/agy-session-state');

const high = 'gemini-3.8-flash-high';
const low = 'gemini-3.8-flash-low';
const classifierSystem = 'Auto mode classification process: return <severity>N</severity>. Grade harm only.';
const user = content => ({ role: 'user', content });
const request = version => ({ headers: { authorization: 'Bearer synthetic-key',
  'user-agent': `claude-cli/${version} (external, cli)`,
  'x-claude-code-session-id': 'synthetic-shared-session' }, socket: { remoteAddress: '127.0.0.1' } });

test('Auto mode 分类使用独立状态域，并保留主对话的账号亲和与会话身份', () => {
  for (const version of ['2.1.284', '2.1.304']) {
    const manager = new SessionManager();
    const main = manager.resolveIdentity(request(version), {}, normalizeAnthropic({ system: '保留用户权限规则。', messages: [user('主任务')] }));
    const classification = normalizeAnthropic({ system: classifierSystem, messages: [user('分类合成动作')] });
    assert.equal(classification.autoMode, true);
    const auxiliary = manager.resolveIdentity(request(version), {}, classification);
    assert.equal(auxiliary.auxiliaryScope, 'auto-mode');
    assert.equal(main.auxiliaryScope, undefined);
    for (const key of ['clientId', 'sessionId', 'routingKey', 'nativeClientProfile', 'reuseConversation']) {
      assert.equal(auxiliary[key], main[key], key);
    }
    const ordinary = manager.resolveIdentity(request(version), {}, normalizeAnthropic({
      system: '请解释 Auto mode 的用途，保持权限规则。', messages: [user('普通无工具请求')] }));
    assert.equal(ordinary.auxiliaryScope, undefined, '不按关键词或无工具特征隔离普通主对话');
  }
});

for (const classifierModel of [high, low]) {
  test(`真实 Provider 状态持久化后，${classifierModel} 分类不改写主对话历史与签名`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-auto-isolation-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const manager = new SessionManager();
    const sent = [];
    let tick = Date.now();
    t.mock.method(Date, 'now', () => (tick += 2000));
    const send = async (messages, classification = false) => {
      const normalized = normalizeAnthropic({ system: classification ? classifierSystem : '保留用户权限规则。', messages });
      const identity = manager.resolveIdentity(request('2.1.304'), {}, normalized);
      // 每次新建 Provider 和 Store，覆盖真实磁盘状态恢复，而不是内存对象隔离。
      const provider = new DirectAntigravityProvider({
        sessionStore: new AgySessionStore({ directory }), accessToken: 'synthetic-token', projectId: 'synthetic-project', maxRetries: 0,
        localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:synthetic-same-account' }) },
        fetchImpl: async (_url, options) => {
          sent.push(JSON.parse(options.body));
          return new Response(JSON.stringify({ candidates: [{ content: { parts: [{
            text: classification ? '<severity>0</severity>' : '合成回答',
            thoughtSignature: classification ? 'classifier-private-signature' : 'main-private-signature'
          }] } }] }), { headers: { 'content-type': 'application/json' } });
        }
      });
      return provider.send(normalized, classification ? classifierModel : high, identity);
    };
    const history = [user('合成主任务')];
    await send(history);
    const mainFile = fs.readdirSync(directory).find(name => name.endsWith('.json'));
    const mainState = fs.readFileSync(path.join(directory, mainFile), 'utf8');
    await send([user('判断合成工具权限')], true);
    assert.equal(fs.readFileSync(path.join(directory, mainFile), 'utf8'), mainState, '分类不能改写主会话磁盘状态');
    history.push({ role: 'assistant', content: '合成回答' }, user('继续主任务'));
    await send(history);
    assert.deepEqual(sent[2].request.contents.slice(0, sent[0].request.contents.length), sent[0].request.contents);
    assert.equal(sent[2].request.systemInstruction.parts[0].text, sent[0].request.systemInstruction.parts[0].text);
    assert.equal(sent[2].request.labels.cascade_id, sent[0].request.labels.cascade_id);
    assert.notEqual(sent[1].request.labels.cascade_id, sent[0].request.labels.cascade_id);
    assert.match(JSON.stringify(sent[2]), /main-private-signature/);
    assert.doesNotMatch(JSON.stringify(sent[2]), /classifier-private-signature|判断合成工具权限/);
    const secondState = fs.readFileSync(path.join(directory, mainFile), 'utf8');
    await send([user('再次判断合成工具权限')], true);
    assert.equal(fs.readFileSync(path.join(directory, mainFile), 'utf8'), secondState);
    history.push({ role: 'assistant', content: '合成回答' }, user('再次继续主任务'));
    await send(history);
    assert.deepEqual(sent[4].request.contents.slice(0, sent[2].request.contents.length), sent[2].request.contents);
    assert.equal(sent[3].request.labels.cascade_id, sent[1].request.labels.cascade_id, '分类自身仍可复用其独立状态');
    assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.json')).length, 2);
  });
}

test('HTTP 入口对普通请求与两阶段分类传递独立状态域，修复重试也保留分类状态域', async t => {
  const { createServer } = require('../antigravity-gateway');
  const calls = [];
  let severityAttempts = 0;
  t.mock.method(DirectAntigravityProvider.prototype, 'isConfigured', () => true);
  t.mock.method(DirectAntigravityProvider.prototype, 'listModels', async () => [high, low]);
  t.mock.method(DirectAntigravityProvider.prototype, 'send', async (normalized, model, options) => {
    calls.push({ normalized, model, options });
    const text = !normalized.autoMode ? '合成回答'
      : normalized.autoModeFormat === 'block' ? '<block>no</block>'
      : ++severityAttempts === 1 ? '不完整的合成分类结果' : '<severity>0</severity>';
    return { text, toolCalls: [], usage: {} };
  });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const payloads = [
    { system: '保留用户权限规则。' },
    { system: classifierSystem },
    { system: 'Auto Mode evaluator. If the action should be blocked: <block>yes</block>. If the action should be allowed: <block>no</block>.' },
    { system: '保留用户权限规则。' }
  ];
  for (const payload of payloads) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
      method: 'POST', headers: { ...request('2.1.304').headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model: high, ...payload, messages: [user('合成输入')] })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.content[0].text, payload.system === classifierSystem ? '<severity>0</severity>'
      : payload.system.startsWith('Auto Mode evaluator') ? '<block>no</block>' : '合成回答');
  }
  assert.equal(calls.length, 5, '仅畸形的合成分类结果触发一次既有修复重试');
  assert.deepEqual(calls.map(call => call.options.auxiliaryScope), [undefined, 'auto-mode', 'auto-mode', 'auto-mode', undefined]);
  assert.ok(calls[2].options.repairInstruction);
  for (const call of calls) {
    assert.equal(call.options.sessionId, calls[0].options.sessionId);
    assert.equal(call.options.routingKey, calls[0].options.routingKey);
  }
});
