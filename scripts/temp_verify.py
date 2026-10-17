import sqlite3

conn = sqlite3.connect('sampledata.db')
cursor = conn.cursor()

# Verify cooperative_id was updated in all collections
collections = ['members', 'loans', 'enterprise', 'bank', 'remittance', 'transaction_types',
               'bank_reconciliation_summary', 'feedback', 'notifications', 'payment_advise',
               'remittance_detail', 'loan_guarantors']

print("Verifying cooperative_id updates:")
for col in collections:
    try:
        cursor.execute(f"SELECT cooperative_id, COUNT(*) as cnt FROM {col} GROUP BY cooperative_id")
        rows = cursor.fetchall()
        print(f"{col}:")
        for r in rows:
            print(f"  {r[0]}: {r[1]}")
    except Exception as e:
        print(f"{col}: Error - {e}")

# Verify cooperatives table
print("\nCooperatives table:")
cursor.execute("SELECT * FROM cooperatives")
rows = cursor.fetchall()
for r in rows:
    print(list(r))

conn.close()