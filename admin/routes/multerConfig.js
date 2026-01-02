const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Create uploads directory if it doesn't exist
const uploadDir = 'uploads/tickets';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'attachment-' + uniqueSuffix + ext);
    }
});

// File filter for images
const fileFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|bmp|webp|svg|pdf|doc|docx|txt/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
        return cb(null, true);
    } else {
        cb(new Error('Only image and document files are allowed!'));
    }
};

// Create multer instance
const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

// Alternative upload for flexibility
const uploadFiles = (req, res, next) => {
    const uploadMiddleware = upload.array('attachments', 10);
    
    uploadMiddleware(req, res, function(err) {
        if (err) {
            // Handle different field names
            if (err.code === 'LIMIT_UNEXPECTED_FILE') {
                // Reset the multer instance with any field name
                const anyFieldUpload = multer({
                    storage: storage,
                    fileFilter: fileFilter,
                    limits: {
                        fileSize: 10 * 1024 * 1024
                    }
                }).any();
                
                anyFieldUpload(req, res, function(err2) {
                    if (err2) {
                        return next(err2);
                    }
                    next();
                });
            } else {
                return next(err);
            }
        } else {
            next();
        }
    });
};

module.exports = { upload, uploadFiles };