import { expect, test, vi } from 'vitest';
import { validateID, originalItemName, applyBusinessRules, toDateOnly, dateToExcelSerial, calculateSettlementDate, isSameDaySettlementBank, resolveErpJournalDate, normalizeItemName, buildMappingLookup, sanitizeExcelValue, sanitizeExcelRows } from '../rules.js';
import { parseBankStatementGrid, parseBanqueMisrPdfText, reconstructBanqueMisrPdfLinesFromPages, matchForeignDepositsToStudents, normalizeArabicPresentation, orderBidiPdfLineItems } from '../foreign-transactions.js';
import { createEmptyFxStore, extractUsdEgpFromPayload, resolveUsdToEgpRate, convertUsdToEgp, setManualFxRate, syncMissingFxRates } from '../fx-rates.js';

vi.mock('../supabase.js', () => ({
    supabase: {}
}));

test('validateID tests', () => {
    expect(validateID(null)).toBe('Missing ID');
    expect(validateID('')).toBe('Missing ID');
    expect(validateID('DIP12345678901234')).toBe('Valid');
    expect(validateID('123abc456')).toBe('Error: Text/Name detected');
    expect(validateID('123')).toBe('Error: ID Too Short (3 digits)');
    expect(validateID('1234567890')).toBe('Error: ID Too Long (10 digits)');
    expect(validateID('2023123')).toBe('Error: Invalid 2-Series Length (7 digits)');
    expect(validateID('202312345')).toBe('Valid');
});

test('originalItemName tests', () => {
    expect(originalItemName({ reference_number: 'REF1', check_column: 'REF1-OrigItem' })).toBe('OrigItem');
    expect(originalItemName({ reference_number: 'REF2', check_column: null, item_name: 'Fallback' })).toBe('Fallback');
});

test('applyBusinessRules precedence logic', () => {
    const base = { studentId: '12345', itemName: 'Tuition' };
    
    // No links, no fixes, no mappings
    const res1 = applyBusinessRules(base, { lookupMapping: () => undefined });
    expect(res1.studentId).toBe('12345');
    expect(res1.itemName).toBe('Tuition');
    
    // With link override
    const link = { custom_input_value: '54321' };
    const res2 = applyBusinessRules(base, { link, lookupMapping: () => undefined });
    expect(res2.studentId).toBe('54321');
    
    // With fix override
    const fix = { correct_id: '99999', item_name: 'FixedTuition', mapping: 'Finance', second_mapping: 'DeptA' };
    const res3 = applyBusinessRules(base, { fix, lookupMapping: () => undefined });
    expect(res3.studentId).toBe('99999');
    expect(res3.itemName).toBe('FixedTuition');
    expect(res3.mapping).toBe('Finance');
    expect(res3.secondMapping).toBe('DeptA');
    
    // With mapping rule lookup
    const lookupMapping = (name) => {
        if (name === 'Tuition') return { adjusted_item_name: 'AdjTuition', mapping: 'Fin', second_mapping: 'Sec' };
        return undefined;
    };
    const res4 = applyBusinessRules(base, { lookupMapping });
    expect(res4.itemName).toBe('AdjTuition');
    expect(res4.mapping).toBe('Fin');
    expect(res4.secondMapping).toBe('Sec');

    // Invalid link.custom_input_value (e.g. 14-digit National ID or text note) must NOT overwrite an already-Valid base studentId
    const res5 = applyBusinessRules(
        { studentId: '202312345', itemName: 'Tuition' },
        { link: { custom_input_value: '29901011234567' }, lookupMapping: () => undefined }
    );
    expect(res5.studentId).toBe('202312345');
    expect(res5.idStatus).toBe('Valid');

    // Invalid link.custom_input_value is still used when base studentId is missing or invalid
    const res6 = applyBusinessRules(
        { studentId: null, itemName: 'Tuition' },
        { link: { custom_input_value: '29901011234567' }, lookupMapping: () => undefined }
    );
    expect(res6.studentId).toBe('29901011234567');
    expect(res6.idStatus).toBe('Error: ID Too Long (14 digits)');
});

