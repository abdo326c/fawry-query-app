import { toDateOnly } from './rules.js';

export const FX_STORAGE_KEY = 'fawry_app_fx_rates_v1';
export const DEFAULT_FX_MODE = 'historical'; // 'historical' | 'latest' | 'custom'
export const DEFAULT_USD_EGP_FALLBACK_RATE = 49.5;
export const EGYPT_TIMEZONE = 'Africa/Cairo';
export const EGYPT_DAILY_FX_HOUR = 12;

/**
 * Returns YYYY-MM-DD and 24-hour clock parts in Egypt time (Africa/Cairo),
 * handling winter (UTC+2) and summer DST (UTC+3) regardless of local OS timezone.
 */
export function getEgyptDateTimeParts(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    const valid = Number.isNaN(d.getTime()) ? new Date() : d;
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: EGYPT_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    });
    const parts = {};
    for (const p of fmt.formatToParts(valid)) {
        if (p.type !== 'literal') parts[p.type] = p.value;
    }
    const hour = Number(parts.hour) % 24;
    const minute = Number(parts.minute) || 0;
    const second = Number(parts.second) || 0;
    return {
        dateStr: `${parts.year}-${parts.month}-${parts.day}`,
        hour,
        minute,
        second
    };
}

/**
 * Resolves the exact epoch milliseconds for a target hour (default 12:00:00 PM) on `dateStr`
 * in Africa/Cairo timezone, automatically adjusting for EET (UTC+2) vs EEST DST (UTC+3).
 */
export function getEgyptNoonTimestampMs(dateStr, targetHour = EGYPT_DAILY_FX_HOUR) {
    const [y, m, d] = String(dateStr || '').split('-').map(Number);
    if (!y || !m || !d) return NaN;
    // Egypt uses UTC+2 or UTC+3; probe UTC+2 first and adjust if Cairo clock differs
    const utcBase = Date.UTC(y, m - 1, d, targetHour, 0, 0, 0);
    let candidate = utcBase - 2 * 3600 * 1000;
    const probe = getEgyptDateTimeParts(new Date(candidate));
    if (probe.dateStr === dateStr && probe.hour === targetHour) {
        return candidate;
    }
    // Try DST offset (UTC+3) or compute exact hour difference
    const alt = utcBase - 3 * 3600 * 1000;
    const altProbe = getEgyptDateTimeParts(new Date(alt));
    if (altProbe.dateStr === dateStr && altProbe.hour === targetHour) {
        return alt;
    }
    const diffHours = probe.hour - targetHour;
    return candidate - diffHours * 3600 * 1000;
}

/**
 * Returns milliseconds from `now` until the next `targetHour`:00:00 Egypt time.
 */
export function getMsUntilNextEgyptNoon(now = new Date(), targetHour = EGYPT_DAILY_FX_HOUR) {
    const validNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    const { dateStr } = getEgyptDateTimeParts(validNow);
    const todayNoonMs = getEgyptNoonTimestampMs(dateStr, targetHour);
    if (Number.isFinite(todayNoonMs) && validNow.getTime() < todayNoonMs) {
        return Math.max(1000, todayNoonMs - validNow.getTime());
    }
    const [y, m, d] = dateStr.split('-').map(Number);
    const nextDateStr = toDateOnly(new Date(Date.UTC(y, m - 1, d + 1, 12, 0, 0)));
    const nextNoonMs = getEgyptNoonTimestampMs(nextDateStr, targetHour);
    if (!Number.isFinite(nextNoonMs)) return 24 * 3600 * 1000;
    return Math.max(1000, nextNoonMs - validNow.getTime());
}

/**
 * Returns true if the stored `latest` FX entry should be refreshed for today's 12:00 PM Egypt schedule.
 * Manual overrides for today are preserved until overwritten explicitly.
 */
