const initSqlJs = require('C:/Users/User/Documents/GitHub/cooplogng/node_modules/sql.js');
const fs = require('fs');
const path = require('path');
const SQL = initSqlJs({ locateFile: f => path.join('C:/Users/User/Documents/GitHub/cooplogng/node_modules/sql.js', 'dist', f) });
const dbPath = process.argv[2] || 'C:\\Users\\User\\Documents\\migration\\the_new_format.db';
const db = new SQL.Database(fs.readFileSync(dbPath));
const q = (s) => {
    const r = db.exec(s);
    if (!r.length) return [];
    const cols = r[0].columns;
    return r[0].values.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
};

console.log('--- remittance schema ---');
console.log(JSON.stringify(q("PRAGMA table_info(remittance)"), null, 2));
console.log('--- remittance_detail schema ---');
console.log(JSON.stringify(q("PRAGMA table_info(remittance_detail)"), null, 2));
console.log('--- members schema ---');
console.log(JSON.stringify(q("PRAGMA table_info(members)"), null, 2));
console.log('--- enterprise schema ---');
console.log(JSON.stringify(q("PRAGMA table_info(enterprise)"), null, 2));

console.log('--- BROUGHT_FORWARD remittances ---');
console.log(JSON.stringify(q("SELECT * FROM remittance WHERE category='BROUGHT_FORWARD' OR transaction_type='DEBIT'"), null, 2));
console.log('--- details for BROUGHT_FORWARD ---');
console.log(JSON.stringify(q("SELECT rd.* FROM remittance_detail rd JOIN remittance r ON r.id=rd.remittance_id WHERE r.category='BROUGHT_FORWARD' OR r.transaction_type='DEBIT'"), null, 2));
