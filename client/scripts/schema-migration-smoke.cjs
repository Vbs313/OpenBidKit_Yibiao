/*
 * 全新数据库迁移冒烟：在临时 userData 目录里从 0 跑完全部迁移。
 *
 * 为什么需要它：平时的冒烟复用工作区数据库，若它已在最新版，applyMigrations 会直接短路，
 * 那些 schema 创建器根本不会执行——「表结构代码坏了但没人发现」正是这样发生的。
 * 本冒烟强制走全新库，并用 createSqliteDatabase 内置的 schema 健康检查兜底。
 *
 * 用法：npm run smoke:schema
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const { createSqliteDatabase, schemaVersion } = require('../electron/services/sqliteDatabase.cjs');

// 每个领域抽一张代表表，覆盖被拆出的全部 schema 模块。
const REQUIRED_TABLES = {
  technicalPlan: 'technical_plan_meta',
  duplicateCheck: 'duplicate_check_meta',
  knowledgeBase: 'knowledge_folders',
  rejectionCheck: 'rejection_check_meta',
  taskLogs: 'task_logs',
  feasibilityReport: 'feasibility_report_meta',
  complianceCheck: 'compliance_check_jobs',
};

function exitWithCode(code) {
  if (app?.isReady?.()) { app.exit(code); return; }
  process.exit(code);
}

function runSmoke() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-schema-smoke-'));
  let database = null;
  try {
    app.setPath('userData', tmpDir);
    database = createSqliteDatabase(app, {});
    const { db } = database;

    const version = Number(db.pragma('user_version', { simple: true }) || 0);
    if (version !== schemaVersion) {
      throw new Error(`迁移后 user_version=${version}，期望 ${schemaVersion}`);
    }

    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    const missing = Object.entries(REQUIRED_TABLES).filter(([, table]) => !tables.has(table));
    if (missing.length) {
      throw new Error('缺少代表性表：' + missing.map(([domain, table]) => `${domain}(${table})`).join(', '));
    }

    console.log(`[schema-smoke] 全新库迁移到 v${version}，表数 ${tables.size}`);
    console.log(`[schema-smoke] ${Object.keys(REQUIRED_TABLES).length} 个领域的代表表全部就绪`);

    database.close();
    database = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('[schema-smoke] all checks passed');
    exitWithCode(0);
  } catch (error) {
    console.error('[schema-smoke] failed');
    console.error(error?.stack || error?.message || String(error));
    try { database?.close?.(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    exitWithCode(1);
  }
}

if (app?.whenReady) {
  app.whenReady().then(runSmoke, (error) => {
    console.error('[schema-smoke] Electron app failed to become ready.');
    console.error(error?.stack || error?.message || String(error));
    exitWithCode(1);
  });
} else {
  runSmoke();
}