test('toDateOnly strips time without shifting calendar date', () => {
    expect(toDateOnly(null)).toBeNull();
    expect(toDateOnly('')).toBeNull();
    expect(toDateOnly('2025-08-01')).toBe('2025-08-01');
    expect(toDateOnly('2025-08-01T00:00:00.000Z')).toBe('2025-08-01');
    expect(toDateOnly('2025-08-01T03:00:00+03:00')).toBe('2025-08-01');
    expect(toDateOnly('2025-08-01 23:59:59')).toBe('2025-08-01');
    expect(toDateOnly('01/08/2025 3:00:00 AM')).toBe('2025-08-01');
    expect(toDateOnly('8/15/2025 3:00:00 AM')).toBe('2025-08-15');
    // Excel serial 45870 = 2025-08-01, 45870.125 = 2025-08-01 3:00:00 AM, 45870.99 = 2025-08-01 late night
    expect(toDateOnly(45870)).toBe('2025-08-01');
    expect(toDateOnly(45870.125)).toBe('2025-08-01');
    expect(toDateOnly(45870.99)).toBe('2025-08-01');
});

test('dateToExcelSerial returns exact integer serial with zero fractional time', () => {
    expect(dateToExcelSerial('2025-08-01')).toBe(45870);
    expect(dateToExcelSerial('2025-08-01T03:00:00.000Z')).toBe(45870);
    expect(dateToExcelSerial('01/08/2025 3:00:00 AM')).toBe(45870);
    expect(Number.isInteger(dateToExcelSerial('2025-08-01'))).toBe(true);
    expect(dateToExcelSerial('')).toBeNull();
});

test('normalizeItemName and buildMappingLookup handle whitespace, casing, and adjusted item names', () => {
    expect(normalizeItemName('  Tuition\u00A0  Fees - Fall  ')).toBe('Tuition Fees - Fall');
    const lookup = buildMappingLookup([
        { item_name: 'Tuition Fees - Fall', adjusted_item_name: 'Fall Tuition 2025', mapping: 'Tuition', second_mapping: 'Undergrad' }
    ]);
    // Exact match
    expect(lookup('Tuition Fees - Fall')?.mapping).toBe('Tuition');
    // Case + extra space match
    expect(lookup('  tuition   fees - fall ')?.mapping).toBe('Tuition');
    // Reverse lookup via adjusted_item_name
    expect(lookup('Fall Tuition 2025')?.item_name).toBe('Tuition Fees - Fall');
    expect(lookup('  fall  tuition 2025 ')?.mapping).toBe('Tuition');
    expect(lookup('Nonexistent')).toBeUndefined();
});




test('sanitizeExcelValue and sanitizeExcelRows neutralize formula injection', () => {
    expect(sanitizeExcelValue('=CMD|\' /C calc\'!A0')).toBe('\'=CMD|\' /C calc\'!A0');
    expect(sanitizeExcelValue('+1+2')).toBe('\'+1+2');
    expect(sanitizeExcelValue('-SUM(A1:A5)')).toBe('\'-SUM(A1:A5)');
    expect(sanitizeExcelValue('@SUM(A1:A5)')).toBe('\'@SUM(A1:A5)');
    expect(sanitizeExcelValue('\t=1+1')).toBe('\'\t=1+1');
    expect(sanitizeExcelValue('  =HYPERLINK("http://evil")')).toBe('\'  =HYPERLINK("http://evil")');
    expect(sanitizeExcelValue('Normal Student Name')).toBe('Normal Student Name');
    expect(sanitizeExcelValue(41718.5)).toBe(41718.5);
    expect(sanitizeExcelValue(-150.25)).toBe(-150.25);

    const rows = [
        { Name: '=EVIL()', Amount: 500, Note: 'Safe' },
        ['@AT', 100, '+PLUS']
    ];
    const cleaned = sanitizeExcelRows(rows);
    expect(cleaned[0]).toEqual({ Name: '\'=EVIL()', Amount: 500, Note: 'Safe' });
    expect(cleaned[1]).toEqual(['\'@AT', 100, '\'+PLUS']);
});

