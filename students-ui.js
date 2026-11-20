import { supabase } from './supabase.js';
import {
    validateID,
    fetchAll,
    fetchByIn,
    escapeHTML,
    sanitizeExcelRows,
    toDateOnly,
    isSameDaySettlementBank,
    normalizeStudentIdValue,
    getStudentProgramLevel,
    formatStudentLevelTag,
    ensureProgramHasLevelPrefix,
    classifyStudentEmails,
    mergeStudentEmails,
    getStudentDisplayEmails,
    writeCompressedExcel
} from './rules.js';
import { convertUsdToEgp } from './fx-rates.js';
import {
    runConcurrent,
    renderIcons,
    formatMoney,
    readIndexedDbCache,
    writeIndexedDbCache,
    clearIndexedDbCache,
    Toast
} from './app-utils.js';

class StudentsUiMixin {
    rebuildStudentMasterMap(students = []) {
        const map = this.studentMasterByIdMap instanceof Map ? new Map() : new Map();
        for (const s of (students || [])) {
            if (!s || !s.student_id) continue;
            const rawSid = String(s.student_id).trim();
            if (!rawSid) continue;
            if (!s._level) s._level = getStudentProgramLevel(s);
            if (!s._levelTag) s._levelTag = formatStudentLevelTag(s._level);
            map.set(rawSid, s);
            map.set(rawSid.toUpperCase(), s);
            const normSid = s._normSid || (this.normalizeStudentId ? this.normalizeStudentId(rawSid) : normalizeStudentIdValue(rawSid));
            if (normSid) {
                const normStr = String(normSid);
                map.set(normStr, s);
                map.set(normStr.toUpperCase(), s);
                if (/^\d+$/.test(normStr) && normStr.length < 9) {
                    map.set(normStr.padStart(9, '0'), s);
                }
            }
        }
        this.studentMasterByIdMap = map;
        this._sidLevelCache = new Map();
        this._studentLookupIndexCache = null;
        this._lastMappedStudentsRef = students;
        this._lastMappedStudentsLen = Array.isArray(students) ? students.length : 0;
        return map;
    }

    syncStudentMasterMapFromCache() {
        const activeArr = (Array.isArray(this.allStudentsData) && this.allStudentsData.length > 0)
            ? this.allStudentsData
            : (Array.isArray(this.allStudents) && this.allStudents.length > 0 ? this.allStudents : null);
        if (activeArr && (this._lastMappedStudentsRef !== activeArr || this._lastMappedStudentsLen !== activeArr.length || !this.studentMasterByIdMap)) {
            this.rebuildStudentMasterMap(activeArr);
        }
        if (!this.studentMasterByIdMap) {
            this.studentMasterByIdMap = new Map();
        }
        return this.studentMasterByIdMap;
    }

    async fetchStudentMasterVersion() {
        try {
            if (typeof supabase.rpc !== 'function') return null;
            const { data, error } = await supabase.rpc('get_student_master_version');
            if (error || !data || typeof data !== 'object' || typeof data.row_count !== 'number') {
                return null;
            }
            return {
                row_count: data.row_count,
                max_student_id: String(data.max_student_id || ''),
                max_updated_at: data.max_updated_at ? String(data.max_updated_at) : ''
            };
        } catch (_e) {
            return null;
        }
    }

    isStudentMasterCacheValid(cached, liveVer) {
        if (!cached || !Array.isArray(cached.rows) || cached.rows.length === 0) return false;
        if (liveVer && typeof liveVer.row_count === 'number') {
            const cVer = cached.version;
            if (!cVer || typeof cVer.row_count !== 'number') return false;
            return cVer.row_count === liveVer.row_count
                && String(cVer.max_student_id || '') === String(liveVer.max_student_id || '')
                && String(cVer.max_updated_at || '') === String(liveVer.max_updated_at || '');
        }
        return typeof cached.savedAt === 'number' && (Date.now() - cached.savedAt < 15 * 60 * 1000);
    }

    async invalidateStudentMasterLocalCache() {
        await clearIndexedDbCache('student_master_v1');
    }

    async ensureFullStudentMaster({ forceReload = false, onProgress = null } = {}) {
        if (!forceReload && Array.isArray(this.allStudentsData) && this.allStudentsData.length > 0) {
            this.syncStudentMasterMapFromCache();
            return this.allStudentsData;
        }
        if (typeof onProgress === 'function') {
            if (!this._studentMasterProgressListeners) this._studentMasterProgressListeners = new Set();
            this._studentMasterProgressListeners.add(onProgress);
            if (Array.isArray(this._partialStudentsPreview) && this._partialStudentsPreview.length > 0) {
                try { onProgress(this._partialStudentsLoadedCount || this._partialStudentsPreview.length, this._partialStudentsPreview); } catch (_e) {}
            }
        }
        if (!forceReload && this._fullStudentMasterPromise) {
            try {
                return await this._fullStudentMasterPromise;
            } finally {
                if (typeof onProgress === 'function') this._studentMasterProgressListeners?.delete(onProgress);
            }
        }
        this._fullStudentMasterPromise = (async () => {
            try {
                const [cached, liveVer] = await Promise.all([
                    !forceReload ? readIndexedDbCache('student_master_v1') : Promise.resolve(null),
                    this.fetchStudentMasterVersion()
                ]);

                if (!forceReload && this.isStudentMasterCacheValid(cached, liveVer)) {
                    this.allStudentsData = cached.rows.map(s => this.indexStudentRecord({ ...s }));
                    this.allStudents = this.allStudentsData;
                    this.rebuildStudentMasterMap(this.allStudentsData);
                    return this.allStudentsData;
                }

                const data = await fetchAll(
                    'student_master',
                    'student_id, full_name, arabic_name, national_id, email, personal_email, mobile, guardian_name, guardian_mobile, college, program, source',
                    null,
                    'student_id',
                    {
                        onProgress: (loaded, partialRows) => {
                            if (Array.isArray(partialRows) && partialRows.length > 0 && !this._partialStudentsPreview) {
                                this._partialStudentsPreview = partialRows.slice(0, 200).map(s => this.indexStudentRecord(s));
                            }
                            this._partialStudentsLoadedCount = loaded;
                            if (this._studentMasterProgressListeners) {
                                for (const fn of this._studentMasterProgressListeners) {
                                    try { fn(loaded, this._partialStudentsPreview || partialRows); } catch (_e) {}
                                }
                            }
                        }
                    }
                );
                if (Array.isArray(data) && data.length > 0) {
                    const freshVer = liveVer || await this.fetchStudentMasterVersion();
                    writeIndexedDbCache('student_master_v1', {
                        version: freshVer,
                        savedAt: Date.now(),
                        rows: data
                    });
                    this.allStudentsData = data.map(s => this.indexStudentRecord({ ...s }));
                    this.allStudents = this.allStudentsData;
                    this.rebuildStudentMasterMap(this.allStudentsData);
                } else if (!this.allStudentsData) {
                    this.allStudentsData = [];
                }
                return this.allStudentsData || [];
            } finally {
                this._partialStudentsPreview = null;
                this._partialStudentsLoadedCount = 0;
                if (this._studentMasterProgressListeners) this._studentMasterProgressListeners.clear();
                this._fullStudentMasterPromise = null;
            }
        })();
        return this._fullStudentMasterPromise;
    }

    async ensureStudentLevelMap() {
        this.syncStudentMasterMapFromCache();
        if (this.studentMasterByIdMap && this.studentMasterByIdMap.size > 0 && Array.isArray(this.allStudents) && this.allStudents.length > 0) {
            return this.studentMasterByIdMap;
        }
        if (this._fullStudentMasterPromise) {
            try { await this._fullStudentMasterPromise; } catch (_e) {}
            return this.studentMasterByIdMap;
        }
        if (this._studentLevelMapPromise) {
            return this._studentLevelMapPromise;
        }
        this._studentLevelMapPromise = (async () => {
            try {
                const [cached, liveVer] = await Promise.all([
                    readIndexedDbCache('student_master_v1'),
                    this.fetchStudentMasterVersion()
                ]);
                if (this.isStudentMasterCacheValid(cached, liveVer)) {
                    if (!this.allStudents || this.allStudents.length === 0) {
                        this.allStudents = cached.rows;
                    }
                    this.rebuildStudentMasterMap(cached.rows);
                    return this.studentMasterByIdMap;
                }

                const rows = await fetchAll('student_master', 'student_id, full_name, arabic_name, guardian_name, college, program, mobile', null, 'student_id');
                if (Array.isArray(rows) && rows.length > 0) {
                    if (!this.allStudents || this.allStudents.length === 0) {
                        this.allStudents = rows;
                    }
                    this.rebuildStudentMasterMap(rows);
                }
            } catch (_e) {
                // Ignore when offline or unseeded
            } finally {
                this._studentLevelMapPromise = null;
            }
            return this.studentMasterByIdMap;
        })();
        return this._studentLevelMapPromise;
    }

    async ensureStudentLevelsForRows(rows = []) {
        this.syncStudentMasterMapFromCache();
        if (this.studentMasterByIdMap && this.studentMasterByIdMap.size > 0 && Array.isArray(this.allStudents) && this.allStudents.length > 0) {
            return this.studentMasterByIdMap;
        }
        const candidates = new Set();
        for (const r of (rows || [])) {
            const stored = typeof r?.student_level === 'string' ? r.student_level.trim().toUpperCase() : '';
            if (stored === 'UG' || stored === 'PG') continue;
            const raw = r?.student_id ? String(r.student_id).trim() : '';
            if (!raw || raw === 'Empty' || raw === 'Missing' || raw === 'Missing ID' || /^dip\d+/i.test(raw)) continue;
            if (this.studentMasterByIdMap?.has(raw)) continue;
            candidates.add(raw);
            const norm = this.normalizeStudentId ? this.normalizeStudentId(raw) : normalizeStudentIdValue(raw);
            if (norm) candidates.add(norm);
        }
        if (candidates.size > 0) {
            try {
                const candidateList = [...candidates];
                const data = candidateList.length <= 200
                    ? ((await supabase
                        .from('student_master')
                        .select('student_id, full_name, college, program')
                        .in('student_id', candidateList)).data || [])
                    : await fetchByIn('student_master', 'student_id, full_name, college, program', 'student_id', candidateList, 'student_id', 200, 4);
                if (Array.isArray(data) && data.length > 0) {
                    if (!this.studentMasterByIdMap) this.studentMasterByIdMap = new Map();
                    for (const s of data) {
                        if (!s || !s.student_id) continue;
                        s._level = getStudentProgramLevel(s);
                        s._levelTag = formatStudentLevelTag(s._level);
                        const rawSid = String(s.student_id).trim();
                        this.studentMasterByIdMap.set(rawSid, s);
                        this.studentMasterByIdMap.set(rawSid.toUpperCase(), s);
                        const normSid = this.normalizeStudentId ? this.normalizeStudentId(rawSid) : normalizeStudentIdValue(rawSid);
                        if (normSid) {
                            this.studentMasterByIdMap.set(normSid, s);
                            if (/^\d+$/.test(normSid) && normSid.length < 9) {
                                this.studentMasterByIdMap.set(normSid.padStart(9, '0'), s);
                            }
                        }
                    }
                    this._sidLevelCache = new Map();
                }
            } catch (_e) {
                // Ignore transient lookup failures; full directory loads lazily only when explicitly needed
            }
        }
        return this.studentMasterByIdMap;
    }

    lookupStudentBySid(sid) {
        if (sid === null || sid === undefined) return null;
        const raw = String(sid).trim();
        if (!raw || raw === 'Empty' || raw === 'Missing' || raw === 'Missing ID') return null;
        const map = this.syncStudentMasterMapFromCache();
        if (map.size === 0) return null;
        const direct = map.get(raw) || map.get(raw.toUpperCase());
        if (direct) return direct;
        const norm = this.normalizeStudentId ? this.normalizeStudentId(raw) : normalizeStudentIdValue(raw);
        if (norm) {
            const byNorm = map.get(norm) || map.get(norm.toUpperCase());
            if (byNorm) return byNorm;
            if (/^\d+$/.test(norm) && norm.length < 9) {
                const byPad = map.get(norm.padStart(9, '0'));
                if (byPad) return byPad;
            }
        }
        return null;
    }

    getStudentLevelBySid(sid) {
        if (sid === null || sid === undefined) return '';
        const raw = String(sid).trim();
        if (!raw || raw === 'Empty' || raw === 'Missing' || raw === 'Missing ID') return '';
        if (!this._sidLevelCache) this._sidLevelCache = new Map();
        const cached = this._sidLevelCache.get(raw);
        if (cached !== undefined) return cached;
        const student = this.lookupStudentBySid(raw);
        const level = student
            ? (student._level || (student._level = getStudentProgramLevel(student)))
            : (/^dip\d+/i.test(raw) ? 'PG' : '');
        if (this.studentMasterByIdMap && this.studentMasterByIdMap.size > 0 && this._sidLevelCache.size < 30000) {
            this._sidLevelCache.set(raw, level);
        }
        return level;
    }

