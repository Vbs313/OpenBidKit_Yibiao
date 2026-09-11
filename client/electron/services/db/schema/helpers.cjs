// 数据库 Schema 通用助手：标识符转义、表/列探测、幂等加列。
//
// 原本是 sqliteDatabase.cjs 里的模块级 DDL 函数，按领域拆出；除 rejectionCheck 迁移外均为纯 DDL。
function addColumnIfMissing(db, tableName, columnName, columnType) {
  if (!getExistingTables(db).has(tableName)) return;
  const columns = getExistingColumns(db, tableName);
  if (columns.has(columnName)) return;
  db.exec(`ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${quoteIdentifier(columnName)} ${columnType}`);
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function getExistingTables(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
}

function getExistingColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().map((row) => row.name));
}
module.exports = {
  quoteIdentifier,
  getExistingTables,
  getExistingColumns,
  addColumnIfMissing,
};
