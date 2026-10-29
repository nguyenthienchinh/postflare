import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowUpCircle, Lock } from "lucide-react";
import { PLAN_LIMIT_EVENT, type PlanLimitError } from "../../lib/api";
import { BILLING_TAB, LIMIT_LABEL } from "../../lib/billing";
import { invalidate } from "../../lib/useFetch";
import { useSession } from "../../lib/session";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

/**
 * Hosted mode: every 402 `plan_limit` answer (api.ts `request`, uploads) opens this dialog with the server's message and
 * an "Upgrade" button for users with billing.manage. Toasts and inline form errors skip these errors (`isPlanLimit`).
 */
export function PlanLimitDialog() {
  const { can } = useSession();
  const navigate = useNavigate();
  const [err, setErr] = useState<PlanLimitError | null>(null);

  useEffect(() => {
    const on = (e: Event) => {
      setErr((e as CustomEvent<PlanLimitError>).detail);
      invalidate("billing"); // usage or state changed since the page loaded
    };
    window.addEventListener(PLAN_LIMIT_EVENT, on);
    return () => window.removeEventListener(PLAN_LIMIT_EVENT, on);
  }, []);

  const d = err?.limit;
  const locked = d?.limit === "locked";
  const canManage = can("billing.manage");
  const close = () => setErr(null);

  return (
    <Dialog
      open={!!d}
      onClose={close}
      size="sm"
      footer={
        <>
          <Button onClick={close}>{canManage ? "Not now" : "Close"}</Button>
          {canManage && (
            <Button
              variant="primary"
              data-autofocus
              icon={<ArrowUpCircle className="size-4" />}
              onClick={() => {
                close();
                navigate(BILLING_TAB);
              }}
            >
              {locked ? "Choose a plan" : "Upgrade"}
            </Button>
          )}
        </>
      }
    >
      {d && (
        <div className="flex gap-4 p-5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-600 dark:bg-brand-950 dark:text-brand-400">
            {locked ? <Lock className="size-5" /> : <ArrowUpCircle className="size-5" />}
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{locked ? "This workspace is read-only" : "You've reached your plan's limit"}</h2>
            <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">{d.error}</p>
            {typeof d.max === "number" && d.used !== null && (
              <p className="mt-2 text-sm tabular-nums text-zinc-500">
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">{d.used.toLocaleString("en-US")}</span> of {d.max.toLocaleString("en-US")} {LIMIT_LABEL[d.limit]}
              </p>
            )}
            {!canManage && <p className="mt-2 text-sm text-zinc-500">Ask the workspace owner to upgrade the plan.</p>}
          </div>
        </div>
      )}
    </Dialog>
  );
}
