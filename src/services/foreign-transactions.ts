import type { ForeignTransactionRecord, StudentMasterRecord } from '../types/domain';
import {
  parseStatementDate as rawParseStatementDate,
  parseBankStatementGrid as rawParseBankStatementGrid,
  parseBanqueMisrPdfText as rawParseBanqueMisrPdfText,
  reconstructBanqueMisrPdfLinesFromPages as rawReconstructBanqueMisrPdfLinesFromPages,
  matchForeignDepositsToStudents as rawMatchForeignDepositsToStudents,
  normalizePersonName as rawNormalizePersonName,
  DEFAULT_FOREIGN_BANK as rawDefaultForeignBank,
  DEFAULT_FOREIGN_MAPPING as rawDefaultForeignMapping
} from '../../foreign-transactions.js';

export const DEFAULT_FOREIGN_BANK: string = rawDefaultForeignBank;
export const DEFAULT_FOREIGN_MAPPING: string = rawDefaultForeignMapping;

export interface ParsedStatementResult {
  metadata: {
    customerName: string;
    accountNumber: string;
    iban: string;
    currency: string;
    branch: string;
    dateFrom: string;
    dateTo: string;
  };
  deposits: ForeignTransactionRecord[];
  excludedReversals: unknown[];
  excludedTreasury: unknown[];
}

export const parseStatementDate: (raw: unknown) => {
  dateOnly: string | null;
  dateTime: string;
} = rawParseStatementDate;

export const parseBankStatementGrid: (gridRows: unknown[][]) => ParsedStatementResult =
  rawParseBankStatementGrid as unknown as (gridRows: unknown[][]) => ParsedStatementResult;

export const parseBanqueMisrPdfText: (fullText: string) => ParsedStatementResult =
  rawParseBanqueMisrPdfText as unknown as (fullText: string) => ParsedStatementResult;

export const reconstructBanqueMisrPdfLinesFromPages: (pages: unknown[]) => string =
  rawReconstructBanqueMisrPdfLinesFromPages;

export const matchForeignDepositsToStudents: (
  deposits: Partial<ForeignTransactionRecord>[],
  students: Partial<StudentMasterRecord>[]
) => ForeignTransactionRecord[] = rawMatchForeignDepositsToStudents;

export const normalizePersonName: (name: string | null | undefined) => string =
  rawNormalizePersonName;
