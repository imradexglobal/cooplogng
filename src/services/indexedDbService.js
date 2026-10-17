/**
 * indexedDbService.js
 * Dedicated native IndexedDB storage wrapper.
 * Provides transactional access, batching, index-based queries, and schema management.
 * Natively supports databases up to 50MB+ (up to 50% of free disk space).
 */

const DB_NAME = 'CoopLogIDB_v3';
const DB_VERSION = 9; // v9: heal stores missing on intermediate-version DBs (see v9 block)

// Object stores mapped to application tables
const STORES = {
    cooperatives: { keyPath: 'id' },
    users: { keyPath: 'id' },
    sync_queue: { keyPath: 'id', autoIncrement: true },
    sync_state: { keyPath: 'cooperative_id' },
    loans: { keyPath: 'id' },
    loan_guarantors: { keyPath: 'id' },
    members: { keyPath: 'id' },
    bank: { keyPath: 'id' },
    enterprise: { keyPath: 'id' },
    remittance: { keyPath: 'id' },
    transaction_types: { keyPath: 'id' },
    remittance_detail: { keyPath: 'id' },
    notifications: { keyPath: 'id' },
    payment_advise: { keyPath: 'id' },
    bank_reconciliation_summary: { keyPath: 'id' },
    feedback: { keyPath: 'id' },
    app_settings: { keyPath: 'key' },
    membership_request: { keyPath: 'id' }
};

let dbInstance = null;
let initPromise = null;

/**
 * Deletes and recreates the database if corrupted
 */
async function resetDatabase() {
  return new Promise((resolve, reject) => {
    console.warn('[IndexedDB] Attempting to reset database due to corruption...');
    const deleteReq = indexedDB.deleteDatabase(DB_NAME);
    
    deleteReq.onsuccess = () => {
      console.log('[IndexedDB] Database deleted successfully. Recreating...');
      dbInstance = null;
      initPromise = null;
      resolve(initIndexedDb());
    };
    
    deleteReq.onerror = (e) => {
      console.error('[IndexedDB] Failed to delete database:', e.target.error);
      reject(e.target.error);
    };
    
    deleteReq.onblocked = () => {
      console.warn('[IndexedDB] Database deletion blocked. Please close all other tabs/windows using this app.');
    };
  });
}

/**
 * Initializes the IndexedDB database and creates object stores / indexes.
 */
