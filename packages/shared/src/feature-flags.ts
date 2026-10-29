/**
 * The feature flags of the core: the parts that ship in the code but are not on for everyone
 * yet (`release`), and the parts a plan includes (`plan`). This file is the list – add a flag
 * here, branch on it with `useFeature("name")` in the studio or `feature("name")` in the
 * runtime, and delete it with its branches once its default became `true`.
 *
 * How a flag gets its value (defaults here → `FEATURES` env → the Manage-App → the `.features`
 * file) lives in features.ts. A plugin's flags are declared in its manifest under `features`
 * and are known as `<plugin id>.<name>`; they do not belong here. No public page lists these.
 */

export interface FeatureDeclaration {
  kind: "release" | "plan";
  /** What counts until a layer says otherwise. */
  default: boolean;
  /** A few words for the lists: `wizards features`, the admin's switches. */
  label: string;
  hint?: string;
}

/**
 * One entry per flag. `kind: "release"`: on or off for everyone by default, turned on for a
 * organization or a machine before the default flips. `kind: "plan"`: on until a plan says `false`.
 */
export const FEATURES = {
  account: {
    kind: "release",
    default: true,
    label: "Account in a local install",
    hint: "Linking, Settings → Account, the offer to sign in.",
  },
  twoWaySync: {
    kind: "release",
    default: true,
    label: "Two-way sync with the cloud",
    hint: "A local install with an account keeps its spaces in step with the organization in the cloud, both ways: wizards, knowledge, data and files.",
  },
  liveChanges: {
    kind: "release",
    default: true,
    label: "Live changes in the studio",
    hint: "An open studio shows what changed elsewhere (another member, a run, the AI, the sync) without a reload.",
  },
  unsetConnectors: {
    kind: "release",
    default: false,
    label: "Connectors without an OAuth client",
    hint: "Built-in connectors are shown although their client is not set up.",
  },
  site: {
    kind: "release",
    default: false,
    label: "Link to the website in the setup",
    hint: "The local install's setup links the product's site.",
  },
  teamPlans: {
    kind: "release",
    default: false,
    label: "Organization plans",
    hint: "The organization page in the cloud studio, and plans that carry this switch on the account pages.",
  },
  organizationSettings: {
    kind: "release",
    default: false,
    label: "Organization settings in the studio",
    hint: "Settings › Organisation in the cloud studio: the organization's name, its members and invitations, changed there instead of on the account pages.",
  },
  brandSections: {
    kind: "release",
    default: false,
    label: "Sections in Brand",
    hint: "Sections of logos and of colours, gradients and patterns among them.",
  },
  brandRules: {
    kind: "release",
    default: false,
    label: "Rules in Brand",
    hint: "Rules for how the logos, the colours and the type may be used.",
  },
  typography: {
    kind: "release",
    default: false,
    label: "Typography in Brand",
    hint: "The brand's fonts, their licences and a type scale.",
  },
  channelVoice: {
    kind: "release",
    default: false,
    label: "Live voice",
    hint: "Wizards run as a spoken conversation in the browser: offered when building and sharing.",
  },
  channelVideo: {
    kind: "release",
    default: false,
    label: "Video call",
    hint: "Wizards run as a video call in the browser: offered when building and sharing.",
  },
  pages: {
    kind: "release",
    default: false,
    label: "Public page",
    hint: "A space's page at the organization's address on wizards.page: its part in the space, the share dialog's switch.",
  },
  wordpress: {
    kind: "release",
    default: false,
    label: "WordPress plugin",
    hint: "The plugin for WordPress sites, and a wizard as a package for one: offered in the share dialog and under Settings → Integrate.",
  },
  skills: {
    kind: "release",
    default: false,
    label: "Skills",
    hint: "Skills in a space's sources: from skills.sh, uploaded or written; always on in every AI step, or read by a wizard when it needs one.",
  },
  plugins: {
    kind: "release",
    default: false,
    label: "Plugins in the settings",
    hint: "Settings › Plugins, also before any plugin is installed. Installing a plugin turns it on.",
  },
  goose: {
    kind: "release",
    default: false,
    label: "Goose",
    hint: "The studio's assistant: its chat at the foot of the page and in the sidebar.",
  },
  modelTiers: {
    kind: "release",
    default: false,
    label: "Model tiers",
    hint: "The organization's model tier: steps may name a maker, calls say what they are for, and the studio shows what each class runs on in the tier.",
  },
  ownKeys: {
    kind: "plan",
    default: true,
    label: "Own API keys",
    hint: "The organization puts its providers' keys into the cloud studio instead of running on credits.",
  },
} as const satisfies Record<string, FeatureDeclaration>;
