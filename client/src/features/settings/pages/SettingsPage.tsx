
import { useAppUpdate } from '../hooks/useAppUpdate';
import { useModelCatalog } from '../hooks/useModelCatalog';
import { useEffect, useState } from 'react';
import { trackConfigUsage } from '../../../shared/analytics/analytics';
import { AppSwitch, DetailHelpLink, FloatingToolbar, InlineSpinner, InputWithAction, OfflineLicenseActivationDialog, useAutoAnswer, useToast } from '../../../shared/ui';
import { showUpdateReadyToast } from '../../../shared/updateToast';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import type { AgentModeScenariosConfig, AgentSelfCheckResult, AgentSelfCheckStepStatus, AiRequestMode, ClientConfig, ComponentsConfig, FileParserProvider, ImageModelProfiles, ImageModelProvider, ImageModelRatio, ImageModelSize, ImageModelStatus, LicenseRuntimeStatus, TextModelConfig, TextModelProfiles, TextModelProvider, UpdateChannel } from '../../../shared/types';
import type { SettingsPageState } from '../types';
import { GeneralTab } from '../components/tabs/GeneralTab';
import { TextModelTab } from '../components/tabs/TextModelTab';
import { ImageModelTab } from '../components/tabs/ImageModelTab';
import { ComponentsTab } from '../components/tabs/ComponentsTab';
import { AgentTab } from '../components/tabs/AgentTab';
import { AboutTab } from '../components/tabs/AboutTab';
import type { AgentSelfCheckUiStatus, UpdateStatus } from '../types';
import type { SettingsPageProps } from '../model';
import {
  SettingsTab,
  settingsTabs,
  agentSelfCheckStatusMeta,
  agentDiagnosticStatusMeta,
  updateChannelOptions,
  normalizeUpdateChannel,
  normalizeAgentModeScenarios,
  getLicenseSourceLabel,
  textModelProviders,
  aiRequestModeOptions,
  textProviderDefaults,
  textProviderApiKeyUrls,
  parseTextContextLengthInput,
  parseTextConcurrencyLimitInput,
  parseTextTemperatureInput,
  normalizeTextModelProfile,
  normalizeTextModelProfiles,
  textProfileFromState,
  imageProviders,
  agnesImageRatioOptions,
  getImageSizeOptions,
  imageProviderDefaults,
  imageProviderApiKeyUrls,
  getImageBaseUrlDescription,
  getImageApiKeyDescription,
  getImageModelDescription,
  getImageModelPlaceholder,
  normalizeImageModelProfile,
  parseImageConcurrencyLimitInput,
  MIN_COMPONENT_CONCURRENCY_LIMIT,
  MAX_COMPONENT_CONCURRENCY_LIMIT,
  parseComponentConcurrencyLimitInput,
  normalizeComponentsState,
  componentsFromState,
  normalizeImageModelProfiles,
  imageProfileFromState,
  imageStatusMeta,
  resetImageModelStatus,
  formatImageTestTime,
  fileParserProviders,
  parserOptions,
  initialState,
} from '../model';

