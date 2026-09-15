// 招标解析 TOC 定向：从 Markdown 抽章节，按任务关键词只喂相关章节。
//
// 判据：TOC 弱、摘录过短、或覆盖过低时**整份回落**，保证产出不低于「全文灌入」基线。

const MIN_TOC_CHAPTERS = 5;
const MIN_EXCERPT_CHARS = 3500;
const MIN_COVER_RATIO = 0.08;
const MAX_CHAPTERS_PER_TASK = 12;
const MAX_EXCERPT_CHARS = 120000;
const PREAMBLE_CHARS = 1800;
const BODY_KEYWORD_SAMPLE_CHARS = 4000;

const ATX_HEADING = /^(#{1,6})\s+(.+)$/;
const NUMBERED_HEADING = /^(?:第[一二三四五六七八九十百千\d]+[章节篇部分](?:[、.．:\s]|$)|[一二三四五六七八九十]+[、.．]\s*\S|\d+(?:\.\d+){0,2}[.、．]\s+\S)/;

const TASK_TOC_KEYWORDS = {
  projectOverview: ['项目概述', '项目简介', '项目背景', '工程概况', '采购项目', '项目名称', '总则', '概述', '项目概况'],
  techRequirements: ['技术评分', '评标办法', '评分标准', '技术要求', '技术规格', '技术参数', '评审因素', '评审内容', '技术部分', '技术方案评分', '详细评审'],
  projectInfo: ['项目概况', '招标公告', '项目名称', '项目编号', '招标编号', '采购项目'],
  partAInfo: ['招标人', '采购人', '联系方式', '联系方式及'],
  deliveryAndServiceRequirements: ['交货', '工期', '实施周期', '服务要求', '验收', '质保', '售后', '培训', '交付', '服务期限', '实施要求'],
  procurementList: ['采购清单', '采购需求', '技术参数', '规格', '货物需求', '服务内容', '工程量', '采购内容', '需求一览'],
  responseFileRequirements: ['投标文件', '响应文件', '文件编制', '投标文件编制', '格式', '签章', '密封', '递交', '响应文件格式'],
  agentInfo: ['代理机构', '采购代理', '招标代理'],
  keyInfo: ['招标公告', '投标截止', '开标时间', '获取招标文件', '投标须知前附表'],
  marginInfo: ['保证金', '投标保证金', '履约保证金'],
  qualificationReview: ['资格性审查', '投标人资格', '资格条件', '资格审查', '资格要求'],
  complianceCheck: ['符合性', '响应性审查', '无效投标', '废标', '否决投标'],
  openBid: ['开标', '开标仪式', '开标地点', '开标程序'],
  evaluationBid: ['评标', '评标办法', '评标委员会', '评标程序'],
  businessScoring: ['商务评分', '商务部分', '价格分', '报价评分', '商务评审'],
  discardedBids: ['无效投标', '废标', '否决投标', '废标条款', '否决', '无效标'],
  signingProcess: ['合同授予', '中标', '合同签订', '履约', '合同主要条款'],
  terminationCondition: ['合同解除', '违约', '不可抗力', '争议解决', '合同终止'],
};

const BROAD_TASK_IDS = new Set(['projectOverview', 'techRequirements']);

function isHeadingLine(line) {
  const text = String(line || '');
  if (ATX_HEADING.test(text)) return true;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 90) return false;
  return NUMBERED_HEADING.test(trimmed);
}

function headingTitle(line) {
  const atx = String(line || '').match(ATX_HEADING);
  if (atx) return { title: atx[2].trim(), level: atx[1].length };
  return { title: String(line || '').trim(), level: 2 };
}

function parseTenderToc(markdown) {
  const text = String(markdown || '');
  if (!text.trim()) return [];
  const lines = text.split('\n');
  const chapters = [];
  let current = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isHeadingLine(line)) continue;
    const { title, level } = headingTitle(line);
    if (!title) continue;
    if (current) {
      current.endLine = index - 1;
      chapters.push(current);
    }
    current = { title, level, startLine: index, endLine: lines.length - 1 };
  }
  if (current) chapters.push(current);
  return chapters.map((chapter) => ({
    ...chapter,
    bodyChars: Math.max(0, chapter.endLine - chapter.startLine)
      ? lines.slice(chapter.startLine + 1, chapter.endLine + 1).join('\n').length
      : 0,
  }));
}

