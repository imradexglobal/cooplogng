import { getFilteredMembers, getAllMembers, usersList, loadMembersData } from './membersState.js'

// ExcelJS (~900KB) loads lazily on first export/import so dashboard startup stays light.
let _excelJS = null;
async function loadExcelJS() {
    if (!_excelJS) {
        const mod = await import('exceljs');
        _excelJS = mod.default || mod;
    }
    return _excelJS;
}
import { addMember } from '../../services/dataService.js'
import { generateRandom6Digit } from '../../utils/formatters.js'
import { getDb, doc, getDoc } from '../../firebase.js'
import { showToast } from '../../services/toastService.js'

/**
 * EXPORT MODAL & LOGIC
 */
export async function showExportModal(user) {
    const fields = [
        { id: 'registration_no', label: 'Registration No' },
        { id: 'prefix', label: 'Prefix' },
        { id: 'last_name', label: 'Last Name' },
        { id: 'first_name', label: 'First Name' },
        { id: 'middle_name', label: 'Middle Name' },
        { id: 'mobile', label: 'Mobile' },
        { id: 'sex', label: 'Sex' },
        { id: 'status', label: 'Status' },
        { id: 'date_joined', label: 'Date Joined' },
        { id: 'address', label: 'Address' },
        { id: 'account_manager', label: 'Managers' },
        { id: 'nok_name', label: 'NOK Name' },
        { id: 'nok_mobile', label: 'NOK Mobile' },
        { id: 'bank_name', label: 'Bank Name' },
        { id: 'account_number', label: 'Account No' },
        { id: 'account_name', label: 'Account Name' },
        { id: 'created_at', label: 'Created At (Audit)' },
        { id: 'modified_at', label: 'Modified At (Audit)' }
    ]

    const modalHtml = `
      <div id="export-modal" class="modal-overlay open" style="z-index: 1000;">
        <div class="modal-content" style="max-width: 450px; padding: 2rem; border-radius: var(--radius-lg); background: var(--bg-card); border: 1px solid var(--border-light); box-shadow: var(--shadow-xl);">
          <h3 style="margin: 0 0 1rem 0; color: var(--text-primary);">Export Members</h3>
          <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1.5rem;">Select the fields you want to include in the Excel export.</p>
          
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; max-height: 300px; overflow-y: auto; padding: 0.5rem; border: 1px solid var(--border-light); border-radius: var(--radius-md); background: var(--bg-input);">
              ${fields.map(f => `
                  <label style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; cursor: pointer; padding: 0.25rem; color: var(--text-primary);">
                      <input type="checkbox" class="export-field-cb" value="${f.id}" checked style="accent-color: var(--accent-primary);">
                      ${f.label}
                  </label>
              `).join('')}
          </div>

          <div style="margin-top: 2rem; display: flex; justify-content: flex-end; gap: 1rem;">
              <button class="ghost-button" onclick="document.getElementById('export-modal').remove()" style="color: var(--text-muted);">Cancel</button>
              <button class="primary-button" id="confirm-export-btn">Download .xlsx</button>
          </div>
        </div>
      </div>
    `
    document.body.insertAdjacentHTML('beforeend', modalHtml)

    document.getElementById('confirm-export-btn').addEventListener('click', async () => {
        const selectedIds = Array.from(document.querySelectorAll('.export-field-cb:checked')).map(cb => cb.value)
        if (selectedIds.length === 0) return showToast("Select at least one field.", 'warning')

        const btn = document.getElementById('confirm-export-btn')
        btn.disabled = true; btn.innerText = 'Generating...'

        try {
            const ExcelJS = await loadExcelJS();
            const workbook = new ExcelJS.Workbook()
            const worksheet = workbook.addWorksheet('Members')
            
            // Header Row
            const columns = selectedIds.map(id => ({
                header: fields.find(f => f.id === id).label,
                key: id,
                width: 20
            }))
            worksheet.columns = columns

            // Add Data
            getFilteredMembers().forEach(m => {
                worksheet.addRow(m)
            })

            // Styling
            worksheet.getRow(1).font = { bold: true }
            worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }

            const buffer = await workbook.xlsx.writeBuffer()
            const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `Members_Export_${new Date().toISOString().slice(0, 10)}.xlsx`
            a.click()
            document.getElementById('export-modal').remove()
        } catch (err) {
            showToast("Export failed: " + err.message, 'error')
            btn.disabled = false; btn.innerText = 'Download .xlsx'
        }
    })
}

/**
 * IMPORT TEMPLATE LOGIC
 */
