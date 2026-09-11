import type { ToastType } from '../../../shared/ui';
import type { TypoCheckFinding } from '../../../shared/types/domains/rejection-check';
import { deleteResultFinding, toggleResultFinding } from '../findingModel';
import type { useRejectionWorkspace } from './useRejectionWorkspace';

type RejectionWorkspace = ReturnType<typeof useRejectionWorkspace>;

interface UseRejectionFindingActionsParams {
  rejectionCheckResult: RejectionWorkspace['rejectionCheckResult'];
  typoCheckResult: RejectionWorkspace['typoCheckResult'];
  logicCheckResult: RejectionWorkspace['logicCheckResult'];
  setRejectionCheckResult: RejectionWorkspace['setRejectionCheckResult'];
  setTypoCheckResult: RejectionWorkspace['setTypoCheckResult'];
  setLogicCheckResult: RejectionWorkspace['setLogicCheckResult'];
  persistRejectionState: RejectionWorkspace['persistRejectionState'];
  showToast: (message: string, type?: ToastType) => void;
}

// 三类检查结果的增删改动作：形状相同、只差文案与目标 state，集中在这里避免页面里再抄三遍。
export function useRejectionFindingActions({
  rejectionCheckResult,
  typoCheckResult,
  logicCheckResult,
  setRejectionCheckResult,
  setTypoCheckResult,
  setLogicCheckResult,
  persistRejectionState,
  showToast,
}: UseRejectionFindingActionsParams) {
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

  return {
    toggleFinding,
    deleteFinding,
    toggleTypoFinding,
    deleteTypoFinding,
    copyTypoOriginal,
    copyTypoWrong,
    toggleLogicFinding,
    deleteLogicFinding,
  };
}
