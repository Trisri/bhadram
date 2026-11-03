// Keeps the encrypted vault in IndexedDB on this device.

const DB_NAME = 'bhadram';
const STORE = 'kv';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, action) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const loadVault = () => run('readonly', (s) => s.get('vault'));
export const saveVault = (envelope) => run('readwrite', (s) => s.put(envelope, 'vault'));
export const deleteVault = () => run('readwrite', (s) => s.delete('vault'));
