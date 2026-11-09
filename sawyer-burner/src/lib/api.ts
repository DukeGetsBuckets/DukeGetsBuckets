// Thin fetch wrapper. Every mutating request carries the CSRF header the Worker requires.

export class ApiError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

// Server clock offset so countdowns are right even if the device clock is off.
let clockOffset = 0;
export const serverNow = () => Date.now() + clockOffset;
function syncClock(data: unknown) {
  const t = (data as { serverNow?: number } | null)?.serverNow;
  if (typeof t === "number") clockOffset = t - Date.now();
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { "x-bb2-csrf": "1", accept: "application/json" };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: "same-origin", signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "You're offline or the server is unreachable.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized?.();
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status}).`, data?.retryAfter);
  }
  syncClock(data);
  return data as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, signal),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

/** Multipart upload with progress (fetch can't report upload progress). */
export function uploadWithProgress<T>(path: string, form: FormData, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.setRequestHeader("x-bb2-csrf", "1");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const data = xhr.response;
      if (xhr.status >= 200 && xhr.status < 300) {
        syncClock(data);
        resolve(data as T);
      } else {
        if (xhr.status === 401) onUnauthorized?.();
        reject(new ApiError(xhr.status, data?.error ?? `Upload failed (${xhr.status}).`, data?.retryAfter));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "Upload failed. Check your connection."));
    xhr.send(form);
  });
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429 && err.retryAfter) {
      const mins = Math.ceil(err.retryAfter / 60);
      return `${err.message} (try again in ${mins < 2 ? `${err.retryAfter}s` : `${mins} min`})`;
    }
    return err.message;
  }
  return "Something went wrong.";
}
