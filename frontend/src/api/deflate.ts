export const MESSAGE_MAX = 4 * 1024 * 1024;
export const MESSAGE_ROOM = 64 * 1024;
export const INLINE_MAX = 512 * 1024;

const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const piped = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

export function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return through(bytes, new CompressionStream("deflate"));
}

export function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  return through(bytes, new DecompressionStream("deflate"));
}

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function fits(bytes: number, besides = 0): boolean {
  return bytes + besides <= MESSAGE_MAX - MESSAGE_ROOM;
}

export function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
