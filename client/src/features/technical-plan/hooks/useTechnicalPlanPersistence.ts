import type { Dispatch, SetStateAction } from 'react';
import type { ToastType } from '../../../shared/ui';
import type { ContentGenerationOptions, GlobalFactGroupState, GlobalFactsMode, SaveOutlineRequest, SaveOutlineSelectionRequest, TechnicalPlanState } from '../../../shared/types/domains/technical-plan';
import type { OutlineItem, OutlineWordControlOptions } from '../../../shared/types';
import { updateOutlineItemContent } from '../taskEventMapping';

interface UseTechnicalPlanPersistenceParams {
  state: TechnicalPlanState;
  setState: Dispatch<SetStateAction<TechnicalPlanState>>;
  showToast: (message: string, type?: ToastType) => void;
}

// 技术方案各阶段的持久化出口：页面把 handler 接给子页面，子页面不直接碰 window.yibiao。
export function useTechnicalPlanPersistence({ state, setState, showToast }: UseTechnicalPlanPersistenceParams) {
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

  return {
    saveChapterContent,
    saveContentGenerationOptions,
    saveGlobalFacts,
    saveGlobalFactsConfig,
    saveOutline,
    saveOutlineSelection,
    openBidTemplate,
    saveOutlineConfig,
  };
}
