// 废标项检查的「工作区域」：持久化状态 + 水合 / 落盘 / 后台任务事件 + 过期标记 + 自定义检查项。
//
// 抽离前这些内容散在 RejectionCheckPage 的组件体里：13 个 useState、5 个 useRef、9 个闭包、3 个 effect，
// 其中 applyWorkspaceState 一次要写 15 个 state —— 页面既装不下、也没法单独测。
//
// 边界：本 hook 只做「工作区数据」，向导步骤 / 分页 / 弹窗 / 上传忙碌位仍归页面。
// 因此把两件事做成注入：onRestoreViewState（水合后页面自己切步骤与分页）、onHydrated（页面据此开埋点）。

import { useEffect, useRef, useState } from 'react';
import { useToast } from '../../../shared/ui';
import {
  checkResultTabs,
  createEmptyExtractionState,
  createEmptyLogicCheckResultState,
  createEmptyRejectionCheckResultState,
  createEmptyTypoCheckResultState,
  defaultCheckOptions,
  normalizeBackgroundTaskState,
  normalizeCheckOptions,
  normalizeExtractionState,
  normalizeLogicCheckResultState,
  normalizeRejectionCheckResultState,
  normalizeTypoCheckResultState,
  stripTripleQuoteWrapper,
} from '../model';
import type {
  LogicCheckResultState,
  RejectionBackgroundTaskState,
  RejectionCheckOptions,
  RejectionCheckResultState,
  RejectionCheckResultTab,
  RejectionCheckStep,
  RejectionCheckWorkspacePatch,
  RejectionCheckWorkspaceState,
  RejectionDocumentContent,
  RejectionDocumentTabId,
  RejectionExtractionState,
  RejectionResultTab,
  TypoCheckResultState,
} from '../../../shared/types/domains/rejection-check';

export interface RestoredRejectionViewState {
  activeDocumentTab: RejectionDocumentTabId;
  step: RejectionCheckStep;
  activeResultTab: RejectionResultTab;
  activeCheckResultTab: RejectionCheckResultTab;
}

export interface UseRejectionWorkspaceOptions {
  step: RejectionCheckStep;
  activeDocumentTab: RejectionDocumentTabId;
  activeResultTab: RejectionResultTab;
  activeCheckResultTab: RejectionCheckResultTab;
  onRestoreViewState: (view: RestoredRejectionViewState) => void;
  onHydrated?: () => void;
}

