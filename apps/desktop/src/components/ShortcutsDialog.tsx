import { Fragment } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SHORTCUT_GROUPS } from "@/lib/shortcuts";
import { useAppStore } from "@/stores/app.store";

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] h-6 items-center justify-center rounded-md border border-border bg-muted/50 px-1.5 font-mono text-[11px] font-semibold text-foreground shadow-[0_1px_0_0] shadow-border">
      {children}
    </kbd>
  );
}

export function ShortcutsDialog() {
  const { shortcutsOpen, setShortcutsOpen } = useAppStore();

  return (
    <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Single-key shortcuts are paused while you type in a field.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} className="flex flex-col gap-1.5">
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                {group.title}
              </h3>
              {group.items.map((item) => (
                <div
                  key={item.label}
                  className="flex items-center justify-between gap-3 py-1 text-sm"
                >
                  <span>{item.label}</span>
                  <span className="flex flex-shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    {item.keys.map((combo, i) => (
                      <Fragment key={combo.join("+")}>
                        {i > 0 && <span className="px-0.5">or</span>}
                        {combo.map((k) => (
                          <Kbd key={k}>{k}</Kbd>
                        ))}
                      </Fragment>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
