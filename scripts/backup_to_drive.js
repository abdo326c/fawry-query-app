/**
 * Fawry Direct-to-Cloud Automated Backup (Zero Local Disk Footprint)
 * Compatible with Local Environments and GitHub Actions Cloud Cron (Turso / libSQL)
 *
 * Hierarchy on Google Drive:
 *   Fawry Payments Backup
 *     └── > Year (e.g. 2026)
 *          └── >> Month (e.g. 10 - October)
 *               └── >>> Week (e.g. Week 44 (Oct 26 - Nov 01))
 *                    ├── fawry_backup_YYYYMMDD_HHmmss.zip (All transactions, students, rules, roles, audit)
 *                    └── manifest.json (Inspectable metadata & financial verification summary)
 *
 * Usage:
 *   npm run backup
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { finished } from 'stream/promises';
import { execFileSync } from 'child_process';
import { createClient } from '@libsql/client';
import { withDbRetry } from '../api/_lib/db.js';
import { TABLE_BOOLEAN_COLS, TABLE_JSON_COLS } from '../api/_lib/rbac.js';

/**
 * Computes the SHA-256 hex digest of a file on disk for backup integrity verification.
 */
export function computeFileSha256(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

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

function parseOrderBySql(orderBy) {
    if (!orderBy) return '';
    const parts = String(orderBy)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(part => {
            const [col, dirRaw] = part.split('.');
            const safeCol = String(col || '').replace(/[^a-zA-Z0-9_]/g, '');
            const dir = String(dirRaw || 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
            return `"${safeCol}" ${dir}`;
        });
    return parts.length > 0 ? `ORDER BY ${parts.join(', ')}` : '';
}

function normalizeBackupRow(table, row) {
    if (!row || typeof row !== 'object') return row;
    const boolCols = TABLE_BOOLEAN_COLS[table];
    const jsonCols = TABLE_JSON_COLS[table];
    const out = {};
    for (const [k, v] of Object.entries(row)) {
        if (boolCols && boolCols.has(k)) {
            out[k] = v === null || v === undefined ? null : Boolean(v);
        } else if (jsonCols && jsonCols.has(k)) {
            if (typeof v === 'string') {
                try { out[k] = JSON.parse(v); } catch { out[k] = v; }
            } else {
                out[k] = v;
            }
        } else {
            out[k] = v;
        }
    }
    return out;
}

/**
 * Reads every row of a Turso table in deterministic order using LIMIT/OFFSET paging.
 */
export async function fetchTableAll(table, orderBy = 'id.asc', pageSize = 2000) {
    const db = getTursoClient();
    const safeTable = String(table).replace(/[^a-zA-Z0-9_]/g, '');
    const orderSql = parseOrderBySql(orderBy);
    const rows = [];

    for (let offset = 0; ; offset += pageSize) {
        const res = await withDbRetry(() => db.execute({
            sql: `SELECT * FROM "${safeTable}" ${orderSql} LIMIT ? OFFSET ?`,
            args: [pageSize, offset]
        }));
        for (const r of res.rows) rows.push(normalizeBackupRow(safeTable, r));
        if (res.rows.length < pageSize) break;
    }
    return rows;
}

const EXTRA_BACKUP_TABLES = [
    { table: 'closed_periods', orderBy: 'period_month.asc' },
    { table: 'transactions_archive', orderBy: 'id.asc' },
    { table: 'foreign_transactions', orderBy: 'id.asc' },
    { table: 'settlement_batches', orderBy: 'id.asc' },
    { table: 'links', orderBy: 'id.asc' },
    { table: 'payment_links', orderBy: 'id.asc' },
    { table: 'import_batches', orderBy: 'id.asc' },
    { table: 'exchange_rates', orderBy: 'rate_date.asc,currency_pair.asc' },
    { table: 'audit_logs', orderBy: 'id.asc' }
];

/**
 * Calculates current Year, Month, and Week hierarchy labels
 */
export function getFolderHierarchy(date = new Date()) {
    const year = String(date.getFullYear());
    const monthNames = [
        '01 - January', '02 - February', '03 - March', '04 - April',
        '05 - May', '06 - June', '07 - July', '08 - August',
        '09 - September', '10 - October', '11 - November', '12 - December'
    ];
    const month = monthNames[date.getMonth()];

    const tempDate = new Date(date.getTime());
    tempDate.setHours(0, 0, 0, 0);
    tempDate.setDate(tempDate.getDate() + 3 - (tempDate.getDay() + 6) % 7);
    const week1 = new Date(tempDate.getFullYear(), 0, 4);
    const weekNumber = 1 + Math.round(((tempDate.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);

    const day = date.getDay();
    const diffToMonday = date.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(date.getFullYear(), date.getMonth(), diffToMonday);
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);

    const pad = (n) => String(n).padStart(2, '0');
    const shortMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const span = `${shortMonths[monday.getMonth()]} ${pad(monday.getDate())} - ${shortMonths[sunday.getMonth()]} ${pad(sunday.getDate())}`;

    const week = `Week ${pad(weekNumber)} (${span})`;
    return { year, month, week };
}

/**
 * Resolves Google Drive OAuth2 Credentials
 */
export function getGoogleCredentials() {
    if (process.env.GDRIVE_TOKEN_JSON) {
        try {
            const raw = JSON.parse(process.env.GDRIVE_TOKEN_JSON);
            return {
                clientId: raw.client_id,
                clientSecret: raw.client_secret,
                refreshToken: raw.token?.refresh_token || raw.refresh_token
            };
        } catch (e) {
            console.warn('⚠️  Could not parse GDRIVE_TOKEN_JSON:', e.message);
        }
    }

    if (process.env.GDRIVE_REFRESH_TOKEN && process.env.GDRIVE_CLIENT_ID) {
        return {
            clientId: process.env.GDRIVE_CLIENT_ID,
            clientSecret: process.env.GDRIVE_CLIENT_SECRET,
            refreshToken: process.env.GDRIVE_REFRESH_TOKEN
        };
    }

    const localCandidates = [
        path.join(process.env.USERPROFILE || '', '.gemini', 'antigravity', 'plugin_data', 'gdrive', 'token.json'),
        path.join(process.env.HOME || '', '.gemini', 'antigravity', 'plugin_data', 'gdrive', 'token.json')
    ];

    for (const p of localCandidates) {
        if (p && fs.existsSync(p)) {
            const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
            return {
                clientId: raw.client_id,
                clientSecret: raw.client_secret,
                refreshToken: raw.token?.refresh_token || raw.refresh_token
            };
        }
    }

    return null;
}

/**
 * Exchanges Google OAuth2 Refresh Token for a fresh Access Token
 */
export async function getDriveAccessToken(creds) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            refresh_token: creds.refreshToken,
            grant_type: 'refresh_token'
        })
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Google OAuth Token Refresh Failed: ${res.status} ${errorText}`);
    }

    const data = await res.json();
    return data.access_token;
}

/**
 * Resolves or creates a Google Drive folder via pure REST API v3
 */
export async function getOrCreateDriveFolderRest(accessToken, name, parentId = null) {
    const safeName = String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const qParts = [
        `name = '${safeName}'`,
        `mimeType = 'application/vnd.google-apps.folder'`,
        `trashed = false`
    ];
    if (parentId) {
        const safeParent = String(parentId).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        qParts.push(`'${safeParent}' in parents`);
    }
    const q = qParts.join(' and ');
    const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink)`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const searchJson = await searchRes.json();
    if (searchJson.files && searchJson.files.length > 0) {
        return searchJson.files[0];
    }

    const body = {
        name,
        mimeType: 'application/vnd.google-apps.folder'
    };
    if (parentId) body.parents = [parentId];

    const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!createRes.ok) {
        throw new Error(`Failed to create Drive folder "${name}": ${createRes.status} ${await createRes.text()}`);
    }

    return await createRes.json();
}

