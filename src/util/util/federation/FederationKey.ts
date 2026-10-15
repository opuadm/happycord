/* SPDX-License-Identifier: AGPL-3.0-only */
import crypto, { KeyObject } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rawPublicKey } from "./Protocol";

export const FEDERATION_KEY_FILE = "federation.key";

export class FederationKey {
    static #privateKey?: KeyObject;
    static #publicKey?: KeyObject;

    static init(file = FEDERATION_KEY_FILE) {
        if (this.#privateKey) return;
        let privateKey: KeyObject;
        if (existsSync(file)) {
            privateKey = crypto.createPrivateKey(readFileSync(file));
            if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`${path.resolve(file)} is not an Ed25519 private key`);
        } else {
            console.log("[Federation] Generating the instance key:", path.resolve(file));
            privateKey = crypto.generateKeyPairSync("ed25519").privateKey;
            writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
        }
        this.#privateKey = privateKey;
        this.#publicKey = crypto.createPublicKey(privateKey);
    }

    static restore(file = FEDERATION_KEY_FILE) {
        if (!this.#privateKey || existsSync(file)) return;
        console.log("[Federation] The instance key file disappeared, saving it again");
        writeFileSync(file, this.#privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
    }

    static get privateKey() {
        if (!this.#privateKey) throw new Error("FederationKey used before init");
        return this.#privateKey;
    }

    static get publicKey() {
        if (!this.#publicKey) throw new Error("FederationKey used before init");
        return rawPublicKey(this.#publicKey);
    }

    static get ready() {
        return !!this.#privateKey;
    }
}