export async function downloadTemplate(user) {
    const db = getDb()
    const coopDoc = await getDoc(doc(db, 'cooperatives', user.cooperativeId))
    const coopName = coopDoc.exists() ? (coopDoc.data().full_name || 'Cooperative') : 'Cooperative'
    const coopShortName = coopDoc.exists() ? (coopDoc.data().short_name || '0000000000') : '0000000000'

    const ExcelJS = await loadExcelJS();
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Import Template')

    // Passcode in A1
    worksheet.getCell('A1').value = coopShortName
    worksheet.getRow(1).hidden = true // Hide passcode row

    // Header Title
    worksheet.mergeCells('B2:E2')
    const titleCell = worksheet.getCell('B2')
    titleCell.value = `${coopName.toUpperCase()} - MEMBER IMPORT TEMPLATE`
    titleCell.font = { bold: true, size: 14 }
    titleCell.alignment = { horizontal: 'center' }

    // Column Headers
    const headers = ['Last Name*', 'First Name*', 'Middle Name', 'Mobile*', 'Sex', 'Status', 'Address', 'Date Joined (YYYY-MM-DD)', 'Account Manager', 'NOK Name', 'NOK Mobile']
    const headerRow = worksheet.getRow(4)
    headers.forEach((h, i) => {
        const cell = headerRow.getCell(i + 2)
        cell.value = h
        cell.font = { bold: true }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCBD5E1' } }
        cell.border = { bottom: { style: 'thin' } }
    })

    // Sample Hint Row
    const hintRow = worksheet.getRow(5)
    hintRow.values = [null, 'Doe', 'John', 'Smith', '8012345678', 'Male', 'Active', '123 Main St', '2026-01-01', 'admin', 'Jane Doe', '8087654321']
    hintRow.font = { italic: true, color: { argb: 'FF94A3B8' } }

    // Locking Logic
    await worksheet.protect('0000000000', {
        selectLockedCells: true,
        selectUnlockedCells: true,
        formatCells: false,
        formatColumns: false,
        formatRows: false,
        insertRows: false,
        insertColumns: false,
        insertHyperlinks: false,
        deleteRows: false,
        deleteColumns: false
    })

    // Unlock input area (B5 downwards to K1000)
    for (let r = 5; r <= 1000; r++) {
        for (let c = 2; c <= 12; c++) {
            worksheet.getRow(r).getCell(c).protection = { locked: false }
        }
    }

    const buffer = await workbook.xlsx.writeBuffer()
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `Member_Import_Template.xlsx`
    a.click()
}

/**
 * IMPORT MODAL & PARSING
 */
