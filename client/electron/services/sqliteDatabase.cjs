const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { getWorkspaceDatabasePath } = require('../utils/paths.cjs');
const { addColumnIfMissing, getExistingColumns, getExistingTables, quoteIdentifier } = require('./db/schema/helpers.cjs');
const { createInitialSchema } = require('./db/schema/technicalPlan.cjs');
const { createDuplicateCheckSchema } = require('./db/schema/duplicateCheck.cjs');
const { createKnowledgeBaseSchema } = require('./db/schema/knowledgeBase.cjs');
const { createRejectionCheckSchema, migrateRejectionCheckMultiBidDocuments } = require('./db/schema/rejectionCheck.cjs');
const { createTaskLogsAndIllustrationItemsSchema } = require('./db/schema/taskLogs.cjs');
const { createFeasibilityReportSchema } = require('./db/schema/feasibilityReport.cjs');
const { createComplianceCheckSchema } = require('./db/schema/complianceCheck.cjs');

const schemaVersion = 24;

function createTechnicalPlanGlobalFactsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS technical_plan_global_fact_groups (
      group_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_technical_plan_global_fact_groups_order
    ON technical_plan_global_fact_groups(sort_order);
  `);
}

function addTechnicalPlanBidSectionV6Compat(db) {
  // v6 兼容：部分旧版本客户端可能已添加 current_bid_section_id 和 bid_sections_extracted，
  // 此处做幂等处理，如果列已存在则 ALTER TABLE 会抛错，用 try/catch 忽略。
  const cols = db.prepare("PRAGMA table_info(technical_plan_meta)").all().map((row) => row.name);
  const addIfMissing = (name, type) => {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE technical_plan_meta ADD COLUMN ${name} ${type}`);
    }
  };
  addIfMissing('current_bid_section_id', 'TEXT');
  addIfMissing('bid_sections_extracted', 'INTEGER');
}

function addTechnicalPlanSelectedSection(db) {
  const cols = db.prepare("PRAGMA table_info(technical_plan_meta)").all().map((row) => row.name);
  const addIfMissing = (name, type) => {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE technical_plan_meta ADD COLUMN ${name} ${type}`);
    }
  };
  addIfMissing('selected_section_id', 'TEXT');
  addIfMissing('selected_section_title', 'TEXT');
  addIfMissing('selected_section_head_line', 'TEXT');
}

function addTechnicalPlanPendingTenderSelection(db) {
  const cols = db.prepare("PRAGMA table_info(technical_plan_meta)").all().map((row) => row.name);
  const addIfMissing = (name, type) => {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE technical_plan_meta ADD COLUMN ${name} ${type}`);
    }
  };
  addIfMissing('pending_tender_markdown_path', 'TEXT');
  addIfMissing('pending_tender_file_name', 'TEXT');
  addIfMissing('pending_tender_parser_label', 'TEXT');
  addIfMissing('pending_tender_sections_json', 'TEXT');
  addIfMissing('pending_tender_total_declared', 'INTEGER');
  addIfMissing('pending_tender_created_at', 'TEXT');
}

