// --- SECTION 0 — FIREBASE SETUP ---
// Firebase is loaded via script tags in HTML
// Functions are available as firebase.initializeApp, firebase.getAuth, etc.

let firebaseApp, auth, db;
const googleProvider = new firebase.auth.GoogleAuthProvider();

async function initFirebase() {
    try {
        const response = await fetch('/api/config');
        const config = await response.json();
        
        console.log("Firebase Config Received:", config.firebase);

        if (!config.firebase || !config.firebase.apiKey) {
            console.warn("Firebase not configured in .env. Authentication and History Board will be disabled.");
            return;
        }

        firebaseApp = firebase.initializeApp(config.firebase);
        auth = firebase.getAuth(firebaseApp);
        db = firebase.getFirestore(firebaseApp);

        firebase.auth.onAuthStateChanged(auth, async (user) => {
            if (user) {
                state.user = {
                    uid: user.uid,
                    displayName: user.displayName,
                    photoURL: user.photoURL
                };
                updateUserUI(true);
                fetchUserHistory();
                await initUserStats();
            } else {
                state.user = null;
                // Favor local guest stats if not logged in
                const savedStats = localStorage.getItem('studybuddy_guest_stats');
                if (savedStats) {
                    state.userStats = JSON.parse(savedStats);
                } else {
                    state.userStats = {
                        totalXP: 0,
                        totalKP: 0,
                        questionsAsked: 0,
                        quizzesCompleted: 0,
                        level: 1,
                        masteryData: {}
                    };
                }
                updateUserUI(false);
                updateStatsUI();
            }
        });
    } catch (e) {
        console.error("Firebase init failed", e);
        state.userStats = {
            totalXP: 0,
            totalKP: 0,
            questionsAsked: 0,
            quizzesCompleted: 0,
            level: 1,
            masteryData: {}
        };
        updateStatsUI();
    }
}

async function loginWithGoogle() {
    if (!auth) return alert("Firebase not initialized. Check your .env config.");
    try {
        await firebase.auth.signInWithPopup(auth, googleProvider);
    } catch (error) {
        console.error("Login failed", error);
        alert("Login failed: " + error.message);
    }
}

async function saveToHistory(topic, content) {
    if (!db || !state.user) return;
    try {
        await firebase.firestore.addDoc(firebase.firestore.collection(db, 'user_history'), {
            user_uid: state.user.uid,
            timestamp: firebase.firestore.serverTimestamp(),
            topic: topic,
            content: content
        });
        fetchUserHistory();
    } catch (e) {
        console.error("Error saving to history", e);
    }
}

async function initUserStats() {
    if (!db || !state.user) return;
    try {
        const userDocRef = firebase.firestore.doc(db, 'users', state.user.uid);
        const userDoc = await firebase.firestore.getDoc(userDocRef);
        
        if (userDoc.exists() && userDoc.data().stats) {
            state.userStats = userDoc.data().stats;
        } else {
            // Initialize new user stats
            const initialStats = {
                totalXP: 0,
                totalKP: 0,
                questionsAsked: 0,
                quizzesCompleted: 0,
                level: 1,
                masteryData: {}
            };
            await firebase.firestore.setDoc(userDocRef, { stats: initialStats }, { merge: true });
            state.userStats = initialStats;
        }
        updateStatsUI();
    } catch (e) {
        console.error("Error initializing stats", e);
    }
}

async function updateUserStats(xpGain, kpGain, isQuizFinished = false) {
    if (!state.userStats) return;
    const isOnline = !!(db && state.user);

    try {
        const newXP = (state.userStats.totalXP || 0) + xpGain;
        const newKP = (state.userStats.totalKP || 0) + kpGain;
        const newLevel = Math.floor(newXP / 500) + 1;
        const levelUp = newLevel > (state.userStats.level || 1);
        
        if (isOnline) {
            const userDocRef = firebase.firestore.doc(db, 'users', state.user.uid);
            const updates = {
                'stats.totalXP': firebase.firestore.increment(xpGain),
                'stats.totalKP': firebase.firestore.increment(kpGain),
                'stats.level': newLevel
            };
            if (isQuizFinished) updates['stats.quizzesCompleted'] = firebase.firestore.increment(1);
            await firebase.firestore.updateDoc(userDocRef, updates);
        }

        // Update local state (always)
        state.userStats.totalXP = newXP;
        state.userStats.totalKP = newKP;
        if (isQuizFinished) state.userStats.quizzesCompleted = (state.userStats.quizzesCompleted || 0) + 1;

        if (!isOnline) {
            // Save to local storage for guests
            localStorage.setItem('studybuddy_guest_stats', JSON.stringify(state.userStats));
        }

        if (levelUp) {
            state.userStats.level = newLevel;
            showToast(`🎊 Level Up! You are now Level ${newLevel}!`);
        }
        
        if (xpGain > 0 || kpGain > 0) {
            let msg = xpGain > 0 ? `+${xpGain} XP` : '';
            if (kpGain > 0) msg += (msg ? ' & ' : '') + `+${kpGain} KP`;
            showToast(msg);
        }
        
        updateStatsUI();

        // Topic Mastery Tracking
        if (kpGain > 0 && isQuizFinished) {
            const session = state.getCurrentSession();
            if (session && session.title !== 'New Chat') {
                const topic = session.title;
                if (!state.userStats.masteryData) state.userStats.masteryData = {};
                const mastery = state.userStats.masteryData[topic] || 0;
                const newMastery = mastery + 1;
                state.userStats.masteryData[topic] = newMastery;

                if (newMastery === 3) showToast(`🏆 Mastery Achieved: ${topic}!`);

                if (isOnline) {
                    const userDocRef = firebase.firestore.doc(db, 'users', state.user.uid);
                    await firebase.firestore.updateDoc(userDocRef, { [`stats.masteryData.${topic}`]: newMastery });
                } else {
                    localStorage.setItem('studybuddy_guest_stats', JSON.stringify(state.userStats));
                }
            }
        }
    } catch (e) {
        console.error("Error updating stats", e);
    }
}

function updateStatsUI() {
    if (!state.userStats) return;
    const stats = state.userStats;

    // Always recalculate level directly from XP so it is never stale
    const currentLevel = Math.floor(stats.totalXP / 500) + 1;
    stats.level = currentLevel;

    if (DOM.statXP) DOM.statXP.textContent = stats.totalXP;
    if (DOM.statKP) DOM.statKP.textContent = stats.totalKP;
    if (DOM.levelBadge) DOM.levelBadge.textContent = `Lvl ${currentLevel}`;

    if (DOM.xpProgressFill) {
        const xpIntoCurrentLevel = stats.totalXP % 500;
        const progress = (xpIntoCurrentLevel / 500) * 100;
        DOM.xpProgressFill.style.width = `${progress}%`;
    }

    if (DOM.xpNextLevel) {
        const xpNeeded = 500 - (stats.totalXP % 500);
        DOM.xpNextLevel.textContent = `${xpNeeded} XP to next level`;
    }
}

function showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<span>✨</span> <span>${message}</span>`;
    
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

async function fetchUserHistory() {
    if (!db || !state.user) return;
    try {
        const q = firebase.firestore.query(
            firebase.firestore.collection(db, 'user_history'),
            firebase.firestore.where('user_uid', '==', state.user.uid),
            firebase.firestore.orderBy('timestamp', 'desc')
        );
        const querySnapshot = await firebase.firestore.getDocs(q);
        const history = [];
        querySnapshot.forEach((doc) => {
            history.push({ id: doc.id, ...doc.data() });
        });
        renderHistoryBoard(history);
    } catch (e) {
        console.error("Error fetching history", e);
    }
}

function updateUserUI(isLoggedIn) {
    if (DOM.googleLoginBtn) DOM.googleLoginBtn.style.display = isLoggedIn ? 'none' : 'flex';
    // Remove the condition that hides stats when not logged in
    if (DOM.userStatsContainer) DOM.userStatsContainer.style.display = 'block';
    if (DOM.userInfo) {
        DOM.userInfo.style.display = isLoggedIn ? 'flex' : 'none';
        if (isLoggedIn && state.user) {
            document.getElementById('user-name').textContent = state.user.displayName;
        }
    }
}

function renderHistoryBoard(history) {
    if (!DOM.historyList) return;
    DOM.historyList.innerHTML = '';
    
    if (history.length === 0) {
        DOM.historyList.innerHTML = '<div class="empty-history">No history yet.</div>';
        return;
    }

    history.forEach(item => {
        const div = document.createElement('div');
        div.className = 'history-item';
        
        const isMastered = state.userStats?.masteryData?.[item.topic] >= 3;
        const masteryBadge = isMastered ? '<span class="history-mastered-badge" title="Topic Mastered">🏆</span>' : '';

        div.innerHTML = `
            <div class="history-topic">${item.topic}${masteryBadge}</div>
            <div class="history-date">${item.timestamp?.toDate().toLocaleDateString() || 'Just now'}</div>
        `;
        div.onclick = () => {
            // Load history item into chat as a new session or preview
            const session = state.createNewSession();
            state.updateSessionTitle(session.id, "History: " + item.topic);
            state.addMessageToCurrentSession('user', "I'm reviewing my history about: " + item.topic);
            state.addMessageToCurrentSession('ai', item.content);
            loadSessionIntoUI(session);
            if (typeof renderSessionsList === 'function') renderSessionsList();
        };
        DOM.historyList.appendChild(div);
    });
}

// --- SECTION A — CONFIG ---
const CONFIG = {
    GROQ_MODEL: 'llama-3.3-70b-versatile',
    SYSTEM_INSTRUCTION: `You are StudyBuddy, a friendly, patient, and highly intelligent AI tutor and study assistant.
Your primary goal is to help students learn, understand concepts, and succeed in their studies.

Key Guidelines:
1. Tone: Be supportive, encouraging, clear, and concise. Avoid overly corporate or robotic language.
2. Step-by-Step Explanations: When explaining complex topics, break the answer down into easy-to-follow steps.
3. Keep It Simple: Avoid unnecessary jargon. If you must use a technical term, briefly define it.
4. Encourage Practice: Offer practice questions or examples when appropriate.
5. Honesty: If you are unsure about something, admit it clearly instead of guessing.
6. Safety: Do not help with inappropriate, unsafe, or harmful requests.
7. Conciseness: For simple questions give simple answers. Do not write an essay unless asked.
8. Image Generation: This app has a built-in image generation system connected to a professional AI image model. When the user asks you to generate, draw, create, or show any image, you MUST NOT say you cannot do it. You MUST NOT say you are a text-based model. You MUST NOT refuse. Instead, respond with a short enthusiastic message like "Sure! Generating that image for you now 🎨" or "On it! Creating that right now ✨" and nothing else. The image will automatically appear below your reply.

