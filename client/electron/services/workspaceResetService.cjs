// 一键重置工作区：清空业务数据（SQLite + workspace 文件），保留用户配置（user_config.json）。
//
// 用途：排障、换项目、演示前清理。
// 安全约束：
// 1. 只删 workspace/ 目录与 yibiao.sqlite，不动 user_config.json 与 userData 根目录其他文件。
// 2. 删除前备份数据库到 workspace-trash/，便于误操作恢复。
// 3. 失败时不阻断启动，返回结果由 UI 提示。

const fs = require('node:fs');
const path = require('node:path');
const { getWorkspaceDir, getWorkspaceTrashDir } = require('../utils/paths.cjs');

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/T/, '-').replace(/\..*$/, '');
}

function safeRemove(target) {
  try {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (error) {
    console.warn('[workspace-reset] 删除失败', target, error?.message || String(error));
    return false;
  }
}

/**
 * 一键重置工作区。
 * @param {{ app: any, db: any }} deps
 * @returns {{ success: boolean, message: string, backed_up: boolean }}
 */
function resetWorkspace({ app, db }) {
  const workspaceDir = getWorkspaceDir(app);
  const trashDir = getWorkspaceTrashDir(app);
  let backedUp = false;

  // 1. 备份数据库到回收目录（便于误操作恢复）。
  try {
    const dbPath = path.join(workspaceDir, 'yibiao.sqlite');
    if (fs.existsSync(dbPath)) {
      fs.mkdirSync(trashDir, { recursive: true });
      const backupPath = path.join(trashDir, `yibiao-backup-${timestamp()}.sqlite`);
      // WAL checkpoint 后再备份，确保数据完整。
      try { db?.pragma?.('wal_checkpoint(TRUNCATE)'); } catch { /* db 未就绪时跳过 */ }
      fs.copyFileSync(dbPath, backupPath);
      backedUp = true;
    }
  } catch (error) {
    console.warn('[workspace-reset] 备份失败', error?.message || String(error));
  }

  // 2. 清空 workspace/ 目录（保留目录本身）。
  try {
    if (fs.existsSync(workspaceDir)) {
      for (const entry of fs.readdirSync(workspaceDir)) {
        safeRemove(path.join(workspaceDir, entry));
      }
    }
  } catch (error) {
    console.warn('[workspace-reset] 清空 workspace 失败', error?.message || String(error));
    return { success: false, message: '清空工作区失败：' + (error?.message || String(error)), backed_up: backedUp };
  }

  return {
    success: true,
    message: backedUp
      ? '工作区已重置（数据库已备份到 workspace-trash/）'
      : '工作区已重置',
    backed_up: backedUp,
  };
}

module.exports = { resetWorkspace };
