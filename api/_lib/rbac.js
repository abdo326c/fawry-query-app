const ROLE_LEVELS = {
  none: 0,
  deactivated: 0,
  viewer: 1,
  operator: 2,
  accountant: 3,
  admin: 4
};

export function roleLevel(role) {
  return ROLE_LEVELS[String(role || 'none').toLowerCase()] || 0;
}

export function hasMinRole(userRole, requiredRole) {
  return roleLevel(userRole) >= roleLevel(requiredRole);
}

/**
 * Allowed tables and their per-operation minimum role, matching PostgreSQL RLS policies.
 */
export const TABLE_PERMISSIONS = {
  transactions:         { select: 'viewer', insert: 'operator',   update: 'operator',   delete: 'admin' },
  transactions_archive: { select: 'viewer', insert: 'admin',      update: 'admin',      delete: 'admin' },
  links:                { select: 'viewer', insert: 'operator',   update: 'operator',   delete: 'admin' },
  item_mappings:        { select: 'viewer', insert: 'accountant', update: 'accountant', delete: 'admin' },
  manual_fixes:         { select: 'viewer', insert: 'accountant', update: 'accountant', delete: 'admin' },
  student_master:       { select: 'viewer', insert: 'operator',   update: 'operator',   delete: 'admin' },
  payment_links:        { select: 'viewer', insert: 'operator',   update: 'operator',   delete: 'admin' },
  import_batches:       { select: 'viewer', insert: 'operator',   update: 'operator',   delete: 'admin' },
  audit_logs:           { select: 'viewer', insert: 'operator',   update: 'admin',      delete: 'admin' },
  foreign_transactions: { select: 'viewer', insert: 'operator',   update: 'operator',   delete: 'admin' },
  exchange_rates:       { select: 'viewer', insert: 'operator',   update: 'operator',   delete: 'admin' },
  settlement_batches:   { select: 'viewer', insert: 'operator',   update: 'accountant', delete: 'admin' },
  closed_periods:       { select: 'viewer', insert: 'admin',      update: 'admin',      delete: 'admin' },
  user_roles:           { select: 'self_or_viewer', insert: 'admin', update: 'admin',   delete: 'admin' }
};

export const TABLE_BOOLEAN_COLS = {
  transactions: new Set(['is_settled']),
  transactions_archive: new Set(['is_settled']),
  user_roles: new Set(['is_active']),
  closed_periods: new Set(['is_closed'])
};

export const TABLE_JSON_COLS = {
  import_batches: new Set(['details']),
  audit_logs: new Set(['details']),
  settlement_batches: new Set(['summary_data'])
};

export const TABLE_DEFAULT_CONFLICT = {
  transactions: ['reference_number', 'item_price', 'check_column'],
  transactions_archive: ['reference_number', 'item_price', 'check_column'],
  links: ['payment_reference_number'],
  item_mappings: ['item_name'],
  manual_fixes: ['reference_number'],
  student_master: ['student_id'],
  payment_links: ['invoice_number'],
  import_batches: ['id'],
  audit_logs: ['id'],
  foreign_transactions: ['reference_number'],
  exchange_rates: ['rate_date', 'currency_pair'],
  settlement_batches: ['id'],
  closed_periods: ['period_month'],
  user_roles: ['email']
};

