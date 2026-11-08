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

let decoderReady: Promise<void> | undefined;

function loadWebpDecoder(): Promise<void> {
  decoderReady ??= (async () => {
    const wasmPath = createRequire(import.meta.url).resolve(
      '@jsquash/webp/codec/dec/webp_dec.wasm',
    );
    await initWebpDecoder(await WebAssembly.compile(await readFile(wasmPath)));
  })().catch(error => {
    decoderReady = undefined; // let the next image retry instead of caching the failure forever
    throw error;
  });
  return decoderReady;
}

const webp = () => ({
  mime: 'image/webp' as const,
  hasAlpha: true,
  encode: async (): Promise<Buffer> => {
    throw new Error('WebP encoding is not supported');
  },
  decode: async (data: Buffer) => {
    await loadWebpDecoder();
    const image = await decodeWebp(new Uint8Array(data).buffer);
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
