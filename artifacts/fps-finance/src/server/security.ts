/**
 * security.ts — Finance cryptographic utilities.
 *
 * Exports:
 *   encryptTotpSecret / decryptTotpSecret  — AES-256-GCM envelope for TOTP secrets
 *   generateTotp                            — RFC 6238 / RFC 4226 TOTP code (SHA-1, 6-digit, 30 s)
 *   validateTotp                            — constant-time validation with ±1 window; returns matched counter or null
 *   generateInvitationToken                 — 32-byte URL-safe cryptographically random token
 *   hashToken                               — SHA-256 hex digest (for invitation tokens & recovery codes)
 *   hashPassword                            — (re-exported bcryptjs hash with cost 12)  — NOT in this file; caller uses bcryptjs directly
 *   validatePasswordStrength                — explicit policy check, returns array of violation messages
 *   generateRecoveryCodes                   — 8 × 10-character base32 recovery codes
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm" as const;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

const TOTP_DIGITS = 6;
const TOTP_STEP_SECONDS = 30;
const TOTP_WINDOW = 1; // accept ±1 step

// Base32 alphabet (RFC 4648)
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE32_LOOKUP = new Uint8Array(256).fill(0xff);
for (let i = 0; i < BASE32_CHARS.length; i++) {
  BASE32_LOOKUP[BASE32_CHARS.charCodeAt(i)] = i;
  // Also accept lowercase
  BASE32_LOOKUP[BASE32_CHARS.toLowerCase().charCodeAt(i)] = i;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`AES-256-GCM key must be exactly ${KEY_BYTES} bytes; received ${key.length}.`);
  }
}

function base32Decode(input: string): Buffer {
  // Strip padding and whitespace
  const cleaned = input.replace(/[\s=]/g, "").toUpperCase();
  const outputLength = Math.floor((cleaned.length * 5) / 8);
  const output = Buffer.alloc(outputLength);
  let buffer = 0;
  let bitsLeft = 0;
  let outputIndex = 0;

  for (let i = 0; i < cleaned.length; i++) {
    const val = BASE32_LOOKUP[cleaned.charCodeAt(i)];
    if (val === 0xff) {
      throw new Error(`Invalid base32 character at position ${i}: ${cleaned[i]}`);
    }
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      output[outputIndex++] = (buffer >> bitsLeft) & 0xff;
    }
  }

  return output;
}

function base32Encode(input: Buffer): string {
  let output = "";
  let buffer = 0;
  let bitsLeft = 0;

  for (let i = 0; i < input.length; i++) {
    buffer = (buffer << 8) | input[i];
    bitsLeft += 8;
    while (bitsLeft >= 5) {
      bitsLeft -= 5;
      output += BASE32_CHARS[(buffer >> bitsLeft) & 0x1f];
    }
  }
  if (bitsLeft > 0) {
    output += BASE32_CHARS[(buffer << (5 - bitsLeft)) & 0x1f];
  }
  return output;
}

/**
 * RFC 4226 HOTP: HMAC-SHA1 of (key || counter), dynamic truncation, 6-digit code.
 */
