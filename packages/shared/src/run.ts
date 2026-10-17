// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import {
  type CardOption,
  type Format,
  isLang,
  type Lang,
  type ModelClass,
  type Step,
  type WizardDefinition,
} from "./definition.js";
import type { ConnectionView, ListDef, ListRow } from "./store.js";
import type { Surface } from "./surface.js";
import { type Gap, type Line, lineText, type Texts, type TextTable, textOf } from "./texts.js";

export type RunStatus = "waiting_input" | "running" | "done" | "failed" | "cancelled";

export interface AssetRef {
  id: string;
  /** image | video | html | text | json */
  kind: string;
  mime: string;
  name: string;
  /**
   * Media a model made ("generated") or changed ("edited"). Shown with a label wherever it is
   * displayed; the file itself carries the marking in its metadata (EU AI Act, Art. 50).
   */
  ai?: "generated" | "edited";
}

export interface StepOutput {
  text?: string;
  json?: unknown;
  /** A decision step: how probable each answer is (1 or 0 where a language model answered). */
  decided?: Record<string, number>;
  /** A view from the surface catalog and the data it is bound to. */
  surface?: Surface;
  assets?: AssetRef[];
  /**
   * What the person did in the step's view, kept with the run: a checklist's ticks by component
   * id, a widget's own state (`wizard.save`).
   */
  view?: Record<string, unknown>;
  /** Widgets: what loading it with this run's data showed. */
  widget?: {
    /** Seconds of animation the widget registered for video export; null = a still widget. */
    duration: number | null;
    errors: string[];
  };
  at: string;
}

export interface RunState {
  values: Record<string, unknown>;
  outputs: Record<string, StepOutput>;
  /** Interactive steps answered, oldest first — "back" pops this. */
  history: string[];
  /** Regenerate notes per step. */
  notes: Record<string, string>;
  /** Steps that make several results: the entries (from 0) to make again; the others stay. */
  redo?: Record<string, number[]>;
  /** The step whose `ask` branches are being decided; the run waits on that decision. */
  deciding?: string;
  /** What decided `ask` branches answered, by step. */
  decisions?: Record<string, BranchDecision>;
  /** Pages whose fields a decision chose: the field ids kept, by page. */
  pages?: Record<string, { shown: string[] }>;
  /** How often each branch was taken, by "<step>→<goto>": loops stop at the rule's max. */
  loops?: Record<string, number>;
  /** File fields with `listen`: what is said in the recording, piece by piece with its times. */
  heard?: Record<string, { start: number; end: number; text: string }[]>;
  /**
   * A test run's own copy of the wizard's memory: the pages it wrote, by title. The wizard's
   * pages stay as they are; the copy goes with the run.
   */
  memory?: Record<string, string>;
  /**
   * Finished results translated on request, by language and step: the text the person reads in
   * place of the step's own (`StepOutput.text`); the step's output stays as it was made.
   */
  translated?: Record<string, Record<string, string>>;
}

/** What a decision over a step's `ask` branches found. */
export interface BranchDecision {
  /** The index of the rule in the step's `next`, or null: none of them, go on. */
  rule: number | null;
  source: "systemone" | "llm";
  probabilities?: Record<string, number>;
  at: string;
}

/** A branch decision as the studio sees it: with the step's branches it was made over. */
export interface ShownDecision extends BranchDecision {
  over: NonNullable<Step["next"]>;
}

interface AskBase {
  id: string;
  stepId: string;
  /** Why the wizard asks, in the person's language. */
  reason: string;
  at: string;
}

/**
 * A running step asks the person to sign in on a page the wizard's browser has open. What the
 * person types goes into that page; the model never sees it.
 */
export interface LoginAsk extends AskBase {
  kind: "login";
  site: { host: string; title: string };
  /** Inputs found on the page, to fill here instead of clicking into the picture. */
  fields: { id: string; label: string; secret: boolean }[];
}

/** A running step wants to change something in one of the person's accounts and asks first. */
export interface ConfirmAsk extends AskBase {
  kind: "confirm";
  /** The connected service, e.g. "Notion". */
  service: string;
  action: { id: string; summary: string; destructive: boolean };
  /** What would be sent, as readable JSON. */
  input: string;
}

/** What a running step asks the person; the step waits for the answer. */
export type RunAsk = LoginAsk | ConfirmAsk;

/** A question as a step puts it; the runner adds id, step and time. */
export type AskInput =
  | Omit<LoginAsk, "id" | "stepId" | "at">
  | Omit<ConfirmAsk, "id" | "stepId" | "at">;

/**
 * `fill` and `done` answer a sign-in (remember = keep the sign-in); `done` also allows a change
 * (remember = allow that action for the rest of the run); `skip` declines either.
 */
export type AskAnswer =
  | { type: "fill"; values: Record<string, string>; remember?: boolean }
  | { type: "done"; remember?: boolean }
  | { type: "skip" };

/** One thing the person does in the wizard's browser while it waits for them. */
export type BrowserAct =
  /** Where on the picture, as a share of its width and height (0–1). */
  | { type: "click"; fx: number; fy: number }
  | { type: "type"; text: string }
  | { type: "key"; key: "Enter" | "Tab" | "Backspace" | "Escape" }
  | { type: "scroll"; dy: number };

/** A stored list the current step shows. */
export interface ShownList {
  def: ListDef;
  rows: ListRow[];
  formats: Format[];
  label: string | null;
}

/**
 * What a step reports while it works, in words for each language: the runtime writes the English
 * line into the run's log, a runner shows it in the language the person reads. The runtime's
 * answers to the person running a shared wizard (a refusal, a failure) are notes too: it answers
 * them in the wizard's language.
 */