function addTechnicalPlanWorkflowAndOriginalPlan(db) {
  const cols = db.prepare("PRAGMA table_info(technical_plan_meta)").all().map((row) => row.name);
  const addIfMissing = (name, type) => {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE technical_plan_meta ADD COLUMN ${name} ${type}`);
    }
  };
  addIfMissing('workflow_kind', "TEXT NOT NULL DEFAULT 'technical-plan'");
  addIfMissing('original_plan_file_name', 'TEXT');
  addIfMissing('original_plan_markdown_path', 'TEXT');
  addIfMissing('original_plan_markdown_hash', 'TEXT');
  addIfMissing('original_plan_markdown_chars', 'INTEGER NOT NULL DEFAULT 0');
  addIfMissing('original_plan_parser_label', 'TEXT');
  addIfMissing('original_plan_imported_at', 'TEXT');
}

function addTechnicalPlanBidAnalysisSelection(db) {
  const cols = db.prepare("PRAGMA table_info(technical_plan_meta)").all().map((row) => row.name);
  if (!cols.includes('bid_analysis_selected_task_ids_json')) {
    db.exec('ALTER TABLE technical_plan_meta ADD COLUMN bid_analysis_selected_task_ids_json TEXT');
  }
}

function addTechnicalPlanOutlineExpansionMode(db) {
  addColumnIfMissing(db, 'technical_plan_meta', 'outline_expansion_mode', "TEXT NOT NULL DEFAULT 'ai-complement'");
}

function addTechnicalPlanGlobalFactsMode(db) {
  addColumnIfMissing(db, 'technical_plan_meta', 'global_facts_mode', "TEXT NOT NULL DEFAULT 'fabricate'");
}

function addTechnicalPlanBidSectionOptimization(db) {
  addColumnIfMissing(db, 'technical_plan_meta', 'tender_original_markdown_path', 'TEXT');
  addColumnIfMissing(db, 'technical_plan_meta', 'tender_original_markdown_hash', 'TEXT');
  addColumnIfMissing(db, 'technical_plan_meta', 'tender_original_markdown_chars', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'technical_plan_meta', 'bid_section_mode', "TEXT NOT NULL DEFAULT 'single'");
  addColumnIfMissing(db, 'technical_plan_meta', 'bid_sections_json', 'TEXT');
  addColumnIfMissing(db, 'technical_plan_meta', 'bid_section_extraction_status', "TEXT NOT NULL DEFAULT 'idle'");
  addColumnIfMissing(db, 'technical_plan_meta', 'bid_section_extraction_error', 'TEXT');
}

function addTechnicalPlanTenderFiles(db) {
  addColumnIfMissing(db, 'technical_plan_meta', 'tender_files_json', 'TEXT');
}

function addTechnicalPlanIllustrationPlan(db) {
  removeLegacyTechnicalPlanIllustrationType(db);
}

// 为 Step03 当前设置和目录生效快照分别增加存储字段。
function addTechnicalPlanOutlineWordControl(db) {
  addColumnIfMissing(db, 'technical_plan_meta', 'outline_word_control_options_json', 'TEXT');
  addColumnIfMissing(db, 'technical_plan_meta', 'outline_word_control_snapshot_json', 'TEXT');
}

// 目录叶子内容处理模式；父节点保持为空，旧测试目录不补默认值。
function addTechnicalPlanOutlineContentMode(db) {
  addColumnIfMissing(db, 'technical_plan_outline_nodes', 'content_mode', 'TEXT');
  addColumnIfMissing(db, 'technical_plan_outline_nodes', 'content_mode_note', 'TEXT');
}

function removeLegacyTechnicalPlanIllustrationType(db) {
  const columns = getExistingColumns(db, 'technical_plan_content_plans');
  if (columns.has('illustration_type')) {
    db.exec('ALTER TABLE technical_plan_content_plans DROP COLUMN illustration_type');
  }
}

function addKnowledgeDocumentSortOrder(db) {
  const cols = db.prepare("PRAGMA table_info(knowledge_documents)").all().map((row) => row.name);
  if (!cols.includes('sort_order')) {
    db.exec('ALTER TABLE knowledge_documents ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    const folders = db.prepare('SELECT DISTINCT folder_id FROM knowledge_documents').all();
    const documentsByFolder = db.prepare('SELECT document_id FROM knowledge_documents WHERE folder_id = ? ORDER BY created_at DESC, document_id ASC');
    const updateOrder = db.prepare('UPDATE knowledge_documents SET sort_order = ? WHERE document_id = ?');
    for (const folder of folders) {
      documentsByFolder.all(folder.folder_id).forEach((document, index) => updateOrder.run(index, document.document_id));
    }
  }
  db.exec(`
    DROP INDEX IF EXISTS idx_knowledge_documents_folder_order;
    CREATE INDEX IF NOT EXISTS idx_knowledge_documents_folder_order
    ON knowledge_documents(folder_id, sort_order, created_at DESC);
  `);
}

function createWorkspaceV2Schema(db) {
  createDuplicateCheckSchema(db);
  createRejectionCheckSchema(db);
}

function createExportTemplatesSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS export_templates (
      template_id TEXT PRIMARY KEY,
      template_name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_export_templates_updated
    ON export_templates(updated_at DESC);
  `);
}

