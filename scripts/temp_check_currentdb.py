import sqlite3

conn = sqlite3.connect('currentdb.db')
cursor = conn.cursor()
cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
tables = cursor.fetchall()
print('Tables:', [t[0] for t in tables])
if 'cooperatives' in [t[0] for t in tables]:
    cursor.execute('SELECT * FROM cooperatives')
    rows = cursor.fetchall()
    print('\nCooperatives:')
    for r in rows:
        print(list(r))
conn.close()