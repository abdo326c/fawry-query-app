/**
 * Daily USD -> EGP FX rate updater scheduled for 12:00 PM Africa/Cairo time.
 * Fetches the live USD -> EGP rate and upserts it into Supabase `exchange_rates`.
 * Intended to run from GitHub Actions (`0 9,10 * * *` UTC) or manually with `--force`.
 */
import {
    EGYPT_DAILY_FX_HOUR,
    fetchUsdToEgpRateForDate,
    getEgyptDateTimeParts
} from '../fx-rates.js';

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const overwriteManual = args.has('--overwrite-manual');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';

async function main() {
    const now = new Date();
    const egyptNow = getEgyptDateTimeParts(now);

    if (!force && egyptNow.hour !== EGYPT_DAILY_FX_HOUR) {
        console.log(
            `[fx-cron] Current Egypt time (${egyptNow.dateStr} ${String(egyptNow.hour).padStart(2, '0')}:${String(egyptNow.minute).padStart(2, '0')} Africa/Cairo) is not 12:00 PM; skipping.`
        );
        return;
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable.');
    }

    const res = await fetchUsdToEgpRateForDate('latest', fetch, egyptNow.dateStr);
    if (!res || !(res.rate > 0)) {
        throw new Error('Failed to fetch a valid USD -> EGP exchange rate from all upstream providers.');
    }

    const headers = {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
    };

    if (!overwriteManual) {
        const checkUrl = `${SUPABASE_URL}/rest/v1/exchange_rates?rate_date=eq.${encodeURIComponent(egyptNow.dateStr)}&currency_pair=eq.USD_EGP&select=rate_date,rate,source`;
        const checkRes = await fetch(checkUrl, { headers });
        if (checkRes.ok) {
            const rows = await checkRes.json();
            if (Array.isArray(rows) && rows[0]?.source === 'manual') {
                console.log(`[fx-cron] Preserving manual USD -> EGP override (${rows[0].rate}) for ${egyptNow.dateStr}.`);
                return;
            }
        }
    }

    const nowIso = now.toISOString();
    const upsertUrl = `${SUPABASE_URL}/rest/v1/exchange_rates?on_conflict=rate_date,currency_pair`;
    const upsertRes = await fetch(upsertUrl, {
        method: 'POST',
        headers: {
            ...headers,
            Prefer: 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify([{
            rate_date: egyptNow.dateStr,
            currency_pair: 'USD_EGP',
            rate: res.rate,
            source: 'auto',
            updated_by: 'daily-cron-12pm-egypt',
            updated_at: nowIso
        }])
    });

    if (!upsertRes.ok) {
        const errText = await upsertRes.text();
        throw new Error(`Supabase upsert failed (${upsertRes.status}): ${errText}`);
    }

    console.log(
        `[fx-cron] Updated USD -> EGP rate for ${egyptNow.dateStr} at 12:00 PM Egypt: ${res.rate} (provider: ${res.provider})`
    );
}

main().catch(err => {
    console.error('[fx-cron] Error:', err?.message || err);
    process.exit(1);
});
