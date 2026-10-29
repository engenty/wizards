import { type BrandFont, type BrandFontSource, fontFace } from "@engenty/wizards-shared/spaces";
import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { Button, cn, Dialog, Input, Label, Segmented } from "../../ui";
import { useFileActions, useSpaceFiles } from "./data";

type Check = "ok" | "cors" | "down" | "missing" | "noFont";
type Kind = "file" | "url";

const hostOf = (url: string) => (URL.canParse(url) ? new URL(url).host : url);

/**
 * Whether a run page can load the font from this address, tried from the studio: it has the same
 * origin as run pages. A font file needs the website's permission (`Access-Control-Allow-Origin`);
 * a stylesheet loads without it, but the font files it names need it too.
 */
async function checkAddress(url: string, family: string): Promise<Check> {
  const face = fontFace({ family, source: { url } });
  if (!face) {
    return "down";
  }
  if (face.stylesheet) {
    return await checkStylesheet(url, family);
  }
  const answer = await fetch(url, { mode: "cors" }).catch(() => null);
  if (!answer) {
    // Without permission the browser hides the answer; asked without CORS, the site still answers.
    const answers = await fetch(url, { mode: "no-cors" }).then(
      () => true,
      () => false,
    );
    return answers ? "cors" : "down";
  }
  if (!answer.ok) {
    return "down";
  }
  return await new FontFace(`engenty-check-${Date.now()}`, await answer.arrayBuffer()).load().then(
    () => "ok" as const,
    () => "noFont" as const,
  );
}

