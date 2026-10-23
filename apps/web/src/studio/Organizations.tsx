import { featureOn } from "@engenty/wizards-shared/features";
import { ArrowUpRight, Check, ChevronsUpDown, LoaderCircle, Plus, Settings, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { STUDIO, withBase } from "../lib/base";
import { t } from "../lib/i18n";
import { initialsOf, type Me, type Organization } from "../lib/session";
import { cn } from "../ui";
import { useDismiss } from "./AppFrame";

/**
 * Most people have one organization: the studio names it and offers nothing to switch. The
 * switch shows for someone in several, or for a platform admin, who may make another.
 */
export function switchable(me: Me): boolean {
  return me.mode === "managed" && (me.organizations.length > 1 || me.mayCreateOrganization);
}

/**
 * Opens the studio in another organization: its address, where the studio signs in naming it
 * (StudioRoot), which the Manage-App answers with that organization's token and no page.
 */
export function switchTo(org: Organization) {
  if (org.slug) {
    window.location.href = `${STUDIO}/${org.slug}/`;
    return;
  }
  const query = new URLSearchParams({ organization: org.id, return: `${STUDIO}/` });
  window.location.href = withBase(`/api/auth/login?${query}`);
}

/** The organization as the studio is in it: from the list, or its name alone. */
export function currentOrganization(me: Me): Organization | null {
  return (
    me.organizations.find((o) => o.id === me.tenant.id) ??
    (me.tenant.name
      ? {
          id: me.tenant.id,
          name: me.tenant.name,
          slug: null,
          role: me.tenant.role,
          personal: false,
          plan: me.tenant.plan,
        }
      : null)
  );
}

/** An organization's face: the person's own as their round avatar, the others as a quiet tile. */
export function OrganizationFace({
  org,
  size = "sm",
}: {
  org: Organization;
  size?: "xs" | "sm" | "md";
}) {
  const box =
    size === "md"
      ? "size-10 text-[0.8125rem]"
      : size === "sm"
        ? "size-9 text-[0.75rem]"
        : "size-7 text-[0.625rem]";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center font-semibold tracking-wide",
        box,
        org.personal
          ? "rounded-full bg-ember-tint text-ember-strong ring-1 ring-border-soft"
          : "rounded-lg bg-card text-ink-2 ring-1 ring-border",
      )}
    >
      {initialsOf(org.name)}
    </span>
  );
}

/** Where the organization is looked after: Settings › Organisation where it is on, else the account. */
export function useManageOrganization(me: Me): () => void {
  const navigate = useNavigate();
  return () => {
    if (featureOn(me.features, "teamPlans")) {
      navigate("/settings/organization");
    } else if (me.manageUrl) {
      window.open(`${me.manageUrl}/account`, "_blank", "noreferrer");
    }
  };
}

/**
 * The person's organizations to switch between, the current one checked, then what is done
 * with an organization: look after it, and (platform admins only) make another.
 */
export function OrganizationList({
  me,
  roomy,
  onDone,
}: {
  me: Me;
  /** Rows as tall as a thumb: the sheet on a phone. */
  roomy?: boolean;
  onDone: () => void;
}) {
  const manage = useManageOrganization(me);
  const [going, setGoing] = useState<string | null>(null);
  const action = cn(
    "flex w-full items-center gap-3 rounded-lg px-3 text-left text-ink-2 transition hover:bg-accent hover:text-ink",
    roomy ? "py-3 text-[0.9375rem]" : "py-2 text-[0.875rem]",
  );
  return (
    <>
      {me.organizations.map((org) => {
        const current = org.id === me.tenant.id;
        return (
          <button
            key={org.id}
            type="button"
            role="menuitem"
            disabled={going !== null}
            aria-current={current ? "true" : undefined}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-2 text-left transition hover:bg-accent disabled:cursor-default",
              roomy ? "py-2.5" : "py-1.5",
            )}
            onClick={() => {
              if (current) {
                onDone();
                return;
              }
              setGoing(org.id);
              switchTo(org);
            }}
          >
            <OrganizationFace org={org} size={roomy ? "md" : "sm"} />
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span
                className={cn(
                  "truncate",
                  roomy ? "text-[0.9375rem]" : "text-[0.875rem]",
                  current ? "font-semibold text-ink" : "font-medium text-ink-2",
                )}
              >
                {org.name}
              </span>
              <span className="truncate text-[0.75rem] text-ink-4">
                {going === org.id
                  ? t("organizations.switching", { name: org.name })
                  : org.personal
                    ? t("organizations.own")
                    : t(`organization.role.${org.role}`)}
              </span>
            </span>
            {org.plan ? (
              <span className="shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 font-medium text-[0.6875rem] text-ink-3 ring-1 ring-border">
                {org.plan.name}
              </span>
            ) : null}
            <span className="grid w-4 shrink-0 place-items-center">
              {going === org.id ? (
                <LoaderCircle className="size-4 animate-spin text-ink-3" />
              ) : current ? (
                <Check className="size-4 text-ember-strong" />
              ) : null}
            </span>
          </button>
        );
      })}
      <div className="mx-2 my-1.5 h-px bg-border-soft" />
      <button
        type="button"
        role="menuitem"
        className={action}
        onClick={() => {
          onDone();
          manage();
        }}
      >
        <Settings className="size-4 shrink-0 text-ink-3" />
        <span className="truncate">{t("organizations.manage")}</span>
      </button>
      {me.mayCreateOrganization && me.manageUrl ? (
        <a
          role="menuitem"
          className={action}
          href={`${me.manageUrl}/account`}
          target="_blank"
          rel="noreferrer"
          onClick={onDone}
        >
          <Plus className="size-4 shrink-0 text-ink-3" />
          <span className="flex-1 truncate">{t("organizations.create")}</span>
          <ArrowUpRight className="size-3.5 shrink-0 text-ink-4" />
        </a>
      ) : null}
    </>
  );
}

