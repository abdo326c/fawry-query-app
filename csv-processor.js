import { supabase } from './supabase.js';
import {
    validateID as sharedValidateID,
    applyBusinessRules,
    buildMappingLookup,
    fetchAll,
    fetchByIn,
    escapeHTML
} from './rules.js';

export class FawryProcessor {
    constructor(userEmail = 'System') {
        this.userEmail = userEmail;
        this.mappings = [];
        this.fixes = [];
        this.skippedTransactions = [];
        this.tuiList = [
            "Eng EGP New ST 2025", "ITCS25 EGP New St 2025", "BBA25 EGP New St 2025", 
            "BioTech25 EGP New St 2025", "Egyptian IT&CS Fees CONT 2024", 
            "Egyptian BBA Fees CONT 2024", "Egyptian Bio-Tech Fees Cont 2024", 
            "Egyptian ENGR Fees2024", "Egyptian ENGR Fees Cont. 2023", 
            "Egyptian BBA Fees Cont. 2023", "Egyptian ENGR Fees Cont.", 
            "Egyptian IT&CS Fees Cont. 2023", "Egyptian Bio-Tech Fees Cont. 2023", 
            "Egyptian IT&CS Fees Cont.", "Egyptian Bio-Tech Fees Cont.", 
            "Egyptian BBA Fees Cont."
        ];
    }

    async loadConfig() {
        // Load ALL mappings and fixes (paginated – Supabase returns max 1,000 rows per request)
        try {
            this.mappings = await fetchAll('item_mappings', '*', null, 'item_name');
        } catch (err) {
            this.mappings = [];
            this.hasErrors = true;
            this.log(`Error: Failed to load item mappings: ${err.message}`);
        }
        try {
            this.fixes = await fetchAll('manual_fixes', '*', null, 'reference_number');
        } catch (err) {
            this.fixes = [];
            this.hasErrors = true;
            this.log(`Error: Failed to load manual fixes: ${err.message}`);
        }
    }

