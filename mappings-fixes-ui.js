import { supabase } from './supabase.js';
import {
    validateID,
    isNonInvalidTransaction,
    fetchAll,
    fetchByIn,
    recomputeTransactions,
    updateRuleFields,
    diffTransaction,
    buildMappingLookup,
    normalizeItemName,
    originalItemName,
    escapeHTML,
    toDateOnly,
    writeCompressedExcel
} from './rules.js';
import {
    runConcurrent,
    renderIcons,
    formatIdStatusMeta,
    formatMoney,
    Toast,
    withDropdownTaskProgress
} from './app-utils.js';

class MappingsFixesUiMixin {
    /**
     * Scans all item_mappings in the database and fixes:
     * 1. Whitespace/casing duplicate item_name rows (merges fields and deletes duplicates)
     * 2. Untrimmed or double-spaced item_name / adjusted_item_name / mapping / second_mapping values
     * 3. Chained duplicates where a rule's item_name is another rule's adjusted_item_name
     *    (folds the edits back into the original rule and removes the redundant chained rule)
     * 4. Self-renames where adjusted_item_name is identical to item_name
     */
    async deduplicateItemMappings({ silent = true } = {}) {
        try {
            this._mappingsDedupedOnce = true;
            const rawMappings = await fetchAll('item_mappings', '*', null, 'item_name');
            if (!rawMappings || rawMappings.length === 0) {
                if (!silent) Toast.show('No item mappings found in database.', 'info');
                return { mergedCount: 0, chainedCount: 0, txUpdated: 0 };
            }

            const normKey = (s) => normalizeItemName(s).toLowerCase();
            const cleanOrNull = (s) => {
                const c = normalizeItemName(s);
                return c ? c : null;
            };

            const keysToDelete = new Set();
            const rowsToUpsertMap = new Map(); // canonical item_name -> row
            const affectedItemNames = new Set();
            const affectedRenamedNames = new Set();
            let mergedCount = 0;
            let chainedCount = 0;

            // Pass 1: Group by normalized item_name (catches whitespace/case duplicates)
            const groups = new Map();
            for (const row of rawMappings) {
                const k = normKey(row.item_name);
                if (!k) continue;
                if (!groups.has(k)) groups.set(k, []);
                groups.get(k).push(row);
            }

            const canonicalByNormKey = new Map();
            for (const [k, group] of groups.entries()) {
                // Prefer the row whose item_name is already trimmed and has the most populated fields
                group.sort((a, b) => {
                    const aTrimmed = a.item_name === normalizeItemName(a.item_name) ? 1 : 0;
                    const bTrimmed = b.item_name === normalizeItemName(b.item_name) ? 1 : 0;
                    if (aTrimmed !== bTrimmed) return bTrimmed - aTrimmed;
                    const aScore = (a.mapping ? 2 : 0) + (a.second_mapping ? 1 : 0) + (a.adjusted_item_name ? 1 : 0);
                    const bScore = (b.mapping ? 2 : 0) + (b.second_mapping ? 1 : 0) + (b.adjusted_item_name ? 1 : 0);
                    return bScore - aScore;
                });

                const canonicalName = normalizeItemName(group[0].item_name);
                let mergedAdjusted = null;
                let mergedMapping = null;
                let mergedSecond = null;

                for (const r of group) {
                    if (r.adjusted_item_name) affectedRenamedNames.add(String(r.adjusted_item_name).trim());
                    const adj = cleanOrNull(r.adjusted_item_name);
                    if (adj && normKey(adj) !== k && !mergedAdjusted) mergedAdjusted = adj;
                    const map1 = cleanOrNull(r.mapping);
                    if (map1 && !mergedMapping) mergedMapping = map1;
                    const map2 = cleanOrNull(r.second_mapping);
                    if (map2 && !mergedSecond) mergedSecond = map2;
                }

                const canonicalRow = {
                    item_name: canonicalName,
                    adjusted_item_name: mergedAdjusted,
                    mapping: mergedMapping,
                    second_mapping: mergedSecond
                };
                canonicalByNormKey.set(k, canonicalRow);

                const primary = group[0];
                const primaryChanged =
                    primary.item_name !== canonicalRow.item_name ||
                    (primary.adjusted_item_name || null) !== canonicalRow.adjusted_item_name ||
                    (primary.mapping || null) !== canonicalRow.mapping ||
                    (primary.second_mapping || null) !== canonicalRow.second_mapping;

                if (group.length > 1 || primaryChanged) {
                    if (group.length > 1) mergedCount += group.length - 1;
                    else mergedCount += 1;
                    for (const r of group) {
                        affectedItemNames.add(r.item_name);
                        if (r.item_name !== canonicalName) {
                            keysToDelete.add(r.item_name);
                        }
                    }
                    affectedItemNames.add(canonicalName);
                    if (mergedAdjusted) affectedRenamedNames.add(mergedAdjusted);
                    rowsToUpsertMap.set(canonicalName, canonicalRow);
                }
            }

            // Pass 2: Detect chained duplicates where Rule B's item_name is Rule A's adjusted_item_name
            // (happens when an edit was entered for the adjusted item name instead of the original item name)
            const adjustedOwnerMap = new Map(); // normKey(adjusted_item_name) -> canonicalRow (Rule A)
            for (const [k, row] of canonicalByNormKey.entries()) {
                if (row.adjusted_item_name) {
                    const adjKey = normKey(row.adjusted_item_name);
                    if (adjKey && adjKey !== k) {
                        adjustedOwnerMap.set(adjKey, row);
                    }
                }
            }

            for (const [k, rowB] of canonicalByNormKey.entries()) {
                const ownerA = adjustedOwnerMap.get(k);
                if (!ownerA || ownerA === rowB) continue;

                // Fold rowB's edits into the original rule ownerA
                let nextAdjusted = rowB.adjusted_item_name || ownerA.adjusted_item_name;
                if (nextAdjusted && normKey(nextAdjusted) === normKey(ownerA.item_name)) {
                    nextAdjusted = null;
                }
                const nextMapping = rowB.mapping || ownerA.mapping || null;
                const nextSecond = rowB.second_mapping || ownerA.second_mapping || null;

                ownerA.adjusted_item_name = nextAdjusted;
                ownerA.mapping = nextMapping;
                ownerA.second_mapping = nextSecond;

                rowsToUpsertMap.set(ownerA.item_name, ownerA);
                rowsToUpsertMap.delete(rowB.item_name);
                keysToDelete.add(rowB.item_name);

                affectedItemNames.add(ownerA.item_name);
                affectedItemNames.add(rowB.item_name);
                affectedRenamedNames.add(rowB.item_name);
                if (nextAdjusted) affectedRenamedNames.add(nextAdjusted);
                chainedCount++;
            }

            const deleteList = Array.from(keysToDelete);
            const upsertList = Array.from(rowsToUpsertMap.values());

            if (deleteList.length === 0 && upsertList.length === 0) {
                if (!silent) Toast.show('No duplicate or chained item mappings found – all rules are clean!', 'success');
                return { mergedCount: 0, chainedCount: 0, txUpdated: 0 };
            }

            for (let i = 0; i < deleteList.length; i += 200) {
                const chunk = deleteList.slice(i, i + 200);
                const { error } = await supabase.from('item_mappings').delete().in('item_name', chunk);
                if (error) throw error;
            }

            for (let i = 0; i < upsertList.length; i += 500) {
                const chunk = upsertList.slice(i, i + 500);
                const { error } = await supabase.from('item_mappings').upsert(chunk, { onConflict: 'item_name', ignoreDuplicates: false });
                if (error) throw error;
            }

            this.mappingSuggestCache = null;
            const affectedTxRows = await this.fetchTransactionsForItemNames(Array.from(affectedItemNames), Array.from(affectedRenamedNames));
            const reapplyRes = await this.reapplyRulesTo(affectedTxRows);

            await this.logAudit('Item Mappings Deduplicated', `${mergedCount + chainedCount} rule(s) cleaned`, {
                duplicates_merged: mergedCount,
                chained_folded: chainedCount,
                transactions_updated: reapplyRes.updated
            });

            if (!silent) {
                Toast.show(
                    `Cleaned ${mergedCount + chainedCount} duplicate/chained mapping(s). ${this.reapplySummary(reapplyRes)}`,
                    'success'
                );
                await this.loadMappings();
            }
            return { mergedCount, chainedCount, txUpdated: reapplyRes.updated };
        } catch (err) {
            if (!silent) Toast.show('Error fixing mapping duplicates: ' + err.message, 'error');
            else console.warn('Mapping deduplication check skipped:', err.message);
            return { mergedCount: 0, chainedCount: 0, txUpdated: 0 };
        }
    }

    resetMappingModal(title = 'Add Mapping') {
        this.editingMappingOriginalName = null;
        ['map-original', 'map-adjusted', 'map-category', 'map-second-category'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const suggest = document.getElementById('mapping-suggestion');
        if (suggest) suggest.style.display = 'none';
        const dupWarn = document.getElementById('mapping-duplicate-warning');
        if (dupWarn) dupWarn.style.display = 'none';
        document.getElementById('modal-mapping-title').innerText = title;
    }

    openMappingModalForEdit(mapping, carryOver = null) {
        if (!mapping) return;
        this.resetMappingModal('Edit Mapping');
        this.editingMappingOriginalName = mapping.item_name;
        document.getElementById('map-original').value = mapping.item_name || '';
        document.getElementById('map-adjusted').value = (carryOver && carryOver.adjusted_item_name != null) ? carryOver.adjusted_item_name : (mapping.adjusted_item_name || '');
        document.getElementById('map-category').value = (carryOver && carryOver.mapping) ? carryOver.mapping : (mapping.mapping || '');
        document.getElementById('map-second-category').value = (carryOver && carryOver.second_mapping) ? carryOver.second_mapping : (mapping.second_mapping || '');
        document.getElementById('modal-mapping').classList.remove('hidden');
    }

    /**
     * Checks if `inputName` conflicts with an existing mapping's item_name or adjusted_item_name.
     * @returns {{ type: 'direct' | 'adjusted', rule: object } | null}
     */
    findConflictingMapping(inputName, excludeOriginalName = null) {
        const normInput = normalizeItemName(inputName).toLowerCase();
        if (!normInput) return null;
        const normExclude = excludeOriginalName ? normalizeItemName(excludeOriginalName).toLowerCase() : null;
        const list = this.allMappingsData || this.mappingSuggestCache || [];

        for (const m of list) {
            if (!m || !m.item_name) continue;
            const normKey = normalizeItemName(m.item_name).toLowerCase();
            if (normExclude && normKey === normExclude) continue;
            if (normKey === normInput) {
                return { type: 'direct', rule: m };
            }
        }
        for (const m of list) {
            if (!m || !m.adjusted_item_name) continue;
            const normKey = normalizeItemName(m.item_name).toLowerCase();
            if (normExclude && normKey === normExclude) continue;
            const normAdj = normalizeItemName(m.adjusted_item_name).toLowerCase();
            if (normAdj === normInput) {
                return { type: 'adjusted', rule: m };
            }
        }
        return null;
    }

    resetFixModal(title = 'Add Fix') {
        this.editingFixOriginalRef = null;
        ['fix-ref', 'fix-id', 'fix-name', 'fix-mapping', 'fix-second-mapping'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        ['fix-duplicate-warning', 'fix-tx-preview', 'fix-id-feedback', 'fix-item-suggestion'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.style.display = 'none';
                el.innerHTML = '';
            }
        });
        document.getElementById('modal-fix-title').innerText = title;
        this.populateFixModalDatalists();
    }

    async populateFixModalDatalists() {
        try {
            if (!this.allMappingsData) {
                this.allMappingsData = await fetchAll('item_mappings', '*', null, 'item_name');
            }
            const allData = this.allMappingsData || [];
            const itemNames = [...new Set(
                allData.flatMap(m => [m.adjusted_item_name, m.item_name]).map(v => normalizeItemName(v)).filter(Boolean)
            )].sort();
            const categories = [...new Set(allData.map(m => m.mapping).filter(Boolean))].sort();
            const secondCategories = [...new Set(allData.map(m => m.second_mapping).filter(Boolean))].sort();

            const dlItems = document.getElementById('datalist-fix-item-names');
            if (dlItems) {
                dlItems.innerHTML = itemNames.map(n => `<option value="${escapeHTML(n)}"></option>`).join('');
            }
            const dl1 = document.getElementById('datalist-mapping-categories');
            if (dl1 && !dl1.innerHTML) {
                dl1.innerHTML = categories.map(c => `<option value="${escapeHTML(c)}"></option>`).join('');
            }
            const dl2 = document.getElementById('datalist-second-mapping-categories');
            if (dl2 && !dl2.innerHTML) {
                dl2.innerHTML = secondCategories.map(c => `<option value="${escapeHTML(c)}"></option>`).join('');
            }
        } catch (_err) {
            // Non-blocking autocomplete population
        }
    }