export const TABLE_COLUMNS = {
  transactions: new Set([
    'id', 'reference_number', 'payment_date', 'student_id', 'original_student_id',
    'raw_student_id', 'customer_mobile', 'total_amount', 'net_amount', 'fawry_fees',
    'payment_status', 'item_name', 'item_price', 'mapping', 'second_mapping',
    'merchant_name', 'bank', 'check_column', 'file_name', 'id_status', 'batch_id',
    'erp_batch_number', 'erp_voucher', 'is_settled', 'settlement_batch',
    'student_level', 'import_date'
  ]),
  transactions_archive: new Set([
    'id', 'reference_number', 'payment_date', 'student_id', 'original_student_id',
    'raw_student_id', 'customer_mobile', 'total_amount', 'net_amount', 'fawry_fees',
    'payment_status', 'item_name', 'item_price', 'mapping', 'second_mapping',
    'merchant_name', 'bank', 'check_column', 'file_name', 'id_status', 'batch_id',
    'erp_batch_number', 'erp_voucher', 'is_settled', 'settlement_batch',
    'student_level', 'import_date', 'archived_at', 'archived_by'
  ]),
  links: new Set([
    'id', 'invoice_number', 'customer_name', 'customer_mobile', 'customer_email',
    'payment_status', 'paid_amount', 'payment_reference_number',
    'customer_national_id', 'custom_input_value'
  ]),
  item_mappings: new Set([
    'id', 'item_name', 'adjusted_item_name', 'mapping', 'second_mapping', 'created_at'
  ]),
  manual_fixes: new Set([
    'id', 'reference_number', 'correct_id', 'item_name', 'mapping',
    'second_mapping', 'created_at'
  ]),
  student_master: new Set([
    'student_id', 'full_name', 'arabic_name', 'national_id', 'email',
    'personal_email', 'mobile', 'guardian_name', 'guardian_mobile',
    'college', 'program', 'source', 'updated_at'
  ]),
  payment_links: new Set([
    'id', 'name', 'amount', 'invoice_number', 'creation_date',
    'expiry_date', 'invoice_link', 'created_at'
  ]),
  import_batches: new Set([
    'id', 'user_email', 'file_name', 'status', 'records_processed',
    'records_inserted', 'details', 'created_at'
  ]),
  audit_logs: new Set([
    'id', 'user_email', 'action', 'affected_references', 'details', 'created_at'
  ]),
  foreign_transactions: new Set([
    'id', 'reference_number', 'transaction_ref', 'transaction_code', 'event',
    'value_date', 'transaction_date', 'transaction_datetime', 'amount', 'currency',
    'account_number', 'student_id', 'student_level', 'extracted_name',
    'matched_student_name', 'handler_name', 'deposit_method', 'description',
    'id_status', 'match_source', 'erp_batch_number', 'erp_voucher',
    'created_at', 'updated_at'
  ]),
  exchange_rates: new Set([
    'rate_date', 'currency_pair', 'rate', 'source', 'updated_by', 'updated_at'
  ]),
  settlement_batches: new Set([
    'id', 'created_at', 'user_email', 'batch_label', 'files_count',
    'total_stl_amount', 'total_sys_amount', 'net_variance', 'matched_count',
    'mismatch_count', 'missing_sys_count', 'missing_stl_count', 'summary_data'
  ]),
  closed_periods: new Set([
    'period_month', 'is_closed', 'closed_by', 'closed_at',
    'reopened_by', 'reopened_at', 'notes', 'updated_at'
  ]),
  user_roles: new Set([
    'email', 'role', 'is_active', 'updated_by', 'updated_at'
  ])
};

export function assertValidTable(table) {
  if (!Object.prototype.hasOwnProperty.call(TABLE_PERMISSIONS, table)) {
    const err = new Error(`Table "${table}" is not accessible.`);
    err.status = 400;
    throw err;
  }
}

export function assertValidColumn(table, col) {
  const allowed = TABLE_COLUMNS[table];
  if (!allowed || !allowed.has(col)) {
    const err = new Error(`Invalid column "${col}" on table "${table}".`);
    err.status = 400;
    throw err;
  }
}

export function assertTableAccess(user, table, operation) {
  assertValidTable(table);
  if (!user) {
    const err = new Error('Authentication required.');
    err.status = 401;
    throw err;
  }
  const reqRole = TABLE_PERMISSIONS[table][operation];
  if (reqRole === 'self_or_viewer') {
    // Allowed for any authenticated user to read their own row (filtered in query.js if role < viewer)
    return;
  }
  if (!hasMinRole(user.role, reqRole)) {
    const err = new Error(`Access denied: requires ${reqRole} role for ${operation} on ${table}.`);
    err.status = 403;
    throw err;
  }
}

