import express from 'express';
import WebSocket from 'ws';
import winston from 'winston';
import 'winston-daily-rotate-file';
import * as fs from 'fs';
import * as path from 'path';
import { Rcon } from 'rcon-client';

const VERSION = '1.0.0';

// ========================================
// Configuration
// ========================================

function loadConfig() {
  const configPath = path.join(process.cwd(), 'TakaroConfig.txt');
  if (!fs.existsSync(configPath)) {
    console.error('ERROR: TakaroConfig.txt not found!');
    console.error('Please copy TakaroConfig.txt.example to TakaroConfig.txt and fill in your settings.');
    process.exit(1);
  }
  const content = fs.readFileSync(configPath, 'utf-8');
  content.split('\n').forEach(line => {
    line = line.trim();
    if (line && !line.startsWith('#')) {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        const key = line.substring(0, eqIdx).trim();
        const value = line.substring(eqIdx + 1).trim();
        if (key) process.env[key] = value;
      }
    }
  });
}
loadConfig();

// ========================================
// Logger
// ========================================

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const logFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
);

const logger = winston.createLogger({
  level: 'info',
  format: logFormat,
  transports: [
    new winston.transports.Console({ format: logFormat }),
    new (winston.transports as any).DailyRotateFile({
      dirname: logsDir,
      filename: 'takaro-bridge-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: 20,
      format: logFormat
    })
  ]
});

// ========================================
// Constants
// ========================================

const TAKARO_WS_URL = 'wss://connect.takaro.io/';
const IDENTITY_TOKEN = process.env.IDENTITY_TOKEN || '';
const REGISTRATION_TOKEN = process.env.REGISTRATION_TOKEN || '';
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3535', 10);
const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = parseInt(process.env.RCON_PORT || '19000', 10);
const RCON_PASSWORD = process.env.RCON_PASSWORD || '';
const PLAYER_POLL_INTERVAL = parseInt(process.env.PLAYER_POLL_INTERVAL || '5000', 10);

// Ban permission list index (2 = blacklist in most Soulmask configs)
// Run "lsp" in RCON to check your server's permission list indices
const BAN_PERMISSION_TYPE = parseInt(process.env.BAN_PERMISSION_TYPE || '2', 10);

// Path to the Soulmask server log file for chat monitoring
const LOG_FILE_PATH = process.env.LOG_FILE_PATH || '';

// ========================================
// State
// ========================================

let takaroWs: WebSocket | null = null;
let isConnectedToTakaro = false;
let rconClient: Rcon | null = null;
let isConnectedToRcon = false;
let playerPollTimer: NodeJS.Timeout | null = null;

interface SoulmaskPlayer {
  gameId: string;
  name: string;
  steamId: string;
  x: number;
  y: number;
  z: number;
}

let knownPlayers = new Map<string, SoulmaskPlayer>();
let logFilePosition = 0;
let logWatchTimer: NodeJS.Timeout | null = null;

let reconnectTimeout: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 60000;
const BASE_RECONNECT_DELAY = 3000;

let rconReconnectTimeout: NodeJS.Timeout | null = null;
let rconReconnectAttempts = 0;
const MAX_RCON_RECONNECT_ATTEMPTS = 100;
const RCON_RECONNECT_DELAY = 5000;

const metrics = {
  requestsReceived: 0,
  responsesSent: 0,
  eventsSent: 0,
  errors: 0,
  startTime: Date.now()
};

// ========================================
// Player Parsing
// ========================================

/**
 * Parse the response from List_OnlinePlayers (lp) command.
 *
 * Soulmask returns a pipe-delimited table:
 *   |              Account |                       PlayerName |  PawnID |  Position |
 *   | 76561198000000000    |                       PlayerName |  123456 |  X=123.4 Y=567.8 Z=91.0 |
 */
