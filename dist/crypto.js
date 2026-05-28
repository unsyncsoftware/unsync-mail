"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateUserKey = generateUserKey;
exports.encryptText = encryptText;
exports.decryptText = decryptText;
exports.generateSafetyNumber = generateSafetyNumber;
const nodeCrypto = require("node:crypto");
const openpgp = __importStar(require("openpgp"));
const db_1 = require("./db");
async function generateUserKey(input) {
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
    const keyInput = {
        userId: input.userId,
        keyFingerprint: publicKeyObject.getFingerprint(),
        publicKeyArmored: publicKey,
        privateKeyArmoredEncrypted: privateKey,
    };
    if (input.passphraseHint) {
        keyInput.passphraseHint = input.passphraseHint;
    }
    const storedKey = (0, db_1.saveUserKey)(keyInput, input.database ?? (0, db_1.getDatabase)());
    return {
        id: storedKey.id,
        userId: storedKey.userId,
        keyFingerprint: storedKey.keyFingerprint,
        publicKeyArmored: storedKey.publicKeyArmored,
        passphraseHint: storedKey.passphraseHint,
    };
}
async function encryptText(plaintext, recipientPublicKeyArmored) {
    assertNonEmpty(plaintext, "plaintext");
    const recipientPublicKeysArmored = Array.isArray(recipientPublicKeyArmored)
        ? recipientPublicKeyArmored
        : [recipientPublicKeyArmored];
    if (recipientPublicKeysArmored.length === 0) {
        throw new Error("recipientPublicKeyArmored must not be empty.");
    }
    for (const publicKeyArmored of recipientPublicKeysArmored) {
        assertNonEmpty(publicKeyArmored, "recipientPublicKeyArmored");
    }
    const recipientPublicKeys = await Promise.all(recipientPublicKeysArmored.map((publicKeyArmored) => readPublicKey(publicKeyArmored)));
    const message = await openpgp.createMessage({ text: plaintext });
    return openpgp.encrypt({
        message,
        encryptionKeys: recipientPublicKeys,
        format: "armored",
    });
}
async function decryptText(armoredCiphertext, input) {
    assertNonEmpty(armoredCiphertext, "armoredCiphertext");
    assertNonEmpty(input.userId, "userId");
    assertNonEmpty(input.passphrase, "passphrase");
    const storedKey = (0, db_1.getActiveUserKey)(input.userId, input.database ?? (0, db_1.getDatabase)());
    if (!storedKey) {
        throw new Error(`No active local private key found for user ${input.userId}.`);
    }
    return decryptTextWithStoredKey(armoredCiphertext, storedKey, input.passphrase);
}
async function generateSafetyNumber(firstPublicKeyArmored, secondPublicKeyArmored) {
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
async function decryptTextWithStoredKey(armoredCiphertext, storedKey, passphrase) {
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
async function readPublicKey(armoredKey) {
    const key = await openpgp.readKey({ armoredKey });
    if (!(key instanceof openpgp.PublicKey)) {
        throw new Error("Expected an armored OpenPGP public key.");
    }
    return key;
}
function assertNonEmpty(value, label) {
    if (value.trim().length === 0) {
        throw new Error(`${label} cannot be empty.`);
    }
}
//# sourceMappingURL=crypto.js.map