require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const { rateLimit } = require('express-rate-limit');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Security: Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 100, // Limit each IP to 100 requests per window
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: 'draft-7',
    legacyHeaders: false,
});

app.use(cors());
app.use(express.json({ limit: '100kb' })); // Security: Limit request body size
app.use(express.static(path.join(__dirname, 'public')));

// Endpoints

// GET /api/status - Check backend configuration
app.get('/api/status', (req, res) => {
    res.json({
        chatConfigured: !!process.env.GROQ_API_KEY,
        imageConfigured: !!process.env.HF_TOKEN,
        publicImageFallbackEnabled: process.env.ENABLE_PUBLIC_IMAGE_FALLBACK === 'true'
    });
});

// POST /api/chat - Proxy to Groq
app.post('/api/chat', limiter, async (req, res) => {
    const { messages, systemInstruction, requestType } = req.body;

    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'Invalid messages format' });
    }

    // Security check: Check if GROQ_API_KEY exists
    if (!process.env.GROQ_API_KEY) {
        return res.json({
            mode: 'demo',
            content: getDemoResponse(requestType, messages)
        });
    }

    const controller = new AbortController();
    req.on('close', () => controller.abort()); // Abort if client disconnects

    try {
        const groqMessages = [
            { role: 'system', content: systemInstruction || 'You are a helpful assistant.' },
            ...messages
        ];

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: groqMessages,
                temperature: 0.7,
                max_tokens: 2048
            }),
            signal: controller.signal
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            return res.status(response.status).json({ error: error.error?.message || 'Groq API Error' });
        }

        const data = await response.json();
        res.json({
            mode: 'live',
            content: data.choices[0].message.content
        });
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.error('Chat error:', error);
        res.status(500).json({ error: 'Failed to generate response' });
    }
});

// POST /api/image - Proxy to Hugging Face
app.post('/api/image', limiter, async (req, res) => {
    const { prompt } = req.body;

    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    // Safety guard
    if (isUnsafePrompt(prompt)) {
        return res.status(403).json({ error: 'The prompt contains restricted content.' });
    }

    if (!process.env.HF_TOKEN) {
        return res.json({
            mode: 'unavailable',
            message: 'Image generation is not configured on this server.'
        });
    }

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    try {
        const response = await fetch('https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.HF_TOKEN}`,
                'Content-Type': 'application/json',
                'x-wait-for-model': 'true'
            },
            body: JSON.stringify({
                inputs: prompt,
                parameters: { num_inference_steps: 8, guidance_scale: 3.5, width: 1024, height: 1024 }
            }),
            signal: controller.signal
        });

        if (!response.ok) {
            return res.status(response.status).json({ error: 'Image generation failed' });
        }

        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        res.json({
            mode: 'live',
            imageUrl: `data:image/png;base64,${base64}`
        });
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.error('Image error:', error);
        res.status(500).json({ error: 'Image generation failed' });
    }
});

// POST /api/title - Generate chat title
app.post('/api/title', limiter, async (req, res) => {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'Invalid messages format' });
    }

    if (!process.env.GROQ_API_KEY) {
        return res.status(501).json({ error: 'AI Title generation not configured' });
    }

    try {
        const titlePrompt = [
            { 
                role: 'system', 
                content: 'You are a helpful assistant that generates extremely concise, topic-based titles for study sessions. Generate a 3-6 word title that captures the main educational topic of the conversation. Do not use quotes. Example: "Photosynthesis Process Explanation" or "Newton\'s First Law Practice".' 
            },
            { 
                role: 'user', 
                content: 'Conversation history:\n' + messages.map(m => `${m.role}: ${m.content}`).join('\n') + '\n\nGenerate a short title:' 
            }
        ];

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant',
                messages: titlePrompt,
                temperature: 0.5,
                max_tokens: 20
            })
        });

        if (!response.ok) throw new Error('Groq Title API Error');

        const data = await response.json();
        let title = data.choices[0].message.content.trim().replace(/^"|"$/g, '');
        res.json({ title });
    } catch (error) {
        console.error('Title generation error:', error);
        res.status(500).json({ error: 'Failed to generate title' });
    }
});

// Helper: Demo mode responses
function getDemoResponse(type, messages) {
    const lastMsg = messages[messages.length - 1]?.content || '';
    
    let base = "[DEMO MODE] I am running in local demo mode. To enable full AI tutoring, please configure the GROQ_API_KEY on the server.\n\n";

    if (type === 'summary') {
        return base + "Here is a sample summary of your text:\n- Key Point 1: Important concept found.\n- Key Point 2: Secondary detail identified.\n- Key Point 3: Final takeaway provided.";
    }
    
    if (type === 'flashcards') {
        return base + "Sample Flashcard:\nQ: What is Demo Mode?\nA: A local mode for testing without an API key.";
    }

    if (type === 'quiz') {
        return base + "Sample Quiz Question:\nQ1: Which mode is this?\nA) Live\nB) Demo\nAnswer: B";
    }

    return base + "I received your message: \"" + lastMsg.substring(0, 50) + "...\"\n\nIn demo mode, I can help you structure your notes or provide simple templates.";
}

// Helper: Safety guard
function isUnsafePrompt(prompt) {
    const unsafeKeywords = ['sexual', 'violent', 'hate', 'illegal', 'nude', 'kill', 'suicide', 'bomb'];
    const lower = prompt.toLowerCase();
    return unsafeKeywords.some(keyword => lower.includes(keyword));
}

app.listen(PORT, () => {
    console.log(`StudyBuddy server running at http://localhost:${PORT}`);
});
