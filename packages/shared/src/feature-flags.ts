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
    default: false,
    label: "Two-way sync with the cloud",
    hint: "A local install with an account keeps its spaces in step with the organization in the cloud, both ways: wizards, knowledge, data and files.",
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
  brandSections: {
    kind: "release",
    default: false,
    label: "Sections in Info & brand",
    hint: "Sections of logos and of colours, gradients and patterns among them.",
  },
  brandRules: {
    kind: "release",
    default: false,
    label: "Rules in Info & brand",
    hint: "Rules for how the logos, the colours and the type may be used.",
  },
  typography: {
    kind: "release",
    default: false,
    label: "Typography in Info & brand",
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
  goose: {
    kind: "release",
    default: false,
    label: "Goose",
    hint: "The studio's assistant: its chat at the foot of the page and in the sidebar.",
  },
  ownKeys: {
    kind: "plan",
    default: true,
    label: "Own API keys",
    hint: "The organization puts its providers' keys into the cloud studio instead of running on credits.",
  },
} as const satisfies Record<string, FeatureDeclaration>;
