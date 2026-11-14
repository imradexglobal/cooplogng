import { formatCurrency } from '../../utils/formatters.js';

export function showBatchDuesChargePopup(chargeable, memberCount) {
    return new Promise(resolve => {
        const modalId = 'statement-batch-dues-modal';
        document.getElementById(modalId)?.remove();
        const overlay = document.createElement('div');
        overlay.id = modalId;
        overlay.className = 'modal-overlay open';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999999;display:flex;align-items:center;justify-content:center;';
        const modal = document.createElement('div');
        modal.style.cssText = 'background:var(--bg-card);border-radius:var(--radius-md);width:92%;max-width:560px;max-height:90vh;overflow:auto;padding:1.5rem;box-shadow:var(--shadow-xl);';
        const title = document.createElement('h3');
        title.textContent = 'Compulsory Dues & Penalties';
        const description = document.createElement('p');
        description.textContent = `Choose whether to apply these charges to all ${memberCount} positive member remittances in this batch. The configured amounts apply per member.`;
        const rows = document.createElement('div');
        rows.style.cssText = 'display:flex;flex-direction:column;gap:.55rem;';
        const inputs = [];
        chargeable.forEach((charge, idx) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:.65rem;padding:.6rem;background:var(--bg-secondary);border-radius:var(--radius-sm);';
            const label = document.createElement('div');
            label.style.cssText = 'flex:1;font-weight:700;';
            label.textContent = `${charge.isDue ? '(C) ' : ''}${charge.isPen ? '(P) ' : ''}${charge.name}`;
            const defaultLine = document.createElement('div');
            defaultLine.style.cssText = 'font-size:.72rem;color:var(--text-muted);font-weight:400;';
            defaultLine.textContent = `Default: ${formatCurrency(charge.defaultAmount || 0)} per member`;
            label.appendChild(defaultLine);
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.textContent = 'Disable';
            toggle.setAttribute('aria-pressed', 'false');
            const input = document.createElement('input');
            input.type = 'number';
            input.min = '0';
            input.step = '0.01';
            input.value = Number(charge.defaultAmount || 0).toFixed(2);
            input.dataset.idx = String(idx);
            input.style.cssText = 'width:125px;padding:.45rem;text-align:right;';
            toggle.addEventListener('click', () => {
                const disabled = toggle.getAttribute('aria-pressed') !== 'true';
                toggle.setAttribute('aria-pressed', String(disabled));
                toggle.textContent = disabled ? 'Enable' : 'Disable';
                if (disabled) {
                    input.dataset.previousValue = input.value;
                    input.value = '0';
                } else {
                    input.value = input.dataset.previousValue || '0';
                }
                input.disabled = disabled;
            });
            row.append(label, toggle, input);
            rows.appendChild(row);
            inputs.push(input);
        });
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;justify-content:flex-end;gap:.75rem;margin-top:1.25rem;padding-top:1rem;border-top:1px solid var(--border-light);';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'btn btn-secondary';
        close.textContent = 'Cancel';
        const no = document.createElement('button');
        no.type = 'button';
        no.className = 'btn btn-secondary';
        no.textContent = 'Don’t Charge';
        const yes = document.createElement('button');
        yes.type = 'button';
        yes.className = 'btn btn-primary';
        yes.textContent = 'Charge for Batch';
        actions.append(close, no, yes);
        modal.append(title, description, rows, actions);
        const finish = value => { overlay.remove(); resolve(value); };
        close.addEventListener('click', () => finish(null));
        no.addEventListener('click', () => finish({ charge: false, items: [] }));
        yes.addEventListener('click', () => {
            const items = [];
            inputs.forEach(input => {
                const charge = chargeable[Number(input.dataset.idx)];
                const amount = Math.abs(Number(input.value) || 0);
                if (charge && amount > 0) items.push({ enterprise_id: charge.enterprise_id, name: charge.name, amount });
            });
            finish({ charge: true, items });
        });
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    });
}
