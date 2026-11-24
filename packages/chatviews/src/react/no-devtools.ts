// SPDX-License-Identifier: MIT

/**
 * `@openuidev/react-lang` mounts its devtools in a development build, and they load a script
 * from cdn.jsdelivr.net. Its own flag says they are mounted already; set before react-lang loads
 * (`react/chat.tsx` imports this module first), nothing is loaded from outside.
 */
(globalThis as Record<symbol, unknown>)[Symbol.for("openui.devtools.autoMount")] = true;
