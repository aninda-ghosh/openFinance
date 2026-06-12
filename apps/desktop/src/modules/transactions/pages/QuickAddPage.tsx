import { Coins } from "lucide-react";
import { useNavigate } from "react-router-dom";
import TransactionForm from "@/components/TransactionForm";

export default function QuickAddPage() {
  const navigate = useNavigate();

  return (
    <div className="w-full flex flex-col h-full bg-background relative overflow-hidden">
      <div className="border-b border-border bg-muted/5 flex-shrink-0">
        <div className="max-w-md mx-auto w-full flex items-center justify-center py-3">
          <div className="flex items-center gap-1.5">
            <Coins className="w-4 h-4 text-primary animate-pulse" />
            <h2 className="text-base font-semibold tracking-tight">
              Add Transaction
            </h2>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 max-w-md mx-auto w-full">
        <TransactionForm mode="create" onSuccess={() => navigate(-1)} />
      </div>
    </div>
  );
}
