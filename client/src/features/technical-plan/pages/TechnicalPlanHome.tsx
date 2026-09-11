import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import DocumentAnalysisPage from './DocumentAnalysisPage';
import BidAnalysisPage from './BidAnalysisPage';
import OutlineEditPage from './OutlineEditPage';
import GlobalFactsPage from './GlobalFactsPage';
import ContentEditPage from './ContentEditPage';
import { ExportProgressDialog, ExportTemplateDialog, OutlineWordControlLeaveDialog, PetInstallDialog, SortLeaveDialog, WordControlWarningDialog, WorkflowSwitchDialog } from '../components/technicalPlanDialogs';
import type { WorkflowSwitchRequest } from '../components/technicalPlanDialogs';
import { useTechnicalPlanWorkflow } from '../hooks/useTechnicalPlanWorkflow';
import { useExportWord } from '../hooks/useExportWord';
import { bidAnalysisTasks, isMissingBidAnalysisResult } from '../services/bidAnalysisWorkflow';
import { trackPageView } from '../../../shared/analytics/analytics';
import { FloatingToolbar, ToolbarArrowLeftIcon, ToolbarArrowRightIcon, ToolbarDocumentIcon, ToolbarSparkleIcon, useToast } from '../../../shared/ui';
import type { BackgroundTaskState, ContentGenerationOptions, GlobalFactGroupState, GlobalFactsMode, SaveOutlineRequest, SaveOutlineSelectionRequest, TechnicalPlanState, TechnicalPlanStep, TechnicalPlanWorkflowKind } from '../../../shared/types/domains/technical-plan';
import { DEFAULT_OUTLINE_WORD_CONTROL_OPTIONS } from '../../../shared/types';
import type { OutlineItem, OutlineWordControlOptions } from '../../../shared/types';
import type { ExportFormatConfig } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import type { SectionId } from '../../../shared/types/navigation';
import { areRequiredBidAnalysisTasksReady, buildWordControlWarningDialog, hasRunningTechnicalPlanTask, hasWorkflowSpecificProgress, isOutlineLeafCountOutsideRange, workflowKindFromSection, workflowLabel } from '../technicalPlanHomeModel';
import type { WordControlWarningDialogState } from '../technicalPlanHomeModel';
import { collectLeafItems } from '../../../shared/utils/outlineMetrics';
import { applyTaskEventToState, trimTaskLogs, updateOutlineItemContent } from '../taskEventMapping';


interface TechnicalPlanHomeProps {
  workflowKind: TechnicalPlanWorkflowKind;
  registerLeaveGuard?: (guard: ((nextSection?: string) => Promise<boolean>) | null) => void;
  onSectionChange?: (section: SectionId) => void;
}

interface OutlineSortGuard {
  hasUnsavedSort: () => boolean;
  saveSort: () => Promise<void>;
  discardSort: () => void;
}





const PET_PLUGIN_ID = 'openbidkit-pet';

const steps: TechnicalPlanStep[] = [
  'document-analysis',
  'bid-analysis',
  'outline-generation',
  'global-facts',
  'content-edit',
  'expand',
];

const stepLabels: Record<TechnicalPlanStep, string> = {
  'document-analysis': '选择标书',
  'bid-analysis': '招标文件解析',
  'outline-generation': '目录生成',
  'global-facts': '全局事实设定',
  'content-edit': '生成正文',
  expand: '扩写改写',
};

const resetState = {
  workflowKind: 'technical-plan' as TechnicalPlanWorkflowKind,
  step: 'document-analysis' as TechnicalPlanStep,
  tenderFile: null,
  tenderFiles: [],
  originalPlanFile: null,
  projectOverview: '',
  techRequirements: '',
  bidAnalysisMode: 'key' as const,
  bidAnalysisSelectedTaskIds: [] as string[],
  bidAnalysisTasks: {},
  bidAnalysisProgress: 0,
  bidSectionMode: 'single' as const,
  bidSections: [],
  bidSectionExtractionStatus: 'idle' as const,
  bidSectionExtractionError: undefined,
  outlineMode: 'aligned' as const,
  outlineExpansionMode: 'ai-complement' as const,
  outlineWordControlOptions: { ...DEFAULT_OUTLINE_WORD_CONTROL_OPTIONS },
  outlineWordControlSnapshot: undefined,
  referenceKnowledgeDocumentIds: [] as string[],
  bidSectionExtractionTask: undefined,
  bidAnalysisTask: undefined,
  outlineGenerationTask: undefined,
  outlineAdjustmentTask: undefined,
  globalFactsMode: 'fabricate' as GlobalFactsMode,
  globalFactsTask: undefined,
  globalFactsAdjustmentTask: undefined,
  globalFacts: [] as GlobalFactGroupState[],
  contentGenerationTask: undefined,
  contentGenerationOptions: undefined,
  contentGenerationSections: {},
  contentGenerationPlans: {},
  contentIllustrationPlan: undefined,
  contentGenerationRuntime: undefined,
  bidTemplateExists: false,
  outlineData: null,
};



const MAX_UI_TASK_LOGS = 80;








