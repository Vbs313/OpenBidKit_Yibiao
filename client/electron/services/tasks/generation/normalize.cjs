// 模型/任务载荷的规整：把各种上游写法归一成一种规范形状，纯函数，可单独测试。

const { singleLine } = require('./agentResponse.cjs');
const { normalizeGeneratedMarkdown, unwrapMarkdownTitle, stripMarkdownHeadingsFromLeafContent } = require('./markdownTables.cjs');

function normalizeGlobalFactsMode(value) {
  return value === 'omit' || value === 'placeholder' ? value : 'fabricate';
}

function normalizeFactTitles(value, allowedFactTitles) {
  const source = Array.isArray(value) ? value : [];
  const titles = source.map((title) => singleLine(title)).filter(Boolean);
  const filtered = allowedFactTitles instanceof Set
    ? titles.filter((title) => allowedFactTitles.has(title))
    : titles;
  return [...new Set(filtered)];
}

function normalizeConsistencyRepairMode(value) {
  return String(value || '').trim() === 'normal' ? 'normal' : 'agent';
}

function normalizeOriginalPlanCoverageRepairMode(value) {
  return String(value || '').trim() === 'normal' ? 'normal' : 'agent';
}

function normalizeOutlineWordControlSnapshot(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalizeInteger = (input) => {
    const number = Number(input);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
  };
  const sectionWords = normalizeInteger(source.sectionWords);
  return Object.freeze({
    enabled: Boolean(source.enabled),
    minimumWords: normalizeInteger(source.minimumWords),
    maximumWords: normalizeInteger(source.maximumWords),
    sectionWords,
    strictSectionWords: sectionWords > 0 && Boolean(source.strictSectionWords),
    sectionMinimumWords: sectionWords > 0 ? Math.ceil(sectionWords * 0.8) : 0,
    sectionMaximumWords: sectionWords > 0 ? Math.floor(sectionWords * 1.2) : 0,
  });
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeKnowledgeItemIds(value, allowedKnowledgeItemIds) {
  const source = Array.isArray(value) ? value : [];
  const ids = source.map((id) => String(id || '').trim()).filter(Boolean);
  const filtered = allowedKnowledgeItemIds instanceof Set
    ? ids.filter((id) => allowedKnowledgeItemIds.has(id))
    : ids;
  return [...new Set(filtered)];
}

function normalizeOriginalMaterial(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourceIds = Array.isArray(source.source_ids || source.sourceIds)
    ? source.source_ids || source.sourceIds
    : [];
  const sourceTitles = Array.isArray(source.source_titles || source.sourceTitles)
    ? source.source_titles || source.sourceTitles
    : [];
  const sourceHashes = Array.isArray(source.source_hashes || source.sourceHashes)
    ? source.source_hashes || source.sourceHashes
    : [];
  return {
    restored: Boolean(source.restored),
    optimized: Boolean(source.optimized),
    source_ids: [...new Set(sourceIds.map((id) => String(id || '').trim()).filter(Boolean))],
    source_titles: [...new Set(sourceTitles.map((title) => singleLine(title)).filter(Boolean))],
    source_hashes: [...new Set(sourceHashes.map((hash) => String(hash || '').trim()).filter(Boolean))],
    restored_chars: Math.max(0, Math.round(Number(source.restored_chars ?? source.restoredChars) || 0)),
    ...(source.restored_at || source.restoredAt ? { restored_at: source.restored_at || source.restoredAt } : {}),
    ...(source.optimized_at || source.optimizedAt ? { optimized_at: source.optimized_at || source.optimizedAt } : {}),
  };
}

function normalizeContentPlan(value, allowedKnowledgeItemIds, allowedFactTitles) {
  const source = value?.plan && typeof value.plan === 'object' ? value.plan : value || {};
  const writing = source.writing && typeof source.writing === 'object' && !Array.isArray(source.writing) ? source.writing : {};
  const knowledgeSource = source.knowledge;
  const knowledge = knowledgeSource && typeof knowledgeSource === 'object' && !Array.isArray(knowledgeSource) ? knowledgeSource : {};
  const rawKnowledgeItemIds = Array.isArray(knowledgeSource)
    ? knowledgeSource
    : knowledge.item_ids ?? knowledge.itemIds ?? knowledge.knowledge_item_ids ?? source.knowledge_item_ids ?? source.knowledgeItemIds;
  const factsSource = source.facts;
  const facts = factsSource && typeof factsSource === 'object' && !Array.isArray(factsSource) ? factsSource : {};
  const rawFactTitles = Array.isArray(factsSource)
    ? factsSource
    : facts.titles ?? facts.fact_titles ?? facts.factTitles ?? source.fact_titles ?? source.factTitles ?? source.global_fact_titles ?? source.globalFactTitles;
  const table = source.table && typeof source.table === 'object' ? source.table : {};
  const tableNeeded = Boolean(table.needed);

  return {
    writing_focus: singleLine(source.writing_focus || source.writingFocus || writing.focus || writing.writing_focus || writing.writingFocus),
    knowledge: {
      item_ids: normalizeKnowledgeItemIds(rawKnowledgeItemIds, allowedKnowledgeItemIds),
    },
    facts: {
      titles: normalizeFactTitles(rawFactTitles, allowedFactTitles),
    },
    table: {
      needed: tableNeeded,
      purpose: tableNeeded ? singleLine(table.purpose) : '',
    },
    original_material: normalizeOriginalMaterial(source.original_material || source.originalMaterial),
  };
}

function normalizeTableCleanupResponse(value, allowedTableIds) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const rawReplacements = Array.isArray(source)
    ? source
    : Array.isArray(source.replacements)
      ? source.replacements
      : Array.isArray(source.items)
        ? source.items
        : [];
  const seen = new Set();
  const replacements = [];
  for (const item of rawReplacements) {
    const tableId = String(item?.table_id || item?.tableId || item?.id || '').trim();
    const replacementText = normalizeGeneratedMarkdown(String(item?.replacement_text || item?.replacementText || item?.text || item?.content || '')).trim();
    if (!tableId || seen.has(tableId) || (allowedTableIds instanceof Set && !allowedTableIds.has(tableId)) || !replacementText) {
      continue;
    }
    replacements.push({ table_id: tableId, replacement_text: replacementText });
    seen.add(tableId);
  }
  return { replacements };
}

