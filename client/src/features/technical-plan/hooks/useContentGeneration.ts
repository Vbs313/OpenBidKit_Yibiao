import { useState } from 'react';
import { trackConfigUsage } from '../../../shared/analytics/analytics';
import { useToast } from '../../../shared/ui';
import type { ClientConfig, ImageModelStatus, OutlineData, OutlineItem } from '../../../shared/types';
import type { ContentGenerationOptions, ContentIllustrationPlanState } from '../../../shared/types/domains/technical-plan';
import { DEFAULT_HTML_IMAGE_TYPES, defaultContentGenerationOptions, normalizeGenerationOptions } from '../contentEditModel';

type ContentGenerationAction = 'start' | 'continue' | 'regenerate' | 'regenerate_section';

interface UseContentGenerationParams {
  outlineData: OutlineData | null;
  leaves: OutlineItem[];
  isExpansionWorkflow: boolean;
  contentGenerationOptions?: ContentGenerationOptions;
  contentIllustrationPlan?: ContentIllustrationPlanState;
  onContentGenerationOptionsChange: (options: ContentGenerationOptions) => Promise<void> | void;
  imageModelStatus: ImageModelStatus;
  setImageModelStatus: (status: ImageModelStatus) => void;
  imageModelAvailable: boolean;
  running: boolean;
  paused: boolean;
  taskInFlight: boolean;
  taskBlocksGeneration: boolean;
  setPausePending: (pending: boolean) => void;
  resolvedCount: number;
  unresolvedCount: number;
  awaitingContentDecision: boolean;
  canRetryContentCorrection: boolean;
  contentRetryTargetLabel: string;
  setSelectedItemId: (itemId: string) => void;
  setEditingItemId: (itemId: string | null) => void;
  setIsPreviewing: (previewing: boolean) => void;
  setDraftContent: (content: string) => void;
}

