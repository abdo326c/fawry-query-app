import { supabase } from './supabase.js';

export class FawryProcessor {
    constructor() {
        this.mappings = [];
        this.fixes = [];
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
        const { data: mappings } = await supabase.from('item_mappings').select('*');
        const { data: fixes } = await supabase.from('manual_fixes').select('*');
        this.mappings = mappings || [];
        this.fixes = fixes || [];
    }

    log(msg) {
        const consoleEl = document.getElementById('import-log');
        if (consoleEl) {
            consoleEl.innerHTML += `<div>[${new Date().toLocaleTimeString()}] ${msg}</div>`;
            consoleEl.scrollTop = consoleEl.scrollHeight;
        }
        console.log(msg);
    }

    async processFiles(files) {
        this.log(`Starting import for ${files.length} files...`);
        await this.loadConfig();

        // Separate Links files from Order files
        const linkFiles = [];
        const orderFiles = [];

        for (const file of files) {
            const fileName = file.name.toLowerCase();
            
            // For CSV files
            if (fileName.endsWith('.csv')) {
                const text = await file.text();
                const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                
                const firstLine = normalizedText.split('\n')[0].toLowerCase();
                if (firstLine.includes('invoice number')) {
                    linkFiles.push({ file, type: 'csv', data: normalizedText });
                } else if (firstLine.includes('reference number')) {
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
                    const keys = Object.keys(firstRow).map(k => k.toLowerCase());
                    
                    if (keys.some(k => k.includes('invoice number'))) {
                        linkFiles.push({ file, type: 'json', data: json });
                    } else if (keys.some(k => k.includes('reference number'))) {
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
                    // Handle Excel keys vs CSV keys (case sensitivity)
                    const getVal = (keyStr) => {
                        const exact = row[keyStr];
                        if (exact !== undefined) return exact;
                        // fallback to case-insensitive match
                        const foundKey = Object.keys(row).find(k => k.toLowerCase() === keyStr.toLowerCase());
                        return foundKey ? row[foundKey] : null;
                    };

                    return {
                        invoice_number: getVal('INVOICE NUMBER'),
                        customer_name: getVal('CUSTOMER NAME'),
                        customer_mobile: getVal('CUSTOMER MOBILE NUMBER'),
                        customer_email: getVal('CUSTOMER EMAIL'),
                        payment_status: getVal('PAYMENT STATUS'),
                        paid_amount: parseFloat(getVal('PAID AMOUNT')) || 0,
                        payment_reference_number: getVal('PAYMENT REFERENCE NUMBER'),
                        customer_national_id: getVal('CUSTOMER NATIONAL ID'),
                        custom_input_value: getVal('CUSTOM INPUT VALUE')
                    };
                }).filter(r => r.payment_reference_number);

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
                for (let i = 0; i < uniqueLinks.length; i += chunkSize) {
                    const chunk = uniqueLinks.slice(i, i + chunkSize);
                    const { error } = await supabase.from('links').upsert(chunk, { onConflict: 'payment_reference_number', ignoreDuplicates: true });
                    if (error) this.log(`Error saving links: ${error.message}`);
                }
                resolve();
            };

            if (item.type === 'csv') {
                Papa.parse(item.data, {
                    header: true,
                    skipEmptyLines: true,
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
                    const getVal = (keyStr) => {
                        const exact = row[keyStr];
                        if (exact !== undefined) return exact;
                        const foundKey = Object.keys(row).find(k => k.toLowerCase() === keyStr.toLowerCase());
                        return foundKey ? row[foundKey] : null;
                    };

                    let refNumber = getVal('Reference Number');
                    if (!refNumber) continue;

                    let itemName = getVal('Item Name') || "";
                    
                    // TUI / SU Check
                    if (this.tuiList.includes(itemName)) {
                        itemName = "TUI";
                    } else if (itemName === "Student Union & Activities") {
                        itemName = "SU";
                    }

                    // Extract numbers from Customer Name
                    const custName = getVal('Customer Name');
                    let studentId = custName ? String(custName).replace(/-/g, '').replace(/\D/g, '') : "";
                    if (!studentId && custName) studentId = custName;

                    let totalAmount = parseFloat(getVal('Total Amount Plus Fees')) || 0;
                    let netAmount = parseFloat(getVal('Net Amount')) || 0;
                    let fawryFees = parseFloat(getVal('Fawry Fees')) || 0;
                    let itemPrice = parseFloat(getVal('Item Price')) || 0;
                    let merchant = getVal('Merchant Name') || "";
                    let bank = merchant === "Nile University Edu" ? "NUADIB64" : "NUADCB136";
                    
                    // Payment Date split
                    let rawDate = getVal('Payment Date') || "";
                    
                    // Excel dates might be numeric serials or pre-formatted strings
                    let paymentDate = "";
                    if (typeof rawDate === 'number') {
                        // Excel serial date to JS Date
                        const dateObj = new Date(Math.round((rawDate - 25569) * 86400 * 1000));
                        paymentDate = dateObj.toISOString().split('T')[0];
                    } else {
                        paymentDate = String(rawDate).split(' ')[0]; // just take the date part
                        if (paymentDate && paymentDate.includes('/')) {
                             // Convert DD/MM/YYYY to YYYY-MM-DD for Postgres
                             const parts = paymentDate.split('/');
                             if (parts.length === 3) {
                                 paymentDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
                             }
                        }
                    }

                    let mobileNum = getVal('Customer Mobile Number') || getVal('Customer  Mobile Number');

                    transformedRows.push({
                        reference_number: refNumber,
                        payment_date: paymentDate || null,
                        student_id: studentId,
                        customer_mobile: mobileNum,
                        total_amount: totalAmount,
                        net_amount: netAmount,
                        fawry_fees: fawryFees,
                        payment_status: getVal('Payment Status') || 'PAID',
                        item_name: itemName,
                        item_price: itemPrice,
                        merchant_name: merchant,
                        bank: bank,
                        check_column: `${refNumber}-${itemName}`
                    });
                }

                // Deduplicate within the file based on Reference Number, Payment Date, Item Name, Item Price
                const uniqueTrans = [];
                const seenTrans = new Set();
                for (const t of transformedRows) {
                    const key = `${t.reference_number}-${t.payment_date}-${t.item_name}-${t.item_price}`;
                    if (!seenTrans.has(key)) {
                        seenTrans.add(key);
                        uniqueTrans.push(t);
                    }
                }

                // Now we need to enrich with Links, Fixes, and Mappings
                this.log(`Enriching ${uniqueTrans.length} transactions...`);
                await this.enrichTransactions(uniqueTrans);
                resolve();
            };

            if (item.type === 'csv') {
                Papa.parse(item.data, {
                    header: true,
                    skipEmptyLines: true,
                    complete: (results) => processData(results.data)
                });
            } else {
                processData(item.data);
            }
        });
    }

    async enrichTransactions(transactions) {
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
                ignoreDuplicates: true 
            });
            
            if (error) {
                this.log(`Database error: ${error.message}`);
            } else {
                inserted += chunk.length;
                document.getElementById('progress-fill').style.width = `${(inserted / transactions.length) * 100}%`;
                document.getElementById('progress-text').innerText = `${inserted} / ${transactions.length} rows processed`;
            }
        }
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
