/**
 * Database Hygiene & Deduplication Scanner (Turso / libSQL)
 * Compatible with Local Environments and GitHub Actions Cloud Cron
 *
 * Inspects and cleans:
 * 1. Duplicate item mapping rules (case/space variations).
 * 2. Duplicate manual fix entries.
 * 3. Identical transaction duplicates.
 * 4. Unmapped transactions.
 * 5. Invalid / Missing student IDs.
 *
 * Uploads audit report to Google Drive (Fawry Payments Backup > Year > Month > Week)
 * and logs to GitHub Actions Step Summary + Turso audit_logs.
 *
 * Usage:
 *   node scripts/database_hygiene.js        (Inspection mode)
 *   node scripts/database_hygiene.js --fix  (Inspection + Auto-clean duplicates)
 *   npm run hygiene
 *   npm run hygiene:fix
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createClient } from '@libsql/client';
import { withDbRetry } from '../api/_lib/db.js';
import {
    getFolderHierarchy,
    getGoogleCredentials,
    getDriveAccessToken,
    getOrCreateDriveFolderRest,
    uploadFileToDriveRest
} from './backup_to_drive.js';

function getTursoClient() {
    const url = process.env.TURSO_DATABASE_URL || '';
    if (!url) {
        throw new Error('TURSO_DATABASE_URL is not set. Add it as a repository secret (Settings -> Secrets -> Actions).');
    }
    return createClient({
        url,
        authToken: process.env.TURSO_AUTH_TOKEN || undefined
    });
}

export async function runDatabaseHygiene({ applyFixes = false, uploadToDrive = true } = {}) {
    const db = getTursoClient();

    console.log('='.repeat(70));
    console.log('🔍 FAWRY DATABASE HYGIENE & AUTO-DEDUPLICATION AUDIT');
    console.log(`Mode: ${applyFixes ? 'AUTO-CLEAN (--fix)' : 'INSPECTION (Read-Only)'}`);
    console.log('='.repeat(70));

    const startTime = Date.now();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const [totRes, setRes, unmRes, invRes, idupRes, mapsRes, fixesRes] = await withDbRetry(() => db.batch([
        { sql: 'SELECT COUNT(*) AS cnt FROM transactions', args: [] },
        { sql: 'SELECT COUNT(*) AS cnt FROM transactions WHERE is_settled = 1', args: [] },
        { sql: "SELECT COUNT(*) AS cnt FROM transactions WHERE mapping IS NULL OR mapping = '' OR mapping = 'Unmapped'", args: [] },
        { sql: "SELECT COUNT(*) AS cnt FROM transactions WHERE id_status IS NOT NULL AND id_status != 'Valid'", args: [] },
        {
            sql: `SELECT COALESCE(SUM(c - 1), 0) AS cnt FROM (
                    SELECT COUNT(*) AS c FROM transactions
                    GROUP BY reference_number, item_name, item_price, payment_date
                    HAVING COUNT(*) > 1
                  )`,
            args: []
        },
        { sql: 'SELECT id, item_name, adjusted_item_name, mapping, second_mapping FROM item_mappings ORDER BY id ASC', args: [] },
        { sql: 'SELECT id, reference_number, correct_id, item_name, mapping, second_mapping FROM manual_fixes ORDER BY id ASC', args: [] }
    ], 'read'));

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

    if (applyFixes && (dupMappingIds.length > 0 || dupFixIds.length > 0)) {
        const delStmts = [];
        let mapIdx = -1;
        let fixIdx = -1;
        if (dupMappingIds.length > 0) {
            const ph = dupMappingIds.map(() => '?').join(', ');
            mapIdx = delStmts.length;
            delStmts.push({ sql: `DELETE FROM item_mappings WHERE id IN (${ph})`, args: dupMappingIds });
        }
        if (dupFixIds.length > 0) {
            const ph = dupFixIds.map(() => '?').join(', ');
            fixIdx = delStmts.length;
            delStmts.push({ sql: `DELETE FROM manual_fixes WHERE id IN (${ph})`, args: dupFixIds });
        }
        const delRes = await withDbRetry(() => db.batch(delStmts, 'write'));
        if (mapIdx >= 0) cleanedMappings = delRes[mapIdx]?.rowsAffected || 0;
        if (fixIdx >= 0) cleanedFixes = delRes[fixIdx]?.rowsAffected || 0;
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
        auto_cleaned: applyFixes,
        is_reverted: false,
        revert_snapshot: {
            deleted_mappings: applyFixes ? deletedMappings : [],
            deleted_fixes: applyFixes ? deletedFixes : []
        }
    };

    const insAudit = await withDbRetry(() => db.execute({
        sql: 'INSERT INTO audit_logs (user_email, action, affected_references, details) VALUES (?, ?, ?, ?) RETURNING id',
        args: [
            'system@nu.edu.eg',
            'Database Hygiene Audit',
            `TX:${totalTx}|INVALID:${invalidIdTx}`,
            JSON.stringify(auditDetails)
        ]
    }));

    const data = {
        audit_id: Number(insAudit.rows[0]?.id),
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
        auto_cleaned: applyFixes
    };
    const duration = Date.now() - startTime;

    console.log(`\nScan completed in ${duration}ms across all tables:`);
    console.log('='.repeat(70));
    console.log(`📊 DATABASE HEALTH & HYGIENE REPORT:`);
    console.log(`  • Overall Database Health Score: ${data.health_score}%`);
    console.log(`  • Total Transactions Scanned:   ${(data.total_transactions || 0).toLocaleString()}`);
    console.log(`  • Settled Transactions:         ${(data.settled_transactions || 0).toLocaleString()}`);
    console.log(`  • Identical Duplicate Tx:        ${data.identical_tx_duplicates || 0}`);
    console.log(`  • Duplicate Mapping Rules:       ${data.duplicate_mappings || 0} (Cleaned: ${data.cleaned_mappings || 0})`);
    console.log(`  • Conflicting Case Mappings:     ${data.conflicting_case_mappings || 0} (Manual review)`);
    console.log(`  • Duplicate Manual Fixes:        ${data.duplicate_fixes || 0} (Cleaned: ${data.cleaned_fixes || 0})`);
    console.log(`  • Transactions Missing Mapping:  ${data.unmapped_items || 0}`);
    console.log(`  • Missing / Invalid Student IDs: ${data.invalid_ids || 0}`);
    console.log('='.repeat(70));
    console.log('✓ Audit entry successfully recorded in audit_logs table.');

    let driveReportUrl = null;
    if (uploadToDrive) {
        try {
            const creds = getGoogleCredentials();
            if (creds && creds.refreshToken) {
                const driveAccessToken = await getDriveAccessToken(creds);
                const hierarchy = getFolderHierarchy(now);

                const rootFolder = await getOrCreateDriveFolderRest(driveAccessToken, 'Fawry Payments Backup');
                const yearFolder = await getOrCreateDriveFolderRest(driveAccessToken, hierarchy.year, rootFolder.id);
                const monthFolder = await getOrCreateDriveFolderRest(driveAccessToken, hierarchy.month, yearFolder.id);
                const weekFolder = await getOrCreateDriveFolderRest(driveAccessToken, hierarchy.week, monthFolder.id);

                const reportContent = {
                    audit_timestamp: now.toISOString(),
                    mode: applyFixes ? 'AUTO_CLEAN' : 'INSPECTION',
                    duration_ms: duration,
                    database_health_score: `${data.health_score}%`,
                    metrics: data
                };

                const tempReportPath = path.join(os.tmpdir(), `hygiene_report_${timestamp}.json`);
                fs.writeFileSync(tempReportPath, JSON.stringify(reportContent, null, 2), 'utf-8');

                const uploadRes = await uploadFileToDriveRest(
                    driveAccessToken,
                    tempReportPath,
                    `hygiene_report_${timestamp}.json`,
                    'application/json',
                    weekFolder.id
                );

                driveReportUrl = uploadRes.webViewLink;
                console.log(`  ✓ Hygiene report uploaded to Google Drive: ${hierarchy.year} > ${hierarchy.month} > ${hierarchy.week}`);
                console.log(`    File URL: ${uploadRes.webViewLink}`);

                if (driveReportUrl && data?.audit_id) {
                    try {
                        const updatedDetails = { ...auditDetails, drive_folder_url: driveReportUrl };
                        await withDbRetry(() => db.execute({
                            sql: 'UPDATE audit_logs SET details = ? WHERE id = ?',
                            args: [JSON.stringify(updatedDetails), data.audit_id]
                        }));
                    } catch (patchErr) {
                        console.warn('⚠️  Could not attach Drive URL to audit_logs:', patchErr.message);
                    }
                }

                if (fs.existsSync(tempReportPath)) {
                    fs.unlinkSync(tempReportPath);
                }
            }
        } catch (driveErr) {
            console.warn('⚠️  Could not upload hygiene report to Drive:', driveErr.message);
        }
    }

    if (process.env.GITHUB_STEP_SUMMARY) {
        try {
            const statusIcon = data.health_score >= 98 ? '🟢' : data.health_score >= 90 ? '🟡' : '🔴';
            const summaryMd = `
### ${statusIcon} Database Hygiene & Auto-Deduplication Report

- **Health Score**: **${data.health_score}%**
- **Mode**: \`${applyFixes ? 'AUTO-CLEAN (--fix)' : 'INSPECTION (Read-Only)'}\`
- **Execution Time**: ${duration}ms
${driveReportUrl ? `- **Drive Report**: [Open in Google Drive](${driveReportUrl})` : ''}

| Metric | Scanned / Found | Cleaned / Fixed |
| :--- | :--- | :--- |
| **Total Transactions** | ${(data.total_transactions || 0).toLocaleString()} | — |
| **Settled Transactions** | ${(data.settled_transactions || 0).toLocaleString()} | — |
| **Identical Duplicate Transactions** | ${data.identical_tx_duplicates || 0} | — |
| **Duplicate Mapping Rules** | ${data.duplicate_mappings || 0} | ${data.cleaned_mappings || 0} |
| **Conflicting Case Mappings** | ${data.conflicting_case_mappings || 0} | Manual review |
| **Duplicate Manual Fixes** | ${data.duplicate_fixes || 0} | ${data.cleaned_fixes || 0} |
| **Transactions Missing Mapping** | ${data.unmapped_items || 0} | — |
| **Invalid / Unmatched Student IDs** | ${data.invalid_ids || 0} | — |
`;
            fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMd);
        } catch (_sumErr) {
            // Ignore step summary error
        }
    }

    return {
        ...data,
        driveReportUrl
    };
}

if (process.argv[1] && process.argv[1].endsWith('database_hygiene.js')) {
    const shouldFix = process.argv.includes('--fix');
    runDatabaseHygiene({ applyFixes: shouldFix }).catch(err => {
        console.error('❌ Hygiene audit failed:', err);
        process.exit(1);
    });
}
