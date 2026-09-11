import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { trackPageView } from '../../../shared/analytics/analytics';
import { FloatingToolbar, ProgressBar, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import type {
  BodyTextStyleConfig,
  ExportFormatConfig,
  HeadingBorderConfig,
  HeadingStyleConfig,
  ImageStyleConfig,
  PageSetupConfig,
  TableCellStyleConfig,
  TableStyleConfig,
} from '../../../shared/types/exportFormat';
import {
  DEFAULT_EXPORT_FORMAT,
  FONT_OPTIONS,
} from '../../../shared/types/exportFormat';
import { buildExportFormatCssVars } from '../../../shared/utils/exportFormatCss';
import { BodySettings } from '../components/settings/BodySettings';
import { CoverSettings } from '../components/settings/CoverSettings';
import { HeadingSettings } from '../components/settings/HeadingSettings';
import { ImageSettings } from '../components/settings/ImageSettings';
import { LayoutSettings } from '../components/settings/LayoutSettings';
import { QuickSettings } from '../components/settings/QuickSettings';
import { TableSettings } from '../components/settings/TableSettings';
import { collectConfigFonts, createDefaultExportFormat, createNewTemplateExportFormat, hasGeneratedContent, mergeFontOptions, withExportFormatDefaults } from '../exportFormatModel';
import { countOutlineMermaidDiagrams } from '../../../shared/utils/outlineMetrics';
import { TemplatePreview } from '../components/TemplatePreview';
import type { WordExportProgressEvent } from '../../../shared/types';
import {
  EXPORT_LAYOUT_PRESETS,
  EXPORT_THEME_PRESETS,
  applyExportLayoutPreset,
  applyExportThemePreset,
} from '../exportFormatPresets';

type TemplateTab = 'quick' | 'layout' | 'cover' | 'heading' | 'body' | 'table' | 'image';
type TableCellStyleKey = 'header_row' | 'first_column' | 'body_cell';

interface ExportFormatPageProps {
  mode?: 'create' | 'edit';
  templateId?: string | null;
  onBack?: () => void;
}

const templateTabs: Array<{ id: TemplateTab; label: string }> = [
  { id: 'quick', label: '快捷设置' },
  { id: 'layout', label: '布局设置' },
  { id: 'cover', label: '封皮' },
  { id: 'heading', label: '标题样式' },
  { id: 'body', label: '正文样式' },
  { id: 'table', label: '表格样式' },
  { id: 'image', label: '图片设置' },
];

interface ExportProgressState {
  open: boolean;
  running: boolean;
  progress: number;
  message: string;
  warnings: string[];
  mermaidCount: number;
  filePath?: string;
  error?: string;
}

const initialExportProgress: ExportProgressState = {
  open: false,
  running: false,
  progress: 0,
  message: '',
  warnings: [],
  mermaidCount: 0,
};














function ExportFormatPage({ mode = 'create', templateId = null, onBack }: ExportFormatPageProps) {
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState<TemplateTab>('quick');
  const [config, setConfig] = useState<ExportFormatConfig>(
    () => mode === 'create' ? createNewTemplateExportFormat() : createDefaultExportFormat(),
  );
  const [savedConfig, setSavedConfig] = useState<ExportFormatConfig | null>(null);
  const [currentTemplateId, setCurrentTemplateId] = useState<string | null>(templateId);
  const [selectedLayoutPresetId, setSelectedLayoutPresetId] = useState('');
  const [selectedThemePresetId, setSelectedThemePresetId] = useState('');
  const [expandedHeadings, setExpandedHeadings] = useState<Set<number>>(new Set([0, 1]));
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [exportProgress, setExportProgress] = useState<ExportProgressState>(initialExportProgress);
  const [previewFullscreenOpen, setPreviewFullscreenOpen] = useState(false);
  const [systemFonts, setSystemFonts] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fonts = await window.yibiao?.systemFonts?.list?.();
        if (!cancelled && Array.isArray(fonts)) {
          setSystemFonts(fonts);
        }
      } catch (error) {
        console.warn('[export-format] 系统字体读取失败', error);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    trackPageView(mode === 'edit' ? 'my-templates/edit' : 'new-template');
    let cancelled = false;
    (async () => {
      setLoaded(false);
      setLoadError('');
      try {
        if (mode === 'edit') {
          if (!templateId) {
            throw new Error('缺少要编辑的模板');
          }
          const template = await window.yibiao?.templates.get(templateId);
          if (!template) {
            throw new Error('模板不存在或已被删除');
          }
          if (cancelled) return;
          const nextConfig = withExportFormatDefaults(template.config);
          setCurrentTemplateId(template.template_id);
          setConfig(nextConfig);
          setSavedConfig(nextConfig);
          setSelectedLayoutPresetId('');
          setSelectedThemePresetId('');
          return;
        }

        const defaultConfig = createNewTemplateExportFormat();
        if (cancelled) return;
        setCurrentTemplateId(null);
        setConfig(defaultConfig);
        setSavedConfig(null);
        setSelectedLayoutPresetId('');
        setSelectedThemePresetId('');
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : '未知错误';
        setLoadError(message);
        showToast(`加载模板失败：${message}`, 'error');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [mode, showToast, templateId]);

  const isDirty = useMemo(() => !savedConfig || JSON.stringify(config) !== JSON.stringify(savedConfig), [config, savedConfig]);
  const previewStyle = useMemo<CSSProperties>(() => buildExportFormatCssVars(config), [config]);
  const fontOptions = useMemo(() => mergeFontOptions(FONT_OPTIONS, collectConfigFonts(config), systemFonts), [config, systemFonts]);

  const updateTemplate = useCallback((updates: Partial<ExportFormatConfig>) => {
    setConfig((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleConfirmTemplateName = useCallback(() => {
    const templateName = config.template_name.trim();
    if (!templateName) {
      showToast('请输入模板名称', 'info');
      return;
    }

    if (templateName !== config.template_name) {
      updateTemplate({ template_name: templateName });
    }
    showToast('模板名称已确认，保存配置后生效', 'success');
  }, [config.template_name, showToast, updateTemplate]);

  const updatePage = useCallback((updates: Partial<PageSetupConfig>) => {
    setConfig((prev) => ({ ...prev, page: { ...prev.page, ...updates } }));
  }, []);

  const updateHeading = useCallback((index: number, updates: Partial<HeadingStyleConfig>) => {
    setConfig((prev) => ({
      ...prev,
      headings: prev.headings.map((heading, headingIndex) => headingIndex === index ? { ...heading, ...updates } : heading),
    }));
  }, []);

  const updateHeadingBorder = useCallback((updates: Partial<HeadingBorderConfig>) => {
    setConfig((prev) => {
      const next = {
        ...prev,
        heading_border: { ...prev.heading_border, ...updates },
      };

      if (typeof updates.enabled === 'boolean' && selectedThemePresetId) {
        return applyExportThemePreset(next, selectedThemePresetId);
      }

      return next;
    });
  }, [selectedThemePresetId]);

  const updateHeadingBorderCellColor = useCallback((index: number, value: string) => {
    setConfig((prev) => {
      const levelCellColors = DEFAULT_EXPORT_FORMAT.heading_border.level_cell_colors.map((color, colorIndex) => prev.heading_border.level_cell_colors[colorIndex] || color);
      levelCellColors[index] = value;
      return {
        ...prev,
        heading_border: { ...prev.heading_border, level_cell_colors: levelCellColors },
      };
    });
  }, []);

  const updateBodyText = useCallback((updates: Partial<BodyTextStyleConfig>) => {
    setConfig((prev) => ({ ...prev, body_text: { ...prev.body_text, ...updates } }));
  }, []);

  const updateTable = useCallback((updates: Partial<TableStyleConfig>) => {
    setConfig((prev) => ({ ...prev, table: { ...prev.table, ...updates } }));
  }, []);

  const updateTableCell = useCallback((cellKey: TableCellStyleKey, updates: Partial<TableCellStyleConfig>) => {
    setConfig((prev) => ({
      ...prev,
      table: {
        ...prev.table,
        [cellKey]: { ...prev.table[cellKey], ...updates },
      },
    }));
  }, []);

  const updateImage = useCallback((updates: Partial<ImageStyleConfig>) => {
    setConfig((prev) => ({ ...prev, image: { ...prev.image, ...updates } }));
  }, []);

  const handleSave = useCallback(async () => {
    const templateName = config.template_name.trim();
    if (!templateName) {
      showToast('请先填写模板名称', 'info');
      return;
    }

    try {
      const nextConfig = templateName === config.template_name ? config : { ...config, template_name: templateName };
      const template = currentTemplateId
        ? await window.yibiao?.templates.update(currentTemplateId, nextConfig)
        : await window.yibiao?.templates.create(nextConfig);
      if (!template) {
        throw new Error('模板保存失败');
      }
      setCurrentTemplateId(template.template_id);
      setConfig(template.config);
      setSavedConfig(template.config);
      showToast(currentTemplateId ? '模板已保存' : '模板已创建', 'success');
    } catch (error) {
      showToast(`保存失败：${error instanceof Error ? error.message : '未知错误'}`, 'error');
    }
  }, [config, currentTemplateId, showToast]);

  const handleResetDefault = useCallback(() => {
    if (selectedLayoutPresetId || selectedThemePresetId) {
      setConfig((prev) => {
        const withLayout = selectedLayoutPresetId ? applyExportLayoutPreset(prev, selectedLayoutPresetId) : prev;
        return selectedThemePresetId ? applyExportThemePreset(withLayout, selectedThemePresetId) : withLayout;
      });
      showToast('已恢复当前预设样式，保存后生效', 'info');
      return;
    }

    setConfig((prev) => {
      if (mode === 'create') {
        return createNewTemplateExportFormat();
      }

      return { ...createDefaultExportFormat(), template_name: prev.template_name };
    });
    showToast('已恢复默认模版设置，保存后生效', 'info');
  }, [mode, selectedLayoutPresetId, selectedThemePresetId, showToast]);

  const handleApplyLayoutPreset = useCallback((presetId: string) => {
    if (!presetId) return;
    const preset = EXPORT_LAYOUT_PRESETS.find((item) => item.id === presetId);
    setSelectedLayoutPresetId(presetId);
    setConfig((prev) => {
      const withLayout = applyExportLayoutPreset(prev, presetId);
      return selectedThemePresetId ? applyExportThemePreset(withLayout, selectedThemePresetId) : withLayout;
    });
    showToast(`已应用版面预设：${preset?.label || '未命名预设'}，保存后生效`, 'success');
  }, [selectedThemePresetId, showToast]);

  const handleApplyThemePreset = useCallback((presetId: string) => {
    if (!presetId) return;
    const preset = EXPORT_THEME_PRESETS.find((item) => item.id === presetId);
    setSelectedThemePresetId(presetId);
    setConfig((prev) => applyExportThemePreset(prev, presetId));
    showToast(`已应用主题预设：${preset?.label || '未命名预设'}，保存后生效`, 'success');
  }, [showToast]);

  const handleExportTest = useCallback(async () => {
    let unsubscribe: (() => void) | undefined;

    try {
      const technicalPlan = await window.yibiao?.technicalPlan.loadState();
      const outlineData = technicalPlan?.outlineData;
      const outline = outlineData?.outline || [];
      if (!hasGeneratedContent(outline)) {
        showToast('无已完成标书', 'info');
        return;
      }

      const requestId = `template-export-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const mermaidCount = countOutlineMermaidDiagrams(outline);
      setExportProgress({
        open: true,
        running: true,
        progress: 2,
        message: mermaidCount
          ? `检测到 ${mermaidCount} 张 Mermaid 图，导出时会转换为 Word 图片，可能需要稍等。`
          : '正在使用当前模板导出测试 Word。',
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
        project_name: outlineData?.project_name,
        outline,
        export_format: config,
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
        message: result?.message || 'Word 已导出，请打开文档核对版式。',
        warnings: result?.warnings || prev.warnings,
        filePath: result?.path,
      }));
      showToast(result?.message || 'Word 已导出', result?.warnings?.length ? 'info' : 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出测试失败';
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
  }, [config, showToast]);

  const handleOpenExportedFile = useCallback(async () => {
    if (!exportProgress.filePath) return;

    try {
      await window.yibiao?.export.openFile(exportProgress.filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : '打开文件失败';
      showToast(message, 'error');
    }
  }, [exportProgress.filePath, showToast]);

  const toggleHeading = useCallback((index: number) => {
    setExpandedHeadings((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const resetToolbarGroup: FloatingToolbarGroup = {
    id: 'template-reset',
    actions: [
      { id: 'reset-default', label: '重置默认', variant: 'danger', tooltip: selectedLayoutPresetId || selectedThemePresetId ? '恢复当前预设样式，保存后生效' : '恢复默认模版设置，保存后生效', onClick: handleResetDefault },
    ],
  };
  const exportTestToolbarGroup: FloatingToolbarGroup = {
    id: 'template-export-test',
    actions: [
      { id: 'export-test', label: '导出测试', variant: 'warning', disabled: exportProgress.running, onClick: () => { void handleExportTest(); } },
    ],
  };
  const previewToolbarGroup: FloatingToolbarGroup = {
    id: 'template-preview',
    actions: [
      { id: 'fullscreen-preview', label: '全屏预览', variant: 'success', tooltip: '放大右侧模板预览', onClick: () => setPreviewFullscreenOpen(true) },
    ],
  };
  const saveToolbarGroups: FloatingToolbarGroup[] = isDirty
    ? [
        {
          id: 'template-save-state',
          actions: [
            { id: 'save-indicator', label: '未保存', variant: 'ghost', disabled: true, onClick: () => {} },
          ],
        },
        {
          id: 'template-save',
          actions: [
            { id: 'save', label: '保存配置', variant: 'primary', onClick: handleSave },
          ],
        },
      ]
    : [
        {
          id: 'template-saved',
          actions: [
            { id: 'saved-indicator', label: '已保存', variant: 'ghost', disabled: true, onClick: () => {} },
          ],
        },
      ];
  const navigationToolbarGroup: FloatingToolbarGroup | null = onBack
    ? {
        id: 'template-navigation',
        actions: [
          { id: 'back', label: '返回我的模板', variant: 'secondary', onClick: onBack },
        ],
      }
    : null;
  const toolbarGroups: FloatingToolbarGroup[] = [
    ...(navigationToolbarGroup ? [navigationToolbarGroup] : []),
    previewToolbarGroup,
    resetToolbarGroup,
    exportTestToolbarGroup,
    ...saveToolbarGroups,
  ];










  if (!loaded) {
    return <div className="settings-page export-template-page"><div className="settings-page-scroll"><div className="export-format-loading">加载中...</div></div></div>;
  }

  if (loadError) {
    return (
      <div className="settings-page export-template-page">
        <div className="settings-page-scroll">
          <div className="export-template-error-state">
            <strong>模板加载失败</strong>
            <span>{loadError}</span>
            {onBack ? <button type="button" className="secondary-action" onClick={onBack}>返回我的模板</button> : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-page export-template-page">
      <div className="settings-page-scroll export-template-scroll">
        <div className="settings-tab-shell" role="tablist" aria-label="模版设置分类">
          {templateTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`settings-tab ${activeTab === tab.id ? 'is-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              role="tab"
              aria-selected={activeTab === tab.id}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="export-template-workspace">
          <section className="settings-page-section export-template-editor">
            {activeTab === 'quick' && <QuickSettings mode={mode} config={config} updateTemplate={updateTemplate} handleApplyLayoutPreset={handleApplyLayoutPreset} handleApplyThemePreset={handleApplyThemePreset} handleConfirmTemplateName={handleConfirmTemplateName} selectedLayoutPresetId={selectedLayoutPresetId} selectedThemePresetId={selectedThemePresetId} />}
            {activeTab === 'layout' && <LayoutSettings config={config} fontOptions={fontOptions} updateTemplate={updateTemplate} updatePage={updatePage} />}
            {activeTab === 'heading' && <HeadingSettings config={config} fontOptions={fontOptions} updateTemplate={updateTemplate} updateHeading={updateHeading} updateHeadingBorder={updateHeadingBorder} updateHeadingBorderCellColor={updateHeadingBorderCellColor} toggleHeading={toggleHeading} expandedHeadings={expandedHeadings} />}
            {activeTab === 'body' && <BodySettings config={config} fontOptions={fontOptions} updateBodyText={updateBodyText} />}
            {activeTab === 'table' && <TableSettings config={config} fontOptions={fontOptions} updateTable={updateTable} updateTableCell={updateTableCell} />}
            {activeTab === 'image' && <ImageSettings config={config} fontOptions={fontOptions} updateImage={updateImage} />}
            {activeTab === 'cover' && <CoverSettings config={config} updatePage={updatePage} />}
          </section>
          <TemplatePreview config={config} previewStyle={previewStyle} />
        </div>
      </div>
      <Dialog.Root
        open={exportProgress.open}
        onOpenChange={(open) => {
          if (!open && !exportProgress.running) {
            setExportProgress(initialExportProgress);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="export-progress-card">
            <div className="content-regenerate-card-head">
              <span className="section-kicker">导出测试</span>
              <Dialog.Title>{exportProgress.running ? '正在导出测试' : exportProgress.error ? '导出失败' : '导出完成'}</Dialog.Title>
              <Dialog.Description>
                {exportProgress.mermaidCount > 0
                  ? `本次包含 ${exportProgress.mermaidCount} 张 Mermaid 图，导出时会在本地转换成 Word 图片。`
                  : '正在使用当前模板导出已生成的技术方案。'}
              </Dialog.Description>
            </div>
            <div className="export-progress-body">
              <ProgressBar value={exportProgress.progress} label={`导出测试进度 ${exportProgress.progress}%`} />
              <p>{exportProgress.message || '正在处理导出任务，请稍候。'}</p>
              {exportProgress.warnings.length > 0 && (
                <div className="export-warning-list">
                  <strong>需要核对</strong>
                  {exportProgress.warnings.slice(0, 4).map((warning) => <small key={warning}>{warning}</small>)}
                  {exportProgress.warnings.length > 4 && <small>还有 {exportProgress.warnings.length - 4} 条图片提示，请打开导出的 Word 核对。</small>}
                </div>
              )}
            </div>
            {!exportProgress.running && (
              <div className="content-regenerate-actions">
                {!exportProgress.error && exportProgress.filePath && <button className="primary-action" type="button" onClick={() => { void handleOpenExportedFile(); }}>打开文件</button>}
                <Dialog.Close className={exportProgress.filePath && !exportProgress.error ? 'secondary-action' : 'primary-action'} type="button">知道了</Dialog.Close>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={previewFullscreenOpen} onOpenChange={setPreviewFullscreenOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="export-template-fullscreen-overlay" />
          <Dialog.Content className="export-template-fullscreen-dialog">
            <Dialog.Title className="export-template-fullscreen-title">全屏预览</Dialog.Title>
            <Dialog.Description className="export-template-fullscreen-description">当前模板的全屏排版预览。</Dialog.Description>
            <Dialog.Close className="export-template-fullscreen-close" type="button">退出全屏</Dialog.Close>
            <TemplatePreview config={config} previewStyle={previewStyle} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <FloatingToolbar groups={toolbarGroups} label="模版设置保存工具条" />
    </div>
  );
}

export default ExportFormatPage;
