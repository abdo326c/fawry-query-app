import crypto from 'node:crypto';
import { getDb, readJsonBody, sendJson, sendServerError, withDbRetry, withDbWriteRetry } from './_lib/db.js';
import { clearRoleCache, getAuthUser } from './_lib/auth.js';
import {
  assertPeriodsUnlocked,
  assertTableAccess,
  assertValidColumn,
  classifyProgramStudentLevel,
  hasMinRole,
  resolveStudentLevel,
  resolveStudentLevelsBatch,
  sanitizeAuditLogRow,
  TABLE_BOOLEAN_COLS,
  TABLE_COLUMNS,
  TABLE_DEFAULT_CONFLICT,
  TABLE_JSON_COLS
} from './_lib/rbac.js';

/** Most rows one select returns (also clamps limit/range). Clients page with fetchAll (≤ 4000). */
export const MAX_SELECT_ROWS = 5000;
/** Most rows one insert/upsert request may carry (413 above). */
export const MAX_WRITE_ROWS = 5000;
/** Most values in one "in" filter. */
export const MAX_FILTER_LIST = 5000;

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function serializeValue(table, col, val) {
  if (val === undefined) return null;
  if (val === null) return null;
  const boolCols = TABLE_BOOLEAN_COLS[table];
  if (boolCols && boolCols.has(col)) {
    return val === true || val === 1 || val === 'true' ? 1 : 0;
  }
  const jsonCols = TABLE_JSON_COLS[table];
  if (jsonCols && jsonCols.has(col)) {
    return typeof val === 'string' ? val : JSON.stringify(val);
  }
  return val;
}

