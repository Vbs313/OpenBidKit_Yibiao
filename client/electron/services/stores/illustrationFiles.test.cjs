const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createIllustrationFiles } = require('./illustrationFiles.cjs');

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-illus-'));
  const technicalPlanDir = path.join(root, 'technical-plan');
  const illustrationsDir = path.join(technicalPlanDir, 'illustrations');
  const generatedIllustrationsDir = path.join(technicalPlanDir, 'generated-illustrations');
  const removed = [];
  const api = createIllustrationFiles({
    originalPlanMarkdownPath: path.join(technicalPlanDir, 'original.md'),
    illustrationsDir,
    generatedIllustrationsDir,
    removeWorkspacePathSync: (target) => {
      removed.push(target);
      fs.rmSync(target, { recursive: true, force: true });
    },
  });
  return { root, technicalPlanDir, illustrationsDir, generatedIllustrationsDir, removed, api };
}

test('saveIllustrationHtml 原子写入并返回相对与绝对路径', () => {
  const h = makeHarness();
  const saved = h.api.saveIllustrationHtml({ revision: 'v1', itemId: 'img 1', content: '<html>x</html>' });
  assert.equal(saved.relativePath, 'illustrations/v1/html/img_1.html');
  assert.equal(fs.readFileSync(saved.filePath, 'utf-8'), '<html>x</html>');
  assert.equal(fs.existsSync(saved.filePath), true);
  // 不留下临时文件
  const dir = path.dirname(saved.filePath);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
});

test('readIllustrationHtml 只允许读配图目录内的文件', () => {
  const h = makeHarness();
  const saved = h.api.saveIllustrationHtml({ revision: 'v1', itemId: 'a', content: '内容' });
  assert.equal(h.api.readIllustrationHtml(saved.relativePath), '内容');
  assert.equal(h.api.readIllustrationHtml('illustrations/../secret.md'), '');
  fs.writeFileSync(path.join(h.technicalPlanDir, 'secret.md'), '不该被读到');
  assert.equal(h.api.readIllustrationHtml('illustrations/../../secret.md'), '');
});

test('findIllustrationHtml 命中返回内容、未命中返回 null', () => {
  const h = makeHarness();
  assert.equal(h.api.findIllustrationHtml({ revision: 'v1', itemId: 'a' }), null);
  h.api.saveIllustrationHtml({ revision: 'v1', itemId: 'a', content: '已落盘' });
  const found = h.api.findIllustrationHtml({ revision: 'v1', itemId: 'a' });
  assert.equal(found.content, '已落盘');
  assert.match(found.filePath, /img|a\.html$/);
});

test('saveIllustrationPng 写入 PNG 并返回编码后的 asset URL', () => {
  const h = makeHarness();
  const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const saved = h.api.saveIllustrationPng({ revision: 'v2', itemId: 'item/1', buffer });
  assert.equal(fs.existsSync(saved.filePath), true);
  assert.deepEqual(fs.readFileSync(saved.filePath), buffer);
  assert.match(saved.assetUrl, /^yibiao-asset:\/\/generated-images\/technical-plan\/illustrations\/v2\//);
  assert.ok(saved.assetUrl.includes('item_1.png'));
});

test('clearIllustrationFiles 清理源文件与生成图片目录', () => {
  const h = makeHarness();
  h.api.saveIllustrationHtml({ revision: 'v1', itemId: 'a', content: 'x' });
  h.api.saveIllustrationPng({ revision: 'v1', itemId: 'a', buffer: Buffer.from('png') });
  h.api.clearIllustrationFiles();
  assert.deepEqual(h.removed, [h.illustrationsDir, h.generatedIllustrationsDir]);
  assert.equal(fs.existsSync(h.illustrationsDir), false);
  assert.equal(fs.existsSync(h.generatedIllustrationsDir), false);
});
