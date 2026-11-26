// The backend runs inside the app and listens on 127.0.0.1:3001. An IP
// rather than "localhost", because it listens on IPv4 only.
export const BASE_URL = "http://127.0.0.1:3001";

export async function apiFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  if (!res.ok) {
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
