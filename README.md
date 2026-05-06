# StudyBuddy AI 🎓

StudyBuddy is a modern, student-focused AI chatbot designed to help with learning, summarizing notes, and generating educational images. It features a secure Node.js/Express backend to keep API keys safe and provide a professional, production-ready environment.

## Features
- **AI Tutoring**: Powered by Groq (Llama 3.3) for fast, intelligent academic support.
- **Image Generation**: Powered by Hugging Face (FLUX.1-schnell) for creating study-related visuals.
- **Smart Tools**: Includes a Pomodoro timer, Flashcard generator, and Quiz mode.
- **Talk Mode**: Hands-free interaction with voice-to-text and text-to-speech.
- **Secure Architecture**: Backend-managed API calls protect your provider secrets.

---

## Getting Started (Local Development)

Follow these steps to run StudyBuddy on your machine:

1. **Prerequisites**
   - Node.js (v18 or higher)
   - A [Groq API Key](https://console.groq.com/) (for chat)
   - A [Hugging Face Token](https://huggingface.co/settings/tokens) (for images)

2. **Installation**
   ```bash
   npm install
   ```

3. **Configuration**
   - Copy the `.env.example` file to a new file named `.env`:
     ```bash
     cp .env.example .env
     ```
   - Open `.env` and add your API keys:
     ```env
     GROQ_API_KEY=your_key_here
     HF_TOKEN=your_token_here
     ```

4. **Run the App**
   ```bash
   npm start
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Deployment Instructions

### 1. GitHub Preparation
- Create a new repository on GitHub.
- Initialize git in your project: `git init`.
- Add all files: `git add .`.
- Commit: `git commit -m "Initial commit"`.
- Push to GitHub: `git remote add origin <your-repo-url>` and `git push -u origin main`.
- **Note:** Your `.env` and `node_modules` are automatically ignored by `.gitignore`. **Never commit your API keys.**

### 2. Hosting on Render / Railway
These platforms are ideal for Node.js apps.

#### Render
1. Create a "Web Service" on [Render](https://render.com).
2. Connect your GitHub repository.
3. **Build Command**: `npm install`
4. **Start Command**: `npm start`
5. **Environment Variables**:
   - `GROQ_API_KEY`: (Your key)
   - `HF_TOKEN`: (Your token)
   - `ENABLE_PUBLIC_IMAGE_FALLBACK`: `false`
6. Click **Deploy**.

#### Railway
1. Create a "New Project" on [Railway](https://railway.app).
2. Connect your GitHub repository.
3. Railway will automatically detect the `package.json` and start the server.
4. Go to **Variables** and add:
   - `GROQ_API_KEY`
   - `HF_TOKEN`
   - `ENABLE_PUBLIC_IMAGE_FALLBACK`
5. Your app will be live on a generated URL.

---

## Important Security Notes
- **No Frontend Keys**: This app removes any legacy client-side keys for security. All AI requests go through the internal `/api` proxy.
- **GitHub Pages**: You cannot host this app on GitHub Pages alone, as it requires a running Node.js backend. GitHub Pages is only for static sites.

## Troubleshooting
- **Demo Mode**: If you see a "Demo Mode" badge, it means the `GROQ_API_KEY` is missing from your `.env` file.
- **Image Generation Failed**: Ensure your `HF_TOKEN` has proper permissions and that the model isn't currently overloaded.

---

*Made with ❤️ for students everywhere.*
