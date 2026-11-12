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

    const str = String(val).trim().replace(/([\-/.])\s+(?=\d)/g, '$1');
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

function groupPdfTextItems(items) {
    const positionedItems = (items || [])
        .filter(item => String(item?.str || '').trim())
        .map(item => ({
            text: String(item.str).trim(),
            x: Number(item.transform?.[4]) || 0,
            y: Number(item.transform?.[5]) || 0,
            width: Number(item.width) || 0
        }))
        .sort((a, b) => b.y - a.y || a.x - b.x);

    const lines = [];
    for (const item of positionedItems) {
        let line = lines.find(candidate => Math.abs(candidate.y - item.y) <= 2.5);
        if (!line) {
            line = { y: item.y, items: [] };
            lines.push(line);
        }
        line.items.push(item);
    }
    return lines
        .sort((a, b) => b.y - a.y)
        .map(line => line.items.sort((a, b) => a.x - b.x));
}

/** Converts thin horizontal PDF path segments into page-coordinate row rules. */
export function extractPdfHorizontalRules(operatorList, ops) {
    if (!operatorList?.fnArray || !operatorList?.argsArray || !ops) return [];

    let matrix = [1, 0, 0, 1, 0, 0];
    const matrixStack = [];
    const segments = [];
    const multiply = (left, right) => [
        left[0] * right[0] + left[2] * right[1],
        left[1] * right[0] + left[3] * right[1],
        left[0] * right[2] + left[2] * right[3],
        left[1] * right[2] + left[3] * right[3],
        left[0] * right[4] + left[2] * right[5] + left[4],
        left[1] * right[4] + left[3] * right[5] + left[5]
    ];

    for (let index = 0; index < operatorList.fnArray.length; index++) {
        const operation = operatorList.fnArray[index];
        const args = operatorList.argsArray[index];
        if (operation === ops.save) {
            matrixStack.push([...matrix]);
            continue;
        }
        if (operation === ops.restore) {
            matrix = matrixStack.pop() || matrix;
            continue;
        }
        if (operation === ops.transform && Array.isArray(args)) {
            matrix = multiply(matrix, args);
            continue;
        }
        if (operation !== ops.constructPath || !args?.[2]) continue;

        const bounds = args[2];
        const corners = [
            [bounds[0], bounds[1]], [bounds[0], bounds[3]],
            [bounds[2], bounds[1]], [bounds[2], bounds[3]]
        ].map(([x, y]) => [
            matrix[0] * x + matrix[2] * y + matrix[4],
            matrix[1] * x + matrix[3] * y + matrix[5]
        ]);
        const xs = corners.map(point => point[0]);
        const ys = corners.map(point => point[1]);
        const left = Math.min(...xs);
        const right = Math.max(...xs);
        const top = Math.min(...ys);
        const bottom = Math.max(...ys);
        if (right - left >= 160 && bottom - top <= 1.5) {
            segments.push({ left, right, y: (top + bottom) / 2 });
        }
    }

    const rules = [];
    for (const segment of segments) {
        let rule = rules.find(candidate => Math.abs(candidate.y - segment.y) <= 1.2);
        if (!rule) {
            rule = { y: segment.y, left: segment.left, right: segment.right, segments: 0 };
            rules.push(rule);
        }
        rule.y = (rule.y * rule.segments + segment.y) / (rule.segments + 1);
        rule.left = Math.min(rule.left, segment.left);
        rule.right = Math.max(rule.right, segment.right);
        rule.segments++;
    }
    return rules.map(rule => rule.y).sort((a, b) => b - a);
}

