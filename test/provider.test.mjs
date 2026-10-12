import test from 'node:test';
import assert from 'node:assert/strict';

// 只测 getProviderInfo 的配置解析，不发起网络请求。
// getProviderInfo 依赖环境变量与 ~/.codex，这里用独立子进程隔离 env。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const node = process.execPath;

function infoWith(env) {
  const script = `import('${join(root, 'lib', 'provider.mjs')}').then(async m => { const i = await m.getProviderInfo(); console.log(JSON.stringify({ ready: i.ready, model: i.model, source: i.source, error: i.error || '' })); });`;
  const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: '/nonexistent-codex-home', ...env };
  const r = spawnSync(node, ['--input-type=module', '-e', script], { env: cleanEnv, encoding: 'utf8' });
  const line = r.stdout.trim().split('\n').pop();
  try { return JSON.parse(line); } catch { return { parseError: true, stdout: r.stdout, stderr: r.stderr }; }
}

test('缺 API_KEY 时报错，不借用其他来源', () => {
  const i = infoWith({ XHS_BASE_URL: 'https://example.com/v1', XHS_MODEL: 'm' });
  assert.equal(i.ready, false);
  assert.match(i.error, /缺少 XHS_API_KEY/);
});

test('配置齐全时就绪且来源标注正确', () => {
  const i = infoWith({ XHS_API_KEY: 'k', XHS_BASE_URL: 'https://example.com/v1', XHS_MODEL: 'm' });
  assert.equal(i.ready, true);
  assert.equal(i.model, 'm');
  assert.equal(i.source, 'XHS 环境变量');
});

test('非 HTTPS 且非本机的地址被拒绝', () => {
  const i = infoWith({ XHS_API_KEY: 'k', XHS_BASE_URL: 'http://example.com/v1', XHS_MODEL: 'm' });
  assert.equal(i.ready, false);
  assert.match(i.error, /HTTPS/);
});

test('地址含查询参数或凭据被拒绝', () => {
  const i = infoWith({ XHS_API_KEY: 'k', XHS_BASE_URL: 'https://example.com/v1?x=1', XHS_MODEL: 'm' });
  assert.equal(i.ready, false);
});

test('缺 MODEL 时报错', () => {
  const i = infoWith({ XHS_API_KEY: 'k', XHS_BASE_URL: 'https://example.com/v1' });
  assert.equal(i.ready, false);
  assert.match(i.error, /MODEL/);
});
