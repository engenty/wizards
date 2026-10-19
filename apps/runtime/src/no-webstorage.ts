// Node 25 and later define `localStorage` and warn once when code reads it without
// `--localstorage-file`. A module bundled in @turbodocx/html-to-docx reads it when it loads, so
// every start printed that warning. The runtime keeps nothing in browser storage: the global goes,
// as it is on Node 24. Imported first by index.ts, before anything that could read it.
delete (globalThis as { localStorage?: unknown }).localStorage;