function parsePlayers(output: string): SoulmaskPlayer[] {
  const players: SoulmaskPlayer[] = [];
  const lines = output.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('|')) continue;

    const cols = line.split('|').map(c => c.trim()).filter(c => c.length > 0);
    if (cols.length < 2) continue;

    // Skip the header row
    if (cols[0].toLowerCase() === 'account') continue;

    const steamId = cols[0];
    const name = cols[1];

    // Steam IDs are 17-digit numbers
    if (!steamId.match(/^\d{15,20}$/) || !name) continue;

    // Parse position from column 3 (index 3) if present
    // UE4 format: "X=123.4 Y=567.8 Z=91.0" or "(X=123.4,Y=567.8,Z=91.0)"
    let x = 0, y = 0, z = 0;
    const posCol = cols[3] || '';
    const xm = posCol.match(/X=([+-]?[\d.]+)/i);
    const ym = posCol.match(/Y=([+-]?[\d.]+)/i);
    const zm = posCol.match(/Z=([+-]?[\d.]+)/i);
    if (xm) x = Math.round(parseFloat(xm[1]));
    if (ym) y = Math.round(parseFloat(ym[1]));
    if (zm) z = Math.round(parseFloat(zm[1]));

    players.push({ gameId: steamId, name, steamId, x, y, z });
  }

  return players;
}

// ========================================
// Help Text
// ========================================

function getSoulmaskCommandHelp(): string {
  return `Soulmask RCON Command Reference
================================

BackupDatabase (bk) [InNewDBName]
  Writes the world save to a file using the given file name. Run SaveWorld 0 first.

BackupDatabaseByHour (bkh)
  Writes the world save using the current date and time as a file name.

ClearAllNpc (can)
  Remove all non-player-owned NPCs from the world. They will respawn shortly.

CreateItemForPlayer (citem) <InOpPlayer> <ItemClass> <Nums> <Quality>
  Create an item in the inventory of the player specified by Steam ID.
  Quality: 0-5

CreateSpecifiedMan (cnpc) <InPlayer> <CreateNo> <Sex>
  Spawns a preconfigured NPC in front of the specified player.

CreateSWByClass (create) <SelectedPlayerAccount> <CreatureClass> <IsBaby> <DengJi> <Num> <PinZhi>
  Spawn an NPC/mount in front of the player. IsBaby: 0=adult, 1=baby.

DeleteItem (del) <InOpPlayer> <InItemClass> <InCount>
  Deletes items from a player's inventory.

Disconnect (q/dc/quit)
  Disconnect from the server.

DrawActorImage (dai) <ActorType>
  Outputs an image to WS/Saved showing locations of a specific actor type.

Dump_AllActorPositions (dap)
  Dumps actor positions to WS/Saved/ACTOR_POSI_DATA.log.

ExecScriptCommands (run) <ScriptFileName>
  Run all commands listed in a text file saved in WS/Saved.

FlyMode (fly) <InPlayer> <nMode>
  Sets ghost/fly mode for player. 1=enable, 0=disable.

GotoPostion (go) <InOpPlayer> <InX> <InY> <InZ>
  Teleport the player to the specified location.

GotoTarget (gonpc) <InOpPlayer> <InTarget>
  Teleport the player to a target character (by Steam ID or pawn UID).

IncGameSeconds <Slice>
  Increases server uptime counter by the specified number of seconds.

List_AllItemClass (lai) <SubName>
  Get a list of item classes matching the given full or partial name.

List_AllNPCClass (lcc) <NameSubStr>
  Get a list of NPC classes matching the given full or partial name.

List_AllPlayers (lap)
  Lists information about all players who have accounts on the server.

List_AllTalent (lat) <TelentLevel>
  Lists all natural gifts of the specified level (1-3). Pass 0 for all levels.

List_GuildObjs (lgo) <InOpGuild>
  Lists the name and UID of all NPCs owned by a tribe (by name or UID).

List_Guilds (lg)
  Lists the names and UIDs of all tribes on the server.

List_OnlinePlayers (lp)
  Lists players currently connected to the server.

List_SameBelongingObjs (ls) <InOpPlayer>
  Lists NPCs owned by the specified player (by Steam ID or pawn UID).

List_ServerPermissionList (lsp)
  Lists information about server permission lists.

QueryInvitationCode (qi)
  Prints the server's invitation code.

SaveAndExit (close/exit/shutdown) <AfterSeconds>
  Saves and shuts down the server. 0 = 300 second timer.

SaveWorld (sav) <Force>
  Saves the world. Force=1 writes to disk.

SayToSystemChannel (say) <Content>
  Sends a system chat message to everyone on the server.

ServerFPS (fps)
  Prints the average server tick rate.

ServerLoginStatus (sl) <Pause>
  0=prohibit logins, 1=allow logins.

Set_Coefficient (sc) <ItemName> <Val>
  Sets the specified gameplay setting to the given value.

Set_OutputChats (soc) <bOutputTolog>
  1=enable chat logging to WS.log, 0=disable. Persists through restarts.

Set_ServerPermissionEnable (ssp) <PermissionType> <bEnabled>
  Enables or disables a server permission list by index.

Set_ServerPermissionFlag (sspf) <PermissionFlag>
  Sets the enabled state of all permission lists using a bit mask.

Show_Coefficient_Settings (lc) [ContainNames]
  Lists values of all gameplay settings, optionally filtered by name.

ShowHelp (help/?)
  Prints information about available commands.

StartAI
  Resumes NPC AI paused by StopAI.

StopAI
  Pauses all NPC AI on the server.

StopCloseServer (cancelclose/cc)
  Cancels a pending server shutdown (if timer not yet elapsed).

Update_RconClientAddress <bAddOrRemove> <RconSafeAddress>
  1=add or 0=remove an IP from the RCON allowlist. Resets on restart.

Update_ServerPermissionList (usp) <PermissionType> <bRemoveOrAdd> <Data>
  Adds or removes an item from a server permission list by index.
  Common usage: usp 2 1 <SteamID> (ban), usp 2 0 <SteamID> (unban)`;
}

