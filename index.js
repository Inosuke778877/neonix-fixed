import 'dotenv/config';
import { Client } from 'discord.js-selfbot-v13';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { loadDatabase, saveDatabase } from './functions/database.js';
import Lavalink from './functions/lavalink.js';
import queueManager from './functions/queue.js';
import { pendingCloneOperations } from './commands/tools/clone.js';
import { initializeRPC } from './commands/tools/rpc.js';
import { initializeCloners } from './commands/tools/msgclone.js';
import { initializeAutoReact } from './commands/tools/autoreact.js';
import { initializeWelcome } from './commands/tools/welcome.js';
import { initializeAutoMod } from './commands/tools/automod.js';
import { initializeGiveaways } from './commands/tools/giveaway.js';
import { initializeAI } from './commands/ai/chat.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new Client({
  checkUpdate: false
});

// Initialize Lavalink
const lavalink = new Lavalink({
  restHost: process.env.LAVALINK_REST,
  wsHost: process.env.LAVALINK_WS,
  password: process.env.LAVALINK_PASSWORD,
  clientName: process.env.CLIENT_NAME || 'NeonixSelfbot',
});

// Voice states storage
const voiceStates = {};

// Initialize collections
client.commands = new Map();
client.aliases = new Map();
client.cooldowns = new Map();
client.deletedMessages = new Map();

// Attach lavalink, queue, and voiceStates to client
client.lavalink = lavalink;
client.queueManager = queueManager;
client.voiceStates = voiceStates;

// Load database
client.db = loadDatabase();

// Initialize no-prefix mode if not exists
if (client.db.noPrefixMode === undefined) {
  client.db.noPrefixMode = false;
  saveDatabase(client.db);
}

// Load all commands from categories
const categoriesPath = path.join(__dirname, 'commands');
const categories = fs.readdirSync(categoriesPath).filter(file => {
  return fs.statSync(path.join(categoriesPath, file)).isDirectory();
});

console.log('╭─────────────────────────╮');
console.log('│  Loading Commands...    │');
console.log('╰─────────────────────────╯\n');

for (const category of categories) {
  const commandsPath = path.join(categoriesPath, category);
  const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
  
  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = await import(`file://${filePath}`);
    const cmd = command.default;
    
    if (cmd.name) {
      client.commands.set(cmd.name, cmd);
      console.log(`✓ Loaded: ${cmd.name} (${category})`);
      
      // Register aliases
      if (cmd.aliases && Array.isArray(cmd.aliases)) {
        cmd.aliases.forEach(alias => {
          client.aliases.set(alias, cmd.name);
        });
      }
    }
  }
}

console.log(`\n✓ Loaded ${client.commands.size} files\n`);

// Store deleted messages for snipe command
client.on('messageDelete', message => {
  if (!message || !message.channel || message.partial || !message.content) return;
  
  const channelId = message.channel.id;
  client.deletedMessages.set(channelId, {
    content: message.content,
    author: message.author.tag,
    authorId: message.author.id,
    timestamp: Date.now()
  });
  
  // Clear after 60 seconds
  setTimeout(() => {
    client.deletedMessages.delete(channelId);
  }, 60000);
});

// Voice state handling for Lavalink
client.ws.on('VOICE_STATE_UPDATE', (packet) => {
  if (packet.user_id !== client.user.id) return;
  
  const guildId = packet.guild_id;
  if (!voiceStates[guildId]) voiceStates[guildId] = {};
  voiceStates[guildId].sessionId = packet.session_id;
  voiceStates[guildId].channelId = packet.channel_id; // Required for DAVE protocol
  console.log(`[Voice] State update for guild ${guildId}`);
});

client.ws.on('VOICE_SERVER_UPDATE', (packet) => {
  const guildId = packet.guild_id;
  if (!voiceStates[guildId]) voiceStates[guildId] = {};
  voiceStates[guildId].token = packet.token;
  voiceStates[guildId].endpoint = packet.endpoint;
  console.log(`[Voice] Server update for guild ${guildId}`);
});

// Lavalink event handlers
lavalink.on('ready', () => {
  console.log('[Lavalink] Session established');
});

lavalink.on('event', async (evt) => {
  console.log(`[Lavalink Event] Type: ${evt.type}, Guild: ${evt.guildId}`);

  if (evt.type === 'TrackEndEvent') {
    // 'replaced' means skip/stop was called manually — don't auto-advance
    if (evt.reason === 'replaced') return;

    if (evt.reason === 'finished' || evt.reason === 'loadFailed') {
      const queue = queueManager.get(evt.guildId);
      if (!queue) return;

      const nextSong = queueManager.getNext(evt.guildId);

      if (!nextSong) {
        await lavalink.destroyPlayer(evt.guildId).catch(() => {});
        queueManager.delete(evt.guildId);
        if (queue.textChannel) {
          queue.textChannel.send([
            '```',
            '╭─[ QUEUE ENDED ]─╮\n',
            '  📭 No more songs in queue.',
            '\n╰──────────────────────────────────╯',
            '```',
          ].join('\n')).catch(() => {});
        }
        return;
      }

      const voiceState = voiceStates[evt.guildId];
      if (!voiceState?.token || !voiceState?.sessionId || !voiceState?.endpoint || !voiceState?.channelId) {
        console.error('[Auto-play] Voice state missing for guild', evt.guildId);
        return;
      }

      queue.nowPlaying = nextSong;
      queue.paused = false;

      try {
        await lavalink.updatePlayer(evt.guildId, nextSong, voiceState, {
          volume: queue.volume,
          filters: queue.filters,
        });

        if (queue.textChannel) {
          queue.textChannel.send([
            '```',
            '╭─[ NOW PLAYING ]─╮\n',
            `  🎵 ${nextSong.info.title}`,
            `  👤 ${nextSong.info.author}`,
            `  ⏱️ ${formatDuration(nextSong.info.length)}`,
            '\n╰──────────────────────────────────╯',
            '```',
          ].join('\n')).catch(() => {});
        }
      } catch (err) {
        console.error('[Auto-play Error]:', err);
        if (queue.textChannel) {
          queue.textChannel.send(`\`\`\`\n❌ Auto-play error: ${err.message}\n\`\`\``).catch(() => {});
        }
      }
    }
  }

  if (evt.type === 'TrackStuckEvent') {
    console.warn(`[Lavalink] Track stuck in guild ${evt.guildId}, skipping...`);
    const queue = queueManager.get(evt.guildId);
    if (!queue) return;
    const nextSong = queueManager.getNext(evt.guildId);
    if (!nextSong) {
      await lavalink.destroyPlayer(evt.guildId).catch(() => {});
      queueManager.delete(evt.guildId);
      return;
    }
    const voiceState = voiceStates[evt.guildId];
    if (!voiceState?.channelId) return;
    queue.nowPlaying = nextSong;
    await lavalink.updatePlayer(evt.guildId, nextSong, voiceState, { volume: queue.volume, filters: queue.filters }).catch(() => {});
  }

  if (evt.type === 'WebSocketClosedEvent') {
    console.warn(`[Lavalink] WS closed for guild ${evt.guildId} code=${evt.code}`);
  }
});

