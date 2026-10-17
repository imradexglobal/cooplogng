import { showToast } from '../../services/toastService.js'
import {
  getDb,
  collection,
  query,
  where,
  getDocs,
  doc,
  getDoc,
  updateDoc,
  deleteDoc,
  setDoc,
  writeBatch,
  serverTimestamp
} from '../../firebase.js'
import { hardDeleteDoc } from '../../services/sqlite/mutationEngine.js'
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url'

const FORCE_STRING_COLS = new Set([
  'id', 'cooperative_id', 'member_id', 'enterprise_id', 'user_id',
  'remittance_id', 'loan_id', 'admin_fee_id', 'reconciliation_summary_id',
  'mobile', 'nok_mobile', 'account_number', 'registration_no',
  'special_id', 'swift_code', 'password_hash', 'firebase_uid',
  'device_id', 'ip_address'
])

let _uploadSqlJsReady = null
async function getUploadSqlJs() {
  if (!_uploadSqlJsReady) {
    _uploadSqlJsReady = import('sql.js').then(({ default: initSqlJs }) =>
      initSqlJs({ locateFile: () => sqlWasmUrl })
    )
  }
  return _uploadSqlJsReady
}

function sqlRowsToObjects(execResult) {
  if (!execResult || execResult.length === 0 || !execResult[0].values.length) return []
  const colNames = execResult[0].columns
  return execResult[0].values.map(vals => {
    const row = {}
    colNames.forEach((col, i) => {
      let val = vals[i]
      if (typeof val === 'string' && !FORCE_STRING_COLS.has(col)) {
        try { val = JSON.parse(val) } catch (e) { /* keep raw string */ }
      }
      row[col] = val
    })
    return row
  })
}

function readSqlTable(sqlDb, table) {
  try {
    return sqlRowsToObjects(sqlDb.exec(`SELECT * FROM "${table}"`))
  } catch (e) {
    console.warn(`[FirestoreUpload] Skipping table "${table}":`, e?.message || e)
    return []
  }
}
const FIRESTORE_COLLECTIONS = [
  { id: 'cooperatives', label: 'Cooperative', icon: '🏢', useDocId: true },
  { id: 'members', label: 'Members', icon: '👤' },
  { id: 'users', label: 'Users', icon: '👥' },
  { id: 'remittance', label: 'Remittance', icon: '💰' },
  { id: 'enterprise', label: 'Enterprise Accounts', icon: '📊' },
  { id: 'bank', label: 'Banks', icon: '🏦' },
  { id: 'notifications', label: 'Notifications', icon: '🔔' },
  { id: 'feedback', label: 'Feedback', icon: '💬' },
  { id: 'transaction_types', label: 'Transaction Types', icon: '📝' },
  { id: 'bank_reconciliation_summary', label: 'Bank Reconciliation', icon: '📋' },
  { id: 'membership_request', label: 'Membership Requests', icon: '🤝' }
]

