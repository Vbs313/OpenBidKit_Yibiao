// 设置页「components」分页。
//
// 原本是 SettingsPage.tsx 中 {activeTab === 'components'} 的 JSX 分支。
// JSX 原样搬出，页面局部量改为同名 props——渲染结果不变。
import type { Dispatch, SetStateAction } from 'react';

import { DetailHelpLink } from '../../../../shared/ui';
import { FileParserProvider } from '../../../../shared/types';
import { SettingsPageState } from '../../types';

type ComponentsTabProps = {
  fileParserProviders: { value: FileParserProvider; label: string; }[];
  MAX_COMPONENT_CONCURRENCY_LIMIT: 20;
  MIN_COMPONENT_CONCURRENCY_LIMIT: 1;
  parseComponentConcurrencyLimitInput: (value: string) => number | "";
  parserOptions: { title: string; badge: string; tone: string; summary: string; items: string[][]; }[];
  setState: Dispatch<SetStateAction<SettingsPageState>>;
  state: SettingsPageState;
};

export function ComponentsTab(props: ComponentsTabProps) {
  return (
<section className="settings-page-section">
          <div className="settings-group-title">文件解析</div>
          <div className="settings-list">
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>文件解析方式</strong>
                <span>
                  优先使用本地解析，复杂扫描件可尝试 MinerU 精准解析 API
                  <DetailHelpLink title="文件解析方式说明" label="查看介绍">
                    <div className="parser-help-dialog">
                      <p className="parser-help-note">
                        招标文件大多数是 Word 或 Word 导出的带文字层 PDF，本地解析可以适应 95% 以上的情况；如果解析失败，再尝试 MinerU 精准解析 API。
                      </p>
                      <div className="parser-help-table-wrap">
                        <table className="parser-help-table">
                          <thead>
                            <tr>
                              <th scope="col">对比项</th>
                              {props.parserOptions.map((option) => (
                                <th scope="col" className={`parser-help-col-${option.tone}`} key={option.title}>
                                  <strong>{option.title}</strong>
                                  <span>{option.badge}</span>
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <th scope="row">说明</th>
                              {props.parserOptions.map((option) => (
                                <td key={`${option.title}-summary`}>{option.summary}</td>
                              ))}
                            </tr>
                            {props.parserOptions[0].items.map(([label], rowIndex) => (
                              <tr key={label}>
                                <th scope="row">{label}</th>
                                {props.parserOptions.map((option) => (
                                  <td key={`${option.title}-${label}`}>{option.items[rowIndex][1]}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </DetailHelpLink>
                </span>
              </div>
              <select
                value={props.state.components.file_parser.provider}
                onChange={(event) => props.setState((prev) => ({
                  ...prev,
                  components: {
                    ...prev.components,
                    file_parser: {
                      ...prev.components.file_parser,
                      provider: event.target.value as FileParserProvider,
                    },
                  },
                }))}
              >
                {props.fileParserProviders.map((provider) => (
                  <option value={provider.value} key={provider.value}>{provider.label}</option>
                ))}
              </select>
            </label>
            {props.state.components.file_parser.provider === 'mineru-accurate-api' && (
              <label className="settings-row">
                <div className="settings-row-copy">
                  <strong>MinerU Token</strong>
                  <span>仅精准解析 API 需要 Token；轻量解析和本地解析无需填写</span>
                </div>
                <input
                  type="password"
                  value={props.state.components.file_parser.mineru_token || ''}
                  placeholder="请输入 MinerU Token"
                  onChange={(event) => props.setState((prev) => ({
                    ...prev,
                    components: {
                      ...prev.components,
                      file_parser: {
                        ...prev.components.file_parser,
                        mineru_token: event.target.value,
                      },
                    },
                  }))}
                />
              </label>
            )}
          </div>

          <div className="settings-group-title">本地转图组件</div>
          <div className="settings-list">
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>Mermaid 转换并发量</strong>
                <span>同时本地渲染 Mermaid 图的最大任务数，默认 5</span>
              </div>
              <input
                type="number"
                min={props.MIN_COMPONENT_CONCURRENCY_LIMIT}
                max={props.MAX_COMPONENT_CONCURRENCY_LIMIT}
                value={props.state.components.mermaid_concurrency_limit}
                onChange={(event) => props.setState((prev) => ({
                  ...prev,
                  components: {
                    ...prev.components,
                    mermaid_concurrency_limit: props.parseComponentConcurrencyLimitInput(event.target.value),
                  },
                }))}
              />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>HTML 转换并发量</strong>
                <span>同时本地截取 HTML 配图的最大任务数，默认 5</span>
              </div>
              <input
                type="number"
                min={props.MIN_COMPONENT_CONCURRENCY_LIMIT}
                max={props.MAX_COMPONENT_CONCURRENCY_LIMIT}
                value={props.state.components.html_concurrency_limit}
                onChange={(event) => props.setState((prev) => ({
                  ...prev,
                  components: {
                    ...prev.components,
                    html_concurrency_limit: props.parseComponentConcurrencyLimitInput(event.target.value),
                  },
                }))}
              />
            </label>
          </div>
        </section>
  );
}