Remember: Help students think through problems rather than just giving away the final answer immediately.`
};

// --- SECTION B — STATE MANAGEMENT ---
class AppState {
    constructor() {
        // CLEANUP: Remove old frontend keys for security
        localStorage.removeItem('studybuddy_groq_key');
        localStorage.removeItem('studybuddy_hf_token');

        let savedSessions = [];
        try {
            const stored = localStorage.getItem('studybuddy_sessions');
            if (stored) savedSessions = JSON.parse(stored);
        } catch (e) {
            console.error("Failed to parse sessions", e);
        }

        this.sessions = Array.isArray(savedSessions) ? savedSessions : [];
        this.currentSessionId = localStorage.getItem('studybuddy_current_session') || null;
        this.isGenerating = false;
        this.abortController = null;
        this.backendStatus = {
            chatConfigured: false,
            imageConfigured: false,
            publicImageFallbackEnabled: false
        };

        this.user = null; // Firebase user

        // Load stats from local storage for guests
        const savedStats = localStorage.getItem('studybuddy_guest_stats');
        this.userStats = savedStats ? JSON.parse(savedStats) : {
            totalXP: 0,
            totalKP: 0,
            questionsAsked: 0,
            quizzesCompleted: 0,
            level: 1,
            masteryData: {}
        };

        if (this.sessions.length === 0) {
            this.createNewSession();
        } else if (this.currentSessionId) {
            const exists = this.sessions.some(s => s.id === this.currentSessionId);
            if (!exists) {
                this.currentSessionId = this.sessions[0].id;
                localStorage.setItem('studybuddy_current_session', this.currentSessionId);
            }
        } else {
            this.currentSessionId = this.sessions[0].id;
            localStorage.setItem('studybuddy_current_session', this.currentSessionId);
        }
    }

    createNewSession() {
        const newSession = {
            id: Date.now().toString(),
            title: 'New Chat',
            createdAt: Date.now(),
            messages: []
        };
        this.sessions.unshift(newSession);
        this.currentSessionId = newSession.id;
        localStorage.setItem('studybuddy_current_session', this.currentSessionId);
        this.saveSessions();
        return newSession;
    }

    getCurrentSession() {
        return this.sessions.find(s => s.id === this.currentSessionId) || null;
    }

    getAllSessions() {
        return [...this.sessions].sort((a, b) => b.createdAt - a.createdAt);
    }

    deleteSession(id) {
        this.sessions = this.sessions.filter(s => s.id !== id);
        if (this.currentSessionId === id) {
            if (this.sessions.length > 0) {
                this.currentSessionId = this.sessions[0].id;
                localStorage.setItem('studybuddy_current_session', this.currentSessionId);
            } else {
                this.createNewSession();
            }
        }
        this.saveSessions();
    }

    switchSession(id) {
        const exists = this.sessions.some(s => s.id === id);
        if (exists) {
            this.currentSessionId = id;
            localStorage.setItem('studybuddy_current_session', this.currentSessionId);
        }
    }

    updateSessionTitle(id, title) {
        const session = this.sessions.find(s => s.id === id);
        if (session) {
            session.title = title;
            this.saveSessions();
        }
    }

    addMessageToCurrentSession(role, content) {
        const session = this.getCurrentSession();
        if (!session) return;

        session.messages.push({ role, content });
        this.saveSessions();

        // Only trigger title update on the first user message or first AI response
        // to avoid excessive API calls while still ensuring a topic-based title.
        const isEarlyInConversation = session.messages.length <= 4;
        const isPlaceholderTitle = session.title === 'New Chat' || this.isGenericGreeting(session.title);

        if (isPlaceholderTitle || isEarlyInConversation) {
            this.updateChatTitleDynamically(session);
        }
    }

    async updateChatTitleDynamically(session) {
        if (!session || session.messages.length === 0) return;

        const currentTitle = session.title;
        
        // 1. Try Live AI Title Generation if configured
        if (state.backendStatus && state.backendStatus.chatConfigured) {
            try {
                const response = await fetch('/api/title', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messages: session.messages.slice(-5) })
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.title && data.title !== currentTitle && !this.isGenericGreeting(data.title)) {
                        this.updateSessionTitle(session.id, data.title);
                        if (typeof renderSessionsList === 'function') renderSessionsList();
                        return;
                    }
                }
            } catch (e) {
                console.warn("AI Title Generation failed, falling back to local logic.");
            }
        }

        // 2. Local Fallback Generation
        const localTitle = this.generateLocalChatTitle(session.messages);
        if (localTitle && localTitle !== currentTitle) {
            this.updateSessionTitle(session.id, localTitle);
            if (typeof renderSessionsList === 'function') renderSessionsList();
        }
    }

    isGenericGreeting(text) {
        const greetings = ['hi', 'hello', 'hey', 'ok', 'thanks', 'help', 'start', 'new chat', 'ok...', 'yes', 'no'];
        const val = text.toLowerCase().trim().replace(/[?!.,]$/g, '');
        return greetings.includes(val) || val.length < 3;
    }

    generateLocalChatTitle(messages) {
        // Find the first user message that isn't a greeting
        const substantialMsg = messages.find(m => m.role === 'user' && !this.isGenericGreeting(m.content));
        if (!substantialMsg) return null;

        let content = substantialMsg.content.trim();
        
        // Handle specialized prompt types
        if (content.toLowerCase().startsWith('/image')) {
            content = content.replace(/\/image/i, '').trim();
            return "Image: " + this.formatTitle(content);
        }

        // Clean common study prefixes to get to the core topic
        const prefixes = [
            /^summarize\s*[:\-]?\s*/i,
            /^explain\s*[:\-]?\s*/i,
            /^what is\s+/i,
            /^how to\s+/i,
            /^tell me about\s+/i,
            /^can you\s+/i,
            /^study\s+/i
        ];

        let topic = content;
        for (const regex of prefixes) {
            if (regex.test(topic)) {
                topic = topic.replace(regex, '').trim();
                break;
            }
        }

        return this.formatTitle(topic);
    }

    formatTitle(text) {
        if (!text) return null;
        const words = text.split(/\s+/).filter(w => w.length > 0);
        if (words.length === 0) return null;

        // Take 3-6 words and capitalize them
        const titleWords = words.slice(0, 6).map(word => {
            // Remove punctuation and capitalize
            const clean = word.replace(/[^\w]/g, '');
            if (!clean) return word;
            return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
        });

        const title = titleWords.join(' ');
        return title.length > 40 ? title.substring(0, 37) + '...' : title;
    }

    getFormattedHistoryForApi() {
        const session = this.getCurrentSession();
        if (!session) return [];
        return session.messages.filter(msg => msg.role !== 'system').map(msg => {
            let content = msg.content;
            if (msg.role === 'ai') {
                if (content.startsWith('[IMAGE_PROMPT]')) {
                    content = "Sure! I've generated an image for: " + content.replace('[IMAGE_PROMPT]', '');
                } else if (content.startsWith('[Image generated for:')) {
                    const prompt = content.replace('[Image generated for: ', '').replace(']', '');
                    content = "Sure! I've generated an image for: " + prompt;
                }
            }
            return {
                role: msg.role === 'ai' ? 'assistant' : 'user',
                content: content
            };
        });
    }

    saveSessions() {
        try {
            localStorage.setItem('studybuddy_sessions', JSON.stringify(this.sessions));
        } catch (e) {
            console.error("Local storage is full or disabled", e);
        }
    }

    setGenerating(bool) {
        this.isGenerating = bool;
        if (DOM.stopBtn) DOM.stopBtn.style.display = bool ? 'flex' : 'none';
        if (DOM.sendBtn) DOM.sendBtn.style.display = bool ? 'none' : 'flex';
        if (!bool) this.abortController = null;
    }

    isCurrentlyGenerating() { return this.isGenerating; }
}

const state = new AppState();

// --- SECTION C — UTILS ---
function setupMarkdownRenderer() {
    if (typeof marked !== 'undefined' && typeof hljs !== 'undefined') {
        marked.setOptions({
            highlight: function (code, lang) {
                const language = hljs.getLanguage(lang) ? lang : 'plaintext';
                return hljs.highlight(code, { language }).value;
            },
            langPrefix: 'hljs language-'
        });
    }
}

function parseMarkdown(text) {
    if (!text) return '';
    let html = '';
    if (typeof marked !== 'undefined') {
        html = marked.parse(text);
    } else {
        html = text.replace(/\n/g, '<br>');
    }
    if (typeof DOMPurify !== 'undefined') {
        return DOMPurify.sanitize(html);
    }
    return html;
}

// --- SECTION D — BACKEND API CALLS ---
async function fetchBackendStatus() {
    try {
        const response = await fetch('/api/status');
        if (!response.ok) throw new Error('Status check failed');
        state.backendStatus = await response.json();
        updateStatusUI();
    } catch (error) {
        console.error('Failed to fetch backend status:', error);
    }
}

async function generateChatResponse(messageToSend, requestType = 'chat') {
    state.abortController = new AbortController();
    const timeoutId = setTimeout(() => state.abortController.abort(), 45000); // 45s timeout

    try {
        const history = state.getFormattedHistoryForApi();
        if (history.length > 0 && history[history.length - 1].role === 'user') {
            history[history.length - 1].content = messageToSend;
        } else {
            history.push({ role: 'user', content: messageToSend });
        }

        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: history,
                systemInstruction: CONFIG.SYSTEM_INSTRUCTION,
                requestType: requestType
            }),
            signal: state.abortController.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || 'Server Error');
        }

        const data = await response.json();
        if (data.mode === 'demo') {
            updateDemoMode(true);
        }
        return data.content;
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('Request cancelled.');
        throw error;
    }
}

async function generateImage(prompt) {
    if (isUnsafePrompt(prompt)) {
        throw new Error('This prompt contains restricted content.');
    }

    state.abortController = new AbortController();
    const timeoutId = setTimeout(() => state.abortController.abort(), 90000);

    try {
        const response = await fetch('/api/image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt }),
            signal: state.abortController.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || 'Image generation failed');
        }

        const data = await response.json();

        if (data.imageUrl) {
            return data.imageUrl;
        }

        throw new Error(data.error || 'Image generation failed');
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('Image generation cancelled.');
        throw error;
    }
}

async function generatePublicFallbackImage(prompt) {
    const fallbackUrl = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) + '?width=1024&height=1024&nologo=true&enhance=true';
    return fallbackUrl; // Returning URL directly as it's a simple GET
}

function isUnsafePrompt(prompt) {
    const unsafeKeywords = ['sexual', 'violent', 'hate', 'illegal', 'nude', 'kill', 'suicide', 'bomb'];
    const lower = prompt.toLowerCase();
    return unsafeKeywords.some(keyword => lower.includes(keyword));
}

function stopGenerating() {
    if (state.abortController) {
        state.abortController.abort();
        state.setGenerating(false);
    }
}

// --- SECTION F — DOM REFERENCES ---
// --- SECTION F — WELCOME PROMPTS ---
const PROMPT_POOLS = {
    core: [
        "Summarize: [paste your text here]",
        "Flashcards: [paste your text here]",
        "Quiz me on: [topic]"
    ],
    study: [
        "Explain Newton's laws with examples",
        "Make a study plan for tomorrow's exam",
        "Help me revise quadratic equations",
        "Compare democracy and monarchy",
        "How to write a high-scoring essay?"
    ],
    science: [
        "Quiz me on photosynthesis",
        "Explain climate change for class notes",
        "How does cellular respiration work?",
        "Explain the periodic table structure",
        "What is quantum entanglement?"
    ],
    math: [
        "Give me 5 algebra practice questions",
        "Give me practice questions on fractions",
        "Explain the Pythagorean theorem",
        "Help me solve for x in linear equations"
    ],
    history: [
        "Summarize the French Revolution",
        "Key events of World War II",
        "History of the Roman Empire",
        "Explain the Industrial Revolution"
    ],
    general: [
        "Explain a current news topic in simple terms",
        "Help me understand global economic trends",
        "What are the basics of international relations?",
        "/image A labeled diagram of the human heart",
        "/image A diagram of the solar system",
        "/image The water cycle process",
        "/image Structure of an atom"
    ]
};

function getWelcomePrompts() {
    const prompts = [...PROMPT_POOLS.core];
    const allOthers = [
        ...PROMPT_POOLS.study,
        ...PROMPT_POOLS.science,
        ...PROMPT_POOLS.math,
        ...PROMPT_POOLS.history,
        ...PROMPT_POOLS.general
    ];
    
    // Shuffle and pick 4-5 additional prompts
    const shuffled = allOthers.sort(() => 0.5 - Math.random());
    return prompts.concat(shuffled.slice(0, 5));
}

function renderWelcomePrompts() {
    if (!DOM.suggestedPromptsContainer) return;
    
    DOM.suggestedPromptsContainer.innerHTML = '';
    const prompts = getWelcomePrompts();
    
    prompts.forEach(text => {
        const btn = document.createElement('button');
        btn.className = 'prompt-btn';
        btn.textContent = text;
        btn.addEventListener('click', () => {
            DOM.messageInput.value = text;
            autoResizeTextarea();
            updateSendButtonState();
            DOM.messageInput.focus();
        });
        DOM.suggestedPromptsContainer.appendChild(btn);
    });
}

let DOM = {};

function initDOM() {
    DOM = {
        chatContainer: document.getElementById('chat-container'),
        welcomeScreen: document.getElementById('welcome-screen'),
        messageInput: document.getElementById('message-input'),
        sendBtn: document.getElementById('send-btn'),
        themeToggleBtn: document.getElementById('theme-toggle-btn'),
        // settingsBtn: document.getElementById('settings-btn'),
        newChatBtn: document.getElementById('new-chat-btn'),
        sessionsList: document.getElementById('sessions-list'),
        settingsModal: document.getElementById('settings-modal'),
        closeSettingsBtn: document.getElementById('close-settings-btn'),
        mobileMenuBtn: document.getElementById('mobile-menu-btn'),
        sidebar: document.querySelector('.sidebar'),
        suggestedPromptsContainer: document.getElementById('suggested-prompts'),
        sunIcon: document.getElementById('sun-icon'),
        moonIcon: document.getElementById('moon-icon'),
        pomodoroBtn: document.getElementById('pomodoro-btn'),
        pomodoroModal: document.getElementById('pomodoro-modal'),
        closePomodoroBtn: document.getElementById('close-pomodoro-btn'),
        pomodoroDisplay: document.getElementById('pomodoro-display'),
        pomodoroStartBtn: document.getElementById('pomodoro-start-btn'),
        pomodoroResetBtn: document.getElementById('pomodoro-reset-btn'),
        pomodoroModeLabel: document.getElementById('pomodoro-mode-label'),
        pomodoroSessionsCount: document.getElementById('pomodoro-sessions-count'),
        voiceBtn: document.getElementById('voice-btn'),
        talkModeBtn: document.getElementById('talk-mode-btn'),
        talkModeOverlay: document.getElementById('talk-mode-overlay'),
        talkModeCloseBtn: document.getElementById('talk-mode-close-btn'),
        talkMicBtn: document.getElementById('talk-mic-btn'),
        talkModeStatus: document.getElementById('talk-mode-status'),
        talkModeTranscript: document.getElementById('talk-mode-transcript'),
        talkModeAvatar: document.getElementById('talk-mode-avatar'),
        ttsRateSlider: document.getElementById('tts-rate-slider'),
        ttsRateValue: document.getElementById('tts-rate-value'),
        ttsStopBtn: document.getElementById('tts-stop-btn'),
        headerSettingsBtn: document.getElementById('header-settings-btn'),
        stopBtn: document.getElementById('stop-btn'),
        chatStatus: document.getElementById('chat-status'),
        imageStatus: document.getElementById('image-status'),
        appMode: document.getElementById('app-mode'),
        demoBadge: document.getElementById('demo-badge'),
        googleLoginBtn: document.getElementById('google-login-btn'),
        userInfo: document.getElementById('user-info'),
        historyList: document.getElementById('history-list'),
        userStatsContainer: document.getElementById('user-stats-container'),
        statXP: document.getElementById('stat-xp'),
        statKP: document.getElementById('stat-kp'),
        levelBadge: document.getElementById('level-badge'),
        xpProgressFill: document.getElementById('xp-progress-fill'),
        xpNextLevel: document.getElementById('xp-next-level')
    };

    if (DOM.googleLoginBtn) {
        DOM.googleLoginBtn.onclick = loginWithGoogle;
    }
}

// --- SECTION G — UI FUNCTIONS ---
function scrollToBottom() {
    DOM.chatContainer.scrollTop = DOM.chatContainer.scrollHeight;
}

function hideWelcomeScreen() {
    if (DOM.welcomeScreen.style.display !== 'none') {
        DOM.welcomeScreen.style.display = 'none';
    }
}

function showWelcomeScreen() {
    DOM.welcomeScreen.style.display = 'block';
}

function clearChatUI() {
    const messages = DOM.chatContainer.querySelectorAll('.message-wrapper');
    messages.forEach(msg => msg.remove());
    renderWelcomePrompts();
    showWelcomeScreen();
}

function loadSessionIntoUI(session) {
    clearChatUI();
    if (!session || !session.messages) return;

    session.messages.forEach(msg => {
        if (msg.role === 'user') {
            addMessageToUI('user', msg.content);
        } else {
            // AI Message
            const content = msg.content || '';

            // Detect Image Markers
            if (content.startsWith('[Image generated for:') || content.startsWith('[IMAGE_PROMPT]')) {
                const prompt = content.includes('[IMAGE_PROMPT]')
                    ? content.replace('[IMAGE_PROMPT]', '')
                    : content.replace('[Image generated for: ', '').replace(']', '');

                addImagePlaceholderToUI(prompt);
            } else {
                // Detect and Render Special Components (Flashcards/Quiz)
                const hasFlashcardMarkers = /Q:|Question:|\*\*Q:\*\*/i.test(content) && /A:|Answer:|\*\*A:\*\*/i.test(content);
                const hasQuizMarkers = /Q1:|Question 1:|\*\*Q1:\*\*/i.test(content) && /Answer:|\*\*Answer:\*\*/i.test(content);

                if (hasFlashcardMarkers) {
                    const count = renderFlashcards(content);
                    if (count === 0) addMessageToUI('ai', content);
                } else if (hasQuizMarkers) {
                    const count = renderQuiz(content);
                    if (count === 0) addMessageToUI('ai', content);
                } else {
                    addMessageToUI('ai', content);
                }
            }
        }
    });
}

function addMessageToUI(role, content) {
    hideWelcomeScreen();
    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper';

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = role === 'user' ? 'U' : 'AI';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    if (role === 'ai') {
        contentDiv.innerHTML = parseMarkdown(content);

        if (typeof hljs !== 'undefined') {
            contentDiv.querySelectorAll('pre code').forEach((block) => {
                hljs.highlightElement(block);
            });
        }

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'message-actions';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'action-btn';
        copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy';
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(content).then(() => {
                const originalText = copyBtn.innerHTML;
                copyBtn.innerHTML = '✓ Copied';
                setTimeout(() => { copyBtn.innerHTML = originalText; }, 2000);
            });
        };
        actionsDiv.appendChild(copyBtn);
        contentDiv.appendChild(actionsDiv);
    } else {
        contentDiv.textContent = content;
    }

    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    wrapper.appendChild(messageDiv);
    DOM.chatContainer.appendChild(wrapper);
    scrollToBottom();
}

function addImagePlaceholderToUI(prompt) {
    hideWelcomeScreen();
    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper';

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message ai';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = 'AI';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'image-message-content placeholder';

    const promptLabel = document.createElement('div');
    promptLabel.className = 'image-prompt-label';
    promptLabel.textContent = '🎨 "' + prompt + '"';

    const info = document.createElement('div');
    info.className = 'image-placeholder-info';
    info.textContent = 'Image URL expired after refresh.';

    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'download-btn reload-btn';
    reloadBtn.innerHTML = '✨ Re-generate Image';
    reloadBtn.onclick = async () => {
        reloadBtn.disabled = true;
        reloadBtn.innerHTML = '<div class="spinner"></div> Generating...';
        try {
            const imageUrl = await generateImage(prompt);
            // Replace the placeholder content with the real image
            contentDiv.innerHTML = '';
            contentDiv.classList.remove('placeholder');

            const newPromptLabel = document.createElement('div');
            newPromptLabel.className = 'image-prompt-label';
            newPromptLabel.textContent = '🎨 "' + prompt + '"';

            const img = document.createElement('img');
            img.src = imageUrl;
            img.alt = prompt;

            const downloadBtn = document.createElement('button');
            downloadBtn.className = 'download-btn';
            downloadBtn.innerHTML = '⬇ Download Image';
            downloadBtn.onclick = () => {
                const a = document.createElement('a');
                a.href = imageUrl;
                a.download = 'studybuddy-image.png';
                a.click();
            };

            contentDiv.appendChild(newPromptLabel);
            contentDiv.appendChild(img);
            contentDiv.appendChild(downloadBtn);
        } catch (error) {
            reloadBtn.disabled = false;
            reloadBtn.innerHTML = '❌ Failed. Try again?';
            alert(error.message);
        }
    };

    contentDiv.appendChild(promptLabel);
    contentDiv.appendChild(info);
    contentDiv.appendChild(reloadBtn);
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    wrapper.appendChild(messageDiv);
    DOM.chatContainer.appendChild(wrapper);
    scrollToBottom();
}

function addImageToUI(prompt, imageUrl) {
    hideWelcomeScreen();
    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper';

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message ai';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = 'AI';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'image-message-content';

    const promptLabel = document.createElement('div');
    promptLabel.className = 'image-prompt-label';
    promptLabel.textContent = '🎨 "' + prompt + '"';

    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = prompt;

    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'download-btn';
    downloadBtn.innerHTML = '⬇ Download Image';
    downloadBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = imageUrl;
        a.download = 'studybuddy-image.png';
        a.click();
    };

    contentDiv.appendChild(promptLabel);
    contentDiv.appendChild(img);
    contentDiv.appendChild(downloadBtn);
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    wrapper.appendChild(messageDiv);
    DOM.chatContainer.appendChild(wrapper);
    scrollToBottom();
}

function showTypingIndicator() {
    hideWelcomeScreen();
    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper typing-wrapper';

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ai`;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = 'AI';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    const indicatorDiv = document.createElement('div');
    indicatorDiv.className = 'typing-indicator';
    indicatorDiv.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';

    contentDiv.appendChild(indicatorDiv);
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    wrapper.appendChild(messageDiv);
    DOM.chatContainer.appendChild(wrapper);
    scrollToBottom();
    return wrapper;
}

