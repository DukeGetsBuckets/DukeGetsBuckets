// Image validation + metadata stripping, done on raw bytes (no native deps in Workers).
//
// - The format is decided by magic bytes only; the client-declared MIME type and file
//   name are ignored. SVG, GIF, HTML-disguised-as-image etc. are rejected.
// - Dimensions are parsed from the container headers and bounded.
// - EXIF / XMP / text metadata is removed so GPS coordinates, device serials and
//   timestamps baked in by phone cameras never get published (anti-doxxing).

import { MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS, type AllowedImageType } from "../../shared/rules";

export class ImageError extends Error {}

export interface ProcessedImage {
  mime: AllowedImageType;
  ext: "jpg" | "png" | "webp";
  width: number;
  height: number;
  bytes: Uint8Array;
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32le = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function sniffImageType(b: Uint8Array): AllowedImageType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && u32be(b, 0) === 0x89504e47 && u32be(b, 4) === 0x0d0a1a0a) return "image/png";
  if (b.length >= 16 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  return null;
}

// ───────────── JPEG ─────────────

function processJpeg(b: Uint8Array): { width: number; height: number; bytes: Uint8Array } {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  let width = 0;
  let height = 0;
  let sawScan = false;

  while (i < b.length) {
    if (b[i] !== 0xff) throw new ImageError("Corrupt JPEG.");
    while (i < b.length && b[i] === 0xff) i++; // fill bytes
    const marker = b[i++];
    if (marker === undefined) break;
    if (marker === 0xd9) {
      out.push(Uint8Array.of(0xff, 0xd9));
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(Uint8Array.of(0xff, marker));
      continue;
    }
    if (i + 2 > b.length) throw new ImageError("Corrupt JPEG.");
    const len = u16be(b, i);
    if (len < 2 || i + len > b.length) throw new ImageError("Corrupt JPEG.");
    const segStart = i - 2;
    const segEnd = i + len;

    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF && len >= 7) {
      height = u16be(b, i + 3);
      width = u16be(b, i + 5);
    }
    if (marker === 0xda) {
      // Start of scan: the rest is entropy-coded data (and, for progressive images,
      // further tables/scans). Copy verbatim.
      out.push(b.subarray(segStart));
      sawScan = true;
      break;
    }

    const isICC = marker === 0xe2 && ascii(b, i + 2, 11) === "ICC_PROFILE";
    const drop =
      marker === 0xe1 || // EXIF / XMP (GPS lives here)
      marker === 0xfe || // comments
      (marker === 0xe2 && !isICC) ||
      (marker >= 0xe3 && marker <= 0xed) ||
      marker === 0xef;
    if (!drop) out.push(b.subarray(segStart, segEnd));
    i = segEnd;
  }
  if (!sawScan) throw new ImageError("Corrupt JPEG.");
  return { width, height, bytes: concat(out) };
}

// ───────────── PNG ─────────────

const PNG_DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

function processPng(b: Uint8Array): { width: number; height: number; bytes: Uint8Array } {
  if (b.length < 33 || ascii(b, 12, 4) !== "IHDR") throw new ImageError("Corrupt PNG.");
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  let sawEnd = false;
  let sawData = false;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    const end = i + 12 + len;
    if (end > b.length) throw new ImageError("Corrupt PNG.");
    if (type === "IDAT") sawData = true;
    if (!PNG_DROP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd || !sawData) throw new ImageError("Corrupt PNG.");
  return { width, height, bytes: concat(out) };
}

// ───────────── WEBP ─────────────

function processWebp(b: Uint8Array): { width: number; height: number; bytes: Uint8Array } {
  const riffEnd = Math.min(b.length, 8 + u32le(b, 4));
  const chunks: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  let vp8x: Uint8Array | null = null;
  let i = 12;
  while (i + 8 <= riffEnd) {
    const fourcc = ascii(b, i, 4);
    const size = u32le(b, i + 4);
    const dataStart = i + 8;
    const end = dataStart + size + (size & 1);
    if (dataStart + size > riffEnd) throw new ImageError("Corrupt WEBP.");
    const d = b.subarray(dataStart, dataStart + size);

    if (fourcc === "VP8X" && size >= 10) {
      width = u24le(d, 4) + 1;
      height = u24le(d, 7) + 1;
      vp8x = b.slice(i, Math.min(end, riffEnd)); // copy: we edit its flags below
      chunks.push(vp8x);
    } else if (fourcc === "VP8 " && size >= 10) {
      if (!width && d[3] === 0x9d && d[4] === 0x01 && d[5] === 0x2a) {
        width = u16le(d, 6) & 0x3fff;
        height = u16le(d, 8) & 0x3fff;
      }
      chunks.push(b.subarray(i, Math.min(end, riffEnd)));
    } else if (fourcc === "VP8L" && size >= 5) {
      if (!width && d[0] === 0x2f) {
        const bits = u32le(d, 1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      }
      chunks.push(b.subarray(i, Math.min(end, riffEnd)));
    } else if (fourcc !== "EXIF" && fourcc !== "XMP ") {
      chunks.push(b.subarray(i, Math.min(end, riffEnd)));
    }
    i = end;
  }
  if (vp8x) vp8x[8] &= ~(0x08 | 0x04); // clear EXIF + XMP presence flags
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46]); // RIFF
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  header.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  return { width, height, bytes: concat([header, body]) };
}

export function processImage(input: Uint8Array): ProcessedImage {
  const mime = sniffImageType(input);
  if (!mime) throw new ImageError("Only JPG, PNG and WEBP images are allowed.");
  const result = mime === "image/jpeg" ? processJpeg(input) : mime === "image/png" ? processPng(input) : processWebp(input);
  const { width, height } = result;
  if (!width || !height) throw new ImageError("Couldn't read the image dimensions.");
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS)
    throw new ImageError("That image is way too big. Max 10,000px on a side.");
  if (width < 32 || height < 32) throw new ImageError("That image is too small.");
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : "webp";
  return { mime, ext, width, height, bytes: result.bytes };
}
