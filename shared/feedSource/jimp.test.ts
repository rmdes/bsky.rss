import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JimpMime} from 'jimp';
import {Jimp} from './jimp.ts';

test('the shared Jimp decodes WebP and re-encodes it as JPEG', async () => {
  const webp = await new Jimp({width: 4, height: 4, color: 0x3366ccff}).getBuffer('image/webp');
  assert.equal(webp.subarray(8, 12).toString('ascii'), 'WEBP');

  const decoded = await Jimp.read(webp);
  assert.equal(decoded.bitmap.width, 4);
  const jpeg = await decoded.resize({w: 800}).getBuffer(JimpMime.jpeg, {quality: 80});
  assert.equal(jpeg[0], 0xff); // JPEG SOI marker
  assert.equal(jpeg[1], 0xd8);
});