function showImageLoadingIndicator() {
    hideWelcomeScreen();
    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper';

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message ai';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = 'AI';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'image-loading-text';
    loadingDiv.innerHTML = '<div class="spinner"></div> 🎨 Generating your image, this may take 20–30 seconds...';

    contentDiv.appendChild(loadingDiv);
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    wrapper.appendChild(messageDiv);
    DOM.chatContainer.appendChild(wrapper);
    scrollToBottom();
    return wrapper;
}

function removeElement(element) {
    if (element && element.parentNode) {
        element.parentNode.removeChild(element);
    }
}

function addErrorToUI(errorMessage) {
    hideWelcomeScreen();
    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper';

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ai`;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = 'AI';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content error-message';
    contentDiv.textContent = errorMessage;

    if (errorMessage.includes("API Key") || errorMessage.includes("Token is missing")) {
        const fixBtn = document.createElement('button');
        fixBtn.className = 'btn primary-btn';
        fixBtn.style.marginTop = '10px';
        fixBtn.style.padding = '0.5rem';
        fixBtn.textContent = 'Open Settings';
        fixBtn.onclick = () => toggleModal(true);
        contentDiv.appendChild(document.createElement('br'));
        contentDiv.appendChild(fixBtn);
    }

    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    wrapper.appendChild(messageDiv);
    DOM.chatContainer.appendChild(wrapper);
    scrollToBottom();
}

function autoResizeTextarea() {
    DOM.messageInput.style.height = 'auto';
    const newHeight = Math.min(DOM.messageInput.scrollHeight, 200);
    DOM.messageInput.style.height = newHeight + 'px';
}

function resetTextarea() {
    DOM.messageInput.value = '';
    DOM.messageInput.style.height = 'auto';
    updateSendButtonState();
}

function updateSendButtonState() {
    const text = DOM.messageInput.value.trim();
    DOM.sendBtn.disabled = text.length === 0;
}

function toggleModal(show) {
    if (show) {
        DOM.settingsModal.classList.add('active');
        fetchBackendStatus();
    } else {
        DOM.settingsModal.classList.remove('active');
    }
}

function updateStatusUI() {
    const { chatConfigured, imageConfigured } = state.backendStatus;

    DOM.chatStatus.textContent = chatConfigured ? '✓ Configured' : '⚠ Not Configured';
    DOM.chatStatus.className = `status-badge ${chatConfigured ? 'success' : 'error'}`;

    DOM.imageStatus.textContent = imageConfigured ? '✓ Configured' : '⚠ Not Configured';
    DOM.imageStatus.className = `status-badge ${imageConfigured ? 'success' : 'warning'}`;

    const isDemo = !chatConfigured;
    updateDemoMode(isDemo);
}

function updateDemoMode(isDemo) {
    DOM.appMode.textContent = isDemo ? 'Demo Mode' : 'Live AI Mode';
    DOM.appMode.className = `status-badge ${isDemo ? 'warning' : 'success'}`;
    DOM.demoBadge.style.display = isDemo ? 'inline-block' : 'none';
}

function toggleSidebar() {
    DOM.sidebar.classList.toggle('open');
}

function setTheme(theme) {
    if (theme === 'dark') {
        document.body.classList.add('dark-mode');
        document.body.classList.remove('light-mode');
        DOM.moonIcon.style.display = 'none';
        DOM.sunIcon.style.display = 'block';

        const hljsLight = document.getElementById('hljs-light-theme');
        const hljsDark = document.getElementById('hljs-dark-theme');
        if (hljsLight) hljsLight.disabled = true;
        if (hljsDark) hljsDark.disabled = false;

        localStorage.setItem('studybuddy_theme', 'dark');
    } else {
        document.body.classList.remove('dark-mode');
        document.body.classList.add('light-mode');
        DOM.sunIcon.style.display = 'none';
        DOM.moonIcon.style.display = 'block';

        const hljsLight = document.getElementById('hljs-light-theme');
        const hljsDark = document.getElementById('hljs-dark-theme');
        if (hljsLight) hljsLight.disabled = false;
        if (hljsDark) hljsDark.disabled = true;

        localStorage.setItem('studybuddy_theme', 'light');
    }
}

function renderSessionsList() {
    DOM.sessionsList.innerHTML = '';
    const sessions = state.getAllSessions();

    if (sessions.length === 0) {
        const noMsg = document.createElement('div');
        noMsg.className = 'no-sessions-msg';
        noMsg.textContent = 'No previous chats';
        DOM.sessionsList.appendChild(noMsg);
        return;
    }

    sessions.forEach(session => {
        const item = document.createElement('div');
        item.className = 'session-item';
        if (session.id === state.currentSessionId) {
            item.classList.add('active');
        }

        const titleSpan = document.createElement('span');
        titleSpan.className = 'session-title';
        titleSpan.textContent = session.title;

        const delBtn = document.createElement('button');
        delBtn.className = 'session-delete-btn';
        delBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';

        delBtn.onclick = (e) => {
            e.stopPropagation();
            if (confirm('Delete this chat session?')) {
                state.deleteSession(session.id);
                renderSessionsList();
                loadSessionIntoUI(state.getCurrentSession());
            }
        };

        item.onclick = () => {
            state.switchSession(session.id);
            renderSessionsList();
            loadSessionIntoUI(session);
            if (window.innerWidth <= 768) toggleSidebar();
        };

        item.appendChild(titleSpan);
        item.appendChild(delBtn);
        DOM.sessionsList.appendChild(item);
    });
}

function openFlashcardFullscreen(cards) {
    // Create fullscreen overlay
    const overlay = document.createElement('div');
    overlay.className = 'flashcard-fullscreen-overlay';

    const modal = document.createElement('div');
    modal.className = 'flashcard-fullscreen-modal';

    // Header
    const header = document.createElement('div');
    header.className = 'flashcard-fullscreen-header';

    const headerTitle = document.createElement('div');
    headerTitle.className = 'flashcard-fullscreen-title';
    headerTitle.textContent = '🃏 Flashcards — Fullscreen';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'flashcard-fullscreen-close';
    closeBtn.innerHTML = '✕ Close';
    closeBtn.onclick = () => document.body.removeChild(overlay);

    header.appendChild(headerTitle);
    header.appendChild(closeBtn);

    // Card display
    const cardArea = document.createElement('div');
    cardArea.className = 'flashcard-fullscreen-card-area';

    const cardDisplay = document.createElement('div');
    cardDisplay.className = 'flashcard-fullscreen-display';

    const cardInner = document.createElement('div');
    cardInner.className = 'flashcard-inner';

    const cardFront = document.createElement('div');
    cardFront.className = 'flashcard-face flashcard-front flashcard-fullscreen-face';

    const cardBack = document.createElement('div');
    cardBack.className = 'flashcard-face flashcard-back flashcard-fullscreen-face';

    let currentIndex = 0;
    let isFlipped = false;

    function updateFullscreenCard() {
        cardFront.textContent = cards[currentIndex].question;
        cardBack.textContent = cards[currentIndex].answer;
        cardInner.classList.remove('flipped');
        isFlipped = false;
        counter.textContent = (currentIndex + 1) + ' / ' + cards.length;
        progressBar.style.width = ((currentIndex + 1) / cards.length * 100) + '%';
    }

    cardInner.appendChild(cardFront);
    cardInner.appendChild(cardBack);
    cardDisplay.appendChild(cardInner);

    cardDisplay.addEventListener('click', () => {
        isFlipped = !isFlipped;
        cardInner.classList.toggle('flipped', isFlipped);
    });

    cardArea.appendChild(cardDisplay);

    // Progress bar
    const progressContainer = document.createElement('div');
    progressContainer.className = 'flashcard-fullscreen-progress';
    const progressBar = document.createElement('div');
    progressBar.className = 'flashcard-fullscreen-progress-bar';
    progressContainer.appendChild(progressBar);

    // Controls
    const controls = document.createElement('div');
    controls.className = 'flashcard-fullscreen-controls';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'flashcard-fullscreen-btn';
    prevBtn.textContent = '← Previous';
    prevBtn.onclick = () => {
        if (currentIndex > 0) { currentIndex--; updateFullscreenCard(); }
    };

    const counter = document.createElement('span');
    counter.className = 'flashcard-fullscreen-counter';

    const nextBtn = document.createElement('button');
    nextBtn.className = 'flashcard-fullscreen-btn';
    nextBtn.textContent = 'Next →';
    nextBtn.onclick = () => {
        if (currentIndex < cards.length - 1) { currentIndex++; updateFullscreenCard(); }
    };

    const flipBtn = document.createElement('button');
    flipBtn.className = 'flashcard-fullscreen-btn flip-btn';
    flipBtn.textContent = '↕ Flip Card';
    flipBtn.onclick = () => {
        isFlipped = !isFlipped;
        cardInner.classList.toggle('flipped', isFlipped);
    };

    const hint = document.createElement('div');
    hint.className = 'flashcard-fullscreen-hint';
    hint.textContent = 'Click the card or press Space to flip • Arrow keys to navigate • Esc to close';

    controls.appendChild(prevBtn);
    controls.appendChild(counter);
    controls.appendChild(nextBtn);

    modal.appendChild(header);
    modal.appendChild(progressContainer);
    modal.appendChild(cardArea);
    modal.appendChild(controls);
    modal.appendChild(flipBtn);
    modal.appendChild(hint);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    updateFullscreenCard();

    // Keyboard navigation
    function handleKeydown(e) {
        if (e.key === 'Escape') {
            if (document.body.contains(overlay)) document.body.removeChild(overlay);
            document.removeEventListener('keydown', handleKeydown);
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            if (currentIndex < cards.length - 1) { currentIndex++; updateFullscreenCard(); }
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            if (currentIndex > 0) { currentIndex--; updateFullscreenCard(); }
        } else if (e.key === ' ') {
            e.preventDefault();
            isFlipped = !isFlipped;
            cardInner.classList.toggle('flipped', isFlipped);
        }
    }
    document.addEventListener('keydown', handleKeydown);

    // Close when clicking outside the modal
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            if (document.body.contains(overlay)) document.body.removeChild(overlay);
            document.removeEventListener('keydown', handleKeydown);
        }
    });
}

function renderFlashcards(aiResponse) {
    // Parse the AI response to extract Q&A pairs
    const cards = [];
    const lines = aiResponse.split('\n');
    let introText = "";
    let currentCard = { question: '', answer: '' };
    let foundFirstCard = false;

    // Regex to find Q and A markers anywhere in a line
    const qPattern = /(?:\*\*|)?Q(?:uestion)?\s*\d*\s*[:.]\s*(.*)/i;
    const aPattern = /(?:\*\*|)?A(?:nswer)?\s*\d*\s*[:.]\s*(.*)/i;

    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) {
            if (!foundFirstCard) introText += "\n";
            return;
        }

        const qMatch = trimmed.match(qPattern);
        const aMatch = trimmed.match(aPattern);

        if (qMatch) {
            foundFirstCard = true;
            currentCard.question = qMatch[1].replace(/\*\*/g, '').trim();
            const secondPart = qMatch[1].match(aPattern);
            if (secondPart) {
                currentCard.question = qMatch[1].split(secondPart[0])[0].replace(/\*\*/g, '').trim();
                currentCard.answer = secondPart[1].replace(/\*\*/g, '').trim();
                cards.push({ ...currentCard });
                currentCard = { question: '', answer: '' };
            }
        } else if (aMatch) {
            foundFirstCard = true;
            currentCard.answer = aMatch[1].replace(/\*\*/g, '').trim();
            if (currentCard.question) {
                cards.push({ ...currentCard });
                currentCard = { question: '', answer: '' };
            }
        } else {
            if (!foundFirstCard) {
                introText += line + "\n";
            } else {
                // Continuation line
                if (currentCard.question && !currentCard.answer) {
                    currentCard.question += ' ' + trimmed.replace(/\*\*/g, '').trim();
                } else if (currentCard.question && currentCard.answer !== undefined) {
                    currentCard.answer += ' ' + trimmed.replace(/\*\*/g, '').trim();
                }
            }
        }
    });

    if (currentCard.question && currentCard.answer) {
        cards.push({ ...currentCard });
    }

    if (cards.length === 0) return 0;

    // Show intro text if any
    if (introText.trim()) {
        addMessageToUI('ai', introText.trim());
    }

    // Create flashcard UI
    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper';

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message ai';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = 'AI';

    const flashcardContainer = document.createElement('div');
    flashcardContainer.className = 'flashcard-container';

    const title = document.createElement('div');
    title.className = 'flashcard-title';
    title.textContent = `🃏 ${cards.length} Flashcards Generated`;

    const downloadContainer = document.createElement('div');
    downloadContainer.className = 'flashcard-download-actions';

    const pdfBtn = document.createElement('button');
    pdfBtn.className = 'flashcard-action-btn';
    pdfBtn.innerHTML = '📄 PDF';
    pdfBtn.onclick = () => downloadFlashcardsPDF(cards);

    const jsonBtn = document.createElement('button');
    jsonBtn.className = 'flashcard-action-btn';
    jsonBtn.innerHTML = '📦 JSON';
    jsonBtn.onclick = () => downloadFlashcardsJSON(cards);

    const csvBtn = document.createElement('button');
    csvBtn.className = 'flashcard-action-btn';
    csvBtn.innerHTML = '📊 CSV';
    csvBtn.onclick = () => downloadFlashcardsCSV(cards);

    downloadContainer.appendChild(pdfBtn);
    downloadContainer.appendChild(jsonBtn);
    downloadContainer.appendChild(csvBtn);

    const fullscreenBtn = document.createElement('button');
    fullscreenBtn.className = 'flashcard-action-btn fullscreen-btn';
    fullscreenBtn.innerHTML = '⛶ Fullscreen';
    fullscreenBtn.onclick = () => openFlashcardFullscreen(cards);

    downloadContainer.appendChild(fullscreenBtn);

    const titleRow = document.createElement('div');
    titleRow.className = 'flashcard-header-row';
    titleRow.appendChild(title);
    titleRow.appendChild(downloadContainer);

    flashcardContainer.appendChild(titleRow);

    const cardDisplay = document.createElement('div');
    cardDisplay.className = 'flashcard-display';

    let currentIndex = 0;
    let isFlipped = false;

    const cardInner = document.createElement('div');
    cardInner.className = 'flashcard-inner';

    const cardFront = document.createElement('div');
    cardFront.className = 'flashcard-face flashcard-front';

    const cardBack = document.createElement('div');
    cardBack.className = 'flashcard-face flashcard-back';

    function updateCard() {
        cardFront.textContent = cards[currentIndex].question;
        cardBack.textContent = cards[currentIndex].answer;
        cardInner.classList.remove('flipped');
        isFlipped = false;
        counter.textContent = (currentIndex + 1) + ' / ' + cards.length;
    }

    cardInner.appendChild(cardFront);
    cardInner.appendChild(cardBack);
    cardDisplay.appendChild(cardInner);

    cardDisplay.addEventListener('click', () => {
        isFlipped = !isFlipped;
        cardInner.classList.toggle('flipped', isFlipped);
    });

    const controls = document.createElement('div');
    controls.className = 'flashcard-controls';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'flashcard-btn';
    prevBtn.textContent = '← Prev';
    prevBtn.onclick = () => {
        if (currentIndex > 0) { currentIndex--; updateCard(); }
    };

    const counter = document.createElement('span');
    counter.className = 'flashcard-counter';
    counter.textContent = '1 / ' + cards.length;

    const nextBtn = document.createElement('button');
    nextBtn.className = 'flashcard-btn';
    nextBtn.textContent = 'Next →';
    nextBtn.onclick = () => {
        if (currentIndex < cards.length - 1) { 
            currentIndex++; 
            updateCard(); 
        } else {
            // Show Finish button
            if (state.user) {
                nextBtn.textContent = 'Finish & Earn XP 🏆';
                nextBtn.classList.add('primary-btn');
                nextBtn.onclick = () => {
                    updateUserStats(50, 0); // +50 XP for finishing
                    nextBtn.textContent = 'Finished! ✅';
                    nextBtn.disabled = true;
                };
            }
        }
    };

    const hint = document.createElement('div');
    hint.className = 'flashcard-hint';
    hint.textContent = 'Click the card to flip it';

    controls.appendChild(prevBtn);
    controls.appendChild(counter);
    controls.appendChild(nextBtn);

    flashcardContainer.appendChild(cardDisplay);
    flashcardContainer.appendChild(controls);
    flashcardContainer.appendChild(hint);

    messageDiv.appendChild(avatar);
    messageDiv.appendChild(flashcardContainer);
    wrapper.appendChild(messageDiv);
    DOM.chatContainer.appendChild(wrapper);
    scrollToBottom();

    updateCard();
    return cards.length;
}

async function downloadFlashcardsPDF(cards) {
    if (!window.jspdf) {
        alert("PDF library not loaded. Please check your internet connection.");
        return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    // Header
    doc.setFont("helvetica", "bold");
    doc.setFontSize(22);
    doc.setTextColor(79, 70, 229); // var(--accent-primary)
    doc.text("StudyBuddy AI - Flashcards", 20, 20);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(100, 100, 100);
    doc.text(`Generated on: ${new Date().toLocaleString()}`, 20, 28);
    doc.setDrawColor(79, 70, 229);
    doc.setLineWidth(0.5);
    doc.line(20, 32, 190, 32);

    let y = 45;
    cards.forEach((card, index) => {
        // Check for new page
        if (y > 260) {
            doc.addPage();
            y = 20;
        }

        // Question
        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.setTextColor(17, 24, 39); // text-primary
        doc.text(`Question ${index + 1}:`, 20, y);

        doc.setFont("helvetica", "normal");
        const qLines = doc.splitTextToSize(card.question, 160);
        doc.text(qLines, 30, y + 6);
        y += (qLines.length * 6) + 12;

        // Answer
        doc.setFont("helvetica", "bold");
        doc.setTextColor(16, 185, 129); // success green
        doc.text(`Answer:`, 20, y);

        doc.setFont("helvetica", "normal");
        doc.setTextColor(55, 65, 81);
        const aLines = doc.splitTextToSize(card.answer, 160);
        doc.text(aLines, 30, y + 6);
        y += (aLines.length * 6) + 15;

        // Divider
        doc.setDrawColor(229, 231, 235); // border-color
        doc.setLineWidth(0.1);
        doc.line(20, y - 8, 190, y - 8);
    });

    doc.save("studybuddy-flashcards.pdf");
}

function downloadFlashcardsJSON(cards) {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(cards, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `studybuddy-flashcards-${Date.now()}.json`);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
}

function downloadFlashcardsCSV(cards) {
    // CSV format: Question,Answer
    let csvContent = "Question,Answer\n";
    cards.forEach(card => {
        // Escape quotes
        const q = `"${card.question.replace(/"/g, '""')}"`;
        const a = `"${card.answer.replace(/"/g, '""')}"`;
        csvContent += `${q},${a}\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `studybuddy-flashcards-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

