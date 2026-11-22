import { validateID, toDateOnly, normalizeStudentIdValue } from './rules.js';

export const DEFAULT_FOREIGN_BANK = 'NuMisrUsd5';
export const DEFAULT_FOREIGN_MAPPING = 'Tuition';

/**
 * Normalizes Arabic and English text for fuzzy student name comparison.
 * Unifies Alef variants (أ/إ/آ -> ا), Teh Marbuta (ة -> ه), Alef Maksura (ى -> ي),
 * collapses compound 'عبد ' prefixes ('عبد الرحمن' -> 'عبدالرحمن'), and strips diacritics.
 */
export function normalizePersonName(str) {
    if (!str) return '';
    return String(str)
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // strip tashkeel & tatweel
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/[ىئ]/g, 'ي')
        .replace(/ؤ/g, 'و')
        .replace(/عبد\s+ال/g, 'عبدال')
        .replace(/ابو\s+/g, 'ابو')
        .replace(/بن\s+/g, 'بن')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Parses a numeric amount from bank statement cells (handles commas, spaces, parentheses).
 */
export function parseStatementAmount(val) {
    if (val === null || val === undefined || val === '') return 0;
    if (typeof val === 'number') return isNaN(val) ? 0 : Math.round(val * 100) / 100;
    const cleaned = String(val).replace(/,/g, '').replace(/[^\d.-]/g, '').trim();
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : Math.round(num * 100) / 100;
}

/**
 * Normalizes a bank statement date or date-time string into:
 *   { dateOnly: 'YYYY-MM-DD', dateTime: 'YYYY-MM-DD HH:MM:SS' }
 * Handles both 'YYYY-MM-DD HH:MM:SS' (CSV) and 'DD-MM-YYYY HH:MM:SS' (PDF).
 */
function isoIfValidDate(y, m, d) {
    const yi = Number(y), mi = Number(m), di = Number(d);
    if (!(mi >= 1 && mi <= 12 && di >= 1 && di <= 31)) return null;
    const dt = new Date(Date.UTC(yi, mi - 1, di));
    if (dt.getUTCFullYear() !== yi || dt.getUTCMonth() !== mi - 1 || dt.getUTCDate() !== di) return null;
    return `${String(yi).padStart(4, '0')}-${String(mi).padStart(2, '0')}-${String(di).padStart(2, '0')}`;
}

export function parseStatementDate(raw) {
    if (!raw) return { dateOnly: null, dateTime: '' };
    // Real Excel date cells arrive as serial numbers (e.g. 45672.5 = 2025-01-14 12:00:00)
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        const iso = toDateOnly(raw);
        if (!iso) return { dateOnly: null, dateTime: '' };
        const totalSec = Math.round((raw - Math.floor(raw)) * 86400);
        if (totalSec <= 0 || totalSec >= 86400) return { dateOnly: iso, dateTime: iso };
        const pad = n => String(n).padStart(2, '0');
        const hh = Math.floor(totalSec / 3600), mm = Math.floor((totalSec % 3600) / 60), ss = totalSec % 60;
        return { dateOnly: iso, dateTime: `${iso} ${pad(hh)}:${pad(mm)}:${pad(ss)}` };
    }
    if (raw instanceof Date) {
        const iso = toDateOnly(raw);
        return { dateOnly: iso, dateTime: iso || '' };
    }
    const str = String(raw).trim();
    if (!str) return { dateOnly: null, dateTime: '' };

    const parts = str.split(/\s+/);
    const datePart = parts[0] || '';
    const timePart = parts[1] || '';

    let m = datePart.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);
    if (m) {
        const iso = isoIfValidDate(m[1], m[2], m[3]);
        if (!iso) return { dateOnly: null, dateTime: str };
        return { dateOnly: iso, dateTime: timePart ? `${iso} ${timePart}` : iso };
    }
    m = datePart.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if (m) {
        const day = parseInt(m[1], 10);
        const month = parseInt(m[2], 10);
        const year = m[3];
        const iso = isoIfValidDate(year, month, day);
        if (!iso) return { dateOnly: null, dateTime: str };
        return { dateOnly: iso, dateTime: timePart ? `${iso} ${timePart}` : iso };
    }

    const fallback = toDateOnly(str);
    return { dateOnly: fallback, dateTime: str };
}

/**
 * Decomposes a Banque Misr / Egyptian bank deposit narrative (Arabic or English) into:
 * - studentId: 9-digit NU ID (e.g. '241000261') or null
 * - studentName: Extracted student name (before 'بمناولة' / 'مناولة')
 * - handlerName: Extracted depositor/handler name (after 'بمناولة' / 'مناولة')
 * - depositMethod: 'Cash Deposit' | 'SWIFT Transfer' | 'Bank Deposit'
 */
export function parseStudentDepositNarrative(description, txCode = '') {
    const raw = String(description || '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (!raw) {
        return { studentId: null, studentName: '', handlerName: '', depositMethod: 'Bank Deposit' };
    }

    const upperCode = String(txCode || '').toUpperCase().trim();
    let depositMethod = 'Cash Deposit';
    if (upperCode === 'T35' || /SWIFT\s+TRANSFER/i.test(raw) || /تحاويل\s+واردة/i.test(raw)) {
        depositMethod = 'SWIFT Transfer';
    }

    // 1. Extract 9-digit NU Student ID (starts with 20..29, 9 digits) or DIP ID
    // Avoid matching 16-digit bank account / TD numbers by requiring word/non-digit boundaries
    let studentId = null;
    const dipMatch = raw.match(/(?:^|[^\dA-Za-z])(DIP\d{10,16})(?:$|[^\dA-Za-z])/i);
    if (dipMatch) {
        studentId = dipMatch[1].toUpperCase();
    } else {
        const idMatch = raw.match(/(?:^|[^\d])(2\d{8})(?:$|[^\d])/);
        if (idMatch) {
            studentId = idMatch[1];
        }
    }

    // 2. Clean known bank prefixes & boilerplate tokens
    let work = raw
        .replace(/\uFFFD/g, ' ')
        .replace(/^(?:ايداع نقدى|إيداع نقدي|ايداع نقدي)\s*\|?\s*/i, '')
        .replace(/\b(?:Cash\s+Deposit|Deposit\s+Cash)\b\s*\|?\s*/gi, ' ')
        .replace(/INCOMING\s+SWIFT\s+TRANSFER\s+OUTSIDE\s+EGYPT\s*[-|]?\s*/gi, ' ')
        .replace(/\/ROC\/.*$/i, ' ')
        .replace(/\/NCBK[A-Z0-9]+\/.*$/i, ' ')
        .replace(/\/\/\/URI\/.*$/i, ' ')
        .replace(/(?:id\s*no|id)\s*[:\/-]?\s*2\d{8}/gi, ' ')
        .replace(/2\d{8}\s*(?:id\s*no|id)\b/gi, ' ')
        .replace(/(?:^|[^\d])2\d{8}(?:$|[^\d])/g, ' ')
        .replace(/\b(?:id\s*no|id)\b\s*[:\/-]*/gi, ' ');

    // 3. Split on 'بمناولة' / 'مناولة' / 'مناوله' to separate Student Name from Handler Name
    let studentPart = work;
    let handlerPart = '';
    const handlerRegex = /(?:بمناولة|بمناوله|مناولة|مناوله)\s*[\/:-]?\s*/i;
    const hMatch = work.match(handlerRegex);
    if (hMatch) {
        const idx = hMatch.index;
        const before = work.slice(0, idx).trim();
        const after = work.slice(idx + hMatch[0].length).trim();
        studentPart = before;
        handlerPart = after;
    }

    const cleanSegment = (seg) => {
        return String(seg || '')
            .replace(/[|\/\\]+/g, ' ')
            .replace(/(?:^|\s)[-–—]+(?:\s|$)/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/^[-–—\/|:\s]+|[-–—\/|:\s]+$/g, '')
            .trim();
    };

    let studentName = cleanSegment(studentPart);
    let handlerName = cleanSegment(handlerPart);

    if (!studentName && handlerName) {
        studentName = handlerName;
        handlerName = '';
    }

    return {
        studentId,
        studentName,
        handlerName,
        depositMethod
    };
}

