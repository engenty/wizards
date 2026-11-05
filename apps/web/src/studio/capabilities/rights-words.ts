import {
  RWX_ALL,
  RWX_PERMS,
  type RwxOrigin,
  type RwxPerm,
  type RwxResourceKind,
  type RwxRuleView,
  type RwxSubjectKind,
  rwxAsked,
} from "@engenty/wizards-shared/rwx";
import { type Key, lang, t } from "../../lib/i18n";

/*
 * Fähigkeiten › Rechte in plain words (docs/plans/broker.md, "Rules, as people write them"): a
 * rule of the space as one sentence, in German and English, from the rule's own data. Who and
 * what are said by name, never by id; a verb says what the runtime asks and no more (a page is
 * changed "with Goose", because only Goose's write is asked). Every kind, permission and origin
 * the rules have maps to a string here; one with none is a bug (rights-words.test.ts).
 */

/** What a sentence needs of a rule: the page's list gives it, and so does a rule being written. */
export type RuleWords = Pick<
  RwxRuleView,
  | "subjectKind"
  | "subjectId"
  | "resourceKind"
  | "resourceId"
  | "r"
  | "w"
  | "x"
  | "subjectName"
  | "resourceName"
  | "folder"
>;

const ROLE_WORDS: Record<string, Key> = {
  member: "rights.who.members",
  admin: "rights.who.admins",
  owner: "rights.who.owners",
  client: "rights.who.clients",
};

/** Who a rule is about, as its sentence starts, and whether they are many (Mitglieder dürfen). */
export function whoOf(rule: Pick<RuleWords, "subjectKind" | "subjectId" | "subjectName">): {
  text: string;
  many: boolean;
} {
  const name = rule.subjectName;
  switch (rule.subjectKind) {
    case "guest":
      return { text: t("rights.who.guests"), many: true };
    case "role":
      return { text: t(ROLE_WORDS[rule.subjectId ?? ""] ?? "rights.who.members"), many: true };
    case "person":
      return { text: name ?? t("rights.who.personGone"), many: false };
    case "goose":
      return {
        text: name ? t("rights.who.goose", { name }) : t("rights.who.gooseGone"),
        many: false,
      };
    case "wizard":
      return {
        text:
          rule.subjectId === RWX_ALL
            ? t("rights.who.everyWizard")
            : name !== null
              ? t("rights.who.wizard", { name })
              : t("rights.who.wizardGone"),
        many: false,
      };
    case "plugin":
      return {
        text: name ? t("rights.who.plugin", { name }) : t("rights.who.pluginGone"),
        many: false,
      };
    case "agent":
      return { text: t("rights.who.agent"), many: false };
  }
}

/** Every resource of a kind, as a sentence's object. */
export const ALL_WORDS: Partial<Record<RwxResourceKind, Key>> = {
  document: "rights.what.all.document",
  page: "rights.what.all.page",
  table: "rights.what.all.table",
  wizard: "rights.what.all.wizard",
  skill: "rights.what.all.skill",
  mount: "rights.what.all.mount",
};

/** One resource by its name. */
export const NAMED_WORDS: Partial<Record<RwxResourceKind, Key>> = {
  document: "rights.what.document",
  page: "rights.what.page",
  table: "rights.what.table",
  wizard: "rights.what.wizard",
  skill: "rights.what.skill",
  mount: "rights.what.mount",
};

/** One resource that is no longer there. */
export const GONE_WORDS: Partial<Record<RwxResourceKind, Key>> = {
  document: "rights.what.gone.document",
  page: "rights.what.gone.page",
  table: "rights.what.gone.table",
  wizard: "rights.what.gone.wizard",
  skill: "rights.what.gone.skill",
  mount: "rights.what.gone.mount",
};

/** The kinds without a name of their own: the space's one setup, and what no rule is asked about. */
export const PLAIN_WORDS: Partial<Record<RwxResourceKind, Key>> = {
  setup: "rights.what.setup",
  connection: "rights.what.connection",
  mail: "rights.what.mail",
  host: "rights.what.host",
  sandbox: "rights.what.sandbox",
};

