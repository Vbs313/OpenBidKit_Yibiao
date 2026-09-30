// 小节 Word 预览：按当前正文生成临时 DOCX，供 DocxEditor 只读打开。
// 与 Yibiao 的 agent 工作区 HTML 路径不同：sjjt 正文权威在 SQLite outline/content_sections。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function findOutlineItem(items, id) {
  for (const item of items || []) {
    if (item.id === id) return item;
    const found = findOutlineItem(item.children, id);
    if (found) return found;
  }
  return null;
}

function wrapSectionHtml(title, content) {
  const body = String(content || '').trim();
  if (!body) return '';
  if (/<html[\s>]/i.test(body)) return body;
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /></head><body><h1>${title || ''}</h1>${body}</body></html>`;
}

/** 生成指定小节的临时 Word 字节；无正文时返回 null。 */
async function previewContentSection({ sectionId, technicalPlanStore, openXmlHelperService, exportFormat }) {
  const state = technicalPlanStore.loadTechnicalPlan();
  const item = findOutlineItem(state?.outlineData?.outline || [], sectionId);
  const sectionContent = state?.contentGenerationSections?.[sectionId]?.content;
  const content = sectionContent || item?.content;
  if (!content || !String(content).trim()) return null;

  const html = wrapSectionHtml(item?.title, content);
  const temporaryRoot = path.resolve(os.tmpdir());
  const temporaryDir = fs.mkdtempSync(path.join(temporaryRoot, 'yibiao-content-preview-'));
  try {
    const rendered = await openXmlHelperService.createRestrictedHtmlDocx(html, exportFormat || { template_name: 'preview' }, {
      assetRoot: undefined,
      copyAssets: false,
    });
    return new Uint8Array(rendered.bytes);
  } finally {
    if (path.dirname(temporaryDir) === temporaryRoot && path.basename(temporaryDir).startsWith('yibiao-content-preview-')) {
      fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
  }
}

module.exports = { previewContentSection, wrapSectionHtml, findOutlineItem };
