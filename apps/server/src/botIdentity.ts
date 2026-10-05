import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Bot signing identities, encrypted at rest.
 *
 * A bot needs a persistent ed25519 identity or its hand history, agent grant
 * and ledger entries would no longer verify. The 32-byte seed is wrapped with
 * AES-256-GCM under BOT_IDENTITY_KEY; only the ciphertext, nonce and auth tag
 * are stored. If the key is missing or wrong we fail closed: we never mint a
 * replacement identity, because that would silently invalidate the bot's past.
 */

const ALGO = 'aes-256-gcm';
const SEED_BYTES = 32;

export class BotIdentityError extends Error {}

function identityKey(): Buffer {
  const raw = process.env.BOT_IDENTITY_KEY;
  if (!raw) throw new BotIdentityError('BOT_IDENTITY_KEY is not configured');
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
  else key = Buffer.from(raw, 'base64');
  if (key.length !== SEED_BYTES)
    throw new BotIdentityError('BOT_IDENTITY_KEY must be 32 bytes (64 hex chars or base64)');
  return key;
}

/** True when a usable key is configured. Never throws. */
export function identityKeyConfigured(): boolean {
  try {
    identityKey();
    return true;
  } catch {
    return false;
  }
}

export interface EncryptedSeed {
  ct: string;
  nonce: string;
  tag: string;
}

/** Wrap a 32-byte seed (hex) for storage. Throws BotIdentityError if no key. */
export function encryptBotSeed(seedHex: string): EncryptedSeed {
  const key = identityKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(seedHex, 'hex')), cipher.final()]);
  return { ct: ct.toString('hex'), nonce: nonce.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}

/**
 * Unwrap a stored seed. Throws BotIdentityError when the key is missing or the
 * ciphertext fails authentication, so a caller can mark the bot unrecoverable
 * rather than proceed with the wrong identity.
 */
export function decryptBotSeed(enc: EncryptedSeed): string {
  const key = identityKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(enc.nonce, 'hex'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
  const seed = Buffer.concat([decipher.update(Buffer.from(enc.ct, 'hex')), decipher.final()]);
  return seed.toString('hex');
}
