import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });
if (!jwk.x || !jwk.y || !jwk.d) throw new Error('Could not export the generated P-256 key pair.');
const publicKey = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(jwk.x, 'base64url'),
  Buffer.from(jwk.y, 'base64url'),
]).toString('base64url');

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.log('\nPut the public key and VAPID_SUBJECT in wrangler.toml. Store the private key with:');
console.log('npx wrangler secret put VAPID_PRIVATE_KEY');
