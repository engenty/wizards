# @engenty/vault

Keeps the secrets of an app: tokens, passwords, keys a person typed. MIT, no dependencies beyond
Node’s own `crypto`.

- **Sealed and bound.** `seal(ring, binding, value)` encrypts with AES-256-GCM. The binding names
  where the value belongs (an owner, a table, a row, a purpose). It is the cipher’s additional
  data, so a value copied to another row or owner doesn’t open.
- **Fails closed.** `unseal` throws a `VaultError` (`format`, `unknown-key`, `not-opened`) and
  never hands back something else. `sealKeyCheck` and `keyCheckHolds` let a store check its key
  before it reads or writes anything.
- **A new key.** A key ring holds the key that seals and the earlier ones that still open.
  `needsReseal` and `reseal` move values to the current key.
- **A key per purpose or per owner.** `deriveKey(secret, purpose)` makes one with HKDF-SHA256.
- **Keys outside the database.** `environmentKeyStore` (32 bytes as base64), `fileKeyStore` (a
  private file, refused when others may read it) and `keychainKeyStore` (macOS; the key goes to
  `security` on its standard input). `loadOrCreateKey` makes one on first use where the store
  can keep it.
- **Secrets out of text.** `redactor(secrets)` replaces each value as it is and as JSON, a URL
  and a form write it, in text (`text`) and in data (`value`).

```ts
import { deriveKey, keyRing, seal, unseal } from "@engenty/vault";

const ring = keyRing(deriveKey(process.env.STORE_KEY!, "stored-secrets"));
const binding = [teamId, "connection", connectionId];
const sealed = seal(ring, binding, token);
const again = unseal(ring, binding, sealed);
```

Sealed values look like `v2.<key id>.<nonce>.<tag>.<ciphertext>`.
