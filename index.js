/**
 * Master Entry Point for Railway Deployment
 * Spawns both:
 * 1. Interactive Telegram Bot (with real-time /start, /rail, /setup commands)
 * 2. 24/7 Autonomous Railway Daemon (with HTTP health check on $PORT for Railway)
 */

require('dotenv').config();

console.log('======================================================');
console.log('       Multiverse Railway Master Engine v1.0         ');
console.log('======================================================');

// 1. Launch Telegram Bot if token configured
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (botToken && !botToken.toLowerCase().includes('bot_token')) {
    console.log('🤖 Starting Telegram Bot listener...');
    try {
        require('./telegram_bot');
    } catch (err) {
        console.error('❌ Failed to launch Telegram Bot:', err.message);
    }
} else {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN is missing or placeholder. Interactive bot commands will be inactive.');
}

// 2. Launch Autonomous Railway Daemon & HTTP Health Service
console.log('⚙️ Starting Autonomous Background Daemon & Health Server...');
try {
    require('./auto_railway_daemon');
} catch (err) {
    console.error('❌ Failed to launch Autonomous Daemon:', err.message);
}
