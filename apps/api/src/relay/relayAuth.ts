export async function relayToken(secret: string, key: string): Promise<string> {
  const keyMaterial = new TextEncoder().encode(secret);
  const message = new TextEncoder().encode(key);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyMaterial,
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, message);
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function timingSafeEqualHex(a: string, b: string): Promise<boolean> {
  const maxLength = Math.max(a.length, b.length);
  let mismatch = 0;
  mismatch |= a.length ^ b.length;
  for (let i = 0; i < maxLength; i += 1) {
    const aCode = i < a.length ? a.charCodeAt(i) : 0;
    const bCode = i < b.length ? b.charCodeAt(i) : 0;
    mismatch |= aCode ^ bCode;
  }

  return mismatch === 0;
}
