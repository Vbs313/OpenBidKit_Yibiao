// 设置页「text-model」分页。
//
// 原本是 SettingsPage.tsx 中 {activeTab === 'text-model'} 的 JSX 分支。
// JSX 原样搬出，页面局部量改为同名 props——渲染结果不变。

import { AiRequestMode, TextModelConfig, TextModelProvider } from '../../../../shared/types';
import { AppSwitch, InlineSpinner, InputWithAction } from '../../../../shared/ui';
import { SettingsPageState } from '../../types';

type TextModelTabProps = {
  aiRequestModeOptions: { value: AiRequestMode; label: string; }[];
  currentTextProviderDefault: TextModelConfig;
  fetchTextModelInfo: () => Promise<void>;
  fetchTextModels: () => Promise<void>;
  loadingModelInfo: boolean;
  loadingModels: "text" | "image" | null;
  openTextProviderApiKeyPage: () => Promise<void>;
  parseTextConcurrencyLimitInput: (value: string) => number | "";
  parseTextContextLengthInput: (value: string) => number | "";
  parseTextTemperatureInput: (value: string) => number;
  reasoningEfforts: string[];
  state: SettingsPageState;
  testingTextModel: boolean;
  testTextConfig: () => Promise<void>;
  textModelProviders: { value: TextModelProvider; label: string; }[];
  textModels: string[];
  textProviderApiKeyUrls: Partial<Record<TextModelProvider, string>>;
  updateTextModelConfig: (partial: Partial<Omit<Omit<TextModelConfig, "context_length_limit" | "concurrency_limit"> & { context_length_limit: number | ""; concurrency_limit: number | ""; provider: TextModelProvider; }, "provider">>, options?: { clearModels?: boolean; }) => void;
  updateTextModelName: (modelName: string) => void;
  updateTextModelProvider: (provider: TextModelProvider) => void;
};

