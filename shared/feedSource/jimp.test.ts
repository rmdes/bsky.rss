import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JimpMime} from 'jimp';
import {Jimp, webpDimensions} from './jimp.ts';
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

function forgedWebp(chunk: 'VP8L' | 'VP8X', width: number, height: number): Buffer {
  const body = Buffer.alloc(30, 0);
  body.write('RIFF', 0, 'ascii');
  body.writeUInt32LE(22, 4);
  body.write('WEBP', 8, 'ascii');
  body.write(chunk, 12, 'ascii');
  body.writeUInt32LE(10, 16);
  if (chunk === 'VP8L') {
    body[20] = 0x2f;
    body.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21);
  } else {
    body.writeUIntLE(width - 1, 24, 3);
    body.writeUIntLE(height - 1, 27, 3);
  }
  return body;
}

test('webpDimensions reads the size of a lossy WebP', () => {
  assert.deepEqual(webpDimensions(WEBP_4X4), {width: 4, height: 4});
});

test('webpDimensions throws on a non-WebP or truncated buffer', () => {
  assert.throws(() => webpDimensions(Buffer.from('not a webp image at all, really')));
  assert.throws(() => webpDimensions(WEBP_4X4.subarray(0, 20)));
});

test('a VP8L header declaring 16383x16383 is rejected before decoding', async () => {
  const forged = forgedWebp('VP8L', 16383, 16383);
  assert.deepEqual(webpDimensions(forged), {width: 16383, height: 16383});
  await assert.rejects(Jimp.read(forged), /size limit/);
});

test('a VP8X header declaring 20000x20000 is rejected before decoding', async () => {
  const forged = forgedWebp('VP8X', 20000, 20000);
  assert.deepEqual(webpDimensions(forged), {width: 20000, height: 20000});
  await assert.rejects(Jimp.read(forged), /size limit/);
});
