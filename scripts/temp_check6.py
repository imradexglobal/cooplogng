import sqlite3

conn = sqlite3.connect('sampledata.db')
cursor = conn.cursor()

# Get all cooperatives
cursor.execute('SELECT * FROM cooperatives')
rows = cursor.fetchall()
print('All Cooperatives:')
for r in rows:
    print(list(r))

# Check each collection for cooperative_id distribution
collections = ['members', 'loans', 'enterprise', 'bank', 'remittance', 'transaction_types', 'bank_reconciliation_summary', 'feedback', 'notifications', 'payment_advise', 'remittance_detail', 'loan_guarantors']

print('\nCooperative ID distribution across collections:')
for col in collections:
    try:
        cursor.execute(f'SELECT cooperative_id, COUNT(*) as cnt FROM {col} GROUP BY cooperative_id')
        rows = cursor.fetchall()
        print(f'{col}:')
        for r in rows:
            print(f'  {r[0]}: {r[1]}')
    except Exception as e:
        print(f'{col}: Error - {e}')

conn.close()