// ========================================
// RCON Commands
// ========================================

async function sendRcon(command: string, timeoutMs = 10000): Promise<string> {
  if (!rconClient || !isConnectedToRcon) {
    throw new Error('RCON not connected');
  }

  const response = await Promise.race([
    rconClient.send(command),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`RCON timeout after ${timeoutMs}ms: ${command}`)), timeoutMs)
    )
  ]);

  return response;
}

// ========================================
// Player Polling
// ========================================

async function pollPlayers() {
  if (!isConnectedToRcon || !isConnectedToTakaro) return;

  try {
    const output = await sendRcon('lp');
    const current = parsePlayers(output);
    const currentMap = new Map(current.map(p => [p.gameId, p]));

    // Detect joins
    for (const [id, player] of currentMap) {
      if (!knownPlayers.has(id)) {
        logger.info(`Player joined: ${player.name} (${id})`);
        sendGameEvent('player-connected', {
          player: {
            gameId: player.gameId,
            name: player.name,
            platformId: `soulmask:${player.steamId}`,
            steamId: player.steamId
          }
        });
      }
    }

    // Detect leaves
    for (const [id, player] of knownPlayers) {
      if (!currentMap.has(id)) {
        logger.info(`Player left: ${player.name} (${id})`);
        sendGameEvent('player-disconnected', {
          player: {
            gameId: player.gameId,
            name: player.name,
            platformId: `soulmask:${player.steamId}`,
            steamId: player.steamId
          }
        });
      }
    }

    knownPlayers = currentMap;
  } catch (error) {
    logger.warn(`Player poll failed: ${error}`);
    // If RCON errors during poll, the error/end event will handle reconnection
  }
}

function startPlayerPoll() {
  if (playerPollTimer) clearInterval(playerPollTimer);
  playerPollTimer = setInterval(pollPlayers, PLAYER_POLL_INTERVAL);
  logger.info(`Player polling started (interval: ${PLAYER_POLL_INTERVAL}ms)`);
}

function stopPlayerPoll() {
  if (playerPollTimer) {
    clearInterval(playerPollTimer);
    playerPollTimer = null;
  }
}

// ========================================
// Takaro WebSocket
// ========================================