function hotp(keyBuffer: Buffer, counter: bigint): string {
  const counterBuffer = Buffer.alloc(8);
  // Write counter as big-endian 64-bit unsigned integer
  let remaining = counter;
  for (let i = 7; i >= 0; i--) {
    counterBuffer[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  const mac = createHmac("sha1", keyBuffer).update(counterBuffer).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const truncated =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(truncated % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function currentCounter(atMs?: number): bigint {
  const epochSeconds = Math.floor((atMs ?? Date.now()) / 1000);
  return BigInt(Math.floor(epochSeconds / TOTP_STEP_SECONDS));
}

// ---------------------------------------------------------------------------
// AES-256-GCM encryption for TOTP secrets
// ---------------------------------------------------------------------------

/**
 * Encrypts a TOTP secret string using AES-256-GCM.
 *
 * @param secret  Plain-text TOTP secret (e.g. a base32 string).
 * @param key     32-byte encryption key derived from env.
 * @returns       Hex-encoded `iv:ciphertext:tag` envelope.
 */
export function encryptTotpSecret(secret: string, key: Buffer): string {
  assertKeyLength(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${encrypted.toString("hex")}:${tag.toString("hex")}`;
}

/**
 * Decrypts an AES-256-GCM envelope produced by `encryptTotpSecret`.
 *
 * @param envelope  Hex-encoded `iv:ciphertext:tag` string.
 * @param key       32-byte encryption key.
 * @returns         Plain-text TOTP secret.
 * @throws          If the envelope is malformed or authentication fails.
 */
export function decryptTotpSecret(envelope: string, key: Buffer): string {
  assertKeyLength(key);
  const parts = envelope.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid TOTP secret envelope: expected iv:ciphertext:tag.");
  }
  const [ivHex, ciphertextHex, tagHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const tag = Buffer.from(tagHex, "hex");

  if (iv.length !== IV_BYTES) {
    throw new Error(`Invalid TOTP secret envelope: IV must be ${IV_BYTES} bytes.`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error(`Invalid TOTP secret envelope: auth tag must be ${TAG_BYTES} bytes.`);
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// TOTP generation and validation
// ---------------------------------------------------------------------------

/**
 * Generates the current TOTP code for a given base32-encoded secret.
 *
 * @param base32Secret  Base32-encoded TOTP seed (e.g. from an authenticator app).
 * @param atMs          Optional timestamp in milliseconds (defaults to `Date.now()`).
 * @returns             6-digit TOTP code string.
 */
export function generateTotp(base32Secret: string, atMs?: number): string {
  const key = base32Decode(base32Secret);
  return hotp(key, currentCounter(atMs));
}

/**
 * Validates a TOTP code against a base32-encoded secret with a ±1-step window.
 * Returns the matched TOTP counter value (for replay detection), or null if invalid.
 *
 * The caller should persist the returned counter and reject any future code with
 * the same or lower counter to prevent replay attacks.
 *
 * @param base32Secret  Base32-encoded TOTP seed.
 * @param code          6-digit code to validate.
 * @param atMs          Optional timestamp in milliseconds (defaults to `Date.now()`).
 * @returns             The matched counter as a `bigint`, or `null` if validation failed.
 */
export function validateTotp(
  base32Secret: string,
  code: string,
  atMs?: number,
): bigint | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(base32Secret);
  const center = currentCounter(atMs);
  const codeBuffer = Buffer.from(code);

  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const counter = center + BigInt(delta);
    const expected = hotp(key, counter);
    const expectedBuffer = Buffer.from(expected);
    if (
      codeBuffer.length === expectedBuffer.length &&
      timingSafeEqual(codeBuffer, expectedBuffer)
    ) {
      return counter;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Invitation tokens
// ---------------------------------------------------------------------------

/**
 * Generates a cryptographically random, URL-safe invitation token.
 * The raw 32-byte value is base64url-encoded (43 characters, no padding).
 */
export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Generates a 160-bit RFC 6238 seed suitable for authenticator applications. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

// ---------------------------------------------------------------------------
// Token / recovery-code hashing
// ---------------------------------------------------------------------------

/**
 * Hashes an invitation token or recovery code using SHA-256.
 * Returns a lowercase hex digest suitable for storage.
 *
 * Never log the input value.
 */
export function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Password strength validation
// ---------------------------------------------------------------------------

/** Minimum acceptable password length. */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Validates password strength and returns an array of human-readable violation
 * messages. An empty array means the password satisfies all requirements.
 *
 * Requirements:
 *   - At least 12 characters
 *   - At least one uppercase ASCII letter
 *   - At least one lowercase ASCII letter
 *   - At least one ASCII digit
 *   - At least one special character from the set: !@#$%^&*()_+-=[]{}|;':",.<>?/`~\
 */
export function validatePasswordStrength(password: string): string[] {
  const violations: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    violations.push(`Het wachtwoord moet minimaal ${PASSWORD_MIN_LENGTH} tekens bevatten.`);
  }
  if (!/[A-Z]/.test(password)) {
    violations.push("Het wachtwoord moet minimaal één hoofdletter bevatten.");
  }
  if (!/[a-z]/.test(password)) {
    violations.push("Het wachtwoord moet minimaal één kleine letter bevatten.");
  }
  if (!/[0-9]/.test(password)) {
    violations.push("Het wachtwoord moet minimaal één cijfer bevatten.");
  }
  if (!/[!@#$%^&*()\-_=+\[\]{}|;':",.<>?/`~\\]/.test(password)) {
    violations.push("Het wachtwoord moet minimaal één speciaal teken bevatten (bijv. !@#$%^&*).");
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Recovery code generation
// ---------------------------------------------------------------------------

const RECOVERY_CODE_COUNT = 8;
const RECOVERY_CODE_BYTES = 6; // ceil(10 × 5 / 8) — produces exactly 10 base32 chars

/**
 * Generates 8 one-time recovery codes.
 * Each code is 10 uppercase base32 characters (48-bit entropy).
 * Returns them as plain strings; the caller is responsible for hashing
 * them (using `hashToken`) before persisting.
 */
export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const raw = randomBytes(RECOVERY_CODE_BYTES);
    // base32-encode and take exactly 10 chars
    const encoded = base32Encode(raw).slice(0, 10);
    codes.push(encoded);
  }
  return codes;
}
