import { validateSurface } from "@engenty/wizards-shared/surface";
import { useEffect, useMemo, useState } from "react";
import { ChatViewPart, ViewContext, type ViewHost } from "../studio/work/View";

/**
 * Views as the space's AI shows them in a Work chat (`show_view`): the same catalog as a wizard's,
 * with what only a chat has: a Form, Refs, a button that asks. Its files are made here (a PDF, a
 * picture, a recording), as a chat would read them from the space's files.
 */

const invoices = {
  title: "Offene Rechnungen",
  data: {
    open: 6,
    sum: "€ 14.380",
    late: 2,
    rows: [
      {
        client: "Hofer Bau",
        no: "2026-118",
        due: "12.10.",
        amount: "€ 4.200",
        state: "überfällig",
      },
      {
        client: "Studio Lind",
        no: "2026-121",
        due: "20.10.",
        amount: "€ 980",
        state: "überfällig",
      },
      { client: "Kranz & Söhne", no: "2026-124", due: "04.11.", amount: "€ 3.150", state: "offen" },
      {
        client: "Weingut Pichler",
        no: "2026-126",
        due: "08.11.",
        amount: "€ 2.400",
        state: "offen",
      },
    ],
    found: [{ title: "Rechnungen 2026", open: "t:invoices" }],
  },
  components: [
    { id: "root", component: "Column", children: ["figs", "list", "src", "acts"] },
    { id: "figs", component: "Grid", columns: 3, children: ["m1", "m2", "m3"] },
    { id: "m1", component: "Metric", label: "Offen", value: { path: "/open" } },
    { id: "m2", component: "Metric", label: "Summe", value: { path: "/sum" } },
    { id: "m3", component: "Metric", label: "Überfällig", value: { path: "/late" } },
    {
      id: "list",
      component: "Table",
      rows: { path: "/rows" },
      columns: [
        { key: "client", label: "Kunde" },
        { key: "no", label: "Nr." },
        { key: "due", label: "Fällig" },
        { key: "amount", label: "Betrag" },
        { key: "state", label: "Stand" },
      ],
    },
    { id: "src", component: "Sources", items: { path: "/found" } },
    { id: "acts", component: "Actions", children: ["b1"] },
    {
      id: "b1",
      component: "Button",
      label: "Mahnung für die überfälligen",
      action: "ask",
      prompt: "Schreib eine Mahnung für die beiden überfälligen Rechnungen.",
    },
  ],
};

const meeting = {
  title: "Termin mit Hofer Bau",
  data: {},
  components: [
    { id: "root", component: "Column", children: ["intro", "form"] },
    {
      id: "intro",
      component: "Text",
      variant: "muted",
      text: "Vorausgefüllt aus dem Chat. Wer im Chat ist, kann absenden.",
    },
    {
      id: "form",
      component: "Form",
      submit: "Termin anlegen",
      children: ["day", "with", "how", "where", "note", "photo", "sign"],
    },
    {
      id: "day",
      component: "Field",
      name: "day",
      kind: "date",
      label: "Tag",
      required: true,
      value: "2026-11-03",
    },
    {
      id: "with",
      component: "Field",
      name: "with",
      kind: "select",
      label: "Mit",
      options: ["Karl Hofer", "Buchhaltung Hofer Bau"],
      value: "Karl Hofer",
    },
    {
      id: "how",
      component: "Field",
      name: "how",
      kind: "select",
      label: "Wie",
      options: ["Telefon", "Video", "Vor Ort"],
      required: true,
    },
    {
      id: "where",
      component: "Field",
      name: "where",
      kind: "location",
      label: "Wo du gerade bist",
    },
    {
      id: "note",
      component: "Field",
      name: "note",
      kind: "textarea",
      label: "Notiz",
      placeholder: "z. B. Zahlungsplan vorschlagen",
    },
    { id: "photo", component: "Field", name: "photo", kind: "image", label: "Foto der Baustelle" },
    { id: "sign", component: "Field", name: "sign", kind: "signature", label: "Unterschrift" },
  ],
};

const requests = {
  title: "Anfragen pro Monat, 2026",
  data: {
    months: [
      { month: "Jan", count: 12 },
      { month: "Feb", count: 15 },
      { month: "Mär", count: 19 },
      { month: "Apr", count: 17 },
      { month: "Mai", count: 22 },
      { month: "Jun", count: 20 },
      { month: "Jul", count: 18 },
      { month: "Aug", count: 26 },
      { month: "Sep", count: 41 },
      { month: "Okt", count: 33 },
    ],
  },
  components: [
    { id: "root", component: "Column", children: ["chart", "md", "r1", "r2"] },
    {
      id: "chart",
      component: "BarChart",
      points: { path: "/months" },
      labelKey: "month",
      valueKey: "count",
    },
    {
      id: "md",
      component: "Markdown",
      text: "**September** war der stärkste Monat, nach dem Newsletter vom 2.9. Im Oktober kamen:\n\n- 21 Anfragen über das Formular\n- 12 per Mail",
    },
    {
      id: "r1",
      component: "Ref",
      title: "Anfragen",
      subtitle: "Tabelle im Space",
      open: "t:requests",
    },
    {
      id: "r2",
      component: "Ref",
      title: "Newsletter September",
      meta: "2.9.",
      open: "chat:newsletter",
    },
  ],
};

