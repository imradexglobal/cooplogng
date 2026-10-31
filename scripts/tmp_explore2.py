import openpyxl
wb = openpyxl.load_workbook('C:/Users/User/Documents/migration/old_data.xlsm', data_only=True, read_only=True)

ws = wb['SetUP2']
print("===== SetUP2 full (cols B=ID, C=NAME) =====")
for i, row in enumerate(ws.iter_rows(min_row=1, max_row=35, max_col=21, values_only=True), start=1):
    print(i, row)

ws = wb['REMITTANCE']
print("\n===== REMITTANCE: distinct DESCRIPTION / CHANNEL / full name sample =====")
# sample data rows (skip header)
rows = list(ws.iter_rows(min_row=2, values_only=True))
print("total data rows:", len(rows))
# non-empty rows
nonempty = [r for r in rows if r[0] is not None]
print("non-empty tran rows:", len(nonempty))
# date range
import datetime
dates = [r[1] for r in nonempty if isinstance(r[1], datetime.datetime)]
print("date min:", min(dates), "max:", max(dates))
# description values
from collections import Counter
desc = Counter(str(r[5]) for r in nonempty)
print("DESCRIPTION:", desc)
channel = Counter(str(r[4]) for r in nonempty)
print("CHANNEL:", channel)
# Amount distribution
amts = [r[3] for r in nonempty if isinstance(r[3],(int,float))]
print("Amount nonzero count:", sum(1 for a in amts if a!=0), "zero count:", sum(1 for a in amts if a==0))
print("Amount sample nonzero:", [a for a in amts if a!=0][:20])

# Look at records with non-zero Amount
print("\n--- REMITTANCE rows with nonzero Amount ---")
for r in nonempty:
    if isinstance(r[3],(int,float)) and r[3]!=0:
        print(r)