/** What a rule is about, as its sentence's object: by name, all of a kind, or gone. */
export function whatOf(
  rule: Pick<RuleWords, "resourceKind" | "resourceId" | "resourceName" | "folder">,
): string {
  const kind = rule.resourceKind;
  const plain = PLAIN_WORDS[kind];
  if (plain) {
    return t(plain);
  }
  if (rule.resourceId === RWX_ALL) {
    return t(ALL_WORDS[kind] as Key);
  }
  if (rule.resourceName === null) {
    return t(GONE_WORDS[kind] as Key);
  }
  const key = kind === "page" && rule.folder ? "rights.what.folder" : (NAMED_WORDS[kind] as Key);
  return t(key, { name: rule.resourceName });
}

type Verb =
  | "read"
  | "change"
  | "changeGoose"
  | "see"
  | "seeAi"
  | "start"
  | "startAi"
  | "seeStartAi"
  | "use"
  | "scripts";

export const VERB_WORDS: Record<Verb, Key> = {
  read: "rights.verb.read",
  change: "rights.verb.change",
  changeGoose: "rights.verb.changeGoose",
  see: "rights.verb.see",
  seeAi: "rights.verb.seeAi",
  start: "rights.verb.start",
  startAi: "rights.verb.startAi",
  seeStartAi: "rights.verb.seeStartAi",
  use: "rights.verb.use",
  scripts: "rights.verb.scripts",
};

/**
 * What a permission on a kind lets someone do, as far as the runtime asks: a page and the setup
 * are changed by Goose alone, a wizard is found and started by an AI for the person (and in the
 * clients' own space), a skill is used and its scripts run.
 */
function verbOf(
  subject: RwxSubjectKind,
  role: string | null,
  kind: RwxResourceKind,
  perm: RwxPerm,
) {
  // The subject is the AI itself, or reaches the wizard without one (a client, in their space).
  const direct = subject === "agent" || (subject === "role" && role === "client");
  const verbs: Partial<Record<RwxResourceKind, Partial<Record<RwxPerm, Verb>>>> = {
    document: { r: "read" },
    table: { r: "read" },
    page: { r: "read", w: subject === "goose" ? "change" : "changeGoose" },
    setup: { w: subject === "goose" ? "change" : "changeGoose" },
    wizard: { r: direct ? "see" : "seeAi", x: direct ? "start" : "startAi" },
    skill: { r: "use", x: "scripts" },
    mount: { r: "read", w: "change" },
  };
  return verbs[kind]?.[perm];
}