function renderQuiz(aiResponse) {
    // Aggressive parsing for quiz
    const questions = [];
    const lines = aiResponse.split('\n');
    let introText = "";
    let currentQ = null;
    let foundFirstQ = false;

    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) {
            if (!foundFirstQ) introText += "\n";
            return;
        }

        // Detect Question header
        const qMatch = trimmed.match(/^(?:\*\*|)?Q(?:uestion)?\s*(\d+)\s*[:.]\s*(.*)/i);
        // Detect Option
        const oMatch = trimmed.match(/^(?:\*\*|)?([A-D])[).]\s*((?:(?!Answer\s*[:.]).)*)/i);
        // Detect Answer
        const aMatch = trimmed.match(/^(?:\*\*|)?(?:Correct\s+)?Answer\s*[:.]\s*([A-D])/i);
        // Detect Explanation
        const eMatch = trimmed.match(/^(?:\*\*|)?Explanation\s*[:.]\s*(.*)/i);

        if (qMatch) {
            foundFirstQ = true;
            if (currentQ && currentQ.text && currentQ.options.length >= 2) questions.push(currentQ);
            currentQ = { id: qMatch[1], text: qMatch[2].replace(/\*\*/g, '').trim(), options: [], answer: '', explanation: '' };
        } else if (oMatch && currentQ) {
            let optionText = oMatch[2].replace(/\*\*/g, '').trim();
            const inlineAnswer = optionText.match(/\bAnswer\s*[:.]\s*([A-D])\b/i);
            if (inlineAnswer) {
                currentQ.answer = inlineAnswer[1].toUpperCase();
                optionText = optionText.replace(/\s*\bAnswer\s*[:.]\s*[A-D]\b/i, '').trim();
            }
            const inlineExplain = optionText.match(/\bExplanation\s*[:.]\s*(.*)/i);
            if (inlineExplain) {
                currentQ.explanation = inlineExplain[1].replace(/\*\*/g, '').trim();
                optionText = optionText.replace(/\s*\bExplanation\s*[:.].*/i, '').trim();
            }
            currentQ.options.push({ letter: oMatch[1].toUpperCase(), text: optionText });
        } else if (aMatch && currentQ) {
            currentQ.answer = aMatch[1].toUpperCase();
        } else if (eMatch && currentQ) {
            currentQ.explanation = eMatch[1].replace(/\*\*/g, '').trim();
        } else {
            if (!foundFirstQ) {
                introText += line + "\n";
            } else if (currentQ) {
                // Continuation line logic
                if (currentQ.options.length === 0) {
                    currentQ.text += ' ' + trimmed.replace(/\*\*/g, '').trim();
                } else {
                    const lastOpt = currentQ.options[currentQ.options.length - 1];
                    if (lastOpt) lastOpt.text += ' ' + trimmed.replace(/\*\*/g, '').trim();
                }
            }
        }
    });

    if (currentQ && currentQ.text && currentQ.options.length >= 2) questions.push(currentQ);

    if (questions.length === 0) return 0;

    if (introText.trim()) {
        addMessageToUI('ai', introText.trim());
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper';

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message ai';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = 'AI';

    const quizContainer = document.createElement('div');
    quizContainer.className = 'quiz-container';

    const quizTitle = document.createElement('div');
    quizTitle.className = 'quiz-title';
    quizTitle.textContent = '📝 Quiz — ' + questions.length + ' Questions';
    quizContainer.appendChild(quizTitle);

    let score = 0;
    let answered = 0;
    const userAnswers = {};

    questions.forEach((q, qIndex) => {
        const questionDiv = document.createElement('div');
        questionDiv.className = 'quiz-question';

        const questionText = document.createElement('div');
        questionText.className = 'quiz-question-text';
        questionText.textContent = (qIndex + 1) + '. ' + q.text;
        questionDiv.appendChild(questionText);

        const optionsDiv = document.createElement('div');
        optionsDiv.className = 'quiz-options';

        q.options.forEach(option => {
            const optionBtn = document.createElement('button');
            optionBtn.className = 'quiz-option-btn';
            optionBtn.textContent = option.letter + ') ' + option.text;

            optionBtn.onclick = () => {
                if (userAnswers[qIndex] !== undefined) return;
                userAnswers[qIndex] = option.letter;
                answered++;

                const isCorrect = option.letter === q.answer;
                if (isCorrect) {
                    score++;
                    if (state.user) updateUserStats(0, 15); // +15 KP per correct answer
                }

                // Mark all options
                optionsDiv.querySelectorAll('.quiz-option-btn').forEach(btn => {
                    const btnLetter = btn.textContent.trim()[0].toUpperCase();
                    if (btnLetter === q.answer) {
                        btn.classList.add('correct');
                    } else if (btnLetter === option.letter && !isCorrect) {
                        btn.classList.add('incorrect');
                    }
                    btn.disabled = true;
                });

                // Show explanation
                const explanationDiv = document.createElement('div');
                explanationDiv.className = 'quiz-explanation';
                explanationDiv.textContent = (isCorrect ? '✓ Correct! ' : '✗ Wrong. ') + q.explanation;
                explanationDiv.classList.add(isCorrect ? 'correct-explanation' : 'incorrect-explanation');
                questionDiv.appendChild(explanationDiv);

                // Show final score if all answered
                if (answered === questions.length) {
                    const scoreDiv = document.createElement('div');
                    scoreDiv.className = 'quiz-final-score';
                    const percent = Math.round((score / questions.length) * 100);
                    scoreDiv.textContent = '🎯 Final Score: ' + score + '/' + questions.length + ' (' + percent + '%)';
                    scoreDiv.classList.add(percent >= 70 ? 'score-good' : 'score-bad');
                    quizContainer.appendChild(scoreDiv);
                    
                    if (state.user) {
                        updateUserStats(50, 0, true); // +50 XP for finishing quiz
                    }
                }
            };

            optionsDiv.appendChild(optionBtn);
        });

        questionDiv.appendChild(optionsDiv);
        quizContainer.appendChild(questionDiv);
    });

    messageDiv.appendChild(avatar);
    messageDiv.appendChild(quizContainer);
    wrapper.appendChild(messageDiv);
    DOM.chatContainer.appendChild(wrapper);
    scrollToBottom();
    return questions.length;
}