test('calculateSettlementDate shifts Sun-Wed by +1 day and Thu/Fri/Sat to Sunday', () => {
    expect(calculateSettlementDate(null)).toBeNull();
    expect(calculateSettlementDate('')).toBeNull();

    // Nov 2026 calendar week:
    // 2026-11-01 = Sunday    -> 2026-11-02 (Monday, +1d)
    // 2026-11-02 = Monday    -> 2026-11-03 (Tuesday, +1d)
    // 2026-11-03 = Tuesday   -> 2026-11-04 (Wednesday, +1d)
    // 2026-11-04 = Wednesday -> 2026-11-05 (Thursday, +1d)
    // 2026-11-05 = Thursday  -> 2026-11-08 (Sunday, +3d)
    // 2026-11-06 = Friday    -> 2026-11-08 (Sunday, +2d)
    // 2026-11-07 = Saturday  -> 2026-11-08 (Sunday, +1d)
    expect(calculateSettlementDate('2026-11-01')).toBe('2026-11-02');
    expect(calculateSettlementDate('2026-11-02')).toBe('2026-11-03');
    expect(calculateSettlementDate('2026-11-03')).toBe('2026-11-04');
    expect(calculateSettlementDate('2026-11-04')).toBe('2026-11-05');
    expect(calculateSettlementDate('2026-11-05')).toBe('2026-11-08');
    expect(calculateSettlementDate('2026-11-06')).toBe('2026-11-08');
    expect(calculateSettlementDate('2026-11-07')).toBe('2026-11-08');

    // Month/Year rollover on Thursday (2026-12-31 is Thursday -> settles Sunday 2027-01-03)
    expect(calculateSettlementDate('2026-12-31T14:22:00Z')).toBe('2027-01-03');
});

