import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import {
  checkUpload,
  cleanName,
  cleanSvg,
  cssStaysInside,
  pictureSize,
  sniffType,
} from "../src/files/upload-check";
import { ServiceError } from "../src/services/errors";

const bytes = (...parts: (string | number[] | Uint8Array)[]) =>
  new Uint8Array(
    Buffer.concat(
      parts.map((p) =>
        typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p as Uint8Array),
      ),
    ),
  );

/** A 40 × 20 picture, red on the left, blue on the right. */
async function picture(format: "png" | "jpeg" | "webp") {
  const canvas = createCanvas(40, 20);
  const g = canvas.getContext("2d");
  g.fillStyle = "#f00";
  g.fillRect(0, 0, 20, 20);
  g.fillStyle = "#00f";
  g.fillRect(20, 0, 20, 20);
  return new Uint8Array(
    format === "png" ? await canvas.encode("png") : await canvas.encode(format, 90),
  );
}

/** A JPEG with an EXIF block: orientation 6 (turn right) and a line that stands for GPS data. */
async function phonePhoto() {
  const jpeg = await picture("jpeg");
  const tiff = [
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00,
    0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ];
  const exif = bytes("Exif\0\0", tiff, "GPS 48.2082N 16.3738E");
  const app1 = bytes([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255], exif);
  return bytes(jpeg.subarray(0, 2), app1, jpeg.subarray(2));
}

/** A PNG that says it is `width` × `height`, with nothing to decode. */
function claimedPng(width: number, height: number) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ihdr);
}

async function refusal(run: () => Promise<unknown>) {
  const err = await run().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServiceError);
  return (err as ServiceError).note?.code;
}

const has = (d: Uint8Array, s: string) => Buffer.from(d).includes(Buffer.from(s, "latin1"));