export function initIndexedDb() {
  if (initPromise) return initPromise;

  initPromise = new Promise((resolve, reject) => {
    if (dbInstance) {
      return resolve(dbInstance);
    }

    console.log('[IndexedDB] Opening database:', DB_NAME, 'version:', DB_VERSION);
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const oldVersion = e.oldVersion;
      console.log('[IndexedDB] Upgrading schema from version', oldVersion, 'to', DB_VERSION);

      // ── Version 1: Create all stores ──────────────────────────────────
      if (oldVersion < 1) {
        for (const [storeName, config] of Object.entries(STORES)) {
          if (!db.objectStoreNames.contains(storeName)) {
            console.log(`[IndexedDB] Creating store: ${storeName}`);
            const store = db.createObjectStore(storeName, {
              keyPath: config.keyPath,
              autoIncrement: config.autoIncrement || false
            });

            // Version 1 indexes
            if (storeName === 'members') {
              store.createIndex('cooperative_id', 'cooperative_id', { unique: false });
            } else if (storeName === 'remittance') {
              store.createIndex('cooperative_id', 'cooperative_id', { unique: false });
              store.createIndex('member_id', 'member_id', { unique: false });
            } else if (storeName === 'loans') {
              store.createIndex('cooperative_id', 'cooperative_id', { unique: false });
              store.createIndex('member_id', 'member_id', { unique: false });
            } else if (storeName === 'remittance_detail') {
              store.createIndex('remittance_id', 'remittance_id', { unique: false });
            } else if (storeName === 'sync_queue') {
              store.createIndex('status', 'status', { unique: false });
            }
          }
        }
      }

      // ── Version 2: Add new relation indexes for child cleanup ──────────
      if (oldVersion < 2) {
        // For stores that already exist, get them from the transaction
        const tx = e.target.transaction;

        // loans: add remittance_id index for cascade delete
        if (db.objectStoreNames.contains('loans')) {
          const loansStore = tx.objectStore('loans');
          if (!loansStore.indexNames.contains('remittance_id')) {
            loansStore.createIndex('remittance_id', 'remittance_id', { unique: false });
            console.log('[IndexedDB] Added loans.remittance_id index');
          }
        }

        // loan_guarantors: add loan_id index for cascade delete
        if (db.objectStoreNames.contains('loan_guarantors')) {
          const lgStore = tx.objectStore('loan_guarantors');
          if (!lgStore.indexNames.contains('loan_id')) {
            lgStore.createIndex('loan_id', 'loan_id', { unique: false });
            console.log('[IndexedDB] Added loan_guarantors.loan_id index');
          }
        }

        // payment_advise: add member_id index for cascade delete
        if (db.objectStoreNames.contains('payment_advise')) {
          const paStore = tx.objectStore('payment_advise');
          if (!paStore.indexNames.contains('member_id')) {
            paStore.createIndex('member_id', 'member_id', { unique: false });
            console.log('[IndexedDB] Added payment_advise.member_id index');
          }
        }

        // notifications: add cooperative_id index for listing
        if (db.objectStoreNames.contains('notifications')) {
          const notifStore = tx.objectStore('notifications');
          if (!notifStore.indexNames.contains('cooperative_id')) {
            notifStore.createIndex('cooperative_id', 'cooperative_id', { unique: false });
            console.log('[IndexedDB] Added notifications.cooperative_id index');
          }
        }

        // sync_queue: add collection_name + document_id composite index for dedup
        if (db.objectStoreNames.contains('sync_queue')) {
          const sqStore = tx.objectStore('sync_queue');
          if (!sqStore.indexNames.contains('collection_document')) {
            sqStore.createIndex('collection_document', ['collection_name', 'document_id'], { unique: false });
            console.log('[IndexedDB] Added sync_queue collection_document composite index');
          }
        }
      }

      // ── Version 3: Add loan_id index to remittance for cascade delete ────
      if (oldVersion < 3) {
        const tx = e.target.transaction;
        // remittance: add loan_id index for cascade delete of autogen remittances
        if (db.objectStoreNames.contains('remittance')) {
          const remStore = tx.objectStore('remittance');
          if (!remStore.indexNames.contains('loan_id')) {
            remStore.createIndex('loan_id', 'loan_id', { unique: false });
            console.log('[IndexedDB] Added remittance.loan_id index');
          }
        }
      }

      // ── Version 4: Add cooperative_id indexes for efficient filtering ─────
      if (oldVersion < 4) {
        const tx = e.target.transaction;
        const coopStores = ['users', 'bank', 'enterprise', 'transaction_types', 'loan_guarantors', 'payment_advise', 'bank_reconciliation_summary'];
        for (const storeName of coopStores) {
          if (db.objectStoreNames.contains(storeName)) {
            const store = tx.objectStore(storeName);
            if (!store.indexNames.contains('cooperative_id')) {
              store.createIndex('cooperative_id', 'cooperative_id', { unique: false });
              console.log(`[IndexedDB] Added ${storeName}.cooperative_id index`);
            }
          }
        }
      }

      // ── Version 5: feedback store + sync_queue.cooperative_id index ─────
      if (oldVersion < 5) {
        const tx = e.target.transaction;
        if (!db.objectStoreNames.contains('feedback')) {
          const fb = db.createObjectStore('feedback', { keyPath: 'id' });
          fb.createIndex('cooperative_id', 'cooperative_id', { unique: false });
          console.log('[IndexedDB] Created feedback store');
        } else {
          try {
            const fb = tx.objectStore('feedback');
            if (!fb.indexNames.contains('cooperative_id')) {
              fb.createIndex('cooperative_id', 'cooperative_id', { unique: false });
            }
          } catch {}
        }
        if (db.objectStoreNames.contains('sync_queue')) {
          try {
            const sq = tx.objectStore('sync_queue');
            if (!sq.indexNames.contains('cooperative_id')) {
              sq.createIndex('cooperative_id', 'cooperative_id', { unique: false });
              console.log('[IndexedDB] Added sync_queue.cooperative_id index');
            }
          } catch {}
        }
      }

      // ── Version 6: self-heal any store/index missing on stale devices ──
      // Devices whose DB was created before a store existed (and no earlier
      // upgrade block created it) would otherwise crash every transaction
      // touching it (e.g. database export). Recreate what's missing.
      if (oldVersion < 6) {
        const tx = e.target.transaction;
        const INDEXES = {
          members: ['cooperative_id'],
          remittance: ['cooperative_id', 'member_id', 'loan_id', 'parent_remittance_id'],
          loans: ['cooperative_id', 'member_id', 'remittance_id'],
          remittance_detail: ['remittance_id'],
          sync_queue: ['status', 'cooperative_id'],
          loan_guarantors: ['loan_id', 'cooperative_id'],
          payment_advise: ['member_id', 'cooperative_id'],
          notifications: ['cooperative_id'],
          users: ['cooperative_id'],
          bank: ['cooperative_id'],
          enterprise: ['cooperative_id'],
          transaction_types: ['cooperative_id'],
          bank_reconciliation_summary: ['cooperative_id'],
          feedback: ['cooperative_id'],
          membership_request: ['cooperative_id'],
        };
        for (const [storeName, config] of Object.entries(STORES)) {
          try {
            let store = null;
            if (!db.objectStoreNames.contains(storeName)) {
              store = db.createObjectStore(storeName, {
                keyPath: config.keyPath,
                autoIncrement: config.autoIncrement || false
              });
              console.log(`[IndexedDB] v6 healed missing store: ${storeName}`);
            } else {
              store = tx.objectStore(storeName);
            }
            for (const idx of (INDEXES[storeName] || [])) {
              if (!store.indexNames.contains(idx)) {
                store.createIndex(idx, idx, { unique: false });
                console.log(`[IndexedDB] v6 healed missing index: ${storeName}.${idx}`);
              }
            }
            if (storeName === 'sync_queue' && !store.indexNames.contains('collection_document')) {
              store.createIndex('collection_document', ['collection_name', 'document_id'], { unique: false });
              console.log('[IndexedDB] v6 healed missing index: sync_queue.collection_document');
            }
          } catch (err) {
            console.warn(`[IndexedDB] v6 heal skipped ${storeName}:`, err && err.message);
          }
        }
      }

      // ── Version 7: add parent_remittance_id index on remittance ─────
      if (oldVersion < 7) {
        const tx = e.target.transaction;
        if (db.objectStoreNames.contains('remittance')) {
          const remStore = tx.objectStore('remittance');
          if (!remStore.indexNames.contains('parent_remittance_id')) {
            remStore.createIndex('parent_remittance_id', 'parent_remittance_id', { unique: false });
            console.log('[IndexedDB] Added remittance.parent_remittance_id index');
          }
        }
      }

      // ── Version 8: membership_request store for self-registration ────
      if (oldVersion < 8) {
        if (!db.objectStoreNames.contains('membership_request')) {
          const mrStore = db.createObjectStore('membership_request', { keyPath: 'id' });
          mrStore.createIndex('cooperative_id', 'cooperative_id', { unique: false });
          console.log('[IndexedDB] Created membership_request store');
        } else {
          const tx = e.target.transaction;
          const mrStore = tx.objectStore('membership_request');
          if (!mrStore.indexNames.contains('cooperative_id')) {
            mrStore.createIndex('cooperative_id', 'cooperative_id', { unique: false });
            console.log('[IndexedDB] Added membership_request.cooperative_id index');
          }
        }
      }

      // ── Version 9: heal ANY store/index missing on stale or intermediate DBs ──
      // A device that ran an intermediate build (version bumped before a
      // store's creation code shipped) can be stuck at the current version
      // WITHOUT the store — onupgradeneeded never fires again, and every
      // write to that store throws NotFoundError. Detect and recreate
      // anything missing. Non-destructive: existing data is preserved.
      if (oldVersion < 9) {
        const tx = e.target.transaction;
        const INDEXES = {
          members: ['cooperative_id'],
          remittance: ['cooperative_id', 'member_id', 'loan_id', 'parent_remittance_id'],
          loans: ['cooperative_id', 'member_id', 'remittance_id'],
          remittance_detail: ['remittance_id'],
          sync_queue: ['status', 'cooperative_id'],
          loan_guarantors: ['loan_id', 'cooperative_id'],
          payment_advise: ['member_id', 'cooperative_id'],
          notifications: ['cooperative_id'],
          users: ['cooperative_id'],
          bank: ['cooperative_id'],
          enterprise: ['cooperative_id'],
          transaction_types: ['cooperative_id'],
          bank_reconciliation_summary: ['cooperative_id'],
          feedback: ['cooperative_id'],
          membership_request: ['cooperative_id'],
        };
        for (const [storeName, config] of Object.entries(STORES)) {
          try {
            let store = null;
            if (!db.objectStoreNames.contains(storeName)) {
              store = db.createObjectStore(storeName, {
                keyPath: config.keyPath,
                autoIncrement: config.autoIncrement || false
              });
              console.log(`[IndexedDB] v9 healed missing store: ${storeName}`);
            } else {
              store = tx.objectStore(storeName);
            }
            for (const idx of (INDEXES[storeName] || [])) {
              if (!store.indexNames.contains(idx)) {
                store.createIndex(idx, idx, { unique: false });
                console.log(`[IndexedDB] v9 healed missing index: ${storeName}.${idx}`);
              }
            }
            if (storeName === 'sync_queue' && !store.indexNames.contains('collection_document')) {
              store.createIndex('collection_document', ['collection_name', 'document_id'], { unique: false });
              console.log('[IndexedDB] v9 healed missing index: sync_queue.collection_document');
            }
          } catch (err) {
            console.warn(`[IndexedDB] v9 heal skipped ${storeName}:`, err && err.message);
          }
        }
      }
    };

    req.onsuccess = (e) => {
      dbInstance = e.target.result;

      // ── Self-heal: missing stores on stale/intermediate DBs ────────────
      // A DB can end up at the current version WITHOUT a store if it was
      // created by an intermediate build (version bumped before the store's
      // creation code shipped) — onupgradeneeded never fires again, so the
      // version-gated heal blocks can't help. Detect any missing store after
      // a successful open and recreate the database fresh. A DB missing stores
      // is already broken (every write to them throws NotFoundError), so
      // recreation is strictly better. Same nuclear option as resetDatabase().
      const missingStores = Object.keys(STORES).filter(s => !dbInstance.objectStoreNames.contains(s));
      if (missingStores.length > 0) {
        console.warn('[IndexedDB] Missing stores after open — recreating database. version:', dbInstance.version, 'missing:', missingStores);
        dbInstance.close();
        dbInstance = null;
        initPromise = null;
        try {
          const delReq = indexedDB.deleteDatabase(DB_NAME);
          delReq.onsuccess = () => { initIndexedDb().then(resolve, reject); };
          delReq.onerror = () => reject(delReq.error);
          delReq.onblocked = () => reject(new Error('IndexedDB delete blocked — close other tabs/windows using this app.'));
        } catch (err) {
          reject(err);
        }
        return;
      }

      console.log('[IndexedDB] Database opened successfully. version:', dbInstance.version);

      dbInstance.onclose = () => {
        console.warn('[IndexedDB] Database connection closed unexpectedly. Cache cleared.');
        dbInstance = null;
        initPromise = null;
      };

      dbInstance.onversionchange = () => {
        console.warn('[IndexedDB] Database version change from another tab. Closing connection.');
        dbInstance.close();
        dbInstance = null;
        initPromise = null;
      };

      resolve(dbInstance);
    };

    req.onerror = async (e) => {
      console.error('[IndexedDB] Database open failed:', e.target.error);
      try {
        // Try to reset the database if it's corrupted
        const db = await resetDatabase();
        resolve(db);
      } catch (resetErr) {
        reject(resetErr);
      }
    };

    req.onblocked = () => {
      console.warn('[IndexedDB] Database open blocked. Please close all other tabs/windows using this app.');
    };
  });

  return initPromise;
}