/**
 * The organization's name in the top bar, beside the space's: a menu of the organizations for
 * someone who can switch, its name alone for everyone else.
 */
export function OrganizationMenu({ me, className }: { me: Me; className?: string }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ top: 0, left: 0 });
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const org = currentOrganization(me);
  if (!org) {
    return null;
  }
  if (!switchable(me)) {
    return (
      <span
        className={cn("max-w-[12rem] truncate text-[0.9375rem] text-ink-3", className)}
        title={org.name}
      >
        {org.name}
      </span>
    );
  }
  return (
    <div ref={ref} className={cn("relative min-w-0 shrink", className)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("organizations.switch")}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ top: r.bottom + 6, left: r.left });
          setOpen((o) => !o);
        }}
        className={cn(
          "-ml-2 flex max-w-[13rem] items-center gap-1 rounded-md py-0.5 pr-1.5 pl-2 text-[0.9375rem] text-ink-2 transition hover:bg-accent hover:text-ink",
          open && "bg-accent text-ink",
        )}
      >
        <span className="truncate">{org.name}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-ink-4" />
      </button>
      {open ? (
        <div
          role="menu"
          style={{ position: "fixed", ...at }}
          className="z-50 w-80 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
        >
          <div className="px-2 pt-1.5 pb-1 text-[0.75rem] text-ink-3">
            {t("organizations.mine")}
          </div>
          <OrganizationList me={me} onDone={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The organizations as a sheet from the bottom on a phone, a small dialog elsewhere: what the
 * space menu's “Wechseln” opens.
 */
export function OrganizationSheet({
  me,
  open,
  onClose,
}: {
  me: Me;
  open: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (open && el && !el.open) {
      el.showModal();
    } else if (!open && el?.open) {
      el.close();
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) {
          onClose();
        }
      }}
      aria-label={t("organizations.switch")}
      className={cn(
        "max-h-[85dvh] overflow-y-auto overscroll-contain bg-card p-0 text-ink shadow-overlay backdrop:bg-[oklch(20%_0.01_60/0.28)]",
        // A phone: along the bottom edge, clear of the home indicator.
        "max-sm:mx-0 max-sm:mt-auto max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-t-3xl",
        "sm:m-auto sm:w-[calc(100%-32px)] sm:max-w-sm sm:rounded-2xl",
      )}
    >
      {open ? (
        <div className="px-3 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pt-3">
          <div className="mx-auto mb-2 h-1.5 w-9 rounded-full bg-border sm:hidden" />
          <SheetTitle onClose={onClose}>{t("organizations.switch")}</SheetTitle>
          <OrganizationList me={me} roomy onDone={onClose} />
        </div>
      ) : null}
    </dialog>
  );
}

function SheetTitle({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between px-2 pt-1 pb-2.5">
      <h2 className="font-semibold text-[1.0625rem]">{children}</h2>
      <button
        type="button"
        onClick={onClose}
        aria-label={t("common.close")}
        className="grid size-8 place-items-center rounded-full bg-paper-2 text-ink-3 transition hover:text-ink"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
