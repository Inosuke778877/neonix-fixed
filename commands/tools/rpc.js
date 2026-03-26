import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Config file path
const CONFIG_PATH = path.join(__dirname, '..', '..', 'database');
const CONFIG_FILE = path.join(CONFIG_PATH, 'rpcConfig.json');

// Default config
const defaultConfig = {
    enabled: false,
    type: null,
    name: null,
    imageUrl: null
};

// Valid activity types
const VALID_TYPES = ['PLAYING', 'STREAMING', 'LISTENING', 'WATCHING'];

// Activity type mapping
const ACTIVITY_TYPES = {
    'PLAYING': 0,
    'STREAMING': 1,
    'LISTENING': 2,
    'WATCHING': 3
};

// Ensure config directory exists
if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(CONFIG_PATH, { recursive: true });
}

// Load config
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Error loading RPC config:', error);
    }
    return { ...defaultConfig };
}

// Save config
function saveConfig(config) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (error) {
        console.error('Error saving RPC config:', error);
    }
}

// Set Rich Presence
async function setRichPresence(client, config) {
    try {
        if (!config.enabled || !config.type || !config.name) {
            await client.user.setActivity(null);
            console.log('[RPC] Cleared');
            return;
        }

        const activity = {
            name: config.name,
            type: ACTIVITY_TYPES[config.type],
            url: config.type === 'STREAMING' ? 'https://twitch.tv/discord' : undefined
        };

        if (config.imageUrl) {
            activity.assets = {
                large_image: config.imageUrl,
                large_text: config.name
            };
        }

        await client.user.setActivity(activity);
        console.log(`[RPC] Started: ${config.type} ${config.name}`);
    } catch (error) {
        console.error('[RPC] Error setting presence:', error);
        throw error;
    }
}

export default {
    name: 'rpc',
    aliases: ['status', 'presence'],
    category: 'utility',
    description: 'Configure Rich Presence status',
    usage: 'rpc <on/off/type> [text] [imageURL]',
    
    async execute(message, args, client) {
        const config = loadConfig();

        // Show usage if no args
        if (args.length === 0) {
            let response = '```js\n';
            response += '  Commands:\n';
            response += '    rpc on/off\n';
            response += '    rpc <TYPE> <text> <imageURL>\n\n';
            response += '  Types:\n';
            response += '    PLAYING\n';
            response += '    STREAMING\n';
            response += '    LISTENING\n';
            response += '    WATCHING\n\n';
            response += '  Examples:\n';
            response += '    rpc PLAYING Minecraft\n';
            response += '    rpc STREAMING Coding https://i.imgur.com/abc.png\n';
            response += '    rpc on\n';
            response += '    rpc off\n';
            response += '\n╰──────────────────────────────────╯\n```';
            await message.channel.send(response);
            return;
        }

        const subCommand = args[0].toUpperCase();

        try {
            // Handle on/off commands
            if (subCommand === 'ON' || subCommand === 'OFF') {
                config.enabled = subCommand === 'ON';
                saveConfig(config);
                await setRichPresence(client, config);
                
                let response = '```js\n';
                response += `  Status: ${config.enabled ? 'Enabled ✅' : 'Disabled ❌'}\n`;
                if (config.enabled && config.name) {
                    response += `  Type: ${config.type}\n`;
                    response += `  Text: ${config.name}\n`;
                }
                response += '\n╰──────────────────────────────────╯\n```';
                
                await message.channel.send(response);
                return;
            }

            // Handle status setting
            if (!VALID_TYPES.includes(subCommand)) {
                await message.channel.send('``````');
                return;
            }

            if (args.length < 2) {
                await message.channel.send('```js\nStatus text cannot be empty.\n```');
                return;
            }

            // Check if last argument is a URL (image)
            const lastArg = args[args.length - 1];
            const isUrl = /^https?:\/\/.+\.(png|jpg|jpeg|gif|webp)$/i.test(lastArg);
            
            let name, imageUrl;
            
            if (isUrl) {
                imageUrl = lastArg;
                name = args.slice(1, -1).join(' ');
            } else {
                name = args.slice(1).join(' ');
                imageUrl = null;
            }

            if (!name) {
                await message.channel.send('```js\nStatus text cannot be empty.\n```');
                return;
            }

            // Update config
            config.type = subCommand;
            config.name = name;
            config.imageUrl = imageUrl;
            config.enabled = true;

            // Save and apply
            saveConfig(config);
            await setRichPresence(client, config);

            let response = '```js\n';
            response += `  Type: ${config.type}\n`;
            response += `  Text: ${config.name}\n`;
            response += `  Image: ${config.imageUrl || 'None'}\n`;
            response += '  Status: Enabled ✅\n';
            response += '\n╰──────────────────────────────────╯\n```';
            
            await message.channel.send(response);
        } catch (error) {
            console.error('[RPC] Command error:', error);
            await message.channel.send('``````');
        }
    }
};

// Export initialize function for use in index.js
export async function initializeRPC(client) {
    console.log('[RPC] Initializing Rich Presence system...');
    try {
        const config = loadConfig();
        await setRichPresence(client, config);
    } catch (error) {
        console.error('[RPC] Failed to initialize:', error);
    }
}
