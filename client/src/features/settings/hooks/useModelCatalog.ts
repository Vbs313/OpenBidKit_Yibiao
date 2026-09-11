// 模型目录：文本 / 生图模型的拉取、测试，以及由此产生的临时状态。
//
// 原本是 SettingsPage.tsx 组件体里的一组闭包（8 个 state + 5 个 handler，约 190 行）。
// 抽成自定义 hook 后，页面只消费它暴露的值和动作。
//
// 依赖注入：createClientConfig / applyTextModelConfig 由页面提供——
// 「配置草稿怎么组装、写回哪里」是页面的配置关注点；
// 本 hook 只负责「跟模型服务商打交道」这一件事。

import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useToast } from '../../../shared/ui';
import { trackConfigUsage } from '../../../shared/analytics/analytics';
import type { ClientConfig, ImageModelConfig } from '../../../shared/types';
import type { SettingsPageState } from '../types';
import {
  imageProviderDefaults,
  imageProviderLabels,
  imageProfileFromState,
  resetImageModelStatus,
  textProfileFromState,
} from '../model';

export interface ImageTestPreview {
  src: string;
  title: string;
}

export interface UseModelCatalogOptions {
  state: SettingsPageState;
  setState: Dispatch<SetStateAction<SettingsPageState>>;
  createClientConfig: () => ClientConfig;
  applyTextModelConfig: (partial: Partial<Omit<SettingsPageState['textModel'], 'provider'>>) => void;
  setSavedConfig: Dispatch<SetStateAction<ClientConfig | null>>;
}

