import type {
  BusinessRulesResult,
  IdStatus,
  ItemMappingRecord,
  ManualFixRecord,
  StudentLevel,
  StudentMasterRecord,
  TransactionRecord
} from '../types/domain';
import {
  validateID as rawValidateID,
  isIdValidationExempt as rawIsIdValidationExempt,
  getEffectiveIdStatus as rawGetEffectiveIdStatus,
  isNonInvalidTransaction as rawIsNonInvalidTransaction,
  applyBusinessRules as rawApplyBusinessRules,
  diffTransaction as rawDiffTransaction,
  buildMappingLookup as rawBuildMappingLookup,
  normalizeItemName as rawNormalizeItemName,
  originalItemName as rawOriginalItemName,
  originalStudentId as rawOriginalStudentId,
  isLockedTransaction as rawIsLockedTransaction,
  escapeHTML as rawEscapeHTML,
  sanitizeExcelValue as rawSanitizeExcelValue,
  sanitizeExcelRows as rawSanitizeExcelRows,
  toDateOnly as rawToDateOnly,
  dateToExcelSerial as rawDateToExcelSerial,
  calculateSettlementDate as rawCalculateSettlementDate,
  isSameDaySettlementBank as rawIsSameDaySettlementBank,
  resolveErpJournalDate as rawResolveErpJournalDate,
  normalizeStudentIdValue as rawNormalizeStudentIdValue,
  getStudentProgramLevel as rawGetStudentProgramLevel,
  formatStudentLevelTag as rawFormatStudentLevelTag,
  ensureProgramHasLevelPrefix as rawEnsureProgramHasLevelPrefix,
  writeCompressedExcel as rawWriteCompressedExcel,
  toPeriodMonth as rawToPeriodMonth,
  isDateInClosedPeriods as rawIsDateInClosedPeriods,
  findClosedPeriodsInRows as rawFindClosedPeriodsInRows,
  formatPeriodMonthLabel as rawFormatPeriodMonthLabel
} from '../../rules.js';

export const validateID: (id: string | number | null | undefined) => IdStatus = rawValidateID;
export const isIdValidationExempt: (
  txOrMapping: Partial<TransactionRecord> | string | null | undefined,
  secondMapping?: string | null
) => boolean = rawIsIdValidationExempt as (
  txOrMapping: Partial<TransactionRecord> | string | null | undefined,
  secondMapping?: string | null
) => boolean;
export const getEffectiveIdStatus: (tx: Partial<TransactionRecord> | null | undefined) => IdStatus =
  rawGetEffectiveIdStatus;
export const isNonInvalidTransaction: (tx: Partial<TransactionRecord> | null | undefined) => boolean =
  rawIsNonInvalidTransaction;
export const applyBusinessRules: (
  base: { studentId: string | null; itemName: string },
  ctx: {
    link?: { custom_input_value?: string | null } | null;
    fix?: Partial<ManualFixRecord> | null;
    lookupMapping: (name: string) => ItemMappingRecord | undefined;
  }
) => BusinessRulesResult = rawApplyBusinessRules as unknown as (
  base: { studentId: string | null; itemName: string },
  ctx: {
    link?: { custom_input_value?: string | null } | null;
    fix?: Partial<ManualFixRecord> | null;
    lookupMapping: (name: string) => ItemMappingRecord | undefined;
  }
) => BusinessRulesResult;
export const diffTransaction: (
  tx: TransactionRecord,
  ctx: {
    link?: { custom_input_value?: string | null } | null;
    fix?: Partial<ManualFixRecord> | null;
    lookupMapping: (name: string) => ItemMappingRecord | undefined;
  }
) => {
  changed: boolean;
  fields: Partial<TransactionRecord>;
  changes: { field: string; label: string; from: unknown; to: unknown }[];
  reasons: string[];
  locked: boolean;
} = rawDiffTransaction as unknown as (
  tx: TransactionRecord,
  ctx: {
    link?: { custom_input_value?: string | null } | null;
    fix?: Partial<ManualFixRecord> | null;
    lookupMapping: (name: string) => ItemMappingRecord | undefined;
  }
) => {
  changed: boolean;
  fields: Partial<TransactionRecord>;
  changes: { field: string; label: string; from: unknown; to: unknown }[];
  reasons: string[];
  locked: boolean;
};
export const buildMappingLookup: (mappings: ItemMappingRecord[]) => (name: string) => ItemMappingRecord | undefined =
  rawBuildMappingLookup as unknown as (mappings: ItemMappingRecord[]) => (name: string) => ItemMappingRecord | undefined;
export const normalizeItemName: (name: string | null | undefined) => string = rawNormalizeItemName;
export const originalItemName: (tx: Partial<TransactionRecord>) => string = rawOriginalItemName;
export const originalStudentId: (tx: Partial<TransactionRecord>) => string | null = rawOriginalStudentId;
export const isLockedTransaction: (tx: Partial<TransactionRecord> | null | undefined) => boolean =
  rawIsLockedTransaction;
export const escapeHTML: (str: unknown) => string = rawEscapeHTML;
export const sanitizeExcelValue: <T>(val: T) => T | string = rawSanitizeExcelValue;
export const sanitizeExcelRows: <T extends Record<string, unknown>>(rows: T[]) => T[] = rawSanitizeExcelRows;
export const toDateOnly: (val: unknown) => string = rawToDateOnly;
export const dateToExcelSerial: (dateStr: string) => number | null = rawDateToExcelSerial;
export const calculateSettlementDate: (paymentDateStr: string, bank?: string) => string =
  rawCalculateSettlementDate;
export const isSameDaySettlementBank: (bank?: string | null) => boolean = rawIsSameDaySettlementBank;
export const resolveErpJournalDate: (tx: Partial<TransactionRecord>, mode?: string) => string =
  rawResolveErpJournalDate;
export const normalizeStudentIdValue: (raw: unknown) => string = rawNormalizeStudentIdValue;
export const getStudentProgramLevel: (
  studentOrProgram: Partial<StudentMasterRecord> | string | null | undefined
) => StudentLevel = rawGetStudentProgramLevel;
export const formatStudentLevelTag: (level: StudentLevel | string) => string = rawFormatStudentLevelTag;
export const ensureProgramHasLevelPrefix: (program: string | null | undefined, explicitLevel?: StudentLevel) => string =
  rawEnsureProgramHasLevelPrefix;
export const writeCompressedExcel: (wb: unknown, filename: string, opts?: Record<string, unknown>) => unknown =
  rawWriteCompressedExcel;
export const toPeriodMonth: (dateInput: unknown) => string = rawToPeriodMonth;
export const isDateInClosedPeriods: (
  dateInput: unknown,
  closedPeriodSet: Set<string> | string[] | null | undefined
) => boolean = rawIsDateInClosedPeriods;
export const findClosedPeriodsInRows: <T extends Record<string, unknown>>(
  rows: T[],
  closedPeriodSet: Set<string> | string[] | null | undefined,
  dateGetter?: string | ((row: T) => unknown)
) => { blockedRows: T[]; closedMonths: string[] } = rawFindClosedPeriodsInRows as unknown as <
  T extends Record<string, unknown>
>(
  rows: T[],
  closedPeriodSet: Set<string> | string[] | null | undefined,
  dateGetter?: string | ((row: T) => unknown)
) => { blockedRows: T[]; closedMonths: string[] };
export const formatPeriodMonthLabel: (periodMonth: string | null | undefined) => string =
  rawFormatPeriodMonthLabel;