/** Converts thin vertical PDF path segments into page-coordinate cell boundaries. */
export function extractPdfVerticalRules(operatorList, ops) {
    if (!operatorList?.fnArray || !operatorList?.argsArray || !ops) return [];

    let matrix = [1, 0, 0, 1, 0, 0];
    const matrixStack = [];
    const segments = [];
    const multiply = (left, right) => [
        left[0] * right[0] + left[2] * right[1],
        left[1] * right[0] + left[3] * right[1],
        left[0] * right[2] + left[2] * right[3],
        left[1] * right[2] + left[3] * right[3],
        left[0] * right[4] + left[2] * right[5] + left[4],
        left[1] * right[4] + left[3] * right[5] + left[5]
    ];

    for (let index = 0; index < operatorList.fnArray.length; index++) {
        const operation = operatorList.fnArray[index];
        const args = operatorList.argsArray[index];
        if (operation === ops.save) {
            matrixStack.push([...matrix]);
            continue;
        }
        if (operation === ops.restore) {
            matrix = matrixStack.pop() || matrix;
            continue;
        }
        if (operation === ops.transform && Array.isArray(args)) {
            matrix = multiply(matrix, args);
            continue;
        }
        if (operation !== ops.constructPath || !args?.[2]) continue;

        const bounds = args[2];
        const corners = [
            [bounds[0], bounds[1]], [bounds[0], bounds[3]],
            [bounds[2], bounds[1]], [bounds[2], bounds[3]]
        ].map(([x, y]) => [
            matrix[0] * x + matrix[2] * y + matrix[4],
            matrix[1] * x + matrix[3] * y + matrix[5]
        ]);
        const xs = corners.map(point => point[0]);
        const ys = corners.map(point => point[1]);
        const left = Math.min(...xs);
        const right = Math.max(...xs);
        const top = Math.min(...ys);
        const bottom = Math.max(...ys);
        if (right - left <= 1.5 && bottom - top >= 12) {
            segments.push({ x: (left + right) / 2, top, bottom });
        }
    }

    const boundaries = [];
    for (const segment of segments) {
        let boundary = boundaries.find(candidate => Math.abs(candidate.x - segment.x) <= 1.2);
        if (!boundary) {
            boundary = { x: segment.x, top: segment.top, bottom: segment.bottom, segments: 0 };
            boundaries.push(boundary);
        }
        boundary.x = (boundary.x * boundary.segments + segment.x) / (boundary.segments + 1);
        boundary.top = Math.max(boundary.top, segment.top);
        boundary.bottom = Math.min(boundary.bottom, segment.bottom);
        boundary.segments++;
    }
    return boundaries.map(boundary => boundary.x).sort((a, b) => a - b);
}

function groupPdfLinesByRules(lines, horizontalRules) {
    const rules = [...new Set((horizontalRules || []).map(Number).filter(Number.isFinite))]
        .sort((a, b) => b - a);
    if (rules.length < 3) return lines.map(line => [line]);

    const bands = rules.slice(0, -1).map((top, index) => ({
        top,
        bottom: rules[index + 1],
        lines: []
    }));
    const outside = [];
    for (const line of lines) {
        const y = line.reduce((sum, item) => sum + item.y, 0) / Math.max(line.length, 1);
        const band = bands.find(candidate => y <= candidate.top + 0.5 && y >= candidate.bottom - 0.5);
        if (band) band.lines.push(line);
        else outside.push({ y, lines: [line] });
    }

    const grouped = bands.filter(band => band.lines.length).map(band => ({
        y: band.lines.flat().reduce((sum, item) => sum + item.y, 0) / band.lines.flat().length,
        lines: band.lines
    }));
    return [...grouped, ...outside].sort((a, b) => b.y - a.y).map(group =>
        group.lines.sort((a, b) => (b[0]?.y || 0) - (a[0]?.y || 0))
    );
}

function getPdfHeaderLayout(lineItems) {
    const recognized = [];
    for (const item of lineItems) {
        const roleIndex = identifyColumns([item.text]);
        const role = Object.keys(roleIndex).find(key => roleIndex[key] === 0);
        const isAuxiliaryDate = role === 'date' && /value|effective|settlement/i.test(item.text) &&
            recognized.some(column => column.role === 'date');
        if (role && (!recognized.some(column => column.role === role) || isAuxiliaryDate)) {
            recognized.push({
                role: isAuxiliaryDate ? 'auxiliary-date' : role,
                label: item.text,
                x: item.x + item.width / 2
            });
        }
    }

    const hasDate = recognized.some(column => column.role === 'date');
    const hasTransactionField = recognized.some(column =>
        ['description', 'debit', 'credit', 'amount'].includes(column.role)
    );
    if (!hasDate || !hasTransactionField) return null;

    recognized.sort((a, b) => a.x - b.x);
    return {
        columns: recognized,
        headers: recognized.map(column => column.label)
    };
}