function normalizeContentExpansionPatch(value) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const rawPatch = Array.isArray(source.operations) ? source.operations[0] : Array.isArray(source.patches) ? source.patches[0] : source;
  const operation = String(rawPatch.operation || rawPatch.type || '').trim().toLowerCase();
  const anchor = singleLine(rawPatch.anchor || rawPatch.position || rawPatch.after || rawPatch.target || rawPatch.replace_target || 'end') || 'end';
  const targetText = normalizeNewlines(rawPatch.target_text ?? rawPatch.targetText ?? rawPatch.old_text ?? rawPatch.oldText ?? '').trim();
  const content = normalizeGeneratedMarkdown(String(rawPatch.content || rawPatch.paragraph || rawPatch.text || rawPatch.new_content || ''))
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .trim();
  return { operation, anchor, target_text: targetText, content };
}

function normalizeNewlines(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function stripPromptLineNumbers(text) {
  return normalizeNewlines(text)
    .split('\n')
    .map((line) => line.replace(/^\[\d{1,6}\]\s?/, ''))
    .join('\n');
}

function normalizeConsistencyPatchText(text) {
  return stripPromptLineNumbers(text).trim();
}

function normalizeConsistencyAuditResponse(value, allowedSectionIds) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const rawConflicts = Array.isArray(source)
    ? source
    : Array.isArray(source.conflicts)
      ? source.conflicts
      : Array.isArray(source.items)
        ? source.items
        : [];
  const allowed = allowedSectionIds instanceof Set ? allowedSectionIds : new Set(allowedSectionIds || []);
  const issues = [];
  const conflicts = [];

  rawConflicts.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`conflicts[${index}] 必须是对象`);
      return;
    }
    const sectionId = singleLine(item.section_id || item.sectionId || item.id || item.chapter_id || item.chapterId);
    if (!sectionId || !allowed.has(sectionId)) {
      issues.push(`conflicts[${index}].section_id 无效：${sectionId || '空'}`);
      return;
    }
    conflicts.push({
      section_id: sectionId,
      fact_title: singleLine(item.fact_title || item.factTitle || item.fact || item.title),
      evidence: String(item.evidence || item.quote || item.source || '').trim(),
      reason: String(item.reason || item.description || item.issue || '').trim(),
      severity: singleLine(item.severity || 'medium') || 'medium',
    });
  });

  if (issues.length) {
    throw new Error(`审计结果格式无效：${issues.join('；')}`);
  }
  return { conflicts };
}

function normalizeConsistencyRepairResponse(value, expectedSectionId) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const rawPatches = Array.isArray(source)
    ? source
    : Array.isArray(source.patches)
      ? source.patches
      : Array.isArray(source.operations)
        ? source.operations
        : (source.old_text || source.oldText || source.new_text || source.newText)
          ? [source]
          : [];
  const patches = rawPatches.map((patch) => {
    const rawSectionId = singleLine(patch?.section_id || patch?.sectionId || patch?.id || '');
    const sectionId = rawSectionId && rawSectionId !== '当前小节编号' ? rawSectionId : expectedSectionId;
    return {
      section_id: sectionId,
      start_line: Number(patch?.start_line ?? patch?.startLine ?? patch?.line_start ?? patch?.lineStart ?? 0) || 0,
      end_line: Number(patch?.end_line ?? patch?.endLine ?? patch?.line_end ?? patch?.lineEnd ?? 0) || 0,
      old_text: normalizeConsistencyPatchText(patch?.old_text ?? patch?.oldText ?? patch?.original ?? patch?.before ?? ''),
      new_text: normalizeConsistencyPatchText(patch?.new_text ?? patch?.newText ?? patch?.replacement ?? patch?.after ?? ''),
      reason: String(patch?.reason || patch?.description || '').trim(),
    };
  });
  const invalidSection = patches.find((patch) => expectedSectionId && patch.section_id !== expectedSectionId);
  if (invalidSection) {
    throw new Error(`一致性修复结果 section_id 无效：${invalidSection.section_id || '空'}`);
  }
  return { patches };
}