const NOTES_EN = {
  entry: "Entry {n} of {total}",
  deciding: "Deciding what to do next…",
  choosingFields: "Choosing the right questions…",
  batchDone: "{done} of {total} done",
  editing: "Editing {n} of {total}",
  filming: "Filming {n} of {total}",
  clipsRendering: {
    one: "Rendering {count} clip – this takes a few minutes.",
    other: "Rendering {count} clips – this takes a few minutes.",
  },
  videoRendering: "Rendering the video – this usually takes 1–3 minutes.",
  photo: "Looking at photo {n} of {total}",
  // An entry a step has just written, while it writes the rest: "Rezepte: Shakshuka mit Feta".
  found: "{label}: {name}",
  listen: "Listening to “{label}”…",
  listenFailed: "“{label}” couldn’t be transcribed.",
  filmCutting: "Cutting the film – this takes about a minute.",
  filmProgress: "{pct} % cut",
  filmError: "The film reports: {detail}",
  widgetError: "The widget reports an error: {detail}",
  mcpConnected: "Connected to {names}",
  mcpUnreachable: "MCP server unreachable: {detail}",
  reads: "Reading {name}",
  readsMany: { one: "Reading {count} document", other: "Reading {count} documents" },
  opens: "Opening {name}",
  clicks: "Clicking in the browser",
  clicksOn: "Clicking “{name}”",
  types: "Typing in the browser",
  typesText: "Typing “{text}”",
  selects: "Choosing “{option}”",
  scrolls: "Scrolling",
  presses: "Pressing {key}",
  goesBack: "Going back a page",
  waitsForPage: "Waiting for the page",
  fastLoop: "Doing in the browser: {goal}",
  personDrives: "You’re driving the browser – the wizard waits",
  agentDrives: "The wizard carries on in the browser",
  looksAtPage: "Looking at the page",
  waitsForSignIn: "Waiting for you to sign in to {name}",
  downloads: "Downloading {name}",
  runs: "Running: {command}",
  python: "Running Python",
  runsProgram: "Working through the data in one go",
  drawing: "Drawing an image",
  writesPage: "Writing the page “{title}”",
  searchesDocuments: "Searching the documents: {query}",
  searchesKnowledge: "Searching knowledge: {query} – {relevant} of {candidates} fit",
  listsKnowledge: "Listing knowledge",
  searchesMail: "Searching {label}",
  savesReceipts: {
    one: "Saving {count} receipt from {label}",
    other: "Saving {count} receipts from {label}",
  },
  remembers: "Remembering {title}",
  files: { one: "Filing {count} file", other: "Filing {count} files" },
  filmSetup: "Setting up the folder for the film",
  filmClient: "{client} is working on the film – this usually takes 10–40 minutes.",
  filmTask: "On the film: {task}",
  filmLooks: "Looking at frames of the film",
  filmFix: "The film didn’t render – Claude Code is fixing it",
  filmResume: "Picking the film up where it stopped",
  wizardUnavailable: "This wizard isn’t available right now.",
  translationFailed: "This wizard can’t be translated right now. It’s shown as it was written.",
  translationOff: "This wizard is only offered as it was written.",
  translationPlaceholder:
    "The translation of “{text}” needs every placeholder in curly brackets the original has.",
  wizardLimit: "This wizard has reached its limit for today. Try again tomorrow.",
  confirmHuman: "Confirm that you’re a person.",
  tooManyRuns: "You’ve started a lot of runs just now. Try again in an hour.",
  runOver: "The run is over.",
  runBusy: "The wizard is working right now.",
  pageOutdated: "This page is out of date.",
  noStepBefore: "There is no step before this one.",
  checkFields: "Check the marked fields.",
  talkOff: "Live conversations aren’t turned on for this wizard.",
  talkKeyRefused: "The conversation couldn’t start: the OpenAI API key was refused.",
  talkFailed: "The conversation couldn’t start ({status}).",
  talkNoSecret: "The conversation couldn’t start: no access key came back.",
  tryLater: "Try again later.",
  recordingTooLarge: "The recording can be 10 MB at most.",
  fileTooLarge: "Choose a file of {mb} MB or less.",
  askClosed: "This question is no longer open.",
  noBrowser: "The wizard has no browser open right now.",
  notWaiting: "The wizard isn’t waiting for you right now.",
  pageActFailed: "That didn’t work on the page.",
  linkGone: "This link has expired or was withdrawn.",
  connected: "Connected. You can close this window.",
  connectFailed: "Connecting didn’t work. Try again.",
  connectCancelled: "Connecting was cancelled.",
  appleOff:
    "Apple Intelligence is turned off on this Mac. Turn it on in System Settings → Apple Intelligence & Siri.",
  appleLoading:
    "Apple is still loading the model for Apple Intelligence onto this Mac. Try again in a moment.",
  appleMissing: "The helper for Apple Intelligence (wizards-apple) is missing from this install.",
  appleOs: "Apple Intelligence needs macOS 26 or later.",
  appleDevice: "Apple Intelligence only works on a Mac with Apple silicon.",
  appleBusy: "Apple Intelligence isn’t taking more requests right now. Try again in a moment.",
  appleTooLong:
    "The text is too long for Apple Intelligence on this Mac (4,096 tokens for question and answer). Choose another model for this class under Settings → Models.",
  appleRefused: "Apple Intelligence turned the request down: Apple’s content rules don’t allow it.",
  appleLanguage: "Apple Intelligence doesn’t understand the language of this request.",
  appleFormat: "Apple Intelligence can’t answer in this format: {detail}",
  appleFailed: "Apple Intelligence: {detail}",
  appleNoFfmpeg:
    "Apple Intelligence can’t read {type}, and without ffmpeg the recording can’t be converted. Install ffmpeg or record as MP4 in the browser.",
  appleNotConverted: "Apple Intelligence couldn’t convert the recording: {detail}",
  connectorAlreadyExistsSpace: "The connector “{id}” already exists in this space.",
  connectorNotExist: "This connector doesn’t exist.",
  fieldMissing: "“{label}” is missing.",
  mailServerNotExist:
    "The mail server{host} doesn’t exist. Enter the IMAP server. For Gmail and Google Workspace, it’s imap.gmail.com.",
  mailServerNotResponding:
    "The mail server{host} isn’t responding. Check the IMAP server and port.",
  connectingNotWork: "Connecting didn’t work{host}: {detail}",
  connectEngentyAccountFirst:
    "Connect your engenty account first (Settings → Account). Then you can connect Google here.",
  engentyAccountNotReached: "Your engenty account can’t be reached right now. Try again later.",
  googleNoLongerAccepts: "Google no longer accepts this connection. Connect the account again.",
  googleNotConnectedThrough: "Google can’t be connected through your engenty account right now.",
  stepNeedsToolPlugin:
    "This step needs the tool “{id}”. The plugin “{plugin}” isn’t installed here.",
  clientNotSignedIn: "{name} isn’t signed in on this computer. Sign in under Settings → Models.",
  clientNotInstalled:
    "{name} isn’t installed on this computer. Install it under Settings → Models.",
  clientNoCredit: "The account {name} is signed in with has no credit or quota left.",
  clientAccountNotServed:
    "{name} no longer serves the account it is signed in with. Sign it in with another account, or choose another way under Settings → Models.",
  anthropicAccountClaudeCode:
    "The Anthropic account Claude Code is signed in with has no credit. Sign Claude Code in with your subscription under Settings → Models.",
  chatgptAccountCodexSigned:
    "The ChatGPT account Codex is signed in with has used up its quota. Try again later or choose another client.",
  builtTerminalNotAvailable:
    "The built-in terminal isn’t available on this computer. Run the command in your own terminal.",
  terminalNoLongerExists: "This terminal no longer exists.",
  imageTypeNotReadable: "Images of type {mime} can’t be read (PNG, JPEG and WebP work).",
  fileNotReadable: "“{name}” ({mime}) can’t be read.",
  creditsNotSignedIn: "This is set to run on credits, but you’re not signed in to an account.",
  accountNoLongerSigned:
    "The account is no longer signed in. Sign in again under Settings → Account.",
  modelNotUsedYet:
    "The model “{ref}” can’t be used yet. Add an API key under Settings → Models, or sign in to an account.",
  noModelForImages: "No model is set up for images.",
  noModelForVideos: "No model is set up for videos.",
  noModelForSpeech: "No model is set up for speech.",
  noOpenaiApiKey: "No OpenAI API key is set for voice conversations (Settings → Models).",
  modelNotAvailableAccount: "This model isn’t available with your account.",
  accountNoModelSet: "Your account has no model set up for this.",
  claudeCodeMakesFilms:
    "Claude Code makes films on this computer, using your subscription. Set it up as an AI subscription under Settings → Models.",
  macNeedsFfmpegTranscribe:
    "This Mac needs ffmpeg to transcribe recordings from Chrome or Firefox (WebM, Ogg). Safari and the app don’t. Install ffmpeg, e.g. with “brew install ffmpeg”.",
  fieldRequired: "Required",
  chooseAtLeast: "Choose at least {min}",
  chooseAtMost: "At most {max} – remove some",
  enterNumber: "Enter a number",
  invalidChoice: "Invalid choice",
  timeNotOffered: "This time isn’t offered",
  notValidEmailAddress: "Not a valid email address",
  notValidUrl: "Not a valid URL",
  wizardRunOutCredits: "This wizard has run out of credits for now. Try again later.",
  providerCreditLow:
    "Your credit with the model provider isn’t enough for this (videos need a minimum balance there). Top up there and try again.",
  aiServiceBusyRight: "The AI service is busy right now. Try again in a moment.",
  stepTookTooLong: "The step took too long. Try again.",
  aiServiceNotReached: "The AI service can’t be reached right now. Try again later.",
  notAvailableNow: "That isn’t available here right now.",
  fileNotFound: "File not found",
  connectFirst: "Connect first",
  noEntriesStepWork: "There are no entries for this step to work on.",
  stepNotReturnResult: "The step didn’t return a result.",
  documentNotCreated: "The document couldn’t be created.",
  stepMissingSourcesImages: "This step is missing its sources (images or scenes).",
  noTextReadAloud: "There is no text to read aloud.",
  wizardStillErrors: "The wizard still has errors.",
  noLanguageModelSet: "No language model is set up here.",
  creditsUsedUp: "Your credits are used up.",
  chooseFile: "Choose a file.",
  pageNotReached: "The page can’t be reached.",
  unknownEntry: "Unknown entry.",
  chooseWizardFileMb: "Choose a wizard file ({PACKAGE_EXTENSION}) of 30 MB or less.",
  recordingMbMost: "The recording can be 10 MB at most.",
  onlyFinishedResultsShared: "Only finished results can be shared.",
  gradientFailed: "Couldn’t make a gradient from that. Try describing it differently.",
  onlyOneSpaceAllowed: "Only one space is allowed here.",
  mostSpaces: {
    one: "You can have at most {count} space here.",
    other: "You can have at most {count} spaces here.",
  },
  twoEntriesSameKey: "Two entries have the same key.",
  notDeleteLastSpace: "You can’t delete the last space.",
  notFound: "This doesn’t exist or was deleted.",
  categoryNeedsName: "A category needs a name.",
  unknownCategoryType: "Unknown type “{type}”.",
  spaceMostCategories: {
    one: "A space can have at most {count} category.",
    other: "A space can have at most {count} categories.",
  },
  categoryAlreadyExists: "The category “{name}” already exists.",
  onlyChoiceCategoriesValues: "Only choice categories have values.",
  onlyValuesOneCategory: "Only values of one category can be merged.",
  templateNeedsNewerVersion:
    "This template needs a newer version of engenty wizards. Update engenty wizards first.",
  chatNotExist: "This chat doesn’t exist.",
  unknownRunner: "There’s no runner “{unknown}” here.",
  leastOneRunnerStay: "At least one runner has to stay on.",
  linkOpenRunnerTurned: "The link has to open a runner that’s turned on.",
  jobNotExistAlready: "This job doesn’t exist or has already finished.",
  accountAlreadySpace: "This account already has a space here.",
  accountAlreadySpaces: {
    one: "This account already has {count} space here.",
    other: "This account already has {count} spaces here.",
  },
  roomMostPublishedWizards: {
    one: "There’s room for at most {count} published wizard here.",
    other: "There’s room for at most {count} published wizards here.",
  },
  spaceIdAlreadyExists:
    "A space with this ID already exists here and didn’t come from your computer.",
  wizardIdAlreadyBelongs: "A wizard with this ID already belongs to another space here.",
  idAlreadyUse: "This ID is already in use here.",
  wizardNotSpace: "This wizard isn’t in the space.",
  invalidColumns: "Invalid columns.",
  spaceMostTables: {
    one: "A space can have at most {count} table.",
    other: "A space can have at most {count} tables.",
  },
  tableBelongsOneWizard:
    "This table belongs to one of the wizard’s lists. Its columns come from the wizard.",
  entryAlreadyExists: "This entry already exists.",
  tableMostRows: {
    one: "A table can have at most {count} row.",
    other: "A table can have at most {count} rows.",
  },
  spaceMostPages: {
    one: "A space can have at most {count} page.",
    other: "A space can have at most {count} pages.",
  },
  pageNotSubpages: "This page can’t have subpages.",
  pageNotOwnSubpage: "A page can’t be its own subpage.",
  pageNeedsTitle: "A page needs a title.",
  unknownSpace: "There’s no space “{space}”.",
  noParentPage: "There’s no page with the key “{parent}” to put this page under.",
  onlyTeamAdmins:
    "Only team admins can do that. As a member, you can edit the wizards that already exist.",
  spaceEditedLocally: "You edit this space in engenty wizards on your computer, not here.",
  wizardsRunOncePublished:
    "Wizards run here once you publish them in engenty wizards on your computer. You build and edit them there.",
  logoImagePngSvg: "A logo is an image (PNG, SVG, JPEG, WebP).",
  patternImageSvgPng: "A pattern is an image (SVG, PNG, JPEG, WebP).",
  filesGoHere:
    "Images, videos, audio, PDFs, fonts, Lottie and 3D models go here. Texts to look things up in go under knowledge.",
  addressNotReached: "The address can’t be reached.",
  addressResponded: "The address responded with {status}.",
  addressLeadsWebPage: "The address leads to a web page, not an image.",
  addressFileTooLarge: "The file is too large.",
  onlyDocumentsIndex: "Only documents are in the index.",
  emptyTooLargeDocument: "“{name}” is empty or too large for a document.",
  spaceMostDocuments: {
    one: "A space can have at most {count} document.",
    other: "A space can have at most {count} documents.",
  },
  accountSignedOut: "The account is signed out. Sign in again.",
  cloudNotReachedRight: "The cloud can’t be reached right now.",
  publishWizardFirst: "Publish the wizard first.",
  wizardJsonUnreadable: "This isn’t a wizard file: its wizard.json can’t be read.",
  wizardFileComesNewer:
    "This wizard file comes from a newer version, or it’s damaged. Update engenty wizards or export the wizard again.",
  fileOver5Mb: "{name} is larger than 5 MB.",
  wizardFileTooLarge:
    "The wizard file is too large: a workspace holds at most 200 files and 25 MB.",
  wizardFileNotOpened:
    "The wizard file can’t be opened. Export the wizard again and try once more.",
  wizardJsonMissing: "This isn’t a wizard file: wizard.json is missing.",
  notValidFilePath: "“{name}” isn’t a valid file path.",
  workspaceWizardFileLarger: "The workspace in the wizard file is larger than 25 MB.",
  unknownTemplate: "There’s no template “{starterId}”.",
  wizardChangedMeantime: "The wizard was changed in the meantime.",
  valueNotExist: "This value doesn’t exist.",
  nothingFiledUnderValue: "Nothing is filed under this value yet.",
  filmNotRenderedNeeds:
    "The film couldn’t be rendered. It needs ffmpeg and a timeline in the widget.",
  signInRefused:
    "The sign-in was refused{host}. Are the address and (app) password right? Gmail and Google Workspace need an app password and IMAP turned on.{answer}",
  serverSaid: " The server said: {answer}",
  viaAccountFailed: "Connecting through your engenty account didn’t work ({code}).",
  pluginInvalidInput: "“{id}” got invalid input: {path} – {problem}",
  filmClientStopped:
    "{name} stopped working on the film: {detail}. The work is saved. A new try carries on from there.",
  filmWorkSaved: "{problem} The work is saved. A new try carries on from there.",
  filmRenderFailed: "The film couldn’t be rendered: {detail}",
  commandNotStarted: "The command couldn’t start: {detail}",
  providerKeyMissing: "{provider} is chosen for {makes}, but no API key is set.",
  noModelFor: "No model is set up for {makes}.",
  noApiKeyFor: "No API key is set for {provider}.",
  freeTier:
    "Your AI Gateway key is on Vercel’s free tier, which doesn’t include {model}. Top up at Vercel ({url}) or choose another model under Settings → Models.",
  thisModel: "this model",
  quoted: "“{text}”",
  viewErrors: "The view has errors: {detail}",
  blockedSteps: "{steps}: {problem}",
  joined: "{first} {second}",
  stepFailed: "This step failed: {detail}",
  answersMissing: "Answers are missing or don’t fit: {answers}",
  fieldError: "{field} – {message}",
  templateNeedsPlugins: {
    one: "This template needs the plugin {plugins}: included with Pro on engenty.ai.",
    other: "This template needs the plugins {plugins}: included with Pro on engenty.ai.",
  },
  pageMostChars: {
    one: "A page can have at most {count} character.",
    other: "A page can have at most {count} characters.",
  },
  chooseFileUpTo: "Choose a file of {mb} MB or less.",
  roomMostFiles: {
    one: "There’s room for at most {count} file here.",
    other: "There’s room for at most {count} files here.",
  },
  makesText: "text",
  makesImages: "images",
  makesVideos: "videos",
  makesSpeech: "speech",
  makesVoiceNotes: "voice notes",
} as const satisfies Record<string, Line>;
export type RunNoteCode = keyof typeof NOTES_EN;

