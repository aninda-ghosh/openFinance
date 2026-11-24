// In Docker: VITE_API_URL="" so requests go to same-origin and Nginx proxies /api → server.
// In Tauri dev: VITE_API_URL is unset so falls back to 127.0.0.1:3001. An IP
// rather than "localhost", because the desktop server listens on IPv4 only.
export const BASE_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3001";

export function getToken(): string | null {
  return localStorage.getItem("openfinance_token");
}

export function setToken(token: string) {
  localStorage.setItem("openfinance_token", token);
}

export function clearToken() {
  localStorage.removeItem("openfinance_token");
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    if (res.status === 401) {
      clearToken();
      window.location.reload();
    }
    const err = await res.json().catch(() => ({ error: "Unknown error" }));
    if (err.details?.issues?.length) {
      const fields = err.details.issues
        .map((i: any) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw Object.assign(
        new Error(`${err.error ?? "Request failed"} — ${fields}`),
        { status: res.status, body: err }
      );
    }
    // The parsed body rides along for callers that need more than the
    // message (e.g. bulk add's per-row errors).
    throw Object.assign(
      new Error(err.error ?? `Request failed: ${res.status}`),
      {
        status: res.status,
        body: err,
      }
    );
  }
  return res.json() as Promise<T>;
}
