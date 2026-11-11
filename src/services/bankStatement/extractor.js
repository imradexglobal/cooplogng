import * as XLSX from 'xlsx';

/**
 * Normalizes string for header comparison
 */
function normHeader(h) {
    return String(h || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ' ')
        .trim();
}

/**
 * Intelligent header mapper: maps varied bank column headers to canonical roles
 */
function identifyColumns(headers) {
    const roles = {
        date: -1,
        description: -1,
        reference: -1,
        debit: -1,
        credit: -1,
        amount: -1,
        type: -1,
        balance: -1,
        payer: -1
    };

    const patterns = {
        date: ['txn date', 'trans date', 'transaction date', 'value date', 'posting date', 'post date', 'date'],
        description: ['narration', 'transaction description', 'trans details', 'details', 'particulars', 'description', 'remarks', 'memo'],
        reference: ['reference', 'ref no', 'ref number', 'txn ref', 'trans ref', 'cheque no', 'chq no', 'doc no', 'chq / ref', 'ref'],
        debit: ['debit amount', 'debit', 'dr', 'withdrawals', 'withdrawal', 'outflow', 'paid out'],
        credit: ['credit amount', 'credit', 'cr', 'deposits', 'deposit', 'inflow', 'lodgement', 'paid in'],
        amount: ['transaction amount', 'trans amount', 'amount', 'net amount'],
        type: ['trans type', 'txn type', 'cr/dr', 'dr/cr', 'type'],
        balance: ['available balance', 'book balance', 'closing balance', 'running balance', 'balance', 'bal'],
        payer: ['payer name', 'sender name', 'originator', 'counterparty', 'beneficiary', 'payer', 'sender']
    };

    headers.forEach((h, idx) => {
        const clean = normHeader(h);
        if (!clean) return;

        for (const [role, synonyms] of Object.entries(patterns)) {
            if (roles[role] === -1) {
                // Exact match first, then substring
                if (synonyms.some(s => clean === s || clean.startsWith(s + ' ') || clean.endsWith(' ' + s))) {
                    roles[role] = idx;
                    break;
                }
            }
        }
    });

    // Fallback: search looser matches if critical columns missing
    headers.forEach((h, idx) => {
        const clean = normHeader(h);
        if (!clean) return;

        if (roles.date === -1 && clean.includes('date')) roles.date = idx;
        if (roles.description === -1 && (clean.includes('narrat') || clean.includes('desc') || clean.includes('partic'))) roles.description = idx;
        if (roles.reference === -1 && (clean.includes('ref') || clean.includes('chq') || clean.includes('cheque'))) roles.reference = idx;
        if (roles.debit === -1 && (clean.includes('debit') || clean === 'dr')) roles.debit = idx;
        if (roles.credit === -1 && (clean.includes('credit') || clean === 'cr')) roles.credit = idx;
        if (roles.amount === -1 && clean.includes('amount') && roles.debit !== idx && roles.credit !== idx) roles.amount = idx;
        if (roles.balance === -1 && clean.includes('bal')) roles.balance = idx;
    });

    return roles;
}

/**
 * Parse numeric amount safely
 */
export function parseAmount(val) {
    if (val === null || val === undefined || val === '') return 0;
    if (typeof val === 'number') return isNaN(val) ? 0 : val;
    
    // Clean string representation
    let str = String(val).trim();
    // Check if wrapped in parentheses (accounting negative)
    const isParenNegative = /^\((.*)\)$/.test(str);
    if (isParenNegative) {
        str = str.replace(/^\((.*)\)$/, '$1');
    }
    // Remove currency symbols, commas, spaces
    str = str.replace(/[^0-9.-]/g, '');
    let num = parseFloat(str);
    if (isNaN(num)) return 0;
    if (isParenNegative && num > 0) num = -num;
    return num;
}

const MONTH_NAMES = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};

/**
 * Parse date into YYYY-MM-DD
 */
