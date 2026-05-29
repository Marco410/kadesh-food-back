const crypto = require('crypto');
const { CONFIG } = require("../config");

const SECRET = Buffer.from(CONFIG.ENCRYPTION_KEY, 'hex');
const ALGO = 'aes-256-cbc';

exports.encrypt = (text) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, SECRET, iv);
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
};

exports.decrypt = (data) => {
  const [ivHex, encData] = data.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encData, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, SECRET, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString();
};
