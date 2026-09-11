// 设置页的配置域：草稿 state、配置装配、读写、脏检查、保存。
//
// 这些闭包原本散在 SettingsPage.tsx 组件体里（含 2 个 state、约 20 个 handler，共 300 余行）。
// 抽成自定义 hook 后，页面变成组合根：配置域从这里取，模型目录域从 useModelCatalog 取，
// 只有页面同时认识两边（所以「切服务商要清空模型列表」这类桥接逻辑留在页面）。
//
// 注入的 UI 态：activeTab（脏检查按当前分页判定）、agentAutoAnswerDraft（随弹窗实时保存的开关）。

import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useToast } from '../../../shared/ui';
import { trackConfigUsage } from '../../../shared/analytics/analytics';
import type { AgentModeScenariosConfig, ClientConfig, ImageModelProfiles, TextModelProfiles, UpdateChannel } from '../../../shared/types';
import type { SettingsPageState } from '../types';
import type { SettingsTab } from '../model';
import {
  componentsFromState,
  imageProfileFromState,
  initialState,
  normalizeAgentModeScenarios,
  normalizeComponentsState,
  normalizeImageModelProfile,
  normalizeImageModelProfiles,
  normalizeTextModelProfile,
  normalizeTextModelProfiles,
  normalizeUpdateChannel,
  resetImageModelStatus,
  textProfileFromState,
} from '../model';

export interface UseSettingsConfigOptions {
  activeTab: SettingsTab;
  agentAutoAnswerDraft: boolean;
  setAgentAutoAnswerDraft: Dispatch<SetStateAction<boolean>>;
  onDeveloperModeChange?: (developerMode: boolean) => void;
}

