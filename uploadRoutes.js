// uploadRoutes.js (example)

const express = require("express");
const router = express.Router();
const multer = require("multer");
const { cloudinary } = require("./cloudinaryConfig");

// Use multer memory storage (no disk)
const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post("/upload", upload.single("imageFile"), async (req, res) => {
  try {
    // req.file is the file from the `imageFile` field in formData
    const file = req.file;

    // Convert buffer to base64 if needed:
    // or pass a local file path if you used diskStorage
    const fileBase64 = `data:${file.mimetype};base64,${file.buffer.toString(
      "base64"
    )}`;

    // Upload to Cloudinary.
    // .upload() can accept a local file path, a buffer/base64 data URI, or remote URL.
    const result = await cloudinary.uploader.upload(fileBase64, {
      folder: "myAppUploads", // optional folder in your cloudinary account
    });

    // 'result.secure_url' is the final https link
    console.log("Uploaded to Cloudinary =>", result.secure_url);

    // Return the url to the client
    return res.json({ url: result.secure_url });
  } catch (error) {
    console.error("Cloudinary upload error =>", error);
    res.status(500).json({ error: "Upload failed" });
  }
});

module.exports = router;