test('parseBankStatementGrid extracts genuine student deposits and filters out REVR reversals & TD/T02/T06 bank rows', () => {
    const sampleGrid = [
        ['كشف حساب'],
        ['', '', 'اسم العميل', 'جامعة النيل الاهلية', '', 'العملة', 'USD', '', 'تاريخ البداية', '2026-02-01'],
        ['', '', 'رقم الفرع', '770', '', 'الرصيد الافتتاحي', '70366.58', '', 'تاريخ النهاية', '2026-02-03'],
        ['', '', 'رقم الحساب', '7700120000000557', '', 'الرصيد الحالي', '168167.65'],
        ['الرصيد بعد المعاملة', 'دائن', 'مدين', 'تاريخ و وقت المعاملة', 'تاريخ الحق', 'البيان', 'رقم المستند', 'الرقم المرجعي', 'كود الحركة', 'رقم الحركة', 'الحدث'],
        ['70765.72', '399.14', '0', '2026-01-29 13:20:24', '2026-01-30', 'عائد ودائع | رقم 7700520000004779', '', '', 'TD3', '770C140USD 00001', 'ILIQ'],
        ['170765.72', '100000', '0', '2026-01-29 13:20:24', '2026-01-30', 'تجديد / الغاء وديعة ألياً | رقم 7700520000004779', '', '', 'TD4', '770C140260320001', 'IMAT'],
        ['172098.19', '1332.47', '0', '2026-02-01 09:14:25', '2026-02-01', 'ايداع نقدى | محمد خوجلي عثمان النور / 241000261 / بمناولة / هناء صلاح بن ادريس - ', '', 'FJB2603229880580', 'CHF', '512CHFD260320001', 'INIT'],
        ['172298.98', '200.79', '0', '2026-02-01 11:35:38', '2026-02-01', 'ايداع نقدى | ABEER MAZEN / 241002241/ بمناولة / اسامه محمد ابوالعلا محمد - ', '', 'FJB2603229948236', 'CHF', '512CHFD260322010', 'INIT'],
        ['172499.77', '200.79', '0', '2026-02-01 11:39:13', '2026-02-01', 'ايداع نقدى | GADEER MAZEN / 241002240 / بمناولة / اسامه محمد ابوالعلا محمد - ', '', 'FJB2603229951583', 'CHF', '512CHFD260322011', 'INIT'],
        ['173079.24', '579.47', '0', '2026-02-01 15:16:42', '2026-02-01', 'ايداع نقدى | عبدالرحمن غسان منصور / id 211000875 - ', '', 'FJB2603230057683', 'CHF', '186CHFD260320026', 'INIT'],
        ['173280.03', '200.79', '0', '2026-02-01 11:32:02', '2026-02-03', 'ايداع نقدى | GADEER MAZEN / 241002240 / بمناولة / اسامه محمد ابوالعلا محمد - ', '', 'FJB2603229948998', 'CHF', '512CHFD260320007', 'INIT'],
        ['173079.24', '0', '200.79', '2026-02-01 11:35:29', '2026-02-03', 'ايداع نقدى | GADEER MAZEN / 241002240 / بمناولة / اسامه محمد ابوالعلا محمد - ', '', 'FJB2603229948998', 'CHF', '512CHFD260320007', 'REVR'],
        ['173658.71', '579.47', '0', '2026-02-01 15:07:36', '2026-02-03', 'ايداع نقدى | عبدالرحمن غسان منصور / id 211000875 - ', '', 'FJB2603230051391', 'CHF', '186CHFD260320025', 'INIT'],
        ['173079.24', '0', '579.47', '2026-02-01 15:17:02', '2026-02-03', 'ايداع نقدى | عبدالرحمن غسان منصور / id 211000875 - ', '', 'FJB2603230051391', 'CHF', '186CHFD260320025', 'REVR'],
        ['173978.71', '899.47', '0', '2026-02-02 11:53:46', '2026-02-02', 'ايداع نقدى | محمد يحيي المغربي - ID 241002560 - ', '', 'FJB2603330195850', 'CHF', '391CHFD260330015', 'INIT'],
        ['173923.65', '0', '55.06', '2026-02-02 13:42:35', '2026-02-02', 'عمولة تحاويل بالسويفت | - 100FCOT260330017', '', '', 'T06', '100FCOT260330017', 'INIT'],
        ['168167.65', '0', '5756', '2026-02-02 13:42:35', '2026-02-02', 'تحاويل صادرة إلى الخارج | - 100FCOT260330017', '', '', 'T02', '100FCOT260330017', 'INIT']
    ];

    const res = parseBankStatementGrid(sampleGrid);
    expect(res.metadata.accountNumber).toBe('7700120000000557');
    expect(res.metadata.currency).toBe('USD');
    expect(res.excludedReversals.length).toBe(4); // 2 INIT + 2 REVR rows cancelled out
    expect(res.excludedTreasury.length).toBe(4);  // TD3, TD4, T06, T02
    expect(res.deposits.length).toBe(5);          // Exactly 5 genuine student deposits

    expect(res.deposits.map(d => d.student_id)).toEqual([
        '241000261',
        '241002241',
        '241002240',
        '211000875',
        '241002560'
    ]);
    expect(res.deposits[0].extracted_name).toBe('محمد خوجلي عثمان النور');
    expect(res.deposits[0].handler_name).toBe('هناء صلاح بن ادريس');
    expect(res.deposits[0].amount).toBe(1332.47);
});

