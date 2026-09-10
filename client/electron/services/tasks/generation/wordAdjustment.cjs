// 全文字数调整：校验模型返回的操作，并把它应用到正文。
// 图片、Mermaid、代码块与表格内部一律视为保护区，纯函数，可单独测试。

const { applyRangeEdits, findTextMatches } = require('./../../../utils/textEdit.cjs');
const { collectFencedCodeRanges, extractContentTableBlocks, containsContentTable } = require('./tableExtraction.cjs');
const { rangeOverlaps } = require('./agentResponse.cjs');

function validateWordAdjustmentResponse(value) {
  if (!['expand', 'shrink'].includes(value?.mode)) throw new Error('字数调整 mode 只能是 expand 或 shrink');
  if (!['paragraph', 'sentence'].includes(value?.granularity)) throw new Error('字数调整 granularity 只能是 paragraph 或 sentence');
  if (!Array.isArray(value?.operations) || !value.operations.length) throw new Error('字数调整 operations 不能为空');
  for (const operation of value.operations) {
    const allowed = value.mode === 'expand' ? ['insert', 'replace'] : ['replace', 'delete'];
    if (!allowed.includes(operation.operation)) throw new Error(`当前调整方向不允许 ${operation.operation || '空'} 操作`);
    if (operation.operation === 'insert' && !operation.anchor) throw new Error('字数调整 insert anchor 不能为空');
    if (operation.operation !== 'insert' && !operation.target_text) throw new Error('字数调整 target_text 不能为空');
    if (operation.operation !== 'delete' && !operation.content) throw new Error('字数调整 content 不能为空');
    if (/^\s{0,3}#{1,6}\s/m.test(operation.content)
      || /!\[[^\]]*\]\([^)]*\)/.test(operation.content)
      || /<img\b/i.test(operation.content)
      || /```|~~~|\bmermaid\b/i.test(operation.content)
      || containsContentTable(operation.content)) {
      throw new Error('字数调整 content 不能包含标题、图片、Mermaid、代码块或表格');
    }
  }
}

function collectProtectedContentRanges(content) {
  const ranges = collectFencedCodeRanges(content);
  ranges.push(...extractContentTableBlocks(content).map((table) => ({ start: table.start, end: table.end })));
  const patterns = [/!\[[^\]]*\]\([^)]*\)/g, /<img\b[^>]*>/gi];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content))) ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function applyWordAdjustmentOperations(content, adjustment) {
  const source = String(content || '');
  const protectedRanges = collectProtectedContentRanges(source);
  const usedRanges = new Set();
  const edits = adjustment.operations.map((operation) => {
    if (operation.operation === 'insert') {
      const anchorKey = operation.anchor.trim().toLowerCase();
      let position;
      if (anchorKey === 'start') {
        position = 0;
      } else if (anchorKey === 'end') {
        position = source.length;
      } else {
        const anchorResult = findTextMatches(source, operation.anchor);
        if (!anchorResult.unique || anchorResult.strategy !== 'exact') {
          throw new Error('字数调整 insert anchor 未在当前正文中精确唯一命中');
        }
        const anchorMatch = anchorResult.matches[0];
        if (rangeOverlaps(anchorMatch.start, anchorMatch.end, protectedRanges)) {
          throw new Error('字数调整不能在图片、Mermaid、代码块或表格内部插入内容');
        }
        position = anchorMatch.end;
      }
      const rangeKey = `${position}:${position}`;
      if (usedRanges.has(rangeKey)) throw new Error('字数调整 insert anchor 重复');
      usedRanges.add(rangeKey);
      const newText = position === 0 ? `${operation.content}\n\n` : `\n\n${operation.content}`;
      return { start: position, end: position, newText };
    }

    const matchResult = findTextMatches(source, operation.target_text);
    if (!matchResult.unique || matchResult.strategy !== 'exact') {
      throw new Error('字数调整 target_text 未在当前正文中精确唯一命中');
    }
    const match = matchResult.matches[0];
    if (rangeOverlaps(match.start, match.end, protectedRanges)) {
      throw new Error('字数调整不能修改图片、Mermaid、代码块或表格');
    }
    const rangeKey = `${match.start}:${match.end}`;
    if (usedRanges.has(rangeKey)) throw new Error('字数调整 target_text 范围重复');
    usedRanges.add(rangeKey);
    return {
      start: match.start,
      end: match.end,
      newText: operation.operation === 'delete' ? '' : operation.content,
    };
  });
  const result = applyRangeEdits(source, edits);
  if (!result.changed || result.errors.length) {
    throw new Error(result.errors[0] || '字数调整没有产生有效修改');
  }
  return result.content;
}

module.exports = {
  validateWordAdjustmentResponse,
  applyWordAdjustmentOperations,
};
