// 知识库文档块类型判定：页码页、目录页、封面、签章页、表格块，纯函数，可单独测试。

function isPageNumberBlock(text) {
  const normalized = String(text || '').trim();
  const compact = normalized.replace(/\s+/g, '');
  return /^[-—_]*\d+[-—_]*$/.test(compact)
    || /^第\d+页(共\d+页)?$/.test(compact)
    || /^\d+\/\d+$/.test(compact)
    || /^page\d+(of\d+)?$/i.test(compact);
}

function isCatalogBlock(text) {
  const normalized = String(text || '').trim();
  const compact = normalized.replace(/\s+/g, '');
  if (/^(#+)?(目录|目次|contents)$/i.test(compact)) {
    return true;
  }

  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) {
    return false;
  }

  const catalogLines = lines.filter((line) => /(?:\.{2,}|…{2,}|·{2,}|\s{4,})\s*\d+\s*$/.test(line));
  return catalogLines.length >= Math.ceil(lines.length * 0.6);
}

function isCoverBlock(text, index) {
  if (index > 12) {
    return false;
  }

  const normalized = String(text || '').trim();
  const compact = normalized.replace(/\s+/g, '');
  if (!compact || compact.length > 220) {
    return false;
  }

  const coverMarkers = ['投标文件', '投标书', '正本', '副本', '项目名称', '招标编号', '投标人', '编制日期', '日期：', '日期:'];
  const hasMarker = coverMarkers.some((marker) => compact.includes(marker));
  const hasLongSentence = /[。！？；]/.test(normalized) && normalized.length > 80;
  return hasMarker && !hasLongSentence;
}

function isSignatureBlock(text) {
  const normalized = String(text || '').trim();
  const compact = normalized.replace(/\s+/g, '');
  if (!compact || compact.length > 260) {
    return false;
  }
  if (/(签字确认|用户签字|双方责任人.{0,12}签字)/.test(compact)) {
    return false;
  }
  return /(盖章|签章|签名|法定代表人|授权代表|委托代理人|被授权人|年月日|投标人代表签字|代表签字)/.test(compact)
    && !/[。！？；].{20,}/.test(normalized);
}

function isTableBlock(block) {
  return /^<table[\s>]/i.test(String(block?.content || '').trim());
}

module.exports = {
  isPageNumberBlock,
  isCatalogBlock,
  isCoverBlock,
  isSignatureBlock,
  isTableBlock,
};