function mapPdfLineToColumns(lineItems, columns, verticalRules = []) {
    const cells = Array(columns.length).fill('');
    for (const item of lineItems) {
        const isDateOrNumber = /^(?:\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,4})?|\(?[-+]?[$£€₦]?\s*\d[\d,]*(?:\.\d+)?\)?(?:\s*(?:cr|dr))?)$/i.test(item.text);
        const position = item.x + (isDateOrNumber ? item.width / 2 : Math.min(item.width / 2, 8));
        let nearestIndex = 0;
        let nearestDistance = Infinity;

        if (verticalRules.length >= 3) {
            const cellIndex = verticalRules.slice(0, -1).findIndex((left, index) =>
                position >= left - 0.5 && position <= verticalRules[index + 1] + 0.5
            );
            if (cellIndex !== -1) {
                const left = verticalRules[cellIndex];
                const right = verticalRules[cellIndex + 1];
                const cellCenter = (left + right) / 2;
                const matchingColumns = columns
                    .map((column, index) => ({ column, index }))
                    .filter(({ column }) => column.x >= left - 1 && column.x <= right + 1);
                const cellColumn = matchingColumns.sort((a, b) =>
                    Math.abs(a.column.x - cellCenter) - Math.abs(b.column.x - cellCenter)
                )[0];
                if (cellColumn) {
                    cells[cellColumn.index] = [cells[cellColumn.index], item.text].filter(Boolean).join(' ');
                    continue;
                }
            }
        }

        columns.forEach((column, index) => {
            // Narration text can span most of its column; don't let later words
            // drift into the next column merely because their x-position is farther right.
            if (!isDateOrNumber && column.x > position + 65) return;
            const distance = Math.abs(column.x - position);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestIndex = index;
            }
        });
        cells[nearestIndex] = [cells[nearestIndex], item.text].filter(Boolean).join(' ');
    }
    return cells;
}

function mapPdfRowToColumns(physicalLines, columns, verticalRules = []) {
    const cells = Array(columns.length).fill('');
    for (const line of physicalLines) {
        const lineCells = mapPdfLineToColumns(line, columns, verticalRules);
        lineCells.forEach((value, index) => {
            if (value) cells[index] = [cells[index], value].filter(Boolean).join(' ');
        });
    }
    return cells;
}

/** Reconstructs PDF text lines into stable columns using the bank's header positions. */
export function reconstructPdfRows(items, initialLayout = null, horizontalRules = [], verticalRules = []) {
    let layout = initialLayout;
    let headerAdded = false;
    const rows = [];

    for (const physicalLines of groupPdfLinesByRules(groupPdfTextItems(items), horizontalRules)) {
        const lineItems = physicalLines.flat();
        const detectedLayout = getPdfHeaderLayout(lineItems);
        if (detectedLayout) {
            layout = detectedLayout;
            if (!headerAdded && !initialLayout) {
                rows.push(detectedLayout.headers);
                headerAdded = true;
            }
            continue;
        }

        if (layout) {
            rows.push(mapPdfRowToColumns(physicalLines, layout.columns, verticalRules));
        } else {
            rows.push(lineItems.map(item => item.text));
        }
    }

    return { rows, layout };
}

function isPdfTransactionDate(value) {
    const text = String(value || '').trim().replace(/([\-/.])\s+(?=\d)/g, '$1');
    const time = '(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s*[ap]m)?)?';
    return new RegExp(`^(?:\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}|\\d{1,2}[-/ ](?:[a-z]{3,}|\\d{1,2})[-/ ]\\d{2,4})${time}$`, 'i').test(text);
}

function isIncompletePdfDate(value) {
    return /^\d{1,2}[-/](?:[a-z]{3,}|\d{1,2})[-/]?$/i.test(String(value || '').trim());
}

