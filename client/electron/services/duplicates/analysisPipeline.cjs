// 标书查重分析流水线：元数据 → 正文提取 → 目录比对 → 正文比对 → 图片比对，逐段回写分析状态。
//
// 这些原本是 createDuplicateCheckService 工厂里的闭包函数；搬出来后只注入 app / configStore / workspaceStore，
// 其余依赖全部来自同目录的纯模块，函数本身不持有可变闭包状态，可单独测试。
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { getDuplicateCheckContentDir, getGeneratedImagesDir, getImportedImagesDir } = require('../../utils/paths.cjs');
const { compactLogError, textMetrics } = require('../../utils/developerLog.cjs');
const { parseDocumentWithConfig } = require('../fileService.cjs');
const { normalizeDocumentParseError } = require('../documentParseErrors.cjs');
const {
  buildRows,
  buildOutlineItems,
  splitContentSentences,
  splitTenderSentences,
  buildTenderSourceMatcher,
} = require('./outlineText.cjs');
const {
  createInitialAnalysis,
  createInitialOutlineAnalysis,
  createInitialContentAnalysis,
  createInitialImageAnalysis,
  buildDuplicateSentences,
  buildDuplicateImages,
  extractImageOccurrences,
  readImageTargetBuffer,
  summarizeDuplicateFileForLog,
  summarizeResultStatus,
  summarizeContentExtractionResults,
} = require('./analysisSupport.cjs');
const { now, stableFileId, getTenderFilesFromPayload, createSignature, hashText } = require('./fileSignature.cjs');
const { extractMetadata } = require('./documentMetadata.cjs');
const { buildOutlineComparison } = require('./markdownText.cjs');

