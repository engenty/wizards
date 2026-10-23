import { ArrowRight, LogOut } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { BrowserRouter } from "react-router";
import { Splash } from "../App";
import { Mascot } from "../brand";
import { STUDIO, setStudioRoot, withBase } from "../lib/base";
import { t } from "../lib/i18n";
import { keepHint, type Place, placeOf } from "../lib/place";
import { type Me, signOut, useMe } from "../lib/session";
import { Button } from "../ui";

export function StudioRoot({ children }: { children: ReactNode }) {
  const me = useMe();
  // Decided once, when the person is known: a later answer of /me does not move the studio again.
  const decided = useRef<{ place: Place; tenant: string | null } | null>(null);
  if (me.isLoading) {
    return <Splash />;
  }
  if (!decided.current) {
    decided.current = {
      place: placeOf(window.location.pathname, me.data),
      tenant: me.data?.tenant.id ?? null,
    };
  }
  const { place } = decided.current;
  const { pathname, search, hash } = window.location;
  if (place.kind === "switch") {
    keepHint(place.slug);
    const query = new URLSearchParams({ organization: place.slug, return: `${pathname}${search}` });
    window.location.replace(withBase(`/api/auth/login?${query}`));
    return <Splash />;
  }
  if (place.kind === "foreign") {
    return <ForeignAddress address={place.address} home={place.home} me={place.me} />;
  }
  if (place.kind === "move") {
    window.history.replaceState(window.history.state, "", `${place.to}${search}${hash}`);
    decided.current.place = { kind: "here", root: place.root };
  }
  let root = place.root;
  // The organization got a new address (named on its first visit): the studio follows it.
  const slug = me.data?.mode === "managed" ? me.data.tenant.slug : null;
  const next = slug ? `${STUDIO}/${slug}` : root;
  if (root !== STUDIO && next !== root && me.data?.tenant.id === decided.current.tenant) {
    const rest = pathname.startsWith(root) ? pathname.slice(root.length) : "/";
    window.history.replaceState(window.history.state, "", `${next}${rest}${search}${hash}`);
    decided.current.place = { kind: "here", root: next };
    root = next;
  }
  setStudioRoot(root);
  // A new root is a new router: one that kept its location would match nothing under the new address.
  return (
    <BrowserRouter key={root} basename={root}>
      {children}
    </BrowserRouter>
  );
}

/** An address that is none of the person's organizations: it names no one, so a typo reads the same. */
function ForeignAddress({ address, home, me }: { address: string; home: string; me: Me }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-6">
      <div className="flex max-w-md flex-col items-center gap-5 text-center">
        <Mascot kind="round" size={56} />
        <div className="rounded-md bg-paper-2 px-2.5 py-1 font-mono text-[0.8125rem] text-ink-2">
          /studio/{address}
        </div>
        <h1 className="text-balance font-display font-semibold text-2xl">
          {t("address.foreign.title")}
        </h1>
        <p className="text-[0.9375rem] text-ink-2">
          {t("address.foreign.text", { email: me.user.email })}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => window.location.assign(home)}>
            {t("address.foreign.continue", { name: me.tenant.name ?? "" })}
            <ArrowRight className="size-4" />
          </Button>
          <Button variant="secondary" onClick={() => void signOut()}>
            <LogOut className="size-4" />
            {t("address.foreign.switchAccount")}
          </Button>
        </div>
      </div>
    </div>
  );
}
