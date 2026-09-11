const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { dialog } = require('electron');
const { getKnowledgeBaseDir } = require('../utils/paths.cjs');
const { deleteImportedImageBatches } = require('../utils/importedImages.cjs');
const { enqueueJsonLine, enqueueLogRemoval } = require('../utils/silentFileLog.cjs');
const { splitUserTextByContextLimit } = require('../utils/userTextSplitter.cjs');
const { parseDocumentWithConfig } = require('./fileService.cjs');
const {
  now,
  waitForPromptCacheWarmup,
  runParallelAndThrowAfterSettled,
  createId,
  safeName,
  ensureDir,
  getDebugLogsDir,
  getDebugLogPath,
  fromRelative,
  normalizeRelativePath,
  rebaseDocumentRelativePath,
  getPromptSummary,
  getItemSample,
  getMatchSummary,
  stripMarkdownFence,
  getMessagesContentLength,
  getKnowledgeBaseSegmentLimit,
  mergeMatchResults,
  renderCandidateItemsJson,
  renderKnowledgeItemsJson,
  normalizeCandidateItems,
  validateCandidateItems,
  mergeTitleSummaryItems,
  mergeCandidateItems,
  buildDocumentBlocksPrefixMessage,
  buildMissingBlocksPrefixMessage,
  buildInitialItemTaskMessage,
  buildInitialItemMessages,
  buildSupplementItemTaskMessage,
  buildSupplementItemMessages,
  buildMatchTaskMessage,
  buildMatchMessages,
  buildRecoveryTaskMessage,
  buildRecoveryMessages,
  getRequestBudget,
  buildUnifiedBlockSegments,
  getItemSplitBudget,
  getBlockOrder,
  normalizeMatchResult,
  validateMatchResult,
  validateRecoveryResult,
  collectHandledBlockIds,
  getMissingBlocks,
  nextKnowledgeItemId,
  createReport,
  DEFAULT_CONTEXT_LENGTH_LIMIT,
  KNOWLEDGE_CONTEXT_LIMIT_RATIO,
  TASK_AND_ITEMS_RESERVE_RATIO,
  PROMPT_CACHE_WARMUP_DELAY_MS,
} = require('./knowledge/kbPipelineUtils.cjs');
const { createDocumentPipeline } = require('./knowledge/documentPipeline.cjs');
const {
  isPageNumberBlock,
  isCatalogBlock,
  isCoverBlock,
  isSignatureBlock,
  isTableBlock,
} = require('./knowledge/blockTypes.cjs');
const {
  createRawBlocks,
  mergeSemanticBlocks,
  filterBlocks,
  renderBlocksForPrompt,
  packBlocksIntoSegments,
  packItemsIntoSegments,
  mergeRecoverySegmentResults,
  normalizeRecoveryResult,
  createFinalItems,
  normalizeRanges,
  expandRanges,
  compressBlockIdsToRanges,
} = require('./knowledge/blockPipeline.cjs');

const supportedExtensions = new Set(['.doc', '.docx', '.wps', '.pdf', '.md', '.markdown', '.xls', '.xlsx']);
const recoveryMaxAttempts = 2;
/** 统一 block 分段时预留给任务说明+条目等 L2 后缀的预算比例（策略 B） */


