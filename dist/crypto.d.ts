import { type DatabaseConnection } from "./db";
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
export declare function generateUserKey(input: GenerateUserKeyInput): Promise<GeneratedUserKey>;
export declare function encryptText(plaintext: string, recipientPublicKeyArmored: string | string[]): Promise<string>;
export declare function decryptText(armoredCiphertext: string, input: DecryptTextInput): Promise<string>;
export declare function generateSafetyNumber(firstPublicKeyArmored: string, secondPublicKeyArmored: string): Promise<string>;
//# sourceMappingURL=crypto.d.ts.map