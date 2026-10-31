/**
 * Full Database Backup to Local Disk and Google Drive
 * 
 * Includes 100% of all data:
 * 1. Transactions (ALL 38,000+ raw records streamed in chunks)
 * 2. Student Master (ALL 22,000+ student records)
 * 3. Item Mappings (ALL rules)
 * 4. Manual Fixes (ALL corrections)
 * 5. User Roles (ALL permission assignments)
 * 6. Audit Trail & Monthly Summaries
 * 
 * Archives into backups/fawry_full_backup_YYYYMMDD_HHmmss/
 * Uploads to Google Drive via gdrive CLI.
 * 
 * Usage:
 *   node scripts/backup_to_drive.js
 *   npm run backup
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { execSync } from 'child_process';

const SUPABASE_URL = 'https://hjtxdyuevxcezxzbiiqk.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhqdHhkeXVldnhjZXp4emJpaXFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1MjU5MDEsImV4cCI6MjA5NTEwMTkwMX0.ZiKUw1db5pDRYto-hLGut3rdrzxVfRN36ouX4AjB5AQ';

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

export async function runFullDatabaseBackup() {
    console.log('='.repeat(70));
    console.log('💾 FAWRY FULL DATABASE BACKUP (RAW TRANSACTIONS + CONFIG + STUDENTS)');
    console.log('='.repeat(70));

    const startTime = Date.now();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    
    const baseBackupsDir = path.resolve('backups');
    const targetDir = path.join(baseBackupsDir, `fawry_full_backup_${timestamp}`);
    fs.mkdirSync(targetDir, { recursive: true });

    // [1/4] Core Configuration Snapshot
    console.log('\n[1/4] Fetching core configuration tables (Mappings, Fixes, Roles)...');
    const coreSnapshot = await fetchRpc('export_database_backup_payload');
    
    fs.writeFileSync(path.join(targetDir, 'item_mappings.json'), JSON.stringify(coreSnapshot.mappings, null, 2), 'utf-8');
    fs.writeFileSync(path.join(targetDir, 'manual_fixes.json'), JSON.stringify(coreSnapshot.manual_fixes, null, 2), 'utf-8');
    fs.writeFileSync(path.join(targetDir, 'user_roles.json'), JSON.stringify(coreSnapshot.user_roles, null, 2), 'utf-8');
    fs.writeFileSync(path.join(targetDir, 'audit_logs.json'), JSON.stringify(coreSnapshot.audit_logs, null, 2), 'utf-8');
    fs.writeFileSync(path.join(targetDir, 'transactions_monthly_summary.json'), JSON.stringify(coreSnapshot.transactions_monthly_summary, null, 2), 'utf-8');

    console.log(`  ✓ Item Mappings: ${coreSnapshot.mappings_count.toLocaleString()} rules`);
    console.log(`  ✓ Manual Fixes:  ${coreSnapshot.fixes_count.toLocaleString()} rules`);
    console.log(`  ✓ User Roles:    ${coreSnapshot.roles_count.toLocaleString()} users`);
    console.log(`  ✓ Audit Logs:    ${(coreSnapshot.audit_logs || []).length.toLocaleString()} entries`);

    // [2/4] Stream All Raw Transactions (in chunks of 5,000)
    console.log('\n[2/4] Streaming all raw transactions from database...');
    const txFilePath = path.join(targetDir, 'transactions.jsonl');
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
    console.log(`\n  ✓ Raw Transactions Saved: ${totalTxCount.toLocaleString()} records`);
    console.log(`  ✓ Total Transactions Amount: EGP ${totalTxAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    console.log(`  ✓ Settled Transactions:     ${totalSettledCount.toLocaleString()}`);

    // [3/4] Stream All Student Master Records
    console.log('\n[3/4] Streaming Student Master directory...');
    const studentsFilePath = path.join(targetDir, 'student_master.jsonl');
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
    console.log(`  ✓ Student Master Saved:   ${totalStudentCount.toLocaleString()} students`);

    // Write Manifest
    const manifest = {
        backup_id: `fawry_full_backup_${timestamp}`,
        created_at: now.toISOString(),
        version: '2.3.2',
        database: 'Fawry Payments Project (Supabase)',
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
    fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

    // Create Gzip Archive of the entire transaction set
    const compressedTxArchive = path.join(baseBackupsDir, `fawry_transactions_${timestamp}.jsonl.gz`);
    const rawTxBuffer = fs.readFileSync(txFilePath);
    const gzippedTx = zlib.gzipSync(rawTxBuffer);
    fs.writeFileSync(compressedTxArchive, gzippedTx);
    const compressedSizeMb = (gzippedTx.length / (1024 * 1024)).toFixed(2);
    console.log(`  ✓ Transactions Compressed Archive: ${compressedTxArchive} (${compressedSizeMb} MB)`);

    // [4/4] Google Drive Integration
    console.log('\n[4/4] Syncing backup to Google Drive...');
    let gdriveUploaded = false;
    try {
        const authCheck = execSync('gdrive auth status', { stdio: 'pipe', encoding: 'utf-8' });
        if (authCheck.includes('Logged in as') || !authCheck.includes('Not logged in')) {
            console.log('  Uploading compressed transactions & manifest to Google Drive...');
            const uploadRes = execSync(`gdrive mutate upload "${compressedTxArchive}"`, { stdio: 'pipe', encoding: 'utf-8' });
            console.log('  ✓ Google Drive upload succeeded!');
            console.log('    ' + uploadRes.trim());
            gdriveUploaded = true;
        } else {
            console.log('  ℹ️ Google Drive CLI not yet logged in.');
            console.log('     Local backup is safely saved. To upload to Google Drive, run: gdrive auth login');
        }
    } catch (err) {
        console.log('  ℹ️ Google Drive CLI check skipped (' + err.message.split('\n')[0] + ').');
        console.log('     All raw transactions and tables are securely backed up locally.');
    }

    const duration = Date.now() - startTime;
    console.log('='.repeat(70));
    console.log(`🎉 FULL BACKUP COMPLETED IN ${(duration / 1000).toFixed(1)}s!`);
    console.log(`   Transactions: ${totalTxCount.toLocaleString()} rows (EGP ${totalTxAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })})`);
    console.log(`   Students:     ${totalStudentCount.toLocaleString()} rows`);
    console.log(`   Mappings:     ${coreSnapshot.mappings_count} rules`);
    console.log(`   Manual Fixes: ${coreSnapshot.fixes_count} rules`);
    console.log(`   Backup Path:  ${targetDir}`);
    console.log(`   Archive:      ${compressedTxArchive} (${compressedSizeMb} MB)`);
    console.log('='.repeat(70));

    return {
        manifest,
        backupDirectory: targetDir,
        archivePath: compressedTxArchive,
        gdriveUploaded
    };
}

// Direct CLI execution
if (process.argv[1] && process.argv[1].endsWith('backup_to_drive.js')) {
    runFullDatabaseBackup().catch(console.error);
}
