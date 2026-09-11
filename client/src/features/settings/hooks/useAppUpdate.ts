// 应用更新：状态 + 进度订阅 + 检查/安装动作。
//
// 原本是 SettingsPage.tsx 组件体里的一组闭包（4 个 state、effect 里的 3 个订阅、2 个 handler、2 个派生值）。
// 抽成自定义 hook 后页面只消费它暴露的值——这是本阶段第一次用「提 hook」的方式迁移页面逻辑。

import { useEffect, useState } from 'react';
import { useToast } from '../../../shared/ui';
import { showUpdateReadyToast } from '../../../shared/updateToast';
import type { UpdateStatus } from '../types';

export function useAppUpdate() {
  const { showToast } = useToast();

  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');
  const [updatePercent, setUpdatePercent] = useState(0);
  const [updateVersion, setUpdateVersion] = useState('');
  const [updateError, setUpdateError] = useState('');

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      window.yibiao?.onUpdateProgress(({ percent }) => {
        setUpdateStatus('downloading');
        setUpdatePercent(Math.round(percent));
      }) ?? (() => {})
    );
    unsubs.push(
      window.yibiao?.onUpdateDownloaded(({ version }) => {
        if (version) {
          setUpdateVersion(version);
        }
        setUpdateStatus('downloaded');
      }) ?? (() => {})
    );
    unsubs.push(
      window.yibiao?.onUpdateError(({ message }) => {
        setUpdateStatus('error');
        setUpdateError(message);
      }) ?? (() => {})
    );

    return () => { unsubs.forEach((unsub) => unsub()); };
  }, []);

  const checkForUpdates = async () => {
    if (updateStatus === 'checking' || updateStatus === 'downloading') {
      return;
    }

    try {
      setUpdateStatus('checking');
      setUpdatePercent(0);
      setUpdateError('');
      const result = await window.yibiao?.checkUpdate();
      if (!result?.enabled) {
        setUpdateStatus('disabled');
        showToast('开发调试模式不执行自动更新', 'info');
        return;
      }
      if (result.failed) {
        const message = result.message || '检查更新失败';
        setUpdateStatus('error');
        setUpdateError(message);
        showToast(message, 'error');
        return;
      }
      if (!result.updateAvailable) {
        setUpdateStatus('idle');
        showToast('已是最新版本', 'success');
        return;
      }

      const version = result.version || updateVersion;
      setUpdateVersion(version);
      if (result.downloaded) {
        setUpdateStatus('downloaded');
        showUpdateReadyToast(showToast, version);
        return;
      }

      setUpdateStatus('idle');
      showToast('发现新版本，但更新包尚未下载完成，请稍后重试', 'info');
    } catch (error) {
      const message = error instanceof Error ? error.message : '检查更新失败';
      setUpdateStatus('error');
      setUpdateError(message);
      showToast(message, 'error');
    }
  };

  const installDownloadedUpdate = async () => {
    try {
      const result = await window.yibiao?.quitAndInstall();
      if (result && !result.success) {
        showToast(result.message || '安装更新失败', 'error');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '安装更新失败';
      showToast(message, 'error');
    }
  };

  const updateBusy = updateStatus === 'checking' || updateStatus === 'downloading';
  const updateStatusText = (() => {
    if (updateStatus === 'checking') return '正在检查更新...';
    if (updateStatus === 'downloading') return `正在下载 ${updatePercent}%`;
    if (updateStatus === 'downloaded') return updateVersion ? `新版本 ${updateVersion} 已准备好` : '更新已准备好';
    if (updateStatus === 'error') return `更新失败：${updateError || '未知错误'}`;
    if (updateStatus === 'disabled') return '开发调试模式不执行自动更新';
    return '启动后自动检查，每 30 分钟轮询';
  })();

  return {
    updateStatus,
    updatePercent,
    updateVersion,
    updateError,
    updateBusy,
    updateStatusText,
    checkForUpdates,
    installDownloadedUpdate,
  };
}
