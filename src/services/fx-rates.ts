import type { FxStore } from '../types/domain';
import {
  createEmptyFxStore as rawCreateEmptyFxStore,
  loadFxStore as rawLoadFxStore,
  saveFxStore as rawSaveFxStore,
  resolveUsdToEgpRate as rawResolveUsdToEgpRate,
  convertUsdToEgp as rawConvertUsdToEgp,
  fetchUsdToEgpRateForDate as rawFetchUsdToEgpRateForDate,
  syncMissingFxRates as rawSyncMissingFxRates,
  setManualFxRate as rawSetManualFxRate,
  getEgyptDateTimeParts as rawGetEgyptDateTimeParts,
  getMsUntilNextEgyptNoon as rawGetMsUntilNextEgyptNoon,
  isRateStaleForEgyptNoon as rawIsRateStaleForEgyptNoon
} from '../../fx-rates.js';

export const createEmptyFxStore: () => FxStore = rawCreateEmptyFxStore as unknown as () => FxStore;
export const loadFxStore: (storage?: Storage | null) => FxStore =
  rawLoadFxStore as unknown as (storage?: Storage | null) => FxStore;
export const saveFxStore: (store: FxStore, storage?: Storage | null) => void =
  rawSaveFxStore as unknown as (store: FxStore, storage?: Storage | null) => void;
export const resolveUsdToEgpRate: (
  dateStr: string | null | undefined,
  store?: FxStore,
  opts?: { mode?: string | null; customRate?: number | null }
) => { rate: number; source: string; rateDate: string; fallback: boolean } =
  rawResolveUsdToEgpRate as unknown as (
    dateStr: string | null | undefined,
    store?: FxStore,
    opts?: { mode?: string | null; customRate?: number | null }
  ) => { rate: number; source: string; rateDate: string; fallback: boolean };
export const convertUsdToEgp: (
  usdAmount: number,
  dateStr?: string | null,
  store?: FxStore,
  opts?: Record<string, unknown>
) => {
  usdAmount: number;
  egpAmount: number;
  rate: number;
  source: string;
  rateDate: string;
  fallback: boolean;
} = rawConvertUsdToEgp as unknown as (
  usdAmount: number,
  dateStr?: string | null,
  store?: FxStore,
  opts?: Record<string, unknown>
) => {
  usdAmount: number;
  egpAmount: number;
  rate: number;
  source: string;
  rateDate: string;
  fallback: boolean;
};
export const fetchUsdToEgpRateForDate: (
  dateStr?: string,
  fetchImpl?: typeof fetch,
  todayStr?: string
) => Promise<{ date: string; rate: number; source: string } | null> = rawFetchUsdToEgpRateForDate;
export const syncMissingFxRates: (
  dates: string[] | undefined,
  store?: FxStore,
  options?: {
    fetchImpl?: typeof fetch | null;
    concurrency?: number;
    forceLatest?: boolean;
    todayStr?: string;
    now?: Date;
  }
) => Promise<{
  updatedCount: number;
  updatedRecords: unknown[];
  latestUpdated: boolean;
  failedCount: number;
}> = rawSyncMissingFxRates as unknown as (
  dates: string[] | undefined,
  store?: FxStore,
  options?: {
    fetchImpl?: typeof fetch | null;
    concurrency?: number;
    forceLatest?: boolean;
    todayStr?: string;
    now?: Date;
  }
) => Promise<{
  updatedCount: number;
  updatedRecords: unknown[];
  latestUpdated: boolean;
  failedCount: number;
}>;
export const setManualFxRate: (
  store: FxStore,
  opts?: { dateStr?: string | null; rate?: number; applyAsLatest?: boolean; customMode?: boolean }
) => FxStore = rawSetManualFxRate as unknown as (
  store: FxStore,
  opts?: { dateStr?: string | null; rate?: number; applyAsLatest?: boolean; customMode?: boolean }
) => FxStore;
export const getEgyptDateTimeParts: (now?: Date) => {
  dateStr: string;
  hour: number;
  minute: number;
  second: number;
} = rawGetEgyptDateTimeParts;
export const getMsUntilNextEgyptNoon: (now?: Date) => number = rawGetMsUntilNextEgyptNoon;
export const isRateStaleForEgyptNoon: (store?: FxStore, now?: Date) => boolean =
  rawIsRateStaleForEgyptNoon;
