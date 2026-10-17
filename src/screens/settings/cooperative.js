import { getAllForCoop, saveDoc, enqueueWrite } from '../../services/sqliteService.js';
import { compressImage } from '../../utils/imageUtils.js';
import { showToast } from '../../services/toastService.js';
import { getInitials, wrapDateInput } from '../../utils/formatters.js';
import { getDb, collection, getDocs, query, where } from '../../firebase.js';

async function checkCoopNameUniqueness(fullName, shortName, excludeId) {
    const db = getDb()
    
    const fullNameSnap = await getDocs(
        query(collection(db, 'cooperatives'), where('full_name', '==', fullName), where('is_deleted', '!=', 1))
    )
    if (!fullNameSnap.empty) {
        const existing = fullNameSnap.docs.find(d => d.id !== excludeId)
        if (existing) {
            throw new Error('A cooperative with this full name already exists.')
        }
    }
    
    const shortNameUpper = shortName.toUpperCase()
    const shortNameSnap = await getDocs(
        query(collection(db, 'cooperatives'), where('short_name', '==', shortNameUpper), where('is_deleted', '!=', 1))
    )
    if (!shortNameSnap.empty) {
        const existing = shortNameSnap.docs.find(d => d.id !== excludeId)
        if (existing) {
            throw new Error('A cooperative with this short name/acronym already exists.')
        }
    }
}

export function renderCooperativeSection(area) {
  area.innerHTML = `
      <h3>Cooperative Settings</h3>
      <p class="section-desc">Update your cooperative's details and branding.</p>
      <form id="cooperative-form" style="display: flex; flex-direction: column; gap: 1.25rem; max-width: 600px;">
        <div class="field">
          <label>Cooperative Logo</label>
          <div style="display: flex; gap: 1rem; align-items: center;">
            <div id="coop-logo-preview" style="width: 80px; height: 80px; border-radius: 50%; background: var(--accent-primary); color: white; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 1.5rem; overflow: hidden; cursor: pointer; border: 2px dashed var(--border-light);">
            </div>
            <div style="font-size: 0.85rem; color: var(--text-muted);">
              Click logo to change
            </div>
            <input type="file" id="coop-logo-input" accept="image/*" style="display: none;">
          </div>
        </div>
        <div class="field">
          <label>Full Name *</label>
          <input type="text" id="coop-full-name" name="full_name" placeholder="Enter full cooperative name" required>
        </div>
        <div class="field">
          <label>Short Name *</label>
          <input type="text" id="coop-short-name" name="short_name" placeholder="Enter short name/acronym" required>
        </div>
        <div class="field">
          <label>Contact Number</label>
          <input type="text" id="coop-contact-number" name="contact_number" placeholder="Enter contact number">
        </div>
        <div class="field">
          <label>Email</label>
          <input type="email" id="coop-email" name="email" placeholder="Enter email address">
        </div>
        <div class="field">
          <label>Address</label>
          <textarea id="coop-address" name="address" rows="2" placeholder="Enter address"></textarea>
        </div>
        <div class="field">
          <label>Cooperative First Month</label>
          <input type="date" id="coop-first-month" name="coop_first_month">
        </div>
        <button type="submit" class="primary-button" style="width: fit-content;">Save Changes</button>
      </form>
    `;
}

export async function setupCooperativeListeners(user, cooperativeId, container) {
  // Wrap date input to show DD MMM, YYYY
  container.querySelectorAll('input[type="date"]').forEach(wrapDateInput);

  let selectedLogo = null;
  let currentCoop = null;

  const loadCoopData = async () => {
    try {
      const coops = await getAllForCoop(cooperativeId, 'cooperatives');
      const coop = coops[0];
      if (coop) {
        currentCoop = coop;
        document.getElementById('coop-full-name').value = coop.full_name || '';
        document.getElementById('coop-short-name').value = coop.short_name || '';
        document.getElementById('coop-contact-number').value = coop.contact_number || '';
        document.getElementById('coop-email').value = coop.email || '';
        document.getElementById('coop-address').value = coop.address || '';
        document.getElementById('coop-first-month').value = coop.coop_first_month ? String(coop.coop_first_month).split('T')[0] : '';

        updateLogoPreview(coop.logo_path, coop.short_name);
      }
    } catch (err) {
      console.error('Failed to load cooperative data:', err);
    }
  };

  const updateLogoPreview = (logoPath, coopName) => {
    const preview = document.getElementById('coop-logo-preview');
    if (!preview) return;
    if (logoPath) {
      preview.innerHTML = `<img src="${logoPath}" style="width: 100%; height: 100%; object-fit: cover;">`;
    } else {
      preview.textContent = getInitials(coopName || 'Coop');
    }
  };

  const logoPreview = document.getElementById('coop-logo-preview');
  const logoInput = document.getElementById('coop-logo-input');

  logoPreview?.addEventListener('click', () => {
    logoInput?.click();
  });

  logoInput?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      try {
        selectedLogo = await compressImage(file);
        const currentShortName = document.getElementById('coop-short-name').value;
        updateLogoPreview(selectedLogo, currentShortName);
      } catch (err) {
        console.error('Failed to compress logo:', err);
      }
    }
  });

  const form = document.getElementById('cooperative-form');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('button');
    try {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving...';

      if (!currentCoop) {
        throw new Error('Cooperative not found');
      }

      // Check uniqueness of full_name and short_name (excluding current coop)
      const newFullName = document.getElementById('coop-full-name').value.trim()
      const newShortName = document.getElementById('coop-short-name').value.trim().toUpperCase()
      await checkCoopNameUniqueness(newFullName, newShortName, currentCoop.id)

      const payload = {
        ...currentCoop, // Keep all existing fields (subscription_key, expiry_date, created_at, created_by, etc.)
        full_name: newFullName,
        short_name: newShortName,
        contact_number: document.getElementById('coop-contact-number').value.trim(),
        email: document.getElementById('coop-email').value.trim(),
        address: document.getElementById('coop-address').value.trim(),
        coop_first_month: document.getElementById('coop-first-month').value.trim(),
        logo_path: selectedLogo || currentCoop.logo_path || null,
        modified_at: new Date().toISOString(),
        modified_by: user.username,
        is_synced: 0
      };

      await saveDoc('cooperatives', payload);
      await enqueueWrite(cooperativeId, 'cooperatives', payload.id, 'update', payload);

      // Refresh currentCoop
      const coops = await getAllForCoop(cooperativeId, 'cooperatives');
      currentCoop = coops[0];

      showToast('Cooperative settings saved!', 'success');
    } catch (err) {
      console.error('Save failed:', err);
      showToast('Failed to save: ' + err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save Changes';
    }
  });

  await loadCoopData();
}
