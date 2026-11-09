import { env, SELF } from "cloudflare:test";

export const BASE = "https://sawyerburner.test";

let seq = 0;
export function uniqueName(prefix = "user"): string {
  seq++;
  return `${prefix}_${seq}_${Math.random().toString(36).slice(2, 7)}`.slice(0, 20);
}

/** Minimal cookie-jar HTTP client that talks to the Worker like the real SPA does. */
export class Client {
  cookie = "";
  constructor(public ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`) {}

  async fetch(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const headers = new Headers({ "x-bb2-csrf": "1", origin: BASE, "cf-connecting-ip": this.ip, ...extraHeaders });
    if (this.cookie) headers.set("cookie", this.cookie);
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers.set("content-type", "application/json");
    }
    for (const [k, v] of Object.entries(extraHeaders)) if (v === "") headers.delete(k);
    const res = await SELF.fetch(new Request(BASE + path, { method, headers, body: payload }));
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const [pair] = setCookie.split(";");
      const [name, value] = pair.split("=");
      const expired = /max-age=0|expires=thu, 01 jan 1970/i.test(setCookie);
      this.cookie = value && !expired ? `${name}=${value}` : "";
    }
    return res;
  }

  async json<T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; data: T; res: Response }> {
    const res = await this.fetch(method, path, body, headers);
    const data = (await res.json().catch(() => null)) as T;
    return { status: res.status, data, res };
  }

  get = (path: string) => this.json("GET", path);
  post = (path: string, body?: unknown) => this.json("POST", path, body ?? {});
  del = (path: string) => this.json("DELETE", path);
}

export async function signup(username = uniqueName(), password = "correct horse battery"): Promise<Client & { username: string }> {
  const client = new Client() as Client & { username: string };
  const { status, data } = await client.post("/api/auth/signup", { username, password, confirmPassword: password, agree: true });
  if (status !== 201) throw new Error(`signup failed ${status} ${JSON.stringify(data)}`);
  client.username = username;
  return client;
}

export async function makeAdmin(username: string): Promise<void> {
  await env.DB.prepare("UPDATE users SET role = 'admin' WHERE username = ?").bind(username).run();
}

// ───────────── synthetic images ─────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  const typeBytes = new TextEncoder().encode(type);
  out.set(typeBytes, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A real, decodable RGB PNG with an optional tEXt metadata chunk. */
export async function makePng(width = 64, height = 48, text?: string): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([x * 4, y * 5, 128], y * (width * 3 + 1) + 1 + x * 3);
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", ihdr),
    ...(text ? [pngChunk("tEXt", new TextEncoder().encode(`Comment\0${text}`))] : []),
    pngChunk("IDAT", await deflate(raw)),
    pngChunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Structurally valid JPEG container with an EXIF (APP1) segment carrying `secret`. */
export function makeJpegWithExif(width: number, height: number, secret: string): Uint8Array {
  const enc = new TextEncoder();
  const seg = (marker: number, payload: Uint8Array) => {
    const out = new Uint8Array(4 + payload.length);
    out.set([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
    out.set(payload, 4);
    return out;
  };
  const exif = new Uint8Array([...enc.encode("Exif\0\0"), ...enc.encode(secret)]);
  const sof = Uint8Array.of(8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0);
  const sos = Uint8Array.of(1, 1, 0, 0, 63, 0);
  const parts = [
    Uint8Array.of(0xff, 0xd8),
    seg(0xe0, enc.encode("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
    seg(0xe1, exif),
    seg(0xc0, sof),
    seg(0xda, sos),
    Uint8Array.of(0x12, 0x34, 0x56, 0x78),
    Uint8Array.of(0xff, 0xd9),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function uploadForm(bytes: Uint8Array, { name = "photo.png", type = "image/png", consent = true, caption = "" } = {}): FormData {
  const form = new FormData();
  form.append("image", new File([bytes], name, { type }));
  if (consent) form.append("consent", "yes");
  if (caption) form.append("caption", caption);
  return form;
}

export async function uploadPng(client: Client, caption = ""): Promise<string> {
  const { status, data } = await client.json("POST", "/api/posts", uploadForm(await makePng(), { caption }));
  if (status !== 201) throw new Error(`upload failed ${status} ${JSON.stringify(data)}`);
  return data.post.id as string;
}
