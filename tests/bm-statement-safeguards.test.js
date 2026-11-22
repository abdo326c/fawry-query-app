import { expect, test, vi } from 'vitest';

vi.mock('../supabase.js', () => ({ supabase: {} }));

import {
    parseBankStatementGrid,
    analyzeBanqueMisrPdfLayout,
    crossCheckStatements,
    pairStatementFiles,
    checkStatementIntegrity,
    isKnownStatementHeader
} from '../foreign-transactions.js';

// Made-up Banque Misr Excel statement (same layout as the real export, incl. branch columns).
const HEADER = ['Balance After Txn', 'Credit', 'Debit', 'Transaction Date/Time', 'Value Date', 'Description',
    'Instrument Code', 'External Reference Number', 'Transaction Code', 'Transaction Reference', 'Event',
    'Executed Branch Code', 'Executed Branch Name'];

function grid({ opening = '1000.00', rows, header = HEADER, account = '7700120000000999' } = {}) {
    return [
        ['STATEMENT OF ACCOUNT'],
        ['', '', 'Customer Name:', 'Test University', '', 'Currency:', 'USD', '', 'Date From:', '2026-09-01'],
        ['', '', 'Branch Number:', '770', '', 'Opening Balance:', opening, '', 'Date To:', '2026-09-30'],
        ['', '', 'Account Number:', account],
        header,
        ...rows
    ];
}
const r = (bal, credit, debit, ref, desc, code = 'CHF', event = 'INIT') =>
    [bal, credit, debit, '2026-09-03 10:00:00', '2026-09-03', desc, '', ref, code, ref + 'T', event, '515', 'Branch'];

const goodRows = [
    r('1500.00', '500.00', '0', 'FJB0000000001', 'Cash Deposit | TEST ONE 261009991 - '),
    r('2250.50', '750.50', '0', 'FJB0000000002', 'Cash Deposit | TEST TWO 251009992 - '),
    r('2245.50', '0', '5.00', '', 'Incoming SWIFT Comm | TEST', 'T30')
];

test('a clean statement passes: columns known, running balance and totals add up', () => {
    const parsed = parseBankStatementGrid(grid({ rows: goodRows }));
    expect(parsed.metadata.openingBalance).toBe(1000);
    expect(parsed.integrity.errors).toEqual([]);
    expect(parsed.integrity.warnings).toEqual([]);
    expect(parsed.deposits).toHaveLength(2);
});

test('a missing, duplicated or edited amount breaks the running balance', () => {
    const edited = goodRows.map(x => [...x]);
    edited[1][1] = '850.50';                                    // amount changed, balances not
    const parsed = parseBankStatementGrid(grid({ rows: edited }));
    expect(parsed.integrity.errors.join(' ')).toMatch(/Running balance does not add up at 1 row.*FJB0000000002/);
    expect(parsed.integrity.errors.join(' ')).toMatch(/Totals do not reconcile/);

    const missingRow = parseBankStatementGrid(grid({ rows: [goodRows[0], goodRows[2]] }));
    expect(missingRow.integrity.errors.join(' ')).toMatch(/Running balance/);
});

test('a wrong opening balance is caught on the first row', () => {
    const parsed = parseBankStatementGrid(grid({ opening: '900.00', rows: goodRows }));
    expect(parsed.integrity.errors.join(' ')).toMatch(/Running balance.*FJB0000000001/);
});

test('Excel: a missing required column blocks; a new column only warns (columns are read by name)', () => {
    const noEvent = HEADER.map(h => (h === 'Event' ? 'Status' : h));
    const parsed = parseBankStatementGrid(grid({ header: noEvent, rows: goodRows }));
    expect(parsed.integrity.errors.join(' ')).toMatch(/Required column\(s\) missing.*Event/);

    const noDesc = HEADER.map(h => (h === 'Description' ? 'Narrative' : h));
    expect(parseBankStatementGrid(grid({ header: noDesc, rows: goodRows })).integrity.errors.join(' ')).toMatch(/header .* was not found/);

    const extra = [...HEADER, 'Channel'];
    const withExtra = parseBankStatementGrid(grid({ header: extra, rows: goodRows.map(x => [...x, 'ATM']) }));
    expect(withExtra.integrity.errors).toEqual([]);
    expect(withExtra.integrity.warnings.join(' ')).toMatch(/New column\(s\).*Channel/);
});

test('known header list covers both spellings the bank uses', () => {
    for (const h of ['Transcation Date/Time', 'Transaction Date/Time', 'External. Ref No', 'Executed Branch name', 'Balance After']) {
        expect(isKnownStatementHeader(h)).toBe(true);
    }
    expect(isKnownStatementHeader('Channel')).toBe(false);
});