const NOTES_DE: Partial<Record<RunNoteCode, Line>> = {
  entry: "Eintrag {n} von {total}",
  deciding: "Entscheidet, wie es weitergeht …",
  choosingFields: "Wählt die passenden Fragen …",
  batchDone: "{done} von {total} fertig",
  editing: "Bearbeitet {n} von {total}",
  filming: "Dreht {n} von {total}",
  clipsRendering: {
    one: "{count} Clip wird gerendert – das dauert einige Minuten.",
    other: "{count} Clips werden gerendert – das dauert einige Minuten.",
  },
  videoRendering: "Das Video wird gerendert – das dauert meist 1–3 Minuten.",
  photo: "Sieht sich Foto {n} von {total} an",
  found: "{label}: {name}",
  listen: "Hört „{label}“ an …",
  listenFailed: "„{label}“ konnte nicht verschriftlicht werden.",
  filmCutting: "Der Film wird geschnitten – das dauert etwa eine Minute.",
  filmProgress: "{pct} % geschnitten",
  filmError: "Der Film meldet: {detail}",
  widgetError: "Das Widget meldet einen Fehler: {detail}",
  mcpConnected: "Verbunden mit {names}",
  mcpUnreachable: "MCP-Server nicht erreichbar: {detail}",
  reads: "Liest {name}",
  readsMany: { one: "Liest {count} Dokument", other: "Liest {count} Dokumente" },
  opens: "Öffnet {name}",
  clicks: "Klickt im Browser",
  clicksOn: "Klickt auf „{name}“",
  types: "Tippt im Browser",
  typesText: "Tippt „{text}“",
  selects: "Wählt „{option}“",
  scrolls: "Scrollt",
  presses: "Drückt {key}",
  goesBack: "Geht eine Seite zurück",
  waitsForPage: "Wartet auf die Seite",
  fastLoop: "Erledigt im Browser: {goal}",
  personDrives: "Du steuerst den Browser – der Wizard wartet",
  agentDrives: "Der Wizard macht im Browser weiter",
  looksAtPage: "Sieht sich die Seite an",
  waitsForSignIn: "Wartet auf deine Anmeldung bei {name}",
  downloads: "Lädt {name} herunter",
  runs: "Führt aus: {command}",
  runsProgram: "Arbeitet die Daten in einem Zug durch",
  python: "Führt Python aus",
  drawing: "Zeichnet ein Bild",
  writesPage: "Schreibt die Seite „{title}“",
  searchesDocuments: "Sucht in den Dokumenten: {query}",
  searchesKnowledge: "Sucht in Wissen: {query} – {relevant} von {candidates} passen",
  listsKnowledge: "Listet Wissen",
  searchesMail: "Durchsucht {label}",
  savesReceipts: {
    one: "Speichert {count} Beleg aus {label}",
    other: "Speichert {count} Belege aus {label}",
  },
  remembers: "Merkt sich {title}",
  files: { one: "Legt {count} Datei ab", other: "Legt {count} Dateien ab" },
  filmSetup: "Richtet den Arbeitsordner für den Film ein",
  filmClient: "{client} arbeitet am Film – das dauert meist 10–40 Minuten.",
  filmTask: "Am Film: {task}",
  filmLooks: "Sieht sich Bilder des Films an",
  filmFix: "Der Film ließ sich nicht rendern – Claude Code bessert nach",
  filmResume: "Macht dort weiter, wo der Film stehen geblieben ist",
  wizardUnavailable: "Dieser Wizard ist gerade nicht verfügbar.",
  translationFailed:
    "Dieser Wizard lässt sich gerade nicht übersetzen. Du siehst ihn so, wie er geschrieben wurde.",
  translationOff: "Diesen Wizard gibt es nur so, wie er geschrieben wurde.",
  translationPlaceholder:
    "Die Übersetzung von „{text}“ braucht jeden Platzhalter in geschweiften Klammern, den das Original hat.",
  wizardLimit: "Für heute ist das Limit dieses Wizards erreicht. Versuch es morgen wieder.",
  confirmHuman: "Bestätige kurz, dass du ein Mensch bist.",
  tooManyRuns: "Du hast gerade viele Läufe gestartet. Versuch es in einer Stunde wieder.",
  runOver: "Der Lauf ist beendet.",
  runBusy: "Der Wizard arbeitet gerade.",
  pageOutdated: "Diese Seite ist nicht mehr aktuell.",
  noStepBefore: "Kein vorheriger Schritt.",
  checkFields: "Prüf die markierten Felder.",
  talkOff: "Live-Gespräche sind für diesen Wizard nicht eingeschaltet.",
  talkKeyRefused: "Das Gespräch ließ sich nicht starten: Der OpenAI-API-Key wurde abgelehnt.",
  talkFailed: "Das Gespräch ließ sich nicht starten ({status}).",
  talkNoSecret: "Das Gespräch ließ sich nicht starten: Es kam kein Zugang zurück.",
  tryLater: "Versuch es später noch einmal.",
  recordingTooLarge: "Die Aufnahme darf höchstens 10 MB groß sein.",
  fileTooLarge: "Wähl eine Datei bis {mb} MB.",
  askClosed: "Diese Frage ist nicht mehr offen.",
  noBrowser: "Der Wizard hat gerade keinen Browser offen.",
  notWaiting: "Der Wizard wartet gerade nicht auf dich.",
  pageActFailed: "Das hat auf der Seite nicht geklappt.",
  linkGone: "Dieser Link ist abgelaufen oder wurde zurückgezogen.",
  connected: "Verbunden. Du kannst dieses Fenster schließen.",
  connectFailed: "Verbinden hat nicht geklappt. Versuch es noch einmal.",
  connectCancelled: "Verbinden wurde abgebrochen.",
  appleOff:
    "Apple Intelligence ist auf diesem Mac ausgeschaltet. Schalte es unter Systemeinstellungen → Apple Intelligence & Siri ein.",
  appleLoading:
    "Apple lädt das Modell für Apple Intelligence noch auf diesen Mac. Versuch es gleich noch einmal.",
  appleMissing: "Der Helfer für Apple Intelligence (wizards-apple) fehlt in dieser Installation.",
  appleOs: "Apple Intelligence braucht macOS 26 oder neuer.",
  appleDevice: "Apple Intelligence gibt es nur auf einem Mac mit Apple Silicon.",
  appleBusy:
    "Apple Intelligence nimmt gerade keine weiteren Anfragen an. Versuch es gleich noch einmal.",
  appleTooLong:
    "Der Text ist zu lang für Apple Intelligence auf diesem Mac (4.096 Tokens für Frage und Antwort). Wähle unter Einstellungen → Modelle ein anderes Modell für diese Klasse.",
  appleRefused:
    "Apple Intelligence hat die Anfrage abgelehnt: Apples Inhaltsregeln lassen sie nicht zu.",
  appleLanguage: "Apple Intelligence versteht die Sprache dieser Anfrage nicht.",
  appleFormat: "Apple Intelligence kann dieses Antwortformat nicht liefern: {detail}",
  appleFailed: "Apple Intelligence: {detail}",
  appleNoFfmpeg:
    "Apple Intelligence liest {type} nicht, und ohne ffmpeg lässt sich die Aufnahme nicht umwandeln. Installiere ffmpeg oder nimm im Browser als MP4 auf.",
  appleNotConverted: "Apple Intelligence konnte die Aufnahme nicht umwandeln: {detail}",
  connectorAlreadyExistsSpace: "Den Connector „{id}“ gibt es in diesem Space schon.",
  connectorNotExist: "Diesen Connector gibt es nicht.",
  fieldMissing: "„{label}“ fehlt.",
  mailServerNotExist:
    "Den Mail-Server{host} gibt es nicht. Trag den IMAP-Server ein, bei Gmail und Google Workspace imap.gmail.com.",
  mailServerNotResponding: "Der Mail-Server{host} antwortet nicht. Prüf IMAP-Server und Port.",
  connectingNotWork: "Verbinden hat nicht geklappt{host}: {detail}",
  connectEngentyAccountFirst:
    "Verbinde zuerst dein engenty-Konto (Einstellungen → Konto). Dann kannst du Google hier verbinden.",
  engentyAccountNotReached:
    "Dein engenty-Konto ist gerade nicht erreichbar. Versuch es später noch einmal.",
  googleNoLongerAccepts: "Google nimmt diese Verbindung nicht mehr an. Verbinde das Konto neu.",
  googleNotConnectedThrough: "Google lässt sich über dein engenty-Konto gerade nicht verbinden.",
  stepNeedsToolPlugin:
    "Dieser Schritt braucht das Werkzeug „{id}“. Das Plugin „{plugin}“ ist hier nicht installiert.",
  clientNotSignedIn:
    "{name} ist auf diesem Computer nicht angemeldet. Melde dich unter Einstellungen → Modelle an.",
  clientNotInstalled:
    "{name} ist auf diesem Computer nicht installiert. Installiere es unter Einstellungen → Modelle.",
  clientNoCredit:
    "Das Konto, mit dem {name} angemeldet ist, hat kein Guthaben oder Kontingent mehr.",
  clientAccountNotServed:
    "{name} bedient das Konto, mit dem es angemeldet ist, nicht mehr. Melde es mit einem anderen Konto an oder wähle unter Einstellungen → Modelle einen anderen Weg.",
  anthropicAccountClaudeCode:
    "Das Anthropic-Konto, mit dem Claude Code angemeldet ist, hat kein Guthaben. Melde Claude Code unter Einstellungen → Modelle mit deinem Abo an.",
  chatgptAccountCodexSigned:
    "Das Kontingent des ChatGPT-Kontos, mit dem Codex angemeldet ist, ist aufgebraucht. Versuch es später noch einmal oder wähle einen anderen Client.",
  builtTerminalNotAvailable:
    "Das eingebaute Terminal ist auf diesem Computer nicht verfügbar. Führe den Befehl in deinem eigenen Terminal aus.",
  terminalNoLongerExists: "Dieses Terminal gibt es nicht mehr.",
  imageTypeNotReadable: "Bilder vom Typ {mime} lassen sich nicht lesen (PNG, JPEG und WebP gehen).",
  fileNotReadable: "„{name}“ ({mime}) lässt sich nicht lesen.",
  creditsNotSignedIn: "Dafür sind Credits gewählt, aber du bist mit keinem Konto angemeldet.",
  accountNoLongerSigned:
    "Das Konto ist nicht mehr angemeldet. Melde dich unter Einstellungen → Konto neu an.",
  modelNotUsedYet:
    "Das Modell „{ref}“ lässt sich noch nicht nutzen. Hinterleg unter Einstellungen → Modelle einen API-Key oder melde dich mit einem Konto an.",
  noModelForImages: "Für Bilder ist kein Modell eingerichtet.",
  noModelForVideos: "Für Videos ist kein Modell eingerichtet.",
  noModelForSpeech: "Für Sprachausgabe ist kein Modell eingerichtet.",
  noOpenaiApiKey:
    "Für Sprachgespräche ist kein OpenAI-API-Key hinterlegt (Einstellungen → Modelle).",
  modelNotAvailableAccount: "Dieses Modell gibt es mit deinem Konto nicht.",
  accountNoModelSet: "Dafür ist bei deinem Konto kein Modell eingerichtet.",
  claudeCodeMakesFilms:
    "Filme macht Claude Code auf diesem Computer mit deinem Abo. Richte es unter Einstellungen → Modelle als KI-Abo ein.",
  macNeedsFfmpegTranscribe:
    "Aufnahmen aus Chrome oder Firefox (WebM, Ogg) schreibt dieser Mac erst mit ffmpeg auf. Safari und die App brauchen es nicht. Installiere ffmpeg, z. B. mit „brew install ffmpeg“.",
  fieldRequired: "Pflichtfeld",
  chooseAtLeast: "Wähl mindestens {min} aus",
  chooseAtMost: "Höchstens {max} – entferne einige",
  enterNumber: "Gib eine Zahl ein",
  invalidChoice: "Ungültige Auswahl",
  timeNotOffered: "Dieser Termin wird nicht angeboten",
  notValidEmailAddress: "Keine gültige E-Mail-Adresse",
  notValidUrl: "Keine gültige URL",
  wizardRunOutCredits:
    "Dieser Wizard hat gerade kein Guthaben mehr. Versuch es später noch einmal.",
  providerCreditLow:
    "Das Guthaben beim Modellanbieter reicht dafür nicht aus (Videos brauchen dort ein Mindestguthaben). Lade dort auf und versuch es noch einmal.",
  aiServiceBusyRight: "Der KI-Dienst ist gerade ausgelastet. Versuch es gleich noch einmal.",
  stepTookTooLong: "Der Schritt hat zu lange gedauert. Versuch es noch einmal.",
  aiServiceNotReached: "Der KI-Dienst ist gerade nicht erreichbar. Versuch es später noch einmal.",
  notAvailableNow: "Das ist hier gerade nicht verfügbar.",
  fileNotFound: "Datei nicht gefunden",
  connectFirst: "Verbinde zuerst",
  noEntriesStepWork: "Es gibt keine Einträge, für die dieser Schritt arbeiten könnte.",
  stepNotReturnResult: "Der Schritt hat kein Ergebnis geliefert.",
  documentNotCreated: "Das Dokument konnte nicht erstellt werden.",
  stepMissingSourcesImages: "Für diesen Schritt fehlen die Vorlagen (Bilder oder Szenen).",
  noTextReadAloud: "Es gibt keinen Text zum Vorlesen.",
  wizardStillErrors: "Der Wizard hat noch Fehler.",
  noLanguageModelSet: "Hier ist kein Sprachmodell eingerichtet.",
  creditsUsedUp: "Dein Guthaben ist aufgebraucht.",
  chooseFile: "Wähl eine Datei.",
  pageNotReached: "Die Seite ist nicht erreichbar.",
  unknownEntry: "Unbekannter Eintrag.",
  chooseWizardFileMb: "Wähl eine Wizard-Datei ({PACKAGE_EXTENSION}) bis 30 MB.",
  recordingMbMost: "Die Aufnahme darf höchstens 10 MB groß sein.",
  onlyFinishedResultsShared: "Nur fertige Ergebnisse lassen sich teilen.",
  gradientFailed: "Daraus ließ sich kein Verlauf machen. Beschreib ihn anders.",
  onlyOneSpaceAllowed: "Hier ist nur ein Space möglich.",
  mostSpaces: {
    one: "Hier ist höchstens {count} Space möglich.",
    other: "Hier sind höchstens {count} Spaces möglich.",
  },
  twoEntriesSameKey: "Zwei Einträge haben denselben Schlüssel.",
  notDeleteLastSpace: "Der letzte Space lässt sich nicht löschen.",
  notFound: "Das gibt es nicht oder nicht mehr.",
  categoryNeedsName: "Eine Kategorie braucht einen Namen.",
  unknownCategoryType: "Unbekannter Typ „{type}“.",
  spaceMostCategories: {
    one: "Ein Space hat höchstens {count} Kategorie.",
    other: "Ein Space hat höchstens {count} Kategorien.",
  },
  categoryAlreadyExists: "Die Kategorie „{name}“ gibt es schon.",
  onlyChoiceCategoriesValues: "Werte gibt es nur bei Kategorien vom Typ Auswahl.",
  onlyValuesOneCategory: "Nur Werte einer Kategorie lassen sich zusammenführen.",
  templateNeedsNewerVersion:
    "Diese Vorlage braucht eine neuere Version von engenty wizards. Aktualisiere zuerst engenty wizards.",
  chatNotExist: "Diesen Chat gibt es nicht.",
  unknownRunner: "Einen Runner „{unknown}“ gibt es hier nicht.",
  leastOneRunnerStay: "Mindestens ein Runner muss eingeschaltet bleiben.",
  linkOpenRunnerTurned: "Der Link muss einen eingeschalteten Runner öffnen.",
  jobNotExistAlready: "Diesen Vorgang gibt es nicht, oder er ist schon beendet.",
  accountAlreadySpace: "Dieses Konto hat hier schon einen Space.",
  accountAlreadySpaces: {
    one: "Dieses Konto hat hier schon {count} Space.",
    other: "Dieses Konto hat hier schon {count} Spaces.",
  },
  roomMostPublishedWizards: {
    one: "Hier hat höchstens {count} veröffentlichter Wizard Platz.",
    other: "Hier haben höchstens {count} veröffentlichte Wizards Platz.",
  },
  spaceIdAlreadyExists:
    "Einen Space mit dieser Kennung gibt es hier schon, und er kommt nicht von deinem Computer.",
  wizardIdAlreadyBelongs: "Ein Wizard mit dieser Kennung gehört hier schon zu einem anderen Space.",
  idAlreadyUse: "Diese Kennung ist hier schon vergeben.",
  wizardNotSpace: "Diesen Wizard gibt es im Space nicht.",
  invalidColumns: "Ungültige Spalten.",
  spaceMostTables: {
    one: "Ein Space hat höchstens {count} Tabelle.",
    other: "Ein Space hat höchstens {count} Tabellen.",
  },
  tableBelongsOneWizard:
    "Diese Tabelle gehört zu einer Liste des Wizards. Die Spalten kommen aus dem Wizard.",
  entryAlreadyExists: "Diesen Eintrag gibt es schon.",
  tableMostRows: {
    one: "Eine Tabelle hat höchstens {count} Zeile.",
    other: "Eine Tabelle hat höchstens {count} Zeilen.",
  },
  spaceMostPages: {
    one: "Ein Space hat höchstens {count} Seite.",
    other: "Ein Space hat höchstens {count} Seiten.",
  },
  pageNotSubpages: "Diese Seite kann keine Unterseiten haben.",
  pageNotOwnSubpage: "Eine Seite kann nicht ihre eigene Unterseite sein.",
  pageNeedsTitle: "Eine Seite braucht einen Titel.",
  unknownSpace: "Den Space „{space}“ gibt es nicht.",
  noParentPage: "Es gibt keine Seite mit dem Schlüssel „{parent}“, unter die diese Seite könnte.",
  onlyTeamAdmins:
    "Das dürfen nur Admins des Teams. Als Mitglied bearbeitest du die Wizards, die es schon gibt.",
  spaceEditedLocally:
    "Diesen Space bearbeitest du in engenty wizards auf deinem Computer, nicht hier.",
  wizardsRunOncePublished:
    "Hier laufen die Wizards, die du in engenty wizards auf deinem Computer veröffentlichst. Gebaut und bearbeitet wird dort.",
  logoImagePngSvg: "Ein Logo ist ein Bild (PNG, SVG, JPEG, WebP).",
  patternImageSvgPng: "Ein Muster ist ein Bild (SVG, PNG, JPEG, WebP).",
  filesGoHere:
    "Hierher gehören Bilder, Videos, Audio, PDFs, Schriften, Lottie und 3D-Modelle. Texte zum Nachschlagen gehören ins Wissen.",
  addressNotReached: "Die Adresse ist nicht erreichbar.",
  addressResponded: "Die Adresse antwortete mit {status}.",
  addressLeadsWebPage: "Unter der Adresse steht eine Webseite, kein Bild.",
  addressFileTooLarge: "Die Datei ist zu groß.",
  onlyDocumentsIndex: "Nur Dokumente stehen im Index.",
  emptyTooLargeDocument: "„{name}“ ist leer oder zu groß für ein Dokument.",
  spaceMostDocuments: {
    one: "Ein Space hat höchstens {count} Dokument.",
    other: "Ein Space hat höchstens {count} Dokumente.",
  },
  accountSignedOut: "Das Konto ist abgemeldet. Melde dich neu an.",
  cloudNotReachedRight: "Die Cloud ist gerade nicht erreichbar.",
  publishWizardFirst: "Veröffentliche den Wizard zuerst.",
  wizardJsonUnreadable: "Das ist keine Wizard-Datei: Die wizard.json darin lässt sich nicht lesen.",
  wizardFileComesNewer:
    "Diese Wizard-Datei stammt aus einer neueren Version oder ist beschädigt. Aktualisiere engenty wizards oder exportiere den Wizard neu.",
  fileOver5Mb: "{name} ist größer als 5 MB.",
  wizardFileTooLarge:
    "Die Wizard-Datei ist zu groß: Ein Arbeitsbereich fasst höchstens 200 Dateien und 25 MB.",
  wizardFileNotOpened:
    "Die Wizard-Datei lässt sich nicht öffnen. Exportiere den Wizard neu und versuche es noch einmal.",
  wizardJsonMissing: "Das ist keine Wizard-Datei: Die wizard.json fehlt.",
  notValidFilePath: "„{name}“ ist kein gültiger Dateipfad.",
  workspaceWizardFileLarger: "Der Arbeitsbereich in der Wizard-Datei ist größer als 25 MB.",
  unknownTemplate: "Die Vorlage „{starterId}“ gibt es nicht.",
  wizardChangedMeantime: "Der Wizard wurde inzwischen geändert.",
  valueNotExist: "Diesen Wert gibt es nicht.",
  nothingFiledUnderValue: "Unter diesem Wert steht noch nichts.",
  filmNotRenderedNeeds:
    "Der Film ließ sich nicht rendern. Dafür braucht es ffmpeg und eine Zeitleiste im Widget.",
  signInRefused:
    "Anmeldung abgelehnt{host}. Stimmen Adresse und (App-)Passwort? Gmail und Google Workspace brauchen ein App-Passwort und eingeschaltetes IMAP.{answer}",
  serverSaid: " Antwort des Servers: {answer}",
  viaAccountFailed: "Verbinden über dein engenty-Konto hat nicht geklappt ({code}).",
  pluginInvalidInput: "„{id}“ bekam ungültige Angaben: {path} – {problem}",
  filmClientStopped:
    "{name} hat beim Film aufgehört: {detail}. Die Arbeit ist gespeichert. Ein neuer Versuch macht dort weiter.",
  filmWorkSaved: "{problem} Die Arbeit ist gespeichert. Ein neuer Versuch macht dort weiter.",
  filmRenderFailed: "Der Film ließ sich nicht rendern: {detail}",
  commandNotStarted: "Der Befehl konnte nicht starten: {detail}",
  providerKeyMissing: "Für {makes} ist {provider} gewählt, aber kein API-Key hinterlegt.",
  noModelFor: "Für {makes} ist kein Modell eingerichtet.",
  noApiKeyFor: "Für {provider} ist kein API-Key hinterlegt.",
  freeTier:
    "Dein AI-Gateway-Key nutzt bei Vercel die kostenlose Stufe, und die schließt {model} aus. Lade bei Vercel Guthaben auf ({url}) oder wähle unter Einstellungen → Modelle ein anderes Modell.",
  thisModel: "dieses Modell",
  quoted: "„{text}“",
  viewErrors: "Die Ansicht hat Fehler: {detail}",
  stepFailed: "Dieser Schritt hat nicht geklappt: {detail}",
  answersMissing: "Antworten fehlen oder passen nicht: {answers}",
  templateNeedsPlugins: {
    one: "Diese Vorlage braucht das Plugin {plugins}: bei Pro auf engenty.ai dabei.",
    other: "Diese Vorlage braucht die Plugins {plugins}: bei Pro auf engenty.ai dabei.",
  },
  pageMostChars: "Eine Seite hat höchstens {count} Zeichen.",
  chooseFileUpTo: "Wähl eine Datei bis {mb} MB.",
  roomMostFiles: {
    one: "Hier hat höchstens {count} Datei Platz.",
    other: "Hier haben höchstens {count} Dateien Platz.",
  },
  makesText: "Text",
  makesImages: "Bilder",
  makesVideos: "Videos",
  makesSpeech: "Sprachausgabe",
  makesVoiceNotes: "Sprachnotizen",
};

