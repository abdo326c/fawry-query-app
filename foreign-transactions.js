import { validateID, toDateOnly, escapeHTML } from './rules.js';

/**
 * Normalizes Arabic and English text for fuzzy student name comparison.
 * Unifies Alef variants (أ/إ/آ -> ا), Teh Marbuta (ة -> ه), Alef Maksura (ى -> ي),
 * collapses compound 'عبد ' prefixes ('عبد الرحمن' -> 'عبدالرحمن'), and strips diacritics.
 */
export function normalizePersonName(str) {
    if (!str) return '';
    return String(str)
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
export function parseStatementDate(raw) {
    if (!raw) return { dateOnly: null, dateTime: '' };
    const str = String(raw).trim();
    if (!str) return { dateOnly: null, dateTime: '' };

    const parts = str.split(/\s+/);
    const datePart = parts[0] || '';
    const timePart = parts[1] || '';

    // Check DD-MM-YYYY or YYYY-MM-DD
    let m = datePart.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);
    if (m) {
        const iso = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
        return { dateOnly: iso, dateTime: timePart ? `${iso} ${timePart}` : iso };
    }
    m = datePart.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if (m) {
        const day = parseInt(m[1], 10);
        const month = parseInt(m[2], 10);
        const year = m[3];
        const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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
        .replace(/\uFFFD/g, ' ') // replacement char from PDF encoding
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

    // If PDF RTL extraction placed part of the handler's last name on a trailing line after '-',
    // clean any stray hyphens
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

/**
 * Given raw statement rows (from CSV, Excel, or PDF), performs:
 * 1. Reversal pair detection (`INIT` + `REVR` sharing External Ref No or Transaction Reference)
 * 2. Treasury / Non-student filtering
 * 3. Student narrative extraction & ID validation
 *
 * Returns:
 *   {
 *     metadata: { customerName, accountNumber, iban, currency, branch, dateFrom, dateTo },
 *     deposits: [...valid student deposit objects],
 *     excludedReversals: [...reversed INIT/REVR rows],
 *     excludedTreasury: [...treasury / debit / fee rows]
 *   }
 */
export function processBankStatementRows(rawRows, metadata = {}) {
    const currency = metadata.currency || 'USD';
    const accountNumber = metadata.accountNumber || '';

    // Normalize each raw row
    const normalized = (rawRows || []).map((r, idx) => {
        const credit = parseStatementAmount(r.credit);
        const debit = parseStatementAmount(r.debit);
        const balanceAfter = parseStatementAmount(r.balance_after);
        const txDateParsed = parseStatementDate(r.transaction_date);
        const valDateParsed = parseStatementDate(r.value_date);
        const extRef = String(r.external_ref || '').trim();
        const txRef = String(r.transaction_ref || '').trim();
        const txCode = String(r.transaction_code || '').trim().toUpperCase();
        const event = String(r.event || '').trim().toUpperCase();
        const description = String(r.description || '').replace(/\s+/g, ' ').trim();

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

        deposits.push({
            reference_number: refNumber,
            external_ref: r.external_ref || '',
            transaction_ref: r.transaction_ref || '',
            transaction_code: r.transaction_code || 'CHF',
            event: r.event || 'INIT',
            value_date: r.value_date,
            transaction_date: r.transaction_date,
            transaction_datetime: r.transaction_datetime,
            amount: r.credit,
            currency,
            account_number: accountNumber,
            student_id: parsed.studentId || '',
            extracted_name: parsed.studentName || '',
            matched_student_name: '',
            handler_name: parsed.handlerName || '',
            deposit_method: parsed.depositMethod,
            description: r.description,
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
            dateTo: metadata.dateTo || ''
        },
        deposits,
        excludedReversals,
        excludedTreasury
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
        dateTo: ''
    };

    if (!Array.isArray(gridRows) || gridRows.length === 0) {
        return processBankStatementRows([], metadata);
    }

    let headerRowIdx = -1;
    let colMap = {};

    // Scan top 25 rows for metadata key-value pairs and locate the table header row
    for (let i = 0; i < Math.min(gridRows.length, 30); i++) {
        const row = (gridRows[i] || []).map(c => String(c ?? '').trim());
        const joined = row.join(' ');

        // Extract metadata from header block
        for (let c = 0; c < row.length - 1; c++) {
            const label = row[c];
            const nextVal = row[c + 1] || row[c + 2] || '';
            if (!label || !nextVal) continue;
            if (/اسم العميل|Customer Name/i.test(label)) metadata.customerName = nextVal;
            else if (/العملة|Currency/i.test(label)) metadata.currency = nextVal.toUpperCase();
            else if (/رقم الفرع|Branch Number/i.test(label)) metadata.branch = nextVal;
            else if (/^رقم الحساب$|^Account Number$/i.test(label)) metadata.accountNumber = nextVal;
            else if (/رقم الحساب الدولي|IBAN/i.test(label)) metadata.iban = nextVal;
            else if (/تاريخ البداية|Date From/i.test(label)) metadata.dateFrom = parseStatementDate(nextVal).dateOnly || nextVal;
            else if (/تاريخ النهاية|Date To/i.test(label)) metadata.dateTo = parseStatementDate(nextVal).dateOnly || nextVal;
        }

        // Detect table header row (Arabic or English)
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
            break;
        }
    }

    if (headerRowIdx === -1) {
        // Fallback standard Banque Misr 11-column positions if header row was omitted
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
 * Parses extracted text from a Banque Misr Statement of Account PDF (single or multi-page)
 * into metadata and transaction rows, then runs processBankStatementRows.
 */
export function parseBanqueMisrPdfText(fullText) {
    const text = String(fullText || '');
    const metadata = {
        customerName: 'جامعة النيل الاهلية',
        accountNumber: '',
        iban: '',
        currency: 'USD',
        branch: '',
        dateFrom: '',
        dateTo: ''
    };

    const accMatch = text.match(/Account\s+Number\s+([0-9]{10,20})/i) || text.match(/رقم الحساب\s+([0-9]{10,20})/);
    if (accMatch) metadata.accountNumber = accMatch[1];

    const ibanMatch = text.match(/\b(EG\d{27})\b/);
    if (ibanMatch) metadata.iban = ibanMatch[1];

    const currMatch = text.match(/Currency\s+([A-Z]{3})/i) || text.match(/العملة\s+([A-Z]{3})/i);
    if (currMatch) metadata.currency = currMatch[1].toUpperCase();

    const branchMatch = text.match(/Branch\s+Number\s+(\d{2,6})/i);
    if (branchMatch) metadata.branch = branchMatch[1];

    const fromMatch = text.match(/Date\s+From\s+(\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2})/i);
    if (fromMatch) metadata.dateFrom = parseStatementDate(fromMatch[1]).dateOnly || fromMatch[1];

    const toMatch = text.match(/Date\s+To\s+(\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2})/i);
    if (toMatch) metadata.dateTo = parseStatementDate(toMatch[1]).dateOnly || toMatch[1];

    // Match each transaction block starting with:
    // <BalanceAfter> <Credit> <Debit> <DD-MM-YYYY HH:MM:SS> <DD-MM-YYYY>
    // and ending with <TransCode> <TransactionReference> <Event: INIT|REVR|DEBK|ILIQ|IMAT>
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

        // Strip page footers / repeated page headers if a page break occurred after this row
        const pageBreakIdx = tail.search(/\b\d+\s*\/\s*\d+\b|Statement of Account|Customer Name\s+جامعة/i);
        if (pageBreakIdx !== -1) {
            tail = tail.slice(0, pageBreakIdx);
        }

        tail = tail.replace(/\s+/g, ' ').trim();

        // Extract trailing tokens: [External Ref No (optional)] <TransCode> <TransactionRef> <Event>
        // Example tail endings:
        //   "FJB2600526662342 CHF 519CHFD260050014 INIT"
        //   "T35 100FOUR260050002 INIT"
        //   "TD3 770C140USD 00001 ILIQ"
        //   "770DEBK2600407PT TD1 770DEBK2600407PT DEBK"
        let event = '';
        let txCode = '';
        let txRef = '';
        let extRef = '';
        let description = tail;

        const eventMatch = tail.match(/\b(INIT|REVR|DEBK|ILIQ|IMAT)\b\s*$/);
        if (eventMatch) {
            event = eventMatch[1];
            const beforeEvent = tail.slice(0, eventMatch.index).trim();
            const codeMatch = beforeEvent.match(/\b(CHF|T35|TD1|TD2|TD3|TD4|T02|T06)\s+([A-Z0-9\s]+?)\s*$/);
            if (codeMatch) {
                txCode = codeMatch[1];
                txRef = codeMatch[2].trim();
                let beforeCode = beforeEvent.slice(0, codeMatch.index).trim();
                const extMatch = beforeCode.match(/\b(FJB\d{10,16}|[0-9]{3}DEBK[A-Z0-9]+)\s*$/);
                if (extMatch) {
                    extRef = extMatch[1];
                    beforeCode = beforeCode.slice(0, extMatch.index).trim();
                }
                description = beforeCode;
            }
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
 * 1. Exact Student ID lookup (populates matched_student_name from student_master)
 * 2. Fuzzy Arabic / English Student Name & Guardian Name matching for rows missing a valid Student ID
 */
export function matchForeignDepositsToStudents(deposits, studentMasterList = []) {
    if (!Array.isArray(deposits) || deposits.length === 0) return [];
    const students = Array.isArray(studentMasterList) ? studentMasterList : [];

    const byId = new Map();
    const preparedStudents = students.map(s => {
        const sid = String(s.student_id || '').trim();
        if (sid) byId.set(sid, s);
        const normEn = normalizePersonName(s.full_name || '');
        const normAr = normalizePersonName(s.arabic_name || '');
        const normGuardian = normalizePersonName(s.guardian_name || '');
        return {
            student: s,
            sid,
            normEn,
            normAr,
            normGuardian,
            enTokens: normEn ? normEn.split(' ').filter(t => t.length >= 2) : [],
            arTokens: normAr ? normAr.split(' ').filter(t => t.length >= 2) : [],
            guardianTokens: normGuardian ? normGuardian.split(' ').filter(t => t.length >= 2) : []
        };
    });

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
        // Require first name token to match either first or last token of target (since PDF RTL sometimes reverses token order)
        const firstQ = queryTokens[0];
        const lastQ = queryTokens[queryTokens.length - 1];
        const firstT = targetTokens[0];
        const firstMatches = (firstQ === firstT || lastQ === firstT);
        const ratio = matched / Math.max(queryTokens.length, Math.min(targetTokens.length, 4));
        return firstMatches ? ratio : ratio * 0.75;
    };

    return deposits.map(dep => {
        const currentId = String(dep.student_id || '').trim();
        if (currentId && byId.has(currentId)) {
            const st = byId.get(currentId);
            return {
                ...dep,
                matched_student_name: st.full_name || st.arabic_name || dep.matched_student_name || '',
                id_status: validateID(currentId),
                match_source: dep.match_source === 'manual' ? 'manual' : 'statement_id'
            };
        }

        // If already has a valid 9-digit ID (even if student_master doesn't have that row yet), keep it Valid
        if (currentId && validateID(currentId) === 'Valid') {
            return {
                ...dep,
                id_status: 'Valid',
                match_source: dep.match_source || 'statement_id'
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
                    if (gScore >= 0.5) score = Math.min(1.0, score + 0.12);
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestCandidate = cand;
                }
            }

            if (bestCandidate && bestScore >= 0.72) {
                return {
                    ...dep,
                    student_id: bestCandidate.sid,
                    matched_student_name: bestCandidate.student.full_name || bestCandidate.student.arabic_name || '',
                    id_status: validateID(bestCandidate.sid),
                    match_source: 'name_match',
                    match_confidence: Math.round(bestScore * 100)
                };
            }
        }

        return {
            ...dep,
            id_status: validateID(currentId)
        };
    });
}