const schemaHealthTableGroups = [
  {
    version: 1,
    tables: [
      'technical_plan_meta',
      'technical_plan_tasks',
      'technical_plan_bid_items',
      'technical_plan_reference_docs',
      'technical_plan_outline_nodes',
      'technical_plan_content_sections',
      'technical_plan_content_plans',
    ],
    repair: createInitialSchema,
  },
  {
    version: 2,
    tables: [
      'duplicate_check_meta',
      'duplicate_check_files',
      'duplicate_check_tasks',
      'duplicate_check_analysis_sections',
      'duplicate_check_content_files',
      'duplicate_check_metadata_items',
      'duplicate_check_outline_items',
      'duplicate_check_outline_groups',
      'duplicate_check_outline_pairwise',
      'duplicate_check_content_duplicates',
      'duplicate_check_content_occurrences',
      'duplicate_check_image_files',
      'duplicate_check_duplicate_images',
      'duplicate_check_image_occurrences',
    ],
    repair: createDuplicateCheckSchema,
  },
  {
    version: 2,
    tables: [
      'rejection_check_meta',
      'rejection_check_documents',
      'rejection_check_tasks',
      'rejection_check_extraction',
      'rejection_check_results',
      'rejection_check_risk_findings',
      'rejection_check_typo_findings',
      'rejection_check_logic_findings',
    ],
    repair: createRejectionCheckSchema,
  },
  {
    version: 3,
    tables: [
      'knowledge_folders',
      'knowledge_documents',
      'knowledge_blocks',
      'knowledge_candidate_items',
      'knowledge_items',
      'knowledge_item_blocks',
      'knowledge_discarded_groups',
      'knowledge_reports',
      'knowledge_document_steps',
      'knowledge_match_batches',
    ],
    repair: createKnowledgeBaseSchema,
  },
  {
    version: 4,
    tables: ['technical_plan_global_fact_groups'],
    repair: createTechnicalPlanGlobalFactsSchema,
  },
  {
    version: 15,
    tables: ['export_templates'],
    repair: createExportTemplatesSchema,
  },
  {
    version: 20,
    tables: ['task_logs', 'technical_plan_illustration_plans', 'technical_plan_illustration_items'],
    repair: createTaskLogsAndIllustrationItemsSchema,
  },
  {
    version: 23,
    tables: ['feasibility_report_meta', 'feasibility_report_tasks', 'feasibility_report_outline_nodes'],
    repair: createFeasibilityReportSchema,
  },
  {
    version: 24,
    tables: ['compliance_check_jobs', 'compliance_check_results', 'compliance_check_findings'],
    repair: createComplianceCheckSchema,
  },
];

function removeKnowledgeMigrationMeta(db) {
  db.exec('DROP TABLE IF EXISTS knowledge_migration_meta;');
}

