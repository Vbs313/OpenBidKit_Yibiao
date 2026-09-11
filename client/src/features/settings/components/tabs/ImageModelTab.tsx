// 设置页「image-model」分页。
//
// 原本是 SettingsPage.tsx 中 {activeTab === 'image-model'} 的 JSX 分支。
// JSX 原样搬出，页面局部量改为同名 props——渲染结果不变。

import { AiRequestMode, ImageModelConfig, ImageModelProfiles, ImageModelProvider, ImageModelRatio, ImageModelSize, ImageModelStatus } from '../../../../shared/types';
import { InlineSpinner, InputWithAction } from '../../../../shared/ui';
import { SettingsPageState } from '../../types';

type ImageModelTabProps = {
  agnesImageRatioOptions: { value: ImageModelRatio; label: string; }[];
  aiRequestModeOptions: { value: AiRequestMode; label: string; }[];
  currentImageSizeOptions: { value: ImageModelSize; label: string; }[];
  currentImageSizeSupported: boolean;
  currentImageStatus: { label: string; description: string; };
  fetchImageModels: () => Promise<void>;
  getImageApiKeyDescription: (provider: ImageModelProvider) => "用于调用金龙中转站图片生成 API" | "用于调用火山方舟图片生成 API" | "用于调用 Agnes AI 图片生成 API" | "用于调用自定义 OpenAI-like 生图接口" | "ComfyUI 本地服务无需 API Key" | "用于调用 Google AI Studio Gemini API";
  getImageBaseUrlDescription: (provider: ImageModelProvider) => "金龙中转站 OpenAI 兼容接口地址" | "火山方舟 OpenAI 兼容接口地址" | "Agnes AI OpenAI 兼容接口地址" | "填写兼容 OpenAI /images/generations 的接口地址" | "ComfyUI 服务地址，例如 http://127.0.0.1:8188 或局域网地址" | "Google Gemini API REST 地址";
  getImageModelDescription: (provider: ImageModelProvider) => "填写金龙中转站已开通的生图模型名称" | "填写火山方舟控制台中已开通的模型或推理接入点 ID" | "填写 Agnes AI 已开通的生图模型名称" | "填写自定义接口支持的生图模型名称" | "可选：粘贴 ComfyUI「Save (API Format)」导出的工作流 JSON；留空则自动复用服务器上最近成功运行的文生图工作流" | "选择或填写支持图片生成的 Gemini 模型";
  getImageModelPlaceholder: (provider: ImageModelProvider) => "请输入已开通的生图模型名称" | "请输入已开通的模型或推理接入点 ID" | "请输入 Agnes AI 生图模型名称" | "请输入 OpenAI-like 生图模型名称" | "粘贴工作流 JSON（可选，留空自动探测）" | "gemini-3.1-flash-image-preview";
  imageModels: string[];
  imageModelStatus: ImageModelStatus;
  imageProviderDefaults: ImageModelProfiles;
  imageProviders: { value: ImageModelProvider; label: string; }[];
  imageTestPreview: { src: string; title: string; } | null;
  imageTestTime: string;
  loadingModels: "text" | "image" | null;
  openImageProviderApiKeyPage: () => Promise<void>;
  parseImageConcurrencyLimitInput: (value: string) => number | "";
  state: SettingsPageState;
  testImageConfig: () => Promise<void>;
  testingImageModel: boolean;
  updateImageModelConfig: (partial: Partial<Omit<Omit<ImageModelConfig, "concurrency_limit"> & { concurrency_limit: number | ""; }, "provider">>, options?: { clearModels?: boolean; }) => void;
  updateImageModelProvider: (provider: ImageModelProvider) => void;
};