export const RUN_NOTES: Texts<RunNoteCode> = { en: NOTES_EN, de: NOTES_DE };

/** What fills a note's gaps: words, numbers, other notes (said in the same language), lists. */
export type NoteGap = Gap | RunNote | readonly NoteGap[];

/** A line of `RUN_NOTES` with what goes into its gaps. */
export interface RunNote {
  code: RunNoteCode;
  params?: Record<string, NoteGap | undefined>;
}

/** What the person reads: plain words, or a note that has a line for each language. */
export type Said = string | RunNote;

/** A note: a line of `RUN_NOTES`, said in whichever language the reader reads. */
export function note(code: RunNoteCode, params?: Record<string, NoteGap | undefined>): RunNote {
  return params ? { code, params } : { code };
}

/** What is said, in a language. */
export function saidText(said: Said, lang: Lang): string {
  return typeof said === "string" ? said : noteText(said, lang);
}

function gapIn(value: NoteGap, lang: string, table?: TextTable): Gap {
  if (Array.isArray(value)) {
    return value.map((item: NoteGap) => gapIn(item, lang, table));
  }
  if (typeof value === "object" && value !== null && "code" in value) {
    return noteText(value, lang, table);
  }
  return value as Gap;
}

/**
 * A note in a language, its gaps filled; English where the language lacks the line. A language
 * outside `LANGS` reads its lines from `table`, the notes translated on request.
 */