// --- SECTION H — MAIN HANDLERS ---
function getRequestType(text) {
    const lower = text.toLowerCase().trim();

    const flashcardMatch = lower.match(/^flashcards\s*:/);
    if (flashcardMatch) return { type: 'flashcards', content: text.substring(flashcardMatch[0].length).trim() };

    const quizMatch = lower.match(/^quiz me on\s*:/);
    if (quizMatch) return { type: 'quiz', content: text.substring(quizMatch[0].length).trim() };

    const imagePrompt = getImagePrompt(text);
    if (imagePrompt) return { type: 'image', prompt: imagePrompt };

    return { type: 'chat' };
}

function getSystemPromptForType(type, content) {
    if (type === 'flashcards') {
        return `Generate a set of flashcards from the following text.

STRICT RULES you MUST follow exactly:
1. Every single flashcard MUST use this EXACT format with question and answer on the SAME line as the label:
**Q:** write the full question here on this same line
**A:** write the full answer here on this same line

2. Do NOT put the question or answer on a new line after the label.
3. Do NOT add numbering like Q1, Q2.
4. Separate each flashcard with one blank line.
5. Generate as many cards as needed to cover all key concepts.

Text to make flashcards from:
${content}`;
    }

    if (type === 'quiz') {
        return `Generate exactly 5 multiple choice quiz questions about: "${content}".\n\nFormat each question EXACTLY like this:\n\nQ1: [question text]\nA) [option text only]\nB) [option text only]\nC) [option text only]\nD) [option text only]\nAnswer: [single capital letter only, e.g. A]\nExplanation: [brief explanation]\n\nSTRICT RULES:\n- Each A) B) C) D) line must contain option text ONLY. Never append Answer: to any option line.\n- The Answer line must be on its own separate line containing only a single letter A, B, C, or D.\n- The Explanation line must be on its own separate line.\n- Separate each question with a blank line.\n- Do not use markdown bold (**) anywhere.`;
    }

    return null;
}

