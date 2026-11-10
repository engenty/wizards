const ID_ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/** A short random id, as a turn's. */
export function randomId(size = 12): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(size))) {
    id += ID_ALPHABET[byte & 63];
  }
  return id;
}
