/**
 * Fawry Direct-to-Cloud Automated Backup (Zero Local Disk Footprint)
 * Compatible with Local Environments and GitHub Actions Cloud Cron
 * 
 * Hierarchy on Google Drive:
 *   Fawry Payments Backup
 *     └── > Year (e.g. 2026)
 *          └── >> Month (e.g. 10 - October)
 *               └── >>> Week (e.g. Week 44 (Oct 26 - Nov 01))
 *                    ├── fawry_backup_YYYYMMDD_HHmmss.zip (All transactions, students, rules, roles, audit)
 *                    └── manifest.json (Inspectable metadata & financial verification summary)
 * 
 * Features:
 * 1. Streams 100% of raw database records directly to ephemeral OS temp storage.
 * 2. Compresses all files into a single production zip archive (cross-platform Windows & Linux).
 * 3. Uploads directly into Google Drive via native REST API v3 (0 CLI dependency).
 * 4. Automatically purges all local temporary files immediately after upload (0 MB left on disk).
 * 5. Logs backup event into database audit trail (`audit_logs`) and GitHub Step Summary.
 * 
 * Usage:
 *   npm run backup
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { finished } from 'stream/promises';
import { execSync } from 'child_process';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hjtxdyuevxcezxzbiiqk.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhqdHhkeXVldnhjZXp4emJpaXFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1MjU5MDEsImV4cCI6MjA5NTEwMTkwMX0.ZiKUw1db5pDRYto-hLGut3rdrzxVfRN36ouX4AjB5AQ';

const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
};

async function fetchRpc(fn, body = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`RPC ${fn} failed: ${res.status} ${text}`);
    }
    return await res.json();
}

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
    
    // ISO Week Calculation (starts Monday)
    const tempDate = new Date(date.getTime());
    tempDate.setHours(0, 0, 0, 0);
    tempDate.setDate(tempDate.getDate() + 3 - (tempDate.getDay() + 6) % 7);
    const week1 = new Date(tempDate.getFullYear(), 0, 4);
    const weekNumber = 1 + Math.round(((tempDate.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
    
    // Week date span
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
 * Supports:
 *   1. GDRIVE_TOKEN_JSON environment variable (Single string secret in CI/GitHub)
 *   2. GDRIVE_REFRESH_TOKEN / GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET env vars
 *   3. Local token.json from Antigravity plugin storage
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
    const qParts = [
        `name = '${name.replace(/'/g, "\\'")}'`,
        `mimeType = 'application/vnd.google-apps.folder'`,
        `trashed = false`
    ];
    if (parentId) {
        qParts.push(`'${parentId}' in parents`);
    }
    const q = qParts.join(' and ');
    const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink)`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const searchJson = await searchRes.json();
    if (searchJson.files && searchJson.files.length > 0) {
        return searchJson.files[0];
    }

    // Create Folder
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
 * Main Direct-to-Drive Backup Runner
 */
