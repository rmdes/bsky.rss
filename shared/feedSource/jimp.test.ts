import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JimpMime} from 'jimp';
import {Jimp} from './jimp.ts';
import {WEBP_4X4} from './test-helpers.ts';

test('the shared Jimp decodes WebP and re-encodes it as JPEG', async () => {
  assert.equal(WEBP_4X4.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(WEBP_4X4.subarray(8, 12).toString('ascii'), 'WEBP');

  const decoded = await Jimp.read(WEBP_4X4);
  assert.equal(decoded.bitmap.width, 4);
  assert.equal(decoded.bitmap.height, 4);
  const jpeg = await decoded.resize({w: 800}).getBuffer(JimpMime.jpeg, {quality: 80});
  assert.equal(jpeg[0], 0xff); // JPEG SOI marker
  assert.equal(jpeg[1], 0xd8);
});

test('decoding two WebP images in a row both succeed (cached decoder is reused)', async () => {
  for (let i = 0; i < 2; i++) {
    const decoded = await Jimp.read(WEBP_4X4);
    assert.equal(decoded.bitmap.width, 4);
    assert.equal(decoded.bitmap.height, 4);
  }
});
