// Vault rules with no browser or screen code, so they can be tested directly.

export const CATEGORIES = ['Login', 'Banking', 'Email', 'Social', 'Government', 'Work', 'Other'];
export const MIN_MASTER_LENGTH = 10;

const COMMON_WORDS = new Set([
  'password', 'passw', 'admin', 'welcome', 'qwerty', 'qwertyuiop', 'asdfgh', 'letmein',
  'iloveyou', 'monkey', 'dragon', 'football', 'india', 'bharat', 'abc', 'abcd', 'abcdef',
]);

export function emptyVault() {
  return { entries: [], tombstones: {}, settings: { autoLockMinutes: 3, lastBackupAt: 0 } };
}

export function makeEntry(fields, now = Date.now()) {
  return {
    id: crypto.randomUUID(),
    title: '',
    username: '',
    password: '',
    url: '',
    notes: '',
    category: 'Login',
    favorite: false,
    createdAt: now,
    ...fields,
    updatedAt: now,
  };
}

export function updateEntry(vault, id, fields, now = Date.now()) {
  return {
    ...vault,
    entries: vault.entries.map((e) => (e.id === id ? { ...e, ...fields, updatedAt: now } : e)),
  };
}

export function removeEntry(vault, id, now = Date.now()) {
  return {
    ...vault,
    entries: vault.entries.filter((e) => e.id !== id),
    tombstones: { ...vault.tombstones, [id]: now },
  };
}

// Combines two copies of a vault, such as phone and PC. For each password the
// most recent change wins, and a deletion counts as a change. Settings stay local.
export function mergeVaults(local, incoming) {
  const tombstones = { ...local.tombstones };
  for (const [id, at] of Object.entries(incoming.tombstones)) {
    tombstones[id] = Math.max(tombstones[id] ?? 0, at);
  }

  const localById = new Map(local.entries.map((e) => [e.id, e]));
  const merged = new Map(localById);
  let added = 0;
  let updated = 0;
  for (const entry of incoming.entries) {
    const mine = localById.get(entry.id);
    if (!mine) {
      merged.set(entry.id, entry);
      added += 1;
    } else if (entry.updatedAt > mine.updatedAt) {
      merged.set(entry.id, entry);
      updated += 1;
    }
  }

  let removed = 0;
  for (const [id, entry] of merged) {
    if ((tombstones[id] ?? -1) >= entry.updatedAt) {
      merged.delete(id);
      if (localById.has(id)) removed += 1;
      else added -= 1;
    } else {
      delete tombstones[id]; // The password was edited after the deletion.
    }
  }

  return {
    vault: { ...local, entries: [...merged.values()], tombstones },
    added,
    updated,
    removed,
  };
}

// Checks decrypted data before trusting it, and fills in anything missing.
export function normalizeVault(data) {
  if (!data || !Array.isArray(data.entries)) throw new Error('Vault data is not valid');
  const base = emptyVault();
  const text = (value) => (typeof value === 'string' ? value : '');
  const entries = data.entries.map((e) => {
    if (typeof e?.id !== 'string' || !e.id) throw new Error('Vault data is not valid');
    return {
      id: e.id,
      title: text(e.title),
      username: text(e.username),
      password: text(e.password),
      url: text(e.url),
      notes: text(e.notes),
      category: CATEGORIES.includes(e.category) ? e.category : 'Other',
      favorite: e.favorite === true,
      createdAt: Number(e.createdAt) || 0,
      updatedAt: Number(e.updatedAt) || 0,
    };
  });
  const tombstones = {};
  for (const [id, at] of Object.entries(data.tombstones ?? {})) {
    if (Number.isFinite(at)) tombstones[id] = at;
  }
  return { entries, tombstones, settings: { ...base.settings, ...data.settings } };
}

export function filterEntries(entries, query = '', category = 'All') {
  const needle = query.trim().toLowerCase();
  return entries
    .filter((e) => category === 'All' || e.category === category)
    .filter((e) => !needle
      || [e.title, e.username, e.url, e.notes].some((f) => f.toLowerCase().includes(needle)))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite)
      || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

const SETS = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!@#$%^&*-_=+?',
};

// Rejection sampling keeps every character equally likely.
function randomIndex(limit) {
  const ceiling = Math.floor(0x100000000 / limit) * limit;
  const buffer = new Uint32Array(1);
  do crypto.getRandomValues(buffer); while (buffer[0] >= ceiling);
  return buffer[0] % limit;
}

export function generatePassword({
  length = 20, upper = true, digits = true, symbols = true,
} = {}) {
  const sets = [SETS.lower];
  if (upper) sets.push(SETS.upper);
  if (digits) sets.push(SETS.digits);
  if (symbols) sets.push(SETS.symbols);
  const pool = sets.join('');
  for (;;) {
    let password = '';
    for (let i = 0; i < length; i += 1) password += pool[randomIndex(pool.length)];
    if (sets.every((set) => [...set].some((c) => password.includes(c)))) return password;
  }
}

function hasRun(password) {
  let run = 1;
  for (let i = 1; i < password.length; i += 1) {
    const step = password.charCodeAt(i) - password.charCodeAt(i - 1);
    run = Math.abs(step) <= 1 ? run + 1 : 1;
    if (run >= 4) return true;
  }
  return false;
}

export function estimateStrength(password) {
  if (!password) return { score: 0, label: '', bits: 0 };
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 33;
  const usefulLength = Math.min(password.length, new Set(password).size * 2);
  let bits = usefulLength * Math.log2(pool);
  if (hasRun(password)) bits *= 0.7;
  const letters = password.toLowerCase().replace(/[^a-z]/g, '');
  if (COMMON_WORDS.has(letters)) bits = Math.min(bits, 20);

  if (bits < 45) return { score: 1, label: 'Weak', bits };
  if (bits < 65) return { score: 2, label: 'Fair', bits };
  if (bits < 90) return { score: 3, label: 'Strong', bits };
  return { score: 4, label: 'Very strong', bits };
}

export function isAcceptableMaster(password) {
  return password.length >= MIN_MASTER_LENGTH && estimateStrength(password).score >= 2;
}

// Returns a link that is safe to open, or null. Only web addresses are allowed.
export function safeWebUrl(value) {
  const text = value.trim();
  if (!text) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text);
  try {
    const url = new URL(hasScheme ? text : `https://${text}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}