export function useSettingsConfig({
  activeTab,
  agentAutoAnswerDraft,
  setAgentAutoAnswerDraft,
  onDeveloperModeChange,
}: UseSettingsConfigOptions) {
  const { showToast } = useToast();
  const [state, setState] = useState<SettingsPageState>(initialState);
  const [savedConfig, setSavedConfig] = useState<ClientConfig | null>(null);

  const loadTextConfig = async () => {
    try {
      const config = await window.yibiao?.config.load();
      if (!config) {
        return;
      }

      const textModelProfiles = normalizeTextModelProfiles(config.text_model_profiles);
      const activeTextProfile = normalizeTextModelProfile(config.text_model_provider, textModelProfiles[config.text_model_provider]);
      const imageModelProfiles = normalizeImageModelProfiles(config.image_model_profiles);
      const activeImageProfile = normalizeImageModelProfile(config.image_model.provider, config.image_model);
      imageModelProfiles[activeImageProfile.provider] = activeImageProfile;

      setState((prev) => ({
        ...prev,
        textModel: {
          provider: config.text_model_provider,
          ...activeTextProfile,
        },
        textModelProfiles,
        imageModel: activeImageProfile,
        imageModelProfiles,
        components: normalizeComponentsState(config.components),
        agentModeScenarios: normalizeAgentModeScenarios(config.agent_mode_scenarios),
        general: {
          developer_mode: Boolean(config.developer_mode),
          developer_token_stats_auto_open: Boolean(config.developer_token_stats_auto_open),
          developer_agent_monitor_auto_open: Boolean(config.developer_agent_monitor_auto_open),
          update_channel: normalizeUpdateChannel(config.update_channel),
          gpu_hardware_acceleration_enabled: Boolean(config.gpu_hardware_acceleration_enabled),
          gpu_hardware_acceleration_configured: Boolean(config.gpu_hardware_acceleration_configured),
        },
      }));
      setAgentAutoAnswerDraft(Boolean(config.agent_auto_answer_enabled));
      setSavedConfig(config);
      onDeveloperModeChange?.(Boolean(config.developer_mode));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '加载客户端配置失败';
      showToast(errorMessage, 'error');
    }
  };

  const getCurrentTextModelProfiles = (): TextModelProfiles => ({
    ...state.textModelProfiles,
    [state.textModel.provider]: textProfileFromState(state.textModel),
  });

  const getCurrentImageModelProfiles = (): ImageModelProfiles => ({
    ...state.imageModelProfiles,
    [state.imageModel.provider]: imageProfileFromState(state.imageModel),
  });

  const createClientConfig = (options: { includeAgentSettings?: boolean } = {}): ClientConfig => {
    const textModelProfiles = getCurrentTextModelProfiles();
    const activeTextProfile = textModelProfiles[state.textModel.provider]
      || normalizeTextModelProfile(state.textModel.provider);
    const imageModelProfiles = getCurrentImageModelProfiles();
    const activeImageProfile = imageModelProfiles[state.imageModel.provider];
    const persistedAgentModeScenarios = savedConfig
      ? normalizeAgentModeScenarios(savedConfig.agent_mode_scenarios)
      : state.agentModeScenarios;

    return {
      text_model_provider: state.textModel.provider,
      text_model_profiles: textModelProfiles,
      api_key: activeTextProfile.api_key,
      base_url: activeTextProfile.base_url,
      model_name: activeTextProfile.model_name,
      multimodal_enabled: activeTextProfile.multimodal_enabled,
      reasoning_effort: activeTextProfile.reasoning_effort,
      context_length_limit: activeTextProfile.context_length_limit,
      concurrency_limit: activeTextProfile.concurrency_limit,
      temperature_enabled: activeTextProfile.temperature_enabled,
      temperature: activeTextProfile.temperature,
      request_mode: activeTextProfile.request_mode,
      image_model: activeImageProfile,
      image_model_profiles: imageModelProfiles,
      components: componentsFromState(state.components),
      agent_mode_scenarios: options.includeAgentSettings ? state.agentModeScenarios : persistedAgentModeScenarios,
      ...(options.includeAgentSettings
        ? { agent_auto_answer_enabled: agentAutoAnswerDraft }
        : savedConfig ? { agent_auto_answer_enabled: Boolean(savedConfig.agent_auto_answer_enabled) } : {}),
      update_channel: state.general.update_channel,
      gpu_hardware_acceleration_enabled: state.general.gpu_hardware_acceleration_enabled,
      gpu_hardware_acceleration_configured: state.general.gpu_hardware_acceleration_configured,
      developer_mode: state.general.developer_mode,
      developer_token_stats_auto_open: state.general.developer_token_stats_auto_open,
      developer_agent_monitor_auto_open: state.general.developer_agent_monitor_auto_open,
    };
  };

  const applyTextModelConfig = (partial: Partial<Omit<SettingsPageState['textModel'], 'provider'>>) => {
    setState((prev) => ({
      ...prev,
      ...(() => {
        const textModel = { ...prev.textModel, ...partial };
        return {
          textModel,
          textModelProfiles: {
            ...prev.textModelProfiles,
            [prev.textModel.provider]: textProfileFromState(textModel),
          },
        };
      })(),
    }));
  };

  const saveClientConfig = async (config: ClientConfig) => {
    try {
      const result = await window.yibiao?.config.save(config);
      showToast(result?.success ? '配置已保存' : result?.message || '配置保存失败', result?.success ? 'success' : 'error');
      if (result?.success) {
        setSavedConfig(config);
        onDeveloperModeChange?.(Boolean(config.developer_mode));
        trackConfigUsage({}, config);
      }
      return Boolean(result?.success);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '配置保存失败';
      showToast(errorMessage, 'error');
      return false;
    }
  };

  const saveTextConfig = async () => {
    await saveClientConfig(createClientConfig());
  };

  const updateDeveloperMode = (developerMode: boolean) => {
    setState((prev) => ({
      ...prev,
      general: { ...prev.general, developer_mode: developerMode },
    }));
    onDeveloperModeChange?.(developerMode);
  };

  const updateDeveloperTokenStatsAutoOpen = (autoOpen: boolean) => {
    setState((prev) => ({
      ...prev,
      general: { ...prev.general, developer_token_stats_auto_open: autoOpen },
    }));
  };

  const updateDeveloperAgentMonitorAutoOpen = (autoOpen: boolean) => {
    setState((prev) => ({
      ...prev,
      general: { ...prev.general, developer_agent_monitor_auto_open: autoOpen },
    }));
  };

  const updateUpdateChannel = (updateChannel: UpdateChannel) => {
    setState((prev) => ({
      ...prev,
      general: { ...prev.general, update_channel: updateChannel },
    }));
  };

  const updateGpuHardwareAcceleration = (enabled: boolean) => {
    setState((prev) => ({
      ...prev,
      general: {
        ...prev.general,
        gpu_hardware_acceleration_enabled: enabled,
        gpu_hardware_acceleration_configured: true,
      },
    }));
  };

  const updateAgentModeScenario = (key: keyof AgentModeScenariosConfig, enabled: boolean) => {
    setState((prev) => ({
      ...prev,
      agentModeScenarios: {
        ...prev.agentModeScenarios,
        [key]: enabled,
      },
    }));
  };

  const saveImageConfig = async () => {
    await saveClientConfig(createClientConfig());
  };

  const saveComponentsConfig = async () => {
    await saveClientConfig(createClientConfig());
  };

  const isActiveTabDirty = () => {
    if (!savedConfig) {
      return false;
    }

    if (activeTab === 'text-model') {
      return JSON.stringify({
        provider: state.textModel.provider,
        profiles: getCurrentTextModelProfiles(),
      }) !== JSON.stringify({
        provider: savedConfig.text_model_provider,
        profiles: normalizeTextModelProfiles(savedConfig.text_model_profiles),
      });
    }

    if (activeTab === 'general') {
      return JSON.stringify({
        developer_mode: Boolean(state.general.developer_mode),
        developer_token_stats_auto_open: Boolean(state.general.developer_token_stats_auto_open),
        developer_agent_monitor_auto_open: Boolean(state.general.developer_agent_monitor_auto_open),
        update_channel: state.general.update_channel,
        gpu_hardware_acceleration_enabled: Boolean(state.general.gpu_hardware_acceleration_enabled),
        gpu_hardware_acceleration_configured: Boolean(state.general.gpu_hardware_acceleration_configured),
      }) !== JSON.stringify({
        developer_mode: Boolean(savedConfig.developer_mode),
        developer_token_stats_auto_open: Boolean(savedConfig.developer_token_stats_auto_open),
        developer_agent_monitor_auto_open: Boolean(savedConfig.developer_agent_monitor_auto_open),
        update_channel: normalizeUpdateChannel(savedConfig.update_channel),
        gpu_hardware_acceleration_enabled: Boolean(savedConfig.gpu_hardware_acceleration_enabled),
        gpu_hardware_acceleration_configured: Boolean(savedConfig.gpu_hardware_acceleration_configured),
      });
    }

    if (activeTab === 'image-model') {
      return JSON.stringify({
        provider: state.imageModel.provider,
        profiles: getCurrentImageModelProfiles(),
      }) !== JSON.stringify({
        provider: savedConfig.image_model.provider,
        profiles: normalizeImageModelProfiles(savedConfig.image_model_profiles),
      });
    }

    if (activeTab === 'components') {
      return JSON.stringify(componentsFromState(state.components)) !== JSON.stringify(normalizeComponentsState(savedConfig.components));
    }

    if (activeTab === 'agent') {
      return JSON.stringify(state.agentModeScenarios) !== JSON.stringify(normalizeAgentModeScenarios(savedConfig.agent_mode_scenarios))
        || agentAutoAnswerDraft !== Boolean(savedConfig.agent_auto_answer_enabled);
    }

    return false;
  };

  const saveActiveTabConfig = async () => {
    if (activeTab === 'general') {
      const nextConfig = createClientConfig();
      const previousGpuEnabled = Boolean(savedConfig?.gpu_hardware_acceleration_enabled);
      const nextGpuEnabled = Boolean(state.general.gpu_hardware_acceleration_enabled);

      if (!previousGpuEnabled && nextGpuEnabled) {
        const saved = await saveClientConfig({
          ...nextConfig,
          gpu_hardware_acceleration_enabled: false,
          gpu_hardware_acceleration_configured: true,
        });
        if (saved) {
          try {
            const result = await window.yibiao?.startGpuHardwareAccelerationTrial();
            if (!result?.success) {
              throw new Error('GPU 硬件加速试启用失败');
            }
            showToast('即将重启试用 GPU 硬件加速', 'info');
          } catch (error) {
            setState((prev) => ({
              ...prev,
              general: {
                ...prev.general,
                gpu_hardware_acceleration_enabled: false,
                gpu_hardware_acceleration_configured: true,
              },
            }));
            const message = error instanceof Error ? error.message : 'GPU 硬件加速试启用失败';
            showToast(`${message}，已保持关闭，请稍后重试。`, 'error');
          }
        }
        return;
      }

      const saved = await saveClientConfig(nextConfig);
      if (saved && previousGpuEnabled !== nextGpuEnabled) {
        showToast(nextGpuEnabled ? 'GPU 硬件加速将在重启后启用' : 'GPU 硬件加速将在重启后关闭', 'info');
      }
      return;
    }
    if (activeTab === 'text-model') {
      await saveTextConfig();
      return;
    }
    if (activeTab === 'image-model') {
      await saveImageConfig();
      return;
    }
    if (activeTab === 'components') {
      await saveComponentsConfig();
      return;
    }
    if (activeTab === 'agent') {
      await saveClientConfig(createClientConfig({ includeAgentSettings: true }));
    }
  };

  const applyImageModelConfig = (partial: Partial<Omit<SettingsPageState['imageModel'], 'provider'>>) => {
    setState((prev) => ({
      ...prev,
      ...(() => {
        const imageModel = resetImageModelStatus({ ...prev.imageModel, ...partial });
        return {
          imageModel,
          imageModelProfiles: {
            ...prev.imageModelProfiles,
            [prev.imageModel.provider]: imageProfileFromState(imageModel),
          },
        };
      })(),
    }));
  };

  // 弹窗里的自动确认开关实时保存后，把草稿和已保存基准一起对齐。
  const patchSavedAgentAutoAnswer = (enabled: boolean) => {
    setAgentAutoAnswerDraft(enabled);
    setSavedConfig((current) => current
      ? { ...current, agent_auto_answer_enabled: enabled }
      : current);
  };

  return {
    state,
    setState,
    savedConfig,
    setSavedConfig,
    loadTextConfig,
    createClientConfig,
    applyTextModelConfig,
    applyImageModelConfig,
    saveClientConfig,
    saveTextConfig,
    saveImageConfig,
    saveComponentsConfig,
    updateDeveloperMode,
    updateDeveloperTokenStatsAutoOpen,
    updateDeveloperAgentMonitorAutoOpen,
    updateUpdateChannel,
    updateGpuHardwareAcceleration,
    updateAgentModeScenario,
    patchSavedAgentAutoAnswer,
    isActiveTabDirty,
    saveActiveTabConfig,
  };
}
