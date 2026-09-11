
import { useAppUpdate } from '../hooks/useAppUpdate';
import { useEffect, useState } from 'react';
import { trackConfigUsage } from '../../../shared/analytics/analytics';
import { AppSwitch, DetailHelpLink, FloatingToolbar, InlineSpinner, InputWithAction, OfflineLicenseActivationDialog, useAutoAnswer, useToast } from '../../../shared/ui';
import { showUpdateReadyToast } from '../../../shared/updateToast';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import type { AgentModeScenariosConfig, AgentSelfCheckResult, AgentSelfCheckStepStatus, AiRequestMode, ClientConfig, ComponentsConfig, FileParserProvider, ImageModelConfig, ImageModelProfiles, ImageModelProvider, ImageModelRatio, ImageModelSize, ImageModelStatus, LicenseRuntimeStatus, TextModelConfig, TextModelProfiles, TextModelProvider, UpdateChannel } from '../../../shared/types';
import type { SettingsPageState } from '../types';
import { GeneralTab } from '../components/tabs/GeneralTab';
import { TextModelTab } from '../components/tabs/TextModelTab';
import { ImageModelTab } from '../components/tabs/ImageModelTab';
import { ComponentsTab } from '../components/tabs/ComponentsTab';
import { AgentTab } from '../components/tabs/AgentTab';
import { AboutTab } from '../components/tabs/AboutTab';
import type { AgentSelfCheckUiStatus, UpdateStatus } from '../types';

type SettingsTab = 'general' | 'text-model' | 'image-model' | 'components' | 'agent' | 'about';

const settingsTabs: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: '通用' },
  { id: 'text-model', label: '文本模型' },
  { id: 'image-model', label: '生图模型' },
  { id: 'components', label: '组件设置' },
  { id: 'agent', label: '智能体配置' },
  { id: 'about', label: '关于' },
];

const agentSelfCheckStatusMeta: Record<AgentSelfCheckUiStatus, { label: string; description: string }> = {
  untested: { label: '未检测', description: '点击自检后，会验证 Pi Agent 的环境、工具、文本模型和输出链路。' },
  checking: { label: '检测中', description: '正在检查 Pi Agent 运行环境、工具链与极简任务。' },
  normal: { label: '正常', description: 'Pi Agent 和关键集成能力已通过自检。' },
  busy: { label: '忙碌', description: 'Pi Agent 正在处理其他任务，本次自检已跳过。' },
  error: { label: '异常', description: 'Pi Agent 链路自检失败，请查看下方错误详情。' },
};

const agentDiagnosticStatusMeta: Record<AgentSelfCheckStepStatus, { label: string; description: string }> = {
  pending: { label: '待检查', description: '尚未执行检查。' },
  running: { label: '检查中', description: '正在执行检查。' },
  success: { label: '正常', description: '检查已通过。' },
  warning: { label: '警告', description: '检查完成，但存在需要留意的信息。' },
  error: { label: '异常', description: '检查未通过。' },
  skipped: { label: '已跳过', description: '因前置条件不足或无需执行而跳过。' },
};

const updateChannelOptions: Array<{ value: UpdateChannel; label: string; description: string }> = [
  { value: 'github', label: 'GitHub', description: '使用 GitHub Release 检查和下载更新' },
  { value: 'cloudflare', label: 'Cloudflare', description: '使用 Cloudflare R2 镜像检查和下载更新' },
  { value: 'atomgit', label: 'AtomGit', description: '使用 AtomGit Release 检查和下载更新' },
];

const defaultAgentModeScenarios: AgentModeScenariosConfig = {
  existing_plan_expansion_original_outline_extraction: true,
};

function normalizeUpdateChannel(value?: string): UpdateChannel {
  if (value === 'cloudflare' || value === 'atomgit') {
    return value;
  }
  return 'atomgit';
}

function normalizeAgentModeScenarios(value?: Partial<AgentModeScenariosConfig>): AgentModeScenariosConfig {
  return {
    existing_plan_expansion_original_outline_extraction: value?.existing_plan_expansion_original_outline_extraction === undefined
      ? defaultAgentModeScenarios.existing_plan_expansion_original_outline_extraction
      : Boolean(value.existing_plan_expansion_original_outline_extraction),
  };
}