    getStudentLevelLabelBySid(sid) {
        return formatStudentLevelTag(this.getStudentLevelBySid(sid));
    }

    getTransactionStudentLevel(tx) {
        if (!tx) return '';
        const stored = typeof tx.student_level === 'string' ? tx.student_level.trim().toUpperCase() : '';
        if (stored === 'UG' || stored === 'PG') return stored;
        if (tx.student_id) {
            const bySid = this.getStudentLevelBySid(tx.student_id);
            if (bySid) return bySid;
        }
        if (tx.program) {
            return getStudentProgramLevel(tx.program);
        }
        return '';
    }

    renderStudentLevelBadge(levelOrStudent) {
        const level = (levelOrStudent === 'UG' || levelOrStudent === 'PG')
            ? levelOrStudent
            : getStudentProgramLevel(levelOrStudent);
        if (!level) return '';
        if (level === 'UG') {
            return `<span class="badge badge-level-ug" style="font-size: 0.68rem; padding: 0.08rem 0.38rem; border-radius: 4px; font-weight: 700; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); margin-left: 0.35rem; vertical-align: middle;" title="Undergraduate Program">(UG)</span>`;
        }
        return `<span class="badge badge-level-pg" style="font-size: 0.68rem; padding: 0.08rem 0.38rem; border-radius: 4px; font-weight: 700; background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3); margin-left: 0.35rem; vertical-align: middle;" title="Postgraduate Program">(PG)</span>`;
    }

