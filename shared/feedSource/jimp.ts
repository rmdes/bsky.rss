// jimp's stock instance can't decode WebP ("Mime type image/webp does not support decoding"),
// which silently dropped card images from WebP og:image pages. This instance adds the official
// WebP format plugin; everything else matches `jimp`'s default Jimp. Import Jimp from here, and
// JimpMime from 'jimp' as before.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createJimp} from '@jimp/core';
import {defaultFormats, defaultPlugins} from 'jimp';
import webp from '@jimp/wasm-webp';

// The plugin's emscripten codec loads its .wasm with fetch(new URL(..., import.meta.url)), a
// file: URL, which Node's fetch rejects ("not implemented... yet..."). Serve file: URLs from disk
// and leave every other fetch untouched.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith('file:')) return nativeFetch(input, init);
  return readFile(fileURLToPath(url)).then(
    body => new Response(body, {headers: {'content-type': 'application/wasm'}}),
  );
};

export const Jimp = createJimp({
  formats: [...defaultFormats, webp],
  plugins: defaultPlugins,
});
