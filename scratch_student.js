    initStudentMaster() {
        const tabBtns = document.querySelectorAll('.student-tab-btn');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                tabBtns.forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.student-tab-content').forEach(c => c.style.display = 'none');
                btn.classList.add('active');
                document.getElementById(btn.dataset.target).style.display = 'block';
                document.getElementById(btn.dataset.target).classList.add('active');
            });
        });

        const btnSearch = document.getElementById('btn-search-students');
        if (btnSearch) {
            btnSearch.addEventListener('click', async () => {
                const term = document.getElementById('student-search-input').value.trim();
                if (!term) return;
                
                try {
                    const { data, error } = await supabase
                        .from('student_master')
                        .select('*')
                        .or(`student_id.ilike.%${term}%,full_name.ilike.%${term}%,mobile.ilike.%${term}%,email.ilike.%${term}%`)
                        .limit(50);
                        
                    if (error) throw error;
                    
                    const tbody = document.getElementById('students-table-body');
                    tbody.innerHTML = data.map(s => `
                        <tr>
                            <td>${s.student_id || ''}</td>
                            <td>${s.full_name || ''}</td>
                            <td>${s.email || ''}</td>
                            <td>${s.mobile || ''}</td>
                            <td>${s.college || ''}</td>
                            <td>${s.program || ''}</td>
                        </tr>
                    `).join('');
                } catch(err) {
                    console.error("Lookup error:", err);
                }
            });
        }
        
        const btnExport = document.getElementById('btn-export-students');
        if (btnExport) {
            btnExport.addEventListener('click', async () => {
                try {
                    btnExport.innerText = 'Exporting...';
                    const { data, error } = await supabase.from('student_master').select('*');
                    if (error) throw error;
                    
                    if (data && data.length > 0) {
                        const csv = Papa.unparse(data);
                        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                        const link = document.createElement('a');
                        link.href = URL.createObjectURL(blob);
                        link.download = `Student_Master.csv`;
                        link.click();
                    }
                } catch(err) {
                    alert('Export failed: ' + err.message);
                } finally {
                    btnExport.innerHTML = '<i data-lucide="download"></i> Export Master List';
                    lucide.createIcons();
                }
            });
        }

        const dropZone = document.getElementById('student-upload-zone');
        const fileInput = document.getElementById('student-file-input');
        
        if (dropZone && fileInput) {
            dropZone.addEventListener('click', () => fileInput.click());
            dropZone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropZone.style.borderColor = 'var(--primary-color)';
                dropZone.style.backgroundColor = 'rgba(59, 130, 246, 0.05)';
            });
            dropZone.addEventListener('dragleave', (e) => {
                e.preventDefault();
                dropZone.style.borderColor = 'var(--border-color)';
                dropZone.style.backgroundColor = 'transparent';
            });
            dropZone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropZone.style.borderColor = 'var(--border-color)';
                dropZone.style.backgroundColor = 'transparent';
                if (e.dataTransfer.files.length) {
                    this.handleStudentExcelUpload(e.dataTransfer.files[0]);
                }
            });
            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length) {
                    this.handleStudentExcelUpload(e.target.files[0]);
                }
            });
        }
        
        const btnRunMatcher = document.getElementById('btn-run-automatcher');
        if (btnRunMatcher) {
            btnRunMatcher.addEventListener('click', () => this.runAutoMatcher());
        }
        const selectAllMatcher = document.getElementById('automatcher-select-all');
        if(selectAllMatcher) {
            selectAllMatcher.addEventListener('change', (e) => {
                document.querySelectorAll('.automatch-checkbox').forEach(cb => cb.checked = e.target.checked);
            });
        }
        const btnApplyMatch = document.getElementById('btn-apply-automatch-fixes');
        if(btnApplyMatch) {
            btnApplyMatch.addEventListener('click', () => this.applyAutoMatches());
        }
    }
    
    loadStudentMaster() {
        lucide.createIcons();
    }

    async handleStudentExcelUpload(file) {
        const status = document.getElementById('student-upload-status');
        status.style.display = 'block';
        status.className = 'alert alert-info';
        status.innerHTML = `<i data-lucide="loader" class="spin"></i> Parsing Excel file...`;
        lucide.createIcons();

        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
            
            if (!rows || rows.length === 0) throw new Error("File is empty.");

            let headers = rows[0];
            let dataRows = rows.slice(1);

            if (!headers.includes('Student ID') && !headers.includes('PEOPLE_ID1')) {
                if (rows.length > 1 && rows[1].includes('Student ID')) {
                    headers = rows[1];
                    dataRows = rows.slice(2);
                }
            }

            const headerMap = {};
            headers.forEach((h, i) => { if (h) headerMap[h.toString().trim()] = i; });

            status.innerHTML = `<i data-lucide="loader" class="spin"></i> Preparing data for upload...`;
            
            const records = [];
            for (const row of dataRows) {
                if (!row || row.length === 0) continue;
                
                const cleanPhone = (val) => val ? String(val).replace(/\s+/g, '').trim() : null;

                let student_id, full_name, arabic_name, national_id, email, mobile, guardian_name, guardian_mobile, college, program, source;

                if ('PEOPLE_ID1' in headerMap) {
                    student_id = String(row[headerMap['PEOPLE_ID1']] || '').trim();
                    full_name = row[headerMap['Full name']] || row[headerMap['FIRST_NAME1']] || '';
                    arabic_name = row[headerMap['ARABICNAME']];
                    national_id = row[headerMap['GOVERNMENT_ID1']];
                    email = row[headerMap['personalEmail']] || row[headerMap['Email1']];
                    mobile = cleanPhone(row[headerMap['PhoneNumber1']]);
                    guardian_name = row[headerMap['Guardian_NAME']];
                    guardian_mobile = cleanPhone(row[headerMap['Guardian_Mobile']]);
                    college = row[headerMap['University1']];
                    program = row[headerMap['PROGRAM1']];
                    source = 'ApplicantReport';
                } else if ('Student ID' in headerMap) {
                    student_id = String(row[headerMap['Student ID']] || '').trim();
                    full_name = row[headerMap['Student Name']];
                    email = row[headerMap['Email']];
                    mobile = cleanPhone(row[headerMap['Mobile Phone Number']]);
                    college = row[headerMap['College']];
                    program = row[headerMap['Program']];
                    source = 'StudentDetails';
                } else {
                    throw new Error("Unrecognized Excel format.");
                }

                if (student_id) {
                    records.push({
                        student_id, full_name, arabic_name, national_id, email, mobile, guardian_name, guardian_mobile, college, program, source
                    });
                }
            }

            status.innerHTML = `<i data-lucide="loader" class="spin"></i> Uploading ${records.length} records to database...`;
            
            for (let i = 0; i < records.length; i += 1000) {
                const batch = records.slice(i, i + 1000);
                const { error } = await supabase.from('student_master').upsert(batch);
                if (error) throw error;
                status.innerHTML = `<i data-lucide="loader" class="spin"></i> Uploading... ${Math.round((i/records.length)*100)}%`;
            }

            status.className = 'alert alert-success';
            status.innerHTML = `<i data-lucide="check-circle"></i> Successfully imported ${records.length} students!`;
            lucide.createIcons();

        } catch (err) {
            status.className = 'alert alert-danger';
            status.innerHTML = `<i data-lucide="alert-triangle"></i> Error: ${err.message}`;
            lucide.createIcons();
            console.error(err);
        }
    }

    async runAutoMatcher() {
        const btn = document.getElementById('btn-run-automatcher');
        const tbody = document.getElementById('automatcher-table-body');
        const btnApply = document.getElementById('btn-apply-automatch-fixes');
        
        btn.innerHTML = `<i data-lucide="loader" class="spin"></i> Matching...`;
        btn.disabled = true;
        lucide.createIcons();

        try {
            const { data: invalidTx, error: err1 } = await supabase
                .from('transactions')
                .select('*')
                .eq('id_status', 'Invalid ID');
            if (err1) throw err1;

            if (!invalidTx || invalidTx.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center">No invalid IDs found.</td></tr>';
                btnApply.style.display = 'none';
                return;
            }

            const { data: linksData, error: err2 } = await supabase.from('links').select('*');
            if (err2) throw err2;
            const linksMap = {};
            linksData.forEach(l => { linksMap[l.reference_number] = l; });

            const { data: students, error: err3 } = await supabase.from('student_master').select('*');
            if (err3) throw err3;

            this.automatchProposals = [];
            let html = '';

            for (const tx of invalidTx) {
                const link = linksMap[tx.reference_number];
                let proposedStudent = null;
                let matchReason = '';

                if (link && !proposedStudent) {
                    const lEmail = link.email ? link.email.trim().toLowerCase() : null;
                    const lMobile = link.mobile ? String(link.mobile).replace(/\s+/g, '') : null;
                    
                    proposedStudent = students.find(s => 
                        (lEmail && s.email && s.email.toLowerCase() === lEmail) ||
                        (lMobile && s.mobile && s.mobile === lMobile) ||
                        (lMobile && s.guardian_mobile && s.guardian_mobile === lMobile)
                    );
                    if (proposedStudent) matchReason = 'Exact match (Links Data)';
                }

                if (!proposedStudent) {
                    const searchNames = [];
                    if (tx.item_name) searchNames.push(tx.item_name.toLowerCase());
                    if (link && link.student_name) searchNames.push(link.student_name.toLowerCase());

                    for (const s of students) {
                        const sName = s.full_name ? s.full_name.toLowerCase() : '';
                        const gName = s.guardian_name ? s.guardian_name.toLowerCase() : '';
                        
                        for (const n of searchNames) {
                            if (sName && sName.length > 5 && n.includes(sName)) {
                                proposedStudent = s; matchReason = 'Fuzzy Name Match'; break;
                            }
                            if (gName && gName.length > 5 && n.includes(gName)) {
                                proposedStudent = s; matchReason = 'Fuzzy Guardian Match'; break;
                            }
                        }
                        if (proposedStudent) break;
                    }
                }

                if (proposedStudent) {
                    this.automatchProposals.push({
                        tx_id: tx.id,
                        student_id: proposedStudent.student_id,
                        student_name: proposedStudent.full_name,
                        reason: matchReason
                    });

                    html += `
                        <tr>
                            <td><input type="checkbox" class="automatch-checkbox" value="${tx.id}" checked></td>
                            <td>${tx.reference_number}</td>
                            <td>${tx.payment_date}</td>
                            <td>${tx.bank}</td>
                            <td>${tx.item_name}</td>
                            <td>${formatMoney(tx.item_price)}</td>
                            <td>
                                <span class="status-badge valid-id">Matched: ${proposedStudent.student_id}</span>
                                <br><small class="text-muted">${proposedStudent.full_name} (${matchReason})</small>
                            </td>
                        </tr>
                    `;
                } else {
                    html += `
                        <tr style="opacity: 0.6;">
                            <td><input type="checkbox" disabled></td>
                            <td>${tx.reference_number}</td>
                            <td>${tx.payment_date}</td>
                            <td>${tx.bank}</td>
                            <td>${tx.item_name}</td>
                            <td>${formatMoney(tx.item_price)}</td>
                            <td><span class="status-badge invalid-id">No Match Found</span></td>
                        </tr>
                    `;
                }
            }

            tbody.innerHTML = html || '<tr><td colspan="7" class="text-center">No proposals could be made.</td></tr>';
            btnApply.style.display = html ? 'inline-block' : 'none';

        } catch (err) {
            alert('Matcher Error: ' + err.message);
        } finally {
            btn.innerHTML = `<i data-lucide="zap"></i> Run Auto-Match`;
            btn.disabled = false;
            lucide.createIcons();
        }
    }

    async applyAutoMatches() {
        const checkboxes = document.querySelectorAll('.automatch-checkbox:checked');
        if (checkboxes.length === 0) {
            alert('Please select at least one proposed match to apply.');
            return;
        }

        const btn = document.getElementById('btn-apply-automatch-fixes');
        btn.innerText = 'Applying...';
        btn.disabled = true;

        try {
            for (const cb of checkboxes) {
                const tx_id = parseInt(cb.value);
                const proposal = this.automatchProposals.find(p => p.tx_id === tx_id);
                if (proposal) {
                    await supabase
                        .from('transactions')
                        .update({ 
                            student_id: proposal.student_id,
                            id_status: 'Valid ID'
                        })
                        .eq('id', tx_id);
                }
            }

            alert(`Successfully applied ${checkboxes.length} fixes!`);
            this.runAutoMatcher();
            this.loadDashboard();
        } catch(err) {
            alert('Error applying fixes: ' + err.message);
        } finally {
            btn.innerText = 'Apply Selected Fixes';
            btn.disabled = false;
        }
    }
