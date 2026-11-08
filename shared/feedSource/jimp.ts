// jimp's stock instance can't decode WebP ("Mime type image/webp does not support decoding"), which
// silently dropped card images from WebP og:image pages. This instance adds a decode-only WebP format
// built on @jsquash/webp. Its WASM is compiled once from disk: @jimp/wasm-webp can't be used on Node
// (it fetch()es a file:// URL and re-initialises the codec on every decode). Images still leave as JPEG,
// so no WebP encoder is needed. Import Jimp from here, and JimpMime from 'jimp' as before.
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createJimp} from '@jimp/core';
import {defaultFormats, defaultPlugins} from 'jimp';
import decodeWebp, {init as initWebpDecoder} from '@jsquash/webp/decode.js';

let compiledDecoder: Promise<WebAssembly.Module> | undefined;
let decoderReady: Promise<void> | undefined;

function compileWebpDecoder(): Promise<WebAssembly.Module> {
  compiledDecoder ??= (async () => {
    const wasmPath = createRequire(import.meta.url).resolve(
      '@jsquash/webp/codec/dec/webp_dec.wasm',
    );
    return WebAssembly.compile(await readFile(wasmPath));
  })().catch(error => {
    compiledDecoder = undefined;
    throw error;
  });
  return compiledDecoder;
}

function loadWebpDecoder(): Promise<void> {
  decoderReady ??= compileWebpDecoder()
    .then(module => initWebpDecoder(module))
    .catch(error => {
      // Retries read/resolve/compile failures only: jsquash init() stores its emscripten promise
      // without awaiting it, so an instantiation failure stays cached inside jsquash.
      decoderReady = undefined;
      throw error;
    });
  return decoderReady;
}

// The decoder's WASM memory grows to fit the largest image it has decoded and never shrinks. After
// a large decode, drop the instance: the next decode instantiates a fresh, small one from the cached
// compiled module (jsquash init() replaces its instance), and the old memory can be collected.
// A decode already in flight keeps its own reference, so this can't break it.
export const WEBP_DECODER_RESET_BYTES = 16_000_000;

export function resetWebpDecoder(): void {
  decoderReady = undefined;
}

// Same limit as fleet's MAX_DECOMPRESSED_SIZE (w*h*4 bytes). jpeg-js refuses oversized images before
// decoding; a tiny lossless WebP can declare 16383x16383 and need ~1 GB of shared WASM heap, so check
// the header first.
export const MAX_WEBP_DECODED_BYTES = 100_000_000;

export function webpDimensions(data: Uint8Array): {width: number; height: number} {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (offset: number) =>
    offset + 4 <= data.length ? String.fromCharCode(...data.subarray(offset, offset + 4)) : '';
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') throw new Error('Not a WebP image');
  const chunk = tag(12);
  if (chunk === 'VP8X' && data.length >= 30) {
    return {
      width: 1 + (view.getUint16(24, true) | (view.getUint8(26) << 16)),
      height: 1 + (view.getUint16(27, true) | (view.getUint8(29) << 16)),
    };
  }
  if (chunk === 'VP8 ' && data.length >= 30) {
    return {width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff};
  }
  if (chunk === 'VP8L' && data.length >= 25 && view.getUint8(20) === 0x2f) {
    const bits = view.getUint32(21, true);
    return {width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff)};
  }
  throw new Error('Unrecognised or truncated WebP header');
}

const webp = () => ({
  mime: 'image/webp' as const,
  hasAlpha: true,
  encode: async (): Promise<Buffer> => {
    throw new Error('WebP encoding is not supported');
  },
  decode: async (data: Buffer) => {
    const {width, height} = webpDimensions(data);
    if (width * height * 4 > MAX_WEBP_DECODED_BYTES) {
      throw new Error(`WebP ${width}x${height} exceeds the decoded size limit`);
    }
    await loadWebpDecoder();
    const image = await decodeWebp(new Uint8Array(data).buffer);
    if (width * height * 4 > WEBP_DECODER_RESET_BYTES) resetWebpDecoder();
    return {
      data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength),
      width: image.width,
      height: image.height,
    };
  },
});

export const Jimp = createJimp({
  formats: [...defaultFormats, webp],
  plugins: defaultPlugins,
});
