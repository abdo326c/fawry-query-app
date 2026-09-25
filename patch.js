const fs = require('fs');

let code = fs.readFileSync('app.js', 'utf8');

const regex = /async loadDashboard\(\) \{[\s\S]*?\/\/ Update Stat Cards/;
const match = code.match(regex);
if (!match) throw new Error('Could not find loadDashboard block');

const replacement = `async loadDashboard() {
        const dateFrom = document.getElementById('dashboard-date-from')?.value;
        const dateTo = document.getElementById('dashboard-date-to')?.value;
        const groupBy = document.getElementById('dashboard-group-by')?.value || 'date';
        
        if (!dateFrom || !dateTo) return;

        const checkboxes = document.querySelectorAll('#dashboard-bank-filters input[type="checkbox"]:checked');
        const selectedBanks = Array.from(checkboxes).map(cb => cb.value);

        const tbody = document.getElementById('dashboard-pivot-body');
        const tfoot = document.getElementById('dashboard-pivot-foot');
        if (!tbody || !tfoot) return;

        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">Loading...</td></tr>';
        tfoot.innerHTML = '';

        try {
            let allData = [];
            
            // If grouping by date, we can try the fast RPC method
            if (groupBy === 'date') {
                const { data: rpcData, error: rpcError } = await supabase.rpc('get_dashboard_pivot', { start_date: dateFrom, end_date: dateTo });
                if (!rpcError && rpcData) {
                    allData = rpcData.map(row => ({
                        payment_date: row.payment_date,
                        bank: row.bank,
                        item_price: row.daily_total
                    }));
                }
            }
            
            // Fallback or if grouping by mapping/item (which requires full data)
            if (allData.length === 0) {
                let fetchMore = true;
                let from = 0;
                while (fetchMore) {
                    const { data, error } = await supabase.from('transactions')
                        .select('payment_date, bank, item_price, mapping, item_name')
                        .gte('payment_date', dateFrom)
                        .lte('payment_date', dateTo)
                        .range(from, from + 999);
                    
                    if (error) throw error;
                    if (!data || data.length === 0) break;
                    allData = allData.concat(data);
                    if (data.length < 1000) fetchMore = false;
                    else from += 1000;
                }
            }

            const formatMoney = (num) => num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

            let bankTotals = { Total: 0 };
            selectedBanks.forEach(b => bankTotals[b] = 0);

            let htmlOutput = '';

            if (groupBy === 'date') {
                const monthlyPivot = {};
                allData.forEach(tx => {
                    if (!selectedBanks.includes(tx.bank)) return;
                    const pDate = tx.payment_date;
                    if (!pDate) return;
                    const monthKey = pDate.substring(0, 7); // YYYY-MM
                    
                    if (!monthlyPivot[monthKey]) {
                        monthlyPivot[monthKey] = { Total: 0, days: {} };
                        selectedBanks.forEach(b => monthlyPivot[monthKey][b] = 0);
                    }
                    if (!monthlyPivot[monthKey].days[pDate]) {
                        monthlyPivot[monthKey].days[pDate] = { Total: 0 };
                        selectedBanks.forEach(b => monthlyPivot[monthKey].days[pDate][b] = 0);
                    }
                    
                    const price = parseFloat(tx.item_price) || 0;
                    monthlyPivot[monthKey].days[pDate][tx.bank] += price;
                    monthlyPivot[monthKey].days[pDate].Total += price;
                    monthlyPivot[monthKey][tx.bank] += price;
                    monthlyPivot[monthKey].Total += price;
                    bankTotals[tx.bank] += price;
                    bankTotals.Total += price;
                });

                const months = Object.keys(monthlyPivot).sort();
                const multiMonth = months.length > 1;

                months.forEach(m => {
                    const monthData = monthlyPivot[m];
                    const days = Object.keys(monthData.days).sort();
                    
                    if (multiMonth) {
                        const parts = m.split('-');
                        const monthLabel = \`\${monthNames[parseInt(parts[1]) - 1]} \${parts[0]}\`;
                        htmlOutput += \`<tr class="month-row" data-month="\${m}">
                            <td><div class="month-toggle"><i data-lucide="chevron-right"></i><span>\${monthLabel}</span></div></td>\`;
                        selectedBanks.forEach(b => {
                            htmlOutput += \`<td class="\${b === 'NUADIB64' ? 'highlight-cell' : ''}">\${formatMoney(monthData[b])}</td>\`;
                        });
                        htmlOutput += \`<td>\${formatMoney(monthData.Total)}</td></tr>\`;
                    }

                    days.forEach(d => {
                        const row = monthData.days[d];
                        const dateParts = d.split('-');
                        const dateLabel = \`\${parseInt(dateParts[2])}-\${monthNames[parseInt(dateParts[1]) - 1]}-\${dateParts[0]}\`;
                        htmlOutput += \`<tr class="day-row month-\${m}" style="\${multiMonth ? 'display: none;' : ''}">
                            <td>\${dateLabel}</td>\`;
                        selectedBanks.forEach(b => {
                            htmlOutput += \`<td class="\${b === 'NUADIB64' ? 'highlight-cell' : ''}">\${formatMoney(row[b])}</td>\`;
                        });
                        htmlOutput += \`<td>\${formatMoney(row.Total)}</td></tr>\`;
                    });
                });

                if (months.length === 0) {
                    htmlOutput = \`<tr><td colspan="\${selectedBanks.length + 2}" style="text-align: center;">No data for selected period</td></tr>\`;
                }

            } else {
                // Group by Mapping or Item Name
                const groupedData = {};
                
                allData.forEach(tx => {
                    if (!selectedBanks.includes(tx.bank)) return;
                    
                    let key = 'Unknown';
                    if (groupBy === 'mapping') {
                        key = tx.mapping || 'Unmapped';
                    } else if (groupBy === 'item_name') {
                        key = tx.item_name || 'Unknown Item';
                    }
                    
                    if (!groupedData[key]) {
                        groupedData[key] = { Total: 0 };
                        selectedBanks.forEach(b => groupedData[key][b] = 0);
                    }
                    
                    const price = parseFloat(tx.item_price) || 0;
                    groupedData[key][tx.bank] += price;
                    groupedData[key].Total += price;
                    bankTotals[tx.bank] += price;
                    bankTotals.Total += price;
                });

                const keys = Object.keys(groupedData).sort();
                
                keys.forEach(k => {
                    const row = groupedData[k];
                    htmlOutput += \`<tr><td>\${k}</td>\`;
                    selectedBanks.forEach(b => {
                        htmlOutput += \`<td class="\${b === 'NUADIB64' ? 'highlight-cell' : ''}">\${formatMoney(row[b])}</td>\`;
                    });
                    htmlOutput += \`<td>\${formatMoney(row.Total)}</td></tr>\`;
                });

                if (keys.length === 0) {
                    htmlOutput = \`<tr><td colspan="\${selectedBanks.length + 2}" style="text-align: center;">No data for selected period</td></tr>\`;
                }
            }

            tbody.innerHTML = htmlOutput;

            let footHtml = \`<tr><td>Grand Total</td>\`;
            selectedBanks.forEach(b => {
                footHtml += \`<td class="\${b === 'NUADIB64' ? 'highlight-cell' : ''}">\${formatMoney(bankTotals[b])}</td>\`;
            });
            footHtml += \`<td>\${formatMoney(bankTotals.Total)}</td></tr>\`;
            tfoot.innerHTML = footHtml;

            const thead = document.querySelector('#dashboard-pivot-table thead');
            if (thead) {
                const label = groupBy === 'date' ? 'Date' : (groupBy === 'mapping' ? 'Mapping' : 'Item Name');
                thead.innerHTML = \`
                    <tr><th colspan="\${selectedBanks.length + 2}" class="pivot-title">Total Fawry Collection</th></tr>
                    <tr>
                        <th class="pivot-row-label">\${label}</th>
                        \${selectedBanks.map(b => \`<th class="pivot-col-label \${b === 'NUADIB64' ? 'highlight-col' : ''}">\${b}</th>\`).join('')}
                        <th class="pivot-col-label">Grand Total</th>
                    </tr>
                \`;
            }

            // Update Stat Cards`;

code = code.replace(regex, replacement);
fs.writeFileSync('app.js', code);
console.log('Patch complete!');
