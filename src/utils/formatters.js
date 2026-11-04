export function formatCurrency(amount) {
  const num = Number(amount) || 0;
  const isInteger = num % 1 === 0;
  return '\u20A6' + new Intl.NumberFormat('en-US', {
    minimumFractionDigits: isInteger ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(num);
}

/**
 * Formats a number with thousands separators, no currency symbol.
 * Shows decimals only when present: 20000 -> "20,000", 20000.34 -> "20,000.34"
 */
export function formatNumber(amount) {
  const num = Number(amount) || 0;
  const isInteger = num % 1 === 0;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: isInteger ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(num)
}

/**
 * Extracts milliseconds from various date formats (String, ISO, Firebase Timestamp)
 */
export function getTimestampMs(dateVal) {
  if (!dateVal) return 0
  
  // Handle Firestore Timestamp (Object with seconds/nanoseconds)
  if (typeof dateVal === 'object') {
    if (typeof dateVal.toDate === 'function') return dateVal.toDate().getTime()
    if (dateVal.seconds !== undefined) return dateVal.seconds * 1000
    if (dateVal._seconds !== undefined) return dateVal._seconds * 1000
  }
  
  // Handle Date object or ISO string
  const d = new Date(dateVal)
  return isNaN(d.getTime()) ? 0 : d.getTime()
}

/**
 * Formats a date for display: DD MMM, YYYY (e.g. 18 Apr, 2026)
 */
export function formatDate(dateVal) {
    if (!dateVal) return '';
    const ms = getTimestampMs(dateVal);
    if (ms === 0) return String(dateVal);
    
    const date = new Date(ms);
    const day = String(date.getDate()).padStart(2, '0');
    const month = date.toLocaleString('default', { month: 'short' });
    const year = date.getFullYear();

    return `${day} ${month}, ${year}`;
}

/**
 * Formats a date with time for display: DD MMM, YYYY HH:MM AM/PM (e.g. 23 Jun, 2026 02:45 PM)
 */
export function formatDateTime(dateVal) {
    if (!dateVal) return '';
    const ms = getTimestampMs(dateVal);
    if (ms === 0) return String(dateVal);
    
    const date = new Date(ms);
    const day = String(date.getDate()).padStart(2, '0');
    const month = date.toLocaleString('default', { month: 'short' });
    const year = date.getFullYear();
    
    let hours = date.getHours();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    const hoursStr = String(hours).padStart(2, '0');
    const minutesStr = String(date.getMinutes()).padStart(2, '0');

    return `${day} ${month}, ${year} ${hoursStr}:${minutesStr} ${ampm}`;
}

/**
 * Formats a date for <input type="date">: YYYY-MM-DD
 */
export function formatDateForInput(dateVal) {
    if (!dateVal) return ''
    const ms = getTimestampMs(dateVal)
    if (ms === 0) return ''
    
    const date = new Date(ms)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    
    return `${year}-${month}-${day}`
}

/**
 * Real Excel date serial (1900 date system) for a day-precision value.
 * Built with pure calendar arithmetic — no JS Date is passed to ExcelJS, so
 * neither ExcelJS nor Excel can apply a timezone shift: the integer serial
 * carries no time fraction at all. The cell stays a true date (sorting,
 * filtering, DATEDIF and arithmetic all work) with a date-only number format.
 * ISO strings use their literal YYYY-MM-DD prefix (the exact DB day);
 * Date/Timestamp values use local calendar parts (same day the preview shows).
 * Returns null when the value has no usable calendar day.
 */
export function toExcelDateSerial(dateVal) {
    if (dateVal === null || dateVal === undefined || dateVal === '') return null
    // A bare number is never a day-precision date here (EOD summary amounts
    // reuse the report grid) — new Date(50000) would "succeed" as Jan 1970.
    if (typeof dateVal === 'number') return null
    let y, m, d
    if (typeof dateVal === 'string') {
        const prefix = dateVal.slice(0, 10).split('-')
        if (prefix.length === 3 && prefix[0].length === 4) {
            y = Number(prefix[0]); m = Number(prefix[1]) - 1; d = Number(prefix[2])
        } else {
            const t = new Date(dateVal)
            if (isNaN(t.getTime())) return null
            y = t.getFullYear(); m = t.getMonth(); d = t.getDate()
        }
    } else {
        const ms = dateVal instanceof Date ? dateVal.getTime() : getTimestampMs(dateVal)
        if (!ms || isNaN(ms)) return null
        const t = new Date(ms)
        y = t.getFullYear(); m = t.getMonth(); d = t.getDate()
    }
    if (![y, m, d].every(Number.isFinite) || m < 0 || m > 11 || d < 1 || d > 31 || y < 1900 || y > 2100) return null
    return Math.round(Date.UTC(y, m, d) / 86400000) + 25569
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;')
}

export function generateId(cooperativeId) {
    const prefix = cooperativeId ? cooperativeId : '';
    const uuid = crypto.randomUUID();
    return prefix ? `${prefix}-${uuid}` : uuid;
}

export function generateRemittanceId(cooperativeId, isAutogen = false) {
    const prefix = cooperativeId;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const datetime = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return isAutogen ? `${prefix}-AUTOGEN-${datetime}` : `${prefix}-${datetime}`;
}

// Compact human reference for a document id (remittance ids are long
// timestamp strings like PREFIX-YYYYMMDDHHMMSS). Used anywhere the old
// sequential receipt number used to be shown.
export function shortRef(id) {
    const s = String(id || '').trim();
    if (!s) return '';
    return s.length > 8 ? s.slice(-8) : s;
}

// Display slice of a remittance id from the month character to the end,
// e.g. CG0nA-20260913131208-RV23EN-1 -> "0913131208-RV23EN-1" and
// CG0nA-20260913131652 -> "0913131652". Falls back to shortRef when
// the id carries no 14-digit timestamp segment.
export function timestampTail(id) {
    const s = String(id || '').trim();
    if (!s) return '';
    const m = s.match(/\d{14}/);
    if (m && typeof m.index === 'number') return s.slice(m.index + 4);
    return shortRef(s);
}

/**
 * Hashes a password using SHA-256 (Web Crypto API with JS Fallback)
 */
export async function hashPassword(password) {
    if (!password) return "";
    
    // Attempt Web Crypto API first
    if (window.crypto && window.crypto.subtle) {
        try {
            const msgBuffer = new TextEncoder().encode(password);
            const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            console.warn("Web Crypto failed, using fallback:", e);
        }
    }

    // Pure JS Fallback (Minimal SHA-256 implementation)
    console.log("Using JS Fallback for hashing...");
    const sha256 = (ascii) => {
        function rightRotate(value, amount) {
            return (value >>> amount) | (value << (32 - amount));
        }
        
        const Math_pow = Math.pow;
        const maxWord = Math_pow(2, 32);
        const lengthProperty = 'length'
        let i, j; // Used as a counter across the whole file
        let result = ''

        const words = [];
        const asciiBitLength = ascii[lengthProperty] * 8;
        
        //* caching results for performance
        let hash = sha256.h = sha256.h || [];
        let k = sha256.k = sha256.k || [];
        let primeCounter = k[lengthProperty];

        const isPrime = (n) => {
            for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
            return true;
        }

        const getFractionalBits = (n) => ((n - Math.floor(n)) * maxWord) | 0;

        for (let n = 2; primeCounter < 64; n++) {
            if (isPrime(n)) {
                if (primeCounter < 8) hash[primeCounter] = getFractionalBits(Math_pow(n, 1 / 2));
                k[primeCounter] = getFractionalBits(Math_pow(n, 1 / 3));
                primeCounter++;
            }
        }
        
        ascii += '\x80' // Append '1' bit (plus zero padding)
        while (ascii[lengthProperty] % 64 - 56) ascii += '\x00' // More zero padding
        for (i = 0; i < ascii[lengthProperty]; i++) {
            j = ascii.charCodeAt(i);
            if (j >> 8) return; // ASCII check: only accept characters in range 0-255
            words[i >> 2] |= j << ((3 - i % 4) * 8);
        }
        words[words[lengthProperty]] = ((asciiBitLength / maxWord) | 0);
        words[words[lengthProperty]] = (asciiBitLength | 0)

        for (j = 0; j < words[lengthProperty]; ) {
            const w = words.slice(j, j += 16); // The message is expanded into 64 words
            const oldHash = hash;
            hash = hash.slice(0, 8);
            
            for (i = 0; i < 64; i++) {
                const w15 = w[i - 15], w2 = w[i - 2];
                const a = hash[0], e = hash[4];
                const temp1 = hash[7]
                    + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) // S1
                    + ((e & hash[5]) ^ (~e & hash[6])) // ch
                    + k[i]
                    + (w[i] = (i < 16) ? w[i] : (
                            w[i - 16]
                            + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) // s0
                            + w[i - 7]
                            + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10)) // s1
                        ) | 0
                    );
                const temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) // S0
                    + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2])); // maj
                
                hash = [(temp1 + temp2) | 0].concat(hash);
                hash[4] = (hash[4] + temp1) | 0;
            }
            
            for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
        }
        
        for (i = 0; i < 8; i++) {
            for (j = 3; j + 1; j--) {
                const b = (hash[i] >> (j * 8)) & 255;
                result += ((b < 16) ? '0' : '') + b.toString(16);
            }
        }
        return result;
    };

    return sha256(password);
}