function enhanceImagePrompt(userPrompt) {
    const base = userPrompt.trim();

    // If the prompt is about space, planets or solar system, inject geometric correction keywords
    const isSpacePrompt = /planet|solar|space|orbit|saturn|jupiter|earth|mars|cosmos|galaxy/i.test(base);
    const spaceBoost = isSpacePrompt
        ? ', each planet is a perfect geometrically accurate sphere, no oval shapes, no distortion, planets clearly separated with visible space between them, each planet has surface texture and detail, '
        : '';

    const wordCount = base.split(' ').length;

    if (wordCount > 15) {
        return base + spaceBoost + ', highly detailed, photorealistic, 8k resolution, masterpiece, sharp focus, vivid colors';
    }

    return base
        + spaceBoost
        + ', highly detailed'
        + ', photorealistic'
        + ', perfect spherical shapes'
        + ', geometrically accurate forms'
        + ', smooth clean edges'
        + ', 8k ultra high resolution'
        + ', masterpiece quality'
        + ', professional photography'
        + ', vivid natural colors'
        + ', sharp focus'
        + ', beautiful cinematic lighting'
        + ', stunning visual composition'
        + ', award winning photograph'
        + ', crisp and precise details';
}

function getImagePrompt(text) {
    const lower = text.toLowerCase().trim();

    // Specific triggers that are definitely image requests
    const strongTriggers = [
        '/image ',
        'generate image of ',
        'generate image ',
        'generate a high quality image of ',
        'generate a high-quality image of ',
        'create image of ',
        'create an image of ',
        'create a image of ',
        'draw me an image of ',
        'draw an image of ',
        'make an image of ',
        'show me an image of ',
        'show me a picture of ',
    ];

    for (const trigger of strongTriggers) {
        if (lower.startsWith(trigger)) {
            const rawPrompt = text.substring(trigger.length).trim();
            if (rawPrompt.length > 0) return enhanceImagePrompt(rawPrompt);
        }
    }

    // Generic triggers that need "image/picture/photo" keywords to confirm intent
    const genericTriggers = [
        'generate ',
        'create ',
        'draw ',
        'make ',
        'show me ',
        'paint ',
        'illustrate ',
    ];

    const imageKeywords = ['image', 'picture', 'photo', 'drawing', 'painting', 'sketch', 'illustration', 'diagram'];

    for (const trigger of genericTriggers) {
        if (lower.startsWith(trigger)) {
            const rest = lower.substring(trigger.length).trim();
            const hasKeyword = imageKeywords.some(word => rest.includes(word));
            if (hasKeyword) {
                const rawPrompt = text.substring(trigger.length).trim();
                if (rawPrompt.length > 0) return enhanceImagePrompt(rawPrompt);
            }
        }
    }

    // Direct nouns
    const nounTriggers = ['picture of ', 'image of ', 'photo of ', 'drawing of '];
    for (const trigger of nounTriggers) {
        if (lower.startsWith(trigger)) {
            const rawPrompt = text.substring(trigger.length).trim();
            if (rawPrompt.length > 0) return enhanceImagePrompt(rawPrompt);
        }
    }

    return null;
}