export function parseDate(val) {
    if (!val) return '';
    if (val instanceof Date) {
        if (isNaN(val.getTime())) return '';
        return val.toISOString().slice(0, 10);
    }
    if (typeof val === 'number' && val > 0) {
        // Excel serial date
        const jsDate = new Date(Date.UTC(1899, 11, 30) + val * 86400000);
        if (!isNaN(jsDate.getTime())) {
            return jsDate.toISOString().slice(0, 10);
        }
    }

    const str = String(val).trim();
    if (!str) return '';

    // Standard ISO YYYY-MM-DD
    const isoMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (isoMatch) {
        const [, y, m, d] = isoMatch;
        return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }

    // DD-MMM-YYYY or DD/MMM/YYYY (e.g. 15-Nov-2024 or 04-Nov-26)
    const namedMonthMatch = str.match(/^(\d{1,2})[-/ ]([a-zA-Z]{3,})[-/ ](\d{2,4})/);
    if (namedMonthMatch) {
        const [, d, mStr, yStr] = namedMonthMatch;
        const m = MONTH_NAMES[mStr.slice(0, 3).toLowerCase()];
        if (m) {
            let y = yStr;
            if (y.length === 2) {
                y = parseInt(y, 10) > 50 ? `19${y}` : `20${y}`;
            }
            return `${y}-${m}-${d.padStart(2, '0')}`;
        }
    }

    // DD/MM/YYYY or DD-MM-YYYY
    const dmyMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (dmyMatch) {
        const [, p1, p2, yStr] = dmyMatch;
        let y = yStr;
        if (y.length === 2) {
            y = parseInt(y, 10) > 50 ? `19${y}` : `20${y}`;
        }
        // Disambiguate: if p1 > 12, p1 is definitely Day
        const d = p1.padStart(2, '0');
        const m = p2.padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    return str.slice(0, 10);
}

/**
 * Extracts transactions from an Excel/CSV array of raw row objects or arrays
 */
export function extractFromRawRows(rows, options = {}) {
    if (!rows || rows.length < 2) return [];

    // Find header row (first row with multiple text columns)
    let headerIdx = -1;
    let headers = [];

    for (let i = 0; i < Math.min(15, rows.length); i++) {
        const r = rows[i];
        const cells = Array.isArray(r) ? r : Object.values(r);
        const textCount = cells.filter(c => typeof c === 'string' && c.trim().length > 0).length;
        if (textCount >= 3) {
            const rowStr = cells.map(c => String(c || '').toLowerCase()).join(' ');
            if (rowStr.includes('date') || rowStr.includes('narrat') || rowStr.includes('amount') || rowStr.includes('debit') || rowStr.includes('credit')) {
                headerIdx = i;
                headers = cells.map(c => String(c ?? '').trim());
                break;
            }
        }
    }

    if (headerIdx === -1) {
        // Default to first row
        headerIdx = 0;
        headers = (Array.isArray(rows[0]) ? rows[0] : Object.keys(rows[0])).map(c => String(c ?? '').trim());
    }

    const cols = identifyColumns(headers);
    const transactions = [];

    for (let i = headerIdx + 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r) continue;
        const cells = Array.isArray(r) ? r : headers.map(h => r[h]);

        const rawDate = cols.date !== -1 ? cells[cols.date] : null;
        const rawDesc = cols.description !== -1 ? cells[cols.description] : '';
        const rawRef = cols.reference !== -1 ? cells[cols.reference] : '';
        const rawDebit = cols.debit !== -1 ? cells[cols.debit] : null;
        const rawCredit = cols.credit !== -1 ? cells[cols.credit] : null;
        const rawAmount = cols.amount !== -1 ? cells[cols.amount] : null;
        const rawType = cols.type !== -1 ? cells[cols.type] : '';
        const rawBalance = cols.balance !== -1 ? cells[cols.balance] : null;
        const rawPayer = cols.payer !== -1 ? cells[cols.payer] : '';

        const dateStr = parseDate(rawDate);
        const description = String(rawDesc || '').trim();
        const reference = String(rawRef || '').trim();
        const payer = String(rawPayer || '').trim();

        // Skip obvious empty/summary rows
        if (!dateStr && !description && !rawDebit && !rawCredit && !rawAmount) continue;
        const lowerDesc = description.toLowerCase();
        if (lowerDesc.includes('total') || lowerDesc.includes('opening balance') || lowerDesc.includes('closing balance') || lowerDesc.includes('brought forward')) {
            continue;
        }

        const debitNum = Math.abs(parseAmount(rawDebit));
        const creditNum = Math.abs(parseAmount(rawCredit));
        let signedAmount = 0;

        if (cols.debit !== -1 || cols.credit !== -1) {
            if (creditNum > 0 && debitNum === 0) {
                signedAmount = creditNum;
            } else if (debitNum > 0 && creditNum === 0) {
                signedAmount = -debitNum;
            } else if (creditNum > 0 && debitNum > 0) {
                // Both populated (rare edge case, check which side is net)
                signedAmount = creditNum - debitNum;
            }
        } else if (cols.amount !== -1) {
            const parsedAmt = parseAmount(rawAmount);
            const typeStr = String(rawType || '').toLowerCase();
            if (typeStr.includes('dr') || typeStr.includes('debit')) {
                signedAmount = -Math.abs(parsedAmt);
            } else if (typeStr.includes('cr') || typeStr.includes('credit')) {
                signedAmount = Math.abs(parsedAmt);
            } else {
                signedAmount = parsedAmt;
            }
        }

        // If amount is 0 and no date/desc, skip
        if (signedAmount === 0 && !dateStr) continue;

        transactions.push({
            rowNumber: i + 1,
            date: dateStr,
            description,
            reference,
            payer,
            debit: signedAmount < 0 ? Math.abs(signedAmount) : 0,
            credit: signedAmount > 0 ? signedAmount : 0,
            amount: signedAmount,
            balance: parseAmount(rawBalance),
            rawRow: cells
        });
    }

    return transactions;
}