test('parseBanqueMisrPdfText and matchForeignDepositsToStudents resolve IDs and fuzzy Arabic/English names', () => {
    const samplePdfText = `
        Statement of Account
        Customer Name جامعة النيل الاهلية
        Account Number 7700120000000557
        Currency USD
        Date From 01-01-2026 Date To 01-02-2026
        44,997.21 0.00 100,000.00 04-01-2026 16:15:43 30-12-2025 Booking TD Number 7700520000004779 770DEBK2600407PT TD1 770DEBK2600407PT DEBK
        447,891.29 1,260.00 0.00 05-01-2026 08:23:25 05-01-2026 INCOMING SWIFT TRANSFER OUTSIDE EGYPT - EMAD ABDULSALAM ALZUQZUQ - /ROC/NCBK82825364BBMQ T35 100FOUR260050002 INIT
        448,798.76 907.47 0.00 05-01-2026 13:10:13 05-01-2026 Cash Deposit سولاف انس الزعبي مناوله ساره انس الزعبي FJB2600526662342 CHF 519CHFD260050014 INIT
        452,637.23 1,305.00 0.00 11-01-2026 11:59:51 12-01-2026 Cash Deposit ربح سفيان السنونس الوزري ID-231002371 FJB2601127264187 CHF 770CHFD260110015 INIT
        451,332.23 0.00 1,305.00 11-01-2026 12:05:39 12-01-2026 Cash Deposit ربح سفيان السنونس الوزري ID-231002371 FJB2601127264187 CHF 770CHFD260110015 REVR
    `;

    const parsed = parseBanqueMisrPdfText(samplePdfText);
    expect(parsed.metadata.accountNumber).toBe('7700120000000557');
    expect(parsed.excludedReversals.length).toBe(2);
    expect(parsed.excludedTreasury.length).toBe(1);
    expect(parsed.deposits.length).toBe(2);

    const matched = matchForeignDepositsToStudents(parsed.deposits, [
        { student_id: '241009901', full_name: 'Emad Abdulsalam Alzuqzuq', arabic_name: 'عماد عبدالسلام الزقزوق' },
        { student_id: '241009902', full_name: 'Solaf Anas Alzoubi', arabic_name: 'سولاف أنس الزعبي', guardian_name: 'سارة أنس الزعبي' }
    ]);

    expect(matched[0].student_id).toBe('241009901');
    expect(matched[0].id_status).toBe('Valid');
    expect(matched[0].match_source).toBe('name_match');

    expect(matched[1].student_id).toBe('241009902');
    expect(matched[1].id_status).toBe('Valid');
    expect(matched[1].match_source).toBe('name_match');
    expect(matched[0].mapping).toBe('Tuition');
    expect(matched[0].bank).toBe('NuMisrUsd5');
});

test('reconstructBanqueMisrPdfLinesFromPages handles vertically centered cells and Currency Current Balance header', () => {
    const page1Items = [
        { str: 'Statement of Account', x: 400, y: 550 },
        { str: 'Branch Number', x: 50, y: 492 },
        { str: 'Currency', x: 250, y: 492 },
        { str: 'Current Balance', x: 450, y: 492 },
        { str: '770', x: 50, y: 477 },
        { str: 'USD', x: 250, y: 477 },
        { str: '493,658.47', x: 450, y: 477 },
        { str: 'Account Number', x: 50, y: 453 },
        { str: '7700120000000557', x: 50, y: 438 },
        // Row 1: vertically centered anchor at y=354, with description line 1 at y=360 and line 2 at y=348
        { str: 'Cash Deposit', x: 350, y: 360 },
        { str: 'تسنيم عمر الصادق الكاروري', x: 420, y: 360 },
        { str: '449,548.23', x: 40, y: 354 },
        { str: '749.47', x: 110, y: 354 },
        { str: '0.00', x: 160, y: 354 },
        { str: '05-01-2026 15:08:50', x: 210, y: 354 },
        { str: '06-01-2026', x: 290, y: 354 },
        { str: 'FJB2600526681048', x: 560, y: 354 },
        { str: 'CHF', x: 650, y: 354 },
        { str: '512CHFD260050030', x: 690, y: 354 },
        { str: 'INIT', x: 780, y: 354 },
        { str: '241002323', x: 350, y: 348 },
        { str: 'بمناولة امنيه النور احمد عبدالحميد', x: 410, y: 348 },
        // Row 2: deposit without Student ID (should still be extracted, never excluded)
        { str: 'Cash Deposit', x: 350, y: 316 },
        { str: 'فاطمة محمد اسماعيل', x: 420, y: 316 },
        { str: '450,853.23', x: 40, y: 310 },
        { str: '1,305.00', x: 110, y: 310 },
        { str: '0.00', x: 160, y: 310 },
        { str: '08-01-2026 11:25:10', x: 210, y: 310 },
        { str: '08-01-2026', x: 290, y: 310 },
        { str: 'FJB2600826955342', x: 560, y: 310 },
        { str: 'CHF', x: 650, y: 310 },
        { str: '133CHFD260080005', x: 690, y: 310 },
        { str: 'INIT', x: 780, y: 310 },
        { str: 'مناولة خالد محمود', x: 350, y: 304 }
    ];

    const reconstructedText = reconstructBanqueMisrPdfLinesFromPages([page1Items]);
    const parsed = parseBanqueMisrPdfText(reconstructedText);

    expect(parsed.metadata.currency).toBe('USD');
    expect(parsed.metadata.accountNumber).toBe('7700120000000557');
    expect(parsed.deposits.length).toBe(2);
    expect(parsed.deposits[0].reference_number).toBe('FJB2600526681048');
    expect(parsed.deposits[0].student_id).toBe('241002323');
    expect(parsed.deposits[0].id_status).toBe('Valid');
    expect(parsed.deposits[0].mapping).toBe('Tuition');
    expect(parsed.deposits[0].bank).toBe('NuMisrUsd5');

    // Second deposit has no ID in statement and is still extracted as Missing ID
    expect(parsed.deposits[1].reference_number).toBe('FJB2600826955342');
    expect(parsed.deposits[1].student_id).toBe('');
    expect(parsed.deposits[1].id_status).toBe('Missing ID');
    expect(parsed.deposits[1].mapping).toBe('Tuition');
    expect(parsed.deposits[1].bank).toBe('NuMisrUsd5');
});

