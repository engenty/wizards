// The setup's words. Wording: docs/copy-style.md; `pnpm copy:check` reads them.

const en = {
  "harness.appHere": "The {app} app is on this computer: {name} signs in with the same {sub}.",
  "harness.authKey":
    "Signed in with an API key from your shell, not the subscription. Sign in here so it runs on your {sub}.",
  "harness.authNone": "Not signed in yet.",
  "harness.authSubscription": "Signed in with your {sub}.",
  "harness.found": "{name} {version} found",
  "harness.hint":
    "Text runs on {name} on this computer, using your {sub}. No key needed. Images, video and audio still need a key.",
  "harness.hintImages":
    "Text and images run on {name} on this computer, using your {sub}. No key needed. Video and audio still need a key.",
  "harness.install": "Or in your own terminal:",
  "harness.installButton": "Install {name}",
  "harness.installEnded":
    "The installation ended, but {name} isn’t there. The output above says why.",
  "harness.installing":
    "{name} is installing in the terminal below – it takes about a minute. Then you sign in.",
  "harness.loginEnded": "The sign-in ended, but {name} isn’t signed in. Try again.",
  "harness.missing": "{name} isn’t installed on this computer.",
  "harness.notInstalled": "not installed",
  "harness.ready": "signed in",
  "harness.signIn": "Sign in here",
  "harness.signInInteractive":
    "{name} starts below. Choose to sign in with your {sub} there, then finish in the browser. The terminal closes once you’re signed in.",
  "harness.signingIn":
    "The sign-in runs in the terminal below – your browser opens for it. The terminal closes once you’re signed in.",
  "harness.sub.claude": "Claude subscription",
  "harness.sub.codex": "ChatGPT subscription",
  "harness.sub.antigravity": "Google AI subscription",
  "harness.sub.cursor": "Cursor subscription",
  "harness.desc.claude": "On your Claude subscription – no key needed.",
  "harness.desc.codex": "On your ChatGPT subscription – no key needed.",
  "harness.desc.antigravity": "On your Google AI subscription – no key needed.",
  "harness.desc.cursor": "On your Cursor subscription – no key needed.",
  "local.keyGet": "Get a key",
  "local.keyRemove": "Delete",
  "local.keySet": "stored",
  "local.keyWorks": "Works. Your wizards write with {model}.",
  "local.keyWorksOther": "Works. Your wizards keep writing with {model}.",
  "local.keyWorksPlain": "Works.",
  "local.keys": "Keys",
  "local.keysHint":
    "One key is enough. Test checks it with the provider. Keys stay in this computer’s keychain, never in the database.",
  "local.modelsLater": "Which model does which job can be changed later under Settings → Models.",
  "local.ollamaWhere": "on this computer",
  "local.recheck": "Check again",
  "local.sourceOwn": "Your own keys",
  "local.test": "Test",
  "local.testFailed": "The test didn’t work: {error}",
  "local.testHint": "One short call checks that the model can be reached.",
  "local.testOk": "Answered in {s} s on {ref}: “{reply}”",
  "setup.h.done": "Connected.",
  "setup.h.install": "Install {name}",
  "setup.h.keys": "Enter a key",
  "setup.h.signIn": "Sign in to {name}",
  "setup.h.test": "One short test",
  "setup.noHarness":
    "No AI client is installed yet. Choose one and it installs right here, or enter your own keys.",
  "setup.ready": "All set.",
  "setup.recommended": "Recommended",
  "setup.stage.connect": "Connect",
  "setup.stage.done": "Done",
  "setup.stage.test": "Test",
  "setup.back": "Back",
  "setup.cancel": "Cancel",
  "setup.close": "Close",
  "setup.keyBad": "The key wasn’t accepted. Check it and try again.",
};

/** A word of the setup. */
export type SetupText = keyof typeof en;

