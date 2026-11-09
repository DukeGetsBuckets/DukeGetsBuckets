import { describe, expect, it } from "vitest";
import { processImage, sniffImageType } from "../worker/lib/image";
import { cleanText, moderationProblem, validateUsername } from "../worker/lib/moderation";
import { makePng } from "./helpers";

describe("moderation", () => {
  it("allows normal roasts without false positives", () => {
    const fine = [
      "You look like you'd lose a staring contest to a mirror",
      "Sniggering at this fit tbh",
      "Scunthorpe called, they want their haircut back",
      "Grape juice stain on the shirt is a choice",
      "He's 6 foot 2 in his dreams",
      "Rated 2/10, the 2 is for the dog",
      "that's a tuesday fit on a friday",
    ];
    for (const text of fine) expect(moderationProblem(text), text).toBeNull();
  });

  it("flags doxxing, threats, links and slurs, including obfuscation", () => {
    const bad = [
      "(415) 555-0199",
      "+44 20 7946 0958",
      "123-45-6789",
      "he lives at 22 baker st",
      "his password is hunter2",
      "https://example.com",
      "go to www.site.io",
      "k y s",
      "i will kill you",
      "i know where he lives",
      "f a g g o t",
      "n1gg3r",
    ];
    for (const text of bad) expect(moderationProblem(text), text).not.toBeNull();
  });

  it("strips invisible characters and control codes, enforces length", () => {
    expect(cleanText("he​llo‮ wor\u0007ld", 50)).toBe("hello world");
    expect(cleanText("a\n\n\n\n\nb", 50)).toBe("a\n\nb");
    expect(cleanText("x".repeat(11), 10).startsWith("\u0000")).toBe(true);
    expect(cleanText("🔥".repeat(10), 10)).toBe("🔥".repeat(10)); // counted by code point
  });

  it("normalises and validates usernames", () => {
    expect(validateUsername("  Sawyer_23 ")).toBe("sawyer_23");
    expect(() => validateUsername("___")).toThrow();
    expect(() => validateUsername("moderator")).toThrow();
    expect(() => validateUsername("robert'); DROP TABLE users;--")).toThrow();
  });
});

describe("image processing", () => {
  it("sniffs by magic bytes only", async () => {
    expect(sniffImageType(await makePng())).toBe("image/png");
    expect(sniffImageType(new TextEncoder().encode("<svg></svg>"))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("GIF89a......"))).toBeNull();
  });

  it("strips EXIF/XMP from WEBP and clears the VP8X flags", () => {
    const enc = new TextEncoder();
    const chunk = (fourcc: string, data: Uint8Array) => {
      const pad = data.length & 1;
      const out = new Uint8Array(8 + data.length + pad);
      out.set(enc.encode(fourcc));
      new DataView(out.buffer).setUint32(4, data.length, true);
      out.set(data, 8);
      return out;
    };
    const w = 300, h = 200;
    const vp8x = new Uint8Array(10);
    vp8x[0] = 0x08 | 0x04; // EXIF + XMP flags
    vp8x.set([(w - 1) & 0xff, ((w - 1) >> 8) & 0xff, 0, (h - 1) & 0xff, ((h - 1) >> 8) & 0xff, 0], 4);
    const bits = (w - 1) | ((h - 1) << 14);
    const vp8l = Uint8Array.of(0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0, 0);
    const body = [chunk("VP8X", vp8x), chunk("VP8L", vp8l), chunk("EXIF", enc.encode("GPS-SECRET")), chunk("XMP ", enc.encode("<xmp>SECRET2</xmp>"))];
    const len = body.reduce((n, c) => n + c.length, 0);
    const file = new Uint8Array(12 + len);
    file.set(enc.encode("RIFF"));
    new DataView(file.buffer).setUint32(4, len + 4, true);
    file.set(enc.encode("WEBP"), 8);
    let o = 12;
    for (const c of body) {
      file.set(c, o);
      o += c.length;
    }

    const out = processImage(file);
    expect(out).toMatchObject({ mime: "image/webp", width: w, height: h });
    const text = new TextDecoder().decode(out.bytes);
    expect(text).not.toContain("SECRET");
    expect(out.bytes[12 + 8] & 0x0c).toBe(0);
    expect(new DataView(out.bytes.buffer).getUint32(4, true)).toBe(out.bytes.length - 8);
  });

  it("rejects absurd dimensions and tiny images", async () => {
    const tiny = await makePng(10, 10);
    expect(() => processImage(tiny)).toThrow(/too small/);
  });
});
