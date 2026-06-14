const fs = require('fs');
const js = fs.readFileSync('f:/fawry-query-app/app.js', 'utf8');
const html = fs.readFileSync('f:/fawry-query-app/index.html', 'utf8');

const jsIds = [...js.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
const querySelectorIds = [...js.matchAll(/querySelector\(['"]#([^'"]+)['"]\)/g)].map(m => m[1]);
const allJsIds = [...new Set([...jsIds, ...querySelectorIds])];

const htmlIdsMatch = [...html.matchAll(/\bid=['"]([^'"]+)['"]/g)].map(m => m[1]);
const htmlIds = new Set(htmlIdsMatch);

const missing = allJsIds.filter(id => !htmlIds.has(id));
console.log('IDs used in JS but missing in HTML:', missing);