    log(msg) {
        const consoleEl = document.getElementById('import-log');
        if (consoleEl) {
            const div = document.createElement('div');
            
            let type = 'info';
            let icon = 'info';
            if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
                type = 'error';
                icon = 'alert-circle';
            } else if (msg.toLowerCase().includes('success') || msg.toLowerCase().includes('completed')) {
                type = 'success';
                icon = 'check-circle';
            }

            div.className = `log-entry log-${type}`;
            div.innerHTML = `
                <div class="log-time">${new Date().toLocaleTimeString()}</div>
                <div class="log-content">
                    <i data-lucide="${icon}" style="width: 16px; height: 16px;"></i>
                    <span>${escapeHTML(msg)}</span>
                </div>
            `;
            
            consoleEl.appendChild(div);
            if (window.lucide) lucide.createIcons({ root: div });
            consoleEl.scrollTop = consoleEl.scrollHeight;
        }
        console.log(msg);
    }

    getVal(row, keyStr) {
        const exact = row[keyStr];
        if (exact !== undefined && exact !== "") return exact;
        const normalize = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
        const target = normalize(keyStr);
        const foundKey = Object.keys(row).find(k => normalize(k) === target);
        return foundKey ? row[foundKey] : null;
    }

    parseAmount(val) {
        if (val === null || val === undefined || val === '') return 0;
        // Strip out currencies (like EGP), commas, and spaces, keeping only numbers, decimal, and minus sign
        const cleaned = String(val).replace(/[^\d.-]/g, '');
        const parsed = parseFloat(cleaned);
        return isNaN(parsed) ? 0 : parsed;
    }

    parsePaymentDate(rawDate) {
        if (rawDate === null || rawDate === undefined || rawDate === '') return null;

        // 1. If it's a JavaScript Date object
        if (rawDate instanceof Date && !isNaN(rawDate)) {
            const y = rawDate.getFullYear();
            const m = String(rawDate.getMonth() + 1).padStart(2, '0');
            const d = String(rawDate.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        }

        // 2. If it's an Excel numeric serial date (e.g. 45562)
        if (typeof rawDate === 'number') {
            if (typeof XLSX !== 'undefined' && XLSX.SSF) {
                const parsed = XLSX.SSF.parse_date_code(rawDate);
                if (parsed && parsed.y && parsed.m && parsed.d) {
                    return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
                }
            }
            const dateObj = new Date(Math.round((rawDate - 25569) * 86400 * 1000));
            if (!isNaN(dateObj.getTime())) {
                return dateObj.toISOString().split('T')[0];
            }
        }

        // 3. String date parsing
        const str = String(rawDate).trim();
        if (!str) return null;

        // Take date portion before whitespace or ISO delimiter
        const datePart = str.split(' ')[0].split('T')[0];

        // Find separator ('/' or '-' or '.')
        const separator = datePart.includes('/') ? '/' : (datePart.includes('-') ? '-' : (datePart.includes('.') ? '.' : null));
        if (separator) {
            const parts = datePart.split(separator);
            if (parts.length === 3) {
                // Case 1: Year is at the beginning (e.g. YYYY-MM-DD, YYYY-DD-MM, YYYY/MM/DD)
                if (parts[0].length === 4) {
                    const year = parts[0];
                    const p1 = parseInt(parts[1], 10);
                    const p2 = parseInt(parts[2], 10);
                    let month = p1;
                    let day = p2;

                    // If p1 > 12, p1 cannot be a month -> p1 is Day, p2 is Month.
                    if (p1 > 12 && p2 <= 12) {
                        day = p1;
                        month = p2;
                    }

                    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
                        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    }
                } 
                // Case 2: 4-digit year is at the end (e.g. DD/MM/YYYY or MM/DD/YYYY)
                else if (parts[2].length === 4) {
                    const year = parseInt(parts[2], 10);
                    const first = parseInt(parts[0], 10);
                    const second = parseInt(parts[1], 10);
                    let day = first;
                    let month = second;

                    // Standard Fawry format is DD/MM/YYYY.
                    // If first > 12, first CANNOT be a month -> first is Day, second is Month.
                    // If second > 12, second CANNOT be a month -> second is Day, first is Month (Excel MM/DD/YYYY).
                    // If both <= 12, default to Fawry standard DD/MM/YYYY (first is Day, second is Month).
                    if (first > 12 && second <= 12) {
                        day = first;
                        month = second;
                    } else if (second > 12 && first <= 12) {
                        day = second;
                        month = first;
                    } else {
                        day = first;
                        month = second;
                    }

                    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
                        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    }
                }
                // Case 3: 2-digit year is at the end (e.g. DD/MM/YY or MM/DD/YY)
                else if (parts[2].length === 2) {
                    const yy = parseInt(parts[2], 10);
                    const year = yy < 70 ? 2000 + yy : 1900 + yy;
                    const first = parseInt(parts[0], 10);
                    const second = parseInt(parts[1], 10);
                    let day = first;
                    let month = second;

                    if (second > 12 && first <= 12) {
                        day = second;
                        month = first;
                    } else {
                        day = first;
                        month = second;
                    }

                    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
                        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    }
                }
            }
        }

        // 4. Catch string numeric Excel dates before native fallback parses them as year 40000+
        if (/^\d{4,5}(\.\d+)?$/.test(str)) {
            const numericDate = parseFloat(str);
            if (typeof XLSX !== 'undefined' && XLSX.SSF) {
                const parsed = XLSX.SSF.parse_date_code(numericDate);
                if (parsed && parsed.y && parsed.m && parsed.d) {
                    return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
                }
            }
            const dateObj = new Date(Math.round((numericDate - 25569) * 86400 * 1000));
            if (!isNaN(dateObj.getTime())) {
                return dateObj.toISOString().split('T')[0];
            }
        }

        // Fallback: try native Date parsing
        const parsed = new Date(str);
        if (!isNaN(parsed.getTime())) {
            const y = parsed.getFullYear();
            const m = String(parsed.getMonth() + 1).padStart(2, '0');
            const d = String(parsed.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        }

        return null;
    }

    async processFiles(files) {
        this.log(`Starting import for ${files.length} files...`);
        this.hasErrors = false;
        this.skippedTransactions = [];
        await this.loadConfig();
        if (this.hasErrors) {
            this.log(`Import stopped: rules could not be loaded, so imported data would be incomplete.`);
            return false;
        }

        // Separate Links files from Order files
        const linkFiles = [];
        const orderFiles = [];

        for (const file of files) {
            const fileName = file.name.toLowerCase();
            
            if (fileName.endsWith('.csv')) {
                let text = await file.text();
                // Strip BOM (Byte Order Mark) if present (Excel often adds this)
                if (text.charCodeAt(0) === 0xFEFF) {
                    text = text.slice(1);
                }
                const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                
                const firstLine = normalizedText.split('\n')[0].toLowerCase().replace(/[^a-z0-9,]/g, '');
                if (firstLine.includes('invoicenumber') || firstLine.includes('custominputvalue')) {
                    linkFiles.push({ file, type: 'csv', data: normalizedText });
                } else if (firstLine.includes('referencenumber') || firstLine.includes('fawryfees')) {
                    orderFiles.push({ file, type: 'csv', data: normalizedText });
                } else {
                    this.log(`Skipping unknown CSV format: ${file.name}`);
                }
            } 
            // For Excel files
            else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
                const buffer = await file.arrayBuffer();
                const workbook = XLSX.read(buffer, { type: 'array' });
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];
                const json = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
                
                if (json.length > 0) {
                    const firstRow = json[0];
                    // Check keys for identifier
                    const keys = Object.keys(firstRow).map(k => String(k).toLowerCase().replace(/[^a-z0-9]/g, ''));
                    
                    if (keys.some(k => k.includes('invoicenumber') || k.includes('custominputvalue'))) {
                        linkFiles.push({ file, type: 'json', data: json });
                    } else if (keys.some(k => k.includes('referencenumber') || k.includes('fawryfees'))) {
                        orderFiles.push({ file, type: 'json', data: json });
                    } else {
                        this.log(`Skipping unknown Excel format: ${file.name}`);
                    }
                }
            } else {
                this.log(`Skipping unsupported file type: ${file.name}`);
            }
        }

        let hasErrors = false;

        // Process Links first
        for (const item of linkFiles) {
            this.log(`Parsing Links file: ${item.file.name}`);
            const ok = await this.processLinks(item);
            if (ok === false) hasErrors = true;
        }

        // Process Orders
        for (const item of orderFiles) {
            this.log(`Parsing Orders file: ${item.file.name}`);
            const ok = await this.processOrders(item);
            if (ok === false) hasErrors = true;
        }
        
        if (hasErrors || this.hasErrors) {
            this.log(`Import failed or finished with errors. Please check the logs above.`);
            return false;
        } else {
            this.log(`Import completed successfully!`);
            return true;
        }
    }

    async processLinks(item) {
        return new Promise((resolve) => {
            const processData = async (data) => {
                let uniqueLinks = [];
                try {
                    const links = data.map(row => {
                        const ref = this.getVal(row, 'PAYMENT REFERENCE NUMBER') || this.getVal(row, 'REFERENCE NUMBER') || this.getVal(row, 'BANK TRANSACTION ID');
                        return {
                            invoice_number: this.getVal(row, 'INVOICE NUMBER'),
                            customer_name: this.getVal(row, 'CUSTOMER NAME'),
                            customer_mobile: this.getVal(row, 'CUSTOMER MOBILE NUMBER'),
                            customer_email: this.getVal(row, 'CUSTOMER EMAIL'),
                            payment_status: this.getVal(row, 'PAYMENT STATUS'),
                            paid_amount: this.parseAmount(this.getVal(row, 'PAID AMOUNT')),
                            payment_reference_number: ref === null || ref === undefined ? '' : String(ref).trim(),
                            customer_national_id: this.getVal(row, 'CUSTOMER NATIONAL ID'),
                            custom_input_value: this.getVal(row, 'CUSTOM INPUT VALUE') || this.getVal(row, 'CUSTOMINPUTVALUE') || this.getVal(row, 'STUDENT ID') || this.getVal(row, 'CUSTOMER NATIONAL ID')
                        };
                    }).filter(r => r.payment_reference_number && r.payment_reference_number !== "null");

                    // Deduplicate (keep the last occurrence – usually the most recent export row)
                    const byRef = new Map();
                    for (const l of links) byRef.set(l.payment_reference_number, l);
                    uniqueLinks = Array.from(byRef.values());

                    this.log(`Found ${uniqueLinks.length} unique links. Saving to database...`);

                    // Upsert links
                    const chunkSize = 500;
                    let insertedCount = 0;
                    let lastError = null;
                    for (let i = 0; i < uniqueLinks.length; i += chunkSize) {
                        const chunk = uniqueLinks.slice(i, i + chunkSize);
                        const { error } = await supabase.from('links').upsert(chunk, { onConflict: 'payment_reference_number', ignoreDuplicates: false });
                        if (error) {
                            lastError = error.message;
                            this.log(`Error saving links: ${error.message}`);
                        } else {
                            insertedCount += chunk.length;
                        }
                    }

                    const { error: batchError } = await supabase.from('import_batches').insert({
                        user_email: this.userEmail,
                        file_name: item.file.name,
                        status: insertedCount === uniqueLinks.length ? 'success' : (insertedCount > 0 ? 'partial' : 'failed'),
                        records_processed: uniqueLinks.length,
                        records_inserted: insertedCount,
                        details: { type: 'links', error_message: lastError }
                    });
                    if (batchError) {
                        this.log(`History Warning: Could not record links import history. ${batchError.message}`);
                    }

                    // Re-enrich existing transactions with the new links (same rules as a normal import)
                    this.log(`Re-enriching existing transactions with new links...`);
                    const linkLookup = new Map(uniqueLinks.map(l => [String(l.payment_reference_number), l]));
                    const fixesMap = new Map(this.fixes.map(f => [String(f.reference_number), f]));
                    const lookupMapping = buildMappingLookup(this.mappings);

                    const existingTx = await fetchByIn('transactions', '*', 'reference_number', Array.from(linkLookup.keys()));
                    const updates = [];
                    for (const tx of existingTx) {
                        const ref = String(tx.reference_number);
                        const link = linkLookup.get(ref);
                        if (!link || !link.custom_input_value) continue;
                        const r = applyBusinessRules(
                            { studentId: tx.student_id, itemName: tx.item_name },
                            // Only the student ID is re-derived here; item name/mapping stay as they are.
                            { link, fix: fixesMap.get(ref), lookupMapping: () => undefined }
                        );
                        if (tx.student_id !== r.studentId || tx.id_status !== r.idStatus) {
                            updates.push({ ...tx, student_id: r.studentId, id_status: r.idStatus });
                        }
                    }

                    let enrichError = null;
                    for (let i = 0; i < updates.length; i += 500) {
                        const { error } = await supabase.from('transactions').upsert(updates.slice(i, i + 500), {
                            onConflict: 'reference_number,item_price,check_column',
                            ignoreDuplicates: false
                        });
                        if (error) {
                            enrichError = error.message;
                            this.log(`Error updating transactions with links: ${error.message}`);
                            break;
                        }
                    }
                    if (!enrichError) this.log(`Updated student IDs on ${updates.length} existing transactions.`);

                    resolve(!lastError && !enrichError);
                } catch (err) {
                    await supabase.from('import_batches').insert({
                        user_email: this.userEmail,
                        file_name: item.file.name,
                        status: 'failed',
                        records_processed: data.length,
                        records_inserted: 0,
                        details: { type: 'links', error_message: err.message }
                    });
                    this.log(`Error processing link data: ${err.message}`);
                    resolve(false);
                }
            };

            if (item.type === 'csv') {
                Papa.parse(item.data, {
                    header: true,
                    skipEmptyLines: true,
                    error: (err) => { this.log(`CSV parse error: ${err.message}`); resolve(false); },
                    complete: (results) => processData(results.data)
                });
            } else {
                processData(item.data);
            }
        });
    }

    async processOrders(item) {
        return new Promise((resolve) => {
            const processData = async (rows) => {
                this.log(`Parsed ${rows.length} rows. Transforming...`);

                const transformedRows = [];
                
                for (const row of rows) {
                    const rawRef = this.getVal(row, 'Reference Number');
                    if (rawRef === null || rawRef === undefined) continue;
                    const refNumber = String(rawRef).trim();
                    if (!refNumber) continue;

                    let itemName = String(this.getVal(row, 'Item Name') || '').trim();
                    
                    // TUI / SU Check (exact match – kept as before, because the result is part of
                    // check_column, the key used to recognise rows that were already imported)
                    if (this.tuiList.includes(itemName)) {
                        itemName = "TUI";
                    } else if (itemName === "Student Union & Activities") {
                        itemName = "SU";
                    }

                    // Extract numbers from Customer Name
                    const custName = this.getVal(row, 'Customer Name');
                    const custNameStr = custName ? String(custName).trim() : '';
                    let studentId;
                    if (/^DIP\d{14}$/i.test(custNameStr)) {
                        // Diploma IDs keep their DIP prefix
                        studentId = custNameStr.toUpperCase();
                    } else {
                        studentId = custNameStr.replace(/\D/g, '');
                        if (!studentId && custNameStr) studentId = custNameStr;
                    }

                    let totalAmount = this.parseAmount(this.getVal(row, 'Total Amount Plus Fees'));
                    let netAmount = this.parseAmount(this.getVal(row, 'Net Amount'));
                    let fawryFees = this.parseAmount(this.getVal(row, 'Fawry Fees'));
                    let itemPrice = this.parseAmount(this.getVal(row, 'Item Price'));
                    // Exact match kept as before: the bank decides item_price, which is part of the duplicate-check key
                    let merchant = this.getVal(row, 'Merchant Name') || "";
                    let bank = merchant === "Nile University Edu" ? "NUADIB64" : "NUADCB136";
                    
                    // For Nile University (NUADCB136), use Net Amount instead of Item Price as the transaction amount
                    if (bank === "NUADCB136" && !isNaN(netAmount) && netAmount !== 0) {
                        itemPrice = netAmount;
                    }
                    
                    // Payment Date
                    let rawDate = this.getVal(row, 'Payment Date') || "";
                    let paymentDate = this.parsePaymentDate(rawDate);

                    let mobileNum = this.getVal(row, 'Customer Mobile Number');
                    let pStatus = this.getVal(row, 'Payment Status') || 'PAID';
                    
                    const pStatusUpper = String(pStatus).trim().toUpperCase();
                    if (pStatusUpper !== 'PAID' && pStatusUpper !== 'SUCCESS' && pStatusUpper !== 'SUCCESSFUL') {
                        this.skippedTransactions.push({
                            reference_number: refNumber,
                            status: pStatus,
                            file_name: item.file.name
                        });
                        continue;
                    }

                    transformedRows.push({
                        reference_number: refNumber,
                        payment_date: paymentDate || null,
                        student_id: studentId,
                        customer_mobile: mobileNum,
                        total_amount: totalAmount,
                        net_amount: netAmount,
                        fawry_fees: fawryFees,
                        payment_status: pStatus,
                        item_name: itemName,
                        item_price: itemPrice,
                        merchant_name: merchant,
                        bank: bank,
                        check_column: `${refNumber}-${itemName}`,
                        file_name: item.file.name
                    });
                }

                // Deduplicate within the file based on Reference Number, Payment Date, Item Name, Item Price
                const uniqueTrans = [];
                const seenTrans = new Set();
                for (const t of transformedRows) {
                    const key = `${t.reference_number}-${t.item_price}-${t.check_column}`;
                    if (!seenTrans.has(key)) {
                        seenTrans.add(key);
                        uniqueTrans.push(t);
                    }
                }

                // Now we need to enrich with Links, Fixes, and Mappings
                this.log(`Enriching ${uniqueTrans.length} transactions...`);
                const ok = await this.enrichTransactions(uniqueTrans, item.file.name);
                resolve(ok);
            };

            if (item.type === 'csv') {
                Papa.parse(item.data, {
                    header: true,
                    skipEmptyLines: true,
                    error: (err) => { this.log(`CSV parse error: ${err.message}`); resolve(false); },
                    complete: (results) => processData(results.data).catch(err => {
                        this.log(`Error processing transaction data: ${err.message}`);
                        resolve(false);
                    })
                });
            } else {
                processData(item.data).catch(err => {
                    this.log(`Error processing data: ${err.message}`);
                    resolve(false);
                });
            }
        });
    }

    async enrichTransactions(transactions, fileName = 'Unknown') {
        if (transactions.length === 0) {
            this.log(`No payable transactions found in ${fileName}. Nothing to import.`);
            return true;
        }

        const refs = transactions.map(t => t.reference_number);

        // 1. Fetch matching links (all pages)
        let dbLinks = [];
        try {
            dbLinks = await fetchByIn('links', 'payment_reference_number, custom_input_value', 'payment_reference_number', refs, 'payment_reference_number');
        } catch (err) {
            this.log(`Error: Failed to fetch payment links: ${err.message}`);
            return false;
        }
        const linkMap = new Map(dbLinks.map(l => [String(l.payment_reference_number), l]));
        const fixesMap = new Map(this.fixes.map(f => [String(f.reference_number), f]));
        const lookupMapping = buildMappingLookup(this.mappings);

        // 2. Apply links, manual fixes and mappings (shared rules – same as "Re-apply Rules")
        for (const t of transactions) {
            const ref = String(t.reference_number);
            const r = applyBusinessRules(
                { studentId: t.student_id, itemName: t.item_name },
                { link: linkMap.get(ref), fix: fixesMap.get(ref), lookupMapping }
            );
            t.student_id = r.studentId;
            t.item_name = r.itemName;
            t.mapping = r.mapping;
            t.second_mapping = r.secondMapping;
            t.id_status = r.idStatus;
        }

        // 3. Find which rows already exist, so a re-import does NOT take ownership of them.
        //    (Otherwise "Revert" on the newer file would delete rows that came from an older import.)
        let existingKeys = new Set();
        try {
            const existing = await fetchByIn('transactions', 'id, reference_number, item_price, check_column', 'reference_number', refs);
            existing.forEach(e => existingKeys.add(this.txKey(e)));
        } catch (err) {
            this.log(`Error: Could not check existing transactions: ${err.message}`);
            return false;
        }

        // 4. Register the import batch
        this.log(`Registering import batch...`);
        const { data: batchData, error: batchInitError } = await supabase.from('import_batches').insert({
            user_email: this.userEmail,
            file_name: fileName,
            status: 'processing',
            records_processed: transactions.length,
            records_inserted: 0,
            details: { type: 'transactions' }
        }).select('id').single();

        if (batchInitError) {
            this.log(`Database error: Could not register import batch. ${batchInitError.message}`);
            return false;
        }
        const batchId = batchData.id;

        const newRows = [];
        const existingRows = [];
        for (const t of transactions) {
            if (existingKeys.has(this.txKey(t))) {
                // Keep the original batch_id / file_name of rows that were imported before
                const { batch_id, file_name, ...rest } = t;
                existingRows.push(rest);
            } else {
                newRows.push({ ...t, batch_id: batchId });
            }
        }
        this.log(`${newRows.length} new and ${existingRows.length} already-existing transactions. Saving...`);

        // 5. Upsert in chunks (3 concurrent requests max)
        const chunkSize = 1000;
        let saved = 0;
        let hasError = false;
        let lastError = null;
        const total = transactions.length;
        const progressFill = document.getElementById('progress-fill');
        const progressText = document.getElementById('progress-text');

        const thunks = [];
        for (const rows of [newRows, existingRows]) {
            for (let i = 0; i < rows.length; i += chunkSize) {
                const chunk = rows.slice(i, i + chunkSize);
                thunks.push(async () => {
                    const { error } = await supabase.from('transactions').upsert(chunk, {
                        onConflict: 'reference_number,item_price,check_column',
                        ignoreDuplicates: false
                    });
                    if (error) {
                        hasError = true;
                        this.hasErrors = true;
                        lastError = error.message;
                        this.log(`Database error: ${error.message}`);
                    } else {
                        saved += chunk.length;
                        if (progressFill) progressFill.style.width = `${(saved / total) * 100}%`;
                        if (progressText) progressText.innerText = `${saved} / ${total} rows processed`;
                    }
                });
            }
        }
        for (let i = 0; i < thunks.length; i += 3) {
            await Promise.all(thunks.slice(i, i + 3).map(fn => fn()));
        }

        // 6. Update batch status
        const { error: batchUpdateError } = await supabase.from('import_batches').update({
            status: saved === total ? 'success' : (saved > 0 ? 'partial' : 'failed'),
            records_inserted: saved,
            details: { type: 'transactions', error_message: lastError, new_rows: newRows.length, updated_rows: existingRows.length }
        }).eq('id', batchId);

        if (batchUpdateError) {
            this.log(`History Warning: Could not update import history. ${batchUpdateError.message}`);
        }

        return !hasError;
    }

    txKey(t) {
        return `${String(t.reference_number)}|${Number(t.item_price)}|${String(t.check_column)}`;
    }

    validateID(id) {
        return sharedValidateID(id);
    }
}
