import openpyxl, datetime
from collections import Counter
wb = openpyxl.load_workbook('C:/Users/User/Documents/migration/old_data.xlsm', data_only=True, read_only=True)

ws = wb['SetUP2']
print("===== SetUP2 enterprises (col B=ID, col C=NAME) =====")
for i, row in enumerate(ws.iter_rows(min_row=1, max_row=30, max_col=3, values_only=True), start=1):
    print(i, '| ID=', row[1], '| NAME=', repr(row[2]))

ws = wb['REMITTANCE']
rows = [r for r in ws.iter_rows(min_row=2, values_only=True) if r[0] is not None]
print("\nREMITTANCE non-empty rows:", len(rows))
dates = [r[1] for r in rows if isinstance(r[1], datetime.datetime)]
print("DATE min:", min(dates), "max:", max(dates))
print("DESCRIPTION:", Counter(str(r[5]) for r in rows))
print("CHANNEL:", Counter(str(r[4]) for r in rows))
amts = [r[3] for r in rows if isinstance(r[3],(int,float))]
print("Amount nonzero:", sum(1 for a in amts if a!=0), "zero:", sum(1 for a in amts if a==0))
print("nonzero amounts sample:", [a for a in amts if a!=0][:50])

# REG_NO values
regs = [r[2] for r in rows]
print("REG_NO sample:", regs[:10], "distinct types:", Counter(type(r).__name__ for r in regs))
print("REG_NO distinct count:", len(set(regs)))

ws = wb['REMITTANCE_DETAILS']
drows = [r for r in ws.iter_rows(min_row=2, values_only=True) if r[0] is not None]
print("\nREMITTANCE_DETAILS non-empty rows:", len(drows))
# header columns
hdr = list(ws.iter_rows(min_row=1, max_row=1, values_only=True))[0]
print("DETAILS header:", hdr)
# date range from BANK DATE
bdates = [r[28] for r in drows if len(r)>28 and isinstance(r[28], datetime.datetime)]
print("BANK DATE min:", min(bdates), "max:", max(bdates))
