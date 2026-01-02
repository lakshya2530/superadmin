// config/profileMulter.js
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Create profile uploads directory
const profileUploadDir = 'uploads/profiles';
if (!fs.existsSync(profileUploadDir)) {
    fs.mkdirSync(profileUploadDir, { recursive: true });
}

// Configure storage for profile images
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, profileUploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        const userId = req.params.id || 'unknown';
        cb(null, `profile-${userId}-${uniqueSuffix}${ext}`);
    }
});

// File filter for profile images only
const fileFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
        return cb(null, true);
    } else {
        cb(new Error('Only image files are allowed for profile pictures!'));
    }
};

// Create multer instance
const profileUpload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit for profile images
    }
});

module.exports = profileUpload;