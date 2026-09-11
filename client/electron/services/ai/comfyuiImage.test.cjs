const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('./comfyuiImage.cjs');

test('resolveComfyUIImageSize 解析常见尺寸写法', () => {
  assert.deepEqual(C.resolveComfyUIImageSize({}, '1024x768'), { width: 1024, height: 768 });
  assert.deepEqual(C.resolveComfyUIImageSize({}, '1024×768'), { width: 1024, height: 768 });
  assert.deepEqual(C.resolveComfyUIImageSize({}, ' 1024 X 768 '), { width: 1024, height: 768 });
  assert.deepEqual(C.resolveComfyUIImageSize({}, '512'), { width: 512, height: 512 });
  assert.deepEqual(C.resolveComfyUIImageSize({}, '2K'), { width: 2048, height: 2048 });
  assert.deepEqual(C.resolveComfyUIImageSize({}, '4k'), { width: 4096, height: 4096 });
});

test('resolveComfyUIImageSize 回退到配置值与默认方图', () => {
  assert.deepEqual(C.resolveComfyUIImageSize({ image_size: '1280x720' }, ''), { width: 1280, height: 720 });
  assert.deepEqual(C.resolveComfyUIImageSize({}, ''), { width: 1024, height: 1024 });
  assert.deepEqual(C.resolveComfyUIImageSize({}, 'auto'), { width: 1024, height: 1024 });
  assert.deepEqual(C.resolveComfyUIImageSize({}, '1K'), { width: 1024, height: 1024 });
});

test('resolveComfyUIImageSize 拒绝非 8 倍数或越界的尺寸', () => {
  // 1000 是 8 的倍数，合法；1001 不是
  assert.deepEqual(C.resolveComfyUIImageSize({}, '1000x1000'), { width: 1000, height: 1000 });
  assert.deepEqual(C.resolveComfyUIImageSize({}, '1001x1001'), { width: 1024, height: 1024 });
  assert.deepEqual(C.resolveComfyUIImageSize({}, '1024x7'), { width: 1024, height: 1024 });
});

test('parseComfyUIWorkflowJson 解析 API 格式并兼容 prompt 外层包装', () => {
  const api = { '1': { class_type: 'KSampler', inputs: {} } };
  assert.deepEqual(C.parseComfyUIWorkflowJson(JSON.stringify(api)), api);
  assert.deepEqual(C.parseComfyUIWorkflowJson(JSON.stringify({ prompt: api })), api);
});

test('parseComfyUIWorkflowJson 对无效输入给出可读错误', () => {
  assert.throws(() => C.parseComfyUIWorkflowJson('{oops'), /工作流 JSON 解析失败/);
  assert.throws(() => C.parseComfyUIWorkflowJson('[]'), /格式不正确/);
  assert.throws(() => C.parseComfyUIWorkflowJson('{"1":{"inputs":{}}}'), /不包含有效节点/);
});

test('isComfyUITextToImageWorkflow 要求采样器+文本编码+潜空间三件套', () => {
  const ok = {
    '1': { class_type: 'KSampler', inputs: {} },
    '2': { class_type: 'CLIPTextEncode', inputs: {} },
    '3': { class_type: 'EmptyLatentImage', inputs: {} },
  };
  assert.equal(C.isComfyUITextToImageWorkflow(ok), true);
  assert.equal(C.isComfyUITextToImageWorkflow({ ...ok, '3': { class_type: 'Other', inputs: {} } }), false);
  assert.equal(C.isComfyUITextToImageWorkflow(null), false);
  assert.equal(C.isComfyUITextToImageWorkflow([]), false);
});