function createAnalysisPipeline({ app, configStore, workspaceStore } = {}) {
  function analysisProgress(value) {
    if (!value) return 0;
    if (value.status === 'success' || value.status === 'error') return 100;
    return Math.max(0, Math.min(Number(value.progress) || 0, 99));
  }

  function overallProgress(state) {
    const values = [
      analysisProgress(state?.metadataAnalysis),
      analysisProgress(state?.outlineAnalysis),
      analysisProgress(state?.contentAnalysis),
      analysisProgress(state?.imageAnalysis),
    ];
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  }

  function latestAnalysisMessage(state) {
    return state?.imageAnalysis?.message
      || state?.contentAnalysis?.message
      || state?.outlineAnalysis?.message
      || state?.metadataAnalysis?.message
      || '标书查重分析运行中。';
  }

  function isCurrentDuplicateCheckSignature(signature) {
    if (!signature) return true;
    const current = workspaceStore.loadDuplicateCheck() || {};
    const currentSignature = createSignature({
      tenderFile: current.tenderFile || null,
      tenderFiles: Array.isArray(current.tenderFiles) ? current.tenderFiles : [],
      bidFiles: Array.isArray(current.bidFiles) ? current.bidFiles : [],
    });
    return currentSignature === signature;
  }

  function updateAnalysisField(field, partial, persist, signature) {
    const analysisPartial = {
      ...partial,
      ...(signature ? { signature } : {}),
      updated_at: now(),
    };
    if (typeof persist === 'function') {
      return persist(field, analysisPartial);
    }
    const prev = workspaceStore.loadDuplicateCheck() || {};
    if (signature) {
      const currentSignature = createSignature({
        tenderFile: prev.tenderFile || null,
        tenderFiles: Array.isArray(prev.tenderFiles) ? prev.tenderFiles : [],
        bidFiles: Array.isArray(prev.bidFiles) ? prev.bidFiles : [],
      });
      if (currentSignature !== signature) return null;
    }
    workspaceStore.updateDuplicateCheckWithoutReload({ [field]: analysisPartial });
    return undefined;
  }

  function updateAnalysis(partial, persist, signature) {
    return updateAnalysisField('metadataAnalysis', partial, persist, signature);
  }

  function updateOutlineAnalysis(partial, persist, signature) {
    return updateAnalysisField('outlineAnalysis', partial, persist, signature);
  }

  function updateContentAnalysis(partial, persist, signature) {
    return updateAnalysisField('contentAnalysis', partial, persist, signature);
  }

  function updateImageAnalysis(partial, persist, signature) {
    return updateAnalysisField('imageAnalysis', partial, persist, signature);
  }

  async function runContentExtraction(allFiles, webContents, signature, developerLogger, tenderFiles) {
    const config = configStore ? configStore.load() : { components: { file_parser: { provider: 'local' } } };
    const dir = getDuplicateCheckContentDir(app);
    await fs.mkdir(dir, { recursive: true });
    const results = [];
    const tenderFileIds = new Set((Array.isArray(tenderFiles) ? tenderFiles : []).map(stableFileId));
    developerLogger?.write('duplicate.content_extraction.started', {
      signature,
      file_count: allFiles.length,
      files: allFiles.map((file) => summarizeDuplicateFileForLog(file, tenderFileIds.has(stableFileId(file)) ? 'tender' : 'bid')),
    });
    updateAnalysis({ contentExtraction: { status: 'running', completed: 0, total: allFiles.length }, message: '正在提取正文内容' }, webContents, signature);

    for (const file of allFiles) {
      const fileId = stableFileId(file);
      try {
        const markdown = (await parseDocumentWithConfig(app, file.file_path, config, {
          assetScope: `duplicate-check-content-${fileId}`,
          preserveImages: true,
        })).trim();
        const contentPath = path.join(dir, `${fileId}.md`);
        await fs.writeFile(contentPath, markdown, 'utf-8');
        results.push({
          file_id: fileId,
          file_name: file.file_name,
          status: 'success',
          content_path: contentPath,
          content_length: markdown.length,
          content_hash: hashText(markdown),
        });
        developerLogger?.write('duplicate.content_extraction.file.completed', {
          file: summarizeDuplicateFileForLog(file, tenderFileIds.has(fileId) ? 'tender' : 'bid'),
          markdown_metrics: textMetrics(markdown),
        });
      } catch (error) {
        results.push({ file_id: fileId, file_name: file.file_name, status: 'error', error: error.message || '正文提取失败' });
        developerLogger?.write('duplicate.content_extraction.file.error', {
          file: summarizeDuplicateFileForLog(file, tenderFileIds.has(fileId) ? 'tender' : 'bid'),
          error: compactLogError(error),
        });
      }
      updateAnalysis({ contentExtraction: { status: 'running', completed: results.length, total: allFiles.length }, contentFiles: results, message: `正文内容提取 ${results.length}/${allFiles.length}` }, webContents, signature);
    }

    const status = results.some((item) => item.status === 'error') ? 'error' : 'success';
    updateAnalysis({ contentExtraction: { status, completed: results.length, total: allFiles.length }, contentFiles: results }, webContents, signature);
    developerLogger?.write('duplicate.content_extraction.completed', {
      signature,
      status,
      result: summarizeContentExtractionResults(results),
    });
    return results;
  }

  async function readCombinedTenderMarkdown(contentFiles, tenderFiles) {
    const parts = [];
    for (const file of Array.isArray(tenderFiles) ? tenderFiles : []) {
      const markdown = await readContentMarkdown(contentFiles, file);
      if (String(markdown || '').trim()) parts.push(String(markdown).trim());
    }
    return parts.join('\n\n');
  }

  async function runMetadataExtraction(bidFiles, webContents, signature, developerLogger) {
    const results = [];
    developerLogger?.write('duplicate.metadata_extraction.started', {
      signature,
      bid_file_count: bidFiles.length,
    });
    updateAnalysis({ metadataExtraction: { status: 'running', completed: 0, total: bidFiles.length }, message: '正在提取投标文件元数据' }, webContents, signature);

    for (const file of bidFiles) {
      const fileId = stableFileId(file);
      try {
        results.push({ file_id: fileId, file_name: file.file_name, status: 'success', metadata: await extractMetadata(file) });
        developerLogger?.write('duplicate.metadata_extraction.file.completed', {
          file: summarizeDuplicateFileForLog(file, 'bid'),
          metadata_count: results[results.length - 1].metadata.length,
        });
      } catch (error) {
        results.push({ file_id: fileId, file_name: file.file_name, status: 'error', error: error.message || '元数据提取失败', metadata: [] });
        developerLogger?.write('duplicate.metadata_extraction.file.error', {
          file: summarizeDuplicateFileForLog(file, 'bid'),
          error: compactLogError(error),
        });
      }
      const rows = buildRows(results);
      updateAnalysis({ metadataExtraction: { status: 'running', completed: results.length, total: bidFiles.length }, files: results, rows, message: `元数据提取 ${results.length}/${bidFiles.length}` }, webContents, signature);
    }

    const rows = buildRows(results);
    const status = results.some((item) => item.status === 'error') ? 'error' : 'success';
    updateAnalysis({ metadataExtraction: { status, completed: results.length, total: bidFiles.length }, files: results, rows }, webContents, signature);
    developerLogger?.write('duplicate.metadata_extraction.completed', {
      signature,
      status,
      result: summarizeResultStatus(results),
      row_count: rows.length,
      repeated_row_count: rows.filter((row) => row.repeated).length,
    });
    return results;
  }

  async function readContentMarkdown(contentFiles, file) {
    const fileId = stableFileId(file);
    const item = contentFiles.find((entry) => entry.file_id === fileId && entry.status === 'success' && entry.content_path);
    if (!item) throw new Error('正文内容尚未成功提取，无法进行目录分析');
    return fs.readFile(item.content_path, 'utf-8');
  }

  async function runOutlineAnalysis(tenderFiles, bidFiles, contentFiles, signature, webContents, developerLogger) {
    developerLogger?.write('duplicate.outline_analysis.started', {
      signature,
      bid_file_count: bidFiles.length,
      tender_files: (Array.isArray(tenderFiles) ? tenderFiles : []).map((file) => summarizeDuplicateFileForLog(file, 'tender')),
    });
    updateOutlineAnalysis({ status: 'running', progress: 5, extraction: { status: 'running', completed: 0, total: bidFiles.length }, message: '正在准备目录分析' }, webContents, signature);
    const results = [];
    let tenderSentences = [];
    if (Array.isArray(tenderFiles) && tenderFiles.length) {
      try {
        const tenderMarkdown = await readCombinedTenderMarkdown(contentFiles, tenderFiles);
        tenderSentences = splitTenderSentences(tenderMarkdown);
      } catch (error) {
        updateOutlineAnalysis({ message: `招标文件句子白名单生成失败，继续对比投标文件目录：${error.message || error}` }, webContents, signature);
        developerLogger?.write('duplicate.outline_analysis.tender_whitelist.error', {
          error: compactLogError(error),
        });
      }
    }
    developerLogger?.write('duplicate.outline_analysis.tender_whitelist.completed', {
      tender_sentence_count: tenderSentences.length,
    });

    updateOutlineAnalysis({ tenderSentenceCount: tenderSentences.length, message: '正在提取投标文件目录' }, webContents, signature);
    for (const file of bidFiles) {
      const fileId = stableFileId(file);
      try {
        const markdown = await readContentMarkdown(contentFiles, file);
        const extracted = buildOutlineItems(markdown, tenderSentences);
        const tenderMatchedCount = extracted.items.filter((item) => item.from_tender).length;
        results.push({
          file_id: fileId,
          file_name: file.file_name,
          status: 'success',
          source: extracted.source,
          confidence: extracted.confidence,
          item_count: extracted.items.length,
          tender_matched_count: tenderMatchedCount,
          items: extracted.items,
        });
        developerLogger?.write('duplicate.outline_analysis.file.completed', {
          file: summarizeDuplicateFileForLog(file, 'bid'),
          source: extracted.source,
          confidence: extracted.confidence,
          item_count: extracted.items.length,
          tender_matched_count: tenderMatchedCount,
        });
      } catch (error) {
        results.push({ file_id: fileId, file_name: file.file_name, status: 'error', item_count: 0, tender_matched_count: 0, items: [], error: error.message || '目录提取失败' });
        developerLogger?.write('duplicate.outline_analysis.file.error', {
          file: summarizeDuplicateFileForLog(file, 'bid'),
          error: compactLogError(error),
        });
      }
      updateOutlineAnalysis({
        status: 'running',
        progress: bidFiles.length ? Math.round((results.length / bidFiles.length) * 80) : 80,
        extraction: { status: 'running', completed: results.length, total: bidFiles.length },
        files: results,
        tenderSentenceCount: tenderSentences.length,
        tenderMatchedItemCount: results.reduce((sum, item) => sum + (item.tender_matched_count || 0), 0),
        message: `目录提取 ${results.length}/${bidFiles.length}`,
      }, webContents, signature);
    }

    const comparison = buildOutlineComparison(results);
    const failed = results.some((item) => item.status === 'error');
    updateOutlineAnalysis({
      status: failed ? 'error' : 'success',
      progress: 100,
      message: failed ? '部分文件目录分析失败' : '目录分析完成',
      signature,
      extraction: { status: failed ? 'error' : 'success', completed: results.length, total: bidFiles.length },
      files: results,
      tenderSentenceCount: tenderSentences.length,
      tenderMatchedItemCount: results.reduce((sum, item) => sum + (item.tender_matched_count || 0), 0),
      duplicateGroups: comparison.duplicateGroups,
      pairwiseSimilarities: comparison.pairwiseSimilarities,
    }, webContents, signature);
    developerLogger?.write('duplicate.outline_analysis.completed', {
      signature,
      status: failed ? 'error' : 'success',
      result: summarizeResultStatus(results),
      tender_sentence_count: tenderSentences.length,
      tender_matched_item_count: results.reduce((sum, item) => sum + (item.tender_matched_count || 0), 0),
      duplicate_group_count: comparison.duplicateGroups.length,
      pairwise_similarity_count: comparison.pairwiseSimilarities.length,
    });
    return results;
  }

  async function runContentDuplicateAnalysis(tenderFiles, bidFiles, contentFiles, signature, webContents, developerLogger) {
    const contentStartedAt = Date.now();
    developerLogger?.write('duplicate.content_analysis.started', {
      signature,
      bid_file_count: bidFiles.length,
      tender_files: (Array.isArray(tenderFiles) ? tenderFiles : []).map((file) => summarizeDuplicateFileForLog(file, 'tender')),
    });
    updateContentAnalysis({ status: 'running', progress: 5, extraction: { status: 'running', completed: 0, total: bidFiles.length }, message: '正在准备正文比对' }, webContents, signature);
    let tenderMatcher = buildTenderSourceMatcher([]);
    const tenderMatchReasonCounts = {};
    if (Array.isArray(tenderFiles) && tenderFiles.length) {
      try {
        const tenderMarkdown = await readCombinedTenderMarkdown(contentFiles, tenderFiles);
        tenderMatcher = buildTenderSourceMatcher(splitContentSentences(tenderMarkdown));
      } catch (error) {
        updateContentAnalysis({ message: `招标文件句子白名单生成失败，继续比对投标正文：${error.message || error}` }, webContents, signature);
        developerLogger?.write('duplicate.content_analysis.tender_whitelist.error', {
          error: compactLogError(error),
        });
      }
    }
    developerLogger?.write('duplicate.content_analysis.tender_whitelist.completed', {
      tender_sentence_count: tenderMatcher.tenderSentenceCount,
    });

    const globalSentences = new Map();
    let totalSentenceCount = 0;
    let tenderMatchedSentenceCount = 0;
    let firstOrder = 0;

    for (let fileIndex = 0; fileIndex < bidFiles.length; fileIndex += 1) {
      const file = bidFiles[fileIndex];
      const fileId = stableFileId(file);
      const fileStartedAt = Date.now();
      try {
        const markdown = await readContentMarkdown(contentFiles, file);
        const sentences = splitContentSentences(markdown);
        totalSentenceCount += sentences.length;
        const local = new Map();
        let fileTenderMatchedCount = 0;
        for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
          const sentence = sentences[sentenceIndex];
          const tenderMatch = tenderMatcher.match(sentence);
          if (tenderMatch) {
            tenderMatchedSentenceCount += 1;
            fileTenderMatchedCount += 1;
            const reason = tenderMatch.reason || 'unknown';
            tenderMatchReasonCounts[reason] = (tenderMatchReasonCounts[reason] || 0) + 1;
          } else {
            const current = local.get(sentence.normalized) || { sentence: sentence.sentence, count: 0, order: firstOrder++ };
            current.count += 1;
            local.set(sentence.normalized, current);
          }

          const processed = sentenceIndex + 1;
          if (processed % 500 === 0 && processed < sentences.length) {
            updateContentAnalysis({
              status: 'running',
              progress: bidFiles.length ? Math.min(89, Math.round(5 + ((fileIndex + processed / sentences.length) / bidFiles.length) * 80)) : 85,
              tenderSentenceCount: tenderMatcher.tenderSentenceCount,
              tenderMatchedSentenceCount,
              totalSentenceCount,
              extraction: { status: 'running', completed: fileIndex, total: bidFiles.length },
              message: `正文比对 ${fileIndex + 1}/${bidFiles.length}（${processed}/${sentences.length} 句）`,
            }, webContents, signature);
            // 大批句子分块让出事件循环，避免单份标书长时间阻塞 Electron 主进程。
            await new Promise((resolve) => setImmediate(resolve));
          }
        }

        for (const [normalized, item] of local.entries()) {
          const global = globalSentences.get(normalized) || { sentence: item.sentence, normalized, file_ids: [], occurrences: {}, first_order: item.order };
          if (!global.file_ids.includes(fileId)) global.file_ids.push(fileId);
          global.occurrences[fileId] = item.count;
          globalSentences.set(normalized, global);
        }
        developerLogger?.write('duplicate.content_analysis.file.completed', {
          file: summarizeDuplicateFileForLog(file, 'bid'),
          duration_ms: Date.now() - fileStartedAt,
          sentence_count: sentences.length,
          tender_matched_sentence_count: fileTenderMatchedCount,
          compared_sentence_count: sentences.length - fileTenderMatchedCount,
        });
      } catch (error) {
        updateContentAnalysis({ message: `${file.file_name} 正文比对失败：${error.message || error}` }, webContents, signature);
        developerLogger?.write('duplicate.content_analysis.file.error', {
          file: summarizeDuplicateFileForLog(file, 'bid'),
          duration_ms: Date.now() - fileStartedAt,
          error: compactLogError(error),
        });
      }

      updateContentAnalysis({
        status: 'running',
        progress: bidFiles.length ? Math.round((globalSentences.size ? 10 : 5) + (fileIndex + 1) / bidFiles.length * 80) : 85,
        tenderSentenceCount: tenderMatcher.tenderSentenceCount,
        tenderMatchedSentenceCount,
        totalSentenceCount,
        extraction: { status: 'running', completed: fileIndex + 1, total: bidFiles.length },
        message: `正文比对 ${fileIndex + 1}/${bidFiles.length}`,
      }, webContents, signature);
    }

    const duplicateSentences = buildDuplicateSentences(globalSentences);
    updateContentAnalysis({
      status: 'success',
      progress: 100,
      message: '正文比对完成',
      signature,
      tenderSentenceCount: tenderMatcher.tenderSentenceCount,
      tenderMatchedSentenceCount,
      totalSentenceCount,
      extraction: { status: 'success', completed: bidFiles.length, total: bidFiles.length },
      duplicateSentences,
    }, webContents, signature);
    developerLogger?.write('duplicate.content_analysis.completed', {
      signature,
      status: 'success',
      duration_ms: Date.now() - contentStartedAt,
      tender_sentence_count: tenderMatcher.tenderSentenceCount,
      tender_matched_sentence_count: tenderMatchedSentenceCount,
      tender_match_reason_counts: tenderMatchReasonCounts,
      total_sentence_count: totalSentenceCount,
      duplicate_sentence_count: duplicateSentences.length,
    });
    return { status: 'success', duplicateSentences };
  }

  async function runImageDuplicateAnalysis(bidFiles, contentFiles, signature, webContents, developerLogger) {
    developerLogger?.write('duplicate.image_analysis.started', {
      signature,
      bid_file_count: bidFiles.length,
    });
    updateImageAnalysis({ status: 'running', progress: 5, extraction: { status: 'running', completed: 0, total: bidFiles.length }, message: '正在准备图片比对' }, webContents, signature);
    const results = [];
    const globalImages = new Map();
    let totalImageCount = 0;

    for (const file of bidFiles) {
      const fileId = stableFileId(file);
      try {
        const markdown = await readContentMarkdown(contentFiles, file);
        const imageOccurrences = extractImageOccurrences(markdown);
        totalImageCount += imageOccurrences.length;
        const local = new Map();
        for (const occurrence of imageOccurrences) {
          try {
            const buffer = await readImageTargetBuffer(app, occurrence.target);
            if (!buffer?.length) continue;
            const hash = crypto.createHash('sha256').update(buffer).digest('hex');
            const current = local.get(hash) || { count: 0, preview_url: occurrence.target, locations: [] };
            current.count += 1;
            current.locations.push({
              image_index: occurrence.index,
              directory: occurrence.directory,
              previous_sentence: occurrence.previous_sentence,
            });
            local.set(hash, current);
          } catch {
            // Ignore individual unreadable images; other images in the same file can still be compared.
          }
        }

        for (const [hash, item] of local.entries()) {
          const global = globalImages.get(hash) || { hash, preview_url: item.preview_url, file_ids: [], occurrences: {}, locations: {} };
          if (!global.file_ids.includes(fileId)) global.file_ids.push(fileId);
          global.occurrences[fileId] = item.count;
          global.locations[fileId] = item.locations;
          globalImages.set(hash, global);
        }
        results.push({ file_id: fileId, file_name: file.file_name, status: 'success', image_count: imageOccurrences.length, unique_image_count: local.size });
        developerLogger?.write('duplicate.image_analysis.file.completed', {
          file: summarizeDuplicateFileForLog(file, 'bid'),
          image_count: imageOccurrences.length,
          unique_image_count: local.size,
        });
      } catch (error) {
        results.push({ file_id: fileId, file_name: file.file_name, status: 'error', image_count: 0, unique_image_count: 0, error: error.message || '图片比对失败' });
        developerLogger?.write('duplicate.image_analysis.file.error', {
          file: summarizeDuplicateFileForLog(file, 'bid'),
          error: compactLogError(error),
        });
      }

      updateImageAnalysis({
        status: 'running',
        progress: bidFiles.length ? Math.round((results.length / bidFiles.length) * 85) : 85,
        extraction: { status: 'running', completed: results.length, total: bidFiles.length },
        files: results,
        totalImageCount,
        message: `图片比对 ${results.length}/${bidFiles.length}`,
      }, webContents, signature);
    }

    const duplicateImages = buildDuplicateImages(globalImages);
    const failed = results.some((item) => item.status === 'error');
    updateImageAnalysis({
      status: failed ? 'error' : 'success',
      progress: 100,
      message: failed ? '部分文件图片比对失败' : '图片比对完成',
      signature,
      extraction: { status: failed ? 'error' : 'success', completed: results.length, total: bidFiles.length },
      files: results,
      totalImageCount,
      duplicateImages,
    }, webContents, signature);
    developerLogger?.write('duplicate.image_analysis.completed', {
      signature,
      status: failed ? 'error' : 'success',
      result: summarizeResultStatus(results),
      total_image_count: totalImageCount,
      duplicate_image_count: duplicateImages.length,
    });
    return { status: failed ? 'error' : 'success', duplicateImages };
  }

  async function run(signature, payload, target, developerLogger) {
    const tenderFiles = getTenderFilesFromPayload(payload);
    const tenderFile = tenderFiles[0] || null;
    const bidFiles = Array.isArray(payload.bidFiles) ? payload.bidFiles : [];
    const allFiles = [...tenderFiles, ...bidFiles].filter(Boolean);
    developerLogger?.write('duplicate.pipeline.started', {
      signature,
      tender_files: tenderFiles.map((file) => summarizeDuplicateFileForLog(file, 'tender')),
      bid_file_count: bidFiles.length,
      file_count: allFiles.length,
    });

    try {
      const contentPromise = runContentExtraction(allFiles, target, signature, developerLogger, tenderFiles);
      const metadataFiles = await runMetadataExtraction(bidFiles, target, signature, developerLogger);
      updateOutlineAnalysis({ status: 'running', progress: 1, message: '元数据提取完成，等待正文内容用于目录分析', extraction: { status: 'running', completed: 0, total: bidFiles.length } }, target, signature);
      updateContentAnalysis({ status: 'running', progress: 1, message: '元数据提取完成，等待正文内容用于正文比对', extraction: { status: 'running', completed: 0, total: bidFiles.length } }, target, signature);
      updateImageAnalysis({ status: 'running', progress: 1, message: '元数据提取完成，等待正文内容用于图片比对', extraction: { status: 'running', completed: 0, total: bidFiles.length } }, target, signature);
      const contentFiles = await contentPromise;
      const metadataFailed = contentFiles.some((item) => item.status === 'error') || metadataFiles.some((item) => item.status === 'error');
      updateAnalysis({
        status: metadataFailed ? 'error' : 'success',
        progress: 100,
        message: metadataFailed ? '部分文件提取失败' : '元数据分析完成',
      }, target, signature);
      const [outlineFiles, contentResult, imageResult] = await Promise.all([
        runOutlineAnalysis(tenderFiles, bidFiles, contentFiles, signature, target, developerLogger),
        runContentDuplicateAnalysis(tenderFiles, bidFiles, contentFiles, signature, target, developerLogger),
        runImageDuplicateAnalysis(bidFiles, contentFiles, signature, target, developerLogger),
      ]);
      const failed = metadataFailed
        || outlineFiles.some((item) => item.status === 'error')
        || contentResult.status === 'error'
        || imageResult.status === 'error';
      developerLogger?.write('duplicate.pipeline.completed', {
        signature,
        status: failed ? 'error' : 'success',
        content_extraction: summarizeResultStatus(contentFiles),
        metadata_extraction: summarizeResultStatus(metadataFiles),
        outline_analysis: summarizeResultStatus(outlineFiles),
        content_duplicate_status: contentResult.status,
        image_duplicate_status: imageResult.status,
      });
      return failed ? 'error' : 'success';
    } catch (error) {
      updateAnalysis({ status: 'error', progress: 100, message: error.message || '元数据分析失败' }, target, signature);
      developerLogger?.write('duplicate.pipeline.error', {
        signature,
        error: compactLogError(error),
      });
      return 'error';
    }
  }

  return {
    run,
    isCurrentDuplicateCheckSignature,
    latestAnalysisMessage,
    overallProgress,
  };
}

module.exports = { createAnalysisPipeline };
