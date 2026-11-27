import test from 'node:test';
import assert from 'node:assert/strict';
import { clientIp } from '../src/util.js';

const req = (headers, peer = '127.0.0.1') => ({ headers, socket: { remoteAddress: peer } });

test('cloudflare: the visitor address wins over the edge address', () => {
  const r = req({ 'cf-ray': 'a5d2-LHR', 'cf-connecting-ip': '102.89.44.7', 'x-forwarded-for': '172.71.150.9' });
  assert.equal(clientIp(r), '102.89.44.7');
});

test('cloudflare: CF-Connecting-IP without CF-Ray is ignored (origin hit)', () => {
  const r = req({ 'cf-connecting-ip': '102.89.44.7', 'x-forwarded-for': '172.71.150.9' });
  assert.equal(clientIp(r), '172.71.150.9');
});

test('proxy: the last forwarded entry is the one Caddy appended', () => {
  const r = req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });
  assert.equal(clientIp(r), '203.0.113.9');
});

test('direct connection: the socket peer is the truth, headers ignored', () => {
  const r = req({ 'cf-ray': 'x', 'cf-connecting-ip': '1.2.3.4' }, '198.51.100.4');
  assert.equal(clientIp(r), '198.51.100.4');
});

test('ipv4-mapped peer is unwrapped', () => {
  const r = req({}, '::ffff:198.51.100.7');
  assert.equal(clientIp(r), '198.51.100.7');
});
