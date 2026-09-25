const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

const searchStr =                     <td>\</td>
                    <td>\</td>
                    <td>\</td>
                    <td>;

const replaceStr =                     <td>\</td>
                    <td>\</td>
                    <td>\</td>
                    <td>\</td>
                    <td>;

code = code.replace(searchStr, replaceStr);

fs.writeFileSync('app.js', code);
