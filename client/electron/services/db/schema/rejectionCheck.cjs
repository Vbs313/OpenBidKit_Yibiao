// 废标项检查表结构，以及多投标文件迁移。
//
// 原本是 sqliteDatabase.cjs 里的模块级 DDL 函数，按领域拆出；除 rejectionCheck 迁移外均为纯 DDL。
const { addColumnIfMissing, getExistingColumns, getExistingTables } = require('./helpers.cjs');

function createRejectionCheckSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rejection_check_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      step TEXT NOT NULL DEFAULT 'documents',
      active_document_tab TEXT NOT NULL DEFAULT 'tender',
      active_result_tab TEXT NOT NULL DEFAULT 'analysis',
      active_check_result_tab TEXT NOT NULL DEFAULT 'rejection',
      custom_check_items TEXT NOT NULL DEFAULT '',
      check_options_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rejection_check_documents (
      document_id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      source TEXT NOT NULL,
      file_name TEXT NOT NULL,
      markdown_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content_chars INTEGER NOT NULL DEFAULT 0,
      parser_label TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rejection_check_documents_role_order
    ON rejection_check_documents(role, sort_order);

    CREATE TABLE IF NOT EXISTS rejection_check_tasks (
      type TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      stats_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rejection_check_extraction (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL DEFAULT 'idle',
      content TEXT NOT NULL DEFAULT '',
      source TEXT,
      tender_signature TEXT,
      error TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS rejection_check_results (
      result_type TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'idle',
      input_signature TEXT,
      active_finding_id TEXT,
      progress_message TEXT,
      error TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS rejection_check_risk_findings (
      finding_id TEXT PRIMARY KEY,
      bid_document_id TEXT,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      requirement TEXT NOT NULL,
      bid_evidence TEXT NOT NULL,
      risk_reason TEXT NOT NULL,
      suggestion TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rejection_check_risk_order
    ON rejection_check_risk_findings(sort_order);

    CREATE INDEX IF NOT EXISTS idx_rejection_check_risk_severity
    ON rejection_check_risk_findings(severity);

    CREATE TABLE IF NOT EXISTS rejection_check_typo_findings (
      finding_id TEXT PRIMARY KEY,
      bid_document_id TEXT,
      wrong_text TEXT NOT NULL,
      correct_text TEXT NOT NULL,
      original_excerpt TEXT NOT NULL,
      reason TEXT NOT NULL,
      location_hint TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rejection_check_typo_order
    ON rejection_check_typo_findings(sort_order);

    CREATE TABLE IF NOT EXISTS rejection_check_logic_findings (
      finding_id TEXT PRIMARY KEY,
      bid_document_id TEXT,
      title TEXT NOT NULL,
      original_text TEXT NOT NULL,
      location_hint TEXT NOT NULL,
      fallacy_reason TEXT NOT NULL,
      suggestion TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rejection_check_logic_order
    ON rejection_check_logic_findings(sort_order);
  `);
}

function migrateRejectionCheckMultiBidDocuments(db) {
  const existingTables = getExistingTables(db);
  if (!existingTables.has('rejection_check_documents')) {
    createRejectionCheckSchema(db);
  }

  const documentColumns = getExistingColumns(db, 'rejection_check_documents');
  if (documentColumns.size && !documentColumns.has('document_id')) {
    db.exec('DROP TABLE IF EXISTS rejection_check_documents_legacy_v12');
    db.exec('ALTER TABLE rejection_check_documents RENAME TO rejection_check_documents_legacy_v12');
    createRejectionCheckSchema(db);

    const rows = db.prepare(`
      SELECT * FROM rejection_check_documents_legacy_v12
      ORDER BY CASE role WHEN 'tender' THEN 0 ELSE 1 END, role ASC
    `).all();
    const insert = db.prepare(`
      INSERT INTO rejection_check_documents (
        document_id, role, source, file_name, markdown_path, content_hash, content_chars, parser_label, sort_order, imported_at, updated_at
      ) VALUES (
        @document_id, @role, @source, @file_name, @markdown_path, @content_hash, @content_chars, @parser_label, @sort_order, @imported_at, @updated_at
      )
    `);
    let bidIndex = 0;
    for (const row of rows) {
      const isBid = row.role === 'bid';
      const documentId = isBid ? `bid-${bidIndex + 1}` : 'tender';
      insert.run({
        document_id: documentId,
        role: isBid ? 'bid' : 'tender',
        source: row.source || 'upload',
        file_name: row.file_name || (isBid ? '投标文件' : '招标文件'),
        markdown_path: row.markdown_path || (isBid ? 'rejection-check/bid.md' : 'rejection-check/tender.md'),
        content_hash: row.content_hash || '',
        content_chars: Number(row.content_chars || 0),
        parser_label: row.parser_label || null,
        sort_order: isBid ? bidIndex : 0,
        imported_at: row.imported_at || new Date().toISOString(),
        updated_at: row.updated_at || new Date().toISOString(),
      });
      if (isBid) bidIndex += 1;
    }
    db.exec('DROP TABLE rejection_check_documents_legacy_v12');
  } else {
    addColumnIfMissing(db, 'rejection_check_documents', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
    createRejectionCheckSchema(db);
  }

  addColumnIfMissing(db, 'rejection_check_documents', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rejection_check_documents_role_order
    ON rejection_check_documents(role, sort_order);
  `);

  addColumnIfMissing(db, 'rejection_check_risk_findings', 'bid_document_id', 'TEXT');
  addColumnIfMissing(db, 'rejection_check_typo_findings', 'bid_document_id', 'TEXT');
  addColumnIfMissing(db, 'rejection_check_logic_findings', 'bid_document_id', 'TEXT');
  const firstBid = db.prepare("SELECT document_id FROM rejection_check_documents WHERE role = 'bid' ORDER BY sort_order ASC LIMIT 1").get();
  if (firstBid?.document_id) {
    db.prepare('UPDATE rejection_check_risk_findings SET bid_document_id = ? WHERE bid_document_id IS NULL OR bid_document_id = ?').run(firstBid.document_id, '');
    db.prepare('UPDATE rejection_check_typo_findings SET bid_document_id = ? WHERE bid_document_id IS NULL OR bid_document_id = ?').run(firstBid.document_id, '');
    db.prepare('UPDATE rejection_check_logic_findings SET bid_document_id = ? WHERE bid_document_id IS NULL OR bid_document_id = ?').run(firstBid.document_id, '');
  }
}
module.exports = {
  createRejectionCheckSchema,
  migrateRejectionCheckMultiBidDocuments,
};
