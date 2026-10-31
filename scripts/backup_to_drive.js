/**
 * Automated Database Backup to Local Disk and Google Drive
 * 
 * Exports:
 * 1. Item Mappings (JSON)
 * 2. Manual Fixes (JSON)
 * 3. User Roles (JSON)
 * 4. Monthly Transactions Summary & Financial Totals (JSON)
 * 5. Recent Audit Logs (JSON)
 * 
 * Archives into backups/fawry_backup_YYYYMMDD_HHmmss/
 * Uploads to Google Drive if the gdrive CLI is authenticated.
 * 
 * Usage:
 *   node scripts/backup_to_drive.js
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { execSync } from 'child_process';

const SUPABASE_URL = 'https://hjtxdyuevxcezxzbiiqk.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhqdHhkeXVldnhjZXp4emJpaXFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1MjU5MDEsImV4cCI6MjA5NTEwMTkwMX0.ZiKUw1db5pDRYto-hLGut3rdrzxVfRN36ouX4AjB5AQ';

export async function runDatabaseBackup() {
    console.log('='.repeat(65));
    console.log('💾 FAWRY AUTOMATED DATABASE BACKUP');
    console.log('='.repeat(65));

    const startTime = Date.now();
    console.log('\n[1/3] Fetching full database snapshot from Supabase...');
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/export_database_backup_payload`, {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json'
        }
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Export RPC failed: ${res.status} ${errText}`);
    }

    const payload = await res.json();
    const fetchTime = Date.now() - startTime;
    console.log(`  ✓ Snapshot retrieved in ${fetchTime}ms`);
    console.log(`  ✓ Mappings:    ${payload.mappings_count}`);
    console.log(`  ✓ Manual Fixes: ${payload.fixes_count}`);
    console.log(`  ✓ User Roles:   ${payload.roles_count}`);
    console.log(`  ✓ Audit Logs:   ${(payload.audit_logs || []).length}`);
    console.log(`  ✓ Months in Summary: ${(payload.transactions_monthly_summary || []).length}`);

    // [2/3] Write local backup files
    console.log('\n[2/3] Writing local backup directory and compressed archive...');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    
    const baseBackupsDir = path.resolve('backups');
    const targetDir = path.join(baseBackupsDir, `fawry_backup_${timestamp}`);
    fs.mkdirSync(targetDir, { recursive: true });

    // Write individual clean JSON files
    fs.writeFileSync(path.join(targetDir, 'item_mappings.json'), JSON.stringify(payload.mappings, null, 2), 'utf-8');
    fs.writeFileSync(path.join(targetDir, 'manual_fixes.json'), JSON.stringify(payload.manual_fixes, null, 2), 'utf-8');
    fs.writeFileSync(path.join(targetDir, 'user_roles.json'), JSON.stringify(payload.user_roles, null, 2), 'utf-8');
    fs.writeFileSync(path.join(targetDir, 'audit_logs.json'), JSON.stringify(payload.audit_logs, null, 2), 'utf-8');
    fs.writeFileSync(path.join(targetDir, 'transactions_monthly_summary.json'), JSON.stringify(payload.transactions_monthly_summary, null, 2), 'utf-8');

    // Write metadata manifest
    const manifest = {
        backup_id: `fawry_backup_${timestamp}`,
        created_at: now.toISOString(),
        version: payload.version,
        statistics: {
            mappings: payload.mappings_count,
            manual_fixes: payload.fixes_count,
            user_roles: payload.roles_count,
            audit_logs: (payload.audit_logs || []).length,
            monthly_summaries: (payload.transactions_monthly_summary || []).length
        }
    };
    fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

    // Compress consolidated snapshot into .json.gz
    const compressedArchive = path.join(baseBackupsDir, `fawry_backup_${timestamp}.json.gz`);
    const fullJsonBuffer = Buffer.from(JSON.stringify(payload), 'utf-8');
    const gzipped = zlib.gzipSync(fullJsonBuffer);
    fs.writeFileSync(compressedArchive, gzipped);

    const sizeKb = (gzipped.length / 1024).toFixed(1);
    console.log(`  ✓ Local Folder:   ${targetDir}`);
    console.log(`  ✓ Gzip Archive:   ${compressedArchive} (${sizeKb} KB)`);

    // [3/3] Upload to Google Drive via gdrive CLI if authenticated
    console.log('\n[3/3] Checking Google Drive integration...');
    let gdriveUploaded = false;
    try {
        const authCheck = execSync('gdrive auth status', { stdio: 'pipe', encoding: 'utf-8' });
        if (authCheck.includes('Logged in as') || !authCheck.includes('Not logged in')) {
            console.log('  ✓ Google Drive CLI is authenticated.');
            console.log(`  Uploading ${path.basename(compressedArchive)} to Google Drive...`);
            const uploadRes = execSync(`gdrive mutate upload "${compressedArchive}"`, { stdio: 'pipe', encoding: 'utf-8' });
            console.log('  ✓ Upload to Google Drive completed successfully!');
            console.log('    ' + uploadRes.trim());
            gdriveUploaded = true;
        } else {
            console.log('  ℹ️ Google Drive CLI not yet signed in.');
            console.log('     Local backup is secure. To enable cloud push, run: gdrive auth login');
        }
    } catch (err) {
        console.log('  ℹ️ Google Drive CLI check skipped (' + err.message.split('\n')[0] + ').');
        console.log('     Local backup was safely created and saved on disk.');
    }

    console.log('='.repeat(65));
    console.log(`🎉 BACKUP SUCCESSFUL (Took ${(Date.now() - startTime)}ms)`);
    console.log(`   File: ${compressedArchive} (${sizeKb} KB)`);
    console.log(`   Cloud Sync: ${gdriveUploaded ? 'Uploaded to Google Drive' : 'Stored locally in ./backups'}`);
    console.log('='.repeat(65));

    return {
        manifest,
        archivePath: compressedArchive,
        gdriveUploaded
    };
}

// Direct CLI execution
if (process.argv[1] && process.argv[1].endsWith('backup_to_drive.js')) {
    runDatabaseBackup().catch(console.error);
}
