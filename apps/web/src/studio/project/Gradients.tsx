import {
  type BrandColor,
  type BrandGradient,
  type BrandPattern,
  GRADIENT_TYPES,
  type GradientType,
  gradientCss,
  parseGradient,
} from "@engenty-wizards/shared/projects";
import { Copy, Download, ImageUp, Plus, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import { Button, cn, Dialog, IconButton, Input, Label, Spinner, Swatch } from "../../ui";
import { fileUrl } from "./data";
import { DropArea, InlineText } from "./Section";

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The gradient drawn on a canvas, as a PNG to download: CSS's geometry, 1920 × 1080. */
async function gradientPng(g: BrandGradient, name: string) {
  const [w, h] = [1920, 1080];
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  const rad = (g.angle * Math.PI) / 180;
  let fill: CanvasGradient;
  if (g.type === "radial") {
    fill = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
  } else if (g.type === "conic") {
    fill = ctx.createConicGradient(rad - Math.PI / 2, w / 2, h / 2);
  } else {
    // CSS: 0deg points up, the line is as long as the box is seen along it.
    const len = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
    const [dx, dy] = [(Math.sin(rad) * len) / 2, (-Math.cos(rad) * len) / 2];
    fill = ctx.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
  }
  for (const s of [...g.stops].sort((a, b) => a.at - b.at)) {
    fill.addColorStop(Math.min(1, Math.max(0, s.at / 100)), s.color);
  }
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
  if (blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name || "gradient"}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}

const TYPE_LABELS: Record<GradientType, Parameters<typeof t>[0]> = {
  linear: "project.gradientLinear",
  radial: "project.gradientRadial",
  conic: "project.gradientConic",
};

/**
 * A gradient made or changed: said in words for engenty to draw, or by its type, angle and colour
 * stops, or its CSS pasted in.
 */
export function GradientEditor({
  projectId,
  gradient,
  isNew,
  brand,
  onSave,
  onClose,
}: {
  projectId: string;
  gradient: BrandGradient;
  isNew: boolean;
  /** The brand's colours, one click from becoming a stop. */
  brand: BrandColor[];
  onSave: (g: BrandGradient) => void;
  onClose: () => void;
}) {
  const [g, setG] = useState(gradient);
  const [css, setCss] = useState(gradientCss(gradient));
  const [cssError, setCssError] = useState(false);
  const [wish, setWish] = useState("");
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  // The first answer to a new gradient makes it; every later one changes what is there.
  const [drawn, setDrawn] = useState(!isNew);
  const change = (next: BrandGradient) => {
    setG(next);
    setCss(gradientCss(next));
    setCssError(false);
  };
  const stop = (i: number, patch: Partial<BrandGradient["stops"][number]>) =>
    change({ ...g, stops: g.stops.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const addStop = (color?: string) => {
    const sorted = [...g.stops].sort((a, b) => a.at - b.at);
    // A new stop goes into the widest gap.
    let at = 50;
    let gap = -1;
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i + 1].at - sorted[i].at > gap) {
        gap = sorted[i + 1].at - sorted[i].at;
        at = Math.round((sorted[i].at + sorted[i + 1].at) / 2);
      }
    }
    change({ ...g, stops: [...g.stops, { color: color ?? sorted[0]?.color ?? "#888888", at }] });
  };
  const ask = async () => {
    setAsking(true);
    setAskError(null);
    try {
      const { gradient: answer } = await api.post<{
        gradient: Pick<BrandGradient, "name" | "type" | "angle" | "stops">;
      }>(`/api/studio/projects/${projectId}/gradients/describe`, {
        text: wish.trim(),
        ...(drawn
          ? { gradient: { name: g.name, type: g.type, angle: g.angle, stops: g.stops } }
          : {}),
      });
      change({ ...g, ...answer, name: g.name.trim() ? g.name : answer.name });
      setWish("");
      setDrawn(true);
    } catch (err) {
      setAskError((err as Error).message);
    }
    setAsking(false);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      wide
      title={isNew ? t("project.gradientNew") : t("project.gradientEdit")}
    >
      <div className="flex flex-col gap-5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (wish.trim() && !asking) {
              void ask();
            }
          }}
        >
          <div className="flex gap-2">
            <Input
              data-autofocus={isNew || undefined}
              value={wish}
              maxLength={1000}
              aria-label={t("project.gradientDescribe")}
              placeholder={
                drawn ? t("project.gradientDescribeChange") : t("project.gradientDescribeNew")
              }
              onChange={(e) => setWish(e.target.value)}
              className="min-w-0 flex-1"
            />
            <Button type="submit" variant="secondary" busy={asking} disabled={!wish.trim()}>
              <Sparkles className="size-4" />
              {drawn ? t("project.gradientDescribeApply") : t("project.gradientDescribeMake")}
            </Button>
          </div>
          <p className={cn("mt-1.5 text-[0.8125rem]", askError ? "text-rose" : "text-ink-3")}>
            {askError ?? t("project.gradientDescribeHint")}
          </p>
        </form>
        <div
          className="h-40 rounded-lg ring-1 ring-border-soft"
          style={{ background: gradientCss(g) }}
        />
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <div>
            <Label>{t("project.gradientName")}</Label>
            <Input
              value={g.name}
              maxLength={80}
              placeholder={t("project.gradientNamePlaceholder")}
              onChange={(e) => setG({ ...g, name: e.target.value })}
            />
          </div>
          <div>
            <Label>{t("project.fillUseLabel")}</Label>
            <Input
              value={g.description ?? ""}
              maxLength={400}
              placeholder={t("project.gradientUse")}
              onChange={(e) => setG({ ...g, description: e.target.value })}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
          <div>
            <Label>{t("project.gradientType")}</Label>
            <div className="flex gap-1 rounded-full bg-paper-2 p-0.5 ring-1 ring-border-soft">
              {GRADIENT_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  aria-pressed={g.type === type}
                  onClick={() => change({ ...g, type })}
                  className={cn(
                    "h-9 rounded-full px-4 font-medium text-[0.875rem] transition",
                    g.type === type ? "bg-card text-ink shadow-sm" : "text-ink-3 hover:text-ink-2",
                  )}
                >
                  {t(TYPE_LABELS[type])}
                </button>
              ))}
            </div>
          </div>
          {g.type === "radial" ? null : (
            <div className="min-w-56">
              <Label>{t("project.gradientAngle")}</Label>
              <div className="flex h-11 items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={360}
                  value={g.angle}
                  aria-label={t("project.gradientAngle")}
                  onChange={(e) => change({ ...g, angle: Number(e.target.value) })}
                  className="flex-1 accent-ink"
                />
                <span className="w-12 text-right text-[0.875rem] text-ink-2 tabular-nums">
                  {Math.round(g.angle)}°
                </span>
              </div>
            </div>
          )}
        </div>
        <div>
          <Label>{t("project.gradientStops")}</Label>
          <div className="flex flex-col gap-2">
            {g.stops.map((s, i) => (
              <div key={i} className="flex items-center gap-3">
                <Swatch
                  value={HEX.test(s.color) ? s.color : "#888888"}
                  onChange={(e) => stop(i, { color: e.target.value })}
                />
                <Input
                  value={s.color}
                  spellCheck={false}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    if (HEX.test(v)) {
                      stop(i, { color: v.toLowerCase() });
                    }
                  }}
                  className="w-28 font-mono text-[0.8125rem]"
                />
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={s.at}
                  aria-label={t("project.gradientAt")}
                  onChange={(e) => stop(i, { at: Number(e.target.value) })}
                  className="flex-1 accent-ink"
                />
                <span className="w-10 text-right text-[0.875rem] text-ink-2 tabular-nums">
                  {Math.round(s.at)}%
                </span>
                <IconButton
                  label={t("project.remove")}
                  disabled={g.stops.length <= 2}
                  onClick={() => change({ ...g, stops: g.stops.filter((_, j) => j !== i) })}
                  className="hover:text-rose"
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {g.stops.length < 12 ? (
              <Button variant="secondary" size="sm" onClick={() => addStop()}>
                <Plus className="size-4" /> {t("project.gradientStopAdd")}
              </Button>
            ) : null}
            {brand.length && g.stops.length < 12 ? (
              <>
                <span className="ml-2 text-[0.8125rem] text-ink-3">
                  {t("project.gradientFromBrand")}
                </span>
                {brand.slice(0, 10).map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    title={c.name || c.value}
                    aria-label={c.name || c.value}
                    onClick={() => addStop(c.value)}
                    className="size-6 rounded-full ring-1 ring-border transition hover:scale-110"
                    style={{ background: c.value }}
                  />
                ))}
              </>
            ) : null}
          </div>
        </div>
        <div>
          <Label>CSS</Label>
          <Input
            value={css}
            spellCheck={false}
            onChange={(e) => {
              setCss(e.target.value);
              const read = parseGradient(e.target.value);
              setCssError(!read);
              if (read) {
                setG({ ...g, ...read });
              }
            }}
            className="font-mono text-[0.8125rem]"
          />
          <p className={cn("mt-1.5 text-[0.8125rem]", cssError ? "text-rose" : "text-ink-3")}>
            {cssError ? t("project.gradientCssError") : t("project.gradientCssHint")}
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => {
              onSave(g);
              onClose();
            }}
          >
            {t("settings.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** A card's actions over its picture, top right, as on the asset tiles. */
const overActions =
  "absolute top-1.5 right-1.5 flex gap-1 opacity-0 transition focus-within:opacity-100 group-hover/card:opacity-100 coarse:opacity-100";
const overButton = "size-8 bg-card shadow-soft hover:bg-card";

/** A card's name and what it is for, written in place. */
function CardText({
  name,
  namePlaceholder,
  description,
  usePlaceholder,
  readOnly,
  onChange,
}: {
  name: string;
  namePlaceholder: string;
  description?: string;
  usePlaceholder: string;
  readOnly?: boolean;
  onChange: (patch: { name?: string; description?: string }) => void;
}) {
  if (readOnly) {
    return (
      <div className="min-w-0 px-0.5">
        <p className="truncate text-[0.875rem]">{name || namePlaceholder}</p>
        {description ? (
          <p className="text-[0.8125rem] text-ink-3 leading-snug">{description}</p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="min-w-0 px-0.5">
      <InlineText
        value={name}
        label={t("project.gradientName")}
        placeholder={namePlaceholder}
        maxLength={80}
        onChange={(v) => onChange({ name: v })}
        className="font-medium text-[0.875rem]"
      />
      <InlineText
        value={description ?? ""}
        label={t("project.fillUseLabel")}
        placeholder={usePlaceholder}
        maxLength={400}
        onChange={(v) => onChange({ description: v })}
        className="text-[0.8125rem] text-ink-3"
      />
    </div>
  );
}

/** A gradient as a card: drawn, named, its CSS to copy and a PNG to download. */
export function GradientCard({
  gradient,
  readOnly,
  onEdit,
  onChange,
  onRemove,
}: {
  gradient: BrandGradient;
  readOnly?: boolean;
  onEdit: () => void;
  onChange: (patch: Partial<BrandGradient>) => void;
  onRemove: () => void;
}) {
  const css = gradientCss(gradient);
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/card flex flex-col gap-2 rounded-lg bg-paper p-2 ring-1 ring-border-soft">
      <div className="relative">
        <button
          type="button"
          disabled={readOnly}
          aria-label={t("project.gradientEdit")}
          onClick={onEdit}
          className="block h-28 w-full rounded-md ring-1 ring-border-soft transition enabled:hover:brightness-105"
          style={{ background: css }}
        />
        <div className={overActions}>
          <IconButton
            label={copied ? t("project.gradientCopied") : t("project.gradientCopy")}
            onClick={() => {
              void navigator.clipboard.writeText(`background: ${css};`);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className={overButton}
          >
            <Copy className="size-4" />
          </IconButton>
          <IconButton
            label={t("project.download")}
            onClick={() => void gradientPng(gradient, gradient.name)}
            className={overButton}
          >
            <Download className="size-4" />
          </IconButton>
          {readOnly ? null : (
            <IconButton
              label={t("project.remove")}
              onClick={onRemove}
              className={cn(overButton, "hover:text-rose")}
            >
              <Trash2 className="size-4" />
            </IconButton>
          )}
        </div>
      </div>
      <CardText
        name={gradient.name}
        namePlaceholder={t("project.gradientName")}
        description={gradient.description}
        usePlaceholder={t("project.gradientUse")}
        readOnly={readOnly}
        onChange={onChange}
      />
    </div>
  );
}

/** How a pattern's picture lies on an area: repeated as a tile, or filling it. */
function patternLook(src: string, tile?: boolean) {
  return {
    backgroundImage: `url("${src}")`,
    backgroundSize: tile ? "64px" : "cover",
    backgroundRepeat: tile ? "repeat" : "no-repeat",
    backgroundPosition: "center",
  };
}

/** A pattern or a fill as a card: the picture, tiled or filling, to download. */
export function PatternCard({
  projectId,
  pattern,
  fileName,
  readOnly,
  onEdit,
  onChange,
  onRemove,
}: {
  projectId: string;
  pattern: BrandPattern;
  fileName: string;
  readOnly?: boolean;
  onEdit: () => void;
  onChange: (patch: Partial<BrandPattern>) => void;
  onRemove: () => void;
}) {
  const src = fileUrl(projectId, pattern.file);
  return (
    <div className="group/card flex flex-col gap-2 rounded-lg bg-paper p-2 ring-1 ring-border-soft">
      <div className="relative">
        <button
          type="button"
          disabled={readOnly}
          aria-label={t("project.patternEdit")}
          onClick={onEdit}
          className="block h-28 w-full rounded-md ring-1 ring-border-soft transition enabled:hover:brightness-105"
          style={patternLook(src, pattern.tile)}
        />
        <div className={overActions}>
          <a
            href={src}
            download={fileName}
            aria-label={t("project.download")}
            title={t("project.download")}
            className={cn(
              "inline-flex items-center justify-center rounded-full text-ink-3 transition hover:text-ink",
              overButton,
            )}
          >
            <Download className="size-4" />
          </a>
          {readOnly ? null : (
            <IconButton
              label={t("project.remove")}
              onClick={onRemove}
              className={cn(overButton, "hover:text-rose")}
            >
              <Trash2 className="size-4" />
            </IconButton>
          )}
        </div>
      </div>
      <CardText
        name={pattern.name}
        namePlaceholder={fileName}
        description={pattern.description}
        usePlaceholder={t("project.patternUse")}
        readOnly={readOnly}
        onChange={onChange}
      />
    </div>
  );
}

/**
 * A pattern added or changed: its picture uploaded or replaced, its name, what it is for, and
 * whether it is repeated as a tile or fills the area. A picture uploaded here and then not kept is
 * removed again.
 */
export function PatternEditor({
  projectId,
  pattern,
  isNew,
  fileName,
  busy,
  error,
  upload,
  removeFile,
  onSave,
  onClose,
}: {
  projectId: string;
  /** A new one has no `file` yet. */
  pattern: BrandPattern;
  isNew: boolean;
  fileName: (id: string) => string;
  busy: boolean;
  /** Why the last upload was not taken. */
  error: string | null;
  /** Uploads a picture as a pattern file: its id and name, or null when it was not taken. */
  upload: (file: File) => Promise<{ id: string; name: string } | null>;
  removeFile: (id: string) => void;
  onSave: (p: BrandPattern) => void;
  onClose: () => void;
}) {
  const [p, setP] = useState(pattern);
  const [uploaded, setUploaded] = useState<string[]>([]);
  const take = async (files: File[]) => {
    const file = files[0];
    if (!file) {
      return;
    }
    const taken = await upload(file);
    if (taken) {
      setUploaded((all) => [...all, taken.id]);
      setP((x) => ({ ...x, file: taken.id, name: x.name || taken.name.replace(/\.[^.]+$/, "") }));
    }
  };
  const cancel = () => {
    for (const id of uploaded) {
      removeFile(id);
    }
    onClose();
  };
  const save = () => {
    for (const id of uploaded.filter((id) => id !== p.file)) {
      removeFile(id);
    }
    if (pattern.file && pattern.file !== p.file) {
      removeFile(pattern.file);
    }
    onSave({ ...p, name: p.name.trim(), description: p.description?.trim() || undefined });
    onClose();
  };
  return (
    <Dialog
      open
      onClose={cancel}
      wide
      title={isNew ? t("project.patternNew") : t("project.patternEdit")}
    >
      <div className="flex flex-col gap-5">
        {p.file ? (
          <div
            className="relative h-40 rounded-lg ring-1 ring-border-soft"
            style={patternLook(fileUrl(projectId, p.file), p.tile)}
          >
            <DropArea
              accept="image/*"
              multiple={false}
              onFiles={(files) => void take(files)}
              className="absolute right-2 bottom-2 h-9 border-solid bg-card px-3.5 text-ink-2 shadow-soft"
            >
              {busy ? <Spinner className="size-4" /> : <ImageUp className="size-4" />}
              {t("project.patternReplace")}
            </DropArea>
          </div>
        ) : (
          <DropArea
            accept="image/*"
            multiple={false}
            onFiles={(files) => void take(files)}
            className="h-40 flex-col"
          >
            {busy ? <Spinner className="size-5" /> : <ImageUp className="size-5" />}
            {t("project.patternPick")}
          </DropArea>
        )}
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <div>
            <Label>{t("project.patternName")}</Label>
            <Input
              value={p.name}
              maxLength={80}
              placeholder={p.file ? fileName(p.file) : t("project.patternNamePlaceholder")}
              onChange={(e) => setP({ ...p, name: e.target.value })}
            />
          </div>
          <div>
            <Label>{t("project.fillUseLabel")}</Label>
            <Input
              value={p.description ?? ""}
              maxLength={400}
              placeholder={t("project.patternUse")}
              onChange={(e) => setP({ ...p, description: e.target.value })}
            />
          </div>
        </div>
        <div>
          <Label>{t("project.patternShow")}</Label>
          <div className="flex w-fit gap-1 rounded-full bg-paper-2 p-0.5 ring-1 ring-border-soft">
            {[false, true].map((tile) => (
              <button
                key={String(tile)}
                type="button"
                aria-pressed={Boolean(p.tile) === tile}
                onClick={() => setP({ ...p, tile: tile || undefined })}
                className={cn(
                  "h-9 rounded-full px-4 font-medium text-[0.875rem] transition",
                  Boolean(p.tile) === tile
                    ? "bg-card text-ink shadow-sm"
                    : "text-ink-3 hover:text-ink-2",
                )}
              >
                {tile ? t("project.patternTile") : t("project.patternFill")}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2">
          {error ? <p className="mr-auto text-[0.8125rem] text-rose">{error}</p> : null}
          <Button variant="ghost" onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!p.file || busy} onClick={save}>
            {isNew ? t("project.add") : t("settings.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
