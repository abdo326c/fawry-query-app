import { expect, test, vi } from 'vitest';

vi.mock('../supabase.js', () => ({ supabase: {} }));

import { reconstructBanqueMisrPdfLinesFromPages, parseBanqueMisrPdfText, assignCenteredDescriptionLines } from '../foreign-transactions.js';

// Layout of the current Banque Misr USD statement PDF (column X positions taken from a real
// statement, all names/IDs/refs made up). The bank added "Executed Branch Code / Name" after
// "Event"; descriptions wrap and are vertically centred on each row's numbers.
const HEADER_Y = 404.6;
const header = [
    ['Balance After', 14.7], ['Credit', 64.0], ['Debit', 99.7], ['Transcation Date/Time', 135.4],
    ['Value Date', 213.6], ['Description', 254.1], ['Instrument Code', 385.3], ['External. Ref No', 444.1],
    ['Transcation Code', 513.5], ['Transaction Reference', 575.1], ['Event', 652.7],
    ['Executed Branch Code', 678.3], ['Executed Branch name', 755.5]
].map(([str, x]) => ({ str, x, y: HEADER_Y }));

const meta = [
    { str: 'Statement of Account', x: 300, y: 560 },
    { str: 'Account Number', x: 20, y: 470 }, { str: '7700120000000999', x: 20, y: 458 },
    { str: 'Currency', x: 200, y: 470 }, { str: 'USD', x: 200, y: 458 }
];

// One statement row: numbers + codes + branch on the anchor line, description lines above/below.
function row(y, { bal, credit, debit = '0.00', dt, vd, ext, code, ref, event = 'INIT', branch, branchName, above = [], mid = null, below = [] }) {
    const items = [
        { str: bal, x: 13.2, y }, { str: credit, x: 62.5, y }, { str: debit, x: 98.2, y },
        { str: dt, x: 133.9, y }, { str: vd, x: 212.1, y },
        { str: code, x: 512.0, y }, { str: ref, x: 573.6, y }, { str: event, x: 651.2, y },
        { str: branch, x: 676.8, y }, { str: branchName, x: 754.0, y }
    ];
    if (ext) items.push({ str: ext, x: 442.6, y });
    if (mid) items.push({ str: mid, x: 252.6, y });
    above.forEach((t, i) => items.push({ str: t, x: 252.6, y: y + 12 * (above.length - i) - 6 }));
    below.forEach((t, i) => items.push({ str: t, x: 252.6, y: y - 12 * (i + 1) + 6 }));
    return items;
}

function buildPage() {
    return [
        ...meta, ...header,
        // 2-line cash deposit: name above the numbers, rest below (exactly the case that shifted)
        ...row(363.4, {
            bal: '5,943.58', credit: '1,499.51', dt: '03-09-2026 15:28:13', vd: '03-09-2026',
            ext: 'FJB2624600000001', code: 'CHF', ref: '515CHFD262460029', branch: '515', branchName: 'Mall Misr',
            above: ['Cash Deposit TEST STUDENT ONE 261009991'], below: ['- handed by TEST PARENT -']
        }),
        // 6-line SWIFT transfer: 3 lines above, 3 below (last lines are nearer the next row)
        ...row(300.0, {
            bal: '6,901.58', credit: '958.00', dt: '14-09-2026 19:24:43', vd: '14-09-2026',
            code: 'T35', ref: '100STP1262570125', branch: '100', branchName: 'Head Office',
            above: ['INCOMING SWIFT TRANSFER OUTSIDE EGYPT', '- TEST SENDER NAME - /ROC', '/2625602354328000///URI//RFB/PA -'],
            below: ['YMENT AGAINST DOCUMENT FOR TUITION -', 'FEES FOR TEST STUDENT TWO DOB: -', '13/01/2008 UNDER ID NO:261009992']
        }),
        // single-line deposit right after it
        ...row(240.0, {
            bal: '7,901.58', credit: '1,000.00', dt: '15-09-2026 10:00:34', vd: '15-09-2026',
            ext: 'FJB2625800000003', code: 'CHF', ref: '135CHFD262580008', branch: '135', branchName: 'Dokki',
            mid: 'Cash Deposit TEST STUDENT THREE ID 251009993 -'
        }),
        // incoming IRS transfer: transaction code SIR, reference with lowercase letters
        ...row(200.0, {
            bal: '7,928.11', credit: '26.53', dt: '18-09-2026 20:24:41', vd: '20-09-2026',
            ext: 'IRS203TESTAAA', code: 'SIR', ref: '100IRSS2626301um', branch: '100', branchName: 'Head Office',
            above: ['CREDIT IRS SHU1000000001 /', 'IRS2000000000001/ TEST REMITTER'],
            below: ['FOUR/GB/ACCT/', '7700120000000999/ TEST Exchange CO./ / -']
        }),
        { str: '1 / 9', x: 400, y: 20 }
    ];
}

test('descriptions stay with their own row when the statement has Executed Branch columns', () => {
    const parsed = parseBanqueMisrPdfText(reconstructBanqueMisrPdfLinesFromPages([buildPage()]));
    const byRef = Object.fromEntries(parsed.deposits.map(d => [d.reference_number, d]));

    expect(Object.keys(byRef).sort()).toEqual(['100STP1262570125', 'FJB2624600000001', 'FJB2625800000003', 'IRS203TESTAAA']);

    const d1 = byRef.FJB2624600000001;
    expect(d1.description).toBe('Cash Deposit TEST STUDENT ONE 261009991 - handed by TEST PARENT -');
    expect(d1.student_id).toBe('261009991');
    expect(d1.description).not.toMatch(/Mall Misr|515 /);            // branch is not description

    const swift = byRef['100STP1262570125'];
    expect(swift.description).toContain('INCOMING SWIFT TRANSFER OUTSIDE EGYPT');
    expect(swift.description).toContain('13/01/2008 UNDER ID NO:261009992'); // not cut as a page number
    expect(swift.amount).toBe(958);

    const d3 = byRef.FJB2625800000003;
    expect(d3.description).toBe('Cash Deposit TEST STUDENT THREE ID 251009993 -'); // nothing from the SWIFT row
    expect(d3.student_id).toBe('251009993');

    const irs = byRef.IRS203TESTAAA;
    expect(irs.amount).toBe(26.53);
    expect(irs.description).toContain('CREDIT IRS SHU1000000001');
    expect(irs.description).toContain('TEST Exchange CO.');
});

test('assignCenteredDescriptionLines splits a gap by the upper row\'s lines above', () => {
    const a = { y: 100, extraDescAbove: [], extraDescBelow: [] };
    const b = { y: 40, extraDescAbove: [], extraDescBelow: [] };
    assignCenteredDescriptionLines([a, b], [
        { y: 124, text: 'a1' }, { y: 112, text: 'a2' },         // above A
        { y: 88, text: 'a3' }, { y: 76, text: 'a4' },           // below A (2, same as above)
        { y: 58, text: 'b1' },                                   // above B
        { y: 22, text: 'b2' }                                    // below B
    ]);
    expect(a.extraDescAbove).toEqual(['a1', 'a2']);
    expect(a.extraDescBelow).toEqual(['a3', 'a4']);
    expect(b.extraDescAbove).toEqual(['b1']);
    expect(b.extraDescBelow).toEqual(['b2']);
});
