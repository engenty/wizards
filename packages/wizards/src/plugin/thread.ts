import type { PluginRunField, PluginRunReport, PluginRuns, PluginRunWaiting } from "./index.js";

/**
 * A thread door: a wizard run in a messenger's thread, one message at a time. The door holds
 * the conversation (which field is asked, what a reply means, when a page is sent, when the
 * screen takes over, what is sent at the end); a channel plugin brings the surface (how a
 * question is drawn there, how a file is fetched) and the plumbing (the webhook, the thread
 * rows, the keywords). WhatsApp and SMS are two surfaces of the same door.
 */

export type ThreadLang = "de" | "en";

/** What the person sent, as every channel can say it. */
export interface ThreadInbound {
  id: string;
  /** The person's address on the channel: a number, an account. */
  from: string;
  name?: string | null;
  at: number;
  kind: "text" | "reply" | "image" | "document" | "video" | "audio" | "location" | "other";
  text?: string;
  /** The id of the option the person tapped, where the channel has buttons. */
  replyId?: string;
  replyTitle?: string;
  media?: { id: string; mime: string; filename?: string; caption?: string };
  location?: { lat: number; lng: number; name?: string; address?: string };
}

export interface ThreadOption {
  id: string;
  title: string;
  /** Of a multiple choice: picked already. */
  picked?: boolean;
}

/** What the door says; the surface draws it as the channel allows. */
export type ThreadPrompt =
  | { kind: "text"; text: string }
  /** A question with options: buttons, a list, or numbered lines — the surface decides. A typed number or title counts as a tap. */
  | { kind: "choice"; text: string; options: ThreadOption[]; multiple?: boolean; button: string }
  | { kind: "location"; text: string }
  | { kind: "link"; text: string; url: string; label: string }
  | {
      kind: "media";
      media: "image" | "document" | "video" | "audio";
      url: string;
      caption?: string;
      filename?: string;
    };

export interface ThreadWizard {
  wizardId: string;
  token: string;
  title: string;
  lang: ThreadLang;
  /** The word that starts it in the thread. */
  keyword: string;
}

export interface ThreadPageDraft {
  step: string;
  values: Record<string, unknown>;
  /** The field the last question was about. */
  asking: string | null;
  /** A multiple choice so far, and the files of a field that takes several. */
  picks: string[];
  files: string[];
}

export interface ThreadState {
  lang: ThreadLang;
  wizardId: string | null;
  page: ThreadPageDraft | null;
  /** At a review: which output to make again, then what should change. */
  awaiting: "target" | "note" | null;
  target: string | null;
  /** What was said once already: "working on X", the review, the question, the link to the screen. */
  said: string | null;
  delivered: boolean;
  /** The options of the last question, so a typed number or title counts as a tap. */
  choices: ThreadOption[] | null;
}

export interface Thread {
  /** The person's address on the channel. */
  id: string;
  name: string | null;
  runId: string | null;
  state: ThreadState;
  lastInboundAt: number;
  lastMessageId: string | null;
}

export const freshThreadState = (lang: ThreadLang = "en"): ThreadState => ({
  lang,
  wizardId: null,
  page: null,
  awaiting: null,
  target: null,
  said: null,
  delivered: false,
  choices: null,
});

export interface ThreadSurface {
  /** The runner's id: kept on the run, and the person's channel. */
  runner: string;
  /** The field kinds the surface asks itself; any other on a page hands the page to the screen. */
  asks: Iterable<string>;
  send(thread: Thread, prompt: ThreadPrompt): Promise<void>;
  /** A file the person sent, by what the inbound named. Without it, files hand off. */
  media?(ref: NonNullable<ThreadInbound["media"]>): Promise<{ data: Uint8Array; mime: string }>;
  /** Whether something may be sent now with nobody having written (a messenger's window). Default: yes. */
  mayDeliver?(thread: Thread): boolean;
  /** When it may not: the link by other means (a template). True when something went out. */
  reach?(thread: Thread, url: string): Promise<boolean>;
}

