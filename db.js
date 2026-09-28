const OM_DB_NAME = 'open-motion';
const OM_DB_VERSION = 1;
const OM_STORE = 'recordings';

function omOpenDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OM_DB_NAME, OM_DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(OM_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putRecording(record) {
  const db = await omOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OM_STORE, 'readwrite');
    tx.objectStore(OM_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getRecording(id) {
  const db = await omOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OM_STORE, 'readonly');
    const req = tx.objectStore(OM_STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteRecording(id) {
  const db = await omOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OM_STORE, 'readwrite');
    tx.objectStore(OM_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function generateRecordingId() {
  return `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