function TechnicalPlanHome({ workflowKind, registerLeaveGuard, onSectionChange }: TechnicalPlanHomeProps) {
  const { hydrated, state, setState } = useTechnicalPlanWorkflow();
  const { showToast } = useToast();
  const [tenderMarkdown, setTenderMarkdown] = useState('');
  const [originalPlanMarkdown, setOriginalPlanMarkdown] = useState('');
  const [exportFormat, setExportFormat] = useState<ExportFormatConfig>(DEFAULT_EXPORT_FORMAT);

  const {
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
  } = useExportWord({ outlineData: state.outlineData, exportFormat, onSectionChange });
  const [sortLeaveDialogOpen, setSortLeaveDialogOpen] = useState(false);
  const [outlineWordControlLeaveDialogOpen, setOutlineWordControlLeaveDialogOpen] = useState(false);
  const [wordControlWarningDialog, setWordControlWarningDialog] = useState<WordControlWarningDialogState | null>(null);
  const [pendingWordControlWarningTaskId, setPendingWordControlWarningTaskId] = useState<string | null>(null);
  const [savingSortBeforeLeave, setSavingSortBeforeLeave] = useState(false);
  const [workflowSwitchRequest, setWorkflowSwitchRequest] = useState<WorkflowSwitchRequest | null>(null);
  const [switchingWorkflow, setSwitchingWorkflow] = useState(false);
  const [petInstallDialogOpen, setPetInstallDialogOpen] = useState(false);
  const [installingPetPlugin, setInstallingPetPlugin] = useState(false);
  const [bidAnalysisFocusRequest, setBidAnalysisFocusRequest] = useState<{ taskId: string } | null>(null);
  const [globalFactsFocusRequest, setGlobalFactsFocusRequest] = useState<{ groupId: string } | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const sortGuardRef = useRef<OutlineSortGuard | null>(null);
  const sortLeaveResolverRef = useRef<((allowed: boolean) => void) | null>(null);
  const outlineWordControlLeaveResolverRef = useRef<((allowed: boolean) => void) | null>(null);
  const shownWordControlWarningTaskIdsRef = useRef(new Set<string>());
  const workflowSwitchResolverRef = useRef<((allowed: boolean) => void) | null>(null);
  const skippedWorkflowSwitchPromptRef = useRef<TechnicalPlanWorkflowKind | null>(null);
  const lastExecutedWorkflowSwitchRef = useRef<TechnicalPlanWorkflowKind | null>(null);
  const activeIndex = steps.indexOf(state.step);
  const requiredBidAnalysisReady = areRequiredBidAnalysisTasksReady(state.bidAnalysisTasks);
  const isBidSectionExtractionRunning = state.bidSectionExtractionTask?.status === 'running' || state.bidSectionExtractionTask?.status === 'pausing';
  const isBidAnalysisTaskRunning = state.bidAnalysisTask?.status === 'running' || state.bidAnalysisTask?.status === 'pausing';
  const selectedBidSectionValid = state.bidSectionMode !== 'multiple'
    || Boolean(state.tenderFile?.selectedSectionId && state.bidSections.some((section) => section.id === state.tenderFile?.selectedSectionId));
  const bidSectionReady = state.bidSectionMode !== 'multiple'
    || (state.bidSectionExtractionStatus === 'success' && !isBidSectionExtractionRunning && selectedBidSectionValid);
  const bidAnalysisReady = requiredBidAnalysisReady && !isBidAnalysisTaskRunning && bidSectionReady;
  const firstMissingBidAnalysisTask = bidAnalysisTasks.find((task) => (
    state.bidAnalysisSelectedTaskIds.includes(task.id)
    && isMissingBidAnalysisResult(task, state.bidAnalysisTasks[task.id]?.content)
  ));
  const globalFactsReady = state.globalFacts.length > 0 && state.globalFactsTask?.status === 'success';
  const firstGlobalFactWithPlaceholder = state.globalFacts.find((group) => `${group.title || ''}${group.content || ''}`.includes('【待填写】'));
  const globalFactsHasPlaceholder = Boolean(firstGlobalFactWithPlaceholder);
  const isGlobalFactsAdjusting = state.globalFactsAdjustmentTask?.status === 'running' || state.globalFactsAdjustmentTask?.status === 'pausing';
  const contentTaskStatus = state.contentGenerationTask?.status;
  const isContentGenerating = contentTaskStatus === 'running' || contentTaskStatus === 'pausing';
  const isContentPaused = contentTaskStatus === 'paused';
  const requiresOriginalPlan = workflowKind === 'existing-plan-expansion';
  const isNextDisabled = activeIndex >= steps.length - 1
    || (state.step === 'document-analysis' && (!state.tenderFile || (requiresOriginalPlan && !state.originalPlanFile)))
    || (state.step === 'bid-analysis' && !bidAnalysisReady)
    || (state.step === 'outline-generation' && (!state.outlineData || !state.outlineWordControlSnapshot))
    || (state.step === 'global-facts' && (!globalFactsReady || isGlobalFactsAdjusting));
  const nextTooltip = state.step === 'document-analysis' && !state.tenderFile
      ? '上传完招标文件后才能进入下一步'
      : state.step === 'document-analysis' && requiresOriginalPlan && !state.originalPlanFile
        ? '上传完原方案后才能进入下一步'
        : state.step === 'bid-analysis' && isBidSectionExtractionRunning
          ? '多标段识别任务仍在运行，请等待当前任务结束'
          : state.step === 'bid-analysis' && state.bidSectionMode === 'multiple' && state.bidSectionExtractionStatus === 'error'
            ? '请重新识别标段或切回单标段'
            : state.step === 'bid-analysis' && state.bidSectionMode === 'multiple' && !selectedBidSectionValid
              ? '请先选择本次投标范围'
              : state.step === 'bid-analysis' && isBidAnalysisTaskRunning
                ? '招标文件解析任务仍在运行，请等待当前任务结束'
                : state.step === 'bid-analysis' && firstMissingBidAnalysisTask
                  ? `${firstMissingBidAnalysisTask.label}未提取到有效内容，点击后定位到该项`
                : state.step === 'bid-analysis' && !requiredBidAnalysisReady
                  ? '招标文件解析完成后才能进入目录生成'
                  : state.step === 'outline-generation' && !state.outlineData
                    ? '目录生成完成后才能进入全局事实设定'
                    : state.step === 'outline-generation' && !state.outlineWordControlSnapshot
                      ? '当前目录缺少字数控制生效配置，请重新生成目录'
                    : state.step === 'global-facts' && isGlobalFactsAdjusting
                      ? '全局事实正在 AI 调整，请等待结束后再进入正文生成'
                    : state.step === 'global-facts' && !globalFactsReady
                      ? '全局事实设定完成后才能进入正文生成'
                      : state.step === 'global-facts' && globalFactsHasPlaceholder
                        ? '请先将【待填写】替换为实际内容后再进入正文生成'
                        : activeIndex >= steps.length - 1
                          ? '当前已经是最后一步'
                          : `进入${stepLabels[steps[activeIndex + 1]]}`;

  const resolveSortLeave = (allowed: boolean) => {
    sortLeaveResolverRef.current?.(allowed);
    sortLeaveResolverRef.current = null;
    setSortLeaveDialogOpen(false);
  };

  const resolveOutlineWordControlLeave = (allowed: boolean) => {
    outlineWordControlLeaveResolverRef.current?.(allowed);
    outlineWordControlLeaveResolverRef.current = null;
    setOutlineWordControlLeaveDialogOpen(false);
  };

  const confirmOutlineWordControlLeave = () => {
    setOutlineWordControlLeaveDialogOpen(true);
    return new Promise<boolean>((resolve) => {
      outlineWordControlLeaveResolverRef.current = resolve;
    });
  };

  const executeWorkflowSwitch = useCallback(async (targetWorkflowKind: TechnicalPlanWorkflowKind) => {
    if (!window.yibiao?.technicalPlan.switchWorkflowKind) {
      showToast('技术方案工作流切换服务尚未初始化', 'error');
      return false;
    }

    try {
      setSwitchingWorkflow(true);
      await window.yibiao.technicalPlan.switchWorkflowKind(targetWorkflowKind);
      const saved = await window.yibiao.technicalPlan.loadState();
      lastExecutedWorkflowSwitchRef.current = targetWorkflowKind;
      setState((prev) => ({ ...prev, ...saved, workflowKind: targetWorkflowKind }));
      setOriginalPlanMarkdown('');
      showToast(`已切换到${workflowLabel(targetWorkflowKind)}`, 'success');
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : '切换技术方案工作流失败', 'error');
      return false;
    } finally {
      setSwitchingWorkflow(false);
    }
  }, [setState, showToast]);

  const resolveWorkflowSwitch = useCallback((allowed: boolean) => {
    const request = workflowSwitchRequest;
    workflowSwitchResolverRef.current?.(allowed);
    workflowSwitchResolverRef.current = null;
    setWorkflowSwitchRequest(null);
    if (!allowed && request?.navigateBackOnCancel) {
      skippedWorkflowSwitchPromptRef.current = request.to;
      onSectionChange?.(request.from);
    }
  }, [onSectionChange, workflowSwitchRequest]);

  const openWorkflowSwitchDialog = useCallback((targetWorkflowKind: TechnicalPlanWorkflowKind, navigateBackOnCancel: boolean) => {
    setWorkflowSwitchRequest({
      from: state.workflowKind,
      to: targetWorkflowKind,
      navigateBackOnCancel,
    });
    return new Promise<boolean>((resolve) => {
      workflowSwitchResolverRef.current = resolve;
    });
  }, [state.workflowKind]);

  const confirmSortLeaveOnly = useCallback(async () => {
    const guard = sortGuardRef.current;
    if (!guard?.hasUnsavedSort()) {
      return true;
    }

    setSortLeaveDialogOpen(true);
    return new Promise<boolean>((resolve) => {
      sortLeaveResolverRef.current = resolve;
    });
  }, []);

  const confirmPendingSortLeave = useCallback(async (nextSection?: string) => {
    const targetWorkflowKind = workflowKindFromSection(nextSection);
    if (!targetWorkflowKind || targetWorkflowKind === state.workflowKind) {
      return confirmSortLeaveOnly();
    }

    if (hasRunningTechnicalPlanTask(state)) {
      showToast('当前有技术方案任务正在运行，请等待任务结束后再切换模式', 'info');
      return false;
    }

    const sortAllowed = await confirmSortLeaveOnly();
    if (!sortAllowed) {
      return false;
    }

    if (hasWorkflowSpecificProgress(state)) {
      return openWorkflowSwitchDialog(targetWorkflowKind, false);
    }

    return executeWorkflowSwitch(targetWorkflowKind);
  }, [confirmSortLeaveOnly, executeWorkflowSwitch, openWorkflowSwitchDialog, showToast, state]);

  const continueSorting = () => {
    resolveSortLeave(false);
  };

  const discardSortAndLeave = () => {
    sortGuardRef.current?.discardSort();
    resolveSortLeave(true);
  };

  const saveSortAndLeave = async () => {
    const guard = sortGuardRef.current;
    if (!guard) {
      resolveSortLeave(true);
      return;
    }

    try {
      setSavingSortBeforeLeave(true);
      await guard.saveSort();
      resolveSortLeave(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存排序失败', 'error');
    } finally {
      setSavingSortBeforeLeave(false);
    }
  };

  const cancelWorkflowSwitch = () => {
    resolveWorkflowSwitch(false);
  };

  const confirmWorkflowSwitch = async () => {
    if (!workflowSwitchRequest) {
      return;
    }

    const switched = await executeWorkflowSwitch(workflowSwitchRequest.to);
    if (switched) {
      resolveWorkflowSwitch(true);
    }
  };

  useEffect(() => {
    if (!hydrated) return;

    trackPageView(`${workflowKind}/${state.step}`);
    void window.yibiao?.ui?.setCurrentView({ section: workflowKind, step: state.step });
  }, [hydrated, state.step, workflowKind]);

  useEffect(() => {
    if (!hydrated || state.workflowKind === workflowKind) return;
    if (skippedWorkflowSwitchPromptRef.current === workflowKind) return;
    if (lastExecutedWorkflowSwitchRef.current === state.workflowKind) return;
    if (workflowSwitchRequest || switchingWorkflow) return;

    const run = async () => {
      if (hasRunningTechnicalPlanTask(state)) {
        showToast('当前有技术方案任务正在运行，请等待任务结束后再切换模式', 'info');
        onSectionChange?.(state.workflowKind);
        return;
      }

      if (hasWorkflowSpecificProgress(state)) {
        await openWorkflowSwitchDialog(workflowKind, true);
        return;
      }

      const switched = await executeWorkflowSwitch(workflowKind);
      if (!switched) {
        onSectionChange?.(state.workflowKind);
      }
    };

    void run();
  }, [executeWorkflowSwitch, hydrated, onSectionChange, openWorkflowSwitchDialog, showToast, state, switchingWorkflow, workflowKind, workflowSwitchRequest]);

  useEffect(() => {
    if (state.workflowKind === workflowKind) {
      skippedWorkflowSwitchPromptRef.current = null;
      lastExecutedWorkflowSwitchRef.current = null;
    }
  }, [state.workflowKind, workflowKind]);

  useEffect(() => {
    if (!hydrated || wordControlWarningDialog) return;
    const currentStepTask = state.step === 'outline-generation'
      ? state.outlineGenerationTask
      : state.step === 'content-edit'
        ? state.contentGenerationTask
        : undefined;
    const task = pendingWordControlWarningTaskId
      ? [state.outlineGenerationTask, state.contentGenerationTask]
          .find((candidate) => candidate?.task_id === pendingWordControlWarningTaskId)
      : currentStepTask;
    if (!task || task.status !== 'success' || shownWordControlWarningTaskIdsRef.current.has(task.task_id)) return;
    const dialog = buildWordControlWarningDialog(task, state);
    if (!dialog) return;
    shownWordControlWarningTaskIdsRef.current.add(task.task_id);
    setPendingWordControlWarningTaskId(null);
    setWordControlWarningDialog(dialog);
  }, [hydrated, pendingWordControlWarningTaskId, state, wordControlWarningDialog]);

  useEffect(() => {
    let cancelled = false;
    window.yibiao?.config.load().then((cfg) => {
      if (!cancelled && cfg?.export_format) {
        setExportFormat(cfg.export_format);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!registerLeaveGuard) return;
    registerLeaveGuard(confirmPendingSortLeave);
    return () => registerLeaveGuard(null);
  }, [confirmPendingSortLeave, registerLeaveGuard]);

  const switchStep = async (step: TechnicalPlanStep) => {
    if (step === state.step) {
      return;
    }
    if (state.step === 'bid-analysis' && step === 'outline-generation' && firstMissingBidAnalysisTask) {
      setBidAnalysisFocusRequest({ taskId: firstMissingBidAnalysisTask.id });
      showToast(`“${firstMissingBidAnalysisTask.label}”自动重试后仍未提取到有效内容，请重新解析该项后再进入下一步`, 'info');
      return;
    }
    if (state.step === 'global-facts' && step === 'content-edit' && firstGlobalFactWithPlaceholder) {
      setGlobalFactsFocusRequest({ groupId: firstGlobalFactWithPlaceholder.id });
      showToast('存在待填写，请您改为真实数据后再继续', 'info');
      return;
    }
    const allowed = await confirmPendingSortLeave();
    if (!allowed) {
      return;
    }

    if (state.step === 'outline-generation' && step === 'global-facts') {
      const latestState = await window.yibiao!.technicalPlan.loadState();
      setState((prev) => ({ ...prev, ...latestState }));
      const finalOutlineData = latestState.outlineData;
      const snapshot = latestState.outlineWordControlSnapshot;
      if (finalOutlineData && !snapshot) {
        showToast('当前目录缺少字数控制生效配置，请重新生成目录后再进入下一步', 'info');
        return;
      }
      if (finalOutlineData && snapshot && isOutlineLeafCountOutsideRange(finalOutlineData, snapshot)) {
        const continueAnyway = await confirmOutlineWordControlLeave();
        if (!continueAnyway) return;
      }
    }

    setState((prev) => ({ ...prev, step }));
    window.yibiao?.technicalPlan.updateStep(step).catch((error) => {
      showToast(error instanceof Error ? error.message : '保存技术方案步骤失败', 'error');
    });
  };

  const goToOffset = async (offset: number) => {
    const nextStep = steps[activeIndex + offset];
    if (nextStep) {
      await switchStep(nextStep);
    }
  };

  useEffect(() => {
    if (!window.yibiao?.tasks) {
      return;
    }

    const unsubscribe = window.yibiao.tasks.onTaskEvent<typeof state>((event) => {
      const taskType = (event.task as { type?: string } | undefined)?.type;
      const latestTask = trimTaskLogs(event.task as BackgroundTaskState | undefined);
      const technicalPlan = event.technicalPlanPatch || event.technicalPlan;

      if (!technicalPlan) {
        return;
      }

      if (latestTask?.status === 'success' && !shownWordControlWarningTaskIdsRef.current.has(latestTask.task_id)) {
        const warning = latestTask.stats?.outline?.word_adjustment_warning || latestTask.stats?.content?.word_control_warning;
        if (warning) {
          setPendingWordControlWarningTaskId(latestTask.task_id);
        }
      }

      setState((prev) => applyTaskEventToState(prev, { taskType, latestTask, technicalPlan, event }));
    });
    window.yibiao.tasks.getActiveTasks().catch((error) => {
      console.warn('获取后台任务状态失败', error);
    });

    return unsubscribe;
  }, [setState, showToast]);

  useEffect(() => {
    if (state.step !== 'document-analysis') {
      return;
    }
    if (!state.tenderFile) {
      setTenderMarkdown('');
      return;
    }
    let mounted = true;
    window.yibiao?.technicalPlan.readTenderMarkdown().then((markdown) => {
      if (mounted) setTenderMarkdown(markdown || '');
    }).catch((error) => {
      if (mounted) showToast(error instanceof Error ? error.message : '读取招标文件 Markdown 失败', 'error');
    });
    return () => {
      mounted = false;
    };
  }, [showToast, state.step, state.tenderFile]);

  useEffect(() => {
    if (state.step !== 'document-analysis' || !requiresOriginalPlan) {
      setOriginalPlanMarkdown('');
      return;
    }
    if (!state.originalPlanFile) {
      setOriginalPlanMarkdown('');
      return;
    }
    let mounted = true;
    window.yibiao?.technicalPlan.readOriginalPlanMarkdown().then((markdown) => {
      if (mounted) setOriginalPlanMarkdown(markdown || '');
    }).catch((error) => {
      if (mounted) showToast(error instanceof Error ? error.message : '读取原方案 Markdown 失败', 'error');
    });
    return () => {
      mounted = false;
    };
  }, [requiresOriginalPlan, showToast, state.originalPlanFile, state.step]);







  const saveChapterContent = async (item: OutlineItem, content: string) => {
    if (!state.outlineData?.outline?.length) {
      throw new Error('当前没有可保存的目录');
    }

    const updatedOutlineData = {
      ...state.outlineData,
      outline: updateOutlineItemContent(state.outlineData.outline, item.id, content),
    };
    const updatedSections = {
      ...state.contentGenerationSections,
      [item.id]: {
        id: item.id,
        title: item.title || '未命名章节',
        status: content.trim() ? 'success' as const : 'idle' as const,
        content,
        updated_at: new Date().toISOString(),
      },
    };

    setState((prev) => ({
      ...prev,
      outlineData: updatedOutlineData,
      contentGenerationSections: updatedSections,
    }));
    const saved = await window.yibiao?.technicalPlan.saveChapterContent({ nodeId: item.id, content });
    if (saved) setState((prev) => ({ ...prev, ...saved }));
  };

  const resetTechnicalPlan = async () => {
    if (isResetting) return;
    if (!window.confirm('会清空整个技术方案编写进度，是否确认？')) {
      return;
    }

    setIsResetting(true);
    showToast('正在重置技术方案，将停止后台任务并清理工作区文件，请稍候…', 'info');
    try {
      const result = await window.yibiao?.technicalPlan.clear();
      setState({ ...resetState, workflowKind });
      setTenderMarkdown('');
      setOriginalPlanMarkdown('');
      showToast(result?.message || '技术方案已重置', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重置技术方案失败', 'error');
    } finally {
      setIsResetting(false);
    }
  };

  const saveContentGenerationOptions = async (contentGenerationOptions: ContentGenerationOptions) => {
    const saved = await window.yibiao?.technicalPlan.saveContentGenerationOptions(contentGenerationOptions);
    setState((prev) => ({ ...prev, ...(saved || {}), contentGenerationOptions }));
  };

  const saveGlobalFacts = async (globalFacts: GlobalFactGroupState[]) => {
    const saved = await window.yibiao?.technicalPlan.saveGlobalFacts(globalFacts);
    setState((prev) => ({ ...prev, ...(saved || {}), globalFacts }));
  };

  const saveGlobalFactsConfig = async (globalFactsMode: GlobalFactsMode) => {
    const saved = await window.yibiao?.technicalPlan.saveGlobalFactsConfig({ globalFactsMode });
    setState((prev) => ({ ...prev, ...(saved || {}), globalFactsMode }));
  };

  const saveOutline = async (request: SaveOutlineRequest) => {
    const saved = await window.yibiao?.technicalPlan.saveOutline(request);
    setState((prev) => {
      if (request.reason !== 'sort') {
        return { ...prev, ...(saved || {}), outlineData: saved?.outlineData || request.outlineData };
      }
      const contentGenerationSections = Object.fromEntries(Object.entries(prev.contentGenerationSections).map(([nodeId, section]) => {
        const nextId = request.idMap?.[nodeId] || nodeId;
        return [nextId, { ...section, id: nextId }];
      }));
      const contentGenerationPlans = Object.fromEntries(Object.entries(prev.contentGenerationPlans).map(([nodeId, plan]) => [
        request.idMap?.[nodeId] || nodeId,
        plan,
      ]));
      return {
        ...prev,
        ...(saved || {}),
        outlineData: saved?.outlineData || request.outlineData,
        contentGenerationSections,
        contentGenerationPlans,
      };
    });
  };

  const saveOutlineSelection = async (request: SaveOutlineSelectionRequest) => {
    await window.yibiao?.technicalPlan.saveOutlineSelection(request);
  };

  const openBidTemplate = async () => {
    const result = await window.yibiao?.technicalPlan.openBidTemplate();
    if (!result?.success) {
      showToast(result?.message || '无法打开投标模版', 'error');
    }
  };

  const saveOutlineConfig = async (config: {
    referenceKnowledgeDocumentIds: string[];
    outlineMode: TechnicalPlanState['outlineMode'];
    outlineExpansionMode: TechnicalPlanState['outlineExpansionMode'];
    wordControlOptions: OutlineWordControlOptions;
  }) => {
    await window.yibiao!.technicalPlan.saveOutlineConfig(config);
    setState((prev) => ({
      ...prev,
      outlineMode: config.outlineMode,
      outlineExpansionMode: config.outlineExpansionMode,
      outlineWordControlOptions: config.wordControlOptions,
      referenceKnowledgeDocumentIds: config.referenceKnowledgeDocumentIds,
    }));
  };

  const generatedContentCount = state.outlineData?.outline
    ? collectLeafItems(state.outlineData.outline).filter((item) => item.content?.trim()).length
    : 0;
  const outlineGenerationStatus = state.outlineGenerationTask?.status;
  const isOutlineGenerating = outlineGenerationStatus === 'running' || outlineGenerationStatus === 'pausing';
  const outlineAdjustmentStatus = state.outlineAdjustmentTask?.status;
  const isOutlineAdjusting = outlineAdjustmentStatus === 'running' || outlineAdjustmentStatus === 'pausing';
  const isGlobalFactsGenerating = state.globalFactsTask?.status === 'running' || state.globalFactsTask?.status === 'pausing';
  const isFactsAiStep = state.step === 'global-facts';
  const isAiAdjusting = isFactsAiStep ? isGlobalFactsAdjusting : isOutlineAdjusting;
  const aiAdjustDisabled = isFactsAiStep
    ? !state.globalFacts.length || isGlobalFactsGenerating || isGlobalFactsAdjusting
    : !state.outlineData || !state.outlineWordControlSnapshot || isOutlineGenerating || isOutlineAdjusting;
  const aiAdjustTooltip = isFactsAiStep
    ? (isGlobalFactsAdjusting
      ? 'AI 正在按要求调整全局事实，请稍候'
      : isGlobalFactsGenerating || !state.globalFacts.length
        ? '全局事实设定结束后才能使用 AI 调整'
        : '通过桌宠 AI 对话调整当前全局事实')
    : (isOutlineAdjusting
      ? 'AI 正在按要求调整目录，请稍候'
      : isOutlineGenerating || !state.outlineData
        ? '目录生成结束后才能使用 AI 调整'
        : !state.outlineWordControlSnapshot
          ? '当前目录缺少字数控制生效配置，请重新生成目录'
          : '通过桌宠 AI 对话调整当前目录');

  const openPetAiChat = useCallback(async () => {
    await window.yibiao!.plugins.notifyEvent(PET_PLUGIN_ID, 'open-ai-chat');
  }, []);

  const handleAiAdjustClick = useCallback(async () => {
    try {
      const plugins = await window.yibiao!.plugins.getAvailablePlugins();
      const pet = plugins.find((plugin) => plugin.id === PET_PLUGIN_ID);
      if (!pet) {
        showToast('插件市场中未找到桌宠插件，请在插件市场刷新后重试', 'error');
        return;
      }
      if (!pet.installed || !pet.enabled) {
        setPetInstallDialogOpen(true);
        return;
      }
      await openPetAiChat();
      showToast('请在桌宠对话框中输入调整要求', 'info');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开桌宠 AI 对话失败', 'error');
    }
  }, [openPetAiChat, showToast]);

  const installPetPluginAndOpenChat = useCallback(async () => {
    setInstallingPetPlugin(true);
    try {
      const plugins = await window.yibiao!.plugins.getAvailablePlugins();
      const pet = plugins.find((plugin) => plugin.id === PET_PLUGIN_ID);
      if (!pet) {
        throw new Error('插件市场中未找到桌宠插件');
      }
      if (!pet.installed) {
        await window.yibiao!.plugins.install(PET_PLUGIN_ID);
      }
      await window.yibiao!.plugins.enable(PET_PLUGIN_ID);
      setPetInstallDialogOpen(false);
      await openPetAiChat();
      showToast('桌宠已启用，请在桌宠对话框中输入调整要求', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '安装桌宠插件失败', 'error');
    } finally {
      setInstallingPetPlugin(false);
    }
  }, [openPetAiChat, showToast]);
  const workflowSwitchClearText = workflowSwitchRequest?.to === 'technical-plan'
    ? '原方案、目录、全局事实、正文和生成进度'
    : '目录、全局事实、正文和生成进度';

  const navigationActions = state.step === 'content-edit'
    ? [
      {
        id: 'previous-step',
        label: '上一步',
        icon: <ToolbarArrowLeftIcon />,
        disabled: activeIndex <= 0,
        tooltip: activeIndex <= 0 ? '当前已经是第一步' : `返回${stepLabels[steps[activeIndex - 1]]}`,
        onClick: () => { void goToOffset(-1); },
      },
      {
        id: 'export-word',
        label: isExporting ? '导出中...' : '导出 Word',
        icon: <ToolbarDocumentIcon />,
        variant: 'primary' as const,
        disabled: isContentGenerating || isExporting || !state.outlineData,
        tooltip: isContentGenerating ? '正文生成或暂停处理中，完成暂停后再导出' : isExporting ? 'Word 正在导出，请稍候' : isContentPaused ? '正文生成已暂停，可导出当前已完成内容' : generatedContentCount ? '导出当前技术方案正文' : '可导出空目录文档，建议先生成正文',
        onClick: () => { void openExportTemplateDialog(); },
      },
    ]
    : [
      {
        id: 'previous-step',
        label: '上一步',
        icon: <ToolbarArrowLeftIcon />,
        disabled: activeIndex <= 0,
        tooltip: activeIndex <= 0 ? '当前已经是第一步' : `返回${stepLabels[steps[activeIndex - 1]]}`,
        onClick: () => { void goToOffset(-1); },
      },
      {
        id: 'next-step',
        label: '下一步',
        icon: <ToolbarArrowRightIcon />,
        variant: 'primary' as const,
        disabled: isNextDisabled,
        tooltip: nextTooltip,
        onClick: () => { void goToOffset(1); },
      },
    ];

  const toolbarGroups = [
    {
      id: 'technical-plan-reset',
      actions: [
        {
          id: 'reset',
          label: isResetting ? '重置中...' : '重置',
          variant: 'danger' as const,
          disabled: isResetting,
          tooltip: isResetting ? '正在停止后台任务并清理工作区文件，请稍候' : '清空当前技术方案流程',
          onClick: resetTechnicalPlan,
        },
        {
          id: 'home',
          label: '首页',
          variant: state.step === 'document-analysis' ? 'primary' as const : 'secondary' as const,
          tooltip: '回到选择标书',
          onClick: () => { void switchStep('document-analysis'); },
        },
      ],
    },
    ...(state.step === 'outline-generation' || state.step === 'global-facts' ? [{
      id: 'technical-plan-ai',
      actions: [
        {
          id: 'ai-adjust',
          label: isAiAdjusting ? 'AI调整中' : 'AI调整',
          icon: <ToolbarSparkleIcon />,
          variant: 'ai' as const,
          disabled: aiAdjustDisabled,
          tooltip: aiAdjustTooltip,
          onClick: () => { void handleAiAdjustClick(); },
        },
      ],
    }] : []),
    {
      id: 'technical-plan-navigation',
      actions: navigationActions,
    },
  ];

  return (
    <div className="page-stack technical-workbench">
      {state.step === 'document-analysis' && (
        <DocumentAnalysisPage
          workflowKind={workflowKind}
          tenderFile={state.tenderFile}
          tenderFiles={state.tenderFiles || []}
          tenderMarkdown={tenderMarkdown}
          originalPlanFile={state.originalPlanFile}
          originalPlanMarkdown={originalPlanMarkdown}
          onFileImported={(nextState, markdown) => {
            setState((prev) => ({ ...prev, ...nextState }));
            setTenderMarkdown(markdown);
          }}
          onOriginalPlanImported={(nextState, markdown) => {
            setState((prev) => ({ ...prev, ...nextState }));
            setOriginalPlanMarkdown(markdown);
          }}
        />
      )}

      {state.step === 'bid-analysis' && (
        <BidAnalysisPage
          hasTenderFile={Boolean(state.tenderFile)}
          mode={state.bidAnalysisMode}
          selectedTaskIds={state.bidAnalysisSelectedTaskIds}
          bidSectionMode={state.bidSectionMode}
          bidSections={state.bidSections}
          bidSectionExtractionTask={state.bidSectionExtractionTask}
          bidSectionExtractionStatus={state.bidSectionExtractionStatus}
          bidSectionExtractionError={state.bidSectionExtractionError}
          selectedSectionTitle={state.tenderFile?.selectedSectionTitle}
          tasks={state.bidAnalysisTasks}
          task={state.bidAnalysisTask}
          progress={state.bidAnalysisProgress}
          focusTaskRequest={bidAnalysisFocusRequest}
          onProgressChange={(progress) => setState((prev) => ({ ...prev, bidAnalysisProgress: progress }))}
          onConfigSaved={(nextState) => setState((prev) => ({ ...prev, ...nextState }))}
        />
      )}
      {state.step === 'outline-generation' && (
          <OutlineEditPage
            workflowKind={workflowKind}
            projectOverview={state.projectOverview}
            outlineMode={state.outlineMode}
            outlineExpansionMode={state.outlineExpansionMode || 'ai-complement'}
          outlineWordControlOptions={state.outlineWordControlOptions}
          outlineWordControlSnapshot={state.outlineWordControlSnapshot}
          referenceKnowledgeDocumentIds={state.referenceKnowledgeDocumentIds}
          outlineData={state.outlineData}
          task={state.outlineGenerationTask}
          contentTaskStatus={state.contentGenerationTask?.status}
          aiAdjustmentRunning={isOutlineAdjusting}
          onOutlineConfigChange={saveOutlineConfig}
          onOutlineSaved={saveOutline}
          onOutlineSelectionSaved={saveOutlineSelection}
          bidTemplateExists={Boolean(state.bidTemplateExists)}
          onOpenBidTemplate={openBidTemplate}
          onSortGuardChange={(guard) => {
            sortGuardRef.current = guard;
          }}
        />
      )}
      {state.step === 'global-facts' && (
        <GlobalFactsPage
          outlineData={state.outlineData}
          globalFacts={state.globalFacts}
          globalFactsMode={state.globalFactsMode || 'fabricate'}
          task={state.globalFactsTask}
          aiAdjustmentRunning={isGlobalFactsAdjusting}
          focusGroupRequest={globalFactsFocusRequest}
          onGlobalFactsSaved={saveGlobalFacts}
          onGlobalFactsConfigChange={saveGlobalFactsConfig}
        />
      )}
      {state.step === 'content-edit' && (
        <ContentEditPage
          workflowKind={workflowKind}
          outlineWordControlSnapshot={state.outlineWordControlSnapshot}
          outlineData={state.outlineData}
          task={state.contentGenerationTask}
          contentGenerationOptions={state.contentGenerationOptions}
          contentIllustrationPlan={state.contentIllustrationPlan}
          sections={state.contentGenerationSections}
          onContentGenerationOptionsChange={saveContentGenerationOptions}
          onContentSaved={saveChapterContent}
        />
      )}
      {state.step === 'expand' && (
        <section className="empty-panel compact-placeholder">
          <div className="feature-under-development-overlay" role="status" aria-live="polite">
            <strong>正在开发中，敬请期待</strong>
            <span>此功能尚未完成，请先不要使用。</span>
          </div>
          <span className="section-kicker">STEP 06</span>
          <h3>扩写改写</h3>
          <p>后续接入旧方案导入、章节扩写和人工校准。</p>
        </section>
      )}








      <SortLeaveDialog
        open={sortLeaveDialogOpen}
        saving={savingSortBeforeLeave}
        onOpenChange={(open) => !open && continueSorting()}
        onContinue={continueSorting}
        onDiscard={discardSortAndLeave}
        onSave={saveSortAndLeave}
      />

      <WordControlWarningDialog
        dialog={wordControlWarningDialog}
        onClose={() => setWordControlWarningDialog(null)}
      />

      <PetInstallDialog
        open={petInstallDialogOpen}
        installing={installingPetPlugin}
        onClose={() => setPetInstallDialogOpen(false)}
        onInstall={installPetPluginAndOpenChat}
      />

      <OutlineWordControlLeaveDialog
        open={outlineWordControlLeaveDialogOpen}
        onResolve={resolveOutlineWordControlLeave}
      />

      <WorkflowSwitchDialog
        request={workflowSwitchRequest}
        switching={switchingWorkflow}
        clearText={workflowSwitchClearText}
        onCancel={cancelWorkflowSwitch}
        onConfirm={confirmWorkflowSwitch}
      />

      <ExportTemplateDialog
        open={exportTemplateDialogOpen}
        isExporting={isExporting}
        search={exportTemplateSearch}
        loading={exportTemplatesLoading}
        templates={exportTemplates}
        filteredTemplates={filteredExportTemplates}
        selectedTemplate={selectedExportTemplate}
        previewStyle={exportTemplatePreviewStyle}
        onOpenChange={(open) => !open && !isExporting && setExportTemplateDialogOpen(false)}
        onClose={() => setExportTemplateDialogOpen(false)}
        onSearchChange={setExportTemplateSearch}
        onSelect={setSelectedExportTemplateId}
        onCreate={createExportTemplate}
        onConfirm={confirmExportTemplate}
      />

      <ExportProgressDialog
        progress={exportProgress}
        onReset={resetExportProgress}
        onOpenFile={handleOpenExportedFile}
      />

      <FloatingToolbar groups={toolbarGroups} label="技术方案工具条" />
    </div>
  );
}

export default TechnicalPlanHome;
