// 知识库块流水线：Markdown → 原始块 → 语义合并 → 过滤 → 分段打包 → 恢复结果归一 → 最终条目。
//
// 这些原本是 knowledgeBaseService.cjs 里的模块级纯函数（只做文本与结构变换）。
// 搬出来后 service 只负责读写文件、调模型与编排；本模块不接触文件系统、模型或任务状态，可单独测试。

const { splitUserTextByContextLimit } = require('../../utils/userTextSplitter.cjs');
const {
  isPageNumberBlock,
  isCatalogBlock,
  isCoverBlock,
  isSignatureBlock,
  isTableBlock,
} = require('./blockTypes.cjs');

const oversizedBlockChars = 8000;
const semanticMergeTargetChars = 500;

function splitOversizedText(text, limit) {
  return splitUserTextByContextLimit(String(text || ''), {}, {
    contextLengthLimit: limit,
    limitRatio: 1,
    maxSegmentLimitRatio: 1,
  }).map((part) => part.trim()).filter(Boolean);
}

function normalizeRepeatedText(text) {
  return String(text || '')
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, '')
    .replace(/[\-—_·.。:：|第页共]/g, '')
    .trim()
    .toLowerCase();
}

function getContentCharCount(text) {
  return String(text || '').replace(/\s+/g, '').length;
}

function stripBoldMarker(text) {
  return String(text || '').trim().replace(/^\*\*(.+)\*\*$/, '$1').trim();
}

function isSemanticHeadingBlock(block) {
  const original = String(block?.content || '').trim();
  const normalized = stripBoldMarker(original);
  const compactLength = getContentCharCount(normalized);
  if (!normalized || compactLength > 100) {
    return false;
  }
  if (/[。！？；;]$/.test(normalized)) {
    return false;
  }

  return /^\*\*.+\*\*$/.test(original)
    || /^\d+(?:\.\d+)+\s*[^。！？；;]{1,80}$/.test(normalized)
    || /^\d+\.\s*[^。！？；;]{1,80}$/.test(normalized)
    || /^[一二三四五六七八九十]+[、.．]\s*[^。！？；;]{1,80}$/.test(normalized)
    || /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳][、.．]?\s*[^。！？；;]{1,80}$/.test(normalized)
    || /^（[一二三四五六七八九十]+）\s*[^。！？；;]{1,80}$/.test(normalized)
    || /^第[一二三四五六七八九十\d]+[章节部分篇]\s*[^。！？；;]{0,80}$/.test(normalized);
}

function mergeSemanticBlocks(rawBlocks) {
  const merged = [];
  let buffer = [];

  function bufferText() {
    return buffer.map((block) => block.content).join('\n\n');
  }

  function bufferHasOnlyHeadings() {
    return buffer.length > 0 && buffer.every(isSemanticHeadingBlock);
  }

  function flushBuffer() {
    if (!buffer.length) {
      return;
    }

    merged.push({
      ...buffer[0],
      id: `R${String(merged.length + 1).padStart(6, '0')}`,
      type: buffer.some((block) => block.type === 'list') ? 'list' : 'paragraph',
      content: bufferText().trim(),
    });
    buffer = [];
  }

  function pushStandalone(block) {
    merged.push({
      ...block,
      id: `R${String(merged.length + 1).padStart(6, '0')}`,
    });
  }

  for (const block of rawBlocks) {
    if (isTableBlock(block)) {
      flushBuffer();
      pushStandalone(block);
      continue;
    }

    if (isSemanticHeadingBlock(block)) {
      if (buffer.length && !bufferHasOnlyHeadings() && getContentCharCount(bufferText()) >= 100) {
        flushBuffer();
      }
      buffer.push(block);
      continue;
    }

    const blockChars = getContentCharCount(block.content);
    if (!buffer.length && blockChars >= semanticMergeTargetChars) {
      pushStandalone(block);
      continue;
    }

    buffer.push(block);
    if (getContentCharCount(bufferText()) >= semanticMergeTargetChars) {
      flushBuffer();
    }
  }

  flushBuffer();
  return merged;
}

