# Use official Node.js image (Bookworm is based on Debian 12)
FROM node:20-bookworm-slim

# Set working directory
WORKDIR /app

# Install git and system tools
RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install npm dependencies
RUN npm install

# Install Playwright browsers and missing OS dependencies as root
RUN npx playwright install firefox
RUN npx playwright install-deps firefox

# Copy the rest of the application code
COPY . .

# Start master engine (Telegram Bot + Autonomous Daemon + HTTP Health Server)
CMD ["node", "index.js"]