/**
 * Generates a random 4-digit numeric string
 * @deprecated Use generateRandom6Digit() — the system now uses 6-digit PINs.
 */
export function generateRandom4Digit() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

/**
 * Generates a random 6-digit numeric PIN string
 */
export function generateRandom6Digit() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Password policy: new passwords must be exactly 6 digits (letters not allowed).
 */
export function isSixDigitPin(val) {
  return typeof val === 'string' && /^\d{6}$/.test(val);
}

/**
 * Legacy password policy (grandfathered): min 8 chars with upper, lower,
 * digit and special character, e.g. "Adex@1234". These keep working
 * without a forced change.
 */
export function isLegacyComplexPassword(val) {
  return typeof val === 'string' && val.length >= 8
    && /[a-z]/.test(val)
    && /[A-Z]/.test(val)
    && /\d/.test(val)
    && /[^A-Za-z0-9]/.test(val);
}

export function isSha256Hex(val) {
  return typeof val === 'string' && /^[a-f0-9]{64}$/i.test(val);
}

/**
 * Force-change evaluation AFTER credentials have verified.
 * Returns true when the user must set a new password:
 *  1. the typed password is exactly 123456, the explicit force-change flag is set,
 *     or the stored hash is empty/missing;
 *  2. the stored value is plain text rather than a SHA-256 hash;
 *  3. a verified hash belongs to a password that is neither an allowed PIN nor
 *     a grandfathered legacy-complex password.
 * The exact PIN 123456 always requires replacement, regardless of storage format.
 */
