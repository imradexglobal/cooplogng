import sqlite3

conn = sqlite3.connect('sampledata.db')
cursor = conn.cursor()

# Check count
cursor.execute("SELECT COUNT(*) FROM cooperatives")
count = cursor.fetchone()[0]
print("Count:", count)

# Get all rows
cursor.execute("SELECT * FROM cooperatives")
rows = cursor.fetchall()
print("\nRows:")
for r in rows:
    print(r)

# Check specific id
cursor.execute("SELECT * FROM cooperatives WHERE id = 'CG0nAXNIzK'",)
row = cursor.fetchone()
print("\nRow with id='CG0nAXNIzK':", row)

cursor.execute("SELECT * FROM cooperatives WHERE id = 'Nasfat IKD'",)
row = cursor.fetchone()
print("Row with id='Nasfat IKD':", row)

conn.close()