function getLicenseSourceLabel(status: LicenseRuntimeStatus | null) {
  if (!status) return '读取中';
  return status.sourceTrusted ? '官方发行版' : '不可信的客户端来源';
}

const textModelProviders: Array<{ value: TextModelProvider; label: string }> = [
  { value: 'jinlong', label: '金龙中转站【推荐】' },
  { value: 'volcengine', label: '火山方舟' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'agnes', label: 'Agnes AI' },
  { value: 'custom', label: '自定义' },
];

const aiRequestModeOptions: Array<{ value: AiRequestMode; label: string }> = [
  { value: 'normal', label: '普通请求' },
  { value: 'stream', label: '流式请求' },
];

const DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT = 400000;
const DEFAULT_TEXT_CONCURRENCY_LIMIT = 10;
const DEFAULT_TEXT_TEMPERATURE = 0.7;

const textProviderDefaults: Record<TextModelProvider, TextModelConfig> = {
  jinlong: { api_key: '', base_url: 'https://jlaudeapi.com/v1', model_name: 'gpt-3.5-turbo', multimodal_enabled: false, reasoning_effort: '', context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT, concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT, temperature_enabled: false, temperature: DEFAULT_TEXT_TEMPERATURE, request_mode: 'stream' },
  volcengine: { api_key: '', base_url: 'https://ark.cn-beijing.volces.com/api/v3', model_name: '', multimodal_enabled: false, reasoning_effort: '', context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT, concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT, temperature_enabled: false, temperature: DEFAULT_TEXT_TEMPERATURE, request_mode: 'stream' },
  deepseek: { api_key: '', base_url: 'https://api.deepseek.com', model_name: '', multimodal_enabled: false, reasoning_effort: '', context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT, concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT, temperature_enabled: false, temperature: DEFAULT_TEXT_TEMPERATURE, request_mode: 'stream' },
  agnes: { api_key: '', base_url: 'https://apihub.agnes-ai.com/v1', model_name: '', multimodal_enabled: false, reasoning_effort: '', context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT, concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT, temperature_enabled: false, temperature: DEFAULT_TEXT_TEMPERATURE, request_mode: 'stream' },
  custom: { api_key: '', base_url: '', model_name: '', multimodal_enabled: false, reasoning_effort: '', context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT, concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT, temperature_enabled: false, temperature: DEFAULT_TEXT_TEMPERATURE, request_mode: 'stream' },
};

const textProviderApiKeyUrls: Partial<Record<TextModelProvider, string>> = {
  jinlong: 'https://s.markup.com.cn/jl',
  volcengine: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  deepseek: 'https://platform.deepseek.com/api_keys',
  agnes: 'https://platform.agnes-ai.com/settings/apiKeys',
};

function createDefaultTextModelProfiles(): TextModelProfiles {
  return textModelProviders.reduce((profiles, provider) => ({
    ...profiles,
    [provider.value]: { ...textProviderDefaults[provider.value] },
  }), {} as TextModelProfiles);
}

function normalizeAiRequestMode(value?: AiRequestMode): AiRequestMode {
  return value === 'normal' ? 'normal' : 'stream';
}

function normalizeTextContextLengthLimit(value?: number | string): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT;
}

function normalizeTextConcurrencyLimit(value?: number | string): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : DEFAULT_TEXT_CONCURRENCY_LIMIT;
}

// 归一化文本模型温度。
function normalizeTextTemperature(value?: number | string): number {
  if (value === '' || value === undefined) return DEFAULT_TEXT_TEMPERATURE;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 2 ? number : DEFAULT_TEXT_TEMPERATURE;
}

function parseTextContextLengthInput(value: string): number | '' {
  if (value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.floor(number)) : '';
}

function parseTextConcurrencyLimitInput(value: string): number | '' {
  if (value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.round(number)) : '';
}

// 解析温度滑动条输入。
function parseTextTemperatureInput(value: string): number {
  return normalizeTextTemperature(value);
}