function connectToTakaro() {
  if (takaroWs && takaroWs.readyState === WebSocket.OPEN) {
    logger.info('Already connected to Takaro');
    return;
  }

  logger.info(`Connecting to Takaro at ${TAKARO_WS_URL} (attempt ${reconnectAttempts + 1})`);
  takaroWs = new WebSocket(TAKARO_WS_URL);

  takaroWs.on('open', () => {
    logger.info('Connected to Takaro WebSocket');
    reconnectAttempts = 0;
    sendIdentify();
  });

  takaroWs.on('message', (data: WebSocket.Data) => {
    try {
      handleTakaroMessage(JSON.parse(data.toString()));
    } catch (err) {
      metrics.errors++;
      logger.error(`Failed to parse Takaro message: ${err}`);
    }
  });

  takaroWs.on('close', () => {
    logger.warn('Disconnected from Takaro');
    isConnectedToTakaro = false;
    scheduleReconnect();
  });

  takaroWs.on('error', (err) => {
    logger.error(`Takaro WebSocket error: ${err.message}`);
  });
}

function sendIdentify() {
  if (!takaroWs || takaroWs.readyState !== WebSocket.OPEN) return;

  const msg: any = {
    type: 'identify',
    payload: { identityToken: IDENTITY_TOKEN }
  };
  if (REGISTRATION_TOKEN) msg.payload.registrationToken = REGISTRATION_TOKEN;

  logger.info('Sending identify message to Takaro');
  takaroWs.send(JSON.stringify(msg));
}

function handleTakaroMessage(message: any) {
  if (message.type !== 'request' && message.type !== 'ping') {
    logger.info(`Received from Takaro: ${message.type}`);
  }

  switch (message.type) {
    case 'identifyResponse':
      if (message.payload?.error) {
        logger.error(`Identification failed: ${message.payload.error}`);
      } else {
        logger.info('Successfully identified with Takaro');
        isConnectedToTakaro = true;
      }
      break;

    case 'connected':
      logger.info('Takaro confirmed connection');
      break;

    case 'request':
      handleTakaroRequest(message);
      break;

    case 'response':
      // Responses to our outbound requests (not used in this bridge)
      break;

    case 'ping':
      sendToTakaro({ type: 'pong' });
      break;

    case 'error':
      logger.error(`Takaro error: ${JSON.stringify(message.payload || message)}`);
      break;

    default:
      logger.warn(`Unknown message type from Takaro: ${message.type}`);
  }
}

