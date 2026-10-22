'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccountPool, errorCategory } = require('../src/account-pool');
const { AccountStore } = require('../src/account-store');
const { QuotaManager } = require('../src/quota-manager');

function fixture(t, failure) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-refresh-health-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: directory });
  const account = store.save({ email: 'refresh@example.invalid', accessToken: 'expired-test-token',
    refreshToken: 'test-refresh', expiresAt: '2020-01-01T00:00:00Z', projectId: 'test-project',
    clientId: 'test-client', clientSecret: 'test-secret' });
  let recovered = false;
  let tokenCalls = 0;
  let quotaCalls = 0;
  const events = [];
  const fetchImpl = async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      tokenCalls += 1;
      if (!recovered) return failure();
      return Response.json({ access_token: 'new-test-token', expires_in: 3600 });
    }
    assert.match(url, /^https:\/\/(?:daily-)?cloudcode-pa\.googleapis\.com\/v1internal:(?:loadCodeAssist|fetchAvailableModels|retrieveUserQuotaSummary)$/);
    quotaCalls += 1;
    return Response.json({ models: { 'gemini-test': { quotaInfo: { remainingFraction: 0.5 } } } });
  };
  const pool = new AccountPool({ store, fallbackProvider: {}, fetchImpl,
    diagnosticReporter: (event, fields) => events.push({ event, ...fields }) });
  const manager = new QuotaManager({ configDir: directory, accountPool: pool });
  return { pool, manager, store, account, events,
    recover: () => { recovered = true; },
    counts: () => ({ tokenCalls, quotaCalls }),
    reload: () => new AccountPool({ store, fallbackProvider: {}, fetchImpl }) };
}

for (const [label, failure] of [
  ['连接失败', () => { throw new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect timed out'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
  }); }],
  ['OAuth 503', () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 })],
  ['OAuth 429', () => Response.json({ error: 'rate_limited' }, { status: 429 })]
]) {
  test(`自动刷新${label}不隔离账号，后续轮询能恢复`, async (t) => {
    const f = fixture(t, failure);
    await f.manager.refresh();
    assert.deepEqual(f.counts(), { tokenCalls: 1, quotaCalls: 0 });
    assert.equal(f.pool.status()[0].state, 'available');
    assert.equal(f.reload().status()[0].state, 'available');
    assert.equal(f.events.some((e) => e.event === 'account_health_quarantined'), false);
    f.recover();
    await f.manager.refresh();
    assert.deepEqual(f.counts(), { tokenCalls: 2, quotaCalls: 3 });
    assert.equal(f.store.list()[0].accessToken, 'new-test-token');
    assert.ok(f.manager.peek(f.account.id));
    assert.equal(f.pool.status()[0].state, 'available');
  });
}

for (const [status, error, state] of [
  [400, 'invalid_grant', 'authentication_error'],
  [401, 'UNAUTHENTICATED', 'authentication_error'],
  [403, 'Verify your account to continue', 'verification_required']
]) {
  test(`自动刷新明确认证拒绝${status}仍持久隔离，轮询不绕过`, async (t) => {
    const f = fixture(t, () => Response.json({ error }, { status }));
    await f.manager.refresh();
    assert.equal(f.pool.status()[0].state, state);
    assert.equal(f.reload().status()[0].state, state);
    f.recover();
    await f.manager.refresh();
    assert.deepEqual(f.counts(), { tokenCalls: 1, quotaCalls: 0 });
  });
}

test('DirectProvider包装刷新连接错误后保留底层连接信息', async (t) => {
  const f = fixture(t, () => { throw new TypeError('fetch failed'); });
  const provider = f.pool.entries.get(f.account.id).provider;
  await assert.rejects(provider.access(), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.code, 'local_agy_refresh_failed');
    assert.match(error.details, /fetch failed/);
    assert.equal(errorCategory(error), 'transient');
    return true;
  });
});

test('刷新服务5xx和超时状态不被登录态或refresh token文案误判', () => {
  for (const status of [408, 425, 500, 502, 503, 504]) {
    assert.equal(errorCategory({ status, code: 'local_agy_refresh_failed',
      message: '本地 agy 登录态刷新失败。', details: 'refresh token service unavailable' }), 'transient');
  }
  assert.equal(errorCategory({ status: 400, code: 'local_agy_refresh_failed',
    message: '本地 agy 登录态刷新失败。', details: 'invalid_grant' }), 'account');
});
