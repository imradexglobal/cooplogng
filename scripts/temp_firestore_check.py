import firebase_admin
from firebase_admin import credentials, firestore
import os

KEY_PATH = os.path.exists("scripts/serviceAccountKey.json") and "scripts/serviceAccountKey.json" or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")

cred = credentials.Certificate(KEY_PATH)
firebase_admin.initialize_app(cred)
db = firestore.client()

# Try to get the cooperative
doc = db.collection('cooperatives').document('CG0nAXNIzK').get()
print('Cooperative doc exists:', doc.exists)
if doc.exists:
    print('Data:', doc.to_dict())
else:
    print('Cooperative not found in Firestore')
    
# List first few collections
collections = list(db.collections())
count = 0
for col in collections:
    count += 1
    print(f'Collection: {col.id}')
    docs = list(col.stream())
    print(f'  Document count: {len(docs)}')
    if count >= 5:
        break