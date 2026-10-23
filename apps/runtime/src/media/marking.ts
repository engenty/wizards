import { crc32 } from "node:zlib";

/**
 * Marking media a model made or changed, so that software can tell (EU AI Act, Art. 50(2)):
 * the IPTC "Digital Source Type" in the file's XMP metadata — what platforms read to put their
 * own "AI" label next to a picture. Nothing is drawn into the picture; the label people see is
 * the interface's (and, in a video, a line of the video itself).
 *
 * A file that already carries a marking is left as it is, byte for byte: image models sign their
 * output (C2PA Content Credentials), and a signed file that is changed no longer verifies.
 */

/** `generated`: a model made it from a description. `edited`: a model changed media that existed. */
export type AiOrigin = "generated" | "edited";

const SOURCE_TYPE: Record<AiOrigin, string> = {
  generated: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
  edited: "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia",
};

export interface Marking {
  origin: AiOrigin;
  /** The model that made it, as far as this runtime knows it ("google/veo-3.1-fast-generate-001"). */
  system?: string;
}

function xml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The XMP packet that says how the file came to be. */
export function xmpPacket(marking: Marking): string {
  const system = marking.system ? `\n   Iptc4xmpExt:AISystemUsed="${xml(marking.system)}"` : "";
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"
   xmlns:xmp="http://ns.adobe.com/xap/1.0/"
   Iptc4xmpExt:DigitalSourceType="${SOURCE_TYPE[marking.origin]}"${system}
   xmp:CreatorTool="engenty wizards"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** Whether the file already says it is AI media: signed Content Credentials, or a source type in its XMP. */
export function isMarked(bytes: Uint8Array): boolean {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return data.includes("c2pa") || data.includes("DigitalSourceType");
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG: an iTXt chunk "XML:com.adobe.xmp" right after the header chunk. */
function markPng(data: Buffer, xmp: string): Buffer | null {
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString("latin1", 12, 16) !== "IHDR") {
    return null;
  }
  const headerEnd = 8 + 12 + data.readUInt32BE(8);
  const body = Buffer.concat([
    Buffer.from("XML:com.adobe.xmp\0\0\0\0\0", "latin1"),
    Buffer.from(xmp, "utf8"),
  ]);
  const type = Buffer.from("iTXt", "latin1");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(Buffer.concat([type, body])) >>> 0);
  return Buffer.concat([
    data.subarray(0, headerEnd),
    length,
    type,
    body,
    check,
    data.subarray(headerEnd),
  ]);
}

/** JPEG: an APP1 segment with the XMP, after the start marker and the JFIF/Exif segments. */
function markJpeg(data: Buffer, xmp: string): Buffer | null {
  if (data[0] !== 0xff || data[1] !== 0xd8) {
    return null;
  }
  let at = 2;
  // Skip APP0 (JFIF) and an APP1 that holds Exif: readers expect them first.
  while (
    at + 4 <= data.length &&
    data[at] === 0xff &&
    (data[at + 1] === 0xe0 || data[at + 1] === 0xe1)
  ) {
    at += 2 + data.readUInt16BE(at + 2);
  }
  const body = Buffer.concat([
    Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"),
    Buffer.from(xmp, "utf8"),
  ]);
  if (body.length + 2 > 0xffff) {
    return null;
  }
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([data.subarray(0, at), head, body, data.subarray(at)]);
}

/** The id of the box that holds XMP in an MP4 or QuickTime file. */
const XMP_BOX = Buffer.from("be7acfcb97a942e89c71999491e3afac", "hex");

/** MP4 / MOV: a top-level `uuid` box with the XMP, at the end of the file. */
function markMp4(data: Buffer, xmp: string): Buffer | null {
  if (data.toString("latin1", 4, 8) !== "ftyp") {
    return null;
  }
  const body = Buffer.from(xmp, "utf8");
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + XMP_BOX.length + body.length);
  head.write("uuid", 4, "latin1");
  return Buffer.concat([data, head, XMP_BOX, body]);
}

/**
 * The file with its marking. Returned unchanged when it is already marked, or of a kind this
 * cannot write (audio is tagged where it is encoded, see `speechTags`).
 */
export function markMedia(bytes: Uint8Array, mime: string, marking: Marking): Uint8Array {
  if (isMarked(bytes)) {
    return bytes;
  }
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const xmp = xmpPacket(marking);
  const marked =
    mime === "image/png"
      ? markPng(data, xmp)
      : mime === "image/jpeg"
        ? markJpeg(data, xmp)
        : mime === "video/mp4" || mime === "video/quicktime"
          ? markMp4(data, xmp)
          : null;
  return marked ? new Uint8Array(marked) : bytes;
}

/** What an audio file says about itself, as the tags ffmpeg writes (ID3 for MP3). */
export function speechTags(marking: Marking): Record<string, string> {
  return {
    comment: "AI-generated voice",
    DigitalSourceType: SOURCE_TYPE[marking.origin],
    ...(marking.system ? { AISystemUsed: marking.system } : {}),
    encoded_by: "engenty wizards",
  };
}