export function isRateStaleForEgyptNoon(entry, now = new Date(), targetHour = EGYPT_DAILY_FX_HOUR) {
    if (!entry || !(Number(entry.rate) > 0)) return true;
    const { dateStr: egyptToday, hour } = getEgyptDateTimeParts(now);
    const entryDate = entry.date || '';
    if (entry.source === 'manual' && entryDate === egyptToday) return false;
    if (entryDate !== egyptToday) return true;
    if (hour >= targetHour) {
        const todayNoonMs = getEgyptNoonTimestampMs(egyptToday, targetHour);
        const updatedMs = entry.updatedAt ? Date.parse(entry.updatedAt) : NaN;
        if (!Number.isFinite(updatedMs) || (Number.isFinite(todayNoonMs) && updatedMs < todayNoonMs)) {
            return true;
        }
    }
    return false;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

export function createEmptyFxStore() {
    return {
        mode: DEFAULT_FX_MODE,
        customRate: null,
        latest: null,
        ratesByDate: {}
    };
}

export function loadFxStore(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
    const empty = createEmptyFxStore();
    if (!storage) return empty;
    try {
        const raw = storage.getItem(FX_STORAGE_KEY);
        if (!raw) return empty;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return empty;
        const mode = ['historical', 'latest', 'custom'].includes(parsed.mode) ? parsed.mode : DEFAULT_FX_MODE;
        const customRate = Number(parsed.customRate) > 0 ? round4(parsed.customRate) : null;
        const latest = parsed.latest && Number(parsed.latest.rate) > 0
            ? {
                date: toDateOnly(parsed.latest.date) || '',
                rate: round4(parsed.latest.rate),
                source: parsed.latest.source || 'auto',
                provider: parsed.latest.provider || '',
                updatedAt: parsed.latest.updatedAt || ''
            }
            : null;
        const ratesByDate = {};
        if (parsed.ratesByDate && typeof parsed.ratesByDate === 'object') {
            for (const [k, v] of Object.entries(parsed.ratesByDate)) {
                const cleanDate = toDateOnly(k);
                const r = Number(v?.rate);
                if (cleanDate && r > 0) {
                    ratesByDate[cleanDate] = {
                        rate: round4(r),
                        source: v.source || 'auto',
                        provider: v.provider || '',
                        updatedAt: v.updatedAt || ''
                    };
                }
            }
        }
        return { mode, customRate, latest, ratesByDate };
    } catch (_e) {
        return empty;
    }
}

export function saveFxStore(store, storage = typeof localStorage !== 'undefined' ? localStorage : null) {
    if (!storage || !store) return;
    try {
        storage.setItem(FX_STORAGE_KEY, JSON.stringify(store));
    } catch (_e) {
        // Ignore storage quota errors cleanly
    }
}

/**
 * Extracts USD -> EGP numeric rate from supported JSON FX API payloads.
 */
export function extractUsdEgpFromPayload(data) {
    if (!data || typeof data !== 'object') return null;
    const raw = data?.usd?.egp ?? data?.USD?.EGP ?? data?.rates?.EGP ?? data?.rates?.egp;
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) return null;
    return round4(num);
}