/** Combines physical PDF lines into logical transaction rows before parsing amounts. */
export function mergePdfContinuationRows(rows) {
    if (!Array.isArray(rows) || rows.length < 2) return rows || [];

    let headerIndex = -1;
    let headers = [];
    for (let index = 0; index < rows.length; index++) {
        const cells = Array.isArray(rows[index]) ? rows[index] : [];
        const roles = identifyColumns(cells);
        const hasDate = roles.date !== -1;
        const hasTransactionField = ['description', 'debit', 'credit', 'amount'].some(role => roles[role] !== -1);
        if (hasDate && hasTransactionField) {
            headerIndex = index;
            headers = cells.map(cell => String(cell ?? '').trim());
            break;
        }
    }
    if (headerIndex === -1) return rows;

    const columns = identifyColumns(headers);
    const output = rows.slice(0, headerIndex + 1);
    let activeIndex = -1;
    const getCell = (cells, role) => columns[role] === -1 ? '' : String(cells[columns[role]] ?? '').trim();
    const setCell = (cells, role, value) => {
        if (columns[role] !== -1) cells[columns[role]] = value;
    };
    const monetaryRoles = ['debit', 'credit', 'amount', 'balance'];

    for (let index = headerIndex + 1; index < rows.length; index++) {
        const source = rows[index];
        if (!Array.isArray(source)) continue;
        const cells = headers.map((_, cellIndex) => String(source[cellIndex] ?? '').trim());
        if (!cells.some(Boolean)) continue;

        const dateValue = getCell(cells, 'date');
        const hasDate = isPdfTransactionDate(dateValue);
        const rowText = cells.join(' ').toLowerCase();
        const isRepeatedHeader = /\b(?:date|narration|description|particulars)\b/.test(rowText) &&
            /\b(?:debit|credit|amount|balance)\b/.test(rowText) &&
            !monetaryRoles.some(role => Math.abs(parseAmount(getCell(cells, role))) > 0);
        if (isRepeatedHeader) continue;

        if (hasDate) {
            output.push(cells);
            activeIndex = output.length - 1;
            continue;
        }

        const description = getCell(cells, 'description');
        const reference = getCell(cells, 'reference');
        const payer = getCell(cells, 'payer');
        const type = getCell(cells, 'type');
        const hasMoney = monetaryRoles.some(role => Math.abs(parseAmount(getCell(cells, role))) > 0);
        const hasUsefulData = Boolean(description || reference || payer || type || hasMoney);
        const isPageTimestamp = /^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)$/i.test(dateValue);
        const summaryOrPageLine = /^(?:total\b|opening balance\b|closing balance\b|balance\s+(?:brought forward|carried forward|(?:b|c)\s*\/\s*f)\b|brought forward\b|carried forward\b|page\s+\d+\b|continued\b|end of statement\b|statement\s+(?:period|date|of account)\b|customer\s+(?:care|service)\b|for more information\b|this is a (?:computer[- ]generated|system[- ]generated)\b|generated\s+(?:on|by)\b|thank you\b)/i.test(description || dateValue) || (isPageTimestamp && !hasMoney);

        // A date-column item that is not a date is usually a page heading/footer, not a transaction.
        if (!hasUsefulData || (summaryOrPageLine && !hasMoney)) continue;

        if (activeIndex === -1) {
            if (!isIncompletePdfDate(dateValue)) setCell(cells, 'date', '');
            output.push(cells);
            activeIndex = output.length - 1;
            continue;
        }

        const active = output[activeIndex];
        const conflictsWithExistingAmount = monetaryRoles.some(role => {
            const incoming = getCell(cells, role);
            const existing = getCell(active, role);
            return Math.abs(parseAmount(incoming)) > 0 && Math.abs(parseAmount(existing)) > 0 &&
                Math.abs(parseAmount(incoming) - parseAmount(existing)) > 0.000001;
        });
        const activeReference = normalizePdfFragment(getCell(active, 'reference'));
        const incomingReference = normalizePdfFragment(reference);
        const conflictsWithReference = hasMoney && activeReference && incomingReference &&
            activeReference !== incomingReference;
        if ((conflictsWithExistingAmount && (hasMoney || (description && getCell(active, 'description')))) || conflictsWithReference) {
            // Keep an independently complete row separate instead of assigning its amount to the wrong transaction.
            if (!isIncompletePdfDate(dateValue)) setCell(cells, 'date', '');
            output.push(cells);
            activeIndex = output.length - 1;
            continue;
        }

        const activeDate = getCell(active, 'date');
        if (/^\d{2,4}$/.test(dateValue) && /[-/]\s*$/.test(activeDate)) {
            const completedDate = `${activeDate.trim()}${dateValue}`;
            if (isPdfTransactionDate(completedDate)) setCell(active, 'date', completedDate);
        }
        if (columns.date !== -1) setCell(cells, 'date', '');

        for (const role of ['description', 'reference', 'payer', 'type']) {
            const incoming = getCell(cells, role);
            if (!incoming) continue;
            const existing = getCell(active, role);
            if (!existing) setCell(active, role, incoming);
            else if (normalizePdfFragment(existing) !== normalizePdfFragment(incoming)) setCell(active, role, `${existing} ${incoming}`.trim());
        }
        for (const role of monetaryRoles) {
            const incoming = getCell(cells, role);
            if (incoming && !getCell(active, role)) setCell(active, role, incoming);
        }
    }

    return output;
}

