// 各家模型响应解析：从 OpenAI 兼容 / Google / ComfyUI 回包里取出正文、用量与图片，纯函数，可单独测试。

const { normalizeTokenUsage } = require('../stores/textTokenStatsStore.cjs');

function extractOpenAIUsage(responseData) {
  return normalizeTokenUsage(responseData?.usage);
}

function extractGoogleUsage(responseData) {
  return normalizeTokenUsage(responseData?.usageMetadata || responseData?.usage_metadata);
}

function extractJsonContent(content) {
  const normalized = String(content || '').trim();
  if (!normalized.startsWith('```')) {
    return normalized;
  }

  const lines = normalized.split(/\r?\n/);
  const firstLine = (lines[0] || '').trim().toLowerCase();
  const lastLine = (lines[lines.length - 1] || '').trim();
  if ((firstLine === '```' || firstLine === '```json') && lastLine.startsWith('```')) {
    return lines.slice(1, -1).join('\n').trim();
  }

  return normalized;
}

function extractFencedJsonBlocks(content) {
  const blocks = [];
  const normalized = String(content || '').trim();
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match = fenceRegex.exec(normalized);

  while (match) {
    const block = String(match[1] || '').trim();
    if (block) {
      blocks.push(block);
    }
    match = fenceRegex.exec(normalized);
  }

  return blocks;
}

function extractBalancedJsonCandidates(content) {
  const text = String(content || '');
  const candidates = [];

  for (let start = 0; start < text.length; start += 1) {
    const firstChar = text[start];
    if (firstChar !== '{' && firstChar !== '[') {
      continue;
    }

    const stack = [firstChar];
    let inString = false;
    let escaped = false;

    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];

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

      if (char === '{' || char === '[') {
        stack.push(char);
        continue;
      }

      if (char === '}' || char === ']') {
        const expectedOpen = char === '}' ? '{' : '[';
        if (stack[stack.length - 1] !== expectedOpen) {
          break;
        }

        stack.pop();
        if (!stack.length) {
          const candidate = text.slice(start, index + 1).trim();
          if (candidate) {
            candidates.push(candidate);
          }
          start = index;
          break;
        }
      }
    }
  }

  return candidates;
}

function extractGoogleCandidateParts(responseData) {
  const candidates = Array.isArray(responseData?.candidates) ? responseData.candidates : [];
  return candidates.flatMap((candidate) => (
    Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
  ));
}

function extractComfyUIHistoryWorkflow(promptTuple) {
  if (!Array.isArray(promptTuple)) return null;
  for (const item of promptTuple) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const values = Object.values(item);
    if (values.length > 0 && values.some((node) => node && typeof node === 'object' && typeof node.class_type === 'string')) {
      return item;
    }
  }
  return null;
}

function extractComfyUIImages(entry) {
  const images = [];
  for (const output of Object.values(entry?.outputs || {})) {
    if (Array.isArray(output?.images)) {
      images.push(...output.images.filter((image) => image?.filename));
    }
  }
  return images;
}

module.exports = {
  extractOpenAIUsage,
  extractGoogleUsage,
  extractJsonContent,
  extractFencedJsonBlocks,
  extractBalancedJsonCandidates,
  extractGoogleCandidateParts,
  extractComfyUIHistoryWorkflow,
  extractComfyUIImages,
};
