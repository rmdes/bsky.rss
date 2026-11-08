import {test} from 'node:test';
import assert from 'node:assert/strict';
import {absolutizeImageUrl, isYouTubeUrl, youtubeThumbnail} from './imageUrl.ts';

const page = 'https://cvefeed.io/vuln/detail/CVE-2026-99284';

test('absolutizeImageUrl keeps absolute http(s) URLs unchanged', () => {
  assert.equal(absolutizeImageUrl('https://cdn.example/a.jpg', page), 'https://cdn.example/a.jpg');
  assert.equal(absolutizeImageUrl('http://cdn.example/a.jpg', page), 'http://cdn.example/a.jpg');
});

test('absolutizeImageUrl resolves root-, protocol- and path-relative URLs against the page', () => {
  assert.equal(
    absolutizeImageUrl('/static/images/x.webp', page),
    'https://cvefeed.io/static/images/x.webp',
  );
  assert.equal(absolutizeImageUrl('//cdn.example/a.jpg', page), 'https://cdn.example/a.jpg');
  assert.equal(absolutizeImageUrl('img/a.png', page), 'https://cvefeed.io/vuln/detail/img/a.png');
});

test('absolutizeImageUrl trims whitespace', () => {
  assert.equal(absolutizeImageUrl('  /a.jpg\n', page), 'https://cvefeed.io/a.jpg');
});

test('absolutizeImageUrl rejects non-http(s), empty and unparseable input', () => {
  assert.equal(absolutizeImageUrl('javascript:alert(1)', page), undefined);
  assert.equal(absolutizeImageUrl('data:image/png;base64,AAAA', page), undefined);
  assert.equal(absolutizeImageUrl('', page), undefined);
  assert.equal(absolutizeImageUrl(undefined, page), undefined);
  assert.equal(absolutizeImageUrl('/a.jpg', 'not a url'), undefined);
});

test('isYouTubeUrl accepts watch, shorts, live, youtu.be and m.youtube.com links', () => {
  assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=lijKRTyrpg0'), true);
  assert.equal(isYouTubeUrl('https://youtube.com/watch?v=lijKRTyrpg0'), true);
  assert.equal(isYouTubeUrl('https://m.youtube.com/watch?v=lijKRTyrpg0'), true);
  assert.equal(isYouTubeUrl('https://www.youtube.com/shorts/PrQSogM4XPc'), true);
  assert.equal(isYouTubeUrl('https://www.youtube.com/live/abc123'), true);
  assert.equal(isYouTubeUrl('https://youtu.be/lijKRTyrpg0'), true);
});

test('isYouTubeUrl rejects channel pages, look-alike hosts and garbage', () => {
  assert.equal(isYouTubeUrl('https://www.youtube.com/@somechannel'), false);
  assert.equal(isYouTubeUrl('https://notyoutube.com/watch?v=x'), false);
  assert.equal(isYouTubeUrl('https://youtube.com.evil.test/watch?v=x'), false);
  assert.equal(isYouTubeUrl('https://youtu.be/'), false);
  assert.equal(isYouTubeUrl('not a url'), false);
});

function stubFetch(status: number, body: string): {fetchFn: typeof fetch; calls: string[]} {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(body, {status, headers: {'content-type': 'application/json'}});
  }) as typeof fetch;
  return {fetchFn, calls};
}

const options = {userAgent: 'test-agent', timeoutMs: 1000};

test('youtubeThumbnail returns thumbnail_url from the oEmbed endpoint', async () => {
  const {fetchFn, calls} = stubFetch(
    200,
    JSON.stringify({thumbnail_url: 'https://i.ytimg.com/vi/lijKRTyrpg0/hqdefault.jpg'}),
  );
  const url = 'https://www.youtube.com/watch?v=lijKRTyrpg0';
  assert.equal(
    await youtubeThumbnail(url, {...options, fetchFn}),
    'https://i.ytimg.com/vi/lijKRTyrpg0/hqdefault.jpg',
  );
  assert.equal(
    calls[0],
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
  );
});

test('youtubeThumbnail returns undefined on non-200, bad JSON, missing or non-https thumbnail, or a thrown fetch', async () => {
  const url = 'https://youtu.be/lijKRTyrpg0';
  assert.equal(
    await youtubeThumbnail(url, {...options, fetchFn: stubFetch(404, '{}').fetchFn}),
    undefined,
  );
  assert.equal(
    await youtubeThumbnail(url, {...options, fetchFn: stubFetch(200, 'not json').fetchFn}),
    undefined,
  );
  assert.equal(
    await youtubeThumbnail(url, {...options, fetchFn: stubFetch(200, '{}').fetchFn}),
    undefined,
  );
  assert.equal(
    await youtubeThumbnail(url, {
      ...options,
      fetchFn: stubFetch(200, JSON.stringify({thumbnail_url: 'http://i.ytimg.com/x.jpg'})).fetchFn,
    }),
    undefined,
  );
  const throwing = (async () => {
    throw new Error('network down');
  }) as typeof fetch;
  assert.equal(await youtubeThumbnail(url, {...options, fetchFn: throwing}), undefined);
});

test('absolutizeImageUrl keeps an absolute URL even when the base is invalid or missing', () => {
  const absolute = 'https://cdn.example/a.jpg';
  assert.equal(absolutizeImageUrl(absolute, 'not a url'), absolute);
  assert.equal(absolutizeImageUrl(absolute, undefined), absolute);
  assert.equal(absolutizeImageUrl('/a.jpg', undefined), undefined);
});

test('youtubeThumbnail reports why it found no thumbnail', async () => {
  const url = 'https://youtu.be/lijKRTyrpg0';
  const reasons: string[] = [];
  const onFailure = (reason: string) => reasons.push(reason);
  await youtubeThumbnail(url, {...options, onFailure, fetchFn: stubFetch(404, '{}').fetchFn});
  await youtubeThumbnail(url, {...options, onFailure, fetchFn: stubFetch(200, '{}').fetchFn});
  const throwing = (async () => {
    throw new Error('network down');
  }) as typeof fetch;
  await youtubeThumbnail(url, {...options, onFailure, fetchFn: throwing});
  assert.deepEqual(reasons, [
    'oEmbed returned HTTP 404',
    'oEmbed response has no https thumbnail_url',
    'oEmbed request failed: network down',
  ]);
});

test('youtubeThumbnail cancels the body of a non-ok oEmbed response', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode('{"error":"Unauthorized"}'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetchFn = (async () => new Response(body, {status: 401})) as typeof fetch;
  assert.equal(
    await youtubeThumbnail('https://youtu.be/lijKRTyrpg0', {...options, fetchFn}),
    undefined,
  );
  assert.equal(cancelled, true);
});
