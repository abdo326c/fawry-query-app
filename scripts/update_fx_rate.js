/**
 * Daily USD -> EGP FX rate updater scheduled for 12:00 PM Africa/Cairo time.
 * Fetches the live USD -> EGP rate and upserts it into Turso `exchange_rates`.
 * Intended to run from GitHub Actions (several hourly cron slots from 09:00 UTC) or manually
 * with `--force`.
 *
 * GitHub's scheduler is often late (sometimes by more than an hour), so a scheduled run:
 *   - before 12:00 Cairo time: skips;
 *   - at 12:xx Cairo time: fetches and saves today's rate;
 *   - after 13:00 Cairo time: saves only when today has no rate yet (catch-up for a late or
 *     missed noon run); once today's 'auto' rate exists the later slots do nothing.
 * A manual rate (source = 'manual') is never overwritten unless `--overwrite-manual` is given;
 * the upsert itself also refuses to replace a manual row, so a manual rate saved in the app
 * between our check and our write still wins.
 */
import { createClient } from '@libsql/client';
import { withDbRetry, withDbWriteRetry } from '../api/_lib/db.js';
import {
    EGYPT_DAILY_FX_HOUR,
    fetchUsdToEgpRateForDate,
    getEgyptDateTimeParts
} from '../fx-rates.js';

/**
 * Decides whether a run should fetch and save a rate.
 * `existing` is today's exchange_rates row (or null).
 */
export function decideFxRun({ hour, force = false, overwriteManual = false, existing = null }) {
    if (existing && existing.source === 'manual' && !overwriteManual) {
        return { run: false, reason: 'manual-override' };
    }
    if (force) return { run: true, reason: 'forced' };
    if (hour < EGYPT_DAILY_FX_HOUR) return { run: false, reason: 'before-noon' };
    if (hour === EGYPT_DAILY_FX_HOUR) return { run: true, reason: 'noon' };
    if (!existing) return { run: true, reason: 'late-catch-up' };
    return { run: false, reason: 'already-set-today' };
}

/** Upsert that never replaces a manual rate unless overwriteManual is set. */
export function buildFxUpsertSql({ overwriteManual = false } = {}) {
    return `INSERT INTO exchange_rates (rate_date, currency_pair, rate, source, updated_by, updated_at)
              VALUES (?, 'USD_EGP', ?, 'auto', 'daily-cron-12pm-egypt', ?)
              ON CONFLICT(rate_date, currency_pair) DO UPDATE SET
                rate = excluded.rate,
                source = excluded.source,
                updated_by = excluded.updated_by,
                updated_at = excluded.updated_at${overwriteManual ? '' : `
              WHERE exchange_rates.source <> 'manual'`}`;
}

export async function runFxUpdate({
    db,
    now = new Date(),
    force = false,
    overwriteManual = false,
    fetchRate = (dateStr) => fetchUsdToEgpRateForDate('latest', fetch, dateStr)
}) {
    const egyptNow = getEgyptDateTimeParts(now);
    const clock = `${egyptNow.dateStr} ${String(egyptNow.hour).padStart(2, '0')}:${String(egyptNow.minute).padStart(2, '0')} Africa/Cairo`;

    if (!force && egyptNow.hour < EGYPT_DAILY_FX_HOUR) {
        console.log(`[fx-cron] Current Egypt time (${clock}) is before 12:00 PM; skipping.`);
        return { updated: false, reason: 'before-noon' };
    }

    const existingRes = await withDbRetry(() => db.execute({
        sql: "SELECT rate_date, rate, source FROM exchange_rates WHERE rate_date = ? AND currency_pair = 'USD_EGP' LIMIT 1",
        args: [egyptNow.dateStr]
    }));
    const existing = existingRes.rows[0] || null;
    const decision = decideFxRun({ hour: egyptNow.hour, force, overwriteManual, existing });
    if (!decision.run) {
        if (decision.reason === 'manual-override') {
            console.log(`[fx-cron] Preserving manual USD -> EGP override (${existing.rate}) for ${egyptNow.dateStr}.`);
        } else {
            console.log(`[fx-cron] ${egyptNow.dateStr} already has an automatic rate (${existing?.rate}) and it is ${clock}; skipping.`);
        }
        return { updated: false, reason: decision.reason };
    }

    const res = await fetchRate(egyptNow.dateStr);
    if (!res || !(res.rate > 0)) {
        throw new Error('Failed to fetch a valid USD -> EGP exchange rate from all upstream providers.');
    }

    const write = await withDbWriteRetry(() => db.execute({
        sql: buildFxUpsertSql({ overwriteManual }),
        args: [egyptNow.dateStr, res.rate, now.toISOString()]
    }));
    if (!write.rowsAffected) {
        console.log(`[fx-cron] A manual rate was saved for ${egyptNow.dateStr} meanwhile; left it unchanged.`);
        return { updated: false, reason: 'manual-override' };
    }

    console.log(
        `[fx-cron] Updated USD -> EGP rate for ${egyptNow.dateStr} (${decision.reason}, ${clock}): ${res.rate} (provider: ${res.provider})`
    );
    return { updated: true, reason: decision.reason, rate: res.rate };
}

async function main() {
    const args = new Set(process.argv.slice(2));
    const url = process.env.TURSO_DATABASE_URL || '';
    if (!url) {
        throw new Error('Missing TURSO_DATABASE_URL environment variable.');
    }
    const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
    await runFxUpdate({
        db,
        force: args.has('--force'),
        overwriteManual: args.has('--overwrite-manual')
    });
}

if (process.argv[1] && process.argv[1].endsWith('update_fx_rate.js')) {
    main().catch(err => {
        console.error('[fx-cron] Error:', err?.message || err);
        process.exit(1);
    });
}