    initStudentMaster() {
        this.studentsCurrentPage = 1;
        this.studentsPageSize = 100;
        this.allStudentsData = null;
        this.filteredStudentsData = [];

        const btnToggleImport = document.getElementById('btn-toggle-student-import');
        const btnCloseImport = document.getElementById('btn-close-student-import');
        const importPanel = document.getElementById('student-import');
        if (btnToggleImport && importPanel) {
            btnToggleImport.addEventListener('click', () => {
                importPanel.classList.toggle('hidden');
            });
        }
        if (btnCloseImport && importPanel) {
            btnCloseImport.addEventListener('click', () => {
                importPanel.classList.add('hidden');
            });
        }

        const btnAddStudent = document.getElementById('btn-add-student');
        if (btnAddStudent) {
            btnAddStudent.addEventListener('click', () => this.openStudentModal());
        }

        const btnSaveStudent = document.getElementById('btn-save-student');
        if (btnSaveStudent) {
            btnSaveStudent.addEventListener('click', async () => {
                const rawSid = document.getElementById('stu-modal-id')?.value.trim();
                const fullName = document.getElementById('stu-modal-name')?.value.trim();
                if (!rawSid || !fullName) {
                    Toast.show('Student ID and Full Name are required.', 'warning');
                    return;
                }

                const normSid = this.normalizeStudentId(rawSid);
                const payload = {
                    student_id: normSid,
                    full_name: fullName,
                    arabic_name: document.getElementById('stu-modal-arabic-name')?.value.trim() || null,
                    national_id: document.getElementById('stu-modal-national-id')?.value.trim() || null,
                    email: document.getElementById('stu-modal-email')?.value.trim() || null,
                    personal_email: document.getElementById('stu-modal-personal-email')?.value.trim() || null,
                    mobile: document.getElementById('stu-modal-mobile')?.value.trim() || null,
                    guardian_name: document.getElementById('stu-modal-guardian-name')?.value.trim() || null,
                    guardian_mobile: document.getElementById('stu-modal-guardian-mobile')?.value.trim() || null,
                    college: document.getElementById('stu-modal-college')?.value.trim() || null,
                    program: ensureProgramHasLevelPrefix(document.getElementById('stu-modal-program')?.value.trim() || ''),
                    source: 'Manual'
                };

                try {
                    btnSaveStudent.disabled = true;
                    const existing = (this.allStudentsData || []).find(s => String(s.student_id) === String(normSid));
                    if (existing && existing.source && existing.source !== 'Manual' && !existing.source.includes('Manual')) {
                        payload.source = `${existing.source}, Manual`;
                    }

                    const { error } = await supabase.from('student_master').upsert([payload], { onConflict: 'student_id' });
                    if (error) throw error;

                    await this.invalidateStudentMasterLocalCache();
                    await this.logAudit(existing ? 'UPDATE' : 'CREATE', 'student_master', normSid, existing || null, payload);
                    Toast.show(existing ? `Updated student ${normSid}` : `Added student ${normSid}`, 'success');
                    document.getElementById('modal-student')?.classList.add('hidden');

                    await this.loadStudents({ forceReload: true, skipAutoProfile: true });
                    if (this.currentProfileSid && String(this.normalizeStudentId(this.currentProfileSid)) === String(normSid)) {
                        this.loadStudentProfile(normSid);
                    }
                } catch (err) {
                    Toast.show('Error saving student: ' + err.message, 'error');
                } finally {
                    btnSaveStudent.disabled = false;
                }
            });
        }

        document.getElementById('btn-export-students')?.addEventListener('click', async () => {
            try {
                Toast.show("Preparing export...", "info");
                const btn = document.getElementById('btn-export-students');
                const oldHtml = btn.innerHTML;
                btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Exporting...';
                btn.disabled = true;
                if (window.lucide) lucide.createIcons();

                const exportSource = (this.filteredStudentsData && this.filteredStudentsData.length > 0)
                    ? this.filteredStudentsData
                    : await this.ensureFullStudentMaster();

                const rows = (exportSource || []).map(s => {
                    const { nuEmail, personalEmail } = getStudentDisplayEmails(s);
                    return {
                        'Student ID': s.student_id || '',
                        'Level': s._levelTag || formatStudentLevelTag(getStudentProgramLevel(s)),
                        'Full Name': s.full_name || '',
                        'Arabic Name': s.arabic_name || '',
                        'Email': nuEmail || '',
                        'Personal Email': personalEmail || '',
                        'Mobile': s.mobile || '',
                        'National ID': s.national_id || '',
                        'College': s.college || '',
                        'Program': s.program || '',
                        'Guardian Name': s.guardian_name || '',
                        'Guardian Mobile': s.guardian_mobile || '',
                        'Source': s.source || ''
                    };
                });

                const ws = XLSX.utils.json_to_sheet(sanitizeExcelRows(rows));
                ws['!cols'] = [
                    { wch: 14 }, { wch: 10 }, { wch: 28 }, { wch: 26 }, { wch: 28 }, { wch: 28 },
                    { wch: 16 }, { wch: 18 }, { wch: 22 }, { wch: 24 },
                    { wch: 24 }, { wch: 16 }, { wch: 16 }
                ];
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, "Students");
                await writeCompressedExcel(wb, `Student_Master_Export_${toDateOnly(new Date())}.xlsx`);
                Toast.show(`Exported ${rows.length.toLocaleString()} students`, "success");

                btn.innerHTML = oldHtml;
                btn.disabled = false;
                if (window.lucide) lucide.createIcons();
            } catch (err) {
                Toast.show("Error exporting: " + err.message, "error");
                const btn = document.getElementById('btn-export-students');
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<i data-lucide="download"></i> Export Master List';
                    if (window.lucide) lucide.createIcons();
                }
            }
        });

        const tbodyGlobal = document.getElementById('students-table-body');
        if (tbodyGlobal) {
            tbodyGlobal.addEventListener('click', async (e) => {
                const copySidBtn = e.target.closest('.copyable-student-id');
                if (copySidBtn) {
                    e.stopPropagation();
                    const sidVal = copySidBtn.getAttribute('data-copy-sid');
                    if (sidVal) {
                        try {
                            await navigator.clipboard.writeText(sidVal);
                            Toast.show(`Student ID "${sidVal}" copied!`, 'success');
                        } catch (_err) {
                            Toast.show('Failed to copy Student ID.', 'error');
                        }
                    }
                    return;
                }

                const target = e.target.closest('.copyable-email');
                if (target) {
                    e.stopPropagation();
                    const email = target.getAttribute('data-email');
                    if (email) {
                        try {
                            await navigator.clipboard.writeText(email);
                            Toast.show('Email copied to clipboard!', 'success');
                        } catch (_err) {
                            Toast.show('Failed to copy email.', 'error');
                        }
                    }
                    return;
                }

                const row = e.target.closest('.student-row');
                if (row) {
                    const sid = row.getAttribute('data-sid');
                    if (sid) this.loadStudentProfile(sid);
                }
            });
        }

        const btnSearch = document.getElementById('btn-search-students');
        const searchInput = document.getElementById('student-search-input');
        const collegeSelect = document.getElementById('student-filter-college');
        const sourceSelect = document.getElementById('student-filter-source');
        const btnClear = document.getElementById('btn-clear-student-filters');

        let searchDebounce = null;
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                clearTimeout(searchDebounce);
                searchDebounce = setTimeout(() => {
                    this.studentsCurrentPage = 1;
                    this.loadStudents();
                }, 220);
            });
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    clearTimeout(searchDebounce);
                    this.studentsCurrentPage = 1;
                    this.loadStudents();
                }
            });
        }
        if (btnSearch) {
            btnSearch.addEventListener('click', () => {
                this.studentsCurrentPage = 1;
                this.loadStudents();
            });
        }
        if (collegeSelect) {
            collegeSelect.addEventListener('change', () => {
                this.studentsCurrentPage = 1;
                this.loadStudents({ skipAutoProfile: true });
            });
        }
        if (sourceSelect) {
            sourceSelect.addEventListener('change', () => {
                this.studentsCurrentPage = 1;
                this.loadStudents({ skipAutoProfile: true });
            });
        }
        if (btnClear) {
            btnClear.addEventListener('click', () => {
                if (searchInput) searchInput.value = '';
                if (collegeSelect) collegeSelect.value = '';
                if (sourceSelect) sourceSelect.value = '';
                document.getElementById('inline-student-profile')?.classList.add('hidden');
                document.getElementById('student-directory-view')?.classList.remove('hidden');
                this.currentProfileSid = null;
                this.studentsCurrentPage = 1;
                this.loadStudents({ skipAutoProfile: true });
            });
        }

        document.getElementById('btn-close-student-profile')?.addEventListener('click', () => {
            document.getElementById('inline-student-profile')?.classList.add('hidden');
            document.getElementById('student-directory-view')?.classList.remove('hidden');
            this.currentProfileSid = null;
        });

        document.getElementById('btn-edit-profile-student')?.addEventListener('click', () => {
            if (!this.currentProfileSid) return;
            const st = this.currentProfileStudent || (this.allStudentsData || []).find(s => String(s.student_id) === String(this.currentProfileSid));
            this.openStudentModal(st || { student_id: this.currentProfileSid });
        });

        document.getElementById('btn-export-student-statement')?.addEventListener('click', () => {
            this.exportStudentStatement();
        });

        const dropzone = document.getElementById('student-upload-zone');
        const fileInput = document.getElementById('student-file-input');
        if (dropzone && fileInput) {
            dropzone.addEventListener('click', () => fileInput.click());
            dropzone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropzone.style.borderColor = 'var(--primary-color)';
            });
            dropzone.addEventListener('dragleave', () => dropzone.style.borderColor = 'var(--border-color)');
            dropzone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropzone.style.borderColor = 'var(--border-color)';
                if (e.dataTransfer.files.length) {
                    this.handleStudentImport(Array.from(e.dataTransfer.files));
                }
            });
            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length) {
                    const files = Array.from(e.target.files);
                    e.target.value = ''; // allow re-selecting the same file(s)
                    this.handleStudentImport(files);
                }
            });
        }
        
        // Auto-Matcher Targeted Import Setup
        const amDropzone = document.getElementById('automatcher-import-zone');
        const amFileInput = document.getElementById('automatcher-file-input');
        if (amDropzone && amFileInput) {
            amDropzone.addEventListener('click', () => amFileInput.click());
            amDropzone.addEventListener('dragover', (e) => {
                e.preventDefault();
                amDropzone.style.borderColor = 'var(--primary-color)';
            });
            amDropzone.addEventListener('dragleave', () => amDropzone.style.borderColor = 'var(--border-color)');
            amDropzone.addEventListener('drop', (e) => {
                e.preventDefault();
                amDropzone.style.borderColor = 'var(--border-color)';
                if (e.dataTransfer.files.length) {
                    this.handleTargetedMatcherImport(e.dataTransfer.files[0]);
                }
            });
            amFileInput.addEventListener('change', (e) => {
                if (e.target.files.length) {
                    const f = e.target.files[0];
                    e.target.value = '';
                    this.handleTargetedMatcherImport(f);
                }
            });
        }
        
        // Auto-Matcher Export Button
        const btnExportAm = document.getElementById('btn-export-automatch');
        if (btnExportAm) {
            btnExportAm.addEventListener('click', () => {
                if (!this.automatchProposals || this.automatchProposals.length === 0) {
                    Toast.show('No results to export. Run Auto-Match first to generate matches.', 'warning');
                    return;
                }
                const tierLabels = {
                    high: 'High (ID / Email / National ID)',
                    phone: 'Phone Match',
                    name: 'Name Match',
                    unmatched: 'Unmatched'
                };
                const exportRows = this.automatchProposals.map(tx => ({
                    "Reference Number": tx.original_ref,
                    "Payment Date": tx.original_date,
                    "Current Student ID": tx.original_student_id || '',
                    "Current Status": tx.original_status,
                    "Confidence Tier": tierLabels[tx.confidenceTier] || (tx.proposedStudent ? 'Matched' : 'Unmatched'),
                    "Proposed Fix (Student ID)": tx.proposedStudent ? tx.proposedStudent.student_id : 'No Match Found',
                    "Level": tx.proposedStudent ? (tx.proposedStudent._levelTag || formatStudentLevelTag(getStudentProgramLevel(tx.proposedStudent))) : '',
                    "Proposed Fix (Student Name)": tx.proposedStudent ? tx.proposedStudent.full_name : '',
                    "Match Reason": tx.matchReason || '',
                    "Item Name": tx.original_item,
                    "Mapping": tx.original_mapping || '',
                    "2nd Mapping": tx.original_second_mapping || '',
                    "Amount": Number(tx.original_amount || 0),
                    "Bank": tx.original_bank || ''
                }));
                const safeExportRows = sanitizeExcelRows(exportRows);
                if (typeof XLSX !== 'undefined' && XLSX.utils && typeof XLSX.writeFile === 'function') {
                    const ws = XLSX.utils.json_to_sheet(safeExportRows);
                    ws['!cols'] = [
                        { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 24 },
                        { wch: 26 }, { wch: 22 }, { wch: 10 }, { wch: 30 }, { wch: 36 },
                        { wch: 28 }, { wch: 22 }, { wch: 22 }, { wch: 12 }, { wch: 14 }
                    ];
                    const wb = XLSX.utils.book_new();
                    XLSX.utils.book_append_sheet(wb, ws, 'Auto-Matcher Results');
                    writeCompressedExcel(wb, `Auto_Matcher_Results_${toDateOnly(new Date())}.xlsx`);
                } else {
                    const csv = Papa.unparse(safeExportRows);
                    // Include UTF-8 BOM so Microsoft Excel renders Arabic text cleanly when opening CSV exports
                    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
                    const link = document.createElement('a');
                    const url = URL.createObjectURL(blob);
                    link.href = url;
                    link.download = `Auto_Matcher_Results.csv`;
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 100);
                }
            });
        }

        const btnRunMatcher = document.getElementById('btn-run-automatcher');
        if (btnRunMatcher) {
            btnRunMatcher.addEventListener('click', () => this.runAutoMatcher());
        }

        this.automatchTierFilter = 'all';
        document.querySelectorAll('[data-automatch-tier]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-automatch-tier]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const tier = btn.getAttribute('data-automatch-tier') || 'all';
                this.automatchTierFilter = tier;
                const toggle = document.getElementById('automatch-toggle-unmatched');
                if (tier === 'unmatched' && toggle && !toggle.checked) {
                    toggle.checked = true;
                }
                this.automatchPage = 1;
                this.renderAutoMatcherPage();
            });
        });

        const btnSelectHighConfidence = document.getElementById('btn-select-high-confidence');
        if (btnSelectHighConfidence) {
            btnSelectHighConfidence.addEventListener('click', () => {
                let count = 0;
                for (const p of (this.automatchProposals || [])) {
                    if (p.proposedStudent && p.confidenceTier === 'high' && !p.locked) {
                        p.selected = true;
                        count++;
                    } else {
                        p.selected = false;
                    }
                }
                this.renderAutoMatcherPage();
                if (count > 0) {
                    Toast.show(`Selected ${count} high-confidence match(es) (ID / Email / National ID).`, 'success');
                } else {
                    Toast.show('No unlocked high-confidence matches available to select.', 'info');
                }
            });
        }

        const selectAllMatcher = document.getElementById('automatcher-select-all');
        if (selectAllMatcher) {
            selectAllMatcher.addEventListener('change', (e) => {
                const checked = e.target.checked;
                const visibleProposals = this.getFilteredAutoMatchProposals();
                for (const p of visibleProposals) {
                    if (p.proposedStudent && (!checked || !p.locked)) {
                        p.selected = checked;
                    }
                }
                document.querySelectorAll('.automatch-checkbox').forEach(cb => {
                    const p = (this.automatchProposals || []).find(item => String(item.tx_id) === cb.value);
                    if (p && (!checked || !p.locked)) {
                        cb.checked = checked;
                    }
                });
                this.updateAutoMatchSelectionUI();
            });
        }
        const toggleUnmatched = document.getElementById('automatch-toggle-unmatched');
        if (toggleUnmatched) {
            toggleUnmatched.addEventListener('change', () => {
                if (!toggleUnmatched.checked && this.automatchTierFilter === 'unmatched') {
                    this.automatchTierFilter = 'all';
                    document.querySelectorAll('[data-automatch-tier]').forEach(b => {
                        b.classList.toggle('active', b.getAttribute('data-automatch-tier') === 'all');
                    });
                }
                this.automatchPage = 1;
                this.renderAutoMatcherPage();
            });
        }
        const btnApplyMatch = document.getElementById('btn-apply-automatch-fixes');
        if(btnApplyMatch) {
            btnApplyMatch.addEventListener('click', () => {
                const checkedDomValues = new Set(Array.from(document.querySelectorAll('.automatch-checkbox:checked')).map(cb => cb.value));
                const selected = (this.automatchProposals || []).filter(p =>
                    p.proposedStudent && (p.selected || checkedDomValues.has(String(p.tx_id)))
                );
                if (selected.length === 0) {
                    Toast.show('Please select at least one proposed match to apply.', 'warning');
                    return;
                }
                const lockedCount = selected.filter(p => p.locked).length;
                const msgEl = document.getElementById('automatch-confirm-msg');
                if (msgEl) {
                    if (lockedCount > 0) {
                        msgEl.innerHTML = `<span style="color: var(--warning, #f59e0b); font-weight: 600; display: block; margin-bottom: 0.5rem;"><i data-lucide="alert-triangle" style="width: 16px; height: 16px; display: inline-block; vertical-align: text-bottom;"></i> Warning: ${lockedCount} of the ${selected.length} selected transaction(s) are settled or already recorded in ERP.</span>Changing them will update their student ID, but will <strong>NOT</strong> change what was already posted to ERP.<br><br>Do you want to proceed and apply fixes to all ${selected.length} transaction(s)?`;
                    } else {
                        msgEl.innerText = `Are you sure you want to apply fixes to ${selected.length} transaction(s)?`;
                    }
                }
                document.getElementById('modal-automatch-confirm')?.classList.remove('hidden');
                if (window.lucide) lucide.createIcons();
            });
        }
        
        const btnConfirmMatch = document.getElementById('btn-confirm-automatch');
        if(btnConfirmMatch) {
            btnConfirmMatch.addEventListener('click', () => this.applyAutoMatches());
        }

        const nameMatchCb = document.getElementById('automatch-enable-name');
        if (nameMatchCb) {
            nameMatchCb.addEventListener('click', (e) => {
                if (nameMatchCb.checked) {
                    e.preventDefault(); // Stop it from actually checking yet
                    document.getElementById('modal-name-match-warn')?.classList.remove('hidden');
                }
            });
        }
        
        const btnConfirmName = document.getElementById('btn-confirm-name-match');
        if (btnConfirmName) {
            btnConfirmName.addEventListener('click', () => {
                const cb = document.getElementById('automatch-enable-name');
                if (cb) cb.checked = true;
                document.getElementById('modal-name-match-warn')?.classList.add('hidden');
            });
        }
    }

    normalizeStudentId(val) {
        if (val === null || val === undefined) return '';
        const s = String(val).trim();
        if (/^0+\d{4,}$/.test(s)) {
            return s.replace(/^0+/, '');
        }
        return s;
    }

    async labelExistingStudentsInDatabase({ silent = false } = {}) {
        if (!this.hasRole('operator')) {
            if (!silent) this.requireRole('operator', 'label students in database');
            return { updated: 0, ugCount: 0, pgCount: 0 };
        }
        const btn = document.getElementById('btn-label-existing-students');
        const oldHtml = btn ? btn.innerHTML : '';
        let loadingToast = null;
        if (!silent) {
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Labeling...';
                if (window.lucide) lucide.createIcons();
            }
            if (window.Toast?.showLoading) {
                loadingToast = window.Toast.showLoading('Scanning & labeling existing students with (UG) / (PG)...');
            }
        }
        try {
            const allRows = (this.allStudentsData && this.allStudentsData.length > 0)
                ? this.allStudentsData
                : await fetchAll('student_master', '*', null, 'student_id');

            let ugCount = 0;
            let pgCount = 0;
            const rowsToUpdate = [];

            for (const s of (allRows || [])) {
                const lvl = getStudentProgramLevel(s) || 'PG';
                if (lvl === 'UG') ugCount++;
                else pgCount++;

                const newProg = ensureProgramHasLevelPrefix(s.program);
                if (String(s.program || '').trim() !== newProg) {
                    s.program = newProg;
                    this.indexStudentRecord(s);
                    rowsToUpdate.push({
                        student_id: s.student_id,
                        full_name: s.full_name ?? null,
                        arabic_name: s.arabic_name ?? null,
                        national_id: s.national_id ?? null,
                        email: s.email ?? null,
                        personal_email: s.personal_email ?? null,
                        mobile: s.mobile ?? null,
                        guardian_name: s.guardian_name ?? null,
                        guardian_mobile: s.guardian_mobile ?? null,
                        college: s.college ?? null,
                        program: newProg,
                        source: s.source ?? null
                    });
                }
            }

            if (rowsToUpdate.length > 0) {
                await this.upsertStudentMasterBatches(rowsToUpdate);
                await this.invalidateStudentMasterLocalCache();
            }

            this.rebuildStudentMasterMap(allRows || []);
            if (document.getElementById('view-student-master')?.classList.contains('active')) {
                this.renderStudentsPage();
            }

            if (loadingToast) loadingToast.dismiss();
            if (!silent) {
                Toast.show(
                    `Labeled ${(allRows || []).length.toLocaleString()} students (${ugCount.toLocaleString()} UG, ${pgCount.toLocaleString()} PG — ${rowsToUpdate.length.toLocaleString()} updated in DB).`,
                    'success'
                );
            }
            return { updated: rowsToUpdate.length, ugCount, pgCount, total: (allRows || []).length };
        } catch (err) {
            if (loadingToast) loadingToast.dismiss();
            if (!silent) Toast.show('Error labeling students: ' + err.message, 'error');
            throw err;
        } finally {
            if (!silent && btn) {
                btn.disabled = false;
                btn.innerHTML = oldHtml;
                if (window.lucide) lucide.createIcons();
            }
        }
    }

    /**
     * Upsert student_master rows in conservative batches so GIN trigram index updates
     * stay well within Supabase's statement_timeout, automatically splitting timed-out chunks.
     */
    async upsertStudentMasterBatches(records, { batchSize = 150, concurrency = 2, minBatchSize = 25, onProgress = null } = {}) {
        if (!Array.isArray(records) || records.length === 0) return 0;

        const isTimeoutError = (err) => {
            const msg = String(err?.message || err?.details || err || '').toLowerCase();
            return err?.code === '57014' || msg.includes('statement timeout') || msg.includes('canceling statement');
        };

        let uploadedCount = 0;
        const upsertChunk = async (chunk, retried = false) => {
            const { error } = await supabase.from('student_master').upsert(chunk, { onConflict: 'student_id' });
            if (!error) {
                uploadedCount += chunk.length;
                if (typeof onProgress === 'function') {
                    onProgress(uploadedCount, records.length);
                }
                return chunk.length;
            }

            if (isTimeoutError(error)) {
                if (chunk.length > minBatchSize) {
                    const mid = Math.ceil(chunk.length / 2);
                    await upsertChunk(chunk.slice(0, mid), false);
                    await upsertChunk(chunk.slice(mid), false);
                    return chunk.length;
                }
                if (!retried) {
                    await new Promise(resolve => setTimeout(resolve, 350));
                    return upsertChunk(chunk, true);
                }
            }
            throw error;
        };

        const tasks = [];
        for (let i = 0; i < records.length; i += batchSize) {
            const chunk = records.slice(i, i + batchSize);
            tasks.push(() => upsertChunk(chunk));
        }
        await runConcurrent(tasks, concurrency);
        return uploadedCount;
    }

    mergeStudentRecord(existing, incoming) {
        if (!existing) {
            const { email, personal_email } = classifyStudentEmails(incoming?.email, incoming?.personal_email);
            return { ...incoming, email, personal_email };
        }
        const pickLongerName = (a, b) => {
            if (!a) return b || null;
            if (!b) return a || null;
            const aWords = String(a).trim().split(/\s+/).length;
            const bWords = String(b).trim().split(/\s+/).length;
            if (bWords > aWords) return b;
            if (aWords > bWords) return a;
            return String(b).length >= String(a).length ? b : a;
        };
        const isFromStudentDetails = incoming.source === 'StudentDetails';
        const { email, personal_email } = mergeStudentEmails(existing, incoming, isFromStudentDetails);
        return {
            student_id: incoming.student_id || existing.student_id,
            full_name: pickLongerName(existing.full_name, incoming.full_name),
            arabic_name: incoming.arabic_name || existing.arabic_name || null,
            national_id: incoming.national_id || existing.national_id || null,
            email,
            personal_email,
            mobile: incoming.mobile || existing.mobile || null,
            guardian_name: incoming.guardian_name || existing.guardian_name || null,
            guardian_mobile: incoming.guardian_mobile || existing.guardian_mobile || null,
            college: (isFromStudentDetails ? (incoming.college || existing.college) : (existing.college || incoming.college)) || null,
            program: (isFromStudentDetails ? (incoming.program || existing.program) : (existing.program || incoming.program)) || null,
            source: existing.source && existing.source !== incoming.source ? 'Merged' : (incoming.source || existing.source || null)
        };
    }

    async handleStudentImport(fileOrFiles) {
        const files = Array.isArray(fileOrFiles)
            ? fileOrFiles
            : (fileOrFiles && typeof fileOrFiles.length === 'number' && !(fileOrFiles instanceof Blob))
                ? Array.from(fileOrFiles)
                : (fileOrFiles ? [fileOrFiles] : []);
        if (files.length === 0) return;

        const batchFileName = files.map(f => f.name).join(', ');
        const status = document.getElementById('student-upload-status');
        status.style.display = 'block';
        status.className = 'alert alert-info';
        status.innerHTML = `<i data-lucide="loader" class="spin"></i> Parsing ${files.length > 1 ? `${files.length} Excel files` : 'Excel file'}...`;
        if (window.lucide) lucide.createIcons();

        try {
            const cleanText = (val) => {
                if (val === null || val === undefined) return null;
                const s = String(val).replace(/\*+$/g, '').replace(/\s+/g, ' ').trim();
                if (!s || ['N/A', 'NA', 'NONE', 'NULL', '-', '.', '0', 'NO', 'NO PASSPORT', 'لا يوجد'].includes(s.toUpperCase())) return null;
                if (s.startsWith('=')) return null; // Ignore un-evaluated formula strings like =D2&" "&E2
                return s;
            };

            const cleanPhone = (val) => {
                const txt = cleanText(val);
                if (!txt) return null;
                let digits = txt.replace(/[^0-9+]/g, '');
                if (!digits || digits.replace(/\D/g, '').length < 7) return null;
                // Restore leading 0 dropped by Excel numeric formatting on 10-digit Egyptian mobile numbers (10, 11, 12, 15)
                if (/^1[0125]\d{8}$/.test(digits)) {
                    digits = '0' + digits;
                }
                return digits;
            };

            const cleanNationalId = (val, rawSid, normSid) => {
                const txt = cleanText(val);
                if (!txt) return null;
                // Ignore dummy National ID / Passport values that repeat the Student ID, are too short, or are Excel float-truncated (ending in 6+ zeros)
                if (txt === rawSid || txt === normSid || txt.length < 7) return null;
                if (/^\d{8}0{6,}$/.test(txt)) return null;
                if (new Set(txt.replace(/[\s\-]/g, '').split('')).size < 3) return null;
                return txt;
            };

            const recordsMap = new Map();
            const paddedLegacyIds = new Set();

            for (const file of files) {
                const data = await file.arrayBuffer();
                const workbook = XLSX.read(data, { type: 'array' });
                let parsedAnySheet = false;

                for (const sheetName of workbook.SheetNames) {
                    const sheet = workbook.Sheets[sheetName];
                    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
                    if (!rows || rows.length === 0) continue;

                    // Scan the first 10 rows to find the header row containing 'Student ID', 'PEOPLE_ID1', or 'People ID'
                    let headerRowIdx = -1;
                    for (let i = 0; i < Math.min(10, rows.length); i++) {
                        const rowCells = (rows[i] || []).map(c => c != null ? String(c).trim() : '');
                        if (rowCells.includes('Student ID') || rowCells.includes('PEOPLE_ID1') || rowCells.includes('People ID')) {
                            headerRowIdx = i;
                            break;
                        }
                    }
                    if (headerRowIdx === -1) continue;
                    parsedAnySheet = true;

                    const headers = rows[headerRowIdx];
                    const dataRows = rows.slice(headerRowIdx + 1);

                    const headerMap = {};
                    headers.forEach((h, i) => { if (h != null && String(h).trim() !== '') headerMap[String(h).trim()] = i; });

                    status.innerHTML = `<i data-lucide="loader" class="spin"></i> Preparing and normalizing student records (${escapeHTML(file.name)})...`;

                    let lastRawSid = '';
                    let lastStudentId = '';

                    for (const row of dataRows) {
                        if (!row || row.length === 0) continue;

                        let rawSid, student_id, full_name, arabic_name, national_id, email, personal_email, mobile, guardian_name, guardian_mobile, college, program, source;

                        if ('PEOPLE_ID1' in headerMap || 'People ID' in headerMap) {
                            const pidCol = 'PEOPLE_ID1' in headerMap ? 'PEOPLE_ID1' : 'People ID';
                            const cellSid = row[headerMap[pidCol]] != null ? String(row[headerMap[pidCol]]).trim() : '';
                            if (cellSid) {
                                rawSid = cellSid;
                                student_id = this.normalizeStudentId(rawSid);
                                lastRawSid = rawSid;
                                lastStudentId = student_id;
                            } else {
                                // Continuation row (e.g. Father / Mother guardian entry for the preceding applicant)
                                rawSid = lastRawSid;
                                student_id = lastStudentId;
                            }
                            if (rawSid && rawSid !== student_id) paddedLegacyIds.add(rawSid);

                            const first = cleanText(row[headerMap['FIRST_NAME1'] ?? headerMap['First Name']]);
                            const middle = cleanText(row[headerMap['MIDDLE_NAME1'] ?? headerMap['Middle Name']]);
                            const last = cleanText(row[headerMap['LAST_NAME1'] ?? headerMap['Last Name']]);
                            const rawFull = cleanText(row[headerMap['Full name']]);
                            const combinedParts = [first, middle, last].filter(Boolean).join(' ');
                            if (rawFull && last && !rawFull.toLowerCase().includes(last.toLowerCase())) {
                                full_name = `${rawFull} ${last}`.replace(/\s+/g, ' ').trim();
                            } else {
                                full_name = combinedParts || rawFull || first || null;
                            }

                            arabic_name = cleanText(row[headerMap['ARABICNAME'] ?? headerMap['Arabic Name']]);
                            national_id = cleanNationalId(row[headerMap['GOVERNMENT_ID1'] ?? headerMap['Government Id']], rawSid, student_id)
                                || cleanNationalId(row[headerMap['PASSPORT_NUMBER1'] ?? headerMap['Passport Number']], rawSid, student_id);
                            const rawUniEmail = cleanText(row[headerMap['Email1'] ?? headerMap['University Email']]);
                            const rawPersonalEmail = cleanText(row[headerMap['personalEmail'] ?? headerMap['Personal Email']]);
                            ({ email, personal_email } = classifyStudentEmails(rawUniEmail, rawPersonalEmail));
                            mobile = cleanPhone(row[headerMap['PhoneNumber1'] ?? headerMap['Phone Number']]);
                            const rel = cleanText(row[headerMap['Guardian_Relation'] ?? headerMap['Parent Relation']]);
                            const rawGName = cleanText(row[headerMap['Guardian_NAME'] ?? headerMap['Parent Name']]);
                            const rawGMob = cleanPhone(row[headerMap['Guardian_Mobile'] ?? headerMap['Parent Mobile']]);

                            // Prioritize Father / Mother guardian info over 'Other' (which often just repeats the student's own name with no mobile)
                            const existingRec = student_id ? recordsMap.get(student_id) : null;
                            const isPrimaryParent = rel && /^(father|mother)$/i.test(rel);
                            if (existingRec && existingRec.guardian_mobile && !rawGMob) {
                                guardian_name = existingRec.guardian_name;
                                guardian_mobile = existingRec.guardian_mobile;
                            } else if (existingRec && existingRec.guardian_name && !isPrimaryParent && existingRec._isPrimaryParent) {
                                guardian_name = existingRec.guardian_name;
                                guardian_mobile = existingRec.guardian_mobile || rawGMob;
                            } else {
                                guardian_name = rawGName;
                                guardian_mobile = rawGMob;
                            }

                            college = cleanText(row[headerMap['University1'] ?? headerMap['University']])
                                || cleanText(row[headerMap['CURRICULUM1'] ?? headerMap['Curriculum']]);
                            const progParts = [
                                cleanText(row[headerMap['PROGRAM1'] ?? headerMap['Program']]),
                                cleanText(row[headerMap['DEGREE1'] ?? headerMap['Degree']]),
                                cleanText(row[headerMap['CURRICULUM1'] ?? headerMap['Curriculum']])
                            ].filter(Boolean);
                            program = [...new Set(progParts)].join(' / ') || null;
                            source = 'ApplicantReport';

                            if (student_id) {
                                const incoming = {
                                    student_id, full_name, arabic_name, national_id, email, personal_email, mobile, guardian_name, guardian_mobile, college, program, source
                                };
                                const merged = this.mergeStudentRecord(existingRec, incoming);
                                if (isPrimaryParent && (rawGName || rawGMob)) merged._isPrimaryParent = true;
                                else if (existingRec?._isPrimaryParent) merged._isPrimaryParent = true;
                                recordsMap.set(student_id, merged);
                            }
                            continue;
                        } else if ('Student ID' in headerMap && 'Full Name' in headerMap) {
                            // Exported / Master Combined format (has student_master columns)
                            rawSid = String(row[headerMap['Student ID']] || '').trim();
                            student_id = this.normalizeStudentId(rawSid);
                            if (rawSid && rawSid !== student_id) paddedLegacyIds.add(rawSid);

                            full_name = cleanText(row[headerMap['Full Name']]);
                            arabic_name = cleanText(row[headerMap['Arabic Name']]);
                            national_id = cleanNationalId(row[headerMap['National ID']], rawSid, student_id);
                            const rawUniEmail = cleanText(row[headerMap['NU Email'] ?? headerMap['University Email'] ?? headerMap['Email']]);
                            const rawPersonalEmail = cleanText(row[headerMap['Personal Email'] ?? headerMap['Secondary Email'] ?? headerMap['personalEmail']]);
                            ({ email, personal_email } = classifyStudentEmails(rawUniEmail, rawPersonalEmail));
                            mobile = cleanPhone(row[headerMap['Mobile']]);
                            guardian_name = cleanText(row[headerMap['Guardian Name']]);
                            guardian_mobile = cleanPhone(row[headerMap['Guardian Mobile']]);
                            college = cleanText(row[headerMap['College']]);
                            program = cleanText(row[headerMap['Program']]);
                            source = cleanText(row[headerMap['Source']]) || 'Merged';
                        } else if ('Student ID' in headerMap) {
                            rawSid = String(row[headerMap['Student ID']] || '').trim();
                            student_id = this.normalizeStudentId(rawSid);
                            if (rawSid && rawSid !== student_id) paddedLegacyIds.add(rawSid);

                            full_name = cleanText(row[headerMap['Student Name']]);
                            arabic_name = null;
                            national_id = cleanNationalId(row[headerMap['National ID']], rawSid, student_id);
                            const rawEmail = cleanText(row[headerMap['Email'] ?? headerMap['University Email']]);
                            const rawPersonalEmail = cleanText(row[headerMap['Personal Email'] ?? headerMap['personalEmail']]);
                            ({ email, personal_email } = classifyStudentEmails(rawEmail, rawPersonalEmail));
                            mobile = cleanPhone(row[headerMap['Mobile Phone Number']]) || cleanPhone(row[headerMap['Home Phone Number']]);
                            guardian_name = null;
                            guardian_mobile = null;
                            college = cleanText(row[headerMap['College']]);
                            program = cleanText(row[headerMap['Program']]);
                            source = 'StudentDetails';
                        }

                        if (student_id) {
                            const incoming = {
                                student_id, full_name, arabic_name, national_id, email, personal_email, mobile, guardian_name, guardian_mobile, college, program, source
                            };
                            recordsMap.set(student_id, this.mergeStudentRecord(recordsMap.get(student_id), incoming));
                        }
                    }
                }

                if (!parsedAnySheet) {
                    throw new Error(`Unrecognized Excel format in "${file.name}". Expected 'Student ID', 'People ID', or 'PEOPLE_ID1' column.`);
                }
            }

            const records = Array.from(recordsMap.values()).map(r => {
                const copy = { ...r };
                delete copy._isPrimaryParent;
                return copy;
            });

            // Fetch existing student_master rows (both normalized IDs and any 0-padded legacy IDs) so we merge instead of wiping fields
            status.innerHTML = `<i data-lucide="loader" class="spin"></i> Merging with existing database records...`;
            const lookupIds = [...new Set([...records.map(r => r.student_id), ...paddedLegacyIds])];
            const existingMap = new Map();
            const rawExistingByNormId = new Map();
            const legacyIdsToDelete = [];

            const lookupChunks = [];
            for (let i = 0; i < lookupIds.length; i += 250) {
                lookupChunks.push(lookupIds.slice(i, i + 250));
            }
            const existingChunkResults = await runConcurrent(lookupChunks.map(chunk => async () => {
                const { data: existingRows, error: exErr } = await supabase.from('student_master').select('*').in('student_id', chunk);
                if (exErr) throw exErr;
                return existingRows || [];
            }), 3);
            for (const existingRows of existingChunkResults) {
                for (const ex of existingRows) {
                    const normId = this.normalizeStudentId(ex.student_id);
                    if (ex.student_id !== normId) {
                        legacyIdsToDelete.push(ex.student_id);
                    } else if (!rawExistingByNormId.has(normId)) {
                        rawExistingByNormId.set(normId, ex);
                    }
                    existingMap.set(normId, this.mergeStudentRecord(existingMap.get(normId), { ...ex, student_id: normId }));
                }
            }

            const mergedRecords = records.map(r => {
                const merged = this.mergeStudentRecord(existingMap.get(r.student_id), r);
                merged.program = ensureProgramHasLevelPrefix(merged.program);
                return merged;
            });

            const syncFields = [
                'student_id', 'full_name', 'arabic_name', 'national_id',
                'email', 'personal_email', 'mobile', 'guardian_name',
                'guardian_mobile', 'college', 'program', 'source'
            ];
            const recordsToUpsert = mergedRecords.filter(merged => {
                const rawEx = rawExistingByNormId.get(merged.student_id);
                if (!rawEx) return true;
                return syncFields.some(field => (merged[field] ?? null) !== (rawEx[field] ?? null));
            });

            let insertedCount = 0;
            if (recordsToUpsert.length > 0) {
                status.innerHTML = `<i data-lucide="loader" class="spin"></i> Uploading ${recordsToUpsert.length.toLocaleString()} new/updated records...`;
                insertedCount = await this.upsertStudentMasterBatches(recordsToUpsert, {
                    batchSize: 150,
                    concurrency: 2,
                    onProgress: (done, total) => {
                        status.innerHTML = `<i data-lucide="loader" class="spin"></i> Uploading... ${Math.min(100, Math.round((done / total) * 100))}%`;
                    }
                });
            }

            // Clean up any old 0-padded duplicate rows in student_master that have now been merged into their normalized IDs
            if (legacyIdsToDelete.length > 0) {
                for (let i = 0; i < legacyIdsToDelete.length; i += 200) {
                    const { error: delErr } = await supabase.from('student_master').delete().in('student_id', legacyIdsToDelete.slice(i, i + 200));
                    if (delErr) throw delErr;
                }
            }

            await this.invalidateStudentMasterLocalCache();

            const unchangedCount = mergedRecords.length - recordsToUpsert.length;
            if (this.currentUser) {
                await supabase.from('import_batches').insert({
                    user_email: this.currentUser.email,
                    file_name: batchFileName,
                    status: 'success',
                    records_processed: mergedRecords.length,
                    records_inserted: insertedCount,
                    details: {
                        type: 'student_master',
                        legacy_ids_cleaned: legacyIdsToDelete.length,
                        unchanged_skipped: unchangedCount
                    }
                });
            }

            status.className = 'alert alert-success';
            status.innerHTML = unchangedCount > 0
                ? `<i data-lucide="check-circle"></i> Successfully processed ${mergedRecords.length.toLocaleString()} students (${insertedCount.toLocaleString()} added/updated, ${unchangedCount.toLocaleString()} unchanged)!`
                : `<i data-lucide="check-circle"></i> Successfully imported & merged ${mergedRecords.length.toLocaleString()} students!`;
            if (window.lucide) lucide.createIcons();
            await this.loadStudents({ forceReload: true });

        } catch (err) {
            status.className = 'alert alert-danger';
            status.innerHTML = `<i data-lucide="alert-triangle"></i> Error: ${escapeHTML(err.message)}`;
            if (window.lucide) lucide.createIcons();
            console.error(err);
            if (this.currentUser) {
                await supabase.from('import_batches').insert({
                    user_email: this.currentUser.email,
                    file_name: batchFileName,
                    status: 'failed',
                    records_processed: 0,
                    records_inserted: 0,
                    details: { type: 'student_master', error: err.message }
                });
            }
        }
    }

    openStudentModal(student = null) {
        const modal = document.getElementById('modal-student');
        if (!modal) return;
        const titleEl = document.getElementById('modal-student-title');
        const idInput = document.getElementById('stu-modal-id');

        if (student) {
            if (titleEl) titleEl.textContent = `Edit Student (${student.student_id})`;
            if (idInput) {
                idInput.value = student.student_id || '';
                idInput.readOnly = true;
                idInput.style.opacity = '0.75';
            }
            const setVal = (id, v) => {
                const el = document.getElementById(id);
                if (el) el.value = v || '';
            };
            const { nuEmail, personalEmail } = getStudentDisplayEmails(student);
            setVal('stu-modal-national-id', student.national_id);
            setVal('stu-modal-name', student.full_name);
            setVal('stu-modal-arabic-name', student.arabic_name);
            setVal('stu-modal-email', nuEmail);
            setVal('stu-modal-personal-email', personalEmail);
            setVal('stu-modal-mobile', student.mobile);
            setVal('stu-modal-guardian-name', student.guardian_name);
            setVal('stu-modal-guardian-mobile', student.guardian_mobile);
            setVal('stu-modal-college', student.college);
            setVal('stu-modal-program', student.program);
        } else {
            if (titleEl) titleEl.textContent = 'Add Student Record';
            if (idInput) {
                idInput.value = '';
                idInput.readOnly = false;
                idInput.style.opacity = '1';
            }
            [
                'stu-modal-national-id', 'stu-modal-name', 'stu-modal-arabic-name',
                'stu-modal-email', 'stu-modal-personal-email', 'stu-modal-mobile', 'stu-modal-guardian-name',
                'stu-modal-guardian-mobile', 'stu-modal-college', 'stu-modal-program'
            ].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
        }
        modal.classList.remove('hidden');
        if (window.lucide) lucide.createIcons();
    }

    indexStudentRecord(s) {
        if (!s || typeof s !== 'object') return s;
        const sid = String(s.student_id || '').toLowerCase();
        s._normSid = this.normalizeStudentId(sid).toLowerCase();
        s._sourceLower = String(s.source || '').toLowerCase();
        s._level = getStudentProgramLevel(s);
        s._levelTag = formatStudentLevelTag(s._level);
        s._searchHaystack = `${sid}\n${s._normSid}\n${s._level}\n${s._levelTag}\n${s.full_name || ''}\n${s.arabic_name || ''}\n${s.email || ''}\n${s.personal_email || ''}\n${s.mobile || ''}\n${s.guardian_mobile || ''}\n${s.guardian_name || ''}\n${s.national_id || ''}\n${s.college || ''}\n${s.program || ''}`.toLowerCase();
        return s;
    }

    async loadStudents({ forceReload = false, skipAutoProfile = false } = {}) {
        const tbody = document.getElementById('students-table-body');
        try {
            if (!this.allStudentsData || forceReload) {
                const termRawInit = (document.getElementById('student-search-input')?.value || '').trim();
                const collegeInit = document.getElementById('student-filter-college')?.value || '';
                const sourceInit = document.getElementById('student-filter-source')?.value || '';
                const canRenderPreview = !termRawInit && !collegeInit && !sourceInit && (this.studentsCurrentPage || 1) === 1;
                let previewRendered = false;

                if (tbody) {
                    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><i data-lucide="loader" class="spin" style="width:36px;height:36px;opacity:0.6;"></i><h3>Loading student directory...</h3></div></td></tr>';
                    renderIcons(tbody);
                }
                await this.ensureFullStudentMaster({
                    forceReload,
                    onProgress: (loaded, previewRows) => {
                        const totalEl = document.getElementById('students-stat-total');
                        if (totalEl && !this.allStudentsData) {
                            totalEl.textContent = `${loaded.toLocaleString()}...`;
                        }
                        if (canRenderPreview && !previewRendered && Array.isArray(previewRows) && previewRows.length > 0) {
                            previewRendered = true;
                            this.filteredStudentsData = previewRows;
                            this.renderStudentsPage();
                        }
                    }
                });
                this.updateStudentsStatsAndDropdowns();
            }
            this.markTabLoaded('student-master');

            const termRaw = (document.getElementById('student-search-input')?.value || '').trim();
            const term = termRaw.toLowerCase();
            const normTerm = termRaw ? this.normalizeStudentId(termRaw).toLowerCase() : '';
            const collegeFilter = document.getElementById('student-filter-college')?.value || '';
            const sourceFilter = document.getElementById('student-filter-source')?.value || '';
            const sourceFilterLower = sourceFilter.toLowerCase();

            const clearBtn = document.getElementById('btn-clear-student-filters');
            if (clearBtn) {
                if (termRaw || collegeFilter || sourceFilter) clearBtn.classList.remove('hidden');
                else clearBtn.classList.add('hidden');
            }

            this.filteredStudentsData = (this.allStudentsData || []).filter(s => {
                if (collegeFilter && (s.college || '') !== collegeFilter) return false;
                if (sourceFilterLower && !(s._sourceLower ?? String(s.source || '').toLowerCase()).includes(sourceFilterLower)) return false;
                if (term) {
                    if (!s._searchHaystack) this.indexStudentRecord(s);
                    const match = (normTerm && s._normSid === normTerm) || s._searchHaystack.includes(term);
                    if (!match) return false;
                }
                return true;
            });

            this.renderStudentsPage();

            if (!skipAutoProfile && term && this.filteredStudentsData.length === 1) {
                this.loadStudentProfile(this.filteredStudentsData[0].student_id);
            }
        } catch (err) {
            Toast.show('Error loading students: ' + err.message, 'error');
        }
    }

    updateStudentsStatsAndDropdowns() {
        const list = this.allStudentsData || [];
        const total = list.length;
        const collegesSet = new Set();
        let withMobile = 0;
        let withNatId = 0;
        let mergedCount = 0;

        list.forEach(s => {
            if (s.college && String(s.college).trim()) collegesSet.add(String(s.college).trim());
            if (s.mobile && String(s.mobile).trim()) withMobile++;
            if (s.national_id && String(s.national_id).trim()) withNatId++;
            if (s.source && String(s.source).includes(',')) mergedCount++;
        });

        const setStat = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };
        setStat('students-stat-total', total.toLocaleString());
        setStat('students-stat-colleges', collegesSet.size.toLocaleString());
        setStat('students-stat-mobile', total > 0 ? `${withMobile.toLocaleString()} (${Math.round((withMobile / total) * 100)}%)` : '0');
        setStat('students-stat-nat-id', total > 0 ? `${withNatId.toLocaleString()} (${Math.round((withNatId / total) * 100)}%)` : '0');
        setStat('students-stat-merged', mergedCount.toLocaleString());

        const collegeSelect = document.getElementById('student-filter-college');
        const currentVal = collegeSelect ? collegeSelect.value : '';
        const sortedColleges = Array.from(collegesSet).sort((a, b) => a.localeCompare(b));
        if (collegeSelect) {
            collegeSelect.innerHTML = `<option value="">All Colleges (${sortedColleges.length})</option>` +
                sortedColleges.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('');
            collegeSelect.value = currentVal;
        }

        const datalist = document.getElementById('datalist-student-colleges');
        if (datalist) {
            datalist.innerHTML = sortedColleges.map(c => `<option value="${escapeHTML(c)}"></option>`).join('');
        }
    }

    renderStudentsPage() {
        const tbody = document.getElementById('students-table-body');
        const paginationEl = document.getElementById('students-pagination');
        if (!tbody) return;

        const data = this.filteredStudentsData || [];
        const total = data.length;
        const pageSize = this.studentsPageSize || 100;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        if (this.studentsCurrentPage > totalPages) this.studentsCurrentPage = totalPages;
        if (this.studentsCurrentPage < 1) this.studentsCurrentPage = 1;

        if (total === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6">
                        <div class="empty-state">
                            <i data-lucide="users" style="width:48px;height:48px;opacity:0.5;"></i>
                            <h3>No students found</h3>
                            <p>Try a different search term or filter.</p>
                        </div>
                    </td>
                </tr>`;
            if (paginationEl) paginationEl.innerHTML = '';
            renderIcons(tbody);
            return;
        }

        const startIdx = (this.studentsCurrentPage - 1) * pageSize;
        const pageItems = data.slice(startIdx, startIdx + pageSize);

        tbody.innerHTML = pageItems.map(s => {
            const levelBadge = this.renderStudentLevelBadge(getStudentProgramLevel(s));
            const { nuEmail, personalEmail } = getStudentDisplayEmails(s);
            const emailCellHtml = `
                <div class="student-emails-cell" style="display: flex; flex-direction: column; gap: 0.18rem;">
                    ${nuEmail
                        ? `<span class="copyable-email" style="color: var(--primary); font-weight: 500;" data-email="${escapeHTML(nuEmail)}" title="Click to copy NU email">${escapeHTML(nuEmail)}</span>`
                        : (personalEmail
                            ? `<span style="color: var(--text-muted); font-size: 0.78rem; font-style: italic;">No NU email</span>`
                            : `<span style="color: var(--text-muted);">—</span>`)
                    }
                    ${personalEmail
                        ? `<span class="copyable-email" style="color: var(--text-muted); font-size: 0.78rem;" data-email="${escapeHTML(personalEmail)}" title="Click to copy personal email"><span style="opacity: 0.7; margin-right: 0.25rem;">Personal:</span>${escapeHTML(personalEmail)}</span>`
                        : ''
                    }
                </div>
            `;
            return `
            <tr class="student-row" style="cursor: pointer;" data-sid="${escapeHTML(s.student_id)}">
                <td style="white-space: nowrap;">
                    <div style="display: inline-flex; align-items: center; gap: 0.45rem;">
                        <strong style="font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.92rem; color: var(--text-main);">${escapeHTML(s.student_id)}</strong>${levelBadge}
                        <button type="button" class="btn-icon copyable-student-id" data-copy-sid="${escapeHTML(s.student_id)}" title="Copy Student ID" style="padding: 2px; width: 22px; height: 22px; opacity: 0.7; border-radius: 4px;">
                            <i data-lucide="copy" style="width: 12px; height: 12px;"></i>
                        </button>
                    </div>
                </td>
                <td><strong>${escapeHTML(s.full_name)}</strong></td>
                <td>${emailCellHtml}</td>
                <td>${escapeHTML(s.mobile)}</td>
                <td>${escapeHTML(s.college)}</td>
                <td>${escapeHTML(s.program)}</td>
            </tr>
        `;
        }).join('');
        if (window.lucide) lucide.createIcons({ root: tbody });

        if (paginationEl) {
            paginationEl.innerHTML = `
                <div class="pagination-info" style="font-size: 0.85rem; color: var(--text-muted);">
                    Showing <strong>${(startIdx + 1).toLocaleString()}</strong>–<strong>${Math.min(startIdx + pageSize, total).toLocaleString()}</strong> of <strong>${total.toLocaleString()}</strong> students
                </div>
                <div class="pagination-controls" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                    <button class="btn btn-secondary btn-sm" id="students-prev-page" ${this.studentsCurrentPage <= 1 ? 'disabled' : ''}>Previous</button>
                    <span style="font-size: 0.85rem; color: var(--text-secondary);">Page <strong>${this.studentsCurrentPage}</strong> of <strong>${totalPages}</strong></span>
                    <button class="btn btn-secondary btn-sm" id="students-next-page" ${this.studentsCurrentPage >= totalPages ? 'disabled' : ''}>Next</button>
                    ${this.pageJump.renderHtml('students', totalPages)}
                </div>
            `;
            document.getElementById('students-prev-page')?.addEventListener('click', () => {
                if (this.studentsCurrentPage > 1) {
                    this.studentsCurrentPage--;
                    this.renderStudentsPage();
                }
            });
            document.getElementById('students-next-page')?.addEventListener('click', () => {
                if (this.studentsCurrentPage < totalPages) {
                    this.studentsCurrentPage++;
                    this.renderStudentsPage();
                }
            });
            this.pageJump.bind('students', totalPages, (target) => {
                this.studentsCurrentPage = target;
                this.renderStudentsPage();
            }, paginationEl);
        }
    }

    setupPrintButton() {
        const btnPrint = document.getElementById('btn-print-profile');
        if (btnPrint) {
            btnPrint.addEventListener('click', () => {
                if (!this.currentProfileSid) return;
                
                const profileContent = document.getElementById('inline-student-profile').cloneNode(true);
                ['.header', '#student-profile-header'].forEach(sel => {
                    const el = profileContent.querySelector(sel);
                    if (el) el.remove();
                });

                const st = this.currentProfileStudent || {};
                const { nuEmail, personalEmail } = getStudentDisplayEmails(st);
                let name = st.full_name || st.name || '-';
                let email = [nuEmail, personalEmail].filter(Boolean).join(' | ') || '-';
                let phone = st.mobile || st.phone || '-';
                let college = st.college || '-';
                let program = st.program || '-';

                // Fallback to DOM row if metadata wasn't loaded
                if (name === '-') {
                    const row = document.querySelector(`.student-row[data-sid="${CSS.escape(String(this.currentProfileSid))}"]`);
                    if (row && row.children.length >= 6) {
                        name = row.children[1].innerText || '-';
                        email = row.children[2].innerText || '-';
                        phone = row.children[3].innerText || '-';
                        college = row.children[4].innerText || '-';
                        program = row.children[5].innerText || '-';
                    }
                }
                const sid = escapeHTML(this.currentProfileSid);
                const levelTag = formatStudentLevelTag(getStudentProgramLevel(st)) || '';
                const arabicName = escapeHTML(st.arabic_name || '');
                [name, email, phone, college, program] = [name, email, phone, college, program].map(v => escapeHTML(v));

                const txs = Array.isArray(this.currentProfileTransactions) ? this.currentProfileTransactions : [];
                let totalEgp = 0;
                let totalUsd = 0;
                txs.forEach(t => {
                    totalEgp += parseFloat(t.item_price || 0) || 0;
                    if (isSameDaySettlementBank(t)) totalUsd += parseFloat(t.raw_usd ?? t.amount ?? 0) || 0;
                });
                const stmtDate = toDateOnly(new Date());
                const stmtRef = `STMT-${stmtDate.replace(/-/g, '')}-${String(this.currentProfileSid).replace(/[^A-Za-z0-9]/g, '')}`;

                // Remove interactive copy buttons from cloned printable ledger
                profileContent.querySelectorAll('button, .btn-icon').forEach(b => b.remove());

                const printWindow = window.open('', '_blank');
                if (!printWindow) {
                    Toast.show('Pop-up blocked – allow pop-ups for this site to print.', 'warning');
                    return;
                }
                printWindow.document.write(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>Official Student Statement - ${sid}</title>
                        <style>
                            @page { size: A4; margin: 0; }
                            * { box-sizing: border-box; }
                            body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111827; max-width: 900px; margin: 0 auto; padding: 14mm; font-size: 12.5px; line-height: 1.45; }
                            .brand-bar { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2.5px solid #0f766e; padding-bottom: 0.9rem; margin-bottom: 1.25rem; }
                            .brand-title { font-size: 1.35rem; font-weight: 800; color: #0f172a; margin: 0; letter-spacing: -0.02em; }
                            .brand-sub { font-size: 0.8rem; color: #475569; margin: 0.2rem 0 0 0; }
                            .stmt-meta { text-align: right; font-size: 0.78rem; color: #475569; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
                            .stmt-meta strong { color: #0f172a; display: block; font-size: 0.85rem; }
                            .dossier-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.55rem 1.5rem; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 0.9rem 1.1rem; margin-bottom: 1rem; }
                            .dossier-row { display: flex; gap: 0.45rem; font-size: 0.82rem; }
                            .dossier-row .lbl { color: #64748b; font-weight: 600; min-width: 92px; }
                            .dossier-row .val { color: #0f172a; font-weight: 600; }
                            .summary-strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; margin-bottom: 1.35rem; }
                            .summary-box { border: 1px solid #cbd5e1; border-radius: 8px; padding: 0.7rem 0.9rem; background: #ffffff; }
                            .summary-box.primary { border-color: #0f766e; background: #f0fdfa; }
                            .summary-box .k { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: #475569; font-weight: 700; }
                            .summary-box .v { font-size: 1.12rem; font-weight: 800; color: #0f172a; font-family: ui-monospace, Menlo, monospace; margin-top: 0.2rem; }
                            table { width: 100%; border-collapse: collapse; margin-bottom: 1.35rem; font-size: 0.78rem; }
                            th, td { padding: 0.5rem 0.6rem; border: 1px solid #cbd5e1; text-align: left; }
                            th { background-color: #f1f5f9; font-weight: 700; color: #1e293b; text-transform: uppercase; font-size: 0.68rem; letter-spacing: 0.04em; }
                            td { background-color: #fff; font-variant-numeric: tabular-nums; }
                            .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; background: #e2e8f0; color: #0f172a; font-weight: 600; font-size: 0.72rem; }
                            h3 { font-size: 0.95rem; margin: 1.1rem 0 0.55rem 0; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.3rem; }
                            .custom-footer { margin-top: 2rem; display: flex; justify-content: space-between; align-items: center; color: #64748b; font-size: 0.75rem; border-top: 1px solid #cbd5e1; padding-top: 0.75rem; }
                            @media print { body { padding: 14mm; max-width: none; } }
                        </style>
                    </head>
                    <body>
                        <div class="brand-bar">
                            <div>
                                <h1 class="brand-title">Statement of Student Payments</h1>
                                <p class="brand-sub">NU Finance Department — Verified Payment Ledger</p>
                            </div>
                            <div class="stmt-meta">
                                <strong>${escapeHTML(stmtRef)}</strong>
                                <span>Issued: ${escapeHTML(stmtDate)}</span>
                            </div>
                        </div>
                        <div class="dossier-grid">
                            <div class="dossier-row"><span class="lbl">Student Name:</span><span class="val">${name}${arabicName ? ` — ${arabicName}` : ''}</span></div>
                            <div class="dossier-row"><span class="lbl">Student ID:</span><span class="val" style="font-family:monospace;">${sid} ${escapeHTML(levelTag)}</span></div>
                            <div class="dossier-row"><span class="lbl">Faculty / Prog:</span><span class="val">${college} / ${program}</span></div>
                            <div class="dossier-row"><span class="lbl">Contact:</span><span class="val">${email} | ${phone}</span></div>
                        </div>
                        <div class="summary-strip">
                            <div class="summary-box primary">
                                <div class="k">Total Verified Paid (EGP Eq.)</div>
                                <div class="v">EGP ${formatMoney(totalEgp)}</div>
                            </div>
                            <div class="summary-box">
                                <div class="k">Foreign Currency (USD)</div>
                                <div class="v">${totalUsd > 0 ? `USD ${formatMoney(totalUsd)}` : '—'}</div>
                            </div>
                            <div class="summary-box">
                                <div class="k">Recorded Payments</div>
                                <div class="v">${txs.length}</div>
                            </div>
                        </div>
                        ${profileContent.innerHTML}
                        <div class="custom-footer">
                            <span>NU Finance Team · Official Computer-Generated Statement</span>
                            <span>Generated: ${escapeHTML(new Date().toLocaleString())}</span>
                        </div>
                    </body>
                    </html>
                `);
                
                printWindow.document.close();
                printWindow.focus();
                
                // Slight delay to ensure CSS loads before printing
                setTimeout(() => {
                    printWindow.print();
                }, 250);
            });
        }
    }

    async loadStudentProfile(sid) {
        this.currentProfileSid = sid;
        this.currentProfileTransactions = [];
        try {
            document.getElementById('student-directory-view')?.classList.add('hidden');
            const profileContainer = document.getElementById('inline-student-profile');
            if (profileContainer) {
                profileContainer.classList.remove('hidden');
            }
            if (window.lucide) lucide.createIcons();
            window.scrollTo({ top: 0, behavior: 'smooth' });

            document.getElementById('student-summary-body').innerHTML = '';
            document.getElementById('student-ledger-body').innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 1.5rem; color: var(--text-muted);">Loading payment history...</td></tr>';

            const normSid = this.normalizeStudentId(sid);
            const paddedErpSid = /^\d+$/.test(normSid) && normSid.length < 9 ? normSid.padStart(9, '0') : null;
            const sidVariants = Array.from(new Set([
                String(sid).trim(),
                normSid,
                paddedErpSid
            ].filter(Boolean)));

            const profileTxCols = 'id, reference_number, payment_date, student_id, original_student_id, item_name, item_price, fawry_fees, net_amount, total_amount, check_column, mapping, second_mapping, bank, merchant_name, id_status, is_settled, settlement_batch, erp_batch_number';

            // Fetch student profile record (from cache or DB) + Fawry transactions + Foreign transactions in parallel
            const cachedSt = (this.allStudentsData || []).find(s => sidVariants.includes(String(s.student_id)));
            const foreignPromise = (async () => {
                try {
                    const fxClient = supabase.from('foreign_transactions');
                    if (fxClient && typeof fxClient.select === 'function') {
                        const res = await fxClient.select('*').in('student_id', sidVariants);
                        if (!res?.error && Array.isArray(res?.data)) return res.data;
                    }
                } catch (_e) { /* offline / unmigrated fallback */ }
                return [];
            })();
            const [st, fetchedTxs, fetchedForeign] = await Promise.all([
                cachedSt
                    ? Promise.resolve(cachedSt)
                    : supabase.from('student_master').select('*').in('student_id', sidVariants).limit(1).then(res => (res.data && res.data[0]) || null),
                fetchAll('transactions', profileTxCols, q => q.in('student_id', sidVariants), 'id'),
                foreignPromise
            ]);

            // Merge cloud & local Foreign Transactions matching this Student ID
            const fxByRef = new Map();
            (this.foreignTransactions || [])
                .map((r, i) => this.normalizeForeignTransactionRow(r, i))
                .filter(r => sidVariants.includes(String(r.student_id || '').trim()))
                .forEach(r => fxByRef.set(r.reference_number, r));
            (fetchedForeign || [])
                .map((r, i) => this.normalizeForeignTransactionRow(r, i))
                .filter(r => sidVariants.includes(String(r.student_id || '').trim()))
                .forEach(r => fxByRef.set(r.reference_number, r));
            const studentForeignTxs = [...fxByRef.values()].map(r => {
                const pDate = toDateOnly(r.value_date || r.payment_date || r.transaction_date);
                const usdAmt = Number(r.amount ?? r.item_price) || 0;
                const fx = convertUsdToEgp(usdAmt, pDate, this.fxStore);
                return {
                    ...r,
                    payment_date: pDate,
                    item_name: r.description || r.item_name || 'Cash Deposit',
                    item_price: fx.rate > 0 ? fx.egpAmount : usdAmt,
                    raw_usd: usdAmt,
                    currency: r.currency || 'USD',
                    is_settled: true
                };
            });

            this.currentProfileStudent = st;
            const txs = [...(fetchedTxs || []), ...studentForeignTxs].sort((a, b) => {
                const da = toDateOnly(a.payment_date) || '';
                const db = toDateOnly(b.payment_date) || '';
                if (da !== db) return db.localeCompare(da);
                return (b.id || 0) - (a.id || 0);
            });
            this.currentProfileTransactions = txs;

            let totalPaid = 0;
            txs.forEach(t => {
                totalPaid += parseFloat(t.item_price || 0) || 0;
            });
            const latestDate = txs.length > 0 ? (toDateOnly(txs[0].payment_date) || '-') : 'No payments';

            const headerEl = document.getElementById('student-profile-header');
            if (headerEl) {
                const name = st?.full_name || 'Student Record';
                const arabicName = st?.arabic_name || '';
                const college = st?.college || '';
                const program = st?.program || '';
                const { nuEmail: email, personalEmail } = getStudentDisplayEmails(st);
                const mobile = st?.mobile || '';
                const natId = st?.national_id || '';
                const guardianName = st?.guardian_name || '';
                const guardianMobile = st?.guardian_mobile || '';
                const src = st?.source || 'Master';

                const initials = name
                    .split(/\s+/)
                    .filter(Boolean)
                    .slice(0, 2)
                    .map(w => w[0].toUpperCase())
                    .join('') || 'ST';

                const renderCopyableField = (val, label) => {
                    if (!val || val === '-') {
                        return `<span style="color: var(--text-muted); font-style: italic; font-size: 0.82rem;">Not provided</span>`;
                    }
                    return `
                        <button type="button" class="student-copy-chip" data-profile-copy="${escapeHTML(val)}" data-profile-copy-label="${escapeHTML(label)}" title="Click to copy ${escapeHTML(label)}">
                            <span style="font-weight: 600;">${escapeHTML(val)}</span>
                            <i data-lucide="copy" style="width: 12px; height: 12px; opacity: 0.75;"></i>
                        </button>
                    `;
                };

                headerEl.innerHTML = `
                    <div class="student-dossier-banner">
                        <div class="student-identity-main">
                            <div class="student-avatar-monogram">${escapeHTML(initials)}</div>
                            <div style="flex: 1; min-width: 220px;">
                                <div style="display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;">
                                    <h2 style="margin: 0; font-size: 1.4rem; font-weight: 700; color: var(--text-main); letter-spacing: -0.01em;">${escapeHTML(name)}</h2>
                                    ${this.renderStudentLevelBadge(st ? getStudentProgramLevel(st) : this.getStudentLevelBySid(sid))}
                                    <span class="badge" style="background: rgba(16,185,129,0.14); color: #10b981; font-size: 0.73rem; border: 1px solid rgba(16,185,129,0.28);">${escapeHTML(src)}</span>
                                </div>
                                ${arabicName ? `<div style="font-size: 0.96rem; color: var(--text-secondary); margin-top: 0.2rem; font-weight: 500;" dir="auto">${escapeHTML(arabicName)}</div>` : ''}

                                <!-- High-Visibility Copyable Student ID Bar -->
                                <div class="student-id-hero-bar">
                                    <button type="button" class="student-id-copy-pill" id="btn-copy-profile-sid" data-profile-copy="${escapeHTML(sid)}" data-profile-copy-label="Student ID" title="Click to copy Student ID (${escapeHTML(sid)})">
                                        <span class="sid-label">Student ID</span>
                                        <span class="sid-value">${escapeHTML(sid)}</span>
                                        <span class="sid-action" id="btn-copy-profile-sid-label">
                                            <i data-lucide="copy" style="width: 13px; height: 13px;"></i> Copy ID
                                        </span>
                                    </button>
                                    ${paddedErpSid && paddedErpSid !== String(sid).trim() ? `
                                        <button type="button" class="student-copy-chip" data-profile-copy="${escapeHTML(paddedErpSid)}" data-profile-copy-label="9-Digit ERP Account" title="Copy 9-digit zero-padded ERP Account number" style="padding: 0.35rem 0.65rem; font-family: monospace;">
                                            <span style="color: var(--text-muted); font-family: var(--font-family); font-size: 0.74rem;">ERP 9-Digit:</span>
                                            <strong>${escapeHTML(paddedErpSid)}</strong>
                                            <i data-lucide="copy" style="width: 12px; height: 12px; opacity: 0.75;"></i>
                                        </button>
                                    ` : ''}
                                    <button type="button" class="btn btn-outline btn-sm" id="btn-profile-view-in-tx" title="Filter Orders Transactions by this Student ID" style="padding: 0.35rem 0.65rem; font-size: 0.76rem; height: auto;">
                                        <i data-lucide="external-link" style="width: 12px; height: 12px;"></i> View in Transactions
                                    </button>
                                </div>
                            </div>
                        </div>

                        <!-- Right Financial KPI Strip -->
                        <div class="student-kpi-strip">
                            <div class="student-kpi-box" style="border-color: rgba(16, 185, 129, 0.3); background: rgba(16, 185, 129, 0.06);">
                                <div style="font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); font-weight: 700;">Total Paid</div>
                                <div style="font-size: 1.4rem; font-weight: 800; color: #10b981; font-family: 'JetBrains Mono', ui-monospace, monospace; margin-top: 0.15rem;">${formatMoney(totalPaid)} <span style="font-size: 0.82rem; font-weight: 600;">EGP</span></div>
                                <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 0.15rem;">${txs.length} transaction(s)</div>
                            </div>
                            <div class="student-kpi-box">
                                <div style="font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); font-weight: 700;">Latest Payment</div>
                                <div style="font-size: 0.98rem; font-weight: 700; color: var(--text-main); margin-top: 0.22rem; font-family: monospace;">${escapeHTML(latestDate)}</div>
                                <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 0.18rem;">${txs.length > 0 ? `EGP ${formatMoney(txs[0].item_price || 0)}` : 'No activity'}</div>
                            </div>
                        </div>
                    </div>

                    <!-- 4-Tile Structured Dossier Metadata Grid -->
                    <div class="student-dossier-grid">
                        <div class="student-dossier-tile">
                            <div class="student-dossier-tile-title">
                                <i data-lucide="graduation-cap" style="width: 14px; height: 14px; color: var(--primary);"></i> Academic Program
                            </div>
                            <div style="font-size: 0.85rem;">
                                <span style="color: var(--text-muted);">College:</span>
                                <strong style="color: var(--text-main); margin-left: 0.25rem;">${escapeHTML(college || '-')}</strong>
                            </div>
                            <div style="font-size: 0.83rem;">
                                <span style="color: var(--text-muted);">Program:</span>
                                <span style="color: var(--text-secondary); margin-left: 0.25rem;">${escapeHTML(program || '-')}</span>
                            </div>
                        </div>

                        <div class="student-dossier-tile">
                            <div class="student-dossier-tile-title">
                                <i data-lucide="phone" style="width: 14px; height: 14px; color: #10b981;"></i> Contact Details
                            </div>
                            <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: 0.84rem;">
                                <span style="color: var(--text-muted);">Mobile:</span>
                                ${renderCopyableField(mobile, 'Mobile Number')}
                            </div>
                            <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: 0.84rem;">
                                <span style="color: var(--text-muted);">NU Email:</span>
                                ${renderCopyableField(email, 'NU Email')}
                            </div>
                            <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: 0.84rem;">
                                <span style="color: var(--text-muted);">Personal Email:</span>
                                ${renderCopyableField(personalEmail, 'Personal Email')}
                            </div>
                        </div>

                        <div class="student-dossier-tile">
                            <div class="student-dossier-tile-title">
                                <i data-lucide="id-card" style="width: 14px; height: 14px; color: #38bdf8;"></i> Identity &amp; National ID
                            </div>
                            <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: 0.84rem;">
                                <span style="color: var(--text-muted);">National ID:</span>
                                ${renderCopyableField(natId, 'National ID')}
                            </div>
                            <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: 0.83rem;">
                                <span style="color: var(--text-muted);">ID Validation:</span>
                                <span class="badge ${validateID(paddedErpSid || sid) === 'Valid' ? 'valid' : 'error'}" style="font-size: 0.72rem;">${escapeHTML(validateID(paddedErpSid || sid))}</span>
                            </div>
                        </div>

                        <div class="student-dossier-tile">
                            <div class="student-dossier-tile-title">
                                <i data-lucide="users" style="width: 14px; height: 14px; color: #a855f7;"></i> Guardian Info
                            </div>
                            <div style="font-size: 0.84rem;">
                                <span style="color: var(--text-muted);">Name:</span>
                                <strong style="color: var(--text-main); margin-left: 0.25rem;">${escapeHTML(guardianName || '-')}</strong>
                            </div>
                            <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: 0.84rem;">
                                <span style="color: var(--text-muted);">Phone:</span>
                                ${renderCopyableField(guardianMobile, 'Guardian Mobile')}
                            </div>
                        </div>
                    </div>
                `;

                // Wire up all copyable chips & main Student ID pill inside the dossier header
                headerEl.querySelectorAll('[data-profile-copy]').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const val = btn.getAttribute('data-profile-copy');
                        const label = btn.getAttribute('data-profile-copy-label') || 'Value';
                        if (!val) return;
                        try {
                            await navigator.clipboard.writeText(val);
                            Toast.show(`${label} "${val}" copied to clipboard!`, 'success');
                            if (btn.id === 'btn-copy-profile-sid') {
                                btn.classList.add('copied');
                                const actionEl = document.getElementById('btn-copy-profile-sid-label');
                                if (actionEl) actionEl.innerHTML = '✓ Copied!';
                                setTimeout(() => {
                                    btn.classList.remove('copied');
                                    if (actionEl) {
                                        actionEl.innerHTML = '<i data-lucide="copy" style="width: 13px; height: 13px;"></i> Copy ID';
                                        if (window.lucide) lucide.createIcons({ root: actionEl });
                                    }
                                }, 1600);
                            }
                        } catch (_err) {
                            Toast.show(`Failed to copy ${label}`, 'error');
                        }
                    });
                });

                // Wire up "View in Transactions" shortcut
                document.getElementById('btn-profile-view-in-tx')?.addEventListener('click', () => {
                    const txNav = document.querySelector('.nav-link[data-tab="transactions"]');
                    const searchEl = document.getElementById('search-input');
                    if (searchEl) searchEl.value = String(sid).trim();
                    if (txNav) txNav.click();
                    this.currentPage = 1;
                    this.renderFilterChips('transactions');
                    this.loadTransactions();
                });

                if (window.lucide) lucide.createIcons({ root: headerEl });
            }

            if (!txs || txs.length === 0) {
                document.getElementById('student-ledger-body').innerHTML = `
                    <tr>
                        <td colspan="7" style="text-align: center; padding: 2.5rem 1rem; color: var(--text-muted);">
                            <div style="display: flex; flex-direction: column; align-items: center; gap: 0.45rem;">
                                <i data-lucide="inbox" style="width: 32px; height: 32px; opacity: 0.45;"></i>
                                <div style="font-weight: 600; color: var(--text-secondary);">No payments recorded for Student ID ${escapeHTML(sid)}</div>
                                <div style="font-size: 0.8rem;">Payments matching ${escapeHTML(sidVariants.join(' or '))} will appear here automatically.</div>
                            </div>
                        </td>
                    </tr>`;
                document.getElementById('student-summary-body').innerHTML = `
                    <tr>
                        <td colspan="3" style="text-align: center; padding: 2rem 1rem; color: var(--text-muted); font-size: 0.85rem;">
                            No payment categories yet
                        </td>
                    </tr>`;
                if (window.lucide) lucide.createIcons({ root: document.getElementById('student-ledger-body') });
                return;
            }

            const ledgerBody = document.getElementById('student-ledger-body');
            ledgerBody.innerHTML = txs.map((t, idx) => {
                const bankName = t.bank || t.bank_Style || '-';
                const refNum = t.reference_number || '-';
                return `
                <tr>
                    <td style="white-space: nowrap; font-family: monospace; font-size: 0.83rem;">${escapeHTML(toDateOnly(t.payment_date) || '-')}</td>
                    <td style="white-space: nowrap;">
                        <div style="display: inline-flex; align-items: center; gap: 0.35rem;">
                            <a href="#" class="student-ledger-ref-link" data-idx="${idx}" style="font-family: 'JetBrains Mono', ui-monospace, monospace; font-weight: 700; color: var(--primary); text-decoration: none;" title="Click to inspect transaction details">
                                ${escapeHTML(refNum)}
                            </a>
                            ${t.reference_number ? `
                            <button type="button" class="btn-icon student-ledger-copy-ref" data-ref="${escapeHTML(t.reference_number)}" title="Copy Reference Number" style="padding: 2px; width: 20px; height: 20px; opacity: 0.65;">
                                <i data-lucide="copy" style="width: 11px; height: 11px;"></i>
                            </button>` : ''}
                        </div>
                    </td>
                    <td style="max-width: 240px; white-space: normal; font-size: 0.84rem;">${escapeHTML(t.item_name || '-')}</td>
                    <td><span class="badge" style="background: rgba(56, 189, 248, 0.12); color: var(--primary); font-size: 0.74rem;">${escapeHTML(t.mapping || 'Unmapped')}</span></td>
                    <td style="font-size: 0.82rem; color: var(--text-secondary);">${escapeHTML(t.second_mapping || '-')}</td>
                    <td style="font-size: 0.82rem;">${escapeHTML(bankName)}</td>
                    <td style="text-align: right; font-weight: 700; font-family: 'JetBrains Mono', ui-monospace, monospace; white-space: nowrap;">${isSameDaySettlementBank(t) ? `USD ${formatMoney(t.raw_usd ?? t.amount ?? 0)} <span style="font-size: 0.72rem; color: var(--text-muted);">(≈ EGP ${formatMoney(t.item_price || 0)})</span>` : formatMoney(t.item_price || 0)}</td>
                </tr>
            `;
            }).join('');

            ledgerBody.querySelectorAll('.student-ledger-ref-link').forEach(link => {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    const idx = parseInt(link.getAttribute('data-idx'), 10);
                    const tx = this.currentProfileTransactions[idx];
                    if (tx && typeof this.openTransactionDetailsModal === 'function') {
                        this.openTransactionDetailsModal(tx);
                    }
                });
            });

            ledgerBody.querySelectorAll('.student-ledger-copy-ref').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const ref = btn.getAttribute('data-ref');
                    if (!ref) return;
                    try {
                        await navigator.clipboard.writeText(ref);
                        Toast.show(`Reference "${ref}" copied!`, 'success');
                    } catch (_err) {
                        Toast.show('Failed to copy reference', 'error');
                    }
                });
            });
            if (window.lucide) lucide.createIcons({ root: ledgerBody });

            // Calculate Summary Grouped by Mapping (sorted highest amount first)
            const summary = {};
            let total = 0;
            txs.forEach(t => {
                const mapKey = t.mapping || 'Unmapped';
                const amt = parseFloat(t.item_price || 0) || 0;
                if (!summary[mapKey]) summary[mapKey] = { count: 0, amount: 0 };
                summary[mapKey].count += 1;
                summary[mapKey].amount += amt;
                total += amt;
            });

            const sortedCategories = Object.keys(summary).sort((a, b) => summary[b].amount - summary[a].amount);
            const summaryHtml = sortedCategories.map(k => {
                const pct = total > 0 ? Math.min(100, Math.round((summary[k].amount / total) * 100)) : 0;
                return `
                <tr>
                    <td>
                        <div style="font-weight: 600; color: var(--text-main);">${escapeHTML(k)}</div>
                        <div style="width: 100%; height: 4px; background: rgba(255,255,255,0.06); border-radius: 999px; margin-top: 4px; overflow: hidden;">
                            <div style="width: ${pct}%; height: 100%; background: var(--primary); border-radius: 999px;"></div>
                        </div>
                    </td>
                    <td style="text-align: center; font-weight: 600;">${summary[k].count}</td>
                    <td style="text-align: right; font-weight: 600; font-family: 'JetBrains Mono', ui-monospace, monospace; white-space: nowrap;">
                        ${formatMoney(summary[k].amount)}
                        <div style="font-size: 0.7rem; color: var(--text-muted); font-weight: 400;">${pct}%</div>
                    </td>
                </tr>
            `;
            }).join('');
            
            document.getElementById('student-summary-body').innerHTML = summaryHtml + `
                <tr style="background-color: var(--bg-secondary);">
                    <td><strong>Grand Total</strong></td>
                    <td style="text-align: center;"><strong>${txs.length}</strong></td>
                    <td style="text-align: right; font-size: 1rem; font-weight: 800; color: #10b981; font-family: 'JetBrains Mono', ui-monospace, monospace; white-space: nowrap;">${formatMoney(total)} EGP</td>
                </tr>
            `;

        } catch (err) {
            Toast.show('Error loading profile: ' + err.message, 'error');
            document.getElementById('inline-student-profile')?.classList.add('hidden');
            document.getElementById('student-directory-view')?.classList.remove('hidden');
        }
    }

    exportStudentStatement() {
        if (!this.currentProfileSid) {
            Toast.show('Select a student first to export their statement.', 'warning');
            return;
        }
        const st = this.currentProfileStudent || {};
        const txs = this.currentProfileTransactions || [];
        const sid = this.currentProfileSid;
        const studentLevelTag = formatStudentLevelTag(st.student_id || st.program !== undefined ? getStudentProgramLevel(st) : this.getStudentLevelBySid(sid));

        const ledgerRows = txs.map(t => ({
            'Payment Date': toDateOnly(t.payment_date) || '',
            'Reference Number': t.reference_number || '',
            'Student ID': t.student_id || sid,
            'Level': studentLevelTag || formatStudentLevelTag(this.getTransactionStudentLevel(t)),
            'Student Name': t.full_name || st.full_name || '',
            'Item Name': t.item_name || '',
            'Mapping': t.mapping || 'Unmapped',
            '2nd Mapping': t.second_mapping || '',
            'Bank': t.bank || t.bank_Style || '',
            'Amount (EGP)': Number(parseFloat(t.item_price || 0).toFixed(2))
        }));

        const summaryMap = {};
        let grandTotal = 0;
        txs.forEach(t => {
            const k = t.mapping || 'Unmapped';
            const amt = parseFloat(t.item_price || 0) || 0;
            if (!summaryMap[k]) summaryMap[k] = { count: 0, total: 0 };
            summaryMap[k].count++;
            summaryMap[k].total += amt;
            grandTotal += amt;
        });

        const summaryRows = Object.keys(summaryMap).sort().map(k => ({
            'Mapping Category': k,
            'Transactions': summaryMap[k].count,
            'Total Amount (EGP)': Number(summaryMap[k].total.toFixed(2))
        }));
        summaryRows.push({
            'Mapping Category': 'Grand Total',
            'Transactions': txs.length,
            'Total Amount (EGP)': Number(grandTotal.toFixed(2))
        });

        const { nuEmail, personalEmail } = getStudentDisplayEmails(st);
        const profileRows = [
            { 'Field': 'Student ID', 'Value': sid },
            { 'Field': 'Level', 'Value': studentLevelTag || '-' },
            { 'Field': 'Full Name', 'Value': st.full_name || '-' },
            { 'Field': 'Arabic Name', 'Value': st.arabic_name || '-' },
            { 'Field': 'College', 'Value': st.college || '-' },
            { 'Field': 'Program', 'Value': st.program || '-' },
            { 'Field': 'NU Email', 'Value': nuEmail || '-' },
            { 'Field': 'Personal Email', 'Value': personalEmail || '-' },
            { 'Field': 'Mobile', 'Value': st.mobile || '-' },
            { 'Field': 'National ID', 'Value': st.national_id || '-' },
            { 'Field': 'Total Transactions', 'Value': txs.length },
            { 'Field': 'Total Paid (EGP)', 'Value': Number(grandTotal.toFixed(2)) },
            { 'Field': 'Statement Generated On', 'Value': new Date().toLocaleString() }
        ];

        const wb = XLSX.utils.book_new();
        const safeLedger = sanitizeExcelRows(ledgerRows);
        const wsLedger = XLSX.utils.json_to_sheet(safeLedger.length ? safeLedger : [{ 'Note': 'No payments recorded for this student' }]);
        wsLedger['!cols'] = [
            { wch: 14 }, { wch: 18 }, { wch: 14 }, { wch: 26 },
            { wch: 32 }, { wch: 22 }, { wch: 20 }, { wch: 16 },
            { wch: 16 }
        ];
        const wsSummary = XLSX.utils.json_to_sheet(sanitizeExcelRows(summaryRows));
        wsSummary['!cols'] = [{ wch: 28 }, { wch: 14 }, { wch: 20 }];
        const wsProfile = XLSX.utils.json_to_sheet(sanitizeExcelRows(profileRows));
        wsProfile['!cols'] = [{ wch: 24 }, { wch: 36 }];

        XLSX.utils.book_append_sheet(wb, wsLedger, 'Statement of Payments');
        XLSX.utils.book_append_sheet(wb, wsSummary, 'Category Summary');
        XLSX.utils.book_append_sheet(wb, wsProfile, 'Student Profile');
        writeCompressedExcel(wb, `Student_Statement_${sid}_${toDateOnly(new Date())}.xlsx`);
        Toast.show(`Exported statement for ${sid}`, 'success');
    }
}

export function applyStudentsUiMixin(AppClass) {
    for (const name of Object.getOwnPropertyNames(StudentsUiMixin.prototype)) {
        if (name !== 'constructor') {
            Object.defineProperty(AppClass.prototype, name, Object.getOwnPropertyDescriptor(StudentsUiMixin.prototype, name));
        }
    }
}
