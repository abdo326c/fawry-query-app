import { expect, test, vi } from 'vitest';

vi.mock('../supabase.js', () => ({ supabase: {} }));

import { applyIsoDateFormats, formatExcelDateText, isoTextToExcelSerial, EXCEL_DATE_FORMAT, EXCEL_DATETIME_FORMAT } from '../rules.js';

const s = (v) => ({ t: 's', v });
const n = (v, z) => (z ? { t: 'n', v, z } : { t: 'n', v });

test('formatExcelDateText converts the date forms used in exports to YYYY-MM-DD', () => {
    expect(formatExcelDateText('2026-11-17')).toBe('2026-11-17');
    expect(formatExcelDateText('2026-1-5')).toBe('2026-01-05');
    expect(formatExcelDateText('17/11/2026')).toBe('2026-11-17');
    expect(formatExcelDateText('05/01/2026')).toBe('2026-01-05');          // day-first (Fawry)
    expect(formatExcelDateText('1/25/2026')).toBe('2026-01-25');           // month-first fallback
    expect(formatExcelDateText('1/25/2026 3:05 PM')).toBe('2026-01-25 15:05:00');
    expect(formatExcelDateText('17-Nov-2026')).toBe('2026-11-17');
    expect(formatExcelDateText('2025-12-31 23:59:59')).toBe('2025-12-31 23:59:59');
    expect(formatExcelDateText('2026-11-17T08:13:33Z')).toMatch(/^2026-11-1[78] \d{2}:13:33$/); // local time
});

test('formatExcelDateText leaves non-dates alone', () => {
    for (const v of ['', 'Tuition', '231000123', '30/02/2026', '2026-13-01', 'N/A', '12345.67']) {
        expect(formatExcelDateText(v)).toBeNull();
    }
});

test('real Excel date cells get the yyyy-mm-dd format', () => {
    const wb = {
        SheetNames: ['S'],
        Sheets: {
            S: {
                '!ref': 'A1:C3',
                A1: s('Date'), B1: s('Amount'), C1: s('Created'),
                A2: n(46343, 'm/d/yyyy'), B2: n(100, '#,##0.00'), C2: n(46343.5, 'm/d/yy h:mm'),
                A3: { t: 'd', v: new Date(2026, 10, 17) }, B3: n(5)
            }
        }
    };
    applyIsoDateFormats(wb);
    const ws = wb.Sheets.S;
    expect(ws.A2.z).toBe(EXCEL_DATE_FORMAT);
    expect(ws.C2.z).toBe(EXCEL_DATETIME_FORMAT);
    expect(ws.B2.z).toBe('#,##0.00');            // number formats untouched
    expect(ws.B3.z).toBeUndefined();
    expect(ws.A3.t).toBe('n');
    expect(ws.A3.z).toBe(EXCEL_DATE_FORMAT);
    expect(ws.A3.v).toBe(46343);                 // 2026-11-17
});

test('date text in date columns becomes a real Excel date shown as yyyy-mm-dd; other columns and non-dates are not', () => {
    const wb = {
        SheetNames: ['S'],
        Sheets: {
            S: {
                '!ref': 'A1:D3',
                A1: s('Payment Date'), B1: s('Reference'), C1: s('Expiry Date'), D1: s('Created At'),
                A2: s('17/11/2026'), B2: s('17/11/2026'), C2: s('2025-12-31 23:59:59'), D2: s('1/25/2026 10:15:00 AM'),
                A3: s('N/A'), B3: s('REF1'), C3: s(''), D3: s('2026-01-02')
            }
        }
    };
    applyIsoDateFormats(wb);
    const ws = wb.Sheets.S;
    expect(ws.A2).toEqual({ t: 'n', v: 46343, z: EXCEL_DATE_FORMAT });            // 2026-11-17
    expect(ws.B2).toEqual({ t: 's', v: '17/11/2026' });                             // not a date column
    expect(ws.C2.t).toBe('n');
    expect(ws.C2.z).toBe(EXCEL_DATETIME_FORMAT);
    expect(ws.C2.v).toBeCloseTo(isoTextToExcelSerial('2025-12-31 23:59:59'), 8);
    expect(ws.D2.t).toBe('n');
    expect(ws.D2.v).toBeCloseTo(isoTextToExcelSerial('2026-01-25 10:15:00'), 8);
    expect(ws.A3).toEqual({ t: 's', v: 'N/A' });                                    // non-date text untouched
    expect(ws.D3).toEqual({ t: 'n', v: isoTextToExcelSerial('2026-01-02'), z: EXCEL_DATE_FORMAT });
    expect(ws.A1.v).toBe('Payment Date');        // header untouched
});

test('titled pivot sheets: header on row 2, title on row 1 is left alone', () => {
    const wb = {
        SheetNames: ['P'],
        Sheets: {
            P: {
                '!ref': 'A1:B3',
                A1: s('Collection Report 1/11/2026'), B1: s(''),
                A2: s('Date'), B2: s('Total'),
                A3: s('17-Nov-2026'), B3: n(10)
            }
        }
    };
    applyIsoDateFormats(wb);
    expect(wb.Sheets.P.A1.v).toBe('Collection Report 1/11/2026');
    expect(wb.Sheets.P.A3).toEqual({ t: 'n', v: 46343, z: EXCEL_DATE_FORMAT });
});

test('isoTextToExcelSerial uses the wall-clock date (no time-zone shift)', () => {
    expect(isoTextToExcelSerial('2026-11-17')).toBe(46343);
    expect(isoTextToExcelSerial('1900-03-01')).toBe(61);
    expect(isoTextToExcelSerial('2026-11-17 12:00:00')).toBe(46343.5);
    expect(isoTextToExcelSerial('17/11/2026')).toBeNull();
});

test('raw bank column names and bare serial numbers in date columns become dates', () => {
    const wb = {
        SheetNames: ['S'],
        Sheets: {
            S: {
                '!ref': 'A1:D2',
                A1: s('TRXDATE'), B1: s('SETTLEMENT_DATE'), C1: s('Value Date'), D1: s('NETAMOUNT'),
                A2: s('2026-11-17'), B2: s('18/11/2026'), C2: n(46343), D2: n(46343)
            }
        }
    };
    applyIsoDateFormats(wb);
    const ws = wb.Sheets.S;
    expect(ws.A2).toEqual({ t: 'n', v: 46343, z: EXCEL_DATE_FORMAT });
    expect(ws.B2).toEqual({ t: 'n', v: 46344, z: EXCEL_DATE_FORMAT });
    expect(ws.C2.z).toBe(EXCEL_DATE_FORMAT);       // bare serial in a date column
    expect(ws.D2.z).toBeUndefined();               // same number in a money column stays a number
});
