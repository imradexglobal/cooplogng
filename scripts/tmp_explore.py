import openpyxl
wb = openpyxl.load_workbook('C:/Users/User/Documents/migration/old_data.xlsm', data_only=True, read_only=True)
for name in ['SetUP2','REMITTANCE','REMITTANCE_DETAILS']:
    ws = wb[name]
    print(f"\n===== {name} rows={ws.max_row} cols={ws.max_column} =====")
    for i, row in enumerate(ws.iter_rows(values_only=True), start=1):
        # print first 20 rows and last 5 rows
        if i <= 25 or i > ws.max_row - 5:
            print(i, row)
        elif i == 26:
            print('...')
print('done')
