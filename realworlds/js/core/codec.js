/* 解压原语：浏览器原生 DecompressionStream，零依赖 */

export async function blobBytes(blob) {
  if (blob instanceof Uint8Array) return blob;
  return new Uint8Array(await blob.arrayBuffer());
}

export async function headBytes(blob, n = 1024) {
  const slice = blob.slice(0, n);
  return new Uint8Array(await slice.arrayBuffer());
}

async function pipe(bytes, format) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 DecompressionStream');
  }
  const ds = new DecompressionStream(format);
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const inflateRaw = (bytes) => pipe(bytes, 'deflate-raw');
export const inflateZlib = (bytes) => pipe(bytes, 'deflate');
export const gunzip = (bytes) => pipe(bytes, 'gzip');

export function startsWith(bytes, sig, offset = 0) {
  if (!bytes || bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig.charCodeAt(i)) return false;
  return true;
}
export function startsWithBytes(bytes, sig) {
  if (!bytes || bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}