describe("a file's type, from its bytes", () => {
  it("knows pictures, recordings, clips, documents and fonts", async () => {
    expect(sniffType(await picture("png"))).toBe("image/png");
    expect(sniffType(await picture("jpeg"))).toBe("image/jpeg");
    expect(sniffType(await picture("webp"))).toBe("image/webp");
    expect(sniffType(bytes("GIF89a", [1, 0, 1, 0]))).toBe("image/gif");
    expect(sniffType(bytes([0, 0, 0, 0x1c], "ftypheic", [0, 0, 0, 0], "mif1heic"))).toBe(
      "image/heic",
    );
    expect(sniffType(bytes([0, 0, 0, 0x1c], "ftypmif1", [0, 0, 0, 0], "mif1avif"))).toBe(
      "image/avif",
    );
    expect(sniffType(bytes([0, 0, 0, 0x18], "ftypqt  ", [0, 0, 0, 0]))).toBe("video/quicktime");
    expect(sniffType(bytes([0, 0, 0, 0x18], "ftypisom", [0, 0, 0, 0]))).toBe("video/mp4");
    expect(sniffType(bytes([0x1a, 0x45, 0xdf, 0xa3], "....webm"))).toBe("video/webm");
    expect(sniffType(bytes("OggS"))).toBe("audio/ogg");
    expect(sniffType(bytes("ID3", [3, 0]))).toBe("audio/mpeg");
    expect(sniffType(bytes("RIFF", [0, 0, 0, 0], "WAVE"))).toBe("audio/wav");
    expect(sniffType(bytes("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffType(bytes("PK", [3, 4]))).toBe("application/zip");
    expect(sniffType(bytes("wOF2"))).toBe("font/woff2");
    expect(sniffType(bytes('<?xml version="1.0"?>\n<svg xmlns="x">'))).toBe("image/svg+xml");
    expect(sniffType(bytes("<!doctype html><p>hi"))).toBeNull();
  });

  it("reads a picture's size from its header", async () => {
    expect(pictureSize(await picture("png"), "image/png")).toEqual({ width: 40, height: 20 });
    expect(pictureSize(await picture("jpeg"), "image/jpeg")).toEqual({ width: 40, height: 20 });
    expect(pictureSize(await picture("webp"), "image/webp")).toEqual({ width: 40, height: 20 });
    expect(pictureSize(claimedPng(100_000, 100_000), "image/png")).toEqual({
      width: 100_000,
      height: 100_000,
    });
  });
});

describe("a file's name", () => {
  it("loses folders, control characters and direction overrides", () => {
    expect(cleanName("../../etc/passwd", "file")).toBe("passwd");
    expect(cleanName("C:\\Users\\a\\photo.jpg", "file")).toBe("photo.jpg");
    expect(cleanName("photo\u202Egpj.exe", "file")).toBe("photogpj.exe");
    expect(cleanName("a\u0000b\nc.png", "file")).toBe("abc.png");
    expect(cleanName("  ", "file")).toBe("file");
    expect(cleanName("x".repeat(300), "file")).toHaveLength(120);
  });
});

describe("an upload, checked", () => {
  it("draws a phone photo again: upright, without EXIF or GPS", async () => {
    const photo = await phonePhoto();
    expect(has(photo, "GPS 48.2082N")).toBe(true);
    const kept = await checkUpload({ name: "IMG_0001.jpg", mime: "image/jpeg", data: photo });
    expect(kept.mime).toBe("image/jpeg");
    expect(has(kept.data, "Exif")).toBe(false);
    expect(has(kept.data, "GPS 48.2082N")).toBe(false);
    const shown = await loadImage(Buffer.from(kept.data));
    expect([shown.width, shown.height]).toEqual([20, 40]);
  });

  it("drops what comes after a picture's end", async () => {
    const png = bytes(await picture("png"), "<html><script>alert(1)</script>");
    const kept = await checkUpload({ name: "a.png", mime: "image/png", data: png });
    expect(has(kept.data, "<script>")).toBe(false);
    expect(pictureSize(kept.data, "image/png")).toEqual({ width: 40, height: 20 });
  });

  it("keeps a picture under the type its bytes show", async () => {
    const kept = await checkUpload({
      name: "a.jpg",
      mime: "image/jpeg",
      data: await picture("png"),
    });
    expect(kept.mime).toBe("image/png");
  });

  it("keeps an animated GIF as it is", async () => {
    const gif = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
    const kept = await checkUpload({ name: "a.gif", mime: "image/gif", data: new Uint8Array(gif) });
    expect(Buffer.from(kept.data).equals(gif)).toBe(true);
  });

  it("refuses a page that says it is a picture", async () => {
    expect(
      await refusal(() =>
        checkUpload({ name: "a.png", mime: "image/png", data: bytes("<html><body>hi") }),
      ),
    ).toBe("uploadNotPicture");
  });

  it("refuses a picture too large to decode, before decoding it", async () => {
    expect(
      await refusal(() =>
        checkUpload({ name: "a.png", mime: "image/png", data: claimedPng(100_000, 100_000) }),
      ),
    ).toBe("uploadPictureTooLarge");
  });

  it("refuses a picture that doesn't decode", async () => {
    expect(
      await refusal(() => checkUpload({ name: "a.png", mime: "image/png", data: claimedPng(40, 20) })),
    ).toBe("uploadNotPicture");
  });

  it("refuses bytes that aren't what the type says", async () => {
    for (const [mime, data] of [
      ["audio/webm", bytes("0123456789")],
      ["application/pdf", bytes("<html>")],
      [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes("plain text"),
      ],
      ["font/woff2", bytes("<svg>")],
      ["text/csv", bytes("a,b", [0], "c")],
    ] as const) {
      expect(await refusal(() => checkUpload({ name: "x", mime, data })), mime).toBe(
        "uploadNotItsType",
      );
    }
  });

  it("keeps a recording under its declared type once the bytes agree", async () => {
    const kept = await checkUpload({
      name: "note.mp4",
      mime: "audio/mp4",
      data: bytes([0, 0, 0, 0x18], "ftypisom", [0, 0, 0, 0]),
    });
    expect(kept.mime).toBe("audio/mp4");
  });

  it("keeps a type it doesn't check as declared", async () => {
    const kept = await checkUpload({
      name: "x.bin",
      mime: "application/octet-stream",
      data: bytes("anything"),
    });
    expect(kept.mime).toBe("application/octet-stream");
  });
});

describe("an SVG, written again", () => {
  const svg = (inner: string, attrs = "") =>
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"${attrs}>${inner}</svg>`;

  it("keeps a drawing", () => {
    const out = cleanSvg(
      svg(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>' +
          '<style>.a{fill:url(#g)}</style><path class="a" d="M0 0h10v10z"/><use href="#g"/>' +
          "<text>Tom &amp; Jerry</text>",
      ),
    );
    expect(out).toContain("<linearGradient");
    expect(out).toContain('d="M0 0h10v10z"');
    expect(out).toContain(".a{fill:url(#g)}");
    expect(out).toContain('href="#g"');
    expect(out).toContain("Tom &amp; Jerry");
  });

  it("drops scripts, handlers, outside references and foreign content", () => {
    const out = cleanSvg(
      svg(
        "<script>alert(1)</script>" +
          '<rect width="1" onclick="alert(1)" fill="url(https://evil.example/x)"/>' +
          '<image href="https://evil.example/pixel.png"/>' +
          '<use xlink:href="https://evil.example/s.svg#a"/>' +
          '<a href="javascript:alert(1)"><circle r="1"/></a>' +
          '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>' +
          '<set attributeName="href" to="javascript:alert(1)"/>' +
          "<style>@import url(https://evil.example/a.css);</style>",
        ' onload="alert(1)"',
      ),
    );
    expect(out).not.toMatch(/script|onclick|onload|evil\.example|javascript|foreignObject|<set|@import/);
    expect(out).toContain("<circle");
  });

  it("keeps an embedded photo, but not an embedded drawing", () => {
    const out = cleanSvg(
      svg(
        '<image href="data:image/png;base64,iVBORw0KGgo="/>' +
          '<image href="data:image/svg+xml;base64,PHN2Zz4="/>',
      ),
    );
    expect(out).toContain("data:image/png;base64");
    expect(out).not.toContain("svg+xml");
  });

  it("can't be talked out of an attribute", () => {
    const out = cleanSvg(svg(`<rect fill='x" onload="alert(1)' width="1"/>`));
    expect(out).not.toMatch(/ onload="/);
    expect(out).toContain("&quot;");
  });

  it("sees through escapes in styles", () => {
    expect(cssStaysInside("fill: url(#a)")).toBe(true);
    expect(cssStaysInside("fill: &#117;rl(https://evil.example)")).toBe(false);
    expect(cssStaysInside("fill: \\75 rl(https://evil.example)")).toBe(false);
    expect(cssStaysInside("fill: URL( 'https://evil.example' )")).toBe(false);
  });

  it("refuses declarations and a root that isn't svg", async () => {
    expect(() =>
      cleanSvg('<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg"/>'),
    ).toThrow(ServiceError);
    expect(() => cleanSvg("<html><svg/></html>")).toThrow(ServiceError);
    expect(
      await refusal(() =>
        checkUpload({
          name: "a.svg",
          mime: "image/svg+xml",
          data: bytes('<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>'),
        }),
      ),
    ).toBe("uploadSvgNotUsable");
  });
});
