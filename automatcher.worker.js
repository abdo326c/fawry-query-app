import {
    buildStudentLookupIndex,
    matchTransactionToStudent,
    toDateOnly,
    isLockedTransaction
} from './rules.js';

let cachedIndex = null;
let cachedStudentsCount = -1;

self.addEventListener('message', (event) => {
    const { type, payload } = event.data || {};
    if (type !== 'RUN_AUTOMATCH') return;

    try {
        const {
            transactions = [],
            students = null,
            linksMap = {},
            fixesList = [],
            enableNameMatch = false,
            sharedMobileList = []
        } = payload || {};

        if (Array.isArray(students) && (!cachedIndex || cachedStudentsCount !== students.length)) {
            cachedIndex = buildStudentLookupIndex(students);
            cachedStudentsCount = students.length;
        }

        const fixesMap = new Map();
        for (const f of fixesList) {
            if (f && f.reference_number) {
                fixesMap.set(String(f.reference_number).trim(), f);
            }
        }
        const sharedMobileSet = new Set(sharedMobileList);
        const proposals = [];

        for (let i = 0; i < transactions.length; i++) {
            const tx = transactions[i];
            if ((i & 127) === 0 && i > 0) {
                self.postMessage({ type: 'PROGRESS', current: i, total: transactions.length });
            }
            const link = linksMap[tx.reference_number];
            const existingFix = fixesMap.get(String(tx.reference_number || '').trim()) || null;
            const rawTxSid = tx.student_id ? String(tx.student_id).trim() : '';

            const { proposedStudent, matchReason, confidenceTier } = matchTransactionToStudent(tx, {
                index: cachedIndex,
                link,
                existingFix,
                enableNameMatch: Boolean(enableNameMatch),
                sharedMobileSet
            });

            proposals.push({
                tx_id: tx.id,
                proposedStudent,
                matchReason,
                confidenceTier: proposedStudent ? confidenceTier : 'unmatched',
                original_ref: tx.reference_number,
                original_date: toDateOnly(tx.payment_date),
                original_student_id: rawTxSid,
                original_bank: tx.bank,
                original_mapping: tx.mapping,
                original_second_mapping: tx.second_mapping,
                original_item: tx.item_name,
                original_amount: tx.item_price,
                original_status: tx.id_status,
                locked: isLockedTransaction(tx),
                selected: false
            });
        }

        self.postMessage({ type: 'DONE', proposals });
    } catch (err) {
        self.postMessage({ type: 'ERROR', message: err?.message || String(err) });
    }
});
