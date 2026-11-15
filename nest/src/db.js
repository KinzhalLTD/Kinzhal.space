// Tiny document-store interface over Firestore, so the rest of the code (and the tests) don't depend on the SDK.
//   get(path) -> object | null         set(path, data, {merge})      del(path)
//   list(collection) -> [{id, data}]   tx(async t => ...)  where t has get/set/del with the same shape
let current = null;
export const useDb = d => { current = d; return d; };
export function db() {
  if (!current) current = firestoreDb();
  return current;
}

// ---------- Firestore (firebase-admin) ----------
let adminApp = null;
export async function admin() {
  if (adminApp) return adminApp;
  const { initializeApp, getApps, cert } = await import('firebase-admin/app');
  const projectId = process.env.FIREBASE_PROJECT_ID, clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
  if (!projectId || !clientEmail || !privateKey) throw new Error('Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in Netlify environment variables');
  if (!privateKey.includes('BEGIN')) privateKey = Buffer.from(privateKey, 'base64').toString('utf8');
  privateKey = privateKey.replace(/\\n/g, '\n');
  adminApp = getApps()[0] || initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId });
  return adminApp;
}

function firestoreDb() {
  let fs = null;
  const store = async () => {
    if (fs) return fs;
    const { getFirestore } = await import('firebase-admin/firestore');
    fs = getFirestore(await admin());
    try { fs.settings({ ignoreUndefinedProperties: true }); } catch { /* already set on a warm instance */ }
    return fs;
  };
  const ref = async p => (await store()).doc(p);
  const wrap = (f, t) => ({
    get: async p => { const s = t ? await t.get(await ref(p)) : await (await ref(p)).get(); return s.exists ? s.data() : null; },
    set: async (p, d, o = {}) => { const r = await ref(p); return t ? t.set(r, d, { merge: !!o.merge }) : r.set(d, { merge: !!o.merge }); },
    del: async p => { const r = await ref(p); return t ? t.delete(r) : r.delete(); }
  });
  const base = wrap(null, null);
  return {
    kind: 'firestore',
    ...base,
    async list(col) { const s = await (await store()).collection(col).get(); return s.docs.map(d => ({ id: d.id, data: d.data() })); },
    async tx(fn) { const f = await store(); return f.runTransaction(t => fn(wrap(f, t))); }
  };
}

// ---------- In-memory (tests) ----------
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(a, b) {
  const out = { ...(isObj(a) ? a : {}) };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : clone(v);
  return out;
}
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
export function memoryDb(seed = {}) {
  const docs = new Map(Object.entries(seed).map(([k, v]) => [k, clone(v)]));
  const api = {
    kind: 'memory', docs,
    get: async p => (docs.has(p) ? clone(docs.get(p)) : null),
    set: async (p, d, o = {}) => { docs.set(p, o.merge ? deepMerge(docs.get(p), d) : clone(d)); },
    del: async p => { docs.delete(p); },
    list: async col => [...docs.entries()].filter(([k]) => k.startsWith(col + '/') && !k.slice(col.length + 1).includes('/')).map(([k, v]) => ({ id: k.slice(col.length + 1), data: clone(v) })),
    tx: async fn => fn(api)
  };
  return api;
}
