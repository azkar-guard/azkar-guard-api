import { describe, expect, it } from "vitest";
import { concat, decode, encode } from "./base64url";
import { encrypt, loadVapid, vapidToken } from "./webpush";

// RFC 8291 §5 and Appendix A: the example message and its intermediate values.
const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  header:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};

async function rfcSenderKeys(): Promise<CryptoKeyPair> {
  const pub = decode(RFC.asPublic);
  const jwk = { kty: "EC", crv: "P-256", x: encode(pub.slice(1, 33)), y: encode(pub.slice(33, 65)) };
  const privateKey = await crypto.subtle.importKey("jwk", { ...jwk, d: RFC.asPrivate }, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, []);
  return { privateKey, publicKey };
}

describe("Web Push encryption (RFC 8291)", () => {
  it("reproduces the RFC 8291 example byte for byte", async () => {
    const body = await encrypt(decode(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, {
      asKeyPair: await rfcSenderKeys(),
      salt: decode(RFC.salt),
    });
    expect(encode(body)).toBe(encode(concat(decode(RFC.header), decode(RFC.ciphertext))));
  });

  it("uses a fresh salt and sender key for every message", async () => {
    const target = { p256dh: RFC.uaPublic, auth: RFC.auth };
    const a = await encrypt(decode(RFC.plaintext), target);
    const b = await encrypt(decode(RFC.plaintext), target);
    expect(encode(a.slice(0, 16))).not.toBe(encode(b.slice(0, 16)));
    expect(encode(a.slice(21, 86))).not.toBe(encode(b.slice(21, 86)));
  });
});

describe("VAPID (RFC 8292)", () => {
  async function pkcs8Pem(): Promise<string> {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
    const b64 = btoa(String.fromCharCode(...der));
    return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  }

  it("loads a PKCS#8 PEM and derives the 65-byte public key", async () => {
    const vapid = await loadVapid(await pkcs8Pem(), "mailto:test@example.com");
    const raw = decode(vapid.publicKey);
    expect(raw).toHaveLength(65);
    expect(raw[0]).toBe(4);
  });

  it("signs a JWT the public key verifies", async () => {
    const vapid = await loadVapid(await pkcs8Pem(), "https://example.com");
    const token = await vapidToken(vapid, "https://fcm.googleapis.com", Date.parse("2026-10-05T00:00:00Z"));
    const [header, claims, signature] = token.split(".") as [string, string, string];

    expect(JSON.parse(new TextDecoder().decode(decode(header)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(new TextDecoder().decode(decode(claims)))).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: Date.parse("2026-10-05T12:00:00Z") / 1000,
      sub: "https://example.com",
    });

    const publicKey = await crypto.subtle.importKey("raw", decode(vapid.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      decode(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(ok).toBe(true);
  });
});
