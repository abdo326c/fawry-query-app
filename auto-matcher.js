import { supabase } from './supabase.js';
import { FawryProcessor } from './csv-processor.js';
import {
    validateID, isIdValidationExempt, getEffectiveIdStatus, isNonInvalidTransaction,
    fetchAll, fetchByIn, recomputeTransactions, updateRuleFields, diffTransaction,
    buildMappingLookup, normalizeItemName, originalItemName, isLockedTransaction,
    escapeHTML, sanitizeExcelValue, sanitizeExcelRows, toDateOnly, dateToExcelSerial,
    calculateSettlementDate, isSameDaySettlementBank, resolveErpJournalDate,
    normalizeStudentIdValue, getStudentProgramLevel, formatStudentLevelTag,
    ensureProgramHasLevelPrefix, normalizePhoneKey, buildStudentLookupIndex,
    matchTransactionToStudent, classifyStudentEmails, mergeStudentEmails,
    getStudentDisplayEmails, writeCompressedExcel
} from './rules.js';
import {
    parseBankStatementGrid, parseBanqueMisrPdfText, reconstructBanqueMisrPdfLinesFromPages,
    matchForeignDepositsToStudents, normalizePersonName, DEFAULT_FOREIGN_BANK, DEFAULT_FOREIGN_MAPPING
} from './foreign-transactions.js';
import {
    loadFxStore, saveFxStore, resolveUsdToEgpRate, convertUsdToEgp, syncMissingFxRates,
    setManualFxRate, getEgyptDateTimeParts, getMsUntilNextEgyptNoon, isRateStaleForEgyptNoon
} from './fx-rates.js';
import {
    runConcurrent, loadScriptOnce, renderIcons, SUPABASE_EXEMPT_OR_FILTER,
    formatIdStatusMeta, formatMoney, sanitizeForFilter, Toast, withDropdownTaskProgress
} from './app-utils.js';

