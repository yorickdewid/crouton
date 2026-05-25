/**
 * 26-character ULIDs in Crockford base32. Layout:
 *
 *     0         1         2
 *     0123456789012345678901234567
 *     │   timestamp   │ randomness │
 *           10 chars      16 chars
 *
 * The timestamp encodes Unix-ms in the leading 10 chars, so two ULIDs
 * generated in the same millisecond sort by their random tail — and two
 * ULIDs from different milliseconds sort by creation order. This gives
 * directory listings (`ls <vmDir>`) a stable, time-ordered shape for free.
 *
 * Alphabet excludes `I L O U` to avoid confusion with `1 0` and profanity.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Returns a fresh 26-char ULID.
 *
 * @param now - Unix-ms timestamp to embed. Defaults to `Date.now()`; pass
 *   a fixed value in tests for deterministic output.
 */
export function ulid(now: number = Date.now()): string {
  const out = new Array<string>(26);

  // Timestamp: 48 bits → 10 base32 chars (50 bits, top 2 unused).
  let ts = now;
  for (let i = 9; i >= 0; i--) {
    out[i] = ALPHABET[ts % 32];
    ts = Math.floor(ts / 32);
  }

  // Randomness: 80 bits from CSPRNG → 16 base32 chars.
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);

  let buf = 0;
  let bits = 0;
  let idx = 10;
  for (const byte of rand) {
    buf = (buf << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out[idx++] = ALPHABET[(buf >>> bits) & 31];
    }
  }
  return out.join("");
}

/** True if `s` is shaped like a ULID (26 chars in our alphabet). */
export function isUlid(s: string): boolean {
  if (s.length !== 26) return false;
  for (let i = 0; i < 26; i++) {
    if (ALPHABET.indexOf(s[i]) < 0) return false;
  }
  return true;
}