async function handleTakaroRequest(message: any) {
  const { requestId, payload } = message;
  const { action, args } = payload;

  metrics.requestsReceived++;

  const routineActions = ['testReachability', 'getPlayers', 'getPlayerLocation', 'getPlayerInventory'];
  if (!routineActions.includes(action)) {
    logger.info(`Takaro request: ${action} (ID: ${requestId})`);
  }

  const parsedArgs = typeof args === 'string' ? JSON.parse(args) : (args || {});
  let responsePayload: any;

  try {
    switch (action) {
      case 'testReachability':
        responsePayload = {
          connectable: isConnectedToRcon,
          reason: isConnectedToRcon ? null : 'RCON not connected - server may be offline'
        };
        break;

      case 'getPlayers':
        responsePayload = Array.from(knownPlayers.values()).map(p => ({
          gameId: p.gameId,
          name: p.name,
          platformId: `soulmask:${p.steamId}`,
          steamId: p.steamId
        }));
        break;

      case 'getPlayerLocation': {
        const gameId = parsedArgs.gameId || parsedArgs.player?.gameId;
        const player = knownPlayers.get(gameId);
        responsePayload = player ? { x: player.x, y: player.y, z: player.z } : { x: 0, y: 0, z: 0 };
        break;
      }

      case 'getPlayerInventory':
        // Soulmask does not expose player inventory over RCON
        responsePayload = [];
        break;

      case 'sendMessage': {
        const msg = parsedArgs.message || parsedArgs.msg || '';
        if (msg) {
          // SayToSystemChannel sends a system message to all players
          await sendRcon(`say ${msg}`);
          responsePayload = { success: true };
        } else {
          responsePayload = { success: false, error: 'No message provided' };
        }
        break;
      }

      case 'executeCommand':
      case 'executeConsoleCommand': {
        const cmd = parsedArgs.command || '';
        if (!cmd) {
          responsePayload = { success: false, rawResult: 'Error: No command provided' };
          break;
        }
        if (cmd.toLowerCase() === 'help') {
          responsePayload = { success: true, rawResult: getSoulmaskCommandHelp() };
          break;
        }
        const result = await sendRcon(cmd, 15000);
        responsePayload = { success: true, rawResult: result };
        break;
      }

      case 'kickPlayer': {
        // KickPlayer <SteamID>
        const gameId = parsedArgs.gameId || parsedArgs.player?.gameId;
        if (!gameId) {
          responsePayload = { success: false, error: 'No player specified' };
          break;
        }
        await sendRcon(`KickPlayer ${gameId}`);
        responsePayload = { success: true };
        break;
      }

      case 'banPlayer': {
        // Add player to the server blacklist (permission list type BAN_PERMISSION_TYPE)
        // Run "lsp" in RCON to check which index is the blacklist on your server
        const gameId = parsedArgs.gameId || parsedArgs.player?.gameId;
        if (!gameId) {
          responsePayload = { success: false, error: 'No player specified' };
          break;
        }
        // usp <permissionType> <1=add> <steamId>
        await sendRcon(`usp ${BAN_PERMISSION_TYPE} 1 ${gameId}`);
        logger.info(`Banned player: ${gameId}`);
        responsePayload = { success: true };
        break;
      }

      case 'unbanPlayer': {
        // Remove player from the server blacklist
        const gameId = parsedArgs.gameId || parsedArgs.player?.gameId;
        if (!gameId) {
          responsePayload = { success: false, error: 'No player specified' };
          break;
        }
        // usp <permissionType> <0=remove> <steamId>
        await sendRcon(`usp ${BAN_PERMISSION_TYPE} 0 ${gameId}`);
        logger.info(`Unbanned player: ${gameId}`);
        responsePayload = { success: true };
        break;
      }

      case 'listBans':
        // Soulmask does not return a structured ban list from RCON
        responsePayload = [];
        break;

      case 'listEntities':
        responsePayload = [];
        break;

      case 'listItems':
        responsePayload = [];
        break;

      case 'shutdown': {
        // SaveAndExit <seconds> - 0 triggers the default 300s timer
        // Use a small value for near-immediate shutdown via Takaro
        const seconds = parsedArgs.seconds ?? 30;
        await sendRcon(`SaveAndExit ${seconds}`);
        responsePayload = { success: true };
        break;
      }

      default:
        logger.warn(`Unknown action: ${action}`);
        responsePayload = { error: `Unknown action: ${action}` };
    }
  } catch (error) {
    metrics.errors++;
    logger.error(`Error handling ${action}: ${error}`);
    responsePayload = { success: false, error: String(error) };
  }

  sendTakaroResponse(requestId, responsePayload);
}

// ========================================
// Takaro Helpers
// ========================================

function sendGameEvent(eventType: string, data: any) {
  if (!isConnectedToTakaro) {
    logger.warn(`Cannot send event ${eventType} - not connected to Takaro`);
    return;
  }

  const playerInfo = data.player?.name ? ` - ${data.player.name}` : '';
  logger.info(`Game event: ${eventType}${playerInfo}`);

  const cleanPlayer: any = {};
  if (data.player) {
    if (data.player.gameId) cleanPlayer.gameId = data.player.gameId;
    if (data.player.name) cleanPlayer.name = data.player.name;
    if (data.player.platformId) cleanPlayer.platformId = data.player.platformId;
    if (data.player.steamId) cleanPlayer.steamId = data.player.steamId;
  }

  const message: any = {
    type: 'gameEvent',
    payload: {
      type: eventType,
      data: { player: cleanPlayer }
    }
  };

  // Forward extra event data (e.g. msg for chat events)
  if (data.msg !== undefined) message.payload.data.msg = data.msg;
  if (data.channel !== undefined) message.payload.data.channel = data.channel;

  sendToTakaro(message);
  metrics.eventsSent++;
}

function sendTakaroResponse(requestId: string, payload: any) {
  sendToTakaro({ type: 'response', requestId, payload });
}

function sendToTakaro(message: any) {
  if (!takaroWs || takaroWs.readyState !== WebSocket.OPEN) {
    logger.error(`Cannot send to Takaro - not connected (state: ${takaroWs?.readyState})`);
    return false;
  }

  try {
    takaroWs.send(JSON.stringify(message));
    if (message.type === 'response') metrics.responsesSent++;
    return true;
  } catch (err) {
    metrics.errors++;
    logger.error(`Failed to send to Takaro: ${err}`);
    return false;
  }
}

