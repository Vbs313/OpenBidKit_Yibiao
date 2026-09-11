// 查重分析支撑：图片重复项提取（含图片上下文与资源解析），以及分析结果/日志的汇总格式化。
//
// 这些原本是 duplicateCheckService.cjs 里的模块级函数；搬出来后 service 只负责调度与落库。
// 只依赖 fs/path 与路径工具，可单独测试。

const fs = require('node:fs/promises');
const path = require('node:path');
const { getGeneratedImagesDir, getImportedImagesDir } = require('../../utils/paths.cjs');
const {
  markdownImagePattern,
  htmlImageSrcPattern,
  cleanMarkdownInlineText,
  cleanMarkdownLine,
} = require('./markdownText.cjs');
const { cleanOutlineTitle, parseOutlineMarker } = require('./outlineText.cjs');
const {
  isCatalogTitleLine,
  cleanContentSentence,
  normalizeContentLineBreaks,
} = require('./tenderText.cjs');
const { now, stableFileId } = require('./fileSignature.cjs');

function buildDuplicateSentences(globalSentences) {
  return Array.from(globalSentences.values())
    .filter((item) => item.file_ids.length > 1)
    .sort((a, b) => b.file_ids.length - a.file_ids.length || b.sentence.length - a.sentence.length || a.first_order - b.first_order)
    .map((item, index) => ({ ...item, id: `S${String(index + 1).padStart(6, '0')}` }));
}

function extractLineImageTargets(line) {
  const targets = [];
  for (const match of String(line || '').matchAll(markdownImagePattern)) {
    const target = String(match.groups?.target || '').trim().replace(/^<|>$/g, '');
    if (target) targets.push({ target, index: match.index || 0 });
  }
  for (const match of String(line || '').matchAll(htmlImageSrcPattern)) {
    const target = String(match.groups?.src || '').trim();
    if (target) targets.push({ target, index: match.index || 0 });
  }
  return targets.sort((a, b) => a.index - b.index);
}

