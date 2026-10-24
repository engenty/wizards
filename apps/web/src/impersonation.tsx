import { useQuery } from "@tanstack/react-query";
import { withBase } from "@/lib/base";
import { api } from "./lib/api";
import { lang, t } from "./lib/i18n";

/**
 * Back to the admin's own account: the studio's session ends here, and the account's form takes
 * the browser on to the admin app (the Manage-App's `/api/impersonate/stop`).
 */
async function backToOwnAccount() {
  const res = await fetch(withBase("/api/auth/sign-out"), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const { account } = (await res.json().catch(() => ({}))) as { account?: string | null };
  if (!account) {
    window.location.reload();
    return;
  }
  const form = document.createElement("form");
  form.method = "POST";
  form.action = account;
  document.body.append(form);
  form.submit();
}

/**
 * While a platform admin is signed in as someone: whose account it is, until when, and the way
 * back. On the studio's and the wizard pages' every screen.
 */
export function ImpersonationBanner({ name, until }: { name: string; until: number }) {
  const time = new Intl.DateTimeFormat(lang, { timeStyle: "short" }).format(new Date(until));
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-tint px-4 py-2 text-center text-[0.8125rem] text-ink">
      <span>{t("impersonation.banner", { name, time })}</span>
      <button
        type="button"
        className="font-medium underline underline-offset-2 hover:text-ink-2"
        onClick={() => void backToOwnAccount()}
      >
        {t("impersonation.back")}
      </button>
    </div>
  );
}

/** The wizard page's banner: the doors say whether an admin is signed in as someone here. */
export function WizardPageImpersonation() {
  const who = useQuery({
    queryKey: ["impersonation"],
    queryFn: () => api.get<{ name: string; until: number } | null>("/api/public/impersonation"),
    staleTime: 60_000,
    retry: false,
  });
  return who.data ? <ImpersonationBanner name={who.data.name} until={who.data.until} /> : null;
}