function scheduleReconnect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  reconnectAttempts++;
  const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
  const jitter = Math.random() * delay * 0.25;
  const ms = delay + jitter;
  logger.info(`Reconnecting to Takaro in ${Math.round(ms / 1000)}s (attempt ${reconnectAttempts})`);
  reconnectTimeout = setTimeout(() => connectToTakaro(), ms);
}

// ========================================
// Log File Watcher (player joins/leaves, chat events)
// ========================================

function startLogWatch() {
  if (!LOG_FILE_PATH) return;
  if (!fs.existsSync(LOG_FILE_PATH)) {
    logger.warn(`Log file not found: ${LOG_FILE_PATH}`);
    return;
  }
  // Start at current end of file - don't replay old messages
  logFilePosition = fs.statSync(LOG_FILE_PATH).size;
  logger.info(`Watching log file for chat: ${LOG_FILE_PATH}`);
  logWatchTimer = setInterval(readLogFile, 1000);
}

function stopLogWatch() {
  if (logWatchTimer) {
    clearInterval(logWatchTimer);
    logWatchTimer = null;
  }
}

function readLogFile() {
  if (!LOG_FILE_PATH || !isConnectedToTakaro) return;
  try {
    const stat = fs.statSync(LOG_FILE_PATH);
    if (stat.size < logFilePosition) logFilePosition = 0; // file was rotated
    if (stat.size <= logFilePosition) return;

    const fd = fs.openSync(LOG_FILE_PATH, 'r');
    const buf = Buffer.alloc(stat.size - logFilePosition);
    fs.readSync(fd, buf, 0, buf.length, logFilePosition);
    fs.closeSync(fd);
    logFilePosition = stat.size;

    for (const line of buf.toString('utf8').split('\n')) {
      parseLogLine(line.trim());
    }
  } catch (_) {}
}

