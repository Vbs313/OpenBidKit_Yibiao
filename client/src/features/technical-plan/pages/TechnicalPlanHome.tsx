import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import DocumentAnalysisPage from './DocumentAnalysisPage';
import BidAnalysisPage from './BidAnalysisPage';
import OutlineEditPage from './OutlineEditPage';
import GlobalFactsPage from './GlobalFactsPage';
import ContentEditPage from './ContentEditPage';
import { ExportProgressDialog, ExportTemplateDialog, OutlineWordControlLeaveDialog, PetInstallDialog, SortLeaveDialog, WordControlWarningDialog, WorkflowSwitchDialog } from '../components/technicalPlanDialogs';
import { useTechnicalPlanWorkflow } from '../hooks/useTechnicalPlanWorkflow';
import { useExportWord } from '../hooks/useExportWord';
import { useTechnicalPlanLeaveGuards } from '../hooks/useTechnicalPlanLeaveGuards';
import { usePetAiAdjust } from '../hooks/usePetAiAdjust';
import { useTechnicalPlanPersistence } from '../hooks/useTechnicalPlanPersistence';
import { bidAnalysisTasks, isMissingBidAnalysisResult } from '../services/bidAnalysisWorkflow';
import { trackPageView } from '../../../shared/analytics/analytics';
import { FloatingToolbar, ToolbarArrowLeftIcon, ToolbarArrowRightIcon, ToolbarDocumentIcon, ToolbarSparkleIcon, useToast } from '../../../shared/ui';
import type { BackgroundTaskState, GlobalFactGroupState, GlobalFactsMode, TechnicalPlanStep, TechnicalPlanWorkflowKind } from '../../../shared/types/domains/technical-plan';
import { DEFAULT_OUTLINE_WORD_CONTROL_OPTIONS } from '../../../shared/types';
import type { ExportFormatConfig } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import type { SectionId } from '../../../shared/types/navigation';
import { areRequiredBidAnalysisTasksReady, buildWordControlWarningDialog, isOutlineLeafCountOutsideRange } from '../technicalPlanHomeModel';
import type { WordControlWarningDialogState } from '../technicalPlanHomeModel';
import { collectLeafItems } from '../../../shared/utils/outlineMetrics';
import { applyTaskEventToState, trimTaskLogs } from '../taskEventMapping';


interface TechnicalPlanHomeProps {
  workflowKind: TechnicalPlanWorkflowKind;
  registerLeaveGuard?: (guard: ((nextSection?: string) => Promise<boolean>) | null) => void;
  onSectionChange?: (section: SectionId) => void;
}






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

  const {
    setSortGuard,
    sortLeaveDialogOpen,
    outlineWordControlLeaveDialogOpen,
    savingSortBeforeLeave,
    workflowSwitchRequest,
    switchingWorkflow,
    resolveOutlineWordControlLeave,
    confirmOutlineWordControlLeave,
    confirmPendingSortLeave,
    continueSorting,
    discardSortAndLeave,
    saveSortAndLeave,
    cancelWorkflowSwitch,
    confirmWorkflowSwitch,
  } = useTechnicalPlanLeaveGuards({
    hydrated,
    state,
    setState,
    workflowKind,
    onSectionChange,
    setOriginalPlanMarkdown,
    registerLeaveGuard,
    showToast,
  });

  const {
    saveChapterContent,
    saveContentGenerationOptions,
    saveGlobalFacts,
    saveGlobalFactsConfig,
    saveOutline,
    saveOutlineSelection,
    openBidTemplate,
    saveOutlineConfig,
  } = useTechnicalPlanPersistence({ state, setState, showToast });
  const [wordControlWarningDialog, setWordControlWarningDialog] = useState<WordControlWarningDialogState | null>(null);
  const [pendingWordControlWarningTaskId, setPendingWordControlWarningTaskId] = useState<string | null>(null);
  const {
    petInstallDialogOpen,
    setPetInstallDialogOpen,
    installingPetPlugin,
    isOutlineAdjusting,
    isAiAdjusting,
    aiAdjustDisabled,
    aiAdjustTooltip,
    handleAiAdjustClick,
    installPetPluginAndOpenChat,
  } = usePetAiAdjust({ state });
  const [bidAnalysisFocusRequest, setBidAnalysisFocusRequest] = useState<{ taskId: string } | null>(null);
  const [globalFactsFocusRequest, setGlobalFactsFocusRequest] = useState<{ groupId: string } | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const shownWordControlWarningTaskIdsRef = useRef(new Set<string>());
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


  useEffect(() => {
    if (!hydrated) return;

    trackPageView(`${workflowKind}/${state.step}`);
    void window.yibiao?.ui?.setCurrentView({ section: workflowKind, step: state.step });
  }, [hydrated, state.step, workflowKind]);

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


  const generatedContentCount = state.outlineData?.outline
    ? collectLeafItems(state.outlineData.outline).filter((item) => item.content?.trim()).length
    : 0;

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
          onSortGuardChange={setSortGuard}
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