export function useRejectionWorkspace({
  step,
  activeDocumentTab,
  activeResultTab,
  activeCheckResultTab,
  onRestoreViewState,
  onHydrated,
}: UseRejectionWorkspaceOptions) {
  const { showToast } = useToast();

  const [tenderDocument, setTenderDocument] = useState<RejectionDocumentContent | null>(null);
  const [tenderDocuments, setTenderDocuments] = useState<RejectionDocumentContent[]>([]);
  const [bidDocuments, setBidDocuments] = useState<RejectionDocumentContent[]>([]);
  const [invalidBidAndRejectionItems, setInvalidBidAndRejectionItems] = useState<RejectionExtractionState>(() => createEmptyExtractionState());
  const [rejectionCheckResult, setRejectionCheckResult] = useState<RejectionCheckResultState>(() => createEmptyRejectionCheckResultState());
  const [typoCheckResult, setTypoCheckResult] = useState<TypoCheckResultState>(() => createEmptyTypoCheckResultState());
  const [logicCheckResult, setLogicCheckResult] = useState<LogicCheckResultState>(() => createEmptyLogicCheckResultState());
  const [extractionTask, setExtractionTask] = useState<RejectionBackgroundTaskState | undefined>();
  const [checkTask, setCheckTask] = useState<RejectionBackgroundTaskState | undefined>();
  const [customCheckItems, setCustomCheckItems] = useState('');
  const [customCheckItemsDraft, setCustomCheckItemsDraft] = useState('');
  const [customCheckItemsSaving, setCustomCheckItemsSaving] = useState(false);
  const [checkOptions, setCheckOptions] = useState<RejectionCheckOptions>(defaultCheckOptions);
  const [draftCheckOptions, setDraftCheckOptions] = useState<RejectionCheckOptions>(defaultCheckOptions);
  const hydratedRef = useRef(false);
  const activeTaskTypesRef = useRef<Set<string> | null>(null);
  const customCheckItemsRef = useRef('');
  const customCheckItemsDraftRef = useRef('');
  const customCheckItemsSaveVersionRef = useRef(0);

  const extractionRunning = invalidBidAndRejectionItems.status === 'running' || extractionTask?.status === 'running';
  const rejectionCheckRunning = rejectionCheckResult.status === 'running';
  const typoCheckRunning = typoCheckResult.status === 'running';
  const logicCheckRunning = logicCheckResult.status === 'running';
  const backgroundCheckRunning = checkTask?.status === 'running';
  const checkRunning = rejectionCheckRunning || typoCheckRunning || logicCheckRunning || backgroundCheckRunning;
  const customCheckItemsDirty = customCheckItemsDraft !== customCheckItems;
  const customCheckItemsDisabled = extractionRunning || checkRunning || customCheckItemsSaving;

  function syncCustomCheckItemsFromWorkspace(value: unknown) {
    const nextValue = typeof value === 'string' ? value : '';
    const shouldSyncDraft = customCheckItemsDraftRef.current === customCheckItemsRef.current;
    customCheckItemsRef.current = nextValue;
    setCustomCheckItems(nextValue);
    if (shouldSyncDraft) {
      customCheckItemsDraftRef.current = nextValue;
      setCustomCheckItemsDraft(nextValue);
    }
  }

  function updateCustomCheckItemsDraft(value: string) {
    customCheckItemsDraftRef.current = value;
    setCustomCheckItemsDraft(value);
  }

  function applyWorkspaceState(state: RejectionCheckWorkspaceState, options: { syncViewState?: boolean } = {}) {
    const syncViewState = options.syncViewState !== false;
    setTenderDocument(state.tenderDocument || null);
    const nextTenderDocuments = Array.isArray(state.tenderDocuments) ? state.tenderDocuments : state.tenderDocument ? [state.tenderDocument] : [];
    setTenderDocuments(nextTenderDocuments);
    const nextBidDocuments = Array.isArray(state.bidDocuments) ? state.bidDocuments : [];
    setBidDocuments(nextBidDocuments);
    if (syncViewState) {
      const nextActiveDocumentTab = state.activeDocumentTab === 'tender'
        || nextTenderDocuments.some((document) => document.id === state.activeDocumentTab)
        || nextBidDocuments.some((document) => document.id === state.activeDocumentTab)
        ? state.activeDocumentTab
        : 'tender';
      onRestoreViewState({
        activeDocumentTab: nextActiveDocumentTab,
        step: state.step === 'items' || state.step === 'results' ? state.step : 'documents',
        activeResultTab: state.activeResultTab === 'custom' ? 'custom' : 'analysis',
        activeCheckResultTab: checkResultTabs.some((tab) => tab.id === state.activeCheckResultTab) ? state.activeCheckResultTab as RejectionCheckResultTab : 'rejection',
      });
    }
    setInvalidBidAndRejectionItems(normalizeExtractionState({
      ...(state.invalidBidAndRejectionItems || {}),
      content: stripTripleQuoteWrapper(state.invalidBidAndRejectionItems?.content || ''),
    }));
    setRejectionCheckResult(normalizeRejectionCheckResultState(state.rejectionCheckResult));
    setTypoCheckResult(normalizeTypoCheckResultState(state.typoCheckResult));
    setLogicCheckResult(normalizeLogicCheckResultState(state.logicCheckResult));
    setExtractionTask(normalizeBackgroundTaskState(state.extractionTask));
    setCheckTask(normalizeBackgroundTaskState(state.checkTask));
    syncCustomCheckItemsFromWorkspace(state.customCheckItems);
    const nextOptions = normalizeCheckOptions(state.checkOptions);
    setCheckOptions(nextOptions);
    setDraftCheckOptions(nextOptions);
  }

  function applyWorkspacePatch(patch: RejectionCheckWorkspacePatch) {
    const has = (field: keyof RejectionCheckWorkspaceState) => Object.prototype.hasOwnProperty.call(patch, field);
    if (has('tenderDocument')) setTenderDocument(patch.tenderDocument || null);
    if (has('tenderDocuments')) setTenderDocuments(Array.isArray(patch.tenderDocuments) ? patch.tenderDocuments : []);
    if (has('bidDocuments')) setBidDocuments(Array.isArray(patch.bidDocuments) ? patch.bidDocuments : []);
    if (has('invalidBidAndRejectionItems')) {
      setInvalidBidAndRejectionItems(normalizeExtractionState({
        ...(patch.invalidBidAndRejectionItems || {}),
        content: stripTripleQuoteWrapper(patch.invalidBidAndRejectionItems?.content || ''),
      }));
    }
    if (has('rejectionCheckResult')) {
      setRejectionCheckResult((prev) => patch.rejectionCheckResult === undefined
        ? createEmptyRejectionCheckResultState()
        : normalizeRejectionCheckResultState({ ...prev, ...patch.rejectionCheckResult }));
    }
    if (has('typoCheckResult')) {
      setTypoCheckResult((prev) => patch.typoCheckResult === undefined
        ? createEmptyTypoCheckResultState()
        : normalizeTypoCheckResultState({ ...prev, ...patch.typoCheckResult }));
    }
    if (has('logicCheckResult')) {
      setLogicCheckResult((prev) => patch.logicCheckResult === undefined
        ? createEmptyLogicCheckResultState()
        : normalizeLogicCheckResultState({ ...prev, ...patch.logicCheckResult }));
    }
    if (has('extractionTask')) setExtractionTask(normalizeBackgroundTaskState(patch.extractionTask));
    if (has('checkTask')) setCheckTask(normalizeBackgroundTaskState(patch.checkTask));
    if (has('customCheckItems')) syncCustomCheckItemsFromWorkspace(patch.customCheckItems);
    if (has('checkOptions')) {
      const nextOptions = normalizeCheckOptions(patch.checkOptions);
      setCheckOptions(nextOptions);
      setDraftCheckOptions(nextOptions);
    }
  }

  function persistRejectionState(partial: RejectionCheckWorkspacePatch, fallbackMessage: string) {
    void window.yibiao?.rejectionCheck.updateState(partial)
      .catch((error) => {
        showToast(error instanceof Error ? error.message : fallbackMessage, 'error');
      });
  }

  async function saveCustomCheckItems() {
    if (!customCheckItemsDirty || customCheckItemsDisabled) {
      return;
    }

    const saveUiState = window.yibiao?.rejectionCheck.saveUiState;
    if (typeof saveUiState !== 'function') {
      showToast('废标项检查缓存接口尚未加载，请重启应用后重试', 'error');
      return;
    }

    const nextCustomCheckItems = customCheckItemsDraftRef.current;
    const saveVersion = ++customCheckItemsSaveVersionRef.current;
    try {
      setCustomCheckItemsSaving(true);
      await saveUiState({ customCheckItems: nextCustomCheckItems });
      if (saveVersion !== customCheckItemsSaveVersionRef.current) {
        return;
      }
      customCheckItemsRef.current = nextCustomCheckItems;
      setCustomCheckItems(nextCustomCheckItems);
      showToast('自定义检查项已保存', 'success');
    } catch (error) {
      if (saveVersion !== customCheckItemsSaveVersionRef.current) {
        return;
      }
      showToast(error instanceof Error ? error.message : '保存自定义检查项失败', 'error');
    } finally {
      if (saveVersion === customCheckItemsSaveVersionRef.current) {
        setCustomCheckItemsSaving(false);
      }
    }
  }

  function markStaleTasksWithoutActive(activeTypes: Set<string>) {
    if (!activeTypes.has('rejection-items-extraction')) {
      markStaleExtractionTask();
    }
    if (!activeTypes.has('rejection-check-run')) {
      markStaleCheckTask();
    }
  }

  function markStaleExtractionTask() {
    setInvalidBidAndRejectionItems((prev) => prev.status === 'running'
      ? {
          ...prev,
          status: 'error',
          error: '上次解析未完成，请重新解析',
          updatedAt: new Date().toISOString(),
        }
      : prev);
    setExtractionTask((prev) => prev?.status === 'running'
      ? {
          ...prev,
          status: 'error',
          progress: 100,
          error: '上次解析未完成，请重新解析',
          logs: ['上次解析未完成，请重新解析。'],
          updated_at: new Date().toISOString(),
        }
      : prev);
  }

  function markStaleCheckTask() {
    const staleMessage = '上次检查未完成，请重新检查';
    const markResult = <T extends RejectionCheckResultState | TypoCheckResultState | LogicCheckResultState>(prev: T): T => (prev.status === 'running'
      ? {
          ...prev,
          status: 'error',
          error: staleMessage,
          progressMessage: staleMessage,
          updatedAt: new Date().toISOString(),
        }
      : prev);
    setRejectionCheckResult(markResult);
    setTypoCheckResult(markResult);
    setLogicCheckResult(markResult);
    setCheckTask((prev) => prev?.status === 'running'
      ? {
          ...prev,
          status: 'error',
          progress: 100,
          error: staleMessage,
          logs: [staleMessage],
          updated_at: new Date().toISOString(),
        }
      : prev);
  }

  useEffect(() => {
    let canceled = false;

    void window.yibiao?.rejectionCheck.loadState()
      .then((state) => {
        if (canceled || !state) return;
        applyWorkspaceState(state);
      })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '读取废标项检查缓存失败', 'error');
      })
      .finally(() => {
        if (!canceled) {
          hydratedRef.current = true;
          onHydrated?.();
          if (activeTaskTypesRef.current) {
            markStaleTasksWithoutActive(activeTaskTypesRef.current);
          }
        }
      });

    return () => {
      canceled = true;
    };
  }, [showToast]);

  useEffect(() => {
    if (!hydratedRef.current) return;

    void window.yibiao?.rejectionCheck.saveUiState({
      activeDocumentTab,
      step,
      activeResultTab,
      activeCheckResultTab,
      checkOptions,
    })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '保存废标项检查页面状态失败', 'error');
      });
  }, [activeCheckResultTab, activeDocumentTab, activeResultTab, checkOptions, showToast, step]);

  useEffect(() => {
    if (!window.yibiao?.tasks) {
      return;
    }

    const unsubscribe = window.yibiao.tasks.onTaskEvent<unknown, RejectionCheckWorkspaceState>((event) => {
      if (event.rejectionCheck) {
        applyWorkspaceState(event.rejectionCheck, { syncViewState: false });
      }
      if (event.rejectionCheckPatch) {
        applyWorkspacePatch(event.rejectionCheckPatch);
      }
    });

    void window.yibiao.tasks.getActiveTasks()
      .then((tasks) => {
        const activeTypes = new Set((Array.isArray(tasks) ? tasks : [])
          .map((task) => {
            const type = task && typeof task === 'object' ? (task as { type?: string }).type : '';
            return typeof type === 'string' ? type : '';
          }));
        activeTaskTypesRef.current = activeTypes;
        if (hydratedRef.current) {
          markStaleTasksWithoutActive(activeTypes);
        }
      })
      .catch((error) => {
        console.warn('获取废标项检查后台任务状态失败', error);
      });

    return unsubscribe;
  }, []);

  // 只重置工作区数据；向导步骤 / 分页 / 弹窗由页面自己收尾。
  function resetWorkspaceDomain() {
    customCheckItemsSaveVersionRef.current += 1;
    setTenderDocument(null);
    setTenderDocuments([]);
    setBidDocuments([]);
    setInvalidBidAndRejectionItems(createEmptyExtractionState());
    setRejectionCheckResult(createEmptyRejectionCheckResultState());
    setTypoCheckResult(createEmptyTypoCheckResultState());
    setLogicCheckResult(createEmptyLogicCheckResultState());
    setExtractionTask(undefined);
    setCheckTask(undefined);
    customCheckItemsRef.current = '';
    customCheckItemsDraftRef.current = '';
    setCustomCheckItems('');
    setCustomCheckItemsDraft('');
    setCustomCheckItemsSaving(false);
    setCheckOptions(defaultCheckOptions);
    setDraftCheckOptions(defaultCheckOptions);
  }

  return {
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
  };
}
