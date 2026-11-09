import { describe, expect, it } from "vitest";
import { builtinConfig } from "../../src/commands/scan-zones/config.ts";
import { scanText } from "../../src/commands/scan-zones/scan.ts";
import type { Zone } from "../../src/commands/scan-zones/types.ts";

const config = builtinConfig();

function zonesOf(line: string, path = "worker.js"): Zone[] {
  return scanText(config, path, `${line}\n`).zones;
}

describe("WebCrypto", () => {
  it.each([
    "const key = await crypto.subtle.importKey('raw', raw, algo, false, ['sign']);",
    "const sig = await crypto.subtle.sign('HMAC', key, data);",
    "const ok = await crypto.subtle.verify('HMAC', key, sig, data);",
    "const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);",
    "const bits = window.crypto.subtle.deriveBits(params, key, 256);",
    "crypto.getRandomValues(new Uint8Array(32));",
    "const bytes = self.crypto.getRandomValues(buffer);",
  ])("flags %s as crypto", (line) => {
    expect(zonesOf(line)).toEqual(["crypto"]);
  });

  it("reaches TypeScript files too", () => {
    expect(zonesOf("const key = await crypto.subtle.importKey(a, b, c, d, e);", "src/sign.ts")).toEqual(["crypto"]);
  });

  it.each([
    "const subtle = 'crypto subtle docs';",
    "const randomValues = getRandomValuesFromPool();",
    "const mycrypto = { subtle: 1 };",
  ])("stays quiet on %s", (line) => {
    expect(zonesOf(line)).toEqual([]);
  });
});

describe("request signing", () => {
  it.each([
    "const algorithm = 'AWS4-HMAC-SHA256';",
    "url.searchParams.set('X-Amz-Signature', signature);",
    "url.searchParams.set('X-Amz-Credential', credential);",
    "const scope = `${date}/${region}/s3/aws4_request`;",
  ])("flags %s as crypto", (line) => {
    expect(zonesOf(line)).toContain("crypto");
  });

  it.each([
    "headers.set('Authorization', `AWS4-HMAC-SHA256 Credential=${id}`);",
    "headers.append('authorization', value);",
    "const init = { headers: { Authorization: `Bearer ${token}` } };",
    "const init = { headers: { 'Authorization': buildAuth(request) } };",
    'const init = { headers: { authorization: "Basic " + encoded } };',
  ])("flags the Authorization header built in %s as auth", (line) => {
    expect(zonesOf(line)).toContain("auth");
  });

  it.each([
    "if (provided !== expectedSignature) return false;",
    "return computedHmac === received;",
    "if (signature == computed) {",
    "const same = digest === other.digest;",
    "if (expected !== sig) throw new Error('bad');",
    "return (await sign(body)) === request.signature;",
  ])("flags the signature comparison in %s as crypto", (line) => {
    expect(zonesOf(line)).toContain("crypto");
  });

  it.each([
    "if (signature === undefined) return;",
    "if (signature !== null) {",
    "if (digest === '') return;",
    "const design = a === b;",
    "if (signal === 'abort') return;",
    "const same = assignment === other;",
    "const machine = a === b;",
    "interface Headers { authorization: string; }",
    "type Init = { authorization?: string };",
    "const value = response.headers.get('Authorization');",
    "const authorization = 'x';",
  ])("stays quiet on %s", (line) => {
    expect(zonesOf(line)).toEqual([]);
  });
});