function normalizeRow(table, row) {
  if (!row || typeof row !== 'object') return row;
  const boolCols = TABLE_BOOLEAN_COLS[table];
  const jsonCols = TABLE_JSON_COLS[table];
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (boolCols && boolCols.has(k)) {
      out[k] = v === null || v === undefined ? null : Boolean(v);
    } else if (jsonCols && jsonCols.has(k)) {
      if (typeof v === 'string') {
        try {
          out[k] = JSON.parse(v);
        } catch {
          out[k] = v;
        }
      } else {
        out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function parseColumns(table, columnsStr) {
  const str = String(columnsStr || '*').trim();
  if (!str || str === '*') return '*';
  const cols = str
    .split(',')
    .map(c => c.trim())
    .filter(Boolean);
  for (const col of cols) {
    assertValidColumn(table, col);
  }
  return cols.map(quoteIdent).join(', ');
}

/**
 * Splits a PostgREST OR expression by top-level commas (respecting parentheses).
 */
function splitTopLevelCommas(expr) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/** Filter values are bound as SQL parameters: only scalars are meaningful. */
function filterArg(table, col, val) {
  const v = serializeValue(table, col, val);
  if (v !== null && typeof v === 'object') {
    throw badRequest(`Invalid filter value for column "${col}".`);
  }
  return v;
}

/**
 * Accepts an array, or the PostgREST string form "(a,b,"c,d")" that supabase-js sends for
 * .not(col, 'in', '(a,b)'). Anything else is a client error (it used to become an empty list,
 * so NOT IN silently matched every row).
 */
export function parseInList(val) {
  if (Array.isArray(val)) return val;
  const str = typeof val === 'string' ? val.trim() : null;
  if (str === null || !str.startsWith('(') || !str.endsWith(')')) {
    throw badRequest('The "in" filter needs a list of values.');
  }
  const inner = str.slice(1, -1);
  const items = [];
  let current = '';
  let quoted = false;
  let sawQuote = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"') {
      if (!quoted && !sawQuote) current = current.trim(); // drop spaces before the opening quote
      quoted = !quoted;
      sawQuote = true;
    } else if (!quoted && sawQuote && /\s/.test(ch)) {
      // spaces after the closing quote are not part of the value
    } else if (ch === '\\' && quoted && i + 1 < inner.length) {
      current += inner[++i];
    } else if (ch === ',' && !quoted) {
      const item = sawQuote ? current : current.trim();
      if (item !== '' || sawQuote) items.push(item);
      current = '';
      sawQuote = false;
    } else {
      current += ch;
    }
  }
  const last = sawQuote ? current : current.trim();
  if (last !== '' || sawQuote) items.push(last);
  return items;
}

function buildSingleFilter(table, col, op, val, args) {
  assertValidColumn(table, col);
  const qCol = quoteIdent(col);

  switch (op) {
    case 'eq':
      args.push(filterArg(table, col, val));
      return `${qCol} = ?`;
    case 'neq':
      // Postgres semantics: NULL is neither equal nor unequal, so NULL rows do not match (and an
      // update/delete .neq() filter never sweeps up NULL rows by accident).
      args.push(filterArg(table, col, val));
      return `${qCol} != ?`;
    case 'gt':
      args.push(filterArg(table, col, val));
      return `${qCol} > ?`;
    case 'gte':
      args.push(filterArg(table, col, val));
      return `${qCol} >= ?`;
    case 'lt':
      args.push(filterArg(table, col, val));
      return `${qCol} < ?`;
    case 'lte':
      args.push(filterArg(table, col, val));
      return `${qCol} <= ?`;
    case 'like':
      args.push(String(val));
      return `${qCol} LIKE ?`;
    case 'ilike':
      args.push(String(val).toLowerCase());
      return `LOWER(COALESCE(${qCol}, '')) LIKE ?`;
    case 'is':
      if (val === null || val === 'null') return `${qCol} IS NULL`;
      if (val === true || val === 'true') return `${qCol} = 1`;
      if (val === false || val === 'false') return `${qCol} = 0`;
      args.push(filterArg(table, col, val));
      return `${qCol} IS ?`;
    case 'in': {
      const list = parseInList(val);
      if (list.length === 0) return '1 = 0';
      if (list.length > MAX_FILTER_LIST) {
        throw badRequest(`The "in" filter accepts at most ${MAX_FILTER_LIST} values.`);
      }
      const placeholders = list.map(() => '?').join(', ');
      for (const item of list) {
        args.push(filterArg(table, col, item));
      }
      return `${qCol} IN (${placeholders})`;
    }
    case 'not': {
      if (val && typeof val === 'object' && 'op' in val) {
        const innerOp = val.op;
        const innerVal = val.value;
        if (innerOp === 'is' && (innerVal === null || innerVal === 'null')) {
          return `${qCol} IS NOT NULL`;
        }
        const sub = buildSingleFilter(table, col, innerOp, innerVal, args);
        return `NOT (${sub})`;
      }
      const err = new Error('Invalid NOT filter payload.');
      err.status = 400;
      throw err;
    }
    default: {
      const err = new Error(`Unsupported filter operator: ${op}`);
      err.status = 400;
      throw err;
    }
  }
}

function parseOrTerm(table, term, args) {
  const trimmed = String(term || '').trim();
  if (/^and\s*\(/i.test(trimmed) && trimmed.endsWith(')')) {
    const inner = trimmed.slice(trimmed.indexOf('(') + 1, -1);
    return parseLogicalExpr(table, inner, 'AND', args);
  }
  if (/^or\s*\(/i.test(trimmed) && trimmed.endsWith(')')) {
    const inner = trimmed.slice(trimmed.indexOf('(') + 1, -1);
    return parseLogicalExpr(table, inner, 'OR', args);
  }

  // Handle PostgREST syntax: col.op.val or col.not.op.val
  const firstDot = trimmed.indexOf('.');
  if (firstDot <= 0) {
    const err = new Error(`Invalid OR filter term: ${term}`);
    err.status = 400;
    throw err;
  }
  const col = trimmed.slice(0, firstDot).trim();
  let rest = trimmed.slice(firstDot + 1);
  let negate = false;
  if (rest.toLowerCase().startsWith('not.')) {
    negate = true;
    rest = rest.slice(4);
  }

  const secondDot = rest.indexOf('.');
  if (secondDot <= 0) {
    const err = new Error(`Invalid OR filter term: ${term}`);
    err.status = 400;
    throw err;
  }
  const op = rest.slice(0, secondDot).trim().toLowerCase();
  let val = rest.slice(secondDot + 1);

  if (op === 'in') {
    const items = parseInList(val);
    return negate
      ? buildSingleFilter(table, col, 'not', { op: 'in', value: items }, args)
      : buildSingleFilter(table, col, 'in', items, args);
  }
  if (op === 'like' || op === 'ilike') {
    val = val.replace(/\*/g, '%');
  } else if (op === 'is') {
    if (val === 'null') val = null;
    else if (val === 'true') val = true;
    else if (val === 'false') val = false;
  }

  if (negate) {
    return buildSingleFilter(table, col, 'not', { op, value: val }, args);
  }
  return buildSingleFilter(table, col, op, val, args);
}

/**
 * Joins SQL terms with AND/OR as a shallow tree: a flat chain of n terms is n levels deep, and
 * Turso's SQLite rejects expressions deeper than 100. Groups of 32, nested, keep any realistic
 * number of terms far below that.
 */
export function joinShallow(parts, joiner) {
  const GROUP = 32;
  if (parts.length <= GROUP) return `(${parts.join(` ${joiner} `)})`;
  const groups = [];
  for (let i = 0; i < parts.length; i += GROUP) groups.push(`(${parts.slice(i, i + GROUP).join(` ${joiner} `)})`);
  return joinShallow(groups, joiner);
}

function parseLogicalExpr(table, expr, joiner, args) {
  const terms = splitTopLevelCommas(String(expr || ''));
  if (terms.length === 0) return '1 = 1';
  const parts = terms.map(t => parseOrTerm(table, t, args));
  return joinShallow(parts, joiner);
}

function buildWhereClause(table, filters = [], extraClauses = []) {
  const clauses = [...extraClauses];
  const args = [];

  for (const f of filters) {
    if (!f || !f.op) continue;
    if (f.op === 'or') {
      const terms = splitTopLevelCommas(String(f.value || ''));
      if (terms.length > 0) {
        clauses.push(parseLogicalExpr(table, f.value, 'OR', args));
      }
      continue;
    }
    if (f.op === 'not') {
      clauses.push(buildSingleFilter(table, f.column, 'not', { op: f.innerOp, value: f.value }, args));
      continue;
    }
    clauses.push(buildSingleFilter(table, f.column, f.op, f.value, args));
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    args
  };
}

function buildOrderClause(table, orders = []) {
  if (!Array.isArray(orders) || orders.length === 0) return '';
  const parts = [];
  for (const o of orders) {
    if (!o || !o.column) continue;
    assertValidColumn(table, o.column);
    const dir = o.ascending === false ? 'DESC' : 'ASC';
    parts.push(`${quoteIdent(o.column)} ${dir}`);
  }
  return parts.length > 0 ? `ORDER BY ${parts.join(', ')}` : '';
}

async function checkPeriodLockForRows(db, table, rows) {
  if (table === 'transactions') {
    await assertPeriodsUnlocked(db, rows.map(r => r.payment_date));
  } else if (table === 'foreign_transactions') {
    await assertPeriodsUnlocked(db, rows.map(r => r.value_date || r.transaction_date));
  } else if (table === 'manual_fixes') {
    const refs = [...new Set(rows.map(r => r.reference_number).filter(Boolean))];
    if (refs.length > 0) {
      const ph = refs.map(() => '?').join(', ');
      const txRes = await db.execute({
        sql: `SELECT DISTINCT payment_date FROM transactions WHERE reference_number IN (${ph})`,
        args: refs
      });
      await assertPeriodsUnlocked(db, txRes.rows.map(r => r.payment_date));
    }
  }
}

// Student-level propagation skips rows in closed accounting periods (as the Postgres version
// did), so it neither rewrites closed-month UG/PG splits nor trips the period-lock trigger.
const OPEN_PERIOD_TX = 'substr(payment_date, 1, 7) NOT IN (SELECT period_month FROM closed_periods WHERE is_closed = 1)';
const OPEN_PERIOD_FTX = 'substr(COALESCE(value_date, transaction_date), 1, 7) NOT IN (SELECT period_month FROM closed_periods WHERE is_closed = 1)';
const PROPAGATE_TX_LEVEL_SQL = `UPDATE transactions SET student_level = ? WHERE student_id = ? AND student_level IS NOT ? AND (payment_date IS NULL OR ${OPEN_PERIOD_TX})`;
const PROPAGATE_FTX_LEVEL_SQL = `UPDATE foreign_transactions SET student_level = ? WHERE student_id = ? AND student_level IS NOT ? AND (COALESCE(value_date, transaction_date) IS NULL OR ${OPEN_PERIOD_FTX})`;

/**
 * An upsert can overwrite an EXISTING row, so the stored row's period must be open too
 * (checkPeriodLockForRows only sees the incoming values).
 */
async function checkPeriodLockForConflictTargets(db, table, conflictCols, rows) {
  const dateExpr = table === 'transactions'
    ? 'payment_date'
    : table === 'foreign_transactions' ? 'COALESCE(value_date, transaction_date)' : null;
  if (!dateExpr || conflictCols.length === 0) return;
  const keyed = rows.filter(r => conflictCols.every(c => r[c] !== undefined));
  // Join against a VALUES list instead of "(a IS ? AND ...) OR (...) OR ..." : a long OR chain is a
  // deep expression tree, and Turso's SQLite rejects depth > 100 ("Expression tree is too large"),
  // which failed every import that overwrote 100 existing rows. A VALUES join has constant depth.
  // (Bound parameters per statement stay well under SQLite's limit: 200 rows x 3 keys.)
  const CHUNK = 200;
  const on = conflictCols.map((c, i) => `t.${quoteIdent(c)} IS v.column${i + 1}`).join(' AND ');
  for (let i = 0; i < keyed.length; i += CHUNK) {
    const slice = keyed.slice(i, i + CHUNK);
    const args = [];
    const tuples = slice.map(r => {
      for (const c of conflictCols) args.push(serializeValue(table, c, r[c]));
      return `(${conflictCols.map(() => '?').join(', ')})`;
    });
    const tDateExpr = dateExpr.replace(/\b(payment_date|value_date|transaction_date)\b/g, 't.$1');
    const res = await withDbRetry(() => db.execute({
      sql: `SELECT DISTINCT ${tDateExpr} AS d FROM ${quoteIdent(table)} t JOIN (VALUES ${tuples.join(', ')}) v ON ${on}`,
      args
    }));
    await assertPeriodsUnlocked(db, res.rows.map(r => r.d));
  }
}

/** Errors raised by the database guard triggers are permission errors, not server errors. */
export function statusForDbError(err) {
  if (err?.status) return err.status;
  const msg = String(err?.message || '');
  if (/Accounting period is closed|cannot be (deleted|changed)/i.test(msg)) return 403;
  return 500;
}

async function checkPeriodLockForFilter(db, table, whereSql, args) {
  if (table === 'transactions') {
    const res = await db.execute({ sql: `SELECT DISTINCT payment_date FROM transactions ${whereSql}`, args });
    await assertPeriodsUnlocked(db, res.rows.map(r => r.payment_date));
  } else if (table === 'foreign_transactions') {
    const res = await db.execute({ sql: `SELECT DISTINCT COALESCE(value_date, transaction_date) AS d FROM foreign_transactions ${whereSql}`, args });
    await assertPeriodsUnlocked(db, res.rows.map(r => r.d));
  } else if (table === 'manual_fixes') {
    // Sub-select so the filter columns refer to manual_fixes only (a JOIN made "reference_number",
    // "id", "item_name", "mapping" ambiguous and every update/delete failed with a 500).
    const sub = `SELECT reference_number FROM manual_fixes ${whereSql}`;
    const res = await db.batch([
      { sql: `SELECT DISTINCT payment_date AS d FROM transactions WHERE reference_number IN (${sub})`, args },
      { sql: `SELECT DISTINCT COALESCE(value_date, transaction_date) AS d FROM foreign_transactions WHERE reference_number IN (${sub})`, args }
    ], 'read');
    await assertPeriodsUnlocked(db, [...res[0].rows, ...res[1].rows].map(r => r.d));
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const db = getDb();
    const user = await getAuthUser(req, db);
    const body = await readJsonBody(req);

    const table = String(body.table || '').trim();
    const operation = String(body.operation || 'select').trim().toLowerCase();

    assertTableAccess(user, table, operation);

    if (operation === 'select') {
      const extraClauses = [];
      const extraArgs = [];
      // Viewers/operators (and deactivated users) only see their own role row; the staff list
      // (emails + roles) is for accountant+ (the Users & Roles screen is admin-only anyway).
      if (table === 'user_roles' && !hasMinRole(user.role, 'accountant')) {
        extraClauses.push('LOWER(TRIM("email")) = ?');
        extraArgs.push(user.email);
      }

      const { whereSql, args } = buildWhereClause(table, body.filters, extraClauses);
      const allArgs = [...extraArgs, ...args];
      const orderSql = buildOrderClause(table, body.orders);
      const countSql = `SELECT COUNT(*) AS cnt FROM ${quoteIdent(table)} ${whereSql}`;

      if (body.head === true) {
        let totalCount = null;
        if (body.count === 'exact') {
          const countRes = await withDbRetry(() => db.execute({ sql: countSql, args: allArgs }));
          totalCount = Number(countRes.rows[0]?.cnt || 0);
        }
        return sendJson(res, 200, { data: null, count: totalCount });
      }

      const selectCols = parseColumns(table, body.columns);
      // Every select is bounded: no limit/range means MAX_SELECT_ROWS, and larger ones are clamped
      // (an unbounded "select *" of transactions could exhaust the function's memory).
      let limitSql = `LIMIT ${MAX_SELECT_ROWS}`;
      if (body.range && Number.isInteger(body.range.from) && Number.isInteger(body.range.to)) {
        const offset = Math.max(0, body.range.from);
        const limit = Math.min(MAX_SELECT_ROWS, Math.max(0, body.range.to - offset + 1));
        limitSql = `LIMIT ${limit} OFFSET ${offset}`;
      } else if (Number.isInteger(body.limit) && body.limit >= 0) {
        limitSql = `LIMIT ${Math.min(MAX_SELECT_ROWS, body.limit)}`;
      }

      const selectSql = `SELECT ${selectCols} FROM ${quoteIdent(table)} ${whereSql} ${orderSql} ${limitSql}`;
      let totalCount = null;
      let result;

      if (body.count === 'exact') {
        const [countRes, selectRes] = await withDbRetry(() => db.batch([
          { sql: countSql, args: allArgs },
          { sql: selectSql, args: allArgs }
        ], 'read'));
        totalCount = Number(countRes.rows[0]?.cnt || 0);
        result = selectRes;
      } else {
        result = await withDbRetry(() => db.execute({ sql: selectSql, args: allArgs }));
      }
      const rows = result.rows.map(r => normalizeRow(table, r));

      if (body.single) {
        if (rows.length !== 1) {
          return sendJson(res, 406, {
            error: rows.length === 0 ? 'JSON object requested, multiple (or no) rows returned' : 'Multiple rows returned for single()'
          });
        }
        return sendJson(res, 200, { data: rows[0], count: totalCount });
      }
      if (body.maybeSingle) {
        if (rows.length > 1) {
          return sendJson(res, 406, { error: 'Multiple rows returned for maybeSingle()' });
        }
        return sendJson(res, 200, { data: rows[0] || null, count: totalCount });
      }

      return sendJson(res, 200, { data: rows, count: totalCount });
    }

    if (operation === 'insert' || operation === 'upsert') {
      const rawRows = Array.isArray(body.values) ? body.values : [body.values];
      if (rawRows.length > MAX_WRITE_ROWS) {
        return sendJson(res, 413, { error: `Too many rows in one request (max ${MAX_WRITE_ROWS}). Send them in smaller chunks.` });
      }
      const rows = rawRows.filter(Boolean);
      if (rows.length === 0) {
        return sendJson(res, 200, { data: [] });
      }

      let levelMap = null;
      if (table === 'transactions' || table === 'foreign_transactions') {
        const missingIds = rows
          .filter(r => r && r.student_id && !r.student_level)
          .map(r => r.student_id);
        if (missingIds.length > 0) {
          levelMap = await resolveStudentLevelsBatch(db, missingIds);
        }
      }

      const processedRows = [];
      for (const raw of rows) {
        let row = { ...raw };
        if (table === 'audit_logs') {
          row = sanitizeAuditLogRow(user, row);
        }
        if ((table === 'import_batches' || table === 'payment_links') && !row.id) {
          row.id = crypto.randomUUID();
        }
        if ((table === 'transactions' || table === 'foreign_transactions') && row.student_id && !row.student_level) {
          const sid = String(row.student_id).trim();
          row.student_level = levelMap ? (levelMap.get(sid) ?? null) : null;
        }
        if (table === 'student_master') {
          row.updated_at = new Date().toISOString();
        }
        processedRows.push(row);
      }

      await checkPeriodLockForRows(db, table, processedRows);

      const allowedCols = TABLE_COLUMNS[table];
      const insertedRows = [];
      const onConflictCols = body.onConflict
        ? String(body.onConflict).split(',').map(c => c.trim()).filter(Boolean)
        : (operation === 'upsert' ? (TABLE_DEFAULT_CONFLICT[table] || []) : []);
      for (const c of onConflictCols) {
        assertValidColumn(table, c);
      }
      if (operation === 'upsert' && !body.ignoreDuplicates) {
        await checkPeriodLockForConflictTargets(db, table, onConflictCols, processedRows);
      }

      const writeStmts = [];
      const returningClause = body.returning ? `RETURNING ${parseColumns(table, body.returning)}` : '';

      for (const row of processedRows) {
        const cols = Object.keys(row).filter(c => allowedCols.has(c) && row[c] !== undefined);
        if (cols.length === 0) continue;

        const colList = cols.map(quoteIdent).join(', ');
        const placeholders = cols.map(() => '?').join(', ');
        const args = cols.map(c => serializeValue(table, c, row[c]));

        let conflictClause = '';
        if (operation === 'upsert' && onConflictCols.length > 0) {
          const conflictTarget = onConflictCols.map(quoteIdent).join(', ');
          if (body.ignoreDuplicates) {
            conflictClause = `ON CONFLICT(${conflictTarget}) DO NOTHING`;
          } else {
            const updateCols = cols.filter(c => !onConflictCols.includes(c));
            if (updateCols.length > 0) {
              const updates = updateCols.map(c => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`).join(', ');
              conflictClause = `ON CONFLICT(${conflictTarget}) DO UPDATE SET ${updates}`;
            } else {
              conflictClause = `ON CONFLICT(${conflictTarget}) DO NOTHING`;
            }
          }
        }

        const sql = `INSERT INTO ${quoteIdent(table)} (${colList}) VALUES (${placeholders}) ${conflictClause} ${returningClause}`;
        writeStmts.push({ stmt: { sql, args }, collectReturn: Boolean(body.returning) });
      }

      if (table === 'student_master') {
        for (const row of processedRows) {
          if (!row.student_id) continue;
          const sid = String(row.student_id).trim();
          let lvl = classifyProgramStudentLevel(row.program);
          if (!lvl) {
            if (/^9\d{6}$/.test(sid)) lvl = 'PG';
            else if (/^\d{9}$/.test(sid)) lvl = 'UG';
          }
          writeStmts.push({ stmt: { sql: PROPAGATE_TX_LEVEL_SQL, args: [lvl, sid, lvl] }, collectReturn: false });
          writeStmts.push({ stmt: { sql: PROPAGATE_FTX_LEVEL_SQL, args: [lvl, sid, lvl] }, collectReturn: false });
        }
      }

      // One batch = one transaction: the whole request is saved, or nothing is. (It used to be
      // split into 200-statement batches, so a failure could leave an import half-written
      // while the UI reported the whole chunk as failed.)
      if (writeStmts.length > 0) {
        const results = await withDbWriteRetry(() => db.batch(writeStmts.map(item => item.stmt), 'write'));
        for (let j = 0; j < writeStmts.length; j++) {
          if (writeStmts[j].collectReturn && results[j]?.rows?.length > 0) {
            insertedRows.push(...results[j].rows.map(r => normalizeRow(table, r)));
          }
        }
      }

      if (table === 'user_roles') {
        clearRoleCache();
      }

      if (body.single) {
        return sendJson(res, 200, { data: insertedRows[0] || null });
      }
      return sendJson(res, 200, { data: body.returning ? insertedRows : null });
    }

    if (operation === 'update') {
      const updates = body.values && typeof body.values === 'object' ? { ...body.values } : {};
      const allowedCols = TABLE_COLUMNS[table];
      const setCols = Object.keys(updates).filter(c => allowedCols.has(c) && updates[c] !== undefined);
      if (setCols.length === 0) {
        return sendJson(res, 400, { error: 'No valid columns provided for update.' });
      }

      if ((table === 'transactions' || table === 'foreign_transactions') && updates.student_id !== undefined && updates.student_level === undefined) {
        updates.student_level = await resolveStudentLevel(db, updates.student_id);
        if (!setCols.includes('student_level')) setCols.push('student_level');
      }
      if (table === 'student_master' && !setCols.includes('updated_at')) {
        updates.updated_at = new Date().toISOString();
        setCols.push('updated_at');
      }

      const { whereSql, args: whereArgs } = buildWhereClause(table, body.filters);
      if (!whereSql) {
        return sendJson(res, 400, { error: 'UPDATE requires at least one filter.' });
      }

      await checkPeriodLockForFilter(db, table, whereSql, whereArgs);
      if (table === 'transactions' && updates.payment_date) {
        await assertPeriodsUnlocked(db, [updates.payment_date]);
      } else if (table === 'foreign_transactions' && (updates.value_date || updates.transaction_date)) {
        await assertPeriodsUnlocked(db, [updates.value_date || updates.transaction_date]);
      }

      const setSql = setCols.map(c => `${quoteIdent(c)} = ?`).join(', ');
      const setArgs = setCols.map(c => serializeValue(table, c, updates[c]));
      const returningClause = body.returning ? `RETURNING ${parseColumns(table, body.returning)}` : '';

      const sql = `UPDATE ${quoteIdent(table)} SET ${setSql} ${whereSql} ${returningClause}`;
      const result = await withDbWriteRetry(() => db.execute({ sql, args: [...setArgs, ...whereArgs] }));
      const rows = result.rows ? result.rows.map(r => normalizeRow(table, r)) : [];

      if (table === 'user_roles') {
        clearRoleCache();
      }

      if (table === 'student_master' && updates.program !== undefined) {
        const affected = await withDbRetry(() => db.execute({
          sql: `SELECT student_id, program FROM student_master ${whereSql}`,
          args: whereArgs
        }));
        const propStmts = [];
        for (const st of affected.rows) {
          const sid = String(st.student_id || '').trim();
          if (!sid) continue;
          let lvl = classifyProgramStudentLevel(st.program);
          if (!lvl) {
            if (/^9\d{6}$/.test(sid)) lvl = 'PG';
            else if (/^\d{9}$/.test(sid)) lvl = 'UG';
          }
          propStmts.push({ sql: PROPAGATE_TX_LEVEL_SQL, args: [lvl, sid, lvl] });
          propStmts.push({ sql: PROPAGATE_FTX_LEVEL_SQL, args: [lvl, sid, lvl] });
        }
        for (let i = 0; i < propStmts.length; i += 200) {
          const slice = propStmts.slice(i, i + 200);
          await withDbWriteRetry(() => db.batch(slice, 'write'));
        }
      }

      if (body.single) {
        return sendJson(res, 200, { data: rows[0] || null });
      }
      return sendJson(res, 200, { data: body.returning ? rows : null });
    }

    if (operation === 'delete') {
      const { whereSql, args: whereArgs } = buildWhereClause(table, body.filters);
      if (!whereSql) {
        return sendJson(res, 400, { error: 'DELETE requires at least one filter.' });
      }

      await checkPeriodLockForFilter(db, table, whereSql, whereArgs);

      const returningClause = body.returning ? `RETURNING ${parseColumns(table, body.returning)}` : '';
      const sql = `DELETE FROM ${quoteIdent(table)} ${whereSql} ${returningClause}`;
      const result = await withDbWriteRetry(() => db.execute({ sql, args: whereArgs }));
      const rows = result.rows ? result.rows.map(r => normalizeRow(table, r)) : [];

      if (table === 'user_roles') {
        clearRoleCache();
      }

      return sendJson(res, 200, { data: body.returning ? rows : null });
    }

    return sendJson(res, 400, { error: `Unsupported operation: ${operation}` });
  } catch (err) {
    const status = statusForDbError(err);
    if (status >= 500) {
      // Raw driver/SQL errors can reveal schema and query text: log them, return a generic message.
      return sendServerError(res, err, 'api/query');
    }
    return sendJson(res, status, { error: err.message || 'Database query error' });
  }
}
