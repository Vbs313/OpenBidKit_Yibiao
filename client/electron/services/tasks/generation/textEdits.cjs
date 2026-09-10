// 正文文本的定位与改写：行号视图、精确命中、行区间替换、一致性补丁与扩写补丁的应用。
// 纯函数，只做字符串变换，不接触任务状态、模型或文件系统，可单独测试。

const crypto = require('node:crypto');

const { normalizeNewlines, normalizeConsistencyPatchText, normalizeParagraphs } = require('./normalize.cjs');
const { singleLine, splitLinesWithRanges } = require('./agentResponse.cjs');
const { normalizeGeneratedMarkdown } = require('./markdownTables.cjs');

function textHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function textMetrics(value) {
  const content = String(value || '');
  return {
    chars: content.length,
    hash: textHash(content),
  };
}

function formatContentWithLineNumbers(content) {
  const lines = normalizeNewlines(content).split('\n');
  const width = Math.max(3, String(lines.length).length);
  return lines
    .map((line, index) => `[${String(index + 1).padStart(width, '0')}] ${line}`)
    .join('\n');
}

function findExactOccurrences(content, search) {
  const indexes = [];
  if (!search) return indexes;
  let startIndex = 0;
  while (startIndex <= content.length) {
    const index = content.indexOf(search, startIndex);
    if (index < 0) break;
    indexes.push(index);
    startIndex = index + search.length;
  }
  return indexes;
}

function extractLineRangeText(content, startLine, endLine) {
  const lines = normalizeNewlines(content).split('\n');
  const start = Math.max(1, Math.round(Number(startLine) || 0));
  const end = Math.max(start, Math.round(Number(endLine) || 0));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end > lines.length) {
    return null;
  }
  return lines.slice(start - 1, end).join('\n');
}

function replaceLineRange(content, startLine, endLine, replacement) {
  const lines = normalizeNewlines(content).split('\n');
  const start = Math.max(1, Math.round(Number(startLine) || 0));
  const end = Math.max(start, Math.round(Number(endLine) || 0));
  const nextLines = [
    ...lines.slice(0, start - 1),
    ...normalizeNewlines(replacement).split('\n'),
    ...lines.slice(end),
  ];
  return nextLines.join('\n');
}

function describeConsistencyPatchMatch(content, patch) {
  const currentContent = normalizeNewlines(content);
  const oldText = normalizeConsistencyPatchText(patch.old_text);
  const newText = normalizeConsistencyPatchText(patch.new_text);
  const startLine = Number(patch.start_line);
  const endLine = Number(patch.end_line);
  const detail = {
    section_id: singleLine(patch.section_id),
    start_line: Number.isFinite(startLine) ? startLine : 0,
    end_line: Number.isFinite(endLine) ? endLine : 0,
    old_text: oldText,
    new_text: newText,
    old_text_metrics: textMetrics(oldText),
    new_text_metrics: textMetrics(newText),
    before_content_metrics: textMetrics(currentContent),
    line_range: null,
    exact_match_count: 0,
  };

  if (Number.isFinite(startLine) && Number.isFinite(endLine) && startLine > 0 && endLine >= startLine) {
    const candidate = extractLineRangeText(currentContent, startLine, endLine);
    detail.line_range = {
      exists: candidate !== null,
      matches_old_text: candidate === oldText,
      candidate_metrics: candidate === null ? null : textMetrics(candidate),
    };
  }

  detail.exact_match_count = findExactOccurrences(currentContent, oldText).length;
  return detail;
}

function applyExactConsistencyPatch(content, patch) {
  const currentContent = normalizeNewlines(content);
  const oldText = normalizeConsistencyPatchText(patch.old_text);
  const newText = normalizeConsistencyPatchText(patch.new_text);
  if (!oldText) {
    throw new Error('old_text 为空');
  }
  if (!newText) {
    throw new Error('new_text 为空');
  }
  if (oldText === newText) {
    throw new Error('old_text 与 new_text 相同');
  }

  const startLine = Number(patch.start_line);
  const endLine = Number(patch.end_line);
  if (Number.isFinite(startLine) && Number.isFinite(endLine) && startLine > 0 && endLine >= startLine) {
    const candidate = extractLineRangeText(currentContent, startLine, endLine);
    if (candidate === oldText) {
      return replaceLineRange(currentContent, startLine, endLine, newText);
    }
  }

  const matches = findExactOccurrences(currentContent, oldText);
  if (!matches.length) {
    throw new Error('old_text 未在当前小节正文中找到');
  }
  if (matches.length > 1) {
    throw new Error('old_text 在当前小节正文中出现多次，请提供更多上下文确保唯一定位');
  }
  const index = matches[0];
  return `${currentContent.slice(0, index)}${newText}${currentContent.slice(index + oldText.length)}`;
}

