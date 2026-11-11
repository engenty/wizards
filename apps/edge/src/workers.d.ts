/**
 * The few Workers runtime types this app uses, as workerd gives them (a Durable Object's state and
 * storage, a namespace of objects). Written here instead of `@cloudflare/workers-types`, whose
 * globals would clash with the DOM's that the engine is typed against.
 */

interface DurableObjectListOptions {
  start?: string;
  prefix?: string;
  limit?: number;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  list<T = unknown>(options?: DurableObjectListOptions): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface DurableObjectState {
  readonly storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface AlarmInvocationInfo {
  retryCount: number;
  isRetry: boolean;
}

/** QuickJS's WebAssembly, which workerd imports as a compiled module. */
declare module "@jitl/quickjs-wasmfile-release-sync/wasm" {
  const module: WebAssembly.Module;
  export default module;
}