test('reconstructBanqueMisrPdfLinesFromPages normalizes Arabic presentation forms and restores RTL word order', () => {
    // Reproduces real Banque Misr PDF spans: Presentation Forms-B tokens ordered visually left-to-right (so Arabic runs right-to-left)
    const pdfSpans = [
        { str: '\uFE8D\uFEDF\uFE8E\uFEEB\uFEE0\uFEF4\uFE94', x: 12.82, y: 540.03 }, // الاهلية
        { str: '\uFE8D\uFEDF\uFEE8\uFEF4\uFEDE', x: 40.62, y: 540.03 }, // النيل
        { str: '\uFE9F\uFE8E\uFEE3\uFECC\uFE94', x: 58.90, y: 540.03 }, // جامعة
        { str: 'Statement of Account', x: 360.00, y: 540.03 },
        { str: 'Account Number', x: 12.82, y: 453.00 },
        { str: '7700120000000557', x: 12.82, y: 438.00 },
        { str: 'Currency', x: 250.00, y: 492.00 },
        { str: 'USD', x: 250.00, y: 477.00 },

        // Transaction 1: multi-line Arabic with Presentation Forms in visual LTR order
        { str: 'Cash Deposit ', x: 329.77, y: 290.27 },
        { str: '\uFEB3\uFE8E\uFEAE\uFEE9', x: 365.14, y: 290.27 }, // ساره
        { str: '\uFEE3\uFEE8\uFE8E\uFEED\uFEDF\uFEEA', x: 378.15, y: 290.27 }, // مناوله
        { str: '\uFE8D\uFEDF\uFEAF\uFECB\uFE92\uFEF2', x: 395.13, y: 290.27 }, // الزعبي
        { str: '\uFE8D\uFEE7\uFEB2', x: 412.01, y: 290.27 }, // انس
        { str: '\uFEB3\uFEEE\uFEFC\uFED1', x: 423.91, y: 290.27 }, // سولاف

        { str: '448,798.76', x: 13.00, y: 284.27 },
        { str: '907.47', x: 90.00, y: 284.27 },
        { str: '0.00', x: 150.00, y: 284.27 },
        { str: '05-01-2026 13:10:13', x: 205.00, y: 284.27 },
        { str: '05-01-2026', x: 285.00, y: 284.27 },
        { str: 'FJB2600526662342', x: 560.00, y: 284.27 },
        { str: 'CHF', x: 650.00, y: 284.27 },
        { str: '519CHFD260050014', x: 690.00, y: 284.27 },
        { str: 'INIT', x: 780.00, y: 284.27 },

        // Transaction 2: Arabic with bridged '/' separator and Student ID on left
        { str: 'Cash Deposit  - ', x: 329.77, y: 231.84 },
        { str: '\uFECB\uFE92\uFEAA\uFE8D\uFEDF\uFEAE\uFEA3\uFEE3\uFEE6', x: 369.90, y: 231.84 }, // عبدالرحمن
        { str: '\uFE8D\uFEDF\uFEC1\uFEF4\uFE90', x: 396.27, y: 231.84 }, // الطيب
        { str: '\uFEA9\uFECB\uFE8E\uFE80', x: 411.89, y: 231.84 }, // دعاء

        { str: '449,700.00', x: 13.00, y: 225.84 },
        { str: '901.24', x: 90.00, y: 225.84 },
        { str: '0.00', x: 150.00, y: 225.84 },
        { str: '06-01-2026 10:00:00', x: 205.00, y: 225.84 },
        { str: '06-01-2026', x: 285.00, y: 225.84 },
        { str: 'FJB2600626700001', x: 560.00, y: 225.84 },
        { str: 'CHF', x: 650.00, y: 225.84 },
        { str: '519CHFD260060001', x: 690.00, y: 225.84 },
        { str: 'INIT', x: 780.00, y: 225.84 },

        { str: '231002670', x: 329.77, y: 219.84 },
        { str: '\uFECB\uFE92\uFEAA\uFE8D\uFEDF\uFEAE\uFEA3\uFEE3\uFEE6', x: 357.52, y: 219.84 }, // عبدالرحمن
        { str: '\uFE8D\uFEDF\uFEC1\uFEF4\uFE90', x: 383.89, y: 219.84 }, // الطيب
        { str: '\uFE8D\uFEDF\uFE92\uFEAE\uFE8D\uFE80', x: 399.51, y: 219.84 }, // البراء
        { str: '/', x: 411.22, y: 219.84 },
        { str: '\uFE91\uFEE3\uFEE8\uFE8E\uFEED\uFEDF\uFE94', x: 413.62, y: 219.84 } // بمناولة
    ];

    expect(normalizeArabicPresentation('\uFEB3\uFEEE\uFEFC\uFED1')).toBe('سولاف');
    const orderedHeader = orderBidiPdfLineItems([
        { str: 'الاهلية', x: 12.82 },
        { str: 'النيل', x: 40.62 },
        { str: 'جامعة', x: 58.90 }
    ]);
    expect(orderedHeader.map(i => i.str).join(' ')).toBe('جامعة النيل الاهلية');

    const text = reconstructBanqueMisrPdfLinesFromPages([pdfSpans]);
    expect(text).not.toMatch(/[\uFB50-\uFDFF\uFE70-\uFEFF]/);
    expect(text).toContain('جامعة النيل الاهلية');

    const parsed = parseBanqueMisrPdfText(text);
    expect(parsed.deposits.length).toBe(2);
    expect(parsed.deposits[0].description).toBe('Cash Deposit سولاف انس الزعبي مناوله ساره');
    expect(parsed.deposits[1].student_id).toBe('231002670');
    expect(parsed.deposits[1].description).toContain('دعاء الطيب عبدالرحمن');
    expect(parsed.deposits[1].description).toContain('بمناولة / البراء الطيب عبدالرحمن');
});