/**
 * Parses XLSX, XLS, or CSV files using SheetJS
 */
export async function parseSpreadsheet(file) {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false, dateNF: 'yyyy-mm-dd' });
    return extractFromRawRows(rawRows);
}

/**
 * Text-based PDF extraction using pdfjs-dist
 */
export async function parsePdf(file) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) });
    const pdf = await loadingTask.promise;

    const allLines = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        
        // Group items by vertical position (Y coordinate rounded to 2px)
        const rowBuckets = new Map();
        for (const item of textContent.items) {
            const str = item.str;
            if (!str) continue;
            // PDF coordinates: transform[4] = x, transform[5] = y
            const y = Math.round(item.transform[5] / 3) * 3;
            if (!rowBuckets.has(y)) rowBuckets.set(y, []);
            rowBuckets.get(y).push({ x: item.transform[4], text: str });
        }

        // Sort descending by Y (top of page to bottom)
        const sortedY = Array.from(rowBuckets.keys()).sort((a, b) => b - a);
        for (const y of sortedY) {
            const rowItems = rowBuckets.get(y).sort((a, b) => a.x - b.x);
            // Join items into space-separated row
            const lineTokens = rowItems.map(i => i.text.trim()).filter(Boolean);
            if (lineTokens.length > 0) {
                allLines.push(lineTokens);
            }
        }
    }

    return extractFromRawRows(allLines);
}

/**
 * Master parser: detects file type and delegates
 */
export async function extractTransactionsFromFile(file) {
    const fileName = String(file.name || '').toLowerCase();

    if (fileName.endsWith('.pdf')) {
        return parsePdf(file);
    } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls') || fileName.endsWith('.csv') || fileName.endsWith('.txt')) {
        return parseSpreadsheet(file);
    } else {
        throw new Error(`Unsupported file type. Please upload a PDF, XLSX, XLS or CSV file.`);
    }
}
