const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const AdmZip = require('adm-zip');
const CFB = require('cfb');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { PDFParse } = require('pdf-parse');
const { getDuplicateCheckContentDir, getGeneratedImagesDir, getImportedImagesDir } = require('../utils/paths.cjs');
const { compactLogError, createDeveloperLogger, textMetrics } = require('../utils/developerLog.cjs');
const { normalizeDocumentParseError } = require('./documentParseErrors.cjs');
const { parseDocumentWithConfig } = require('./fileService.cjs');
const {
  intersectSize,
  lcsSimilarity,
  riskFromScore,
  charBigramsFromLooseText,
  diceSimilarityFromShared,
} = require('./duplicates/similarity.cjs');
const {
  normalizeValue,
  stripMarkdownForOutline,
  inferOutlineLevel,
  isCatalogTitleLine,
  normalizeContentLineBreaks,
  splitMarkdownTableRow,
  stripLeadingContentSequence,
  cleanContentSentence,
  isInformativeContentSentence,
  stripTenderTablePrefix,
  stripTenderDirectoryPageTail,
  normalizeTenderFieldName,
} = require('./duplicates/tenderText.cjs');
const {
  now,
  stableFileId,
  getTenderFilesFromPayload,
  createSignature,
  hashText,
} = require('./duplicates/fileSignature.cjs');
const { extractMetadata } = require('./duplicates/documentMetadata.cjs');
const { createAnalysisPipeline } = require('./duplicates/analysisPipeline.cjs');
const {
  buildRows,
  cleanOutlineTitle,
  splitTenderSentences,
  parseOutlineMarker,
  buildOutlineItems,
  splitContentSentences,
  buildTenderSourceMatcher,
} = require('./duplicates/outlineText.cjs');
const {
  buildDuplicateSentences,
  extractImageOccurrences,
  readImageTargetBuffer,
  buildDuplicateImages,
  createInitialAnalysis,
  createInitialOutlineAnalysis,
  createInitialContentAnalysis,
  createInitialImageAnalysis,
  summarizeDuplicateFileForLog,
  summarizeResultStatus,
  summarizeContentExtractionResults,
} = require('./duplicates/analysisSupport.cjs');
const {
  isReadableSignalSnippet,
  extractMarkdownTextBlocks,
  buildOutlineComparison,
  addContentTextBlock,
  cleanMarkdownInlineText,
  cleanMarkdownLine,
} = require('./duplicates/markdownText.cjs');
const { markdownImagePattern, htmlImageSrcPattern, htmlImagePattern } = require('./duplicates/markdownText.cjs');
const {
  decodeXml,
  readZipText,
  align4,
  readUInt16LE,
  readInt16LE,
  readUInt32LE,
  readInt32LE,
  codePageToEncoding,
  cleanOleString,
  isOlePropertySetStreamName,
  canonicalPdfXmpKey,
  decodeUtf16Be,
  decodePdfName,
} = require('./duplicates/metadataDecoders.cjs');


function loadDeveloperConfig(configStore) {
  try {
    return configStore?.load?.() || {};
  } catch {
    return {};
  }
}

function createDuplicateCheckService({ app, configStore, workspaceStore } = {}) {

  const { run, isCurrentDuplicateCheckSignature, latestAnalysisMessage, overallProgress } = createAnalysisPipeline({
    app,
    configStore,
    workspaceStore,
  });

  return {
    async runAnalysisTask({ workspaceStore: taskWorkspaceStore, updateTask, checkpointTask, payload }) {
      const signature = createSignature(payload);
      const force = payload.force === true;
      const bidFiles = Array.isArray(payload.bidFiles) ? payload.bidFiles : [];
      const tenderFiles = getTenderFilesFromPayload(payload);
      const developerLogger = createDeveloperLogger({
        app,
        config: loadDeveloperConfig(configStore),
        moduleName: 'duplicate-check',
        name: 'duplicate-analysis',
        meta: {
          signature,
          force,
          tender_files: tenderFiles.map((file) => summarizeDuplicateFileForLog(file, 'tender')),
          bid_file_count: bidFiles.length,
        },
      });
      developerLogger.write('duplicate.task.started', {
        signature,
        force,
        tender_files: tenderFiles.map((file) => summarizeDuplicateFileForLog(file, 'tender')),
        bid_files: bidFiles.map((file) => summarizeDuplicateFileForLog(file, 'bid')),
      });
      const current = taskWorkspaceStore.loadDuplicateCheck() || {};
      if (!force
        && current.metadataAnalysis?.signature === signature && current.metadataAnalysis?.status === 'success'
        && current.outlineAnalysis?.signature === signature && current.outlineAnalysis?.status === 'success'
        && current.contentAnalysis?.signature === signature && current.contentAnalysis?.status === 'success'
        && current.imageAnalysis?.signature === signature && current.imageAnalysis?.status === 'success') {
        checkpointTask({ status: 'success', progress: 100, logs: ['标书查重分析已完成，无需重复分析。'] });
        developerLogger.write('duplicate.task.skipped', { signature, reason: 'already_success' });
        return;
      }

      const metadataAnalysis = createInitialAnalysis(signature, bidFiles);
      const outlineAnalysis = createInitialOutlineAnalysis(signature, bidFiles);
      const contentAnalysis = createInitialContentAnalysis(signature, bidFiles);
      const imageAnalysis = createInitialImageAnalysis(signature, bidFiles);
      let analysisState = {
        metadataAnalysis,
        outlineAnalysis,
        contentAnalysis,
        imageAnalysis,
      };
      const initialLogs = [force ? '开始重新执行标书查重分析。' : '开始执行标书查重分析。'];
      let latestLog = initialLogs[0];
      checkpointTask({ status: 'running', progress: 0, logs: initialLogs }, {
        tenderFile: tenderFiles[0] || null,
        tenderFiles,
        bidFiles,
        metadataAnalysis,
        outlineAnalysis,
        contentAnalysis,
        imageAnalysis,
      });

      const notifyTask = (field, analysisPartial) => {
        analysisState = {
          ...analysisState,
          [field]: { ...(analysisState[field] || {}), ...analysisPartial },
        };
        const message = latestAnalysisMessage(analysisState);
        const partial = { status: 'running', progress: overallProgress(analysisState) };
        if (message && message !== latestLog) {
          latestLog = message;
          partial.logs = [message];
        }
        const detailFields = field === 'metadataAnalysis'
          ? ['contentFiles', 'files']
          : field === 'outlineAnalysis'
            ? ['files', 'duplicateGroups', 'pairwiseSimilarities']
            : field === 'contentAnalysis'
              ? ['duplicateSentences']
              : ['files', 'duplicateImages'];
        const hasResultChange = detailFields.some((key) => Object.prototype.hasOwnProperty.call(analysisPartial, key));
        const hasTerminalTransition = ['success', 'error'].includes(analysisPartial.status);
        (hasResultChange || hasTerminalTransition ? checkpointTask : updateTask)(partial, { [field]: analysisPartial });
      };

      const finalStatus = await run(signature, payload, notifyTask, developerLogger);
      const doneLog = finalStatus === 'success' ? '标书查重分析完成。' : '标书查重分析完成，部分结果失败。';
      if (!isCurrentDuplicateCheckSignature(signature)) {
        developerLogger.write('duplicate.task.stale_signature', { signature });
        return;
      }
      checkpointTask({ status: finalStatus, progress: 100, logs: [doneLog] });
      developerLogger.write('duplicate.task.completed', {
        signature,
        status: finalStatus,
        progress: 100,
      });
    },
  };
}

module.exports = { createDuplicateCheckService };
