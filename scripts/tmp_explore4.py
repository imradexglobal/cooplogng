import openpyxl, datetime
from collections import Counter
wb = openpyxl.load_workbook('C:/Users/User/Documents/migration/old_data.xlsm', data_only=True, read_only=True)

ws = wb['REMITTANCE_DETAILS']
drows = [r for r in ws.iter_rows(min_row=2, values_only=True) if r[0] is not None]
print("DETAILS rows:", len(drows))
bdates = [r[29] for r in drows if len(r)>29 and isinstance(r[29], datetime.datetime)]
print("BANK DATE min:", min(bdates), "max:", max(bdates))
edates = [r[27] for r in drows if len(r)>27 and isinstance(r[27], datetime.datetime)]
print("ENTERED_ON min:", min(edates), "max:", max(edates))

# For each tran, sum of numbered columns vs REMITTANCE Amount
ws2 = wb['REMITTANCE']
rem = {r[0]: r for r in ws2.iter_rows(min_row=2, values_only=True) if r[0] is not None}

# Look at some specific tran examples
for tid in [1, 24, 100, 1000]:
    dr = [r for r in drows if r[0]==tid]
    print("\nTRANID", tid)
    for r in dr[:3]:
        nums = r[2:27]
        print("  REG_NO=",r[1], "nums=", nums, "BANKDATE=", r[29], "Closed=", r[30])
    if tid in rem:
        r = rem[tid]
        print("  REMITTANCE: DATE=",r[1],"REG_NO=",r[2],"Amount=",r[3],"CHANNEL=",r[4],"DESC=",r[5])
