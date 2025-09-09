const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const mineflayer = require('mineflayer');
const express = require('express');
const http = require('http');

// Configuration
const CONFIG = {
    discord: {
        token: process.env.DISCORD_BOT_TOKEN,
        channelId: '1414992938278191132'
    },
    minecraft: {
        host: 'donutsmp.net',
        port: 25565,
        version: '1.21.4',
        auth: 'microsoft'
    },
    webServer: {
        port: process.env.PORT || 3000,
        host: '0.0.0.0'
    }
};

class MinecraftDiscordBot {
    constructor() {
        this.discordClient = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.GuildMessageReactions
            ]
        });
        this.minecraftBot = null;
        this.controlMessage = null;
        this.isConnected = false;
        this.authUrl = null;
        this.userCode = null;
        this.shouldJoin = false;
        this.originalConsoleLog = null;
        this.originalStdoutWrite = null;
        this.authMessageSent = false;
        this.authCheckTimeout = null;
        this.lastAuthUser = null;
        this.authMessage = null;
        this.originalStderrWrite = null;
        this.authCheckInterval = null;

        // Enhanced features
        this.currentWorld = 'Unknown';
        this.currentCoords = { x: 0, y: 0, z: 0 };
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 5000;
        this.statusUpdateInterval = null;

        // Web server properties
        this.app = null;
        this.server = null;

        this.setupDiscordEvents();
    }

    async start() {
        try {
            // Start Discord bot first
            await this.discordClient.login(CONFIG.discord.token);
            console.log('Discord bot logged in successfully!');

            // Start periodic status updates every 30 seconds
            this.statusUpdateInterval = setInterval(() => {
                if (this.isConnected && this.minecraftBot) {
                    this.updatePositionInfo();
                    this.updateEmbed();
                }
            }, 30000);

            // Start web server after Discord bot is ready
            await this.startWebServer();

        } catch (error) {
            console.error('Failed to start services:', error);
        }
    }

    async startWebServer() {
        this.app = express();

        // Middleware
        this.app.use(express.json());
        this.app.use(express.static('public')); // Serve static files if you have any

        // Routes
        this.setupWebRoutes();

        // Create HTTP server
        this.server = http.createServer(this.app);

        // Start listening
        return new Promise((resolve, reject) => {
            this.server.listen(CONFIG.webServer.port, CONFIG.webServer.host, (error) => {
                if (error) {
                    console.error('Failed to start web server:', error);
                    reject(error);
                } else {
                    console.log(`Web server running on http://${CONFIG.webServer.host}:${CONFIG.webServer.port}`);
                    resolve();
                }
            });
        });
    }

    setupWebRoutes() {
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                timestamp: new Date().toISOString(),
                minecraft: {
                    connected: this.isConnected,
                    username: this.minecraftBot?.username || null,
                    world: this.currentWorld,
                    coordinates: this.currentCoords
                },
                discord: {
                    connected: this.discordClient.readyTimestamp !== null,
                    username: this.discordClient.user?.tag || null
                }
            });
        });

        // Bot status endpoint
        this.app.get('/status', (req, res) => {
            res.json({
                minecraft: {
                    connected: this.isConnected,
                    shouldJoin: this.shouldJoin,
                    username: this.minecraftBot?.username || null,
                    server: `${CONFIG.minecraft.host}:${CONFIG.minecraft.port}`,
                    version: CONFIG.minecraft.version,
                    world: this.currentWorld,
                    coordinates: this.currentCoords,
                    reconnectAttempts: this.reconnectAttempts,
                    maxReconnectAttempts: this.maxReconnectAttempts,
                    authRequired: !!(this.authUrl && this.userCode)
                },
                discord: {
                    connected: this.discordClient.readyTimestamp !== null,
                    username: this.discordClient.user?.tag || null,
                    guildCount: this.discordClient.guilds.cache.size
                },
                uptime: process.uptime(),
                memory: process.memoryUsage()
            });
        });

        // Control endpoints
        this.app.post('/connect', async (req, res) => {
            if (this.isConnected) {
                return res.json({ success: false, message: 'Bot already connected' });
            }

            this.shouldJoin = true;
            this.reconnectAttempts = 0;
            await this.connectToMinecraft();

            res.json({ success: true, message: 'Connection initiated' });
        });

        this.app.post('/disconnect', async (req, res) => {
            this.shouldJoin = false;
            this.reconnectAttempts = 0;

            if (this.minecraftBot) {
                this.minecraftBot.quit();
                this.minecraftBot = null;
            }

            await this.updateEmbed();
            res.json({ success: true, message: 'Bot disconnected' });
        });

        // Send chat message endpoint
        this.app.post('/chat', (req, res) => {
            const { message } = req.body;

            if (!this.isConnected || !this.minecraftBot) {
                return res.json({ success: false, message: 'Bot not connected' });
            }

            if (!message || typeof message !== 'string') {
                return res.json({ success: false, message: 'Invalid message' });
            }

            this.minecraftBot.chat(message);
            res.json({ success: true, message: 'Message sent' });
        });

        // Root endpoint with basic info
        this.app.get('/', (req, res) => {
            res.json({
                name: 'Minecraft Discord Bot API',
                version: '1.0.0',
                endpoints: {
                    'GET /': 'This endpoint',
                    'GET /health': 'Health check',
                    'GET /status': 'Detailed bot status',
                    'POST /connect': 'Connect to Minecraft server',
                    'POST /disconnect': 'Disconnect from Minecraft server',
                    'POST /chat': 'Send chat message (requires {message: "text"})'
                },
                minecraft: {
                    server: `${CONFIG.minecraft.host}:${CONFIG.minecraft.port}`,
                    version: CONFIG.minecraft.version,
                    connected: this.isConnected
                }
            });
        });

        // Error handling middleware
        this.app.use((error, req, res, next) => {
            console.error('Web server error:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        });

        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({
                success: false,
                message: 'Endpoint not found',
                availableEndpoints: ['/', '/health', '/status', '/connect', '/disconnect', '/chat']
            });
        });
    }

    setupDiscordEvents() {
        this.discordClient.once('ready', async () => {
            console.log(`Logged in as ${this.discordClient.user.tag}`);
            await this.setupControlMessage();
        });

        this.discordClient.on('messageReactionAdd', async (reaction, user) => {
            if (user.bot) return;
            if (reaction.message.id !== this.controlMessage?.id) return;

            if (reaction.emoji.name === '✅') {
                this.shouldJoin = true;
                this.lastAuthUser = user;
                this.reconnectAttempts = 0;

                const authEmbed = new EmbedBuilder()
                    .setTitle('🔐 Microsoft Authentication Required')
                    .setDescription(`${user}, please authenticate to connect the Minecraft bot.`)
                    .addFields(
                        { name: '🔗 Authentication Link', value: '[Click here to authenticate](https://www.microsoft.com/link)', inline: false },
                        { name: '⏳ Status', value: 'Waiting for authentication code...', inline: false }
                    )
                    .setColor('#ff9900')
                    .setTimestamp();

                this.authMessage = await reaction.message.channel.send({ embeds: [authEmbed] });
                console.log('[DEBUG] Sent auth message to channel');

                setTimeout(() => {
                    if (this.authMessage && !this.isConnected) {
                        console.log('[DEBUG] Force checking for auth code...');
                        this.forceCheckAuthCode();
                    }
                }, 3000);

                await this.connectToMinecraft();

            } else if (reaction.emoji.name === '❌') {
                this.shouldJoin = false;
                this.reconnectAttempts = 0;
                if (this.minecraftBot) {
                    this.minecraftBot.quit();
                    this.minecraftBot = null;
                }
                await this.updateEmbed();
            }

            await reaction.users.remove(user.id);
        });
    }

    async setupControlMessage() {
        const channel = await this.discordClient.channels.fetch(CONFIG.discord.channelId);
        if (!channel) {
            console.error('Control channel not found!');
            return;
        }

        const embed = this.createEmbed();
        this.controlMessage = await channel.send({ embeds: [embed] });

        await this.controlMessage.react('✅');
        await this.controlMessage.react('❌');
    }

    createEmbed() {
        const embed = new EmbedBuilder()
            .setTitle('🎮 Minecraft Bot Controller')
            .setColor(this.isConnected ? '#00ff00' : '#ff0000')
            .addFields(
                { name: '🖥️ Server', value: `${CONFIG.minecraft.host}:${CONFIG.minecraft.port}`, inline: true },
                { name: '📦 Version', value: CONFIG.minecraft.version, inline: true },
                { name: '🔐 Auth', value: CONFIG.minecraft.auth, inline: true },
                { name: '🔗 Status', value: this.getStatusText(), inline: false },
                { name: '🌐 Web Server', value: `Running on port ${CONFIG.webServer.port}`, inline: false }
            );

        if (this.isConnected && this.minecraftBot) {
            embed.addFields(
                { name: '🌍 World', value: this.currentWorld, inline: true },
                { name: '📍 Coordinates', value: `X: ${Math.round(this.currentCoords.x)}, Y: ${Math.round(this.currentCoords.y)}, Z: ${Math.round(this.currentCoords.z)}`, inline: true },
                { name: '👤 Username', value: this.minecraftBot.username || 'Unknown', inline: true }
            );
        }

        if (this.reconnectAttempts > 0 && this.shouldJoin) {
            embed.addFields({
                name: '🔄 Auto-Reconnect',
                value: `Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`,
                inline: false
            });
        }

        embed.setTimestamp()
            .setFooter({ text: '✅ Join Server | ❌ Leave Server' });

        if (this.authUrl && this.userCode) {
            embed.addFields({
                name: '🔑 Microsoft Authentication Required',
                value: `Please visit: [${this.authUrl}](${this.authUrl})\nAnd enter code: \`${this.userCode}\``,
                inline: false
            });
        }

        return embed;
    }

    getStatusText() {
        if (this.authUrl && this.userCode) {
            return '⏳ Waiting for Microsoft authentication...';
        }
        if (this.isConnected && this.minecraftBot) {
            return `✅ Connected as ${this.minecraftBot.username}`;
        }
        if (this.shouldJoin && !this.isConnected) {
            if (this.reconnectAttempts > 0) {
                return `🔄 Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`;
            }
            return '⏳ Connecting...';
        }
        return '❌ Disconnected';
    }

    updatePositionInfo() {
        if (this.minecraftBot && this.minecraftBot.entity) {
            this.currentCoords = {
                x: this.minecraftBot.entity.position.x,
                y: this.minecraftBot.entity.position.y,
                z: this.minecraftBot.entity.position.z
            };
        }
    }

    async attemptReconnect() {
        if (!this.shouldJoin) {
            console.log('[RECONNECT] Reconnection cancelled - shouldJoin is false');
            return;
        }

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log('[RECONNECT] Max reconnection attempts reached');
            this.shouldJoin = false;
            await this.updateEmbed();
            return;
        }

        this.reconnectAttempts++;
        console.log(`[RECONNECT] Attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);

        await this.updateEmbed();

        setTimeout(async () => {
            if (this.shouldJoin && !this.isConnected) {
                await this.connectToMinecraft();
            }
        }, this.reconnectDelay);
    }

    async connectToMinecraft() {
        if (this.minecraftBot) {
            this.minecraftBot.quit();
        }

        try {
            console.log('Attempting to connect to Minecraft server...');
            await this.updateEmbed();

            this.setupConsoleCapture();

            if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
                console.log('Production environment detected - attempting to handle auth differently');
                if (process.env.MC_ACCESS_TOKEN && process.env.MC_REFRESH_TOKEN) {
                    console.log('Using stored authentication tokens for production');
                } else {
                    console.log('No stored authentication tokens found. Bot will need manual authentication.');
                    console.log('Available env vars:', Object.keys(process.env).filter(key => key.startsWith('MC_') || key.includes('TOKEN')));
                }
            }

            this.minecraftBot = mineflayer.createBot({
                host: CONFIG.minecraft.host,
                port: CONFIG.minecraft.port,
                version: CONFIG.minecraft.version,
                auth: CONFIG.minecraft.auth
            });

            this.setupMinecraftEvents();

            this.authCheckTimeout = setTimeout(() => {
                if (!this.authMessageSent && !this.isConnected) {
                    console.log('[DEBUG] No authentication message detected after 5 seconds - checking connection status');
                    if (this.isConnected) {
                        console.log('[DEBUG] Bot connected without authentication prompt - using cached login');
                    } else {
                        console.log('[DEBUG] Bot still not connected - may need manual authentication');
                    }
                }
            }, 5000);

        } catch (error) {
            console.error('Failed to connect to Minecraft:', error);
            if (this.shouldJoin) {
                console.log('[RECONNECT] Connection failed, attempting reconnect...');
                await this.attemptReconnect();
            } else {
                await this.updateEmbed();
            }
        }
    }

    setupConsoleCapture() {
        console.log('[DEBUG] Setting up console capture...');

        if (!this.originalConsoleLog) {
            this.originalConsoleLog = console.log;
            console.log = (...args) => {
                const message = args.join(' ');
                this.originalConsoleLog('[DEBUG] Console message:', message);

                if (message.includes('microsoft.com/link') && message.includes('use the code')) {
                    this.originalConsoleLog('[DEBUG] FOUND AUTH IN CONSOLE.LOG!');
                    this.extractAuthDetails(message);
                }

                this.originalConsoleLog.apply(console, args);
            };
        }

        if (!this.originalStderrWrite) {
            this.originalStderrWrite = process.stderr.write;
            process.stderr.write = (chunk, encoding, callback) => {
                const message = chunk.toString();

                if (message.includes('microsoft.com/link') && message.includes('use the code')) {
                    console.log('[DEBUG] FOUND AUTH IN STDERR!');
                    this.extractAuthDetails(message);
                }

                return this.originalStderrWrite.call(process.stderr, chunk, encoding, callback);
            };
        }

        if (!this.originalStdoutWrite) {
            this.originalStdoutWrite = process.stdout.write;
            process.stdout.write = (chunk, encoding, callback) => {
                const message = chunk.toString();

                if (message.includes('microsoft.com/link') && message.includes('use the code')) {
                    console.log('[DEBUG] FOUND AUTH IN STDOUT!');
                    this.extractAuthDetails(message);
                }

                return this.originalStdoutWrite.call(process.stdout, chunk, encoding, callback);
            };
        }

        this.authCheckInterval = setInterval(() => {
            if (this.lastAuthUser && this.authMessage && !this.isConnected) {
                console.log('[DEBUG] Manual check - looking for recent auth code in logs...');
            }
        }, 1000);
    }

    async forceCheckAuthCode() {
        console.log('[DEBUG] forceCheckAuthCode called but disabled to prevent edits');
        return;
    }

    setupMinecraftEvents() {
        this.minecraftBot.on('login', async () => {
            console.log('Successfully logged into Minecraft server!');
            this.isConnected = true;
            this.authUrl = null;
            this.userCode = null;
            this.authMessageSent = false;
            this.reconnectAttempts = 0;

            if (this.minecraftBot.game && this.minecraftBot.game.dimension) {
                this.currentWorld = this.minecraftBot.game.dimension;
            }

            if (this.authCheckTimeout) {
                clearTimeout(this.authCheckTimeout);
            }
            if (this.authCheckInterval) {
                clearInterval(this.authCheckInterval);
                this.authCheckInterval = null;
            }

            if (this.authMessage) {
                try {
                    await this.authMessage.delete();
                    console.log('[DEBUG] Deleted auth message after successful login');
                    this.authMessage = null;
                } catch (error) {
                    console.error('[DEBUG] Failed to delete auth message:', error);
                }
            }

            await this.updateEmbed();
        });

        this.minecraftBot.on('spawn', async () => {
            console.log('Bot spawned in game');

            this.updatePositionInfo();

            if (this.minecraftBot.game && this.minecraftBot.game.dimension) {
                this.currentWorld = this.minecraftBot.game.dimension;
            }

            setTimeout(() => {
                this.minecraftBot.chat('/afk 10');
                console.log('Executed /afk 10');
            }, 5000);

            await this.updateEmbed();
        });

        this.minecraftBot.on('move', () => {
            this.updatePositionInfo();
        });

        this.minecraftBot.on('respawn', () => {
            if (this.minecraftBot.game && this.minecraftBot.game.dimension) {
                this.currentWorld = this.minecraftBot.game.dimension;
                console.log('Bot respawned/changed dimension to:', this.currentWorld);
                this.updateEmbed();
            }
        });

        this.minecraftBot.on('end', async (reason) => {
            console.log('Minecraft connection ended:', reason);
            this.isConnected = false;
            this.minecraftBot = null;
            this.currentWorld = 'Unknown';
            this.currentCoords = { x: 0, y: 0, z: 0 };

            await this.updateEmbed();

            if (this.shouldJoin) {
                console.log('[RECONNECT] Connection ended, attempting reconnect...');
                await this.attemptReconnect();
            }
        });

        this.minecraftBot.on('error', async (error) => {
            console.error('Minecraft bot error:', error);
            this.isConnected = false;
            this.currentWorld = 'Unknown';
            this.currentCoords = { x: 0, y: 0, z: 0 };

            await this.updateEmbed();

            if (this.shouldJoin) {
                console.log('[RECONNECT] Error occurred, attempting reconnect...');
                await this.attemptReconnect();
            }
        });

        this.minecraftBot.on('kicked', async (reason) => {
            console.log('Bot was kicked:', reason);
            this.isConnected = false;
            this.minecraftBot = null;
            this.currentWorld = 'Unknown';
            this.currentCoords = { x: 0, y: 0, z: 0 };

            await this.updateEmbed();

            if (this.shouldJoin) {
                console.log('[RECONNECT] Bot kicked, attempting reconnect...');
                await this.attemptReconnect();
            }
        });

        this.minecraftBot.on('auth_pending', (data) => {
            console.log('Microsoft auth pending:', data);
            this.authUrl = data.verification_uri;
            this.userCode = data.user_code;
            this.updateEmbed();
        });
    }

    async extractAuthDetails(message) {
        const codeMatch = message.match(/code ([A-Z0-9]+)/);

        if (codeMatch && this.lastAuthUser && this.authMessage) {
            const authCode = codeMatch[1];
            console.log('[DEBUG] Found auth code:', authCode, 'updating message');

            const updatedEmbed = new EmbedBuilder()
                .setTitle('🔐 Microsoft Authentication Required')
                .setDescription(`${this.lastAuthUser}, please authenticate to connect the Minecraft bot.`)
                .addFields(
                    { name: '🔗 Authentication Link', value: '[Click here to authenticate](https://www.microsoft.com/link)', inline: false },
                    { name: '🔑 Authentication Code', value: `**${authCode}**`, inline: false },
                    { name: '📝 Instructions', value: '1. Click the link above\n2. Enter the code\n3. Complete authentication', inline: false }
                )
                .setColor('#00ff00')
                .setTimestamp();

            try {
                await this.authMessage.edit({ embeds: [updatedEmbed] });
                console.log('[DEBUG] Successfully updated auth message with code:', authCode);
            } catch (error) {
                console.error('[DEBUG] Failed to update auth message:', error);
                try {
                    const channel = await this.discordClient.channels.fetch(CONFIG.discord.channelId);
                    await channel.send({
                        content: `${this.lastAuthUser} - Authentication code: **${authCode}**\nUse: https://www.microsoft.com/link`
                    });
                } catch (channelError) {
                    console.error('[DEBUG] Failed to send new message too:', channelError);
                }
            }
        } else {
            console.log('[DEBUG] Missing requirements:', { 
                hasCodeMatch: !!codeMatch, 
                hasUser: !!this.lastAuthUser, 
                hasAuthMessage: !!this.authMessage 
            });
        }
    }

    async updateEmbed() {
        if (!this.controlMessage) return;

        try {
            const embed = this.createEmbed();
            await this.controlMessage.edit({ embeds: [embed] });
        } catch (error) {
            console.error('Failed to update embed:', error);
        }
    }

    // Graceful shutdown method
    async shutdown() {
        console.log('Shutting down services...');

        // Clear intervals
        if (this.statusUpdateInterval) {
            clearInterval(this.statusUpdateInterval);
        }
        if (this.authCheckInterval) {
            clearInterval(this.authCheckInterval);
        }

        // Close Minecraft connection
        if (this.minecraftBot) {
            this.minecraftBot.quit();
        }

        // Close Discord connection
        if (this.discordClient) {
            this.discordClient.destroy();
        }

        // Close web server
        if (this.server) {
            return new Promise((resolve) => {
                this.server.close(() => {
                    console.log('Web server closed');
                    resolve();
                });
            });
        }
    }
}

// Start the bot
const bot = new MinecraftDiscordBot();
bot.start().then(() => {
    console.log('All services started successfully!');
}).catch((error) => {
    console.error('Failed to start services:', error);
    process.exit(1);
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    try {
        await bot.shutdown();
        console.log('Shutdown complete');
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
    gracefulShutdown('unhandledRejection');
});