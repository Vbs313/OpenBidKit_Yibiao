import type { Dispatch, SetStateAction } from 'react';
import { useToast } from '../../../shared/ui';
import type { FeasibilityOutlineTemplate, FeasibilityProjectInfo, FeasibilityReportState, FeasibilityReportStep } from '../../../shared/types/domains/feasibility-report';
import { FEASIBILITY_STEPS } from '../../../shared/types/domains/feasibility-report';

interface UseFeasibilityReportActionsParams {
  state: FeasibilityReportState;
  setState: Dispatch<SetStateAction<FeasibilityReportState>>;
  draftProjectInfo: FeasibilityProjectInfo;
  setDraftProjectInfo: Dispatch<SetStateAction<FeasibilityProjectInfo>>;
  analysisDraft: string;
  setAnalysisDraft: Dispatch<SetStateAction<string>>;
  parametersDraft: string;
  setParametersDraft: Dispatch<SetStateAction<string>>;
  activeIndex: number;
  setBusyImport: Dispatch<SetStateAction<boolean>>;
  setSaving: Dispatch<SetStateAction<boolean>>;
}

function sameProjectInfo(left: FeasibilityProjectInfo, right: FeasibilityProjectInfo) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// 可研各步骤的持久化出口与步骤动作：草稿在页面、落盘在这里，
// 页面只把 handler 接给子页面，不直接调 window.yibiao.feasibilityReport.*。
export function useFeasibilityReportActions({
  state,
  setState,
  draftProjectInfo,
  setDraftProjectInfo,
  analysisDraft,
  setAnalysisDraft,
  parametersDraft,
  setParametersDraft,
  activeIndex,
  setBusyImport,
  setSaving,
}: UseFeasibilityReportActionsParams) {
  const { showToast } = useToast();

  const applyLoadedState = (next: FeasibilityReportState) => {
    setState(next);
    setDraftProjectInfo(next.projectInfo);
    setAnalysisDraft(next.analysisMarkdown);
    setParametersDraft(next.keyParametersMarkdown);
  };

  const persistProjectInfoIfNeeded = async () => {
    if (sameProjectInfo(draftProjectInfo, state.projectInfo)) {
      return state;
    }
    const saved = await window.yibiao!.feasibilityReport.saveProjectInfo(draftProjectInfo);
    applyLoadedState(saved);
    return saved;
  };

  const persistAnalysisIfNeeded = async () => {
    if (analysisDraft === state.analysisMarkdown) return;
    const next = await window.yibiao!.feasibilityReport.saveAnalysis(analysisDraft);
    applyLoadedState(next);
  };

  const persistParametersIfNeeded = async () => {
    if (parametersDraft === state.keyParametersMarkdown) return;
    const next = await window.yibiao!.feasibilityReport.saveKeyParameters(parametersDraft);
    applyLoadedState(next);
  };

  const switchStep = async (step: FeasibilityReportStep) => {
    if (step !== 'materials' && !draftProjectInfo.projectName.trim()) {
      showToast('请先填写项目名称', 'info');
      return;
    }
    const movingForward = FEASIBILITY_STEPS.indexOf(step) > activeIndex;
    try {
      if (state.step === 'materials') {
        await persistProjectInfoIfNeeded();
      }
      if (movingForward && state.step === 'analysis') {
        await persistAnalysisIfNeeded();
      }
      if (movingForward && state.step === 'parameters') {
        await persistParametersIfNeeded();
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存当前步骤失败', 'error');
      return;
    }
    setState((prev) => ({ ...prev, step }));
    window.yibiao?.feasibilityReport.updateStep(step).catch((error) => {
      showToast(error instanceof Error ? error.message : '保存步骤失败', 'error');
    });
  };

  const goToOffset = async (offset: number) => {
    const next = FEASIBILITY_STEPS[activeIndex + offset];
    if (next) await switchStep(next);
  };

  const importSources = async (filePaths?: string[]) => {
    setBusyImport(true);
    try {
      const result = await window.yibiao!.feasibilityReport.importSourceDocuments(filePaths);
      if (!result?.success) {
        showToast(result?.message || '未导入文件', result?.message === '已取消选择' ? 'info' : 'error');
        return;
      }
      applyLoadedState(await window.yibiao!.feasibilityReport.loadState());
      showToast(result.message || '资料已导入', 'success');
    } finally {
      setBusyImport(false);
    }
  };

  const removeSource = async (sourceId: string) => {
    const result = await window.yibiao!.feasibilityReport.removeSourceDocument(sourceId);
    if (!result.success) {
      showToast(result.message || '移除失败', 'error');
      return;
    }
    applyLoadedState(await window.yibiao!.feasibilityReport.loadState());
    showToast(result.message || '已移除资料', 'success');
  };

  const startAnalysis = async () => {
    try {
      await persistProjectInfoIfNeeded();
      await window.yibiao!.tasks.startFeasibilityAnalysis();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动分析失败', 'error');
    }
  };

  const saveAnalysis = async () => {
    setSaving(true);
    try {
      const next = await window.yibiao!.feasibilityReport.saveAnalysis(analysisDraft);
      applyLoadedState(next);
      showToast('资料分析已保存', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存分析失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const startOutline = async (config: {
    outlineTemplate: FeasibilityOutlineTemplate;
    targetWords: number;
    referenceDocumentIds: string[];
  }) => {
    try {
      await window.yibiao!.tasks.startFeasibilityOutline(config);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动目录生成失败', 'error');
    }
  };

  const saveKeyParameters = async () => {
    setSaving(true);
    try {
      const next = await window.yibiao!.feasibilityReport.saveKeyParameters(parametersDraft);
      applyLoadedState(next);
      showToast('关键参数已保存', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存关键参数失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  return {
    applyLoadedState,
    goToOffset,
    importSources,
    removeSource,
    startAnalysis,
    saveAnalysis,
    startOutline,
    saveKeyParameters,
  };
}
