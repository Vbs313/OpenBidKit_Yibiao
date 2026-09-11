import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { trackPageView } from '../../../shared/analytics/analytics';
import { AppDialog, FloatingToolbar, ProgressBar, ToolbarArrowLeftIcon, ToolbarArrowRightIcon, ToolbarDocumentIcon, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import { useRejectionWorkspace } from '../hooks/useRejectionWorkspace';
import { useRejectionDocumentImport } from '../hooks/useRejectionDocumentImport';
import type { RejectionDocumentBusyState } from '../hooks/useRejectionDocumentImport';
import { BidResultFilter, LogicCheckContent, RejectionFindingGroups, TypoCheckContent } from '../components/resultViews';
import { DocumentsStepView, ItemsStepView } from '../components/stepViews';
import { CheckConfigDialog } from '../components/CheckConfigDialog';
import { hasExportableRejectionResults } from '../exportState';
import { buildCheckRunPlan, buildExtractionErrorState, buildExtractionStartPlan, markBackgroundTaskFailed, markCheckResultFailed } from '../checkRunModel';
import { deleteResultFinding, filterFindingsByActiveBid, toggleResultFinding } from '../findingModel';
import {
  steps,
  stepLabels,
  checkResultTabs,
  defaultCheckOptions,
  checkRunStatusLabels,
  RejectionCheckTabStatus,
  checkTabStatusLabels,
  createEmptyRejectionCheckResultState,
  normalizeCheckOptions,
  isCheckResultTabEnabled,
  getCheckResultTabProgress,
  createDocumentSignature,
  createRejectionCheckInputSignature,
  createBidDocumentsSignature,
} from '../model';
import type {
  RejectionCheckStep,
  RejectionCheckOptions,
  RejectionCheckResultTab,
  RejectionCheckRunStatus,
  RejectionDocumentTabId,
  RejectionResultTab,
  TypoCheckFinding,
} from '../../../shared/types/domains/rejection-check';

function escapeInlineHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function highlightMarkdownText(content: string, target: string) {
  if (!target) {
    return content;
  }

  const parts = content.split(target);
  if (parts.length <= 1) {
    return content;
  }

  return parts.map((part, index) => index < parts.length - 1
    ? `${part}<mark>${escapeInlineHtml(target)}</mark>`
    : part).join('');
}

function RejectionCheckPage() {
  const [step, setStep] = useState<RejectionCheckStep>('documents');
  const [activeDocumentTab, setActiveDocumentTab] = useState<RejectionDocumentTabId>('tender');
  const [activeResultTab, setActiveResultTab] = useState<RejectionResultTab>('analysis');
  const [activeCheckResultTab, setActiveCheckResultTab] = useState<RejectionCheckResultTab>('rejection');
  const [activeResultBidDocumentId, setActiveResultBidDocumentId] = useState('all');
  const [checkConfigDialogOpen, setCheckConfigDialogOpen] = useState(false);
  const [busy, setBusy] = useState<RejectionDocumentBusyState>(null);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [exportedExcelPath, setExportedExcelPath] = useState('');
  const [analyticsReady, setAnalyticsReady] = useState(false);

  // 工作区域（持久化状态 + 水合/落盘/后台任务事件）走独立 hook；页面只保留向导视图状态。
  const {
    tenderDocument,
    tenderDocuments,
    bidDocuments,
    invalidBidAndRejectionItems,
    rejectionCheckResult,
    typoCheckResult,
    logicCheckResult,
    extractionTask,
    checkTask,
    customCheckItems,
    customCheckItemsDraft,
    customCheckItemsSaving,
    checkOptions,
    draftCheckOptions,
    setInvalidBidAndRejectionItems,
    setRejectionCheckResult,
    setTypoCheckResult,
    setLogicCheckResult,
    setExtractionTask,
    setCheckTask,
    setCheckOptions,
    setDraftCheckOptions,
    hydratedRef,
    extractionRunning,
    checkRunning,
    customCheckItemsDirty,
    customCheckItemsDisabled,
    applyWorkspaceState,
    persistRejectionState,
    updateCustomCheckItemsDraft,
    saveCustomCheckItems,
    resetWorkspaceDomain,
  } = useRejectionWorkspace({
    step,
    activeDocumentTab,
    activeResultTab,
    activeCheckResultTab,
    onRestoreViewState: (view) => {
      setActiveDocumentTab(view.activeDocumentTab);
      setStep(view.step);
      setActiveResultTab(view.activeResultTab);
      setActiveCheckResultTab(view.activeCheckResultTab);
    },
    onHydrated: () => setAnalyticsReady(true),
  });
  const autoStartedSignatureRef = useRef('');
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();

  const activeTenderSourceDocument = tenderDocuments.find((document) => document.id === activeDocumentTab) || null;
  const activeBidDocument = bidDocuments.find((document) => document.id === activeDocumentTab) || null;
  const activeDocument = activeDocumentTab === 'tender' ? tenderDocument : activeTenderSourceDocument || activeBidDocument;
  const tenderSignature = useMemo(() => createDocumentSignature(tenderDocument), [tenderDocument]);
  const bidSignature = useMemo(() => createBidDocumentsSignature(bidDocuments), [bidDocuments]);
  const hasAnyDocument = Boolean(tenderDocument || bidDocuments.length);
  const checkOptionsChanged = checkOptions.typoCheck !== defaultCheckOptions.typoCheck
    || checkOptions.logicCheck !== defaultCheckOptions.logicCheck;
  const hasAnyWorkspaceData = Boolean(
    hasAnyDocument
    || invalidBidAndRejectionItems.content.trim()
    || rejectionCheckResult.status !== 'idle'
    || rejectionCheckResult.findings.length
    || typoCheckResult.status !== 'idle'
    || typoCheckResult.findings.length
    || logicCheckResult.status !== 'idle'
    || logicCheckResult.findings.length
    || extractionTask
    || checkTask
    || customCheckItemsDraft.trim()
    || checkOptionsChanged,
  );
  const canGoNext = Boolean(tenderDocument && bidDocuments.length);
  const activeIndex = steps.indexOf(step);
  const extractionMatchesTender = Boolean(tenderSignature && invalidBidAndRejectionItems.tenderSignature === tenderSignature);
  const visibleExtractionStatus = extractionMatchesTender ? invalidBidAndRejectionItems.status : 'idle';
  const visibleExtractionContent = extractionMatchesTender ? invalidBidAndRejectionItems.content : '';
  const hasCurrentExtraction = Boolean(
    visibleExtractionContent.trim(),
  );
  const resultSourceLabel = !extractionMatchesTender
    ? '等待解析'
    : invalidBidAndRejectionItems.source === 'technical-plan'
      ? '来自技术方案解析结果'
      : invalidBidAndRejectionItems.source === 'ai'
        ? '由废标项检查解析生成'
        : '等待解析';
  const activeCheckResult = checkResultTabs.find((tab) => tab.id === activeCheckResultTab) || checkResultTabs[0];
  const currentRejectionCheckInputSignature = useMemo(
    () => createRejectionCheckInputSignature(bidDocuments, visibleExtractionContent, customCheckItems),
    [bidDocuments, customCheckItems, visibleExtractionContent],
  );
  const rejectionCheckMatchesInput = Boolean(
    currentRejectionCheckInputSignature
    && rejectionCheckResult.inputSignature === currentRejectionCheckInputSignature,
  );
  const typoCheckMatchesInput = Boolean(
    bidSignature
    && typoCheckResult.inputSignature === bidSignature,
  );
  const logicCheckMatchesInput = Boolean(
    bidSignature
    && logicCheckResult.inputSignature === bidSignature,
  );
  const visibleRejectionCheckStatus: RejectionCheckRunStatus = rejectionCheckMatchesInput ? rejectionCheckResult.status : 'idle';
  const visibleRejectionFindings = rejectionCheckMatchesInput ? rejectionCheckResult.findings : [];
  const visibleTypoCheckStatus: RejectionCheckRunStatus = typoCheckMatchesInput ? typoCheckResult.status : 'idle';
  const visibleTypoFindings = typoCheckMatchesInput ? typoCheckResult.findings : [];
  const visibleLogicCheckStatus: RejectionCheckRunStatus = logicCheckMatchesInput ? logicCheckResult.status : 'idle';
  const visibleLogicFindings = logicCheckMatchesInput ? logicCheckResult.findings : [];
  const hasExportableCurrentResult = hasExportableRejectionResults({
    rejectionCheckResult,
    typoCheckResult,
    logicCheckResult,
    rejectionInputSignature: currentRejectionCheckInputSignature,
    bidSignature,
  });
  const documentsLocked = busy !== null || extractionRunning || checkRunning;
  const hasStaleRejectionCheckResult = Boolean(
    currentRejectionCheckInputSignature
    && rejectionCheckResult.inputSignature
    && rejectionCheckResult.inputSignature !== currentRejectionCheckInputSignature
    && (rejectionCheckResult.findings.length || rejectionCheckResult.status !== 'idle'),
  );
  const hasStaleTypoCheckResult = Boolean(
    bidSignature
    && typoCheckResult.inputSignature
    && typoCheckResult.inputSignature !== bidSignature
    && (typoCheckResult.findings.length || typoCheckResult.status !== 'idle'),
  );
  const hasStaleLogicCheckResult = Boolean(
    bidSignature
    && logicCheckResult.inputSignature
    && logicCheckResult.inputSignature !== bidSignature
    && (logicCheckResult.findings.length || logicCheckResult.status !== 'idle'),
  );

  const {
    resolveDroppedFilePaths,
    importParsedDocument,
    readTenderFromTechnicalPlan,
    removeDocument,
  } = useRejectionDocumentImport({
    documentsLocked,
    step,
    setBusy,
    setStep,
    applyWorkspaceState,
    showToast,
    showDocumentParseNotice,
  });


  useEffect(() => {
    if (!analyticsReady) return;

    const page = step === 'documents'
      ? `rejection-check/documents/${activeDocumentTab === 'tender' || activeTenderSourceDocument ? 'tender' : 'bid'}`
      : step === 'items'
        ? `rejection-check/items/${activeResultTab}`
        : `rejection-check/results/${activeCheckResultTab}`;
    trackPageView(page);
  }, [activeCheckResultTab, activeDocumentTab, activeResultTab, activeTenderSourceDocument, analyticsReady, step]);









  useEffect(() => {
    if (activeResultBidDocumentId !== 'all' && !bidDocuments.some((document) => document.id === activeResultBidDocumentId)) {
      setActiveResultBidDocumentId('all');
    }
  }, [activeResultBidDocumentId, bidDocuments]);

  useEffect(() => {
    if (!hydratedRef.current || step !== 'items' || !tenderDocument || !tenderSignature) {
      return;
    }

    if (extractionRunning) {
      return;
    }

    void prepareInvalidBidAndRejectionItems(false);
  }, [extractionRunning, invalidBidAndRejectionItems.content, invalidBidAndRejectionItems.source, invalidBidAndRejectionItems.tenderSignature, step, tenderDocument, tenderSignature]);

  async function prepareInvalidBidAndRejectionItems(force: boolean) {
    if (!tenderDocument || !tenderSignature) {
      showToast('请先准备招标文件', 'info');
      return;
    }

    if (!force) {
      if (hasCurrentExtraction) {
        return;
      }

      if (autoStartedSignatureRef.current === tenderSignature) {
        return;
      }

    }

    void startInvalidBidAndRejectionItemsExtraction(tenderSignature);
  }

  async function startInvalidBidAndRejectionItemsExtraction(signature: string) {
    if (!tenderDocument) {
      showToast('请先准备招标文件', 'info');
      return;
    }

    autoStartedSignatureRef.current = signature;
    const startedAt = new Date().toISOString();
    const { extractionState, extractionTask } = buildExtractionStartPlan(signature, startedAt, `local-${Date.now()}`);

    setInvalidBidAndRejectionItems(extractionState);
    setRejectionCheckResult(createEmptyRejectionCheckResultState());
    setExtractionTask(extractionTask);
    setCheckTask(undefined);

    try {
      const starter = window.yibiao?.tasks.startRejectionItemsExtraction;
      if (typeof starter !== 'function') {
        throw new Error('后台任务接口尚未加载，请重启应用后重试');
      }

      await starter({ tenderSignature: signature });
      showToast('无效与废标项解析任务已在后台启动', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '启动无效与废标项解析失败';
      setInvalidBidAndRejectionItems(buildExtractionErrorState(signature, message, new Date().toISOString()));
      setExtractionTask((prev) => markBackgroundTaskFailed(prev, message, new Date().toISOString()));
      showToast(message, 'error');
    }
  }

  function resetWorkspace() {
    autoStartedSignatureRef.current = '';
    resetWorkspaceDomain();
    setStep('documents');
    setActiveDocumentTab('tender');
    setActiveResultBidDocumentId('all');
    setActiveResultTab('analysis');
    setActiveCheckResultTab('rejection');
    setCheckConfigDialogOpen(false);
    void window.yibiao?.rejectionCheck.clear()
      .then(() => {
        showToast('已重置废标项检查文件', 'success');
      })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '清空废标项检查缓存失败', 'error');
      });
  }

  function openCheckConfigDialog() {
    setDraftCheckOptions(checkOptions);
    setCheckConfigDialogOpen(true);
  }

  function applyCheckOptions(options: RejectionCheckOptions) {
    setCheckOptions(options);
    if (!isCheckResultTabEnabled(activeCheckResultTab, options)) {
      setActiveCheckResultTab('rejection');
    }
  }

  function saveCheckOptions() {
    const nextOptions = normalizeCheckOptions(draftCheckOptions);
    applyCheckOptions(nextOptions);
    setCheckConfigDialogOpen(false);
    showToast('检查配置已保存', 'success');
  }


  function ensureCustomCheckItemsSaved() {
    if (!customCheckItemsDirty) {
      return true;
    }

    setStep('items');
    setActiveResultTab('custom');
    showToast('自定义检查项有未保存修改，请先保存', 'info');
    return false;
  }

  async function startChecks(options: RejectionCheckOptions = checkOptions, runOptions: RejectionCheckOptions = options) {
    if (checkRunning) {
      return;
    }

    if (!ensureCustomCheckItemsSaved()) {
      return;
    }

    if (!bidDocuments.length || !bidSignature) {
      showToast('请先准备至少一份投标文件', 'info');
      return;
    }

    if (runOptions.rejectionCheck && (visibleExtractionStatus !== 'success' || !visibleExtractionContent.trim())) {
      showToast('请先完成无效与废标项解析', 'info');
      setStep('items');
      return;
    }

    if (runOptions.rejectionCheck && !currentRejectionCheckInputSignature) {
      showToast('检查输入不完整，请确认投标文件和检查项', 'info');
      return;
    }

    if (!runOptions.rejectionCheck && !runOptions.typoCheck && !runOptions.logicCheck) {
      showToast('请至少启用一种检查', 'info');
      return;
    }

    const startedAt = new Date().toISOString();
    const plan = buildCheckRunPlan({
      runOptions,
      bidSignature,
      rejectionInputSignature: currentRejectionCheckInputSignature,
      startedAt,
      taskId: `local-${Date.now()}`,
      previousRejectionCheckResult: rejectionCheckResult,
      previousTypoCheckResult: typoCheckResult,
      previousLogicCheckResult: logicCheckResult,
    });

    setActiveCheckResultTab(plan.activeCheckResultTab);
    setActiveResultBidDocumentId('all');
    if (runOptions.rejectionCheck) {
      setRejectionCheckResult(plan.rejectionCheckResult);
    }

    if (runOptions.typoCheck) {
      setTypoCheckResult(plan.typoCheckResult);
    }

    if (runOptions.logicCheck) {
      setLogicCheckResult(plan.logicCheckResult);
    }

    setCheckTask(plan.checkTask);

    try {
      const starter = window.yibiao?.tasks.startRejectionCheck;
      if (typeof starter !== 'function') {
        throw new Error('后台任务接口尚未加载，请重启应用后重试');
      }

      await window.yibiao?.rejectionCheck.saveUiState({
        activeCheckResultTab: plan.activeCheckResultTab,
        checkOptions: options,
      });

      await starter({
        checkOptions: options,
        runOptions,
        customCheckItems,
      });
      showToast('检查任务已在后台启动', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '启动检查任务失败';
      const failedAt = new Date().toISOString();
      if (runOptions.rejectionCheck) {
        setRejectionCheckResult((prev) => markCheckResultFailed(prev, message, currentRejectionCheckInputSignature, failedAt));
      }
      if (runOptions.typoCheck) {
        setTypoCheckResult((prev) => markCheckResultFailed(prev, message, bidSignature, failedAt));
      }
      if (runOptions.logicCheck) {
        setLogicCheckResult((prev) => markCheckResultFailed(prev, message, bidSignature, failedAt));
      }
      setCheckTask((prev) => markBackgroundTaskFailed(prev, message, new Date().toISOString()));
      showToast(message, 'error');
    }
  }

  function startCheckWithOptions() {
    const nextOptions = normalizeCheckOptions(draftCheckOptions);
    applyCheckOptions(nextOptions);
    setCheckConfigDialogOpen(false);
    void startChecks(nextOptions);
  }

  function retrySingleCheck(tabId: RejectionCheckResultTab) {
    void startChecks(checkOptions, {
      rejectionCheck: tabId === 'rejection',
      typoCheck: tabId === 'typo',
      logicCheck: tabId === 'logic',
    });
  }

  function toggleFinding(findingId: string) {
    const next = toggleResultFinding(rejectionCheckResult, findingId, new Date().toISOString());
    setRejectionCheckResult(next);
    persistRejectionState({
      rejectionCheckResult: { activeFindingId: next.activeFindingId, updatedAt: next.updatedAt },
    }, '保存废标项结果状态失败');
  }

  function deleteFinding(findingId: string) {
    const next = deleteResultFinding(rejectionCheckResult, findingId, new Date().toISOString(), '需复核风险项', '风险项');
    setRejectionCheckResult(next);
    persistRejectionState({
      rejectionCheckResult: {
        findings: next.findings,
        activeFindingId: next.activeFindingId,
        progressMessage: next.progressMessage,
        updatedAt: next.updatedAt,
      },
    }, '保存废标项结果状态失败');
  }

  function toggleTypoFinding(findingId: string) {
    const next = toggleResultFinding(typoCheckResult, findingId, new Date().toISOString());
    setTypoCheckResult(next);
    persistRejectionState({
      typoCheckResult: { activeFindingId: next.activeFindingId, updatedAt: next.updatedAt },
    }, '保存错别字结果状态失败');
  }

  function deleteTypoFinding(findingId: string) {
    const next = deleteResultFinding(typoCheckResult, findingId, new Date().toISOString(), '疑似错别字', '错别字项');
    setTypoCheckResult(next);
    persistRejectionState({
      typoCheckResult: {
        findings: next.findings,
        activeFindingId: next.activeFindingId,
        progressMessage: next.progressMessage,
        updatedAt: next.updatedAt,
      },
    }, '保存错别字结果状态失败');
  }

  async function copyTypoOriginal(finding: TypoCheckFinding) {
    try {
      await navigator.clipboard.writeText(finding.originalExcerpt);
      showToast('已复制原文', 'success');
    } catch {
      showToast('复制原文失败', 'error');
    }
  }

  async function copyTypoWrong(finding: TypoCheckFinding) {
    try {
      await navigator.clipboard.writeText(finding.wrongText);
      showToast('已复制错字', 'success');
    } catch {
      showToast('复制错字失败', 'error');
    }
  }

  function toggleLogicFinding(findingId: string) {
    const next = toggleResultFinding(logicCheckResult, findingId, new Date().toISOString());
    setLogicCheckResult(next);
    persistRejectionState({
      logicCheckResult: { activeFindingId: next.activeFindingId, updatedAt: next.updatedAt },
    }, '保存逻辑谬误结果状态失败');
  }

  function deleteLogicFinding(findingId: string) {
    const next = deleteResultFinding(logicCheckResult, findingId, new Date().toISOString(), '逻辑问题', '逻辑问题');
    setLogicCheckResult(next);
    persistRejectionState({
      logicCheckResult: {
        findings: next.findings,
        activeFindingId: next.activeFindingId,
        progressMessage: next.progressMessage,
        updatedAt: next.updatedAt,
      },
    }, '保存逻辑谬误结果状态失败');
  }




  async function exportCheckResultsExcel() {
    if (!window.yibiao?.rejectionCheck?.exportExcel) {
      showToast('废标检查结果导出接口尚未加载，请重启应用后重试', 'error');
      return;
    }
    setExportingExcel(true);
    try {
      const result = await window.yibiao.rejectionCheck.exportExcel({
        rejectionInputSignature: currentRejectionCheckInputSignature,
        bidSignature,
      });
      if (result.canceled) return;
      if (!result.success || !result.path) {
        showToast(result.message || '废标检查结果导出失败', 'error');
        return;
      }
      setExportedExcelPath(result.path);
      showToast(result.message || '废标检查结果已导出', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '废标检查结果导出失败', 'error');
    } finally {
      setExportingExcel(false);
    }
  }

  async function openExportedExcelFile() {
    if (!exportedExcelPath) return;
    try {
      await window.yibiao.export.openFile(exportedExcelPath);
      setExportedExcelPath('');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开 Excel 文件失败', 'error');
    }
  }

  function switchStep(nextStep: RejectionCheckStep) {
    if (nextStep !== step && !ensureCustomCheckItemsSaved()) {
      return;
    }
    if (nextStep === 'items' && !canGoNext) {
      showToast('请先准备招标文件和投标文件', 'info');
      return;
    }
    setStep(nextStep);
  }

  function goToOffset(offset: number) {
    const nextStep = steps[activeIndex + offset];
    if (nextStep) {
      switchStep(nextStep);
    }
  }

  const hasVisibleCheckResult = visibleRejectionCheckStatus === 'success'
    || visibleRejectionCheckStatus === 'error'
    || visibleTypoCheckStatus === 'success'
    || visibleTypoCheckStatus === 'error'
    || visibleLogicCheckStatus === 'success'
    || visibleLogicCheckStatus === 'error';
  const checkActionLabel = checkRunning
    ? '检查中...'
    : hasVisibleCheckResult
      ? '重新检查'
      : '开始检查';
  const rejectionCheckSummaryText = visibleRejectionCheckStatus === 'running'
    ? rejectionCheckResult.progressMessage || 'AI 正在检查投标文件。'
    : visibleRejectionCheckStatus === 'error'
      ? rejectionCheckResult.error || '废标项检查失败，请重新检查。'
      : visibleRejectionCheckStatus === 'success'
        ? visibleRejectionFindings.length
          ? `发现 ${visibleRejectionFindings.length} 个需要复核的风险项。`
          : '暂未发现符合条件的废标项风险。'
          : hasStaleRejectionCheckResult
            ? '检查输入已变化，请重新检查以刷新结果。'
            : '点击开始检查后展示废标项检查结果。';
  const typoCheckSummaryText = visibleTypoCheckStatus === 'running'
    ? typoCheckResult.progressMessage || 'AI 正在识别并校验错别字。'
    : visibleTypoCheckStatus === 'error'
      ? typoCheckResult.error || '错别字检查失败，请重新检查。'
      : visibleTypoCheckStatus === 'success'
        ? visibleTypoFindings.length
          ? `发现 ${visibleTypoFindings.length} 个疑似错别字。`
          : '暂未发现明确错别字。'
        : hasStaleTypoCheckResult
          ? '投标文件已变化，请重新检查以刷新结果。'
          : '点击开始检查后展示错别字检查结果。';
  const logicCheckSummaryText = visibleLogicCheckStatus === 'running'
    ? logicCheckResult.progressMessage || 'AI 正在检查逻辑谬误。'
    : visibleLogicCheckStatus === 'error'
      ? logicCheckResult.error || '逻辑谬误检查失败，请重新检查。'
      : visibleLogicCheckStatus === 'success'
        ? visibleLogicFindings.length
          ? `发现 ${visibleLogicFindings.length} 个逻辑问题。`
          : '暂未发现明确逻辑谬误。'
        : hasStaleLogicCheckResult
          ? '投标文件已变化，请重新检查以刷新结果。'
          : '点击开始检查后展示逻辑谬误检查结果。';








  const toolbarGroups: FloatingToolbarGroup[] = [
    ...(step === 'results' ? [{
      id: 'rejection-check-export',
      actions: [{
        id: 'export-excel',
        label: exportingExcel ? '导出中...' : '导出 Excel',
        icon: <ToolbarDocumentIcon />,
        variant: 'success' as const,
        disabled: checkRunning || exportingExcel || !hasExportableCurrentResult,
        tooltip: checkRunning
          ? '请等待当前检查结束后再导出'
          : !hasExportableCurrentResult
            ? '没有当前检查输入对应的可导出结果'
            : '导出当前废标项、错别字和逻辑问题',
        onClick: () => { void exportCheckResultsExcel(); },
      }],
    }] : []),
    {
      id: 'rejection-check-reset',
      actions: [
        {
          id: 'reset',
          label: '重置',
          variant: 'danger',
          disabled: (!hasAnyWorkspaceData && step === 'documents') || documentsLocked,
          tooltip: '清空当前废标项检查文件',
          onClick: resetWorkspace,
        },
        {
          id: 'home',
          label: '首页',
          variant: step === 'documents' ? 'primary' : 'secondary',
          disabled: extractionRunning || checkRunning,
          tooltip: extractionRunning || checkRunning ? '请等待当前解析或检查结束后再返回' : '回到选择标书',
          onClick: () => switchStep('documents'),
        },
      ],
    },
    {
      id: 'rejection-check-navigation',
      actions: [
        {
          id: 'previous-step',
          label: '上一步',
          icon: <ToolbarArrowLeftIcon />,
          disabled: activeIndex <= 0 || extractionRunning || checkRunning,
          tooltip: activeIndex <= 0 ? '当前已经是第一步' : `返回${stepLabels[steps[activeIndex - 1]]}`,
          onClick: () => goToOffset(-1),
        },
        {
          id: 'next-step',
          label: '下一步',
          icon: <ToolbarArrowRightIcon />,
          variant: 'primary',
          disabled: activeIndex >= steps.length - 1 || (step === 'documents' && !canGoNext) || extractionRunning || checkRunning,
          tooltip: activeIndex >= steps.length - 1
            ? '当前已经是最后一步'
            : step === 'documents' && !canGoNext
              ? '请先准备招标文件和投标文件'
              : `进入${stepLabels[steps[activeIndex + 1]]}`,
          onClick: () => goToOffset(1),
        },
      ],
    },
  ];

  return (
    <div className={`rejection-check-page is-${step}`}>
      {step === 'documents' ? (
        <DocumentsStepView activeDocument={activeDocument} activeDocumentTab={activeDocumentTab} activeTenderSourceDocument={activeTenderSourceDocument} bidDocuments={bidDocuments} busy={busy} documentsLocked={documentsLocked} importParsedDocument={importParsedDocument} readTenderFromTechnicalPlan={readTenderFromTechnicalPlan} removeDocument={removeDocument} resolveDroppedFilePaths={resolveDroppedFilePaths} setActiveDocumentTab={setActiveDocumentTab} tenderDocuments={tenderDocuments} />
      ) : step === 'items' ? (
        <ItemsStepView activeResultTab={activeResultTab} checkRunning={checkRunning} customCheckItemsDirty={customCheckItemsDirty} customCheckItemsDisabled={customCheckItemsDisabled} customCheckItemsDraft={customCheckItemsDraft} customCheckItemsSaving={customCheckItemsSaving} extractionRunning={extractionRunning} invalidBidAndRejectionItems={invalidBidAndRejectionItems} prepareInvalidBidAndRejectionItems={prepareInvalidBidAndRejectionItems} resultSourceLabel={resultSourceLabel} saveCustomCheckItems={saveCustomCheckItems} setActiveResultTab={setActiveResultTab} tenderDocument={tenderDocument} updateCustomCheckItemsDraft={updateCustomCheckItemsDraft} visibleExtractionContent={visibleExtractionContent} visibleExtractionStatus={visibleExtractionStatus} />
      ) : (
        <>
          <section className="rejection-check-result-panel">
            <div className="duplicate-page-title rejection-check-result-title">
              <div>
                <span className="section-kicker">STEP 03</span>
                <h2>检查结果</h2>
              </div>
              <div className="rejection-check-result-actions">
                <button
                  type="button"
                  className="outline-config-action"
                  onClick={openCheckConfigDialog}
                  aria-label="打开检查配置"
                  title="检查配置"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
                    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.05.05a2 2 0 0 1-2.83 2.83l-.05-.05a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 0 1-4 0v-.08a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.05.05a2 2 0 0 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 0 1 0-4h.08A1.7 1.7 0 0 0 4.6 8.93a1.7 1.7 0 0 0-.34-1.87l-.05-.05a2 2 0 0 1 2.83-2.83l.05.05a1.7 1.7 0 0 0 1.87.34A1.7 1.7 0 0 0 10 3.01V3a2 2 0 0 1 4 0v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.05-.05a2 2 0 0 1 2.83 2.83l-.05.05a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 0 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="primary-action"
                  onClick={openCheckConfigDialog}
                  disabled={checkRunning || extractionRunning}
                >
                  {checkActionLabel}
                </button>
              </div>
            </div>

            <div className="rejection-check-result-tabs" role="tablist" aria-label="废标项检查结果类型">
              {checkResultTabs.map((tab) => {
                const isActive = tab.id === activeCheckResultTab;
                const enabled = isCheckResultTabEnabled(tab.id, checkOptions);
                const status: RejectionCheckTabStatus = !enabled
                  ? 'disabled'
                  : tab.id === 'rejection'
                    ? visibleRejectionCheckStatus
                    : tab.id === 'typo'
                      ? visibleTypoCheckStatus
                      : visibleLogicCheckStatus;
                const progressMessage = tab.id === 'rejection'
                  ? rejectionCheckResult.progressMessage
                  : tab.id === 'typo'
                    ? typoCheckResult.progressMessage
                    : logicCheckResult.progressMessage;
                const progress = getCheckResultTabProgress(status, progressMessage);
                return (
                  <button
                    type="button"
                    className={`rejection-check-result-tab${isActive ? ' is-active' : ''} is-${status}`}
                    role="tab"
                    aria-selected={isActive}
                    aria-controls={`rejection-check-result-panel-${tab.id}`}
                    id={`rejection-check-result-tab-${tab.id}`}
                    key={tab.id}
                    onClick={() => setActiveCheckResultTab(tab.id)}
                  >
                    <span className="duplicate-analysis-tab-main">
                      <strong>{tab.label}</strong>
                      <em>{checkTabStatusLabels[status]}</em>
                    </span>
                    <ProgressBar value={progress} label={`${tab.label}检查进度 ${progress}%`} />
                  </button>
                );
              })}
            </div>

            <div
              className={`rejection-check-result-content${isCheckResultTabEnabled(activeCheckResult.id, checkOptions) ? ' is-rejection-list' : ''}`}
              role="tabpanel"
              id={`rejection-check-result-panel-${activeCheckResult.id}`}
              aria-labelledby={`rejection-check-result-tab-${activeCheckResult.id}`}
            >
              {activeCheckResult.id === 'rejection' ? (
                <>
                  <div className="rejection-finding-summary">
                    <div>
                      <span className="section-kicker">废标项检查</span>
                      <h3>{visibleRejectionCheckStatus === 'running' ? '正在检查投标文件' : '废标项检查结果'}</h3>
                      <p>{rejectionCheckSummaryText}</p>
                    </div>
                    <div className={`rejection-result-status is-${visibleRejectionCheckStatus}`}>
                      <span>{checkRunStatusLabels[visibleRejectionCheckStatus]}</span>
                      <small>{visibleRejectionCheckStatus === 'success' ? `${visibleRejectionFindings.length} 个风险项` : rejectionCheckResult.progressMessage || '等待执行'}</small>
                    </div>
                  </div>
                  <BidResultFilter bidDocuments={bidDocuments} activeResultBidDocumentId={activeResultBidDocumentId} setActiveResultBidDocumentId={setActiveResultBidDocumentId} findings={visibleRejectionFindings} />

                  {visibleRejectionCheckStatus === 'running' ? (
                    <div className="markdown-empty-state rejection-finding-empty">
                      <strong>AI 正在执行三轮检查</strong>
                      <p>{rejectionCheckResult.progressMessage || '正在分析检查范围、逐项核查投标文件并补充定稿。'}</p>
                    </div>
                  ) : visibleRejectionCheckStatus === 'error' ? (
                    <div className="markdown-empty-state rejection-finding-empty is-error">
                      <strong>{rejectionCheckResult.error || '废标项检查失败'}</strong>
                      <p>请确认模型配置可用，或重新检查当前投标文件。</p>
                      <button type="button" className="secondary-action" onClick={() => retrySingleCheck('rejection')} disabled={checkRunning || extractionRunning || !bidDocuments.length || visibleExtractionStatus !== 'success' || !currentRejectionCheckInputSignature}>
                        重新检查废标项
                      </button>
                    </div>
                  ) : filterFindingsByActiveBid(visibleRejectionFindings, activeResultBidDocumentId).length ? (
                    <RejectionFindingGroups bidDocuments={bidDocuments} activeResultBidDocumentId={activeResultBidDocumentId} rejectionCheckResult={rejectionCheckResult} toggleFinding={toggleFinding} deleteFinding={deleteFinding} findings={visibleRejectionFindings} />
                  ) : (
                    <div className="markdown-empty-state rejection-finding-empty">
                      <strong>{visibleRejectionCheckStatus === 'success' ? '暂未发现废标项风险' : hasStaleRejectionCheckResult ? '检查输入已变化' : '等待废标项检查'}</strong>
                      <p>{rejectionCheckSummaryText}</p>
                    </div>
                  )}
                </>
              ) : activeCheckResult.id === 'typo' ? <TypoCheckContent checkOptions={checkOptions} visibleTypoCheckStatus={visibleTypoCheckStatus} typoCheckSummaryText={typoCheckSummaryText} visibleTypoFindings={visibleTypoFindings} typoCheckResult={typoCheckResult} bidDocuments={bidDocuments} activeResultBidDocumentId={activeResultBidDocumentId} setActiveResultBidDocumentId={setActiveResultBidDocumentId} checkRunning={checkRunning} extractionRunning={extractionRunning} retrySingleCheck={retrySingleCheck} hasStaleTypoCheckResult={hasStaleTypoCheckResult} toggleTypoFinding={toggleTypoFinding} deleteTypoFinding={deleteTypoFinding} copyTypoOriginal={copyTypoOriginal} copyTypoWrong={copyTypoWrong} /> : <LogicCheckContent checkOptions={checkOptions} visibleLogicCheckStatus={visibleLogicCheckStatus} logicCheckSummaryText={logicCheckSummaryText} visibleLogicFindings={visibleLogicFindings} logicCheckResult={logicCheckResult} bidDocuments={bidDocuments} activeResultBidDocumentId={activeResultBidDocumentId} setActiveResultBidDocumentId={setActiveResultBidDocumentId} checkRunning={checkRunning} extractionRunning={extractionRunning} retrySingleCheck={retrySingleCheck} hasStaleLogicCheckResult={hasStaleLogicCheckResult} toggleLogicFinding={toggleLogicFinding} deleteLogicFinding={deleteLogicFinding} />}
            </div>
          </section>

          <CheckConfigDialog checkConfigDialogOpen={checkConfigDialogOpen} setCheckConfigDialogOpen={setCheckConfigDialogOpen} draftCheckOptions={draftCheckOptions} setDraftCheckOptions={setDraftCheckOptions} checkRunning={checkRunning} extractionRunning={extractionRunning} bidDocuments={bidDocuments} visibleExtractionStatus={visibleExtractionStatus} currentRejectionCheckInputSignature={currentRejectionCheckInputSignature} checkActionLabel={checkActionLabel} saveCheckOptions={saveCheckOptions} startCheckWithOptions={startCheckWithOptions} />
        </>
      )}

      <AppDialog
        open={Boolean(exportedExcelPath)}
        onOpenChange={(open) => !open && setExportedExcelPath('')}
        kicker="导出完成"
        title="废标检查结果已导出"
        description={exportedExcelPath ? `文件已保存到：${exportedExcelPath}` : undefined}
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setExportedExcelPath('')}>稍后打开</button>
            <button type="button" className="primary-action" onClick={() => { void openExportedExcelFile(); }}>打开文件</button>
          </>
        )}
      />

      <FloatingToolbar groups={toolbarGroups} label="废标项检查工具条" />
    </div>
  );
}

export default RejectionCheckPage;
