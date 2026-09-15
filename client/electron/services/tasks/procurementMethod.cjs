// 采购方式识别：从采购/招标/谈判/磋商文件 Markdown 判定采购方式。
//
// 用途：招标解析日志与提示词口径（招标文件 vs 谈判文件 vs 磋商文件）。
// 不阻断流程：识别失败回落 open_tender，并按通用「采购文件」表述。

const METHOD_RULES = [
  {
    id: 'competitive_negotiation',
    label: '竞争性谈判',
    fileLabel: '竞争性谈判文件',
    patterns: [/竞争性谈判/, /谈判文件/, /谈判须知/, /谈判响应文件/, /谈判小组/],
  },
  {
    id: 'competitive_consultation',
    label: '竞争性磋商',
    fileLabel: '竞争性磋商文件',
    patterns: [/竞争性磋商/, /磋商文件/, /磋商须知/, /磋商响应文件/, /磋商小组/],
  },
  {
    id: 'inquiry',
    label: '询价采购',
    fileLabel: '询价文件',
    patterns: [/询价通知书/, /询价采购/, /询价文件/, /询价响应/],
  },
  {
    id: 'single_source',
    label: '单一来源采购',
    fileLabel: '单一来源采购文件',
    patterns: [/单一来源/, /单一来源采购/],
  },
  {
    id: 'open_tender',
    label: '公开招标',
    fileLabel: '招标文件',
    patterns: [/公开招标/, /招标公告/, /招标文件/, /投标人须知/, /投标文件/, /评标办法/],
  },
];

const SAMPLE_CHARS = 12000;

function sampleDocumentHead(markdown) {
  const text = String(markdown || '');
  // 采购方式多出现在文首；长文只扫前段 + 首次出现方式关键词的邻域
  const head = text.slice(0, SAMPLE_CHARS);
  const midHit = /竞争性谈判|竞争性磋商|询价|单一来源|公开招标/.exec(text.slice(SAMPLE_CHARS));
  if (!midHit) return head;
  const start = Math.max(0, SAMPLE_CHARS + midHit.index - 200);
  return `${head}\n${text.slice(start, start + 800)}`;
}

function detectProcurementMethod(markdown) {
  const sample = sampleDocumentHead(markdown);
  if (!sample.trim()) {
    return {
      id: 'open_tender',
      label: '公开招标',
      fileLabel: '招标文件',
      confidence: 'low',
      reason: 'empty_document',
    };
  }

  const scores = METHOD_RULES.map((rule) => {
    let hits = 0;
    for (const pattern of rule.patterns) {
      const matched = sample.match(new RegExp(pattern.source, 'g'));
      if (matched) hits += matched.length;
    }
    return { rule, hits };
  }).filter((item) => item.hits > 0);

  if (!scores.length) {
    return {
      id: 'open_tender',
      label: '公开招标',
      fileLabel: '采购文件',
      confidence: 'low',
      reason: 'no_method_keyword',
    };
  }

  scores.sort((a, b) => b.hits - a.hits);
  const best = scores[0];
  const runnerUp = scores[1];
  const confidence = best.hits >= 3 && (!runnerUp || best.hits >= runnerUp.hits * 2)
    ? 'high'
    : best.hits >= 2
      ? 'medium'
      : 'low';

  return {
    id: best.rule.id,
    label: best.rule.label,
    fileLabel: best.rule.fileLabel,
    confidence,
    reason: 'keyword_hit',
    hits: best.hits,
  };
}

function buildProcurementContextMessage(method) {
  const label = method?.fileLabel || '采购文件';
  if (method?.id === 'open_tender' || !method) {
    return `本文件按${label}处理。文中“招标人/采购人”“投标人/供应商”“投标文件/响应文件”“开标/递交”等同义表述请按同一概念理解。`;
  }
  return `本文件采购方式识别为「${method.label}」，请按${label}口径解析：谈判/磋商/询价场景下的“响应文件”视同“投标文件”，“采购人/采购单位”视同“招标人”，“谈判/磋商/评审”视同“评标”相关环节。不要因为缺少“开标”“评标委员会”等招标专用词而判定信息缺失。`;
}

module.exports = {
  detectProcurementMethod,
  buildProcurementContextMessage,
  METHOD_RULES,
};
