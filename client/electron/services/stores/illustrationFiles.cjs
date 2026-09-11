// 技术方案配图的落盘助手：HTML 源文件与截图 PNG 的确定性路径、原子写入、读取与清理。
//
// 这些原本是 createTechnicalPlanStore 工厂里的闭包函数；这里把三个路径与删除回调显式注入，
// 自身不持有模块级状态，可单独测试。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createIllustrationFiles(deps) {
  const {
    originalPlanMarkdownPath,
    illustrationsDir,
    generatedIllustrationsDir,
    removeWorkspacePathSync,
  } = deps;

  function normalizeIllustrationFilePart(value) {
    return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'illustration';
  }

  function writeIllustrationFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    if (typeof content === 'string') {
      fs.writeFileSync(tempPath, content, 'utf-8');
    } else {
      fs.writeFileSync(tempPath, content);
    }
    fs.renameSync(tempPath, filePath);
  }

  // 根据计划版本和图片项 ID 计算 HTML 源文件的确定性路径。
  function getIllustrationHtmlFile({ revision, itemId }) {
    const safeRevision = normalizeIllustrationFilePart(revision);
    const safeItemId = normalizeIllustrationFilePart(itemId);
    const relativePath = path.join('illustrations', safeRevision, 'html', `${safeItemId}.html`).replace(/\\/g, '/');
    return {
      relativePath,
      filePath: path.join(path.dirname(originalPlanMarkdownPath), relativePath),
    };
  }

  // 独立保存 HTML 图片源文件，供转图失败或任务恢复时复用。
  function saveIllustrationHtml({ revision, itemId, content }) {
    const { relativePath, filePath } = getIllustrationHtmlFile({ revision, itemId });
    writeIllustrationFile(filePath, String(content || ''));
    return { relativePath, filePath };
  }

  // 读取此前已生成的 HTML 图片源文件。
  function readIllustrationHtml(relativePath) {
    const resolvedPath = path.resolve(path.dirname(originalPlanMarkdownPath), String(relativePath || ''));
    const root = `${path.resolve(illustrationsDir)}${path.sep}`;
    if (!resolvedPath.startsWith(root) || !fs.existsSync(resolvedPath)) return '';
    return fs.readFileSync(resolvedPath, 'utf-8');
  }

  // 在计划尚未记录 source_path 时按确定性路径探测已落盘的 HTML。
  function findIllustrationHtml({ revision, itemId }) {
    const entry = getIllustrationHtmlFile({ revision, itemId });
    if (!fs.existsSync(entry.filePath)) return null;
    return { ...entry, content: fs.readFileSync(entry.filePath, 'utf-8') };
  }

  // 保存 HTML 截图 PNG，并返回 Renderer/导出层均可读取的资产 URL。
  function saveIllustrationPng({ revision, itemId, buffer }) {
    const safeRevision = normalizeIllustrationFilePart(revision);
    const safeItemId = normalizeIllustrationFilePart(itemId);
    const filePath = path.join(generatedIllustrationsDir, safeRevision, `${safeItemId}.png`);
    writeIllustrationFile(filePath, buffer);
    return {
      filePath,
      assetUrl: `yibiao-asset://generated-images/technical-plan/illustrations/${encodeURIComponent(safeRevision)}/${encodeURIComponent(`${safeItemId}.png`)}`,
    };
  }

  // 清理技术方案专属的图片源文件和生成图片。
  function clearIllustrationFiles() {
    removeWorkspacePathSync(illustrationsDir);
    removeWorkspacePathSync(generatedIllustrationsDir);
  }

  return {
    saveIllustrationHtml,
    readIllustrationHtml,
    findIllustrationHtml,
    saveIllustrationPng,
    clearIllustrationFiles,
  };
}

module.exports = { createIllustrationFiles };
