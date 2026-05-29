const { decrypt, encrypt } = require("../utils/crypto");

function encryptCredentials(credentials = {}) {
  const encrypted = {};

  for (const key in credentials) {
    if (credentials[key]) {
      encrypted[key] = encrypt(credentials[key]);
    }
  }

  return encrypted;
}

// function decryptCredentials(encryptedCredentials = {}) {
//   const decrypted = {};

//   for (const key in encryptedCredentials) {
//     if (encryptedCredentials[key]) {
//       decrypted[key] = decrypt(encryptedCredentials[key]);
//     }
//   }

//   return decrypted;
// }
function decryptCredentials(credentials = {}) {
  const decrypted = {};

  for (const key in credentials) {
    const value = credentials[key];

    // ✅ skip missing / masked / null values
    if (!value || typeof value !== "object") continue;
    if (!value.iv || !value.content || !value.tag) continue;

    decrypted[key] = decrypt(value);
  }

  return decrypted;
}

function sanitizeCredentialsForUI(credentials) {
  if (!credentials) return null;

  const safe = {};

  for (const key of Object.keys(credentials)) {
    // Do NOT expose encrypted structure
    safe[key] = "configured"; // or ""
  }

  return safe;
}

module.exports = {
  encryptCredentials,
  decryptCredentials,
  sanitizeCredentialsForUI,
};
