// 可研报告表结构。
//
// 原本是 sqliteDatabase.cjs 里的模块级 DDL 函数，按领域拆出；除 rejectionCheck 迁移外均为纯 DDL。
function createFeasibilityReportSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feasibility_report_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      step TEXT NOT NULL DEFAULT 'materials',
      project_info_json TEXT,
      source_files_json TEXT,
      analysis_markdown TEXT,
      outline_template TEXT NOT NULL DEFAULT 'government',
      target_words INTEGER NOT NULL DEFAULT 30000,
      reference_document_ids_json TEXT,
      key_parameters_markdown TEXT,
      outline_project_name TEXT,
      outline_project_overview TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feasibility_report_tasks (
      type TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      stats_json TEXT,
      error TEXT,
      pause_requested INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feasibility_report_outline_nodes (
      node_id TEXT PRIMARY KEY,
      parent_node_id TEXT,
      sort_order INTEGER NOT NULL,
      level INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      knowledge_item_ids_json TEXT,
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (parent_node_id) REFERENCES feasibility_report_outline_nodes(node_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_feasibility_report_outline_parent_order
    ON feasibility_report_outline_nodes(parent_node_id, sort_order);

    CREATE INDEX IF NOT EXISTS idx_feasibility_report_outline_level
    ON feasibility_report_outline_nodes(level);
  `);
}
module.exports = {
  createFeasibilityReportSchema,
};
