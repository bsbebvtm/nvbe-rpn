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
// MIDDLEWARE
// ========================

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(express.static("public"));

// Upload config
const upload = multer({
    dest: "uploads/",
    limits: { fileSize: 100 * 1024 * 1024 }
});

// OpenAI client - GPT-4 MINI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// In-memory storage
const conversationHistory = new Map();
const knowledgeCache = new Map();

// ========================
// HELPER FUNCTIONS
// ========================

// Parse TSV file (Tab-Separated Values)
async function parseTSVFile(filePath) {
    try {
        const content = await fs.readFile(filePath, "utf-8");
        const lines = content.split("\n").filter(line => line.trim());
        const headers = lines[0].split("\t");
        
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
            const cells = lines[i].split("\t");
            const row = {};
            headers.forEach((header, index) => {
                row[header.trim()] = cells[index] ? cells[index].trim() : "";
            });
            rows.push(row);
        }
        
        return { headers, rows };
    } catch (error) {
        console.error(`Error parsing TSV ${filePath}:`, error.message);
        return null;
    }
}

// Load và cache tất cả knowledge files
async function loadKnowledgeBase() {
    try {
        const uploadDir = path.join(__dirname, "uploads");
        
        if (!fsSync.existsSync(uploadDir)) {
            return;
        }

        const files = await fs.readdir(uploadDir);
        const txtFiles = files.filter(f => f.toLowerCase().endsWith(".txt"));

        for (const file of txtFiles) {
            const filePath = path.join(uploadDir, file);
            console.log(`📖 Loading: ${file}`);
            
            const data = await parseTSVFile(filePath);
            if (data) {
                knowledgeCache.set(file, data);
                console.log(`✅ Loaded ${file}: ${data.rows.length} rows`);
            }
        }

    } catch (error) {
        console.error("Error loading knowledge base:", error.message);
    }
}

// Tìm kiếm trong knowledge base
async function searchInKnowledgeBase(question) {
    if (knowledgeCache.size === 0) {
        console.log("⚠️  Knowledge base is empty");
        return null;
    }

    const keywords = question
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 2);

    console.log(`🔍 Searching with keywords: ${keywords.join(", ")}`);

    let results = [];

    // Tìm trong mỗi file
    for (const [fileName, fileData] of knowledgeCache) {
        const { rows } = fileData;

        for (const row of rows) {
            let matchScore = 0;
            let matchedFields = [];

            // Tính điểm match dựa vào từng column
            for (const [key, value] of Object.entries(row)) {
                const lowerValue = value.toLowerCase();
                for (const keyword of keywords) {
                    if (lowerValue.includes(keyword)) {
                        matchScore++;
                        if (!matchedFields.includes(key)) {
                            matchedFields.push(key);
                        }
                    }
                }
            }

            if (matchScore > 0) {
                results.push({
                    file: fileName,
                    row: row,
                    score: matchScore,
                    fields: matchedFields
                });
            }
        }
    }

    // Sort by score
    results.sort((a, b) => b.score - a.score);

    if (results.length > 0) {
        console.log(`✅ Found ${results.length} matching rows`);
        return results.slice(0, 5); // Top 5
    }

    console.log("⚠️  No matching rows found");
    return null;
}

// Format search results to readable text
function formatSearchResults(results) {
    if (!results || results.length === 0) return null;

    let formattedText = "【THÔNG TIN TỪ DATABASE BỆNH VIỆN】\n\n";

    results.forEach((result, index) => {
        formattedText += `【${result.file}】 - Kết quả ${index + 1}\n`;
        
        for (const [key, value] of Object.entries(result.row)) {
            if (value && value.trim().length > 0) {
                formattedText += `${key}: ${value}\n`;
            }
        }
        
        formattedText += "\n";
    });

    return formattedText;
}

// Gọi OpenAI GPT-4 MINI
async function callOpenAI(messages) {
    try {
        console.log("🤖 Calling OpenAI GPT-4 MINI...");
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: messages,
            temperature: 0.7,
            max_tokens: 500
        });

        const reply = response.choices[0].message.content;
        console.log("✅ OpenAI response received");
        return reply;

    } catch (error) {
        console.error("❌ OpenAI error:", error.message);
        
        if (error.message.includes("401")) {
            return "❌ Lỗi: OPENAI_API_KEY không hợp lệ.";
        }
        
        return "❌ Xin lỗi, không thể kết nối với OpenAI API.";
    }
}

// ========================
// ROUTES
// ========================

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Upload endpoint
app.post("/upload", upload.single("file"), async (req, res) => {
    console.log("\n📤 UPLOAD REQUEST");
    
    try {
        if (!req.file) {
            return res.status(400).json({ 
                success: false,
                error: "NO FILE" 
            });
        }

        const tempPath = req.file.path;
        const originalName = req.file.originalname;
        const targetPath = path.join("uploads", originalName);

        await fs.rename(tempPath, targetPath);
        const stats = await fs.stat(targetPath);
        
        console.log(`✅ File uploaded: ${originalName} (${stats.size} bytes)`);

        // Reload knowledge base
        await loadKnowledgeBase();

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
            return res.status(400).json({ error: "NO MESSAGE" });
        }

        console.log(`👤 User: "${message}"`);

        const currentSessionId = sessionId || uuidv4();
        let history = conversationHistory.get(currentSessionId) || [];

        // TÌM KIẾM TRONG KNOWLEDGE BASE
        const searchResults = await searchInKnowledgeBase(message);
        let reply = "";
        let source = "gpt";

        if (searchResults && searchResults.length > 0) {
            console.log("📖 Using KNOWLEDGE BASE");
            source = "knowledge_base";
            
            const formattedResults = formatSearchResults(searchResults);
            
            const systemPrompt = `Bạn là trợ lý AI của Bệnh viện Đa khoa Khu vực Tháp Mười.
Dựa vào thông tin sau từ cơ sở dữ liệu bệnh viện, hãy trả lời câu hỏi của người dùng một cách chính xác và chi tiết:

${formattedResults}

Hãy trả lời dựa trên thông tin đã cung cấp. Nếu không tìm thấy thông tin liên quan, hãy nói rõ.`;

            const messages = [
                { role: "system", content: systemPrompt },
                { role: "user", content: message }
            ];

            reply = await callOpenAI(messages);

        } else {
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

// Files endpoint
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
                    createdAt: stats.birthtime,
                    cached: knowledgeCache.has(file)
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

const uploadDir = path.join(__dirname, "uploads");
fsSync.mkdir(uploadDir, { recursive: true }, (err) => {
    if (err) console.error("❌ Error creating uploads folder:", err);
    else console.log("✅ Uploads folder ready");
});

// Start server
app.listen(PORT, async () => {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🚀 NVBE-AI running at http://localhost:${PORT}`);
    console.log(`📁 Upload directory: ${uploadDir}`);
    console.log(`🤖 Model: GPT-4 MINI (gpt-4o-mini)`);
    console.log(`🔑 OpenAI API Key: ${process.env.OPENAI_API_KEY ? "✅ SET" : "❌ NOT SET"}`);
    console.log(`${"=".repeat(60)}\n`);
    
    // Load knowledge base on startup
    console.log("📚 Loading knowledge base...");
    await loadKnowledgeBase();
    console.log("✅ Knowledge base ready!\n");
});
