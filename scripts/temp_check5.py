import sqlite3

conn = sqlite3.connect('sampledata.db')
cursor = conn.cursor()

# Get column names
cursor.execute('PRAGMA table_info(cooperatives)')
columns = cursor.fetchall()
print('Columns:', [c[1] for c in columns])

# Get all cooperatives
cursor.execute('SELECT * FROM cooperatives')
rows = cursor.fetchall()
print('\nCooperatives rows:')
for r in rows:
    print(list(r))

conn.close()