export function useModelCatalog({
  state,
  setState,
  createClientConfig,
  applyTextModelConfig,
  setSavedConfig,
}: UseModelCatalogOptions) {
  const { showToast } = useToast();

  const [textModels, setTextModels] = useState<string[]>([]);
  const [reasoningEfforts, setReasoningEfforts] = useState<string[]>([]);
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState<'text' | 'image' | null>(null);
  const [loadingModelInfo, setLoadingModelInfo] = useState(false);
  const [testingTextModel, setTestingTextModel] = useState(false);
  const [testingImageModel, setTestingImageModel] = useState(false);
  const [imageTestPreview, setImageTestPreview] = useState<ImageTestPreview | null>(null);

  // 切换服务商 / 模型时清空目录缓存。列表属于本 hook，清空动作也只从这里出。
  const clearTextModels = () => {
    setTextModels([]);
    setReasoningEfforts([]);
  };

  const clearReasoningEfforts = () => {
    setReasoningEfforts([]);
  };

  const clearImageModels = () => {
    setImageModels([]);
  };

  const resetImageTestPreview = () => {
    setImageTestPreview(null);
  };

  const testTextConfig = async () => {
    try {
      setTestingTextModel(true);
      const config = createClientConfig();
      const result = await window.yibiao?.config.save(config);
      if (result?.success) {
        setSavedConfig(config);
      }
      const content = await window.yibiao?.ai.chat({
        messages: [{ role: 'user', content: 'hi' }],
        timeout_ms: 30000,
        timeout_message: '文本模型测试超时，请检查 Base URL、API Key 或模型名称',
        logTitle: '文本模型测试',
      });
      const reply = (content || '').trim();
      if (!reply) {
        throw new Error('文本模型测试失败：模型未返回有效内容');
      }
      showToast(`测试成功：${reply.slice(0, 160)}`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '测试失败', 'error');
    } finally {
      setTestingTextModel(false);
    }
  };

  const testImageConfig = async () => {
    try {
      setTestingImageModel(true);
      const config = createClientConfig();
      const result = await window.yibiao?.ai.testImageModel(config);
      if (!result?.success) {
        throw new Error(result?.message || '生图模型测试失败');
      }
      const testedImageModel: ImageModelConfig = {
        ...config.image_model,
        status: 'available',
        tested_at: new Date().toISOString(),
        last_error: '',
      };
      const testedConfig: ClientConfig = {
        ...config,
        image_model: testedImageModel,
        image_model_profiles: {
          ...config.image_model_profiles,
          [testedImageModel.provider]: testedImageModel,
        },
      };
      await window.yibiao?.config.save(testedConfig);
      setState((prev) => ({
        ...prev,
        imageModel: testedConfig.image_model,
        imageModelProfiles: {
          ...prev.imageModelProfiles,
          [testedConfig.image_model.provider]: imageProfileFromState(testedConfig.image_model),
        },
      }));
      setSavedConfig(testedConfig);
      trackConfigUsage({}, testedConfig);
      const previewSrc = result?.image_url || (result?.image_data ? `data:${result.mime_type || 'image/png'};base64,${result.image_data}` : '');

      if (previewSrc) {
        setImageTestPreview({ src: previewSrc, title: `${imageProviderLabels[state.imageModel.provider]} 测试图片` });
      }

      showToast(result?.message || '生图模型测试成功', result?.success ? 'success' : 'error');
    } catch (error) {
      const message = error instanceof Error ? error.message : '生图模型测试失败';
      const config = createClientConfig();
      const failedImageModel: ImageModelConfig = {
        ...config.image_model,
        status: 'unavailable',
        tested_at: new Date().toISOString(),
        last_error: message,
      };
      const failedConfig: ClientConfig = {
        ...config,
        image_model: failedImageModel,
        image_model_profiles: {
          ...config.image_model_profiles,
          [failedImageModel.provider]: failedImageModel,
        },
      };
      await window.yibiao?.config.save(failedConfig).catch(() => undefined);
      setState((prev) => ({
        ...prev,
        imageModel: failedConfig.image_model,
        imageModelProfiles: {
          ...prev.imageModelProfiles,
          [failedConfig.image_model.provider]: imageProfileFromState(failedConfig.image_model),
        },
      }));
      setSavedConfig(failedConfig);
      trackConfigUsage({}, failedConfig);
      showToast(message, 'error');
    } finally {
      setTestingImageModel(false);
    }
  };

  const fetchTextModels = async () => {
    try {
      setLoadingModels('text');
      setReasoningEfforts([]);
      const result = await window.yibiao?.config.listModels(createClientConfig());
      const models = result?.models || [];
      setTextModels(models);
      if (result?.success && models.length > 0) {
        setState((prev) => ({
          ...prev,
          ...(() => {
            const textModel = models.includes(prev.textModel.model_name)
              ? prev.textModel
              : { ...prev.textModel, model_name: models[0], reasoning_effort: '' };
            return {
              textModel,
              textModelProfiles: {
                ...prev.textModelProfiles,
                [prev.textModel.provider]: textProfileFromState(textModel),
              },
            };
          })(),
        }));
      }
      showToast(result?.message || `获取到 ${result?.models.length || 0} 个文本模型`, result?.success ? 'success' : 'info');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '获取文本模型失败', 'error');
    } finally {
      setLoadingModels(null);
    }
  };

  // 从云端模型信息缓存一次填充当前模型可确定的高级参数。
  const fetchTextModelInfo = async () => {
    const modelName = state.textModel.model_name.trim();
    if (!modelName) {
      showToast('请先填写文本模型名称', 'info');
      return;
    }

    try {
      setLoadingModelInfo(true);
      const result = await window.yibiao?.config.getModelInfo(modelName);
      if (!result?.success || !result.model) {
        showToast(result?.message || '未获取到模型信息', 'info');
        return;
      }

      const modelInfo = result.model;
      const efforts = modelInfo.reasoningEfforts || [];
      const updates: Partial<Omit<SettingsPageState['textModel'], 'provider'>> = {
        concurrency_limit: modelInfo.concurrencyLimit,
        request_mode: modelInfo.requestMode,
      };
      if (efforts.length && state.textModel.reasoning_effort && !efforts.includes(state.textModel.reasoning_effort)) {
        updates.reasoning_effort = '';
      }
      if (modelInfo.context > 0) {
        updates.context_length_limit = modelInfo.context;
      }
      if (modelInfo.imageInputStatus === 'supported' || modelInfo.imageInputStatus === 'mixed') {
        updates.multimodal_enabled = true;
      } else if (modelInfo.imageInputStatus === 'unsupported') {
        updates.multimodal_enabled = false;
      }
      if (modelInfo.temperatureStatus === 'unsupported') {
        updates.temperature_enabled = false;
      }

      setReasoningEfforts(efforts);
      applyTextModelConfig(updates);
      showToast('已获取并填写模型高级参数', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '获取模型信息失败', 'error');
    } finally {
      setLoadingModelInfo(false);
    }
  };

  const fetchImageModels = async () => {
    try {
      setLoadingModels('image');
      if (state.imageModel.provider === 'jinlong' || state.imageModel.provider === 'volcengine' || state.imageModel.provider === 'agnes' || state.imageModel.provider === 'custom') {
        const providerLabel = imageProviderLabels[state.imageModel.provider];
        const baseUrl = state.imageModel.provider === 'custom'
          ? state.imageModel.base_url || ''
          : state.imageModel.base_url || imageProviderDefaults[state.imageModel.provider].base_url || '';

        if (!state.imageModel.api_key.trim()) {
          setImageModels([]);
          showToast(`请先填写${providerLabel} API Key`, 'info');
          return;
        }

        if (!baseUrl.trim()) {
          setImageModels([]);
          showToast(`请先填写${providerLabel} Base URL`, 'info');
          return;
        }

        const config = createClientConfig();
        const result = await window.yibiao?.config.listModels({
          ...config,
          api_key: state.imageModel.api_key,
          base_url: baseUrl,
          model_name: state.imageModel.model_name,
        });
        const models = result?.models || [];
        setImageModels(models);
        if (result?.success && models.length > 0) {
          setState((prev) => ({
            ...prev,
            ...(() => {
              const imageModel = models.includes(prev.imageModel.model_name)
                ? prev.imageModel
                : resetImageModelStatus({ ...prev.imageModel, model_name: models[0] });
              return {
                imageModel,
                imageModelProfiles: {
                  ...prev.imageModelProfiles,
                  [prev.imageModel.provider]: imageProfileFromState(imageModel),
                },
              };
            })(),
          }));
        }
        showToast(result?.message || `获取到 ${models.length} 个${providerLabel}模型`, result?.success ? 'success' : 'info');
        return;
      }

      if (state.imageModel.provider === 'google-ai-studio') {
        const models = [
          'gemini-3.1-flash-image-preview',
          'gemini-3-pro-image-preview',
          'gemini-2.5-flash-image',
        ];
        setImageModels(models);
        setState((prev) => ({
          ...prev,
          ...(() => {
            const imageModel = models.includes(prev.imageModel.model_name)
              ? prev.imageModel
              : resetImageModelStatus({ ...prev.imageModel, model_name: models[0] });
            return {
              imageModel,
              imageModelProfiles: {
                ...prev.imageModelProfiles,
                [prev.imageModel.provider]: imageProfileFromState(imageModel),
              },
            };
          })(),
        }));
        showToast('已载入 Google AI Studio 生图模型', 'success');
        return;
      }

      setImageModels([]);
      showToast('该服务商模型列表接口暂未接入。');
    } finally {
      setLoadingModels(null);
    }
  };

  return {
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
  };
}
