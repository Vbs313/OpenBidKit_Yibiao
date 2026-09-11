// 技术方案库的技术标元数据层：meta 行的读写、tender.md 路径解析，以及「待选招标文件」的清理。
//
// 这些原本是 createTechnicalPlanStore 工厂里的闭包函数；这里把 db 与两个路径显式注入，
// 自身不持有模块级状态，可单独测试。

const fs = require('node:fs');
const path = require('node:path');
const { now } = require('./storeUtils.cjs');

function createTenderMeta(deps) {
  const { db, tenderMarkdownPath, tenderMarkdownRelativePath } = deps;

  function resolvePendingTenderMarkdownPath(filePath) {
    return path.resolve(resolveMarkdownPath(filePath));
  }

  function isPendingTenderMarkdownPath(filePath) {
    const resolvedPath = resolvePendingTenderMarkdownPath(filePath);
    const expectedDir = path.resolve(path.dirname(tenderMarkdownPath));
    return path.dirname(resolvedPath).toLowerCase() === expectedDir.toLowerCase()
      && /^tender-pending-\d+\.tmp\.md$/.test(path.basename(resolvedPath));
  }

  function clearPendingTenderMeta() {
    updateMeta({
      pending_tender_markdown_path: null,
      pending_tender_file_name: null,
      pending_tender_parser_label: null,
      pending_tender_sections_json: null,
      pending_tender_total_declared: null,
      pending_tender_created_at: null,
    });
  }

  function cleanupOrphanPendingTenderFiles(activeMarkdownPath = '') {
    const targetDir = path.dirname(tenderMarkdownPath);
    if (!fs.existsSync(targetDir)) {
      return;
    }
    const activePath = activeMarkdownPath ? path.resolve(activeMarkdownPath).toLowerCase() : '';
    for (const fileName of fs.readdirSync(targetDir)) {
      if (!/^tender-pending-\d+\.tmp\.md$/.test(fileName)) {
        continue;
      }
      const filePath = path.join(targetDir, fileName);
      if (activePath && path.resolve(filePath).toLowerCase() === activePath) {
        continue;
      }
      try {
        const stats = fs.lstatSync(filePath);
        if (stats.isFile()) fs.rmSync(filePath, { force: true });
      } catch {
        // 清理孤儿临时文件失败不影响主流程
      }
    }
  }

  function removePendingTenderMarkdown(markdownPath) {
    const resolvedPath = markdownPath ? resolvePendingTenderMarkdownPath(markdownPath) : '';
    if (!resolvedPath || !isPendingTenderMarkdownPath(resolvedPath) || !fs.existsSync(resolvedPath)) {
      return;
    }
    try {
      const stats = fs.lstatSync(resolvedPath);
      if (stats.isFile()) fs.rmSync(resolvedPath, { force: true });
    } catch {
      // 清理临时文件失败不影响主流程
    }
  }

  function cleanupPendingTenderSelection() {
    const meta = ensureMetaRow();
    const pendingPath = meta.pending_tender_markdown_path || '';
    const markdownPath = pendingPath ? resolvePendingTenderMarkdownPath(pendingPath) : '';
    clearPendingTenderMeta();
    if (!markdownPath || !isPendingTenderMarkdownPath(markdownPath) || !fs.existsSync(markdownPath)) {
      cleanupOrphanPendingTenderFiles();
      return;
    }
    removePendingTenderMarkdown(markdownPath);
    cleanupOrphanPendingTenderFiles();
  }

  function cleanupLegacyPendingTenderState(meta = ensureMetaRow()) {
    const hasPendingMeta = Boolean(
      meta.pending_tender_markdown_path
      || meta.pending_tender_file_name
      || meta.pending_tender_sections_json
      || meta.pending_tender_created_at,
    );
    if (hasPendingMeta) {
      cleanupPendingTenderSelection();
      return true;
    }
    cleanupOrphanPendingTenderFiles();
    return false;
  }

  function ensureMetaRow() {
    const existing = db.prepare('SELECT * FROM technical_plan_meta WHERE id = 1').get();
    if (existing) return existing;
    const timestamp = now();
    db.prepare(`
      INSERT INTO technical_plan_meta (id, workflow_kind, step, bid_analysis_mode, outline_mode, outline_expansion_mode, created_at, updated_at)
      VALUES (1, 'technical-plan', 'document-analysis', 'key', 'aligned', 'ai-complement', @timestamp, @timestamp)
    `).run({ timestamp });
    return db.prepare('SELECT * FROM technical_plan_meta WHERE id = 1').get();
  }

  function readMetaRow() {
    const meta = db.prepare('SELECT * FROM technical_plan_meta WHERE id = 1').get();
    if (!meta) throw new Error('技术方案数据库尚未初始化');
    return meta;
  }

  function updateMeta(fields) {
    ensureMetaRow();
    const entries = Object.entries(fields || {}).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE technical_plan_meta SET ${assignments}, updated_at = @updated_at WHERE id = 1`).run({
      ...Object.fromEntries(entries),
      updated_at: now(),
    });
  }

  function resolveMarkdownPath(relativeOrAbsolutePath) {
    const value = String(relativeOrAbsolutePath || '').trim();
    if (!value) return tenderMarkdownPath;
    return path.isAbsolute(value) ? value : path.join(path.dirname(path.dirname(tenderMarkdownPath)), value);
  }

  function readTenderMarkdown() {
    const meta = readMetaRow();
    const filePath = resolveMarkdownPath(meta.tender_markdown_path || tenderMarkdownRelativePath);
    if (!meta.tender_markdown_path || !fs.existsSync(filePath)) {
      return '';
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  return {
    ensureMetaRow,
    readMetaRow,
    updateMeta,
    resolveMarkdownPath,
    readTenderMarkdown,
    resolvePendingTenderMarkdownPath,
    isPendingTenderMarkdownPath,
    clearPendingTenderMeta,
    cleanupOrphanPendingTenderFiles,
    removePendingTenderMarkdown,
    cleanupPendingTenderSelection,
    cleanupLegacyPendingTenderState,
  };
}

module.exports = { createTenderMeta };