function parseLogLine(line: string) {
  if (!line) return;

  // Player join: logStoreGamemode: player ready. Addr:..., Netuid:76561198041959712, Name:Mad
  const joinMatch = line.match(/logStoreGamemode:.*player ready\.\s*Addr:[^,]*,\s*Netuid:(\d+),\s*Name:(.+)/i);
  if (joinMatch) {
    const steamId = joinMatch[1].trim();
    const name = joinMatch[2].trim();
    if (knownPlayers.has(steamId)) return;

    const player: SoulmaskPlayer = { gameId: steamId, name, steamId, x: 0, y: 0, z: 0 };
    knownPlayers.set(steamId, player);
    logger.info(`Player joined: ${name} (${steamId})`);
    sendGameEvent('player-connected', {
      player: { gameId: steamId, name, platformId: `soulmask:${steamId}`, steamId }
    });
    return;
  }

  // Player leave: logStoreGamemode: Display: player leave world. 76561198041959712
  const leaveMatch = line.match(/logStoreGamemode:.*player leave world\.\s*(\d+)/i);
  if (leaveMatch) {
    const steamId = leaveMatch[1].trim();
    const player = knownPlayers.get(steamId);
    if (!player) return;

    knownPlayers.delete(steamId);
    logger.info(`Player left: ${player.name} (${steamId})`);
    sendGameEvent('player-disconnected', {
      player: { gameId: player.gameId, name: player.name, platformId: `soulmask:${player.steamId}`, steamId: player.steamId }
    });
    return;
  }

  // Chat: [timestamp][frame]logWorldChat: Display: [,PlayerName(SteamID)]message
  const chatMatch = line.match(/logWorldChat:\s*Display:\s*\[,([^\(]+)\((\d+)\)\](.+)/i);
  if (!chatMatch) return;

  const name = chatMatch[1].trim();
  const steamId = chatMatch[2].trim();
  const message = chatMatch[3].trim();
  if (!message) return;

  const player = knownPlayers.get(steamId);

  logger.info(`Chat: ${name}: ${message}`);

  sendGameEvent('chat-message', {
    player: player
      ? { gameId: player.gameId, name: player.name, platformId: `soulmask:${player.steamId}`, steamId: player.steamId }
      : { gameId: steamId, name, platformId: `soulmask:${steamId}`, steamId },
    msg: message,
    channel: 'global'
  });
}

// ========================================
// RCON Client
// ========================================

async function connectToRcon() {
  if (!RCON_PASSWORD) {
    logger.warn('RCON_PASSWORD not set in TakaroConfig.txt - skipping RCON connection');
    return;
  }

  // Clean up existing connection before creating a new one
  if (rconClient) {
    try {
      await rconClient.end().catch(() => {});
    } catch (_) {}
    rconClient = null;
  }

  isConnectedToRcon = false;
  logger.info(`Connecting to Soulmask RCON at ${RCON_HOST}:${RCON_PORT}`);

  try {
    rconClient = new Rcon({
      host: RCON_HOST,
      port: RCON_PORT,
      password: RCON_PASSWORD,
      timeout: 10000
    });

    rconClient.on('connect', () => {
      logger.info('Connected to Soulmask RCON');
      isConnectedToRcon = true;
      rconReconnectAttempts = 0;
      if (rconReconnectTimeout) {
        clearTimeout(rconReconnectTimeout);
        rconReconnectTimeout = null;
      }
      rconClient!.send('Set_OutputChats 1').catch(() => {});
      startLogWatch();
    });

    rconClient.on('end', () => {
      logger.warn('Disconnected from Soulmask RCON');
      isConnectedToRcon = false;
      stopLogWatch();
      knownPlayers.clear();
      scheduleRconReconnect();
    });

    rconClient.on('error', (err: Error) => {
      metrics.errors++;
      logger.error(`RCON error: ${err.message}`);
      if (isConnectedToRcon) {
        isConnectedToRcon = false;
        knownPlayers.clear();
        scheduleRconReconnect();
      }
    });

    await rconClient.connect();

  } catch (error) {
    logger.error(`Failed to connect to Soulmask RCON: ${error}`);
    isConnectedToRcon = false;
    scheduleRconReconnect();
  }
}

function scheduleRconReconnect() {
  if (rconReconnectTimeout) clearTimeout(rconReconnectTimeout);

  if (rconReconnectAttempts >= MAX_RCON_RECONNECT_ATTEMPTS) {
    logger.error(`RCON reconnection gave up after ${MAX_RCON_RECONNECT_ATTEMPTS} attempts`);
    return;
  }

  logger.info(`Scheduling RCON reconnection in ${RCON_RECONNECT_DELAY}ms... (attempt ${rconReconnectAttempts + 1})`);

  rconReconnectTimeout = setTimeout(() => {
    rconReconnectAttempts++;
    connectToRcon();
  }, RCON_RECONNECT_DELAY);
}

// ========================================
// HTTP API (health check)
// ========================================

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  const uptime = Date.now() - metrics.startTime;
  res.json({
    status: 'ok',
    version: VERSION,
    takaroConnected: isConnectedToTakaro,
    rconConnected: isConnectedToRcon,
    playersOnline: knownPlayers.size,
    uptime: Math.floor(uptime / 1000),
    metrics: {
      requestsReceived: metrics.requestsReceived,
      responsesSent: metrics.responsesSent,
      eventsSent: metrics.eventsSent,
      errors: metrics.errors
    }
  });
});

app.listen(HTTP_PORT, '127.0.0.1', () => {
  logger.info(`Takaro Soulmask Bridge v${VERSION} starting...`);
  logger.info(`HTTP health check: http://127.0.0.1:${HTTP_PORT}/health`);
  logger.info(`Identity token: ${IDENTITY_TOKEN || '(not set)'}`);
  logger.info(`RCON: ${RCON_HOST}:${RCON_PORT}`);
});

// ========================================
// Start
// ========================================

connectToTakaro();
connectToRcon();

// ========================================
// Graceful shutdown
// ========================================

function shutdown() {
  logger.info('Shutting down Takaro Soulmask Bridge...');
  stopLogWatch();
  if (takaroWs) takaroWs.close();
  if (rconClient) rconClient.end().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
