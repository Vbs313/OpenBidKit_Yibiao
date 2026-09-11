import { useCallback, useState } from 'react';
import { useToast } from '../../../shared/ui';
import type { TechnicalPlanState } from '../../../shared/types/domains/technical-plan';

const PET_PLUGIN_ID = 'openbidkit-pet';

interface UsePetAiAdjustParams {
  state: TechnicalPlanState;
}

// 桌宠 AI 调整：目录 / 全局事实两个步骤共用同一套「按钮可用性 + 插件检查 + 唤起对话」逻辑。
export function usePetAiAdjust({ state }: UsePetAiAdjustParams) {
  const { showToast } = useToast();
  const [petInstallDialogOpen, setPetInstallDialogOpen] = useState(false);
  const [installingPetPlugin, setInstallingPetPlugin] = useState(false);

  const outlineGenerationStatus = state.outlineGenerationTask?.status;
  const isOutlineGenerating = outlineGenerationStatus === 'running' || outlineGenerationStatus === 'pausing';
  const outlineAdjustmentStatus = state.outlineAdjustmentTask?.status;
  const isOutlineAdjusting = outlineAdjustmentStatus === 'running' || outlineAdjustmentStatus === 'pausing';
  const isGlobalFactsAdjusting = state.globalFactsAdjustmentTask?.status === 'running' || state.globalFactsAdjustmentTask?.status === 'pausing';
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

  return {
    petInstallDialogOpen,
    setPetInstallDialogOpen,
    installingPetPlugin,
    isOutlineAdjusting,
    isAiAdjusting,
    aiAdjustDisabled,
    aiAdjustTooltip,
    handleAiAdjustClick,
    installPetPluginAndOpenChat,
  };
}