/**
 * Lists the object stores actually present in this device's database.
 * Lets callers skip (instead of crashing on) stores missing from stale DBs.
 */
export async function listStores() {
    const db = await initIndexedDb();
    return Array.from(db.objectStoreNames);
}

/**
 * Gets an item by its primary key.
 */
export async function getItem(storeName, key) {
    const db = await initIndexedDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.get(key);

        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

export function ensureDateWithTime(val) {
    if (!val) return null;
    
    if (typeof val === 'object') {
        let dateObj;
        if (val instanceof Date) {
            dateObj = val;
        } else if (typeof val.toDate === 'function') {
            dateObj = val.toDate();
        } else if (val.seconds !== undefined) {
            dateObj = new Date(val.seconds * 1000);
        } else if (val.type === 'firestore/timestamp/1.0' && val.seconds !== undefined) {
            dateObj = new Date(val.seconds * 1000);
        } else {
            dateObj = new Date(String(val));
        }
        
        if (!isNaN(dateObj.getTime())) {
            return dateObj.toISOString();
        }
        return null;
    }
    
    const str = String(val).trim();
    if (!str) return null;
    
    const hasTime = str.includes(':') || (str.includes('T') && !str.endsWith('T00:00:00.000Z') && !str.endsWith('T00:00:00Z')) || /\b\d{1,2}\s*(am|pm)\b/i.test(str);
    
    const d = new Date(str);
    if (isNaN(d.getTime())) return str;
    
    if (!hasTime) {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    
    return d.toISOString();
}

function sanitizeDates(item) {
    if (!item || typeof item !== 'object') return item;
    const DATE_FIELDS = [
        'created_at', 'modified_at', 'deleted_at', 'sync_at', 'expiry_date',
        'issued_date', 'due_date', 'date_joined', 'remittance_date',
        'last_attempt_at', 'coop_first_month', 'dob', 'last_login'
    ];
    
    const newItem = { ...item };
    for (const key of Object.keys(newItem)) {
        if (DATE_FIELDS.includes(key)) {
            const originalVal = newItem[key];
            if (originalVal !== null && originalVal !== undefined && originalVal !== '') {
                newItem[key] = ensureDateWithTime(originalVal);
            }
        }
    }
    return newItem;
}

/**
 * Saves (adds or updates) a single item.
 */
export async function putItem(storeName, item) {
    const db = await initIndexedDb();
    const sanitized = sanitizeDates(item);
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.put(sanitized);

        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Deletes an item by primary key.
 */
export async function deleteItem(storeName, key) {
    const db = await initIndexedDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.delete(key);

        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

/**
 * Fetches all items in an object store.
 */
export async function getAllItems(storeName) {
    const db = await initIndexedDb();
    if (!db.objectStoreNames.contains(storeName)) return [];
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.getAll();

        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Fetches all items matching a specific index value.
 * @param {string} storeName - The object store name.
 * @param {string} indexName - The name of the index to use.
 * @param {*} key - The index key value to look up.
 */
export async function getAllByIndex(storeName, indexName, key) {
    const db = await initIndexedDb();
    if (!db.objectStoreNames.contains(storeName)) return [];
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const index = store.index(indexName);
        const req = index.getAll(key);

        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Deletes all items matching a specific index value in a single transaction.
 * Used for cascade-deleting child entities (e.g. details when a remittance is overwritten).
 * @param {string} storeName - The object store name.
 * @param {string} indexName - The name of the index to use.
 * @param {*} key - The index key value to match for deletion.
 */
export async function deleteAllByIndex(storeName, indexName, key) {
    const db = await initIndexedDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const index = store.index(indexName);
        const req = index.openCursor(key);

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);

        req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * Batch saves multiple items in a single transaction.
 */
export async function putItemsBatch(storeName, items) {
    if (!items || items.length === 0) return;
    const db = await initIndexedDb();
    const sanitizedItems = items.map(item => sanitizeDates(item));
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);

        for (const item of sanitizedItems) {
            store.put(item);
        }
    });
}

/**
 * Batch deletes multiple items by primary key in a single transaction.
 */
export async function deleteItemsBatch(storeName, keys) {
    if (!keys || keys.length === 0) return;
    const db = await initIndexedDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);

        for (const key of keys) {
            store.delete(key);
        }
    });
}

