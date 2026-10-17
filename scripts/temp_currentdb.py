import sqlite3

conn = sqlite3.connect('currentdb.db')
cursor = conn.cursor()

# Check if tables exist
cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
tables = cursor.fetchall()
print('Tables:', [t[0] for t in tables])

if 'cooperatives' in [t[0] for t in tables]:
    cursor.execute("PRAGMA table_info(cooperatives)")
    columns = cursor.fetchall()
    print('Columns:', [c[1] for c in columns])
    
    cursor.execute('SELECT * FROM cooperatives')
    rows = cursor.fetchall()
    print('\nCooperatives rows:')
    for r in rows:
        print(r)

conn.close()