function createRawBlocks(markdown) {
  const blocks = [];
  const lines = String(markdown || '').split(/\r?\n/);
  let buffer = [];
  let currentType = 'paragraph';
  const headings = [];

  function pushBuffer() {
    const content = buffer.join('\n').trim();
    if (!content) {
      buffer = [];
      return;
    }

    const chunks = content.length > oversizedBlockChars ? splitOversizedText(content, Math.floor(oversizedBlockChars * 0.75)) : [content];
    for (const chunk of chunks) {
      blocks.push({
        id: `R${String(blocks.length + 1).padStart(6, '0')}`,
        type: currentType,
        heading_path: headings.filter(Boolean),
        content: chunk,
      });
    }
    buffer = [];
  }

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      pushBuffer();
      const level = headingMatch[1].length;
      headings.splice(level - 1);
      headings[level - 1] = headingMatch[2].trim();
      currentType = 'heading';
      buffer = [line];
      pushBuffer();
      currentType = 'paragraph';
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      pushBuffer();
      currentType = 'paragraph';
      continue;
    }

    const nextType = /^\s*\|.*\|\s*$/.test(line)
      ? 'table'
      : /^\s*(?:[-*+]\s+|\d+[.)、]\s+)/.test(line)
        ? 'list'
        : 'paragraph';
    if (buffer.length && currentType !== nextType && (currentType !== 'paragraph' || nextType !== 'paragraph')) {
      pushBuffer();
    }
    currentType = nextType;
    buffer.push(line);
  }

  pushBuffer();
  return blocks;
}

function filterBlocks(rawBlocks) {
  const repeatedCounts = new Map();
  rawBlocks.forEach((block) => {
    const key = normalizeRepeatedText(block.content);
    if (key && key.length <= 80) {
      repeatedCounts.set(key, (repeatedCounts.get(key) || 0) + 1);
    }
  });

  const kept = [];
  const filtered = [];

  rawBlocks.forEach((block, index) => {
    const repeatedKey = normalizeRepeatedText(block.content);
    const repeated = repeatedKey && repeatedKey.length <= 80 && repeatedCounts.get(repeatedKey) >= 3;
    const reason = !String(block.content || '').trim()
      ? 'empty'
      : isPageNumberBlock(block.content)
        ? 'page_number'
        : getContentCharCount(block.content) < 100
          ? 'too_short'
          : isCatalogBlock(block.content)
            ? 'catalog'
            : repeated
              ? 'repeated_header_footer'
              : isCoverBlock(block.content, index)
                ? 'cover'
                : isSignatureBlock(block.content)
                  ? 'signature_page'
                  : '';

    if (reason) {
      filtered.push({ ...block, reason });
      return;
    }

    kept.push({
      ...block,
      id: `P${String(kept.length + 1).padStart(6, '0')}`,
    });
  });

  return { blocks: kept, filtered_blocks: filtered };
}

function renderBlocksForPrompt(blocks) {
  return blocks.map((block) => {
    const headingPath = block.heading_path?.length ? block.heading_path.join(' > ') : '无';
    return [
      `[${block.id}]`,
      `type: ${block.type}`,
      `heading_path: ${headingPath}`,
      'text:',
      block.content,
    ].join('\n');
  }).join('\n\n');
}

function packBlocksIntoSegments(blocks, segmentLimit) {
  const limit = Math.max(1, Math.floor(Number(segmentLimit) || 1));
  const source = Array.isArray(blocks) ? blocks : [];
  if (!source.length) return [];

  const segments = [];
  let currentBlocks = [];
  let currentChars = 0;

  const flush = () => {
    if (!currentBlocks.length) return;
    const text = renderBlocksForPrompt(currentBlocks);
    segments.push({
      blocks: currentBlocks,
      blockIds: currentBlocks.map((block) => block.id),
      text,
      chars: text.length,
    });
    currentBlocks = [];
    currentChars = 0;
  };

  for (const block of source) {
    const blockText = renderBlocksForPrompt([block]);
    const blockChars = blockText.length;
    const nextChars = currentChars + (currentBlocks.length ? 2 : 0) + blockChars;
    if (currentBlocks.length && nextChars > limit) {
      flush();
    }
    currentBlocks.push(block);
    currentChars += (currentBlocks.length > 1 ? 2 : 0) + blockChars;
  }
  flush();

  return segments.map((segment, index) => ({
    ...segment,
    index: index + 1,
    total: segments.length,
  }));
}