function createKnowledgeBaseService({ app, aiService, configStore, knowledgeBaseStore }) {
  const baseDir = getKnowledgeBaseDir(app);
  const activePreparations = new Set();
  const activeMatches = new Set();

  if (!knowledgeBaseStore) {
    throw new Error('知识库数据库服务尚未初始化');
  }

  function isDeveloperMode() {
    try {
      return Boolean(configStore?.load()?.developer_mode);
    } catch {
      return false;
    }
  }

  function debugLog(documentId, event, payload = {}) {
    if (!isDeveloperMode()) {
      return;
    }

    try {
      const logPath = getDebugLogPath(app, documentId || 'unknown');
      const entry = {
        time: now(),
        event,
        ...payload,
      };
      enqueueJsonLine(logPath, entry);
      console.info(`[knowledge-base] ${event}`, entry);
    } catch {
      // 调试日志不能影响知识库主流程。
    }
  }

  function emitProgress(webContents, document) {
    if (!webContents?.isDestroyed()) {
      webContents.send('knowledge-base:event', { document });
    }
  }

  function updateDocument(documentId, partial, webContents) {
    const document = knowledgeBaseStore.updateDocument(documentId, { ...partial, updated_at: now() });
    if (document) emitProgress(webContents, document);
    debugLog(documentId, 'document:update', {
      status: partial.status,
      progress: partial.progress,
      message: partial.message,
      error: partial.error,
      candidate_item_count: partial.candidate_item_count,
      item_count: partial.item_count,
      block_count: partial.block_count,
      filtered_block_count: partial.filtered_block_count,
    });
    return document;
  }

  function getDocument(documentId) {
    return knowledgeBaseStore.getDocument(documentId);
  }

  function getActiveDocumentIds() {
    return [...new Set([...activePreparations, ...activeMatches])];
  }

  function recoverInterruptedDocuments() {
    const recovered = knowledgeBaseStore.recoverInterruptedDocuments(getActiveDocumentIds());
    recovered.forEach((document) => debugLog(document.id, 'document:recover-interrupted', { status: document.status, message: document.message }));
    return recovered;
  }

  function isSamePath(a, b) {
    return path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();
  }

  function getStep(documentId, stepKey) {
    return knowledgeBaseStore.getDocumentStep(documentId, stepKey);
  }

  function stepCanReuse(step, hasArtifact) {
    return Boolean(hasArtifact && (!step || step.status === 'success'));
  }

  function getStepItems(documentId, stepKey) {
    const result = getStep(documentId, stepKey)?.result;
    return Array.isArray(result?.items) ? result.items : null;
  }

  function isSameStringList(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => String(value) === String(b[index]));
  }

  function isRecoveryStepResult(value) {
    return Boolean(value
      && Array.isArray(value.items)
      && Array.isArray(value.matches)
      && Array.isArray(value.discarded)
      && Array.isArray(value.system_discarded)
      && Array.isArray(value.recovery_attempts));
  }

  async function runDocumentStep(documentId, stepKey, worker) {
    knowledgeBaseStore.saveDocumentStep(documentId, stepKey, { status: 'running' });
    try {
      const result = await worker();
      knowledgeBaseStore.saveDocumentStep(documentId, stepKey, { status: 'success', result });
      debugLog(documentId, `step:${stepKey}:success`);
      return result;
    } catch (error) {
      knowledgeBaseStore.saveDocumentStep(documentId, stepKey, { status: 'error', error: error.message || String(error) });
      debugLog(documentId, `step:${stepKey}:error`, { message: error.message || String(error) });
      throw error;
    }
  }


  recoverInterruptedDocuments();

  // 文档解析与匹配流水线：实现见 knowledge/documentPipeline.cjs。
  const { prepareDocument, matchDocument } = createDocumentPipeline({
    baseDir,
    activePreparations,
    activeMatches,
    isDeveloperMode,
    debugLog,
    updateDocument,
    getDocument,
    isSamePath,
    getStep,
    stepCanReuse,
    getStepItems,
    isSameStringList,
    isRecoveryStepResult,
    runDocumentStep,
  });
  return {
    list() {
      return knowledgeBaseStore.list();
    },
    search(request) {
      return knowledgeBaseStore.search(request);
    },

    createFolder(name) {
      return knowledgeBaseStore.createFolder(name);
    },

    renameFolder(folderId, name) {
      return knowledgeBaseStore.renameFolder(folderId, name);
    },

    reorderFolder(draggedFolderId, targetFolderId, position) {
      knowledgeBaseStore.reorderFolders(draggedFolderId, targetFolderId, position);
      return { success: true, message: '文件夹排序已保存' };
    },

    deleteFolder(folderId) {
      const index = knowledgeBaseStore.list();
      const folder = index.folders.find((item) => item.id === folderId);
      if (!folder) throw new Error('知识库文件夹不存在');

      const documentsToDelete = index.documents.filter((document) => document.folder_id === folderId);
      const runningDocument = documentsToDelete.find((document) => activePreparations.has(document.id) || activeMatches.has(document.id));
      if (runningDocument) {
        throw new Error(`文档“${runningDocument.file_name}”正在处理中，请完成后再删除文件夹`);
      }

      for (const document of documentsToDelete) {
        deleteImportedImageBatches(app, `knowledge-${document.id}`);
        fs.rmSync(fromRelative(baseDir, document.document_dir), { recursive: true, force: true });
        enqueueLogRemoval(getDebugLogPath(app, document.id));
      }
      fs.rmSync(fromRelative(baseDir, path.join('folders', folderId)), { recursive: true, force: true });
      knowledgeBaseStore.deleteFolder(folderId);
      return { success: true, message: `已删除文件夹“${folder.name}”及 ${documentsToDelete.length} 个文档` };
    },

    deleteDocument(documentId) {
      const document = getDocument(documentId);
      if (activePreparations.has(documentId) || activeMatches.has(documentId)) {
        throw new Error('该文档正在处理中，请完成后再删除');
      }

      deleteImportedImageBatches(app, `knowledge-${documentId}`);
      fs.rmSync(fromRelative(baseDir, document.document_dir), { recursive: true, force: true });
      enqueueLogRemoval(getDebugLogPath(app, documentId));
      knowledgeBaseStore.deleteDocument(documentId);
      return { success: true, message: `已删除文档“${document.file_name}”` };
    },

    moveDocument(documentId, targetFolderId, targetDocumentId, position) {
      const document = getDocument(documentId);
      if (activePreparations.has(documentId) || activeMatches.has(documentId)) {
        throw new Error('该文档正在处理中，请完成后再移动');
      }
      if (!['ready_for_matching', 'success', 'error'].includes(document.status)) {
        throw new Error('该文档正在处理中，请完成后再移动');
      }

      const index = knowledgeBaseStore.list();
      const targetFolder = index.folders.find((folder) => folder.id === targetFolderId);
      if (!targetFolder) throw new Error('目标知识库文件夹不存在');

      let moveOptions = { targetDocumentId, position };
      let oldDir = '';
      let newDir = '';
      if (document.folder_id !== targetFolderId) {
        const newDocumentDir = path.join('folders', targetFolderId, 'documents', documentId).replace(/\\/g, '/');
        oldDir = fromRelative(baseDir, document.document_dir);
        newDir = fromRelative(baseDir, newDocumentDir);
        if (!fs.existsSync(oldDir)) {
          throw new Error('文档文件不存在，无法移动');
        }
        if (fs.existsSync(newDir)) {
          throw new Error('目标文件夹中已存在同名文档目录，无法移动');
        }
        ensureDir(path.dirname(newDir));
        fs.renameSync(oldDir, newDir);
        moveOptions = {
          ...moveOptions,
          documentDir: newDocumentDir,
          sourcePath: rebaseDocumentRelativePath(document.source_path, document.document_dir, newDocumentDir),
          markdownPath: rebaseDocumentRelativePath(document.markdown_path, document.document_dir, newDocumentDir),
        };
      }

      try {
        const movedDocument = knowledgeBaseStore.moveDocument(documentId, targetFolderId, moveOptions);
        return { success: true, message: `已移动文档“${document.file_name}”`, document: movedDocument };
      } catch (error) {
        if (oldDir && newDir && fs.existsSync(newDir) && !fs.existsSync(oldDir)) {
          try {
            fs.renameSync(newDir, oldDir);
          } catch {
            // 回滚失败时保留原始错误，避免掩盖数据库更新问题。
          }
        }
        throw error;
      }
    },

    async uploadDocuments(folderId, webContents) {
      const currentIndex = knowledgeBaseStore.list();
      const folder = currentIndex.folders.find((item) => item.id === folderId);
      if (!folder) throw new Error('请先选择知识库文件夹');

      const result = await dialog.showOpenDialog({
        title: '选择知识库文档',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '知识库文档', extensions: ['doc', 'docx', 'wps', 'pdf', 'md', 'markdown', 'xls', 'xlsx'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePaths.length) {
        return { success: false, message: '已取消选择' };
      }

      const created = [];
      for (const filePath of result.filePaths) {
        const ext = path.extname(filePath).toLowerCase();
        if (!supportedExtensions.has(ext)) continue;
        const documentId = createId('doc');
        const documentDir = path.join('folders', folderId, 'documents', documentId).replace(/\\/g, '/');
        const sourceName = `source${ext}`;
        const document = {
          id: documentId,
          folder_id: folderId,
          file_name: path.basename(filePath),
          document_dir: documentDir,
          source_path: path.join(documentDir, sourceName).replace(/\\/g, '/'),
          markdown_path: path.join(documentDir, 'content.md').replace(/\\/g, '/'),
          status: 'pending',
          progress: 0,
          message: '等待处理',
          item_count: 0,
          block_count: 0,
          filtered_block_count: 0,
          candidate_item_count: 0,
          discarded_block_count: 0,
          system_discarded_after_retry_count: 0,
          created_at: now(),
          updated_at: now(),
        };
        const savedDocument = knowledgeBaseStore.createDocument(document);
        created.push(savedDocument);
        emitProgress(webContents, savedDocument);
        prepareDocument(documentId, filePath, webContents);
      }

      return { success: Boolean(created.length), message: created.length ? `已加入 ${created.length} 个文档处理任务` : '未选择支持的文档类型', documents: created };
    },

    retryDocument(documentId, webContents) {
      const document = getDocument(documentId);
      debugLog(documentId, 'ipc:retry-document', { current_status: document.status });
      if (activePreparations.has(documentId) || activeMatches.has(documentId)) {
        return { success: false, message: '该文档正在处理中', document };
      }
      if (document.status !== 'error') {
        return { success: false, message: '只有解析失败的文档可以重试', document };
      }

      const sourcePath = fromRelative(baseDir, document.source_path);
      if (!fs.existsSync(sourcePath)) {
        return { success: false, message: '原始文件不存在，请重新上传', document };
      }

      prepareDocument(documentId, sourcePath, webContents);
      return { success: true, message: '已重新开始解析', document: getDocument(documentId) };
    },

    startMatching(documentId, _batchSize, webContents) {
      const document = getDocument(documentId);
      debugLog(documentId, 'ipc:start-matching', { current_status: document.status });
      if (activeMatches.has(documentId)) {
        return { success: false, message: '该文档正在匹配中', document };
      }
      if (!['ready_for_matching', 'success', 'error'].includes(document.status)) {
        return { success: false, message: '请等待候选知识条目提取完成', document };
      }
      // batchSize 已忽略，按模型上下文自动分段匹配
      matchDocument(documentId, webContents, { force: document.status === 'success' });
      return { success: true, message: '已开始自动分段匹配段落', document };
    },

    getOutlineReferences(documentIds) {
      return knowledgeBaseStore.getOutlineReferences(documentIds);
    },

    readMarkdown(documentId) {
      return knowledgeBaseStore.readMarkdown(documentId);
    },

    readReferences(documentIds, options) {
      return knowledgeBaseStore.readReferences(documentIds, options);
    },

    readItems(documentId) {
      return knowledgeBaseStore.readItems(documentId);
    },

    readAnalysis(documentId) {
      return knowledgeBaseStore.readAnalysis(documentId, { debugLogPath: isDeveloperMode() ? getDebugLogPath(app, documentId) : '' });
    },
  };
}

module.exports = {
  createKnowledgeBaseService,
  _internals: {
    createRawBlocks,
    mergeSemanticBlocks,
    filterBlocks,
    renderBlocksForPrompt,
    packBlocksIntoSegments,
    packItemsIntoSegments,
    getKnowledgeBaseSegmentLimit,
    buildUnifiedBlockSegments,
    buildInitialItemMessages,
    buildSupplementItemMessages,
    buildMatchMessages,
    buildRecoveryMessages,
    mergeTitleSummaryItems,
    mergeMatchResults,
    normalizeCandidateItems,
    normalizeMatchResult,
    normalizeRecoveryResult,
  },
};
