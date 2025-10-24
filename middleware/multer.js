const multer = require('multer');
const path = require('path');

// Set up memory storage for Multer (store the file temporarily in memory)
const storage = multer.memoryStorage();

// File filter function to limit the types of files allowed (e.g., images only)
const fileFilter = (req, file, cb) => {
  const fileTypes = /jpeg|jpg|png|gif/;  // Allowed file extensions (images)
  const extname = fileTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = fileTypes.test(file.mimetype);

  if (extname && mimetype) {
    return cb(null, true);  // File type is valid, proceed with upload
  } else {
    cb(new Error('Only image files (jpeg, jpg, png, gif) are allowed!'), false);  // Invalid file type
  }
};

// Set Multer file upload options
const upload = multer({
  storage: storage,                           // Store files in memory
  fileFilter: fileFilter,                     // Validate file types
  limits: { fileSize: 5 * 1024 * 1024 },      // Max file size of 5MB
}).single('profile_photo');                    // Handle single file upload with field name 'profile_photo'

// Middleware to handle Multer errors more clearly
const uploadMiddleware = (req, res, next) => {
  upload(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        // Handle Multer-specific errors
        return res.status(400).json({ error: err.message });
      } else {
        // Handle custom errors (e.g., from fileFilter)
        return res.status(400).json({ error: err.message });
      }
    }
    next();  // Proceed if no error
  });
};

// Export the multer configuration and middleware
module.exports = uploadMiddleware;
