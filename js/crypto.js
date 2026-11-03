// Encryption for the vault. Uses only the browser's built-in Web Crypto.
// PBKDF2-SHA256 turns the master password into an AES-256-GCM key.
// The key is non-extractable and the master password is never stored.

export const FORMAT = 'bhadram-vault';
export const VERSION = 1;
export const KDF_ITERATIONS = 600000;
const MIN_ITERATIONS = 100000; // Refuse files weakened by tampering.
const MAX_ITERATIONS = 10000000; // Refuse files built to hang the app.

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong password or damaged data');
    this.name = 'WrongPasswordError';
  }
}

export class InvalidFileError extends Error {
  constructor() {
    super('Not a Bhadram vault');
    this.name = 'InvalidFileError';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function deriveKey(password, salt, iterations) {
  // NFKC so the same password types identically on iPhone and Windows keyboards.
  const material = await crypto.subtle.importKey(
    'raw', encoder.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// The header is authenticated, so changing it makes decryption fail.
function additionalData(header) {
  return encoder.encode(JSON.stringify([header.format, header.version, header.kdf]));
}

export function isEnvelope(value) {
  return Boolean(value)
    && value.format === FORMAT
    && value.version === VERSION
    && value.kdf?.name === 'PBKDF2-SHA256'
    && Number.isInteger(value.kdf.iterations)
    && value.kdf.iterations >= MIN_ITERATIONS
    && value.kdf.iterations <= MAX_ITERATIONS
    && typeof value.kdf.salt === 'string'
    && typeof value.iv === 'string'
    && typeof value.ct === 'string';
}

export async function seal(session, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(session.header) },
    session.key,
    encoder.encode(JSON.stringify(data)),
  );
  return { ...session.header, iv: toBase64(iv), ct: toBase64(new Uint8Array(ciphertext)) };
}

export async function createEnvelope(password, data, iterations = KDF_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const header = {
    format: FORMAT,
    version: VERSION,
    kdf: { name: 'PBKDF2-SHA256', iterations, salt: toBase64(salt) },
  };
  const session = { key: await deriveKey(password, salt, iterations), header };
  return { session, envelope: await seal(session, data) };
}

export async function openEnvelope(password, envelope) {
  if (!isEnvelope(envelope)) throw new InvalidFileError();
  const { format, version, kdf } = envelope;
  const header = { format, version, kdf };
  let iv;
  let ciphertext;
  let salt;
  try {
    iv = fromBase64(envelope.iv);
    ciphertext = fromBase64(envelope.ct);
    salt = fromBase64(kdf.salt);
  } catch {
    throw new InvalidFileError();
  }
  const key = await deriveKey(password, salt, kdf.iterations);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(header) }, key, ciphertext,
    );
    return { data: JSON.parse(decoder.decode(plain)), session: { key, header } };
  } catch {
    throw new WrongPasswordError();
  }
}
