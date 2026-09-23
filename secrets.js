/**
 * At-rest encryption for stored user keys (AES-256-GCM, iv:tag:data in hex).
 *
 * decrypt() returns null — never the ciphertext — when a stored value can't be
 * read, and logs why once per value. Before this, a failed decrypt returned
 * the stored string as-is, so the ciphertext was sent upstream as an API key
 * and the user saw unexplained 401s. Callers already treat null as "no key".
 *
 * Side-effect free so tests can import it.
 * Shared byte-for-byte between TeleCentaur and DiscoCentaur.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ENCRYPTED_RE = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]*$/i;

/** True for values written by encrypt(); plaintext keys never match. */
export function looksEncrypted(stored) {
  return typeof stored === 'string' && ENCRYPTED_RE.test(stored);
}

/**
 * @param {string|undefined} masterKeyHex  MASTER_ENCRYPTION_KEY (64 hex chars) or empty
 */
export function createSecretBox(masterKeyHex, { logger = console } = {}) {
  const key = masterKeyHex ? Buffer.from(masterKeyHex, 'hex') : null;
  if (key && key.length !== 32) {
    throw new Error(`MASTER_ENCRYPTION_KEY must be 64 hex characters (32 bytes); got ${key.length} bytes`);
  }
  const warned = new Set();
  const warnOnce = (stored, why) => {
    const id = String(stored).slice(0, 8);
    if (warned.has(id)) return;
    warned.add(id);
    logger.error(`[keys] ⚠️  a stored key (${id}…) could not be read: ${why}. Treating it as missing — the user must link it again.`);
  };

  return {
    enabled: !!key,

    encrypt(plaintext) {
      if (!key) return plaintext;
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('hex')}`;
    },

    /** @returns {string|null} */
    decrypt(stored) {
      if (stored == null || stored === '') return null;
      if (!looksEncrypted(stored)) return stored; // stored before encryption was enabled
      if (!key) {
        warnOnce(stored, 'it is encrypted but MASTER_ENCRYPTION_KEY is not set');
        return null;
      }
      try {
        const [ivHex, tagHex, dataHex] = stored.split(':');
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        return decipher.update(Buffer.from(dataHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
      } catch (err) {
        warnOnce(stored, `decryption failed (${err?.code ?? err?.message ?? 'unknown'}) — was MASTER_ENCRYPTION_KEY changed?`);
        return null;
      }
    },
  };
}