function normalizeTextModelProfile(provider: TextModelProvider, profile?: Partial<TextModelConfig>): TextModelConfig {
  const defaults = textProviderDefaults[provider];
  const baseUrl = provider === 'custom' ? profile?.base_url ?? defaults.base_url : defaults.base_url;
  return {
    api_key: profile?.api_key ?? defaults.api_key,
    base_url: baseUrl,
    model_name: profile?.model_name ?? defaults.model_name,
    multimodal_enabled: profile?.multimodal_enabled ?? defaults.multimodal_enabled,
    reasoning_effort: profile?.reasoning_effort?.trim() ?? defaults.reasoning_effort,
    context_length_limit: normalizeTextContextLengthLimit(profile?.context_length_limit ?? defaults.context_length_limit),
    concurrency_limit: normalizeTextConcurrencyLimit(profile?.concurrency_limit ?? defaults.concurrency_limit),
    temperature_enabled: profile?.temperature_enabled ?? defaults.temperature_enabled,
    temperature: normalizeTextTemperature(profile?.temperature ?? defaults.temperature),
    request_mode: normalizeAiRequestMode(profile?.request_mode ?? defaults.request_mode),
  };
}

function normalizeTextModelProfiles(
  profiles?: Partial<Record<TextModelProvider, TextModelConfig>>,
): TextModelProfiles {
  return textModelProviders.reduce((normalizedProfiles, provider) => ({
    ...normalizedProfiles,
    [provider.value]: normalizeTextModelProfile(provider.value, profiles?.[provider.value]),
  }), {} as TextModelProfiles);
}

function textProfileFromState(textModel: SettingsPageState['textModel']): TextModelConfig {
  return {
    api_key: textModel.api_key,
    base_url: textModel.provider === 'custom' ? textModel.base_url : textProviderDefaults[textModel.provider].base_url,
    model_name: textModel.model_name,
    multimodal_enabled: textModel.multimodal_enabled,
    reasoning_effort: textModel.reasoning_effort.trim(),
    context_length_limit: normalizeTextContextLengthLimit(textModel.context_length_limit),
    concurrency_limit: normalizeTextConcurrencyLimit(textModel.concurrency_limit),
    temperature_enabled: textModel.temperature_enabled,
    temperature: normalizeTextTemperature(textModel.temperature),
    request_mode: textModel.request_mode,
  };
}

const imageProviders: Array<{ value: ImageModelProvider; label: string }> = [
  { value: 'jinlong', label: '金龙中转站【推荐】' },
  { value: 'volcengine', label: '火山方舟' },
  { value: 'google-ai-studio', label: 'Google AI Studio' },
  { value: 'agnes', label: 'Agnes AI' },
  { value: 'custom', label: '自定义 OpenAI-like' },
  { value: 'comfyui', label: 'ComfyUI（本地/局域网）' },
];

const DEFAULT_IMAGE_CONCURRENCY_LIMIT = 2;

const openAICompatibleImageSizeOptions: Array<{ value: ImageModelSize; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: '1024x1024', label: '1024×1024（1K 方图）' },
  { value: '1536x1024', label: '1536×1024（1K 横图）' },
  { value: '1024x1536', label: '1024×1536（1K 竖图）' },
  { value: '2048x2048', label: '2048×2048（2K 方图）' },
  { value: '2048x1152', label: '2048×1152（2K 横图）' },
  { value: '3840x2160', label: '3840×2160（4K 横图）' },
  { value: '2160x3840', label: '2160×3840（4K 竖图）' },
];

const googleImageSizeOptions: Array<{ value: ImageModelSize; label: string }> = [
  { value: '512', label: '512' },
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
  { value: '4K', label: '4K' },
];

const agnesImage20SizeOptions: Array<{ value: ImageModelSize; label: string }> = [
  { value: '1024x1024', label: '1024×1024（方图）' },
  { value: '1024x768', label: '1024×768（横图）' },
  { value: '768x1024', label: '768×1024（竖图）' },
];

const agnesImage21SizeOptions: Array<{ value: ImageModelSize; label: string }> = [
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
  { value: '3K', label: '3K' },
  { value: '4K', label: '4K' },
];