async function handleSendMessage() {
    if (state.isCurrentlyGenerating()) return;
    const text = DOM.messageInput.value.trim();
    if (!text) return;

    const request = getRequestType(text);

    addMessageToUI('user', text);
    state.addMessageToCurrentSession('user', text);
    resetTextarea();
    renderSessionsList();

    state.setGenerating(true);
    DOM.messageInput.disabled = true;

    if (request.type === 'image') {
        addMessageToUI('ai', "Sure! Generating that image for you now 🎨");
        const loadingIndicator = showImageLoadingIndicator();
        try {
            const imageUrl = await generateImage(request.prompt);
            removeElement(loadingIndicator);
            addImageToUI(request.prompt, imageUrl);
            state.addMessageToCurrentSession('ai', '[IMAGE_PROMPT]' + request.prompt);
        } catch (error) {
            removeElement(loadingIndicator);
            addErrorToUI(error.message);
        }
    } else {
        let messageToSend = text;
        const systemPrompt = getSystemPromptForType(request.type, request.content);
        if (systemPrompt) messageToSend = systemPrompt;

        const typingIndicator = showTypingIndicator();
        try {
            const aiResponse = await generateChatResponse(messageToSend, request.type);
            removeElement(typingIndicator);
            state.addMessageToCurrentSession('ai', aiResponse);

            if (request.type === 'flashcards') {
                const cardCount = renderFlashcards(aiResponse);
                if (!cardCount || cardCount === 0) addMessageToUI('ai', aiResponse);
            } else if (request.type === 'quiz') {
                const questionCount = renderQuiz(aiResponse);
                if (!questionCount || questionCount === 0) addMessageToUI('ai', aiResponse);
            } else {
                addMessageToUI('ai', aiResponse);
            }

            // Save to Firestore History if logged in
            if (state.user) {
                const topic = request.type === 'image' ? `Image: ${request.prompt}` : (state.getCurrentSession()?.title || text);
                saveToHistory(topic, aiResponse);
            }

            // Gamification rewards (Always apply to local state)
            let xp = 10; // Base chat XP
            let kp = 0;
            if (request.type === 'image') xp = 20;
            if (request.type === 'flashcards' || request.type === 'quiz') xp = 50;

            updateUserStats(xp, kp);
        } catch (error) {
            removeElement(typingIndicator);
            addErrorToUI(error.message);
        }
    }

    state.setGenerating(false);
    DOM.messageInput.disabled = false;
    DOM.messageInput.focus();
    updateSendButtonState();
}

// --- SECTION I — EVENT LISTENERS ---
function setupEventListeners() {
    DOM.messageInput.addEventListener('input', () => { autoResizeTextarea(); updateSendButtonState(); });
    DOM.messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); }
    });

    DOM.sendBtn.addEventListener('click', handleSendMessage);
    DOM.stopBtn.addEventListener('click', stopGenerating);

    DOM.newChatBtn.addEventListener('click', () => {
        state.createNewSession();
        clearChatUI();
        renderSessionsList();
        if (window.innerWidth <= 768) toggleSidebar();
    });

    DOM.themeToggleBtn.addEventListener('click', () => {
        const isDark = document.body.classList.contains('dark-mode');
        setTheme(isDark ? 'light' : 'dark');
    });

    // DOM.settingsBtn.addEventListener('click', () => toggleModal(true));
    DOM.headerSettingsBtn.addEventListener('click', () => toggleModal(true));
    DOM.closeSettingsBtn.addEventListener('click', () => toggleModal(false));

    DOM.settingsModal.addEventListener('click', (e) => {
        if (e.target === DOM.settingsModal) toggleModal(false);
    });

    DOM.mobileMenuBtn.addEventListener('click', toggleSidebar);

    // Accessibility: Escape key closes modals
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (DOM.settingsModal.classList.contains('active')) toggleModal(false);
            if (DOM.pomodoroModal.classList.contains('active')) DOM.pomodoroModal.classList.remove('active');
            if (talkModeActive) closeTalkMode();
        }
    });

    setupPomodoroListeners();
    setupVoiceListeners();
}

// --- SECTION K — POMODORO TIMER ---
let pomodoroInterval = null;
let pomodoroSeconds = 25 * 60;
let pomodoroRunning = false;
let pomodoroSessionsCompleted = 0;
let pomodoroTotalSeconds = 25 * 60;

function formatPomodoroTime(seconds) {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return m + ':' + s;
}

function updatePomodoroDisplay() {
    const timeText = formatPomodoroTime(pomodoroSeconds);
    // Set the text in the inner span, not directly on the display div
    const displayEl = DOM.pomodoroDisplay;
    const progress = 1 - (pomodoroSeconds / pomodoroTotalSeconds);
    displayEl.style.background = `conic-gradient(var(--accent-primary) ${progress * 360}deg, var(--border-color) 0deg)`;
    // Update only the time text node, not innerHTML (preserve structure)
    let timeNode = displayEl.querySelector('.pomodoro-time-text');
    if (!timeNode) {
        timeNode = document.createElement('span');
        timeNode.className = 'pomodoro-time-text';
        displayEl.appendChild(timeNode);
    }
    timeNode.textContent = timeText;
}

function startPomodoro() {
    if (pomodoroRunning) {
        clearInterval(pomodoroInterval);
        pomodoroRunning = false;
        DOM.pomodoroStartBtn.textContent = 'Resume';
        return;
    }

    pomodoroRunning = true;
    DOM.pomodoroStartBtn.textContent = 'Pause';

    pomodoroInterval = setInterval(() => {
        pomodoroSeconds--;
        updatePomodoroDisplay();

        if (pomodoroSeconds <= 0) {
            clearInterval(pomodoroInterval);
            pomodoroRunning = false;
            pomodoroSessionsCompleted++;
            DOM.pomodoroSessionsCount.textContent = 'Sessions completed: ' + pomodoroSessionsCompleted;
            DOM.pomodoroStartBtn.textContent = 'Start';
            // Play a simple beep sound using Web Audio API
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const oscillator = ctx.createOscillator();
                const gainNode = ctx.createGain();
                oscillator.connect(gainNode);
                gainNode.connect(ctx.destination);
                oscillator.frequency.value = 880;
                oscillator.type = 'sine';
                gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
                gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.5);
                oscillator.start(ctx.currentTime);
                oscillator.stop(ctx.currentTime + 1.5);
            } catch (e) { }
            alert('⏱ Time is up! Great work!');
        }
    }, 1000);
}

function resetPomodoro() {
    clearInterval(pomodoroInterval);
    pomodoroRunning = false;
    DOM.pomodoroStartBtn.textContent = 'Start';
    updatePomodoroDisplay();
}

function setupPomodoroListeners() {
    DOM.pomodoroBtn.addEventListener('click', () => {
        DOM.pomodoroModal.classList.add('active');
        updatePomodoroDisplay();
    });

    DOM.closePomodoroBtn.addEventListener('click', () => {
        DOM.pomodoroModal.classList.remove('active');
    });

    DOM.pomodoroModal.addEventListener('click', (e) => {
        if (e.target === DOM.pomodoroModal) DOM.pomodoroModal.classList.remove('active');
    });

    DOM.pomodoroStartBtn.addEventListener('click', startPomodoro);
    DOM.pomodoroResetBtn.addEventListener('click', () => {
        resetPomodoro();
        updatePomodoroDisplay();
    });

    document.querySelectorAll('.pomodoro-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.pomodoro-type-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const minutes = parseInt(btn.dataset.minutes);
            const mode = btn.dataset.mode;
            pomodoroTotalSeconds = minutes * 60;
            pomodoroSeconds = pomodoroTotalSeconds;
            DOM.pomodoroModeLabel.textContent = mode;
            resetPomodoro();
            updatePomodoroDisplay();
        });
    });
}

// --- SECTION L — VOICE & TALK MODE ---

let voiceRecognition = null;
let isListening = false;
let talkModeActive = false;
let ttsEnabled = true;
let ttsRate = 1.0;
let currentUtterance = null;
let voiceFinalResult = '';
let backgroundMicStream = null;

// Check if browser supports speech recognition
function isSpeechRecognitionSupported() {
    return 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
}

// Check if browser supports speech synthesis
function isTTSSupported() {
    return 'speechSynthesis' in window;
}

