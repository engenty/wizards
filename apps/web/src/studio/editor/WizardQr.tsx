import { cn } from "@engenty-wizards/runner/ui";
import { useMemo } from "react";
import { renderSVG } from "uqr";

/** `K7WM4TQ9` → `K7WM 4TQ9`: two groups read aloud and typed more easily. */
export const spacedCode = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;

/** A link as a QR code, in SVG. */
export const qrSvg = (url: string) => renderSVG(url, { ecc: "M", border: 2, pixelSize: 8 });

const fileOf = (title: string) =>
  `${(title.trim() || "wizard").replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase()}-qr`;

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The SVG drawn on a canvas, 1024 pixels wide: for print and slides that take no SVG. */
export async function saveQrPng(svg: string, title: string) {
  const image = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, 0, 0, 1024, 1024);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (png) {
      save(png, `${fileOf(title)}.png`);
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The code with the wizard's name under it, on a page of its own that prints and closes. */
export function printQr(svg: string, title: string) {
  const page = window.open("", "_blank", "width=520,height=680");
  if (!page) {
    return;
  }
  const doc = page.document;
  doc.title = title;
  const style = doc.createElement("style");
  style.textContent =
    "body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;font:600 28px system-ui,sans-serif}svg{width:12cm;height:12cm}";
  doc.head.append(style);
  // Parsed as SVG, from the link alone: no markup of anyone else's goes in.
  const code = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  const name = doc.createElement("div");
  name.textContent = title;
  doc.body.append(doc.importNode(code, true), name);
  page.addEventListener("afterprint", () => page.close());
  page.focus();
  page.print();
}

/** The code itself, on white whatever the theme: a camera reads dark on light. */
export function QrImage({
  svg,
  label,
  className,
}: {
  svg: string;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      className={cn("overflow-hidden rounded-xl bg-white [&>svg]:size-full", className)}
      // uqr writes the SVG from the link alone: no markup of anyone else's goes in.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: generated from the URL only
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** A QR code of a text (a link, `tel:` with a number), for a plugin's part of the studio. */
export function QrCode({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const svg = useMemo(() => qrSvg(text), [text]);
  return <QrImage svg={svg} label={label} className={cn("size-40 p-1", className)} />;
}
