import test from 'node:test';
import assert from 'node:assert/strict';
import { newToken, TOKEN_RE, ALPHABET } from '../src/util.js';

test('token: 10 chars from the Crockford alphabet, no I L O U', () => {
  for (let i = 0; i < 1000; i++) {
    const t = newToken();
    assert.equal(t.length, 10);
    assert.match(t, TOKEN_RE);
    assert.doesNotMatch(t, /[ILOU]/);
    for (const ch of t) assert.ok(ALPHABET.includes(ch));
  }
});

test('token: 10 000 iterations, zero collisions', () => {
  const seen = new Set();
  for (let i = 0; i < 10000; i++) seen.add(newToken());
  assert.equal(seen.size, 10000);
});

test('token: alphabet is the 32 Crockford characters', () => {
  assert.equal(ALPHABET.length, 32);
  assert.equal(new Set(ALPHABET).size, 32);
});

test('token: regex rejects lowercase, forbidden letters and wrong lengths', () => {
  assert.ok(TOKEN_RE.test('7K2M9QX4AB'));
  assert.ok(!TOKEN_RE.test('7k2m9qx4ab'));
  assert.ok(!TOKEN_RE.test('7K2M9QX4AI'));
  assert.ok(!TOKEN_RE.test('7K2M9QX4AL'));
  assert.ok(!TOKEN_RE.test('7K2M9QX4AO'));
  assert.ok(!TOKEN_RE.test('7K2M9QX4AU'));
  assert.ok(!TOKEN_RE.test('7K2M9QX4A'));
  assert.ok(!TOKEN_RE.test('7K2M9QX4ABC'));
});