async function fetchJsonWithTimeout(url, fetchImpl, timeoutMs = 4500) {
    if (typeof fetchImpl !== 'function') return null;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
        const res = await fetchImpl(url, controller ? { signal: controller.signal } : undefined);
        if (!res || !res.ok) return null;
        return await res.json();
    } catch (_e) {
        return null;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Fetches USD -> EGP exchange rate from CORS-friendly public FX feeds
 * for a given 'YYYY-MM-DD' date or 'latest'. Returns null when unavailable.
 */
export async function fetchUsdToEgpRateForDate(dateOrLatest = 'latest', fetchImpl = typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null, todayStr = toDateOnly(new Date())) {
    const isLatestReq = !dateOrLatest || dateOrLatest === 'latest';
    const targetDate = isLatestReq ? null : toDateOnly(dateOrLatest);
    if (!isLatestReq && !targetDate) return null;

    const latestCandidates = [
        { url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', provider: 'currency-api' },
        { url: 'https://open.er-api.com/v6/latest/USD', provider: 'open-er-api' },
        { url: 'https://latest.currency-api.pages.dev/v1/currencies/usd.json', provider: 'currency-api-pages' }
    ];

    const candidates = (isLatestReq || (targetDate && todayStr && targetDate >= todayStr))
        ? latestCandidates
        : [
            { url: `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${targetDate}/v1/currencies/usd.json`, provider: 'currency-api' },
            { url: `https://${targetDate}.currency-api.pages.dev/v1/currencies/usd.json`, provider: 'currency-api-pages' },
            // Fallback to latest rate if historical snapshot for targetDate is not published
            ...latestCandidates
        ];

    for (const c of candidates) {
        const payload = await fetchJsonWithTimeout(c.url, fetchImpl);
        const rate = extractUsdEgpFromPayload(payload);
        if (rate) {
            const payloadDate = toDateOnly(payload?.date) || targetDate || todayStr || '';
            return {
                rate,
                date: targetDate || payloadDate,
                source: 'auto',
                provider: c.provider,
                updatedAt: new Date().toISOString()
            };
        }
    }
    return null;
}

/**
 * Stores a user-entered manual override rate (per-date, latest, and/or custom global override).
 */
export function setManualFxRate(store, { dateStr = null, rate, applyAsLatest = true, customMode = false } = {}) {
    const cleanRate = Number(rate);
    if (!Number.isFinite(cleanRate) || cleanRate <= 0) return store;
    const rounded = round4(cleanRate);
    const nowIso = new Date().toISOString();
    const cleanDate = toDateOnly(dateStr);

    const next = {
        mode: customMode ? 'custom' : (store?.mode || DEFAULT_FX_MODE),
        customRate: customMode ? rounded : (store?.customRate ?? null),
        latest: store?.latest ? { ...store.latest } : null,
        ratesByDate: { ...(store?.ratesByDate || {}) }
    };

    if (cleanDate) {
        next.ratesByDate[cleanDate] = {
            rate: rounded,
            source: 'manual',
            provider: 'manual-override',
            updatedAt: nowIso
        };
    }
    if (applyAsLatest) {
        next.latest = {
            date: cleanDate || next.latest?.date || toDateOnly(new Date()),
            rate: rounded,
            source: 'manual',
            provider: 'manual-override',
            updatedAt: nowIso
        };
    }
    return next;
}

/**
 * Resolves the USD -> EGP exchange rate for a deposit date given active mode and cache:
 * - 'custom': uses store.customRate
 * - 'latest': uses store.latest.rate
 * - 'historical': exact date match -> nearest prior date -> nearest future date -> store.latest
 */
export function resolveUsdToEgpRate(dateStr, store, { mode = null, customRate = null } = {}) {
    const activeMode = mode || store?.mode || DEFAULT_FX_MODE;
    const override = Number(customRate ?? store?.customRate);

    if (activeMode === 'custom') {
        if (Number.isFinite(override) && override > 0) {
            return { rate: round4(override), source: 'custom', rateDate: 'Custom', fallback: false };
        }
    }

    if (activeMode === 'latest') {
        if (store?.latest?.rate > 0) {
            return {
                rate: round4(store.latest.rate),
                source: store.latest.source || 'latest',
                rateDate: store.latest.date || '',
                fallback: false
            };
        }
    }

    const ratesByDate = store?.ratesByDate || {};
    const cleanDate = toDateOnly(dateStr);

    if (cleanDate && ratesByDate[cleanDate]?.rate > 0) {
        return {
            rate: round4(ratesByDate[cleanDate].rate),
            source: ratesByDate[cleanDate].source || 'auto',
            rateDate: cleanDate,
            fallback: false
        };
    }

    // Reuse cached sorted date array when available and valid to avoid O(D log D) sorting per row
    const keyCount = Object.keys(ratesByDate).length;
    let availableDates = store?._sortedDates;
    if (!Array.isArray(availableDates) || store?._sortedDatesCount !== keyCount) {
        availableDates = Object.keys(ratesByDate)
            .filter(d => ratesByDate[d]?.rate > 0)
            .sort();
        if (store && typeof store === 'object') {
            store._sortedDates = availableDates;
            store._sortedDatesCount = keyCount;
        }
    }

    if (cleanDate && availableDates.length > 0) {
        // Nearest prior date first
        let bestPrior = null;
        for (let i = availableDates.length - 1; i >= 0; i--) {
            if (availableDates[i] <= cleanDate) {
                bestPrior = availableDates[i];
                break;
            }
        }
        const chosenDate = bestPrior || availableDates[0];
        return {
            rate: round4(ratesByDate[chosenDate].rate),
            source: ratesByDate[chosenDate].source || 'auto',
            rateDate: chosenDate,
            fallback: true
        };
    }

    if (store?.latest?.rate > 0) {
        return {
            rate: round4(store.latest.rate),
            source: store.latest.source || 'latest',
            rateDate: store.latest.date || '',
            fallback: true
        };
    }

    return {
        rate: DEFAULT_USD_EGP_FALLBACK_RATE,
        source: 'fallback',
        rateDate: '',
        fallback: true
    };
}

/**
 * Converts a USD deposit amount into EGP for reporting using resolveUsdToEgpRate.
 */
export function convertUsdToEgp(amountUsd, dateStr, store, opts = {}) {
    const usdAmount = round2(amountUsd);
    const resolved = resolveUsdToEgpRate(dateStr, store, opts);
    const egpAmount = resolved.rate > 0 ? round2(usdAmount * resolved.rate) : 0;
    return {
        usdAmount,
        egpAmount,
        rate: resolved.rate,
        source: resolved.source,
        rateDate: resolved.rateDate,
        fallback: resolved.fallback
    };
}

/**
 * Fetches today's latest rate (when stale) and any missing historical dates with bounded concurrency.
 * Never overwrites manual overrides. Returns summary of synced records.
 */
export async function syncMissingFxRates(dates = [], store, { fetchImpl = typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null, concurrency = 4, todayStr, now = new Date(), forceLatest = false } = {}) {
    const targetStore = store || createEmptyFxStore();
    if (!targetStore.ratesByDate) targetStore.ratesByDate = {};
    const updatedRecords = [];
    let latestUpdated = false;
    let failedCount = 0;

    const validNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    const egyptNow = getEgyptDateTimeParts(validNow);
    const effectiveTodayStr = todayStr || egyptNow.dateStr;

    // 1. Refresh daily latest rate when stale for today's 12:00 PM Egypt schedule (don't overwrite today's manual override unless forced)
    const isLatestManualToday = targetStore.latest?.source === 'manual' && targetStore.latest?.date === effectiveTodayStr;
    const staleForSchedule = todayStr && todayStr !== egyptNow.dateStr
        ? (!targetStore.latest?.rate || (targetStore.latest.date !== effectiveTodayStr && !isLatestManualToday))
        : isRateStaleForEgyptNoon(targetStore.latest, validNow);
    const shouldRefreshLatest = forceLatest || (!isLatestManualToday && staleForSchedule);
    if (shouldRefreshLatest) {
        const latestRes = await fetchUsdToEgpRateForDate('latest', fetchImpl, effectiveTodayStr);
        if (latestRes && latestRes.rate > 0) {
            const latestDate = effectiveTodayStr || latestRes.date;
            const fetchTimestampIso = validNow.toISOString();
            if (!targetStore.latest || forceLatest || targetStore.latest.source !== 'manual' || targetStore.latest.date !== effectiveTodayStr) {
                targetStore.latest = {
                    date: latestDate,
                    rate: latestRes.rate,
                    source: 'auto',
                    provider: latestRes.provider,
                    updatedAt: fetchTimestampIso
                };
                latestUpdated = true;
            }
            if (latestDate && (!targetStore.ratesByDate[latestDate] || targetStore.ratesByDate[latestDate].source !== 'manual')) {
                targetStore.ratesByDate[latestDate] = {
                    rate: latestRes.rate,
                    source: 'auto',
                    provider: latestRes.provider,
                    updatedAt: fetchTimestampIso
                };
                updatedRecords.push({ rate_date: latestDate, ...targetStore.ratesByDate[latestDate] });
            }
        } else {
            failedCount++;
        }
    }

    // 2. Fetch any missing historical dates in parallel batches
    const uniqueMissing = [...new Set(
        (dates || [])
            .map(d => toDateOnly(d))
            .filter(d => d && (!todayStr || d <= todayStr) && !targetStore.ratesByDate[d])
    )].sort();

    for (let i = 0; i < uniqueMissing.length; i += concurrency) {
        const chunk = uniqueMissing.slice(i, i + concurrency);
        const results = await Promise.all(chunk.map(async (d) => {
            const fetched = await fetchUsdToEgpRateForDate(d, fetchImpl, todayStr);
            return { d, fetched };
        }));
        for (const { d, fetched } of results) {
            if (fetched && fetched.rate > 0) {
                targetStore.ratesByDate[d] = {
                    rate: fetched.rate,
                    source: 'auto',
                    provider: fetched.provider,
                    updatedAt: fetched.updatedAt
                };
                updatedRecords.push({ rate_date: d, ...targetStore.ratesByDate[d] });
            } else {
                failedCount++;
            }
        }
    }

    if (updatedRecords.length > 0 && targetStore) {
        delete targetStore._sortedDates;
        delete targetStore._sortedDatesCount;
    }

    return {
        updatedCount: updatedRecords.length,
        updatedRecords,
        latestUpdated,
        failedCount
    };
}