function parseImageContextHeading(line) {
  const hashMatch = String(line || '').match(/^\s{0,3}(#{1,6})\s+(.+)$/);
  if (hashMatch) {
    const title = cleanOutlineTitle(hashMatch[2]);
    return title ? { level: Math.min(hashMatch[1].length, 6), title } : null;
  }

  const text = cleanOutlineTitle(line);
  if (!text || text.length > 90 || /[。！？；;]$/.test(text) || /^\|/.test(text) || isCatalogTitleLine(text)) return null;
  const marker = parseOutlineMarker(text);
  const bold = /^\s*\*\*.+\*\*\s*$/.test(line);
  if (!marker && !bold) return null;
  return { level: marker?.level || 2, title: marker?.title || text };
}

function updateImageContextHeadings(headings, heading) {
  while (headings.length && headings[headings.length - 1].level >= heading.level) headings.pop();
  headings.push(heading);
}

function getPreviousImageSentence(value) {
  const text = cleanMarkdownInlineText(value)
    .replace(/\|/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .trim();
  const parts = text.split(/[。！？!?；;\n]+/).map((item) => cleanContentSentence(item)).filter(Boolean);
  return (parts[parts.length - 1] || '').slice(0, 500);
}

function extractImageOccurrences(markdown) {
  const lines = normalizeContentLineBreaks(String(markdown || '').replace(/```[\s\S]*?```/g, '\n')).split('\n');
  const occurrences = [];
  const headings = [];
  let previousText = '';
  let imageIndex = 0;

  for (const line of lines) {
    const heading = parseImageContextHeading(line);
    if (heading) updateImageContextHeadings(headings, heading);

    const targets = extractLineImageTargets(line);
    for (const item of targets) {
      const beforeImage = line.slice(0, item.index);
      imageIndex += 1;
      occurrences.push({
        target: item.target,
        index: imageIndex,
        directory: headings.map((entry) => entry.title).join(' > '),
        previous_sentence: getPreviousImageSentence(`${previousText}\n${beforeImage}`),
      });
    }

    const cleanedLine = cleanMarkdownLine(line);
    if (cleanedLine) {
      previousText = `${previousText}\n${cleanedLine}`.slice(-4000);
    }
  }

  return occurrences;
}

function isPathInsideDirectory(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveAssetPath(app, value) {
  const url = new URL(value);
  const roots = {
    'generated-images': getGeneratedImagesDir(app),
    'imported-images': getImportedImagesDir(app),
  };
  const rootDir = roots[url.hostname];
  if (!rootDir) return '';
  const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!relativePath) return '';
  const baseDir = path.resolve(rootDir);
  const filePath = path.resolve(baseDir, relativePath);
  return isPathInsideDirectory(baseDir, filePath) && filePath !== baseDir ? filePath : '';
}

async function readImageTargetBuffer(app, target) {
  const value = String(target || '').trim();
  if (!value) return null;
  const dataMatch = value.match(/^data:image\/[^;]+;base64,(?<data>[A-Za-z0-9+/=\s]+)$/i);
  if (dataMatch?.groups?.data) return Buffer.from(dataMatch.groups.data.replace(/\s+/g, ''), 'base64');
  if (/^yibiao-asset:\/\//i.test(value)) {
    const filePath = resolveAssetPath(app, value);
    return filePath ? fs.readFile(filePath) : null;
  }
  if (/^file:\/\//i.test(value)) {
    return fs.readFile(new URL(value));
  }
  return null;
}

function buildDuplicateImages(globalImages) {
  return Array.from(globalImages.values())
    .filter((item) => item.file_ids.length > 1)
    .sort((a, b) => b.file_ids.length - a.file_ids.length || Object.values(b.occurrences).reduce((sum, count) => sum + count, 0) - Object.values(a.occurrences).reduce((sum, count) => sum + count, 0))
    .map((item, index) => ({ ...item, id: `I${String(index + 1).padStart(6, '0')}` }));
}

function createInitialAnalysis(signature, bidFiles) {
  const total = bidFiles.length;
  return {
    status: 'running',
    progress: 0,
    message: '正在启动元数据分析',
    signature,
    started_at: now(),
    updated_at: now(),
    contentExtraction: { status: 'running', completed: 0, total: 0 },
    metadataExtraction: { status: total ? 'running' : 'success', completed: 0, total },
    files: [],
    rows: [],
    contentFiles: [],
    logs: [],
  };
}

function createInitialOutlineAnalysis(signature, bidFiles) {
  return {
    status: 'pending',
    progress: 0,
    message: '等待元数据提取完成后开始目录分析',
    signature,
    started_at: now(),
    updated_at: now(),
    tenderSentenceCount: 0,
    tenderMatchedItemCount: 0,
    extraction: { status: bidFiles.length ? 'pending' : 'success', completed: 0, total: bidFiles.length },
    files: [],
    duplicateGroups: [],
    pairwiseSimilarities: [],
  };
}

function createInitialContentAnalysis(signature, bidFiles) {
  return {
    status: 'pending',
    progress: 0,
    message: '等待正文内容提取完成后开始正文比对',
    signature,
    started_at: now(),
    updated_at: now(),
    tenderSentenceCount: 0,
    tenderMatchedSentenceCount: 0,
    totalSentenceCount: 0,
    extraction: { status: bidFiles.length ? 'pending' : 'success', completed: 0, total: bidFiles.length },
    duplicateSentences: [],
  };
}

function createInitialImageAnalysis(signature, bidFiles) {
  return {
    status: 'pending',
    progress: 0,
    message: '等待正文内容提取完成后开始图片比对',
    signature,
    started_at: now(),
    updated_at: now(),
    extraction: { status: bidFiles.length ? 'pending' : 'success', completed: 0, total: bidFiles.length },
    totalImageCount: 0,
    files: [],
    duplicateImages: [],
  };
}

function summarizeDuplicateFileForLog(file, role) {
  if (!file) return null;
  return {
    role,
    file_id: stableFileId(file),
    file_name: file.file_name || path.basename(file.file_path || ''),
    extension: file.extension || path.extname(file.file_name || file.file_path || '').toLowerCase(),
    size: file.size ?? null,
    modified_at: file.modified_at || '',
  };
}

function summarizeResultStatus(results = []) {
  const total = results.length;
  const errorCount = results.filter((item) => item.status === 'error').length;
  return {
    total,
    success_count: total - errorCount,
    error_count: errorCount,
  };
}

function summarizeContentExtractionResults(results = []) {
  const base = summarizeResultStatus(results);
  const lengths = results.map((item) => Number(item.content_length) || 0);
  return {
    ...base,
    total_content_chars: lengths.reduce((sum, value) => sum + value, 0),
    max_content_chars: Math.max(0, ...lengths),
  };
}

module.exports = {
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
};