const agnesImageRatioOptions: Array<{ value: ImageModelRatio; label: string }> = [
  { value: '1:1', label: '1:1（方图）' },
  { value: '3:4', label: '3:4（竖图）' },
  { value: '4:3', label: '4:3（横图）' },
  { value: '16:9', label: '16:9（宽屏）' },
  { value: '9:16', label: '9:16（竖屏）' },
  { value: '2:3', label: '2:3（竖图）' },
  { value: '3:2', label: '3:2（横图）' },
  { value: '21:9', label: '21:9（超宽屏）' },
];

function getImageSizeOptions(provider: ImageModelProvider, modelName = '') {
  if (provider === 'google-ai-studio') return googleImageSizeOptions;
  if (provider === 'comfyui') return openAICompatibleImageSizeOptions.filter((option) => option.value !== 'auto');
  if (provider === 'agnes' && modelName === 'agnes-image-2.1-flash') return agnesImage21SizeOptions;
  if (provider === 'agnes') return agnesImage20SizeOptions;
  return openAICompatibleImageSizeOptions;
}

function normalizeImageSize(provider: ImageModelProvider, value?: string): ImageModelSize {
  const options = provider === 'google-ai-studio'
    ? googleImageSizeOptions
    : provider === 'agnes'
      ? [...openAICompatibleImageSizeOptions, ...agnesImage20SizeOptions, ...agnesImage21SizeOptions]
      : openAICompatibleImageSizeOptions;
  const candidate = String(value || '').trim() as ImageModelSize;
  return options.some((option) => option.value === candidate)
    ? candidate
    : provider === 'google-ai-studio' ? '1K' : '1024x1024';
}

