const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createTemplateStore } = require('./templateStore.cjs');
const { SYSTEM_EXPORT_TEMPLATES } = require('../systemExportTemplates.cjs');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE export_templates (
      template_id TEXT PRIMARY KEY,
      template_name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

test('syncSystemTemplates 幂等写入系统预设模板', () => {
  const db = createDb();
  const store = createTemplateStore({ db });
  store.syncSystemTemplates();
  const templates = store.listTemplates();
  assert.equal(templates.length, SYSTEM_EXPORT_TEMPLATES.length);
  assert.ok(templates.every((t) => t.is_system));
  store.syncSystemTemplates();
  assert.equal(store.listTemplates().length, SYSTEM_EXPORT_TEMPLATES.length);
  db.close();
});

test('系统预设模板不可编辑、不可删除', () => {
  const db = createDb();
  const store = createTemplateStore({ db });
  store.syncSystemTemplates();
  const systemTemplate = store.listTemplates()[0];
  assert.throws(() => store.updateTemplate(systemTemplate.template_id, { template_name: 'x' }), /不可编辑/);
  const result = store.deleteTemplate(systemTemplate.template_id);
  assert.equal(result.success, false);
  assert.match(result.message, /不可删除/);
  db.close();
});

test('用户模板可正常增删改', () => {
  const db = createDb();
  const store = createTemplateStore({ db });
  store.syncSystemTemplates();
  const userTemplate = store.createTemplate({ template_name: '我的模板' });
  assert.equal(userTemplate.is_system, false);
  store.updateTemplate(userTemplate.template_id, { template_name: '改名' });
  assert.equal(store.getTemplate(userTemplate.template_id).template_name, '改名');
  const result = store.deleteTemplate(userTemplate.template_id);
  assert.equal(result.success, true);
  db.close();
});

test('复制系统预设模板得到用户模板', () => {
  const db = createDb();
  const store = createTemplateStore({ db });
  store.syncSystemTemplates();
  const systemTemplate = store.listTemplates()[0];
  const copy = store.duplicateTemplate(systemTemplate.template_id);
  assert.equal(copy.is_system, false);
  assert.match(copy.template_name, /副本/);
  db.close();
});
