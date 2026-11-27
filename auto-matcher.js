import { supabase } from './supabase.js';
import {
    isNonInvalidTransaction,
    fetchAll,
    fetchByIn,
    isLockedTransaction,
    isDateInClosedPeriods,
    recomputeTransactions,
    updateRuleFields,
    escapeHTML,
    toDateOnly,
    normalizeStudentIdValue,
    getStudentProgramLevel,
    normalizePhoneKey,
    buildStudentLookupIndex,
    matchTransactionToStudent
} from './rules.js';
import { ensureXlsx, renderIcons, Toast } from './app-utils.js';

class AutoMatcherMixin {
    async handleTargetedMatcherImport(file) {
        const status = document.getElementById('automatcher-import-status');
        status.innerText = 'Parsing file...';
        try {
            await ensureXlsx();
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

    runAutoMatcherInWorker({ transactions, students, linksMap, fixesList, enableNameMatch, sharedMobileList, onProgress }) {
        return new Promise((resolve, reject) => {
            if (typeof Worker === 'undefined') {
                reject(new Error('Web Worker not supported'));
                return;
            }
            if (!this._automatcherWorker) {
                this._automatcherWorker = new Worker(new URL('./automatcher.worker.js', import.meta.url), { type: 'module' });
                this._workerStudentsRef = null;
                this._workerStudentsLen = -1;
            }
            const worker = this._automatcherWorker;
            const shouldSendStudents = this._workerStudentsRef !== students || this._workerStudentsLen !== (students?.length || 0);

            const cleanup = () => {
                worker.removeEventListener('message', onMessage);
                worker.removeEventListener('error', onError);
            };
            const onMessage = (event) => {
                const msg = event.data || {};
                if (msg.type === 'PROGRESS') {
                    if (typeof onProgress === 'function') onProgress(msg.current, msg.total);
                } else if (msg.type === 'DONE') {
                    cleanup();
                    this._workerStudentsRef = students;
                    this._workerStudentsLen = students?.length || 0;
                    resolve(msg.proposals || []);
                } else if (msg.type === 'ERROR') {
                    cleanup();
                    reject(new Error(msg.message || 'Auto-Matcher worker failed'));
                }
            };
            const onError = (err) => {
                cleanup();
                try { worker.terminate(); } catch (_e) { /* ignore */ }
                this._automatcherWorker = null;
                this._workerStudentsRef = null;
                this._workerStudentsLen = -1;
                reject(new Error(err?.message || 'Auto-Matcher worker crashed'));
            };

            worker.addEventListener('message', onMessage);
            worker.addEventListener('error', onError);
            worker.postMessage({
                type: 'RUN_AUTOMATCH',
                payload: {
                    transactions,
                    students: shouldSendStudents ? students : null,
                    linksMap,
                    fixesList,
                    enableNameMatch: Boolean(enableNameMatch),
                    sharedMobileList
                }
            });
        });
    }

    async runAutoMatcher() {
        // Request token: a newer run (date change, Run click) supersedes any run still in flight,
        // so an older, slower run can never render its stale proposals over the newer ones.
        const runToken = (this._automatchRunToken = (this._automatchRunToken || 0) + 1);
        const isStale = () => runToken !== this._automatchRunToken;
        this._automatchRunInFlight = true;
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
            if (isStale()) return;
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
            if (isStale()) return;

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

            // Build into a local array; only publish to this.automatchProposals if still current.
            let proposals = [];

            let workerUsed = false;
            if (typeof Worker !== 'undefined' && filteredTx.length >= 250) {
                try {
                    const workerProposals = await this.runAutoMatcherInWorker({
                        transactions: filteredTx,
                        students,
                        linksMap,
                        fixesList: this.allFixesData || [],
                        enableNameMatch: Boolean(enableNameMatch),
                        sharedMobileList: [...sharedMobileSet],
                        onProgress: (current, total) => {
                            btn.innerHTML = `<i data-lucide="loader" class="spin"></i> Matching... ${current}/${total}`;
                        }
                    });
                    if (Array.isArray(workerProposals)) {
                        proposals = workerProposals;
                        workerUsed = true;
                    }
                } catch (workerErr) {
                    console.warn('Auto-Matcher worker fallback to main thread:', workerErr?.message || workerErr);
                }
            }

            if (!workerUsed) {
                if (
                    !this._studentLookupIndexCache ||
                    this._studentLookupIndexSource !== students ||
                    this._studentLookupIndexLen !== students.length
                ) {
                    this._studentLookupIndexCache = buildStudentLookupIndex(students);
                    this._studentLookupIndexSource = students;
                    this._studentLookupIndexLen = students.length;
                }
                const studentLookupIndex = this._studentLookupIndexCache;

                let loopCount = 0;
                let lastYield = typeof performance !== 'undefined' ? performance.now() : Date.now();
                for (const tx of filteredTx) {
                    loopCount++;
                    if ((loopCount & 63) === 0) {
                        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
                        if (now - lastYield > 50) {
                            btn.innerHTML = `<i data-lucide="loader" class="spin"></i> Matching... ${loopCount}/${filteredTx.length}`;
                            await new Promise(r => setTimeout(r, 0));
                            if (isStale()) return;
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

                    proposals.push(proposalTx);
                }
            }

            // Second-pass sibling propagation: if one line item of a multi-item reference matched,
            // propagate that match to any unmatched sibling line item sharing the same reference_number
            const matchedByRef = new Map();
            if (isStale()) return;
            for (const p of proposals) {
                if (p.proposedStudent && p.original_ref && !matchedByRef.has(p.original_ref)) {
                    matchedByRef.set(p.original_ref, p);
                }
            }
            for (const p of proposals) {
                if (!p.proposedStudent && p.original_ref && matchedByRef.has(p.original_ref)) {
                    const sib = matchedByRef.get(p.original_ref);
                    p.proposedStudent = sib.proposedStudent;
                    p.confidenceTier = sib.confidenceTier;
                    p.matchReason = `${sib.matchReason} (Same Order Reference)`;
                }
            }

            // Sort proposals by confidence tier priority: high -> phone -> name -> unmatched
            const tierPriority = { high: 1, phone: 2, name: 3, unmatched: 4 };
            proposals.sort((a, b) => {
                const pa = tierPriority[a.confidenceTier] || 4;
                const pb = tierPriority[b.confidenceTier] || 4;
                return pa - pb;
            });

            this.automatchProposals = proposals;
            this.automatchPage = 1;
            this.renderAutoMatcherPage();
            
            const selectAllMatcher = document.getElementById('automatcher-select-all');
            if (selectAllMatcher) selectAllMatcher.checked = false;

        } catch (err) {
            if (!isStale()) Toast.show('Matcher Error: ' + err.message, 'error');
        } finally {
            // Only the current run owns the button state; a superseded run leaves it alone.
            if (!isStale()) {
                this._automatchRunInFlight = false;
                btn.innerHTML = `<i data-lucide="zap"></i> Run Auto-Match`;
                btn.disabled = false;
                if (window.lucide) lucide.createIcons();
            }
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
            const plan = planAutoMatchApply(this.automatchProposals || [], selectedProposals);
            const proposalByTxId = new Map((this.automatchProposals || []).map(p => [String(p.tx_id), p]));
            const targetIds = [...plan.sidByTxId.keys()].map(k => proposalByTxId.get(k)?.tx_id ?? k);

            // Re-read the rows now: anything fixed by someone else since Run is left alone,
            // and rows in closed accounting periods are skipped instead of failing the whole save.
            const currentRows = targetIds.length > 0 ? await fetchByIn('transactions', '*', 'id', targetIds, 'id') : [];
            const closedSkipped = [];
            const changedSkipped = [];
            const rowsToApply = [];
            for (const row of currentRows) {
                const prop = proposalByTxId.get(String(row.id));
                if (isDateInClosedPeriods(row.payment_date, this.closedPeriodSet)) { closedSkipped.push(row); continue; }
                const nowSid = String(row.student_id ?? '').trim();
                const thenSid = String(prop?.original_student_id ?? '').trim();
                if (row.id_status === 'Valid' || row.id_status === 'Exempt' || nowSid !== thenSid) { changedSkipped.push(row); continue; }
                rowsToApply.push(row);
            }

            // one manual fix per reference; a reference is applied only if all of its rows are still applicable
            const blockedRefs = new Set([...closedSkipped, ...changedSkipped].map(r => String(r.reference_number || '').trim()));
            const finalRows = rowsToApply.filter(r => !blockedRefs.has(String(r.reference_number || '').trim()));
            const sidByRef = new Map();
            for (const r of finalRows) sidByRef.set(String(r.reference_number || '').trim(), plan.sidByTxId.get(String(r.id)));
            const appliedRefs = [...sidByRef.keys()].filter(Boolean);

            let updatedCount = 0;
            if (appliedRefs.length > 0) {
                const existingFixes = await fetchByIn('manual_fixes', '*', 'reference_number', appliedRefs, 'reference_number');
                const existingFixMap = new Map((existingFixes || []).map(ef => [String(ef.reference_number).trim(), ef]));
                const fixes = appliedRefs.map(ref => {
                    const ex = existingFixMap.get(ref);
                    return {
                        reference_number: ref,
                        correct_id: sidByRef.get(ref),
                        item_name: ex?.item_name ?? null,
                        mapping: ex?.mapping ?? null,
                        second_mapping: ex?.second_mapping ?? null
                    };
                });
                for (let i = 0; i < fixes.length; i += 500) {
                    const { error } = await supabase.from('manual_fixes').upsert(fixes.slice(i, i + 500), { onConflict: 'reference_number', ignoreDuplicates: false });
                    if (error) throw error;
                }
                // Same path as Bulk Assign: the fix drives student_id, id_status, level-based mapping, etc.
                const changes = await recomputeTransactions(finalRows, {
                    includeLocked: true,
                    fixes: new Map(fixes.map(f => [f.reference_number, f])),
                    mappings: this.allMappingsData || undefined
                });
                updatedCount = changes.length > 0 ? await updateRuleFields(changes) : 0;

                const insertedKeys = appliedRefs.filter(ref => !existingFixMap.has(ref));
                await this.logAudit('Applied Auto-Matches', appliedRefs.slice(0, 50).join(', ') + (appliedRefs.length > 50 ? ` (+${appliedRefs.length - 50} more)` : ''), {
                    count: appliedRefs.length,
                    transactions_updated: updatedCount,
                    locked_included: finalRows.filter(r => isLockedTransaction(r)).length,
                    skipped_closed_period: closedSkipped.length,
                    skipped_changed_since_run: changedSkipped.length,
                    skipped_conflicting_refs: plan.conflictingRefs.length,
                    revert_data: { table_name: 'manual_fixes', operation: 'update', previous_rows: existingFixes || [], inserted_keys: insertedKeys }
                });
            }

            const skippedNotes = [];
            if (closedSkipped.length) skippedNotes.push(`${closedSkipped.length} in closed periods`);
            if (changedSkipped.length) skippedNotes.push(`${changedSkipped.length} changed since the match was run`);
            if (plan.conflictingRefs.length) skippedNotes.push(`${plan.conflictingRefs.length} reference(s) matched to different students`);
            if (skippedNotes.length) {
                Toast.show(`Skipped: ${skippedNotes.join(', ')}.`, 'warning');
            }

            this.invalidateDistinctCache();
            Toast.show(`Applied ${appliedRefs.length} match(es) to ${updatedCount} transaction(s).`, appliedRefs.length ? 'success' : 'info');
            
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

/**
 * Decides which transactions an Auto-Match apply touches and with which Student ID.
 * Selected proposals pull in their unlocked sibling lines (same reference). A reference that
 * ends up with two different students is left out rather than written in an arbitrary order.
 */
export function planAutoMatchApply(allProposals, selectedProposals) {
    const sidOf = (p) => normalizeStudentIdValue(p.proposedStudent?.student_id) || String(p.proposedStudent?.student_id || '');
    const siblingsByRef = new Map();
    for (const p of allProposals || []) {
        if (!p.original_ref || p.locked) continue;
        if (!siblingsByRef.has(p.original_ref)) siblingsByRef.set(p.original_ref, []);
        siblingsByRef.get(p.original_ref).push(String(p.tx_id));
    }
    const sidsByRef = new Map();
    const idsByRef = new Map();
    for (const p of selectedProposals || []) {
        if (!p.proposedStudent) continue;
        const ref = String(p.original_ref || '');
        const sid = sidOf(p);
        if (!sidsByRef.has(ref)) { sidsByRef.set(ref, new Set()); idsByRef.set(ref, new Set()); }
        sidsByRef.get(ref).add(sid);
        idsByRef.get(ref).add(String(p.tx_id));
        for (const id of (ref ? siblingsByRef.get(ref) || [] : [])) idsByRef.get(ref).add(id);
    }
    const sidByTxId = new Map();
    const conflictingRefs = [];
    for (const [ref, sids] of sidsByRef) {
        if (sids.size > 1) { conflictingRefs.push(ref); continue; }
        const sid = [...sids][0];
        for (const id of idsByRef.get(ref)) sidByTxId.set(id, sid);
    }
    return { sidByTxId, conflictingRefs };
}

export function applyAutoMatcherMixin(AppClass) {
    for (const name of Object.getOwnPropertyNames(AutoMatcherMixin.prototype)) {
        if (name !== 'constructor') {
            Object.defineProperty(AppClass.prototype, name, Object.getOwnPropertyDescriptor(AutoMatcherMixin.prototype, name));
        }
    }
}