function packItemsIntoSegments(items, segmentLimit) {
  const limit = Math.max(1, Math.floor(Number(segmentLimit) || 1));
  const source = Array.isArray(items) ? items : [];
  if (!source.length) return [];

  const segments = [];
  let currentItems = [];
  let currentChars = 0;

  const renderItems = (list) => JSON.stringify(
    list.map(({ id, title, summary }) => ({ id, title, summary })),
    null,
    2,
  );

  const flush = () => {
    if (!currentItems.length) return;
    const text = renderItems(currentItems);
    segments.push({
      items: currentItems,
      itemIds: currentItems.map((item) => item.id),
      text,
      chars: text.length,
    });
    currentItems = [];
    currentChars = 0;
  };

  for (const item of source) {
    const itemText = renderItems([item]);
    const itemChars = itemText.length;
    const nextChars = currentChars + (currentItems.length ? 2 : 0) + itemChars;
    if (currentItems.length && nextChars > limit) {
      flush();
    }
    currentItems.push(item);
    currentChars += (currentItems.length > 1 ? 2 : 0) + itemChars;
  }
  flush();

  return segments.map((segment, index) => ({
    ...segment,
    index: index + 1,
    total: segments.length,
  }));
}

function mergeRecoverySegmentResults(parsedList, itemIds, blocks, blockOrder) {
  const ownership = new Map();
  const matchRangesByItem = new Map();
  const newItems = [];
  const discarded = [];
  const sourceList = parsedList || [];

  const claimBlock = (blockId, kind, payload) => {
    if (!blockId || ownership.has(blockId)) return false;
    ownership.set(blockId, { kind, payload });
    return true;
  };

  // 必须全局按优先级认领，避免子批顺序导致 discarded 抢先占住 matches
  for (const parsed of sourceList) {
    for (const match of parsed.matches || []) {
      const claimedIds = [];
      for (const blockId of match.block_ids || []) {
        if (claimBlock(blockId, 'match', match.id)) claimedIds.push(blockId);
      }
      if (!claimedIds.length) continue;
      const current = matchRangesByItem.get(match.id) || { ranges: [], block_ids: [] };
      current.ranges.push(...(match.ranges || []));
      current.block_ids.push(...claimedIds);
      matchRangesByItem.set(match.id, current);
    }
  }

  for (const parsed of sourceList) {
    for (const item of parsed.new_items || []) {
      const claimedIds = [];
      for (const blockId of item.block_ids || []) {
        if (claimBlock(blockId, 'new_item', item)) claimedIds.push(blockId);
      }
      if (!claimedIds.length) continue;
      newItems.push({
        title: item.title,
        summary: item.summary,
        ranges: item.ranges || [],
        block_ids: claimedIds,
      });
    }
  }

  for (const parsed of sourceList) {
    for (const item of parsed.discarded || []) {
      const claimedIds = [];
      for (const blockId of item.block_ids || []) {
        if (claimBlock(blockId, 'discarded', item)) claimedIds.push(blockId);
      }
      if (!claimedIds.length) continue;
      discarded.push({
        ranges: item.ranges || [],
        block_ids: claimedIds,
        reason: item.reason || 'AI 建议舍弃',
      });
    }
  }

  // 以认领后的 block_ids 为权威，再压成 ranges，避免脏 ranges 再展开串段
  const matches = [...matchRangesByItem.entries()]
    .map(([id, value]) => {
      if (!itemIds.has(id)) return null;
      const blockIds = [...new Set(value.block_ids)].filter(
        (blockId) => ownership.get(blockId)?.kind === 'match' && ownership.get(blockId)?.payload === id,
      );
      const ranges = compressBlockIdsToRanges(blockIds, blockOrder);
      return ranges.length && blockIds.length ? { id, ranges, block_ids: blockIds } : null;
    })
    .filter(Boolean);

  return {
    matches,
    new_items: newItems.map((item) => {
      const blockIds = [...new Set(item.block_ids)];
      const ranges = compressBlockIdsToRanges(blockIds, blockOrder);
      return {
        title: item.title,
        summary: item.summary,
        ranges,
        block_ids: blockIds,
      };
    }).filter((item) => item.ranges.length && item.block_ids.length),
    discarded: discarded.map((item) => {
      const blockIds = [...new Set(item.block_ids)];
      const ranges = compressBlockIdsToRanges(blockIds, blockOrder);
      return {
        ranges,
        block_ids: blockIds,
        reason: item.reason,
      };
    }).filter((item) => item.ranges.length && item.block_ids.length),
  };
}

