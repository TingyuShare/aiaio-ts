# aiaio-ts

A TypeScript rewrite of [aiaio](https://github.com/abhishekkrthakur/aiaio) - a lightweight, privacy-focused web UI for interacting with AI models. Supports both local and remote LLM deployments through OpenAI-compatible APIs.

## Features

- 🌓 Dark/Light mode support
- 💾 Local SQLite database for conversation storage
- 📁 File upload and processing (images, documents, etc.)
- ⚙️ Configurable model parameters through UI
- 🔒 Privacy-focused (all data stays local)
- 📱 Responsive design for mobile/desktop
- 🎨 Syntax highlighting for code blocks
- 📋 One-click code block copying
- 🔄 Real-time conversation updates
- 📝 Automatic conversation summarization
- 🎯 Customizable system prompts
- 🌐 WebSocket support for real-time updates
- 📦 Docker support for easy deployment
- 📦 Multiple API endpoint support
- 📦 Multiple system prompt support
- 🔑 Access code authentication
- 🔀 Custom API key header support (e.g. `api-key`)

## Requirements

- Node.js 18+
- An OpenAI-compatible API endpoint (local or remote)

## Installation

### From source

```bash
git clone https://github.com/TingyuShare/aiaio-ts.git
cd aiaio-ts
npm install
npm run build
```

## Quick Start

1. Start the server:
```bash
npm start
```

2. Open your browser and navigate to `http://127.0.0.1:10000`

3. Enter the default access code: `aiaio-ts`

4. You will be prompted to change the access code on first login

5. Configure your API endpoint and model settings in the UI

### Development mode

```bash
npm run dev
```

## Docker Usage

### Pre-built Image

```bash
docker pull tingyu163/aiaio-ts
docker run --network host \
  -v ./data:/data \
  tingyu163/aiaio-ts
```

### Docker Compose

```bash
docker compose up -d
```

```yaml
# docker-compose.yml
services:
  aiaio-ts:
    image: tingyu163/aiaio-ts
    network_mode: host
    volumes:
      - ./data:/data
    expose:
      - 10000
    restart: unless-stopped
```

## UI Configuration

### Model Parameters
- **Temperature** (0-2): Controls response randomness
- **Max Tokens** (1-32k): Maximum length of generated responses
- **Top P** (0-1): Controls diversity via nucleus sampling
- **Model Name**: Name/path of the model to use

### API Configuration
- **Host**: URL of your OpenAI-compatible API endpoint
- **API Key**: Authentication key if required by your endpoint
- **API Key Header**: Custom header name for API key (default: `Authorization`, use `api-key` for MiMo)

### Supported API Endpoints

- OpenAI API
- vLLM
- Text Generation Inference (TGI)
- Hugging Face Inference Endpoints
- llama.cpp server
- LocalAI
- Xiaomi MiMo API
- Custom OpenAI-compatible APIs

## Authentication

aiaio-ts includes a simple access code authentication system:

- Default access code: `aiaio-ts`
- Users must change the access code on first login
- All API requests require a valid authentication token
- Changing the access code invalidates all existing sessions

## Project Structure

```
aiaio-ts/
├── src/
│   ├── index.ts        # Entry point
│   ├── db.ts           # SQLite database layer
│   ├── routes.ts       # Express API routes
│   ├── websocket.ts    # WebSocket connection manager
│   ├── openai.ts       # OpenAI streaming helper
│   └── prompts.ts      # System prompt constants
├── public/
│   ├── index.html      # Frontend template
│   └── script.js       # Frontend logic
├── package.json
├── tsconfig.json
└── Dockerfile
```

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Original [aiaio](https://github.com/abhishekkrthakur/aiaio) by Abhishek Thakur