export function ImageModelTab(props: ImageModelTabProps) {
  return (
<section className="settings-page-section">
          <div className={`image-model-status is-${props.imageModelStatus}`}>
            <div>
              <strong>接口状态：{props.currentImageStatus.label}</strong>
              <span>{props.currentImageStatus.description}</span>
              {props.imageTestTime && <small>最近测试：{props.imageTestTime}</small>}
              {props.imageModelStatus === 'unavailable' && props.state.imageModel.last_error && <small>失败原因：{props.state.imageModel.last_error}</small>}
            </div>
            <em>{props.currentImageStatus.label}</em>
          </div>
          <div className="settings-group-title">服务商配置</div>
          <div className="settings-list">
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>服务提供商</strong>
                <span>各家生图接口不统一，先选择服务商再配置模型</span>
              </div>
              <select
                value={props.state.imageModel.provider}
                onChange={(event) => {
                  const provider = event.target.value as ImageModelProvider;
                  props.updateImageModelProvider(provider);
                }}
              >
                {props.imageProviders.map((provider) => (
                  <option value={provider.value} key={provider.value}>{provider.label}</option>
                ))}
              </select>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>Base URL</strong>
                <span>{props.getImageBaseUrlDescription(props.state.imageModel.provider)}</span>
              </div>
              <input
                type="text"
                value={props.state.imageModel.base_url || ''}
                placeholder={props.state.imageModel.provider === 'custom' ? 'https://api.example.com/v1' : props.state.imageModel.provider === 'comfyui' ? 'http://127.0.0.1:8188' : props.imageProviderDefaults[props.state.imageModel.provider].base_url}
                onChange={(event) => props.updateImageModelConfig({ base_url: event.target.value }, { clearModels: true })}
                disabled={props.state.imageModel.provider !== 'custom' && props.state.imageModel.provider !== 'comfyui'}
              />
            </label>
            {props.state.imageModel.provider !== 'comfyui' && (
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>API Key</strong>
                <span>{props.getImageApiKeyDescription(props.state.imageModel.provider)}</span>
              </div>
              <InputWithAction
                type="password"
                value={props.state.imageModel.api_key}
                placeholder="请输入生图服务 API Key"
                onChange={(event) => props.updateImageModelConfig({ api_key: event.target.value }, { clearModels: true })}
                actionLabel="获取"
                actionTitle="打开当前生图服务商的 API Key 获取页面"
                onAction={() => { void props.openImageProviderApiKeyPage(); }}
              />
            </label>
            )}
            {props.state.imageModel.provider === 'comfyui' && (
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>工作流 JSON</strong>
                <span>{props.getImageModelDescription(props.state.imageModel.provider)}</span>
              </div>
              <textarea
                rows={6}
                value={props.state.imageModel.comfyui_workflow || ''}
                placeholder={props.getImageModelPlaceholder(props.state.imageModel.provider)}
                onChange={(event) => props.updateImageModelConfig({ comfyui_workflow: event.target.value })}
              />
            </label>
            )}
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>模型名称</strong>
                <span>{props.state.imageModel.provider === 'comfyui' ? 'ComfyUI 由工作流决定模型，无需填写模型名称' : props.getImageModelDescription(props.state.imageModel.provider)}</span>
              </div>
              <div className="settings-control-with-action">
                {props.state.imageModel.provider !== 'comfyui' && (props.imageModels.length > 0 ? (
                  <select
                    value={props.state.imageModel.model_name}
                    onChange={(event) => props.updateImageModelConfig({ model_name: event.target.value })}
                  >
                    {props.imageModels.map((model) => <option value={model} key={model}>{model}</option>)}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={props.state.imageModel.model_name}
                    placeholder={props.getImageModelPlaceholder(props.state.imageModel.provider)}
                    onChange={(event) => props.updateImageModelConfig({ model_name: event.target.value })}
                  />
                ))}
                {props.state.imageModel.provider !== 'comfyui' && (
                <button
                  type="button"
                  className="inline-action"
                  onClick={props.fetchImageModels}
                  disabled={props.loadingModels === 'image'}
                >
                  {props.loadingModels === 'image' && <InlineSpinner />}
                  {props.loadingModels === 'image' ? '获取中' : '获取'}
                </button>
                )}
                <button type="button" className="inline-action" onClick={props.testImageConfig} disabled={props.testingImageModel}>
                  {props.testingImageModel && <InlineSpinner />}
                  {props.testingImageModel ? '测试中' : '测试'}
                </button>
              </div>
            </label>
          </div>

          <div className="settings-group-title">高级参数</div>
          <div className="settings-list">
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>图片尺寸</strong>
                <span>{props.state.imageModel.provider === 'google-ai-studio'
                  ? '使用 Google AI Studio 官方 imageSize 枚举'
                  : props.state.imageModel.provider === 'comfyui'
                    ? '尺寸会注入工作流的 Latent 节点（宽×高）'
                    : props.state.imageModel.provider === 'agnes' && props.state.imageModel.model_name === 'agnes-image-2.1-flash'
                      ? 'Agnes Image 2.1 Flash 使用 1K 至 4K 尺寸档位'
                      : props.state.imageModel.provider === 'agnes'
                        ? 'Agnes Image 2.0 Flash 使用官方支持的具体尺寸'
                        : '使用 OpenAI Image API 官方常用尺寸枚举'}</span>
              </div>
              <select
                value={props.state.imageModel.image_size}
                onChange={(event) => props.updateImageModelConfig({ image_size: event.target.value as ImageModelSize })}
              >
                {!props.currentImageSizeSupported && (
                  <option value={props.state.imageModel.image_size} disabled>
                    {props.state.imageModel.image_size}（当前模型不支持，请重新选择）
                  </option>
                )}
                {props.currentImageSizeOptions.map((option) => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            {props.state.imageModel.provider === 'agnes' && props.state.imageModel.model_name === 'agnes-image-2.1-flash' && (
              <label className="settings-row">
                <div className="settings-row-copy">
                  <strong>图片宽高比</strong>
                  <span>与 1K 至 4K 尺寸档位配合使用</span>
                </div>
                <select
                  value={props.state.imageModel.image_ratio || '1:1'}
                  onChange={(event) => props.updateImageModelConfig({ image_ratio: event.target.value as ImageModelRatio })}
                >
                  {props.agnesImageRatioOptions.map((option) => (
                    <option value={option.value} key={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>并发上限</strong>
                <span>全局生图 AI 请求同时执行的最大数量，超出后自动排队</span>
              </div>
              <input
                type="number"
                min={1}
                step={1}
                value={props.state.imageModel.concurrency_limit}
                placeholder="2"
                onChange={(event) => props.updateImageModelConfig({ concurrency_limit: props.parseImageConcurrencyLimitInput(event.target.value) })}
              />
            </label>
            {props.state.imageModel.provider !== 'comfyui' && (
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>请求方式</strong>
                <span>{props.state.imageModel.provider === 'agnes'
                  ? 'Agnes 生图接口使用普通请求'
                  : '流式请求只影响后端调用方式，应用仍等待完整图片生成后继续流程'}</span>
              </div>
              <select
                value={props.state.imageModel.request_mode}
                onChange={(event) => props.updateImageModelConfig({ request_mode: event.target.value as AiRequestMode })}
              >
                {props.aiRequestModeOptions.map((option) => (
                  <option value={option.value} key={option.value} disabled={props.state.imageModel.provider === 'agnes' && option.value === 'stream'}>
                    {option.label}{props.state.imageModel.provider === 'agnes' && option.value === 'stream' ? '（Agnes 不支持）' : ''}
                  </option>
                ))}
              </select>
            </label>
            )}
          </div>
          {props.imageTestPreview && (
            <div className="image-test-preview">
              <div>
                <strong>{props.imageTestPreview.title}</strong>
                <span>用于确认当前生图配置可用</span>
              </div>
              <img src={props.imageTestPreview.src} alt="生图模型测试结果" />
            </div>
          )}
        </section>
  );
}
