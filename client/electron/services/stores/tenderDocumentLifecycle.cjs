// 招标文件与原方案文档的生命周期：导入、移除、切换工作流与清理技术标。
//
// 这些原本是 createTechnicalPlanStore 工厂里的闭包函数；依赖较宽，全部通过 deps 显式注入，
// 函数本身不持有可变闭包状态，可单独测试。

const fs = require('node:fs');
const path = require('node:path');
const {
  stableHash,
  filePathKey,
  createTenderSourceId,
  now,
  safeJsonParse,
} = require('./storeUtils.cjs');

function createTenderDocumentLifecycle(deps) {
  const {
    deleteOutlineAgentTask,
    deleteGlobalFactsAgentTask,
    notifyAgentWorkspaceChange,
    tenderMarkdownPath,
    tenderOriginalMarkdownPath,
    tenderSourceFilesDir,
    originalPlanMarkdownPath,
    tenderOriginalLogger,
    removeWorkspacePathSync,
    getManagedTenderOriginalRelativePath,
    clearTechnicalPlanMermaidCache,
    clearBidTemplate,
    clearDownstreamFromTender,
    clearDownstreamFromBidSectionChange,
    clearDownstreamFromOriginalPlan,
    runBeforeCommit,
    tenderMarkdownRelativePath,
    tenderOriginalMarkdownRelativePath,
    tenderOriginalsDirRelativePath,
    originalPlanMarkdownRelativePath,
    appendImportFailureParts,
    combineTenderMarkdown,
    normalizeWorkflowKind,
    normalizeBidSections,
    buildSelectedSectionMarkdown,
    fileService,
    loadTenderSourceFiles,
    readTenderSourceMarkdown,
    resolveMarkdownPath,
    cleanupPendingTenderSelection,
    pruneTenderOriginals,
    compactLogError,
    clearTenderSourceFiles,
    db,
    updateMeta,
    writeTenderSourceMarkdown,
    writeMarkdownFile,
    ensureMetaRow,
    readOriginalTenderMarkdown,
    clearOriginalOutlineRuntime,
    clearIllustrationFiles,
    deleteImportedImageBatches,
    app,
    clearContentIllustrationPlan,
  } = deps;

  async function importTenderDocument(filePaths, options = {}) {
    if (!fileService?.importDocument) {
      throw new Error('文件导入服务尚未初始化');
    }

    const result = await fileService.importDocument({ multiple: true, filePaths });
    if (!result?.success || !result.file_content) {
      return {
        success: false,
        message: result?.message || '未导入文件',
        markdown: '',
      };
    }

    const importedDocuments = Array.isArray(result.documents) && result.documents.length ? result.documents : [result];
    const existingSourceDocuments = loadTenderSourceFiles().map((file) => {
      const markdown = String(readTenderSourceMarkdown(file.id) || '').trim();
      return markdown ? {
        file_content: markdown,
        file_name: file.fileName,
        parser_label: file.parserLabel,
        content_hash: file.contentHash || stableHash(markdown),
        source_docx_path: file.sourceDocxPath,
      } : null;
    }).filter(Boolean);
    const existingKeys = new Set(existingSourceDocuments.map((item) => `${item.file_name}\u0000${item.content_hash}`));
    const existingOriginalPaths = new Set(existingSourceDocuments
      .map((item) => String(item.source_docx_path || '').trim())
      .filter(Boolean)
      .map((item) => filePathKey(resolveMarkdownPath(item))));
    const addedDocuments = [];
    let skippedCount = 0;
    importedDocuments.forEach((item) => {
      const markdown = String(item.file_content || '').trim();
      if (!markdown) return;
      const fileName = item.file_name || '未命名文件';
      const key = `${fileName}\u0000${stableHash(markdown)}`;
      const sourcePath = String(item.source_path || '').trim();
      if (existingKeys.has(key) || (sourcePath && existingOriginalPaths.has(filePathKey(sourcePath)))) {
        skippedCount += 1;
        return;
      }
      existingKeys.add(key);
      addedDocuments.push(item);
    });

    if (!addedDocuments.length) {
      const messageParts = [];
      if (skippedCount > 0) messageParts.push(`已跳过 ${skippedCount} 份重复文件`);
      appendImportFailureParts(messageParts, result.errors);
      return {
        success: false,
        message: messageParts.join('，') || result.message || '未导入文件',
        markdown: '',
      };
    }

    await runBeforeCommit(options.beforeCommit);
    clearBidTemplate();
    cleanupPendingTenderSelection();

    const mergedDocuments = [...existingSourceDocuments, ...addedDocuments];
    pruneTenderOriginals([
      ...existingSourceDocuments.map((item) => item.source_docx_path),
      ...addedDocuments.map((item) => item.source_path),
    ].filter(Boolean), 'import-preflight');
    for (let index = 0; index < mergedDocuments.length; index += 1) {
      const item = mergedDocuments[index];
      const sourcePath = String(item.source_path || '').trim();
      if (!sourcePath || item.source_docx_path || !fileService?.persistTenderSourceDocx) continue;
      const sourceId = createTenderSourceId(item.file_name || '未命名文件', String(item.file_content || '').trim(), index);
      const relativePath = path.join(tenderOriginalsDirRelativePath, `${sourceId}.docx`).replace(/\\/g, '/');
      const destPath = resolveMarkdownPath(relativePath);
      const managedRelativePath = getManagedTenderOriginalRelativePath(sourcePath);
      if (managedRelativePath) {
        item.source_docx_path = managedRelativePath;
        tenderOriginalLogger.write('tender-original.persist.reused', { phase: 'import', source_path: sourcePath });
        continue;
      }
      tenderOriginalLogger.write('tender-original.persist.started', { phase: 'import', source_path: sourcePath, dest_path: destPath });
      try {
        const persisted = filePathKey(sourcePath) === filePathKey(destPath)
          ? true
          : await fileService.persistTenderSourceDocx(sourcePath, destPath);
        if (persisted) item.source_docx_path = relativePath;
        tenderOriginalLogger.write('tender-original.persist.completed', { phase: 'import', source_path: sourcePath, dest_path: destPath, persisted: Boolean(persisted) });
      } catch (error) {
        tenderOriginalLogger.write('tender-original.persist.failed', {
          phase: 'import',
          source_path: sourcePath,
          dest_path: destPath,
          code: error?.code,
          syscall: error?.syscall,
          error: compactLogError(error),
        });
        throw new Error(`${item.file_name || '招标文件'}：无法保存 Word 原件，${error.message || error}`);
      }
    }
    const markdown = combineTenderMarkdown(mergedDocuments.map((item) => item.file_content));
    const fileName = mergedDocuments.length > 1 ? `${mergedDocuments.length} 份招标文件` : mergedDocuments[0].file_name || '未命名文件';
    const parserLabel = mergedDocuments.length > 1 ? null : mergedDocuments[0].parser_label || null;
    const messageParts = [`已解析 ${addedDocuments.length} 份招标文件`];
    if (result.fallbackToLocal === true || mergedDocuments.some((item) => item.fallback_to_local)) {
      messageParts.push('当前格式已自动使用本地解析');
    }
    if (skippedCount > 0) messageParts.push(`跳过 ${skippedCount} 份重复文件`);
    appendImportFailureParts(messageParts, result.errors);

    return saveTenderMarkdownAndState(markdown, {
      fileName,
      parserLabel,
      message: messageParts.join('，'),
      fallbackToLocal: result.fallbackToLocal === true,
      resetOriginal: true,
      sourceFiles: mergedDocuments,
    });
  }

  async function removeTenderDocument(sourceId, options = {}) {
    const targetId = String(sourceId || '');
    const existingFiles = loadTenderSourceFiles();
    const remainingFiles = existingFiles.filter((file) => file.id !== targetId);
    if (!targetId || remainingFiles.length === existingFiles.length) {
      return { success: false, message: '未找到要删除的招标文件', markdown: '' };
    }

    await runBeforeCommit(options.beforeCommit);
    clearBidTemplate();
    if (!remainingFiles.length) {
      clearTenderSourceFiles('remove-last-tender');
      removeWorkspacePathSync(tenderMarkdownPath);
      removeWorkspacePathSync(tenderOriginalMarkdownPath);
      const transaction = db.transaction(() => {
        clearDownstreamFromTender();
        updateMeta({
          tender_file_name: null,
          tender_markdown_path: null,
          tender_markdown_hash: null,
          tender_markdown_chars: 0,
          tender_original_markdown_path: null,
          tender_original_markdown_hash: null,
          tender_original_markdown_chars: 0,
          tender_parser_label: null,
          tender_imported_at: null,
          tender_files_json: null,
          selected_section_id: null,
          selected_section_title: null,
        });
      });
      transaction();
      return { success: true, message: '已移除招标文件', markdown: '' };
    }

    const sourceFiles = remainingFiles.map((file) => ({
      file_content: String(readTenderSourceMarkdown(file.id) || '').trim(),
      file_name: file.fileName,
      parser_label: file.parserLabel,
      source_docx_path: file.sourceDocxPath,
    })).filter((item) => item.file_content);
    const markdown = combineTenderMarkdown(sourceFiles.map((item) => item.file_content));
    const fileName = sourceFiles.length > 1 ? `${sourceFiles.length} 份招标文件` : sourceFiles[0]?.file_name || '未命名文件';
    const parserLabel = sourceFiles.length > 1 ? null : sourceFiles[0]?.parser_label || null;
    return saveTenderMarkdownAndState(markdown, {
      fileName,
      parserLabel,
      message: '已移除招标文件',
      resetOriginal: true,
      sourceFiles,
    });
  }

  async function importOriginalPlanDocument(filePaths, options = {}) {
    const importer = fileService?.importTechnicalPlanDocument || fileService?.importDocument;
    if (!importer) {
      throw new Error('文件导入服务尚未初始化');
    }

    const result = fileService.importTechnicalPlanDocument
      ? await fileService.importTechnicalPlanDocument('原方案', { filePaths })
      : await importer({ filePaths });
    if (!result?.success || !result.file_content) {
      return {
        success: false,
        message: result?.message || '未导入文件',
        markdown: '',
      };
    }

    const markdown = String(result.file_content || '').trim();
    const fileName = result.file_name || '未命名文件';
    const parserLabel = result.parser_label || null;
    await runBeforeCommit(options.beforeCommit);
    const targetDir = path.dirname(originalPlanMarkdownPath);
    const tempPath = path.join(targetDir, `original-plan-${Date.now()}.tmp.md`);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(tempPath, `${markdown}\n`, 'utf-8');

    try {
      fs.renameSync(tempPath, originalPlanMarkdownPath);
      const timestamp = now();
      const transaction = db.transaction(() => {
        updateMeta({
          workflow_kind: 'existing-plan-expansion',
          original_plan_file_name: fileName,
          original_plan_markdown_path: originalPlanMarkdownRelativePath,
          original_plan_markdown_hash: stableHash(markdown),
          original_plan_markdown_chars: markdown.length,
          original_plan_parser_label: parserLabel || null,
          original_plan_imported_at: timestamp,
        });
        clearDownstreamFromOriginalPlan();
      });
      transaction();
      return {
        success: true,
        message: result.message || '原方案已导入',
        markdown,
      };
    } catch (error) {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
      throw error;
    }
  }

  function saveTenderMarkdownAndState(markdown, { fileName, parserLabel, message, selectedSection, fallbackToLocal, resetOriginal, sourceFiles }) {
    const nextMarkdown = String(markdown || '').trim();
    if (Array.isArray(sourceFiles)) {
      clearBidTemplate();
      if (fs.existsSync(tenderSourceFilesDir)) {
        removeWorkspacePathSync(tenderSourceFilesDir);
      }
    }
    const tenderSourceFiles = Array.isArray(sourceFiles)
      ? sourceFiles.map(writeTenderSourceMarkdown)
      : undefined;
    if (tenderSourceFiles) {
      pruneTenderOriginals(tenderSourceFiles.map((file) => file.sourceDocxPath).filter(Boolean));
    }
    writeMarkdownFile(tenderMarkdownPath, nextMarkdown, 'tender');
    if (resetOriginal) {
      writeMarkdownFile(tenderOriginalMarkdownPath, nextMarkdown, 'tender-original');
    }

    const timestamp = now();
    const transaction = db.transaction(() => {
      clearDownstreamFromTender();
      updateMeta({
        tender_file_name: fileName || '未命名文件',
        tender_markdown_path: tenderMarkdownRelativePath,
        tender_markdown_hash: stableHash(nextMarkdown),
        tender_markdown_chars: nextMarkdown.length,
        tender_original_markdown_path: resetOriginal ? tenderOriginalMarkdownRelativePath : undefined,
        tender_original_markdown_hash: resetOriginal ? stableHash(nextMarkdown) : undefined,
        tender_original_markdown_chars: resetOriginal ? nextMarkdown.length : undefined,
        tender_parser_label: parserLabel || null,
        tender_imported_at: timestamp,
        tender_files_json: tenderSourceFiles ? JSON.stringify(tenderSourceFiles) : undefined,
        selected_section_id: selectedSection?.id || null,
        selected_section_title: selectedSection?.title || null,
      });
    });
    transaction();
    return {
      success: true,
      message: message || (fallbackToLocal ? '文件解析完成，当前格式已自动使用本地解析' : '招标文件已导入'),
      markdown: nextMarkdown,
    };
  }

  function selectBidSection(selectedSection) {
    const selected = selectedSection || {};
    const meta = ensureMetaRow();
    const aiSections = normalizeBidSections(safeJsonParse(meta.bid_sections_json, []));

    if (aiSections.length >= 2) {
      const matched = aiSections.find((section) => section.id === selected.id) || selected;
      const originalMarkdown = readOriginalTenderMarkdown().trim();
      if (!originalMarkdown) {
        throw new Error('原始招标文件内容为空，请重新上传');
      }
      const workingMarkdown = buildSelectedSectionMarkdown(originalMarkdown, aiSections, matched.id);
      clearBidTemplate();
      writeMarkdownFile(tenderMarkdownPath, workingMarkdown, 'tender');
      const transaction = db.transaction(() => {
        clearDownstreamFromBidSectionChange();
        updateMeta({
          tender_markdown_path: tenderMarkdownRelativePath,
          tender_markdown_hash: stableHash(workingMarkdown),
          tender_markdown_chars: workingMarkdown.length,
          bid_section_mode: 'multiple',
          selected_section_id: matched.id || null,
          selected_section_title: matched.title || null,
        });
      });
      transaction();
      return {
        success: true,
        message: `已选择【${matched.title || '投标范围'}】，招标文件解析将仅使用当前投标范围`,
        markdown: workingMarkdown,
      };
    }

    throw new Error('请先完成多标段识别，再选择投标范围');
  }

  function clearTechnicalPlan() {
    const workflowKind = normalizeWorkflowKind(ensureMetaRow().workflow_kind);
    clearTenderSourceFiles();
    cleanupPendingTenderSelection();
    removeWorkspacePathSync(tenderMarkdownPath);
    removeWorkspacePathSync(tenderOriginalMarkdownPath);
    removeWorkspacePathSync(originalPlanMarkdownPath);
    clearOriginalOutlineRuntime();
    clearTechnicalPlanMermaidCache();
    clearIllustrationFiles();
    deleteImportedImageBatches(app, 'technical-plan');
    deleteOutlineAgentTask();
    deleteGlobalFactsAgentTask();
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM technical_plan_tasks').run();
      db.prepare('DELETE FROM technical_plan_bid_items').run();
      db.prepare('DELETE FROM technical_plan_reference_docs').run();
      db.prepare('DELETE FROM technical_plan_outline_nodes').run();
      db.prepare('DELETE FROM technical_plan_global_fact_groups').run();
      clearContentIllustrationPlan();
      db.prepare('DELETE FROM technical_plan_meta').run();
      ensureMetaRow();
      updateMeta({ workflow_kind: workflowKind });
    });
    transaction();
    notifyAgentWorkspaceChange({ force: true });
    return { success: true, message: '技术方案缓存已清空' };
  }

  return {
    importTenderDocument,
    removeTenderDocument,
    importOriginalPlanDocument,
    saveTenderMarkdownAndState,
    selectBidSection,
    clearTechnicalPlan,
  };
}

module.exports = { createTenderDocumentLifecycle };
