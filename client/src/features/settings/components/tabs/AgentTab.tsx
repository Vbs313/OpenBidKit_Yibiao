// 设置页「agent」分页。
//
// 原本是 SettingsPage.tsx 中 {activeTab === 'agent'} 的 JSX 分支。
// JSX 原样搬出，页面局部量改为同名 props——渲染结果不变。
import type { Dispatch, SetStateAction } from 'react';

import { AppSwitch, InlineSpinner } from '../../../../shared/ui';
import { AgentSelfCheckResult, AgentSelfCheckStepStatus } from '../../../../shared/types';
import { SettingsPageState } from '../../types';
import type { AgentSelfCheckUiStatus } from '../../types';

type AgentTabProps = {
  agentAutoAnswerDraft: boolean;
  agentDiagnosticStatusMeta: Record<AgentSelfCheckStepStatus, { label: string; description: string; }>;
  agentSelfCheckResult: AgentSelfCheckResult | null;
  agentSelfCheckStatus: AgentSelfCheckUiStatus;
  currentAgentSelfCheckStatus: { label: string; description: string; };
  exportAgentSelfCheckReport: () => Promise<void>;
  exportingAgentSelfCheckReport: boolean;
  runAgentSelfCheck: () => Promise<void>;
  setAgentAutoAnswerDraft: Dispatch<SetStateAction<boolean>>;
  state: SettingsPageState;
  updateAgentModeScenario: (key: "existing_plan_expansion_original_outline_extraction", enabled: boolean) => void;
};

export function AgentTab(props: AgentTabProps) {
  return (
<section className="settings-page-section">
          <div className="settings-group-title">智能体</div>
          <div className="settings-list">
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>当前智能体</strong>
                <span>客户端所有智能体任务固定由 Pi Agent 执行。</span>
              </div>
              <span className="settings-readonly-value">Pi Agent</span>
            </div>
          </div>

          <div className="settings-group-title">自动确认</div>
          <div className="settings-list">
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>自动采用推荐方案</strong>
                <span>开启后，需要确认的弹窗会倒计时 8 秒；期间未修改选项或手动提交时，自动执行默认方案。</span>
              </div>
              <AppSwitch checked={props.agentAutoAnswerDraft} onCheckedChange={(checked) => props.setAgentAutoAnswerDraft(checked)} />
            </label>
          </div>

          <div className="settings-group-title">在以下场景启用智能体模式</div>
          <div className="settings-list">
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>已有方案扩写-旧目录提取</strong>
                <span>开启后，已有方案扩写会把原方案交给智能体完成旧目录提取和补漏；关闭后使用原有分段提取流程。</span>
              </div>
              <AppSwitch checked={props.state.agentModeScenarios.existing_plan_expansion_original_outline_extraction} onCheckedChange={(checked) => props.updateAgentModeScenario('existing_plan_expansion_original_outline_extraction', checked)} />
            </label>
          </div>

          <div className="settings-group-title">智能体自检</div>
          <div className={`agent-self-check-status is-${props.agentSelfCheckStatus}`}>
            <div>
              <strong>自检状态</strong>
              <span>{props.currentAgentSelfCheckStatus.description}</span>
            </div>
            <em>{props.currentAgentSelfCheckStatus.label}</em>
          </div>
          <div className="settings-list">
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>运行自检</strong>
                <span>检查 Pi Agent 的模型普通/流式/工具调用、本地 AI Proxy、运行环境、工具和输出链路；失败时自动诊断并尝试安全修复。</span>
              </div>
              <div className="settings-action-cell">
                <button type="button" className="inline-action" onClick={props.runAgentSelfCheck} disabled={props.agentSelfCheckStatus === 'checking'}>
                  {props.agentSelfCheckStatus === 'checking' && <InlineSpinner />}
                  {props.agentSelfCheckStatus === 'checking' ? '自检中' : '自检'}
                </button>
              </div>
            </div>
          </div>
          {props.agentSelfCheckResult && (
            <div className={`agent-self-check-result is-${props.agentSelfCheckResult.success ? 'normal' : props.agentSelfCheckResult.status === 'busy' ? 'busy' : 'error'}`}>
              <div className="agent-self-check-result-head">
                <div>
                  <strong>{props.agentSelfCheckResult.runtime_name}：{props.agentSelfCheckResult.success ? props.agentSelfCheckResult.repaired ? '自检通过（已自动修复）' : '自检通过' : props.agentSelfCheckResult.status === 'busy' ? '自检跳过' : '自检失败'}</strong>
                  <span>{props.agentSelfCheckResult.message}</span>
                </div>
                <div className="agent-self-check-result-actions">
                  <small>{props.agentSelfCheckResult.duration_ms ? `${Math.round(props.agentSelfCheckResult.duration_ms / 1000)} 秒` : props.agentSelfCheckResult.checked_at}</small>
                  <button type="button" className="inline-action" onClick={props.exportAgentSelfCheckReport} disabled={props.exportingAgentSelfCheckReport}>
                    {props.exportingAgentSelfCheckReport && <InlineSpinner />}
                    {props.exportingAgentSelfCheckReport ? '导出中' : '导出报告'}
                  </button>
                </div>
              </div>
              {props.agentSelfCheckResult.steps.length > 0 && (
                <div className="agent-self-check-steps">
                  {props.agentSelfCheckResult.steps.map((step) => (
                    <div className={`agent-self-check-step is-${step.status}`} key={step.id}>
                      <strong>{step.label}</strong>
                      <span>{step.message || step.status}</span>
                    </div>
                  ))}
                </div>
              )}
              {props.agentSelfCheckResult.sections.map((section) => {
                const sectionMeta = props.agentDiagnosticStatusMeta[section.status];
                return (
                  <div className={`agent-diagnostic-section is-${section.status}`} key={section.id}>
                    <div className="agent-diagnostic-section-head">
                      <div>
                        <strong>{section.title}</strong>
                        <span>{section.summary || sectionMeta.description}</span>
                      </div>
                      <em>{sectionMeta.label}</em>
                    </div>
                    {Boolean(section.details?.length) && (
                      <div className="agent-diagnostic-detail-grid">
                        {section.details?.map((item) => (
                          <div key={`${section.id}-${item.label}`}>
                            <span>{item.label}</span>
                            <strong title={item.value}>{item.value || '-'}</strong>
                          </div>
                        ))}
                      </div>
                    )}
                    {Boolean(section.items?.length) && (
                      <div className="agent-tool-check-grid">
                        {section.items?.map((item) => {
                          const itemMeta = props.agentDiagnosticStatusMeta[item.status];
                          return (
                            <div className={`agent-tool-check-item is-${item.status}`} key={item.id} title={item.detail || item.message}>
                              <div>
                                <strong>{item.label}</strong>
                                <em>{itemMeta.label}</em>
                              </div>
                              <span>{item.message || itemMeta.description}</span>
                              {item.detail && <small>{item.detail}</small>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              <pre>{props.agentSelfCheckResult.detail_text}</pre>
            </div>
          )}
        </section>
  );
}
