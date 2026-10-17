import sqlite3

conn = sqlite3.connect('sampledata.db')
cursor = conn.cursor()

# Get column names
cursor.execute("PRAGMA table_info(cooperatives)")
columns = cursor.fetchall()
print('Columns:')
for c in columns:
    print(f"  {c[1]} (type: {c[2]})")

# Get all cooperatives
cursor.execute('SELECT * FROM cooperatives')
rows = cursor.fetchall()
print('\nCooperatives rows:')
for r in rows:
    print(f"  {list(r)}")

conn.close()