test('descriptions glued from two rows are flagged (the old PDF bug)', () => {
    const { warnings } = checkStatementIntegrity([], [
        { reference_number: 'A', transaction_code: 'CHF', description: '515 Mall Misr TEST - Cash Deposit NEXT STUDENT' },
        { reference_number: 'B', transaction_code: 'CHF', description: 'Cash Deposit TEST ONE 261009991 -' }
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/A: .*starts with a branch code/);
    expect(warnings[0]).not.toMatch(/B:/);
});

test('PDF layout check: unknown header column or missing header is an error', () => {
    const headerItems = (labels) => labels.map((str, i) => ({ str, x: 10 + i * 60, y: 400 }));
    const rowItems = [{ str: '1,500.00', x: 13, y: 360 }, { str: '03-09-2026 10:00:00', x: 134, y: 360 }];
    const ok = analyzeBanqueMisrPdfLayout([[...headerItems(['Balance After', 'Credit', 'Debit', 'Transcation Date/Time', 'Value Date', 'Description', 'Instrument Code', 'External. Ref No', 'Transcation Code', 'Transaction Reference', 'Event', 'Executed Branch Code', 'Executed Branch name']), ...rowItems]]);
    expect(ok.errors).toEqual([]);

    const changed = analyzeBanqueMisrPdfLayout([[...headerItems(['Balance After', 'Credit', 'Debit', 'Transcation Date/Time', 'Value Date', 'Description', 'Instrument Code', 'External. Ref No', 'Transcation Code', 'Transaction Reference', 'Event', 'Channel']), ...rowItems]]);
    expect(changed.errors.join(' ')).toMatch(/unknown column\(s\) "Channel"/);

    const noHeader = analyzeBanqueMisrPdfLayout([rowItems]);
    expect(noHeader.errors.join(' ')).toMatch(/header was not found/);
});

// ---------------------------------------------------------------- Excel vs PDF
const dep = (ref, amount, description, value_date = '2026-09-03') => ({ reference_number: ref, amount, description, value_date });
const parsedOf = (deposits, meta = {}) => ({
    metadata: { accountNumber: '7700120000000999', dateFrom: '2026-09-01', dateTo: '2026-09-30', ...meta },
    deposits, excludedReversals: [], excludedTreasury: [], integrity: { errors: [], warnings: [] }
});

test('cross-check passes when Excel and PDF agree (punctuation/separator differences ignored)', () => {
    const x = parsedOf([dep('F1', 500, 'Cash Deposit | TEST ONE-261009991 -')]);
    const p = parsedOf([dep('F1', 500, 'Cash Deposit TEST ONE 261009991 -')]);
    expect(crossCheckStatements(x, p)).toMatchObject({ errors: [], compared: 1 });
});

test('cross-check catches an edited Excel amount, a changed ID, a misread PDF and missing rows', () => {
    const x = parsedOf([dep('F1', 600, 'Cash Deposit TEST ONE 261009991'), dep('F2', 100, 'Cash Deposit TEST TWO 261009999'), dep('F3', 50, 'X')]);
    const p = parsedOf([dep('F1', 500, 'Cash Deposit TEST ONE 261009991'), dep('F2', 100, 'Cash Deposit TEST TWO 261009992'), dep('F4', 70, 'Y')]);
    const { errors } = crossCheckStatements(x, p);
    const text = errors.join(' ');
    expect(text).toMatch(/differ on 4 deposit/);
    expect(text).toMatch(/F1: amount 600\.00 in Excel vs 500\.00 in PDF/);
    expect(text).toMatch(/F2: description differs/);
    expect(text).toMatch(/F3: in the Excel .* but not in the PDF/);
    expect(text).toMatch(/F4: in the PDF .* but not in the Excel/);
});

test('cross-check refuses files for different accounts or periods', () => {
    expect(crossCheckStatements(parsedOf([]), parsedOf([], { accountNumber: '7700120000000111' })).errors[0]).toMatch(/different accounts/);
    expect(crossCheckStatements(parsedOf([]), parsedOf([], { dateFrom: '2026-10-01', dateTo: '2026-10-31' })).errors[0]).toMatch(/different periods/);
});

// ---------------------------------------------------------------- pairing
test('Excel + its PDF: only the Excel is imported, the PDF cross-checks it', () => {
    const x = { name: 'Misr 557.xls', isPdf: false, parsed: parsedOf([dep('F1', 500, 'A')]) };
    const p = { name: 'Misr 557.pdf', isPdf: true, parsed: parsedOf([dep('F1', 500, 'A')]) };
    const { statements, integrity } = pairStatementFiles([p, x]);
    expect(statements.map(s => s.name)).toEqual(['Misr 557.xls']);
    expect(integrity.errors).toEqual([]);
    expect(integrity.passed.join(' ')).toMatch(/matches the bank's PDF Misr 557\.pdf on all 1 deposits/);
});

test('a disagreement between Excel and PDF blocks the import', () => {
    const x = { name: 'a.xls', isPdf: false, parsed: parsedOf([dep('F1', 600, 'A')]) };
    const p = { name: 'a.pdf', isPdf: true, parsed: parsedOf([dep('F1', 500, 'A')]) };
    const { integrity } = pairStatementFiles([x, p]);
    expect(integrity.errors.join(' ')).toMatch(/a\.xls vs a\.pdf: .*F1: amount/);
});

test('PDF only: imported with a warning; Excel only: imported with a "not cross-checked" warning', () => {
    const p = { name: 'only.pdf', isPdf: true, parsed: parsedOf([dep('F1', 500, 'A')]) };
    const pdfOnly = pairStatementFiles([p]);
    expect(pdfOnly.statements).toHaveLength(1);
    expect(pdfOnly.integrity.errors).toEqual([]);
    expect(pdfOnly.integrity.warnings.join(' ')).toMatch(/imported from the PDF only/);

    const x = { name: 'only.xls', isPdf: false, parsed: parsedOf([dep('F1', 500, 'A')]) };
    const xlsOnly = pairStatementFiles([x]);
    expect(xlsOnly.integrity.warnings.join(' ')).toMatch(/not cross-checked/);
});

test('two months uploaded together are paired by account and period', () => {
    const sep = { accountNumber: '7700120000000999', dateFrom: '2026-09-01', dateTo: '2026-09-30' };
    const oct = { accountNumber: '7700120000000999', dateFrom: '2026-10-01', dateTo: '2026-10-31' };
    const files = [
        { name: 'sep.xls', isPdf: false, parsed: parsedOf([dep('S1', 1, 'A')], sep) },
        { name: 'oct.pdf', isPdf: true, parsed: parsedOf([dep('O1', 2, 'B')], oct) },
        { name: 'oct.xls', isPdf: false, parsed: parsedOf([dep('O1', 2, 'B')], oct) },
        { name: 'sep.pdf', isPdf: true, parsed: parsedOf([dep('S1', 1, 'A')], sep) }
    ];
    const { statements, integrity } = pairStatementFiles(files);
    expect(statements.map(s => s.name).sort()).toEqual(['oct.xls', 'sep.xls']);
    expect(integrity.errors).toEqual([]);
    expect(integrity.passed.filter(t => /matches the bank's PDF/.test(t))).toHaveLength(2);
});

test('a file\'s own integrity errors carry its name into the blocking list', () => {
    const bad = parsedOf([dep('F1', 500, 'A')]);
    bad.integrity = { errors: ['Running balance does not add up'], warnings: [] };
    const { integrity } = pairStatementFiles([{ name: 'bad.xls', isPdf: false, parsed: bad }]);
    expect(integrity.errors).toEqual(['bad.xls: Running balance does not add up']);
});

// ---------------------------------------------------------------- browser cache vs database
import { mergeForeignCloudAndLocal } from '../foreign-transactions.js';

test('cached deposits deleted from the database are dropped, not uploaded again', () => {
    const local = [
        { reference_number: 'KEEP', amount: 1, description: 'old local copy' },
        { reference_number: 'DELETED', amount: 2 },                       // deleted elsewhere
        { reference_number: 'UNSAVED', amount: 3, _pendingSync: true }     // import whose save failed
    ];
    const cloud = [{ reference_number: 'KEEP', amount: 1, description: 'database copy' }];
    const { merged, pendingUpload, droppedCount } = mergeForeignCloudAndLocal(local, cloud);
    expect(merged.map(r => r.reference_number).sort()).toEqual(['KEEP', 'UNSAVED']);
    expect(merged.find(r => r.reference_number === 'KEEP').description).toBe('database copy');
    expect(pendingUpload.map(r => r.reference_number)).toEqual(['UNSAVED']);
    expect(droppedCount).toBe(1);
});

test('after the delete script empties the table, an old cached copy uploads nothing', () => {
    const local = Array.from({ length: 50 }, (_, i) => ({ reference_number: `FJB${i}`, amount: i }));
    const { merged, pendingUpload, droppedCount } = mergeForeignCloudAndLocal(local, []);
    expect(merged).toEqual([]);
    expect(pendingUpload).toEqual([]);
    expect(droppedCount).toBe(50);
});
