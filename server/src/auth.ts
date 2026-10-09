// Server-side hashing (Web Crypto, works in Workers and in Node tests).

export async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hashWithSalt(secret: string, salt: string): Promise<string> {
  return sha256hex(salt + ":" + secret);
}

export function newSalt(): string {
  return crypto.randomUUID();
}
