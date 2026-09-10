// 模型输出的解析、规整与校验：从 contentGenerationTask 摘出的纯函数，
// 只做字符串/JSON 变换，不接触任务状态、模型或文件系统。

function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function splitLinesWithRanges(content) {
  const text = String(content || '');
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '\r' && char !== '\n') {
      continue;
    }
    const lineEnd = index;
    const newlineEnd = char === '\r' && text[index + 1] === '\n' ? index + 2 : index + 1;
    lines.push({ text: text.slice(start, lineEnd), start, end: lineEnd, newlineEnd });
    start = newlineEnd;
    if (newlineEnd > index + 1) {
      index += 1;
    }
  }
  if (start < text.length || !lines.length) {
    lines.push({ text: text.slice(start), start, end: text.length, newlineEnd: text.length });
  }
  return lines;
}

function rangeOverlaps(start, end, ranges) {
  return (ranges || []).some((range) => start < range.end && end > range.start);
}

function compactError(value, maxLength = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalizeOriginalRestoreAssignments(value, context) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const rawAssignments = Array.isArray(source)
    ? source
    : Array.isArray(source.assignments)
      ? source.assignments
      : Array.isArray(source.items)
        ? source.items
        : [];
  const allowedNodeIds = context.allowedNodeIds || new Set();
  const allowedSourceIds = context.allowedSourceIds || new Set();
  const usedSourceIds = new Set();
  const byNode = new Map();

  for (const assignment of rawAssignments) {
    const nodeId = String(assignment?.node_id || assignment?.nodeId || assignment?.id || '').trim();
    if (!allowedNodeIds.has(nodeId)) {
      continue;
    }
    const rawSourceIds = Array.isArray(assignment.source_ids || assignment.sourceIds)
      ? assignment.source_ids || assignment.sourceIds
      : Array.isArray(assignment.sources)
        ? assignment.sources
        : [];
    const sourceIds = rawSourceIds
      .map((sourceId) => String(sourceId || '').trim())
      .filter((sourceId) => allowedSourceIds.has(sourceId) && !usedSourceIds.has(sourceId));
    if (!sourceIds.length) {
      continue;
    }
    for (const sourceId of sourceIds) {
      usedSourceIds.add(sourceId);
    }
    byNode.set(nodeId, [...(byNode.get(nodeId) || []), ...sourceIds]);
  }

  return {
    assignments: Array.from(byNode.entries()).map(([node_id, source_ids]) => ({
      node_id,
      source_ids: [...new Set(source_ids)],
    })),
  };
}

function extractFencedAgentJsonBlocks(content) {
  const blocks = [];
  const pattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = pattern.exec(String(content || '')))) {
    blocks.push(match[1]);
  }
  return blocks;
}

function extractBalancedAgentJsonCandidate(content) {
  const source = String(content || '');
  const start = source.search(/[\[{]/);
  if (start < 0) return '';

  const stack = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      stack.push('}');
      continue;
    }
    if (char === '[') {
      stack.push(']');
      continue;
    }
    if (char === '}' || char === ']') {
      if (stack[stack.length - 1] !== char) return '';
      stack.pop();
      if (!stack.length) return source.slice(start, index + 1);
    }
  }

  return '';
}

function validateConsistencyRepairResponse(value) {
  if (!value || !Array.isArray(value.patches)) {
    throw new Error('一致性修复结果缺少 patches 数组');
  }
  value.patches.forEach((patch, index) => {
    if (!patch.section_id) {
      throw new Error(`patches[${index}].section_id 缺失`);
    }
    if (!patch.old_text) {
      throw new Error(`patches[${index}].old_text 缺失`);
    }
    if (!patch.new_text) {
      throw new Error(`patches[${index}].new_text 缺失`);
    }
    if (patch.old_text === patch.new_text) {
      throw new Error(`patches[${index}].old_text 与 new_text 相同`);
    }
  });
}

module.exports = {
  compactError,
  extractBalancedAgentJsonCandidate,
  extractFencedAgentJsonBlocks,
  normalizeOriginalRestoreAssignments,
  rangeOverlaps,
  singleLine,
  splitLinesWithRanges,
  validateConsistencyRepairResponse,
};
