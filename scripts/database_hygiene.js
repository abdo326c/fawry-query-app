/**
 * Database Hygiene & Deduplication Scanner
 * 
 * Inspects and cleans:
 * 1. Duplicate item mapping rules (case/space variations).
 * 2. Duplicate manual fix entries.
 * 3. Identical transaction duplicates.
 * 4. Unmapped transactions.
 * 5. Invalid / Missing student IDs.
 * 
 * Runs server-side via PostgreSQL RPC for sub-second execution across 38,000+ rows.
 * 
 * Usage:
 *   node scripts/database_hygiene.js        (Inspection mode)
 *   node scripts/database_hygiene.js --fix  (Inspection + Auto-clean duplicates)
 */

const SUPABASE_URL = 'https://hjtxdyuevxcezxzbiiqk.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhqdHhkeXVldnhjZXp4emJpaXFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1MjU5MDEsImV4cCI6MjA5NTEwMTkwMX0.ZiKUw1db5pDRYto-hLGut3rdrzxVfRN36ouX4AjB5AQ';

export async function runDatabaseHygiene({ applyFixes = false } = {}) {
    console.log('='.repeat(65));
    console.log('🔍 FAWRY DATABASE HYGIENE & DEDUPLICATION AUDIT');
    console.log(`Mode: ${applyFixes ? 'AUTO-CLEAN (--fix)' : 'INSPECTION (Read-Only)'}`);
    console.log('='.repeat(65));

    const startTime = Date.now();
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
    console.log('='.repeat(65));
    console.log(`📊 DATABASE HEALTH & HYGIENE REPORT:`);
    console.log(`  • Overall Database Health Score: ${data.health_score}%`);
    console.log(`  • Total Transactions Scanned:   ${(data.total_transactions || 0).toLocaleString()}`);
    console.log(`  • Settled Transactions:         ${(data.settled_transactions || 0).toLocaleString()}`);
    console.log(`  • Identical Duplicate Tx:        ${data.identical_tx_duplicates || 0}`);
    console.log(`  • Duplicate Mapping Rules:       ${data.duplicate_mappings || 0} (Cleaned: ${data.cleaned_mappings || 0})`);
    console.log(`  • Duplicate Manual Fixes:        ${data.duplicate_fixes || 0} (Cleaned: ${data.cleaned_fixes || 0})`);
    console.log(`  • Transactions Missing Mapping:  ${data.unmapped_items || 0}`);
    console.log(`  • Missing / Invalid Student IDs: ${data.invalid_ids || 0}`);
    console.log('='.repeat(65));
    console.log('✓ Audit entry successfully recorded in audit_logs table.');

    return data;
}

// Direct CLI execution
if (process.argv[1] && process.argv[1].endsWith('database_hygiene.js')) {
    const shouldFix = process.argv.includes('--fix');
    runDatabaseHygiene({ applyFixes: shouldFix }).catch(console.error);
}