// Helper function to load allowed users from allowedUsers.json
function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function loadAllowedUsers() {
  try {
    const allowedUsersPath = path.join(__dirname, 'database', 'allowedUsers.json');
    if (fs.existsSync(allowedUsersPath)) {
      const data = JSON.parse(fs.readFileSync(allowedUsersPath, 'utf8'));
      return data.allowedUsers || [];
    }
  } catch (error) {
    console.error('[Allowed Users] Error loading:', error);
  }
  return [];
}

// Helper function to check if user is allowed
function isAllowedUser(userId) {
  // Owner always allowed
  if (userId === process.env.OWNER_ID) return true;
  
  // Check allowedUsers.json
  const allowedUsers = loadAllowedUsers();
  return allowedUsers.includes(userId);
}

// Ready event
client.on('ready', async () => {
  console.log('╭─────────────────────────╮');
  console.log('│   Selfbot Connected!    │');
  console.log('╰─────────────────────────╯');
  console.log(`Username: ${client.user.username}`);
  console.log(`User ID: ${client.user.id}`);
  console.log(`Prefix: ${process.env.PREFIX}`);
  console.log(`Owner ID: ${process.env.OWNER_ID}`);
  
  // Load and display allowed users count
  const allowedUsers = loadAllowedUsers();
  console.log(`Allowed Users: ${allowedUsers.length}`);
  
  console.log(`No-Prefix Mode: ${client.db.noPrefixMode ? 'Enabled' : 'Disabled'}`);
  console.log('─────────────────────────\n');
  
  // Connect to Lavalink
  lavalink.connect(client.user.id);
  
  // Initialize all systems
  await initializeRPC(client);
  await initializeCloners(client);
  await initializeAutoReact(client);
  await initializeWelcome(client);
  await initializeAutoMod(client);
  await initializeGiveaways(client);
  await initializeAI(client);
});

// Message handler
client.on('messageCreate', async (message) => {
  // Check if user is allowed (owner or in allowedUsers.json)
  if (!isAllowedUser(message.author.id)) return;
  
  // Handle clone confirmations FIRST
  if (pendingCloneOperations.has(message.author.id)) {
    const operation = pendingCloneOperations.get(message.author.id);
    
    if (operation.channelId !== message.channel.id) return;
    
    const response = message.content.toLowerCase().trim();
    
    if (operation.step === 'confirmProceed') {
      if (response === 'y' || response === 'yes') {
        operation.step = 'confirmEmojis';
        pendingCloneOperations.set(message.author.id, operation);
        await message.channel.send('``````');
        
        if ((message.author.id === process.env.OWNER_ID || message.author.id === client.user.id) && message.deletable) {
          await message.delete().catch(() => {});
        }
        return;
      } else if (response === 'n' || response === 'no') {
        pendingCloneOperations.delete(message.author.id);
        await message.channel.send('``````');
        
        if ((message.author.id === process.env.OWNER_ID || message.author.id === client.user.id) && message.deletable) {
          await message.delete().catch(() => {});
        }
        return;
      }
    } else if (operation.step === 'confirmEmojis') {
      if (response === 'y' || response === 'yes' || response === 'n' || response === 'no') {
        const cloneEmojis = (response === 'y' || response === 'yes');
        pendingCloneOperations.delete(message.author.id);
        
        if ((message.author.id === process.env.OWNER_ID || message.author.id === client.user.id) && message.deletable) {
          await message.delete().catch(() => {});
        }
        
        const cloneCommand = client.commands.get('clone');
        await cloneCommand.executeClone(
          client,
          message.channel,
          operation.sourceGuildId,
          operation.targetGuildId,
          cloneEmojis
        );
        return;
      }
    }
  }
  
  const prefix = process.env.PREFIX;
  const noPrefixMode = client.db.noPrefixMode;
  let content = message.content;
  let hasPrefix = content.startsWith(prefix);
  
  // Check for nop command (always with prefix)
  if (hasPrefix && content.slice(prefix.length).trim().toLowerCase().startsWith('nop')) {
    const args = content.slice(prefix.length).trim().split(/ +/);
    const command = client.commands.get('nop');
    
    if (command) {
      try {
        if ((message.author.id === process.env.OWNER_ID || message.author.id === client.user.id) && message.deletable) {
          await message.delete().catch(() => {});
        }
        await command.execute(message, args.slice(1), client);
      } catch (error) {
        console.error(`Error executing nop command:`, error);
      }
      return;
    }
  }
  
  // Determine if we should process the command
  let shouldProcess = false;
  let commandArgs = [];
  
  if (noPrefixMode) {
    shouldProcess = true;
    commandArgs = content.trim().split(/ +/);
  } else if (hasPrefix) {
    shouldProcess = true;
    commandArgs = content.slice(prefix.length).trim().split(/ +/);
  }
  
  if (!shouldProcess || commandArgs.length === 0) return;
  
  const commandName = commandArgs[0].toLowerCase();
  const args = commandArgs.slice(1);
  
  const command = client.commands.get(commandName) ||
                  client.commands.get(client.aliases.get(commandName));
  
  if (!command) return;
  
  // Delete command message if owner or selfbot user
  if ((message.author.id === process.env.OWNER_ID || message.author.id === client.user.id) && message.deletable) {
    await message.delete().catch(() => {});
  }
  
  try {
    await command.execute(message, args, client);
  } catch (error) {
    console.error(`Error executing ${commandName}:`, error);
    message.channel.send(`\`\`\`js\n❌ Error: ${error.message}\n\`\`\``).catch(() => {});
  }
});

