const fs = require('fs');

let html = fs.readFileSync('index.html', 'utf8');

// 1. Manual Fixes table
html = html.replace(
    /<th>Mapping<\/th>\s*<th>Actions<\/th>/,
    "<th>Mapping</th>\n                                <th>2nd Mapping</th>\n                                <th>Actions</th>"
);

// 2. Auto Matcher table
html = html.replace(
    /<th>\s*<div class="th-filter-wrapper" data-column="mapping" data-table="automatch">\s*Mapping <i data-lucide="filter" class="header-filter-icon"><\/i>\s*<\/div>\s*<\/th>/,
    \<th>
                                            <div class="th-filter-wrapper" data-column="mapping" data-table="automatch">
                                                Mapping <i data-lucide="filter" class="header-filter-icon"></i>
                                            </div>
                                        </th>
                                        <th>
                                            <div class="th-filter-wrapper" data-column="second_mapping" data-table="automatch">
                                                2nd Mapping <i data-lucide="filter" class="header-filter-icon"></i>
                                            </div>
                                        </th>\
);

fs.writeFileSync('index.html', html);
console.log('HTML updated.');
