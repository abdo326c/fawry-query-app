/**
 * Database Hygiene & Deduplication Scanner
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
 * and logs to GitHub Actions Step Summary + Supabase audit_logs.
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
import {
    getFolderHierarchy,
    getGoogleCredentials,
    getDriveAccessToken,
    getOrCreateDriveFolderRest,
    uploadFileToDriveRest
} from './backup_to_drive.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hjtxdyuevxcezxzbiiqk.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhqdHhkeXVldnhjZXp4emJpaXFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1MjU5MDEsImV4cCI6MjA5NTEwMTkwMX0.ZiKUw1db5pDRYto-hLGut3rdrzxVfRN36ouX4AjB5AQ';

export async function runDatabaseHygiene({ applyFixes = false, uploadToDrive = true } = {}) {
    console.log('='.repeat(70));
    console.log('🔍 FAWRY DATABASE HYGIENE & AUTO-DEDUPLICATION AUDIT');
    console.log(`Mode: ${applyFixes ? 'AUTO-CLEAN (--fix)' : 'INSPECTION (Read-Only)'}`);
    console.log('='.repeat(70));

    const startTime = Date.now();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    // Execute server-side RPC on Supabase
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/run_database_hygiene_audit`, {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ p_clean: applyFixes })
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Hygiene audit RPC failed: ${res.status} ${errText}`);
    }

    const data = await res.json();
    const duration = Date.now() - startTime;

    console.log(`\nScan completed in ${duration}ms across all tables:`);
    console.log('='.repeat(70));
    console.log(`📊 DATABASE HEALTH & HYGIENE REPORT:`);
    console.log(`  • Overall Database Health Score: ${data.health_score}%`);
    console.log(`  • Total Transactions Scanned:   ${(data.total_transactions || 0).toLocaleString()}`);
    console.log(`  • Settled Transactions:         ${(data.settled_transactions || 0).toLocaleString()}`);
    console.log(`  • Identical Duplicate Tx:        ${data.identical_tx_duplicates || 0}`);
    console.log(`  • Duplicate Mapping Rules:       ${data.duplicate_mappings || 0} (Cleaned: ${data.cleaned_mappings || 0})`);
    console.log(`  • Duplicate Manual Fixes:        ${data.duplicate_fixes || 0} (Cleaned: ${data.cleaned_fixes || 0})`);
    console.log(`  • Transactions Missing Mapping:  ${data.unmapped_items || 0}`);
    console.log(`  • Missing / Invalid Student IDs: ${data.invalid_ids || 0}`);
    console.log('='.repeat(70));
    console.log('✓ Audit entry successfully recorded in audit_logs table.');

    // Upload Report to Google Drive if credentials exist
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

                // Purge temp file immediately
                if (fs.existsSync(tempReportPath)) {
                    fs.unlinkSync(tempReportPath);
                }
            }
        } catch (driveErr) {
            console.warn('⚠️  Could not upload hygiene report to Drive:', driveErr.message);
        }
    }

    // GitHub Step Summary (Markdown)
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
| **Identical Duplicate Transactions** | ${data.identical_tx_duplicates || 0} | ${data.identical_tx_duplicates || 0} |
| **Duplicate Mapping Rules** | ${data.duplicate_mappings || 0} | ${data.cleaned_mappings || 0} |
| **Duplicate Manual Fixes** | ${data.duplicate_fixes || 0} | ${data.cleaned_fixes || 0} |
| **Transactions Missing Mapping** | ${data.unmapped_items || 0} | — |
| **Invalid / Unmatched Student IDs** | ${data.invalid_ids || 0} | — |
`;
            fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMd);
        } catch (sumErr) {
            // Ignore step summary error
        }
    }

    return {
        ...data,
        driveReportUrl
    };
}

// Direct CLI execution
if (process.argv[1] && process.argv[1].endsWith('database_hygiene.js')) {
    const shouldFix = process.argv.includes('--fix');
    runDatabaseHygiene({ applyFixes: shouldFix }).catch(console.error);
}
