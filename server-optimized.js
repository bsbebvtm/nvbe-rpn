require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const db = require("./database");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const jwt = require("jsonwebtoken");

const app = express();

// ===== CONFIGURATION =====
const CHUNK_SIZE = 3000; // characters per chunk
const MAX_CHUNKS_FOR_CONTEXT = 5; // max chunks to send to GPT
const CACHE_DURATION = 3600000; // 1 hour in ms

// ===== STORAGE & CACHE =====
const upload = multer({
    dest: "uploads/",
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
});

app.use(express.static("public"));
app.use(express.json({ limit: "50mb" }));

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// In-memory cache with TTL
const knowledgeCache = {
    data: null,
    timestamp: null,
    isValid() {
        return this.data && (Date.now() - this.timestamp < CACHE_DURATION);
    },
    invalidate() {
        this.data = null;
        this.timestamp = null;
    }
};

// ===== MIDDLEWARE =====
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).json({
            error: "TOKEN REQUIRED"
        });
    }

    const token = authHeader.split(" ")[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({
            error: "INVALID TOKEN"
        });
    }
}

// ===== UTILITY FUNCTIONS =====

// Read file in chunks (memory efficient)
async function readFileInChunks(filePath) {
    try {
        const content = await fs.readFile(filePath, "utf8");
        const chunks = [];
        
        for (let i = 0; i < content.length; i += CHUNK_SIZE) {
            chunks.push(content.substring(i, i + CHUNK_SIZE));
        }
        
        return chunks;
    } catch (error) {
        console.error(`Error reading file ${filePath}:`, error);
        return [];
    }
}

// Extract text from PDF with streaming
async function extractPdfText(filePath) {
    try {
        const dataBuffer = await fs.readFile(filePath);
        const pdfData = await pdfParse(dataBuffer);
        return pdfData.text;
    } catch (error) {
        console.error(`Error parsing PDF ${filePath}:`, error);
        return "";
    }
}

// Load knowledge asynchronously with caching
async function loadKnowledgeOptimized() {
    // Check cache first
    if (knowledgeCache.isValid()) {
        console.log("Using cached knowledge");
        return knowledgeCache.data;
    }

    const knowledgeMap = {};
    
    try {
        const uploadsDir = "./uploads";
        
        // Check if directory exists
        if (!fsSync.existsSync(uploadsDir)) {
            return knowledgeMap;
        }

        const files = await fs.readdir(uploadsDir);
        const filePromises = [];

        for (const file of files) {
            const filePath = path.join(uploadsDir, file);

            if (file.endsWith(".txt")) {
                filePromises.push(
                    readFileInChunks(filePath).then(chunks => ({
                        filename: file,
                        chunks: chunks,
                        type: "text"
                    }))
                );
            } else if (file.endsWith(".pdf")) {
                filePromises.push(
                    extractPdfText(filePath).then(text => ({
                        filename: file,
                        chunks: [
                            ...text.substring(0, text.length / 2).match(new RegExp(`.{1,${CHUNK_SIZE}}`, 'g')) || [],
                            ...text.substring(text.length / 2).match(new RegExp(`.{1,${CHUNK_SIZE}}`, 'g')) || []
                        ].filter(c => c),
                        type: "pdf"
                    }))
                );
            }
        }

        // Wait for all files to be processed
        const results = await Promise.all(filePromises);
        
        results.forEach(item => {
            knowledgeMap[item.filename] = {
                chunks: item.chunks,
                type: item.type,
                chunkCount: item.chunks.length
            };
        });

        // Cache the result
        knowledgeCache.data = knowledgeMap;
        knowledgeCache.timestamp = Date.now();

        console.log(`✓ Knowledge loaded: ${Object.keys(knowledgeMap).length} files`);
        return knowledgeMap;

    } catch (error) {
        console.error("Error loading knowledge:", error);
        return knowledgeMap;
    }
}

// Search for relevant chunks (simple keyword matching)
function searchRelevantChunks(knowledge, query, maxChunks = MAX_CHUNKS_FOR_CONTEXT) {
    const results = [];
    const queryWords = query.toLowerCase().split(" ");

    for (const [filename, data] of Object.entries(knowledge)) {
        for (let i = 0; i < data.chunks.length; i++) {
            const chunk = data.chunks[i].toLowerCase();
            const matchCount = queryWords.filter(word => chunk.includes(word)).length;

            if (matchCount > 0) {
                results.push({
                    filename,
                    chunk: data.chunks[i],
                    relevance: matchCount,
                    chunkIndex: i
                });
            }
        }
    }

    // Sort by relevance and return top chunks
    return results
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, maxChunks)
        .map(r => r.chunk)
        .join("\n\n---\n\n");
}

