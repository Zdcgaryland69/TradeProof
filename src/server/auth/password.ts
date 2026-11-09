// Password hashing with Node's built-in scrypt (node:crypto; RFC 7914). No custom algorithm.
// Stored form: scrypt$<N>$<r>$<p>$<salt b64url>$<key b64url>. Verification re-derives with the stored parameters and
// compares in constant time.

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

const N = 1 << 15;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const MAXMEM = 128 * N * R * 2; // 64 MiB: scrypt needs ~128·N·r bytes
export const MIN_PASSWORD_LENGTH = 12;

function derive(password: string, salt: Buffer, opts: ScryptOptions, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password.normalize("NFC"), salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) throw new Error(`password must have at least ${MIN_PASSWORD_LENGTH} characters`);
  const salt = randomBytes(16);
  const key = await derive(password, salt, { N, r: R, p: P, maxmem: MAXMEM }, KEY_LEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0) || expected.length === 0) return false;
  const key = await derive(typeof password === "string" ? password : "", salt, { N: n, r, p, maxmem: 128 * n * r * 2 }, expected.length);
  return timingSafeEqual(key, expected);
}

/** A hash of a random password, used to spend the same work on unknown usernames. */
let dummy: Promise<string> | null = null;
export const dummyHash = () => (dummy ??= hashPassword(randomBytes(24).toString("base64url")));