// Error handling
client.on('error', (error) => {
  console.error('Client error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

// ── Dashboard (port 3000) ─────────────────────────────────────────────────────
import { loadConfig as loadRpcConfig, saveConfig as saveRpcConfig, setRichPresence } from './commands/tools/rpc.js';

const startTime = new Date();

function getUptime() {
  const s = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}h ${String(m).padStart(2,'0')}m ${String(sec).padStart(2,'0')}s`;
}

function readBody(req) {
  return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
}

function parseForm(body) {
  const o = {};
  for (const p of body.split('&')) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    const k = decodeURIComponent(p.slice(0, i));
    const v = decodeURIComponent(p.slice(i + 1).replace(/\+/g, ' '));
    o[k] = v;
  }
  return o;
}

function isCdn(u) {
  try { return new URL(u).hostname === 'cdn.discordapp.com'; } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────────────────────
const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080809;--surface:#0f0f11;--surface2:#161619;--border:#1f1f24;--border2:#2a2a30;
  --accent:#7289da;--accent-dim:#5b6eae;--accent-glow:#7289da30;
  --green:#3ba55d;--green-dim:#2d7d46;--red:#ed4245;--yellow:#faa61a;
  --text:#e3e3e8;--text2:#9d9daa;--text3:#5c5c6e;
  --radius:10px;--radius-lg:14px;--sidebar:240px;
  --font:'Inter',system-ui,-apple-system,sans-serif;
}
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
html{height:100%;scroll-behavior:smooth}
body{min-height:100%;background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
code{font-family:'JetBrains Mono',monospace;font-size:.8rem;background:var(--surface2);padding:2px 6px;border-radius:4px;color:var(--accent)}

/* ── Layout ── */
.app{display:flex;min-height:100vh}

/* ── Sidebar ── */
.sidebar{
  width:var(--sidebar);flex-shrink:0;background:var(--surface);
  border-right:1px solid var(--border);display:flex;flex-direction:column;
  position:fixed;top:0;left:0;height:100vh;z-index:200;
  transition:transform .25s cubic-bezier(.4,0,.2,1);overflow-y:auto;overflow-x:hidden;
}
.sidebar-brand{padding:22px 20px 18px;border-bottom:1px solid var(--border);flex-shrink:0}
.brand-logo{display:flex;align-items:center;gap:10px}
.brand-icon{width:34px;height:34px;background:var(--accent);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0}
.brand-name{font-size:1rem;font-weight:700;color:#fff;letter-spacing:-.01em}
.brand-sub{font-size:.7rem;color:var(--text3);margin-top:1px}
.nav-section{padding:12px 0 4px}
.nav-label{font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);padding:0 16px 6px}
.nav-item{
  display:flex;align-items:center;gap:10px;padding:9px 16px;margin:1px 8px;
  border-radius:var(--radius);font-size:.85rem;font-weight:500;color:var(--text2);
  transition:all .15s;cursor:pointer;border:none;background:none;width:calc(100% - 16px);text-align:left;
}
.nav-item:hover{color:var(--text);background:var(--surface2)}
.nav-item.active{color:var(--accent);background:var(--accent-glow);font-weight:600}
.nav-item svg{width:16px;height:16px;flex-shrink:0;opacity:.8}
.nav-item.active svg{opacity:1}
.sidebar-footer{margin-top:auto;padding:14px 16px;border-top:1px solid var(--border);flex-shrink:0}
.online-pill{display:flex;align-items:center;gap:8px;background:var(--surface2);border-radius:var(--radius);padding:8px 12px}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0;position:relative}
.pulse::after{content:'';position:absolute;inset:-3px;border-radius:50%;background:var(--green);opacity:.3;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{transform:scale(1);opacity:.3}50%{transform:scale(1.5);opacity:0}}
.online-text{font-size:.75rem;font-weight:600;color:var(--green)}
.online-name{font-size:.72rem;color:var(--text3);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── Mobile topbar ── */
.topbar{
  display:none;position:fixed;top:0;left:0;right:0;height:56px;z-index:150;
  background:var(--surface);border-bottom:1px solid var(--border);
  align-items:center;padding:0 16px;gap:12px;
}
.topbar-title{font-weight:600;font-size:.95rem;flex:1}
.menu-btn{width:36px;height:36px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0}
.overlay{display:none;position:fixed;inset:0;background:#00000080;z-index:190;backdrop-filter:blur(2px)}

/* ── Main ── */
.main{margin-left:var(--sidebar);flex:1;display:flex;flex-direction:column;min-height:100vh;max-width:100%}
.content{flex:1;padding:32px 36px;max-width:960px;width:100%}

/* ── Page header ── */
.page-header{margin-bottom:28px}
.page-title{font-size:1.4rem;font-weight:700;color:#fff;letter-spacing:-.02em}
.page-sub{font-size:.82rem;color:var(--text3);margin-top:4px}

/* ── Stats grid ── */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:24px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:18px 16px;transition:.2s}
.stat-card:hover{border-color:var(--border2)}
.stat-icon{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:.9rem;margin-bottom:12px}
.stat-icon.blue{background:#7289da20}
.stat-icon.green{background:#3ba55d20}
.stat-icon.purple{background:#9b59b620}
.stat-icon.yellow{background:#faa61a20}
.stat-icon.red{background:#ed424520}
.stat-icon.teal{background:#1abc9c20}
.stat-val{font-size:1.5rem;font-weight:700;color:#fff;line-height:1;margin-bottom:4px}
.stat-val.accent{color:var(--accent)}
.stat-val.green{color:var(--green)}
.stat-lbl{font-size:.72rem;font-weight:500;text-transform:uppercase;letter-spacing:.08em;color:var(--text3)}

/* ── Cards ── */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);margin-bottom:16px;overflow:hidden}
.card-head{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px}
.card-head-left{display:flex;align-items:center;gap:10px}
.card-icon{width:28px;height:28px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:.8rem;flex-shrink:0}
.card-title{font-size:.82rem;font-weight:600;color:var(--text);letter-spacing:.01em}
.card-body{padding:20px}
.card-body.no-pad{padding:0}
.card-footer{padding:14px 20px;border-top:1px solid var(--border);display:flex;align-items:center;gap:10px}

/* ── Forms ── */
.form-group{margin-bottom:14px}
.form-group:last-child{margin-bottom:0}
.label{display:block;font-size:.75rem;font-weight:600;color:var(--text2);margin-bottom:6px;letter-spacing:.01em}
.hint{font-size:.7rem;color:var(--text3);margin-top:4px}
input[type=text],input[type=url],input[type=number],select,textarea{
  width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:var(--radius);
  padding:9px 12px;color:var(--text);font-size:.85rem;font-family:var(--font);
  outline:none;transition:border-color .15s,box-shadow .15s;-webkit-appearance:none;
}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}
input::placeholder,textarea::placeholder{color:var(--text3)}
select{cursor:pointer;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%235c5c6e' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;padding-right:32px}
select option{background:var(--surface2)}
textarea{resize:vertical;min-height:100px;line-height:1.5}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}

/* ── Toggle switch ── */
.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border)}
.toggle-row:last-child{border-bottom:none;padding-bottom:0}
.toggle-row:first-child{padding-top:0}
.toggle-info{flex:1;min-width:0;margin-right:16px}
.toggle-label{font-size:.875rem;font-weight:500;color:var(--text)}
.toggle-desc{font-size:.75rem;color:var(--text3);margin-top:2px}
.switch{position:relative;width:42px;height:23px;flex-shrink:0}
.switch input{opacity:0;width:0;height:0;position:absolute}
.switch-track{position:absolute;inset:0;background:var(--border2);border-radius:23px;cursor:pointer;transition:.2s}
.switch-track::before{content:'';position:absolute;width:17px;height:17px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 3px #0006}
input:checked + .switch-track{background:var(--accent)}
input:checked + .switch-track::before{transform:translateX(19px)}

/* ── Buttons ── */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:9px 18px;border-radius:var(--radius);font-size:.82rem;font-weight:600;cursor:pointer;border:none;transition:all .15s;white-space:nowrap;font-family:var(--font)}
.btn svg{width:14px;height:14px}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent-dim);transform:translateY(-1px);box-shadow:0 4px 12px var(--accent-glow)}
.btn-primary:active{transform:none}
.btn-danger{background:var(--red);color:#fff}
.btn-danger:hover{background:#c93535;transform:translateY(-1px)}
.btn-ghost{background:transparent;border:1px solid var(--border2);color:var(--text2)}
.btn-ghost:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-glow)}
.btn-success{background:var(--green);color:#fff}
.btn-success:hover{background:var(--green-dim)}
.btn-sm{padding:7px 13px;font-size:.78rem}

/* ── Badges ── */
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:5px;font-size:.7rem;font-weight:600;letter-spacing:.02em}
.badge-green{background:#3ba55d20;color:var(--green)}
.badge-red{background:#ed424520;color:var(--red)}
.badge-blue{background:#7289da20;color:var(--accent)}
.badge-yellow{background:#faa61a20;color:var(--yellow)}
.badge-gray{background:var(--surface2);color:var(--text2)}

/* ── Table ── */
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:.82rem;min-width:400px}
th{padding:10px 16px;color:var(--text3);font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid var(--border);text-align:left;white-space:nowrap}
td{padding:12px 16px;border-bottom:1px solid var(--border);color:var(--text);vertical-align:middle}
tr:last-child td{border-bottom:none}
tbody tr{transition:.1s}
tbody tr:hover td{background:#ffffff04}

/* ── Alert ── */
.alert{padding:12px 16px;border-radius:var(--radius);font-size:.82rem;margin-bottom:16px;display:flex;align-items:center;gap:10px;border:1px solid transparent}
.alert-success{background:#3ba55d15;border-color:#3ba55d30;color:var(--green)}
.alert-error{background:#ed424515;border-color:#ed424530;color:var(--red)}
.alert-info{background:var(--accent-glow);border-color:#7289da30;color:var(--accent)}

/* ── Info row (overview list) ── */
.info-list{display:flex;flex-direction:column}
.info-row{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--border);gap:12px}
.info-row:last-child{border-bottom:none;padding-bottom:0}
.info-row:first-child{padding-top:0}
.info-key{font-size:.8rem;color:var(--text3);font-weight:500;flex-shrink:0}
.info-val{font-size:.82rem;color:var(--text);font-weight:500;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65%}

/* ── RPC preview ── */
.rpc-preview{background:var(--surface2);border:1px solid var(--border2);border-radius:var(--radius);padding:14px;display:flex;gap:14px;align-items:flex-start}
.rpc-img{width:70px;height:70px;border-radius:8px;object-fit:cover;flex-shrink:0;background:var(--border);display:flex;align-items:center;justify-content:center;font-size:1.8rem;overflow:hidden}
.rpc-img img{width:100%;height:100%;object-fit:cover;border-radius:8px}
.rpc-name{font-weight:700;font-size:.95rem;color:#fff}
.rpc-details{font-size:.8rem;color:var(--text2);margin-top:2px}
.rpc-state{font-size:.8rem;color:var(--text2);margin-top:1px}
.rpc-type{font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);margin-bottom:6px}
.rpc-btn-row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.rpc-btn-pill{font-size:.72rem;padding:5px 12px;border:1px solid var(--border2);border-radius:5px;color:var(--text2);background:var(--surface);cursor:default}

/* ── Section divider ── */
.section-divider{height:1px;background:var(--border);margin:20px 0}
.section-label{font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);margin-bottom:12px}

/* ── Command tag ── */
.cmd-tag{font-family:'JetBrains Mono',monospace;font-size:.78rem;color:var(--accent);background:#7289da12;padding:3px 8px;border-radius:4px;white-space:nowrap}
.alias-tag{font-size:.72rem;color:var(--text3)}

/* ── Responsive ── */
@media (max-width:900px){
  .grid-3{grid-template-columns:1fr 1fr}
  .content{padding:24px 20px}
}
@media (max-width:680px){
  .sidebar{transform:translateX(-100%)}
  .sidebar.open{transform:translateX(0)}
  .overlay.open{display:block}
  .topbar{display:flex}
  .main{margin-left:0}
  .content{padding:72px 16px 24px}
  .stats-grid{grid-template-columns:repeat(2,1fr)}
  .grid-2,.grid-3{grid-template-columns:1fr}
  .page-title{font-size:1.15rem}
  .rpc-preview{flex-direction:column;align-items:center;text-align:center}
  .rpc-img{width:56px;height:56px}
  .info-val{max-width:55%}
  table{font-size:.78rem}
  th,td{padding:9px 10px}
}
@media (max-width:380px){
  .stats-grid{grid-template-columns:1fr}
  .btn{padding:8px 14px;font-size:.78rem}
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Shared layout
// ─────────────────────────────────────────────────────────────────────────────
function icon(d, extra = '') {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
}

const NAV = [
  { id: 'overview', href: '/',        label: 'Overview',       i: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>' },
  { id: 'rpc',      href: '/rpc',     label: 'Rich Presence',  i: '<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>' },
  { id: 'ai',       href: '/ai',      label: 'AI Chat',        i: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
  { id: 'commands', href: '/commands',label: 'Commands',       i: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>' },
  { id: 'settings', href: '/settings',label: 'Settings',       i: '<circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>' },
];

function layout(activePage, title, content, flash = '') {
  const username = client.user?.username ?? 'Connecting...';
  const navHtml = NAV.map(n => `
    <a href="${n.href}" class="nav-item${activePage === n.id ? ' active' : ''}">
      ${icon(n.i)} ${n.label}
    </a>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="theme-color" content="#0f0f11"/>
<title>${title} — Neonix</title>
<style>${CSS}</style>
</head>
<body>
<div class="app">

  <!-- Mobile topbar -->
  <div class="topbar">
    <button class="menu-btn" onclick="toggleMenu()" aria-label="Menu">
      ${icon('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>')}
    </button>
    <span class="topbar-title">✦ Neonix</span>
  </div>

  <!-- Overlay -->
  <div class="overlay" id="overlay" onclick="toggleMenu()"></div>

  <!-- Sidebar -->
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-brand">
      <div class="brand-logo">
        <div class="brand-icon">✦</div>
        <div><div class="brand-name">Neonix</div><div class="brand-sub">Selfbot Dashboard</div></div>
      </div>
    </div>
    <div class="nav-section">
      <div class="nav-label">Navigation</div>
      ${navHtml}
    </div>
    <div class="sidebar-footer">
      <div class="online-pill">
        <div class="pulse"></div>
        <div>
          <div class="online-text">Online</div>
          <div class="online-name">${username}</div>
        </div>
      </div>
    </div>
  </aside>

  <!-- Main content -->
  <div class="main">
    <div class="content">
      ${flash}
      ${content}
    </div>
  </div>

</div>
<script>
function toggleMenu(){
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('overlay').classList.toggle('open');
}
// Close sidebar on nav click (mobile)
document.querySelectorAll('.nav-item').forEach(el=>{
  el.addEventListener('click',()=>{
    if(window.innerWidth<=680){
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('overlay').classList.remove('open');
    }
  });
});
// Auto-dismiss flash
setTimeout(()=>{
  const a=document.querySelector('.alert');
  if(a){a.style.transition='opacity .4s';a.style.opacity='0';setTimeout(()=>a.remove(),400);}
},3000);
</script>
</body>
</html>`;
}

function alert(type, msg) {
  if (!msg) return '';
  const icons = { success: '<circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/>', error: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>', info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' };
  return `<div class="alert alert-${type}">${icon(icons[type] || icons.info, 'width="16" height="16"')} ${msg}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page: Overview
// ─────────────────────────────────────────────────────────────────────────────
function pageOverview() {
  const u = client.user;
  const rpc = loadRpcConfig();
  const aiCfgPath = path.join(__dirname, 'database', 'ai_config.json');
  let aiEnabled = 0;
  try { const d = JSON.parse(fs.readFileSync(aiCfgPath,'utf8')); aiEnabled = Object.values(d).filter(c=>c.enabled).length; } catch {}

  const stats = [
    { icon: '👤', cls: 'blue',   val: u?.username ?? '—',         lbl: 'Account',    accent: true },
    { icon: '🌐', cls: 'purple', val: client.guilds?.cache?.size ?? 0, lbl: 'Servers' },
    { icon: '⚡', cls: 'green',  val: client.commands?.size ?? 0,  lbl: 'Commands',   green: true },
    { icon: '⏱️', cls: 'yellow', val: getUptime(),                  lbl: 'Uptime',     green: true },
    { icon: '🤖', cls: 'teal',   val: aiEnabled,                   lbl: 'AI Guilds' },
    { icon: '🎮', cls: 'red',    val: rpc.enabled ? 'Active' : 'Off', lbl: 'RPC', green: rpc.enabled },
  ];

  const statsHtml = stats.map(s => `
    <div class="stat-card">
      <div class="stat-icon ${s.cls}">${s.icon}</div>
      <div class="stat-val${s.accent ? ' accent' : s.green ? ' green' : ''}">${s.val}</div>
      <div class="stat-lbl">${s.lbl}</div>
    </div>`).join('');

  const allowedUsersPath = path.join(__dirname, 'database', 'allowedUsers.json');
  let allowedCount = 0;
  try { allowedCount = JSON.parse(fs.readFileSync(allowedUsersPath,'utf8')).allowedUsers?.length ?? 0; } catch {}

  const infoRows = [
    ['User ID',        u?.id ?? '—'],
    ['Prefix',         process.env.PREFIX || '!'],
    ['Owner ID',       process.env.OWNER_ID || '—'],
    ['Allowed Users',  allowedCount],
    ['No-Prefix Mode', client.db?.noPrefixMode ? '✅ On' : '❌ Off'],
    ['Lavalink',       process.env.LAVALINK_REST || 'Not set'],
    ['AI Providers',   [process.env.GROQ_API_KEY?'Groq':'',process.env.HUGGINGFACE_API_KEY?'HF':'',process.env.NVIDIA_NIM_API_KEY?'NIM':''].filter(Boolean).join(', ')||'None configured'],
  ];

  const rpcSummary = rpc.enabled && rpc.name
    ? `<span class="badge badge-green">● ${rpc.type} — ${rpc.name}</span>`
    : `<span class="badge badge-gray">Disabled</span>`;

  const html = `
<div class="page-header">
  <div class="page-title">Overview</div>
  <div class="page-sub">Live status for your Neonix selfbot instance</div>
</div>

<div class="stats-grid">${statsHtml}</div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
  <div class="card">
    <div class="card-head">
      <div class="card-head-left">
        <div class="card-icon" style="background:#7289da20">⚙️</div>
        <span class="card-title">Bot Info</span>
      </div>
    </div>
    <div class="card-body">
      <div class="info-list">
        ${infoRows.map(([k,v])=>`<div class="info-row"><span class="info-key">${k}</span><span class="info-val">${v}</span></div>`).join('')}
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <div class="card-head-left">
        <div class="card-icon" style="background:#3ba55d20">📡</div>
        <span class="card-title">System Status</span>
      </div>
    </div>
    <div class="card-body">
      <div class="info-list">
        <div class="info-row"><span class="info-key">Discord</span><span class="badge badge-green">● Connected</span></div>
        <div class="info-row"><span class="info-key">Rich Presence</span>${rpcSummary}</div>
        <div class="info-row"><span class="info-key">Dashboard</span><span class="badge badge-green">● Port 3000</span></div>
        <div class="info-row"><span class="info-key">Node.js</span><span class="info-val">${process.version}</span></div>
        <div class="info-row"><span class="info-key">Platform</span><span class="info-val">${process.platform}</span></div>
        <div class="info-row"><span class="info-key">Memory</span><span class="info-val">${Math.round(process.memoryUsage().heapUsed/1024/1024)}MB used</span></div>
        <div class="info-row"><span class="info-key">PID</span><span class="info-val">${process.pid}</span></div>
      </div>
    </div>
  </div>
</div>`;

  return layout('overview', 'Overview', html);
}

// ─────────────────────────────────────────────────────────────────────────────
// Page: Rich Presence
// ─────────────────────────────────────────────────────────────────────────────
function pageRPC(flash = '') {
  const cfg = loadRpcConfig();
  const types = ['PLAYING','STREAMING','LISTENING','WATCHING','COMPETING'];

  const previewImg = cfg.imageUrl
    ? `<img src="${cfg.imageUrl}" alt="large image" onerror="this.style.display='none'">`
    : '🎮';

  const preview = `
<div class="rpc-preview">
  <div class="rpc-img">${previewImg}</div>
  <div>
    <div class="rpc-type">${cfg.type || 'PLAYING'}</div>
    <div class="rpc-name">${cfg.name || 'Activity Name'}</div>
    ${cfg.details ? `<div class="rpc-details">${cfg.details}</div>` : ''}
    ${cfg.state   ? `<div class="rpc-state">${cfg.state}</div>` : ''}
    ${(cfg.button1Label || cfg.button2Label) ? `<div class="rpc-btn-row">
      ${cfg.button1Label ? `<div class="rpc-btn-pill">${cfg.button1Label}</div>` : ''}
      ${cfg.button2Label ? `<div class="rpc-btn-pill">${cfg.button2Label}</div>` : ''}
    </div>` : ''}
  </div>
</div>`;

  const html = `
<div class="page-header">
  <div class="page-title">Rich Presence</div>
  <div class="page-sub">Configure your Discord activity. Only <code>cdn.discordapp.com</code> image links are accepted.</div>
</div>

<div class="card">
  <div class="card-head">
    <div class="card-head-left">
      <div class="card-icon" style="background:#7289da20">👁️</div>
      <span class="card-title">Preview</span>
    </div>
    <span class="badge ${cfg.enabled ? 'badge-green' : 'badge-gray'}">${cfg.enabled ? '● Active' : 'Disabled'}</span>
  </div>
  <div class="card-body">${preview}</div>
</div>

<form method="POST" action="/rpc">
  <div class="card">
    <div class="card-head">
      <div class="card-head-left">
        <div class="card-icon" style="background:#3ba55d20">⚡</div>
        <span class="card-title">Activity</span>
      </div>
    </div>
    <div class="card-body">
      <div class="toggle-row" style="margin-bottom:18px;border:none;padding:0">
        <div class="toggle-info">
          <div class="toggle-label">Enable Rich Presence</div>
          <div class="toggle-desc">Show activity status on your Discord profile</div>
        </div>
        <label class="switch">
          <input type="checkbox" name="enabled" value="1" ${cfg.enabled ? 'checked' : ''}>
          <span class="switch-track"></span>
        </label>
      </div>
      <div class="section-divider"></div>
      <div class="grid-2" style="margin-top:16px">
        <div class="form-group">
          <label class="label">Activity Type</label>
          <select name="type">
            ${types.map(t=>`<option value="${t}" ${cfg.type===t?'selected':''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="label">Activity Name *</label>
          <input type="text" name="name" value="${cfg.name||''}" placeholder="e.g. Minecraft" required/>
        </div>
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label class="label">Details (line 2)</label>
          <input type="text" name="details" value="${cfg.details||''}" placeholder="e.g. Survival Mode"/>
        </div>
        <div class="form-group">
          <label class="label">State (line 3)</label>
          <input type="text" name="state" value="${cfg.state||''}" placeholder="e.g. In a game"/>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <div class="card-head-left">
        <div class="card-icon" style="background:#9b59b620">🖼️</div>
        <span class="card-title">Images</span>
      </div>
      <span class="badge badge-yellow">cdn.discordapp.com only</span>
    </div>
    <div class="card-body">
      <div class="grid-2">
        <div class="form-group">
          <label class="label">Large Image URL</label>
          <input type="url" name="imageUrl" value="${cfg.imageUrl||''}" placeholder="https://cdn.discordapp.com/..."/>
          <div class="hint">Must be from cdn.discordapp.com</div>
        </div>
        <div class="form-group">
          <label class="label">Large Image Tooltip</label>
          <input type="text" name="imageText" value="${cfg.imageText||''}" placeholder="Hover text"/>
        </div>
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label class="label">Small Image URL</label>
          <input type="url" name="smallImageUrl" value="${cfg.smallImageUrl||''}" placeholder="https://cdn.discordapp.com/..."/>
        </div>
        <div class="form-group">
          <label class="label">Small Image Tooltip</label>
          <input type="text" name="smallImageText" value="${cfg.smallImageText||''}" placeholder="Hover text"/>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <div class="card-head-left">
        <div class="card-icon" style="background:#faa61a20">🔘</div>
        <span class="card-title">Buttons <span style="font-weight:400;color:var(--text3)">(optional)</span></span>
      </div>
    </div>
    <div class="card-body">
      <div class="grid-2">
        <div class="form-group">
          <label class="label">Button 1 Label</label>
          <input type="text" name="button1Label" value="${cfg.button1Label||''}" placeholder="Visit Website"/>
        </div>
        <div class="form-group">
          <label class="label">Button 1 URL</label>
          <input type="url" name="button1Url" value="${cfg.button1Url||''}" placeholder="https://..."/>
        </div>
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label class="label">Button 2 Label</label>
          <input type="text" name="button2Label" value="${cfg.button2Label||''}" placeholder="Source Code"/>
        </div>
        <div class="form-group">
          <label class="label">Button 2 URL</label>
          <input type="url" name="button2Url" value="${cfg.button2Url||''}" placeholder="https://..."/>
        </div>
      </div>
    </div>
  </div>

  <div style="display:flex;gap:10px;flex-wrap:wrap">
    <button type="submit" class="btn btn-primary">
      ${icon('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>', 'width="14" height="14"')}
      Save &amp; Apply
    </button>
    <a href="/rpc/clear" class="btn btn-ghost btn-sm">Clear Activity</a>
  </div>
</form>`;

  return layout('rpc', 'Rich Presence', html, alert('success', flash));
}

// ─────────────────────────────────────────────────────────────────────────────
// Page: AI
// ─────────────────────────────────────────────────────────────────────────────
function pageAI(flash = '') {
  const aiCfgPath = path.join(__dirname, 'database', 'ai_config.json');
  let aiCfg = {};
  try { aiCfg = JSON.parse(fs.readFileSync(aiCfgPath, 'utf8')); } catch {}

  const personalityPath = path.join(__dirname, 'database', 'personality.txt');
  let personality = '';
  try { personality = fs.readFileSync(personalityPath, 'utf8'); } catch {}

  const PROVIDERS = { groq: 'Groq', huggingface: 'HuggingFace', nim: 'NVIDIA NIM' };

  const guildRows = Object.entries(aiCfg).map(([gId, cfg]) => `
    <tr>
      <td><code>${gId}</code></td>
      <td><span class="badge ${cfg.enabled ? 'badge-green' : 'badge-red'}">${cfg.enabled ? 'On' : 'Off'}</span></td>
      <td>${PROVIDERS[cfg.provider] || cfg.provider || 'Groq'}</td>
      <td>${cfg.channels?.length ?? 0}</td>
      <td><span class="badge badge-blue">${cfg.respondToAll ? 'Everyone' : 'Owner'}</span></td>
    </tr>`).join('')
    || `<tr><td colspan="5" style="text-align:center;color:var(--text3);padding:24px">No guilds configured. Use <code>ai on</code> in a Discord server first.</td></tr>`;

  const keyStatus = (k, label) => {
    const set = !!process.env[k];
    return `<div class="info-row"><span class="info-key">${label}</span><span class="badge ${set ? 'badge-green' : 'badge-gray'}">${set ? '● Set' : 'Not set'}</span></div>`;
  };

  const html = `
<div class="page-header">
  <div class="page-title">AI Chat</div>
  <div class="page-sub">Manage AI personality and view guild configurations</div>
</div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
  <div class="card" style="margin-bottom:0">
    <div class="card-head">
      <div class="card-head-left">
        <div class="card-icon" style="background:#3ba55d20">🔑</div>
        <span class="card-title">API Keys</span>
      </div>
    </div>
    <div class="card-body">
      <div class="info-list">
        ${keyStatus('GROQ_API_KEY', 'Groq')}
        ${keyStatus('HUGGINGFACE_API_KEY', 'HuggingFace')}
        ${keyStatus('NVIDIA_NIM_API_KEY', 'NVIDIA NIM')}
      </div>
      <div class="hint" style="margin-top:12px">Set keys in your <code>.env</code> file</div>
    </div>
  </div>

  <div class="card" style="margin-bottom:0">
    <div class="card-head">
      <div class="card-head-left">
        <div class="card-icon" style="background:#7289da20">📊</div>
        <span class="card-title">Stats</span>
      </div>
    </div>
    <div class="card-body">
      <div class="info-list">
        <div class="info-row"><span class="info-key">Total Guilds</span><span class="info-val">${Object.keys(aiCfg).length}</span></div>
        <div class="info-row"><span class="info-key">Enabled</span><span class="info-val">${Object.values(aiCfg).filter(c=>c.enabled).length}</span></div>
        <div class="info-row"><span class="info-key">Providers in use</span><span class="info-val">${[...new Set(Object.values(aiCfg).map(c=>PROVIDERS[c.provider]||'Groq'))].join(', ')||'—'}</span></div>
      </div>
    </div>
  </div>
</div>

<form method="POST" action="/ai">
  <div class="card">
    <div class="card-head">
      <div class="card-head-left">
        <div class="card-icon" style="background:#9b59b620">✏️</div>
        <span class="card-title">Personality / System Prompt</span>
      </div>
    </div>
    <div class="card-body">
      <div class="form-group">
        <label class="label">System Prompt</label>
        <textarea name="personality" rows="7" placeholder="You are a helpful assistant...">${personality.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
        <div class="hint">This is sent as the system message to all AI providers</div>
      </div>
    </div>
    <div class="card-footer">
      <button type="submit" class="btn btn-primary btn-sm">
        ${icon('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/>', 'width="14" height="14"')}
        Save Personality
      </button>
    </div>
  </div>
</form>

<div class="card">
  <div class="card-head">
    <div class="card-head-left">
      <div class="card-icon" style="background:#faa61a20">🌐</div>
      <span class="card-title">Guild Configurations</span>
    </div>
  </div>
  <div class="card-body no-pad">
    <div class="table-wrap">
      <table>
        <thead><tr><th>Guild ID</th><th>Status</th><th>Provider</th><th>Channels</th><th>Scope</th></tr></thead>
        <tbody>${guildRows}</tbody>
      </table>
    </div>
  </div>
  <div class="card-footer">
    <span style="font-size:.75rem;color:var(--text3)">Use <code>ai provider &lt;groq/hf/nim&gt;</code> in Discord to change per-guild provider</span>
  </div>
</div>`;

  return layout('ai', 'AI Chat', html, alert('success', flash));
}

// ─────────────────────────────────────────────────────────────────────────────
// Page: Commands
// ─────────────────────────────────────────────────────────────────────────────
function pageCommands() {
  const categories = new Map();
  for (const [, cmd] of (client.commands ?? new Map())) {
    const cat = cmd.category || 'misc';
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat).push(cmd);
  }

  const catIcons = { music:'🎵', ai:'🤖', fun:'🎉', fun2:'🎪', moderation:'🔨', tools:'🔧', utility:'⚙️', misc:'📦' };

  const sections = [...categories.entries()].map(([cat, cmds]) => {
    const rows = cmds.map(c => `
      <tr>
        <td><span class="cmd-tag">${process.env.PREFIX||'!'}${c.name}</span></td>
        <td class="alias-tag">${c.aliases?.join(', ') || '—'}</td>
        <td style="color:var(--text2)">${c.description || '—'}</td>
        <td><code style="font-size:.72rem">${c.usage || c.name}</code></td>
      </tr>`).join('');

    return `
      <div class="card">
        <div class="card-head">
          <div class="card-head-left">
            <div class="card-icon" style="background:var(--surface2)">${catIcons[cat]||'📦'}</div>
            <span class="card-title">${cat.charAt(0).toUpperCase()+cat.slice(1)} <span style="color:var(--text3);font-weight:400">(${cmds.length})</span></span>
          </div>
        </div>
        <div class="card-body no-pad">
          <div class="table-wrap">
            <table>
              <thead><tr><th>Command</th><th>Aliases</th><th>Description</th><th>Usage</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>`;
  }).join('');

  const html = `
<div class="page-header">
  <div class="page-title">Commands</div>
  <div class="page-sub">${client.commands?.size ?? 0} commands loaded across ${categories.size} categories</div>
</div>
${sections || '<div class="alert alert-info">No commands loaded yet.</div>'}`;

  return layout('commands', 'Commands', html);
}

// ─────────────────────────────────────────────────────────────────────────────
// Page: Settings
// ─────────────────────────────────────────────────────────────────────────────
function pageSettings(flash = '') {
  const allowedPath = path.join(__dirname, 'database', 'allowedUsers.json');
  let allowed = [];
  try { allowed = JSON.parse(fs.readFileSync(allowedPath, 'utf8')).allowedUsers || []; } catch {}

  const userRows = allowed.length
    ? allowed.map((uid, i) => `<tr><td>${i + 1}</td><td><code>${uid}</code></td><td><a href="/settings/removeuser?id=${uid}" class="btn btn-danger btn-sm">Remove</a></td></tr>`).join('')
    : `<tr><td colspan="3" style="text-align:center;color:var(--text3);padding:20px">No allowed users added yet</td></tr>`;

  const html = `
<div class="page-header">
  <div class="page-title">Settings</div>
  <div class="page-sub">Manage allowed users and bot settings</div>
</div>

<div class="card">
  <div class="card-head">
    <div class="card-head-left">
      <div class="card-icon" style="background:#3ba55d20">👥</div>
      <span class="card-title">Allowed Users</span>
    </div>
    <span class="badge badge-blue">${allowed.length} users</span>
  </div>
  <div class="card-body no-pad">
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>User ID</th><th>Action</th></tr></thead>
        <tbody>${userRows}</tbody>
      </table>
    </div>
  </div>
  <div class="card-footer">
    <form method="POST" action="/settings/adduser" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;width:100%">
      <input type="text" name="userId" placeholder="Discord User ID" style="flex:1;min-width:180px"/>
      <button type="submit" class="btn btn-primary btn-sm">Add User</button>
    </form>
  </div>
</div>

<div class="card">
  <div class="card-head">
    <div class="card-head-left">
      <div class="card-icon" style="background:#7289da20">⚙️</div>
      <span class="card-title">Bot Settings</span>
    </div>
  </div>
  <div class="card-body">
    <div class="info-list">
      <div class="info-row">
        <div>
          <div class="toggle-label">No-Prefix Mode</div>
          <div class="toggle-desc">Commands work without prefix</div>
        </div>
        <span class="badge ${client.db?.noPrefixMode ? 'badge-green' : 'badge-gray'}">${client.db?.noPrefixMode ? '● Enabled' : 'Disabled'}</span>
      </div>
      <div class="info-row">
        <span class="info-key">Current Prefix</span>
        <code>${process.env.PREFIX || '!'}</code>
      </div>
      <div class="info-row">
        <span class="info-key">Owner ID</span>
        <code>${process.env.OWNER_ID || 'Not set'}</code>
      </div>
    </div>
    <div class="hint" style="margin-top:14px">Prefix and owner are configured via <code>.env</code> file</div>
  </div>
</div>`;

  return layout('settings', 'Settings', html, alert('success', flash));
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const rawUrl  = req.url || '/';
  const url     = rawUrl.split('?')[0];
  const qs      = Object.fromEntries(new URLSearchParams(rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : ''));
  const method  = req.method;

  const send = (html, code = 200) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); };
  const redirect = (loc) => { res.writeHead(302, { Location: loc }); res.end(); };

  // POST /rpc
  if (method === 'POST' && url === '/rpc') {
    const form = parseForm(await readBody(req));
    const cfg = loadRpcConfig();
    cfg.enabled        = form.enabled === '1';
    cfg.type           = form.type || 'PLAYING';
    cfg.name           = form.name?.trim() || null;
    cfg.details        = form.details?.trim() || null;
    cfg.state          = form.state?.trim() || null;
    cfg.imageText      = form.imageText?.trim() || null;
    cfg.smallImageText = form.smallImageText?.trim() || null;
    cfg.button1Label   = form.button1Label?.trim() || null;
    cfg.button1Url     = form.button1Url?.trim() || null;
    cfg.button2Label   = form.button2Label?.trim() || null;
    cfg.button2Url     = form.button2Url?.trim() || null;
    cfg.imageUrl       = isCdn(form.imageUrl?.trim()) ? form.imageUrl.trim() : null;
    cfg.smallImageUrl  = isCdn(form.smallImageUrl?.trim()) ? form.smallImageUrl.trim() : null;
    saveRpcConfig(cfg);
    try { await setRichPresence(client, cfg); } catch {}
    return send(pageRPC('RPC settings saved and applied ✓'));
  }

  // GET /rpc/clear
  if (method === 'GET' && url === '/rpc/clear') {
    const cfg = loadRpcConfig();
    cfg.enabled = false;
    saveRpcConfig(cfg);
    try { await setRichPresence(client, cfg); } catch {}
    return redirect('/rpc');
  }

  // POST /ai
  if (method === 'POST' && url === '/ai') {
    const form = parseForm(await readBody(req));
    const personalityPath = path.join(__dirname, 'database', 'personality.txt');
    if (form.personality !== undefined) fs.writeFileSync(personalityPath, form.personality);
    return send(pageAI('Personality saved ✓'));
  }

  // POST /settings/adduser
  if (method === 'POST' && url === '/settings/adduser') {
    const form = parseForm(await readBody(req));
    const uid = form.userId?.trim();
    if (uid && /^\d{17,20}$/.test(uid)) {
      const p = path.join(__dirname, 'database', 'allowedUsers.json');
      let d = { allowedUsers: [] };
      try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
      if (!d.allowedUsers.includes(uid)) { d.allowedUsers.push(uid); fs.writeFileSync(p, JSON.stringify(d, null, 2)); }
      return send(pageSettings('User added ✓'));
    }
    return send(pageSettings('Invalid user ID — must be 17-20 digits'));
  }

  // GET /settings/removeuser
  if (method === 'GET' && url === '/settings/removeuser') {
    const uid = qs.id?.trim();
    if (uid) {
      const p = path.join(__dirname, 'database', 'allowedUsers.json');
      let d = { allowedUsers: [] };
      try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
      d.allowedUsers = d.allowedUsers.filter(u => u !== uid);
      fs.writeFileSync(p, JSON.stringify(d, null, 2));
    }
    return redirect('/settings');
  }

  // GET routes
  const GET = {
    '/':         () => send(pageOverview()),
    '/rpc':      () => send(pageRPC()),
    '/ai':       () => send(pageAI()),
    '/commands': () => send(pageCommands()),
    '/settings': () => send(pageSettings()),
  };

  if (GET[url]) GET[url]();
  else redirect('/');

}).listen(3000, () => {
  console.log('[Dashboard] http://localhost:3000');
});

// Login
client.login(process.env.TOKEN).catch((error) => {
  console.error('Failed to login:', error);
  process.exit(1);
});