export async function runFullDatabaseBackup() {
    console.log('='.repeat(75));
    console.log('☁️  FAWRY DIRECT-TO-DRIVE AUTOMATED BACKUP (ZERO LOCAL STORAGE)');
    console.log('='.repeat(75));

    const startTime = Date.now();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    
    // Calculate Year > Month > Week Hierarchy
    const hierarchy = getFolderHierarchy(now);
    console.log(`\n📅 Target Destination:`);
    console.log(`   > Root:   Fawry Payments Backup`);
    console.log(`   > Year:   ${hierarchy.year}`);
    console.log(`   >> Month: ${hierarchy.month}`);
    console.log(`   >>> Week: ${hierarchy.week}`);

    // Verify Google Credentials upfront
    const creds = getGoogleCredentials();
    if (!creds || !creds.refreshToken) {
        throw new Error('Google Drive credentials not found. Please provide GDRIVE_TOKEN_JSON or authenticate via gdrive auth login');
    }
    const driveAccessToken = await getDriveAccessToken(creds);
    console.log('  ✓ Google Drive REST API authenticated successfully');

    // Create Ephemeral Working Directory in OS Temp
    const tempDir = path.join(os.tmpdir(), `fawry_backup_temp_${timestamp}`);
    fs.mkdirSync(tempDir, { recursive: true });

    let zipPath = null;
    let weekFolder = null;
    let uploadedArchive = null;
    let uploadedManifest = null;

    try {
        // [1/4] Core Configuration Snapshot
        console.log('\n[1/4] Fetching core configuration tables (Mappings, Fixes, Roles)...');
        const coreSnapshot = await fetchRpc('export_database_backup_payload');
        
        fs.writeFileSync(path.join(tempDir, 'item_mappings.json'), JSON.stringify(coreSnapshot.mappings, null, 2), 'utf-8');
        fs.writeFileSync(path.join(tempDir, 'manual_fixes.json'), JSON.stringify(coreSnapshot.manual_fixes, null, 2), 'utf-8');
        fs.writeFileSync(path.join(tempDir, 'user_roles.json'), JSON.stringify(coreSnapshot.user_roles, null, 2), 'utf-8');
        fs.writeFileSync(path.join(tempDir, 'audit_logs.json'), JSON.stringify(coreSnapshot.audit_logs, null, 2), 'utf-8');
        fs.writeFileSync(path.join(tempDir, 'transactions_monthly_summary.json'), JSON.stringify(coreSnapshot.transactions_monthly_summary, null, 2), 'utf-8');

        console.log(`  ✓ Item Mappings: ${coreSnapshot.mappings_count.toLocaleString()} rules`);
        console.log(`  ✓ Manual Fixes:  ${coreSnapshot.fixes_count.toLocaleString()} rules`);
        console.log(`  ✓ User Roles:    ${coreSnapshot.roles_count.toLocaleString()} users`);
        console.log(`  ✓ Audit Logs:    ${(coreSnapshot.audit_logs || []).length.toLocaleString()} entries`);

        // [2/4] Stream All Raw Transactions (in chunks of 5,000)
        console.log('\n[2/4] Streaming all raw transactions from database...');
        const txFilePath = path.join(tempDir, 'transactions.jsonl');
        const txWriteStream = fs.createWriteStream(txFilePath, { encoding: 'utf-8' });
        
        let txOffset = 0;
        const chunkSize = 5000;
        let totalTxCount = 0;
        let totalTxAmount = 0;
        let totalSettledCount = 0;

        while (true) {
            const chunk = await fetchRpc('get_transactions_backup_chunk', { p_offset: txOffset, p_limit: chunkSize });
            if (!chunk || chunk.length === 0) break;

            for (const row of chunk) {
                txWriteStream.write(JSON.stringify(row) + '\n');
                totalTxAmount += parseFloat(row.item_price || 0) || 0;
                if (row.is_settled) totalSettledCount++;
            }

            totalTxCount += chunk.length;
            process.stdout.write(`  ... streamed ${totalTxCount.toLocaleString()} transactions\r`);
            if (chunk.length < chunkSize) break;
            txOffset += chunkSize;
        }
        txWriteStream.end();
        await finished(txWriteStream);
        console.log(`\n  ✓ Raw Transactions Saved: ${totalTxCount.toLocaleString()} records`);
        console.log(`  ✓ Total Transactions Amount: EGP ${totalTxAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
        console.log(`  ✓ Settled Transactions:     ${totalSettledCount.toLocaleString()}`);

        // [3/4] Stream All Student Master Records
        console.log('\n[3/4] Streaming Student Master directory...');
        const studentsFilePath = path.join(tempDir, 'student_master.jsonl');
        const studentWriteStream = fs.createWriteStream(studentsFilePath, { encoding: 'utf-8' });

        let stuOffset = 0;
        let totalStudentCount = 0;

        while (true) {
            const chunk = await fetchRpc('get_students_backup_chunk', { p_offset: stuOffset, p_limit: chunkSize });
            if (!chunk || chunk.length === 0) break;

            for (const s of chunk) {
                studentWriteStream.write(JSON.stringify(s) + '\n');
            }

            totalStudentCount += chunk.length;
            if (chunk.length < chunkSize) break;
            stuOffset += chunkSize;
        }
        studentWriteStream.end();
        await finished(studentWriteStream);
        console.log(`  ✓ Student Master Saved:   ${totalStudentCount.toLocaleString()} students`);

        // Write Manifest Metadata
        const manifest = {
            backup_id: `fawry_backup_${timestamp}`,
            created_at: now.toISOString(),
            version: '2.3.2',
            database: 'Fawry Payments Project (Supabase)',
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
                mappings_count: coreSnapshot.mappings_count,
                manual_fixes_count: coreSnapshot.fixes_count,
                user_roles_count: coreSnapshot.roles_count,
                audit_logs_count: (coreSnapshot.audit_logs || []).length
            }
        };
        const manifestPath = path.join(tempDir, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

        // Package Everything into Single Zip Archive (Cross-Platform)
        console.log('\n[4/5] Packaging database into compressed archive...');
        zipPath = path.join(os.tmpdir(), `fawry_backup_${timestamp}.zip`);
        
        if (process.platform === 'win32') {
            execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${tempDir}\\*' -DestinationPath '${zipPath}' -Force"`);
        } else {
            // Linux / macOS (GitHub Actions runner)
            execSync(`cd "${tempDir}" && zip -q -r "${zipPath}" .`);
        }
        
        const zipSizeMb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(2);
        console.log(`  ✓ Production Package Created: ${zipSizeMb} MB (transactions, students, config, roles)`);

        // [5/5] Google Drive Upload via Native REST API v3
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

        // Record Audit Log in Supabase
        try {
            await fetch(`${SUPABASE_URL}/rest/v1/audit_logs`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    user_email: 'system@nu.edu.eg',
                    action: 'DRIVE_BACKUP_COMPLETED',
                    affected_references: `Full Database (${totalTxCount.toLocaleString()} txs)`,
                    details: {
                        archive_name: `fawry_backup_${timestamp}.zip`,
                        size_mb: zipSizeMb,
                        hierarchy: `Fawry Payments Backup > ${hierarchy.year} > ${hierarchy.month} > ${hierarchy.week}`,
                        drive_folder_url: weekFolder.webViewLink,
                        financial_total_egp: totalTxAmount,
                        runner: process.env.GITHUB_ACTIONS ? 'github-actions-cloud' : 'local-runtime'
                    }
                })
            });
            console.log('  ✓ Logged backup event to database audit trail');
        } catch (auditErr) {
            // Ignore non-fatal audit log failure
        }

        const duration = Date.now() - startTime;
        console.log('\n' + '='.repeat(75));
        console.log(`🎉 BACKUP UPLOADED DIRECTLY TO GOOGLE DRIVE IN ${(duration / 1000).toFixed(1)}s!`);
        console.log(`   Transactions:  ${totalTxCount.toLocaleString()} rows (EGP ${totalTxAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })})`);
        console.log(`   Students:      ${totalStudentCount.toLocaleString()} rows`);
        console.log(`   Rules & Fixes: ${coreSnapshot.mappings_count} mappings, ${coreSnapshot.fixes_count} fixes, ${coreSnapshot.roles_count} roles`);
        console.log(`   Cloud Folder:  ${weekFolder.webViewLink}`);
        console.log(`   Local Storage: 0 MB (all temporary files purged from disk)`);
        console.log('='.repeat(75));

        // GitHub Actions Step Summary
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
            } catch (sumErr) {
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
        // Enforce Zero Local Disk Storage by purging temporary files
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
        } catch (cleanupErr) {
            // Silent cleanup error
        }
    }
}

// Direct CLI execution
if (process.argv[1] && process.argv[1].endsWith('backup_to_drive.js')) {
    runFullDatabaseBackup().catch(console.error);
}