// ===== ROUTES =====

// Chat endpoint (optimized with chunking)
app.post("/chat", async (req, res) => {
    try {
        const userMessage = req.body.message;
        let sessionId = req.body.sessionId;

        if (!sessionId) {
            sessionId = uuidv4();
        }

        // Save user message to DB (non-blocking)
        db.run(
            "INSERT INTO messages (session_id, role, message) VALUES (?, ?, ?)",
            [sessionId, "user", userMessage]
        );

        // Get chat history
        const rows = await new Promise((resolve, reject) => {
            db.all(
                "SELECT role, message FROM messages WHERE session_id = ? ORDER BY id ASC",
                [sessionId],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });

        // Load knowledge (cached)
        const knowledge = await loadKnowledgeOptimized();
        const relevantContext = searchRelevantChunks(knowledge, userMessage);

        let messages = [
            {
                role: "system",
                content: `
Bạn là trợ lý AI của Bệnh viện Đa khoa Khu vực Tháp Mười.

📋 THÔNG TIN BỆNH VIỆN:
${relevantContext || "Không có thông tin chi tiết"}

📌 NHIỆM VỤ:
- Hỗ trợ người bệnh về thông tin bệnh viện
- Ghi nhớ thông tin người dùng trong lịch sử chat
- Trả lời dựa trên thông tin bệnh viện
- Hướng dẫn khám bệnh
- Trả lời lịch sự, dễ hiểu
- Nếu không có thông tin, hãy thông báo rõ
`
            }
        ];

        // Add conversation history
        rows.forEach((row) => {
            messages.push({
                role: row.role,
                content: row.message
            });
        });

        // Add current message
        messages.push({
            role: "user",
            content: userMessage
        });

        // Call GPT-4 with optimized context
        const completion = await openai.chat.completions.create({
            model: "gpt-4-turbo", // Using turbo for faster response
            messages: messages,
            temperature: 0.7,
            max_tokens: 1000
        });

        const reply = completion.choices[0].message.content;

        // Save AI response to DB (non-blocking)
        db.run(
            "INSERT INTO messages (session_id, role, message) VALUES (?, ?, ?)",
            [sessionId, "assistant", reply]
        );

        res.json({
            reply: reply,
            sessionId: sessionId,
            tokensUsed: completion.usage.total_tokens
        });

    } catch (error) {
        console.error("Chat error:", error);
        res.status(500).json({
            error: "AI SERVER ERROR",
            details: error.message
        });
    }
});

// Get chat history
app.get("/history/:sessionId", (req, res) => {
    const sessionId = req.params.sessionId;

    db.all(
        "SELECT role, message FROM messages WHERE session_id = ? ORDER BY id ASC",
        [sessionId],
        (err, rows) => {
            if (err) {
                res.status(500).json({ error: err.message });
            } else {
                res.json(rows || []);
            }
        }
    );
});

// Upload file with knowledge cache invalidation
app.post(
    "/upload",
    authMiddleware,
    upload.single("file"),
    async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ error: "NO FILE" });
            }

            const tempPath = req.file.path;
            const targetPath = path.join("uploads", req.file.originalname);

            // Move file
            await fs.rename(tempPath, targetPath);

            // Invalidate cache to reload knowledge
            knowledgeCache.invalidate();

            // Async reload knowledge
            loadKnowledgeOptimized();

            console.log(`✓ File uploaded: ${req.file.originalname}`);

            res.json({
                success: true,
                filename: req.file.originalname,
                size: req.file.size
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

// Health check
app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        cached: knowledgeCache.isValid(),
        uptime: process.uptime()
    });
});

// ===== SERVER START =====
const PORT = process.env.PORT || 3000;

// Initialize knowledge on startup
loadKnowledgeOptimized().then(() => {
    app.listen(PORT, () => {
        console.log(`\n╔════════════════════════════════════╗`);
        console.log(`║  🏥 NVBE-AI Server Optimized       ║`);
        console.log(`║  Port: ${PORT}                          ║`);
        console.log(`║  Chunk Size: ${CHUNK_SIZE} chars               ║`);
        console.log(`║  Cache TTL: 1 hour                 ║`);
        console.log(`╚════════════════════════════════════╝\n`);
    });
});

module.exports = app;
