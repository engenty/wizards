import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { createSandbox } from "./sandbox";
import type { Sandbox } from "./types";

/** The sandbox in Node: QuickJS and its WebAssembly module, loaded on the first turn. */
export function nodeSandbox(): Sandbox {
  return createSandbox(() => newQuickJSWASMModuleFromVariant(variant));
}
