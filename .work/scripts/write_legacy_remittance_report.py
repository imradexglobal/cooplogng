import sqlite3
p = r'C:\Users\USER\Downloads\cooperative_backup_2026-11-18T00-46.db'
out = r'C:\Users\USER\Documents\Imradex_Project\cooplogng\outputs\legacy_opening_remittances_full_list_2025-12-31.md'
c = sqlite3.connect(p); c.row_factory = sqlite3.Row
sql = """select r.id,r.remittance_date,r.member_id,trim(coalesce(m.first_name,'')||' '||coalesce(m.middle_name,'')||' '||coalesce(m.last_name,'')) member_name,r.amount,r.bank_name,r.transaction_type,r.category,r.description,d.id detail_id,e.account_name,d.amount detail_amount,d.auto_description from remittance r left join members m on m.id=r.member_id left join remittance_detail d on d.remittance_id=r.id and d.is_deleted='0' left join enterprise e on e.id=d.enterprise_id where r.is_deleted='0' and substr(r.remittance_date,1,10)='2025-12-31' and r.transaction_type in ('Member Loan','Loan Charges','Savings Withdrawal','Member Deposit','Internal Transfer') order by r.transaction_type,r.id,d.id"""
rows = [dict(x) for x in c.execute(sql)]
groups = {}
order = []
for x in rows:
    groups.setdefault(x['id'], []).append(x)
    if x['id'] not in order: order.append(x['id'])
with open(out, 'w', encoding='utf-8') as f:
    f.write('# Full list of legacy 2025-12-31 remittances\n\n')
    f.write('Source: `cooperative_backup_2026-11-18T00-46.db` (read-only). The CSV companion contains one row per detail leg. This report contains one section per distinct remittance.\n\n')
    f.write('| Group | Distinct remittances | Header net | Detail net |\n|---|---:|---:|---:|\n')
    for typ in ['Member Loan','Loan Charges','Savings Withdrawal','Member Deposit','Internal Transfer']:
        rr = [x for x in rows if x['transaction_type'] == typ]
        ids = {x['id'] for x in rr}
        hdr = {i: next(x['amount'] for x in rr if x['id'] == i) for i in ids}
        det = sum(float(x['detail_amount'] or 0) for x in rr)
        f.write(f'| {typ} | {len(ids)} | {sum(float(v or 0) for v in hdr.values()):,.2f} | {det:,.2f} |\n')
    f.write('\n')
    n = 0
    for typ in ['Member Loan','Loan Charges','Savings Withdrawal','Member Deposit','Internal Transfer']:
        f.write(f'## {typ}\n\n')
        for rid in order:
            rr = groups[rid]
            if rr[0]['transaction_type'] != typ: continue
            x = rr[0]; n += 1
            member = x['member_name'].strip() or '(cooperative / pseudo-member)'
            f.write(f'{n}. **{x["id"]}** — {member}; amount **{float(x["amount"] or 0):,.2f}**; category `{x["category"]}`; description: {x["description"] or "(blank)"}.\n')
            for d in rr:
                if d['detail_id']:
                    f.write(f'   - Detail `{d["detail_id"]}` → `{d["account_name"] or d["enterprise_id"]}`: {float(d["detail_amount"] or 0):,.2f}; auto-description: {d["auto_description"] or "(blank)"}.\n')
                else:
                    f.write('   - No detail leg.\n')
        f.write('\n')
    f.write('## Recommended posting for a dividend applied to the member loan\n\n')
    f.write('Use one balanced internal-transfer remittance with two signed detail legs: debit the member-liability/savings enterprise by **-11,760.00** and credit the loan enterprise by **+11,760.00**. The details sum to zero. Set bank to `Internal Transfer`, type to `Internal Transfer`, category to `Transfer`, retain the member ID, and describe it as `2025 dividend applied to Ordinary Loan – member instruction`. The current app validation already supports a zero-header balanced internal transfer with multiple details summing to zero. Do not retain only the loan detail; that is the one-sided posting causing the current difference.\n')
c.close()
print(out, len(groups), len(rows))
