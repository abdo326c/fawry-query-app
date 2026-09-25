const fs = require('fs');

// Patch index.html
let html = fs.readFileSync('index.html', 'utf8');
const searchTh = /<div class="th-filter-wrapper" data-column="mapping" data-table="transactions">\s*Mapping <i data-lucide="filter" class="header-filter-icon"><\/i>\s*<\/div>\s*<\/th>/;
const replaceTh = '<div class="th-filter-wrapper" data-column="mapping" data-table="transactions">\n                                        Mapping <i data-lucide="filter" class="header-filter-icon"></i>\n                                    </div>\n                                </th>\n                                <th>\n                                    <div class="th-filter-wrapper" data-column="second_mapping" data-table="transactions">\n                                        2nd Mapping <i data-lucide="filter" class="header-filter-icon"></i>\n                                    </div>\n                                </th>';
html = html.replace(searchTh, replaceTh);
fs.writeFileSync('index.html', html);

// Patch app.js
let code = fs.readFileSync('app.js', 'utf8');
const searchTd = /<td>\$\{escapeHTML\(t\.mapping\) \|\| '-'\.toString\(\) \? '-' : '-'\s*\}/; // Wait, t.mapping doesn't have toString? Let's just use simple match
code = code.replace(
    /<td>\$\{escapeHTML\(t\.mapping\) \|\| '-'\s*\}<\/td>/,
    "<td></td>\n                    <td></td>"
);
fs.writeFileSync('app.js', code);

console.log('Transactions table patched with regex!');
