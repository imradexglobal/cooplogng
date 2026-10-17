import sqlite3

conn = sqlite3.connect('sampledata.db')
cursor = conn.cursor()
cursor.execute("SELECT * FROM cooperatives")
rows = cursor.fetchall()
print('Cooperatives:')
for r in rows:
    print(r)
conn.close()