/**
 * Clears all records from a single object store.
 */
export async function clearStore(storeName) {
    const db = await initIndexedDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.clear();

        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

/**
 * Clears all object stores (full database reset).
 */
export async function clearAllStores() {
    const db = await initIndexedDb();
    const promises = Object.keys(STORES).map(storeName => clearStore(storeName));
    await Promise.all(promises);
}

/**
 * Iterates over a cursor with optional range, direction, limit, and offset.
 * Returns matching items and (optionally) continues to the next page.
 * @param {string} storeName - The object store name.
 * @param {string|null} indexName - Index to use, or null for primary key traversal.
 * @param {IDBKeyRange|null} range - Key range to filter by.
 * @param {'next'|'prev'|'nextunique'|'prevunique'} direction - Cursor direction.
 * @param {number} limit - Max items to return (0 = no limit).
 * @param {number} offset - Number of items to skip.
 * @returns {Promise<Array>}
 */
export async function iterateCursor(storeName, indexName = null, range = null, direction = 'next', limit = 0, offset = 0) {
    const db = await initIndexedDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const source = indexName ? store.index(indexName) : store;
        const req = source.openCursor(range, direction);
        const results = [];
        let skipped = 0;

        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
                resolve(results);
                return;
            }
            if (offset > 0 && skipped < offset) {
                skipped++;
                cursor.continue();
                return;
            }
            results.push(cursor.value);
            if (limit > 0 && results.length >= limit) {
                resolve(results);
                return;
            }
            cursor.continue();
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * Fetches all items matching an index value, with optional limit and offset.
 * @param {string} storeName
 * @param {string} indexName
 * @param {*} key - The index key value
 * @param {number} limit - Max items (0 = no limit)
 * @param {number} offset - Items to skip
 * @returns {Promise<Array>}
 */
export async function getAllByIndexRange(storeName, indexName, key, limit = 0, offset = 0) {
    const range = IDBKeyRange.only(key);
    return iterateCursor(storeName, indexName, range, 'next', limit, offset);
}

/**
 * Counts all items in a store.
 */
export async function countAll(storeName) {
    const db = await initIndexedDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Counts items matching an index key.
 */
export async function countByIndex(storeName, indexName, key) {
    const db = await initIndexedDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const index = store.index(indexName);
        const req = index.count(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Deletes all items matching a filter function.
 * Used when no suitable index exists for deleteAllByIndex.
 * @param {string} storeName
 * @param {function} filterFn - Returns true for items to delete
 */
export async function deleteByFilter(storeName, filterFn) {
    const db = await initIndexedDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.openCursor();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
                if (filterFn(cursor.value)) {
                    cursor.delete();
                }
                cursor.continue();
            }
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * Upserts multiple items in separate transactions (safer for large batches).
 * @param {string} storeName
 * @param {Array} items
 */
export async function putItemsSequential(storeName, items) {
    if (!items || items.length === 0) return;
    for (const item of items) {
        await putItem(storeName, item);
    }
}

/**
 * Deletes multiple items by key in separate transactions.
 * @param {string} storeName
 * @param {Array} keys
 */
export async function deleteItemsSequential(storeName, keys) {
    if (!keys || keys.length === 0) return;
    for (const key of keys) {
        await deleteItem(storeName, key);
    }
}