export function noteText(note: RunNote, lang: string, table?: TextTable): string {
  if (!(note.code in NOTES_EN)) {
    return "";
  }
  const params: Record<string, Gap | undefined> = {};
  for (const [key, value] of Object.entries(note.params ?? {})) {
    params[key] = value === undefined ? undefined : gapIn(value, lang, table);
  }
  const own = table?.[note.code];
  if (own !== undefined) {
    return lineText(own, lang, params);
  }
  return textOf(RUN_NOTES, note.code, isLang(lang) ? lang : "en", params);
}

export interface RunEvent {
  id: number;
  at: string;
  stepId: string | null;
  type: "step_started" | "step_done" | "tool" | "info" | "error";
  /** In German, as the run's log keeps it. */
  message: string;
  /** The same as a note a runner shows in the person's language; null for free text. */
  note?: RunNote | null;
  /** A picture of the run this is about (a photo being looked at, an image just made). */
  asset?: string | null;
}

export interface RunView {
  id: string;
  status: RunStatus;
  mode: "test" | "live";
  wizard: Pick<WizardDefinition, "title" | "description" | "avatar" | "intro">;
  /** The language the wizard speaks, by its code: what is read aloud, and in which voice. */
  lang: string;
  /**
   * The run in the viewer's language (a wizard translated on request): every text of the view
   * is written in it, the choices keep their values and show `labels[value]`. Null: the
   * wizard's own words.
   */
  translation: RunTranslation | null;
  /** A live conversation can be started on this run: the runtime has a model for it and the wizard has live voice or video on (always in a test). */
  talk: boolean;
  /** The step the person is on (interactive) or the one running. */
  step: Step | null;
  /** Pages and reviews answered before it, oldest first: what a chat shows above the current step. */
  answered: Step[];
  values: Record<string, unknown>;
  /** What fields of the current page start with, from earlier steps (`prefill`). */
  prefill: Record<string, unknown>;
  /** What the `when` of the current page's fields read from before the page, by reference. */
  known?: Record<string, unknown>;
  /** Choices of the current page's fields that come from earlier data (`optionsFrom`). */
  options?: Record<string, string[]>;
  /** The same choices as cards, for fields that have `cards`. */
  cards?: Record<string, CardOption[]>;
  /** The decided fields (`ask`, `group`) of the current page that a decision kept. */
  decidedFields?: string[];
  /**
   * What decided branches answered so far, by step, with the branches decided over (test runs:
   * the studio shows them while the draft's branches are still those).
   */
  decisions?: Record<string, ShownDecision>;
  /** Choices of the current page that lead to a step without a model here, by field id. */
  closed: Record<string, ClosedChoice>;
  outputs: Record<string, StepOutput>;
  /** Steps whose outputs the current step shows, with their definitions. */
  shown: { step: Step; output: StepOutput | null; formats: Format[]; label: string | null }[];
  progress: { done: number; total: number };
  canBack: boolean;
  error: string | null;
  events: RunEvent[];
  brand: BrandView;
  /** What the running step asks the person right now. */
  ask: RunAsk | null;
  /** Stored lists the current step shows (a page's list fields, a review, the result). */
  lists: ShownList[];
  /** The wizard's connections with what the person has connected. */
  connections: ConnectionView[];
  /** The wizard keeps things for the person between runs (lists, files, accounts). */
  keeps: boolean;
  /** Set once the result is shared. */
  shareUrl: string | null;
  /** When the run and its shared link are deleted; null = kept. */
  expiresAt: string | null;
}