export function needsForceChangeAfterMatch(stored, typedInput, forceFlag) {
  if (String(typedInput ?? '') === '123456') return true;
  if (forceFlag === true) return true;
  if (!stored) return true;
  if (!isSha256Hex(stored)) return true;
  if (isSixDigitPin(typedInput)) return false;
  if (isLegacyComplexPassword(typedInput)) return false;
  return true;
}

/**
 * Validates a 6-digit PIN
 */
export function validatePin(pin) {
  return typeof pin === 'string' && /^\d{6}$/.test(pin);
}

/**
 * Gets PIN value from 6 individual inputs
 */
export function getPinFromInputs(container) {
  let pin = '';
  for (let i = 0; i < 6; i++) {
    const input = container.querySelector(`input[name="pin-${i}"]`) || container.querySelector(`input[name="new-pin-${i}"]`) || container.querySelector(`input[name="confirm-pin-${i}"]`);
    if (input) pin += input.value;
  }
  return pin;
}

/**
 * Sets up PIN input auto-focus behavior
 */
export function setupPinInputs(container, selectorPrefix = 'pin') {
  const inputs = Array.from({length: 6}, (_, i) => container.querySelector(`input[name="${selectorPrefix}-${i}"]`));
  inputs.forEach((input, idx, arr) => {
    if (!input) return;
    input.addEventListener('input', (e) => {
      if (e.target.value.length === 1 && idx < arr.length - 1) {
        arr[idx + 1]?.focus();
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !e.target.value && idx > 0) {
        arr[idx - 1]?.focus();
      }
    });
  });
  return inputs;
}