function normalizeChildren(item) {
  return Array.isArray(item.children) ? item.children : [];
}

function normalizeReferenceDocumentIds(storedPlan) {
  const raw = storedPlan?.referenceKnowledgeDocumentIds ?? [];
  return Array.isArray(raw)
    ? [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
}

function normalizeParagraphs(content) {
  return String(content || '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripRepeatedChapterTitle(content, chapter) {
  const title = String(chapter?.title || '').trim();
  if (!title) {
    return content;
  }

  const rawLines = String(content || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  let firstContentLine = rawLines.findIndex((line) => line.trim());
  if (firstContentLine < 0) {
    return content;
  }

  const chapterId = String(chapter?.id || '').trim();
  const firstLine = unwrapMarkdownTitle(rawLines[firstContentLine]);
  let comparable = firstLine;

  if (chapterId) {
    comparable = comparable.replace(new RegExp(`^${escapeRegExp(chapterId)}\\s+`), '').trim();
  }
  comparable = comparable.replace(/^[一二三四五六七八九十]+[、.．]\s*/, '').trim();

  if (comparable !== title && firstLine !== `${chapterId} ${title}`.trim()) {
    return content;
  }

  const nextLines = rawLines.slice(firstContentLine + 1);
  while (nextLines.length && !nextLines[0].trim()) {
    nextLines.shift();
  }
  return [...rawLines.slice(0, firstContentLine), ...nextLines].join('\n').trimStart();
}

function normalizeLeafContentForSave(content, chapter) {
  return stripMarkdownHeadingsFromLeafContent(
    stripRepeatedChapterTitle(normalizeGeneratedMarkdown(content), chapter),
  );
}

function normalizeWordAdjustmentResponse(value) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const mode = String(source.mode || '').trim();
  const granularity = String(source.granularity || '').trim();
  const operations = (Array.isArray(source.operations) ? source.operations : []).map((operation) => ({
    operation: String(operation?.operation || '').trim().toLowerCase(),
    anchor: normalizeNewlines(operation?.anchor || '').trim(),
    target_text: normalizeNewlines(operation?.target_text || '').trim(),
    content: normalizeGeneratedMarkdown(operation?.content || '').trim(),
  }));
  return { mode, granularity, operations };
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))] : [];
}

function normalizeContentGenerationRuntime(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    phase: String(source.phase || ''),
    touched_item_ids: normalizeStringArray(source.touched_item_ids),
    completed_stages: normalizeStringArray(source.completed_stages),
    word_adjustment_stage: ['section', 'final-section', 'total'].includes(source.word_adjustment_stage) ? source.word_adjustment_stage : undefined,
    word_adjustment_item_id: String(source.word_adjustment_item_id || '').trim(),
    word_adjustment_round: Math.max(0, Math.round(Number(source.word_adjustment_round) || 0)),
    word_adjustment_item_rounds: { ...(source.word_adjustment_item_rounds || {}) },
    word_adjustment_completed_item_ids: normalizeStringArray(source.word_adjustment_completed_item_ids),
    word_adjustment_no_progress_rounds: Math.max(0, Math.round(Number(source.word_adjustment_no_progress_rounds) || 0)),
    word_adjustment_round_start_words: Math.max(0, Math.round(Number(source.word_adjustment_round_start_words) || 0)),
    target_item_id: String(source.target_item_id || '').trim(),
    regenerate_requirement: String(source.regenerate_requirement || '').trim(),
    awaiting_content_decision: Boolean(source.awaiting_content_decision),
    updated_at: source.updated_at || now(),
  };
}

function now() {
  return new Date().toISOString();
}

module.exports = {
  normalizeGlobalFactsMode,
  normalizeFactTitles,
  normalizeConsistencyRepairMode,
  normalizeOriginalPlanCoverageRepairMode,
  normalizeOutlineWordControlSnapshot,
  normalizePositiveInteger,
  normalizeKnowledgeItemIds,
  normalizeOriginalMaterial,
  normalizeContentPlan,
  normalizeTableCleanupResponse,
  normalizeContentExpansionPatch,
  normalizeNewlines,
  stripPromptLineNumbers,
  normalizeConsistencyPatchText,
  normalizeConsistencyAuditResponse,
  normalizeConsistencyRepairResponse,
  normalizeChildren,
  normalizeReferenceDocumentIds,
  normalizeParagraphs,
  escapeRegExp,
  stripRepeatedChapterTitle,
  normalizeLeafContentForSave,
  normalizeWordAdjustmentResponse,
  normalizeStringArray,
  normalizeContentGenerationRuntime,
  now,
};
