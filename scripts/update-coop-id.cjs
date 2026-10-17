#!/usr/bin/env node
/**
 * update-coop-id.mjs
 * =================
 * Updates the cooperative ID across all Firestore collections to the cooperative's short name.
 *
 * Usage:
 *   node scripts/update-coop-id.mjs CG0nAXNIzK
 *
 * This script:
 *   1. Accepts cooperative ID as command-line argument
 *   2. Gets the short name from Firestore cooperatives collection
 *   3. Updates the cooperatives document ID to the short name
 *   4. Updates ALL documents across ALL collections where cooperative_id matches the given ID
 */

// Load .env.local manually
const fs = require('fs');
const path = require('path');

const envPath = path.resolve(process.cwd(), '.env.local');
const envFileContent = fs.readFileSync(envPath, 'utf-8');
let envVars = {};

// Simple .env parser
for (const line of envFileContent.split('\n')) {
  const match = line.match(/^VITE_(.+)=(.*)$/);
  if (match) {
    envVars[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, collection, query, where, getDocs, writeBatch, setDoc, deleteDoc } = require('firebase/firestore');

// Firebase config from .env.local
const firebaseConfig = {
  apiKey: envVars.VITE_FIREBASE_API_KEY,
  authDomain: envVars.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: envVars.VITE_FIREBASE_PROJECT_ID,
  storageBucket: envVars.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: envVars.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: envVars.VITE_FIREBASE_APP_ID,
};

// Check if we have the config
function hasFirebaseConfig() {
  return Object.values(firebaseConfig).every((value) => typeof value === 'string' && value.trim() !== '');
}

if (!hasFirebaseConfig()) {
  console.error('Firebase web configuration is missing. Add your values to .env.local.');
  process.exit(1);
}

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Get cooperative ID from command line
const args = process.argv.slice(2);
const coopId = args[0];

if (!coopId) {
  console.error('Usage: node scripts/update-coop-id.mjs <coop_id>');
  console.error('Example: node scripts/update-coop-id.mjs CG0nAXNIzK');
  process.exit(1);
}

console.log(`Cooperative ID: ${coopId}`);
console.log();

// Step 1: Get the short name from Firestore cooperatives collection
async function getShortName() {
  const coopRef = doc(db, 'cooperatives', coopId);
  const coopDoc = await getDoc(coopRef);

  if (!coopDoc.exists()) {
    console.error(`ERROR: Cooperative document '${coopId}' not found in Firestore`);
    process.exit(1);
  }

  const data = coopDoc.data();
  const shortName = data.short_name;

  if (!shortName) {
    console.error(`ERROR: No 'short_name' field found in cooperative '${coopId}'`);
    process.exit(1);
  }

  console.log(`Found short name: ${shortName}`);
  return shortName;
}

// All collections that have cooperative_id field
const collections = [
  'cooperatives',
  'members',
  'loans',
  'enterprise',
  'bank',
  'remittance',
  'transaction_types',
  'bank_reconciliation_summary',
  'feedback',
  'notifications',
  'payment_advise',
  'remittance_detail',
  'loan_guarantors',
];

async function main() {
  const shortName = await getShortName();
  console.log();

  // Step 2: Update the cooperatives document ID to the short name
  console.log('Step 2: Updating cooperatives document ID...');
  const coopRef = doc(db, 'cooperatives', coopId);
  const coopData = await getDoc(coopRef);

  if (!args.includes('--dry-run')) {
    try {
      // Firestore doesn't support renaming document IDs directly.
      // We need to copy data to new document and delete old one.
      const newRef = doc(db, 'cooperatives', shortName);
      
      // Copy all data to new document
      await setDoc(newRef, {
        ...coopData.data(),
        updated_at: new Date().toISOString(),
        _moved_from: coopId,
      });

      // Delete the old document
      await deleteDoc(coopRef);

      console.log(`  Moved cooperatives document from '${coopId}' to '${shortName}'`);
    } catch (e) {
      console.error(`  ERROR: Failed to update cooperatives document ID: ${e}`);
      process.exit(1);
    }
  } else {
    const coopData = (await getDoc(coopRef)).data();
    console.log(`  [DRY RUN] Would move cooperatives document from '${coopId}' to '${shortName}'`);
    console.log(`  [DRY RUN] Current short_name from doc: ${coopData.short_name || 'not found'}`);
  }
  console.log();

  // Step 3: Update all documents across all collections
  console.log('Step 3: Updating cooperative_id fields across all collections...');
  
  let totalUpdated = 0;

  for (const collectionName of collections) {
    try {
      const collectionRef = collection(db, collectionName);
      const q = query(collectionRef, where('cooperative_id', '==', coopId));
      const docs = await getDocs(q);

      if (docs.empty) {
        console.log(`  ${collectionName}: 0 docs have cooperative_id='${coopId}'`);
        continue;
      }

      if (args.includes('--dry-run')) {
        console.log(`  ${collectionName}: ${docs.size} docs have cooperative_id='${coopId}'`);
        totalUpdated += docs.size;
        continue;
      }

      // Update docs in batches
      const batchSize = 500;
      let updated = 0;

      for (let i = 0; i < docs.docs.length; i += batchSize) {
        const batch = writeBatch(db);
        const chunk = docs.docs.slice(i, i + batchSize);

        chunk.forEach((docSnap) => {
          batch.update(docSnap.reference, { cooperative_id: shortName });
        });

        await batch.commit();
        updated += chunk.length;
      }

      console.log(`  ${collectionName}: Updated ${updated} docs`);
      totalUpdated += updated;

    } catch (e) {
      console.error(`  ${collectionName}: ERROR - ${e.message}`);
    }
  }

  console.log();
  console.log('='.repeat(60));
  if (args.includes('--dry-run')) {
    console.log(`DRY RUN: Would update ${totalUpdated} documents total`);
    console.log('Run without --dry-run to execute.');
  } else {
    console.log(`Updated ${totalUpdated} documents total`);
    console.log(`All cooperative_id fields updated to: ${shortName}`);
    console.log(`Cooperatives document ID changed from: ${coopId} -> ${shortName}`);
  }
  console.log('='.repeat(60));
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});