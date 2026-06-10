import { supabase } from './supabase.js';

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
        // Load mappings and fixes from Supabase
        const { data: mappings, error: mapErr } = await supabase.from('item_mappings').select('*');
        const { data: fixes, error: fixErr } = await supabase.from('manual_fixes').select('*');
        if (mapErr) this.log(`Warning: Failed to load item mappings: ${mapErr.message}`);
        if (fixErr) this.log(`Warning: Failed to load manual fixes: ${fixErr.message}`);
        this.mappings = mappings || [];
        this.fixes = fixes || [];
    }

    log(msg) {
        const consoleEl = document.getElementById('import-log');
        if (consoleEl) {
            const div = document.createElement('div');
            div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
            consoleEl.appendChild(div);
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

    async processFiles(files) {
        this.log(`Starting import for ${files.length} files...`);
        await this.loadConfig();

        // Separate Links files from Order files
        const linkFiles = [];
        const orderFiles = [];

        for (const file of files) {
            const fileName = file.name.toLowerCase();
            
            if (fileName.endsWith('.csv')) {
                const text = await file.text();
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

        // Process Links first
        for (const item of linkFiles) {
            this.log(`Parsing Links file: ${item.file.name}`);
            await this.processLinks(item);
        }

        // Process Orders
        for (const item of orderFiles) {
            this.log(`Parsing Orders file: ${item.file.name}`);
            await this.processOrders(item);
        }
        
        this.log(`Import completed successfully!`);
        return true;
    }

    async processLinks(item) {
        return new Promise((resolve) => {
            const processData = async (data) => {
                const links = data.map(row => {
                    return {
                        invoice_number: this.getVal(row, 'INVOICE NUMBER'),
                        customer_name: this.getVal(row, 'CUSTOMER NAME'),
                        customer_mobile: this.getVal(row, 'CUSTOMER MOBILE NUMBER'),
                        customer_email: this.getVal(row, 'CUSTOMER EMAIL'),
                        payment_status: this.getVal(row, 'PAYMENT STATUS'),
                        paid_amount: parseFloat(this.getVal(row, 'PAID AMOUNT')) || 0,
                        payment_reference_number: String(this.getVal(row, 'PAYMENT REFERENCE NUMBER') || this.getVal(row, 'REFERENCE NUMBER') || this.getVal(row, 'BANK TRANSACTION ID')),
                        customer_national_id: this.getVal(row, 'CUSTOMER NATIONAL ID'),
                        custom_input_value: this.getVal(row, 'CUSTOM INPUT VALUE') || this.getVal(row, 'CUSTOMINPUTVALUE') || this.getVal(row, 'STUDENT ID') || this.getVal(row, 'CUSTOMER NATIONAL ID')
                    };
                }).filter(r => r.payment_reference_number && r.payment_reference_number !== "null");

                // Deduplicate
                const uniqueLinks = [];
                const seen = new Set();
                for (const l of links) {
                    if (!seen.has(l.payment_reference_number)) {
                        seen.add(l.payment_reference_number);
                        uniqueLinks.push(l);
                    }
                }

                this.log(`Found ${uniqueLinks.length} unique links. Saving to database...`);
                
                // Upsert links
                const chunkSize = 500;
                let insertedCount = 0;
                for (let i = 0; i < uniqueLinks.length; i += chunkSize) {
                    const chunk = uniqueLinks.slice(i, i + chunkSize);
                    const { error } = await supabase.from('links').upsert(chunk, { onConflict: 'payment_reference_number', ignoreDuplicates: false });
                    if (error) {
                        this.log(`Error saving links: ${error.message}`);
                    } else {
                        insertedCount += chunk.length;
                    }
                }

                await supabase.from('import_batches').insert({
                    user_email: this.userEmail,
                    file_name: item.file.name,
                    status: insertedCount === uniqueLinks.length ? 'success' : (insertedCount > 0 ? 'partial' : 'failed'),
                    records_processed: uniqueLinks.length,
                    records_inserted: insertedCount,
                    details: { type: 'links' }
                });

                // Re-enrich existing transactions with these new links
                this.log(`Re-enriching existing transactions with new links...`);
                const refs = uniqueLinks.map(l => String(l.payment_reference_number));
                for (let i = 0; i < refs.length; i += 200) {
                    const chunkRefs = refs.slice(i, i + 200);
                    const { data: existingTx } = await supabase.from('transactions').select('*').in('reference_number', chunkRefs);
                    if (existingTx && existingTx.length > 0) {
                        const { data: existingFixes } = await supabase.from('manual_fixes').select('*').in('reference_number', chunkRefs);
                        const fixesMap = new Map();
                        if (existingFixes) {
                            existingFixes.forEach(f => fixesMap.set(String(f.reference_number), f));
                        }

                        for (const tx of existingTx) {
                            const link = uniqueLinks.find(l => String(l.payment_reference_number) === String(tx.reference_number));
                            if (link && link.custom_input_value) {
                                if (!fixesMap.has(String(tx.reference_number))) {
                                    tx.student_id = link.custom_input_value;
                                    tx.id_status = this.validateID(tx.student_id);
                                } else {
                                    const fix = fixesMap.get(String(tx.reference_number));
                                    if (fix.correct_id) {
                                        tx.student_id = fix.correct_id;
                                        tx.id_status = this.validateID(tx.student_id);
                                    }
                                }
                            }
                        }
                        await supabase.from('transactions').upsert(existingTx, { onConflict: 'reference_number,item_price,check_column', ignoreDuplicates: false });
                    }
                }
                
                resolve();
            };

            if (item.type === 'csv') {
                Papa.parse(item.data, {
                    header: true,
                    skipEmptyLines: true,
                    worker: true,
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
                    let refNumber = this.getVal(row, 'Reference Number');
                    if (!refNumber) continue;

                    let itemName = this.getVal(row, 'Item Name') || "";
                    
                    // TUI / SU Check
                    if (this.tuiList.includes(itemName)) {
                        itemName = "TUI";
                    } else if (itemName === "Student Union & Activities") {
                        itemName = "SU";
                    }

                    // Extract numbers from Customer Name
                    const custName = this.getVal(row, 'Customer Name');
                    let studentId = custName ? String(custName).replace(/-/g, '').replace(/\D/g, '') : "";
                    if (!studentId && custName) studentId = custName;

                    let totalAmount = parseFloat(this.getVal(row, 'Total Amount Plus Fees')) || 0;
                    let netAmount = parseFloat(this.getVal(row, 'Net Amount')) || 0;
                    let fawryFees = parseFloat(this.getVal(row, 'Fawry Fees')) || 0;
                    let itemPrice = parseFloat(this.getVal(row, 'Item Price')) || 0;
                    let merchant = this.getVal(row, 'Merchant Name') || "";
                    let bank = merchant === "Nile University Edu" ? "NUADIB64" : "NUADCB136";
                    
                    // Payment Date split
                    let rawDate = this.getVal(row, 'Payment Date') || "";
                    
                    // Excel dates might be numeric serials or pre-formatted strings
                    let paymentDate = "";
                    if (typeof rawDate === 'number') {
                        // Excel serial date to JS Date
                        const dateObj = new Date(Math.round((rawDate - 25569) * 86400 * 1000));
                        paymentDate = dateObj.toISOString().split('T')[0];
                    } else if (rawDate) {
                        paymentDate = String(rawDate).split(' ')[0]; // take the date part
                        
                        // Parse DD/MM/YYYY or MM/DD/YYYY securely
                        const separator = paymentDate.includes('/') ? '/' : (paymentDate.includes('-') ? '-' : null);
                        if (separator) {
                             const parts = paymentDate.split(separator);
                             if (parts.length === 3) {
                                 if (parts[2].length === 4) {
                                     // Format is XX-XX-YYYY. We must figure out if it's DD-MM or MM-DD.
                                     // Fawry defaults to DD-MM-YYYY.
                                     // If Excel mutated it, it might be MM-DD-YYYY.
                                     // Let's assume DD-MM-YYYY first (parts[0] is day, parts[1] is month).
                                     let day = parseInt(parts[0]);
                                     let month = parseInt(parts[1]);
                                     // If month > 12, then it must be MM-DD-YYYY (Excel mutated it!)
                                     if (month > 12) {
                                         day = parseInt(parts[1]);
                                         month = parseInt(parts[0]);
                                     }
                                     paymentDate = `${parts[2]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                                 } else if (parts[0].length === 4) {
                                     // It's already YYYY-MM-DD
                                     paymentDate = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
                                 }
                             }
                        }
                    }

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
                await this.enrichTransactions(uniqueTrans, item.file.name);
                resolve();
            };

            if (item.type === 'csv') {
                Papa.parse(item.data, {
                    header: true,
                    skipEmptyLines: true,
                    worker: true,
                    complete: (results) => processData(results.data)
                });
            } else {
                processData(item.data);
            }
        });
    }

    async enrichTransactions(transactions, fileName = 'Unknown') {
        // Collect references to fetch links
        const refs = transactions.map(t => t.reference_number);
        
        // Fetch matching links in chunks to avoid URL length limits
        const dbLinks = [];
        const fetchChunkSize = 200;
        for (let i = 0; i < refs.length; i += fetchChunkSize) {
            const chunkRefs = refs.slice(i, i + fetchChunkSize);
            const { data, error } = await supabase
                .from('links')
                .select('payment_reference_number, custom_input_value')
                .in('payment_reference_number', chunkRefs);
                
            if (data) {
                dbLinks.push(...data);
            } else if (error) {
                this.log(`Warning: Failed to fetch some links: ${error.message}`);
            }
        }
            
        const linkMap = {};
        dbLinks.forEach(l => {
            linkMap[l.payment_reference_number] = l.custom_input_value;
        });

        const fixesMap = {};
        this.fixes.forEach(f => fixesMap[f.reference_number] = f);

        const mappingMap = {};
        this.mappings.forEach(m => mappingMap[m.item_name] = m);

        // Final application
        for (const t of transactions) {
            // Apply Link
            if (linkMap[t.reference_number]) {
                t.student_id = linkMap[t.reference_number];
            }

            // Apply Fixes
            const fix = fixesMap[t.reference_number];
            if (fix) {
                if (fix.correct_id) t.student_id = fix.correct_id;
                if (fix.item_name) t.item_name = fix.item_name;
                if (fix.mapping) t.mapping = fix.mapping;
            }

            // Apply Validation Status (The Bulletproof rules)
            t.id_status = this.validateID(t.student_id);

            // Apply Mappings if not overridden by fixes
            if (!fix || !fix.mapping) {
                const mapDef = mappingMap[t.item_name];
                if (mapDef) {
                    if (mapDef.adjusted_item_name) t.item_name = mapDef.adjusted_item_name;
                    t.mapping = mapDef.mapping;
                }
            }
        }

        // Insert into Supabase
        this.log(`Inserting data into database...`);
        const chunkSize = 1000;
        let inserted = 0;
        
        for (let i = 0; i < transactions.length; i += chunkSize) {
            const chunk = transactions.slice(i, i + chunkSize);
            const { error } = await supabase.from('transactions').upsert(chunk, { 
                onConflict: 'reference_number,item_price,check_column', 
                ignoreDuplicates: false 
            });
            
            if (error) {
                this.log(`Database error: ${error.message}`);
            } else {
                inserted += chunk.length;
                document.getElementById('progress-fill').style.width = `${(inserted / transactions.length) * 100}%`;
                document.getElementById('progress-text').innerText = `${inserted} / ${transactions.length} rows processed`;
            }
        }

        await supabase.from('import_batches').insert({
            user_email: this.userEmail,
            file_name: fileName,
            status: inserted === transactions.length ? 'success' : (inserted > 0 ? 'partial' : 'failed'),
            records_processed: transactions.length,
            records_inserted: inserted,
            details: { type: 'transactions' }
        });
    }

    validateID(id) {
        if (!id) return "Missing ID";
        const idText = String(id).trim();
        const idLength = idText.length;
        
        // Find non-numeric
        const onlyTextLeft = idText.replace(/[0-9]/g, '');
        
        // DIP Exception
        if (idLength === 17 && idText.toUpperCase().startsWith("DIP")) {
            const remainder = idText.substring(3).replace(/[0-9]/g, '');
            if (remainder === "") return "Valid";
        }

        if (onlyTextLeft !== "") return "Error: Text/Name detected";
        if (idLength > 9) return `Error: ID Too Long (${idLength} digits)`;
        if (idText.startsWith("2") && idLength !== 9) return `Error: Invalid 2-Series Length (${idLength} digits)`;
        
        return "Valid";
    }
}