/**
 * Checks if any of the given YYYY-MM-DD dates fall in a closed accounting period.
 */
export async function assertPeriodsUnlocked(db, dates) {
  const months = new Set();
  for (const d of dates) {
    if (!d) continue;
    const m = String(d).trim().slice(0, 7);
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) {
      months.add(m);
    }
  }
  if (months.size === 0) return;

  const placeholders = [...months].map(() => '?').join(', ');
  const res = await db.execute({
    sql: `SELECT period_month FROM closed_periods WHERE is_closed = 1 AND period_month IN (${placeholders})`,
    args: [...months]
  });

  if (res.rows.length > 0) {
    const locked = res.rows.map(r => r.period_month).join(', ');
    const err = new Error(`Accounting period ${locked} is closed. Reopen the period in Admin before modifying these records.`);
    err.status = 403;
    throw err;
  }
}

/**
 * Classifies a student program string as 'PG' or 'UG' (mirrors schema.sql).
 */
export function classifyProgramStudentLevel(program) {
  if (!program || !String(program).trim()) return null;
  const p = String(program);
  if (/(^|[^a-z])(pg|post\s*grad|graduate|master|msc|mba|phd|doctorate|diploma)([^a-z]|$)/i.test(p)) {
    return 'PG';
  }
  return 'UG';
}

/**
 * Resolves student_level ('UG' or 'PG') for a batch of student IDs in minimal queries.
 */
export async function resolveStudentLevelsBatch(db, studentIds) {
  const uniqueIds = [...new Set((studentIds || []).map(id => String(id || '').trim()).filter(Boolean))];
  const resultMap = new Map();
  if (uniqueIds.length === 0) return resultMap;

  const programMap = new Map();
  const CHUNK_SIZE = 400;
  for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const res = await db.execute({
      sql: `SELECT student_id, program FROM student_master WHERE student_id IN (${placeholders})`,
      args: chunk
    });
    for (const row of res.rows) {
      programMap.set(String(row.student_id).trim(), row.program);
    }
  }

  for (const sid of uniqueIds) {
    let lvl = null;
    if (programMap.has(sid)) {
      lvl = classifyProgramStudentLevel(programMap.get(sid));
    }
    if (!lvl) {
      if (/^9\d{6}$/.test(sid)) lvl = 'PG';
      else if (/^\d{9}$/.test(sid)) lvl = 'UG';
    }
    resultMap.set(sid, lvl);
  }
  return resultMap;
}

/**
 * Resolves student_level ('UG' or 'PG') from student_master or student_id prefix.
 */
export async function resolveStudentLevel(db, studentId) {
  const sid = String(studentId || '').trim();
  if (!sid) return null;
  const map = await resolveStudentLevelsBatch(db, [sid]);
  return map.get(sid) ?? null;
}

/**
 * Sanitizes audit_logs insert payload just like trg_secure_audit_log_insert in schema.sql.
 */
export function sanitizeAuditLogRow(user, row) {
  const adminOnlyActions = new Set([
    'Database Hygiene Audit',
    'Database Hygiene Rollback',
    'Accounting Period Closed',
    'Accounting Period Unlocked'
  ]);

  if (adminOnlyActions.has(row.action) && user.role !== 'admin') {
    const err = new Error(`Access denied: only admin can log ${row.action}`);
    err.status = 403;
    throw err;
  }

  const out = { ...row, user_email: user.email };
  if (!hasMinRole(user.role, 'accountant') && out.details && typeof out.details === 'object') {
    const cloned = { ...out.details };
    delete cloned.revert_data;
    delete cloned.revert_snapshot;
    delete cloned.drive_folder_url;
    out.details = cloned;
  }
  return out;
}
