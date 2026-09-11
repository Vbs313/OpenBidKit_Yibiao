// 任务日志与配图条目表结构。
//
// 原本是 sqliteDatabase.cjs 里的模块级 DDL 函数，按领域拆出；除 rejectionCheck 迁移外均为纯 DDL。
function createTaskLogsAndIllustrationItemsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_domain TEXT NOT NULL,
      task_type TEXT NOT NULL,
      task_id TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_logs_task
    ON task_logs(task_domain, task_type, task_id, id DESC);

    CREATE TRIGGER IF NOT EXISTS trg_technical_plan_task_logs_delete
    AFTER DELETE ON technical_plan_tasks
    BEGIN
      DELETE FROM task_logs
      WHERE task_domain = 'technical-plan' AND task_type = OLD.type AND task_id = OLD.task_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_rejection_check_task_logs_delete
    AFTER DELETE ON rejection_check_tasks
    BEGIN
      DELETE FROM task_logs
      WHERE task_domain = 'rejection-check' AND task_type = OLD.type AND task_id = OLD.task_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_duplicate_check_task_logs_delete
    AFTER DELETE ON duplicate_check_tasks
    BEGIN
      DELETE FROM task_logs
      WHERE task_domain = 'duplicate-check' AND task_type = OLD.type AND task_id = OLD.task_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_technical_plan_task_logs_replace
    AFTER UPDATE OF task_id ON technical_plan_tasks
    WHEN OLD.task_id <> NEW.task_id
    BEGIN
      DELETE FROM task_logs
      WHERE task_domain = 'technical-plan' AND task_type = OLD.type AND task_id = OLD.task_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_rejection_check_task_logs_replace
    AFTER UPDATE OF task_id ON rejection_check_tasks
    WHEN OLD.task_id <> NEW.task_id
    BEGIN
      DELETE FROM task_logs
      WHERE task_domain = 'rejection-check' AND task_type = OLD.type AND task_id = OLD.task_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_duplicate_check_task_logs_replace
    AFTER UPDATE OF task_id ON duplicate_check_tasks
    WHEN OLD.task_id <> NEW.task_id
    BEGIN
      DELETE FROM task_logs
      WHERE task_domain = 'duplicate-check' AND task_type = OLD.type AND task_id = OLD.task_id;
    END;

    CREATE TABLE IF NOT EXISTS technical_plan_illustration_plans (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      plan_version INTEGER NOT NULL,
      revision TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS technical_plan_illustration_items (
      item_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      image_type TEXT NOT NULL,
      title TEXT NOT NULL,
      section_ids_json TEXT NOT NULL,
      placement TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      generation_status TEXT,
      generation_mode TEXT,
      generation_code TEXT,
      generation_source_path TEXT,
      generation_asset_url TEXT,
      generation_attempts INTEGER,
      generation_error TEXT,
      generation_updated_at TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_technical_plan_illustration_items_order
    ON technical_plan_illustration_items(sort_order);
  `);
}
module.exports = {
  createTaskLogsAndIllustrationItemsSchema,
};
