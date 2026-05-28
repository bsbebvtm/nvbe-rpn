require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const fs = require("fs").promises;
const path = require("path");
const { createReadStream } = require("fs");

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ limit: "50mb" }));

// Upload config - Lưu file vào thư mục uploads
const upload = multer({
    dest: "uploads/",
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB max
    }
});

// Auth Middleware
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).json({
            error: "TOKEN REQUIRED"
        });
    }

    const token = authHeader.split(" ")[1];

    try {
        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        req.user = decoded;
        next();

    } catch (error) {
        return res.status(401).json({
            error: "INVALID TOKEN"
        });
    }
}

// Helper: Đọc file .txt với streaming (tối ưu cho file lớn)
async function readTextFileChunked(filePath, chunkSize = 8192) {
    const chunks = [];
    const stream = createReadStream(filePath, { encoding: "utf-8" });

    return new Promise((resolve, reject) => {
        stream.on("data", (chunk) => {
            chunks.push(chunk);
        });

        stream.on("end", () => {
            resolve(chunks.join(""));
        });

        stream.on("error", reject);
    });
}

// Helper: Xử lý file text nhanh
async function processTextFile(filePath) {
    try {
        const content = await readTextFileChunked(filePath);
        
        // Split thành chunks nhỏ để xử lý
        const lines = content.split("\n");
        const chunkData = {
            totalLines: lines.length,
            fileSize: (await fs.stat(filePath)).size,
            preview: lines.slice(0, 10).join("\n") // 10 dòng đầu
        };

        console.log(`✓ TXT processed: ${lines.length} lines, ${chunkData.fileSize} bytes`);
        return chunkData;

    } catch (error) {
        console.error("Error processing TXT:", error.message);
        throw error;
    }
}

// ========================
// ROUTES
// ========================

// Upload endpoint - Hỗ trợ upload 1 file hoặc nhiều files
app.post(
    "/api/upload",
    authMiddleware,
    upload.array("files", 10), // Max 10 files
    async (req, res) => {
        try {
            if (!req.files || req.files.length === 0) {
                return res.status(400).json({
                    error: "NO FILES"
                });
            }

            const results = [];

            // Xử lý từng file
            for (const file of req.files) {
                const tempPath = file.path;
                const originalName = file.originalname;
                const targetPath = path.join("uploads", originalName);

                try {
                    // Rename file
                    await fs.rename(tempPath, targetPath);

                    let fileData = {
                        filename: originalName,
                        size: file.size,
                        status: "uploaded"
                    };

                    // TXT File Processing
                    if (originalName.toLowerCase().endsWith(".txt")) {
                        const txtData = await processTextFile(targetPath);
                        fileData = {
                            ...fileData,
                            type: "text",
                            ...txtData
                        };
                    }
                    // PDF File Processing (khi cần)
                    else if (originalName.toLowerCase().endsWith(".pdf")) {
                        fileData.type = "pdf";
                        // TODO: Implement PDF processing
                    }

                    results.push(fileData);
                    console.log(`✓ File processed: ${originalName}`);

                } catch (fileError) {
                    console.error(`✗ Error processing ${originalName}:`, fileError.message);
                    results.push({
                        filename: originalName,
                        status: "error",
                        error: fileError.message
                    });
                }
            }

            res.json({
                success: true,
                totalFiles: results.length,
                files: results
            });

        } catch (error) {
            console.error("Upload error:", error);
            res.status(500).json({
                error: "UPLOAD FAILED",
                details: error.message
            });
        }
    }
);

// Get file content endpoint - Đọc file tối ưu
app.get(
    "/api/file/:filename",
    authMiddleware,
    async (req, res) => {
        try {
            const filename = req.params.filename;
            const filePath = path.join("uploads", filename);

            // Security: Prevent directory traversal
            if (!filePath.startsWith(path.resolve("uploads"))) {
                return res.status(403).json({ error: "FORBIDDEN" });
            }

            const stats = await fs.stat(filePath);

            if (!stats.isFile()) {
                return res.status(404).json({ error: "NOT FOUND" });
            }

            // Stream file nếu >1MB, load nếu <1MB
            if (stats.size > 1024 * 1024) {
                const stream = createReadStream(filePath);
                res.setHeader("Content-Type", "text/plain");
                stream.pipe(res);
            } else {
                const content = await fs.readFile(filePath, "utf-8");
                res.json({
                    filename,
                    size: stats.size,
                    content
                });
            }

        } catch (error) {
            console.error("File read error:", error);
            res.status(500).json({
                error: "READ FAILED",
                details: error.message
            });
        }
    }
);

// List uploaded files
app.get(
    "/api/files",
    authMiddleware,
    async (req, res) => {
        try {
            const files = await fs.readdir("uploads");
            const fileStats = await Promise.all(
                files.map(async (file) => {
                    const stats = await fs.stat(path.join("uploads", file));
                    return {
                        name: file,
                        size: stats.size,
                        createdAt: stats.birthtime
                    };
                })
            );

            res.json({
                totalFiles: fileStats.length,
                files: fileStats
            });

        } catch (error) {
            res.status(500).json({
                error: "LIST FAILED",
                details: error.message
            });
        }
    }
);

// ========================
// SERVER START
// ========================

const PORT = process.env.PORT || 3000;

// Tạo thư mục uploads nếu chưa tồn tại
const uploadDir = path.join(__dirname, "uploads");
fs.mkdir(uploadDir, { recursive: true }).catch(console.error);

app.listen(PORT, () => {
    console.log(`🚀 NVBE-AI running at port ${PORT}`);
    console.log(`📁 Upload directory: ${uploadDir}`);
});
