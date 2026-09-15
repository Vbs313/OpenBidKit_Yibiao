const test = require('node:test');
const assert = require('node:assert/strict');
const { assessParseQuality, pickWorstParseQuality } = require('./normalizeWorkspaceMarkdown.cjs');

test('mineru output with GFM tables is ok', () => {
  const md = [
    '# tender',
    '| factor | score |',
    '| --- | --- |',
    '| tech | 55 |',
    'x'.repeat(5000),
  ].join('\n');
  const quality = assessParseQuality(md, { provider: 'mineru-accurate-api', sourcePath: 'C:/a.pdf' });
  assert.equal(quality.level, 'ok');
  assert.equal(quality.suggestMinerU, false);
});

test('local structured source with table hints and zero tables warns', () => {
  const md = [
    '评标办法',
    '技术方案评分因素包括实施计划与服务承诺',
    'x'.repeat(5000),
  ].join('\n');
  const quality = assessParseQuality(md, { provider: 'local', sourcePath: 'C:/tender.docx' });
  assert.equal(quality.level, 'warn');
  assert.equal(quality.reason, 'no_gfm_tables');
  assert.equal(quality.suggestMinerU, true);
  assert.match(quality.message, /MinerU/);
});

test('local short text without table hints is ok', () => {
  const quality = assessParseQuality('短文档无表', { provider: 'local', sourcePath: 'C:/a.docx' });
  assert.equal(quality.level, 'ok');
});

test('html residual is poor', () => {
  const quality = assessParseQuality('body <table><tr><td>x</td></tr></table>', {
    provider: 'local',
    sourcePath: 'C:/a.docx',
  });
  assert.equal(quality.level, 'poor');
  assert.equal(quality.reason, 'html_table_residual');
});

test('pickWorstParseQuality prefers poor over warn over ok', () => {
  const worst = pickWorstParseQuality([
    { level: 'ok' },
    { level: 'warn' },
    { level: 'poor' },
  ]);
  assert.equal(worst.level, 'poor');
});
