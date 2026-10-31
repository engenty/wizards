import { useQuery } from "@tanstack/react-query";
import { ExternalLink, MailPlus, UserRound } from "lucide-react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { initialsOf, type Me } from "../lib/session";
import { Button, Chip, Spinner } from "../ui";
import { openExternal } from "./LocalRuntime";
import { Section } from "./space/Section";

type Role = "owner" | "admin" | "member";

interface OrganizationInfo {
  members: {
    userId: string;
    name: string;
    email: string;
    image: string | null;
    role: Role;
    joinedAt: string;
  }[];
  invitations: { id: string; email: string; role: Role; expiresAt: string }[];
  /** The places the plan gives the organization (null: no limit), and how many are taken or invited. */
  seats: { limit: number | null; taken: number };
  plan: { id: string; name: string } | null;
  manageUrl: string;
  canManage: boolean;
}

function Avatar({ name, image }: { name: string; image: string | null }) {
  return image ? (
    <img src={image} alt="" className="size-9 shrink-0 rounded-full object-cover" />
  ) : (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-paper-2 font-medium text-[0.75rem] text-ink-2">
      {initialsOf(name)}
    </span>
  );
}

/**
 * The organization the cloud studio belongs to: its plan and places, who is in it and who is invited.
 * Inviting, roles and the plan are changed on the account pages of the Manage-App.
 */
export function Organization({ me }: { me: Me }) {
  const organization = useQuery({
    queryKey: ["organization", me.tenant.id],
    queryFn: () => api.get<OrganizationInfo>("/api/studio/organization"),
  });
  const data = organization.data;
  const plan = data?.plan ?? me.tenant.plan;
  const seats = data?.seats;
  return (
    <div className="flex flex-col gap-9">
      <Section title={t("organization.title")} hint={t("organization.hint")}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1">
            {me.tenant.name ? (
              <div className="mb-3">
                <div className="text-[0.8125rem] text-ink-3">{t("organization.name")}</div>
                <div className="mt-0.5 truncate font-medium text-[0.9375rem]">{me.tenant.name}</div>
              </div>
            ) : null}
            <div className="text-[0.8125rem] text-ink-3">{t("organization.plan")}</div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="font-medium text-[0.9375rem]">
                {plan?.name ?? t("organization.planFree")}
              </span>
              {seats ? (
                <Chip>
                  {seats.limit === null
                    ? t("organization.seatsUnlimited")
                    : t("organization.seats", { taken: seats.taken, limit: seats.limit })}
                </Chip>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => openExternal(`${me.manageUrl}/billing`)}>
              {t("organization.changePlan")} <ExternalLink className="size-4" />
            </Button>
            {data?.canManage ? (
              <Button onClick={() => openExternal(`${me.manageUrl}/`)}>
                {t("organization.manage")} <ExternalLink className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>
        <p className="mt-4 text-[0.8125rem] text-ink-3 leading-relaxed">
          {me.tenant.role === "member" ? t("organization.memberNote") : t("organization.roles")}
        </p>
      </Section>

      <Section title={t("organization.members")}>
        {organization.isPending ? (
          <Spinner />
        ) : organization.isError || !data ? (
          <p className="text-[0.875rem] text-rose">{t("organization.failed")}</p>
        ) : (
          <div className="flex flex-col divide-y divide-border-soft">
            {data.members.map((m) => (
              <div key={m.userId} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <Avatar name={m.name} image={m.image} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[0.9375rem]">
                    {m.name}
                    {m.userId === me.user.id ? (
                      <span className="text-ink-4"> · {t("organization.you")}</span>
                    ) : null}
                  </div>
                  <div className="truncate text-[0.8125rem] text-ink-3">{m.email}</div>
                </div>
                <Chip tone={m.role === "member" ? undefined : "live"}>
                  {t(`organization.role.${m.role}`)}
                </Chip>
              </div>
            ))}
            {data.invitations.map((i) => (
              <div key={i.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-paper-2 text-ink-3">
                  <MailPlus className="size-4" />
                </span>
                <div className="min-w-0 flex-1 truncate text-[0.9375rem]">{i.email}</div>
                <Chip tone="warn">
                  {t("organization.invited")} · {t(`organization.role.${i.role}`)}
                </Chip>
              </div>
            ))}
            {data.members.length === 0 && data.invitations.length === 0 ? (
              <div className="flex items-center gap-3 text-[0.875rem] text-ink-3">
                <UserRound className="size-4" /> –
              </div>
            ) : null}
          </div>
        )}
      </Section>
    </div>
  );
}