/**
 * Classifies whether a statement row is a non-student bank/treasury operation.
 */
export function isTreasuryOrNonStudentRow(row) {
    const code = String(row.transaction_code || '').toUpperCase().trim();
    const event = String(row.event || '').toUpperCase().trim();
    const desc = String(row.description || '').trim();

    if (event === 'DEBK' || event === 'ILIQ' || event === 'IMAT') return true;
    if (['TD1', 'TD2', 'TD3', 'TD4', 'T02', 'T06'].includes(code)) return true;

    if (/عائد ودائع|تجديد\s*\/\s*الغاء وديعة|عمولة تحاويل|تحاويل صادرة/i.test(desc)) return true;
    if (/Booking\s+TD\s+Number|TD\s+Interest\s+Number|Auto\s+Renew\/cancel\s+CD/i.test(desc)) return true;

    return false;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Integrity checks on a parsed statement. Returns { errors, warnings } (arrays of strings).
 * Errors mean the reading is provably wrong or incomplete and the import must not go ahead.
 *  - running balance: every row's Balance After = previous balance + credit - debit
 *    (catches a missing, duplicated or misread amount)
 *  - totals: credits - debits = last balance - opening balance
 *  - descriptions: text that looks glued from two rows (warnings, shown in the preview)
 */
export function checkStatementIntegrity(rows, deposits, metadata = {}) {
    const errors = [...(metadata.formatErrors || [])];
    const warnings = [...(metadata.formatWarnings || [])];
    const chain = (rows || []).filter(r => Number.isFinite(r.balance_after) && (r.credit > 0 || r.debit > 0));

    if (chain.length > 0) {
        const opening = Number.isFinite(metadata.openingBalance) ? metadata.openingBalance : null;
        const breaks = [];
        let prev = opening;
        chain.forEach((r, i) => {
            if (prev !== null) {
                const expected = round2(prev + r.credit - r.debit);
                if (Math.abs(expected - r.balance_after) > 0.01) {
                    breaks.push(`row ${r._rowIndex}${r.external_ref || r.transaction_ref ? ` (${r.external_ref || r.transaction_ref})` : ''}: expected balance ${money(expected)}, statement shows ${money(r.balance_after)}`);
                }
            } else if (i === 0) {
                warnings.push('Opening balance not found in the statement header; the first row\'s balance could not be checked.');
            }
            prev = r.balance_after;
        });
        if (breaks.length > 0) {
            errors.push(`Running balance does not add up at ${breaks.length} row(s), so a row is missing, duplicated or misread: ${breaks.slice(0, 5).join('; ')}${breaks.length > 5 ? '; …' : ''}`);
        }

        if (opening !== null) {
            const credits = round2(chain.reduce((s, r) => s + r.credit, 0));
            const debits = round2(chain.reduce((s, r) => s + r.debit, 0));
            const last = chain[chain.length - 1].balance_after;
            if (Math.abs(round2(credits - debits) - round2(last - opening)) > 0.01) {
                errors.push(`Totals do not reconcile: credits ${money(credits)} - debits ${money(debits)} ≠ closing ${money(last)} - opening ${money(opening)}.`);
            }
            if (Number.isFinite(metadata.closingBalance) && metadata.closingBalanceIsPeriodEnd && Math.abs(metadata.closingBalance - last) > 0.01) {
                errors.push(`Last row balance ${money(last)} does not match the statement closing balance ${money(metadata.closingBalance)}.`);
            }
        }
    }

    const suspicious = [];
    for (const d of deposits || []) {
        const desc = String(d.description || '');
        const reasons = [];
        if ((desc.match(/cash deposit/gi) || []).length > 1) reasons.push('contains "Cash Deposit" twice');
        if (/^\d{3}\s/.test(desc)) reasons.push('starts with a branch code');
        if (d.transaction_code === 'CHF' && desc && !/^cash deposit/i.test(desc)) reasons.push('cash deposit text does not start with "Cash Deposit"');
        if (/INCOMING SWIFT|CREDIT IRS/i.test(desc) && /cash deposit/i.test(desc)) reasons.push('mixes a transfer and a cash deposit');
        if (reasons.length) suspicious.push(`${d.reference_number}: ${reasons.join(', ')}`);
    }
    if (suspicious.length > 0) {
        warnings.push(`${suspicious.length} description(s) look like text from two rows; check them before importing: ${suspicious.slice(0, 5).join('; ')}${suspicious.length > 5 ? '; …' : ''}`);
    }

    return { errors, warnings };
}

/**
 * Compares the Excel and PDF versions of the same statement deposit by deposit.
 * The Excel file is read exactly (named cells) but can be edited by anyone; the PDF is the bank's
 * official copy but its reading is reconstructed from page layout. Any difference means one of
 * them is wrong, so the import is blocked. Returns { errors, warnings, compared }.
 */
export function crossCheckStatements(excelParsed, pdfParsed) {
    const errors = [];
    const warnings = [];
    const em = excelParsed?.metadata || {};
    const pm = pdfParsed?.metadata || {};
    if (em.accountNumber && pm.accountNumber && em.accountNumber !== pm.accountNumber) {
        errors.push(`The Excel and PDF are for different accounts (${em.accountNumber} vs ${pm.accountNumber}).`);
        return { errors, warnings, compared: 0 };
    }
    if (em.dateFrom && pm.dateFrom && (em.dateFrom !== pm.dateFrom || em.dateTo !== pm.dateTo)) {
        errors.push(`The Excel and PDF cover different periods (${em.dateFrom} → ${em.dateTo} vs ${pm.dateFrom} → ${pm.dateTo}).`);
        return { errors, warnings, compared: 0 };
    }

    // letters and digits only: the PDF spaces punctuation differently and has no "|" separator
    const text = (s) => String(s || '').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
    const pdfByRef = new Map((pdfParsed?.deposits || []).map(d => [d.reference_number, d]));
    const excelRefs = new Set();
    const diffs = [];
    for (const x of excelParsed?.deposits || []) {
        excelRefs.add(x.reference_number);
        const p = pdfByRef.get(x.reference_number);
        if (!p) { diffs.push(`${x.reference_number}: in the Excel (${money(x.amount)}) but not in the PDF`); continue; }
        if (Math.abs(Number(x.amount) - Number(p.amount)) > 0.005) diffs.push(`${x.reference_number}: amount ${money(x.amount)} in Excel vs ${money(p.amount)} in PDF`);
        if (x.value_date !== p.value_date) diffs.push(`${x.reference_number}: date ${x.value_date} in Excel vs ${p.value_date} in PDF`);
        if (text(x.description) !== text(p.description)) diffs.push(`${x.reference_number}: description differs ("${x.description}" vs "${p.description}")`);
    }
    for (const p of pdfParsed?.deposits || []) {
        if (!excelRefs.has(p.reference_number)) diffs.push(`${p.reference_number}: in the PDF (${money(p.amount)}) but not in the Excel`);
    }
    if (diffs.length > 0) {
        errors.push(`The Excel and PDF statements differ on ${diffs.length} deposit(s): ${diffs.slice(0, 5).join('; ')}${diffs.length > 5 ? '; …' : ''}`);
    }
    const er = (excelParsed?.excludedReversals || []).length;
    const pr = (pdfParsed?.excludedReversals || []).length;
    if (er !== pr) errors.push(`Reversed entries differ: ${er} in the Excel vs ${pr} in the PDF.`);
    const et = (excelParsed?.excludedTreasury || []).length;
    const pt = (pdfParsed?.excludedTreasury || []).length;
    if (et !== pt) warnings.push(`Bank operation rows differ: ${et} in the Excel vs ${pt} in the PDF.`);
    return { errors, warnings, compared: (excelParsed?.deposits || []).length };
}

/**
 * Merges the database's BM deposits with this browser's cached copy.
 *  - The database is the truth: its rows replace cached ones with the same reference.
 *  - A cached row the database doesn't have is kept (and re-uploaded) ONLY if it is marked
 *    `_pendingSync` — an import whose save to the database failed.
 *  - Any other cached row the database doesn't have was deleted (by a user, Detect Duplicates or
 *    the delete script) and is dropped. It used to be uploaded again, so deleted deposits came back
 *    whenever someone with an old cached copy opened the BM page.
 * Returns { merged, pendingUpload, droppedCount }.
 */
export function mergeForeignCloudAndLocal(localRows, cloudRows) {
    const cloudRefs = new Set((cloudRows || []).map(r => r && r.reference_number).filter(Boolean));
    const byRef = new Map();
    const pendingUpload = [];
    let droppedCount = 0;
    for (const r of localRows || []) {
        if (!r || !r.reference_number || cloudRefs.has(r.reference_number)) continue;
        if (r._pendingSync) {
            byRef.set(r.reference_number, r);
            pendingUpload.push(r);
        } else {
            droppedCount++;
        }
    }
    for (const r of cloudRows || []) {
        if (r && r.reference_number) byRef.set(r.reference_number, r);
    }
    return { merged: [...byRef.values()], pendingUpload, droppedCount };
}

/**
 * Decides which uploaded files are imported and runs every check.
 * files: [{ name, isPdf, parsed }] where parsed is a parse*Statement result.
 *  - Excel/CSV statements are the data (exact cells).
 *  - A PDF of the same account + period is NOT imported; it cross-checks its Excel.
 *  - A PDF with no matching Excel is imported, with a warning (the reading depends on page layout).
 * Returns { statements: files to import, integrity: { errors, warnings, passed } }.
 */
export function pairStatementFiles(files) {
    const errors = [];
    const warnings = [];
    const passed = [];
    const add = (out, prefix, items) => (items || []).forEach(t => out.push(`${prefix}: ${t}`));
    const key = (m = {}) => `${m.accountNumber || ''}|${m.dateFrom || ''}|${m.dateTo || ''}`;
    const sheets = (files || []).filter(f => !f.isPdf);
    const pdfs = (files || []).filter(f => f.isPdf);
    const usedPdfs = new Set();
    const statements = [];

    for (const x of sheets) {
        add(errors, x.name, x.parsed.integrity?.errors);
        add(warnings, x.name, x.parsed.integrity?.warnings);
        if (!x.parsed.integrity?.errors?.length) {
            passed.push(`${x.name}: columns recognised, running balance and totals add up (${(x.parsed.deposits || []).length} deposits).`);
        }
        let pdf = pdfs.find(p => !usedPdfs.has(p) && key(p.parsed.metadata) === key(x.parsed.metadata));
        // one Excel + one PDF uploaded together are meant as a pair; a mismatch is reported by the cross-check
        if (!pdf && sheets.length === 1 && pdfs.length === 1) pdf = pdfs[0];
        if (pdf) {
            usedPdfs.add(pdf);
            add(errors, pdf.name, pdf.parsed.integrity?.errors);
            const cross = crossCheckStatements(x.parsed, pdf.parsed);
            add(errors, `${x.name} vs ${pdf.name}`, cross.errors);
            add(warnings, `${x.name} vs ${pdf.name}`, cross.warnings);
            if (!cross.errors.length && !pdf.parsed.integrity?.errors?.length) {
                passed.push(`${x.name} matches the bank's PDF ${pdf.name} on all ${cross.compared} deposits.`);
            }
        } else {
            warnings.push(`${x.name}: no PDF of this statement was uploaded, so it was not cross-checked against the bank's official copy.`);
        }
        statements.push(x);
    }

    for (const p of pdfs) {
        if (usedPdfs.has(p)) continue;
        add(errors, p.name, p.parsed.integrity?.errors);
        add(warnings, p.name, p.parsed.integrity?.warnings);
        warnings.push(`${p.name}: imported from the PDF only. Reading a PDF depends on its page layout; upload the Excel statement of the same account and period for an exact reading.`);
        if (!p.parsed.integrity?.errors?.length) {
            passed.push(`${p.name}: table layout recognised, running balance and totals add up (${(p.parsed.deposits || []).length} deposits).`);
        }
        statements.push(p);
    }

    return { statements, integrity: { errors, warnings, passed } };
}

/**
 * Given raw statement rows (from CSV, Excel, or PDF), performs:
 * 1. Reversal pair detection (`INIT` + `REVR` sharing External Ref No or Transaction Reference)
 * 2. Treasury / Non-student filtering
 * 3. Student narrative extraction & ID validation (rows without a Student ID are KEPT so they can be fixed or exported)
 */
export function processBankStatementRows(rawRows, metadata = {}) {
    const currency = metadata.currency || 'USD';
    const accountNumber = metadata.accountNumber || '';

    const normalized = (rawRows || []).map((r, idx) => {
        const credit = parseStatementAmount(r.credit);
        const debit = parseStatementAmount(r.debit);
        // NaN when the cell is empty, so the running-balance check skips it instead of reading 0
        const balanceAfter = r.balance_after === null || r.balance_after === undefined || String(r.balance_after).trim() === ''
            ? NaN
            : parseStatementAmount(r.balance_after);
        const txDateParsed = parseStatementDate(r.transaction_date);
        const valDateParsed = parseStatementDate(r.value_date);
        const extRef = String(r.external_ref || '').trim();
        const txRef = String(r.transaction_ref || '').trim();
        const txCode = String(r.transaction_code || '').trim().toUpperCase();
        const event = String(r.event || '').trim().toUpperCase();
        const description = normalizeArabicPresentation(r.description || '').replace(/\s+/g, ' ').trim();

        return {
            _rowIndex: idx + 1,
            balance_after: balanceAfter,
            credit,
            debit,
            transaction_datetime: txDateParsed.dateTime || String(r.transaction_date || '').trim(),
            transaction_date: txDateParsed.dateOnly || valDateParsed.dateOnly,
            value_date: valDateParsed.dateOnly || txDateParsed.dateOnly,
            description,
            instrument_code: String(r.instrument_code || '').trim(),
            external_ref: extRef,
            transaction_code: txCode,
            transaction_ref: txRef,
            event
        };
    }).filter(r => r.credit > 0 || r.debit > 0 || r.description);

    // 1. Identify all External Refs and Transaction Refs that have an Event === 'REVR'
    const reversedExtRefs = new Set();
    const reversedTxRefs = new Set();
    for (const r of normalized) {
        if (r.event === 'REVR') {
            if (r.external_ref) reversedExtRefs.add(r.external_ref);
            if (r.transaction_ref) reversedTxRefs.add(r.transaction_ref);
        }
    }

    const deposits = [];
    const excludedReversals = [];
    const excludedTreasury = [];

    for (const r of normalized) {
        const isReversedPair =
            r.event === 'REVR' ||
            (r.external_ref && reversedExtRefs.has(r.external_ref)) ||
            (r.transaction_ref && reversedTxRefs.has(r.transaction_ref));

        if (isReversedPair) {
            excludedReversals.push({
                ...r,
                exclude_reason: r.event === 'REVR' ? 'Reversal Entry (REVR)' : 'Cancelled by Reversal (INIT+REVR Pair)'
            });
            continue;
        }

        if (isTreasuryOrNonStudentRow(r) || r.credit <= 0) {
            excludedTreasury.push({
                ...r,
                exclude_reason: r.credit <= 0 ? 'Debit / Outgoing Entry' : `Treasury / Bank Operation (${r.transaction_code || r.event})`
            });
            continue;
        }

        // Reference is mandatory: use External. Ref No if present, otherwise fallback to Transaction Reference
        const refNumber = String(r.external_ref || r.transaction_ref || '').trim();
        if (!refNumber) {
            excludedTreasury.push({
                ...r,
                exclude_reason: 'Missing Mandatory Reference (External Ref / Transaction Ref)'
            });
            continue;
        }

        const parsed = parseStudentDepositNarrative(r.description, r.transaction_code);
        const idStatus = validateID(parsed.studentId);
        const effectiveDate = r.value_date || r.transaction_date;

        deposits.push({
            reference_number: refNumber,
            external_ref: r.external_ref || '',
            transaction_ref: r.transaction_ref || '',
            transaction_code: r.transaction_code || 'CHF',
            event: r.event || 'INIT',
            payment_date: effectiveDate,
            value_date: effectiveDate,
            transaction_date: r.transaction_date,
            transaction_datetime: r.transaction_datetime,
            item_price: r.credit,
            amount: r.credit,
            currency,
            account_number: accountNumber,
            student_id: parsed.studentId || '',
            extracted_name: parsed.studentName || '',
            matched_student_name: '',
            handler_name: parsed.handlerName || '',
            deposit_method: parsed.depositMethod,
            description: r.description,
            item_name: r.description,
            mapping: DEFAULT_FOREIGN_MAPPING,
            second_mapping: '',
            bank: DEFAULT_FOREIGN_BANK,
            id_status: idStatus,
            match_source: parsed.studentId && idStatus === 'Valid' ? 'statement_id' : 'unmatched',
            erp_batch_number: null,
            erp_voucher: null
        });
    }

    return {
        metadata: {
            customerName: metadata.customerName || 'جامعة النيل الاهلية',
            accountNumber: metadata.accountNumber || '',
            iban: metadata.iban || '',
            currency: metadata.currency || 'USD',
            branch: metadata.branch || '',
            dateFrom: metadata.dateFrom || '',
            dateTo: metadata.dateTo || '',
            openingBalance: Number.isFinite(metadata.openingBalance) ? metadata.openingBalance : null,
            sourceType: metadata.sourceType || ''
        },
        deposits,
        excludedReversals,
        excludedTreasury,
        integrity: checkStatementIntegrity(normalized, deposits, metadata)
    };
}

/**
 * Parses a 2D array of rows (from CSV PapaParse or SheetJS XLSX.utils.sheet_to_json({header:1}))
 * into statement metadata + raw transaction objects, then runs processBankStatementRows.
 */
export function parseBankStatementGrid(gridRows) {
    const metadata = {
        customerName: '',
        accountNumber: '',
        iban: '',
        currency: 'USD',
        branch: '',
        dateFrom: '',
        dateTo: '',
        openingBalance: null,
        sourceType: 'excel',
        formatErrors: [],
        formatWarnings: []
    };

    if (!Array.isArray(gridRows) || gridRows.length === 0) {
        return processBankStatementRows([], metadata);
    }

    let headerRowIdx = -1;
    let colMap = {};

    for (let i = 0; i < Math.min(gridRows.length, 30); i++) {
        const row = (gridRows[i] || []).map(c => String(c ?? '').trim());

        for (let c = 0; c < row.length - 1; c++) {
            // The bank's Excel writes labels with a colon ("Account Number:"), which the anchored
            // patterns below didn't match, so the account number was never read from Excel.
            const label = String(row[c] || '').replace(/\s*[:：]\s*$/, '');
            const nextVal = row[c + 1] || row[c + 2] || '';
            if (!label || !nextVal) continue;
            if (/اسم العميل|Customer Name/i.test(label)) metadata.customerName = nextVal;
            else if (/^العملة$|^Currency$/i.test(label) && /^[A-Z]{3}$/i.test(nextVal)) metadata.currency = nextVal.toUpperCase();
            else if (/رقم الفرع|Branch Number/i.test(label)) metadata.branch = nextVal;
            else if (/^رقم الحساب$|^Account Number$/i.test(label)) metadata.accountNumber = nextVal;
            else if (/رقم الحساب الدولي|IBAN/i.test(label)) metadata.iban = nextVal;
            else if (/تاريخ البداية|Date From/i.test(label)) metadata.dateFrom = parseStatementDate(nextVal).dateOnly || nextVal;
            else if (/تاريخ النهاية|Date To/i.test(label)) metadata.dateTo = parseStatementDate(nextVal).dateOnly || nextVal;
            else if (/الرصيد الافتتاحي|Opening Balance/i.test(label) && /\d/.test(nextVal)) metadata.openingBalance = parseStatementAmount(nextVal);
        }

        const hasArabicHeaders = row.some(c => /البيان/.test(c)) && row.some(c => /دائن/.test(c));
        const hasEnglishHeaders = row.some(c => /^Description$/i.test(c)) && row.some(c => /^Credit$/i.test(c));
        if (hasArabicHeaders || hasEnglishHeaders) {
            headerRowIdx = i;
            row.forEach((cell, idx) => {
                const clean = cell.toLowerCase();
                if (/الرصيد بعد المعاملة|balance after/.test(clean)) colMap.balance_after = idx;
                else if (/^دائن$|^credit$/.test(clean)) colMap.credit = idx;
                else if (/^مدين$|^debit$/.test(clean)) colMap.debit = idx;
                else if (/تاريخ و وقت المعاملة|transcation date|transaction date/.test(clean)) colMap.transaction_date = idx;
                else if (/تاريخ الحق|value date/.test(clean)) colMap.value_date = idx;
                else if (/^البيان$|^description$/.test(clean)) colMap.description = idx;
                else if (/رقم المستند|instrument code/.test(clean)) colMap.instrument_code = idx;
                else if (/الرقم المرجعي|external\.?\s*ref/.test(clean)) colMap.external_ref = idx;
                else if (/كود الحركة|transcation code|transaction code/.test(clean)) colMap.transaction_code = idx;
                else if (/رقم الحركة|transaction reference/.test(clean)) colMap.transaction_ref = idx;
                else if (/^الحدث$|^event$/.test(clean)) colMap.event = idx;
            });
            // Columns are read by name here, so a NEW column is harmless (warning only); a MISSING
            // required column means the reading would be wrong (error).
            const unknown = row.filter(c => c && !isKnownStatementHeader(c));
            if (unknown.length > 0) {
                metadata.formatWarnings.push(`New column(s) in the Excel statement: "${unknown.join('", "')}". They are ignored; tell the developer if they matter.`);
            }
            const required = { balance_after: 'Balance After', credit: 'Credit', debit: 'Debit', transaction_date: 'Transaction Date/Time', value_date: 'Value Date', description: 'Description', event: 'Event' };
            const missing = Object.entries(required).filter(([k]) => colMap[k] === undefined).map(([, label]) => label);
            if (colMap.external_ref === undefined && colMap.transaction_ref === undefined) missing.push('External Ref / Transaction Reference');
            if (missing.length > 0) {
                metadata.formatErrors.push(`Required column(s) missing from the Excel statement: ${missing.join(', ')}. The bank changed the format.`);
            }
            break;
        }
    }

    if (headerRowIdx === -1) {
        metadata.formatErrors.push('The statement table header (Balance After, Credit, Debit, ... Description) was not found, so columns cannot be identified.');
        colMap = {
            balance_after: 0,
            credit: 1,
            debit: 2,
            transaction_date: 3,
            value_date: 4,
            description: 5,
            instrument_code: 6,
            external_ref: 7,
            transaction_code: 8,
            transaction_ref: 9,
            event: 10
        };
    }

    const rawRows = [];
    for (let i = headerRowIdx + 1; i < gridRows.length; i++) {
        const row = gridRows[i];
        if (!Array.isArray(row) || row.every(c => c === null || c === undefined || String(c).trim() === '')) continue;
        const get = (key) => (colMap[key] !== undefined ? row[colMap[key]] : '');
        const desc = String(get('description') ?? '').trim();
        const credit = get('credit');
        const debit = get('debit');
        if (!desc && !credit && !debit) continue;

        rawRows.push({
            balance_after: get('balance_after'),
            credit,
            debit,
            transaction_date: get('transaction_date'),
            value_date: get('value_date'),
            description: desc,
            instrument_code: get('instrument_code'),
            external_ref: get('external_ref'),
            transaction_code: get('transaction_code'),
            transaction_ref: get('transaction_ref'),
            event: get('event')
        });
    }

    return processBankStatementRows(rawRows, metadata);
}

/**
 * Reconstructs ordered PDF text from coordinate-positioned pdf.js text items across pages.
 * Because Banque Misr PDF tables vertically center the single-line cells (Balance, Credit, Debit,
 * Dates, External Ref, Code, Tx Ref, Event) at `rowY` while multi-line `Description` cells wrap
 * slightly above (`rowY + 6`) and below (`rowY - 6`), sorting purely by Y would place Line 1 of
 * a row's description above the row's numbers!
 *
 * This function finds each row's anchor Y-coordinate on the page and assigns all wrapped
 * Description items to their nearest row Y-coordinate, emitting every row in clean column order:
 *   `<Balance> <Credit> <Debit> <DateTime> <ValueDate> <Full Description> <ExtRef> <TxCode> <TxRef> <Event>`
 */
const ARABIC_CHAR_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const ARABIC_PRESENTATION_RE = /[\uFB50-\uFDFF\uFE70-\uFEFF]/;
const NEUTRAL_SEP_RE = /^[\s\-\/.,:()]+$/;

/**
 * Normalizes Arabic Presentation Forms-A/B (often emitted by PDF fonts)
 * into canonical standard UTF-8 Arabic characters.
 */
export function normalizeArabicPresentation(str) {
    if (!str) return '';
    const s = String(str);
    return ARABIC_PRESENTATION_RE.test(s) ? s.normalize('NFKC') : s;
}

/**
 * Sorts spans on a single horizontal PDF line left-to-right by X, while
 * reversing contiguous Right-to-Left Arabic segments (including neutral
 * punctuation separators bridged by Arabic tokens) so multi-word Arabic names
 * and narratives reconstruct in logical reading order rather than reversed.
 */
export function orderBidiPdfLineItems(items) {
    const sorted = [...(items || [])].sort((a, b) => a.x - b.x);
    const ordered = [];
    let i = 0;

    while (i < sorted.length) {
        if (ARABIC_CHAR_RE.test(sorted[i].str)) {
            let j = i + 1;
            while (j < sorted.length) {
                if (ARABIC_CHAR_RE.test(sorted[j].str)) {
                    j++;
                } else if (NEUTRAL_SEP_RE.test(sorted[j].str)) {
                    let k = j + 1;
                    while (k < sorted.length && NEUTRAL_SEP_RE.test(sorted[k].str)) {
                        k++;
                    }
                    if (k < sorted.length && ARABIC_CHAR_RE.test(sorted[k].str)) {
                        j = k + 1;
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
            ordered.push(...sorted.slice(i, j).reverse());
            i = j;
        } else {
            ordered.push(sorted[i]);
            i++;
        }
    }

    return ordered;
}

/**
 * Finds the statement table header on a page and returns X boundaries:
 *   descStart..descEnd   = Description column
 *   codesStart..codesEnd = External Ref, Transaction Code, Transaction Reference, Event
 * Returns null when the header isn't on the page (callers fall back to text matching).
 */
export function detectBanqueMisrColumns(hLines) {
    for (const line of hLines || []) {
        const text = line.items.map(i => i.str).join(' ');
        if (!/Description/i.test(text) || !/Credit/i.test(text)) continue;
        const xOf = (re) => {
            const it = line.items.find(i => re.test(i.str));
            return it ? it.x : null;
        };
        const descX = xOf(/^Description$/i);
        const instrX = xOf(/Instrument/i);
        const extX = xOf(/External/i);
        const branchX = xOf(/Executed\s+Branch\s+Code|Branch\s+Code/i);
        const descEndX = instrX ?? extX;
        if (descX === null || descEndX === null || extX === null) return null;
        const pad = 3;
        return {
            headerY: line.y,
            descStart: descX - pad,
            descEnd: descEndX - pad,
            codesStart: extX - pad,
            // the Event cell ends where the branch columns start (or the page edge on older layouts)
            codesEnd: branchX !== null ? branchX - pad : Infinity
        };
    }
    return null;
}

/**
 * Assigns wrapped Description lines to rows. The bank centres each description vertically on its
 * row's numbers, so a row has as many wrapped lines below its numbers as above them. Lines between
 * two rows' numbers therefore go: the first N to the upper row (N = its lines above), the rest to
 * the lower row. "Nearest row" got this wrong for tall rows (e.g. a 7-line SWIFT description), whose
 * last lines are closer to the next row's numbers.
 * anchors and lines are ordered top to bottom (descending PDF y).
 */
export function assignCenteredDescriptionLines(anchors, lines) {
    if (!anchors.length) return;
    const gaps = Array.from({ length: anchors.length + 1 }, () => []);
    for (const line of [...lines].sort((a, b) => b.y - a.y)) {
        const anchorsAbove = anchors.filter(a => a.y > line.y).length;
        gaps[anchorsAbove].push(line.text);
    }
    anchors[0].extraDescAbove.push(...gaps[0]);
    for (let g = 1; g < gaps.length; g++) {
        const upper = anchors[g - 1];
        const lower = anchors[g];
        const n = lower ? Math.min(upper.extraDescAbove.length, gaps[g].length) : gaps[g].length;
        upper.extraDescBelow.push(...gaps[g].slice(0, n));
        if (lower) lower.extraDescAbove.push(...gaps[g].slice(n));
    }
}

/** Groups one page's pdf.js text items into horizontal lines (top to bottom), each in reading order. */
function groupPdfPageLines(pageItems) {
    const cleanItems = (pageItems || [])
        .map(it => ({
            str: normalizeArabicPresentation(it.str).trim(),
            x: Number(it.x) || 0,
            y: Number(it.y) || 0
        }))
        .filter(it => it.str.length > 0);

    // Group items that share approximately the same Y coordinate (within 3pt) into horizontal lines
    const sortedByY = [...cleanItems].sort((a, b) => b.y - a.y || a.x - b.x);
    const hLines = [];
    for (const item of sortedByY) {
        const last = hLines[hLines.length - 1];
        if (last && Math.abs(last.y - item.y) <= 3.2) {
            last.items.push(item);
        } else {
            hLines.push({ y: item.y, items: [item] });
        }
    }
    hLines.forEach(line => {
        line.items = orderBidiPdfLineItems(line.items);
    });
    return hLines;
}

// Every column header the Banque Misr statement is known to use (PDF and Excel, English and Arabic).
// A header outside this list means the bank changed the format: the PDF reader refuses to guess.
const KNOWN_STATEMENT_HEADERS = [
    // (the bank spells it both "Transaction" and "Transcation")
    /^balance after( txn)?$/, /^credit$/, /^debit$/, /^trans(action|cation) date\/time$/, /^value date$/,
    /^description$/, /^instrument code$/, /^external\.? ref(erence)?( no| number)?$/, /^trans(action|cation) code$/,
    /^transaction reference$/, /^event$/, /^executed branch code$/, /^executed branch name$/,
    /^الرصيد بعد المعاملة$/, /^دائن$/, /^مدين$/, /^تاريخ و وقت المعاملة$/, /^تاريخ الحق$/, /^البيان$/,
    /^رقم المستند$/, /^الرقم المرجعي/, /^كود الحركة$/, /^رقم الحركة$/, /^الحدث$/, /^كود الفرع/, /^اسم الفرع/
];
export function isKnownStatementHeader(label) {
    const clean = String(label || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return !clean || KNOWN_STATEMENT_HEADERS.some(re => re.test(clean));
}

/**
 * Checks that every page of a Banque Misr PDF still has the table layout the reader understands.
 * Returns { errors, warnings }. An error means the PDF must not be trusted on its own.
 */
export function analyzeBanqueMisrPdfLayout(pagesItems) {
    const errors = [];
    const warnings = [];
    (pagesItems || []).forEach((pageItems, p) => {
        const hLines = groupPdfPageLines(pageItems);
        const hasRows = hLines.some(l => /\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2}/.test(l.items.map(i => i.str).join(' ')));
        if (!hasRows) return;
        const headerLine = hLines.find(l => {
            const t = l.items.map(i => i.str).join(' ');
            return /Description/i.test(t) && /Credit/i.test(t);
        });
        if (!headerLine || !detectBanqueMisrColumns([headerLine])) {
            errors.push(`PDF page ${p + 1}: the statement table header was not found, so its columns cannot be read reliably.`);
            return;
        }
        const unknown = headerLine.items.map(i => i.str).filter(s => !isKnownStatementHeader(s));
        if (unknown.length > 0) {
            errors.push(`PDF page ${p + 1}: unknown column(s) "${unknown.join('", "')}". The bank changed the statement format; the PDF reader needs updating.`);
        }
    });
    return { errors, warnings };
}

export function reconstructBanqueMisrPdfLinesFromPages(pagesItems) {
    const outputLines = [];

    for (const pageItems of pagesItems || []) {
        const hLines = groupPdfPageLines(pageItems);
        if (hLines.length === 0) continue;

        // Column boundaries from this page's table header ("Balance After | Credit | Debit | ...").
        // Reading cells by X position keeps wrapped text in its own column: the bank added
        // "Executed Branch Code / Name" columns after "Event", and without this the branch name
        // (and the row-matching regex failing on it) shifted every description onto the previous row.
        const cols = detectBanqueMisrColumns(hLines);

        // Identify Anchor Lines: lines that contain a transaction date-time (\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2})
        // or an Event code (INIT|REVR|DEBK|ILIQ|IMAT) + numeric balances
        const anchorLines = [];
        for (const line of hLines) {
            const text = line.items.map(i => i.str).join(' ');
            if (
                /[\d,]+\.\d{2}\s+[\d,]+\.\d{2}\s+[\d,]+\.\d{2}\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2}/.test(text) ||
                /\b(INIT|REVR|DEBK|ILIQ|IMAT)\b/.test(text)
            ) {
                if (/\d{2}-\d{2}-\d{4}/.test(text)) {
                    anchorLines.push({
                        y: line.y,
                        extraDescAbove: [],
                        extraDescBelow: [],
                        anchorItems: line.items
                    });
                }
            }
        }

        if (anchorLines.length === 0) {
            // Header-only page or fallback
            hLines.forEach(l => outputLines.push(l.items.map(i => i.str).join(' ')));
            continue;
        }

        // Table bounds. With a detected header the table starts right below it: a tall row at the
        // top of a page wraps more than 22pt above its numbers and was being cut off as "header".
        const topTableY = cols ? cols.headerY - 1 : anchorLines[0].y + 22;
        const bottomTableY = cols ? -Infinity : anchorLines[anchorLines.length - 1].y - 22;
        const descLines = [];

        for (const line of hLines) {
            const text = line.items.map(i => i.str).join(' ');
            // Keep metadata header lines above the table
            if (line.y > topTableY) {
                if (!/Balance\s+After.*Credit.*Debit/i.test(text)) {
                    outputLines.push(text);
                }
                continue;
            }
            // Skip page footer below the table (e.g., "1 / 4")
            if (line.y < bottomTableY) {
                if (!/^\d+\s*\/\s*\d+$/.test(text.trim())) {
                    outputLines.push(text);
                }
                continue;
            }

            // If this is one of the anchor lines, skip (already in anchorLines)
            if (anchorLines.some(a => Math.abs(a.y - line.y) <= 0.5)) {
                continue;
            }

            // Skip repeated table header row
            if (/Balance\s+After.*Credit.*Debit/i.test(text)) continue;

            // With known columns, only Description-column text belongs to a row's description
            // (a wrapped branch name or reference must not be glued onto it).
            let descText = text;
            if (cols) {
                if (/^\d+\s*\/\s*\d+$/.test(text.trim())) continue; // page footer "3 / 9"
                const descItems = line.items.filter(i => i.x >= cols.descStart && i.x < cols.descEnd);
                if (descItems.length === 0) continue;
                descText = orderBidiPdfLineItems(descItems).map(i => i.str).join(' ');
                descLines.push({ y: line.y, text: descText });
                continue;
            }

            // Find the closest anchor line by Y distance
            let bestAnchor = anchorLines[0];
            let bestDist = Math.abs(line.y - bestAnchor.y);
            for (let i = 1; i < anchorLines.length; i++) {
                const d = Math.abs(line.y - anchorLines[i].y);
                if (d < bestDist) {
                    bestDist = d;
                    bestAnchor = anchorLines[i];
                }
            }

            if (line.y > bestAnchor.y) {
                bestAnchor.extraDescAbove.push(descText);
            } else {
                bestAnchor.extraDescBelow.push(descText);
            }
        }

        if (cols) assignCenteredDescriptionLines(anchorLines, descLines);

        // Now emit each anchor row with all its description lines placed cleanly before the trailing refs/codes
        for (const anchor of anchorLines) {
            if (cols) {
                const join = (arr) => orderBidiPdfLineItems(arr).map(i => i.str).join(' ').trim();
                const leftCols = join(anchor.anchorItems.filter(i => i.x < cols.descStart));
                const midDesc = join(anchor.anchorItems.filter(i => i.x >= cols.descStart && i.x < cols.descEnd));
                // External Ref .. Event; Instrument Code and Executed Branch Code/Name are dropped
                const rightCodes = join(anchor.anchorItems.filter(i => i.x >= cols.codesStart && i.x < cols.codesEnd));
                if (/^[\d,]+\.\d{2}\s+[\d,]+\.\d{2}\s+[\d,]+\.\d{2}\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2}\s+\d{2}-\d{2}-\d{4}$/.test(leftCols)) {
                    const fullDesc = [
                        ...anchor.extraDescAbove,
                        ...(midDesc ? [midDesc] : []),
                        ...anchor.extraDescBelow
                    ].join(' ').replace(/\s+/g, ' ').trim();
                    outputLines.push(`${leftCols} ${fullDesc} ${rightCodes}`.replace(/\s+/g, ' ').trim());
                    continue;
                }
            }
            const baseText = anchor.anchorItems.map(i => i.str).join(' ');
            // Optional trailing "Executed Branch Code / Name" after the Event column.
            const trailRegex = /(?:\b(FJB\d{8,18}|\d{3}DEBK[A-Z0-9]+|IRS[A-Z0-9]{6,14})\s+)?\b(CHF|SIR|T30|T35|TD1|TD2|TD3|TD4|T02|T06)\s+([0-9A-Z]{3}[A-Za-z0-9\s]{4,22}?)\s+\b(INIT|REVR|DEBK|ILIQ|IMAT)\b(?:\s+\d{3}\b.*)?\s*$/;
            const tm = baseText.match(trailRegex);
            if (tm) {
                const leftAndMid = baseText.slice(0, tm.index).trim();
                const rightCodes = [tm[1], tm[2], tm[3], tm[4]].filter(Boolean).join(' ');
                const startMatch = leftAndMid.match(/^([\d,]+\.\d{2}\s+[\d,]+\.\d{2}\s+[\d,]+\.\d{2}\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2}\s+\d{2}-\d{2}-\d{4})\s*(.*)$/);
                if (startMatch) {
                    const leftCols = startMatch[1];
                    const midDesc = startMatch[2].trim();
                    const fullDesc = [
                        ...anchor.extraDescAbove,
                        ...(midDesc ? [midDesc] : []),
                        ...anchor.extraDescBelow
                    ].join(' ').replace(/\s+/g, ' ').trim();
                    outputLines.push(`${leftCols} ${fullDesc} ${rightCodes}`);
                    continue;
                }
            }
            outputLines.push(
                [...anchor.extraDescAbove, baseText, ...anchor.extraDescBelow].join(' ').replace(/\s+/g, ' ').trim()
            );
        }
    }

    return outputLines.join('\n');
}

/**
 * Parses extracted text from a Banque Misr Statement of Account PDF (single or multi-page)
 * into metadata and transaction rows, then runs processBankStatementRows.
 */
export function parseBanqueMisrPdfText(fullText, layout = null) {
    const text = normalizeArabicPresentation(fullText || '');
    const metadata = {
        customerName: 'جامعة النيل الاهلية',
        accountNumber: '',
        iban: '',
        currency: 'USD',
        branch: '',
        dateFrom: '',
        dateTo: '',
        openingBalance: null,
        sourceType: 'pdf',
        formatErrors: [...(layout?.errors || [])],
        formatWarnings: [...(layout?.warnings || [])]
    };

    // Header block: "Customer Name  Customer Id  Opening Balance" then the values line.
    const openMatch = text.match(/Opening Balance[^\n]*\n[^\n]*?(-?[\d,]+\.\d{2})[ \t]*$/m);
    if (openMatch) metadata.openingBalance = parseStatementAmount(openMatch[1]);

    const accMatch = text.match(/\b(7\d{15})\b/) || text.match(/Account\s+Number\s+([0-9]{10,20})/i) || text.match(/رقم الحساب\s+([0-9]{10,20})/);
    if (accMatch) metadata.accountNumber = accMatch[1];

    const ibanMatch = text.match(/\b(EG\d{27})\b/);
    if (ibanMatch) metadata.iban = ibanMatch[1];

    // Match explicit ISO currency codes (avoid matching 'Cur' from 'Current Balance')
    const currMatch = text.match(/\b(USD|EGP|EUR|GBP|SAR|AED)\b/);
    if (currMatch) metadata.currency = currMatch[1].toUpperCase();

    const branchMatch = text.match(/Branch\s+Number\s+(\d{2,6})/i);
    if (branchMatch) metadata.branch = branchMatch[1];

    const allHeaderDates = [...text.slice(0, 1200).matchAll(/\b(\d{2}-\d{2}-\d{4})\b/g)].map(m => m[1]);
    if (allHeaderDates.length >= 2) {
        metadata.dateFrom = parseStatementDate(allHeaderDates[0]).dateOnly || allHeaderDates[0];
        metadata.dateTo = parseStatementDate(allHeaderDates[1]).dateOnly || allHeaderDates[1];
    }

    const rowStartRegex = /([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2})/g;

    const starts = [];
    let m;
    while ((m = rowStartRegex.exec(text)) !== null) {
        starts.push({
            index: m.index,
            endOfHeader: m.index + m[0].length,
            balance_after: m[1],
            credit: m[2],
            debit: m[3],
            transaction_date: m[4],
            value_date: m[5]
        });
    }

    const rawRows = [];
    for (let i = 0; i < starts.length; i++) {
        const cur = starts[i];
        const nextIndex = i + 1 < starts.length ? starts[i + 1].index : text.length;
        let tail = text.slice(cur.endOfHeader, nextIndex);

        // Page footer "3 / 9" only: a stand-alone pair, not part of a date ("13/01/2008") or an
        // ID written as "241002692/2".
        const pageBreakIdx = tail.search(/(?:^|\s)\d{1,3}\s*\/\s*\d{1,3}(?=\s|$)(?!\s*\/)|Statement of Account|Customer Name|جامعة النيل الاهلية/i);
        if (pageBreakIdx !== -1) {
            tail = tail.slice(0, pageBreakIdx);
        }

        tail = tail.replace(/\s+/g, ' ').trim();

        // Match [External Ref (optional)] <TransCode> <TransactionRef> <Event> anywhere in tail
        let event = '';
        let txCode = '';
        let txRef = '';
        let extRef = '';
        let description = tail;

        const codeBlockRegex = /(?:(FJB\d{8,18}|\d{3}DEBK[A-Z0-9]+|IRS[A-Z0-9]{6,14})\s+)?\b(CHF|SIR|T30|T35|TD1|TD2|TD3|TD4|T02|T06)\s+([0-9A-Z]{3}[A-Za-z0-9\s]{4,22}?)\s+\b(INIT|REVR|DEBK|ILIQ|IMAT)\b/;
        const cbMatch = tail.match(codeBlockRegex);
        if (cbMatch) {
            extRef = (cbMatch[1] || '').trim();
            txCode = (cbMatch[2] || '').trim();
            txRef = (cbMatch[3] || '').trim();
            event = (cbMatch[4] || '').trim();
            description = (tail.slice(0, cbMatch.index) + ' ' + tail.slice(cbMatch.index + cbMatch[0].length))
                .replace(/\s+/g, ' ')
                .trim();
        } else {
            // Secondary fallback: extract FJB external ref and event independently if present
            const fjbMatch = tail.match(/\b(FJB\d{8,18}|IRS[A-Z0-9]{6,14})\b/);
            if (fjbMatch) {
                extRef = fjbMatch[1];
                description = description.replace(fjbMatch[0], ' ');
            }
            const evMatch = tail.match(/\b(INIT|REVR|DEBK|ILIQ|IMAT)\b/);
            if (evMatch) {
                event = evMatch[1];
                description = description.replace(evMatch[0], ' ');
            }
            const tcMatch = tail.match(/\b(CHF|SIR|T30|T35|TD1|TD2|TD3|TD4|T02|T06)\b/);
            if (tcMatch) {
                txCode = tcMatch[1];
                description = description.replace(tcMatch[0], ' ');
            }
            description = description.replace(/\s+/g, ' ').trim();
        }

        rawRows.push({
            balance_after: cur.balance_after,
            credit: cur.credit,
            debit: cur.debit,
            transaction_date: cur.transaction_date,
            value_date: cur.value_date,
            description,
            instrument_code: '',
            external_ref: extRef,
            transaction_code: txCode,
            transaction_ref: txRef,
            event
        });
    }

    return processBankStatementRows(rawRows, metadata);
}

/**
 * Matches foreign deposit rows against student_master by:
 * 1. Manual fixes (by reference_number) if provided
 * 2. Exact Student ID lookup (populates matched_student_name from student_master)
 * 3. Fuzzy Arabic / English Student Name & Guardian Name matching for rows missing a valid Student ID
 */
const _foreignStudentIndexCache = new WeakMap();

export function matchForeignDepositsToStudents(deposits, studentMasterList = [], manualFixesList = []) {
    if (!Array.isArray(deposits) || deposits.length === 0) return [];
    const students = Array.isArray(studentMasterList) ? studentMasterList : [];
    const fixesByRef = new Map();
    (manualFixesList || []).forEach(f => {
        if (f && f.reference_number) {
            fixesByRef.set(String(f.reference_number).trim(), f);
        }
    });

    let cachedIndex = (Array.isArray(students) && students.length > 0) ? _foreignStudentIndexCache.get(students) : null;
    if (!cachedIndex || cachedIndex.length !== students.length) {
        const byId = new Map();
        const preparedStudents = students.map(s => {
            const sid = String(s.student_id || '').trim();
            const normSid = normalizeStudentIdValue(sid);
            if (sid) byId.set(sid, s);
            if (normSid) byId.set(normSid, s);
            const normEn = normalizePersonName(s.full_name || '');
            const normAr = normalizePersonName(s.arabic_name || '');
            const normGuardian = normalizePersonName(s.guardian_name || '');
            return {
                student: s,
                sid: normSid || sid,
                normEn,
                normAr,
                normGuardian,
                enTokens: normEn ? normEn.split(' ').filter(t => t.length >= 2) : [],
                arTokens: normAr ? normAr.split(' ').filter(t => t.length >= 2) : [],
                guardianTokens: normGuardian ? normGuardian.split(' ').filter(t => t.length >= 2) : []
            };
        });
        cachedIndex = { byId, preparedStudents, length: students.length };
        if (Array.isArray(students) && students.length > 0) {
            _foreignStudentIndexCache.set(students, cachedIndex);
        }
    }
    const { byId, preparedStudents } = cachedIndex;

    const scoreTokenOverlap = (queryNorm, queryTokens, targetNorm, targetTokens) => {
        if (!queryNorm || !targetNorm || queryTokens.length === 0 || targetTokens.length === 0) return 0;
        if (queryNorm === targetNorm) return 1.0;

        let matched = 0;
        for (const qt of queryTokens) {
            if (targetTokens.some(tt => tt === qt || (qt.length >= 4 && tt.length >= 4 && (tt.startsWith(qt) || qt.startsWith(tt))))) {
                matched++;
            }
        }
        if (matched === 0) return 0;
        const firstQ = queryTokens[0];
        const lastQ = queryTokens[queryTokens.length - 1];
        const firstT = targetTokens[0];
        const firstMatches = (firstQ === firstT || lastQ === firstT);
        const ratio = matched / Math.max(queryTokens.length, Math.min(targetTokens.length, 4));
        return firstMatches ? ratio : ratio * 0.75;
    };

    return deposits.map(dep => {
        const refKey = String(dep.reference_number || '').trim();
        const fix = fixesByRef.get(refKey);
        let currentId = String((fix && fix.correct_id) ? fix.correct_id : (dep.student_id || '')).trim();
        const normCurrentId = normalizeStudentIdValue(currentId);
        const mappingVal = (fix && fix.mapping) ? fix.mapping : (dep.mapping || DEFAULT_FOREIGN_MAPPING);
        const secondMappingVal = (fix && fix.second_mapping) ? fix.second_mapping : (dep.second_mapping || '');
        const bankVal = dep.bank || DEFAULT_FOREIGN_BANK;

        if (currentId && (byId.has(currentId) || (normCurrentId && byId.has(normCurrentId)))) {
            const st = byId.get(currentId) || byId.get(normCurrentId);
            const resolvedSid = normCurrentId && byId.has(normCurrentId) ? normCurrentId : currentId;
            return {
                ...dep,
                student_id: resolvedSid,
                mapping: mappingVal,
                second_mapping: secondMappingVal,
                bank: bankVal,
                matched_student_name: st.full_name || st.arabic_name || dep.matched_student_name || '',
                id_status: validateID(resolvedSid),
                match_source: fix ? 'manual' : (dep.match_source === 'manual' ? 'manual' : 'statement_id')
            };
        }

        if (currentId && validateID(currentId) === 'Valid') {
            return {
                ...dep,
                student_id: currentId,
                mapping: mappingVal,
                second_mapping: secondMappingVal,
                bank: bankVal,
                id_status: 'Valid',
                match_source: fix ? 'manual' : (dep.match_source || 'statement_id')
            };
        }

        // Try matching by extracted_name (and handler_name as tie-breaker)
        const queryNorm = normalizePersonName(dep.extracted_name || '');
        const queryTokens = queryNorm ? queryNorm.split(' ').filter(t => t.length >= 2) : [];
        const handlerNorm = normalizePersonName(dep.handler_name || '');
        const handlerTokens = handlerNorm ? handlerNorm.split(' ').filter(t => t.length >= 2) : [];

        if (queryTokens.length >= 2 && preparedStudents.length > 0) {
            let bestCandidate = null;
            let bestScore = 0;
            let secondBestScore = 0;

            for (const cand of preparedStudents) {
                if (!cand.sid) continue;
                const arScore = scoreTokenOverlap(queryNorm, queryTokens, cand.normAr, cand.arTokens);
                const enScore = scoreTokenOverlap(queryNorm, queryTokens, cand.normEn, cand.enTokens);
                let score = Math.max(arScore, enScore);

                if (score >= 0.65 && handlerTokens.length >= 2) {
                    const gScore = Math.max(
                        scoreTokenOverlap(handlerNorm, handlerTokens, cand.normGuardian, cand.guardianTokens),
                        scoreTokenOverlap(handlerNorm, handlerTokens, cand.normAr, cand.arTokens)
                    );
                    // Not capped at 1.0: the guardian/handler bonus may break a tie between two
                    // students with identical names, but must never turn one into an automatic pass.
                    if (gScore >= 0.5) score = score + 0.12;
                }

                if (score > bestScore) {
                    if (cand.sid !== bestCandidate?.sid) secondBestScore = bestScore;
                    bestScore = score;
                    bestCandidate = cand;
                } else if (score > secondBestScore && cand.sid !== bestCandidate?.sid) {
                    secondBestScore = score;
                }
            }

            // Always require a clear lead over the runner-up: two students with the same full
            // name both score 1.0, and picking the first one silently books the deposit wrongly.
            if (bestCandidate && bestScore >= 0.72 && (bestScore - secondBestScore) >= 0.05) {
                return {
                    ...dep,
                    student_id: bestCandidate.sid,
                    mapping: mappingVal,
                    second_mapping: secondMappingVal,
                    bank: bankVal,
                    matched_student_name: bestCandidate.student.full_name || bestCandidate.student.arabic_name || '',
                    id_status: validateID(bestCandidate.sid),
                    match_source: 'name_match',
                    match_confidence: Math.min(100, Math.round(bestScore * 100))
                };
            }
        }

        return {
            ...dep,
            student_id: currentId,
            mapping: mappingVal,
            second_mapping: secondMappingVal,
            bank: bankVal,
            id_status: validateID(currentId)
        };
    });
}
