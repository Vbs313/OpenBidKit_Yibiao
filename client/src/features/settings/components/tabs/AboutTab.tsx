// 设置页「about」分页。
//
// 原本是 SettingsPage.tsx 中 {activeTab === 'about'} 的 JSX 分支。
// JSX 原样搬出，页面局部量改为同名 props——渲染结果不变。
import type { Dispatch, SetStateAction } from 'react';

import { LicenseRuntimeStatus } from '../../../../shared/types';
import type { UpdateStatus } from '../../types';

type AboutTabProps = {
  appVersion: string;
  checkForUpdates: () => Promise<void>;
  installDownloadedUpdate: () => Promise<void>;
  licenseSourceLabel: "读取中" | "官方发行版" | "不可信的客户端来源";
  licenseStatus: LicenseRuntimeStatus | null;
  setOfflineLicenseDialogOpen: Dispatch<SetStateAction<boolean>>;
  updateBusy: boolean;
  updateStatus: UpdateStatus;
  updateStatusText: string;
};

export function AboutTab(props: AboutTabProps) {
  return (
<section className="settings-page-section about-section">
          <div className="about-overview">
            <article className="about-update-card">
              <div className="about-card-head">
                <span>自动更新</span>
                <strong>当前版本 {props.appVersion || '...'}</strong>
              </div>
              <p>{props.updateStatusText}</p>
              <button
                type="button"
                className="update-button"
                disabled={props.updateBusy}
                onClick={() => {
                  if (props.updateStatus === 'downloaded') {
                    void props.installDownloadedUpdate();
                    return;
                  }
                  void props.checkForUpdates();
                }}
              >
                {props.updateStatus === 'downloaded' ? '安装并重启' : props.updateBusy ? '检查中...' : '检查更新'}
              </button>
            </article>
            <article className="about-info-card about-links-card">
              <span>信息与授权</span>
              <ul className="about-links-list">
                <li className="about-links-item">
                  <span className="about-links-label">GitHub 仓库</span>
                  <a
                    className="about-links-value is-link"
                    href="https://github.com/FB208/OpenBidKit_Yibiao"
                    target="_blank"
                    rel="noreferrer"
                  >
                    FB208/OpenBidKit_Yibiao
                  </a>
                </li>
                <li className="about-links-item">
                  <span className="about-links-label">使用文档</span>
                  <a
                    className="about-links-value is-link"
                    href="https://wiki.agnet.top/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    wiki.agnet.top
                  </a>
                </li>
                <li className="about-links-item">
                  <span className="about-links-label">客户端授权状态</span>
                  <span className={`about-links-value ${props.licenseStatus?.sourceTrusted ? 'is-trusted' : 'is-untrusted'}`}>
                    {props.licenseSourceLabel}
                  </span>
                </li>
              </ul>
              <button type="button" className="about-links-activate" onClick={() => props.setOfflineLicenseDialogOpen(true)}>
                离线激活授权
              </button>
            </article>
          </div>
          <div className="privacy-statement">
            <div className="privacy-statement-head">
              <span>Privacy</span>
              <strong>隐私声明</strong>
              <p>本工具尽量把数据处理留在本机和你自行选择的服务商之间，只保留运行所必需的最少信息。</p>
            </div>
            <div className="privacy-list">
              <article className="privacy-item">
                <span>01</span>
                <strong>你的业务数据不会被我收集</strong>
                <p>应用不会上传、收集或保存你配置的 API Key、导入的招标文件、解析后的文档内容、生成的方案正文、导出文件或其他业务结果。</p>
              </article>
              <article className="privacy-item">
                <span>02</span>
                <strong>线上 AI 请求只发送给你配置的服务商</strong>
                <p>当你使用 OpenAI 兼容接口、MinerU 或其他线上 API 时，应用会把完成任务所需的内容发送给你自行配置的服务商。这是实现文档解析、内容生成、模型测试等功能的必要步骤；这些请求不经过我的服务器，我也不会额外留存任何请求内容或生成结果。</p>
              </article>
              <article className="privacy-item">
                <span>03</span>
                <strong>匿名埋点只用于了解功能使用情况</strong>
                <p>为了判断开源项目是否有人使用、哪些功能更常用，应用会把匿名页面访问和功能使用次数上报到 Cloudflare。统计不包含文档内容、文件名、本地路径、API Key、用户输入、生成结果或任何可还原业务内容的信息。</p>
              </article>
            </div>
          </div>
        </section>
  );
}