/** „lesen und ändern“; what is denied, each on its own: „lesen und nicht ändern“ after „nicht“. */
function joined(words: string[], last: Key): string {
  return words.length < 2
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} ${t(last)} ${words.at(-1)}`;
}

/** The verbs of a rule's flags that say `flag`, among the ones a reader asks. */
function verbsOf(rule: RuleWords, flag: "allow" | "deny"): string {
  const role = rule.subjectKind === "role" ? rule.subjectId : null;
  const verbs = RWX_PERMS.filter(
    (p) => rule[p] === flag && rwxAsked(rule.subjectKind, rule.resourceKind, p, rule.subjectId),
  )
    .map((p) => verbOf(rule.subjectKind, role, rule.resourceKind, p))
    .filter((v): v is Verb => Boolean(v));
  const both = verbs.includes("seeAi") && verbs.includes("startAi");
  const said = both
    ? ["seeStartAi" as const, ...verbs.filter((v) => v !== "seeAi" && v !== "startAi")]
    : verbs;
  return joined(
    said.map((v) => t(VERB_WORDS[v])),
    flag === "deny" ? "rights.nor" : "rights.and",
  );
}

/** Whether any flag of the rule is one a reader asks: a rule with none decides nothing. */
export function hasEffect(rule: RuleWords): boolean {
  return RWX_PERMS.some(
    (p) => rule[p] !== null && rwxAsked(rule.subjectKind, rule.resourceKind, p, rule.subjectId),
  );
}

/** Who a sentence is about, as it starts: one (darf) or many (dürfen). */
export interface Who {
  text: string;
  many: boolean;
}

/**
 * A rule as one sentence: who may, or may not, do what with what. „Gäste dürfen den Ordner
 * ‚Preise intern‘ nicht lesen.“ A rule no reader asks is said as that.
 */
export function ruleSentence(rule: RuleWords, who: Who = whoOf(rule)): string {
  const what = whatOf(rule);
  const may = verbsOf(rule, "allow");
  const not = verbsOf(rule, "deny");
  // The plural form goes by who: one (darf) or many (dürfen).
  const vars = { who: who.text, what, n: who.many ? 2 : 1 };
  if (may && not) {
    return t("rights.rule.mixed", { ...vars, verbs: may, not });
  }
  if (may) {
    return t("rights.rule.may", { ...vars, verbs: may });
  }
  if (not) {
    return t("rights.rule.mayNot", { ...vars, verbs: not });
  }
  return t("rights.rule.noEffect", vars);
}

/** What a rule says about its resource, whoever it is about: rules that say the same share a sentence. */
export function saysOf(rule: RuleWords): string {
  return [rule.resourceKind, rule.resourceId, verbsOf(rule, "allow"), verbsOf(rule, "deny")].join(
    "\u0000",
  );
}

/** Who a rule is about inside a sentence: a name and a German noun keep their capital. */
function whoWithin(rule: RuleWords): string {
  const { text } = whoOf(rule);
  const named = (rule.subjectKind === "person" && rule.subjectName) || rule.subjectKind === "goose";
  const noun = lang === "de" && (rule.subjectKind === "role" || rule.subjectKind === "guest");
  return named || noun ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Rules that say the same about one resource (`saysOf`), as one sentence: „Admins, Mitglieder
 * und jeder Wizard dürfen den Ordner ‚Kunden‘ in Dateien lesen.“
 */
export function rulesSentence(rules: RuleWords[]): string {
  const [first, ...more] = rules;
  if (!more.length) {
    return ruleSentence(first);
  }
  const who = joined([whoOf(first).text, ...more.map(whoWithin)], "rights.and");
  return ruleSentence(first, { text: who, many: true });
}

/** Where a rule is set, under its sentence. */
export const ORIGIN_WORDS: Record<RwxOrigin, Key> = {
  start: "rights.origin.start",
  folder: "rights.origin.folder",
  mount: "rights.origin.mount",
  clients: "rights.origin.clients",
  rights: "rights.origin.rights",
};

export function originWord(origin: RwxOrigin): string {
  return t(ORIGIN_WORDS[origin]);
}

/** Where „Dort ändern“ leads: the place that shows the rule and changes it. None for Rechte's own. */
export function originLink(
  rule: Pick<RwxRuleView, "origin" | "resourceKind" | "resourceId">,
): string | null {
  const id = encodeURIComponent(rule.resourceId);
  switch (rule.origin) {
    case "folder":
      return `/space/knowledge?show=p:${id}&audience=1`;
    case "mount":
      return `/space/files?show=m:${id}`;
    case "clients":
      return rule.resourceKind === "wizard"
        ? "/space/clients"
        : `/space/knowledge?show=${rule.resourceKind === "table" ? "t" : rule.resourceKind === "page" ? "p" : "f"}:${id}`;
    default:
      return null;
  }
}

/**
 * What a role or the guests may do with every resource of a kind, as the top of the page lists
 * it: a row per kind and permission the runtime asks, in the page's order. A client reaches a
 * wizard in their own space, without an AI between.
 */
export const RIGHTS: { kind: RwxResourceKind; perm: RwxPerm; label: Key; client?: Key }[] = [
  { kind: "document", perm: "r", label: "rights.can.document.r" },
  { kind: "page", perm: "r", label: "rights.can.page.r" },
  { kind: "table", perm: "r", label: "rights.can.table.r" },
  { kind: "page", perm: "w", label: "rights.can.page.w" },
  {
    kind: "wizard",
    perm: "r",
    label: "rights.can.wizard.r",
    client: "rights.can.wizard.r.client",
  },
  {
    kind: "wizard",
    perm: "x",
    label: "rights.can.wizard.x",
    client: "rights.can.wizard.x.client",
  },
  { kind: "skill", perm: "r", label: "rights.can.skill.r" },
  { kind: "skill", perm: "x", label: "rights.can.skill.x" },
  { kind: "setup", perm: "w", label: "rights.can.setup.w" },
];

/** The permissions by the word the page's forms offer: lesen, ändern, ausführen. */
export const PERM_WORDS: Record<RwxPerm, Key> = {
  r: "rights.perm.r",
  w: "rights.perm.w",
  x: "rights.perm.x",
};

/** The kinds a rule or the question can name, as the forms offer them. */
export const KIND_WORDS: Partial<Record<RwxResourceKind, Key>> = {
  document: "rights.kind.document",
  page: "rights.kind.page",
  table: "rights.kind.table",
  wizard: "rights.kind.wizard",
  skill: "rights.kind.skill",
  setup: "rights.kind.setup",
};