export async function showImportModal(user) {
    const modalHtml = `
      <div id="import-modal" class="modal-overlay open" style="z-index: 1000;">
        <div class="modal-content" style="max-width: 500px; padding: 2rem; border-radius: var(--radius-lg); background: var(--bg-card); border: 1px solid var(--border-light); box-shadow: var(--shadow-xl);">
          <h3 style="margin: 0 0 0.5rem 0; color: var(--text-primary);">Import Members</h3>
          <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1.5rem;">Upload the completed .xlsx template to bulk add members.</p>
          
          <div id="import-dropzone" style="border: 2px dashed var(--border-medium); border-radius: var(--radius-lg); padding: 3rem; text-align: center; cursor: pointer; transition: border-color 0.2s; background: var(--bg-input);">
              <svg style="color: var(--text-muted); margin-bottom: 1rem;" width="32" height="32" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
              <div style="font-size: 0.9rem; font-weight: 600; color: var(--text-primary);">Click or drag file to upload</div>
              <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">Supports .xlsx only</div>
          </div>
          <input type="file" id="import-file-input" accept=".xlsx" style="display: none;">

          <div style="margin-top: 1.5rem; display: flex; justify-content: space-between; align-items: center;">
              <button class="ghost-button" style="font-size: 0.8rem; padding: 0.5rem; color: var(--accent-primary);" id="download-template-btn">Download Template</button>
              <button class="ghost-button" onclick="document.getElementById('import-modal').remove()" style="color: var(--text-muted);">Close</button>
          </div>
          
          <div id="import-preview" class="hidden" style="margin-top: 1.5rem; border-top: 1px solid var(--border-light); padding-top: 1rem;">
              <div id="import-stats" style="font-size: 0.85rem; font-weight: 700; margin-bottom: 0.5rem; color: var(--text-primary);"></div>
              <div style="max-height: 200px; overflow-y: auto; border: 1px solid var(--border-light); border-radius: var(--radius-md); font-size: 0.75rem; background: var(--bg-input);" id="import-log"></div>
              <button class="primary-button" id="final-import-btn" style="width: 100%; margin-top: 1rem;">Process Import</button>
          </div>
        </div>
      </div>
    `
    document.body.insertAdjacentHTML('beforeend', modalHtml)

    const downloadBtn = document.getElementById('download-template-btn')
    downloadBtn.addEventListener('click', () => downloadTemplate(user))

    const dropzone = document.getElementById('import-dropzone')
    const fileInput = document.getElementById('import-file-input')
    dropzone.addEventListener('click', () => fileInput.click())

    let parsedData = []

    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0]
        if (!file) return

        const ExcelJS = await loadExcelJS();
        const workbook = new ExcelJS.Workbook()
        try {
            await workbook.xlsx.load(file)
            const worksheet = workbook.getWorksheet(1)
            
            // Validate Passcode
            const db = getDb()
            const coopDoc = await getDoc(doc(db, 'cooperatives', user.cooperativeId))
            const expectedPasscode = coopDoc.exists() ? (coopDoc.data().short_name || '0000000000') : '0000000000'
            const actualPasscode = worksheet.getCell('A1').value
            
            if (String(actualPasscode) !== String(expectedPasscode)) {
                return showToast("Passcode mismatch! Please use a template downloaded from this cooperative.", 'error')
            }

            parsedData = []
            const logs = []
            const normalizePhone = (num) => {
                const cleaned = String(num || '').replace(/\D/g, '')
                return cleaned.length > 10 ? cleaned.slice(-10) : cleaned
            }
            const properCase = (str) => String(str || '').trim().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')

            // Iterate rows starting from row 5
            worksheet.eachRow((row, rowNumber) => {
                if (rowNumber < 5) return
                const lastName = row.getCell(2).value
                const firstName = row.getCell(3).value
                const mobile = row.getCell(5).value

                if (!lastName || !firstName || !mobile) {
                    if (lastName || firstName || mobile) logs.push(`<div style="color: var(--danger); padding: 2px;">Row ${rowNumber}: Missing required fields.</div>`)
                    return
                }

                parsedData.push({
                    cooperative_id: user.cooperativeId,
                    last_name: properCase(lastName),
                    first_name: properCase(firstName),
                    middle_name: properCase(row.getCell(4).value),
                    mobile: normalizePhone(mobile),
                    sex: row.getCell(6).value || 'Male',
                    status: row.getCell(7).value || 'Active',
                    address: String(row.getCell(8).value || '').trim(),
                    date_joined: row.getCell(9).value instanceof Date ? row.getCell(9).value.toISOString().slice(0, 10) : String(row.getCell(9).value || ''),
                    account_manager: String(row.getCell(10).value || '').trim(),
                    nok_name: properCase(row.getCell(11).value),
                    nok_mobile: normalizePhone(row.getCell(12).value)
                })
                logs.push(`<div style="color: var(--success); padding: 2px;">Row ${rowNumber}: ${properCase(lastName)} ${properCase(firstName)} parsed.</div>`)
            })

            document.getElementById('import-preview').classList.remove('hidden')
            document.getElementById('import-stats').innerText = `Ready to import ${parsedData.length} members.`
            document.getElementById('import-log').innerHTML = logs.join('')
            
        } catch (err) {
            showToast("Failed to parse file: " + err.message, 'error')
        }
    })

    document.getElementById('final-import-btn').addEventListener('click', async () => {
        const btn = document.getElementById('final-import-btn')
        btn.disabled = true; btn.innerText = 'Importing...'

        try {
            // Coop-scoped duplicate guard: skip rows whose mobile / special_id
            // already exists locally or appears twice inside the file itself.
            // addMember() re-checks anyway; this keeps the bulk run going.
            const { getAllForCoop } = await import('../../services/sqliteService.js')
            let existing = []
            try { existing = await getAllForCoop(String(user.cooperativeId), 'members') } catch { existing = getAllMembers() }
            const seenMobiles = new Set(
                (existing || []).map(m => String(m.mobile || '').replace(/\D/g, '').slice(-10)).filter(Boolean)
            )
            const seenSpecials = new Set(
                (existing || []).map(m => String(m.special_id || '').trim().toLowerCase()).filter(Boolean)
            )
            let imported = 0
            const skipped = []
            for (const data of parsedData) {
                const mk = String(data.mobile || '').replace(/\D/g, '').slice(-10)
                const sk = String(data.special_id || '').trim().toLowerCase()
                if ((mk && seenMobiles.has(mk)) || (sk && seenSpecials.has(sk))) {
                    skipped.push(`${data.last_name || ''} ${data.first_name || ''}`.trim() || data.mobile || 'row')
                    continue
                }
                data.password_hash = generateRandom6Digit() // Default 6-digit PIN for bulk import (force-change on first login via addMember)
                try {
                    await addMember(data, user.username)
                } catch (e) {
                    // Race/edge: data-layer guard fired (e.g. member synced mid-import)
                    if (String(e.message || '').includes('already registered')) {
                        skipped.push(`${data.last_name || ''} ${data.first_name || ''}`.trim() || data.mobile || 'row')
                        continue
                    }
                    throw e
                }
                if (mk) seenMobiles.add(mk)
                if (sk) seenSpecials.add(sk)
                imported++
            }
            if (skipped.length > 0) {
                showToast(`Imported ${imported}, skipped ${skipped.length} duplicate(s): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '…' : ''}`, 'warning')
            } else {
                showToast(`Successfully imported ${imported} members.`, 'success')
            }
            document.getElementById('import-modal').remove()
            await loadMembersData(user)
            window.dispatchEvent(new Event('refresh-members'))
        } catch (err) {
            showToast("Bulk import error: " + err.message, 'error')
            btn.disabled = false; btn.innerText = 'Process Import'
        }
    })
}