export interface ThreadDoorOptions {
  runs: PluginRuns;
  surface: ThreadSurface;
  /** The wizards the door may start: the ones switched on, with their keywords. */
  offered(): Promise<ThreadWizard[]>;
  /** Keep hearing the run, and call `resume` for the thread when it changes. */
  watch(thread: Thread): void;
  unwatch(runId: string): void;
  log: { warn(...args: unknown[]): void };
}

// ── Words ─────────────────────────────────────────────────────────────────────

const texts = {
  de: {
    nothing: "Hier ist noch kein Wizard verbunden.",
    which: "Welcher Wizard soll es sein?",
    choose: "Auswählen",
    over: "Dieser Lauf ist beendet. Mit dem Stichwort startest du einen neuen.",
    stopped: "Abgebrochen. Mit dem Stichwort startest du einen neuen Lauf.",
    optional: "(freiwillig – mit „weiter“ überspringst du es)",
    pickOne: "Wähl eine der Möglichkeiten.",
    picked: "Gewählt: {list}",
    more: "Noch etwas?",
    done: "Fertig",
    yes: "Ja",
    no: "Nein",
    yesOrNo: "Antworte mit Ja oder Nein.",
    asText: "Antworte mit einem Text.",
    asDate: "Schick ein Datum, zum Beispiel 24.12.2026.",
    sendPhoto: "Schick ein Foto.",
    sendFile: "Schick eine Datei.",
    sendVoice: "Schick eine Sprachnachricht.",
    another: "Noch eins",
    whereAre: "Teil deinen Standort oder schreib die Adresse.",
    needed: "Dafür brauche ich eine Antwort.",
    screen: "Dieser Teil braucht einen Bildschirm. Danach geht es hier weiter.",
    open: "Öffnen",
    working: "{step} – das dauert einen Moment.",
    reviewAsk: "Passt das so?",
    reviewOk: "Passt",
    reviewRedo: "Neue Version",
    reviewWhich: "Was soll neu gemacht werden?",
    reviewNote: "Was soll anders sein?",
    allow: "Erlauben",
    skip: "Überspringen",
    finished: "Fertig. Alles liegt hier:",
    failed: "Der Wizard ist stehen geblieben. Hier geht es weiter:",
  },
  en: {
    nothing: "No wizard is connected here yet.",
    which: "Which wizard?",
    choose: "Choose",
    over: "This run is over. Send the keyword to start a new one.",
    stopped: "Stopped. Send the keyword to start a new run.",
    optional: "(optional – reply “skip” to leave it out)",
    pickOne: "Choose one of the options.",
    picked: "Chosen: {list}",
    more: "Anything else?",
    done: "Done",
    yes: "Yes",
    no: "No",
    yesOrNo: "Answer yes or no.",
    asText: "Reply with text.",
    asDate: "Send a date, for example 24/12/2026.",
    sendPhoto: "Send a photo.",
    sendFile: "Send a file.",
    sendVoice: "Send a voice message.",
    another: "One more",
    whereAre: "Share your location or type the address.",
    needed: "I need an answer for this one.",
    screen: "This part needs a screen. You carry on here afterwards.",
    open: "Open",
    working: "{step} – this takes a moment.",
    reviewAsk: "Is this right?",
    reviewOk: "Looks good",
    reviewRedo: "New version",
    reviewWhich: "What should be redone?",
    reviewNote: "What should be different?",
    allow: "Allow",
    skip: "Skip",
    finished: "Done. Everything is here:",
    failed: "The wizard stopped. You can carry on here:",
  },
} as const;

type Key = keyof (typeof texts)["de"];

