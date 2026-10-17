import firebase_admin
from firebase_admin import credentials, firestore
import os

os.chdir("C:\\Users\\Admin\\Documents\\Imradex_Tech_Projects\\cooplogng")
KEY_PATH = "scripts/serviceAccountKey.json"
cred = credentials.Certificate(KEY_PATH)
firebase_admin.initialize_app(cred)
db = firestore.client()

# List all cooperatives
docs = list(db.collection('cooperatives').stream())
print('All cooperatives in Firestore:')
for doc in docs:
    data = doc.to_dict()
    print(f"  ID: {doc.id}, short_name: {data.get('short_name', 'N/A')}, id: {data.get('id', 'N/A')}")
    
# Check specific cooperative
print('\nChecking CG0nAXNIzK:')
doc = db.collection('cooperatives').document('CG0nAXNIzK').get()
print(f'  Exists: {doc.exists}')
if doc.exists:
    print(f'  Data: {doc.to_dict()}')
PYEOF