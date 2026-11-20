import { getDb, readJsonBody, sendJson } from './_lib/db.js';
import { getAuthUser } from './_lib/auth.js';
import { hasMinRole, resolveStudentLevelsBatch, roleLevel } from './_lib/rbac.js';

const PRIMARY_ADMIN_EMAIL = 'ammahmoud@nu.edu.eg';
const EXEMPT_ITEM_RE = /\b(dip|diploma|workshops?)\b/i;

function requireRole(user, minRole, actionDesc) {
  if (!user) {
    const err = new Error('Authentication required.');
    err.status = 401;
    throw err;
  }
  if (!hasMinRole(user.role, minRole)) {
    const err = new Error(`Access denied: ${minRole} role required to ${actionDesc}`);
    err.status = 403;
    throw err;
  }
}

function isExemptMapping(row) {
  return EXEMPT_ITEM_RE.test(row.mapping || '') || EXEMPT_ITEM_RE.test(row.second_mapping || '');
}

function parseDetailsJson(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function executeHygieneRollback(db, user, auditId) {
  const logRes = await db.execute({
    sql: 'SELECT id, action, details FROM audit_logs WHERE id = ? LIMIT 1',
    args: [auditId]
  });
  if (!logRes.rows.length) {
    const err = new Error(`Audit log record ${auditId} not found`);
    err.status = 404;
    throw err;
  }

  const details = parseDetailsJson(logRes.rows[0].details);
  if (details.is_reverted === true) {
    const err = new Error(`Audit run ${auditId} has already been reverted`);
    err.status = 400;
    throw err;
  }

  const snapshot = details.revert_snapshot;
  if (!snapshot || typeof snapshot !== 'object') {
    return { success: false, message: 'No snapshot found for this audit run.' };
  }

  let restoredM = 0;
  let restoredF = 0;
  const tx = await db.transaction('write');
  try {
    for (const m of (snapshot.deleted_mappings || [])) {
      await tx.execute({
        sql: `INSERT OR IGNORE INTO item_mappings (item_name, adjusted_item_name, mapping, second_mapping)
              VALUES (?, ?, ?, ?)`,
        args: [m.item_name ?? null, m.adjusted_item_name ?? null, m.mapping ?? null, m.second_mapping ?? null]
      });
      restoredM++;
    }

    for (const f of (snapshot.deleted_fixes || [])) {
      await tx.execute({
        sql: `INSERT OR IGNORE INTO manual_fixes (reference_number, correct_id, item_name, mapping, second_mapping)
              VALUES (?, ?, ?, ?, ?)`,
        args: [f.reference_number ?? null, f.correct_id ?? null, f.item_name ?? null, f.mapping ?? null, f.second_mapping ?? null]
      });
      restoredF++;
    }

    const updatedDetails = { ...details, is_reverted: true };
    await tx.execute({
      sql: 'UPDATE audit_logs SET details = ? WHERE id = ?',
      args: [JSON.stringify(updatedDetails), auditId]
    });

    await tx.execute({
      sql: 'INSERT INTO audit_logs (user_email, action, affected_references, details) VALUES (?, ?, ?, ?)',
      args: [
        user.email,
        'Database Hygiene Rollback',
        `Audit #${auditId}`,
        JSON.stringify({
          target_audit_id: auditId,
          restored_mappings: restoredM,
          restored_fixes: restoredF,
          reverted_at: new Date().toISOString()
        })
      ]
    });
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  return {
    success: true,
    audit_id: auditId,
    restored_mappings: restoredM,
    restored_fixes: restoredF,
    message: `Successfully restored ${restoredM} mapping rules and ${restoredF} manual fixes.`
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const db = getDb();
    const user = await getAuthUser(req, db);
    const body = await readJsonBody(req);
    const fn = String(body.fn || '').trim();
    const args = body.args && typeof body.args === 'object' ? body.args : {};

    switch (fn) {
      case 'get_dashboard_pivot': {
        requireRole(user, 'viewer', 'view dashboard pivot');
        const { start_date, end_date } = args;
        const result = await db.execute({
          sql: `SELECT payment_date, bank, COALESCE(SUM(item_price), 0) AS daily_total
                FROM transactions
                WHERE payment_date >= ? AND payment_date <= ?
                GROUP BY payment_date, bank
                ORDER BY payment_date, bank`,
          args: [start_date, end_date]
        });
        return sendJson(res, 200, { data: result.rows });
      }

      case 'get_dashboard_pivot_by': {
        requireRole(user, 'viewer', 'view dashboard pivot');
        const { start_date, end_date, group_col } = args;
        let groupExpr;
        if (group_col === 'date') groupExpr = 'payment_date';
        else if (group_col === 'mapping') groupExpr = "COALESCE(NULLIF(mapping, ''), 'Unmapped')";
        else if (group_col === 'second_mapping') groupExpr = "COALESCE(NULLIF(second_mapping, ''), 'Unmapped')";
        else if (group_col === 'item_name') groupExpr = "COALESCE(NULLIF(item_name, ''), 'Unknown Item')";
        else {
          return sendJson(res, 400, { error: `Invalid group_col for dashboard pivot: ${group_col}` });
        }

        const result = await db.execute({
          sql: `SELECT ${groupExpr} AS group_key, bank, COALESCE(SUM(item_price), 0) AS total_amount
                FROM transactions
                WHERE payment_date >= ? AND payment_date <= ?
                GROUP BY 1, bank
                ORDER BY 1, bank`,
          args: [start_date, end_date]
        });
        return sendJson(res, 200, { data: result.rows });
      }

      case 'get_dashboard_summary': {
        requireRole(user, 'viewer', 'view dashboard summary');
        const startDate = args.start_date;
        const endDate = args.end_date;
        const groupCol = String(args.group_col || 'date').trim().toLowerCase();
        const banks = Array.isArray(args.banks) && args.banks.length > 0 ? args.banks : null;
        const statusFilter = String(args.status_filter || 'all').trim().toLowerCase();

        if (!['date', 'mapping', 'second_mapping', 'item_name'].includes(groupCol)) {
          return sendJson(res, 400, { error: `Invalid group_col for dashboard summary: ${groupCol}` });
        }

        let sql = `SELECT payment_date, bank, COALESCE(item_price, 0) AS item_price,
                          mapping, second_mapping, item_name, id_status,
                          COALESCE(is_settled, 0) AS is_settled, erp_batch_number
                   FROM transactions
                   WHERE payment_date >= ? AND payment_date <= ?`;
        const sqlArgs = [startDate, endDate];
        if (banks) {
          sql += ` AND bank IN (${banks.map(() => '?').join(', ')})`;
          sqlArgs.push(...banks);
        }

        const resRows = await db.execute({ sql, args: sqlArgs });
        const filtered = resRows.rows.filter(t => {
          const settled = Boolean(t.is_settled);
          const hasErp = Boolean(String(t.erp_batch_number || '').trim());
          if (statusFilter === 'all') return true;
          if (statusFilter === 'valid') return t.id_status === 'Valid' || t.id_status === 'Exempt' || isExemptMapping(t);
          if (statusFilter === 'invalid') return t.id_status !== 'Valid' && t.id_status !== 'Exempt' && !isExemptMapping(t);
          if (statusFilter === 'settled') return settled;
          if (statusFilter === 'unsettled') return !settled;
          if (statusFilter === 'erp_recorded') return hasErp;
          if (statusFilter === 'erp_unposted') return !hasErp;
          return true;
        });

        let validCount = 0;
        let settledCount = 0;
        let erpCount = 0;
        let unmappedCount = 0;
        const pivotMap = new Map();
        const catMap = new Map();

        for (const t of filtered) {
          if (t.id_status === 'Valid') validCount++;
          if (t.is_settled) settledCount++;
          if (String(t.erp_batch_number || '').trim()) erpCount++;
          if (!String(t.mapping || '').trim()) unmappedCount++;

          const price = Number(t.item_price || 0);
          let gKey = '';
          if (groupCol === 'date') gKey = String(t.payment_date || '');
          else if (groupCol === 'mapping') gKey = String(t.mapping || '').trim() || 'Unmapped';
          else if (groupCol === 'second_mapping') gKey = String(t.second_mapping || '').trim() || 'Unmapped';
          else gKey = String(t.item_name || '').trim() || 'Unknown Item';

          const pKey = `${gKey}\0${t.bank || ''}`;
          const prevP = pivotMap.get(pKey);
          if (prevP) prevP.total_amount += price;
          else pivotMap.set(pKey, { group_key: gKey, bank: t.bank, total_amount: price });

          const cKey = String(t.mapping || '').trim() || 'Unmapped';
          catMap.set(cKey, (catMap.get(cKey) || 0) + price);
        }

        const pivot = [...pivotMap.values()].sort((a, b) =>
          a.group_key.localeCompare(b.group_key) || String(a.bank || '').localeCompare(String(b.bank || ''))
        );
        const categories = [...catMap.entries()]
          .map(([group_key, total_amount]) => ({ group_key, total_amount }))
          .sort((a, b) => b.total_amount - a.total_amount);

        return sendJson(res, 200, {
          data: {
            kpis: {
              total_count: filtered.length,
              valid_count: validCount,
              settled_count: settledCount,
              erp_count: erpCount,
              unmapped_count: unmappedCount
            },
            pivot,
            categories
          }
        });
      }

      case 'get_distinct_transaction_values': {
        requireRole(user, 'viewer', 'view transaction filters');
        const colName = String(args.col_name || '');
        if (!['mapping', 'item_name', 'second_mapping', 'bank', 'id_status'].includes(colName)) {
          return sendJson(res, 400, { error: `Invalid column name for distinct lookup: ${colName}` });
        }
        const result = await db.execute({
          sql: `SELECT DISTINCT "${colName}" AS val FROM transactions WHERE "${colName}" IS NOT NULL AND "${colName}" != '' ORDER BY 1`
        });
        return sendJson(res, 200, { data: result.rows });
      }

      case 'get_keyset_bounds': {
        requireRole(user, 'viewer', 'paginate table');
        const pTable = String(args.p_table || '');
        const pCol = String(args.p_col || '');
        const pChunk = Math.max(100, Math.min(Number(args.p_chunk_size || 1000), 5000));
        const pAfter = args.p_after ?? null;

        const allowedTargets = {
          transactions: new Set(['id']),
          student_master: new Set(['student_id']),
          links: new Set(['payment_reference_number', 'id']),
          manual_fixes: new Set(['reference_number', 'id']),
          item_mappings: new Set(['item_name', 'id']),
          payment_links: new Set(['id']),
          foreign_transactions: new Set(['id'])
        };
        if (!allowedTargets[pTable] || !allowedTargets[pTable].has(pCol)) {
          return sendJson(res, 400, { error: `Invalid keyset target: ${pTable}.${pCol}` });
        }

        const isNumericId = pCol === 'id' && pTable !== 'payment_links';
        let whereClause = '';
        const qArgs = [pChunk];
        if (pAfter !== null && pAfter !== undefined && String(pAfter) !== '') {
          let coercedAfter = String(pAfter);
          if (isNumericId) {
            const num = Number(pAfter);
            if (!Number.isFinite(num)) {
              return sendJson(res, 400, { error: `Invalid numeric p_after cursor: ${pAfter}` });
            }
            coercedAfter = num;
          }
          whereClause = `WHERE "${pCol}" > ?`;
          qArgs.push(coercedAfter);
        }

        const sql = `
          SELECT
            CAST(((rn - 1) / ?) AS INTEGER) AS chunk_idx,
            CAST(MIN(k) AS TEXT) AS min_val,
            CAST(MAX(k) AS TEXT) AS max_val
          FROM (
            SELECT "${pCol}" AS k, ROW_NUMBER() OVER (ORDER BY "${pCol}" ASC) AS rn
            FROM "${pTable}"
            ${whereClause}
          ) s
          GROUP BY chunk_idx
          ORDER BY chunk_idx ASC
        `;
        const boundsRes = await db.execute({ sql, args: qArgs });
        return sendJson(res, 200, {
          data: boundsRes.rows.map(r => ({
            chunk_idx: Number(r.chunk_idx),
            min_val: String(r.min_val),
            max_val: String(r.max_val)
          }))
        });
      }

      case 'get_unresolved_tx_count': {
        requireRole(user, 'viewer', 'count unresolved transactions');
        const resRows = await db.execute({
          sql: `SELECT mapping, second_mapping FROM transactions
                WHERE COALESCE(id_status, '') NOT IN ('Valid', 'Exempt')`
        });
        const count = resRows.rows.filter(r => !isExemptMapping(r)).length;
        return sendJson(res, 200, { data: count });
      }

      case 'get_student_master_version': {
        requireRole(user, 'viewer', 'check student master version');
        const result = await db.execute({
          sql: `SELECT COUNT(*) AS row_count, COALESCE(MAX(student_id), '') AS max_student_id, MAX(updated_at) AS max_updated_at
                FROM student_master`
        });
        return sendJson(res, 200, { data: result.rows[0] });
      }

      case 'get_database_storage_stats': {
        requireRole(user, 'admin', 'view database storage stats');
        const pageCountRes = await db.execute({ sql: 'PRAGMA page_count' });
        const pageSizeRes = await db.execute({ sql: 'PRAGMA page_size' });
        const pageCount = Number(pageCountRes.rows[0]?.page_count || 0);
        const pageSize = Number(pageSizeRes.rows[0]?.page_size || 4096);
        const totalBytes = pageCount * pageSize;
        const limitMb = 5120; // Turso Free Tier: 5 GB

        const tableNames = [
          'transactions', 'transactions_archive', 'student_master', 'links',
          'audit_logs', 'foreign_transactions', 'payment_links', 'manual_fixes',
          'item_mappings', 'settlement_batches', 'import_batches', 'user_roles'
        ];
        const tables = [];
        for (const t of tableNames) {
          const cntRes = await db.execute({ sql: `SELECT COUNT(*) AS cnt FROM "${t}"` });
          const estRows = Number(cntRes.rows[0]?.cnt || 0);
          tables.push({
            table_name: t,
            est_rows: estRows,
            table_mb: 0,
            indexes_mb: 0,
            total_mb: 0
          });
        }
        tables.sort((a, b) => b.est_rows - a.est_rows);

        return sendJson(res, 200, {
          data: {
            total_bytes: totalBytes,
            used_mb: Math.round((totalBytes / (1024 * 1024)) * 10) / 10,
            limit_mb: limitMb,
            pct_used: Math.round((totalBytes / (limitMb * 1024 * 1024)) * 1000) / 10,
            tables: tables.slice(0, 8)
          }
        });
      }

      case 'bulk_update_rule_fields': {
        requireRole(user, 'operator', 'bulk update rule fields');
        const updates = Array.isArray(args.p_updates) ? args.p_updates : [];
        if (updates.length === 0) return sendJson(res, 200, { data: 0 });

        const studentIds = updates.map(u => u?.student_id).filter(Boolean);
        const levelMap = await resolveStudentLevelsBatch(db, studentIds);

        let updatedCount = 0;
        const tx = await db.transaction('write');
        try {
          for (const item of updates) {
            if (!item || item.id === undefined || item.id === null) continue;
            const sid = item.student_id ? String(item.student_id).trim() : '';
            const lvl = sid ? (levelMap.get(sid) ?? null) : null;
            const r = await tx.execute({
              sql: `UPDATE transactions
                    SET student_id = ?, item_name = ?, mapping = ?, second_mapping = ?, id_status = ?, student_level = COALESCE(?, student_level)
                    WHERE id = ?`,
              args: [
                item.student_id ?? null,
                item.item_name ?? null,
                item.mapping ?? null,
                item.second_mapping ?? null,
                item.id_status ?? null,
                lvl,
                Number(item.id)
              ]
            });
            updatedCount += r.rowsAffected || 0;
          }
          await tx.commit();
        } catch (err) {
          await tx.rollback();
          throw err;
        }
        return sendJson(res, 200, { data: updatedCount });
      }

      case 'sync_auth_users': {
        requireRole(user, 'admin', 'sync users');
        const authRes = await db.execute({
          sql: "SELECT email FROM app_users WHERE email IS NOT NULL AND TRIM(email) != ''"
        });

        let inserted = 0;
        const tx = await db.transaction('write');
        try {
          for (const u of authRes.rows) {
            const email = String(u.email).trim().toLowerCase();
            const role = email === PRIMARY_ADMIN_EMAIL ? 'admin' : 'viewer';
            const isActive = (email === PRIMARY_ADMIN_EMAIL || email.endsWith('@nu.edu.eg')) ? 1 : 0;
            const ins = await tx.execute({
              sql: `INSERT INTO user_roles (email, role, is_active, updated_by, updated_at)
                    VALUES (?, ?, ?, 'auth.users sync', datetime('now'))
                    ON CONFLICT(email) DO NOTHING`,
              args: [email, role, isActive]
            });
            inserted += ins.rowsAffected || 0;
          }
          await tx.execute({
            sql: `UPDATE user_roles SET role = 'admin', is_active = 1, updated_at = datetime('now')
                  WHERE LOWER(TRIM(email)) = ?`,
            args: [PRIMARY_ADMIN_EMAIL]
          });
          await tx.commit();
        } catch (err) {
          await tx.rollback();
          throw err;
        }

        const totalRes = await db.execute({ sql: 'SELECT COUNT(*) AS cnt FROM user_roles' });
        const total = Number(totalRes.rows[0]?.cnt || 0);
        return sendJson(res, 200, { data: { inserted, total } });
      }

      case 'admin_set_user_active': {
        requireRole(user, 'admin', 'change user active status');
        const targetEmail = String(args.target_email || '').trim().toLowerCase();
        const active = args.active ? 1 : 0;
        if (!targetEmail || !targetEmail.includes('@')) {
          return sendJson(res, 400, { error: 'Valid target email is required' });
        }
        if (targetEmail === PRIMARY_ADMIN_EMAIL && active === 0) {
          return sendJson(res, 400, { error: 'Primary Admin account cannot be deactivated' });
        }
        if (targetEmail === user.email && active === 0) {
          return sendJson(res, 400, { error: 'You cannot deactivate your own active Admin account' });
        }

        const roleForInsert = targetEmail === PRIMARY_ADMIN_EMAIL ? 'admin' : 'viewer';
        await db.execute({
          sql: `INSERT INTO user_roles (email, role, is_active, updated_by, updated_at)
                VALUES (?, ?, ?, ?, datetime('now'))
                ON CONFLICT(email) DO UPDATE SET
                  is_active = excluded.is_active,
                  updated_by = excluded.updated_by,
                  updated_at = datetime('now')`,
          args: [targetEmail, roleForInsert, active, user.email]
        });

        const appRes = await db.execute({
          sql: 'SELECT id FROM app_users WHERE LOWER(TRIM(email)) = ? LIMIT 1',
          args: [targetEmail]
        });
        return sendJson(res, 200, {
          data: {
            email: targetEmail,
            is_active: Boolean(active),
            auth_user_found: appRes.rows.length > 0
          }
        });
      }

      case 'admin_delete_user': {
        requireRole(user, 'admin', 'delete user');
        const targetEmail = String(args.target_email || '').trim().toLowerCase();
        if (!targetEmail || !targetEmail.includes('@')) {
          return sendJson(res, 400, { error: 'Valid target email is required' });
        }
        if (targetEmail === PRIMARY_ADMIN_EMAIL) {
          return sendJson(res, 400, { error: 'Primary Admin account cannot be deleted' });
        }
        if (targetEmail === user.email) {
          return sendJson(res, 400, { error: 'You cannot delete your own active Admin account' });
        }
        await db.execute({ sql: 'DELETE FROM user_roles WHERE LOWER(TRIM(email)) = ?', args: [targetEmail] });
        const delAuth = await db.execute({ sql: 'DELETE FROM app_users WHERE LOWER(TRIM(email)) = ?', args: [targetEmail] });
        return sendJson(res, 200, {
          data: {
            email: targetEmail,
            deleted_auth_users: delAuth.rowsAffected || 0
          }
        });
      }

      case 'set_accounting_period_lock': {
        requireRole(user, 'admin', 'lock or unlock accounting periods');
        const periodMonth = String(args.p_period_month || '').trim();
        const isClosed = args.p_is_closed ? 1 : 0;
        const notes = args.p_notes ?? null;
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodMonth)) {
          return sendJson(res, 400, { error: 'Invalid period_month format. Expected YYYY-MM.' });
        }

        await db.execute({
          sql: `INSERT INTO closed_periods (period_month, is_closed, closed_by, closed_at, reopened_by, reopened_at, notes, updated_at)
                VALUES (?, ?, CASE WHEN ? = 1 THEN ? ELSE NULL END, CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END,
                        CASE WHEN ? = 0 THEN ? ELSE NULL END, CASE WHEN ? = 0 THEN datetime('now') ELSE NULL END, ?, datetime('now'))
                ON CONFLICT(period_month) DO UPDATE SET
                  is_closed = excluded.is_closed,
                  closed_by = CASE WHEN excluded.is_closed = 1 THEN ? ELSE closed_periods.closed_by END,
                  closed_at = CASE WHEN excluded.is_closed = 1 THEN datetime('now') ELSE closed_periods.closed_at END,
                  reopened_by = CASE WHEN excluded.is_closed = 0 THEN ? ELSE closed_periods.reopened_by END,
                  reopened_at = CASE WHEN excluded.is_closed = 0 THEN datetime('now') ELSE closed_periods.reopened_at END,
                  notes = COALESCE(?, closed_periods.notes),
                  updated_at = datetime('now')`,
          args: [
            periodMonth, isClosed,
            isClosed, user.email, isClosed,
            isClosed, user.email, isClosed,
            notes,
            user.email, user.email, notes
          ]
        });

        await db.execute({
          sql: 'INSERT INTO audit_logs (user_email, action, affected_references, details) VALUES (?, ?, ?, ?)',
          args: [
            user.email,
            isClosed ? 'Accounting Period Closed' : 'Accounting Period Unlocked',
            periodMonth,
            JSON.stringify({ period_month: periodMonth, is_closed: Boolean(isClosed), notes })
          ]
        });

        return sendJson(res, 200, {
          data: { period_month: periodMonth, is_closed: Boolean(isClosed), notes }
        });
      }

      case 'archive_settled_transactions': {
        requireRole(user, 'admin', 'archive transactions');
        const beforeDate = String(args.p_before_date || '').trim();
        const dryRun = args.p_dry_run !== false;
        const cutoff = new Date();
        cutoff.setUTCDate(cutoff.getUTCDate() - 90);
        const minAllowed = cutoff.toISOString().slice(0, 10);

        if (!beforeDate || beforeDate > minAllowed) {
          return sendJson(res, 400, { error: 'Safety guard: cutoff date must be at least 90 days in the past' });
        }

        const eligRes = await db.execute({
          sql: `SELECT COUNT(*) AS cnt, COALESCE(SUM(item_price), 0) AS amt
                FROM transactions
                WHERE payment_date < ? AND COALESCE(is_settled, 0) = 1
                  AND TRIM(COALESCE(erp_batch_number, '')) != ''`,
          args: [beforeDate]
        });
        const eligibleCount = Number(eligRes.rows[0]?.cnt || 0);
        const eligibleAmount = Number(eligRes.rows[0]?.amt || 0);

        if (dryRun) {
          return sendJson(res, 200, {
            data: {
              dry_run: true,
              before_date: beforeDate,
              eligible_count: eligibleCount,
              eligible_amount_egp: eligibleAmount
            }
          });
        }

        const tx = await db.transaction('write');
        let archivedCount = 0;
        try {
          const ins = await tx.execute({
            sql: `INSERT OR IGNORE INTO transactions_archive (
                    id, reference_number, payment_date, student_id, original_student_id,
                    raw_student_id, customer_mobile, total_amount, net_amount, fawry_fees,
                    payment_status, item_name, item_price, mapping, second_mapping,
                    merchant_name, bank, check_column, file_name, id_status, batch_id,
                    erp_batch_number, erp_voucher, is_settled, settlement_batch,
                    student_level, import_date, archived_at, archived_by
                  )
                  SELECT
                    id, reference_number, payment_date, student_id, original_student_id,
                    raw_student_id, customer_mobile, total_amount, net_amount, fawry_fees,
                    payment_status, item_name, item_price, mapping, second_mapping,
                    merchant_name, bank, check_column, file_name, id_status, batch_id,
                    erp_batch_number, erp_voucher, is_settled, settlement_batch,
                    student_level, import_date, datetime('now'), ?
                  FROM transactions
                  WHERE payment_date < ? AND COALESCE(is_settled, 0) = 1
                    AND TRIM(COALESCE(erp_batch_number, '')) != ''`,
            args: [user.email, beforeDate]
          });
          archivedCount = ins.rowsAffected || 0;

          await tx.execute({
            sql: `DELETE FROM transactions
                  WHERE payment_date < ? AND COALESCE(is_settled, 0) = 1
                    AND TRIM(COALESCE(erp_batch_number, '')) != ''`,
            args: [beforeDate]
          });

          await tx.execute({
            sql: 'INSERT INTO audit_logs (user_email, action, affected_references, details) VALUES (?, ?, ?, ?)',
            args: [
              user.email,
              'Cold-Storage Archive Completed',
              `Before ${beforeDate} (${archivedCount} rows)`,
              JSON.stringify({ before_date: beforeDate, archived_count: archivedCount, archived_amount_egp: eligibleAmount })
            ]
          });
          await tx.commit();
        } catch (err) {
          await tx.rollback();
          throw err;
        }

        return sendJson(res, 200, {
          data: {
            dry_run: false,
            before_date: beforeDate,
            archived_count: archivedCount,
            archived_amount_egp: eligibleAmount
          }
        });
      }

      case 'detect_double_payments': {
        requireRole(user, 'viewer', 'detect double payments');
        const daysWindow = Math.max(0, Number(args.p_days_window ?? 3));
        const rowsRes = await db.execute({
          sql: `SELECT
                  t.id, t.student_id, t.item_name, t.mapping, t.item_price,
                  t.payment_date, t.reference_number, t.bank, COALESCE(t.is_settled, 0) AS is_settled,
                  COALESCE(sm.full_name, sm.arabic_name, '-') AS student_name,
                  COALESCE(sm.college, '-') AS faculty
                FROM transactions t
                LEFT JOIN student_master sm ON sm.student_id = t.student_id
                WHERE t.id_status = 'Valid'
                  AND TRIM(COALESCE(t.student_id, '')) != ''
                  AND COALESCE(t.item_price, 0) > 0
                  AND t.payment_date IS NOT NULL
                  AND LOWER(TRIM(COALESCE(t.mapping, ''))) = 'tuition'
                ORDER BY t.payment_date DESC, t.id DESC`
        });

        const groups = new Map();
        for (const r of rowsRes.rows) {
          const itemName = String(r.item_name || '').trim() || 'Unknown';
          const mapping = String(r.mapping || '').trim() || 'Tuition';
          const price = Number(r.item_price || 0);
          const key = `${r.student_id}\0${itemName}\0${mapping}\0${price}`;
          if (!groups.has(key)) {
            groups.set(key, {
              student_id: r.student_id,
              student_name: r.student_name || '-',
              faculty: r.faculty || '-',
              item_name: itemName,
              mapping,
              item_price: price,
              rows: []
            });
          }
          groups.get(key).rows.push(r);
        }

        const results = [];
        for (const g of groups.values()) {
          const distinctRefs = new Set(g.rows.map(r => r.reference_number));
          if (distinctRefs.size <= 1) continue;

          const dates = g.rows.map(r => String(r.payment_date)).sort();
          const firstDate = dates[0];
          const lastDate = dates[dates.length - 1];
          const daysApart = Math.round((new Date(lastDate).getTime() - new Date(firstDate).getTime()) / 86400000);
          if (daysApart > daysWindow) continue;

          const totalAmount = g.rows.reduce((sum, r) => sum + Number(r.item_price || 0), 0);
          results.push({
            student_id: g.student_id,
            student_name: g.student_name,
            faculty: g.faculty,
            item_name: g.item_name,
            mapping: g.mapping,
            item_price: g.item_price,
            occurrences: distinctRefs.size,
            total_amount: totalAmount,
            first_date: firstDate,
            last_date: lastDate,
            reference_numbers: g.rows.map(r => String(r.reference_number)),
            banks: g.rows.map(r => String(r.bank || '')),
            settled_flags: g.rows.map(r => Boolean(r.is_settled))
          });
        }

        results.sort((a, b) => b.last_date.localeCompare(a.last_date) || b.total_amount - a.total_amount);
        return sendJson(res, 200, { data: results.slice(0, 500) });
      }

      case 'run_database_hygiene_audit': {
        requireRole(user, 'admin', 'run database hygiene audit');
        const clean = Boolean(args.p_clean);

        const [totRes, setRes, unmRes, invRes, idupRes, mapsRes, fixesRes] = await Promise.all([
          db.execute({ sql: 'SELECT COUNT(*) AS cnt FROM transactions' }),
          db.execute({ sql: 'SELECT COUNT(*) AS cnt FROM transactions WHERE is_settled = 1' }),
          db.execute({ sql: "SELECT COUNT(*) AS cnt FROM transactions WHERE mapping IS NULL OR mapping = '' OR mapping = 'Unmapped'" }),
          db.execute({ sql: "SELECT COUNT(*) AS cnt FROM transactions WHERE id_status IS NOT NULL AND id_status != 'Valid'" }),
          db.execute({
            sql: `SELECT COALESCE(SUM(c - 1), 0) AS cnt FROM (
                    SELECT COUNT(*) AS c FROM transactions
                    GROUP BY reference_number, item_name, item_price, payment_date
                    HAVING COUNT(*) > 1
                  )`
          }),
          db.execute({ sql: 'SELECT id, item_name, adjusted_item_name, mapping, second_mapping FROM item_mappings ORDER BY id ASC' }),
          db.execute({ sql: 'SELECT id, reference_number, correct_id, item_name, mapping, second_mapping FROM manual_fixes ORDER BY id ASC' })
        ]);

        const totalTx = Number(totRes.rows[0]?.cnt || 0);
        const settledTx = Number(setRes.rows[0]?.cnt || 0);
        const unmappedTx = Number(unmRes.rows[0]?.cnt || 0);
        const invalidIdTx = Number(invRes.rows[0]?.cnt || 0);
        const identicalDups = Number(idupRes.rows[0]?.cnt || 0);

        const seenMappingsExact = new Set();
        const dupMappingIds = [];
        const deletedMappings = [];
        const mappingsByLower = new Map();

        for (const m of mapsRes.rows) {
          const lowerName = String(m.item_name || '').trim().toLowerCase();
          const tupleKey = `${m.adjusted_item_name || ''}\0${m.mapping || ''}\0${m.second_mapping || ''}`;
          if (!mappingsByLower.has(lowerName)) mappingsByLower.set(lowerName, new Set());
          mappingsByLower.get(lowerName).add(tupleKey);

          const exactKey = `${lowerName}\0${tupleKey}`;
          if (seenMappingsExact.has(exactKey)) {
            dupMappingIds.push(m.id);
            deletedMappings.push({
              item_name: m.item_name,
              adjusted_item_name: m.adjusted_item_name,
              mapping: m.mapping,
              second_mapping: m.second_mapping
            });
          } else {
            seenMappingsExact.add(exactKey);
          }
        }

        let conflictingMappings = 0;
        for (const tuples of mappingsByLower.values()) {
          if (tuples.size > 1) conflictingMappings++;
        }

        const seenFixes = new Set();
        const dupFixIds = [];
        const deletedFixes = [];
        for (const f of fixesRes.rows) {
          if (seenFixes.has(f.reference_number)) {
            dupFixIds.push(f.id);
            deletedFixes.push({
              reference_number: f.reference_number,
              correct_id: f.correct_id,
              item_name: f.item_name,
              mapping: f.mapping,
              second_mapping: f.second_mapping
            });
          } else {
            seenFixes.add(f.reference_number);
          }
        }

        const dupMappingsCount = dupMappingIds.length;
        const dupFixesCount = dupFixIds.length;
        let cleanedMappings = 0;
        let cleanedFixes = 0;

        if (clean && (dupMappingIds.length > 0 || dupFixIds.length > 0)) {
          const tx = await db.transaction('write');
          try {
            if (dupMappingIds.length > 0) {
              const ph = dupMappingIds.map(() => '?').join(', ');
              const delM = await tx.execute({ sql: `DELETE FROM item_mappings WHERE id IN (${ph})`, args: dupMappingIds });
              cleanedMappings = delM.rowsAffected || 0;
            }
            if (dupFixIds.length > 0) {
              const ph = dupFixIds.map(() => '?').join(', ');
              const delF = await tx.execute({ sql: `DELETE FROM manual_fixes WHERE id IN (${ph})`, args: dupFixIds });
              cleanedFixes = delF.rowsAffected || 0;
            }
            await tx.commit();
          } catch (err) {
            await tx.rollback();
            throw err;
          }
        }

        const healthScore = totalTx === 0
          ? 100.0
          : Math.round(Math.max(0, (1 - (invalidIdTx + unmappedTx + identicalDups + dupMappingsCount + dupFixesCount) / (totalTx * 2))) * 1000) / 10;

        const auditDetails = {
          health_score: `${healthScore}%`,
          total_transactions: totalTx,
          settled_transactions: settledTx,
          invalid_ids: invalidIdTx,
          unmapped_items: unmappedTx,
          identical_tx_duplicates: identicalDups,
          duplicate_mappings: dupMappingsCount,
          conflicting_case_mappings: conflictingMappings,
          duplicate_fixes: dupFixesCount,
          cleaned_mappings: cleanedMappings,
          cleaned_fixes: cleanedFixes,
          auto_cleaned: clean,
          is_reverted: false,
          revert_snapshot: {
            deleted_mappings: clean ? deletedMappings : [],
            deleted_fixes: clean ? deletedFixes : []
          }
        };

        const insAudit = await db.execute({
          sql: 'INSERT INTO audit_logs (user_email, action, affected_references, details) VALUES (?, ?, ?, ?) RETURNING id, created_at',
          args: [
            user.email,
            'Database Hygiene Audit',
            `TX:${totalTx}|INVALID:${invalidIdTx}`,
            JSON.stringify(auditDetails)
          ]
        });

        return sendJson(res, 200, {
          data: {
            audit_id: Number(insAudit.rows[0]?.id),
            created_at: insAudit.rows[0]?.created_at,
            health_score: healthScore,
            total_transactions: totalTx,
            settled_transactions: settledTx,
            invalid_ids: invalidIdTx,
            unmapped_items: unmappedTx,
            identical_tx_duplicates: identicalDups,
            duplicate_mappings: dupMappingsCount,
            conflicting_case_mappings: conflictingMappings,
            duplicate_fixes: dupFixesCount,
            cleaned_mappings: cleanedMappings,
            cleaned_fixes: cleanedFixes,
            auto_cleaned: clean
          }
        });
      }

      case 'rollback_database_hygiene_audit': {
        requireRole(user, 'admin', 'rollback database hygiene audit');
        const result = await executeHygieneRollback(db, user, Number(args.p_audit_id));
        return sendJson(res, 200, { data: result });
      }

      case 'revert_audit_log_entry': {
        requireRole(user, 'admin', 'revert audit log entry');
        const auditId = Number(args.p_audit_id);
        const logRes = await db.execute({
          sql: 'SELECT id, user_email, action, details FROM audit_logs WHERE id = ? LIMIT 1',
          args: [auditId]
        });
        if (!logRes.rows.length) {
          return sendJson(res, 404, { error: `Audit log entry #${auditId} not found` });
        }

        const auditRow = logRes.rows[0];
        const details = parseDetailsJson(auditRow.details);
        if (details.is_reverted === true) {
          return sendJson(res, 400, { error: `Audit log entry #${auditId} has already been reverted` });
        }

        if (auditRow.action === 'Database Hygiene Audit' && !details.revert_data) {
          const result = await executeHygieneRollback(db, user, auditId);
          return sendJson(res, 200, { data: result });
        }

        const authorEmail = String(auditRow.user_email || '').trim().toLowerCase();
        if (authorEmail && authorEmail !== 'system@nu.edu.eg' && authorEmail !== PRIMARY_ADMIN_EMAIL) {
          const authorRes = await db.execute({
            sql: 'SELECT role FROM user_roles WHERE LOWER(TRIM(email)) = ? LIMIT 1',
            args: [authorEmail]
          });
          const authorRole = authorRes.rows[0]?.role || 'viewer';
          if (roleLevel(authorRole) < roleLevel('accountant')) {
            return sendJson(res, 403, { error: `Security block: cannot execute revert_data authored by non-accountant user (${auditRow.user_email})` });
          }
        }

        const revertData = details.revert_data;
        if (!revertData || !revertData.table_name) {
          return sendJson(res, 200, {
            data: {
              success: false,
              message: 'No point-in-time revert snapshot is attached to this audit log entry.'
            }
          });
        }

        const tbl = String(revertData.table_name || '');
        const op = String(revertData.operation || '');
        let restored = 0;

        const tx = await db.transaction('write');
        try {
          if (tbl === 'item_mappings') {
            if (op === 'delete' || op === 'update') {
              for (const r of (revertData.previous_rows || [])) {
                await tx.execute({ sql: 'DELETE FROM item_mappings WHERE item_name = ?', args: [r.item_name] });
                await tx.execute({
                  sql: 'INSERT INTO item_mappings (item_name, adjusted_item_name, mapping, second_mapping) VALUES (?, ?, ?, ?)',
                  args: [r.item_name ?? null, r.adjusted_item_name ?? null, r.mapping ?? null, r.second_mapping ?? null]
                });
                restored++;
              }
            } else if (op === 'insert') {
              for (const key of (revertData.inserted_keys || [])) {
                await tx.execute({ sql: 'DELETE FROM item_mappings WHERE item_name = ?', args: [key] });
                restored++;
              }
            }
          } else if (tbl === 'manual_fixes') {
            if (op === 'delete' || op === 'update') {
              for (const r of (revertData.previous_rows || [])) {
                await tx.execute({ sql: 'DELETE FROM manual_fixes WHERE reference_number = ?', args: [r.reference_number] });
                await tx.execute({
                  sql: 'INSERT INTO manual_fixes (reference_number, correct_id, item_name, mapping, second_mapping) VALUES (?, ?, ?, ?, ?)',
                  args: [r.reference_number ?? null, r.correct_id ?? null, r.item_name ?? null, r.mapping ?? null, r.second_mapping ?? null]
                });
                restored++;
              }
            } else if (op === 'insert') {
              for (const key of (revertData.inserted_keys || [])) {
                await tx.execute({ sql: 'DELETE FROM manual_fixes WHERE reference_number = ?', args: [key] });
                restored++;
              }
            }
          } else if (tbl === 'transactions_erp') {
            for (const prev of (revertData.previous_rows || [])) {
              const batchVal = prev.erp_batch_number ? String(prev.erp_batch_number) : null;
              const voucherVal = prev.erp_voucher ? String(prev.erp_voucher) : null;
              if (prev.id !== undefined && prev.id !== null) {
                await tx.execute({
                  sql: 'UPDATE transactions SET erp_batch_number = ?, erp_voucher = ? WHERE id = ?',
                  args: [batchVal, voucherVal, Number(prev.id)]
                });
              } else if (prev.reference_number) {
                await tx.execute({
                  sql: 'UPDATE transactions SET erp_batch_number = ?, erp_voucher = ? WHERE reference_number = ?',
                  args: [batchVal, voucherVal, prev.reference_number]
                });
              }
              restored++;
            }
            const batchNum = String(revertData.batch_number || '').trim();
            if (batchNum) {
              const c1 = await tx.execute({
                sql: 'UPDATE transactions SET erp_batch_number = NULL, erp_voucher = NULL WHERE erp_batch_number = ?',
                args: [batchNum]
              });
              const c2 = await tx.execute({
                sql: 'UPDATE foreign_transactions SET erp_batch_number = NULL, erp_voucher = NULL WHERE erp_batch_number = ?',
                args: [batchNum]
              });
              restored += (c1.rowsAffected || 0) + (c2.rowsAffected || 0);
            }
          } else if (tbl === 'foreign_transactions_erp') {
            for (const prev of (revertData.previous_rows || [])) {
              const batchVal = prev.erp_batch_number ? String(prev.erp_batch_number) : null;
              const voucherVal = prev.erp_voucher ? String(prev.erp_voucher) : null;
              await tx.execute({
                sql: 'UPDATE foreign_transactions SET erp_batch_number = ?, erp_voucher = ? WHERE reference_number = ?',
                args: [batchVal, voucherVal, prev.reference_number]
              });
              restored++;
            }
            const batchNum = String(revertData.batch_number || '').trim();
            if (batchNum) {
              const c2 = await tx.execute({
                sql: 'UPDATE foreign_transactions SET erp_batch_number = NULL, erp_voucher = NULL WHERE erp_batch_number = ?',
                args: [batchNum]
              });
              restored += c2.rowsAffected || 0;
            }
          } else {
            await tx.rollback();
            return sendJson(res, 200, {
              data: {
                success: false,
                message: `Unsupported revert table: ${tbl}`
              }
            });
          }

          const updatedDetails = { ...details, is_reverted: true };
          await tx.execute({
            sql: 'UPDATE audit_logs SET details = ? WHERE id = ?',
            args: [JSON.stringify(updatedDetails), auditId]
          });

          await tx.execute({
            sql: 'INSERT INTO audit_logs (user_email, action, affected_references, details) VALUES (?, ?, ?, ?)',
            args: [
              user.email,
              'Audit Action Reverted',
              `Audit #${auditId}`,
              JSON.stringify({
                reverted_audit_id: auditId,
                reverted_action: auditRow.action,
                table_name: tbl,
                operation: op,
                restored_count: restored,
                reverted_at: new Date().toISOString()
              })
            ]
          });
          await tx.commit();
        } catch (err) {
          await tx.rollback();
          throw err;
        }

        return sendJson(res, 200, {
          data: {
            success: true,
            audit_id: auditId,
            restored_count: restored,
            message: `Successfully reverted Audit #${auditId} (${restored} record(s) restored).`
          }
        });
      }

      default:
        return sendJson(res, 400, { error: `Unknown RPC function: ${fn}` });
    }
  } catch (err) {
    return sendJson(res, err.status || 500, { error: err.message || 'RPC execution error' });
  }
}
