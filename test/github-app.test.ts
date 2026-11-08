import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { appJwt } from '../src/github-app.ts';

test('appJwt is an RS256 JWT that verifies and expires within 10 minutes', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = appJwt(123, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 1_000_000);
  const [h, b, s] = jwt.split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url')));
  const p = JSON.parse(Buffer.from(b, 'base64url').toString());
  assert.equal(p.iss, '123');
  assert.ok(p.exp - p.iat <= 600);
});
