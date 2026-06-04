// In Docker: VITE_API_URL="" so requests go to same-origin and Nginx proxies /api → server.
// In Tauri dev: VITE_API_URL is unset so falls back to localhost:3001.
export const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

export function getToken(): string | null {
  return localStorage.getItem("finwise_token");
}

export function setToken(token: string) {
  localStorage.setItem("finwise_token", token);
}

export function clearToken() {
  localStorage.removeItem("finwise_token");
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
      throw new Error(`${err.error ?? "Request failed"} — ${fields}`);
    }
    throw new Error(err.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}