// Initialize Speech Recognition once to help with permissions
function initVoiceRecognition() {
    if (!isSpeechRecognitionSupported()) return;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    voiceRecognition = new SpeechRecognition();
    voiceRecognition.continuous = false;
    voiceRecognition.interimResults = true;
    voiceRecognition.lang = 'en-US';

    voiceRecognition.onstart = () => {
        isListening = true;
        voiceFinalResult = '';
        if (talkModeActive) {
            DOM.talkModeAvatar.className = 'talk-mode-avatar listening';
            DOM.talkModeStatus.textContent = 'Listening...';
            DOM.talkMicBtn.className = 'talk-mic-btn listening';
        } else {
            DOM.voiceBtn.classList.add('listening');
        }
    };

    voiceRecognition.onresult = (event) => {
        let interimTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                voiceFinalResult = transcript;
            } else {
                interimTranscript += transcript;
            }
        }

        const displayTranscript = voiceFinalResult || interimTranscript;
        if (talkModeActive) {
            DOM.talkModeTranscript.textContent = displayTranscript;
        } else {
            DOM.messageInput.value = displayTranscript;
            autoResizeTextarea();
            updateSendButtonState();
        }
    };

    voiceRecognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        isListening = false;
        if (talkModeActive) {
            DOM.talkModeStatus.textContent = 'Error hearing you. Try again.';
            DOM.talkModeAvatar.className = 'talk-mode-avatar idle';
            DOM.talkMicBtn.className = 'talk-mic-btn idle';
        } else {
            DOM.voiceBtn.classList.remove('listening');
        }
    };

    voiceRecognition.onend = () => {
        isListening = false;
        if (!talkModeActive) {
            DOM.voiceBtn.classList.remove('listening');
        } else {
            DOM.talkMicBtn.className = 'talk-mic-btn idle';
        }

        // If we have a result and we are in talk mode, handle it now
        if (voiceFinalResult && talkModeActive) {
            handleTalkModeMessage(voiceFinalResult.trim());
            voiceFinalResult = '';
        }
    };
}

// Speak text out loud using browser TTS
function speakText(text) {
    if (!isTTSSupported() || !ttsEnabled) return;

    window.speechSynthesis.cancel();

    const cleanText = text
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/#{1,6}\s/g, '')
        .replace(/`{1,3}[^`]*`{1,3}/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[-*+]\s/g, '')
        .trim();

    currentUtterance = new SpeechSynthesisUtterance(cleanText);
    currentUtterance.rate = ttsRate;

    const voices = window.speechSynthesis.getVoices();
    const preferredVoice = voices.find(v =>
        v.name.includes('Google') || v.name.includes('Natural') ||
        v.lang.startsWith('en')
    );
    if (preferredVoice) currentUtterance.voice = preferredVoice;

    currentUtterance.onstart = () => {
        if (talkModeActive) {
            DOM.talkModeAvatar.className = 'talk-mode-avatar speaking';
            DOM.talkModeStatus.textContent = 'StudyBuddy is speaking...';
        }
    };

    currentUtterance.onend = () => {
        if (talkModeActive) {
            DOM.talkModeAvatar.className = 'talk-mode-avatar idle';
            DOM.talkModeStatus.textContent = 'Hold the mic to speak';
        }
    };

    window.speechSynthesis.speak(currentUtterance);
}

function stopSpeaking() {
    window.speechSynthesis.cancel();
    if (talkModeActive) {
        DOM.talkModeAvatar.className = 'talk-mode-avatar idle';
        DOM.talkModeStatus.textContent = 'Hold the mic to speak';
    }
}

function startVoiceInput() {
    if (!voiceRecognition) initVoiceRecognition();
    if (!voiceRecognition) {
        alert('Voice not supported.');
        return;
    }
    if (isListening) return;
    try {
        voiceRecognition.start();
    } catch (e) {
        console.error(e);
    }
}

function stopVoiceInput() {
    if (voiceRecognition && isListening) {
        voiceRecognition.stop();
    }
}

async function handleTalkModeMessage(transcript) {
    if (!transcript || state.isCurrentlyGenerating()) return;

    const request = getRequestType(transcript);

    DOM.talkModeTranscript.textContent = '"' + transcript + '"';
    DOM.talkModeStatus.textContent = 'Thinking...';
    DOM.talkModeAvatar.className = 'talk-mode-avatar thinking';

    addMessageToUI('user', transcript);
    state.addMessageToCurrentSession('user', transcript);
    renderSessionsList();

    state.setGenerating(true);

    if (request.type === 'image') {
        addMessageToUI('ai', "Sure! Generating that image for you now 🎨");
        speakText("Sure! Generating that image for you now.");
        const loadingIndicator = showImageLoadingIndicator();
        try {
            const imageUrl = await generateImage(request.prompt);
            removeElement(loadingIndicator);
            addImageToUI(request.prompt, imageUrl);
            state.addMessageToCurrentSession('ai', '[IMAGE_PROMPT]' + request.prompt);
            DOM.talkModeStatus.textContent = 'Image generated! 🎨';
            DOM.talkModeAvatar.className = 'talk-mode-avatar idle';
        } catch (error) {
            removeElement(loadingIndicator);
            addErrorToUI(error.message);
            DOM.talkModeStatus.textContent = 'Error generating image.';
            DOM.talkModeAvatar.className = 'talk-mode-avatar idle';
        } finally {
            state.setGenerating(false);
        }
    } else {
        let messageToSend = transcript;
        const systemPrompt = getSystemPromptForType(request.type, request.content);
        if (systemPrompt) messageToSend = systemPrompt;

        try {
            const aiResponse = await generateChatResponse(messageToSend, request.type);
            state.addMessageToCurrentSession('ai', aiResponse);

            if (request.type === 'flashcards') {
                const cardCount = renderFlashcards(aiResponse);
                if (!cardCount || cardCount === 0) addMessageToUI('ai', aiResponse);
                speakText(`I've generated ${cardCount || 'some'} flashcards for you.`);
            } else if (request.type === 'quiz') {
                const questionCount = renderQuiz(aiResponse);
                if (!questionCount || questionCount === 0) addMessageToUI('ai', aiResponse);
                speakText(`I've created a quiz for you.`);
            } else {
                addMessageToUI('ai', aiResponse);
                speakText(aiResponse);
            }

            // Save to Firestore History if logged in
            if (state.user) {
                const topic = request.type === 'image' ? `Image: ${request.prompt}` : (state.getCurrentSession()?.title || transcript);
                saveToHistory(topic, aiResponse);
            }

            // Gamification rewards (Always apply to local state)
            let xp = 15; // Voice chat gets a small bonus (+5 XP)
            let kp = 0;
            if (request.type === 'image') xp = 25;
            if (request.type === 'flashcards' || request.type === 'quiz') xp = 60;

            updateUserStats(xp, kp);
        } catch (error) {
        } catch (error) {
            DOM.talkModeStatus.textContent = 'Error: ' + error.message;
            DOM.talkModeAvatar.className = 'talk-mode-avatar idle';
            addErrorToUI(error.message);
        } finally {
            state.setGenerating(false);
        }
    }
}

function openTalkMode() {
    talkModeActive = true;
    DOM.talkModeOverlay.style.display = 'flex';
    DOM.talkModeTranscript.textContent = '';
    DOM.talkModeStatus.textContent = 'Hold the mic to speak';
    DOM.talkModeAvatar.className = 'talk-mode-avatar idle';

    // Request background mic stream to maintain permission during the session
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(stream => {
                backgroundMicStream = stream;
                console.log("Background mic stream active for session persistence.");
            })
            .catch(err => {
                console.error("Could not start background mic stream:", err);
                DOM.talkModeStatus.textContent = 'Mic permission denied. Use browser settings to fix.';
            });
    }
}

function closeTalkMode() {
    talkModeActive = false;
    stopSpeaking();
    stopVoiceInput();

    // Release the background stream
    if (backgroundMicStream) {
        backgroundMicStream.getTracks().forEach(track => track.stop());
        backgroundMicStream = null;
    }

    DOM.talkModeOverlay.style.display = 'none';
}

function setupVoiceListeners() {
    if (!DOM.voiceBtn) return;

    // Inline Voice
    DOM.voiceBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        stopSpeaking();
        startVoiceInput();
    });

    DOM.voiceBtn.addEventListener('mouseup', () => {
        stopVoiceInput();
        setTimeout(() => {
            if (!talkModeActive && DOM.messageInput.value.trim()) {
                handleSendMessage();
            }
        }, 500);
    });

    // Sidebar
    DOM.talkModeBtn.addEventListener('click', openTalkMode);
    DOM.talkModeCloseBtn.addEventListener('click', closeTalkMode);
    DOM.talkModeOverlay.addEventListener('click', (e) => {
        if (e.target === DOM.talkModeOverlay) closeTalkMode();
    });

    // Modal Mic
    DOM.talkMicBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (state.isCurrentlyGenerating()) return;
        stopSpeaking();
        startVoiceInput();
    });

    DOM.talkMicBtn.addEventListener('mouseup', () => {
        stopVoiceInput();
    });

    // Mobile
    DOM.voiceBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        stopSpeaking();
        startVoiceInput();
    });
    DOM.voiceBtn.addEventListener('touchend', () => {
        stopVoiceInput();
        setTimeout(() => {
            if (!talkModeActive && DOM.messageInput.value.trim()) handleSendMessage();
        }, 500);
    });

    DOM.talkMicBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        if (state.isCurrentlyGenerating()) return;
        stopSpeaking();
        startVoiceInput();
    });
    DOM.talkMicBtn.addEventListener('touchend', () => stopVoiceInput());

    DOM.ttsRateSlider.addEventListener('input', () => {
        ttsRate = parseFloat(DOM.ttsRateSlider.value);
        DOM.ttsRateValue.textContent = ttsRate.toFixed(1) + 'x';
    });

    DOM.ttsStopBtn.addEventListener('click', stopSpeaking);
}

// --- SECTION J — INIT ---
function init() {
    initDOM();
    initFirebase();
    renderWelcomePrompts();
    setupMarkdownRenderer();
    initVoiceRecognition();

    const savedTheme = localStorage.getItem('studybuddy_theme');
    if (savedTheme) {
        setTheme(savedTheme);
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        setTheme('dark');
    }

    renderSessionsList();

    const currentSession = state.getCurrentSession();
    if (currentSession && currentSession.messages.length > 0) {
        loadSessionIntoUI(currentSession);
    }

    fetchBackendStatus();
    setupEventListeners();
}

document.addEventListener('DOMContentLoaded', init);
