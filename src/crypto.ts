import nodeCrypto = require("node:crypto");
import * as openpgp from "openpgp";

import {
  type DatabaseConnection,
  getActiveUserKey,
  getDatabase,
  saveUserKey,
  type SaveUserKeyInput,
  type StoredUserKey,
} from "./db";

export interface GenerateUserKeyInput {
  userId: string;
  name: string;
  email: string;
  passphrase: string;
  passphraseHint?: string;
  database?: DatabaseConnection;
}

export interface GeneratedUserKey {
  id: number;
  userId: string;
  keyFingerprint: string;
  publicKeyArmored: string;
  passphraseHint: string | null;
}

export interface DecryptTextInput {
  userId: string;
  passphrase: string;
  database?: DatabaseConnection;
}

export async function generateUserKey(
  input: GenerateUserKeyInput,
): Promise<GeneratedUserKey> {
  assertNonEmpty(input.userId, "userId");
  assertNonEmpty(input.email, "email");
  assertNonEmpty(input.passphrase, "passphrase");

  const { privateKey, publicKey } = await openpgp.generateKey({
    type: "curve25519",
    userIDs: [{ name: input.name, email: input.email }],
    passphrase: input.passphrase,
    format: "armored",
  });

  const publicKeyObject = await readPublicKey(publicKey);
  const keyInput: SaveUserKeyInput = {
    userId: input.userId,
    keyFingerprint: publicKeyObject.getFingerprint(),
    publicKeyArmored: publicKey,
    privateKeyArmoredEncrypted: privateKey,
  };

  if (input.passphraseHint) {
    keyInput.passphraseHint = input.passphraseHint;
  }

  const storedKey = saveUserKey(keyInput, input.database ?? getDatabase());

  return {
    id: storedKey.id,
    userId: storedKey.userId,
    keyFingerprint: storedKey.keyFingerprint,
    publicKeyArmored: storedKey.publicKeyArmored,
    passphraseHint: storedKey.passphraseHint,
  };
}

export async function encryptText(
  plaintext: string,
  recipientPublicKeyArmored: string,
): Promise<string> {
  assertNonEmpty(plaintext, "plaintext");
  assertNonEmpty(recipientPublicKeyArmored, "recipientPublicKeyArmored");

  const recipientPublicKey = await readPublicKey(recipientPublicKeyArmored);
  const message = await openpgp.createMessage({ text: plaintext });

  return openpgp.encrypt({
    message,
    encryptionKeys: recipientPublicKey,
    format: "armored",
  });
}

export async function decryptText(
  armoredCiphertext: string,
  input: DecryptTextInput,
): Promise<string> {
  assertNonEmpty(armoredCiphertext, "armoredCiphertext");
  assertNonEmpty(input.userId, "userId");
  assertNonEmpty(input.passphrase, "passphrase");

  const storedKey = getActiveUserKey(input.userId, input.database ?? getDatabase());

  if (!storedKey) {
    throw new Error(`No active local private key found for user ${input.userId}.`);
  }

  return decryptTextWithStoredKey(armoredCiphertext, storedKey, input.passphrase);
}

export async function generateSafetyNumber(
  firstPublicKeyArmored: string,
  secondPublicKeyArmored: string,
): Promise<string> {
  assertNonEmpty(firstPublicKeyArmored, "firstPublicKeyArmored");
  assertNonEmpty(secondPublicKeyArmored, "secondPublicKeyArmored");

  const [firstPublicKey, secondPublicKey] = await Promise.all([
    readPublicKey(firstPublicKeyArmored),
    readPublicKey(secondPublicKeyArmored),
  ]);
  const fingerprints = [
    firstPublicKey.getFingerprint(),
    secondPublicKey.getFingerprint(),
  ]
    .map((fingerprint) => fingerprint.toLowerCase())
    .sort();
  const digest = nodeCrypto
    .createHash("sha256")
    .update(fingerprints.join(":"))
    .digest();
  const eightDigitValue = digest.readUInt32BE(0) % 100_000_000;

  return eightDigitValue.toString().padStart(8, "0");
}

async function decryptTextWithStoredKey(
  armoredCiphertext: string,
  storedKey: StoredUserKey,
  passphrase: string,
): Promise<string> {
  const privateKey = await openpgp.readPrivateKey({
    armoredKey: storedKey.privateKeyArmoredEncrypted,
  });
  const unlockedPrivateKey = await openpgp.decryptKey({
    privateKey,
    passphrase,
  });
  const message = await openpgp.readMessage({
    armoredMessage: armoredCiphertext,
  });
  const { data } = await openpgp.decrypt({
    message,
    decryptionKeys: unlockedPrivateKey,
    format: "utf8",
  });

  return data;
}

async function readPublicKey(armoredKey: string): Promise<openpgp.PublicKey> {
  const key = await openpgp.readKey({ armoredKey });

  if (!(key instanceof openpgp.PublicKey)) {
    throw new Error("Expected an armored OpenPGP public key.");
  }

  return key;
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} cannot be empty.`);
  }
}
