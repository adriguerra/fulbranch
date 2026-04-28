import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  verifyGitHubSignature,
  verifyLinearSignature,
} from "../../src/server/middleware/signature";

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("signature verification", () => {
  describe("verifyLinearSignature", () => {
    test("accepts a valid signature", () => {
      const body = `{"action":"update","type":"Issue"}`;
      const secret = "s3cret";
      const header = sign(secret, body);
      expect(verifyLinearSignature(secret, body, header)).toBe(true);
    });

    test("rejects a tampered body", () => {
      const body = `{"action":"update","type":"Issue"}`;
      const secret = "s3cret";
      const header = sign(secret, body);
      expect(verifyLinearSignature(secret, body + "x", header)).toBe(false);
    });

    test("rejects a missing header", () => {
      expect(verifyLinearSignature("s3cret", "body", null)).toBe(false);
    });

    test("rejects a wrong secret", () => {
      const body = `{}`;
      const header = sign("right", body);
      expect(verifyLinearSignature("wrong", body, header)).toBe(false);
    });
  });

  describe("verifyGitHubSignature", () => {
    test("accepts a valid sha256=<hex> header", () => {
      const body = `{"action":"closed"}`;
      const secret = "ghsec";
      const header = `sha256=${sign(secret, body)}`;
      expect(verifyGitHubSignature(secret, body, header)).toBe(true);
    });

    test("rejects header missing the sha256= prefix", () => {
      const body = `{}`;
      const secret = "ghsec";
      const header = sign(secret, body); // no prefix
      expect(verifyGitHubSignature(secret, body, header)).toBe(false);
    });

    test("rejects a missing header", () => {
      expect(verifyGitHubSignature("x", "y", null)).toBe(false);
    });
  });
});