class AutoMatcherMixin {
    async handleTargetedMatcherImport(file) {
        const status = document.getElementById('automatcher-import-status');
        status.innerText = 'Parsing file...';
        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(firstSheet);
            
            const refs = [];
            for (const r of rows) {
                const ref = r['Ref Number'] || r['Reference Number'] || r['REF NUMBER'] || r['Reference_Number'];
                if (ref) refs.push(String(ref).trim());
            }
            if (refs.length === 0) throw new Error("No 'Reference Number' or 'Ref Number' column found in file.");
            
            this.targetedMatchRefs = refs;
            status.innerText = `Targeted ${refs.length} transactions! Filter applied. Click Run Auto-Match.`;
        } catch(err) {
            status.innerText = 'Error: ' + err.message;
        }
    }

    async runAutoMatcher() {
        const btn = document.getElementById('btn-run-automatcher');
        const tbody = document.getElementById('automatcher-table-body');
        const btnApply = document.getElementById('btn-apply-automatch-fixes');
        
        btn.innerHTML = `<i data-lucide="loader" class="spin"></i> Matching...`;
        btn.disabled = true;
        if (window.lucide) lucide.createIcons();

        try {
            const dateFrom = document.getElementById('automatcher-date-from')?.value;
            const dateTo = document.getElementById('automatcher-date-to')?.value;

            // Fetch base invalidTx filtered by date range and optional targeted ref list
            // (Search and header filters are applied client-side in renderAutoMatcherPage so selections persist)
            let queryFn = (q) => {
                q = q.neq('id_status', 'Valid').neq('id_status', 'Exempt');
                if (dateFrom) q = q.gte('payment_date', dateFrom);
                if (dateTo) q = q.lte('payment_date', dateTo);
                if (this.targetedMatchRefs && this.targetedMatchRefs.length > 0 && this.targetedMatchRefs.length <= 500) {
                    q = q.in('reference_number', this.targetedMatchRefs);
                }
                return q;
            };

            if (this.targetedMatchRefs && this.targetedMatchRefs.length > 500) {
                console.warn("Large targeted filter, fetching all and filtering locally.");
            }

            const matcherCols = 'id, reference_number, payment_date, student_id, original_student_id, customer_mobile, item_name, item_price, mapping, second_mapping, bank, id_status, is_settled, erp_batch_number';
            const [rawInvalidTx, loadedStudents] = await Promise.all([
                fetchAll('transactions', matcherCols, queryFn),
                this.ensureFullStudentMaster()
            ]);
            let invalidTx = rawInvalidTx;
            
            // If the targeted match list was very large and bypassed the .in(), filter locally
            if (this.targetedMatchRefs && this.targetedMatchRefs.length > 500) {
                const targetSet = new Set(this.targetedMatchRefs);
                invalidTx = invalidTx.filter(t => targetSet.has(t.reference_number));
            }

            // Ignore exempt categories (e.g. Dip & Workshop) — they do not follow standard tuition ID rules
            invalidTx = (invalidTx || []).filter(t => !isNonInvalidTransaction(t));

            this.invalidTx = invalidTx; // Store for header filter dropdowns

            if (invalidTx.length === 0) {
                this.automatchProposals = [];
                this.renderAutoMatcherPage();
                tbody.innerHTML = '<tr><td colspan="10" class="text-center" style="padding: 2rem;">No invalid IDs found matching criteria.</td></tr>';
                if (btnApply) btnApply.style.display = 'none';
                const btnHigh = document.getElementById('btn-select-high-confidence');
                if (btnHigh) btnHigh.style.display = 'none';
                return;
            }
            
            // Generate distinct mappings and item names for the filters
            const distinctMappings = [...new Set(invalidTx.map(t => t.mapping).filter(Boolean))].sort();
            const distinctItems = [...new Set(invalidTx.map(t => t.item_name).filter(Boolean))].sort();
            
            // Store for header filters
            this.automatchDistinctMappings = distinctMappings;
            this.automatchDistinctItems = distinctItems;

            let filteredTx = invalidTx;

            const enableNameMatch = document.getElementById('automatch-enable-name')?.checked;
            const invalidRefs = filteredTx.map(t => String(t.reference_number));

            // Fetch links for invalid references
            const links = await fetchByIn(
                'links',
                'payment_reference_number, custom_input_value, customer_national_id, customer_mobile, customer_email, customer_name',
                'payment_reference_number',
                invalidRefs,
                'payment_reference_number',
                400
            );

            const students = loadedStudents || [];

            // Build lookups
            const linksMap = {};
            links.forEach(l => {
                linksMap[l.payment_reference_number] = l;
            });

            const fixesMap = new Map();
            (this.allFixesData || []).forEach(f => {
                if (f && f.reference_number) {
                    fixesMap.set(String(f.reference_number).trim(), f);
                }
            });

            // Detect Fawry kiosk / shared terminal mobile numbers (phones appearing across 3+ distinct student names/IDs)
            const mobileIdentityBuckets = new Map();
            for (const tx of filteredTx) {
                const pk = normalizePhoneKey(tx.customer_mobile);
                if (!pk) continue;
                const sig = String(tx.student_id || tx.original_student_id || tx.reference_number || '').trim().toLowerCase();
                if (!sig) continue;
                if (!mobileIdentityBuckets.has(pk)) mobileIdentityBuckets.set(pk, new Set());
                mobileIdentityBuckets.get(pk).add(sig);
            }
            const sharedMobileSet = new Set();
            for (const [pk, sigSet] of mobileIdentityBuckets.entries()) {
                if (sigSet.size >= 3) sharedMobileSet.add(pk);
            }

            const studentLookupIndex = buildStudentLookupIndex(students);

            this.automatchProposals = [];

            let loopCount = 0;
            let lastYield = typeof performance !== 'undefined' ? performance.now() : Date.now();
            for (const tx of filteredTx) {
                loopCount++;
                if ((loopCount & 63) === 0) {
                    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
                    if (now - lastYield > 50) {
                        btn.innerHTML = `<i data-lucide="loader" class="spin"></i> Matching... ${loopCount}/${filteredTx.length}`;
                        await new Promise(r => setTimeout(r, 0));
                        lastYield = typeof performance !== 'undefined' ? performance.now() : Date.now();
                    }
                }

                const link = linksMap[tx.reference_number];
                const existingFix = fixesMap.get(String(tx.reference_number || '').trim()) || null;
                const rawTxSid = tx.student_id ? String(tx.student_id).trim() : '';

                const { proposedStudent, matchReason, confidenceTier } = matchTransactionToStudent(tx, {
                    index: studentLookupIndex,
                    link,
                    existingFix,
                    enableNameMatch: Boolean(enableNameMatch),
                    sharedMobileSet
                });

                // Track for export & display
                const proposalTx = {
                    tx_id: tx.id,
                    proposedStudent: proposedStudent,
                    matchReason: matchReason,
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
                };

                this.automatchProposals.push(proposalTx);
            }

            // Second-pass sibling propagation: if one line item of a multi-item reference matched,
            // propagate that match to any unmatched sibling line item sharing the same reference_number
            const matchedByRef = new Map();
            for (const p of this.automatchProposals) {
                if (p.proposedStudent && p.original_ref && !matchedByRef.has(p.original_ref)) {
                    matchedByRef.set(p.original_ref, p);
                }
            }
            for (const p of this.automatchProposals) {
                if (!p.proposedStudent && p.original_ref && matchedByRef.has(p.original_ref)) {
                    const sib = matchedByRef.get(p.original_ref);
                    p.proposedStudent = sib.proposedStudent;
                    p.confidenceTier = sib.confidenceTier;
                    p.matchReason = `${sib.matchReason} (Same Order Reference)`;
                }
            }

            // Sort proposals by confidence tier priority: high -> phone -> name -> unmatched
            const tierPriority = { high: 1, phone: 2, name: 3, unmatched: 4 };
            this.automatchProposals.sort((a, b) => {
                const pa = tierPriority[a.confidenceTier] || 4;
                const pb = tierPriority[b.confidenceTier] || 4;
                return pa - pb;
            });

            this.automatchPage = 1;
            this.renderAutoMatcherPage();
            
            const selectAllMatcher = document.getElementById('automatcher-select-all');
            if (selectAllMatcher) selectAllMatcher.checked = false;

        } catch (err) {
            Toast.show('Matcher Error: ' + err.message, 'error');
        } finally {
            btn.innerHTML = `<i data-lucide="zap"></i> Run Auto-Match`;
            btn.disabled = false;
            if (window.lucide) lucide.createIcons();
        }
    }

    getFilteredAutoMatchProposals() {
        const proposals = this.automatchProposals || [];
        const tierFilter = this.automatchTierFilter || 'all';
        const showUnmatchedToggle = document.getElementById('automatch-toggle-unmatched')?.checked || false;
        const showUnmatched = showUnmatchedToggle || tierFilter === 'unmatched';
        const search = (document.getElementById('automatcher-search')?.value || '').trim().toLowerCase();
        const activeFilters = this.headerFilters?.automatch || {};

        return proposals.filter(proposal => {
            if (!showUnmatched && !proposal.proposedStudent) return false;

            if (tierFilter === 'high' && proposal.confidenceTier !== 'high') return false;
            if (tierFilter === 'phone' && proposal.confidenceTier !== 'phone') return false;
            if (tierFilter === 'name' && proposal.confidenceTier !== 'name') return false;
            if (tierFilter === 'unmatched' && proposal.proposedStudent) return false;

            // Header filters
            for (const [col, values] of Object.entries(activeFilters)) {
                if (!values || values.length === 0) continue;
                if (col === 'proposed_fix') {
                    const pfStatus = proposal.proposedStudent ? 'Has Proposed Match' : 'No Match Found';
                    if (!values.includes(pfStatus)) return false;
                } else if (col === 'id_status') {
                    const st = String(proposal.original_status || '');
                    const matchCat = (values.includes('Valid') && st === 'Valid') ||
                        (values.includes('Missing ID') && st.includes('Missing ID')) ||
                        (values.includes('Error') && st.includes('Error'));
                    if (!matchCat) return false;
                } else if (col === 'mapping') {
                    if (!values.includes(String(proposal.original_mapping ?? ''))) return false;
                } else if (col === 'second_mapping') {
                    if (!values.includes(String(proposal.original_second_mapping ?? ''))) return false;
                } else if (col === 'item_name') {
                    if (!values.includes(String(proposal.original_item ?? ''))) return false;
                }
            }

            // Unified client-side search across Ref, Current ID, Status, Item, Mapping, Proposed Student ID/Name, and Match Reason
            if (search) {
                const haystacks = [
                    proposal.original_ref,
                    proposal.original_student_id,
                    proposal.original_status,
                    proposal.original_item,
                    proposal.original_mapping,
                    proposal.original_second_mapping,
                    proposal.proposedStudent?.student_id,
                    proposal.proposedStudent?.full_name,
                    proposal.matchReason
                ];
                const matchedSearch = haystacks.some(val => val && String(val).toLowerCase().includes(search));
                if (!matchedSearch) return false;
            }

            return true;
        });
    }

    updateAutoMatchSelectionUI() {
        const proposals = this.automatchProposals || [];
        const matchedTotal = proposals.filter(p => p.proposedStudent).length;
        const selectedCount = proposals.filter(p => p.proposedStudent && p.selected).length;
        const highUnlockedCount = proposals.filter(p => p.proposedStudent && p.confidenceTier === 'high' && !p.locked).length;

        const btnApply = document.getElementById('btn-apply-automatch-fixes');
        const btnApplyLabel = document.getElementById('btn-apply-automatch-label');
        if (btnApply) {
            btnApply.style.display = matchedTotal > 0 ? 'inline-flex' : 'none';
        }
        if (btnApplyLabel) {
            btnApplyLabel.innerText = `Apply Selected Fixes (${selectedCount})`;
        }

        const btnSelectHigh = document.getElementById('btn-select-high-confidence');
        if (btnSelectHigh) {
            btnSelectHigh.style.display = highUnlockedCount > 0 ? 'inline-flex' : 'none';
        }

        const selectAllMatcher = document.getElementById('automatcher-select-all');
        if (selectAllMatcher) {
            const visibleSelectable = this.getFilteredAutoMatchProposals().filter(p => p.proposedStudent && !p.locked);
            selectAllMatcher.checked = visibleSelectable.length > 0 && visibleSelectable.every(p => p.selected);
        }
    }

    renderAutoMatcherPage() {
        this.renderFilterChips('automatch');
        const tbody = document.getElementById('automatcher-table-body');
        if (!tbody) return;
        const formatMoney = (num) => parseFloat(num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        
        // Update summary card stats
        const proposals = this.automatchProposals || [];
        const totalCount = proposals.length;
        const matchedCount = proposals.filter(p => p.proposedStudent).length;
        const highCount = proposals.filter(p => p.confidenceTier === 'high').length;
        const phoneCount = proposals.filter(p => p.confidenceTier === 'phone').length;
        const nameCount = proposals.filter(p => p.confidenceTier === 'name').length;
        const unmatchedCount = totalCount - matchedCount;

        const summaryCard = document.getElementById('automatch-summary-card');
        if (summaryCard) {
            if (totalCount > 0) {
                summaryCard.style.display = 'block';
                const totalEl = document.getElementById('automatch-stat-total');
                const matchedEl = document.getElementById('automatch-stat-matched');
                const highEl = document.getElementById('automatch-stat-high');
                const phoneEl = document.getElementById('automatch-stat-phone');
                const nameEl = document.getElementById('automatch-stat-name');
                const unmatchedEl = document.getElementById('automatch-stat-unmatched');
                if (totalEl) totalEl.innerText = totalCount.toLocaleString();
                if (matchedEl) matchedEl.innerText = matchedCount.toLocaleString();
                if (highEl) highEl.innerText = highCount.toLocaleString();
                if (phoneEl) phoneEl.innerText = phoneCount.toLocaleString();
                if (nameEl) nameEl.innerText = nameCount.toLocaleString();
                if (unmatchedEl) unmatchedEl.innerText = unmatchedCount.toLocaleString();
            } else {
                summaryCard.style.display = 'none';
            }
        }

        this.updateAutoMatchSelectionUI();

        const showUnmatched = (document.getElementById('automatch-toggle-unmatched')?.checked || false) || this.automatchTierFilter === 'unmatched';
        const filteredProposals = this.getFilteredAutoMatchProposals();

        if (filteredProposals.length === 0) {
            if (totalCount > 0 && !showUnmatched) {
                tbody.innerHTML = `<tr><td colspan="10" class="text-center" style="padding: 2.5rem 1rem;">
                    <div style="color: var(--text-muted); font-size: 0.95rem; margin-bottom: 0.75rem;">
                        No proposed matches were found matching current filters among the ${totalCount.toLocaleString()} scanned transactions.
                    </div>
                    <button class="btn btn-outline btn-sm" id="btn-show-unmatched-empty">
                        <i data-lucide="eye" style="width: 14px; height: 14px; margin-right: 4px;"></i> Show all ${unmatchedCount.toLocaleString()} unmatched transactions
                    </button>
                </td></tr>`;
                document.getElementById('btn-show-unmatched-empty')?.addEventListener('click', () => {
                    const toggle = document.getElementById('automatch-toggle-unmatched');
                    if (toggle) toggle.checked = true;
                    this.automatchPage = 1;
                    this.renderAutoMatcherPage();
                });
            } else {
                tbody.innerHTML = '<tr><td colspan="10" class="text-center" style="padding: 2rem;">No fixable transactions found.</td></tr>';
            }
            const pager = document.getElementById('automatcher-pagination');
            if (pager) pager.remove();
            if (window.lucide) lucide.createIcons();
            return;
        }

        const pageSize = 100;
        const totalPages = Math.max(1, Math.ceil(filteredProposals.length / pageSize));
        if (!this.automatchPage || this.automatchPage > totalPages) this.automatchPage = 1;
        const startIdx = (this.automatchPage - 1) * pageSize;
        const pageProposals = filteredProposals.slice(startIdx, startIdx + pageSize);

        let html = '';
        for (const proposal of pageProposals) {
            const rawStatus = String(proposal.original_status || '');
            const isMissing = rawStatus.includes('Missing ID');
            const statusShort = isMissing ? 'Missing ID' : (rawStatus.includes('Error') ? rawStatus.replace(/^Error:\s*/i, '') : (rawStatus || 'Invalid'));
            const currentIdHtml = `
                <div style="font-family: monospace; font-weight: 600; font-size: 0.84rem; color: ${proposal.original_student_id ? 'var(--text-main)' : 'var(--text-muted)'};">
                    ${proposal.original_student_id ? escapeHTML(proposal.original_student_id) : '<span style="font-style: italic; font-weight: 400;">(Empty)</span>'}
                </div>
                <span class="status-badge ${isMissing ? 'missing-id' : 'invalid-id'}" style="font-size: 0.7rem; padding: 0.1rem 0.45rem; margin-top: 2px; display: inline-block;" title="${escapeHTML(rawStatus)}">
                    ${escapeHTML(statusShort)}
                </span>
            `;

            const canApplyFixes = this.hasRole('accountant');
            const quickFixBtnHtml = canApplyFixes ? `
                <button type="button" class="btn btn-outline btn-sm" data-automatch-manual-fix="${escapeHTML(proposal.original_ref)}" data-proposed-sid="${escapeHTML(proposal.proposedStudent?.student_id || '')}" title="Open in Manual Fixes to inspect or override" style="padding: 0.15rem 0.45rem; font-size: 0.72rem; height: auto; display: inline-flex; align-items: center; gap: 3px;">
                    <i data-lucide="wrench" style="width: 11px; height: 11px;"></i> Fix
                </button>
            ` : '';

            if (proposal.proposedStudent) {
                let badgeStyle = '';
                let tierTag = 'High';
                if (proposal.confidenceTier === 'phone') {
                    badgeStyle = 'style="background: rgba(59, 130, 246, 0.15); color: #60a5fa; border-color: rgba(59, 130, 246, 0.3);"';
                    tierTag = 'Phone';
                } else if (proposal.confidenceTier === 'name') {
                    badgeStyle = 'style="background: rgba(234, 179, 8, 0.15); color: #eab308; border-color: rgba(234, 179, 8, 0.3);"';
                    tierTag = 'Name';
                }

                html += `
                    <tr>
                        <td>${canApplyFixes ? `<input type="checkbox" class="automatch-checkbox" value="${escapeHTML(proposal.tx_id)}" ${proposal.selected ? 'checked' : ''}>` : ''}</td>
                        <td style="font-family: monospace; font-weight: 500;">${escapeHTML(proposal.original_ref)}</td>
                        <td>${escapeHTML(proposal.original_date)}</td>
                        <td>${currentIdHtml}</td>
                        <td>${escapeHTML(proposal.original_mapping || '-')}</td>
                        <td>${escapeHTML(proposal.original_second_mapping || '-')}</td>
                        <td>${escapeHTML(proposal.original_item)}</td>
                        <td>${formatMoney(proposal.original_amount)}</td>
                        <td>
                            <span class="status-badge valid-id" title="${escapeHTML(proposal.matchReason)}" ${badgeStyle}>
                                Matched: ${escapeHTML(proposal.proposedStudent.student_id)} (${tierTag})
                            </span>${this.renderStudentLevelBadge(getStudentProgramLevel(proposal.proposedStudent))}
                            <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 2px;">${escapeHTML(proposal.proposedStudent.full_name)}</div>
                        </td>
                        <td style="white-space: normal; word-wrap: break-word; max-width: 220px;">
                            <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 0.4rem;">
                                <span style="font-size:0.82rem; color:var(--text-muted);">${escapeHTML(proposal.matchReason)}</span>
                                ${quickFixBtnHtml}
                            </div>
                            ${proposal.locked ? '<div style="font-size:0.78rem; color: var(--warning); margin-top: 3px;"><i data-lucide="lock" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:2px;"></i>Locked: settled / in ERP</div>' : ''}
                        </td>
                    </tr>
                `;
            } else {
                html += `
                    <tr>
                        <td></td>
                        <td style="font-family: monospace; font-weight: 500;">${escapeHTML(proposal.original_ref)}</td>
                        <td>${escapeHTML(proposal.original_date)}</td>
                        <td>${currentIdHtml}</td>
                        <td>${escapeHTML(proposal.original_mapping || '-')}</td>
                        <td>${escapeHTML(proposal.original_second_mapping || '-')}</td>
                        <td>${escapeHTML(proposal.original_item)}</td>
                        <td>${formatMoney(proposal.original_amount)}</td>
                        <td><span class="status-badge invalid-id">No Match Found</span></td>
                        <td>
                            <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.4rem;">
                                <span style="color:var(--text-muted); font-size: 0.82rem;">No match in Student Master</span>
                                ${quickFixBtnHtml}
                            </div>
                        </td>
                    </tr>
                `;
            }
        }

        tbody.innerHTML = html || '<tr><td colspan="10" class="text-center">No fixable transactions found.</td></tr>';

        tbody.querySelectorAll('.automatch-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const p = (this.automatchProposals || []).find(item => String(item.tx_id) === cb.value);
                if (p) p.selected = e.target.checked;
                this.updateAutoMatchSelectionUI();
            });
        });

        tbody.querySelectorAll('[data-automatch-manual-fix]').forEach(btn => {
            btn.addEventListener('click', () => {
                const ref = btn.getAttribute('data-automatch-manual-fix');
                const proposedSid = btn.getAttribute('data-proposed-sid');
                this.resetFixModal('Add Fix');
                const refInput = document.getElementById('fix-ref');
                const sidInput = document.getElementById('fix-id');
                if (refInput && ref) {
                    refInput.value = ref;
                    refInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
                if (sidInput && proposedSid) {
                    sidInput.value = proposedSid;
                    sidInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
                document.getElementById('modal-fix')?.classList.remove('hidden');
            });
        });

        const container = tbody.closest('.table-container');
        if (container) {
            let pager = document.getElementById('automatcher-pagination');
            if (filteredProposals.length <= pageSize) {
                if (pager) pager.remove();
            } else {
                if (!pager) {
                    pager = document.createElement('div');
                    pager.id = 'automatcher-pagination';
                    pager.className = 'pagination';
                    container.appendChild(pager);
                }
                pager.innerHTML = `
                    <span class="text-muted">Showing ${startIdx + 1}-${Math.min(startIdx + pageSize, filteredProposals.length)} of ${filteredProposals.length} rows</span>
                    <div class="pagination-controls" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                        <button class="btn btn-icon" id="btn-automatch-prev" ${this.automatchPage <= 1 ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button>
                        <span>Page ${this.automatchPage} of ${totalPages}</span>
                        <button class="btn btn-icon" id="btn-automatch-next" ${this.automatchPage >= totalPages ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button>
                        ${this.pageJump.renderHtml('automatch', totalPages)}
                    </div>
                `;
                pager.querySelector('#btn-automatch-prev')?.addEventListener('click', () => {
                    if (this.automatchPage > 1) {
                        this.automatchPage--;
                        this.renderAutoMatcherPage();
                    }
                });
                pager.querySelector('#btn-automatch-next')?.addEventListener('click', () => {
                    if (this.automatchPage < totalPages) {
                        this.automatchPage++;
                        this.renderAutoMatcherPage();
                    }
                });
                this.pageJump.bind('automatch', totalPages, (target) => {
                    this.automatchPage = target;
                    this.renderAutoMatcherPage();
                }, pager);
            }
        }
        renderIcons(document.getElementById('view-automatcher'));
    }

    async applyAutoMatches() {
        const checkedDomValues = new Set(Array.from(document.querySelectorAll('.automatch-checkbox:checked')).map(cb => cb.value));
        const selectedProposals = (this.automatchProposals || []).filter(p =>
            p.proposedStudent && (p.selected || checkedDomValues.has(String(p.tx_id)))
        );

        if (selectedProposals.length === 0) {
            Toast.show('Please select at least one proposed match to apply.', 'warning');
            return;
        }

        const btn = document.getElementById('btn-confirm-automatch');
        if (btn) {
            btn.innerText = 'Applying...';
            btn.disabled = true;
        }
        const originalBtn = document.getElementById('btn-apply-automatch-fixes');
        if (originalBtn) {
            originalBtn.disabled = true;
        }

        try {
            const appliedRefs = [];
            const appliedRefsSet = new Set();
            const manualFixesToInsert = [];
            const updateGroups = {};

            // Pre-index unlocked sibling rows by reference_number for O(1) lookup
            const siblingsByRef = new Map();
            for (const sib of (this.automatchProposals || [])) {
                if (sib.original_ref && !sib.locked) {
                    let list = siblingsByRef.get(sib.original_ref);
                    if (!list) {
                        list = [];
                        siblingsByRef.set(sib.original_ref, list);
                    }
                    list.push(sib.tx_id);
                }
            }

            for (const proposal of selectedProposals) {
                const tx_id = proposal.tx_id;
                const sid = normalizeStudentIdValue(proposal.proposedStudent.student_id) || proposal.proposedStudent.student_id;
                if (!updateGroups[sid]) updateGroups[sid] = new Set();
                updateGroups[sid].add(tx_id);

                // Also include any unlocked sibling rows in automatchProposals that share the same reference_number
                const sibIds = proposal.original_ref ? siblingsByRef.get(proposal.original_ref) : null;
                if (sibIds) {
                    for (let i = 0; i < sibIds.length; i++) updateGroups[sid].add(sibIds[i]);
                }
                
                manualFixesToInsert.push({
                    reference_number: proposal.original_ref,
                    correct_id: sid
                });

                if (proposal.original_ref && !appliedRefsSet.has(proposal.original_ref)) {
                    appliedRefsSet.add(proposal.original_ref);
                    appliedRefs.push(proposal.original_ref);
                }
            }

            // Execute batched updates concurrently across student groups
            const txUpdateTasks = [];
            for (const [sid, txIdSet] of Object.entries(updateGroups)) {
                const txIds = Array.from(txIdSet);
                const statusVal = validateID(sid);
                for (let i = 0; i < txIds.length; i += 350) {
                    const chunk = txIds.slice(i, i + 350);
                    txUpdateTasks.push(async () => {
                        const { error } = await supabase
                            .from('transactions')
                            .update({
                                student_id: sid,
                                id_status: statusVal
                            })
                            .in('id', chunk);
                        if (error) throw error;
                    });
                }
            }
            await runConcurrent(txUpdateTasks, 10);

            // Insert into manual_fixes (preserve existing item_name, mapping, second_mapping if any)
            if (manualFixesToInsert.length > 0) {
                // De-duplicate by reference (a reference can have several items) – an upsert cannot touch the same row twice
                const uniqueFixesMap = new Map(manualFixesToInsert.map(f => [String(f.reference_number), f]));
                const existingFixes = await fetchByIn('manual_fixes', '*', 'reference_number', Array.from(uniqueFixesMap.keys()), 'reference_number');
                const existingFixMap = new Map((existingFixes || []).map(ef => [String(ef.reference_number), ef]));

                const uniqueFixes = Array.from(uniqueFixesMap.values()).map(f => {
                    const ex = existingFixMap.get(String(f.reference_number));
                    return ex ? {
                        reference_number: f.reference_number,
                        correct_id: f.correct_id,
                        item_name: ex.item_name ?? null,
                        mapping: ex.mapping ?? null,
                        second_mapping: ex.second_mapping ?? null
                    } : f;
                });

                const fixTasks = [];
                for (let i = 0; i < uniqueFixes.length; i += 500) {
                    const chunk = uniqueFixes.slice(i, i + 500);
                    fixTasks.push(async () => {
                        const { error } = await supabase.from('manual_fixes').upsert(chunk, { onConflict: 'reference_number', ignoreDuplicates: false });
                        if (error) throw new Error('IDs were updated, but saving them as manual fixes failed: ' + error.message);
                    });
                }
                await runConcurrent(fixTasks, 4);
            }

            // Audit Log
            const lockedCount = selectedProposals.filter(p => p.locked).length;
            if (appliedRefs.length > 0) {
                await this.logAudit('Applied Auto-Matches', appliedRefs.join(', '), {
                    count: appliedRefs.length,
                    locked_included: lockedCount
                });
            }

            this.invalidateDistinctCache();
            Toast.show(`Successfully applied ${appliedRefs.length} fixes!`, 'success');
            
            // Clear targeted state
            this.targetedMatchRefs = [];
            if (document.getElementById('automatcher-import-status')) {
                document.getElementById('automatcher-import-status').innerText = '';
            }

            this.runAutoMatcher();
            if (document.getElementById('view-dashboard')?.classList.contains('active')) {
                this.loadDashboard();
            }
            if (document.getElementById('view-transactions')?.classList.contains('active')) {
                this.loadTransactions();
            }
            this.updateSidebarBadges();
        } catch (err) {
            Toast.show('Error applying fixes: ' + err.message, 'error');
        } finally {
            if (btn) {
                btn.innerText = 'Yes, Apply';
                btn.disabled = false;
            }
            if (originalBtn) {
                originalBtn.disabled = false;
            }
            document.getElementById('modal-automatch-confirm')?.classList.add('hidden');
        }
    }
}

export function applyAutoMatcherMixin(AppClass) {
    for (const name of Object.getOwnPropertyNames(AutoMatcherMixin.prototype)) {
        if (name !== 'constructor') {
            Object.defineProperty(AppClass.prototype, name, Object.getOwnPropertyDescriptor(AutoMatcherMixin.prototype, name));
        }
    }
}
