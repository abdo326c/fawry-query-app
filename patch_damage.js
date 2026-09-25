const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

const searchBad = /<td style="white-space: normal; word-wrap: break-word; max-width: 250px;">\$\{escapeHTML\(t\.item_name\)\}<\/td>\s*<td><\/td>\s*<td><\/td>/;
const replaceGood = '<td style="white-space: normal; word-wrap: break-word; max-width: 250px;"></td>\n                    <td></td>\n                    <td></td>';
code = code.replace(searchBad, replaceGood);

fs.writeFileSync('app.js', code);
console.log('Fixed PowerShell damage!');
