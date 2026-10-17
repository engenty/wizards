import { lang, t } from "./i18n.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: any,
  ) {
    super(message);
  }
}

/** The request never reached the server: no network, a tunnel, a phone switching cells. */
export function isOffline(err: unknown): boolean {
  return err instanceof ApiError && err.status === 0;
}

/** A body as JSON; one that is not (a proxy's error page) as `{ error: <the text> }`. */
export function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
  upload<T>(path: string, file: File): Promise<T>;
}

/**
 * JSON calls with the host's credentials; a refused call throws an `ApiError` with the server's
 * `error` and its body (`fields`, `issues`, a `code`).
 */
export function createApi(
  withBase: (path: string) => string,
  headers: Record<string, string> = {},
  /** Told of every answer of 500 and above, e.g. to send it to the host's log. */
  onServerError?: (line: string) => void,
): Api {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(withBase(path), {
      method,
      credentials: "include",
      headers: {
        // The server answers in the language the person picked, not the browser's.
        "accept-language": lang,
        ...headers,
        ...(body !== undefined && !(body instanceof FormData)
          ? { "content-type": "application/json" }
          : {}),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    }).catch(() => {
      throw new ApiError(t("common.offline"), 0, null);
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) {
      if (res.status >= 500) {
        onServerError?.(`${method} ${path} answered ${res.status}: ${data?.error ?? ""}`);
      }
      // WordPress answers `{ code, message }`; a runtime `{ error, code }`.
      throw new ApiError(data?.error ?? data?.message ?? res.statusText, res.status, data);
    }
    return data as T;
  }
  return {
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
    put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
    patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
    del: <T>(path: string) => request<T>("DELETE", path),
    upload: <T>(path: string, file: File) => {
      const form = new FormData();
      form.set("file", file);
      return request<T>("POST", path, form);
    },
  };
}
