import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.join(__dirname, '..', '..', 'database');
const CONFIG_FILE = path.join(CONFIG_PATH, 'rpcConfig.json');

const defaultConfig = { enabled: false, type: null, name: null, imageUrl: null };

const VALID_TYPES = ['PLAYING', 'STREAMING', 'LISTENING', 'WATCHING'];
const ACTIVITY_TYPES = { PLAYING: 0, STREAMING: 1, LISTENING: 2, WATCHING: 3 };

if (!fs.existsSync(CONFIG_PATH)) fs.mkdirSync(CONFIG_PATH, { recursive: true });

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) { console.error('[RPC] Error loading config:', e); }
  return { ...defaultConfig };
}

function saveConfig(config) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }
  catch (e) { console.error('[RPC] Error saving config:', e); }
}

// Detects any http/https URL regardless of extension or query string
function isImageUrl(str) {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

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
      url: config.type === 'STREAMING' ? 'https://twitch.tv/discord' : undefined,
    };

    if (config.imageUrl) {
      // Use mp: prefix so Discord accepts external image URLs in RPC
      activity.assets = {
        large_image: `mp:${config.imageUrl}`,
        large_text: config.name,
      };
    }

    await client.user.setActivity(activity);
    console.log(`[RPC] Set: ${config.type} "${config.name}"${config.imageUrl ? ' (with image)' : ''}`);
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
  usage: 'rpc <on/off/TYPE> [text] [imageURL]',

  async execute(message, args, client) {
    const config = loadConfig();

    if (args.length === 0) {
      return message.channel.send([
        '```',
        '╭─[ RPC CONFIG ]─╮\n',
        '  rpc on/off',
        '  rpc <TYPE> <text> [imageURL]\n',
        '  Types: PLAYING, STREAMING, LISTENING, WATCHING\n',
        '  Examples:',
        '    rpc PLAYING Minecraft',
        '    rpc WATCHING Netflix https://i.imgur.com/abc.png',
        '    rpc STREAMING Coding https://cdn.discordapp.com/attachments/xyz/img.png?ex=abc',
        '\n╰──────────────────────────────────╯',
        '```',
      ].join('\n'));
    }

    const subCommand = args[0].toUpperCase();

    try {
      // ── on/off ──
      if (subCommand === 'ON' || subCommand === 'OFF') {
        config.enabled = subCommand === 'ON';
        saveConfig(config);
        await setRichPresence(client, config);

        return message.channel.send([
          '```',
          '╭─[ RPC STATUS ]─╮\n',
          `  Status: ${config.enabled ? 'Enabled ✅' : 'Disabled ❌'}`,
          ...(config.enabled && config.name
            ? [`  Type: ${config.type}`, `  Text: ${config.name}`]
            : []),
          '\n╰──────────────────────────────────╯',
          '```',
        ].join('\n'));
      }

      // ── type + text [+ imageURL] ──
      if (!VALID_TYPES.includes(subCommand)) {
        return message.channel.send(
          `\`\`\`\n❌ Invalid type. Use: ${VALID_TYPES.join(', ')}\n\`\`\``
        );
      }

      if (args.length < 2) {
        return message.channel.send('```\n❌ Status text cannot be empty.\n```');
      }

      // Check if the last arg is any valid http/https URL (no extension required)
      const lastArg = args[args.length - 1];
      const hasImage = isImageUrl(lastArg);

      const imageUrl = hasImage ? lastArg : null;
      const name = hasImage ? args.slice(1, -1).join(' ') : args.slice(1).join(' ');

      if (!name) {
        return message.channel.send('```\n❌ Status text cannot be empty.\n```');
      }

      config.type = subCommand;
      config.name = name;
      config.imageUrl = imageUrl;
      config.enabled = true;

      saveConfig(config);
      await setRichPresence(client, config);

      return message.channel.send([
        '```',
        '╭─[ RPC UPDATED ]─╮\n',
        `  Type:   ${config.type}`,
        `  Text:   ${config.name}`,
        `  Image:  ${config.imageUrl ?? 'None'}`,
        '  Status: Enabled ✅',
        '\n╰──────────────────────────────────╯',
        '```',
      ].join('\n'));
    } catch (error) {
      console.error('[RPC] Command error:', error);
      await message.channel.send(`\`\`\`\n❌ RPC Error: ${error.message}\n\`\`\``);
    }
  },
};

export async function initializeRPC(client) {
  console.log('[RPC] Initializing Rich Presence...');
  try {
    const config = loadConfig();
    await setRichPresence(client, config);
  } catch (error) {
    console.error('[RPC] Failed to initialize:', error);
  }
}