/** How a run in the viewer's language shows. */
export interface RunTranslation {
  /** The language, by its code ("fr"): any language, not only one of `LANGS`. */
  lang: string;
  /** What a choice shows, by its value. */
  labels: Record<string, string>;
  /** A model wrote some of it; false where the author wrote every text by hand. */
  machine: boolean;
  /** Results shown in this language, by step (`RunState.translated`). */
  results: Record<string, string>;
}

/** A shared result: what `/s/<token>` shows. Never the person's answers. */
export interface ShareView {
  token: string;
  title: string;
  message: string | null;
  wizard: Pick<WizardDefinition, "title" | "description" | "avatar">;
  brand: BrandView;
  shown: RunView["shown"];
  createdAt: string;
  expiresAt: string | null;
  /** The wizard's public link, to make your own — when it is published and open. */
  wizardUrl: string | null;
}

export interface BrandView {
  name: string;
  accent: string | null;
  logoUrl: string | null;
  /** How the pages look: the run page sets its tokens from it. */
  theme: RunTheme;
}

/** How a wizard's pages look, taken from its space's brand (`runTheme`). Null: the runner's own. */
export interface RunTheme {
  /** Buttons and marks. */
  accent: string | null;
  /** What is there, done or good to know: ticks, tips, group headings. */
  second: string | null;
  /** The ground the pages stand on; its hue tints paper and ink. */
  background: string | null;
  /** Typefaces as CSS names them. */
  display: string | null;
  body: string | null;
  /** The brand stands on a dark ground. */
  dark: boolean;
}

