// 设置页的纯模型层：选项常量、provider 默认值、状态归一化与派生。
//
// 原本全部堆在 SettingsPage.tsx 的模块顶层（约 600 行）。它们不依赖 React、不读组件状态，
// 因此下沉为独立模块；页面与后续的自定义 hook 都从这里 import。
import { AgentSelfCheckUiStatus, SettingsPageState } from './types';
import { AgentModeScenariosConfig, AgentSelfCheckStepStatus, AiRequestMode, ComponentsConfig, FileParserProvider, ImageModelConfig, ImageModelProfiles, ImageModelProvider, ImageModelRatio, ImageModelSize, ImageModelStatus, LicenseRuntimeStatus, TextModelConfig, TextModelProfiles, TextModelProvider, UpdateChannel } from '../../shared/types';

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

function normalizeComponentConcurrencyLimit(value?: number | string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_COMPONENT_CONCURRENCY_LIMIT;
  return Math.min(MAX_COMPONENT_CONCURRENCY_LIMIT, Math.max(MIN_COMPONENT_CONCURRENCY_LIMIT, Math.round(number)));
}

function parseComponentConcurrencyLimitInput(value: string): number | '' {
  if (value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return Math.min(MAX_COMPONENT_CONCURRENCY_LIMIT, Math.max(MIN_COMPONENT_CONCURRENCY_LIMIT, Math.round(number)));
}

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

export type {
  SettingsTab,
  SettingsPageProps,
};

export {
  settingsTabs,
  agentSelfCheckStatusMeta,
  agentDiagnosticStatusMeta,
  updateChannelOptions,
  defaultAgentModeScenarios,
  normalizeUpdateChannel,
  normalizeAgentModeScenarios,
  getLicenseSourceLabel,
  textModelProviders,
  aiRequestModeOptions,
  DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT,
  DEFAULT_TEXT_CONCURRENCY_LIMIT,
  DEFAULT_TEXT_TEMPERATURE,
  textProviderDefaults,
  textProviderApiKeyUrls,
  createDefaultTextModelProfiles,
  normalizeAiRequestMode,
  normalizeTextContextLengthLimit,
  normalizeTextConcurrencyLimit,
  normalizeTextTemperature,
  parseTextContextLengthInput,
  parseTextConcurrencyLimitInput,
  parseTextTemperatureInput,
  normalizeTextModelProfile,
  normalizeTextModelProfiles,
  textProfileFromState,
  imageProviders,
  DEFAULT_IMAGE_CONCURRENCY_LIMIT,
  openAICompatibleImageSizeOptions,
  googleImageSizeOptions,
  agnesImage20SizeOptions,
  agnesImage21SizeOptions,
  agnesImageRatioOptions,
  getImageSizeOptions,
  normalizeImageSize,
  imageProviderDefaults,
  imageProviderApiKeyUrls,
  imageProviderLabels,
  getImageBaseUrlDescription,
  getImageApiKeyDescription,
  getImageModelDescription,
  getImageModelPlaceholder,
  createDefaultImageModelProfiles,
  normalizeImageModelProfile,
  normalizeImageConcurrencyLimit,
  parseImageConcurrencyLimitInput,
  DEFAULT_COMPONENT_CONCURRENCY_LIMIT,
  MIN_COMPONENT_CONCURRENCY_LIMIT,
  MAX_COMPONENT_CONCURRENCY_LIMIT,
  normalizeComponentConcurrencyLimit,
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
};