const schemaHealthColumnGroups = [
  {
    version: 1,
    table: 'technical_plan_meta',
    columns: {
      step: 'TEXT',
      tender_file_name: 'TEXT',
      tender_markdown_path: 'TEXT',
      tender_markdown_hash: 'TEXT',
      tender_markdown_chars: 'INTEGER',
      tender_parser_label: 'TEXT',
      tender_imported_at: 'TEXT',
      bid_analysis_mode: 'TEXT',
      outline_mode: 'TEXT',
      outline_project_name: 'TEXT',
      outline_project_overview: 'TEXT',
      content_generation_options_json: 'TEXT',
      content_generation_runtime_json: 'TEXT',
      created_at: 'TEXT',
      updated_at: 'TEXT',
    },
  },
  {
    version: 5,
    table: 'technical_plan_meta',
    columns: {
      current_bid_section_id: 'TEXT',
      bid_sections_extracted: 'INTEGER',
    },
  },
  {
    version: 7,
    table: 'technical_plan_meta',
    columns: {
      selected_section_id: 'TEXT',
      selected_section_title: 'TEXT',
      selected_section_head_line: 'TEXT',
    },
  },
  {
    version: 8,
    table: 'technical_plan_meta',
    columns: {
      pending_tender_markdown_path: 'TEXT',
      pending_tender_file_name: 'TEXT',
      pending_tender_parser_label: 'TEXT',
      pending_tender_sections_json: 'TEXT',
      pending_tender_total_declared: 'INTEGER',
      pending_tender_created_at: 'TEXT',
    },
  },
  {
    version: 9,
    table: 'technical_plan_meta',
    columns: {
      workflow_kind: "TEXT NOT NULL DEFAULT 'technical-plan'",
      original_plan_file_name: 'TEXT',
      original_plan_markdown_path: 'TEXT',
      original_plan_markdown_hash: 'TEXT',
      original_plan_markdown_chars: 'INTEGER NOT NULL DEFAULT 0',
      original_plan_parser_label: 'TEXT',
      original_plan_imported_at: 'TEXT',
    },
  },
  {
    version: 10,
    table: 'technical_plan_meta',
    columns: {
      bid_analysis_selected_task_ids_json: 'TEXT',
    },
  },
  {
    version: 11,
    table: 'knowledge_documents',
    columns: {
      sort_order: 'INTEGER NOT NULL DEFAULT 0',
    },
  },
  {
    version: 12,
    table: 'rejection_check_documents',
    columns: {
      sort_order: 'INTEGER NOT NULL DEFAULT 0',
    },
  },
  {
    version: 12,
    table: 'rejection_check_risk_findings',
    columns: {
      bid_document_id: 'TEXT',
    },
  },
  {
    version: 12,
    table: 'rejection_check_typo_findings',
    columns: {
      bid_document_id: 'TEXT',
    },
  },
  {
    version: 12,
    table: 'rejection_check_logic_findings',
    columns: {
      bid_document_id: 'TEXT',
    },
  },
  {
    version: 13,
    table: 'technical_plan_meta',
    columns: {
      outline_expansion_mode: "TEXT NOT NULL DEFAULT 'ai-complement'",
    },
  },
  {
    version: 22,
    table: 'technical_plan_meta',
    columns: {
      global_facts_mode: "TEXT NOT NULL DEFAULT 'fabricate'",
    },
  },
  {
    version: 14,
    table: 'technical_plan_meta',
    columns: {
      tender_original_markdown_path: 'TEXT',
      tender_original_markdown_hash: 'TEXT',
      tender_original_markdown_chars: 'INTEGER NOT NULL DEFAULT 0',
      bid_section_mode: "TEXT NOT NULL DEFAULT 'single'",
      bid_sections_json: 'TEXT',
      bid_section_extraction_status: "TEXT NOT NULL DEFAULT 'idle'",
      bid_section_extraction_error: 'TEXT',
    },
  },
  {
    version: 16,
    table: 'technical_plan_meta',
    columns: {
      tender_files_json: 'TEXT',
    },
  },
  {
    version: 18,
    table: 'technical_plan_meta',
    columns: {
      outline_word_control_options_json: 'TEXT',
      outline_word_control_snapshot_json: 'TEXT',
    },
  },
  {
    version: 19,
    table: 'technical_plan_outline_nodes',
    columns: {
      content_mode: 'TEXT',
      content_mode_note: 'TEXT',
    },
  },
];

function emitDatabaseStatus(onStatus, status) {
  if (typeof onStatus === 'function') {
    onStatus(status);
  }
}

