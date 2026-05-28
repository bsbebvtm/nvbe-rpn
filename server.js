require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const multer = require("multer");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();

// Middleware
app.use(express.json());
app.use(express.static("public"));
app.use(express.urlencoded({ limit: "50mb" }));

// Upload config
const upload = multer({
    dest: "uploads/",
    limits: { fileSize: 100 * 1024 * 1024 }
});

// OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// In-memory storage cho conversation history
const conversationHistory = new Map();

// ========================
// HELPER FUNCTIONS
// ========================

// Đọc tất cả file .txt từ folder uploads
async function readAllKnowledgeFiles() {
    try {
        const uploadDir = path.join(__dirname, "uploads");
        
        if (!fsSync.existsSync(uploadDir)) {
            return "";
        }

        const files = await fs.readdir(uploadDir);
        const txtFiles = files.filter(f => f.toLowerCase().endsWith(".txt"));

        let allContent = "";

        for (const file of txtFiles) {
            try {
                const filePath = path.join(uploadDir, file);
                const content = await fs.readFile(filePath, "utf-8");
                allContent += `\n\n【${file}】\n${content}`;
            } catch (err) {
                console.error(`Lỗi đọc file ${file}:`, err.message);
            }
        }

        return allContent;

    } catch (error) {
        console.error("Lỗi đọc knowledge files:", error.message);
        return "";
    }
}

// Tìm câu trả lời từ file .txt
async function searchInKnowledgeBase(question) {
    const knowledge = await readAllKnowledgeFiles();

    if (!knowledge) return null;

    // Tách câu hỏi thành keywords
    const keywords = question
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 2);

    // Tìm những dòng có chứa keywords
    const lines = knowledge.split("\n");
    const relevantLines = [];

    for (const line of lines) {
        const lineContent = line.toLowerCase();
        const matchCount = keywords.filter(kw => lineContent.includes(kw)).length;
        
        if (matchCount > 0) {
            relevantLines.push({
                text: line.trim(),
                matches: matchCount
            });
        }
    }

    // Sort by relevance
    relevantLines.sort((a, b) => b.matches - a.matches);

    // Trả về top 5 dòng phù hợp nhất
    if (relevantLines.length > 0) {
        const result = relevantLines
            .slice(0, 5)
            .map(r => r.text)
            .filter(t => t.length > 0)
            .join("\n");

        return result.length > 0 ? result : null;
    }

    return null;
}

// Gọi OpenAI GPT
async function callOpenAI(messages) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: messages,
            temperature: 0.7,
            max_tokens: 500
        });

        return response.choices[0].message.content;

    } catch (error) {
        console.error("OpenAI error:", error.message);
        return "Xin lỗi, không thể kết nối với OpenAI API.";
    }
}

// ========================
// ROUTES
// ========================

// Serve static files
app.use(express.static("public"));

// Upload endpoint - KHÔNG cần authentication
app.post("/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "NO FILE" });
        }

        const tempPath = req.file.path;
        const originalName = req.file.originalname;
        const targetPath = path.join("uploads", originalName);

        // Rename file
        await fs.rename(tempPath, targetPath);

        console.log(`✓ File uploaded: ${originalName}`);

        res.json({
            success: true,
            filename: originalName
        });

    } catch (error) {
        console.error("Upload error:", error);
        res.status(500).json({
            error: "UPLOAD FAILED",
            details: error.message
        });
    }
});

// Chat endpoint - Trả lời dựa vào file hoặc GPT
app.post("/chat", async (req, res) => {
    try {
        const { message, sessionId } = req.body;

        if (!message) {
            return res.status(400).json({ error: "NO MESSAGE" });
        }

        const currentSessionId = sessionId || uuidv4();

        // Lấy history
        let history = conversationHistory.get(currentSessionId) || [];

        // 1️⃣ TÌM KIẾM TRONG FILE .TXT
        console.log(`\n🔍 Searching: "${message}"`);
        const knowledgeResult = await searchInKnowledgeBase(message);

        let reply = "";

        if (knowledgeResult) {
            // Tìm được từ file → Trả lời dựa vào file
            console.log("✓ Found in knowledge base");
            
            const systemPrompt = `Bạn là trợ lý AI của Bệnh viện Đa khoa Khu vực Tháp Mười.
Dựa vào thông tin sau từ cơ sở dữ liệu bệnh viện, hãy trả lời câu hỏi của người dùng:

【THÔNG TIN TỪ FILE】
${knowledgeResult}

Hãy trả lời ngắn gọn, chính xác dựa vào thông tin trên. Nếu thông tin không đủ, hãy nói rõ.`;

            const messages = [
                { role: "system", content: systemPrompt },
                { role: "user", content: message }
            ];

            reply = await callOpenAI(messages);

        } else {
            // Không tìm được → Dùng GPT để trả lời general
            console.log("✗ Not found in knowledge base, using GPT");
            
            history.push({ role: "user", content: message });

            const messages = [
                {
                    role: "system",
                    content: "Bạn là trợ lý AI của Bệnh viện Đa khoa Khu vực Tháp Mười. Hãy trả lời các câu hỏi một cách thân thiện và chuyên nghiệp."
                },
                ...history
            ];

            reply = await callOpenAI(messages);
        }

        // Lưu vào history
        history.push({ role: "user", content: message });
        history.push({ role: "assistant", content: reply });
        conversationHistory.set(currentSessionId, history);

        res.json({
            reply: reply,
            sessionId: currentSessionId,
            source: knowledgeResult ? "knowledge_base" : "gpt"
        });

    } catch (error) {
        console.error("Chat error:", error);
        res.status(500).json({
            error: "CHAT FAILED",
            details: error.message
        });
    }
});

// History endpoint
app.get("/history/:sessionId", (req, res) => {
    const history = conversationHistory.get(req.params.sessionId) || [];
    res.json(history);
});

// List uploaded files
app.get("/files", async (req, res) => {
    try {
        const uploadDir = path.join(__dirname, "uploads");
        
        if (!fsSync.existsSync(uploadDir)) {
            return res.json({ files: [] });
        }

        const files = await fs.readdir(uploadDir);
        const fileStats = await Promise.all(
            files.map(async (file) => {
                const stats = await fs.stat(path.join(uploadDir, file));
                return {
                    name: file,
                    size: stats.size,
                    createdAt: stats.birthtime
                };
            })
        );

        res.json({ files: fileStats });

    } catch (error) {
        res.status(500).json({ error: "LIST FAILED" });
    }
});

// ========================
// SERVER START
// ========================

const PORT = process.env.PORT || 3000;

// Tạo thư mục uploads
const uploadDir = path.join(__dirname, "uploads");
fsSync.mkdir(uploadDir, { recursive: true }, (err) => {
    if (err) console.error("Lỗi tạo folder uploads:", err);
});

app.listen(PORT, () => {
    console.log(`\n🚀 NVBE-AI running at http://localhost:${PORT}`);
    console.log(`📁 Upload directory: ${uploadDir}\n`);
});
