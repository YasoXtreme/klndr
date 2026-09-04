const crypto = require("crypto");

// Encryption for integration tokens at rest.
//
// klndr's own session tokens sit in the database in the clear, and that is
// fine: they only unlock klndr, and anyone reading the database already has
// everything they would unlock. An integration's refresh token is different -
// it unlocks a *different* system, one whose data klndr does not otherwise
// hold. That asymmetry is the whole reason this file exists.
//
// AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
// than quietly producing a different token.

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const KEY_BYTES = 32;

let cachedKey = null;

function key() {
  if (cachedKey) return cachedKey;

  const raw = process.env.INTEGRATION_ENC_KEY;
  if (!raw) {
    // Deliberately fatal, and deliberately not defaulted. A hardcoded fallback
    // key is worse than a crash: everything would appear to work while the
    // tokens were effectively stored in the clear.
    throw new Error(
      "INTEGRATION_ENC_KEY must be set to use integrations. Generate one with:\n" +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }

  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `INTEGRATION_ENC_KEY must decode to ${KEY_BYTES} bytes, got ${decoded.length}. ` +
        "It should be 32 random bytes, base64 encoded.",
    );
  }

  cachedKey = decoded;
  return cachedKey;
}

/** Whether integrations can run at all. Lets the UI say so instead of throwing. */
function isConfigured() {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

// Stored as one string, "iv.tag.ciphertext" in base64, so a token is a single
// column and there is nothing to keep in sync.
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

function decrypt(value) {
  if (value === null || value === undefined) return null;
  const parts = String(value).split(".");
  if (parts.length !== 3) throw new Error("Stored token is not in the expected format.");

  const [iv, tag, ciphertext] = parts;
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key(),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

module.exports = { encrypt, decrypt, isConfigured };
