
import { useAppUpdate } from '../hooks/useAppUpdate';
import { useSettingsConfig } from '../hooks/useSettingsConfig';
import { useModelCatalog } from '../hooks/useModelCatalog';
import { useEffect, useState } from 'react';
import { FloatingToolbar, OfflineLicenseActivationDialog, useAutoAnswer, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import type { AgentSelfCheckResult, ImageModelProvider, ImageModelStatus, LicenseRuntimeStatus, TextModelProvider } from '../../../shared/types';
import type { SettingsPageState } from '../types';
import { GeneralTab } from '../components/tabs/GeneralTab';
import { TextModelTab } from '../components/tabs/TextModelTab';
import { ImageModelTab } from '../components/tabs/ImageModelTab';
import { ComponentsTab } from '../components/tabs/ComponentsTab';
import { AgentTab } from '../components/tabs/AgentTab';
import { AboutTab } from '../components/tabs/AboutTab';
import type { AgentSelfCheckUiStatus } from '../types';
import type { SettingsPageProps } from '../model';
import {
  SettingsTab,
  settingsTabs,
  agentSelfCheckStatusMeta,
  agentDiagnosticStatusMeta,
  updateChannelOptions,
  getLicenseSourceLabel,
  textModelProviders,
  aiRequestModeOptions,
  textProviderDefaults,
  textProviderApiKeyUrls,
  parseTextContextLengthInput,
  parseTextConcurrencyLimitInput,
  parseTextTemperatureInput,
  normalizeTextModelProfile,
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
  imageProfileFromState,
  imageStatusMeta,
  formatImageTestTime,
  fileParserProviders,
  parserOptions,
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
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [appVersion, setAppVersion] = useState('');
  const [licenseStatus, setLicenseStatus] = useState<LicenseRuntimeStatus | null>(null);
  const [offlineLicenseDialogOpen, setOfflineLicenseDialogOpen] = useState(false);
  const [agentSelfCheckStatus, setAgentSelfCheckStatus] = useState<AgentSelfCheckUiStatus>('untested');
  const [agentSelfCheckResult, setAgentSelfCheckResult] = useState<AgentSelfCheckResult | null>(null);
  const [exportingAgentSelfCheckReport, setExportingAgentSelfCheckReport] = useState(false);
  const [agentAutoAnswerDraft, setAgentAutoAnswerDraft] = useState(false);
  const { showToast } = useToast();
  const { enabled: agentAutoAnswerEnabled } = useAutoAnswer();

  const {
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
  } = useSettingsConfig({
    activeTab,
    agentAutoAnswerDraft,
    setAgentAutoAnswerDraft,
    onDeveloperModeChange,
  });

  useEffect(() => {
    void loadTextConfig();
    void window.yibiao?.getVersion().then(setAppVersion);
    void window.yibiao?.license?.getStatus().then(setLicenseStatus).catch(() => setLicenseStatus(null));

  }, []);

  // 弹窗中的自动确认开关实时保存后，同步刷新设置页草稿和已保存基准。
  useEffect(() => {
    patchSavedAgentAutoAnswer(agentAutoAnswerEnabled);
  }, [agentAutoAnswerEnabled]);

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

    applyImageModelConfig(partial);
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

  const openConfigFolder = async () => {
    try {
      await window.yibiao?.config.openConfigFolder();
      showToast('已打开配置文件夹', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开配置文件夹失败', 'error');
    }
  };

  // 从云端模型信息缓存一次填充当前模型可确定的高级参数。

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