function ensureWorkspaceSchemaHealth(db, targetVersion = schemaVersion, onStatus) {
  emitDatabaseStatus(onStatus, {
    phase: 'checking',
    message: '正在检查本地数据库结构',
    targetVersion,
  });
  let existingTables = getExistingTables(db);
  for (const group of schemaHealthTableGroups) {
    if (group.version > targetVersion) continue;
    if (group.tables.every((tableName) => existingTables.has(tableName))) continue;
    emitDatabaseStatus(onStatus, {
      phase: 'repairing',
      message: '正在修复本地数据库表结构',
      targetVersion,
    });
    group.repair(db);
    existingTables = getExistingTables(db);
  }

  const columnCache = new Map();
  for (const group of schemaHealthColumnGroups) {
    if (group.version > targetVersion || !existingTables.has(group.table)) continue;
    let existingColumns = columnCache.get(group.table);
    if (!existingColumns) {
      existingColumns = getExistingColumns(db, group.table);
      columnCache.set(group.table, existingColumns);
    }
    for (const [columnName, columnType] of Object.entries(group.columns)) {
      if (existingColumns.has(columnName)) continue;
      emitDatabaseStatus(onStatus, {
        phase: 'repairing',
        message: '正在修复本地数据库字段',
        targetVersion,
      });
      db.exec(`ALTER TABLE ${quoteIdentifier(group.table)} ADD COLUMN ${quoteIdentifier(columnName)} ${columnType}`);
      existingColumns.add(columnName);
    }
  }
  if (targetVersion >= 17 && existingTables.has('technical_plan_content_plans')) {
    removeLegacyTechnicalPlanIllustrationType(db);
  }
}

const migrations = [
  {
    version: 1,
    description: '创建技术方案 SQLite 初始表结构',
    up: createInitialSchema,
  },
  {
    version: 2,
    description: '新增标书查重和废标项检查 SQLite 表结构',
    up: createWorkspaceV2Schema,
  },
  {
    version: 3,
    description: '新增知识库 SQLite 表结构',
    up: createKnowledgeBaseSchema,
  },
  {
    version: 4,
    description: '新增技术方案全局事实表结构',
    up: createTechnicalPlanGlobalFactsSchema,
  },
  {
    version: 5,
    description: '技术方案新增标段选择字段',
    up: addTechnicalPlanBidSectionV6Compat,
  },
  {
    version: 6,
    description: '兼容旧版标段字段（幂等）',
    up: addTechnicalPlanBidSectionV6Compat,
  },
  {
    version: 7,
    description: '技术方案新增标段选择字段（selected_section）',
    up: addTechnicalPlanSelectedSection,
  },
  {
    version: 8,
    description: '技术方案新增待选择标段恢复状态',
    up: addTechnicalPlanPendingTenderSelection,
  },
  {
    version: 9,
    description: '技术方案新增工作流类型和原方案文件状态',
    up: addTechnicalPlanWorkflowAndOriginalPlan,
  },
  {
    version: 10,
    description: '技术方案新增招标解析项选择配置',
    up: addTechnicalPlanBidAnalysisSelection,
  },
  {
    version: 11,
    description: '知识库文档新增手动排序字段',
    up: addKnowledgeDocumentSortOrder,
  },
  {
    version: 12,
    description: '废标项检查支持多份投标文件',
    up: migrateRejectionCheckMultiBidDocuments,
  },
  {
    version: 13,
    description: '技术方案新增已有方案目录使用方式配置',
    up: addTechnicalPlanOutlineExpansionMode,
  },
  {
    version: 14,
    description: '技术方案新增多标段优化状态',
    up: addTechnicalPlanBidSectionOptimization,
  },
  {
    version: 15,
    description: '新增导出模板库表结构',
    up: createExportTemplatesSchema,
  },
  {
    version: 16,
    description: '技术方案支持多份招标文件',
    up: addTechnicalPlanTenderFiles,
  },
  {
    version: 17,
    description: '技术方案新增全文图片编排结果',
    up: addTechnicalPlanIllustrationPlan,
  },
  {
    version: 18,
    description: '技术方案新增目录字数控制设置和生效快照',
    up: addTechnicalPlanOutlineWordControl,
  },
  {
    version: 19,
    description: '技术方案目录叶子新增内容处理模式',
    up: addTechnicalPlanOutlineContentMode,
  },
  {
    version: 20,
    description: '任务日志按行存储并拆分全文图片计划项目',
    up: createTaskLogsAndIllustrationItemsSchema,
  },
  {
    version: 21,
    description: '移除废弃的知识库旧数据迁移状态',
    up: removeKnowledgeMigrationMeta,
  },
  {
    version: 22,
    description: '技术方案新增全局事实补全模式',
    up: addTechnicalPlanGlobalFactsMode,
  },
  {
    version: 23,
    description: '新增可行性研究报告工作区表结构',
    up: createFeasibilityReportSchema,
  },
  {
    version: 24,
    description: '新增合规检查任务与结果表结构',
    up: createComplianceCheckSchema,
  },
];

