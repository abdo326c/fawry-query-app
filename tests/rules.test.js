import { expect, test, vi } from 'vitest';
import { validateID, originalItemName, applyBusinessRules, toDateOnly, dateToExcelSerial, calculateSettlementDate, normalizeItemName, buildMappingLookup, sanitizeExcelValue, sanitizeExcelRows } from '../rules.js';
import { parseBankStatementGrid, parseBanqueMisrPdfText, matchForeignDepositsToStudents } from '../foreign-transactions.js';

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
});
