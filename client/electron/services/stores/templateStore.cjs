const crypto = require('node:crypto');
const { now } = require('./storeUtils.cjs');
const { SYSTEM_EXPORT_TEMPLATES } = require('../systemExportTemplates.cjs');

function createTemplateId() {
  return `tpl-${crypto.randomUUID()}`;
}

function resolveTemplateName(config) {
  return String(config?.template_name || '').trim() || '未命名模板';
}

function templateFromRow(row) {
  if (!row) return null;
  return {
    template_id: row.template_id,
    template_name: row.template_name,
    config: JSON.parse(row.config_json),
    is_system: row.is_system === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createTemplateStore({ db }) {
  function listTemplates() {
    return db.prepare(`
      SELECT template_id, template_name, config_json, is_system, created_at, updated_at
      FROM export_templates
      ORDER BY updated_at DESC, created_at DESC
    `).all().map(templateFromRow);
  }

  function getTemplate(templateId) {
    const row = db.prepare(`
      SELECT template_id, template_name, config_json, is_system, created_at, updated_at
      FROM export_templates
      WHERE template_id = ?
    `).get(templateId);
    return templateFromRow(row);
  }

  function createTemplate(config) {
    const timestamp = now();
    const templateId = createTemplateId();
    const templateName = resolveTemplateName(config);
    const nextConfig = { ...config, template_name: templateName };

    db.prepare(`
      INSERT INTO export_templates (template_id, template_name, config_json, created_at, updated_at)
      VALUES (@template_id, @template_name, @config_json, @created_at, @updated_at)
    `).run({
      template_id: templateId,
      template_name: templateName,
      config_json: JSON.stringify(nextConfig),
      created_at: timestamp,
      updated_at: timestamp,
    });

    return {
      template_id: templateId,
      template_name: templateName,
      config: nextConfig,
      is_system: false,
      created_at: timestamp,
      updated_at: timestamp,
    };
  }

  function updateTemplate(templateId, config) {
    const existing = getTemplate(templateId);
    if (existing?.is_system) {
      throw new Error('系统预设模板不可编辑，请复制后再修改');
    }
    const templateName = resolveTemplateName(config);
    const nextConfig = { ...config, template_name: templateName };
    const updatedAt = now();
    const row = db.prepare(`
      UPDATE export_templates
      SET template_name = @template_name,
          config_json = @config_json,
          updated_at = @updated_at
      WHERE template_id = @template_id
      RETURNING template_id, template_name, config_json, is_system, created_at, updated_at
    `).get({
      template_id: templateId,
      template_name: templateName,
      config_json: JSON.stringify(nextConfig),
      updated_at: updatedAt,
    });

    if (!row) {
      throw new Error('模板不存在或已被删除');
    }

    return templateFromRow(row);
  }

  function deleteTemplate(templateId) {
    const existing = getTemplate(templateId);
    if (existing?.is_system) {
      return { success: false, message: '系统预设模板不可删除' };
    }
    const result = db.prepare('DELETE FROM export_templates WHERE template_id = ?').run(templateId);
    return {
      success: result.changes > 0,
      message: result.changes > 0 ? '模板已删除' : '模板不存在或已被删除',
    };
  }

  function duplicateTemplate(templateId) {
    const source = getTemplate(templateId);
    if (!source) {
      throw new Error('模板不存在或已被删除');
    }
    return createTemplate({ ...source.config, template_name: `${source.template_name} 副本` });
  }

  /** 系统预设模板真源幂等同步：每次启动调用，改预设只需改 systemExportTemplates.cjs。 */
  function syncSystemTemplates() {
    const timestamp = now();
    const upsert = db.prepare(`
      INSERT INTO export_templates (template_id, template_name, config_json, is_system, created_at, updated_at)
      VALUES (@template_id, @template_name, @config_json, 1, @timestamp, @timestamp)
      ON CONFLICT(template_id) DO UPDATE SET
        template_name = excluded.template_name,
        config_json = excluded.config_json,
        is_system = 1,
        updated_at = excluded.updated_at
    `);
    const keptIds = SYSTEM_EXPORT_TEMPLATES.map((template) => template.template_id);
    const placeholders = keptIds.map(() => '?').join(', ');
    const removeStale = db.prepare(
      `DELETE FROM export_templates WHERE is_system = 1 AND template_id NOT IN (${placeholders})`,
    );

    db.transaction(() => {
      for (const template of SYSTEM_EXPORT_TEMPLATES) {
        const templateName = resolveTemplateName(template.config);
        upsert.run({
          template_id: template.template_id,
          template_name: templateName,
          config_json: JSON.stringify({ ...template.config, template_name: templateName }),
          timestamp,
        });
      }
      removeStale.run(...keptIds);
    })();
  }

  return {
    listTemplates,
    getTemplate,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    duplicateTemplate,
    syncSystemTemplates,
  };
}

module.exports = {
  createTemplateStore,
};
