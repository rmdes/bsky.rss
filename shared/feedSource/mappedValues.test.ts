import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveMappedValues} from './mappedValues.ts';

test('resolveMappedValues returns an empty object without throwing when mappedValues is an object instead of an array', () => {
  // Confirmed real-world typo: a user writes mappedValues as a map ({"author": "dc:creator"})
  // because the option name reads like one. `mappedValues ?? []` still leaves a non-array
  // value in place, so `for...of` on it throws TypeError - this must degrade gracefully
  // instead, the same "unrecognized -> empty" convention the rest of this module follows.
  const item = {dc: {creators: ['Jane Doe']}};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const badConfig = {author: 'dc:creator'} as any;
  assert.doesNotThrow(() => resolveMappedValues(item, badConfig));
  assert.deepEqual(resolveMappedValues(item, badConfig), {});
});

test('resolveMappedValues returns an empty object without throwing when mappedValues is a non-array primitive', () => {
  const item = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.deepEqual(resolveMappedValues(item, 'oops' as any), {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.deepEqual(resolveMappedValues(item, 42 as any), {});
});

test('resolveMappedValues skips a malformed entry missing key without throwing or polluting the result', () => {
  const item = {dc: {creators: ['Jane Doe']}};
  const config = [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {value: 'dc:creator'} as any,
    {key: 'author', value: 'dc:creator'},
  ];
  assert.deepEqual(resolveMappedValues(item, config), {author: 'Jane Doe'});
});

test('resolveMappedValues skips a malformed entry missing value without throwing or polluting the result', () => {
  const item = {dc: {creators: ['Jane Doe']}};
  const config = [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {key: 'author'} as any,
    {key: 'author2', value: 'dc:creator'},
  ];
  assert.deepEqual(resolveMappedValues(item, config), {author2: 'Jane Doe'});
});

test('resolveMappedValues skips an entry whose key/value are the wrong type without throwing', () => {
  const item = {dc: {creators: ['Jane Doe']}};
  const config = [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {key: 123, value: 'dc:creator'} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {key: 'author', value: true} as any,
  ];
  assert.deepEqual(resolveMappedValues(item, config), {});
});

test('resolveMappedValues resolves dc:creator for a valid entry', () => {
  const item = {dc: {creators: ['Jane Doe']}};
  assert.deepEqual(resolveMappedValues(item, [{key: 'author', value: 'dc:creator'}]), {
    author: 'Jane Doe',
  });
});