export interface PublicWizard {
  token: string;
  title: string;
  description: string;
  avatar: string;
  intro: string | null;
  brand: BrandView;
  turnstileSiteKey: string | null;
  available: boolean;
  unavailableReason: string | null;
  /**
   * The runners switched on for this wizard, the one its link opens first: what the page offers
   * beside "Let's go". A page runner has an address; a channel (a number, a bot) has none.
   */
  runners: { id: string; label: string; kind: "page" | "channel"; url: string | null }[];
  /** The language the wizard is written in, by its code: the page opens in it. */
  lang: string;
  /** The author offers the wizard in the viewer's language, translated on request. */
  translatable: boolean;
  /** The page in the viewer's language, where it was asked for (`?lang=`); null: the original. */
  translation: Omit<RunTranslation, "results"> | null;
  /**
   * What the wizard's pages ask, in order: an AI app that starts the wizard (the OpenUI
   * component) can fill in what it already knows. The person still sees and sends each page.
   */
  fields: PublicField[];
}

/** A field of a wizard's page, as `PublicWizard.fields` lists it. */
export interface PublicField {
  id: string;
  label: string;
  kind: string;
  options?: string[];
  required?: boolean;
}

/** The runner's own words in a language outside `LANGS`: `GET /api/public/texts/:lang`. */
export interface UiTexts {
  lang: string;
  /** The runner's table (`packages/shared/src/runner-texts.ts`). */
  runner: TextTable;
  /** The run notes (`RUN_NOTES`). */
  notes: TextTable;
}

/** What a step is expected to cost, in credits. `high` is the 90th percentile once measured. */
export interface StepEstimate {
  credits: number;
  high: number;
  /** From at least five runs of this version; otherwise from a formula. */
  measured: boolean;
}

/** What a run is expected to cost. `available` is false where no credits are involved. */
/** A model class a wizard needs that this runtime cannot serve, with the steps that call it. */
export interface MissingModel {
  cls: ModelClass;
  /** Why the class cannot run, as the person reads it. */
  problem: string;
  steps: { id: string; title: string }[];
  /** A step that needs it lies on every path: the run cannot start. */
  blocking: boolean;
}

/** A page's choice whose values lead to a step this runtime has no model for. */
export interface ClosedChoice {
  /** The options (or a toggle's true / false) that lead there; empty = the field as a whole. */
  values: (string | boolean)[];
  /** What is missing on the way. */
  classes: ModelClass[];
}

export interface RunEstimate {
  available: boolean;
  credits: number;
  /** Credits held when a run starts. */
  reserve: number;
  steps: Record<string, StepEstimate>;
}
