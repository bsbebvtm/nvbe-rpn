require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const multer = require("multer");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();

// ========================
// MIDDLEWARE - RẤT QUAN TRỌNG!
// ========================

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(express.static("public"));

// Upload config
const upload = multer({
    dest: "uploads/",
    limits: { fileSize: 100 * 1024 * 1024 }
});

// OpenAI client - SỬ DỤNG GPT-4 MINI (RẺ HƠN)
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// In-memory storage
const conversationHistory = new Map();

// ========================
// HELPER FUNCTIONS
// ========================

// Đọc tất cả file .txt từ folder uploads
async function readAllKnowledgeFiles() {
    try {
        const uploadDir = path.join(__dirname, "uploads");
        
        if (!fsSync.existsSync(uploadDir)) {
            console.log("📁 Uploads folder not exists yet");
            return "";
        }

        const files = await fs.readdir(uploadDir);
        const txtFiles = files.filter(f => f.toLowerCase().endsWith(".txt"));

        console.log(`📖 Found ${txtFiles.length} .txt files: ${txtFiles.join(", ")}`);

        let allContent = "";

        for (const file of txtFiles) {
            try {
                const filePath = path.join(uploadDir, file);
                const content = await fs.readFile(filePath, "utf-8");
                console.log(`✓ Read file: ${file} (${content.length} chars)`);
                allContent += `\n\n【${file}】\n${content}`;
            } catch (err) {
                console.error(`✗ Error reading ${file}:`, err.message);
            }
        }

        return allContent;

    } catch (error) {
        console.error("❌ Error reading knowledge files:", error.message);
        return "";
    }
}

// Tìm câu trả lời từ file .txt
async function searchInKnowledgeBase(question) {
    const knowledge = await readAllKnowledgeFiles();

    if (!knowledge) {
        console.log("⚠️  No knowledge base content");
        return null;
    }

    // Tách câu hỏi thành keywords
    const keywords = question
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 2);

    console.log(`🔍 Keywords: ${keywords.join(", ")}`);

    // Tìm những dòng có chứa keywords
    const lines = knowledge.split("\n");
    const relevantLines = [];

    for (const line of lines) {
        const lineContent = line.toLowerCase();
        const matchCount = keywords.filter(kw => lineContent.includes(kw)).length;
        
        if (matchCount > 0 && line.trim().length > 0) {
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
            .join("\n");

        console.log(`✅ Found ${relevantLines.length} relevant lines`);
        return result.length > 0 ? result : null;
    }

    console.log("⚠️  No matching lines found");
    return null;
}

// Gọi OpenAI GPT-4 MINI (RẺ & NHANH)
async function callOpenAI(messages) {
    try {
        console.log("🤖 Calling OpenAI GPT-4 MINI...");
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",  // ✅ GPT-4 MINI - RẺ HƠN & NHANH HƠN
            messages: messages,
            temperature: 0.7,
            max_tokens: 500
        });

        const reply = response.choices[0].message.content;
        console.log("✅ OpenAI response received");
        return reply;

    } catch (error) {
        console.error("❌ OpenAI error:", error.message);
        
        // Nếu lỗi API key
        if (error.message.includes("401") || error.message.includes("Unauthorized")) {
            return "❌ Lỗi: OPENAI_API_KEY không hợp lệ hoặc không có quyền. Vui lòng kiểm tra lại.";
        }
        
        // Nếu lỗi quota
        if (error.message.includes("429") || error.message.includes("rate_limit")) {
            return "❌ Lỗi: Vượt quá giới hạn sử dụng OpenAI. Vui lòng thử lại sau.";
        }
        
        return "❌ Xin lỗi, không thể kết nối với OpenAI API.";
    }
}

// ========================
// ROUTES
// ========================

// Home
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Upload endpoint - NO AUTHENTICATION
app.post("/upload", upload.single("file"), async (req, res) => {
    console.log("\n📤 UPLOAD REQUEST");
    
    try {
        if (!req.file) {
            console.log("❌ No file provided");
            return res.status(400).json({ 
                success: false,
                error: "NO FILE" 
            });
        }

        const tempPath = req.file.path;
        const originalName = req.file.originalname;
        const targetPath = path.join("uploads", originalName);

        console.log(`📁 Temp path: ${tempPath}`);
        console.log(`📁 Target path: ${targetPath}`);

        // Rename file
        await fs.rename(tempPath, targetPath);

        // Verify file exists
        const stats = await fs.stat(targetPath);
        console.log(`✅ File uploaded successfully: ${originalName} (${stats.size} bytes)`);

        res.json({
            success: true,
            filename: originalName,
            size: stats.size,
            message: "Upload thành công!"
        });

    } catch (error) {
        console.error("❌ Upload error:", error);
        res.status(500).json({
            success: false,
            error: "UPLOAD FAILED",
            details: error.message
        });
    }
});

// Chat endpoint
app.post("/chat", async (req, res) => {
    console.log("\n💬 CHAT REQUEST");
    
    try {
        const { message, sessionId } = req.body;

        if (!message) {
            console.log("❌ No message provided");
            return res.status(400).json({ error: "NO MESSAGE" });
        }

        console.log(`👤 User: "${message}"`);

        const currentSessionId = sessionId || uuidv4();

        // Lấy history
        let history = conversationHistory.get(currentSessionId) || [];

        // 1️⃣ TÌM KIẾM TRONG FILE .TXT
        const knowledgeResult = await searchInKnowledgeBase(message);

        let reply = "";
        let source = "gpt";

        if (knowledgeResult) {
            // Tìm được từ file → Trả lời dựa vào file
            console.log("📖 Using KNOWLEDGE BASE");
            source = "knowledge_base";
            
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
            console.log("🤖 Using GPT-4 MINI (no knowledge found)");
            source = "gpt";
            
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

        console.log(`🤖 AI: "${reply.substring(0, 50)}..."`);
        console.log(`📊 Source: ${source}\n`);

        res.json({
            reply: reply,
            sessionId: currentSessionId,
            source: source
        });

    } catch (error) {
        console.error("❌ Chat error:", error);
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
    if (err) console.error("❌ Error creating uploads folder:", err);
    else console.log("✅ Uploads folder ready");
});

// Start server
app.listen(PORT, () => {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`🚀 NVBE-AI running at http://localhost:${PORT}`);
    console.log(`📁 Upload directory: ${uploadDir}`);
    console.log(`🤖 Model: GPT-4 MINI (gpt-4o-mini) - RẺ & NHANH`);
    console.log(`🔑 OpenAI API Key: ${process.env.OPENAI_API_KEY ? "✅ SET" : "❌ NOT SET"}`);
    console.log(`${"=".repeat(50)}\n`);
});
