/**
 * HMAC signature verification helpers.
 *
 * Both Linear and GitHub sign webhook bodies with HMAC-SHA256 over the raw
 * request body. We compare using a constant-time check to avoid timing
 * side-channels.
 *
 * Linear header:  `linear-signature` (hex, no prefix)
 * GitHub header:  `x-hub-signature-256` (`sha256=` + hex)
 */

import { createHmac, timingSafeEqual } from "node:crypto";

function hmacSha256Hex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify a Linear webhook. `header` is the raw value of `linear-signature`.
 */
export function verifyLinearSignature(
  secret: string,
  rawBody: string,
  header: string | null,
): boolean {
  if (!header) return false;
  const expected = hmacSha256Hex(secret, rawBody);
  return safeEqualHex(expected, header.trim());
}

/**
 * Verify a GitHub webhook. `header` is the raw value of `x-hub-signature-256`
 * (including the `sha256=` prefix).
 */
export function verifyGitHubSignature(
  secret: string,
  rawBody: string,
  header: string | null,
): boolean {
  if (!header) return false;
  const prefix = "sha256=";
  if (!header.startsWith(prefix)) return false;
  const received = header.slice(prefix.length).trim();
  const expected = hmacSha256Hex(secret, rawBody);
  return safeEqualHex(expected, received);
}