function normalizeRanges(ranges, blockOrder) {
  if (!Array.isArray(ranges)) return [];
  const normalized = [];
  for (const range of ranges) {
    const pair = normalizeRangePair(range);
    if (!pair) continue;
    let [start, end] = pair;
    if (!blockOrder.has(start) || !blockOrder.has(end)) continue;
    if (blockOrder.get(start) > blockOrder.get(end)) {
      [start, end] = [end, start];
    }
    normalized.push([start, end]);
  }
  return normalized;
}

function expandRanges(ranges, blocks, blockOrder) {
  const ids = [];
  for (const [start, end] of ranges) {
    const startIndex = blockOrder.get(start);
    const endIndex = blockOrder.get(end);
    if (startIndex === undefined || endIndex === undefined) continue;
    for (let index = startIndex; index <= endIndex; index += 1) {
      ids.push(blocks[index].id);
    }
  }
  return [...new Set(ids)];
}

/** 将已排序的 block id 列表压缩为闭区间 ranges */
function compressBlockIdsToRanges(blockIds, blockOrder) {
  const ordered = [...new Set(blockIds || [])]
    .filter((id) => blockOrder.has(id))
    .sort((a, b) => blockOrder.get(a) - blockOrder.get(b));
  if (!ordered.length) return [];

  const ranges = [];
  let start = ordered[0];
  let prev = ordered[0];
  for (let i = 1; i < ordered.length; i += 1) {
    const id = ordered[i];
    if (blockOrder.get(id) === blockOrder.get(prev) + 1) {
      prev = id;
      continue;
    }
    ranges.push([start, prev]);
    start = id;
    prev = id;
  }
  ranges.push([start, prev]);
  return ranges;
}

function normalizeRecoveryResult(parsed, itemIds, blocks, blockOrder) {
  const matches = Array.isArray(parsed?.matches) ? parsed.matches : [];
  const newItems = Array.isArray(parsed?.new_items) ? parsed.new_items : [];
  const discarded = Array.isArray(parsed?.discarded) ? parsed.discarded : [];

  return {
    matches: matches.map((match) => {
      const id = String(match?.id || '').trim();
      const ranges = normalizeRanges(match?.ranges || [], blockOrder);
      return itemIds.has(id) && ranges.length ? { id, ranges, block_ids: expandRanges(ranges, blocks, blockOrder) } : null;
    }).filter(Boolean),
    new_items: newItems.map((item) => {
      const title = String(item?.title || '').trim();
      const summary = String(item?.summary || item?.resume || '').trim();
      const ranges = normalizeRanges(item?.ranges || [], blockOrder);
      return title && summary && ranges.length ? { title, summary, ranges, block_ids: expandRanges(ranges, blocks, blockOrder) } : null;
    }).filter(Boolean),
    discarded: discarded.map((item) => {
      const ranges = normalizeRanges(item?.ranges || [], blockOrder);
      return ranges.length ? {
        ranges,
        block_ids: expandRanges(ranges, blocks, blockOrder),
        reason: String(item?.reason || 'AI 建议舍弃').trim() || 'AI 建议舍弃',
      } : null;
    }).filter(Boolean),
  };
}

function createFinalItems(items, matches, blocks, fileName) {
  const blockMap = new Map(blocks.map((block) => [block.id, block]));
  const blocksByItem = new Map();
  matches.forEach((match) => {
    const current = blocksByItem.get(match.id) || [];
    blocksByItem.set(match.id, [...new Set([...current, ...match.block_ids])]);
  });

  return items.map((item) => {
    const sourceBlockIds = blocksByItem.get(item.id) || [];
    const content = sourceBlockIds.map((id) => blockMap.get(id)?.content || '').filter(Boolean).join('\n\n').trim();
    return {
      id: item.id,
      title: item.title,
      resume: item.summary,
      content,
      source_block_ids: sourceBlockIds,
      source_file: fileName,
    };
  }).filter((item) => item.content);
}

function normalizeRangePair(range) {
  if (Array.isArray(range)) {
    const start = String(range[0] || '').trim();
    const end = String(range[1] || range[0] || '').trim();
    return start ? [start, end] : null;
  }

  const id = String(range || '').trim();
  return id ? [id, id] : null;
}

module.exports = {
  splitOversizedText,
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
};