const imageProviderDefaults: ImageModelProfiles = {
  jinlong: {
    provider: 'jinlong',
    base_url: 'https://img-api.jlaudeapi.com/v1',
    api_key: '',
    model_name: 'gpt-image-2',
    image_size: '1024x1024',
    request_mode: 'normal',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  volcengine: {
    provider: 'volcengine',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    api_key: '',
    model_name: '',
    image_size: '1024x1024',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  'google-ai-studio': {
    provider: 'google-ai-studio',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    api_key: '',
    model_name: 'gemini-3.1-flash-image-preview',
    image_size: '1K',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  agnes: {
    provider: 'agnes',
    base_url: 'https://apihub.agnes-ai.com/v1',
    api_key: '',
    model_name: '',
    image_size: '1024x1024',
    image_ratio: '1:1',
    request_mode: 'normal',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  custom: {
    provider: 'custom',
    base_url: '',
    api_key: '',
    model_name: '',
    image_size: '1024x1024',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  comfyui: {
    provider: 'comfyui',
    base_url: 'http://127.0.0.1:8188',
    api_key: '',
    model_name: 'z-image-turbo',
    image_size: '1024x1024',
    request_mode: 'normal',
    concurrency_limit: 1,
    comfyui_workflow: '',
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
};

const imageProviderApiKeyUrls: Record<ImageModelProvider, string> = {
  jinlong: 'https://s.markup.com.cn/jl',
  volcengine: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  'google-ai-studio': 'https://aistudio.google.com/api-keys',
  agnes: 'https://platform.agnes-ai.com/settings/apiKeys',
  custom: '',
  comfyui: '',
};

const imageProviderLabels: Record<ImageModelProvider, string> = {
  jinlong: '金龙中转站',
  volcengine: '火山方舟',
  'google-ai-studio': 'Google AI Studio',
  agnes: 'Agnes AI',
  custom: '自定义生图服务',
  comfyui: 'ComfyUI',
};

function getImageBaseUrlDescription(provider: ImageModelProvider) {
  if (provider === 'jinlong') return '金龙中转站 OpenAI 兼容接口地址';
  if (provider === 'volcengine') return '火山方舟 OpenAI 兼容接口地址';
  if (provider === 'agnes') return 'Agnes AI OpenAI 兼容接口地址';
  if (provider === 'custom') return '填写兼容 OpenAI /images/generations 的接口地址';
  if (provider === 'comfyui') return 'ComfyUI 服务地址，例如 http://127.0.0.1:8188 或局域网地址';
  return 'Google Gemini API REST 地址';
}

function getImageApiKeyDescription(provider: ImageModelProvider) {
  if (provider === 'jinlong') return '用于调用金龙中转站图片生成 API';
  if (provider === 'volcengine') return '用于调用火山方舟图片生成 API';
  if (provider === 'agnes') return '用于调用 Agnes AI 图片生成 API';
  if (provider === 'custom') return '用于调用自定义 OpenAI-like 生图接口';
  if (provider === 'comfyui') return 'ComfyUI 本地服务无需 API Key';
  return '用于调用 Google AI Studio Gemini API';
}

function getImageModelDescription(provider: ImageModelProvider) {
  if (provider === 'jinlong') return '填写金龙中转站已开通的生图模型名称';
  if (provider === 'volcengine') return '填写火山方舟控制台中已开通的模型或推理接入点 ID';
  if (provider === 'agnes') return '填写 Agnes AI 已开通的生图模型名称';
  if (provider === 'custom') return '填写自定义接口支持的生图模型名称';
  if (provider === 'comfyui') return '可选：粘贴 ComfyUI「Save (API Format)」导出的工作流 JSON；留空则自动复用服务器上最近成功运行的文生图工作流';
  return '选择或填写支持图片生成的 Gemini 模型';
}

function getImageModelPlaceholder(provider: ImageModelProvider) {
  if (provider === 'jinlong') return '请输入已开通的生图模型名称';
  if (provider === 'volcengine') return '请输入已开通的模型或推理接入点 ID';
  if (provider === 'agnes') return '请输入 Agnes AI 生图模型名称';
  if (provider === 'custom') return '请输入 OpenAI-like 生图模型名称';
  if (provider === 'comfyui') return '粘贴工作流 JSON（可选，留空自动探测）';
  return 'gemini-3.1-flash-image-preview';
}

function createDefaultImageModelProfiles(): ImageModelProfiles {
  return imageProviders.reduce((profiles, provider) => ({
    ...profiles,
    [provider.value]: { ...imageProviderDefaults[provider.value] },
  }), {} as ImageModelProfiles);
}

function normalizeImageModelProfile(provider: ImageModelProvider, profile?: Partial<ImageModelConfig>): ImageModelConfig {
  const defaults = imageProviderDefaults[provider];
  const useProviderDefaultImageModel = provider === 'jinlong' && !String(profile?.model_name ?? '').trim();
  return {
    provider,
    base_url: provider === 'custom' || provider === 'comfyui' ? profile?.base_url ?? defaults.base_url : defaults.base_url,
    api_key: profile?.api_key ?? defaults.api_key,
    model_name: useProviderDefaultImageModel ? defaults.model_name : profile?.model_name ?? defaults.model_name,
    image_size: normalizeImageSize(provider, useProviderDefaultImageModel ? defaults.image_size : profile?.image_size ?? defaults.image_size),
    ...(provider === 'agnes' ? { image_ratio: profile?.image_ratio ?? defaults.image_ratio ?? '1:1' } : {}),
    request_mode: normalizeAiRequestMode(useProviderDefaultImageModel ? defaults.request_mode : profile?.request_mode ?? defaults.request_mode),
    concurrency_limit: normalizeImageConcurrencyLimit(profile?.concurrency_limit ?? defaults.concurrency_limit),
    comfyui_workflow: profile?.comfyui_workflow ?? defaults.comfyui_workflow ?? '',
    status: useProviderDefaultImageModel ? defaults.status : profile?.status ?? defaults.status,
    tested_at: useProviderDefaultImageModel ? defaults.tested_at : profile?.tested_at ?? defaults.tested_at,
    last_error: useProviderDefaultImageModel ? defaults.last_error : profile?.last_error ?? defaults.last_error,
  };
}

function normalizeImageConcurrencyLimit(value?: number | string): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : DEFAULT_IMAGE_CONCURRENCY_LIMIT;
}

function parseImageConcurrencyLimitInput(value: string): number | '' {
  if (value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.round(number)) : '';
}

const DEFAULT_COMPONENT_CONCURRENCY_LIMIT = 5;
const MIN_COMPONENT_CONCURRENCY_LIMIT = 1;
const MAX_COMPONENT_CONCURRENCY_LIMIT = 20;

// 归一化组件转换并发量。
function normalizeComponentConcurrencyLimit(value?: number | string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_COMPONENT_CONCURRENCY_LIMIT;
  return Math.min(MAX_COMPONENT_CONCURRENCY_LIMIT, Math.max(MIN_COMPONENT_CONCURRENCY_LIMIT, Math.round(number)));
}

// 解析组件并发输入。
function parseComponentConcurrencyLimitInput(value: string): number | '' {
  if (value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return Math.min(MAX_COMPONENT_CONCURRENCY_LIMIT, Math.max(MIN_COMPONENT_CONCURRENCY_LIMIT, Math.round(number)));
}

// 归一化组件设置状态。
function normalizeComponentsState(components?: Partial<ComponentsConfig>): SettingsPageState['components'] {
  return {
    file_parser: {
      provider: components?.file_parser?.provider || 'local',
      mineru_token: components?.file_parser?.mineru_token || '',
    },
    mermaid_concurrency_limit: normalizeComponentConcurrencyLimit(components?.mermaid_concurrency_limit),
    html_concurrency_limit: normalizeComponentConcurrencyLimit(components?.html_concurrency_limit),
  };
}

// 从设置状态生成可保存的组件配置。
function componentsFromState(components: SettingsPageState['components']): ComponentsConfig {
  return {
    file_parser: {
      provider: components.file_parser.provider,
      mineru_token: components.file_parser.mineru_token || '',
    },
    mermaid_concurrency_limit: normalizeComponentConcurrencyLimit(components.mermaid_concurrency_limit),
    html_concurrency_limit: normalizeComponentConcurrencyLimit(components.html_concurrency_limit),
  };
}

function normalizeImageModelProfiles(profiles?: Partial<ImageModelProfiles>): ImageModelProfiles {
  return imageProviders.reduce((nextProfiles, provider) => ({
    ...nextProfiles,
    [provider.value]: normalizeImageModelProfile(provider.value, profiles?.[provider.value]),
  }), {} as ImageModelProfiles);
}

function imageProfileFromState(imageModel: SettingsPageState['imageModel']): ImageModelConfig {
  return {
    provider: imageModel.provider,
    base_url: imageModel.provider === 'custom' || imageModel.provider === 'comfyui' ? imageModel.base_url || '' : imageProviderDefaults[imageModel.provider].base_url,
    api_key: imageModel.api_key,
    model_name: imageModel.model_name,
    image_size: normalizeImageSize(imageModel.provider, imageModel.image_size),
    ...(imageModel.provider === 'agnes' ? { image_ratio: imageModel.image_ratio || '1:1' } : {}),
    request_mode: imageModel.request_mode,
    concurrency_limit: normalizeImageConcurrencyLimit(imageModel.concurrency_limit),
    comfyui_workflow: imageModel.comfyui_workflow || '',
    status: imageModel.status || 'untested',
    tested_at: imageModel.tested_at || '',
    last_error: imageModel.last_error || '',
  };
}

const imageStatusMeta: Record<ImageModelStatus, { label: string; description: string }> = {
  untested: {
    label: '未测试',
    description: '请点击测试确认当前生图模型可用，正文生成时只有可用状态才会自动配图。',
  },
  available: {
    label: '可用',
    description: '当前生图模型已通过测试，正文生成时会按内容需要自动配图。',
  },
  unavailable: {
    label: '不可用',
    description: '当前生图模型测试失败，正文生成会跳过配图。',
  },
};

function resetImageModelStatus(imageModel: SettingsPageState['imageModel']): SettingsPageState['imageModel'] {
  return {
    ...imageModel,
    status: 'untested',
    tested_at: '',
    last_error: '',
  };
}

function formatImageTestTime(value?: string) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleString('zh-CN', { hour12: false });
}

const fileParserProviders: Array<{ value: FileParserProvider; label: string }> = [
  { value: 'local', label: '本地解析' },
  { value: 'mineru-accurate-api', label: 'MinerU-精准解析 API' },
  { value: 'mineru-agent-api', label: 'MinerU-Agent 轻量解析 API' },
];

const parserOptions = [
  {
    title: '本地解析',
    badge: '推荐默认',
    tone: 'primary',
    summary: '覆盖大多数 Word、Excel 和带文字层 PDF，速度快、无调用限制。',
    items: [
      ['Token', '无需'],
      ['解析速度', '快'],
      ['支持格式', 'pdf、docx、doc、wps、md、xls、xlsx'],
      ['大小/页数', '无限制'],
      ['解析质量', '高'],
      ['扫描件', '不支持'],
    ],
  },
  {
    title: 'MinerU 精准解析 API',
    badge: '扫描件兜底',
    tone: 'accent',
    summary: '解析质量高，适合本地解析失败或扫描件质量要求高的文档。',
    items: [
      ['Token', '需要'],
      ['解析速度', '慢'],
      ['支持格式', 'pdf、doc、docx、ppt、pptx、图片、html；xls/xlsx 自动本地解析'],
      ['大小/页数', '≤ 200MB / ≤ 200 页'],
      ['解析质量', '高'],
      ['扫描件', '支持'],
    ],
  },
  {
    title: 'MinerU-Agent 轻量解析 API',
    badge: '轻量备用',
    tone: 'muted',
    summary: '无需 Token 但存在 IP 限频，适合轻量文档的备用解析。',
    items: [
      ['Token', '无需（IP 限频）'],
      ['解析速度', '中等'],
      ['支持格式', 'pdf、doc、docx、ppt、pptx、图片；xls/xlsx 自动本地解析'],
      ['大小/页数', '≤ 10MB / ≤ 20 页'],
      ['解析质量', '中'],
      ['扫描件', '质量差'],
    ],
  },
];

const initialState: SettingsPageState = {
  textModel: {
    provider: 'jinlong',
    ...textProviderDefaults.jinlong,
  },
  textModelProfiles: createDefaultTextModelProfiles(),
  imageModel: {
    ...imageProviderDefaults.jinlong,
  },
  imageModelProfiles: createDefaultImageModelProfiles(),
  components: {
    file_parser: {
      provider: 'local',
      mineru_token: '',
    },
    mermaid_concurrency_limit: DEFAULT_COMPONENT_CONCURRENCY_LIMIT,
    html_concurrency_limit: DEFAULT_COMPONENT_CONCURRENCY_LIMIT,
  },
  agentModeScenarios: { ...defaultAgentModeScenarios },
  general: {
    developer_mode: false,
    developer_token_stats_auto_open: false,
    developer_agent_monitor_auto_open: false,
    update_channel: 'atomgit',
    gpu_hardware_acceleration_enabled: true,
    gpu_hardware_acceleration_configured: true,
  },
};

interface SettingsPageProps {
  onDeveloperModeChange?: (developerMode: boolean) => void;
}

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
  const [textModels, setTextModels] = useState<string[]>([]);
  const [reasoningEfforts, setReasoningEfforts] = useState<string[]>([]);
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState<'text' | 'image' | null>(null);
  const [loadingModelInfo, setLoadingModelInfo] = useState(false);
  const [testingTextModel, setTestingTextModel] = useState(false);
  const [testingImageModel, setTestingImageModel] = useState(false);
  const textModelBusy = loadingModels === 'text' || loadingModelInfo || testingTextModel;
  const [imageTestPreview, setImageTestPreview] = useState<{ src: string; title: string } | null>(null);
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


  const updateImageModelConfig = (partial: Partial<Omit<SettingsPageState['imageModel'], 'provider'>>, options: { clearModels?: boolean } = {}) => {
    if (options.clearModels) {
      setImageModels([]);
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
    setImageModels([]);
    setImageTestPreview(null);
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
    setTextModels([]);
    setReasoningEfforts([]);
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
      setTextModels([]);
    }

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

  // 更新模型名称，并清空不再适用于新模型的思考强度。
  const updateTextModelName = (modelName: string) => {
    setReasoningEfforts([]);
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
      updateTextModelConfig(updates);
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
