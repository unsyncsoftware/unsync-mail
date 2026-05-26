import assert = require("node:assert/strict");
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");

import {
  decryptText,
  encryptText,
  generateSafetyNumber,
  generateUserKey,
} from "./crypto";
import { openDatabase } from "./db";

async function main(): Promise<void> {
  const databasePath = path.join(os.tmpdir(), "unsync-mail-crypto-smoke.sqlite");

  removeDatabaseFiles(databasePath);

  const database = openDatabase(databasePath);

  try {
    const passphrase = "correct horse battery staple";
    const plaintext = "Unsync Mail keeps this round trip local.";
    const generatedKey = await generateUserKey({
      userId: "smoke-user",
      name: "Smoke Test",
      email: "smoke@example.test",
      passphrase,
      passphraseHint: "test fixture",
      database,
    });
    const recipientKey = await generateUserKey({
      userId: "recipient-user",
      name: "Recipient Test",
      email: "recipient@example.test",
      passphrase: "recipient passphrase",
      database,
    });

    const storedKey = database
      .prepare<
        { userId: string },
        {
          publicKeyArmored: string;
          privateKeyArmoredEncrypted: string;
          keyFingerprint: string;
        }
      >(
        `
          SELECT
            public_key_armored AS publicKeyArmored,
            private_key_armored_encrypted AS privateKeyArmoredEncrypted,
            key_fingerprint AS keyFingerprint
          FROM user_keys
          WHERE user_id = @userId
            AND is_active = 1
        `,
      )
      .get({ userId: "smoke-user" });

    assert.ok(storedKey, "generated key should be stored in user_keys");
    assert.equal(storedKey.keyFingerprint, generatedKey.keyFingerprint);
    assert.match(
      storedKey.privateKeyArmoredEncrypted,
      /-----BEGIN PGP PRIVATE KEY BLOCK-----/,
    );
    assert.notEqual(storedKey.privateKeyArmoredEncrypted, storedKey.publicKeyArmored);

    const armoredCiphertext = await encryptText(
      plaintext,
      storedKey.publicKeyArmored,
    );
    assert.match(armoredCiphertext, /-----BEGIN PGP MESSAGE-----/);

    const decryptedPlaintext = await decryptText(armoredCiphertext, {
      userId: "smoke-user",
      passphrase,
      database,
    });

    assert.equal(decryptedPlaintext, plaintext);

    const safetyNumber = await generateSafetyNumber(
      generatedKey.publicKeyArmored,
      recipientKey.publicKeyArmored,
    );
    const reversedSafetyNumber = await generateSafetyNumber(
      recipientKey.publicKeyArmored,
      generatedKey.publicKeyArmored,
    );

    assert.match(safetyNumber, /^\d{8}$/);
    assert.equal(safetyNumber, reversedSafetyNumber);

    console.log("crypto smoke test passed");
  } finally {
    database.close();
    removeDatabaseFiles(databasePath);
  }
}

function removeDatabaseFiles(databasePath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(databasePath + suffix, { force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
