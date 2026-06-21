export interface EnvelopeKeyReference {
  institutionDid: string;
  keyVersion: string;
  publicKeyRef: string;
}
export * from "./envelope-cipher.js";
export * from "./key-generation.js";
export * from "./key-rotation.js";
export * from "./sealed-secret-maps.js";