function chapterText(lines, chapter) {
  return lines.slice(chapter.startLine, chapter.endLine + 1).join('\n');
}

function scoreChapter(chapter, lines, keywords) {
  const title = chapter.title || '';
  const body = chapterText(lines, chapter).slice(0, BODY_KEYWORD_SAMPLE_CHARS);
  let score = 0;
  for (const keyword of keywords) {
    if (!keyword) continue;
    if (title.includes(keyword)) score += 4;
    if (body.includes(keyword)) score += 1;
  }
  // 仅在已有关键词命中时，用章节体量做同分排序
  if (score > 0 && chapter.bodyChars > 800) score += 0.5;
  return score;
}

function buildTaskExcerpt(markdown, taskId) {
  const text = String(markdown || '');
  const lines = text.split('\n');
  const chapters = parseTenderToc(text);
  if (chapters.length < MIN_TOC_CHAPTERS) {
    return { content: text, directed: false, reason: 'toc_too_weak', chapterCount: chapters.length, selectedTitles: [] };
  }

  const keywords = TASK_TOC_KEYWORDS[taskId] || [];
  if (!keywords.length) {
    return { content: text, directed: false, reason: 'no_keywords', chapterCount: chapters.length, selectedTitles: [] };
  }

  const scored = chapters
    .map((chapter) => ({ chapter, score: scoreChapter(chapter, lines, keywords) }))
    .sort((a, b) => b.score - a.score || a.chapter.startLine - b.chapter.startLine);

  const strong = scored.filter((item) => item.score >= 2);
  if (!strong.length && !scored.some((item) => item.score >= 1)) {
    return { content: text, directed: false, reason: 'no_hit', chapterCount: chapters.length, selectedTitles: [] };
  }

  const selected = [];
  const selectedIds = new Set();
  let used = 0;
  const tryAdd = (item) => {
    if (!item || selectedIds.has(item.chapter.startLine)) return;
    if (selected.length >= MAX_CHAPTERS_PER_TASK) return;
    const chunk = lines.slice(item.chapter.startLine, item.chapter.endLine + 1).join('\n');
    if (used + chunk.length > MAX_EXCERPT_CHARS && selected.length) return;
    selected.push(item.chapter);
    selectedIds.add(item.chapter.startLine);
    used += chunk.length;
  };

  for (const item of strong) tryAdd(item);
  // 体量不够时补次优命中，避免「路由准但上下文过瘦」
  if (used < MIN_EXCERPT_CHARS) {
    for (const item of scored) {
      if (used >= MIN_EXCERPT_CHARS) break;
      if (item.score >= 1) tryAdd(item);
    }
  }

  const firstChapterStart = chapters[0].startLine;
  const preamble = lines.slice(0, firstChapterStart).join('\n').slice(0, PREAMBLE_CHARS);
  const bodyParts = selected.map((chapter) => chapterText(lines, chapter));
  const content = [preamble, ...bodyParts].filter(Boolean).join('\n\n').trim();
  const coverRatio = text.length ? content.length / text.length : 0;

  if (content.length < MIN_EXCERPT_CHARS) {
    return { content: text, directed: false, reason: 'excerpt_too_small', chapterCount: chapters.length, selectedTitles: selected.map((c) => c.title) };
  }
  if (BROAD_TASK_IDS.has(taskId) && coverRatio < MIN_COVER_RATIO) {
    return { content: text, directed: false, reason: 'cover_too_low', chapterCount: chapters.length, selectedTitles: selected.map((c) => c.title) };
  }

  return {
    content,
    directed: true,
    reason: 'ok',
    chapterCount: chapters.length,
    selectedTitles: selected.map((chapter) => chapter.title),
    selectedChars: content.length,
    fullChars: text.length,
  };
}

module.exports = {
  parseTenderToc,
  buildTaskExcerpt,
  TASK_TOC_KEYWORDS,
  MIN_TOC_CHAPTERS,
  MIN_EXCERPT_CHARS,
};
