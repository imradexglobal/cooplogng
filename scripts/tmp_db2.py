import sqlite3
conn = sqlite3.connect('C:/Users/User/Documents/migration/the_new_format.db')
conn.row_factory = sqlite3.Row
c = conn.cursor()
print("=== members sample ===")
for row in c.execute("SELECT * FROM members LIMIT 10"):
    print(dict(row))
print("\n=== members count ===")
print(c.execute("SELECT count(*) FROM members").fetchone()[0])
print("\n=== remittance sample (recent non-bf) ===")
for row in c.execute("SELECT * FROM remittance WHERE category!='BROUGHT_FORWARD' AND transaction_type!='DEBIT' LIMIT 5"):
    print(dict(row))
print("\n=== remittance_detail sample ===")
for row in c.execute("SELECT * FROM remittance_detail LIMIT 5"):
    print(dict(row))
conn.close()