function timestampForFileName() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/T/, '-').replace(/\..*$/, '');
}

function copyIfExists(source, target) {
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, target);
  }
}

function backupDatabaseFiles(db, databasePath, onStatus) {
  if (!fs.existsSync(databasePath)) {
    return;
  }

  emitDatabaseStatus(onStatus, {
    phase: 'backing-up',
    message: '正在备份本地数据库',
  });
  db.pragma('wal_checkpoint(TRUNCATE)');
  const suffix = `backup-${timestampForFileName()}`;
  copyIfExists(databasePath, `${databasePath}.${suffix}`);
  copyIfExists(`${databasePath}-wal`, `${databasePath}-wal.${suffix}`);
  copyIfExists(`${databasePath}-shm`, `${databasePath}-shm.${suffix}`);
}

// 数据库升级成功后，统一删除当前数据库积累的全部历史备份。
function clearDatabaseBackupFiles(databasePath) {
  const directory = path.dirname(databasePath);
  const databaseName = path.basename(databasePath);
  const backupPrefixes = [
    `${databaseName}.backup-`,
    `${databaseName}-wal.backup-`,
    `${databaseName}-shm.backup-`,
  ];

  for (const fileName of fs.readdirSync(directory)) {
    if (!backupPrefixes.some((prefix) => fileName.startsWith(prefix))) continue;
    try {
      fs.unlinkSync(path.join(directory, fileName));
    } catch (error) {
      console.warn(`[sqlite] 删除数据库备份失败：${fileName}`, error?.message || String(error));
    }
  }
}

function applyMigrations(db, databasePath, onStatus) {
  const currentVersion = Number(db.pragma('user_version', { simple: true }) || 0);
  if (currentVersion > schemaVersion) {
    throw new Error(`本地数据库版本 ${currentVersion} 高于当前客户端支持版本 ${schemaVersion}，请升级客户端后再使用技术方案功能。`);
  }
  if (currentVersion === schemaVersion) {
    ensureWorkspaceSchemaHealth(db, schemaVersion, onStatus);
    return;
  }

  if (currentVersion > 0) {
    backupDatabaseFiles(db, databasePath, onStatus);
  }

  const runMigration = db.transaction((migration) => {
    migration.up(db);
    db.pragma(`user_version = ${migration.version}`);
  });

  for (const migration of migrations.filter((item) => item.version > currentVersion).sort((a, b) => a.version - b.version)) {
    try {
      ensureWorkspaceSchemaHealth(db, migration.version - 1, onStatus);
      emitDatabaseStatus(onStatus, {
        phase: 'upgrading',
        message: `正在升级本地数据库（v${migration.version}）`,
        currentVersion,
        targetVersion: migration.version,
        migrationVersion: migration.version,
        migrationDescription: migration.description,
      });
      runMigration(migration);
      ensureWorkspaceSchemaHealth(db, migration.version, onStatus);
    } catch (error) {
      throw new Error(`数据库升级失败（v${migration.version} ${migration.description}）：${error.message || String(error)}`);
    }
  }

  ensureWorkspaceSchemaHealth(db, schemaVersion, onStatus);
  clearDatabaseBackupFiles(databasePath);
}

function createSqliteDatabase(app, options = {}) {
  const databasePath = getWorkspaceDatabasePath(app);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  try {
    applyMigrations(db, databasePath, options.onStatus);
  } catch (error) {
    db.close();
    throw error;
  }

  const close = () => {
    if (db.open) {
      db.close();
    }
  };

  app.once('will-quit', close);

  return {
    db,
    path: databasePath,
    schemaVersion,
    close,
  };
}

module.exports = {
  createSqliteDatabase,
  schemaVersion,
};