function say(lang: ThreadLang, key: Key, vars: Record<string, string | number> = {}): string {
  let text: string = texts[lang][key];
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

const SKIP_WORDS = new Set(["weiter", "skip", "-", "überspringen", "keine", "none"]);
const DONE_WORDS = new Set(["fertig", "done", "ok", "passt", "das wars", "that's it"]);
const STOP_WORDS = new Set(["stop", "stopp", "abbrechen", "cancel", "abbruch", "ende"]);
const YES_WORDS = new Set(["ja", "yes", "y", "j", "jo", "klar", "yep", "true", "✓"]);
const NO_WORDS = new Set(["nein", "no", "n", "nö", "nope", "false"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

type PageWaiting = Extract<PluginRunWaiting, { page: string }>;
type ReviewWaiting = Extract<PluginRunWaiting, { review: string }>;
type AskWaiting = Extract<PluginRunWaiting, { ask: string }>;

type Taken = { kind: "value"; value: unknown } | { kind: "again"; hint: string } | { kind: "wait" };

const shownOf = (w: PageWaiting) => w.fields.filter((f) => f.shown !== false);

/** `24.12.2026`, `24/12/26` or an ISO date, as the page's date input gives it. */
export function toIso(text: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }
  const dmy = text.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
  if (!dmy) {
    return null;
  }
  const [, d, m, y] = dmy;
  const year = y.length === 2 ? `20${y}` : y;
  const date = new Date(Number(year), Number(m) - 1, Number(d));
  if (date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) {
    return null;
  }
  return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/** Cut to a length, with an ellipsis where something was cut. */
export function clipText(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const extOf = (mime: string) =>
  ({
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "application/pdf": "pdf",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "video/mp4": "mp4",
  })[mime] ?? "bin";

/** Which option a reply means: a tap on `o:<i>`, a number, or the option's own words. */
function optionIndex(msg: ThreadInbound, options: string[]): number {
  if (msg.replyId?.startsWith("o:")) {
    const i = Number(msg.replyId.slice(2));
    return Number.isInteger(i) && options[i] !== undefined ? i : -1;
  }
  const text = (msg.text ?? "").trim();
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n >= 1 && n <= options.length ? n - 1 : -1;
  }
  const lower = text.toLowerCase();
  return options.findIndex((o) => o.toLowerCase() === lower);
}

const mediaOf = (mime: string): "image" | "document" | "video" | "audio" | null =>
  mime.startsWith("image/")
    ? "image"
    : mime === "application/pdf"
      ? "document"
      : mime.startsWith("video/")
        ? "video"
        : mime.startsWith("audio/")
          ? "audio"
          : null;

// ── The door ──────────────────────────────────────────────────────────────────

export class ThreadDoor {
  private readonly asks: Set<string>;

  constructor(private readonly o: ThreadDoorOptions) {
    this.asks = new Set(o.surface.asks);
  }

  /** A message of the person arrived. The caller keeps the thread before and after. */
  async inbound(thread: Thread, given: ThreadInbound): Promise<void> {
    const msg = this.asTap(thread, given);
    const text = (msg.text ?? "").trim();
    const lower = text.toLowerCase();
    const offered = await this.o.offered();
    // A keyword starts its wizard, from anywhere in the thread; so does a pick from the menu.
    const picked =
      (lower ? offered.find((w) => w.keyword.toLowerCase() === lower) : undefined) ??
      (msg.replyId?.startsWith("w:")
        ? offered.find((w) => `w:${w.wizardId}` === msg.replyId)
        : undefined);
    if (picked) {
      await this.start(thread, picked);
      return;
    }
    if (STOP_WORDS.has(lower)) {
      await this.stop(thread);
      return;
    }
    if (!thread.runId) {
      await this.menu(thread, offered);
      return;
    }
    const report = await this.report(thread);
    if (!report) {
      thread.runId = null;
      await this.menu(thread, offered);
      return;
    }
    await this.step(thread, report, msg);
  }

  /** The run changed while nobody wrote: a step ended, the page was filled on the screen. */
  async resume(thread: Thread): Promise<void> {
    if (!thread.runId) {
      return;
    }
    const report = await this.report(thread);
    if (report) {
      await this.step(thread, report, null);
    }
  }

  /** A typed number or the words of an option of the last question count as a tap on it. */
  private asTap(thread: Thread, msg: ThreadInbound): ThreadInbound {
    const choices = thread.state.choices;
    if (msg.replyId || msg.kind !== "text" || !choices?.length) {
      return msg;
    }
    const text = (msg.text ?? "").trim();
    const hit = /^\d+$/.test(text)
      ? choices[Number(text) - 1]
      : choices.find((c) => c.title.replace(/^✓ /, "").toLowerCase() === text.toLowerCase());
    return hit ? { ...msg, kind: "reply", replyId: hit.id, replyTitle: hit.title } : msg;
  }

  // ── Runs ───────────────────────────────────────────────────────────────────

  private async report(thread: Thread, waitSeconds = 0): Promise<PluginRunReport | null> {
    if (!thread.runId) {
      return null;
    }
    try {
      return await this.o.runs.report(thread.runId, {
        waitSeconds,
        draft: thread.state.page?.values,
      });
    } catch (err) {
      if ((err as { code?: string }).code === "not_found") {
        return null;
      }
      throw err;
    }
  }

  private async start(thread: Thread, wizard: ThreadWizard): Promise<void> {
    if (thread.runId) {
      this.o.unwatch(thread.runId);
    }
    thread.state = { ...freshThreadState(wizard.lang), wizardId: wizard.wizardId };
    try {
      const { runId } = await this.o.runs.start({
        token: wizard.token,
        person: { channel: this.o.surface.runner, id: thread.id },
        runner: this.o.surface.runner,
      });
      thread.runId = runId;
    } catch (err) {
      thread.runId = null;
      await this.send(thread, { kind: "text", text: (err as Error).message });
      return;
    }
    const report = await this.report(thread, 10);
    if (report) {
      await this.step(thread, report, null);
    }
  }

  private async stop(thread: Thread): Promise<void> {
    if (thread.runId) {
      this.o.unwatch(thread.runId);
      await this.o.runs.control(thread.runId, "cancel").catch(() => undefined);
      thread.runId = null;
    }
    thread.state = freshThreadState(thread.state.lang);
    await this.send(thread, { kind: "text", text: say(thread.state.lang, "stopped") });
  }

  private async menu(thread: Thread, offered: ThreadWizard[]): Promise<void> {
    // Before a wizard is picked, the thread speaks the wizards' language where they share one.
    const spoken = new Set(offered.map((w) => w.lang));
    if (spoken.size === 1) {
      thread.state.lang = offered[0].lang;
    }
    const lang = thread.state.lang;
    if (!offered.length) {
      await this.send(thread, { kind: "text", text: say(lang, "nothing") });
      return;
    }
    if (offered.length === 1) {
      await this.start(thread, offered[0]);
      return;
    }
    await this.send(thread, {
      kind: "choice",
      text: say(lang, "which"),
      button: say(lang, "choose"),
      options: offered.slice(0, 10).map((w) => ({ id: `w:${w.wizardId}`, title: w.title })),
    });
  }

  /** Where the run stands, and what to do about it. `msg`: what the person just sent, if anything. */
  private async step(
    thread: Thread,
    report: PluginRunReport,
    msg: ThreadInbound | null,
  ): Promise<void> {
    const s = thread.state;
    const runId = thread.runId!;
    if (report.status === "done") {
      if (s.delivered) {
        if (msg) {
          await this.send(thread, { kind: "text", text: say(s.lang, "over") });
        }
        return;
      }
      await this.deliver(thread, report);
      return;
    }
    if (report.status === "failed" || report.status === "cancelled") {
      this.o.unwatch(runId);
      thread.runId = null;
      if (report.status === "failed") {
        const url = await this.o.runs.handoffUrl(runId).catch(() => report.browserUrl);
        await this.send(
          thread,
          url
            ? { kind: "link", text: say(s.lang, "failed"), url, label: say(s.lang, "open") }
            : { kind: "text", text: say(s.lang, "failed") },
        );
      } else {
        await this.send(thread, { kind: "text", text: say(s.lang, "stopped") });
      }
      return;
    }
    const w = report.waitingFor;
    if (!w) {
      // The wizard works: said once, then the thread waits for the run to change.
      const key = `working:${report.step?.id ?? ""}`;
      if (s.said !== key) {
        s.said = key;
        await this.send(thread, {
          kind: "text",
          text: say(s.lang, "working", { step: report.step?.title ?? "…" }),
        });
      }
      this.o.watch(thread);
      return;
    }
    if ("page" in w) {
      await this.page(thread, w, msg);
    } else if ("review" in w) {
      await this.review(thread, report, w, msg);
    } else {
      await this.ask(thread, w, msg);
    }
  }

  /** The run moved on after a command: wait a little for it, then look again. */
  private async after(thread: Thread): Promise<void> {
    const report = await this.report(thread, 25);
    if (report) {
      await this.step(thread, report, null);
    }
  }

  // ── A page ─────────────────────────────────────────────────────────────────

  private async page(thread: Thread, waiting: PageWaiting, msg: ThreadInbound | null) {
    const s = thread.state;
    let w = waiting;
    if (!s.page || s.page.step !== w.page) {
      s.page = { step: w.page, values: {}, asking: null, picks: [], files: [] };
    }
    const page = s.page;
    let fields = shownOf(w);
    // A field only the screen can take (a signature, a sign-in): the whole page goes there.
    if (fields.some((f) => !this.asks.has(f.kind))) {
      const key = `screen:${w.page}`;
      if (s.said !== key || msg) {
        s.said = key;
        await this.handoff(thread);
      }
      this.o.watch(thread);
      return;
    }
    if (msg && page.asking) {
      const field = fields.find((f) => f.id === page.asking);
      if (field) {
        const taken = await this.take(thread, field, msg);
        if (taken.kind === "again") {
          await this.askField(thread, field, taken.hint);
          return;
        }
        if (taken.kind === "wait") {
          return;
        }
        page.values[field.id] = taken.value;
        page.asking = null;
        page.picks = [];
        page.files = [];
        s.choices = null;
        // A later field's condition may read this answer: the page is read again with it.
        const again = await this.report(thread);
        if (!again) {
          return;
        }
        if (
          !again.waitingFor ||
          !("page" in again.waitingFor) ||
          again.waitingFor.page !== w.page
        ) {
          await this.step(thread, again, null);
          return;
        }
        w = again.waitingFor;
        fields = shownOf(w);
      }
    }
    const next = fields.find((f) => !(f.id in page.values));
    if (next) {
      page.asking = next.id;
      await this.askField(thread, next);
      return;
    }
    // Every field has its answer: the page is sent.
    try {
      await this.o.runs.answerPage(thread.runId!, w.page, page.values);
    } catch (err) {
      const wrong = (
        (err as { data?: { fields?: { field: string; message: string }[] } }).data?.fields ?? []
      ).find((e) => e.field in page.values);
      const field = wrong ? fields.find((f) => f.id === wrong.field) : undefined;
      if (wrong && field) {
        delete page.values[wrong.field];
        page.asking = wrong.field;
        await this.askField(thread, field, wrong.message);
        return;
      }
      await this.send(thread, { kind: "text", text: (err as Error).message });
      return;
    }
    s.page = null;
    s.said = null;
    await this.after(thread);
  }

  /** The question for a field, with the options it takes. `hint` first: what was wrong. */
  private async askField(thread: Thread, field: PluginRunField, hint?: string): Promise<void> {
    const { lang } = thread.state;
    const page = thread.state.page!;
    const lines = [field.label, field.help].filter((x): x is string => Boolean(x));
    if (!field.required && field.kind !== "toggle") {
      lines.push(say(lang, "optional"));
    }
    if (field.kind === "date") {
      lines.push(say(lang, "asDate"));
    }
    const text = [hint, lines.join("\n")].filter(Boolean).join("\n\n");
    const options = field.options ?? [];
    switch (field.kind) {
      case "select":
        return this.send(thread, {
          kind: "choice",
          text,
          button: say(lang, "choose"),
          options: options.map((o, i) => ({ id: `o:${i}`, title: o })),
        });
      case "multiselect": {
        const picked = page.picks.length
          ? `\n\n${say(lang, "picked", { list: page.picks.join(", ") })}`
          : "";
        return this.send(thread, {
          kind: "choice",
          text: `${page.picks.length ? say(lang, "more") : text}${picked}`,
          button: say(lang, "choose"),
          multiple: true,
          options: [
            ...options.map((o, i) => ({ id: `o:${i}`, title: o, picked: page.picks.includes(o) })),
            ...(page.picks.length ? [{ id: "done", title: `✓ ${say(lang, "done")}` }] : []),
          ],
        });
      }
      case "toggle":
        return this.send(thread, {
          kind: "choice",
          text,
          button: say(lang, "choose"),
          options: [
            { id: "t:1", title: say(lang, "yes") },
            { id: "t:0", title: say(lang, "no") },
          ],
        });
      case "image":
      case "file": {
        const ask = say(lang, field.kind === "image" ? "sendPhoto" : "sendFile");
        if (page.files.length) {
          return this.send(thread, {
            kind: "choice",
            text: `${say(lang, "more")} (${page.files.length})`,
            button: say(lang, "choose"),
            options: [
              { id: "f:more", title: say(lang, "another") },
              { id: "f:done", title: say(lang, "done") },
            ],
          });
        }
        return this.send(thread, { kind: "text", text: `${text}\n${ask}` });
      }
      case "audio":
        return this.send(thread, { kind: "text", text: `${text}\n${say(lang, "sendVoice")}` });
      case "location":
        return this.send(thread, {
          kind: "location",
          text: `${text}\n${say(lang, "whereAre")}`,
        });
      default:
        return this.send(thread, { kind: "text", text });
    }
  }

  /** What the message means for the field: its value, a second try with a hint, or more to come. */
  private async take(thread: Thread, field: PluginRunField, msg: ThreadInbound): Promise<Taken> {
    const { lang } = thread.state;
    const page = thread.state.page!;
    const text = (msg.text ?? "").trim();
    const lower = text.toLowerCase();
    const typed = msg.kind === "text" || msg.kind === "reply";
    if (!field.required && typed && SKIP_WORDS.has(lower)) {
      return { kind: "value", value: null };
    }
    const again = (hint: Key): Taken => ({ kind: "again", hint: say(lang, hint) });
    switch (field.kind) {
      case "text":
      case "textarea":
      case "email":
      case "url":
      case "number": {
        if (msg.kind === "audio" && msg.media) {
          const said = await this.transcribe(thread, msg);
          return said ? { kind: "value", value: said } : again("asText");
        }
        return typed && text ? { kind: "value", value: text } : again("asText");
      }
      case "date": {
        const iso = typed ? toIso(text) : null;
        return iso ? { kind: "value", value: iso } : again("asDate");
      }
      case "select": {
        const i = optionIndex(msg, field.options ?? []);
        return i >= 0 ? { kind: "value", value: field.options?.[i] } : again("pickOne");
      }
      case "multiselect": {
        const options = field.options ?? [];
        if (msg.replyId === "done" || (typed && DONE_WORDS.has(lower))) {
          if (!page.picks.length && field.required) {
            return again("needed");
          }
          return { kind: "value", value: [...page.picks] };
        }
        if (msg.replyId?.startsWith("o:")) {
          const i = optionIndex(msg, options);
          if (i >= 0 && !page.picks.includes(options[i])) {
            page.picks.push(options[i]);
          }
          if (page.picks.length >= options.length) {
            return { kind: "value", value: [...page.picks] };
          }
          await this.askField(thread, field);
          return { kind: "wait" };
        }
        if (typed && text) {
          const chosen = text
            .split(/[,;\n]+/)
            .map((part) => part.trim())
            .map((part) => {
              const n = Number(part);
              return Number.isInteger(n) && n >= 1 && n <= options.length
                ? options[n - 1]
                : options.find((o) => o.toLowerCase() === part.toLowerCase());
            })
            .filter((o): o is string => Boolean(o));
          if (chosen.length) {
            return { kind: "value", value: [...new Set([...page.picks, ...chosen])] };
          }
        }
        return again("pickOne");
      }
      case "toggle": {
        if (msg.replyId === "t:1" || YES_WORDS.has(lower)) {
          return { kind: "value", value: true };
        }
        if (msg.replyId === "t:0" || NO_WORDS.has(lower)) {
          return { kind: "value", value: false };
        }
        return again("yesOrNo");
      }
      case "image":
      case "file": {
        const ask = field.kind === "image" ? "sendPhoto" : "sendFile";
        if (msg.replyId === "f:done" || (typed && DONE_WORDS.has(lower))) {
          return page.files.length
            ? { kind: "value", value: field.multiple ? [...page.files] : page.files[0] }
            : again(ask);
        }
        if (msg.replyId === "f:more") {
          await this.send(thread, { kind: "text", text: say(lang, ask) });
          return { kind: "wait" };
        }
        const fits =
          field.kind === "image"
            ? msg.kind === "image"
            : msg.kind === "image" ||
              msg.kind === "document" ||
              msg.kind === "video" ||
              msg.kind === "audio";
        if (fits && msg.media && this.o.surface.media) {
          const { assetId } = await this.upload(thread, msg);
          if (!field.multiple) {
            return { kind: "value", value: assetId };
          }
          page.files.push(assetId);
          await this.askField(thread, field);
          return { kind: "wait" };
        }
        return again(ask);
      }
      case "audio": {
        if (msg.kind === "audio" && msg.media && this.o.surface.media) {
          const { assetId } = await this.upload(thread, msg);
          return { kind: "value", value: { asset: assetId } };
        }
        return again("sendVoice");
      }
      case "location": {
        if (msg.location) {
          const label = [msg.location.name, msg.location.address].filter(Boolean).join(", ");
          return {
            kind: "value",
            value: { lat: msg.location.lat, lng: msg.location.lng, ...(label ? { label } : {}) },
          };
        }
        return typed && text ? { kind: "value", value: { label: text } } : again("whereAre");
      }
      default:
        return again("asText");
    }
  }

  private async upload(thread: Thread, msg: ThreadInbound): Promise<{ assetId: string }> {
    const ref = msg.media!;
    const file = await this.o.surface.media!(ref);
    return this.o.runs.upload(thread.runId!, {
      data: file.data,
      mime: file.mime,
      name: ref.filename ?? `${this.o.surface.runner}-${ref.id.slice(-8)}.${extOf(file.mime)}`,
    });
  }

  private async transcribe(thread: Thread, msg: ThreadInbound): Promise<string | null> {
    if (!this.o.surface.media) {
      return null;
    }
    try {
      const file = await this.o.surface.media(msg.media!);
      const { text } = await this.o.runs.transcribe(thread.runId!, file);
      return text.trim() || null;
    } catch (err) {
      this.o.log.warn("a voice message could not be written down:", (err as Error).message);
      return null;
    }
  }

  // ── A review, a question ───────────────────────────────────────────────────

  private async review(
    thread: Thread,
    report: PluginRunReport,
    w: ReviewWaiting,
    msg: ThreadInbound | null,
  ): Promise<void> {
    const s = thread.state;
    const runId = thread.runId!;
    if (msg?.replyId === "r:ok") {
      await this.o.runs.review(runId, w.review, { type: "accept" });
      s.said = null;
      s.awaiting = null;
      await this.after(thread);
      return;
    }
    if (msg?.replyId === "r:redo") {
      if (w.show.length > 1) {
        s.awaiting = "target";
        await this.send(thread, {
          kind: "choice",
          text: say(s.lang, "reviewWhich"),
          button: say(s.lang, "choose"),
          options: w.show.map((id) => ({
            id: `r:t:${id}`,
            title: report.outputs.find((o) => o.stepId === id)?.title ?? id,
          })),
        });
        return;
      }
      s.target = w.show[0] ?? null;
      s.awaiting = "note";
      await this.send(thread, { kind: "text", text: say(s.lang, "reviewNote") });
      return;
    }
    if (s.awaiting === "target" && msg?.replyId?.startsWith("r:t:")) {
      s.target = msg.replyId.slice("r:t:".length);
      s.awaiting = "note";
      await this.send(thread, { kind: "text", text: say(s.lang, "reviewNote") });
      return;
    }
    if (s.awaiting === "note" && msg?.text?.trim() && s.target) {
      await this.o.runs.review(runId, w.review, {
        type: "regenerate",
        target: s.target,
        note: msg.text.trim(),
      });
      s.awaiting = null;
      s.said = null;
      await this.after(thread);
      return;
    }
    const key = `review:${w.review}`;
    const fresh = s.said !== key;
    if (fresh) {
      s.said = key;
      for (const output of report.outputs.filter((o) => w.show.includes(o.stepId))) {
        await this.sendOutput(thread, output);
      }
    }
    if (fresh || msg) {
      await this.send(thread, {
        kind: "choice",
        text: say(s.lang, "reviewAsk"),
        button: say(s.lang, "choose"),
        options: [
          { id: "r:ok", title: say(s.lang, "reviewOk") },
          { id: "r:redo", title: say(s.lang, "reviewRedo") },
        ],
      });
    }
  }

  private async ask(thread: Thread, w: AskWaiting, msg: ThreadInbound | null): Promise<void> {
    const s = thread.state;
    if (w.kind === "login") {
      const key = `login:${w.ask}`;
      if (s.said !== key) {
        s.said = key;
        await this.handoff(thread);
      }
      this.o.watch(thread);
      return;
    }
    if (msg?.replyId === "a:allow" || msg?.replyId === "a:skip") {
      await this.o.runs.answerAsk(
        thread.runId!,
        w.ask,
        msg.replyId === "a:allow" ? "allow" : "skip",
      );
      s.said = null;
      await this.after(thread);
      return;
    }
    const key = `ask:${w.ask}`;
    if (s.said !== key || msg) {
      s.said = key;
      await this.send(thread, {
        kind: "choice",
        text: [w.reason, w.action, w.input ? clipText(w.input, 600) : ""]
          .filter(Boolean)
          .join("\n"),
        button: say(s.lang, "choose"),
        options: [
          { id: "a:allow", title: say(s.lang, "allow") },
          { id: "a:skip", title: say(s.lang, "skip") },
        ],
      });
    }
  }

  // ── What goes out ──────────────────────────────────────────────────────────

  /** The link to the run page, for what the thread cannot do. */
  private async handoff(thread: Thread): Promise<void> {
    const url = await this.o.runs.handoffUrl(thread.runId!);
    await this.send(thread, {
      kind: "link",
      text: say(thread.state.lang, "screen"),
      url,
      label: say(thread.state.lang, "open"),
    });
  }

  /** One output as a thread can carry it: text, pictures, documents, the picture of a widget. */
  private async sendOutput(
    thread: Thread,
    output: PluginRunReport["outputs"][number],
  ): Promise<void> {
    const parts: ThreadPrompt[] = [];
    if (output.text) {
      parts.push({ kind: "text", text: `*${output.title}*\n${output.text}` });
    }
    let picture = false;
    let pdf = false;
    for (const a of output.assets) {
      const media = mediaOf(a.mime);
      if (!media) {
        continue;
      }
      parts.push({ kind: "media", media, url: a.url, caption: output.title, filename: a.name });
      picture ||= media === "image";
      pdf ||= media === "document";
    }
    if (!picture && output.picture) {
      parts.push({ kind: "media", media: "image", url: output.picture, caption: output.title });
    }
    if (!pdf && output.downloads.pdf) {
      parts.push({
        kind: "media",
        media: "document",
        url: output.downloads.pdf,
        caption: output.title,
        filename: `${output.title}.pdf`,
      });
    }
    if (!parts.length && output.json) {
      parts.push({ kind: "text", text: `*${output.title}*\n${clipText(output.json, 3000)}` });
    }
    for (const part of parts) {
      await this.send(thread, part);
    }
  }

  /** The run reached its end: what it made, then the link to all of it. */
  private async deliver(thread: Thread, report: PluginRunReport): Promise<void> {
    const s = thread.state;
    const runId = thread.runId!;
    this.o.unwatch(runId);
    const url = await this.o.runs.handoffUrl(runId);
    if (this.o.surface.mayDeliver && !this.o.surface.mayDeliver(thread)) {
      // The channel does not take a free message now: the link by other means, or nothing.
      if (this.o.surface.reach && (await this.o.surface.reach(thread, url))) {
        s.delivered = true;
      } else {
        this.o.log.warn(`run ${runId} is done, but the thread takes no message now: nothing sent`);
      }
      return;
    }
    const listed = report.outputs.filter((o) => Object.keys(o.downloads).length);
    for (const output of listed.length ? listed : report.outputs) {
      await this.sendOutput(thread, output);
    }
    await this.send(thread, {
      kind: "link",
      text: say(s.lang, "finished"),
      url,
      label: say(s.lang, "open"),
    });
    s.delivered = true;
  }

  private async send(thread: Thread, prompt: ThreadPrompt): Promise<void> {
    // The last question's options are what a typed number means next.
    thread.state.choices = prompt.kind === "choice" ? prompt.options : null;
    await this.o.surface.send(thread, prompt);
  }
}