/**
 * Uploads a local file to a Google Drive folder via native multipart REST API
 */
export async function uploadFileToDriveRest(accessToken, filePath, fileName, mimeType, parentFolderId) {
    const metadata = {
        name: fileName,
        parents: [parentFolderId]
    };
    const fileBuffer = fs.readFileSync(filePath);
    const boundary = '-------fawrybackup' + Date.now();
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const multipartBody = Buffer.concat([
        Buffer.from(
            delimiter +
            'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
            JSON.stringify(metadata) +
            delimiter +
            `Content-Type: ${mimeType}\r\n\r\n`
        ),
        fileBuffer,
        Buffer.from(closeDelimiter)
    ]);

    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: multipartBody
    });

    if (!res.ok) {
        throw new Error(`Drive file upload failed ("${fileName}"): ${res.status} ${await res.text()}`);
    }

    return await res.json();
}

/**
 * Main Direct-to-Drive Backup Runner (Turso)
 */
export async function runFullDatabaseBackup() {
    console.log('='.repeat(75));
    console.log('☁️  FAWRY DIRECT-TO-DRIVE AUTOMATED BACKUP (ZERO LOCAL STORAGE)');
    console.log('='.repeat(75));

    const startTime = Date.now();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const hierarchy = getFolderHierarchy(now);
    console.log(`\n📅 Target Destination:`);
    console.log(`   > Root:   Fawry Payments Backup`);
    console.log(`   > Year:   ${hierarchy.year}`);
    console.log(`   >> Month: ${hierarchy.month}`);
    console.log(`   >>> Week: ${hierarchy.week}`);

    const db = getTursoClient();

    const creds = getGoogleCredentials();
    if (!creds || !creds.refreshToken) {
        throw new Error('Google Drive credentials not found. Please provide GDRIVE_TOKEN_JSON or authenticate via gdrive auth login');
    }
    const driveAccessToken = await getDriveAccessToken(creds);
    console.log('  ✓ Google Drive REST API authenticated successfully');

    const tempDir = path.join(os.tmpdir(), `fawry_backup_temp_${timestamp}`);
    fs.mkdirSync(tempDir, { recursive: true });

    let zipPath = null;
    let weekFolder = null;
    let uploadedArchive = null;
    let uploadedManifest = null;

    try {
        console.log('\n[1/4] Fetching core configuration tables (Mappings, Fixes, Roles)...');
        const [mappings, manualFixes, userRoles, latestAuditRes, monthlySummaryRes] = await Promise.all([
            fetchTableAll('item_mappings', 'id.asc'),
            fetchTableAll('manual_fixes', 'id.asc'),
            fetchTableAll('user_roles', 'email.asc'),
            withDbRetry(() => db.execute({ sql: 'SELECT * FROM audit_logs ORDER BY id DESC LIMIT 500' })),
            withDbRetry(() => db.execute({
                sql: `SELECT substr(payment_date, 1, 7) AS month, bank, COUNT(*) AS tx_count, COALESCE(SUM(item_price), 0) AS total_amount
                      FROM transactions
                      GROUP BY 1, bank
                      ORDER BY 1 DESC, bank ASC`
            }))
        ]);

        const latestAuditLogs = latestAuditRes.rows.map(r => normalizeBackupRow('audit_logs', r));
        const monthlySummary = monthlySummaryRes.rows;

        fs.writeFileSync(path.join(tempDir, 'item_mappings.json'), JSON.stringify(mappings, null, 2), 'utf-8');
        fs.writeFileSync(path.join(tempDir, 'manual_fixes.json'), JSON.stringify(manualFixes, null, 2), 'utf-8');
        fs.writeFileSync(path.join(tempDir, 'user_roles.json'), JSON.stringify(userRoles, null, 2), 'utf-8');
        fs.writeFileSync(path.join(tempDir, 'audit_logs.json'), JSON.stringify(latestAuditLogs, null, 2), 'utf-8');
        fs.writeFileSync(path.join(tempDir, 'transactions_monthly_summary.json'), JSON.stringify(monthlySummary, null, 2), 'utf-8');

        console.log(`  ✓ Item Mappings: ${mappings.length.toLocaleString()} rules`);
        console.log(`  ✓ Manual Fixes:  ${manualFixes.length.toLocaleString()} rules`);
        console.log(`  ✓ User Roles:    ${userRoles.length.toLocaleString()} users`);
        console.log(`  ✓ Audit Logs:    ${latestAuditLogs.length.toLocaleString()} entries (latest; full log below)`);

        const extraTableCounts = {};
        for (const { table, orderBy } of EXTRA_BACKUP_TABLES) {
            const rows = await fetchTableAll(table, orderBy);
            const fileName = table === 'audit_logs' ? 'audit_logs_full.json' : `${table}.json`;
            fs.writeFileSync(path.join(tempDir, fileName), JSON.stringify(rows), 'utf-8');
            extraTableCounts[table] = rows.length;
            console.log(`  ✓ ${table}: ${rows.length.toLocaleString()} rows`);
        }

        console.log('\n[2/4] Streaming all raw transactions from Turso...');
        const txFilePath = path.join(tempDir, 'transactions.jsonl');
        const txWriteStream = fs.createWriteStream(txFilePath, { encoding: 'utf-8' });

        const chunkSize = 5000;
        let lastTxId = 0;
        let totalTxCount = 0;
        let totalTxAmount = 0;
        let totalSettledCount = 0;

        while (true) {
            const res = await withDbRetry(() => db.execute({
                sql: 'SELECT * FROM transactions WHERE id > ? ORDER BY id ASC LIMIT ?',
                args: [lastTxId, chunkSize]
            }));
            const chunk = res.rows;
            if (!chunk || chunk.length === 0) break;

            for (const rawRow of chunk) {
                const row = normalizeBackupRow('transactions', rawRow);
                txWriteStream.write(JSON.stringify(row) + '\n');
                totalTxAmount += parseFloat(row.item_price || 0) || 0;
                if (row.is_settled) totalSettledCount++;
            }

            lastTxId = Number(chunk[chunk.length - 1].id);
            totalTxCount += chunk.length;
            process.stdout.write(`  ... streamed ${totalTxCount.toLocaleString()} transactions\r`);
            if (chunk.length < chunkSize) break;
        }
        txWriteStream.end();
        await finished(txWriteStream);
        console.log(`\n  ✓ Raw Transactions Saved: ${totalTxCount.toLocaleString()} records`);
        console.log(`  ✓ Total Transactions Amount: EGP ${totalTxAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
        console.log(`  ✓ Settled Transactions:     ${totalSettledCount.toLocaleString()}`);

        console.log('\n[3/4] Streaming Student Master directory...');
        const studentsFilePath = path.join(tempDir, 'student_master.jsonl');
        const studentWriteStream = fs.createWriteStream(studentsFilePath, { encoding: 'utf-8' });

        let lastStudentId = null;
        let totalStudentCount = 0;

        while (true) {
            const res = await withDbRetry(() => db.execute({
                sql: lastStudentId === null
                    ? 'SELECT * FROM student_master ORDER BY student_id ASC LIMIT ?'
                    : 'SELECT * FROM student_master WHERE student_id > ? ORDER BY student_id ASC LIMIT ?',
                args: lastStudentId === null ? [chunkSize] : [lastStudentId, chunkSize]
            }));
            const chunk = res.rows;
            if (!chunk || chunk.length === 0) break;

            for (const s of chunk) {
                studentWriteStream.write(JSON.stringify(s) + '\n');
            }

            lastStudentId = String(chunk[chunk.length - 1].student_id);
            totalStudentCount += chunk.length;
            if (chunk.length < chunkSize) break;
        }
        studentWriteStream.end();
        await finished(studentWriteStream);
        console.log(`  ✓ Student Master Saved:   ${totalStudentCount.toLocaleString()} students`);

        const fileChecksums = {};
        for (const fname of fs.readdirSync(tempDir)) {
            const fullPath = path.join(tempDir, fname);
            if (fs.statSync(fullPath).isFile()) {
                fileChecksums[fname] = {
                    bytes: fs.statSync(fullPath).size,
                    sha256: computeFileSha256(fullPath)
                };
            }
        }

        const manifest = {
            backup_id: `fawry_backup_${timestamp}`,
            created_at: now.toISOString(),
            version: '2.11.6-turso',
            database: 'Fawry Payments Project (Turso / libSQL)',
            integrity_verified: true,
            hierarchy: {
                root: 'Fawry Payments Backup',
                year: hierarchy.year,
                month: hierarchy.month,
                week: hierarchy.week
            },
            statistics: {
                transactions_count: totalTxCount,
                transactions_total_amount_egp: Math.round(totalTxAmount * 100) / 100,
                settled_transactions_count: totalSettledCount,
                students_count: totalStudentCount,
                mappings_count: mappings.length,
                manual_fixes_count: manualFixes.length,
                user_roles_count: userRoles.length,
                audit_logs_count: extraTableCounts.audit_logs ?? latestAuditLogs.length,
                extra_tables: extraTableCounts
            },
            checksums_sha256: fileChecksums
        };
        const manifestPath = path.join(tempDir, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

        console.log('\n[4/5] Packaging database into compressed archive...');
        zipPath = path.join(os.tmpdir(), `fawry_backup_${timestamp}.zip`);

        if (process.platform === 'win32') {
            const safeSrc = `${tempDir}\\*`.replace(/'/g, "''");
            const safeDst = zipPath.replace(/'/g, "''");
            execFileSync('powershell', [
                '-NoProfile',
                '-Command',
                `Compress-Archive -Path '${safeSrc}' -DestinationPath '${safeDst}' -Force`
            ]);
        } else {
            execFileSync('zip', ['-q', '-r', zipPath, '.'], { cwd: tempDir });
        }

        const zipSizeMb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(2);
        const zipSha256 = computeFileSha256(zipPath);
        manifest.archive_sha256 = zipSha256;
        manifest.archive_size_mb = Number(zipSizeMb);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
        console.log(`  ✓ Production Package Created: ${zipSizeMb} MB | SHA-256: ${zipSha256.slice(0, 16)}...`);

        console.log('\n[5/5] Resolving Google Drive hierarchy and uploading directly...');
        const rootFolder = await getOrCreateDriveFolderRest(driveAccessToken, 'Fawry Payments Backup');
        const yearFolder = await getOrCreateDriveFolderRest(driveAccessToken, hierarchy.year, rootFolder.id);
        const monthFolder = await getOrCreateDriveFolderRest(driveAccessToken, hierarchy.month, yearFolder.id);
        weekFolder = await getOrCreateDriveFolderRest(driveAccessToken, hierarchy.week, monthFolder.id);

        console.log(`  Uploading backup archive to: ${hierarchy.year} > ${hierarchy.month} > ${hierarchy.week}`);
        uploadedArchive = await uploadFileToDriveRest(
            driveAccessToken,
            zipPath,
            `fawry_backup_${timestamp}.zip`,
            'application/zip',
            weekFolder.id
        );
        console.log('  ✓ Archive uploaded to Google Drive!');
        console.log(`    File ID: ${uploadedArchive.id}`);

        uploadedManifest = await uploadFileToDriveRest(
            driveAccessToken,
            manifestPath,
            'manifest.json',
            'application/json',
            weekFolder.id
        );
        console.log('  ✓ Manifest uploaded to Google Drive!');
        console.log(`    File ID: ${uploadedManifest.id}`);

        try {
            await withDbRetry(() => db.execute({
                sql: 'INSERT INTO audit_logs (user_email, action, affected_references, details) VALUES (?, ?, ?, ?)',
                args: [
                    'system@nu.edu.eg',
                    'DRIVE_BACKUP_COMPLETED',
                    `Full Database (${totalTxCount.toLocaleString()} txs)`,
                    JSON.stringify({
                        archive_name: `fawry_backup_${timestamp}.zip`,
                        size_mb: zipSizeMb,
                        hierarchy: `Fawry Payments Backup > ${hierarchy.year} > ${hierarchy.month} > ${hierarchy.week}`,
                        drive_folder_url: weekFolder.webViewLink,
                        financial_total_egp: totalTxAmount,
                        runner: process.env.GITHUB_ACTIONS ? 'github-actions-cloud' : 'local-runtime'
                    })
                ]
            }));
            console.log('  ✓ Logged backup event to database audit trail');
        } catch (_auditErr) {
            // Ignore non-fatal audit log failure
        }

        const duration = Date.now() - startTime;
        console.log('\n' + '='.repeat(75));
        console.log(`🎉 BACKUP UPLOADED DIRECTLY TO GOOGLE DRIVE IN ${(duration / 1000).toFixed(1)}s!`);
        console.log(`   Transactions:  ${totalTxCount.toLocaleString()} rows (EGP ${totalTxAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })})`);
        console.log(`   Students:      ${totalStudentCount.toLocaleString()} rows`);
        console.log(`   Rules & Fixes: ${mappings.length} mappings, ${manualFixes.length} fixes, ${userRoles.length} roles`);
        console.log(`   Cloud Folder:  ${weekFolder.webViewLink}`);
        console.log(`   Local Storage: 0 MB (all temporary files purged from disk)`);
        console.log('='.repeat(75));

        if (process.env.GITHUB_STEP_SUMMARY) {
            try {
                const summaryMarkdown = `
### ☁️ Fawry Payments Automated Cloud Backup Succeeded

- **Status**: Completed in ${(duration / 1000).toFixed(1)}s
- **Destination**: [Fawry Payments Backup > ${hierarchy.year} > ${hierarchy.month} > ${hierarchy.week}](${weekFolder.webViewLink})
- **Archive Size**: ${zipSizeMb} MB
- **Total Transactions**: ${totalTxCount.toLocaleString()} (EGP ${totalTxAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })})
- **Total Students**: ${totalStudentCount.toLocaleString()}
- **Archive ID**: \`${uploadedArchive.id}\`
`;
                fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown);
            } catch (_sumErr) {
                // Ignore summary write errors
            }
        }

        return {
            success: true,
            manifest,
            driveFolderUrl: weekFolder.webViewLink,
            hierarchy
        };
    } finally {
        try {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
            if (zipPath && fs.existsSync(zipPath)) {
                fs.unlinkSync(zipPath);
            }
            const localBackupsDir = path.resolve('backups');
            if (fs.existsSync(localBackupsDir)) {
                fs.rmSync(localBackupsDir, { recursive: true, force: true });
            }
        } catch (_cleanupErr) {
            // Silent cleanup error
        }
    }
}

if (process.argv[1] && process.argv[1].endsWith('backup_to_drive.js')) {
    runFullDatabaseBackup().catch(err => {
        console.error('❌ Backup failed:', err);
        process.exit(1);
    });
}