    findConflictingFix(refInput, excludeRef = null) {
        const normRef = String(refInput || '').trim().toLowerCase();
        if (!normRef) return null;
        const normExclude = excludeRef ? String(excludeRef).trim().toLowerCase() : null;
        const list = this.allFixesData || [];
        for (const f of list) {
            if (!f || !f.reference_number) continue;
            const key = String(f.reference_number).trim().toLowerCase();
            if (normExclude && key === normExclude) continue;
            if (key === normRef) return f;
        }
        return null;
    }

    openFixModalForEdit(fix, carryOver = null) {
        if (!fix) return;
        this.resetFixModal('Edit Fix');
        this.editingFixOriginalRef = fix.reference_number;
        document.getElementById('fix-ref').value = fix.reference_number || '';
        document.getElementById('fix-id').value = (carryOver && carryOver.correct_id) ? carryOver.correct_id : (fix.correct_id || '');
        document.getElementById('fix-name').value = (carryOver && carryOver.item_name) ? carryOver.item_name : (fix.item_name || '');
        document.getElementById('fix-mapping').value = (carryOver && carryOver.mapping) ? carryOver.mapping : (fix.mapping || '');
        document.getElementById('fix-second-mapping').value = (carryOver && carryOver.second_mapping) ? carryOver.second_mapping : (fix.second_mapping || '');
        document.getElementById('modal-fix').classList.remove('hidden');
        this.updateFixRefPreview(fix.reference_number);
        if (document.getElementById('fix-id').value) {
            this.updateFixIdFeedback(document.getElementById('fix-id').value);
        }
    }

    async openQuickFixForRef(refNumber) {
        const cleanRef = String(refNumber || '').trim();
        if (!cleanRef) return;
        try {
            if (!this.allFixesData) {
                this.allFixesData = await fetchAll('manual_fixes', '*', null, 'reference_number');
            }
        } catch (_e) {
            // ignore
        }
        const existing = this.findConflictingFix(cleanRef, null);
        if (existing) {
            this.openFixModalForEdit(existing);
            Toast.show(`Loaded existing manual fix for Reference "${existing.reference_number}"`, 'info');
        } else {
            this.resetFixModal('Add Fix');
            document.getElementById('fix-ref').value = cleanRef;
            document.getElementById('modal-fix').classList.remove('hidden');
            this.updateFixRefPreview(cleanRef);
            setTimeout(() => document.getElementById('fix-id')?.focus(), 50);
        }
    }

