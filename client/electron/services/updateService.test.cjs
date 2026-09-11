const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUpdateChannel } = require('./updateService.cjs');

// 回归：'github' 是 UpdateChannel 的合法取值，UI 下拉框第一项就是它，
// 且 updateService 的 fetchLatestRelease / getUpdateDownloadUrl 都实现了 github 分支。
// 曾经的归一化函数只认 cloudflare / atomgit，把用户选的 github 静默改写成 atomgit
// （表现为：设置页选 GitHub 后永远显示「未保存」，重载后选择还会丢）。
test('normalizeUpdateChannel 保留三个合法渠道', () => {
  assert.equal(normalizeUpdateChannel('github'), 'github');
  assert.equal(normalizeUpdateChannel('cloudflare'), 'cloudflare');
  assert.equal(normalizeUpdateChannel('atomgit'), 'atomgit');
});

test('normalizeUpdateChannel 对未知 / 缺省值回退到 atomgit', () => {
  assert.equal(normalizeUpdateChannel('unknown'), 'atomgit');
  assert.equal(normalizeUpdateChannel(''), 'atomgit');
  assert.equal(normalizeUpdateChannel(undefined), 'atomgit');
  assert.equal(normalizeUpdateChannel(null), 'atomgit');
});
