const test = require('node:test');
const assert = require('node:assert/strict');

const { createContentPersistence } = require('./contentPersistence.cjs');

function makeHarness(overrides = {}) {
  const state = { runs: [], rows: [], existingIds: [], planRow: null, scheduled: [], deletedRows: [], illustrationValues: [] };
  const db = {
    prepare(sql) {
      return {
        all: () => {
          if (sql.includes('FROM technical_plan_content_sections s')) return state.rows;
          if (sql.includes('SELECT node_id FROM technical_plan_content_sections')) return state.existingIds;
          return [];
        },
        get: () => state.planRow,
        run: (params) => { state.runs.push({ sql, params }); return { changes: 1 }; },
      };
    },
  };
  const api = createContentPersistence({
    db,
    scheduleGeneratedAssetCleanup: (...args) => state.scheduled.push(args),
    deleteContentIllustrationPlanRows: (...args) => state.deletedRows.push(args),
    illustrationItemValues: (...args) => { state.illustrationValues.push(args); return []; },
    upsertIllustrationItem: () => {},
    updateGeneratedContent: () => {},
    upsertGeneratedSection: () => {},
    upsertGeneratedPlan: () => {},
    normalizeStatus: (value, allowed, fallback) => (allowed.includes(value) ? value : fallback),
    collectLeafItems: (outline) => (Array.isArray(outline) ? outline.flatMap((item) => (item.children?.length ? [] : [item])) : []),
    updateMeta: () => {},
    ...overrides,
  });
  return { api, state };
}

test('createContentPersistence 暴露正文与配图计划接口', () => {
  const { api } = makeHarness();
  for (const n of ['loadContentSections','saveContentSections','saveContentPlans','loadContentIllustrationPlan','loadGeneratedIllustrationAssetUrls','saveContentGenerationItemFields','clearContentIllustrationPlan','replaceContentIllustrationPlan']) {
    assert.equal(typeof api[n], 'function', 'missing ' + n);
  }
});

test('loadContentSections 合并数据库行与大纲里的正文', () => {
  const { api, state } = makeHarness();
  state.rows = [{ node_id: 'a', status: 'weird', error: '', updated_at: 't', title: 'A', content: '库里正文' }];
  const sections = api.loadContentSections({ outline: [{ id: 'b', title: 'B', content: '大纲正文' }, { id: 'c', title: 'C', content: '   ' }] });
  assert.equal(sections.a.status, 'idle');
  assert.equal(sections.a.content, '库里正文');
  assert.equal(sections.b.status, 'success');
  assert.equal(sections.b.content, '大纲正文');
  assert.equal('c' in sections, false);
});

test('saveContentSections 写入小节并清理已删除的行', () => {
  const { api, state } = makeHarness();
  state.existingIds = [{ node_id: 'a' }, { node_id: 'zombie' }];
  api.saveContentSections({ a: { status: 'success', content: '正文' } });
  const upsert = state.runs.find((r) => r.sql.includes('INSERT INTO technical_plan_content_sections'));
  assert.equal(upsert.params.node_id, 'a');
  assert.equal(upsert.params.status, 'success');
  const contentUpdate = state.runs.find((r) => r.sql.includes('UPDATE technical_plan_outline_nodes SET content'));
  assert.equal(contentUpdate.params.content, '正文');
  const deleted = state.runs.find((r) => r.sql.includes('DELETE FROM technical_plan_content_sections WHERE node_id = ?'));
  assert.equal(deleted.params, 'zombie');
});

test('saveContentSections 传空对象时清空整表', () => {
  const { api, state } = makeHarness();
  api.saveContentSections({});
  assert.equal(state.runs.length, 1);
  assert.match(state.runs[0].sql, /DELETE FROM technical_plan_content_sections$/);
});

test('loadContentIllustrationPlan 无记录时返回空值', () => {
  const { api, state } = makeHarness();
  assert.ok(api.loadContentIllustrationPlan() == null);
  state.planRow = { id: 1, plan_json: '{"items":[]}' };
  const plan = api.loadContentIllustrationPlan();
  assert.ok(plan === null || typeof plan === 'object');
});