function SettingsPage({ onDeveloperModeChange }: SettingsPageProps) {
  const {
    updateStatus,
    updateVersion,
    updateBusy,
    updateStatusText,
    checkForUpdates,
    installDownloadedUpdate,
  } = useAppUpdate();
  const [state, setState] = useState<SettingsPageState>(initialState);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [savedConfig, setSavedConfig] = useState<ClientConfig | null>(null);
  const [appVersion, setAppVersion] = useState('');
  const [licenseStatus, setLicenseStatus] = useState<LicenseRuntimeStatus | null>(null);
  const [offlineLicenseDialogOpen, setOfflineLicenseDialogOpen] = useState(false);
  const [agentSelfCheckStatus, setAgentSelfCheckStatus] = useState<AgentSelfCheckUiStatus>('untested');
  const [agentSelfCheckResult, setAgentSelfCheckResult] = useState<AgentSelfCheckResult | null>(null);
  const [exportingAgentSelfCheckReport, setExportingAgentSelfCheckReport] = useState(false);
  const [agentAutoAnswerDraft, setAgentAutoAnswerDraft] = useState(false);
  const { showToast } = useToast();
  const { enabled: agentAutoAnswerEnabled } = useAutoAnswer();

  useEffect(() => {
    void loadTextConfig();
    void window.yibiao?.getVersion().then(setAppVersion);
    void window.yibiao?.license?.getStatus().then(setLicenseStatus).catch(() => setLicenseStatus(null));

  }, []);

  // 弹窗中的自动确认开关实时保存后，同步刷新设置页草稿和已保存基准。
  useEffect(() => {
    setAgentAutoAnswerDraft(agentAutoAnswerEnabled);
    setSavedConfig((current) => current
      ? { ...current, agent_auto_answer_enabled: agentAutoAnswerEnabled }
      : current);
  }, [agentAutoAnswerEnabled]);

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

  // 只把文本模型草稿写回 state，不碰模型目录缓存；目录清空由 useModelCatalog 暴露的 clear* 负责。
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

  const {
    textModels,
    reasoningEfforts,
    imageModels,
    loadingModels,
    loadingModelInfo,
    testingTextModel,
    testingImageModel,
    imageTestPreview,
    clearTextModels,
    clearReasoningEfforts,
    clearImageModels,
    resetImageTestPreview,
    testTextConfig,
    testImageConfig,
    fetchTextModels,
    fetchTextModelInfo,
    fetchImageModels,
  } = useModelCatalog({
    state,
    setState,
    createClientConfig,
    applyTextModelConfig,
    setSavedConfig,
  });

  const updateImageModelConfig = (partial: Partial<Omit<SettingsPageState['imageModel'], 'provider'>>, options: { clearModels?: boolean } = {}) => {
    if (options.clearModels) {
      clearImageModels();
    }

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

  const updateImageModelProvider = (provider: ImageModelProvider) => {
    clearImageModels();
    resetImageTestPreview();
    setState((prev) => ({
      ...prev,
      imageModelProfiles: {
        ...prev.imageModelProfiles,
        [prev.imageModel.provider]: imageProfileFromState(prev.imageModel),
      },
      imageModel: normalizeImageModelProfile(provider, prev.imageModelProfiles[provider]),
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

  const updateTextModelProvider = (provider: TextModelProvider) => {
    clearTextModels();
    setState((prev) => ({
      ...prev,
      textModelProfiles: {
        ...prev.textModelProfiles,
        [prev.textModel.provider]: textProfileFromState(prev.textModel),
      },
      textModel: {
        provider,
        ...normalizeTextModelProfile(provider, prev.textModelProfiles[provider]),
      },
    }));
  };

  const updateTextModelConfig = (partial: Partial<Omit<SettingsPageState['textModel'], 'provider'>>, options: { clearModels?: boolean } = {}) => {
    if (options.clearModels) {
      clearTextModels();
    }

    applyTextModelConfig(partial);
  };

  // 更新模型名称，并清空不再适用于新模型的思考强度。
  const updateTextModelName = (modelName: string) => {
    clearReasoningEfforts();
    setState((prev) => {
      const textModel = prev.textModel.model_name === modelName
        ? prev.textModel
        : { ...prev.textModel, model_name: modelName, reasoning_effort: '' };
      return {
        ...prev,
        textModel,
        textModelProfiles: {
          ...prev.textModelProfiles,
          [prev.textModel.provider]: textProfileFromState(textModel),
        },
      };
    });
  };

  const openTextProviderApiKeyPage = async () => {
    const url = textProviderApiKeyUrls[state.textModel.provider];
    if (!url) {
      showToast('自定义服务商没有预置 API Key 获取页面', 'info');
      return;
    }

    try {
      const result = await window.yibiao?.openExternal(url);
      if (result && !result.success) {
        showToast(result.message || '打开 API Key 获取页面失败', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开 API Key 获取页面失败', 'error');
    }
  };

  const openImageProviderApiKeyPage = async () => {
    const url = imageProviderApiKeyUrls[state.imageModel.provider];
    if (!url) {
      showToast('自定义生图服务没有预置 API Key 获取页面', 'info');
      return;
    }

    try {
      const result = await window.yibiao?.openExternal(url);
      if (result && !result.success) {
        showToast(result.message || '打开生图服务 API Key 获取页面失败', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开生图服务 API Key 获取页面失败', 'error');
    }
  };

  const runAgentSelfCheck = async () => {
    if (agentSelfCheckStatus === 'checking') return;

    try {
      setAgentSelfCheckStatus('checking');
      setAgentSelfCheckResult(null);

      const result = await window.yibiao?.agent.selfCheck();
      if (!result) {
        throw new Error('智能体自检未返回结果');
      }

      setAgentSelfCheckResult(result);
      const nextStatus = result.success ? 'normal' : result.status === 'busy' ? 'busy' : 'error';
      setAgentSelfCheckStatus(nextStatus);
      showToast(
        result.success ? '智能体自检正常' : result.message || '智能体自检失败',
        result.success ? 'success' : result.status === 'busy' ? 'info' : 'error'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '智能体自检失败';
      const failedResult: AgentSelfCheckResult = {
        success: false,
        runtime_id: 'pi',
        runtime_name: 'Pi Agent',
        status: 'error',
        message,
        checked_at: new Date().toISOString(),
        duration_ms: 0,
        log_dir: '',
        log_file: '',
        runtime_root: '',
        workspace_dir: '',
        output_file: '',
        output_path: '',
        steps: [],
        sections: [],
        error: { message },
        diagnostics: { message },
        detail_text: message,
      };
      setAgentSelfCheckResult(failedResult);
      setAgentSelfCheckStatus('error');
      showToast(message, 'error');
    }
  };

  const exportAgentSelfCheckReport = async () => {
    if (!agentSelfCheckResult || exportingAgentSelfCheckReport) return;

    try {
      setExportingAgentSelfCheckReport(true);
      const result = await window.yibiao?.agent.exportSelfCheckReport(agentSelfCheckResult);
      if (!result) {
        throw new Error('导出智能体自检报告失败');
      }
      if (result.canceled) {
        showToast(result.message || '已取消导出', 'info');
        return;
      }
      if (!result.success) {
        throw new Error(result.message || '导出智能体自检报告失败');
      }
      showToast(result.message || '智能体自检报告已导出', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '导出智能体自检报告失败', 'error');
    } finally {
      setExportingAgentSelfCheckReport(false);
    }
  };

  const saveImageConfig = async () => {
    await saveClientConfig(createClientConfig());
  };

  const saveComponentsConfig = async () => {
    await saveClientConfig(createClientConfig());
  };

  const openConfigFolder = async () => {
    try {
      await window.yibiao?.config.openConfigFolder();
      showToast('已打开配置文件夹', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开配置文件夹失败', 'error');
    }
  };

  // 从云端模型信息缓存一次填充当前模型可确定的高级参数。

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

  const openDeveloperTokenStatsWindow = async () => {
    const nextConfig = createClientConfig();
    if (!nextConfig.developer_mode) {
      showToast('请先开启开发者模式', 'info');
      return;
    }

    if (!savedConfig?.developer_mode || isActiveTabDirty()) {
      const saved = await saveClientConfig(nextConfig);
      if (!saved) {
        return;
      }
    }

    try {
      const result = await window.yibiao?.developerTokenStats.openWindow();
      showToast(result?.success ? '已打开 Token 统计小窗' : '打开 Token 统计小窗失败', result?.success ? 'success' : 'error');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开 Token 统计小窗失败', 'error');
    }
  };

  // 保存当前开发者配置后打开独立的 Pi Agent 只读执行监视器。
  const openDeveloperAgentMonitorWindow = async () => {
    const nextConfig = createClientConfig();
    if (!nextConfig.developer_mode) {
      showToast('请先开启开发者模式', 'info');
      return;
    }

    if (!savedConfig?.developer_mode || isActiveTabDirty()) {
      const saved = await saveClientConfig(nextConfig);
      if (!saved) {
        return;
      }
    }

    try {
      const result = await window.yibiao?.developerAgentMonitor.openWindow();
      showToast(result?.success ? '已打开 Pi Agent 执行监视器' : '打开 Pi Agent 执行监视器失败', result?.success ? 'success' : 'error');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开 Pi Agent 执行监视器失败', 'error');
    }
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

  const canSaveActiveTab = activeTab === 'general' || activeTab === 'text-model' || activeTab === 'image-model' || activeTab === 'components' || activeTab === 'agent';
  const activeTabDirty = isActiveTabDirty();
  const currentTextProviderDefault = textProviderDefaults[state.textModel.provider];
  const imageModelStatus: ImageModelStatus = state.imageModel.status || 'untested';
  const currentImageStatus = imageStatusMeta[imageModelStatus];
  const currentAgentSelfCheckStatus = agentSelfCheckStatusMeta[agentSelfCheckStatus];
  const imageTestTime = formatImageTestTime(state.imageModel.tested_at);
  const settingsToolbarGroups: FloatingToolbarGroup[] = canSaveActiveTab
    ? [
        {
          id: 'settings-save-state',
          actions: [
            {
              id: 'save-state',
              label: activeTabDirty ? '未保存' : '已保存',
              variant: 'ghost',
              disabled: true,
              onClick: () => undefined,
            },
          ],
        },
        {
          id: 'settings-save-action',
          actions: [
            {
              id: 'save',
              label: '保存',
              variant: 'primary',
              disabled: !activeTabDirty,
              tooltip: activeTabDirty ? '保存当前设置' : '当前设置已保存',
              onClick: saveActiveTabConfig,
            },
          ],
        },
      ]
    : [];

  const licenseSourceLabel = getLicenseSourceLabel(licenseStatus);
  const currentImageSizeOptions = getImageSizeOptions(state.imageModel.provider, state.imageModel.model_name);
  const currentImageSizeSupported = currentImageSizeOptions.some((option) => option.value === state.imageModel.image_size);

  return (
    <div className="settings-page">
      <div className="settings-page-scroll">
        <div className="settings-tab-shell" role="tablist" aria-label="设置分类">
          {settingsTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`settings-tab ${activeTab === tab.id ? 'is-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              role="tab"
              aria-selected={activeTab === tab.id}
            >
              {tab.label}
            </button>
          ))}
        </div>

      {activeTab === 'general' && <GeneralTab openConfigFolder={openConfigFolder} openDeveloperAgentMonitorWindow={openDeveloperAgentMonitorWindow} openDeveloperTokenStatsWindow={openDeveloperTokenStatsWindow} state={state} updateChannelOptions={updateChannelOptions} updateDeveloperAgentMonitorAutoOpen={updateDeveloperAgentMonitorAutoOpen} updateDeveloperMode={updateDeveloperMode} updateDeveloperTokenStatsAutoOpen={updateDeveloperTokenStatsAutoOpen} updateGpuHardwareAcceleration={updateGpuHardwareAcceleration} updateUpdateChannel={updateUpdateChannel} />}

      {activeTab === 'text-model' && <TextModelTab aiRequestModeOptions={aiRequestModeOptions} currentTextProviderDefault={currentTextProviderDefault} fetchTextModelInfo={fetchTextModelInfo} fetchTextModels={fetchTextModels} loadingModelInfo={loadingModelInfo} loadingModels={loadingModels} openTextProviderApiKeyPage={openTextProviderApiKeyPage} parseTextConcurrencyLimitInput={parseTextConcurrencyLimitInput} parseTextContextLengthInput={parseTextContextLengthInput} parseTextTemperatureInput={parseTextTemperatureInput} reasoningEfforts={reasoningEfforts} state={state} testTextConfig={testTextConfig} testingTextModel={testingTextModel} textModelProviders={textModelProviders} textModels={textModels} textProviderApiKeyUrls={textProviderApiKeyUrls} updateTextModelConfig={updateTextModelConfig} updateTextModelName={updateTextModelName} updateTextModelProvider={updateTextModelProvider} />}

      {activeTab === 'image-model' && <ImageModelTab agnesImageRatioOptions={agnesImageRatioOptions} aiRequestModeOptions={aiRequestModeOptions} currentImageSizeOptions={currentImageSizeOptions} currentImageSizeSupported={currentImageSizeSupported} currentImageStatus={currentImageStatus} fetchImageModels={fetchImageModels} getImageApiKeyDescription={getImageApiKeyDescription} getImageBaseUrlDescription={getImageBaseUrlDescription} getImageModelDescription={getImageModelDescription} getImageModelPlaceholder={getImageModelPlaceholder} imageModelStatus={imageModelStatus} imageModels={imageModels} imageProviderDefaults={imageProviderDefaults} imageProviders={imageProviders} imageTestPreview={imageTestPreview} imageTestTime={imageTestTime} loadingModels={loadingModels} openImageProviderApiKeyPage={openImageProviderApiKeyPage} parseImageConcurrencyLimitInput={parseImageConcurrencyLimitInput} state={state} testImageConfig={testImageConfig} testingImageModel={testingImageModel} updateImageModelConfig={updateImageModelConfig} updateImageModelProvider={updateImageModelProvider} />}

      {activeTab === 'components' && <ComponentsTab MAX_COMPONENT_CONCURRENCY_LIMIT={MAX_COMPONENT_CONCURRENCY_LIMIT} MIN_COMPONENT_CONCURRENCY_LIMIT={MIN_COMPONENT_CONCURRENCY_LIMIT} fileParserProviders={fileParserProviders} parseComponentConcurrencyLimitInput={parseComponentConcurrencyLimitInput} parserOptions={parserOptions} setState={setState} state={state} />}

      {activeTab === 'agent' && <AgentTab agentAutoAnswerDraft={agentAutoAnswerDraft} agentDiagnosticStatusMeta={agentDiagnosticStatusMeta} agentSelfCheckResult={agentSelfCheckResult} agentSelfCheckStatus={agentSelfCheckStatus} currentAgentSelfCheckStatus={currentAgentSelfCheckStatus} exportAgentSelfCheckReport={exportAgentSelfCheckReport} exportingAgentSelfCheckReport={exportingAgentSelfCheckReport} runAgentSelfCheck={runAgentSelfCheck} setAgentAutoAnswerDraft={setAgentAutoAnswerDraft} state={state} updateAgentModeScenario={updateAgentModeScenario} />}

      {activeTab === 'about' && <AboutTab appVersion={appVersion} checkForUpdates={checkForUpdates} installDownloadedUpdate={installDownloadedUpdate} licenseSourceLabel={licenseSourceLabel} licenseStatus={licenseStatus} setOfflineLicenseDialogOpen={setOfflineLicenseDialogOpen} updateBusy={updateBusy} updateStatus={updateStatus} updateStatusText={updateStatusText} />}
      </div>
      <OfflineLicenseActivationDialog
        open={offlineLicenseDialogOpen}
        onOpenChange={setOfflineLicenseDialogOpen}
        onActivated={setLicenseStatus}
      />
      <FloatingToolbar groups={settingsToolbarGroups} label="设置保存工具条" />
    </div>
  );
}

export default SettingsPage;
