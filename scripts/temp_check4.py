import sqlite3

conn = sqlite3.connect('sampledata.db')
cursor = conn.cursor()

# Check cooperative_id distribution
collections = ['members', 'loans', 'enterprise', 'bank', 'remittance', 'transaction_types']
for col in collections:
    cursor.execute(f"SELECT cooperative_id, COUNT(*) as cnt FROM {col} GROUP BY cooperative_id")
    rows = cursor.fetchall()
    print(f"{col}:")
    for r in rows:
        print(f"  {r[0]}: {r[1]}")

conn.close()