/** Loads the stylesheet on its own and tries the faces it adds for the family. */
function checkStylesheet(url: string, family: string): Promise<Check> {
  const before = new Set(document.fonts);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = url;
  return new Promise<Check>((resolve) => {
    link.onerror = () => resolve("down");
    link.onload = async () => {
      const own = [...document.fonts].filter(
        (f) => !before.has(f) && f.family.replace(/^["']|["']$/g, "") === family,
      );
      const tried = await Promise.allSettled(own.map((f) => f.load()));
      resolve(
        own.length === 0 ? "missing" : tried.some((x) => x.status === "fulfilled") ? "ok" : "cors",
      );
    };
    document.head.append(link);
  }).finally(() => link.remove());
}

/** Where the font loads from, in a line: our copy, a website, or nowhere yet. */
export function sourceLine(font: BrandFont, files: { id: string; name: string }[]): string {
  const source = font.source;
  if (!source) {
    return t("space.fontSourceNone");
  }
  if ("file" in source) {
    const name = files.find((f) => f.id === source.file)?.name ?? "";
    return t("space.fontSourceFile", { name });
  }
  return t("space.fontSourceUrl", { host: hostOf(source.url) });
}

/**
 * Where wizard pages load a brand font from: a font file of the space, uploaded here, or its
 * address on the space's website. An address is tried first; both ask to confirm the licence.
 */
export function FontSourceDialog({
  spaceId,
  font,
  onSave,
  onClose,
}: {
  spaceId: string;
  font: BrandFont;
  onSave: (patch: Pick<BrandFont, "source" | "license">) => void;
  onClose: () => void;
}) {
  const files = (useSpaceFiles(spaceId).data?.files ?? []).filter((f) =>
    f.mime.startsWith("font/"),
  );
  const actions = useFileActions(spaceId);
  const picker = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<Kind>(font.source && "url" in font.source ? "url" : "file");
  const [file, setFile] = useState(font.source && "file" in font.source ? font.source.file : "");
  const [url, setUrl] = useState(font.source && "url" in font.source ? font.source.url : "");
  const [checked, setChecked] = useState<{ url: string; result: Check } | null>(
    font.source && "url" in font.source ? { url: font.source.url, result: "ok" } : null,
  );
  const [checking, setChecking] = useState(false);
  const [license, setLicense] = useState(font.license ?? "");
  const [allowed, setAllowed] = useState(false);

  const address = url.trim();
  const check = async () => {
    setChecking(true);
    setChecked({ url: address, result: await checkAddress(address, font.family.trim()) });
    setChecking(false);
  };
  const source: BrandFontSource | null =
    kind === "file"
      ? file
        ? { file }
        : null
      : checked?.url === address && checked.result === "ok"
        ? { url: address }
        : null;
  const result = checked?.url === address ? checked.result : null;

  return (
    <Dialog open onClose={onClose} title={t("space.fontSourceTitle", { family: font.family })}>
      <div className="flex flex-col gap-5">
        <p className="-mt-2 text-[0.875rem] text-ink-3">{t("space.fontSourceHint")}</p>
        <Segmented
          value={kind}
          options={["file", "url"]}
          label={(o) => t(`space.fontSourceKind.${o as Kind}`)}
          onChange={(k: Kind) => setKind(k)}
        />
        {kind === "file" ? (
          <div>
            <Label>{t("space.fontSourceFiles")}</Label>
            <div className="flex flex-col gap-1">
              {files.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={file === f.id}
                  onClick={() => setFile(f.id)}
                  className={cn(
                    "rounded-lg px-3 py-2 text-left text-[0.875rem] ring-1 transition",
                    file === f.id ? "ring-2 ring-ember" : "ring-border-soft hover:ring-ink-4",
                  )}
                >
                  {f.name}
                </button>
              ))}
            </div>
            <input
              ref={picker}
              type="file"
              accept=".woff2,.woff,.ttf,.otf"
              className="hidden"
              onChange={async (e) => {
                const picked = [...(e.target.files ?? [])];
                e.target.value = "";
                const [taken] = await actions.upload("asset", picked);
                if (taken) {
                  setFile(taken.id);
                }
              }}
            />
            <Button
              variant="ghost"
              className="mt-2"
              busy={actions.busy}
              onClick={() => picker.current?.click()}
            >
              <Upload className="size-4" />
              {t("space.fontSourceUpload")}
            </Button>
            {actions.error ? (
              <p className="mt-1.5 text-[0.875rem] text-rose">{actions.error}</p>
            ) : null}
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void check();
            }}
          >
            <Label>{t("space.fontSourceUrlLabel")}</Label>
            <div className="flex gap-2">
              <Input
                value={url}
                inputMode="url"
                placeholder={t("space.fontSourceUrlPlaceholder")}
                onChange={(e) => setUrl(e.target.value)}
              />
              <Button
                type="submit"
                variant="ghost"
                busy={checking}
                disabled={!address.startsWith("https://")}
              >
                {t("space.fontSourceCheck")}
              </Button>
            </div>
            {result ? (
              <p
                className={cn(
                  "mt-1.5 text-[0.875rem]",
                  result === "ok" ? "text-ink-3" : "text-rose",
                )}
              >
                {t(`space.fontCheck.${result}`, {
                  host: hostOf(address),
                  family: font.family,
                })}
              </p>
            ) : null}
            {result === "ok" ? (
              <p className="mt-1.5 text-[0.875rem] text-ink-3">
                {t("space.fontPrivacy", { host: hostOf(address) })}
              </p>
            ) : null}
          </form>
        )}
        <div>
          <Label hint={t("space.fontLicenseHint")}>{t("space.fontLicense")}</Label>
          <Input
            value={license}
            maxLength={200}
            placeholder={t("space.fontLicensePlaceholder")}
            onChange={(e) => setLicense(e.target.value)}
          />
          <label className="mt-2 flex items-start gap-2 text-[0.875rem]">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-ember"
              checked={allowed}
              onChange={(e) => setAllowed(e.target.checked)}
            />
            {t("space.fontLicenseConfirm", { family: font.family })}
          </label>
        </div>
        <div className="flex justify-end gap-2">
          {font.source ? (
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => {
                onSave({ source: undefined, license: font.license });
                onClose();
              }}
            >
              {t("space.fontSourceRemove")}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!(source && allowed)}
            onClick={() => {
              if (source) {
                onSave({ source, license: license.trim() || undefined });
                onClose();
              }
            }}
          >
            {t("space.fontSourceSave")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
