// 资信库表结构（单企业 credential_library_*）。

function createCredentialLibrarySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credential_library_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      company_name TEXT,
      unified_social_credit_code TEXT,
      phone TEXT,
      email TEXT,
      legal_representative TEXT,
      registered_capital TEXT,
      operating_period_start TEXT,
      operating_period_end TEXT,
      address TEXT,
      business_scope TEXT,
      industry TEXT,
      company_type TEXT,
      insured_employee_count TEXT,
      company_intro TEXT,
      tax_certificate_date TEXT,
      tax_certificate_note TEXT,
      audit_report_date TEXT,
      audit_report_note TEXT,
      social_security_certificate_date TEXT,
      social_security_certificate_note TEXT,
      bank_account_name TEXT,
      bank_account_number TEXT,
      bank_name TEXT,
      bank_routing_number TEXT,
      watermark_enabled INTEGER NOT NULL DEFAULT 0,
      watermark_content TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS credential_library_certificates (
      certificate_id TEXT PRIMARY KEY,
      name TEXT,
      number TEXT,
      validity_mode TEXT,
      valid_from TEXT,
      valid_to TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS credential_library_employees (
      employee_id TEXT PRIMARY KEY,
      name TEXT,
      id_number TEXT,
      position TEXT,
      professional_title TEXT,
      gender TEXT,
      phone TEXT,
      id_validity_mode TEXT,
      id_valid_from TEXT,
      id_valid_to TEXT,
      education TEXT,
      school TEXT,
      major TEXT,
      introduction TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS credential_library_projects (
      project_id TEXT PRIMARY KEY,
      project_name TEXT,
      project_number TEXT,
      customer_name TEXT,
      project_type TEXT,
      project_manager TEXT,
      contract_amount TEXT,
      start_date TEXT,
      end_date TEXT,
      project_status TEXT,
      introduction TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS credential_library_other_materials (
      material_id TEXT PRIMARY KEY,
      name TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS credential_library_images (
      image_id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      field_key TEXT NOT NULL,
      original_name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      custom_name TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_credential_library_images_owner
    ON credential_library_images(owner_type, owner_id, field_key, sort_order, created_at);
  `);
}


module.exports = {
  createCredentialLibrarySchema,
};

