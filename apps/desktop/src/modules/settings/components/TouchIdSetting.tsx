import { Fingerprint } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  type TouchIdStatus,
  touchId,
  touchIdEnableMessage,
} from "@/lib/touchId";

function loadStatus(set: (status: TouchIdStatus | null) => void) {
  return touchId
    .status()
    .then(set)
    .catch(() => set(null));
}

/**
 * Settings → Session Security → Touch ID. Turning it on asks for the password
 * (checked against the database in Rust), then one Touch ID check. Turning it
 * off deletes the saved password from the keychain.
 */
export function TouchIdSetting() {
  const [status, setStatus] = useState<TouchIdStatus | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => loadStatus(setStatus);

  useEffect(() => {
    loadStatus(setStatus);
  }, []);

  if (!status) return null;

  const available = status.availability === "available";
  const hint =
    status.availability === "not_enrolled"
      ? "Add a fingerprint in System Settings → Touch ID & Password to use this."
      : "This Mac has no Touch ID.";

  const closeDialog = () => {
    setDialogOpen(false);
    setPassword("");
    setError("");
  };

  const turnOn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError("");
    try {
      await touchId.enableWithPassword(password);
      closeDialog();
      toast.success("Touch ID is on.");
    } catch (err) {
      const message = touchIdEnableMessage(err);
      if (err === "wrong_password") {
        setError(message ?? "");
      } else {
        closeDialog();
        if (message) toast.error(message);
      }
    } finally {
      setPassword("");
      setBusy(false);
      refresh();
    }
  };

  const turnOff = async () => {
    setBusy(true);
    try {
      await touchId.disable();
      toast.success("Touch ID is off.");
    } catch {
      toast.error("Couldn't turn off Touch ID.");
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <>
      <div
        className={`flex items-center justify-between p-3 rounded-xl bg-muted/30 border border-border/40 ${available ? "" : "opacity-70"}`}
      >
        <div className="space-y-0.5 pr-4">
          <p className="text-xs font-bold text-foreground flex items-center gap-1.5">
            <Fingerprint className="w-3.5 h-3.5" /> Unlock with Touch ID
          </p>
          <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">
            {available
              ? "Use your fingerprint instead of typing your password. The password is saved in your login keychain."
              : hint}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={status.enabled}
          aria-label="Unlock with Touch ID"
          disabled={busy || (!available && !status.enabled)}
          onClick={() => (status.enabled ? turnOff() : setDialogOpen(true))}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer ${status.enabled ? "bg-positive" : "bg-muted-foreground/30"}`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${status.enabled ? "translate-x-4.5" : "translate-x-0.5"}`}
          />
        </button>
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Fingerprint className="w-4 h-4" /> Turn on Touch ID
            </DialogTitle>
            <DialogDescription>
              Enter your password, then touch the sensor.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={turnOn} className="space-y-3">
            <Input
              type="password"
              placeholder="Password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError("");
              }}
            />
            {error && <p className="text-destructive text-xs">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeDialog}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !password}>
                {busy ? "Checking…" : "Turn on"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
