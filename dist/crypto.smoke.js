"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto_1 = require("./crypto");
const db_1 = require("./db");
async function main() {
    const databasePath = path.join(os.tmpdir(), "unsync-mail-crypto-smoke.sqlite");
    removeDatabaseFiles(databasePath);
    const database = (0, db_1.openDatabase)(databasePath);
    try {
        const passphrase = "correct horse battery staple";
        const plaintext = "Unsync Mail keeps this round trip local.";
        const generatedKey = await (0, crypto_1.generateUserKey)({
            userId: "smoke-user",
            name: "Smoke Test",
            email: "smoke@example.test",
            passphrase,
            passphraseHint: "test fixture",
            database,
        });
        const recipientKey = await (0, crypto_1.generateUserKey)({
            userId: "recipient-user",
            name: "Recipient Test",
            email: "recipient@example.test",
            passphrase: "recipient passphrase",
            database,
        });
        const storedKey = database
            .prepare(`
          SELECT
            public_key_armored AS publicKeyArmored,
            private_key_armored_encrypted AS privateKeyArmoredEncrypted,
            key_fingerprint AS keyFingerprint
          FROM user_keys
          WHERE user_id = @userId
            AND is_active = 1
        `)
            .get({ userId: "smoke-user" });
        assert.ok(storedKey, "generated key should be stored in user_keys");
        assert.equal(storedKey.keyFingerprint, generatedKey.keyFingerprint);
        assert.match(storedKey.privateKeyArmoredEncrypted, /-----BEGIN PGP PRIVATE KEY BLOCK-----/);
        assert.notEqual(storedKey.privateKeyArmoredEncrypted, storedKey.publicKeyArmored);
        const armoredCiphertext = await (0, crypto_1.encryptText)(plaintext, storedKey.publicKeyArmored);
        assert.match(armoredCiphertext, /-----BEGIN PGP MESSAGE-----/);
        const decryptedPlaintext = await (0, crypto_1.decryptText)(armoredCiphertext, {
            userId: "smoke-user",
            passphrase,
            database,
        });
        assert.equal(decryptedPlaintext, plaintext);
        const safetyNumber = await (0, crypto_1.generateSafetyNumber)(generatedKey.publicKeyArmored, recipientKey.publicKeyArmored);
        const reversedSafetyNumber = await (0, crypto_1.generateSafetyNumber)(recipientKey.publicKeyArmored, generatedKey.publicKeyArmored);
        assert.match(safetyNumber, /^\d{8}$/);
        assert.equal(safetyNumber, reversedSafetyNumber);
        console.log("crypto smoke test passed");
    }
    finally {
        database.close();
        removeDatabaseFiles(databasePath);
    }
}
function removeDatabaseFiles(databasePath) {
    for (const suffix of ["", "-wal", "-shm"]) {
        fs.rmSync(databasePath + suffix, { force: true });
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
//# sourceMappingURL=crypto.smoke.js.map