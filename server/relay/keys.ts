/**
 * This computer's phone relay key (relay plan steps 1 and 2, 2026-09-26).
 *
 * An Ed25519 key pair made by node:crypto. The public half is the device
 * record's key at the account service. The private half is sealed by the
 * desktop's SecretBox (DPAPI on Windows, Keychain on macOS), the same protected
 * storage that keeps a sign-in, and is never logged, answered or written in the
 * clear. In memory it is a KeyObject, which prints and serializes without its
 * key material.
 */
import os from 'node:os';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { challengePayload, type ChallengeMessage } from '../../services/control-plane/src/relay/protocol.js';
import type { SecretBox } from '../connection-secrets.js';

export interface RelayKey {
  /** The raw 32-byte public key, base64url: what the device record holds. */
  publicKey: string;
  privateKey: KeyObject;
}

/** The public half of a private key, as the device record holds it. */
export function publicHalf(privateKey: KeyObject): string {
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  if (!x) throw new Error('A relay key is an Ed25519 key.');
  return x;
}

export function newRelayKey(): RelayKey {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: publicHalf(privateKey), privateKey };
}

/** base64 of the SecretBox's seal over the PKCS #8 key. */
export function sealRelayKey(box: SecretBox, privateKey: KeyObject): string {
  return box.seal(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')).toString('base64');
}

/** The key a sealed entry holds, or null when the box can't open it or it isn't an Ed25519 key. */
export function openRelayKey(box: SecretBox, sealed: string): KeyObject | null {
  try {
    const key = createPrivateKey({ key: Buffer.from(box.open(Buffer.from(sealed, 'base64')), 'base64'), format: 'der', type: 'pkcs8' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

/** The signature that answers a hub's challenge: base64url, over the protocol's challenge payload. */
export function proveChallenge(privateKey: KeyObject, challenge: Pick<ChallengeMessage, 'organizationId' | 'deviceId' | 'nonce'>): string {
  return sign(null, challengePayload(challenge), privateKey).toString('base64url');
}

/** This computer's name as the phone shows it: the host name, without control characters, up to 60 characters. */
export function computerLabel(hostname: string = os.hostname()): string {
  const clean = hostname.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60).replace(/[\ud800-\udbff]$/, '').trim();
  return clean || 'This computer';
}