export function renderFirestoreManagementSection(area) {
  area.innerHTML = `
    <h3>Firestore Management</h3>
    <p class="section-desc">Select a cooperative and manage its cloud Firestore data. Choose between soft delete (marks records as deleted) or hard delete (removes documents permanently).</p>

    <div style="display: flex; flex-direction: column; gap: 1.5rem;">
      <div class="card" style="padding: 1.5rem; border: 1px solid var(--border-light); border-radius: var(--radius-md); background: var(--bg-card);">
        <h4 style="margin-top: 0; color: var(--text-primary);">1. Select Cooperative</h4>
        <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem;">Choose the cooperative whose Firestore data you want to manage.</p>
        <div style="display: flex; gap: 0.75rem; align-items: flex-end; flex-wrap: wrap;">
          <div class="field" style="flex: 1; min-width: 250px;">
            <span>Cooperative</span>
            <select id="fs-coop-select" style="width: 100%;">
              <option value="">-- Select Cooperative --</option>
            </select>
          </div>
          <button id="fs-load-btn" class="primary-button" style="padding: 0.6rem 1.25rem; font-size: 0.85rem; white-space: nowrap;">
            Load Data
          </button>
        </div>
        <div id="fs-coop-info" style="margin-top: 1rem; font-size: 0.85rem;"></div>
      </div>

      <div class="card" id="fs-upload-card" style="padding: 1.5rem; border: 1px solid var(--border-light); border-radius: var(--radius-md); background: var(--bg-card); display: none;">
        <h4 style="margin-top: 0; color: var(--text-primary);">2. Upload DB to Firestore</h4>
        <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem;">Pick a <code>.db</code> backup file and push all its rows to Firestore for the selected cooperative. Child records (details, loans, guarantors, payment advises) are embedded in their parent documents — never pushed as their own collections. Uses the app's normal Firebase session, so rate-limit retries apply automatically. Local data is untouched.</p>
        <div style="display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem;">
          <button id="fs-upload-pick-btn" class="secondary-button" style="padding: 0.6rem 1.25rem; font-size: 0.85rem; border: 1px solid var(--border-medium); background: transparent; color: var(--text-primary);">
            Choose .db File
          </button>
          <span id="fs-upload-filename" style="font-size: 0.85rem; color: var(--text-muted);">No file selected</span>
        </div>
        <input type="file" id="fs-upload-input" accept=".db,.sqlite" style="display: none;">
        <p style="font-size: 0.85rem; color: var(--text-muted); margin: 0 0 0.5rem 0;">Choose which collections to upload (child records embed automatically into their parents).</p>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.5rem; margin-bottom: 1rem;">
          <label style="display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem; border: 1px solid var(--border-light); border-radius: var(--radius-md); cursor: pointer; font-size: 0.85rem; background: var(--bg-secondary);">
            <input type="checkbox" id="fs-upload-select-all" checked style="width: 16px; height: 16px; accent-color: var(--accent-primary); cursor: pointer;">
            <strong>Select All</strong>
          </label>
          ${FIRESTORE_COLLECTIONS.map(col => `
            <label class="fs-upload-collection-checkbox" style="display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem; border: 1px solid var(--accent-primary); border-radius: var(--radius-md); cursor: pointer; font-size: 0.85rem; background: var(--accent-soft); transition: all 0.2s;">
              <input type="checkbox" name="fs-upload-collection" value="${col.id}" checked style="width: 16px; height: 16px; accent-color: var(--accent-primary); cursor: pointer;">
              <span>${col.icon} ${col.label}</span>
            </label>
          `).join('')}
        </div>
        <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
          <button id="fs-upload-btn" class="primary-button" style="padding: 0.75rem 1.5rem; font-size: 0.9rem;" disabled>
            ⬆️ Upload to Firestore
          </button>
        </div>

        <div id="fs-upload-result" style="margin-top: 1rem; font-size: 0.85rem;"></div>
        <div id="fs-upload-progress" style="margin-top: 1rem; display: none;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
            <span id="fs-upload-progress-text" style="font-size: 0.85rem; color: var(--text-muted);">Processing...</span>
            <span id="fs-upload-progress-pct" style="font-size: 0.85rem; font-weight: 600; color: var(--accent-primary);">0%</span>
          </div>
          <div style="height: 6px; background: var(--bg-secondary); border-radius: 3px; overflow: hidden;">
            <div id="fs-upload-progress-bar" style="width: 0%; height: 100%; background: var(--accent-primary); border-radius: 3px; transition: width 0.3s;"></div>
          </div>
        </div>
      </div>

      <div class="card" id="fs-collections-card" style="padding: 1.5rem; border: 1px solid var(--border-light); border-radius: var(--radius-md); background: var(--bg-card); display: none;">
        <h4 style="margin-top: 0; color: var(--text-primary);">3. Select Collections</h4>
        <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem;">Choose which collections to delete data from.</p>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.5rem; margin-bottom: 1.5rem;">
          <label style="display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem; border: 1px solid var(--border-light); border-radius: var(--radius-md); cursor: pointer; font-size: 0.85rem; background: var(--bg-secondary);">
            <input type="checkbox" id="fs-select-all" style="width: 16px; height: 16px; accent-color: var(--accent-primary); cursor: pointer;">
            <strong>Select All</strong>
          </label>
          ${FIRESTORE_COLLECTIONS.map(col => `
            <label class="fs-collection-checkbox" style="display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem; border: 1px solid var(--border-light); border-radius: var(--radius-md); cursor: pointer; font-size: 0.85rem; background: var(--bg-secondary); transition: all 0.2s;">
              <input type="checkbox" name="fs-collection" value="${col.id}" style="width: 16px; height: 16px; accent-color: var(--accent-primary); cursor: pointer;">
              <span>${col.icon} ${col.label}</span>
            </label>
          `).join('')}
        </div>

        <h4 style="margin-top: 0; color: var(--text-primary);">4. Delete Type</h4>
        <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem;">Choose how to delete the data.</p>
        <div style="display: flex; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap;">
          <label style="display: flex; align-items: flex-start; gap: 0.75rem; padding: 1rem; border: 2px solid var(--border-light); border-radius: var(--radius-md); cursor: pointer; flex: 1; min-width: 200px; transition: all 0.2s;" class="fs-delete-type-option">
            <input type="radio" name="fs-delete-type" value="soft" checked style="width: 18px; height: 18px; accent-color: var(--accent-primary); margin-top: 0.15rem; cursor: pointer;">
            <div>
              <div style="font-weight: 700; color: var(--text-primary); margin-bottom: 0.25rem;">🔄 Soft Delete</div>
              <div style="font-size: 0.8rem; color: var(--text-muted); line-height: 1.4;">Marks records as deleted. Data is preserved and can be restored. Records will be hidden from normal views.</div>
            </div>
          </label>
          <label style="display: flex; align-items: flex-start; gap: 0.75rem; padding: 1rem; border: 2px solid var(--border-light); border-radius: var(--radius-md); cursor: pointer; flex: 1; min-width: 200px; transition: all 0.2s;" class="fs-delete-type-option">
            <input type="radio" name="fs-delete-type" value="hard" style="width: 18px; height: 18px; accent-color: var(--danger, #e53e3e); margin-top: 0.15rem; cursor: pointer;">
            <div>
              <div style="font-weight: 700; color: var(--text-primary); margin-bottom: 0.25rem;">⚠️ Hard Delete</div>
              <div style="font-size: 0.8rem; color: var(--text-muted); line-height: 1.4;">Permanently removes documents from Firestore. This action cannot be undone. Requires Firestore rules to allow deletes.</div>
            </div>
          </label>
        </div>

        <div style="padding: 0.75rem 1rem; background: var(--warning-bg, #fef3c7); border: 1px solid var(--warning, #d97706); border-radius: var(--radius-md); margin-bottom: 1.5rem;">
          <div style="font-size: 0.85rem; color: var(--warning, #d97706); font-weight: 600; margin-bottom: 0.25rem;">⚠️ Warning</div>
          <div style="font-size: 0.8rem; color: var(--warning, #d97706); opacity: 0.8;">This action affects cloud Firestore data. All changes will be reflected across all devices. Make sure you have selected the correct cooperative and collections.</div>
        </div>

        <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
          <button id="fs-execute-btn" class="primary-button" style="padding: 0.75rem 1.5rem; font-size: 0.9rem; background: var(--danger, #e53e3e);" disabled>
            Execute Delete
          </button>
        </div>

        <div id="fs-result" style="margin-top: 1.5rem; font-size: 0.85rem;"></div>
        <div id="fs-progress" style="margin-top: 1rem; display: none;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
            <span id="fs-progress-text" style="font-size: 0.85rem; color: var(--text-muted);">Processing...</span>
            <span id="fs-progress-pct" style="font-size: 0.85rem; font-weight: 600; color: var(--accent-primary);">0%</span>
          </div>
          <div style="height: 6px; background: var(--bg-secondary); border-radius: 3px; overflow: hidden;">
            <div id="fs-progress-bar" style="width: 0%; height: 100%; background: var(--accent-primary); border-radius: 3px; transition: width 0.3s;"></div>
          </div>
        </div>
      </div>
    </div>
  `

  // Style the delete type options highlight
  const styleRadioOptions = () => {
    area.querySelectorAll('.fs-delete-type-option').forEach(opt => {
      const radio = opt.querySelector('input[type="radio"]')
      if (radio?.checked) {
        opt.style.borderColor = 'var(--accent-primary)'
        opt.style.background = 'var(--accent-soft)'
      } else {
        opt.style.borderColor = 'var(--border-light)'
        opt.style.background = 'var(--bg-secondary)'
      }
    })
  }
  styleRadioOptions()
  area.addEventListener('change', (e) => {
    if (e.target.name === 'fs-delete-type') styleRadioOptions()
  })

  // Highlight selected collection checkboxes
  area.addEventListener('change', (e) => {
    if (e.target.name === 'fs-collection' || e.target.id === 'fs-select-all') {
      area.querySelectorAll('.fs-collection-checkbox').forEach(label => {
        const cb = label.querySelector('input[type="checkbox"]')
        if (cb?.checked) {
          label.style.borderColor = 'var(--accent-primary)'
          label.style.background = 'var(--accent-soft)'
        } else {
          label.style.borderColor = 'var(--border-light)'
          label.style.background = 'var(--bg-secondary)'
        }
      })
      updateExecuteButton()
    }
  })

  // Highlight selected upload-collection checkboxes + select-all
  area.addEventListener('change', (e) => {
    if (e.target.id === 'fs-upload-select-all') {
      const checked = e.target.checked
      area.querySelectorAll('input[name="fs-upload-collection"]').forEach(cb => { cb.checked = checked })
    }
    if (e.target.name === 'fs-upload-collection' || e.target.id === 'fs-upload-select-all') {
      area.querySelectorAll('.fs-upload-collection-checkbox').forEach(label => {
        const cb = label.querySelector('input[type="checkbox"]')
        if (cb?.checked) {
          label.style.borderColor = 'var(--accent-primary)'
          label.style.background = 'var(--accent-soft)'
        } else {
          label.style.borderColor = 'var(--border-light)'
          label.style.background = 'var(--bg-secondary)'
        }
      })
      // Keep upload button gated on ≥1 collection + file + coop
      const upBtn = document.getElementById('fs-upload-btn')
      const filePicked = document.getElementById('fs-upload-filename')?.textContent !== 'No file selected'
      const anyCol = area.querySelectorAll('input[name="fs-upload-collection"]:checked').length > 0
      const coop = document.getElementById('fs-coop-select')?.value
      if (upBtn) upBtn.disabled = !(filePicked && anyCol && coop)
    }
  })
  function updateExecuteButton() {
    const selected = area.querySelectorAll('input[name="fs-collection"]:checked')
    const coop = document.getElementById('fs-coop-select')?.value
    const btn = document.getElementById('fs-execute-btn')
    if (btn) btn.disabled = selected.length === 0 || !coop
  }
}

