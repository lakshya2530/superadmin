// utils/encryption.js - FIXED VERSION
const crypto = require('crypto');

const algorithm = 'aes-256-gcm';
const secretKey = process.env.ENCRYPTION_KEY || 'your-default-32-char-key-here-12345';
const ivLength = 16;

// Helper function to ensure key is 32 bytes
function normalizeKey(key) {
    if (!key) {
        // Fallback to default
        return 'default-32-character-encryption-key!!';
    }
    
    // If key is too short, pad it
    if (key.length < 32) {
        key = key.padEnd(32, '0');
    }
    // If key is too long, truncate it
    else if (key.length > 32) {
        key = key.substring(0, 32);
    }
    
    return key;
}

function encrypt(text) {
    if (!text) return '';
    
    try {
        const normalizedKey = normalizeKey(secretKey);
        const iv = crypto.randomBytes(ivLength);
        const cipher = crypto.createCipheriv(algorithm, Buffer.from(normalizedKey), iv);
        
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        
        const authTag = cipher.getAuthTag();
        
        return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
    } catch (error) {
        console.error('Encryption error:', error);
        return text; // Fallback to plain text if encryption fails
    }
}

function decrypt(encryptedText) {
    if (!encryptedText) return '';
    
    try {
        // Check if it's actually encrypted (has : separators)
        if (!encryptedText.includes(':') || encryptedText.split(':').length !== 3) {
            return encryptedText; // Return as-is if not encrypted
        }
        
        const textParts = encryptedText.split(':');
        const iv = Buffer.from(textParts[0], 'hex');
        const authTag = Buffer.from(textParts[1], 'hex');
        const encrypted = textParts[2];
        
        const normalizedKey = normalizeKey(secretKey);
        const decipher = crypto.createDecipheriv(algorithm, Buffer.from(normalizedKey), iv);
        decipher.setAuthTag(authTag);
        
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
    } catch (error) {
        console.error('Decryption error:', error);
        return encryptedText; // Return as-is if decryption fails
    }
}

// Alternative: Use simpler encryption if you don't need strong encryption
function simpleEncrypt(text) {
    if (!text) return '';
    return Buffer.from(text).toString('base64');
}

function simpleDecrypt(encryptedText) {
    if (!encryptedText) return '';
    return Buffer.from(encryptedText, 'base64').toString('utf8');
}

module.exports = { 
    encrypt, 
    decrypt,
    simpleEncrypt,
    simpleDecrypt 
};