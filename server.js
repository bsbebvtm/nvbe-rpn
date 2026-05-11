require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");

const app = express();

app.use(express.json());

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (req, res) => {
    res.send("NVBE AI SERVER RUNNING");
});

app.post("/chat", async (req, res) => {
    try {
        const userMessage = req.body.message;

        const completion = await openai.chat.completions.create({
            model: "gpt-4.1-mini",
            messages: [
                {
                    role: "system",
                    content: "Bạn là trợ lý AI của Bệnh viện Đa khoa Khu vực Tháp Mười."
                },
                {
                    role: "user",
                    content: userMessage
                }
            ]
        });

        const reply = completion.choices[0].message.content;

        res.json({
            reply: reply
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "AI SERVER ERROR"
        });
    }
});

app.listen(3000, () => {
    console.log("AI Server running at port 3000");
});