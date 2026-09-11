// 可研报告导出 Word：模板列表、选中模板、导出进度与六个动作。
//
// 与技术方案的 useExportWord 同形：注入 state（导出内容来源）、exportOptions（导出选项）、
// onSectionChange（新建模板跳转），模板读取、进度事件订阅、失败态全部关在 hook 里。

import { useCallback, useMemo, useState } from 'react';
import { useToast } from '../../../shared/ui';
import type { ExportFormatConfig, ExportTemplateRecord } from '../../../shared/types/exportFormat';
import type { WordExportProgressEvent } from '../../../shared/types';
import { buildExportFormatCssVars } from '../../../shared/utils/exportFormatCss';
import type { SectionId } from '../../../shared/types/navigation';
import type { FeasibilityExportOptions, FeasibilityReportState } from '../../../shared/types/domains/feasibility-report';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';

const initialExportProgress = {
  open: false,
  running: false,
  progress: 0,
  message: '',
  warnings: [] as string[],
  filePath: '',
  error: '',
};

export interface UseFeasibilityExportWordOptions {
  state: FeasibilityReportState;
  exportOptions: FeasibilityExportOptions;
  onSectionChange?: (section: SectionId) => void;
}

export function useFeasibilityExportWord({ state, exportOptions, onSectionChange }: UseFeasibilityExportWordOptions) {
  const { showToast } = useToast();
  const [exportTemplateDialogOpen, setExportTemplateDialogOpen] = useState(false);
  const [exportTemplates, setExportTemplates] = useState<ExportTemplateRecord[]>([]);
  const [exportTemplatesLoading, setExportTemplatesLoading] = useState(false);
  const [exportTemplateSearch, setExportTemplateSearch] = useState('');
  const [selectedExportTemplateId, setSelectedExportTemplateId] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(initialExportProgress);

  const selectedExportTemplate = exportTemplates.find((item) => item.template_id === selectedExportTemplateId) || null;
  const exportTemplatePreviewStyle = useMemo(
    () => buildExportFormatCssVars(selectedExportTemplate?.config || DEFAULT_EXPORT_FORMAT),
    [selectedExportTemplate],
  );
  const filteredExportTemplates = useMemo(() => {
    const keyword = exportTemplateSearch.trim().toLowerCase();
    if (!keyword) return exportTemplates;
    return exportTemplates.filter((template) => template.template_name.toLowerCase().includes(keyword));
  }, [exportTemplateSearch, exportTemplates]);

  const loadExportTemplates = useCallback(async () => {
    setExportTemplatesLoading(true);
    try {
      const templates = await window.yibiao?.templates.list();
      const nextTemplates = templates || [];
      setExportTemplates(nextTemplates);
      setSelectedExportTemplateId((prev) => (nextTemplates.some((item) => item.template_id === prev) ? prev : nextTemplates[0]?.template_id || ''));
    } catch (error) {
      setExportTemplates([]);
      setSelectedExportTemplateId('');
      showToast(error instanceof Error ? error.message : '读取导出模板失败', 'error');
    } finally {
      setExportTemplatesLoading(false);
    }
  }, [showToast]);

  const openExportTemplateDialog = async () => {
    if (!state.outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }
    setExportTemplateDialogOpen(true);
    setExportTemplateSearch('');
    await loadExportTemplates();
  };

  const runExportWord = async (exportFormat: ExportFormatConfig) => {
    if (!state.outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }
    const requestId = `export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let unsubscribe: (() => void) | undefined;
    try {
      setIsExporting(true);
      setExportProgress({
        ...initialExportProgress,
        open: true,
        running: true,
        progress: 2,
        message: '正在准备导出 Word。',
      });
      unsubscribe = window.yibiao?.export.onWordExportProgress((event: WordExportProgressEvent) => {
        if (event.requestId && event.requestId !== requestId) return;
        setExportProgress((prev) => ({
          ...prev,
          open: true,
          running: event.phase === 'running',
          progress: event.progress,
          message: event.message,
          warnings: event.warnings || prev.warnings,
          error: event.phase === 'error' ? event.message : '',
        }));
      });
      const result = await window.yibiao!.export.exportWord({
        requestId,
        project_name: state.projectInfo.projectName || '可行性研究报告',
        outline: state.outlineData.outline,
        export_format: exportFormat,
        feasibility_options: {
          ...exportOptions,
          documentCode: String(exportOptions.documentCode || '').trim() || `KYBG-${Date.now().toString().slice(-6)}`,
          project_info: state.projectInfo,
        },
      });
      if (result.canceled) {
        setExportProgress(initialExportProgress);
        showToast('已取消导出', 'info');
        return;
      }
      if (!result.success) {
        throw new Error(result.message || '导出失败');
      }
      setExportProgress((prev) => ({
        ...prev,
        open: true,
        running: false,
        progress: 100,
        message: result.message || 'Word 已导出，请打开文档核对封面、附表和正文。',
        warnings: result.warnings || prev.warnings,
        filePath: result.path || '',
      }));
      showToast(result.message || 'Word 已导出', result.warnings?.length ? 'info' : 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出失败';
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
      setIsExporting(false);
      unsubscribe?.();
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

  const handleOpenExportedFile = async () => {
    if (!exportProgress.filePath) return;
    try {
      await window.yibiao?.export.openFile(exportProgress.filePath);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开文件失败', 'error');
    }
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
