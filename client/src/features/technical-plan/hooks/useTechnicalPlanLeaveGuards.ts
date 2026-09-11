import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ToastType } from '../../../shared/ui';
import type { SectionId } from '../../../shared/types/navigation';
import type { TechnicalPlanState, TechnicalPlanWorkflowKind } from '../../../shared/types/domains/technical-plan';
import type { WorkflowSwitchRequest } from '../components/technicalPlanDialogs';
import { hasRunningTechnicalPlanTask, hasWorkflowSpecificProgress, workflowKindFromSection, workflowLabel } from '../technicalPlanHomeModel';

export interface OutlineSortGuard {
  hasUnsavedSort: () => boolean;
  saveSort: () => Promise<void>;
  discardSort: () => void;
}

interface UseTechnicalPlanLeaveGuardsParams {
  hydrated: boolean;
  state: TechnicalPlanState;
  setState: Dispatch<SetStateAction<TechnicalPlanState>>;
  workflowKind: TechnicalPlanWorkflowKind;
  onSectionChange?: (section: SectionId) => void;
  setOriginalPlanMarkdown: Dispatch<SetStateAction<string>>;
  registerLeaveGuard?: (guard: ((nextSection?: string) => Promise<boolean>) | null) => void;
  showToast: (message: string, type?: ToastType) => void;
}

// 离开页面 / 切换工作流的守卫簇：目录排序未保存、字数控制配置、模式切换确认。
// 三者共用同一个「弹窗 → Promise 解析」骨架，且互相回调（排序确认会拉起模式切换），
// 拆成三个 hook 只会让这条链散落回页面，所以整体保留在一个 hook 里。
export function useTechnicalPlanLeaveGuards({
  hydrated,
  state,
  setState,
  workflowKind,
  onSectionChange,
  setOriginalPlanMarkdown,
  registerLeaveGuard,
  showToast,
}: UseTechnicalPlanLeaveGuardsParams) {
  const [sortLeaveDialogOpen, setSortLeaveDialogOpen] = useState(false);
  const [outlineWordControlLeaveDialogOpen, setOutlineWordControlLeaveDialogOpen] = useState(false);
  const [savingSortBeforeLeave, setSavingSortBeforeLeave] = useState(false);
  const [workflowSwitchRequest, setWorkflowSwitchRequest] = useState<WorkflowSwitchRequest | null>(null);
  const [switchingWorkflow, setSwitchingWorkflow] = useState(false);
  const sortGuardRef = useRef<OutlineSortGuard | null>(null);
  const sortLeaveResolverRef = useRef<((allowed: boolean) => void) | null>(null);
  const outlineWordControlLeaveResolverRef = useRef<((allowed: boolean) => void) | null>(null);
  const workflowSwitchResolverRef = useRef<((allowed: boolean) => void) | null>(null);
  const skippedWorkflowSwitchPromptRef = useRef<TechnicalPlanWorkflowKind | null>(null);
  const lastExecutedWorkflowSwitchRef = useRef<TechnicalPlanWorkflowKind | null>(null);

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
    if (!registerLeaveGuard) return;
    registerLeaveGuard(confirmPendingSortLeave);
    return () => registerLeaveGuard(null);
  }, [confirmPendingSortLeave, registerLeaveGuard]);

  const setSortGuard = useCallback((guard: OutlineSortGuard | null) => {
    sortGuardRef.current = guard;
  }, []);

  return {
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
  };
}