const de: Record<SetupText, string> = {
  "harness.appHere":
    "Die {app}-App ist auf diesem Computer: {name} meldet sich mit demselben {sub} an.",
  "harness.authKey":
    "Angemeldet mit einem API-Key aus deiner Shell, nicht mit dem Abo. Melde dich hier an, damit es über dein {sub} läuft.",
  "harness.authNone": "Noch nicht angemeldet.",
  "harness.authSubscription": "Angemeldet mit deinem {sub}.",
  "harness.found": "{name} {version} gefunden",
  "harness.hint":
    "Texte schreibt {name} auf diesem Computer, mit deinem {sub}. Kein API-Key nötig. Bilder, Videos und Audio brauchen weiter einen API-Key.",
  "harness.hintImages":
    "Texte und Bilder erzeugt {name} auf diesem Computer, mit deinem {sub}. Kein API-Key nötig. Videos und Audio brauchen weiter einen API-Key.",
  "harness.install": "Oder in deinem eigenen Terminal:",
  "harness.installButton": "{name} installieren",
  "harness.installEnded":
    "Die Installation ist fertig, aber {name} ist nicht da. Warum, steht oben.",
  "harness.installing":
    "{name} wird im Terminal unten installiert – das dauert etwa eine Minute. Danach meldest du es an.",
  "harness.loginEnded": "Die Anmeldung wurde beendet, ohne dass {name} angemeldet ist.",
  "harness.missing": "{name} ist auf diesem Computer nicht installiert.",
  "harness.notInstalled": "nicht installiert",
  "harness.ready": "angemeldet",
  "harness.signIn": "Hier anmelden",
  "harness.signInInteractive":
    "Unten startet {name}. Wähle dort die Anmeldung mit deinem {sub} und melde dich im Browser an. Das Terminal schließt sich, sobald die Anmeldung da ist.",
  "harness.signingIn":
    "Die Anmeldung läuft im Terminal unten – dein Browser öffnet sich dafür. Das Terminal schließt sich, sobald die Anmeldung da ist.",
  "harness.sub.claude": "Claude-Abo",
  "harness.sub.codex": "ChatGPT-Abo",
  "harness.sub.antigravity": "Google-AI-Abo",
  "harness.sub.cursor": "Cursor-Abo",
  "harness.desc.claude": "Mit deinem Claude-Abo – kein API-Key nötig.",
  "harness.desc.codex": "Mit deinem ChatGPT-Abo – kein API-Key nötig.",
  "harness.desc.antigravity": "Mit deinem Google-AI-Abo – kein API-Key nötig.",
  "harness.desc.cursor": "Mit deinem Cursor-Abo – kein API-Key nötig.",
  "local.keyGet": "Key holen",
  "local.keyRemove": "Entfernen",
  "local.keySet": "hinterlegt",
  "local.keyWorks": "Funktioniert. Deine Wizards schreiben mit {model}.",
  "local.keyWorksOther": "Funktioniert. Deine Wizards schreiben weiter mit {model}.",
  "local.keyWorksPlain": "Funktioniert.",
  "local.keys": "API-Keys",
  "local.keysHint":
    "Ein API-Key reicht. Testen prüft ihn beim Anbieter. Die Keys liegen im Schlüsselbund dieses Geräts, nie in der Datenbank.",
  "local.modelsLater":
    "Welches Modell was übernimmt, lässt sich später unter Einstellungen → Modelle ändern.",
  "local.ollamaWhere": "auf diesem Computer",
  "local.recheck": "Erneut prüfen",
  "local.sourceOwn": "Eigene API-Keys",
  "local.test": "Testen",
  "local.testFailed": "Der Test hat nicht geklappt: {error}",
  "local.testHint": "Ein kurzer Aufruf prüft, ob das Modell erreichbar ist.",
  "local.testOk": "Antwort in {s} s über {ref}: „{reply}“",
  "setup.h.done": "Verbunden",
  "setup.h.install": "{name} installieren",
  "setup.h.keys": "API-Key eintragen",
  "setup.h.signIn": "{name} anmelden",
  "setup.h.test": "Ein kurzer Test",
  "setup.noHarness":
    "Noch kein KI-Client installiert. Wähle einen aus – er wird dann hier installiert. Oder trage eigene API-Keys ein.",
  "setup.ready": "Alles bereit.",
  "setup.recommended": "Empfohlen",
  "setup.stage.connect": "Verbinden",
  "setup.stage.done": "Fertig",
  "setup.stage.test": "Testen",
  "setup.back": "Zurück",
  "setup.cancel": "Abbrechen",
  "setup.close": "Schließen",
  "setup.keyBad": "Der Key wurde nicht angenommen.",
};

/** The setup's words; a host may spread them into a dictionary of its own. */
export const SETUP_TEXTS = { en, de };

export type SetupVars = Record<string, string | number>;

/** A word in a language, its gaps filled. */
export function setupText(lang: "en" | "de", key: SetupText, vars?: SetupVars): string {
  const line = SETUP_TEXTS[lang][key];
  return vars
    ? line.replace(/\{(\w+)\}/g, (whole, name: string) => String(vars[name] ?? whole))
    : line;
}