export function setupFirestoreManagementListeners(user) {
  const db = getDb()
  const loadBtn = document.getElementById('fs-load-btn')
  const coopSelect = document.getElementById('fs-coop-select')
  const coopInfo = document.getElementById('fs-coop-info')
  const collectionsCard = document.getElementById('fs-collections-card')
  const selectAllCb = document.getElementById('fs-select-all')
  const executeBtn = document.getElementById('fs-execute-btn')
  const resultDiv = document.getElementById('fs-result')
  const progressDiv = document.getElementById('fs-progress')
  const progressBar = document.getElementById('fs-progress-bar')
  const progressText = document.getElementById('fs-progress-text')
  const progressPct = document.getElementById('fs-progress-pct')

  // Upload-to-Firestore controls
  const uploadCard = document.getElementById('fs-upload-card')
  const uploadPickBtn = document.getElementById('fs-upload-pick-btn')
  const uploadInput = document.getElementById('fs-upload-input')
  const uploadFilename = document.getElementById('fs-upload-filename')
  const uploadBtn = document.getElementById('fs-upload-btn')
  const uploadResult = document.getElementById('fs-upload-result')
  const uploadProgress = document.getElementById('fs-upload-progress')
  const uploadBar = document.getElementById('fs-upload-progress-bar')
  const uploadText = document.getElementById('fs-upload-progress-text')
  const uploadPct = document.getElementById('fs-upload-progress-pct')
  let uploadFile = null

  let loadedCoops = []

  // Load cooperatives list — never leave the dropdown empty if we know
  // the current user's coop (e.g. its cloud doc was hard-deleted).
  async function loadCooperatives() {
    if (!coopSelect) return
    const fallbackId = user?.cooperativeId || user?.cooperative_id || null
    try {
      const coopsRef = collection(db, 'cooperatives')
      const snapshot = await getDocs(coopsRef)
      loadedCoops = []
      coopSelect.innerHTML = '<option value="">-- Select Cooperative --</option>'
      snapshot.forEach(docSnap => {
        const data = docSnap.data()
        const coop = { id: docSnap.id, name: data.full_name || data.name || docSnap.id }
        loadedCoops.push(coop)
        const opt = document.createElement('option')
        opt.value = coop.id
        opt.textContent = `${coop.name} (${coop.id})`
        coopSelect.appendChild(opt)
      })
      if (loadedCoops.length === 0 && fallbackId) {
        loadedCoops.push({ id: fallbackId, name: `${fallbackId} (current)` })
        const opt = document.createElement('option')
        opt.value = fallbackId
        opt.textContent = `${fallbackId} (current)`
        coopSelect.appendChild(opt)
        if (coopInfo) {
          coopInfo.innerHTML = `<div style="padding: 0.75rem 1rem; background: var(--warning-bg, #fef3c7); border-radius: var(--radius-md); border: 1px solid var(--warning, #d97706); font-size: 0.85rem;">No cooperatives found in cloud Firestore. Showing your current cooperative as fallback — you can still select it to upload/restore data.</div>`
        }
      }
    } catch (err) {
      console.error('[FirestoreMgmt] loadCooperatives failed:', err)
      showToast('Failed to load cooperatives: ' + err.message, 'error')
      if (fallbackId && coopSelect.options.length <= 1) {
        loadedCoops = [{ id: fallbackId, name: `${fallbackId} (current)` }]
        coopSelect.innerHTML = '<option value="">-- Select Cooperative --</option>'
        const opt = document.createElement('option')
        opt.value = fallbackId
        opt.textContent = `${fallbackId} (current)`
        coopSelect.appendChild(opt)
      }
    }
  }

  // Load button handler — no count queries here (reads cost money).
  // Just reveals the cards; per-collection counts come free from the
  // delete loop itself and are shown in the result panel at the end.
  loadBtn?.addEventListener('click', async () => {
    const coopId = coopSelect.value
    if (!coopId) {
      showToast('Please select a cooperative first.', 'warning')
      return
    }
    loadBtn.disabled = true
    loadBtn.innerText = 'Loading...'
    try {
      const coop = loadedCoops.find(c => c.id === coopId)
      coopInfo.innerHTML = `
        <div style="padding: 0.75rem 1rem; background: var(--bg-secondary); border-radius: var(--radius-md); border: 1px solid var(--border-light);">
          <div style="font-weight: 700; color: var(--text-primary);">${coop?.name || coopId}</div>
          <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">ID: ${coopId}</div>
        </div>
      `
      collectionsCard.style.display = ''
      if (uploadCard) uploadCard.style.display = ''
      resultDiv.innerHTML = ''
      progressDiv.style.display = 'none'

      // No extra reads — enable buttons based on current checkbox state only.
      // Enable execute button if collections are selected
      const selected = document.querySelectorAll('input[name="fs-collection"]:checked')
      executeBtn.disabled = selected.length === 0
      // Enable upload button if a file was already picked and ≥1 collection selected
      if (uploadBtn) {
        const anyCol = document.querySelectorAll('input[name="fs-upload-collection"]:checked').length > 0
        uploadBtn.disabled = !uploadFile || !anyCol
      }
    } catch (err) {
      showToast('Failed to load data: ' + err.message, 'error')
    } finally {
      loadBtn.disabled = false
      loadBtn.innerText = 'Load Data'
    }
  })

  // Select All checkbox + individual collection checkboxes gate the Execute button.
  // (Kept here in setup — not only in render — so it works regardless of how
  // the section DOM is mounted.)
  const updateExecuteBtnState = () => {
    if (!executeBtn) return
    const selected = document.querySelectorAll('input[name="fs-collection"]:checked').length
    executeBtn.disabled = selected === 0 || !coopSelect?.value
  }
  const styleDeleteCheckboxes = () => {
    document.querySelectorAll('.fs-collection-checkbox').forEach(label => {
      const cb = label.querySelector('input[type="checkbox"]')
      if (cb?.checked) {
        label.style.borderColor = 'var(--accent-primary)'
        label.style.background = 'var(--accent-soft)'
      } else {
        label.style.borderColor = 'var(--border-light)'
        label.style.background = 'var(--bg-secondary)'
      }
    })
  }
  const updateUploadBtnState = () => {
    if (!uploadBtn) return
    const anyCol = document.querySelectorAll('input[name="fs-upload-collection"]:checked').length > 0
    uploadBtn.disabled = !uploadFile || !coopSelect?.value || !anyCol
  }
  const styleUploadCheckboxes = () => {
    document.querySelectorAll('.fs-upload-collection-checkbox').forEach(label => {
      const cb = label.querySelector('input[type="checkbox"]')
      if (cb?.checked) {
        label.style.borderColor = 'var(--accent-primary)'
        label.style.background = 'var(--accent-soft)'
      } else {
        label.style.borderColor = 'var(--border-light)'
        label.style.background = 'var(--bg-secondary)'
      }
    })
  }

  selectAllCb?.addEventListener('change', () => {
    const checked = selectAllCb.checked
    document.querySelectorAll('input[name="fs-collection"]').forEach(cb => {
      cb.checked = checked
    })
    styleDeleteCheckboxes()
    updateExecuteBtnState()
  })

  // Individual checkboxes (scoped to cards — no global listener leak on re-mount)
  collectionsCard?.addEventListener('change', (e) => {
    if (e.target?.name === 'fs-collection') {
      const all = Array.from(collectionsCard.querySelectorAll('input[name="fs-collection"]'))
      if (selectAllCb && all.length > 0) {
        selectAllCb.checked = all.every(cb => cb.checked)
      }
      styleDeleteCheckboxes()
      updateExecuteBtnState()
    }
  })
  uploadCard?.addEventListener('change', (e) => {
    if (e.target?.name === 'fs-upload-collection' || e.target?.id === 'fs-upload-select-all') {
      if (e.target?.id === 'fs-upload-select-all') {
        const checked = e.target.checked
        uploadCard.querySelectorAll('input[name="fs-upload-collection"]').forEach(cb => { cb.checked = checked })
      } else {
        const allUp = Array.from(uploadCard.querySelectorAll('input[name="fs-upload-collection"]'))
        const upSelectAll = document.getElementById('fs-upload-select-all')
        if (upSelectAll && allUp.length > 0) upSelectAll.checked = allUp.every(cb => cb.checked)
      }
      styleUploadCheckboxes()
      updateUploadBtnState()
    }
  })

  // Re-evaluate buttons when cooperative changes (file may already be picked)
  coopSelect?.addEventListener('change', () => {
    updateExecuteBtnState()
    updateUploadBtnState()
  })

  // Execute delete button — the ONLY reads here are the ones needed to find
  // docs to delete (1 read per doc deleted). Counts are tallied from that
  // same loop and shown at the end, with zero extra count queries.
  executeBtn?.addEventListener('click', async () => {
    const coopId = coopSelect.value
    if (!coopId) return

    const selectedCols = Array.from(document.querySelectorAll('input[name="fs-collection"]:checked')).map(cb => cb.value)
    if (selectedCols.length === 0) return

    const deleteType = document.querySelector('input[name="fs-delete-type"]:checked')?.value || 'soft'
    const typeLabel = deleteType === 'soft' ? 'Soft Delete' : 'Hard Delete'

    if (!confirm(`Are you sure you want to ${typeLabel} data for cooperative "${coopId}"?\n\nCollections: ${selectedCols.join(', ')}\n\nThis action affects cloud Firestore data.`)) {
      return
    }

    if (deleteType === 'hard') {
      if (!confirm('⚠️ HARD DELETE WARNING: This will permanently remove documents from Firestore. This action CANNOT be undone. Continue?')) {
        return
      }
    }

    executeBtn.disabled = true
    executeBtn.innerText = 'Processing...'
    progressDiv.style.display = ''
    resultDiv.innerHTML = ''
    progressBar.style.width = '0%'
    progressText.innerText = 'Starting...'
    progressPct.innerText = '0%'

    try {
      let totalProcessed = 0
      let totalErrors = 0
      const results = {}

      for (let i = 0; i < selectedCols.length; i++) {
        const colId = selectedCols[i]
        const col = FIRESTORE_COLLECTIONS.find(c => c.id === colId)
        const pct = Math.round(((i) / selectedCols.length) * 100)
        progressBar.style.width = pct + '%'
        progressPct.innerText = pct + '%'
        progressText.innerText = `Processing ${col?.label || colId}...`

        try {
          let docs = []

          if (col?.useDocId) {
            const docSnap = await getDoc(doc(db, colId, coopId))
            if (docSnap.exists()) docs = [docSnap]
          } else {
            const q = query(collection(db, colId), where('cooperative_id', '==', coopId))
            const snap = await getDocs(q)
            snap.forEach(docSnap => docs.push(docSnap))
          }

          if (docs.length === 0) {
            results[colId] = { processed: 0, errors: 0 }
            continue
          }

          // Process in batches of 500 (Firestore batch limit)
          let batchProcessed = 0
          let batchErrors = 0

          for (let j = 0; j < docs.length; j += 500) {
            const batchDocs = docs.slice(j, j + 500)

            if (deleteType === 'soft') {
              // Soft delete: mark as deleted
              const batch = writeBatch(db)
              for (const docSnap of batchDocs) {
                const data = docSnap.data()
                batch.update(docSnap.ref, {
                  is_deleted: true,
                  deleted_at: serverTimestamp(),
                  deleted_by: user.username || 'admin',
                  ...(data.cooperative_id ? { cooperative_id: data.cooperative_id } : {})
                })
              }
              await batch.commit()
              // Also hard-delete locally from IndexedDB
              for (const docSnap of batchDocs) {
                hardDeleteDoc(col.id, docSnap.id)
              }
              batchProcessed += batchDocs.length
            } else {
              // Hard delete: remove documents
              const batch = writeBatch(db)
              for (const docSnap of batchDocs) {
                batch.delete(docSnap.ref)
              }
              await batch.commit()
              // Also hard-delete locally from IndexedDB (permanent)
              for (const docSnap of batchDocs) {
                hardDeleteDoc(col.id, docSnap.id)
              }
              batchProcessed += batchDocs.length
            }

            // Update progress within collection
            const innerPct = Math.round(((i + (j + batchDocs.length) / docs.length) / selectedCols.length) * 100)
            progressBar.style.width = innerPct + '%'
            progressPct.innerText = innerPct + '%'
          }

          results[colId] = { processed: batchProcessed, errors: batchErrors }
          totalProcessed += batchProcessed
          totalErrors += batchErrors
        } catch (err) {
          console.error(`[FirestoreMgmt] Error processing ${colId}:`, err)
          results[colId] = { processed: 0, errors: 1, error: err.message }
          totalErrors++
        }
      }

      progressBar.style.width = '100%'
      progressPct.innerText = '100%'
      progressText.innerText = 'Complete!'

      const typeIcon = deleteType === 'soft' ? '🔄' : '⚠️'
      resultDiv.innerHTML = `
        <div style="padding: 1rem; background: ${totalErrors > 0 ? 'var(--warning-bg)' : 'var(--success-bg)'}; border-radius: var(--radius-md); border: 1px solid ${totalErrors > 0 ? 'var(--warning)' : 'var(--success)'};">
          <div style="font-weight: 700; color: ${totalErrors > 0 ? 'var(--warning)' : 'var(--success)'}; margin-bottom: 0.5rem;">
            ${typeIcon} ${typeLabel} Complete
          </div>
          <div style="font-size: 0.85rem; color: var(--text-muted);">
            Total processed: <strong>${totalProcessed}</strong> documents
            ${totalErrors > 0 ? `<br>Total errors: <strong style="color: var(--danger);">${totalErrors}</strong>` : ''}
          </div>
          <div style="margin-top: 0.75rem; font-size: 0.8rem;">
            ${Object.entries(results).map(([colId, r]) => {
              const col = FIRESTORE_COLLECTIONS.find(c => c.id === colId)
              return `<div style="color: var(--text-muted);">${col?.icon || ''} ${col?.label || colId}: ${r.processed} processed${r.error ? ` (Error: ${r.error})` : ''}</div>`
            }).join('')}
          </div>
        </div>
      `

      showToast(`${typeLabel} complete: ${totalProcessed} documents processed.`, totalErrors > 0 ? 'warning' : 'success')
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error')
      resultDiv.innerHTML = `<span style="color: var(--danger);">Delete failed: ${err.message}</span>`
    } finally {
      executeBtn.disabled = false
      executeBtn.innerText = 'Execute Delete'
      setTimeout(() => {
        progressDiv.style.display = 'none'
      }, 2000)
    }
  })

  // ── Upload .db to Firestore ──────────────────────────────────────────
  // Reads a SQLite backup in-browser (sql.js) and pushes every row to
  // Firestore with the client SDK (automatic 429 retry). Child records
  // are embedded in their parents — never pushed as own collections.
  // Local IndexedDB, sync_queue and background sync are untouched.
  uploadPickBtn?.addEventListener('click', () => uploadInput?.click())

  uploadInput?.addEventListener('change', (e) => {
    uploadFile = e.target.files?.[0] || null
    if (uploadFilename) {
      uploadFilename.textContent = uploadFile
        ? `${uploadFile.name} (${(uploadFile.size / 1048576).toFixed(1)} MB)`
        : 'No file selected'
    }
    if (uploadBtn) {
      const anyCol = document.querySelectorAll('input[name="fs-upload-collection"]:checked').length > 0
      uploadBtn.disabled = !uploadFile || !coopSelect?.value || !anyCol
    }
    if (uploadResult) uploadResult.innerHTML = ''
  })

  const setUploadProgress = (done, total, label) => {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0
    if (uploadBar) uploadBar.style.width = pct + '%'
    if (uploadPct) uploadPct.innerText = pct + '%'
    if (uploadText) uploadText.innerText = label || `Processing... (${done}/${total})`
  }
  const yieldToUI = () => new Promise(r => setTimeout(r, 0))

  uploadBtn?.addEventListener('click', async () => {
    const coopId = coopSelect?.value
    if (!coopId) {
      showToast('Please select a cooperative first.', 'warning')
      return
    }
    if (!uploadFile) {
      showToast('Please choose a .db file first.', 'warning')
      return
    }
    const selectedTables = Array.from(document.querySelectorAll('input[name="fs-upload-collection"]:checked')).map(cb => cb.value)
    if (selectedTables.length === 0) {
      showToast('Please select at least one collection to upload.', 'warning')
      return
    }
    if (!confirm(`Push ${selectedTables.join(', ')} from "${uploadFile.name}" to Firestore for cooperative "${coopId}"?\n\nExisting cloud documents will be merged (not overwritten). This may take several minutes for large files. Continue?`)) {
      return
    }

    uploadBtn.disabled = true
    uploadBtn.innerText = 'Uploading...'
    if (uploadProgress) uploadProgress.style.display = ''
    if (uploadResult) uploadResult.innerHTML = ''

    try {
      const { prepareForFirestore } = await import('../../services/syncService.js')

      setUploadProgress(0, 1, 'Reading .db file...')
      const SQL = await getUploadSqlJs()
      const buffer = await uploadFile.arrayBuffer()
      const sqlDb = new SQL.Database(new Uint8Array(buffer))

      // Read selected tables (+ child tables only when their parent is selected)
      setUploadProgress(0, 1, 'Parsing tables...')
      const needRemitChildren = selectedTables.includes('remittance')
      const needMemberChildren = selectedTables.includes('members')
      const tablesToRead = [
        ...selectedTables,
        ...(needRemitChildren ? ['remittance_detail', 'loans', 'loan_guarantors'] : []),
        ...(needMemberChildren ? ['payment_advise'] : [])
      ]
      const tables = {}
      for (let idx = 0; idx < tablesToRead.length; idx++) {
        const t = tablesToRead[idx]
        setUploadProgress(idx, tablesToRead.length, `Parsing table ${idx + 1}/${tablesToRead.length}: ${t}...`)
        tables[t] = readSqlTable(sqlDb, t)
        await yieldToUI()
      }
      // cooperatives table: only the selected coop's row
      if (tables.cooperatives) {
        tables.cooperatives = tables.cooperatives.filter(r => String(r.id) === String(coopId))
      }
      sqlDb.close()

      // Build child maps keyed by parent FK (empty when parent not selected)
      const detailsByRemit = new Map()
      for (const d of tables.remittance_detail || []) {
        const k = String(d.remittance_id ?? '')
        if (!k) continue
        if (!detailsByRemit.has(k)) detailsByRemit.set(k, [])
        detailsByRemit.get(k).push(d)
      }
      const loansByRemit = new Map()
      for (const l of tables.loans || []) {
        const k = String(l.remittance_id ?? '')
        if (!k) continue
        if (!loansByRemit.has(k)) loansByRemit.set(k, [])
        loansByRemit.get(k).push(l)
      }
      const guarantorsByLoan = new Map()
      for (const g of tables.loan_guarantors || []) {
        const k = String(g.loan_id ?? '')
        if (!k) continue
        if (!guarantorsByLoan.has(k)) guarantorsByLoan.set(k, [])
        guarantorsByLoan.get(k).push(g)
      }
      const advisesByMember = new Map()
      for (const a of tables.payment_advise || []) {
        const k = String(a.member_id ?? '')
        if (!k) continue
        if (!advisesByMember.has(k)) advisesByMember.set(k, [])
        advisesByMember.get(k).push(a)
      }
      setUploadProgress(tablesToRead.length, tablesToRead.length, 'Building document maps...')
      await yieldToUI()

      const notDeleted = (r) => !r.is_deleted && r.is_deleted !== 1 && r.is_deleted !== '1' && r.is_deleted !== true

      // Assemble per-collection doc lists with embedded children
      const docsByTable = {}
      let grandTotal = 0
      for (const t of selectedTables) {
        setUploadProgress(grandTotal, grandTotal + 1, `Assembling ${t} documents...`)
        let docs = (tables[t] || []).filter(r => r.id !== undefined && r.id !== null && String(r.id) !== '')
        // Stamp the selected coop onto every row that carries the field
        for (const r of docs) {
          if ('cooperative_id' in r) r.cooperative_id = String(coopId)
          delete r.is_synced
          delete r.sync_at
        }
        if (t === 'remittance') {
          for (const r of docs) {
            const rid = String(r.id)
            r.details = (detailsByRemit.get(rid) || []).filter(notDeleted)
            const loans = (loansByRemit.get(rid) || []).filter(notDeleted)
            for (const loan of loans) {
              loan.guarantors = (guarantorsByLoan.get(String(loan.id)) || []).filter(notDeleted)
            }
            r.loans = loans
          }
        } else if (t === 'members') {
          for (const r of docs) {
            r.payment_advise = (advisesByMember.get(String(r.id)) || []).filter(notDeleted)
          }
        }
        docsByTable[t] = docs
        grandTotal += docs.length
        await yieldToUI()
      }

      if (grandTotal === 0) {
        if (uploadResult) uploadResult.innerHTML = '<span style="color: var(--warning);">No rows found in the selected file.</span>'
        return
      }

      // Push in 400-doc batches with per-batch fallback to single writes
      let pushed = 0
      let failed = 0
      const perTable = {}
      for (const t of selectedTables) {
        const docs = docsByTable[t] || []
        perTable[t] = { pushed: 0, failed: 0 }
        for (let i = 0; i < docs.length; i += 400) {
          const chunk = docs.slice(i, i + 400)
          // Skip rows that produce an empty Firestore payload
          const staged = []
          for (const raw of chunk) {
            try {
              const payload = { ...prepareForFirestore(raw), sync_at: serverTimestamp() }
              if (!payload || Object.keys(payload).length === 0) continue
              staged.push({ id: String(raw.id), payload })
            } catch (e) {
              console.warn(`[FirestoreUpload] Prep failed for ${t}/${raw.id}:`, e?.message || e)
            }
          }
          if (staged.length === 0) {
            pushed += 0
            setUploadProgress(pushed + failed, grandTotal, `${t}: ${i + chunk.length}/${docs.length}`)
            continue
          }
          try {
            const batch = writeBatch(db)
            for (const { id, payload } of staged) {
              batch.set(doc(db, t, id), payload, { merge: true })
            }
            await batch.commit()
            perTable[t].pushed += staged.length
            pushed += staged.length
          } catch (batchErr) {
            console.warn(`[FirestoreUpload] Batch failed for ${t} (${staged.length} docs), falling back to single writes:`, batchErr?.message || batchErr)
            for (const { id, payload } of staged) {
              try {
                await setDoc(doc(db, t, id), payload, { merge: true })
                perTable[t].pushed++
                pushed++
              } catch (indErr) {
                console.warn(`[FirestoreUpload] Write failed for ${t}/${id}:`, indErr?.message || indErr)
                perTable[t].failed++
                failed++
              }
              if ((perTable[t].pushed + perTable[t].failed) % 25 === 0) {
                setUploadProgress(pushed + failed, grandTotal, `${t}: ${i + perTable[t].pushed + perTable[t].failed}/${docs.length} (retrying singles...)`)
              }
            }
          }
          setUploadProgress(pushed + failed, grandTotal, `${t}: ${Math.min(i + 400, docs.length)}/${docs.length}`)
        }
      }

      setUploadProgress(grandTotal, grandTotal, 'Complete!')
      const ok = failed === 0
      if (uploadResult) {
        uploadResult.innerHTML = `
          <div style="padding: 1rem; background: ${ok ? 'var(--success-bg)' : 'var(--warning-bg)'}; border-radius: var(--radius-md); border: 1px solid ${ok ? 'var(--success)' : 'var(--warning)'};">
            <div style="font-weight: 700; color: ${ok ? 'var(--success)' : 'var(--warning)'}; margin-bottom: 0.5rem;">
              ⬆️ Upload Complete — ${pushed} pushed${failed > 0 ? `, ${failed} failed` : ''}
            </div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.5rem; font-size: 0.8rem; color: var(--text-muted);">
              ${Object.entries(perTable).filter(([, r]) => (r.pushed + r.failed) > 0).map(([t, r]) =>
                `<div>${t}: <strong style="color: var(--text-primary);">${r.pushed}</strong>${r.failed > 0 ? ` (<span style="color: var(--danger);">${r.failed} failed</span>)` : ''}</div>`
              ).join('')}
            </div>
          </div>
        `
      }
      showToast(`Upload complete: ${pushed} pushed${failed > 0 ? `, ${failed} failed` : ''}.`, ok ? 'success' : 'warning')
    } catch (err) {
      console.error('[FirestoreUpload] Upload failed:', err)
      showToast('Upload failed: ' + (err?.message || err), 'error')
      if (uploadResult) uploadResult.innerHTML = `<span style="color: var(--danger);">Upload failed: ${err?.message || err}</span>`
    } finally {
      uploadBtn.disabled = false
      uploadBtn.innerText = '⬆️ Upload to Firestore'
      setTimeout(() => { if (uploadProgress) uploadProgress.style.display = 'none' }, 3000)
    }
  })

  // Initialize
  loadCooperatives()
}
