'use strict';

// documentPipeline 的行为特征测试。
// 作用：锁住 prepareDocument / matchDocument 的「步骤推进 + 落库调用 + 错误状态」，
// 让后续继续从这个 1000 行文件里抽模块时，不会出现静默漂移。
// 说明：convert_markdown 依赖 electron 的 fileService，这里统一走「复用已存在 Markdown」分支，
// 用它来隔离出 block 构建、条目提取、匹配与补漏的纯逻辑。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDocumentPipeline } = require('./documentPipeline.cjs');

const STEP_KEYS = [
  'copy_source',
  'convert_markdown',
  'build_blocks',
  'extract_first_items',
  'extract_supplement_items',
  'merge_candidates',
  'match_batches',
  'recover_missing',
  'save_result',
];

const LONG_A = `Section A body. ${'alpha '.repeat(20)}${'A'.repeat(40)}`;
const LONG_B = `Section B body. ${'beta '.repeat(20)}${'B'.repeat(40)}`;

function makeBlocks() {
  return [
    { id: 'P000001', type: 'paragraph', heading_path: ['Heading'], content: LONG_A },
    { id: 'P000002', type: 'paragraph', heading_path: ['Heading'], content: LONG_B },
  ];
}

function makeHarness(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-doc-pipeline-'));
  const document = {
    document_id: 'doc-1',
    file_name: 'tender-doc.md',
    folder_id: 'folder-1',
    document_dir: 'docs/doc-1',
    source_path: 'docs/doc-1/source.md',
    markdown_path: 'docs/doc-1/content.md',
  };
  fs.mkdirSync(path.join(tmpDir, document.document_dir), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, document.source_path), 'source', 'utf-8');
  fs.writeFileSync(
    path.join(tmpDir, document.markdown_path),
    // 中间用语义标题分界：mergeSemanticBlocks 的合并阈值是 500 字，
    // 只有遇到语义标题才会把前一段冲出去，否则两段正文会被并成一个 block。
    `# Heading\n\n${LONG_A}\n\n**Section B**\n\n${LONG_B}\n`,
    'utf-8',
  );

  const state = {
    document: { ...document, status: 'pending' },
    steps: new Map(),
    batches: new Map(),
    blocks: [],
    filteredBlocks: [],
    candidateItems: [],
    items: [],
    matchResult: null,
  };
  const debugLogs = [];
  const updates = [];
  const aiCalls = [];
  const aiQueue = [];

  const knowledgeBaseStore = {
    readBlocks: () => state.blocks,
    readFilteredBlocks: () => state.filteredBlocks,
    saveBlocks: (id, blocks, filtered) => {
      state.blocks = blocks;
      state.filteredBlocks = filtered;
    },
    readCandidateItems: () => state.candidateItems,
    saveCandidateItems: (id, items) => {
      state.candidateItems = items;
    },
    updateMarkdownMetadata: () => {},
    getDocumentStep: (id, key) => state.steps.get(key) || null,
    saveDocumentStep: (id, key, fields) => {
      const current = state.steps.get(key) || { step_key: key };
      state.steps.set(key, { ...current, ...fields });
    },
    clearDocumentProcessingFromStep: (id, key) => {
      const start = STEP_KEYS.indexOf(key);
      STEP_KEYS.slice(start).forEach((stepKey) => state.steps.delete(stepKey));
      if (start <= STEP_KEYS.indexOf('build_blocks')) {
        state.blocks = [];
        state.filteredBlocks = [];
      }
      if (start <= STEP_KEYS.indexOf('merge_candidates')) state.candidateItems = [];
      if (start <= STEP_KEYS.indexOf('match_batches')) state.batches.clear();
      if (start <= STEP_KEYS.indexOf('save_result')) {
        state.items = [];
        state.matchResult = null;
      }
    },
    readMatchBatches: () => [...state.batches.values()],
    getMatchBatch: (id, index) => state.batches.get(Number(index)) || null,
    saveMatchBatch: (id, index, fields) => {
      const key = Number(index);
      const current = state.batches.get(key) || { batch_index: key };
      state.batches.set(key, { ...current, ...fields });
    },
    clearMatchBatches: () => state.batches.clear(),
    readItems: () => state.items,
    saveMatchResult: (id, payload) => {
      state.items = payload.finalItems;
      state.matchResult = payload.matchResult;
    },
  };

  const baseDeps = {
    baseDir: tmpDir,
    activePreparations: new Set(),
    activeMatches: new Set(),
    isDeveloperMode: () => true,
    debugLog: (id, event) => debugLogs.push(event),
    updateDocument: (id, partial) => {
      Object.assign(state.document, partial);
      updates.push(partial);
    },
    getDocument: () => state.document,
    isSamePath: (a, b) => path.resolve(String(a || '')) === path.resolve(String(b || '')),
    getStep: (id, key) => state.steps.get(key) || null,
    stepCanReuse: (step, hasArtifact) => Boolean(hasArtifact && (!step || step.status === 'success')),
    getStepItems: (id, key) => {
      const result = state.steps.get(key)?.result;
      return Array.isArray(result?.items) ? result.items : null;
    },
    isSameStringList: (a, b) => Array.isArray(a) && Array.isArray(b)
      && a.length === b.length
      && a.every((value, index) => String(value) === String(b[index])),
    isRecoveryStepResult: (value) => Boolean(
      value
      && Array.isArray(value.items)
      && Array.isArray(value.matches)
      && Array.isArray(value.discarded)
      && Array.isArray(value.system_discarded)
      && Array.isArray(value.recovery_attempts),
    ),
    runDocumentStep: async (id, key, worker) => {
      state.steps.set(key, { step_key: key, status: 'running' });
      try {
        const result = await worker();
        state.steps.set(key, { step_key: key, status: 'success', result });
        return result;
      } catch (error) {
        state.steps.set(key, { step_key: key, status: 'error', error: error.message || String(error) });
        throw error;
      }
    },
    configStore: { load: () => ({ components: { file_parser: { provider: 'local' } } }) },
    aiService: {
      getConfig: () => ({ context_length_limit: 400000 }),
      collectJsonResponse: async ({ normalizer, validator, logTitle }) => {
        aiCalls.push(logTitle);
        if (!aiQueue.length) throw new Error(`unscripted AI call: ${logTitle}`);
        const raw = aiQueue.shift();
        if (raw instanceof Error) throw raw;
        const value = normalizer ? normalizer(raw) : raw;
        if (validator) validator(value);
        return value;
      },
    },
    app: {},
    knowledgeBaseStore,
    recoveryMaxAttempts: 2,
  };

  const deps = { ...baseDeps, ...overrides };
  return {
    deps,
    state,
    aiCalls,
    aiQueue,
    debugLogs,
    updates,
    tmpDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

// 预置「准备阶段已完成」的文档状态：Markdown、block、步骤与候选条目全部齐备。
function seedPrepared(harness) {
  const blocks = makeBlocks();
  harness.state.blocks = blocks;
  harness.state.filteredBlocks = [];
  harness.state.candidateItems = [
    { id: 'K000001', title: 'Project plan', summary: 'Plan summary' },
  ];
  const steps = {
    copy_source: { step_key: 'copy_source', status: 'success', result: { source_path: 'docs/doc-1/source.md' } },
    convert_markdown: { step_key: 'convert_markdown', status: 'success', result: { markdown_chars: 200 } },
    build_blocks: { step_key: 'build_blocks', status: 'success', result: { block_count: blocks.length, filtered_block_count: 0 } },
    extract_first_items: { step_key: 'extract_first_items', status: 'success', result: { items: [{ title: 'Project plan', summary: 'Plan summary' }] } },
    extract_supplement_items: { step_key: 'extract_supplement_items', status: 'success', result: { items: [] } },
    merge_candidates: { step_key: 'merge_candidates', status: 'success', result: { candidate_item_count: 1 } },
  };
  Object.entries(steps).forEach(([key, value]) => harness.state.steps.set(key, value));
}

test('prepareDocument 从 Markdown 重建 block 并完成条目提取', async (t) => {
  const h = makeHarness();
  t.after(h.cleanup);
  h.aiQueue.push(
    { items: [{ title: 'Project plan', summary: 'Plan summary' }] },
    { items: [{ title: 'Risk control', summary: 'Risk summary' }] },
  );

  const { prepareDocument } = createDocumentPipeline(h.deps);
  await prepareDocument('doc-1', path.join(h.tmpDir, 'docs/doc-1/source.md'), {});

  assert.equal(h.state.document.status, 'ready_for_matching');
  assert.equal(h.state.document.progress, 65);
  assert.equal(h.state.document.item_count, 0, '开发模式不应自动进入匹配');
  assert.equal(h.state.candidateItems.length, 2);
  assert.deepEqual(h.state.candidateItems.map((item) => item.id), ['K000001', 'K000002']);
  assert.equal(h.state.blocks.length, 2, '两段超长正文应各自成为 block，标题被过滤');
  for (const key of [
    'copy_source',
    'convert_markdown',
    'build_blocks',
    'extract_first_items',
    'extract_supplement_items',
    'merge_candidates',
  ]) {
    assert.equal(h.state.steps.get(key)?.status, 'success', `步骤 ${key} 应为 success`);
  }
  assert.equal(h.aiCalls.length, 2, '首次提取 + 补充提取各一次');
  assert.equal(h.deps.activePreparations.size, 0, '结束后必须释放并发锁');
});

test('prepareDocument 复用已完成产物时不重复调用 AI', async (t) => {
  const h = makeHarness();
  t.after(h.cleanup);
  seedPrepared(h);

  const { prepareDocument } = createDocumentPipeline(h.deps);
  await prepareDocument('doc-1', path.join(h.tmpDir, 'docs/doc-1/source.md'), {});

  assert.equal(h.state.document.status, 'ready_for_matching');
  assert.equal(h.state.candidateItems.length, 1);
  assert.equal(h.aiCalls.length, 0);
  assert.equal(h.updates.some((update) => update.status === 'extracting'), false, '不应重新进入提取态');
});

test('prepareDocument 在 AI 提取失败时写入 error 状态', async (t) => {
  const h = makeHarness();
  t.after(h.cleanup);
  h.aiQueue.push(new Error('extract boom'));

  const { prepareDocument } = createDocumentPipeline(h.deps);
  await prepareDocument('doc-1', path.join(h.tmpDir, 'docs/doc-1/source.md'), {});

  assert.equal(h.state.document.status, 'error');
  assert.equal(h.state.document.error, 'extract boom');
  assert.equal(h.state.steps.get('extract_first_items')?.status, 'error');
  assert.equal(h.deps.activePreparations.size, 0);
});

test('prepareDocument 对同一文档的并发调用直接跳过', async (t) => {
  const h = makeHarness();
  t.after(h.cleanup);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const scripted = h.deps.aiService.collectJsonResponse;
  let gated = false;
  h.deps.aiService.collectJsonResponse = async (options) => {
    if (!gated) {
      gated = true;
      await gate;
    }
    return scripted(options);
  };
  h.aiQueue.push(
    { items: [{ title: 'Project plan', summary: 'Plan summary' }] },
    { items: [] },
  );

  const { prepareDocument } = createDocumentPipeline(h.deps);
  const first = prepareDocument('doc-1', '', {});
  const second = prepareDocument('doc-1', '', {});
  await second;
  assert.equal(h.debugLogs.filter((event) => event === 'prepare:skip-active').length, 1);
  release();
  await first;
  assert.equal(h.state.document.status, 'ready_for_matching');
});

test('非开发模式下 prepareDocument 自动串接 matchDocument', async (t) => {
  const h = makeHarness({ isDeveloperMode: () => false });
  t.after(h.cleanup);
  h.aiQueue.push(
    { items: [{ title: 'Project plan', summary: 'Plan summary' }] },
    { items: [] },
    { matches: [{ id: 'K000001', ranges: [['P000001', 'P000002']] }] },
  );

  const { prepareDocument } = createDocumentPipeline(h.deps);
  await prepareDocument('doc-1', path.join(h.tmpDir, 'docs/doc-1/source.md'), {});

  assert.equal(h.state.document.status, 'success');
  assert.equal(h.state.document.item_count, 1);
  assert.equal(h.state.matchResult.final_matches.length, 1);
});

test('matchDocument 生成最终条目并按覆盖率落库', async (t) => {
  const h = makeHarness();
  t.after(h.cleanup);
  seedPrepared(h);
  h.aiQueue.push({ matches: [{ id: 'K000001', ranges: [['P000001', 'P000002']] }] });

  const { matchDocument } = createDocumentPipeline(h.deps);
  await matchDocument('doc-1', {});

  assert.equal(h.state.document.status, 'success');
  assert.equal(h.state.document.item_count, 1);
  assert.equal(h.state.steps.get('save_result')?.status, 'success');
  assert.deepEqual(
    h.state.matchResult.final_matches[0].block_ids,
    ['P000001', 'P000002'],
  );
  assert.equal(h.state.matchResult.report.coverage_rate, 1);
  assert.equal(h.state.matchResult.report.recovery_attempt_count, 0);
  assert.equal(h.deps.activeMatches.size, 0);
});

test('matchDocument 缺少正文 block 时写入 error 并释放锁', async (t) => {
  const h = makeHarness();
  t.after(h.cleanup);
  h.state.candidateItems = [{ id: 'K000001', title: 'Project plan', summary: 'Plan summary' }];

  const { matchDocument } = createDocumentPipeline(h.deps);
  await matchDocument('doc-1', {});

  assert.equal(h.state.document.status, 'error');
  assert.match(h.state.document.error, /缺少正文 block/);
  assert.equal(h.deps.activeMatches.size, 0);
});

test('matchDocument 段内 AI 失败时该 batch 与步骤都标记 error', async (t) => {
  const h = makeHarness();
  t.after(h.cleanup);
  seedPrepared(h);
  h.aiQueue.push(new Error('segment boom'));

  const { matchDocument } = createDocumentPipeline(h.deps);
  await matchDocument('doc-1', {});

  assert.equal(h.state.document.status, 'error');
  assert.equal(h.state.document.error, 'segment boom');
  assert.equal(h.state.batches.get(1)?.status, 'error');
  assert.equal(h.state.steps.get('match_batches')?.status, 'error');
});

test('matchDocument 指纹一致时复用已存 batch，不重复调用 AI', async (t) => {
  const h = makeHarness();
  t.after(h.cleanup);
  seedPrepared(h);
  h.state.batches.set(1, {
    batch_index: 1,
    status: 'success',
    item_ids: { block_ids: ['P000001', 'P000002'], item_ids: ['K000001'] },
    matches: [{ id: 'K000001', ranges: [['P000001', 'P000002']], block_ids: ['P000001', 'P000002'] }],
  });

  const { matchDocument } = createDocumentPipeline(h.deps);
  await matchDocument('doc-1', {});

  assert.equal(h.aiCalls.length, 0);
  assert.equal(h.state.document.status, 'success');
  assert.equal(h.state.document.item_count, 1);
});

test('matchDocument force 时清空已存 batch 并重新调用 AI', async (t) => {
  const h = makeHarness();
  t.after(h.cleanup);
  seedPrepared(h);
  h.state.batches.set(1, {
    batch_index: 1,
    status: 'success',
    item_ids: { block_ids: ['P000001', 'P000002'], item_ids: ['K000001'] },
    matches: [{ id: 'K000001', ranges: [['P000001', 'P000002']], block_ids: ['P000001', 'P000002'] }],
  });
  h.aiQueue.push({ matches: [{ id: 'K000001', ranges: [['P000001', 'P000002']] }] });

  const { matchDocument } = createDocumentPipeline(h.deps);
  await matchDocument('doc-1', {}, { force: true });

  assert.equal(h.aiCalls.length, 1, 'force 必须绕过 batch 复用');
  assert.equal(h.state.document.status, 'success');
});
