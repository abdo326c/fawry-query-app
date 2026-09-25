const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');
const searchStr = "const checkboxes = document.querySelectorAll('#dashboard-bank-filters input[type=\"checkbox\"]');";
const replaceStr = "document.getElementById('dashboard-group-by')?.addEventListener('change', () => this.loadDashboard());\n        " + searchStr;
code = code.replace(searchStr, replaceStr);
fs.writeFileSync('app.js', code);
