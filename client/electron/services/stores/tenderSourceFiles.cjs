// 技术标源文件与原件：招标原文、原件副本的落盘与清理。
//
// 这些原本是 createTechnicalPlanStore 工厂里的闭包函数；这里把目录常量与少量内部助手显式注入。

const fs = require('node:fs');
const path = require('node:path');
const { now, safeJsonParse, stableHash, safeFileNamePart, filePathKey, createTenderSourceId } = require('./storeUtils.cjs');
const { compactLogError } = require('../../utils/developerLog.cjs');
const { isFileLockError } = require('../../utils/forceRemove.cjs');

function createTenderSourceFiles(deps) {
  const {
    tenderSourceFilesDir,
    tenderOriginalsDir,
    tenderSourceFilesDirRelativePath,
    tenderOriginalsDirRelativePath,
    tenderOriginalLogger,
    removeWorkspacePathSync,
    getManagedTenderOriginalRelativePath,
    clearBidTemplate,
    readMetaRow,
    resolveMarkdownPath,
  } = deps;

  function loadTenderSourceFiles(meta = readMetaRow()) {
    const sourceFiles = safeJsonParse(meta.tender_files_json, []);
    if (Array.isArray(sourceFiles) && sourceFiles.length) {
      return sourceFiles.map((file) => ({
        id: String(file.id || ''),
        fileName: String(file.fileName || '招标文件'),
        markdownPath: String(file.markdownPath || ''),
        markdownChars: Number(file.markdownChars || 0),
        contentHash: String(file.contentHash || ''),
        parserLabel: file.parserLabel ? String(file.parserLabel) : undefined,
        sourceDocxPath: file.sourceDocxPath ? String(file.sourceDocxPath) : undefined,
        importedAt: file.importedAt ? String(file.importedAt) : undefined,
        updatedAt: file.updatedAt ? String(file.updatedAt) : meta.updated_at,
      })).filter((file) => file.id && file.markdownPath);
    }
    if (meta.tender_markdown_path) {
      return [{
        id: 'tender-legacy-01',
        fileName: meta.tender_file_name || '技术方案招标文件',
        markdownPath: meta.tender_markdown_path,
        markdownChars: Number(meta.tender_markdown_chars || 0),
        contentHash: meta.tender_markdown_hash || '',
        parserLabel: meta.tender_parser_label || undefined,
        importedAt: meta.tender_imported_at || undefined,
        updatedAt: meta.updated_at,
      }];
    }
    return [];
  }

  function readTenderSourceMarkdown(sourceId) {
    const target = loadTenderSourceFiles().find((file) => file.id === String(sourceId || ''));
    if (!target) return '';
    const filePath = resolveMarkdownPath(target.markdownPath);
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8');
  }

  function readOriginalTenderMarkdown() {
    const meta = readMetaRow();
    if (!meta.tender_markdown_path) {
      return '';
    }
    const originalPath = meta.tender_original_markdown_path
      ? resolveMarkdownPath(meta.tender_original_markdown_path)
      : null;
    if (originalPath && fs.existsSync(originalPath)) {
      return fs.readFileSync(originalPath, 'utf-8');
    }
    throw new Error('原始招标文件缺失，请重新上传招标文件');
  }

  function writeMarkdownFile(targetPath, markdown, prefix) {
    const targetDir = path.dirname(targetPath);
    const tempPath = path.join(targetDir, `${prefix}-${Date.now()}.tmp.md`);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(tempPath, `${String(markdown || '').trim()}\n`, 'utf-8');
    try {
      fs.renameSync(tempPath, targetPath);
    } catch (error) {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
      throw error;
    }
  }

  function writeTenderSourceMarkdown(source, index) {
    const markdown = String(source?.file_content || '').trim();
    const fileName = source?.file_name || '招标文件';
    const id = createTenderSourceId(fileName, markdown, index);
    const relativePath = path.join(tenderSourceFilesDirRelativePath, `${id}-${safeFileNamePart(fileName)}.md`).replace(/\\/g, '/');
    const targetPath = resolveMarkdownPath(relativePath);
    writeMarkdownFile(targetPath, markdown, id);
    const sourceDocxPath = persistExistingTenderOriginal(source, id);
    return {
      id,
      fileName,
      markdownPath: relativePath,
      markdownChars: markdown.length,
      contentHash: stableHash(markdown),
      parserLabel: source?.parser_label || undefined,
      sourceDocxPath: sourceDocxPath || undefined,
      importedAt: now(),
      updatedAt: now(),
    };
  }

  function persistExistingTenderOriginal(source, id) {
    const destRelative = path.join(tenderOriginalsDirRelativePath, `${id}.docx`).replace(/\\/g, '/');
    const destPath = resolveMarkdownPath(destRelative);
    const incoming = String(source?.source_docx_path || source?.sourceDocxPath || '').trim();
    if (!incoming) return '';
    const sourcePath = path.isAbsolute(incoming) ? incoming : resolveMarkdownPath(incoming);
    if (!fs.existsSync(sourcePath)) return '';
    const managedRelativePath = getManagedTenderOriginalRelativePath(sourcePath);
    if (managedRelativePath) return managedRelativePath;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    if (filePathKey(sourcePath) !== filePathKey(destPath)) {
      tenderOriginalLogger.write('tender-original.copy.started', { phase: 'state-rebuild', source_path: sourcePath, dest_path: destPath });
      try {
        fs.copyFileSync(sourcePath, destPath);
        tenderOriginalLogger.write('tender-original.copy.completed', { phase: 'state-rebuild', source_path: sourcePath, dest_path: destPath });
      } catch (error) {
        tenderOriginalLogger.write('tender-original.copy.failed', {
          phase: 'state-rebuild',
          source_path: sourcePath,
          dest_path: destPath,
          code: error?.code,
          syscall: error?.syscall,
          error: compactLogError(error),
        });
        throw error;
      }
    }
    return destRelative;
  }

  function pruneTenderOriginals(keptRelativePaths, phase = 'state-rebuild') {
    const keep = new Set((Array.isArray(keptRelativePaths) ? keptRelativePaths : []).map((item) => filePathKey(resolveMarkdownPath(item))));
    if (!fs.existsSync(tenderOriginalsDir)) return;
    for (const name of fs.readdirSync(tenderOriginalsDir)) {
      const filePath = path.join(tenderOriginalsDir, name);
      if (!keep.has(filePathKey(filePath))) {
        tenderOriginalLogger.write('tender-original.delete.started', { phase, file_path: filePath });
        try {
          removeWorkspacePathSync(filePath, (event, payload) => tenderOriginalLogger.write(event, { phase, ...payload }));
          tenderOriginalLogger.write('tender-original.delete.completed', { phase, file_path: filePath });
        } catch (error) {
          tenderOriginalLogger.write('tender-original.delete.failed', {
            phase,
            file_path: filePath,
            code: error?.code,
            syscall: error?.syscall,
            error: compactLogError(error),
          });
          const fileName = path.basename(filePath);
          const message = isFileLockError(error)
            ? `无法删除旧招标 Word 原件“${fileName}”，请关闭可能占用该文件的 Word/WPS，并确认文件可写后重试`
            : `无法清理旧招标 Word 原件“${fileName}”：${error?.message || error}`;
          const cleanupError = new Error(message);
          cleanupError.code = 'TENDER_ORIGINAL_CLEANUP_FAILED';
          cleanupError.cause = error;
          throw cleanupError;
        }
      }
    }
  }

  function clearTenderSourceFiles(phase = 'technical-plan-reset') {
    clearBidTemplate();
    if (fs.existsSync(tenderOriginalsDir)) {
      tenderOriginalLogger.write('tender-original.delete-directory.started', { phase, directory_path: tenderOriginalsDir });
      try {
        removeWorkspacePathSync(tenderOriginalsDir, (event, payload) => tenderOriginalLogger.write(event, { phase, ...payload }));
        tenderOriginalLogger.write('tender-original.delete-directory.completed', { phase, directory_path: tenderOriginalsDir });
      } catch (error) {
        tenderOriginalLogger.write('tender-original.delete-directory.failed', {
          phase,
          directory_path: tenderOriginalsDir,
          code: error?.code,
          syscall: error?.syscall,
          path: error?.path,
          error: compactLogError(error),
        });
        const resetError = new Error('无法清理招标 Word 原件，请关闭可能占用原件的 Word/WPS，并确认文件可写后重试');
        resetError.code = 'TENDER_ORIGINAL_CLEANUP_FAILED';
        resetError.cause = error;
        throw resetError;
      }
    }
    if (fs.existsSync(tenderSourceFilesDir)) {
      removeWorkspacePathSync(tenderSourceFilesDir);
    }
  }

  return {
    loadTenderSourceFiles,
    readTenderSourceMarkdown,
    readOriginalTenderMarkdown,
    writeMarkdownFile,
    writeTenderSourceMarkdown,
    persistExistingTenderOriginal,
    pruneTenderOriginals,
    clearTenderSourceFiles,
  };
}

module.exports = { createTenderSourceFiles };
