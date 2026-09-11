// 导出 Word：模板列表、选中模板、导出进度与四个动作。
//
// 原本散在 TechnicalPlanHome 里（6 个 state + 4 个派生 + 6 个 handler，约 150 行）。
// 两个弹窗组件（ExportTemplateDialog / ExportProgressDialog）已经单独拆出，这里只负责它们的状态与动作。
//
// 注入三件事：outlineData（导出的内容来源）、exportFormat（预览样式回落）、onSectionChange（新建模板跳转）。

import { useCallback, useMemo, useState } from 'react';
import { useToast } from '../../../shared/ui';
import type { ExportFormatConfig, ExportTemplateRecord } from '../../../shared/types/exportFormat';
import type { OutlineData, WordExportProgressEvent } from '../../../shared/types';
import { buildExportFormatCssVars } from '../../../shared/utils/exportFormatCss';
import { countOutlineMermaidDiagrams } from '../../../shared/utils/outlineMetrics';
import { initialExportProgress } from '../components/technicalPlanDialogs';
import type { ExportProgressState } from '../components/technicalPlanDialogs';
import type { SectionId } from '../../../shared/types/navigation';

export interface UseExportWordOptions {
  outlineData: OutlineData | null;
  exportFormat: ExportFormatConfig;
  onSectionChange?: (section: SectionId) => void;
}

export function useExportWord({ outlineData, exportFormat, onSectionChange }: UseExportWordOptions) {
  const { showToast } = useToast();
  const [exportProgress, setExportProgress] = useState<ExportProgressState>(initialExportProgress);
  const [exportTemplateDialogOpen, setExportTemplateDialogOpen] = useState(false);
  const [exportTemplates, setExportTemplates] = useState<ExportTemplateRecord[]>([]);
  const [exportTemplatesLoading, setExportTemplatesLoading] = useState(false);
  const [exportTemplateSearch, setExportTemplateSearch] = useState('');
  const [selectedExportTemplateId, setSelectedExportTemplateId] = useState('');

  const isExporting = exportProgress.running;
  const filteredExportTemplates = useMemo(() => {
    const keyword = exportTemplateSearch.trim().toLowerCase();
    if (!keyword) return exportTemplates;
    return exportTemplates.filter((template) => template.template_name.toLowerCase().includes(keyword));
  }, [exportTemplateSearch, exportTemplates]);
  const selectedExportTemplate = filteredExportTemplates.find((template) => template.template_id === selectedExportTemplateId) || filteredExportTemplates[0] || null;
  const exportTemplatePreviewStyle = useMemo(() => buildExportFormatCssVars(selectedExportTemplate?.config || exportFormat), [exportFormat, selectedExportTemplate]);

  const loadExportTemplates = useCallback(async () => {
    setExportTemplatesLoading(true);
    try {
      const templates = await window.yibiao?.templates.list();
      const nextTemplates = templates || [];
      setExportTemplates(nextTemplates);
      setSelectedExportTemplateId((prev) => nextTemplates.some((template) => template.template_id === prev) ? prev : nextTemplates[0]?.template_id || '');
    } catch (error) {
      setExportTemplates([]);
      setSelectedExportTemplateId('');
      showToast(error instanceof Error ? error.message : '读取导出模板失败', 'error');
    } finally {
      setExportTemplatesLoading(false);
    }
  }, [showToast]);

  const openExportTemplateDialog = async () => {
    if (!outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }

    setExportTemplateDialogOpen(true);
    setExportTemplateSearch('');
    await loadExportTemplates();
  };

  const runExportWord = async (latestExportFormat: ExportFormatConfig) => {
    if (!outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }

    const requestId = `export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const mermaidCount = countOutlineMermaidDiagrams(outlineData.outline);
    let unsubscribe: (() => void) | undefined;

    try {
      setExportProgress({
        open: true,
        running: true,
        progress: 2,
        message: mermaidCount
          ? `检测到 ${mermaidCount} 张 Mermaid 图，导出时会转换为 Word 图片，可能需要稍等。`
          : '正在准备导出 Word。',
        warnings: [],
        mermaidCount,
      });

      unsubscribe = window.yibiao?.export.onWordExportProgress((event: WordExportProgressEvent) => {
        if (event.requestId && event.requestId !== requestId) {
          return;
        }

        setExportProgress((prev) => ({
          ...prev,
          open: true,
          running: event.phase === 'running',
          progress: event.progress,
          message: event.message,
          warnings: event.warnings || prev.warnings,
          error: event.phase === 'error' ? event.message : undefined,
        }));
      });

      const result = await window.yibiao?.export.exportWord({
        requestId,
        project_name: outlineData.project_name,
        outline: outlineData.outline,
        export_format: latestExportFormat,
      });
      if (result?.canceled) {
        setExportProgress(initialExportProgress);
        showToast('已取消导出', 'info');
        return;
      }
      setExportProgress((prev) => ({
        ...prev,
        open: true,
        running: false,
        progress: 100,
        message: result?.message || 'Word 已导出，请打开文档核对图片、表格和版式。',
        warnings: result?.warnings || prev.warnings,
        filePath: result?.path,
      }));
      showToast(result?.message || 'Word 已导出', result?.warnings?.length ? 'info' : 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出 Word 失败';
      setExportProgress((prev) => ({
        ...prev,
        open: true,
        running: false,
        progress: 100,
        message,
        error: message,
      }));
      showToast(message, 'error');
    } finally {
      unsubscribe?.();
    }
  };

  const handleOpenExportedFile = async () => {
    if (!exportProgress.filePath) return;

    try {
      await window.yibiao?.export.openFile(exportProgress.filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : '打开文件失败';
      showToast(message, 'error');
    }
  };

  const confirmExportTemplate = async () => {
    if (!selectedExportTemplate) {
      showToast('请先选择导出模板', 'info');
      return;
    }

    setExportTemplateDialogOpen(false);
    await runExportWord(selectedExportTemplate.config);
  };

  const createExportTemplate = () => {
    if (!onSectionChange) {
      showToast('请从左侧菜单进入模板设置新建模板', 'info');
      return;
    }

    setExportTemplateDialogOpen(false);
    onSectionChange('new-template');
  };

  const resetExportProgress = () => {
    setExportProgress(initialExportProgress);
  };

  return {
    exportProgress,
    resetExportProgress,
    exportTemplateDialogOpen,
    setExportTemplateDialogOpen,
    exportTemplates,
    exportTemplatesLoading,
    exportTemplateSearch,
    setExportTemplateSearch,
    selectedExportTemplateId,
    setSelectedExportTemplateId,
    filteredExportTemplates,
    selectedExportTemplate,
    exportTemplatePreviewStyle,
    isExporting,
    openExportTemplateDialog,
    handleOpenExportedFile,
    confirmExportTemplate,
    createExportTemplate,
  };
}
