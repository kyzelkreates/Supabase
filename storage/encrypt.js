/**
 * encrypt.js
 * Key storage placeholder — secure design only in RUN 0.
 * Real encryption (AES-GCM via WebCrypto) added in RUN 2.
 *
 * RULE: Keys are NEVER used directly. Always abstracted through this layer.
 */

export function encrypt(data) {
  // RUN 0: Base64 placeholder — NOT production-safe.
  // Replace with AES-GCM in RUN 2.
  return btoa(JSON.stringify(data));
}

export function decrypt(data) {
  // RUN 0: Base64 decode placeholder.
  return JSON.parse(atob(data));
}

/**
 * Future interface (RUN 2+):
 * export async function encryptSecure(data, keyMaterial) { ... }
 * export async function decryptSecure(ciphertext, keyMaterial) { ... }
 */