// 正文生成的配置弹窗、任务控制与启动编排。
// 页面持有「任务状态派生 + 进度视图模型」，这里只接它的输出，避免两边各算一遍。
export function useContentGeneration({
  outlineData,
  leaves,
  isExpansionWorkflow,
  contentGenerationOptions,
  contentIllustrationPlan,
  onContentGenerationOptionsChange,
  imageModelStatus,
  setImageModelStatus,
  imageModelAvailable,
  running,
  paused,
  taskInFlight,
  taskBlocksGeneration,
  setPausePending,
  resolvedCount,
  unresolvedCount,
  awaitingContentDecision,
  canRetryContentCorrection,
  contentRetryTargetLabel,
  setSelectedItemId,
  setEditingItemId,
  setIsPreviewing,
  setDraftContent,
}: UseContentGenerationParams) {
  const { showToast } = useToast();
  const [requirementItem, setRequirementItem] = useState<OutlineItem | null>(null);
  const [regenerateRequirement, setRegenerateRequirement] = useState('');
  const [generationDialogOpen, setGenerationDialogOpen] = useState(false);
  const [continuePostProcessingDialogOpen, setContinuePostProcessingDialogOpen] = useState(false);
  const [draftGenerationOptions, setDraftGenerationOptions] = useState<ContentGenerationOptions>(defaultContentGenerationOptions);
  const [htmlImageTypesDialogOpen, setHtmlImageTypesDialogOpen] = useState(false);
  const [htmlImageTypesDraft, setHtmlImageTypesDraft] = useState(DEFAULT_HTML_IMAGE_TYPES);

  const openGenerationDialog = async () => {
    if (!outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }
    if (taskInFlight) {
      showToast('正文生成任务进行中，请暂停后再修改配置', 'info');
      return;
    }

    try {
      const config = await window.yibiao?.config.load();
      const nextStatus = config?.image_model?.status || 'untested';
      const available = nextStatus === 'available';
      setImageModelStatus(nextStatus);
      setDraftGenerationOptions(normalizeGenerationOptions(contentGenerationOptions, available, leaves.length, isExpansionWorkflow));
      setGenerationDialogOpen(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取生成配置失败', 'error');
    }
  };

  const saveDraftGenerationOptions = async (showSuccess: boolean, imageAvailable = imageModelAvailable) => {
    const normalizedDraftOptions = normalizeGenerationOptions(draftGenerationOptions, imageAvailable, leaves.length, isExpansionWorkflow);
    const currentOptions = contentGenerationOptions
      ? { ...defaultContentGenerationOptions, ...contentGenerationOptions }
      : normalizeGenerationOptions(undefined, imageAvailable, leaves.length, isExpansionWorkflow);
    const nextOptions = paused ? currentOptions : normalizedDraftOptions;
    await onContentGenerationOptionsChange(nextOptions);
    setDraftGenerationOptions(normalizeGenerationOptions(nextOptions, imageAvailable, leaves.length, isExpansionWorkflow));

    if (showSuccess) {
      setGenerationDialogOpen(false);
      showToast('正文生成配置已保存', 'success');
    }

    return nextOptions;
  };

  const saveGenerationOptions = async () => {
    try {
      await saveDraftGenerationOptions(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '正文生成配置保存失败', 'error');
    }
  };

  // 打开 HTML 图片类型设置并建立独立草稿。
  const openHtmlImageTypesDialog = () => {
    setHtmlImageTypesDraft(draftGenerationOptions.htmlImageTypes);
    setHtmlImageTypesDialogOpen(true);
  };

  // 确认 HTML 图片类型设置并写回主配置草稿。
  const confirmHtmlImageTypes = () => {
    setDraftGenerationOptions((prev) => ({ ...prev, htmlImageTypes: htmlImageTypesDraft }));
    setHtmlImageTypesDialogOpen(false);
  };

  const pauseGeneration = async () => {
    if (!running) {
      return;
    }

    setPausePending(true);
    try {
      await window.yibiao?.tasks.pauseContentGeneration();
      showToast('正在暂停正文生成，当前 AI 请求完成后会停止调度新任务', 'info');
    } catch (error) {
      setPausePending(false);
      showToast(error instanceof Error ? error.message : '暂停正文生成失败', 'error');
    }
  };

  const resumeGeneration = async () => {
    if (!paused) {
      return;
    }

    try {
      await window.yibiao?.tasks.startContentGeneration({ resume: true });
      showToast('已继续正文生成任务', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '继续正文生成失败', 'error');
    }
  };

  const retryContentCorrection = async () => {
    if (!canRetryContentCorrection) {
      return;
    }

    try {
      await window.yibiao?.tasks.startContentGeneration({ retryContentCorrection: true });
      showToast(`${contentRetryTargetLabel}重试任务已在后台启动`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : `重试${contentRetryTargetLabel}失败`, 'error');
    }
  };

  // 只重新生成当前失败的正文小节，全部成功后由 Main 自动进入后续流程。
  const retryFailedSections = async () => {
    if (!awaitingContentDecision || !unresolvedCount || taskBlocksGeneration) return;
    try {
      await window.yibiao?.tasks.startContentGeneration({ retryFailedSections: true });
      trackConfigUsage({ content_generation_action: 'retry_failed_sections' });
      showToast('失败小节重试任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动失败小节重试失败', 'error');
    }
  };

  // 用户确认后忽略剩余失败或未完成小节，直接执行检查、字数调整和配图。
  const continuePostProcessing = async () => {
    if (!awaitingContentDecision || taskBlocksGeneration) return;
    try {
      await window.yibiao?.tasks.startContentGeneration({ continuePostProcessing: true });
      trackConfigUsage({ content_generation_action: 'continue_with_ignored_sections' });
      setContinuePostProcessingDialogOpen(false);
      showToast('后续处理任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动后续处理失败', 'error');
    }
  };

  const rerunIllustrations = async () => {
    if (!contentIllustrationPlan || taskBlocksGeneration) {
      return;
    }

    try {
      await window.yibiao?.tasks.startContentGeneration({ rerunIllustrations: true });
      trackConfigUsage({ content_generation_action: 'rerun_illustrations' });
      showToast('仅重新配图任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动仅重新配图任务失败', 'error');
    }
  };

  const handleGenerationButtonClick = () => {
    if (running) {
      void pauseGeneration();
      return;
    }
    if (paused) {
      void resumeGeneration();
      return;
    }
    if (canRetryContentCorrection) {
      void retryContentCorrection();
      return;
    }
    if (resolvedCount === leaves.length && leaves.length) {
      void openGenerationDialog();
      return;
    }
    void openGenerationDialog();
  };

  const launchContentGeneration = async ({
    savedGenerationOptions,
    nextImageModelAvailable,
    config,
    regenerate,
    contentGenerationAction,
    simulatePartialFailures = false,
  }: {
    savedGenerationOptions: ContentGenerationOptions;
    nextImageModelAvailable: boolean;
    config?: ClientConfig | null;
    regenerate: boolean;
    contentGenerationAction: ContentGenerationAction;
    simulatePartialFailures?: boolean;
  }) => {
    if (!outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }

    if (regenerate) {
      setEditingItemId(null);
      setIsPreviewing(false);
      setDraftContent('');
    }

    await window.yibiao?.tasks.startContentGeneration({
      regenerate,
      simulatePartialFailures,
      generationOptions: {
        useAiImages: nextImageModelAvailable && savedGenerationOptions.useAiImages,
        maxAiImages: savedGenerationOptions.maxAiImages,
        useMermaidImages: savedGenerationOptions.useMermaidImages,
        maxMermaidImages: savedGenerationOptions.maxMermaidImages,
        useHtmlImages: savedGenerationOptions.useHtmlImages,
        maxHtmlImages: savedGenerationOptions.maxHtmlImages,
        htmlImageTypes: savedGenerationOptions.htmlImageTypes,
        tableRequirement: savedGenerationOptions.tableRequirement,
        enableConsistencyAudit: savedGenerationOptions.enableConsistencyAudit,
        consistencyRepairMode: savedGenerationOptions.consistencyRepairMode,
        enableOriginalPlanCoverageAudit: isExpansionWorkflow && savedGenerationOptions.enableOriginalPlanCoverageAudit,
        originalPlanCoverageRepairMode: isExpansionWorkflow ? savedGenerationOptions.originalPlanCoverageRepairMode : undefined,
      },
    });
    trackConfigUsage({
      table_requirement: savedGenerationOptions.tableRequirement,
      use_mermaid_images: savedGenerationOptions.useMermaidImages,
      use_ai_images: nextImageModelAvailable && savedGenerationOptions.useAiImages,
      content_generation_action: contentGenerationAction,
      enable_consistency_audit: savedGenerationOptions.enableConsistencyAudit,
      consistency_repair_mode: savedGenerationOptions.enableConsistencyAudit ? savedGenerationOptions.consistencyRepairMode : undefined,
      enable_original_plan_coverage_audit: isExpansionWorkflow && savedGenerationOptions.enableOriginalPlanCoverageAudit,
      original_plan_coverage_repair_mode: isExpansionWorkflow && savedGenerationOptions.enableOriginalPlanCoverageAudit ? savedGenerationOptions.originalPlanCoverageRepairMode : undefined,
    }, config);
    setGenerationDialogOpen(false);
    showToast(simulatePartialFailures
      ? '随机失败模式正文生成任务已在后台启动'
      : regenerate ? '正文重新生成任务已在后台启动' : '正文生成任务已在后台启动', 'success');
  };

  const startGeneration = async (simulatePartialFailures = false) => {
    if (!outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }

    try {
      const config = await window.yibiao?.config.load();
      const nextImageModelStatus = config?.image_model?.status || 'untested';
      const nextImageModelAvailable = nextImageModelStatus === 'available';
      setImageModelStatus(nextImageModelStatus);
      const savedGenerationOptions = await saveDraftGenerationOptions(false, nextImageModelAvailable);
      const regenerate = leaves.length > 0 && resolvedCount === leaves.length;
      const contentGenerationAction: ContentGenerationAction = regenerate
          ? 'regenerate'
          : resolvedCount > 0
            ? 'continue'
            : 'start';
      await launchContentGeneration({ savedGenerationOptions, nextImageModelAvailable, config, regenerate, contentGenerationAction, simulatePartialFailures });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动正文生成任务失败', 'error');
    }
  };

  const startSectionRegeneration = async () => {
    if (!outlineData?.outline?.length || !requirementItem) {
      return;
    }

    try {
      const config = await window.yibiao?.config.load();
      const nextImageModelStatus = config?.image_model?.status || 'untested';
      const nextImageModelAvailable = nextImageModelStatus === 'available';
      const savedGenerationOptions = normalizeGenerationOptions(contentGenerationOptions, nextImageModelAvailable, leaves.length, isExpansionWorkflow);
      setImageModelStatus(nextImageModelStatus);
      await window.yibiao?.tasks.startContentGeneration({
        regenerate: true,
        targetItemId: requirementItem.id,
        requirement: regenerateRequirement,
        generationOptions: {
          useAiImages: nextImageModelAvailable && savedGenerationOptions.useAiImages,
          maxAiImages: savedGenerationOptions.maxAiImages,
          useMermaidImages: savedGenerationOptions.useMermaidImages,
          maxMermaidImages: savedGenerationOptions.maxMermaidImages,
          useHtmlImages: savedGenerationOptions.useHtmlImages,
          maxHtmlImages: savedGenerationOptions.maxHtmlImages,
          htmlImageTypes: savedGenerationOptions.htmlImageTypes,
          tableRequirement: savedGenerationOptions.tableRequirement,
          enableConsistencyAudit: savedGenerationOptions.enableConsistencyAudit,
          consistencyRepairMode: savedGenerationOptions.consistencyRepairMode,
          enableOriginalPlanCoverageAudit: isExpansionWorkflow && savedGenerationOptions.enableOriginalPlanCoverageAudit,
          originalPlanCoverageRepairMode: isExpansionWorkflow ? 'normal' : undefined,
        },
      });
      trackConfigUsage({
        table_requirement: savedGenerationOptions.tableRequirement,
        use_mermaid_images: savedGenerationOptions.useMermaidImages,
        use_ai_images: nextImageModelAvailable && savedGenerationOptions.useAiImages,
        content_generation_action: 'regenerate_section',
        enable_consistency_audit: savedGenerationOptions.enableConsistencyAudit,
        consistency_repair_mode: savedGenerationOptions.enableConsistencyAudit ? savedGenerationOptions.consistencyRepairMode : undefined,
        enable_original_plan_coverage_audit: isExpansionWorkflow && savedGenerationOptions.enableOriginalPlanCoverageAudit,
        original_plan_coverage_repair_mode: isExpansionWorkflow && savedGenerationOptions.enableOriginalPlanCoverageAudit ? 'normal' : undefined,
      }, config);
      setSelectedItemId(requirementItem.id);
      setRequirementItem(null);
      setRegenerateRequirement('');
      showToast('小节重新生成任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动小节重新生成失败', 'error');
    }
  };

  return {
    generationDialogOpen,
    setGenerationDialogOpen,
    continuePostProcessingDialogOpen,
    setContinuePostProcessingDialogOpen,
    draftGenerationOptions,
    setDraftGenerationOptions,
    htmlImageTypesDialogOpen,
    setHtmlImageTypesDialogOpen,
    htmlImageTypesDraft,
    setHtmlImageTypesDraft,
    requirementItem,
    setRequirementItem,
    regenerateRequirement,
    setRegenerateRequirement,
    openGenerationDialog,
    saveGenerationOptions,
    openHtmlImageTypesDialog,
    confirmHtmlImageTypes,
    retryFailedSections,
    continuePostProcessing,
    rerunIllustrations,
    handleGenerationButtonClick,
    startGeneration,
    startSectionRegeneration,
  };
}
