// 合规检查表结构。
//
// 原本是 sqliteDatabase.cjs 里的模块级 DDL 函数，按领域拆出；除 rejectionCheck 迁移外均为纯 DDL。
function createComplianceCheckSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS compliance_check_jobs (
      job_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      input_json TEXT NOT NULL,
      task_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_compliance_check_jobs_created
    ON compliance_check_jobs(created_at DESC);

    CREATE TABLE IF NOT EXISTS compliance_check_results (
      job_id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      status TEXT NOT NULL,
      severity TEXT,
      summary TEXT,
      metrics_json TEXT,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES compliance_check_jobs(job_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS compliance_check_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      check_id TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      code TEXT,
      title TEXT,
      message TEXT,
      severity TEXT,
      evidence TEXT,
      suggestion TEXT,
      location_json TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (job_id) REFERENCES compliance_check_jobs(job_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_compliance_check_findings_job_order
    ON compliance_check_findings(job_id, sort_order);

    CREATE INDEX IF NOT EXISTS idx_compliance_check_findings_severity
    ON compliance_check_findings(job_id, severity);
  `);
}
module.exports = {
  createComplianceCheckSchema,
};