function normalizePdfFragment(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
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
    const skippedRows = [];
    const sourceDataRowCount = rows.slice(headerIdx + 1).filter(row => {
        if (!row) return false;
        const cells = Array.isArray(row) ? row : Object.values(row);
        return cells.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== '');
    }).length;

    for (let i = headerIdx + 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r) continue;
        const cells = Array.isArray(r) ? r : headers.map(h => r[h]);
        if (!cells.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== '')) continue;

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
        const hasTransactionAmount = [rawDebit, rawCredit, rawAmount].some(value => Math.abs(parseAmount(value)) > 0);

        if (options.joinContinuationRows && !dateStr && description && !hasTransactionAmount &&
            !reference && !payer && !String(rawType || '').trim() &&
            Math.abs(parseAmount(rawBalance)) === 0 && transactions.length > 0 &&
            !/^(?:total\b|opening balance\b|closing balance\b|balance brought forward\b|brought forward\b|balance carried forward\b|carried forward\b|page\s+\d+\b|continued\b|end of statement\b)/i.test(description)) {
            const previous = transactions[transactions.length - 1];
            previous.description = [previous.description, description].filter(Boolean).join(' ');
            continue;
        }

        // Skip malformed rows, while retaining an audit trail with source row numbers.
        if (!dateStr && !description && !rawDebit && !rawCredit && !rawAmount) {
            skippedRows.push({ rowNumber: i + 1, reason: 'No date, description, or amount.' });
            continue;
        }
        const lowerDesc = description.toLowerCase();
        const isSummaryDescription = /^(?:totals?\b|opening balance\b|closing balance\b|balance\s+(?:brought forward|carried forward|(?:b|c)\s*\/\s*f)\b|brought forward\b|carried forward\b)/i.test(lowerDesc);
        if (isSummaryDescription && (!dateStr || !hasTransactionAmount)) {
            skippedRows.push({ rowNumber: i + 1, reason: 'Statement summary/balance row.', description });
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
        if (signedAmount === 0 && !dateStr) {
            skippedRows.push({ rowNumber: i + 1, reason: 'No valid transaction date or non-zero amount.', description });
            continue;
        }

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

    transactions.extractionInfo = {
        sourceRowCount: rows.length,
        headerRowNumber: headerIdx + 1,
        dataRowCount: sourceDataRowCount,
        extractedCount: transactions.length,
        skippedRows
    };
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
export async function parsePdf(file, options = {}) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // Let Vite emit the matching PDF.js worker as an asset for dev and production.
    // PDF.js v6 does not provide a default workerSrc in this dynamic-import path.
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        '../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs',
        import.meta.url
    ).toString();
    const arrayBuffer = await file.arrayBuffer();
    const documentOptions = { data: new Uint8Array(arrayBuffer) };
    if (options.password) documentOptions.password = String(options.password);
    const loadingTask = pdfjs.getDocument(documentOptions);
    let pdf;
    try {
        pdf = await loadingTask.promise;
    } catch (error) {
        const passwordResponses = pdfjs.PasswordResponses || {};
        const needsPassword = Number(error?.code) === Number(passwordResponses.NEED_PASSWORD ?? 1);
        const incorrectPassword = Number(error?.code) === Number(passwordResponses.INCORRECT_PASSWORD ?? 2);
        if (error?.name === 'PasswordException' || needsPassword || incorrectPassword) {
            const passwordError = new Error(incorrectPassword
                ? 'The PDF password was incorrect. Please check it and try again.'
                : 'This PDF is password-protected. Enter its password above and try again.');
            passwordError.code = incorrectPassword ? 'PDF_PASSWORD_INCORRECT' : 'PDF_PASSWORD_REQUIRED';
            throw passwordError;
        }
        throw error;
    }

    const allLines = [];
    let layout = null;

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const operatorList = await page.getOperatorList();
        const horizontalRules = extractPdfHorizontalRules(operatorList, pdfjs.OPS);
        const verticalRules = extractPdfVerticalRules(operatorList, pdfjs.OPS);

        const reconstructed = reconstructPdfRows(textContent.items, layout, horizontalRules, verticalRules);
        layout = reconstructed.layout || layout;
        allLines.push(...reconstructed.rows);
    }

    return extractFromRawRows(mergePdfContinuationRows(allLines), { joinContinuationRows: true });
}

/**
 * Master parser: detects file type and delegates
 */
export async function extractTransactionsFromFile(file, options = {}) {
    const fileName = String(file.name || '').toLowerCase();

    if (fileName.endsWith('.pdf')) {
        return parsePdf(file, options);
    } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls') || fileName.endsWith('.csv') || fileName.endsWith('.txt')) {
        return parseSpreadsheet(file);
    } else {
        throw new Error(`Unsupported file type. Please upload a PDF, XLSX, XLS or CSV file.`);
    }
}
