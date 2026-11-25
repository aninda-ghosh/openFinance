import { Fingerprint } from "lucide-react";
import { toast } from "sonner";
import { touchId, touchIdEnableMessage } from "@/lib/touchId";

/**
 * After a passcode unlock: "Unlock with Touch ID next time?" (Enable / Not
 * now), shown only when the Rust side says so (Touch ID available and
 * enrolled, feature off, not declined, passcode from this unlock still held
 * in Rust). Enable stores that passcode after one Touch ID check; it never
 * passes through here.
 */
export async function offerTouchId() {
  let offer = false;
  try {
    offer = (await touchId.status()).offer;
  } catch {
    return;
  }
  if (!offer) return;

  let answered = false;
  const closedWithoutAnswer = () => {
    if (answered) return;
    answered = true;
    touchId.dismiss(false).catch(() => {});
  };

  toast("Unlock with Touch ID next time?", {
    icon: <Fingerprint className="w-4 h-4" />,
    duration: 30_000,
    action: {
      label: "Enable",
      onClick: async () => {
        answered = true;
        try {
          await touchId.enable();
          toast.success("Touch ID is on.");
        } catch (err) {
          const message = touchIdEnableMessage(err);
          toast(message ?? "Touch ID is off. You can turn it on in Settings.");
        }
      },
    },
    cancel: {
      label: "Not now",
      onClick: () => {
        answered = true;
        touchId.dismiss(true).catch(() => {});
      },
    },
    onDismiss: closedWithoutAnswer,
    onAutoClose: closedWithoutAnswer,
  });
}
