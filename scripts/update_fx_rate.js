/**
 * Daily USD -> EGP FX rate updater scheduled for 12:00 PM Africa/Cairo time.
 * Fetches the live USD -> EGP rate and upserts it into Turso `exchange_rates`.
 * Intended to run from GitHub Actions (`0 9,10 * * *` UTC) or manually with `--force`.
 */
import { createClient } from '@libsql/client';
import { withDbRetry } from '../api/_lib/db.js';
import {
    EGYPT_DAILY_FX_HOUR,
    fetchUsdToEgpRateForDate,
    getEgyptDateTimeParts
} from '../fx-rates.js';

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const overwriteManual = args.has('--overwrite-manual');

const TURSO_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

async function main() {
    const now = new Date();
    const egyptNow = getEgyptDateTimeParts(now);

    if (!force && egyptNow.hour !== EGYPT_DAILY_FX_HOUR) {
        console.log(
            `[fx-cron] Current Egypt time (${egyptNow.dateStr} ${String(egyptNow.hour).padStart(2, '0')}:${String(egyptNow.minute).padStart(2, '0')} Africa/Cairo) is not 12:00 PM; skipping.`
        );
        return;
    }

    if (!TURSO_URL) {
        throw new Error('Missing TURSO_DATABASE_URL environment variable.');
    }

    const db = createClient({
        url: TURSO_URL,
        authToken: TURSO_TOKEN || undefined
    });

    const res = await fetchUsdToEgpRateForDate('latest', fetch, egyptNow.dateStr);
    if (!res || !(res.rate > 0)) {
        throw new Error('Failed to fetch a valid USD -> EGP exchange rate from all upstream providers.');
    }

    if (!overwriteManual) {
        const existing = await withDbRetry(() => db.execute({
            sql: "SELECT rate_date, rate, source FROM exchange_rates WHERE rate_date = ? AND currency_pair = 'USD_EGP' LIMIT 1",
            args: [egyptNow.dateStr]
        }));
        if (existing.rows.length > 0 && existing.rows[0]?.source === 'manual') {
            console.log(`[fx-cron] Preserving manual USD -> EGP override (${existing.rows[0].rate}) for ${egyptNow.dateStr}.`);
            return;
        }
    }

    const nowIso = now.toISOString();
    await withDbRetry(() => db.execute({
        sql: `INSERT INTO exchange_rates (rate_date, currency_pair, rate, source, updated_by, updated_at)
              VALUES (?, 'USD_EGP', ?, 'auto', 'daily-cron-12pm-egypt', ?)
              ON CONFLICT(rate_date, currency_pair) DO UPDATE SET
                rate = excluded.rate,
                source = excluded.source,
                updated_by = excluded.updated_by,
                updated_at = excluded.updated_at`,
        args: [egyptNow.dateStr, res.rate, nowIso]
    }));

    console.log(
        `[fx-cron] Updated USD -> EGP rate for ${egyptNow.dateStr} at 12:00 PM Egypt: ${res.rate} (provider: ${res.provider})`
    );
}

main().catch(err => {
    console.error('[fx-cron] Error:', err?.message || err);
    process.exit(1);
});