function applyConsistencyRepairPatches(content, patches) {
  let nextContent = normalizeNewlines(content);
  const errors = [];
  const patchResults = [];
  let appliedCount = 0;

  for (const [index, patch] of (patches || []).entries()) {
    const detail = { index, ...describeConsistencyPatchMatch(nextContent, patch) };
    try {
      nextContent = applyExactConsistencyPatch(nextContent, patch);
      appliedCount += 1;
      patchResults.push({
        ...detail,
        applied: true,
        after_content_metrics: textMetrics(nextContent),
      });
    } catch (error) {
      errors.push(`patch[${index}] ${error.message || '应用失败'}`);
      patchResults.push({
        ...detail,
        applied: false,
        error: error.message || '应用失败',
        after_content_metrics: textMetrics(nextContent),
      });
    }
  }

  return { content: nextContent, appliedCount, errors, patchResults };
}

function findContentExpansionNeedleRanges(content, targetText) {
  const source = normalizeNewlines(content);
  const target = normalizeNewlines(targetText).trim();
  const matches = [];
  if (!target) {
    return matches;
  }

  let index = 0;
  while ((index = source.indexOf(target, index)) >= 0) {
    matches.push({ start: index, end: index + target.length, strategy: 'target_text-exact' });
    index += Math.max(1, target.length);
  }
  return matches;
}

function findContentExpansionTargetTextMatch(content, targetText) {
  const source = normalizeNewlines(content).trim();
  const target = normalizeNewlines(targetText).trim();
  if (!target) {
    return { found: false, unique: false, count: 0, strategy: '', match: null, error: 'replace patch 缺少 target_text' };
  }

  const exactMatches = findContentExpansionNeedleRanges(source, target);
  if (exactMatches.length === 1) {
    return { found: true, unique: true, count: 1, strategy: exactMatches[0].strategy, match: exactMatches[0], error: '' };
  }
  if (exactMatches.length > 1) {
    return { found: true, unique: false, count: exactMatches.length, strategy: 'target_text-exact', match: null, error: `replace target_text 精确命中 ${exactMatches.length} 处，拒绝替换` };
  }

  const sourceLines = splitLinesWithRanges(source);
  const targetLines = target.split('\n').map((line) => line.trim());
  const lineMatches = [];
  if (targetLines.length <= sourceLines.length) {
    for (let startIndex = 0; startIndex <= sourceLines.length - targetLines.length; startIndex += 1) {
      const matched = targetLines.every((line, offset) => sourceLines[startIndex + offset].text.trim() === line);
      if (!matched) {
        continue;
      }
      const firstLine = sourceLines[startIndex];
      const lastLine = sourceLines[startIndex + targetLines.length - 1];
      lineMatches.push({ start: firstLine.start, end: lastLine.end, strategy: 'target_text-line-trimmed' });
    }
  }

  if (lineMatches.length === 1) {
    return { found: true, unique: true, count: 1, strategy: lineMatches[0].strategy, match: lineMatches[0], error: '' };
  }
  if (lineMatches.length > 1) {
    return { found: true, unique: false, count: lineMatches.length, strategy: 'target_text-line-trimmed', match: null, error: `replace target_text 逐行匹配命中 ${lineMatches.length} 处，拒绝替换` };
  }

  return { found: false, unique: false, count: 0, strategy: '', match: null, error: 'replace target_text 未在当前章节正文中唯一命中' };
}

function applyContentExpansionPatch(content, patch) {
  const normalizedContent = normalizeNewlines(String(content || '')).trim();
  const patchContent = normalizeGeneratedMarkdown(patch.content).trim();
  if (!normalizedContent) {
    if (patch.operation === 'replace') {
      throw new Error('当前章节正文为空，replace target_text 无法执行替换');
    }
    return patchContent;
  }

  if (patch.operation === 'replace') {
    const targetMatch = findContentExpansionTargetTextMatch(normalizedContent, patch.target_text);
    if (!targetMatch.unique || !targetMatch.match) {
      throw new Error(targetMatch.error || 'replace target_text 未命中');
    }
    return `${normalizedContent.slice(0, targetMatch.match.start)}${patchContent}${normalizedContent.slice(targetMatch.match.end)}`;
  }

  const paragraphs = normalizeParagraphs(normalizedContent);
  const anchor = String(patch.anchor || '').trim();
  const anchorKey = anchor.replace(/\s+/g, ' ').trim();
  const anchorIndex = anchorKey && !/^end$/i.test(anchorKey)
    ? paragraphs.findIndex((paragraph) => paragraph.replace(/\s+/g, ' ').includes(anchorKey) || anchorKey.includes(paragraph.replace(/\s+/g, ' ')))
    : -1;

  if (/^start$/i.test(anchorKey)) {
    return [patchContent, ...paragraphs].join('\n\n');
  }

  if (anchorIndex >= 0) {
    const next = [...paragraphs];
    next.splice(anchorIndex + 1, 0, patchContent);
    return next.join('\n\n');
  }

  return `${normalizedContent}\n\n${patchContent}`;
}

module.exports = {
  textHash,
  textMetrics,
  formatContentWithLineNumbers,
  findExactOccurrences,
  extractLineRangeText,
  replaceLineRange,
  describeConsistencyPatchMatch,
  applyExactConsistencyPatch,
  applyConsistencyRepairPatches,
  findContentExpansionNeedleRanges,
  findContentExpansionTargetTextMatch,
  applyContentExpansionPatch,
};