const papers = {
  title: "Unterlagen zur Baustelle",
  data: {
    photos: [
      { id: "photo-a", caption: "Nordseite" },
      { id: "photo-b", caption: "Einfahrt" },
      { id: "photo-c", caption: "Lager" },
    ],
  },
  components: [
    { id: "root", component: "Column", children: ["offer", "gallery", "voice"] },
    {
      id: "offer",
      component: "File",
      file: "f:offer",
      name: "Angebot Hofer Bau.pdf",
      mime: "application/pdf",
    },
    {
      id: "gallery",
      component: "Gallery",
      items: { path: "/photos" },
      srcKey: "id",
      captionKey: "caption",
    },
    { id: "voice", component: "Audio", src: "f:voice", title: "Sprachnotiz von Karl" },
  ],
};

export const CHAT_VIEWS = [invoices, meeting, requests, papers];

/** A one-page PDF with one line of text, written by hand: what a File previews. */
function samplePdf(): Blob {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const text = "BT /F1 24 Tf 72 760 Td (Angebot Hofer Bau, 2026-118) Tj ET";
  objects[3] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([pdf], { type: "application/pdf" });
}

/** A picture in one colour with its name on it. */
async function samplePicture(label: string, hue: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 480;
  const g = canvas.getContext("2d");
  if (g) {
    g.fillStyle = `hsl(${hue} 45% 45%)`;
    g.fillRect(0, 0, 480, 480);
    g.fillStyle = "white";
    g.font = "600 40px system-ui";
    g.fillText(label, 32, 440);
  }
  return new Promise((done) => canvas.toBlob((b) => done(b ?? new Blob()), "image/png"));
}

/** Two seconds of a quiet tone, as a WAV file. */
function sampleRecording(): Blob {
  const rate = 8000;
  const n = rate * 2;
  const view = new DataView(new ArrayBuffer(44 + n * 2));
  const word = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(at + i, s.charCodeAt(i));
    }
  };
  word(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  word(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  word(36, "data");
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    view.setInt16(44 + i * 2, Math.sin((i / rate) * 2 * Math.PI * 440) * 3000, true);
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

/** The lab's chat: views as calls of the AI, a Form that "sends" here, and the files above. */
export function ChatLab() {
  const [files, setFiles] = useState<Record<string, string>>({});
  const [said, setSaid] = useState<string[]>([]);
  const [answered, setAnswered] = useState(
    new Map<string, { by: string; values: Record<string, unknown> }>(),
  );
  useEffect(() => {
    let urls: string[] = [];
    void (async () => {
      const made = {
        offer: samplePdf(),
        voice: sampleRecording(),
        "photo-a": await samplePicture("Nordseite", 25),
        "photo-b": await samplePicture("Einfahrt", 160),
        "photo-c": await samplePicture("Lager", 220),
      };
      const next = Object.fromEntries(
        Object.entries(made).map(([id, blob]) => [id, URL.createObjectURL(blob)]),
      );
      urls = Object.values(next);
      setFiles(next);
    })();
    return () => {
      for (const u of urls) {
        URL.revokeObjectURL(u);
      }
    };
  }, []);
  const host: ViewHost = useMemo(
    () => ({
      chatId: "lab",
      spaceId: "lab",
      ask: (text) => setSaid((s) => [...s, text]),
      submit: async (call, answer) => {
        await new Promise((r) => setTimeout(r, 400));
        setSaid((s) => [...s, answer.text]);
        setAnswered((m) => new Map(m).set(call, { by: "Matthias", values: answer.values }));
      },
      answered,
      assetUrl: (id) => files[id.replace(/^f:/, "")] ?? "",
    }),
    [answered, files],
  );
  return (
    <ViewContext.Provider value={host}>
      <div className="flex flex-col gap-8">
        {CHAT_VIEWS.map((view, i) => {
          const issues = validateSurface(view.components, Object.keys(view.data), { chat: true });
          return (
            <div key={view.title} className="flex flex-col gap-2">
              {issues.length ? (
                <ul className="rounded-xl bg-amber-tint px-4 py-3 text-[0.875rem]">
                  {issues.map((issue) => (
                    <li key={issue.message}>{issue.message}</li>
                  ))}
                </ul>
              ) : null}
              <ChatViewPart
                part={{
                  toolCallId: `lab-${i}`,
                  state: "output-available",
                  input: view,
                  output: { ok: true },
                }}
                live={false}
              />
            </div>
          );
        })}
        {said.length ? (
          <div className="flex flex-col gap-1 rounded-xl bg-card px-4 py-3 text-[0.8125rem] ring-1 ring-border-soft">
            <span className="text-ink-3">Sent to the chat:</span>
            {said.map((line, i) => (
              <pre key={i} className="whitespace-pre-wrap font-sans">
                {line}
              </pre>
            ))}
          </div>
        ) : null}
      </div>
    </ViewContext.Provider>
  );
}