    async updateFixRefPreview(rawRef) {
        const ref = String(rawRef || '').trim();
        const dupWarn = document.getElementById('fix-duplicate-warning');
        const previewEl = document.getElementById('fix-tx-preview');
        const reqId = (this.fixPreviewReqId = (this.fixPreviewReqId || 0) + 1);

        if (!ref) {
            if (dupWarn) dupWarn.style.display = 'none';
            if (previewEl) previewEl.style.display = 'none';
            return;
        }

        try {
            if (!this.allFixesData) {
                this.allFixesData = await fetchAll('manual_fixes', '*', null, 'reference_number');
            }
        } catch (_e) {
            // ignore
        }
        if (reqId !== this.fixPreviewReqId) return;

        // 1. Check duplicate fix in manual_fixes
        if (dupWarn) {
            const conflict = this.findConflictingFix(ref, this.editingFixOriginalRef);
            if (conflict) {
                dupWarn.innerText = `⚠️ A manual fix for Reference "${conflict.reference_number}" already exists. Click here to edit the existing fix instead.`;
                dupWarn.style.display = 'block';
                dupWarn.onclick = () => {
                    this.openFixModalForEdit(conflict, {
                        correct_id: document.getElementById('fix-id')?.value.trim() || '',
                        item_name: normalizeItemName(document.getElementById('fix-name')?.value) || '',
                        mapping: normalizeItemName(document.getElementById('fix-mapping')?.value) || '',
                        second_mapping: normalizeItemName(document.getElementById('fix-second-mapping')?.value) || ''
                    });
                    Toast.show(`Switched to editing existing fix for "${conflict.reference_number}"`, 'info');
                };
            } else {
                dupWarn.style.display = 'none';
            }
        }

        // 2. Live Transaction Lookup in `transactions`
        if (!previewEl) return;
        previewEl.style.display = 'block';
        previewEl.innerHTML = `<span style="color: var(--text-muted);">Looking up transaction "${escapeHTML(ref)}"...</span>`;

        try {
            const { data: txRows, error } = await supabase
                .from('transactions')
                .select('reference_number, payment_date, student_id, id_status, item_name, check_column, item_price, mapping, second_mapping, is_settled')
                .eq('reference_number', ref)
                .limit(5);
            if (reqId !== this.fixPreviewReqId) return;
            if (error) throw error;

            if (!txRows || txRows.length === 0) {
                previewEl.innerHTML = `
                    <div style="color: #f59e0b; display: flex; align-items: center; gap: 0.4rem;">
                        <span>⚠️ No transaction found in database with Reference Number <strong>${escapeHTML(ref)}</strong>. Verify there are no typos.</span>
                    </div>
                `;
                return;
            }

            const t = txRows[0];
            const { statusClass, statusText } = formatIdStatusMeta(t, { defaultStatus: 'Unknown' });
            const extraCount = txRows.length > 1 ? ` <span class="text-muted">(${txRows.length} items in order)</span>` : '';
            const multiItemItemsHtml = txRows.length > 1
                ? `<div style="grid-column: 1 / -1; margin-top: 0.25rem; padding: 0.4rem 0.55rem; border-radius: 6px; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); color: #f59e0b; font-size: 0.76rem;">
                    <strong>Multi-Item Order (${txRows.length} lines):</strong> ${txRows.map(r => `${escapeHTML(r.item_name || '-')} (EGP ${formatMoney(r.item_price)})`).join(' • ')}<br>
                    <span style="opacity: 0.9;">Tip: Leave Item Name &amp; Mapping blank to fix only the Student ID while preserving each item's own mapping rule.</span>
                   </div>`
                : '';

            previewEl.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.35rem;">
                    <span><strong>Transaction Found</strong>${extraCount} • ${escapeHTML(toDateOnly(t.payment_date) || 'N/A')}</span>
                    <span class="badge ${statusClass}" style="font-size: 0.72rem;">${escapeHTML(statusText)}</span>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.3rem 0.75rem; color: var(--text-muted); font-size: 0.8rem;">
                    <div>Current ID: <strong style="color: var(--text-main);">${escapeHTML(t.student_id || 'Empty')}</strong></div>
                    <div>Amount: <strong style="color: var(--text-main);">EGP ${formatMoney(t.item_price)}</strong></div>
                    <div style="grid-column: 1 / -1;">Item: <strong style="color: var(--text-main);">${escapeHTML(t.item_name || '-')}</strong></div>
                    <div>Mapping: <strong style="color: var(--text-main);">${escapeHTML(t.mapping || '-')}</strong></div>
                    <div>2nd Mapping: <strong style="color: var(--text-main);">${escapeHTML(t.second_mapping || '-')}</strong></div>
                    ${multiItemItemsHtml}
                </div>
            `;
        } catch (_err) {
            if (reqId !== this.fixPreviewReqId) return;
            previewEl.style.display = 'none';
        }
    }

    async updateFixIdFeedback(rawId) {
        const val = String(rawId || '').trim();
        const fbEl = document.getElementById('fix-id-feedback');
        const reqId = (this.fixIdReqId = (this.fixIdReqId || 0) + 1);
        if (!fbEl) return;

        if (!val) {
            fbEl.style.display = 'none';
            fbEl.innerHTML = '';
            return;
        }

        const status = validateID(val);
        fbEl.style.display = 'block';

        if (status !== 'Valid') {
            fbEl.style.background = 'rgba(239, 68, 68, 0.12)';
            fbEl.style.border = '1px solid rgba(239, 68, 68, 0.35)';
            fbEl.style.color = '#ef4444';
            fbEl.innerHTML = `⚠️ <strong>${escapeHTML(status)}</strong> — Saving this ID will mark the transaction as an Error.`;
            return;
        }

        fbEl.style.background = 'rgba(16, 185, 129, 0.12)';
        fbEl.style.border = '1px solid rgba(16, 185, 129, 0.35)';
        fbEl.style.color = '#10b981';
        // Fast path: check in-memory Student Master cache first (0ms network wait)
        const cachedStudent = this.studentMasterByIdMap?.get(val)
            || (this.allStudentsData ? this.allStudentsData.find(s => String(s.student_id).trim() === val) : null);
        if (cachedStudent) {
            const colLabel = cachedStudent.college || cachedStudent.program || '';
            const fac = colLabel ? ` • ${escapeHTML(colLabel)}` : '';
            fbEl.innerHTML = `✅ <strong>Valid ID</strong> — ${escapeHTML(cachedStudent.full_name || 'Student')}${fac}`;
            return;
        }

        fbEl.innerHTML = `✅ Valid 9-digit Student ID format. Checking Student Master...`;

        try {
            const { data: student, error } = await supabase
                .from('student_master')
                .select('student_id, full_name, college, program')
                .eq('student_id', val)
                .maybeSingle();
            if (reqId !== this.fixIdReqId) return;
            if (!error && student) {
                const colLabel = student.college || student.program || '';
                const fac = colLabel ? ` • ${escapeHTML(colLabel)}` : '';
                fbEl.innerHTML = `✅ <strong>Valid ID</strong> — ${escapeHTML(student.full_name || 'Student')}${fac}`;
            } else {
                fbEl.innerHTML = `✅ <strong>Valid 9-digit ID format</strong> <span style="opacity: 0.85;">(Not found in Student Master list)</span>`;
            }
        } catch (_err) {
            if (reqId !== this.fixIdReqId) return;
            fbEl.innerHTML = `✅ <strong>Valid 9-digit ID format</strong>`;
        }
    }

    async updateFixItemSuggestion(rawName) {
        const query = normalizeItemName(rawName);
        const suggestEl = document.getElementById('fix-item-suggestion');
        if (!suggestEl) return;
        if (!query) {
            suggestEl.style.display = 'none';
            return;
        }
        try {
            if (!this.allMappingsData) {
                this.allMappingsData = await fetchAll('item_mappings', '*', null, 'item_name');
            }
        } catch (_e) {
            suggestEl.style.display = 'none';
            return;
        }
        const normQuery = query.toLowerCase();
        const match = (this.allMappingsData || []).find(m =>
            (m.item_name && normalizeItemName(m.item_name).toLowerCase() === normQuery) ||
            (m.adjusted_item_name && normalizeItemName(m.adjusted_item_name).toLowerCase() === normQuery)
        );
        if (match && (match.mapping || match.second_mapping)) {
            const mapInput = document.getElementById('fix-mapping');
            const secInput = document.getElementById('fix-second-mapping');
            // Auto-fill if both mapping inputs are currently empty
            if (mapInput && !mapInput.value.trim() && !secInput?.value.trim()) {
                mapInput.value = match.mapping || '';
                if (secInput && match.second_mapping) secInput.value = match.second_mapping;
                suggestEl.style.display = 'none';
                Toast.show(`Auto-filled Mapping "${match.mapping}" from Item Mappings`, 'info');
                return;
            }
            const curMap = mapInput?.value.trim() || '';
            const curSec = secInput?.value.trim() || '';
            if (curMap !== (match.mapping || '') || curSec !== (match.second_mapping || '')) {
                const secLabel = match.second_mapping ? ` / "${match.second_mapping}"` : '';
                suggestEl.innerText = `💡 Click to fill Mapping "${match.mapping || '-'}"${secLabel} from Item Mappings`;
                suggestEl.style.display = 'block';
                suggestEl.onclick = () => {
                    if (mapInput) mapInput.value = match.mapping || '';
                    if (secInput) secInput.value = match.second_mapping || '';
                    suggestEl.style.display = 'none';
                    Toast.show('Applied Mapping from Item Mappings!', 'success');
                };
            } else {
                suggestEl.style.display = 'none';
            }
        } else {
            suggestEl.style.display = 'none';
        }
    }

    initModals() {
        // Close modals on backdrop click or Escape key
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target !== modal) return;
                if (modal.id === 'modal-custom-confirm') {
                    document.getElementById('btn-custom-confirm-cancel')?.click();
                } else if (modal.id !== 'modal-import' || !this.isImporting) {
                    modal.classList.add('hidden');
                }
            });
        });

        window.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const confirmModal = document.getElementById('modal-custom-confirm');
            if (confirmModal && !confirmModal.classList.contains('hidden')) return; // handled by customConfirm
            const openModals = Array.from(document.querySelectorAll('.modal:not(.hidden)'));
            if (openModals.length === 0) return;
            // Close only the topmost open modal (highest z-index, or last in DOM on tie)
            openModals.sort((a, b) => {
                const zA = parseInt(window.getComputedStyle(a).zIndex, 10) || 0;
                const zB = parseInt(window.getComputedStyle(b).zIndex, 10) || 0;
                return zA - zB;
            });
            const topModal = openModals[openModals.length - 1];
            if (topModal.id === 'modal-import' && this.isImporting) return;
            topModal.classList.add('hidden');
        });

        // Open Mapping Modal
        document.getElementById('btn-add-mapping').addEventListener('click', () => {
            this.resetMappingModal('Add Mapping');
            document.getElementById('modal-mapping').classList.remove('hidden');
        });

        // Smart Mapping Auto-Suggest & Live Duplicate Detection
        let suggestTimeout;
        document.getElementById('map-original').addEventListener('input', (e) => {
            clearTimeout(suggestTimeout);
            suggestTimeout = setTimeout(async () => {
                const query = normalizeItemName(e.target.value);
                const suggestDiv = document.getElementById('mapping-suggestion');
                const dupWarn = document.getElementById('mapping-duplicate-warning');

                try {
                    if (!this.allMappingsData) {
                        this.allMappingsData = await fetchAll('item_mappings', '*', null, 'item_name');
                    }
                    if (!this.mappingSuggestCache) {
                        this.mappingSuggestCache = this.allMappingsData.filter(m => m.mapping);
                    }
                } catch (_err) {
                    if (suggestDiv) suggestDiv.style.display = 'none';
                    if (dupWarn) dupWarn.style.display = 'none';
                    return;
                }

                // 1. Live duplicate / adjusted-item check
                if (dupWarn) {
                    const conflict = this.findConflictingMapping(query, this.editingMappingOriginalName);
                    if (conflict) {
                        const r = conflict.rule;
                        if (conflict.type === 'direct') {
                            dupWarn.innerText = `⚠️ "${r.item_name}" already exists in Item Mappings. Click here to edit the original mapping instead.`;
                        } else {
                            dupWarn.innerText = `⚠️ "${query}" is already the Adjusted Item Name for original item "${r.item_name}". Click here to edit "${r.item_name}" instead.`;
                        }
                        dupWarn.style.display = 'block';
                        dupWarn.onclick = () => {
                            const curAdj = normalizeItemName(document.getElementById('map-adjusted').value);
                            const curCat = normalizeItemName(document.getElementById('map-category').value);
                            const curSec = normalizeItemName(document.getElementById('map-second-category').value);
                            this.openMappingModalForEdit(r, {
                                adjusted_item_name: curAdj || r.adjusted_item_name || '',
                                mapping: curCat || r.mapping || '',
                                second_mapping: curSec || r.second_mapping || ''
                            });
                            Toast.show(`Switched to editing original mapping "${r.item_name}"`, 'info');
                        };
                    } else {
                        dupWarn.style.display = 'none';
                    }
                }

                // 2. Smart Fuzzy Suggestion
                if (!suggestDiv) return;
                if (query.length < 3 || typeof Fuse === 'undefined') {
                    suggestDiv.style.display = 'none';
                    return;
                }
                const fuse = new Fuse(this.mappingSuggestCache || [], { keys: ['item_name'], threshold: 0.3 });
                const results = fuse.search(query).filter(r => normalizeItemName(r.item.item_name).toLowerCase() !== query.toLowerCase());
                if (results.length > 0) {
                    const topMatch = results[0].item;
                    const secLabel = topMatch.second_mapping ? ` / "${topMatch.second_mapping}"` : '';
                    suggestDiv.innerText = `💡 Smart Suggestion: Click to map to "${topMatch.mapping}"${secLabel} (similar to ${topMatch.item_name})`;
                    suggestDiv.style.display = 'block';
                    suggestDiv.onclick = () => {
                        document.getElementById('map-category').value = topMatch.mapping || '';
                        if (topMatch.second_mapping && !document.getElementById('map-second-category').value.trim()) {
                            document.getElementById('map-second-category').value = topMatch.second_mapping;
                        }
                        suggestDiv.style.display = 'none';
                        Toast.show('Applied Smart Suggestion!', 'success');
                    };
                } else {
                    suggestDiv.style.display = 'none';
                }
            }, 250);
        });

        // Open Fix Modal
        document.getElementById('btn-add-fix').addEventListener('click', () => {
            this.resetFixModal('Add Fix');
            document.getElementById('modal-fix').classList.remove('hidden');
        });

        // Live Transaction Preview & Duplicate Fix Detection on #fix-ref
        let fixRefTimeout;
        document.getElementById('fix-ref')?.addEventListener('input', (e) => {
            clearTimeout(fixRefTimeout);
            fixRefTimeout = setTimeout(() => {
                this.updateFixRefPreview(e.target.value);
            }, 250);
        });

        // Live Student ID Validation & Student Master Lookup on #fix-id
        let fixIdTimeout;
        document.getElementById('fix-id')?.addEventListener('input', (e) => {
            clearTimeout(fixIdTimeout);
            fixIdTimeout = setTimeout(() => {
                this.updateFixIdFeedback(e.target.value);
            }, 250);
        });

        // Smart Item Mapping Auto-Fill on #fix-name
        let fixNameTimeout;
        document.getElementById('fix-name')?.addEventListener('input', (e) => {
            clearTimeout(fixNameTimeout);
            fixNameTimeout = setTimeout(() => {
                this.updateFixItemSuggestion(e.target.value);
            }, 200);
        });

        // Save Mapping (with duplicate & chained-name prevention)
        const btnSaveMapping = document.getElementById('btn-save-mapping');
        btnSaveMapping.addEventListener('click', async () => {
            const original = normalizeItemName(document.getElementById('map-original').value);
            let adjusted = normalizeItemName(document.getElementById('map-adjusted').value);
            const category = normalizeItemName(document.getElementById('map-category').value);
            const secondCategory = normalizeItemName(document.getElementById('map-second-category').value);

            if (!original) return Toast.show('Original Item Name is required', 'warning');

            // Prevent redundant self-rename
            if (adjusted && adjusted.toLowerCase() === original.toLowerCase()) {
                adjusted = '';
            }

            btnSaveMapping.disabled = true;
            try {
                if (!this.allMappingsData) {
                    this.allMappingsData = await fetchAll('item_mappings', '*', null, 'item_name');
                }

                // Check if original item name conflicts with an existing item_name or adjusted_item_name
                const conflict = this.findConflictingMapping(original, this.editingMappingOriginalName);
                if (conflict) {
                    const r = conflict.rule;
                    const msg = conflict.type === 'direct'
                        ? `A mapping for "${r.item_name}" already exists. Duplicate item names are not allowed.\n\nWould you like to edit the original mapping "${r.item_name}" instead?`
                        : `"${original}" is already the Adjusted Item Name for original item "${r.item_name}".\n\nTo prevent duplicate rules, would you like to edit the original mapping "${r.item_name}" instead?`;

                    const switchToOriginal = await window.customConfirm(msg, 'Edit Original Mapping', 'Cancel');
                    if (switchToOriginal) {
                        this.openMappingModalForEdit(r, {
                            adjusted_item_name: adjusted || r.adjusted_item_name || '',
                            mapping: category || r.mapping || '',
                            second_mapping: secondCategory || r.second_mapping || ''
                        });
                        Toast.show(`Loaded original mapping "${r.item_name}". Click Save Mapping to confirm your changes.`, 'info');
                    }
                    return;
                }

                // Also check if the user entered an Adjusted Item Name that is itself another rule's Original Item Name
                if (adjusted) {
                    const adjConflict = (this.allMappingsData || []).find(m =>
                        m.item_name !== (this.editingMappingOriginalName || original) &&
                        normalizeItemName(m.item_name).toLowerCase() === adjusted.toLowerCase()
                    );
                    if (adjConflict && (adjConflict.mapping !== (category || null) || adjConflict.second_mapping !== (secondCategory || null))) {
                        const ok = await window.customConfirm(
                            `Note: Adjusted Item Name "${adjusted}" also exists as an Original Item Name with category "${adjConflict.mapping || 'None'}". Continue saving?`,
                            'Save Anyway', 'Cancel'
                        );
                        if (!ok) return;
                    }
                }

                const oldEditingKey = this.editingMappingOriginalName;
                const isRenamingKey = oldEditingKey && oldEditingKey !== original;
                const lookupKeys = isRenamingKey ? [oldEditingKey, original] : [original];
                const previouslyRenamedTo = await this.getCurrentAdjustedNames(lookupKeys);
                const prevRule = (this.allMappingsData || []).find(m => m.item_name === (oldEditingKey || original));

                if (isRenamingKey) {
                    const { error: delErr } = await supabase.from('item_mappings').delete().eq('item_name', oldEditingKey);
                    if (delErr) throw delErr;
                }

                const { error } = await supabase.from('item_mappings').upsert([{
                    item_name: original,
                    adjusted_item_name: adjusted || null,
                    mapping: category || null,
                    second_mapping: secondCategory || null
                }], { onConflict: 'item_name', ignoreDuplicates: false });
                if (error) throw error;

                await this.logAudit(
                    oldEditingKey ? 'Mapping Updated' : 'Single Mapping Added',
                    original,
                    {
                        previous_item_name: oldEditingKey || undefined,
                        original,
                        adjusted,
                        category,
                        secondCategory,
                        revert_data: {
                            table_name: 'item_mappings',
                            operation: prevRule ? 'upsert' : 'delete',
                            previous_rows: prevRule ? [prevRule] : [{ item_name: original }]
                        }
                    }
                );

                // Re-apply rules to every affected transaction (fetch everything first, then update)
                const rows = await this.fetchTransactionsForItemNames(lookupKeys, [...previouslyRenamedTo, adjusted]);
                const result = await this.reapplyRulesTo(rows);

                this.mappingSuggestCache = null; // rules changed – reload suggestions next time
                Toast.show(`Mapping saved. ${this.reapplySummary(result)}`, 'success');
                document.getElementById('modal-mapping').classList.add('hidden');
                this.resetMappingModal();
                this.loadMappings();
                if (document.getElementById('view-transactions')?.classList.contains('active')) {
                    this.loadTransactions();
                }
                if (document.getElementById('view-erp-export')?.classList.contains('active')) {
                    this.loadErpExport({ refresh: true });
                }
            } catch (err) {
                Toast.show('Error saving mapping: ' + err.message, 'error');
            } finally {
                btnSaveMapping.disabled = false;
            }
        });

        // Save Fix (with live ID validation, duplicate protection, reference rename cleanup, and Save & Next Issue)
        const btnSaveFix = document.getElementById('btn-save-fix');
        const btnSaveFixNext = document.getElementById('btn-save-fix-next');
        const findNextUnresolvedRef = (excludeRef) => {
            const excl = String(excludeRef || '').trim();
            if (this.unresolvedTxByRef instanceof Map && this.unresolvedTxByRef.size > 0) {
                for (const [candidateRef] of this.unresolvedTxByRef.entries()) {
                    if (candidateRef && candidateRef !== excl) return candidateRef;
                }
            }
            for (const tx of (this.currentPageTransactions || [])) {
                const r = String(tx?.reference_number || '').trim();
                if (r && r !== excl && !isNonInvalidTransaction(tx)) return r;
            }
            return null;
        };

        const saveManualFixHandler = async (openNext = false) => {
            const ref = document.getElementById('fix-ref').value.trim();
            const correctId = document.getElementById('fix-id').value.trim();
            const correctName = normalizeItemName(document.getElementById('fix-name').value);
            const correctMapping = normalizeItemName(document.getElementById('fix-mapping').value);
            const correctSecondMapping = normalizeItemName(document.getElementById('fix-second-mapping').value);

            if (!ref) return Toast.show('Reference Number is required', 'warning');
            if (!correctId && !correctName && !correctMapping && !correctSecondMapping) {
                return Toast.show('Enter at least one value to correct', 'warning');
            }

            if (correctId) {
                const idStatus = validateID(correctId);
                if (idStatus !== 'Valid') {
                    const proceedInvalid = await window.customConfirm(
                        `The Student ID "${correctId}" is invalid (${idStatus}). Saving this ID will mark the transaction status as Error.\n\nDo you still want to save this ID?`,
                        'Save Anyway', 'Cancel'
                    );
                    if (!proceedInvalid) return;
                }
            }

            btnSaveFix.disabled = true;
            if (btnSaveFixNext) btnSaveFixNext.disabled = true;
            try {
                const isEditMode = document.getElementById('modal-fix-title').innerText === 'Edit Fix';
                const oldEditingRef = this.editingFixOriginalRef;
                const isRenamingRef = isEditMode && oldEditingRef && oldEditingRef !== ref;

                let existing = this.allFixesData ? this.findConflictingFix(ref, null) : null;
                if (!this.allFixesData) {
                    const { data: dbExisting, error: existErr } = await supabase.from('manual_fixes').select('*').eq('reference_number', ref).maybeSingle();
                    if (existErr) throw existErr;
                    existing = dbExisting;
                }
                if (existing && (!isEditMode || isRenamingRef)) {
                    if (!await window.customConfirm(`A manual fix for reference "${ref}" already exists. Do you want to update the existing fix?`, 'Update Existing', 'Cancel')) {
                        return;
                    }
                }

                if (isRenamingRef) {
                    const { error: delErr } = await supabase.from('manual_fixes').delete().eq('reference_number', oldEditingRef);
                    if (delErr) throw delErr;
                }

                // When adding a partial fix to an existing reference (not full Edit Mode), preserve existing non-empty fields
                const mergedFix = (existing && !isEditMode) ? {
                    reference_number: ref,
                    correct_id: correctId || existing.correct_id || null,
                    item_name: correctName || existing.item_name || null,
                    mapping: correctMapping || existing.mapping || null,
                    second_mapping: correctSecondMapping || existing.second_mapping || null
                } : {
                    reference_number: ref,
                    correct_id: correctId || null,
                    item_name: correctName || null,
                    mapping: correctMapping || null,
                    second_mapping: correctSecondMapping || null
                };

                const { error } = await supabase.from('manual_fixes').upsert([mergedFix], { onConflict: 'reference_number', ignoreDuplicates: false });
                if (error) throw error;

                const prevFix = isRenamingRef
                    ? ((this.allFixesData || []).find(f => f.reference_number === oldEditingRef) || existing)
                    : existing;

                // Update in-memory allFixesData immediately so recompute & table render need 0 extra table downloads
                if (Array.isArray(this.allFixesData)) {
                    const dropKeys = new Set([ref.toLowerCase()]);
                    if (isRenamingRef && oldEditingRef) dropKeys.add(String(oldEditingRef).trim().toLowerCase());
                    this.allFixesData = this.allFixesData.filter(f => !dropKeys.has(String(f.reference_number || '').trim().toLowerCase()));
                    this.allFixesData.push(mergedFix);
                    this.allFixesData.sort((a, b) => String(a.reference_number || '').localeCompare(String(b.reference_number || '')));
                }

                const affectedRefs = isRenamingRef ? [oldEditingRef, ref] : [ref];
                const fixRuleCols = 'id, reference_number, payment_date, student_id, original_student_id, item_name, item_price, check_column, mapping, second_mapping, id_status, is_settled, erp_batch_number';

                const [, rows] = await Promise.all([
                    this.logAudit(
                        isEditMode ? 'Manual Fix Updated' : 'Single Manual Fix Added',
                        ref,
                        {
                            ...(isRenamingRef ? { ...mergedFix, previous_reference_number: oldEditingRef } : mergedFix),
                            revert_data: {
                                table_name: 'manual_fixes',
                                operation: prevFix ? 'upsert' : 'delete',
                                previous_rows: prevFix ? [prevFix] : [{ reference_number: ref }]
                            }
                        }
                    ),
                    fetchByIn('transactions', fixRuleCols, 'reference_number', affectedRefs)
                ]);

                const all = await recomputeTransactions(rows, {
                    includeLocked: true,
                    mappings: this.allMappingsData || undefined,
                    fixes: this.allFixesData || [mergedFix]
                });
                const lockedChanges = all.filter(c => c.diff.locked);
                let applyToLocked = false;

                if (lockedChanges.length > 0) {
                    applyToLocked = await window.customConfirm(
                        `Transaction "${ref}" is settled or already recorded in ERP. Changing it here will NOT change what was already posted to ERP. Do you want to apply this fix to the transaction anyway?`,
                        'Apply Anyway', 'Leave Unchanged'
                    );
                }

                const toApply = applyToLocked ? all : all.filter(c => !c.diff.locked);
                const updated = toApply.length > 0 ? await updateRuleFields(toApply) : 0;
                const foreignUpdated = await this.applyManualFixesToForeignTransactions(this.allFixesData || [mergedFix]);
                if (updated > 0 || foreignUpdated > 0) this.invalidateDistinctCache();

                const lockedSkipped = all.length - toApply.length;
                let summaryMsg = `${updated + foreignUpdated} transaction(s) updated.`;
                if (lockedSkipped > 0) summaryMsg += ` ${lockedSkipped} settled/ERP-recorded transaction(s) left unchanged.`;

                Toast.show(`Manual fix saved. ${summaryMsg}`, 'success');
                const nextUnresolvedRef = openNext ? findNextUnresolvedRef(ref) : null;
                document.getElementById('modal-fix').classList.add('hidden');
                this.resetFixModal();

                if (Array.isArray(this.allFixesData)) {
                    this.updateFixesStatsAndDropdowns(this.allFixesData);
                    this.renderFixesPage();
                    this.syncUnresolvedAfterFixChange(rows, toApply);
                } else {
                    this.loadFixes();
                }
                if (document.getElementById('view-transactions')?.classList.contains('active')) {
                    this.loadTransactions();
                }
                if (document.getElementById('view-erp-export')?.classList.contains('active')) {
                    this.loadErpExport({ refresh: true });
                }
                if (document.getElementById('view-automatcher')?.classList.contains('active')) {
                    this.runAutoMatcher();
                }

                if (openNext) {
                    if (nextUnresolvedRef) {
                        await this.openQuickFixForRef(nextUnresolvedRef);
                    } else {
                        Toast.show('All visible unresolved issues have been addressed!', 'info');
                    }
                }
            } catch (err) {
                Toast.show('Error saving fix: ' + err.message, 'error');
            } finally {
                btnSaveFix.disabled = false;
                if (btnSaveFixNext) btnSaveFixNext.disabled = false;
            }
        };

        btnSaveFix.addEventListener('click', () => saveManualFixHandler(false));
        if (btnSaveFixNext) {
            btnSaveFixNext.addEventListener('click', () => saveManualFixHandler(true));
        }
    }

    initBulkUploads() {
        const handleUpload = async (e, type) => {
            const input = e.target;
            const file = input.files[0];
            if (!file) return;
            input.value = ''; // Reset so the same file can be selected again

            if (this.isBulkUploading) {
                Toast.show('An upload is already in progress. Please wait.', 'warning');
                return;
            }
            this.isBulkUploading = true;

            const getVal = (row, keyStr) => {
                const exact = row[keyStr];
                if (exact !== undefined && exact !== "") return exact;
                const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
                const foundKey = Object.keys(row).find(k => norm(k) === norm(keyStr));
                const v = foundKey ? row[foundKey] : null;
                return v === "" ? null : v;
            };
            const clean = v => (v === null || v === undefined) ? null : (String(v).trim() || null);

            const chunkSize = 500;
            let processed = 0;
            let inserted = 0;

            try {
                const buffer = await file.arrayBuffer();
                const workbook = XLSX.read(buffer, { type: 'array' });
                const worksheet = workbook.Sheets[workbook.SheetNames[0]];
                const data = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

                if (data.length === 0) {
                    Toast.show('File is empty!', 'warning');
                    return;
                }

                Toast.show('Uploading... please wait.', 'info');

                if (type === 'mappings') {
                    const existingAll = await fetchAll('item_mappings', '*', null, 'item_name');
                    const existingByNorm = new Map();
                    const existingByAdjNorm = new Map();
                    for (const ex of existingAll) {
                        const nk = normalizeItemName(ex.item_name).toLowerCase();
                        if (nk) existingByNorm.set(nk, ex);
                        if (ex.adjusted_item_name) {
                            const ak = normalizeItemName(ex.adjusted_item_name).toLowerCase();
                            if (ak) existingByAdjNorm.set(ak, ex);
                        }
                    }

                    const byNormKey = new Map();
                    let redirectedFromAdjusted = 0;
                    data.forEach(row => {
                        let item_name = normalizeItemName(getVal(row, 'Item Name'));
                        if (!item_name) return;
                        let adjusted_item_name = normalizeItemName(getVal(row, 'Adjusted Item Name')) || null;
                        const mapping = normalizeItemName(getVal(row, 'Mapping')) || null;
                        const second_mapping = normalizeItemName(getVal(row, '2nd Mapping')) || null;

                        let nk = item_name.toLowerCase();
                        // If the uploaded Item Name is actually an existing (or earlier uploaded) rule's Adjusted Item Name, target the original rule!
                        if (!existingByNorm.has(nk) && existingByAdjNorm.has(nk)) {
                            const origRule = existingByAdjNorm.get(nk);
                            adjusted_item_name = adjusted_item_name || item_name;
                            item_name = origRule.item_name;
                            nk = normalizeItemName(item_name).toLowerCase();
                            redirectedFromAdjusted++;
                        } else if (existingByNorm.has(nk)) {
                            item_name = existingByNorm.get(nk).item_name;
                        }

                        if (adjusted_item_name && adjusted_item_name.toLowerCase() === nk) {
                            adjusted_item_name = null;
                        }

                        const prev = byNormKey.get(nk);
                        const mergedEntry = {
                            item_name,
                            adjusted_item_name: adjusted_item_name || (prev ? prev.adjusted_item_name : null),
                            mapping: mapping || (prev ? prev.mapping : null),
                            second_mapping: second_mapping || (prev ? prev.second_mapping : null)
                        };
                        byNormKey.set(nk, mergedEntry);
                        if (mergedEntry.adjusted_item_name) {
                            existingByAdjNorm.set(mergedEntry.adjusted_item_name.toLowerCase(), mergedEntry);
                        }
                    });

                    const uploadedMappings = Array.from(byNormKey.values());
                    const matchingExistingCount = uploadedMappings.filter(m => existingByNorm.has(normalizeItemName(m.item_name).toLowerCase())).length;

                    let mappingsToProcess = uploadedMappings;
                    if (matchingExistingCount > 0) {
                        const extraNote = redirectedFromAdjusted > 0 ? ` (${redirectedFromAdjusted} row(s) matched an Adjusted Item Name and were linked to their Original Item Name)` : '';
                        const overwrite = await window.customConfirm(
                            `Found ${matchingExistingCount} item mapping(s) that already exist in the database${extraNote}. Do you want to update them with the new values?`,
                            'Update Existing', 'Skip Existing'
                        );
                        if (!overwrite) {
                            mappingsToProcess = uploadedMappings.filter(m => !existingByNorm.has(normalizeItemName(m.item_name).toLowerCase()));
                        } else {
                            // Merge blank cells with existing values so partial bulk uploads don't wipe existing fields
                            mappingsToProcess = uploadedMappings.map(m => {
                                const old = existingByNorm.get(normalizeItemName(m.item_name).toLowerCase());
                                if (!old) return m;
                                return {
                                    item_name: old.item_name,
                                    adjusted_item_name: m.adjusted_item_name || old.adjusted_item_name || null,
                                    mapping: m.mapping || old.mapping || null,
                                    second_mapping: m.second_mapping || old.second_mapping || null
                                };
                            });
                        }
                    }

                    if (mappingsToProcess.length === 0) {
                        Toast.show('No new item mappings to process.', 'info');
                        return;
                    }

                    processed = mappingsToProcess.length;
                    const previouslyRenamedTo = await this.getCurrentAdjustedNames(mappingsToProcess.map(m => m.item_name));

                    for (let i = 0; i < mappingsToProcess.length; i += chunkSize) {
                        const chunk = mappingsToProcess.slice(i, i + chunkSize);
                        const { error } = await supabase.from('item_mappings').upsert(chunk, { onConflict: 'item_name', ignoreDuplicates: false });
                        if (error) throw new Error(`Only ${inserted} of ${mappingsToProcess.length} mappings saved. ${error.message}`);
                        inserted += chunk.length;
                    }

                    // Fetch ALL affected transactions first, then update (no paging while modifying)
                    const rows = await this.fetchTransactionsForItemNames(mappingsToProcess.map(m => m.item_name), [...previouslyRenamedTo, ...mappingsToProcess.map(m => m.adjusted_item_name)]);
                    const result = await this.reapplyRulesTo(rows);

                    await this.logAudit('Bulk Mappings Uploaded', `Batch of ${inserted} items`, { count: inserted, redirected_from_adjusted: redirectedFromAdjusted, transactions_updated: result.updated, locked_skipped: result.lockedSkipped });
                    this.mappingSuggestCache = null;
                    Toast.show(`Uploaded ${inserted} item mappings. ${this.reapplySummary(result)}`, 'success');
                    this.loadMappings();

                } else if (type === 'fixes') {
                    const byRef = new Map();
                    data.forEach(row => {
                        const rawRef = clean(getVal(row, 'Reference Number'));
                        const reference_number = rawRef ? String(rawRef).trim() : null;
                        if (!reference_number || reference_number === 'null') return;
                        const key = reference_number.toLowerCase();
                        const prev = byRef.get(key);
                        const correct_id = clean(getVal(row, 'Correct ID'));
                        const item_name = clean(getVal(row, 'Item Name')) ? normalizeItemName(clean(getVal(row, 'Item Name'))) : null;
                        const mapping = clean(getVal(row, 'Mapping')) ? normalizeItemName(clean(getVal(row, 'Mapping'))) : null;
                        const second_mapping = clean(getVal(row, '2nd Mapping')) ? normalizeItemName(clean(getVal(row, '2nd Mapping'))) : null;

                        if (!correct_id && !item_name && !mapping && !second_mapping && !prev) return;

                        byRef.set(key, {
                            reference_number: prev ? prev.reference_number : reference_number,
                            correct_id: correct_id || (prev ? prev.correct_id : null) || null,
                            item_name: item_name || (prev ? prev.item_name : null) || null,
                            mapping: mapping || (prev ? prev.mapping : null) || null,
                            second_mapping: second_mapping || (prev ? prev.second_mapping : null) || null
                        });
                    });
                    const fixes = Array.from(byRef.values());

                    const invalidIdFixes = fixes.filter(f => f.correct_id && validateID(f.correct_id) !== 'Valid');
                    if (invalidIdFixes.length > 0) {
                        const sampleRefs = invalidIdFixes.slice(0, 3).map(f => `${f.reference_number} (${f.correct_id})`).join(', ');
                        const proceedInvalid = await window.customConfirm(
                            `${invalidIdFixes.length} row(s) in your upload have an invalid Student ID format (e.g., ${sampleRefs}). Saving invalid IDs will mark those transactions as Error.\n\nDo you want to continue uploading them anyway?`,
                            'Upload Anyway', 'Cancel Upload'
                        );
                        if (!proceedInvalid) return;
                    }

                    const existingRows = Array.isArray(this.allFixesData)
                        ? this.allFixesData
                        : await fetchByIn('manual_fixes', 'reference_number, correct_id, item_name, mapping, second_mapping', 'reference_number', fixes.map(f => f.reference_number), 'reference_number', 500);
                    const uploadedKeys = new Set(fixes.map(f => String(f.reference_number).trim().toLowerCase()));
                    const existingMap = new Map(
                        existingRows
                            .filter(r => uploadedKeys.has(String(r.reference_number || '').trim().toLowerCase()))
                            .map(r => [String(r.reference_number).trim().toLowerCase(), r])
                    );

                    let fixesToProcess = fixes;
                    if (existingMap.size > 0) {
                        const overwrite = await window.customConfirm(`Found ${existingMap.size} fixes that already exist in the database. Do you want to update them with the new values?`, 'Update Existing', 'Skip Existing');
                        if (!overwrite) {
                            fixesToProcess = fixes.filter(f => !existingMap.has(String(f.reference_number).trim().toLowerCase()));
                        } else {
                            // Merge blank cells with existing values so partial bulk uploads don't wipe existing fields
                            fixesToProcess = fixes.map(f => {
                                const old = existingMap.get(String(f.reference_number).trim().toLowerCase());
                                if (!old) return f;
                                return {
                                    reference_number: old.reference_number || f.reference_number,
                                    correct_id: f.correct_id || old.correct_id || null,
                                    item_name: f.item_name || old.item_name || null,
                                    mapping: f.mapping || old.mapping || null,
                                    second_mapping: f.second_mapping || old.second_mapping || null
                                };
                            });
                        }
                    }

                    if (fixesToProcess.length === 0) {
                        Toast.show('No new fixes to process.', 'info');
                        return;
                    }
                    processed = fixesToProcess.length;

                    // Upsert manual_fixes chunks in parallel (4x concurrency)
                    const upsertTasks = [];
                    for (let i = 0; i < fixesToProcess.length; i += chunkSize) {
                        const chunk = fixesToProcess.slice(i, i + chunkSize);
                        upsertTasks.push(async () => {
                            const { error } = await supabase.from('manual_fixes').upsert(chunk, { onConflict: 'reference_number', ignoreDuplicates: false });
                            if (error) throw new Error(`Only ${inserted} of ${fixesToProcess.length} fixes saved. ${error.message}`);
                            inserted += chunk.length;
                        });
                    }
                    await runConcurrent(upsertTasks, 4);

                    // Update in-memory allFixesData if cached
                    if (Array.isArray(this.allFixesData)) {
                        const byKey = new Map(this.allFixesData.map(f => [String(f.reference_number || '').trim().toLowerCase(), f]));
                        for (const f of fixesToProcess) {
                            byKey.set(String(f.reference_number || '').trim().toLowerCase(), f);
                        }
                        this.allFixesData = Array.from(byKey.values()).sort((a, b) =>
                            String(a.reference_number || '').localeCompare(String(b.reference_number || ''))
                        );
                    }

                    // Fetch only rule columns (not '*') and pass cached fixes/mappings into reapplyRulesTo
                    const fixRuleCols = 'id, reference_number, payment_date, student_id, original_student_id, item_name, item_price, check_column, mapping, second_mapping, id_status, is_settled, erp_batch_number';
                    const rows = await fetchByIn('transactions', fixRuleCols, 'reference_number', fixesToProcess.map(f => f.reference_number));
                    const result = await this.reapplyRulesTo(rows, {
                        fixes: this.allFixesData || fixesToProcess,
                        mappings: this.allMappingsData || undefined
                    });
                    const foreignUpdated = await this.applyManualFixesToForeignTransactions(this.allFixesData || fixesToProcess);

                    await this.logAudit('Bulk Fixes Uploaded', `Batch of ${inserted} items`, { count: inserted, transactions_updated: result.updated + foreignUpdated, foreign_updated: foreignUpdated, locked_skipped: result.lockedSkipped });
                    const foreignMsg = foreignUpdated > 0 ? ` (${foreignUpdated} foreign deposit(s) updated)` : '';
                    Toast.show(`Uploaded ${inserted} manual fixes. ${this.reapplySummary(result)}${foreignMsg}`, 'success');
                    if (Array.isArray(this.allFixesData)) {
                        this.updateFixesStatsAndDropdowns(this.allFixesData);
                        this.renderFixesPage();
                        this.syncUnresolvedAfterFixChange(rows, result.appliedChanges || []);
                    } else {
                        this.loadFixes();
                    }
                }

                await this.recordBatch(file.name, type, processed, inserted, null);
            } catch (err) {
                Toast.show('Upload error: ' + err.message, 'error');
                await this.recordBatch(file.name, type, processed, inserted, err.message);
            } finally {
                this.isBulkUploading = false;
            }
        };

        document.getElementById('file-upload-mappings').addEventListener('change', (e) => handleUpload(e, 'mappings'));
        document.getElementById('file-upload-fixes').addEventListener('change', (e) => handleUpload(e, 'fixes'));

        // Templates
        document.getElementById('btn-template-mappings').addEventListener('click', () => {
            const worksheet = XLSX.utils.json_to_sheet([{
                "Item Name": "",
                "Adjusted Item Name": "",
                "Mapping": "",
                "2nd Mapping": ""
            }]);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, "Template");
            writeCompressedExcel(workbook, "Item_Mappings_Template.xlsx");
        });

        document.getElementById('btn-template-fixes').addEventListener('click', () => {
            const worksheet = XLSX.utils.json_to_sheet([{
                "Reference Number": "",
                "Correct ID": "",
                "Item Name": "",
                "Mapping": "",
                "2nd Mapping": ""
            }]);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, "Template");
            writeCompressedExcel(workbook, "Manual_Fixes_Template.xlsx");
        });

        // Manual Fixes Search, Filters, Deduplicate & Unresolved Transactions Panel
        const fixesSearch = document.getElementById('fixes-search');
        let fixesSearchTimeout;
        fixesSearch?.addEventListener('input', () => {
            clearTimeout(fixesSearchTimeout);
            fixesSearchTimeout = setTimeout(() => {
                this.fixesPage = 1;
                this.renderFixesPage();
            }, 250);
        });

        ['fixes-filter-type', 'fixes-filter-category'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => {
                this.fixesPage = 1;
                this.renderFixesPage();
            });
        });

        document.getElementById('btn-clear-fixes-filters')?.addEventListener('click', () => {
            const s = document.getElementById('fixes-search');
            const t = document.getElementById('fixes-filter-type');
            const c = document.getElementById('fixes-filter-category');
            if (s) s.value = '';
            if (t) t.value = '';
            if (c) c.value = '';
            this.fixesPage = 1;
            this.renderFixesPage();
        });

        document.getElementById('btn-dedup-fixes')?.addEventListener('click', async () => {
            const btn = document.getElementById('btn-dedup-fixes');
            const origHtml = btn.innerHTML;
            btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Cleaning...';
            btn.disabled = true;
            if (window.lucide) lucide.createIcons({ root: btn });
            try {
                await this.deduplicateManualFixes({ silent: false });
            } finally {
                btn.innerHTML = origHtml;
                btn.disabled = false;
                if (window.lucide) lucide.createIcons({ root: btn });
            }
        });

        document.getElementById('btn-toggle-unresolved-tx-panel')?.addEventListener('click', () => {
            const panel = document.getElementById('unresolved-tx-panel');
            if (!panel) return;
            const willOpen = panel.classList.contains('hidden');
            panel.classList.toggle('hidden');
            if (willOpen) this.loadUnresolvedTransactionsSummary();
        });

        document.getElementById('btn-close-unresolved-tx-panel')?.addEventListener('click', () => {
            document.getElementById('unresolved-tx-panel')?.classList.add('hidden');
        });

        // Item Mappings Search, Filters, Deduplicate & Unmapped Panel
        let mappingsSearchTimeout;
        document.getElementById('mappings-search')?.addEventListener('input', () => {
            clearTimeout(mappingsSearchTimeout);
            mappingsSearchTimeout = setTimeout(() => {
                this.mappingsPage = 1;
                this.renderMappingsPage();
            }, 250);
        });

        ['mappings-filter-category', 'mappings-filter-second-category', 'mappings-filter-type'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => {
                this.mappingsPage = 1;
                this.renderMappingsPage();
            });
        });

        document.getElementById('btn-clear-mappings-filters')?.addEventListener('click', () => {
            const s = document.getElementById('mappings-search');
            const c1 = document.getElementById('mappings-filter-category');
            const c2 = document.getElementById('mappings-filter-second-category');
            const t = document.getElementById('mappings-filter-type');
            if (s) s.value = '';
            if (c1) c1.value = '';
            if (c2) c2.value = '';
            if (t) t.value = '';
            this.mappingsPage = 1;
            this.renderMappingsPage();
        });

        document.getElementById('btn-dedup-mappings')?.addEventListener('click', async () => {
            const btn = document.getElementById('btn-dedup-mappings');
            const origHtml = btn.innerHTML;
            btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Cleaning...';
            btn.disabled = true;
            if (window.lucide) lucide.createIcons({ root: btn });
            try {
                await this.deduplicateItemMappings({ silent: false });
            } finally {
                btn.innerHTML = origHtml;
                btn.disabled = false;
                if (window.lucide) lucide.createIcons({ root: btn });
            }
        });

        document.getElementById('btn-toggle-unmapped-panel')?.addEventListener('click', () => {
            const panel = document.getElementById('unmapped-items-panel');
            if (!panel) return;
            const willOpen = panel.classList.contains('hidden');
            panel.classList.toggle('hidden');
            if (willOpen) this.loadUnmappedItemsSummary();
        });

        document.getElementById('btn-close-unmapped-panel')?.addEventListener('click', () => {
            document.getElementById('unmapped-items-panel')?.classList.add('hidden');
        });
    }

    initReapply() {
        const modal = document.getElementById('modal-reapply-preview');
        const tbody = document.getElementById('reapply-preview-table-body');
        const selectAll = document.getElementById('reapply-select-all');
        const summaryEl = document.getElementById('reapply-summary');
        const fmt = v => (v === null || v === undefined || v === '') ? 'Empty' : String(v);

        // Main "Re-apply Rules" button: compute a preview of every change
        document.getElementById('btn-reapply-rules').addEventListener('click', () => {
            withDropdownTaskProgress(
                'btn-reapply-rules',
                'Computing...',
                'Computing rules & fetching transactions...',
                async (progressToast) => {
                    try {
                        if (this.hasRole('admin') && !this._mappingsDedupedOnce) {
                            await this.deduplicateItemMappings({ silent: true });
                        }
                        const ruleCols = 'id, reference_number, student_id, original_student_id, item_name, check_column, mapping, second_mapping, id_status, is_settled, erp_batch_number';
                        const [mappings, fixes, links, txs] = await Promise.all([
                            fetchAll('item_mappings', '*', null, 'item_name'),
                            fetchAll('manual_fixes', '*', null, 'reference_number'),
                            fetchAll('links', 'payment_reference_number, custom_input_value', null, 'payment_reference_number'),
                            fetchAll('transactions', ruleCols, null, 'id')
                        ]);

                        progressToast.update(`Evaluating ${txs.length.toLocaleString()} transaction(s) against rules...`);
                        await new Promise(resolve => setTimeout(resolve, 0));

                        const fixesMap = new Map(fixes.map(f => [String(f.reference_number), f]));
                        const linksMap = new Map(links.map(l => [String(l.payment_reference_number), l]));
                        const lookupMapping = buildMappingLookup(mappings);

                        // Same pure function as import / fix save / mapping save: starts from the ORIGINAL
                        // imported ID and item name, so removed links, fixes and rules are undone too.
                        const proposals = [];
                        for (const tx of txs) {
                            const ref = String(tx.reference_number);
                            const diff = diffTransaction(tx, { link: linksMap.get(ref), fix: fixesMap.get(ref), lookupMapping });
                            if (diff.changed) proposals.push({ tx, diff });
                        }
                        window.reapplyProposals = proposals;

                        // Also apply manual fixes to Foreign Transactions when Re-apply Rules is clicked
                        this.allFixesData = fixes;
                        progressToast.update('Checking manual fixes for BM transactions...');
                        const foreignReapplied = await this.applyManualFixesToForeignTransactions(fixes);

                        if (proposals.length === 0) {
                            progressToast.dismiss();
                            Toast.show(
                                foreignReapplied > 0
                                    ? `Applied manual fixes to ${foreignReapplied} foreign transaction(s)!`
                                    : 'No rules need to be applied. Everything is up to date!',
                                foreignReapplied > 0 ? 'success' : 'info'
                            );
                            return;
                        }

                        const lockedCount = proposals.filter(p => p.diff.locked).length;
                        if (summaryEl) {
                            summaryEl.textContent = `${proposals.length} transaction(s) would change.` +
                                (lockedCount > 0 ? ` ${lockedCount} of them are settled or already recorded in ERP and are not selected by default – changing them does not change what was already posted to ERP.` : '');
                        }

                        tbody.innerHTML = proposals.map((p, idx) => {
                            const { tx, diff } = p;
                            const lockBadge = diff.locked
                                ? ` <span class="badge" style="background: rgba(245, 158, 11, 0.15); color: var(--warning, #f59e0b);">${tx.erp_batch_number ? 'In ERP' : 'Settled'}</span>`
                                : '';
                            return `
                        <tr>
                            <td><input type="checkbox" class="reapply-checkbox" data-index="${idx}" ${diff.locked ? '' : 'checked'}></td>
                            <td>${escapeHTML(tx.reference_number || '')}${lockBadge}</td>
                            <td><span class="badge" style="background: rgba(0, 229, 255, 0.1); color: var(--primary-color);">${escapeHTML(diff.changes.map(c => c.label).join(', '))}</span></td>
                            <td style="color: var(--text-muted); text-decoration: line-through;">${escapeHTML(diff.changes.map(c => fmt(c.from)).join(', '))}</td>
                            <td style="color: var(--success-color); font-weight: 500;">${escapeHTML(diff.changes.map(c => fmt(c.to)).join(', '))}</td>
                            <td style="font-size: 0.85rem; color: var(--text-muted);">${escapeHTML(diff.reasons.join(' + '))}</td>
                        </tr>
                    `;
                        }).join('');

                        // "Select all" reflects the rows as rendered (locked rows start unticked)
                        if (selectAll) {
                            selectAll.checked = lockedCount === 0;
                            selectAll.indeterminate = lockedCount > 0 && lockedCount < proposals.length;
                        }

                        progressToast.dismiss();
                        modal.classList.remove('hidden');
                    } catch (err) {
                        progressToast.dismiss();
                        Toast.show('Error computing rules: ' + err.message, 'error');
                    }
                }
            );
        });

        // "Select All" checkbox
        selectAll?.addEventListener('change', (e) => {
            e.target.indeterminate = false;
            document.querySelectorAll('.reapply-checkbox').forEach(cb => cb.checked = e.target.checked);
        });

        // "Apply Selected" button: writes only the rule columns of the selected rows
        document.getElementById('btn-apply-reapply-fixes')?.addEventListener('click', async () => {
            const btn = document.getElementById('btn-apply-reapply-fixes');
            const originalText = btn.innerHTML;

            const selected = Array.from(document.querySelectorAll('.reapply-checkbox:checked'))
                .map(cb => (window.reapplyProposals || [])[parseInt(cb.getAttribute('data-index'), 10)])
                .filter(Boolean);

            if (selected.length === 0) {
                Toast.show('No transactions selected.', 'info');
                modal.classList.add('hidden');
                return;
            }

            const lockedSelected = selected.filter(p => p.diff.locked).length;
            if (lockedSelected > 0) {
                const ok = await window.customConfirm(
                    `${lockedSelected} of the selected transactions are settled or already recorded in ERP. Changing them here will NOT change what was already posted to ERP. Continue?`,
                    'Apply Anyway', 'Cancel');
                if (!ok) return;
            }

            btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Applying...';
            btn.disabled = true;
            try {
                const updatedCount = await updateRuleFields(selected.map(p => ({ id: p.tx.id, fields: p.diff.fields, diff: p.diff })));
                this.invalidateDistinctCache();

                await this.logAudit('Rules Re-applied', `Batch of ${updatedCount} transactions`, {
                    count: updatedCount,
                    locked_included: lockedSelected
                });

                Toast.show(`Successfully updated ${updatedCount} transactions!`, 'success');
                modal.classList.add('hidden');
                window.reapplyProposals = [];
                this.loadTransactions();

            } catch (err) {
                Toast.show('Error applying rules: ' + err.message, 'error');
            } finally {
                btn.innerHTML = originalText;
                btn.disabled = false;
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    async loadMappings() {
        const tbody = document.getElementById('mappings-body');
        if (tbody) {
            tbody.innerHTML = Array(3).fill('<tr class="skeleton-row">' + '<td><div class="skeleton-cell" style="width:80%"></div></td>'.repeat(5) + '</tr>').join('');
        }
        try {
            if (this.hasRole('admin') && !this._mappingsDedupedOnce) {
                await this.deduplicateItemMappings({ silent: true });
            }
            const allData = await fetchAll('item_mappings', 'item_name, adjusted_item_name, mapping, second_mapping', null, 'item_name');
            this.allMappingsData = allData;
            this.mappingsPage = 1;
            this.updateMappingsStatsAndDropdowns(allData);
            this.renderMappingsPage();
            this.loadUnmappedItemsSummary();
            this.markTabLoaded('mappings');
        } catch (err) {
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="5" style="color: var(--danger);">${escapeHTML(err.message)}</td></tr>`;
            }
        }
    }

    updateMappingsStatsAndDropdowns(allData = this.allMappingsData || []) {
        const categories = [...new Set(allData.map(m => m.mapping).filter(Boolean))].sort();
        const secondCategories = [...new Set(allData.map(m => m.second_mapping).filter(Boolean))].sort();
        const renamedCount = allData.filter(m => m.adjusted_item_name && normalizeItemName(m.adjusted_item_name).toLowerCase() !== normalizeItemName(m.item_name).toLowerCase()).length;

        const elTotal = document.getElementById('mappings-stat-total');
        const elRenamed = document.getElementById('mappings-stat-renamed');
        const elCats = document.getElementById('mappings-stat-categories');
        const elSecCats = document.getElementById('mappings-stat-second-categories');
        if (elTotal) elTotal.textContent = allData.length.toLocaleString();
        if (elRenamed) elRenamed.textContent = renamedCount.toLocaleString();
        if (elCats) elCats.textContent = categories.length.toLocaleString();
        if (elSecCats) elSecCats.textContent = secondCategories.length.toLocaleString();

        const catSelect = document.getElementById('mappings-filter-category');
        if (catSelect) {
            const cur = catSelect.value;
            catSelect.innerHTML = '<option value="">All Categories</option>' +
                categories.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('');
            if (categories.includes(cur)) catSelect.value = cur;
        }

        const secSelect = document.getElementById('mappings-filter-second-category');
        if (secSelect) {
            const cur = secSelect.value;
            secSelect.innerHTML = '<option value="">All 2nd Categories</option>' +
                secondCategories.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('');
            if (secondCategories.includes(cur)) secSelect.value = cur;
        }

        const dl1 = document.getElementById('datalist-mapping-categories');
        if (dl1) {
            dl1.innerHTML = categories.map(c => `<option value="${escapeHTML(c)}"></option>`).join('');
        }
        const dl2 = document.getElementById('datalist-second-mapping-categories');
        if (dl2) {
            dl2.innerHTML = secondCategories.map(c => `<option value="${escapeHTML(c)}"></option>`).join('');
        }
    }

    async loadUnmappedItemsSummary() {
        const statEl = document.getElementById('mappings-stat-unmapped');
        const tbody = document.getElementById('unmapped-items-body');
        try {
            const unmappedRows = await fetchAll(
                'transactions',
                'id, reference_number, item_name, check_column, item_price, mapping',
                q => q.or('mapping.is.null,mapping.eq.'),
                'id'
            );

            const byOrigName = new Map();
            for (const tx of unmappedRows) {
                if (tx.mapping && String(tx.mapping).trim() !== '') continue;
                const orig = normalizeItemName(originalItemName(tx)) || normalizeItemName(tx.item_name);
                if (!orig) continue;
                const key = orig.toLowerCase();
                const prev = byOrigName.get(key) || {
                    originalName: orig,
                    displayName: normalizeItemName(tx.item_name) || orig,
                    count: 0,
                    totalAmount: 0
                };
                prev.count += 1;
                prev.totalAmount += parseFloat(tx.item_price || 0) || 0;
                byOrigName.set(key, prev);
            }

            const items = Array.from(byOrigName.values()).sort((a, b) => b.count - a.count || b.totalAmount - a.totalAmount);
            if (statEl) statEl.textContent = items.length.toLocaleString();

            if (!tbody) return;
            if (items.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="padding: 1.5rem; color: var(--success);">All transaction items in the database have a Mapping Category!</td></tr>';
                return;
            }

            const canEditMappings = this.hasRole('accountant');
            tbody.innerHTML = items.map(item => `
                <tr>
                    <td><strong>${escapeHTML(item.originalName)}</strong></td>
                    <td>${escapeHTML(item.displayName)}</td>
                    <td>${item.count.toLocaleString()}</td>
                    <td>EGP ${formatMoney(item.totalAmount)}</td>
                    <td>
                        ${canEditMappings ? `<button type="button" class="btn btn-primary btn-sm" data-quick-map="${escapeHTML(item.originalName)}">
                            <i data-lucide="plus" style="width: 12px; height: 12px;"></i> Map Item
                        </button>` : '<span style="color: var(--text-muted); font-size: 0.78rem;">View Only</span>'}
                    </td>
                </tr>
            `).join('');

            tbody.querySelectorAll('[data-quick-map]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const targetName = btn.getAttribute('data-quick-map');
                    const conflict = this.findConflictingMapping(targetName);
                    if (conflict) {
                        this.openMappingModalForEdit(conflict.rule);
                    } else {
                        this.resetMappingModal('Add Mapping');
                        document.getElementById('map-original').value = targetName;
                        document.getElementById('modal-mapping').classList.remove('hidden');
                        document.getElementById('map-original').dispatchEvent(new Event('input'));
                        setTimeout(() => document.getElementById('map-category')?.focus(), 50);
                    }
                });
            });
            if (window.lucide) lucide.createIcons({ root: tbody });
        } catch (err) {
            console.warn('Could not load unmapped items summary:', err.message);
            if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="text-center" style="color: var(--danger);">${escapeHTML(err.message)}</td></tr>`;
        }
    }

    renderMappingsPage() {
        const tbody = document.getElementById('mappings-body');
        if (!tbody) return;
        const allData = this.allMappingsData || [];
        const pageSize = 100;

        if (allData.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><i data-lucide="git-merge" style="width:48px;height:48px;opacity:0.5;"></i><h3>No mappings yet</h3><p>Click "Add Mapping" to create your first item mapping.</p></div></td></tr>';
            document.getElementById('mappings-pagination')?.remove();
            if (window.lucide) lucide.createIcons();
            return;
        }

        const searchQ = (document.getElementById('mappings-search')?.value || '').trim().toLowerCase();
        const filterCat = document.getElementById('mappings-filter-category')?.value || '';
        const filterSec = document.getElementById('mappings-filter-second-category')?.value || '';
        const filterType = document.getElementById('mappings-filter-type')?.value || '';

        const filteredData = allData.filter(m => {
            if (filterCat && (m.mapping || '') !== filterCat) return false;
            if (filterSec && (m.second_mapping || '') !== filterSec) return false;
            if (filterType === 'renamed' && (!m.adjusted_item_name || normalizeItemName(m.adjusted_item_name).toLowerCase() === normalizeItemName(m.item_name).toLowerCase())) return false;
            if (filterType === 'incomplete' && m.mapping && String(m.mapping).trim() !== '') return false;
            if (searchQ) {
                const hay = `${m.item_name || ''} ${m.adjusted_item_name || ''} ${m.mapping || ''} ${m.second_mapping || ''}`.toLowerCase();
                if (!hay.includes(searchQ)) return false;
            }
            return true;
        });

        if (filteredData.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><i data-lucide="search" style="width:40px;height:40px;opacity:0.5;"></i><h3>No matching rules</h3><p>Try adjusting your search or category filters.</p></div></td></tr>';
            document.getElementById('mappings-pagination')?.remove();
            if (window.lucide) lucide.createIcons();
            return;
        }

        const totalPages = Math.max(1, Math.ceil(filteredData.length / pageSize));
        if (!this.mappingsPage || this.mappingsPage > totalPages) this.mappingsPage = 1;
        const startIdx = (this.mappingsPage - 1) * pageSize;
        const pageData = filteredData.slice(startIdx, startIdx + pageSize);

        const canEditMapping = this.hasRole('accountant');
        const canDeleteMapping = this.hasRole('admin');
        tbody.innerHTML = pageData.map(m => `
            <tr>
                <td><strong>${escapeHTML(m.item_name)}</strong></td>
                <td>${m.adjusted_item_name ? `<span style="color: var(--primary);">${escapeHTML(m.adjusted_item_name)}</span>` : '<span style="color: var(--text-muted);">-</span>'}</td>
                <td>${m.mapping ? `<span class="badge" style="background: rgba(56, 189, 248, 0.12); color: var(--primary); border: 1px solid rgba(56, 189, 248, 0.25);">${escapeHTML(m.mapping)}</span>` : '<span style="color: var(--warning); font-size: 0.8rem;">Unmapped</span>'}</td>
                <td>${escapeHTML(m.second_mapping) || '-'}</td>
                <td style="white-space: nowrap;">
                    ${canEditMapping ? `<button class="btn btn-outline btn-sm" data-edit-mapping="${escapeHTML(m.item_name)}">Edit</button>` : ''}
                    ${canDeleteMapping ? `<button class="btn btn-outline btn-sm" style="color: var(--danger);" data-delete-mapping="${escapeHTML(m.item_name)}">Delete</button>` : ''}
                    ${(!canEditMapping && !canDeleteMapping) ? '<span style="color: var(--text-muted); font-size: 0.78rem;">View Only</span>' : ''}
                </td>
            </tr>
        `).join('');

        // Wire up Edit buttons
        tbody.querySelectorAll('[data-edit-mapping]').forEach(btn => {
            btn.addEventListener('click', () => {
                const itemName = btn.getAttribute('data-edit-mapping');
                const mapping = allData.find(m => m.item_name === itemName);
                if (mapping) {
                    this.openMappingModalForEdit(mapping);
                }
            });
        });

        // Wire up Delete buttons
        tbody.querySelectorAll('[data-delete-mapping]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const itemName = btn.getAttribute('data-delete-mapping');
                if (!await window.customConfirm(`Delete mapping for "${itemName}"?`, 'Delete', 'Cancel')) return;
                btn.disabled = true;
                try {
                    const prevRule = allData.find(m => m.item_name === itemName);
                    const previouslyRenamedTo = await this.getCurrentAdjustedNames([itemName]);
                    const { error } = await supabase.from('item_mappings').delete().eq('item_name', itemName);
                    if (error) throw error;

                    await this.logAudit('Mapping Deleted', itemName, {
                        item_name: itemName,
                        revert_data: prevRule ? {
                            table_name: 'item_mappings',
                            operation: 'upsert',
                            previous_rows: [prevRule]
                        } : undefined
                    });

                    const rows = await this.fetchTransactionsForItemNames([itemName], previouslyRenamedTo);
                    const result = await this.reapplyRulesTo(rows);

                    this.mappingSuggestCache = null;
                    Toast.show(`Mapping deleted. ${this.reapplySummary(result)}`, 'success');
                    this.loadMappings();
                } catch (err) {
                    Toast.show('Error deleting mapping: ' + err.message, 'error');
                    btn.disabled = false;
                }
            });
        });

        const container = tbody.closest('.table-container');
        if (container) {
            let pager = document.getElementById('mappings-pagination');
            if (filteredData.length <= pageSize) {
                if (pager) pager.remove();
            } else {
                if (!pager) {
                    pager = document.createElement('div');
                    pager.id = 'mappings-pagination';
                    pager.className = 'pagination';
                    container.appendChild(pager);
                }
                pager.innerHTML = `
                    <span class="text-muted">Showing ${startIdx + 1}-${Math.min(startIdx + pageSize, filteredData.length)} of ${filteredData.length} mappings</span>
                    <div class="pagination-controls" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                        <button class="btn btn-icon" id="btn-mappings-prev" ${this.mappingsPage <= 1 ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button>
                        <span>Page ${this.mappingsPage} of ${totalPages}</span>
                        <button class="btn btn-icon" id="btn-mappings-next" ${this.mappingsPage >= totalPages ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button>
                        ${this.pageJump.renderHtml('mappings', totalPages)}
                    </div>
                `;
                pager.querySelector('#btn-mappings-prev')?.addEventListener('click', () => {
                    if (this.mappingsPage > 1) {
                        this.mappingsPage--;
                        this.renderMappingsPage();
                    }
                });
                pager.querySelector('#btn-mappings-next')?.addEventListener('click', () => {
                    if (this.mappingsPage < totalPages) {
                        this.mappingsPage++;
                        this.renderMappingsPage();
                    }
                });
                this.pageJump.bind('mappings', totalPages, (target) => {
                    this.mappingsPage = target;
                    this.renderMappingsPage();
                }, pager);
            }
        }
        renderIcons(document.getElementById('view-mappings'));
    }

    async deduplicateManualFixes({ silent = true, prefetchedRows = null } = {}) {
        try {
            this._fixesDedupedOnce = true;
            const allRows = Array.isArray(prefetchedRows)
                ? prefetchedRows
                : await fetchAll('manual_fixes', '*', null, 'reference_number');
            if (!allRows || allRows.length === 0) {
                if (!silent) Toast.show('No manual fixes found to check.', 'info');
                return { mergedCount: 0, deletedCount: 0, cleanRows: [] };
            }

            const byNormRef = new Map();
            const keysToDelete = [];
            const rowsToUpsert = [];

            for (const row of allRows) {
                const rawRef = String(row.reference_number || '');
                const cleanRef = rawRef.trim();
                if (!cleanRef) continue;
                const normKey = cleanRef.toLowerCase();

                const normalizedRow = {
                    reference_number: cleanRef,
                    correct_id: row.correct_id ? String(row.correct_id).trim() : null,
                    item_name: row.item_name ? normalizeItemName(row.item_name) : null,
                    mapping: row.mapping ? normalizeItemName(row.mapping) : null,
                    second_mapping: row.second_mapping ? normalizeItemName(row.second_mapping) : null
                };

                if (!byNormRef.has(normKey)) {
                    byNormRef.set(normKey, {
                        canonical: normalizedRow,
                        rawKeys: [rawRef],
                        needsSave: rawRef !== cleanRef
                    });
                } else {
                    const group = byNormRef.get(normKey);
                    group.rawKeys.push(rawRef);
                    group.canonical = {
                        reference_number: group.canonical.reference_number,
                        correct_id: group.canonical.correct_id || normalizedRow.correct_id || null,
                        item_name: group.canonical.item_name || normalizedRow.item_name || null,
                        mapping: group.canonical.mapping || normalizedRow.mapping || null,
                        second_mapping: group.canonical.second_mapping || normalizedRow.second_mapping || null
                    };
                    group.needsSave = true;
                }
            }

            const cleanRows = [];
            for (const group of byNormRef.values()) {
                cleanRows.push(group.canonical);
                if (group.rawKeys.length > 1 || group.needsSave) {
                    rowsToUpsert.push(group.canonical);
                    for (const k of group.rawKeys) {
                        if (k !== group.canonical.reference_number) {
                            keysToDelete.push(k);
                        }
                    }
                }
            }
            cleanRows.sort((a, b) => String(a.reference_number || '').localeCompare(String(b.reference_number || '')));

            if (keysToDelete.length === 0 && rowsToUpsert.length === 0) {
                if (!silent) Toast.show('All manual fixes are clean — no duplicate Reference Numbers found!', 'success');
                return { mergedCount: 0, deletedCount: 0, cleanRows };
            }

            if (keysToDelete.length > 0) {
                for (let i = 0; i < keysToDelete.length; i += 200) {
                    const chunk = keysToDelete.slice(i, i + 200);
                    const { error: delErr } = await supabase.from('manual_fixes').delete().in('reference_number', chunk);
                    if (delErr) throw delErr;
                }
            }

            if (rowsToUpsert.length > 0) {
                for (let i = 0; i < rowsToUpsert.length; i += 200) {
                    const chunk = rowsToUpsert.slice(i, i + 200);
                    const { error: upErr } = await supabase.from('manual_fixes').upsert(chunk, { onConflict: 'reference_number', ignoreDuplicates: false });
                    if (upErr) throw upErr;
                }
            }

            await this.logAudit('Manual Fixes Deduplicated', `${rowsToUpsert.length} merged, ${keysToDelete.length} removed`, {
                merged: rowsToUpsert.length,
                deleted_keys: keysToDelete
            });

            if (!silent) {
                Toast.show(`Cleaned ${keysToDelete.length} duplicate/whitespace fix row(s)!`, 'success');
                this.allFixesData = cleanRows;
                this.updateFixesStatsAndDropdowns(cleanRows);
                this.renderFixesPage();
            }

            return { mergedCount: rowsToUpsert.length, deletedCount: keysToDelete.length, cleanRows };
        } catch (err) {
            if (!silent) Toast.show('Error deduplicating fixes: ' + err.message, 'error');
            return { mergedCount: 0, deletedCount: 0, cleanRows: Array.isArray(prefetchedRows) ? prefetchedRows : [] };
        }
    }

    async loadFixes() {
        const tbody = document.getElementById('fixes-body');
        if (tbody && (!this.allFixesData || this.allFixesData.length === 0)) {
            tbody.innerHTML = Array(3).fill('<tr class="skeleton-row">' + '<td><div class="skeleton-cell" style="width:80%"></div></td>'.repeat(6) + '</tr>').join('');
        }
        try {
            let allData = await fetchAll('manual_fixes', 'reference_number, correct_id, item_name, mapping, second_mapping', null, 'reference_number');
            if (this.hasRole('admin') && !this._fixesDedupedOnce) {
                const dedupRes = await this.deduplicateManualFixes({ silent: true, prefetchedRows: allData });
                if (Array.isArray(dedupRes.cleanRows)) {
                    allData = dedupRes.cleanRows;
                }
            }
            this.allFixesData = allData;
            this.fixesPage = 1;
            this.updateFixesStatsAndDropdowns(allData);
            this.renderFixesPage();
            this.loadUnresolvedTransactionsSummary();
            this.markTabLoaded('fixes');
        } catch (err) {
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="6" style="color: var(--danger);">${escapeHTML(err.message)}</td></tr>`;
            }
        }
    }

    updateFixesStatsAndDropdowns(allData = this.allFixesData || []) {
        const idFixesCount = allData.filter(f => f.correct_id && String(f.correct_id).trim() !== '').length;
        const itemFixesCount = allData.filter(f =>
            (f.item_name && String(f.item_name).trim() !== '') ||
            (f.mapping && String(f.mapping).trim() !== '') ||
            (f.second_mapping && String(f.second_mapping).trim() !== '')
        ).length;
        const invalidIdCount = allData.filter(f => f.correct_id && validateID(String(f.correct_id).trim()) !== 'Valid').length;
        const categories = [...new Set(allData.map(f => f.mapping).filter(Boolean))].sort();

        const elTotal = document.getElementById('fixes-stat-total');
        const elId = document.getElementById('fixes-stat-id');
        const elItem = document.getElementById('fixes-stat-item');
        const elInvalid = document.getElementById('fixes-stat-invalid-id');
        if (elTotal) elTotal.textContent = allData.length.toLocaleString();
        if (elId) elId.textContent = idFixesCount.toLocaleString();
        if (elItem) elItem.textContent = itemFixesCount.toLocaleString();
        if (elInvalid) elInvalid.textContent = invalidIdCount.toLocaleString();

        const catSelect = document.getElementById('fixes-filter-category');
        if (catSelect) {
            const cur = catSelect.value;
            catSelect.innerHTML = '<option value="">All Mapping Categories</option>' +
                categories.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('');
            if (categories.includes(cur)) catSelect.value = cur;
        }
    }

    renderUnresolvedTransactionsDom() {
        const statEl = document.getElementById('fixes-stat-unresolved');
        const tbody = document.getElementById('unresolved-tx-body');
        const byRef = this.unresolvedTxByRef || new Map();
        const items = Array.from(byRef.values());
        if (statEl) statEl.textContent = items.length.toLocaleString();

        if (!tbody) return;
        if (items.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding: 1.5rem; color: var(--success);">All transactions in the database currently have a Valid Student ID!</td></tr>';
            return;
        }

        const canEditFixes = this.hasRole('accountant');
        const displayItems = items.slice(0, 150);
        tbody.innerHTML = displayItems.map(t => {
            const isMissing = t.id_status && t.id_status.includes('Missing');
            const statusClass = isMissing ? 'missing' : 'error';
            return `
                <tr>
                    <td style="white-space: nowrap;"><strong>${escapeHTML(t.reference_number)}</strong></td>
                    <td style="white-space: nowrap;">${escapeHTML(toDateOnly(t.payment_date) || '-')}</td>
                    <td>${escapeHTML(t.student_id || '-')}</td>
                    <td><span class="badge ${statusClass}">${escapeHTML(t.id_status || 'Error')}</span></td>
                    <td style="max-width: 240px; white-space: normal; font-size: 0.82rem;">${escapeHTML(t.item_name || '-')}</td>
                    <td style="white-space: nowrap;">EGP ${formatMoney(t.item_price)}</td>
                    <td>
                        ${canEditFixes ? `<button class="btn btn-primary btn-sm" data-fix-unresolved="${escapeHTML(t.reference_number)}">
                            <i data-lucide="wrench" style="width: 13px; height: 13px;"></i> Fix
                        </button>` : '<span style="color: var(--text-muted); font-size: 0.78rem;">View Only</span>'}
                    </td>
                </tr>
            `;
        }).join('');

        tbody.querySelectorAll('[data-fix-unresolved]').forEach(btn => {
            btn.addEventListener('click', () => {
                const ref = btn.getAttribute('data-fix-unresolved');
                this.openQuickFixForRef(ref);
            });
        });
        if (window.lucide) lucide.createIcons({ root: tbody });
    }

    syncUnresolvedAfterFixChange(txRows = [], appliedChanges = []) {
        if (!this.unresolvedTxByRef) return;
        const changeById = new Map((appliedChanges || []).map(c => [c.id, c.fields]));
        let mutated = false;

        for (const tx of txRows || []) {
            if (!tx || !tx.reference_number) continue;
            const refKey = String(tx.reference_number).trim();
            const updatedFields = changeById.get(tx.id);
            const newStatus = updatedFields ? updatedFields.id_status : tx.id_status;
            const newStudentId = updatedFields ? updatedFields.student_id : tx.student_id;
            const newItemName = updatedFields ? updatedFields.item_name : tx.item_name;

            if (newStatus === 'Valid') {
                if (this.unresolvedTxByRef.delete(refKey)) mutated = true;
            } else {
                this.unresolvedTxByRef.set(refKey, {
                    ...tx,
                    student_id: newStudentId,
                    item_name: newItemName,
                    id_status: newStatus
                });
                mutated = true;
            }
        }

        if (mutated) {
            this.renderUnresolvedTransactionsDom();
            this.updateSidebarBadges();
        }
    }

    async loadUnresolvedTransactionsSummary() {
        const tbody = document.getElementById('unresolved-tx-body');
        try {
            const badRows = await fetchAll(
                'transactions',
                'id, reference_number, payment_date, student_id, id_status, item_name, item_price, mapping, second_mapping',
                q => q.neq('id_status', 'Valid').neq('id_status', 'Exempt'),
                'id'
            );

            // Group by reference_number so each reference appears once (exclude exempt Dip & Workshop rows)
            const byRef = new Map();
            for (const tx of badRows) {
                if (!tx.reference_number || isNonInvalidTransaction(tx)) continue;
                const key = String(tx.reference_number).trim();
                if (!byRef.has(key)) {
                    byRef.set(key, tx);
                }
            }
            for (const ftx of (this.foreignTransactions || [])) {
                const norm = this.normalizeForeignTransactionRow(ftx);
                if (!norm.reference_number || isNonInvalidTransaction(norm)) continue;
                const key = String(norm.reference_number).trim();
                if (!byRef.has(key)) {
                    byRef.set(key, {
                        reference_number: norm.reference_number,
                        payment_date: norm.value_date || norm.payment_date,
                        student_id: norm.student_id || '',
                        id_status: norm.id_status || 'Missing ID',
                        item_name: norm.description || '',
                        item_price: norm.amount || 0
                    });
                }
            }

            this.unresolvedTxByRef = byRef;
            this.renderUnresolvedTransactionsDom();
        } catch (err) {
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="7" style="color: var(--danger);">${escapeHTML(err.message)}</td></tr>`;
            }
        }
    }

    renderFixesPage() {
        const tbody = document.getElementById('fixes-body');
        if (!tbody) return;
        const allData = this.allFixesData || [];
        const pageSize = 100;

        const searchVal = (document.getElementById('fixes-search')?.value || '').trim().toLowerCase();
        const typeFilter = document.getElementById('fixes-filter-type')?.value || '';
        const catFilter = document.getElementById('fixes-filter-category')?.value || '';

        const filteredData = allData.filter(f => {
            if (searchVal) {
                const haystack = [
                    f.reference_number,
                    f.correct_id,
                    f.item_name,
                    f.mapping,
                    f.second_mapping
                ].filter(Boolean).join(' ').toLowerCase();
                if (!haystack.includes(searchVal)) return false;
            }
            if (catFilter && (f.mapping || '') !== catFilter) return false;

            const hasId = Boolean(f.correct_id && String(f.correct_id).trim() !== '');
            const hasItem = Boolean(
                (f.item_name && String(f.item_name).trim() !== '') ||
                (f.mapping && String(f.mapping).trim() !== '') ||
                (f.second_mapping && String(f.second_mapping).trim() !== '')
            );
            if (typeFilter === 'id_only' && (!hasId || hasItem)) return false;
            if (typeFilter === 'item_only' && (!hasItem || hasId)) return false;
            if (typeFilter === 'both' && (!hasId || !hasItem)) return false;
            if (typeFilter === 'invalid_id') {
                if (!hasId || validateID(String(f.correct_id).trim()) === 'Valid') return false;
            }
            return true;
        });

        if (filteredData.length === 0) {
            const hasActiveFilters = Boolean(searchVal || typeFilter || catFilter);
            tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><i data-lucide="wrench" style="width:48px;height:48px;opacity:0.5;"></i><h3>${hasActiveFilters ? 'No matching manual fixes' : 'No manual fixes'}</h3><p>${hasActiveFilters ? 'Try clearing or adjusting your search filters.' : 'Click "Add Fix" to create a manual correction.'}</p></div></td></tr>`;
            document.getElementById('fixes-pagination')?.remove();
            if (window.lucide) lucide.createIcons();
            return;
        }

        const totalPages = Math.max(1, Math.ceil(filteredData.length / pageSize));
        if (!this.fixesPage || this.fixesPage > totalPages) this.fixesPage = 1;
        const startIdx = (this.fixesPage - 1) * pageSize;
        const pageData = filteredData.slice(startIdx, startIdx + pageSize);

        const canEditFix = this.hasRole('accountant');
        const canDeleteFix = this.hasRole('admin');
        tbody.innerHTML = pageData.map(f => {
            const cid = f.correct_id ? String(f.correct_id).trim() : '';
            const idStatus = cid ? validateID(cid) : null;
            const idBadge = cid
                ? (idStatus === 'Valid'
                    ? `<strong>${escapeHTML(cid)}</strong>`
                    : `<span style="display: inline-flex; align-items: center; gap: 0.35rem;"><strong style="color: var(--danger);">${escapeHTML(cid)}</strong> <span class="badge error" title="${escapeHTML(idStatus)}" style="font-size: 0.68rem;">Invalid</span></span>`)
                : '-';

            return `
                <tr>
                    <td><strong>${escapeHTML(f.reference_number)}</strong></td>
                    <td>${idBadge}</td>
                    <td>${escapeHTML(f.item_name) || '-'}</td>
                    <td>${ f.mapping ? `<span class="badge valid" style="background: rgba(16, 185, 129, 0.12); color: #10b981;">${escapeHTML(f.mapping)}</span>` : '-' }</td>
                    <td>${escapeHTML(f.second_mapping) || '-'}</td>
                    <td>
                        ${canEditFix ? `<button class="btn btn-outline btn-sm" data-edit-fix="${escapeHTML(f.reference_number)}">Edit</button>` : ''}
                        ${canDeleteFix ? `<button class="btn btn-outline btn-sm" style="color: var(--danger);" data-delete-fix="${escapeHTML(f.reference_number)}">Delete</button>` : ''}
                        ${(!canEditFix && !canDeleteFix) ? '<span style="color: var(--text-muted); font-size: 0.78rem;">View Only</span>' : ''}
                    </td>
                </tr>
            `;
        }).join('');

        // Wire up Edit buttons
        tbody.querySelectorAll('[data-edit-fix]').forEach(btn => {
            btn.addEventListener('click', () => {
                const ref = btn.getAttribute('data-edit-fix');
                const fix = allData.find(f => f.reference_number === ref);
                if (fix) {
                    this.openFixModalForEdit(fix);
                }
            });
        });

        // Wire up Delete buttons
        tbody.querySelectorAll('[data-delete-fix]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const ref = btn.getAttribute('data-delete-fix');
                if (!await window.customConfirm(`Delete fix for reference "${ref}"?`, 'Delete', 'Cancel')) return;
                btn.disabled = true;
                try {
                    const prevFix = allData.find(f => f.reference_number === ref);
                    const { error } = await supabase.from('manual_fixes').delete().eq('reference_number', ref);
                    if (error) throw error;

                    if (Array.isArray(this.allFixesData)) {
                        const cleanKey = String(ref || '').trim().toLowerCase();
                        this.allFixesData = this.allFixesData.filter(f => String(f.reference_number || '').trim().toLowerCase() !== cleanKey);
                    }

                    const fixRuleCols = 'id, reference_number, payment_date, student_id, original_student_id, item_name, item_price, check_column, mapping, second_mapping, id_status, is_settled, erp_batch_number';
                    const [, rows] = await Promise.all([
                        this.logAudit('Manual Fix Deleted', ref, {
                            reference_number: ref,
                            revert_data: prevFix ? {
                                table_name: 'manual_fixes',
                                operation: 'upsert',
                                previous_rows: [prevFix]
                            } : undefined
                        }),
                        fetchAll('transactions', fixRuleCols, q => q.eq('reference_number', ref), 'id')
                    ]);

                    const result = await this.reapplyRulesTo(rows, {
                        fixes: this.allFixesData || [],
                        mappings: this.allMappingsData || undefined
                    });

                    Toast.show(`Fix deleted. ${this.reapplySummary(result)}`, 'success');
                    if (Array.isArray(this.allFixesData)) {
                        this.updateFixesStatsAndDropdowns(this.allFixesData);
                        this.renderFixesPage();
                        this.syncUnresolvedAfterFixChange(rows, result.appliedChanges || []);
                    } else {
                        this.loadFixes();
                    }
                } catch (err) {
                    Toast.show('Error deleting fix: ' + err.message, 'error');
                    btn.disabled = false;
                }
            });
        });

        const container = tbody.closest('.table-container');
        if (container) {
            let pager = document.getElementById('fixes-pagination');
            if (filteredData.length <= pageSize) {
                if (pager) pager.remove();
            } else {
                if (!pager) {
                    pager = document.createElement('div');
                    pager.id = 'fixes-pagination';
                    pager.className = 'pagination';
                    container.appendChild(pager);
                }
                pager.innerHTML = `
                    <span class="text-muted">Showing ${startIdx + 1}-${Math.min(startIdx + pageSize, filteredData.length)} of ${filteredData.length} fixes</span>
                    <div class="pagination-controls" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                        <button class="btn btn-icon" id="btn-fixes-prev" ${this.fixesPage <= 1 ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button>
                        <span>Page ${this.fixesPage} of ${totalPages}</span>
                        <button class="btn btn-icon" id="btn-fixes-next" ${this.fixesPage >= totalPages ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button>
                        ${this.pageJump.renderHtml('fixes', totalPages)}
                    </div>
                `;
                pager.querySelector('#btn-fixes-prev')?.addEventListener('click', () => {
                    if (this.fixesPage > 1) {
                        this.fixesPage--;
                        this.renderFixesPage();
                    }
                });
                pager.querySelector('#btn-fixes-next')?.addEventListener('click', () => {
                    if (this.fixesPage < totalPages) {
                        this.fixesPage++;
                        this.renderFixesPage();
                    }
                });
                this.pageJump.bind('fixes', totalPages, (target) => {
                    this.fixesPage = target;
                    this.renderFixesPage();
                }, pager);
            }
        }
        renderIcons(document.getElementById('view-fixes'));
    }
}

export function applyMappingsFixesUiMixin(AppClass) {
    for (const name of Object.getOwnPropertyNames(MappingsFixesUiMixin.prototype)) {
        if (name !== 'constructor') {
            Object.defineProperty(AppClass.prototype, name, Object.getOwnPropertyDescriptor(MappingsFixesUiMixin.prototype, name));
        }
    }
}