test('sanitizeExcelRows normalizes Arabic presentation forms for Excel exports', () => {
    const clean = sanitizeExcelRows([
        {
            Description: 'Cash Deposit \uFEB3\uFEEE\uFEFC\uFED1 \uFE8D\uFEE7\uFEB2',
            Note: '=\uFEB3\uFEEE\uFEFC\uFED1'
        }
    ]);
    expect(clean[0].Description).toBe('Cash Deposit سولاف انس');
    expect(clean[0].Description).not.toMatch(/[\uFB50-\uFDFF\uFE70-\uFEFF]/);
    expect(clean[0].Note).toBe("'=سولاف");
});

test('isSameDaySettlementBank and resolveErpJournalDate keep NuMisrUsd5 on exact value date while shifting Fawry', () => {
    const fawryThu = { bank: 'NUADIB64', payment_date: '2026-11-12' }; // Thursday
    const foreignThu = { bank: 'NuMisrUsd5', value_date: '2026-01-08', payment_date: '2026-01-08' }; // Thursday

    expect(isSameDaySettlementBank(fawryThu)).toBe(false);
    expect(isSameDaySettlementBank(foreignThu)).toBe(true);

    // Settlement mode: Fawry shifts Thu -> Sun, while NuMisrUsd5 stays on exact same Value Date
    expect(resolveErpJournalDate(fawryThu, 'settlement')).toBe('2026-11-15');
    expect(resolveErpJournalDate(foreignThu, 'settlement')).toBe('2026-01-08');

    // Payment mode: both stay on their exact payment/value date
    expect(resolveErpJournalDate(fawryThu, 'payment')).toBe('2026-11-12');
    expect(resolveErpJournalDate(foreignThu, 'payment')).toBe('2026-01-08');

    // Custom override mode: custom date wins when explicitly chosen
    expect(resolveErpJournalDate(foreignThu, 'custom', '2026-01-11')).toBe('2026-01-11');
});

