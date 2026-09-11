// 正文小节、正文编排与配图计划的持久化：读写技术方案正文相关表。
//
// 这些原本是 createTechnicalPlanStore 工厂里的闭包函数；这里把 db 与少量内部助手显式注入，
// 函数本身不持有可变闭包状态。

const { now, hasOwn, safeJsonParse, jsonOrNull } = require('./storeUtils.cjs');

function createContentPersistence(deps) {
  const {
    db,
    scheduleGeneratedAssetCleanup,
    deleteContentIllustrationPlanRows,
    illustrationItemValues,
    upsertIllustrationItem,
    updateGeneratedContent,
    upsertGeneratedSection,
    upsertGeneratedPlan,
    normalizeStatus,
    collectLeafItems,
    updateMeta,
  } = deps;

  function loadContentSections(outlineData) {
    const rows = db.prepare(`
      SELECT s.node_id, s.status, s.error, s.updated_at, n.title, n.content
      FROM technical_plan_content_sections s
      JOIN technical_plan_outline_nodes n ON n.node_id = s.node_id
    `).all();
    const sections = rows.reduce((acc, row) => {
      acc[row.node_id] = {
        id: row.node_id,
        title: row.title || '未命名章节',
        status: normalizeStatus(row.status, ['idle', 'running', 'success', 'error', 'ignored'], 'idle'),
        content: row.content || '',
        error: row.error || undefined,
        updated_at: row.updated_at || undefined,
      };
      return acc;
    }, {});

    for (const item of collectLeafItems(outlineData?.outline || [])) {
      if (!sections[item.id] && item.content?.trim()) {
        sections[item.id] = {
          id: item.id,
          title: item.title || '未命名章节',
          status: 'success',
          content: item.content,
        };
      }
    }

    return sections;
  }

  function saveContentSections(sections) {
    const entries = Object.entries(sections || {});
    if (!entries.length) {
      db.prepare('DELETE FROM technical_plan_content_sections').run();
      return;
    }

    const nextIds = new Set(entries.map(([nodeId]) => nodeId));
    const upsert = db.prepare(`
      INSERT INTO technical_plan_content_sections (node_id, status, error, updated_at)
      VALUES (@node_id, @status, @error, @updated_at)
      ON CONFLICT(node_id) DO UPDATE SET
        status = excluded.status,
        error = excluded.error,
        updated_at = excluded.updated_at
    `);
    const updateContent = db.prepare('UPDATE technical_plan_outline_nodes SET content = @content, updated_at = @updated_at WHERE node_id = @node_id');
    const timestamp = now();
    for (const [nodeId, section] of entries) {
      upsert.run({
        node_id: nodeId,
        status: normalizeStatus(section?.status, ['idle', 'running', 'success', 'error', 'ignored'], 'idle'),
        error: section?.error ? String(section.error) : null,
        updated_at: section?.updated_at || timestamp,
      });
      if (hasOwn(section, 'content')) {
        updateContent.run({ node_id: nodeId, content: String(section.content || ''), updated_at: timestamp });
      }
    }

    const deleteSection = db.prepare('DELETE FROM technical_plan_content_sections WHERE node_id = ?');
    for (const row of db.prepare('SELECT node_id FROM technical_plan_content_sections').all()) {
      if (!nextIds.has(row.node_id)) deleteSection.run(row.node_id);
    }
  }

  function saveContentPlans(plans) {
    const entries = Object.entries(plans || {}).filter(([, value]) => value?.plan && Number(value.plan_version) > 0);
    if (!entries.length) {
      db.prepare('DELETE FROM technical_plan_content_plans').run();
      return;
    }

    const nextIds = new Set(entries.map(([nodeId]) => nodeId));
    const upsert = db.prepare(`
      INSERT INTO technical_plan_content_plans (node_id, plan_json, updated_at)
      VALUES (@node_id, @plan_json, @updated_at)
      ON CONFLICT(node_id) DO UPDATE SET
        plan_json = excluded.plan_json,
        updated_at = excluded.updated_at
    `);
    const timestamp = now();
    for (const [nodeId, value] of entries) {
      if (!value?.plan) continue;
      upsert.run({
        node_id: nodeId,
        plan_json: JSON.stringify({
          plan_version: Number(value.plan_version),
          plan: value.plan,
          ...(value.table_requirement ? { table_requirement: value.table_requirement } : {}),
        }),
        updated_at: value.updated_at || timestamp,
      });
    }

    const deletePlan = db.prepare('DELETE FROM technical_plan_content_plans WHERE node_id = ?');
    for (const row of db.prepare('SELECT node_id FROM technical_plan_content_plans').all()) {
      if (!nextIds.has(row.node_id)) deletePlan.run(row.node_id);
    }
  }

  function loadContentIllustrationPlan() {
    const plan = db.prepare('SELECT * FROM technical_plan_illustration_plans WHERE id = 1').get();
    if (!plan) return undefined;
    const items = db.prepare('SELECT * FROM technical_plan_illustration_items ORDER BY sort_order ASC, item_id ASC').all().map((row) => {
      const generation = row.generation_status ? {
        status: row.generation_status,
        ...(row.generation_mode ? { mode: row.generation_mode } : {}),
        ...(row.generation_code ? { code: row.generation_code } : {}),
        ...(row.generation_source_path ? { source_path: row.generation_source_path } : {}),
        ...(row.generation_asset_url ? { asset_url: row.generation_asset_url } : {}),
        ...(row.generation_attempts === null ? {} : { attempts: Number(row.generation_attempts || 0) }),
        ...(row.generation_error ? { error: row.generation_error } : {}),
        ...(row.generation_updated_at ? { updated_at: row.generation_updated_at } : {}),
      } : undefined;
      return {
        item_id: row.item_id,
        kind: row.kind,
        image_type: row.image_type,
        title: row.title,
        section_ids: safeJsonParse(row.section_ids_json, []),
        placement: row.placement,
        priority: Number(row.priority || 0),
        ...(generation ? { generation } : {}),
      };
    });
    return {
      plan_version: Number(plan.plan_version || 0),
      revision: plan.revision,
      items,
      updated_at: plan.updated_at || undefined,
    };
  }

  function loadGeneratedIllustrationAssetUrls() {
    return db.prepare(`
      SELECT generation_asset_url
      FROM technical_plan_illustration_items
      WHERE generation_asset_url IS NOT NULL AND generation_asset_url <> ''
    `).all().map((row) => row.generation_asset_url);
  }

  function saveContentGenerationItemFields({ nodeId, section, storedPlan, runtime }) {
    const timestamp = now();
    if (section) {
      updateGeneratedContent.run(String(section.content || ''), timestamp, nodeId);
      upsertGeneratedSection.run({
        node_id: nodeId,
        status: normalizeStatus(section.status, ['idle', 'running', 'success', 'error', 'ignored'], 'idle'),
        error: section.error ? String(section.error) : null,
        updated_at: section.updated_at || timestamp,
      });
    }
    if (storedPlan) {
      upsertGeneratedPlan.run({
        node_id: nodeId,
        plan_json: JSON.stringify({
          plan_version: Number(storedPlan.plan_version),
          plan: storedPlan.plan,
          ...(storedPlan.table_requirement ? { table_requirement: storedPlan.table_requirement } : {}),
        }),
        updated_at: storedPlan.updated_at || timestamp,
      });
    }
    if (runtime !== undefined) {
      updateMeta({ content_generation_runtime_json: jsonOrNull(runtime) });
    }
  }

  function clearContentIllustrationPlan() {
    const assetUrls = loadGeneratedIllustrationAssetUrls();
    deleteContentIllustrationPlanRows();
    scheduleGeneratedAssetCleanup(assetUrls);
  }

  function replaceContentIllustrationPlan(plan) {
    const previousAssetUrls = loadGeneratedIllustrationAssetUrls();
    deleteContentIllustrationPlanRows();
    if (!plan || !Array.isArray(plan.items)) {
      scheduleGeneratedAssetCleanup(previousAssetUrls);
      return;
    }
    const timestamp = plan.updated_at || now();
    db.prepare(`
      INSERT INTO technical_plan_illustration_plans (id, plan_version, revision, updated_at)
      VALUES (1, ?, ?, ?)
    `).run(Number(plan.plan_version || 0), String(plan.revision || ''), timestamp);
    plan.items.forEach((item, index) => {
      if (item?.item_id) upsertIllustrationItem.run(illustrationItemValues(item, index, timestamp));
    });
    const retainedAssetUrls = new Set(loadGeneratedIllustrationAssetUrls());
    scheduleGeneratedAssetCleanup(previousAssetUrls.filter((assetUrl) => !retainedAssetUrls.has(assetUrl)));
  }

  return {
    loadContentSections,
    saveContentSections,
    saveContentPlans,
    loadContentIllustrationPlan,
    loadGeneratedIllustrationAssetUrls,
    saveContentGenerationItemFields,
    clearContentIllustrationPlan,
    replaceContentIllustrationPlan,
  };
}

module.exports = { createContentPersistence };