/**
 * Gmail-style deterministic avatar color for a name (shared by members
 * table, member modal and duplicates review so colors stay consistent).
 */
const AVATAR_COLORS = [
    '#f44336', '#e91e63', '#9c27b0', '#673ab7',
    '#3f51b5', '#2196f3', '#03a9f4', '#00bcd4',
    '#009688', '#4caf50', '#8bc34a', '#cddc39',
    '#ffeb3b', '#ffc107', '#ff9800', '#ff5722'
]

export function getAvatarColor(name) {
    if (!name) return '#999'
    let hash = 0
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash)
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

/**
 * Generates initials from a full name (up to 2 characters)
 */
export function getInitials(name) {
    if (!name) return '';
    const parts = String(name).trim().split(/\s+/);
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

/**
 * Converts a native <input type="date"> into a custom formatted date input
 * that shows "DD MMM, YYYY" but uses the native date picker
 * @param {HTMLInputElement} dateInput - The original input type="date" element
 */
export function wrapDateInput(dateInput) {
    if (!dateInput || dateInput.type !== 'date') return;
    
    // Create wrapper div
    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.style.display = 'inline-block';
    wrapper.style.width = '100%';
    wrapper.style.cursor = 'pointer';
    
    // Create formatted display input
    const displayInput = document.createElement('input');
    displayInput.type = 'text';
    displayInput.readOnly = true;
    displayInput.style.width = '100%';
    displayInput.style.boxSizing = 'border-box';
    displayInput.style.cursor = 'pointer';
    displayInput.style.pointerEvents = 'none';
    displayInput.className = dateInput.className; // Copy original classes
    
    // Update display input whenever date input changes
    const updateDisplay = () => {
        if (dateInput.value) {
            displayInput.value = formatDate(dateInput.value);
        } else {
            displayInput.value = 'DD MMM, YYYY';
        }
    };
    
    dateInput.addEventListener('change', updateDisplay);
    dateInput.addEventListener('input', updateDisplay);
    
    // When wrapper is clicked, open the native date picker
    wrapper.addEventListener('click', (e) => {
        if (e.target === dateInput) return;
        try {
            if (typeof dateInput.showPicker === 'function') {
                dateInput.showPicker();
            } else {
                dateInput.click();
            }
        } catch (err) {
            dateInput.click();
        }
    });
    
    // Insert wrapper and display input in the DOM
    dateInput.parentNode.insertBefore(wrapper, dateInput);
    wrapper.appendChild(displayInput);
    wrapper.appendChild(dateInput);
    
    // Hide original date input but keep it functional
    dateInput.style.position = 'absolute';
    dateInput.style.top = '0';
    dateInput.style.left = '0';
    dateInput.style.width = '100%';
    dateInput.style.height = '100%';
    dateInput.style.opacity = '0';
    dateInput.style.cursor = 'pointer';
    dateInput.style.boxSizing = 'border-box';
    dateInput.style.pointerEvents = 'none';
    
    // Initialize display
    updateDisplay();
    
    return displayInput;
}