export function TextModelTab(props: TextModelTabProps) {
  return (
<section className="settings-page-section">
          <div className="settings-group-title">服务商配置</div>
          <div className="settings-list">
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>服务提供商</strong>
                <span>选择服务商会自动使用预置 Base URL；只有自定义服务商允许修改</span>
              </div>
              <select
                value={props.state.textModel.provider}
                onChange={(event) => props.updateTextModelProvider(event.target.value as TextModelProvider)}
              >
                {props.textModelProviders.map((provider) => (
                  <option value={provider.value} key={provider.value}>{provider.label}</option>
                ))}
              </select>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>Base URL</strong>
                <span>OpenAI Like 接口地址，用于文本生成和分析任务</span>
              </div>
              <input
                type="text"
                value={props.state.textModel.base_url}
                placeholder={props.currentTextProviderDefault.base_url || '例如 https://api.openai.com/v1'}
                onChange={(event) => props.updateTextModelConfig({ base_url: event.target.value }, { clearModels: true })}
                disabled={props.state.textModel.provider !== 'custom'}
              />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>API Key</strong>
                <span>仅保存在本机配置文件中，不暴露给 Renderer 以外的原始能力</span>
              </div>
              <InputWithAction
                type="password"
                value={props.state.textModel.api_key}
                placeholder="请输入文本模型 API Key"
                onChange={(event) => props.updateTextModelConfig({ api_key: event.target.value }, { clearModels: true })}
                actionLabel="获取"
                actionTitle="打开当前服务商的 API Key 获取页面"
                actionDisabled={!props.textProviderApiKeyUrls[props.state.textModel.provider]}
                onAction={() => { void props.openTextProviderApiKeyPage(); }}
              />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>模型名称</strong>
                <span>可手动录入，也可从当前 Base URL 拉取可用模型</span>
              </div>
              <div className="settings-control-with-action">
                {props.textModels.length > 0 ? (
                  <select
                    value={props.state.textModel.model_name}
                    onChange={(event) => props.updateTextModelName(event.target.value)}
                  >
                    {props.textModels.map((model) => <option value={model} key={model}>{model}</option>)}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={props.state.textModel.model_name}
                    placeholder="例如 deepseek-chat"
                    onChange={(event) => props.updateTextModelName(event.target.value)}
                  />
                )}
                <button
                  type="button"
                  className="inline-action"
                  onClick={props.fetchTextModels}
                  disabled={props.loadingModels === 'text'}
                >
                  {props.loadingModels === 'text' && <InlineSpinner />}
                  {props.loadingModels === 'text' ? '获取中' : '获取'}
                </button>
                <button type="button" className="inline-action" onClick={props.testTextConfig} disabled={props.testingTextModel}>
                  {props.testingTextModel && <InlineSpinner />}
                  {props.testingTextModel ? '测试中' : '测试'}
                </button>
              </div>
            </label>
          </div>

          <div className="settings-group-title settings-group-title-with-action">
            <span>高级参数</span>
            <button type="button" className="inline-action settings-group-action" onClick={props.fetchTextModelInfo} disabled={props.loadingModelInfo}>
              {props.loadingModelInfo && <InlineSpinner />}
              {props.loadingModelInfo ? '填充中' : '自动填充高级参数'}
            </button>
          </div>
          <div className="settings-list">
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>支持多模态</strong>
                <span>开启后允许文本模型接收图片；关闭时带图片的请求会在本地拦截</span>
              </div>
              <div className="settings-action-cell">
                <AppSwitch aria-label="支持多模态" checked={props.state.textModel.multimodal_enabled} onCheckedChange={(checked) => props.updateTextModelConfig({ multimodal_enabled: checked })} />
              </div>
            </div>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>模型思考强度</strong>
                <span>可手动录入，自动填充后可选择模型明确支持的档位；选择默认时不发送参数</span>
              </div>
              {props.reasoningEfforts.length > 0 ? (
                <select
                  value={props.state.textModel.reasoning_effort}
                  onChange={(event) => props.updateTextModelConfig({ reasoning_effort: event.target.value })}
                >
                  <option value="">默认</option>
                  {props.reasoningEfforts.map((effort) => <option value={effort} key={effort}>{effort}</option>)}
                </select>
              ) : (
                <input
                  type="text"
                  value={props.state.textModel.reasoning_effort}
                  placeholder="例如 medium；留空则使用默认"
                  onChange={(event) => props.updateTextModelConfig({ reasoning_effort: event.target.value })}
                />
              )}
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>上下文长度限制</strong>
                <span>可手动录入或自动填充；处理长文本时会自动截断并分批处理</span>
              </div>
              <input
                type="number"
                min={1}
                step={1}
                value={props.state.textModel.context_length_limit}
                placeholder="400000"
                onChange={(event) => props.updateTextModelConfig({ context_length_limit: props.parseTextContextLengthInput(event.target.value) })}
              />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>并发上限</strong>
                <span>全局文本 AI 请求同时执行的最大数量，超出后自动排队</span>
              </div>
              <input
                type="number"
                min={1}
                step={1}
                value={props.state.textModel.concurrency_limit}
                placeholder="10"
                onChange={(event) => props.updateTextModelConfig({ concurrency_limit: props.parseTextConcurrencyLimitInput(event.target.value) })}
              />
            </label>
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>模型温度</strong>
                <span>默认关闭以兼容不支持温度参数的模型；开启后数值越低输出越稳定</span>
              </div>
              <div className={`settings-temperature-control ${props.state.textModel.temperature_enabled ? '' : 'is-disabled'}`}>
                <AppSwitch aria-label="启用模型温度" checked={props.state.textModel.temperature_enabled} onCheckedChange={(checked) => props.updateTextModelConfig({ temperature_enabled: checked })} />
                <input
                  className="settings-temperature-slider"
                  type="range"
                  aria-label="模型温度"
                  min={0}
                  max={2}
                  step={0.1}
                  value={props.state.textModel.temperature}
                  disabled={!props.state.textModel.temperature_enabled}
                  onChange={(event) => props.updateTextModelConfig({ temperature: props.parseTextTemperatureInput(event.target.value) })}
                />
                <output>{props.state.textModel.temperature.toFixed(1)}</output>
              </div>
            </div>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>请求方式</strong>
                <span>流式请求只影响后端调用方式，应用仍等待完整结果后继续流程</span>
              </div>
              <select
                value={props.state.textModel.request_mode}
                onChange={(event) => props.updateTextModelConfig({ request_mode: event.target.value as AiRequestMode })}
              >
                {props.aiRequestModeOptions.map((option) => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
        </section>
  );
}
