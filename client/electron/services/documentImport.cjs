// 文档导入：选文件 → 校验扩展名 → 逐个解析成 Markdown → 汇总错误与文案。
// 技术方案 / 可研资料 / 废标项检查三处导入只有「标题、是否多选、assetScope 前缀」三处差异，
// 合并成一个入口后 fileService 只留薄封装。
const path = require('node:path');
const crypto = require('node:crypto');

function createDocumentImport({
  app,
  configStore,
  dialog,
  parseDocumentWithConfig,
  resolveFileParser,
  normalizeProvidedFilePaths,
  getSelectableExtensions,
  formatImportError,
  parserLabels,
}) {
  async function importParsedDocuments({
    label,
    multiple = false,
    assetScopePrefix = 'technical-plan',
    includeSourcePath = true,
    filePaths,
  } = {}) {
const config = configStore ? configStore.load() : { components: { file_parser: { provider: 'local' } } };
    const provider = config.components?.file_parser?.provider || 'local';
    const supportedExtensions = getSelectableExtensions(provider);
    let selectedPaths = normalizeProvidedFilePaths(filePaths);
    if (!multiple && selectedPaths.length > 1) {
      selectedPaths = selectedPaths.slice(0, 1);
    }
    if (!selectedPaths.length) {
      const result = await dialog.showOpenDialog({
        title: `选择${label}`,
        properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: [
          { name: parserLabels[provider] || label, extensions: [...supportedExtensions].map((item) => item.slice(1)) },
          { name: '所有文件', extensions: ['*'] },
        ],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, message: '已取消选择' };
      }
      selectedPaths = result.filePaths;
    }

    const parsedDocuments = [];
    const errors = [];
    for (const filePath of selectedPaths) {
      const ext = path.extname(filePath).toLowerCase();
      const parser = resolveFileParser(config, filePath);
      if (!supportedExtensions.has(ext)) {
        errors.push(`${path.basename(filePath)}：当前${parserLabels[provider] || '解析方式'}不支持该文件格式`);
        continue;
      }

      let fileContent = '';
      try {
        const assetHash = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 12);
        fileContent = (await parseDocumentWithConfig(app, filePath, config, {
          assetScope: `${assetScopePrefix}-${assetHash}`,
          preserveImages: false,
        })).trim();
      } catch (error) {
        errors.push(`${path.basename(filePath)}：${formatImportError(error, filePath)}`);
        continue;
      }

      if (!fileContent) {
        errors.push(`${path.basename(filePath)}：未提取到有效 Markdown 内容，请检查文件内容`);
        continue;
      }

        parsedDocuments.push({
          file_content: fileContent,
          file_name: path.basename(filePath),
          ...(includeSourcePath ? { source_path: filePath } : {}),
          parser_provider: parser.provider,
        parser_label: parserLabels[parser.provider] || '本地解析',
        fallback_to_local: Boolean(parser.fallbackToLocal),
      });
    }

    if (!parsedDocuments.length) {
      return { success: false, message: errors[0] || '未提取到有效 Markdown 内容，请检查文件内容', documents: [] };
    }

    const fallbackToLocal = parsedDocuments.some((item) => item.fallback_to_local);
    const messageParts = [multiple ? `文件解析完成，共 ${parsedDocuments.length} 份` : '文件解析完成'];
    if (fallbackToLocal) messageParts.push('当前格式已自动使用本地解析');
    if (errors.length) messageParts.push(`失败 ${errors.length} 份`);
    const first = parsedDocuments[0];

    return {
      success: true,
      message: messageParts.join('，'),
      file_content: first.file_content,
      file_name: first.file_name,
      parser_provider: first.parser_provider,
      parser_label: first.parser_label,
      documents: parsedDocuments,
      errors,
    };
  }

  return { importParsedDocuments };
}

module.exports = { createDocumentImport };