test('FX rates support Per-Tx Value Date, Latest Daily Rate, Custom override, and async sync', async () => {
    expect(extractUsdEgpFromPayload({ date: '2026-01-05', usd: { egp: 50.25 } })).toBe(50.25);
    expect(extractUsdEgpFromPayload({ rates: { EGP: 49.8 } })).toBe(49.8);

    let store = createEmptyFxStore();
    // Empty store falls back to DEFAULT_USD_EGP_FALLBACK_RATE (never 0)
    expect(resolveUsdToEgpRate('2026-01-05', store).rate).toBeGreaterThan(0);

    store.ratesByDate['2026-01-05'] = { rate: 50.0, source: 'auto' };
    store.ratesByDate['2026-01-08'] = { rate: 48.0, source: 'auto' };
    store.latest = { date: '2026-01-15', rate: 51.0, source: 'auto' };

    // Historical mode (default): uses exact date or nearest prior date
    expect(convertUsdToEgp(1000, '2026-01-05', store).egpAmount).toBe(50000);
    expect(convertUsdToEgp(500, '2026-01-06', store).rate).toBe(50.0); // nearest prior (Jan 5)
    expect(convertUsdToEgp(500, '2026-01-08', store).egpAmount).toBe(24000);

    // Latest mode: applies store.latest.rate regardless of deposit date
    expect(convertUsdToEgp(1000, '2026-01-05', store, { mode: 'latest' }).egpAmount).toBe(51000);

    // Manual override + Custom mode: preserves manual rate and uses customRate when mode='custom'
    store = setManualFxRate(store, { dateStr: '2026-01-10', rate: 52.5, applyAsLatest: true, customMode: true });
    expect(resolveUsdToEgpRate('2026-01-05', store).rate).toBe(52.5);
    expect(convertUsdToEgp(100, '2026-01-05', store).egpAmount).toBe(5250);

    // Sync missing dates with mocked fetch (must skip manual entries)
    store.mode = 'historical';
    const fetchedUrls = [];
    const mockFetch = async (url) => {
        fetchedUrls.push(url);
        return {
            ok: true,
            json: async () => ({ date: '2026-01-09', usd: { egp: 48.75 } })
        };
    };
    const res = await syncMissingFxRates(['2026-01-05', '2026-01-09', '2026-01-10'], store, {
        fetchImpl: mockFetch,
        todayStr: '2026-01-10'
    });
    expect(res.updatedCount).toBe(1);
    expect(store.ratesByDate['2026-01-09'].rate).toBe(48.75);
    expect(store.ratesByDate['2026-01-10'].rate).toBe(52.5); // manual preserved
    expect(fetchedUrls.some(u => u.includes('@2026-01-09'))).toBe(true);
});
