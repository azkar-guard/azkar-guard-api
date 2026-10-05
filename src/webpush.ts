import { concat, decode, encode, utf8 } from "./base64url";

/**
 * Web Push with WebCrypto only, so it runs on Workers:
 * - payload encryption: RFC 8291 (Message Encryption for Web Push) with the aes128gcm
 *   content coding from RFC 8188, as a single record;
 * - sender authentication: VAPID, RFC 8292 (an ES256 JWT in the Authorization header).
 */

/** A browser push subscription, as PushSubscription.toJSON() returns it. */
export interface PushTarget {
  endpoint: string;
  /** User agent's P-256 public key, base64url (65 bytes uncompressed). */
  p256dh: string;
  /** User agent's auth secret, base64url (16 bytes). */
  auth: string;
}

const RECORD_SIZE = 4096;

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/** Inputs that are random in production; fixed only by tests reproducing the RFC 8291 example. */
export interface EncryptOptions {
  asKeyPair?: CryptoKeyPair;
  salt?: Uint8Array;
}

/** Encrypt a push message body for one subscription (RFC 8291 §3.4, RFC 8188 §2). */
export async function encrypt(plaintext: Uint8Array, target: Pick<PushTarget, "p256dh" | "auth">, options: EncryptOptions = {}): Promise<Uint8Array> {
  const uaPublic = decode(target.p256dh);
  const authSecret = decode(target.auth);
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const asKeys =
    options.asKeyPair ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", asKeys.publicKey)) as ArrayBuffer);

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // The Web Crypto field is "public"; workers-types spells it "$public" because of how
  // workerd declares it, so the standard spelling needs a cast.
  const ecdhParams = { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams, asKeys.privateKey, 256));

  const keyInfo = concat(utf8("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  // One record: the plaintext followed by the last-record padding delimiter (0x02).
  const record = concat(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));

  // Header: salt (16) | record size (uint32 BE) | key id length (1) | key id = sender public key.
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

/** The server's VAPID identity: an ECDSA P-256 key pair. */
export interface Vapid {
  privateKey: CryptoKey;
  /** Uncompressed public key, base64url: the browser's applicationServerKey. */
  publicKey: string;
  /** Contact for push services: a mailto: or https: URL. */
  subject: string;
}

/** Load the VAPID key from a PKCS#8 PEM (what Terraform's tls_private_key emits). */
export async function loadVapid(pkcs8Pem: string, subject: string): Promise<Vapid> {
  const der = decode(
    pkcs8Pem
      .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
      .replace(/\s+/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, ""),
  );
  const privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  // The public point is part of the private JWK.
  const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
  const publicKey = encode(concat(new Uint8Array([4]), decode(jwk.x!), decode(jwk.y!)));
  return { privateKey, publicKey, subject };
}

/** VAPID JWT for one push service origin (RFC 8292 §2), valid for 12 hours. */
export async function vapidToken(vapid: Vapid, audience: string, now = Date.now()): Promise<string> {
  const header = encode(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = encode(utf8(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject })));
  const signingInput = `${header}.${claims}`;
  // WebCrypto returns the raw r||s signature JWS expects.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapid.privateKey, utf8(signingInput));
  return `${signingInput}.${encode(new Uint8Array(signature))}`;
}

export interface SendOptions {
  /** Seconds the push service keeps an undelivered message. */
  ttl: number;
  /** Replaces an undelivered message with the same topic (base64url alphabet, ≤ 32 chars). */
  topic?: string;
}

/**
 * Send one encrypted message. Returns the push service's HTTP status:
 * 201 delivered to the service, 404/410 subscription gone, 429/5xx try later.
 */
export async function send(target: PushTarget, payload: unknown, vapid: Vapid, token: string, options: SendOptions): Promise<number> {
  const body = await encrypt(utf8(JSON.stringify(payload)), target);
  const headers: Record<string, string> = {
    Authorization: `vapid t=${token}, k=${vapid.publicKey}`,
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(options.ttl),
    Urgency: "normal",
  };
  if (options.topic) headers.Topic = options.topic;
  const response = await fetch(target.endpoint, { method: "POST", headers, body });
  return response.status;
}
