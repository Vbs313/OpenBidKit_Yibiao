// 设置页「general」分页。
//
// 原本是 SettingsPage.tsx 中 {activeTab === 'general'} 的 JSX 分支。
// JSX 原样搬出，页面局部量改为同名 props——渲染结果不变。

import { UpdateChannel } from '../../../../shared/types';
import { AppSwitch } from '../../../../shared/ui';
import { SettingsPageState } from '../../types';

type GeneralTabProps = {
  openConfigFolder: () => Promise<void>;
  openDeveloperAgentMonitorWindow: () => Promise<void>;
  openDeveloperTokenStatsWindow: () => Promise<void>;
  state: SettingsPageState;
  updateChannelOptions: { value: UpdateChannel; label: string; description: string; }[];
  updateDeveloperAgentMonitorAutoOpen: (autoOpen: boolean) => void;
  updateDeveloperMode: (developerMode: boolean) => void;
  updateDeveloperTokenStatsAutoOpen: (autoOpen: boolean) => void;
  updateGpuHardwareAcceleration: (enabled: boolean) => void;
  updateUpdateChannel: (updateChannel: UpdateChannel) => void;
};

export function GeneralTab(props: GeneralTabProps) {
  return (
<section className="settings-page-section">
          <div className="settings-group-title">外观</div>
          <div className="settings-list">
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>显示语言</strong>
                <span>选择界面的显示语言</span>
              </div>
              <select value="zh-CN" disabled>
                <option value="zh-CN">简体中文</option>
              </select>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>应用主题</strong>
                <span>切换深色或浅色模式</span>
              </div>
              <select value="system" disabled>
                <option value="system">跟随系统</option>
              </select>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>侧边栏布局</strong>
                <span>保持当前经典布局，后续可扩展为紧凑布局</span>
              </div>
              <select value="classic" disabled>
                <option value="classic">经典布局</option>
              </select>
            </div>
          </div>

          <div className="settings-group-title">更新与系统</div>
          <div className="settings-list">
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>自动更新渠道</strong>
                <span>{props.updateChannelOptions.find((option) => option.value === props.state.general.update_channel)?.description || '选择自动检查更新和下载客户端安装包的来源'}</span>
              </div>
              <select
                value={props.state.general.update_channel}
                onChange={(event) => props.updateUpdateChannel(event.target.value as UpdateChannel)}
              >
                {props.updateChannelOptions.map((option) => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>GPU 硬件加速</strong>
                <span>启用后界面可能更流畅；极少数电脑启用后会闪退，关闭后兼容性更好。修改后需重启生效。</span>
              </div>
              <AppSwitch checked={props.state.general.gpu_hardware_acceleration_enabled} onCheckedChange={(checked) => props.updateGpuHardwareAcceleration(checked)} />
            </label>
          </div>

          <div className="settings-group-title">开发者</div>
          <div className="settings-list">
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>开发者模式</strong>
                <span>会打乱既有工作流，生成大量日志占用磁盘空间，<strong>非专业人士请勿开启</strong></span>
              </div>
              <AppSwitch checked={props.state.general.developer_mode} onCheckedChange={(checked) => props.updateDeveloperMode(checked)} />
            </label>
            {props.state.general.developer_mode && (
              <>
                <label className="settings-row">
                  <div className="settings-row-copy">
                    <strong>默认打开 Token 统计小窗</strong>
                    <span>开启后，应用下次启动时自动打开开发者 Token 统计悬浮窗</span>
                  </div>
                  <AppSwitch checked={props.state.general.developer_token_stats_auto_open} onCheckedChange={(checked) => props.updateDeveloperTokenStatsAutoOpen(checked)} />
                </label>
                <label className="settings-row">
                  <div className="settings-row-copy">
                    <strong>默认打开 Pi Agent 执行监视器</strong>
                    <span>开启后，应用下次启动时自动打开 Pi Agent 执行监视器</span>
                  </div>
                  <AppSwitch checked={props.state.general.developer_agent_monitor_auto_open} onCheckedChange={(checked) => props.updateDeveloperAgentMonitorAutoOpen(checked)} />
                </label>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>Token 统计小窗</strong>
                    <span>半透明悬浮展示文本模型输入、输出、总量、缓存命中和请求次数</span>
                  </div>
                  <div className="settings-action-cell">
                    <button type="button" className="inline-action" onClick={props.openDeveloperTokenStatsWindow}>
                      打开 Token 统计小窗
                    </button>
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>Pi Agent 执行监视器</strong>
                    <span>只读查看窗口打开后的任务输入、助手输出、工具调用和最终结果；关闭后立即停止采集</span>
                  </div>
                  <div className="settings-action-cell">
                    <button type="button" className="inline-action" onClick={props.openDeveloperAgentMonitorWindow}>
                      打开 Pi Agent 执行监视器
                    </button>
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>配置文件夹</strong>
                    <span>打开本机配置、工作区缓存和开发者日志所在目录</span>
                  </div>
                  <div className="settings-action-cell">
                    <button type="button" className="inline-action" onClick={props.openConfigFolder}>
                      打开配置文件夹
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </section>
  );
}
