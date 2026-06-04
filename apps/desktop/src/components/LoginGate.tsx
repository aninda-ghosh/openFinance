import { useEffect, useState } from "react";
import { BASE_URL, setToken } from "@/lib/api";

interface Props {
  onUnlocked: () => void;
}

type Phase = "loading" | "setup" | "login" | "submitting";

export function LoginGate({ onUnlocked }: Props) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${BASE_URL}/api/auth/status`)
      .then((r) => r.json())
      .then((d: { needs_setup: boolean }) =>
        setPhase(d.needs_setup ? "setup" : "login")
      )
      .catch(() => setError("Could not reach the server."));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!username.trim()) return setError("Username is required.");
    if (password.length < 8)
      return setError("Password must be at least 8 characters.");
    if (phase === "setup" && password !== confirm)
      return setError("Passwords do not match.");

    setPhase("submitting");
    const endpoint =
      phase === "setup" ? "/api/auth/register" : "/api/auth/login";

    try {
      const res = await fetch(`${BASE_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPhase(phase === "submitting" ? "login" : phase);
        return setError(data.error ?? "Something went wrong.");
      }
      setToken(data.token);
      onUnlocked();
    } catch {
      setError("Could not reach the server.");
      setPhase("login");
    }
  };

  const isSetup = phase === "setup";
  const busy = phase === "submitting" || phase === "loading";

  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <div className="w-full max-w-xs space-y-6 p-8">
        <div>
          <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white font-bold text-lg mb-4">
            FW
          </div>
          <h1 className="text-xl font-semibold text-foreground">
            {isSetup ? "Create your account" : "Welcome back"}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {isSetup
              ? "Set up your username and password to protect your financial data."
              : "Sign in to access your finances."}
          </p>
        </div>

        {phase === "loading" ? (
          <div className="flex justify-center py-4">
            <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <input
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isSetup ? "new-password" : "current-password"}
              className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            {isSetup && (
              <input
                type="password"
                placeholder="Confirm password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            )}
            {error && <p className="text-destructive text-sm">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-md text-sm font-medium"
            >
              {busy ? "Please wait…" : isSetup ? "Create account" : "Sign in"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
