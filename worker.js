// Sigma Hideout — gallery Worker
//
// Files go in an R2 bucket, capped at a total storage budget so you never
// pay more than a predictable, tiny amount past R2's 10GB free tier.
// Metadata (caption, uploader, timestamp) stays in Workers KV.
//
// Uploading and deleting both require being logged in with Discord;
// deleting additionally requires being on the admin list.
//
// Server events (Discord's native "Events" feature) are managed entirely
// through slash commands with popup forms — /create_event, /edit_event,
// /delete_event — admin-only. Discord itself is the source of truth; the
// website just reads the list back out to show on /events and /home.
// Each change also posts a ping-free announcement.
//
// /admin_help and /notify_admins (both admin-only) DM every current admin
// — the first resends a fixed how-to-use guide, the second sends a
// custom message. The scheduled() handler below also runs on a cron
// (see wrangler.jsonc) to auto-DM the guide to anyone newly added to
// DISCORD_ADMIN_USER_IDS, so new admins get welcomed without anyone
// having to remember to run a command.
//
// Routes:
//   GET    /api/gallery         -> list all uploaded items (newest first)
//   POST   /api/upload          -> accept image/video uploads (requires Discord login)
//   GET    /uploads/<file>      -> serve an uploaded file from R2
//   DELETE /api/gallery/:id     -> remove an item (requires logged-in Discord admin)
//   GET    /api/events          -> list upcoming server events (public)
//   GET    /api/auth/login      -> redirect to Discord OAuth2
//   GET    /api/auth/callback   -> Discord sends the user back here after login
//   GET    /api/auth/me         -> current session info, or { loggedIn: false }
//   POST   /api/auth/logout     -> clear the session
//   POST   /api/discord/interactions -> Discord slash-command / modal webhook (the bot)
//
// Everything else falls through to the static site (env.ASSETS).

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/ogg'
]);

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB per file

// Hard cap on total storage used across the whole bucket. 15GB = 5GB past
// R2's 10GB free tier, i.e. ~$0.075/month max at R2's $0.015/GB/month rate.
// Raise/lower this to change what you're willing to spend.
const MAX_TOTAL_STORAGE_BYTES = 15 * 1024 * 1024 * 1024;

const ITEM_PREFIX = 'item:';
const USAGE_KEY = 'total-storage-bytes';
const SESSION_PREFIX = 'session:';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const SESSION_COOKIE = 'sh_session';

function extFromMime(mime) {
  const map = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/avif': '.avif',
    'video/mp4': '.mp4', 'video/webm': '.webm',
    'video/quicktime': '.mov', 'video/ogg': '.ogv'
  };
  return map[mime] || '';
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });
}

// ---- Cookies ----

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

function sessionCookieHeader(sessionId, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// ---- Sessions (Workers KV) ----

async function getSession(request, env) {
  const cookies = parseCookies(request);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return null;

  const raw = await env.GALLERY_KV.get(SESSION_PREFIX + sessionId);
  if (!raw) return null;
  try {
    return { id: sessionId, ...JSON.parse(raw) };
  } catch {
    return null;
  }
}

async function createSession(env, userData) {
  const sessionId = crypto.randomUUID();
  await env.GALLERY_KV.put(SESSION_PREFIX + sessionId, JSON.stringify(userData), {
    expirationTtl: SESSION_TTL_SECONDS
  });
  return sessionId;
}

async function destroySession(request, env) {
  const cookies = parseCookies(request);
  const sessionId = cookies[SESSION_COOKIE];
  if (sessionId) await env.GALLERY_KV.delete(SESSION_PREFIX + sessionId);
}

// ---- Discord OAuth2 ----

function discordRedirectUri(url) {
  return `${url.protocol}//${url.host}/api/auth/callback`;
}

async function handleAuthLogin(request, env) {
  const url = new URL(request.url);
  const redirectUri = discordRedirectUri(url);
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify guilds.members.read'
  });
  return Response.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`, 302);
}

async function handleAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return jsonResponse({ error: 'Missing code from Discord.' }, 400);

  const redirectUri = discordRedirectUri(url);

  // Exchange the code for an access token.
  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    })
  });
  if (!tokenRes.ok) return jsonResponse({ error: 'Discord login failed (token exchange).' }, 502);
  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;

  // Who is this?
  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!userRes.ok) return jsonResponse({ error: 'Discord login failed (user lookup).' }, 502);
  const user = await userRes.json();

  // Are they actually in the server? (also gets us their roles there)
  const memberRes = await fetch(`https://discord.com/api/users/@me/guilds/${env.DISCORD_GUILD_ID}/member`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!memberRes.ok) {
    return new Response(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0f0c0c;color:#ecd9d9;padding:3rem;text-align:center;">
        <h1>Not a member</h1>
        <p>You need to be in the Sigma Hideout Discord server to log in.</p>
        <p><a href="/gallery" style="color:#b43838;">Back to the gallery</a></p>
      </body></html>`,
      { status: 403, headers: { 'Content-Type': 'text/html' } }
    );
  }
  const member = await memberRes.json();

  const sessionId = await createSession(env, {
    discordId: user.id,
    username: user.global_name || user.username,
    avatar: user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : null,
    roles: member.roles || [],
    createdAt: Date.now()
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/gallery/upload',
      'Set-Cookie': sessionCookieHeader(sessionId, SESSION_TTL_SECONDS)
    }
  });
}

async function handleAuthMe(request, env) {
  const session = await getSession(request, env);
  if (!session) return jsonResponse({ loggedIn: false });
  return jsonResponse({
    loggedIn: true,
    username: session.username,
    avatar: session.avatar,
    isAdmin: isAuthorizedAdmin(session.discordId, env)
  });
}

async function handleAuthLogout(request, env) {
  await destroySession(request, env);
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearSessionCookieHeader() });
}

// ---- Storage usage tracking (KV counter, self-healing from R2 if missing) ----

async function getUsedBytes(env) {
  const raw = await env.GALLERY_KV.get(USAGE_KEY);
  if (raw !== null) return parseInt(raw, 10) || 0;

  // First run, or counter got lost somehow — recompute from R2 directly.
  let total = 0;
  let cursor;
  do {
    const page = await env.sigma_gallery.list({ cursor });
    cursor = page.truncated ? page.cursor : undefined;
    for (const obj of page.objects) total += obj.size;
  } while (cursor);

  await env.GALLERY_KV.put(USAGE_KEY, String(total));
  return total;
}

async function adjustUsedBytes(env, delta) {
  const current = await getUsedBytes(env);
  const next = Math.max(0, current + delta);
  await env.GALLERY_KV.put(USAGE_KEY, String(next));
  return next;
}

// ---- Gallery logic ----

async function listGallery(env) {
  const items = [];
  let cursor;
  do {
    const page = await env.GALLERY_KV.list({ prefix: ITEM_PREFIX, cursor });
    cursor = page.cursor;
    const values = await Promise.all(page.keys.map(k => env.GALLERY_KV.get(k.name)));
    for (const v of values) {
      if (v) items.push(JSON.parse(v));
    }
    if (page.list_complete) break;
  } while (cursor);

  items.sort((a, b) => b.uploadedAt - a.uploadedAt);
  return items;
}

async function handleUpload(request, env) {
  const session = await getSession(request, env);
  if (!session) {
    return jsonResponse({ error: 'You need to log in with Discord to upload.' }, 401);
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ error: 'Could not read upload.' }, 400);
  }

  const files = formData.getAll('media').filter(f => f && typeof f.arrayBuffer === 'function');
  if (files.length === 0) {
    return jsonResponse({ error: 'No files received.' }, 400);
  }
  if (files.length > 10) {
    return jsonResponse({ error: 'Max 10 files per upload.' }, 400);
  }

  const caption = (formData.get('caption') || '').toString().trim().slice(0, 200);
  const uploader = session.username; // always the real Discord identity, never client-supplied

  if (!caption) return jsonResponse({ error: 'A caption is required.' }, 400);

  // Check the whole batch fits before writing anything.
  const batchSize = files.reduce((sum, f) => sum + f.size, 0);
  const usedBytes = await getUsedBytes(env);
  if (usedBytes + batchSize > MAX_TOTAL_STORAGE_BYTES) {
    const remainingMB = Math.max(0, Math.floor((MAX_TOTAL_STORAGE_BYTES - usedBytes) / (1024 * 1024)));
    return jsonResponse({
      error: `Gallery storage is full (${remainingMB}MB left of a ${Math.floor(MAX_TOTAL_STORAGE_BYTES / (1024 ** 3))}GB cap). Ask an admin to raise the cap or clear old items.`
    }, 507);
  }

  const saved = [];
  for (const file of files) {
    if (!ALLOWED_MIME.has(file.type)) {
      return jsonResponse({ error: `Unsupported file type: ${file.type || 'unknown'}` }, 400);
    }
    if (file.size > MAX_FILE_SIZE) {
      return jsonResponse({ error: `${file.name} is too large (max ${Math.floor(MAX_FILE_SIZE / (1024 * 1024))}MB).` }, 413);
    }

    const id = crypto.randomUUID();
    const ext = extFromMime(file.type);
    const objectKey = `uploads/${id}${ext}`;

    await env.sigma_gallery.put(objectKey, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type }
    });
    await adjustUsedBytes(env, file.size);

    const entry = {
      id,
      objectKey,
      url: `/${objectKey}`,
      type: file.type.startsWith('video') ? 'video' : 'image',
      mimetype: file.type,
      size: file.size,
      caption,
      uploader,
      discordId: session.discordId,
      uploadedAt: Date.now()
    };

    await env.GALLERY_KV.put(ITEM_PREFIX + id, JSON.stringify(entry));
    saved.push(entry);
  }

  return jsonResponse({ ok: true, items: saved });
}

async function handleServeFile(pathname, env) {
  const objectKey = pathname.replace(/^\//, ''); // "uploads/<id>.<ext>"
  const object = await env.sigma_gallery.get(objectKey);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=604800'); // 7 days

  return new Response(object.body, { headers });
}

async function isSessionAdmin(request, env) {
  const session = await getSession(request, env);
  return Boolean(session) && isAuthorizedAdmin(session.discordId, env);
}

async function handleDelete(request, id, env) {
  if (!await isSessionAdmin(request, env)) {
    return jsonResponse({ error: 'Not authorized.' }, 401);
  }

  const key = ITEM_PREFIX + id;
  const raw = await env.GALLERY_KV.get(key);
  if (!raw) return jsonResponse({ error: 'Not found' }, 404);

  const entry = JSON.parse(raw);
  await env.sigma_gallery.delete(entry.objectKey);
  await env.GALLERY_KV.delete(key);
  if (typeof entry.size === 'number') {
    await adjustUsedBytes(env, -entry.size);
  }
  return jsonResponse({ ok: true });
}

// ---- Discord REST API (bot-token authenticated) ----

async function discordApiRequest(path, options, env) {
  return fetch(`https://discord.com/api/v10${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options && options.headers)
    }
  });
}

// ---- Server events (Discord's native Guild Scheduled Events) ----
// Discord itself is the source of truth — nothing about events is stored
// in KV, EXCEPT a short-lived "last known good" snapshot (EVENTS_CACHE_KEY
// below), used only as a fallback if a live request to Discord fails.
// Without this, a single transient failure (rate limit, network blip)
// would make the site briefly show "no events" even though real events
// exist — this makes that show the last successful list instead.

const EVENTS_CACHE_KEY = 'events-cache';
const EVENTS_CACHE_TTL_SECONDS = 600; // how long a fallback snapshot stays usable

async function fetchScheduledEventsOnce(env) {
  const res = await discordApiRequest(`/guilds/${env.DISCORD_GUILD_ID}/scheduled-events`, { method: 'GET' }, env);
  if (!res.ok) throw new Error(`Discord API returned ${res.status}`);
  return res.json();
}

async function listScheduledEvents(env) {
  try {
    const data = await fetchScheduledEventsOnce(env);
    // Success — remember this as the fallback for next time something goes wrong.
    await env.GALLERY_KV.put(EVENTS_CACHE_KEY, JSON.stringify(data), { expirationTtl: EVENTS_CACHE_TTL_SECONDS });
    return data;
  } catch {
    // First failure — try once more immediately, transient blips often clear right away.
    try {
      const data = await fetchScheduledEventsOnce(env);
      await env.GALLERY_KV.put(EVENTS_CACHE_KEY, JSON.stringify(data), { expirationTtl: EVENTS_CACHE_TTL_SECONDS });
      return data;
    } catch {
      // Still failing — fall back to the last successful list rather than showing nothing.
      const cached = await env.GALLERY_KV.get(EVENTS_CACHE_KEY);
      return cached ? JSON.parse(cached) : [];
    }
  }
}

async function findEventByName(name, env) {
  const events = await listScheduledEvents(env);
  const target = (name || '').trim().toLowerCase();
  return events.find(e => e.name.toLowerCase() === target) || null;
}

async function createScheduledEvent(fields, env) {
  const body = {
    name: fields.name,
    description: fields.description || undefined,
    scheduled_start_time: fields.startTime.toISOString(),
    scheduled_end_time: fields.endTime.toISOString(),
    privacy_level: 2, // GUILD_ONLY — the only value Discord currently supports
    entity_type: 3,   // EXTERNAL — a real-world/location-based event, not tied to a voice channel
    entity_metadata: { location: fields.location }
  };
  const res = await discordApiRequest(`/guilds/${env.DISCORD_GUILD_ID}/scheduled-events`, {
    method: 'POST',
    body: JSON.stringify(body)
  }, env);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function updateScheduledEvent(eventId, fields, env) {
  const body = {
    name: fields.name,
    description: fields.description || undefined,
    scheduled_start_time: fields.startTime.toISOString(),
    scheduled_end_time: fields.endTime.toISOString(),
    entity_metadata: { location: fields.location }
  };
  const res = await discordApiRequest(`/guilds/${env.DISCORD_GUILD_ID}/scheduled-events/${eventId}`, {
    method: 'PATCH',
    body: JSON.stringify(body)
  }, env);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function deleteScheduledEvent(eventId, env) {
  const res = await discordApiRequest(`/guilds/${env.DISCORD_GUILD_ID}/scheduled-events/${eventId}`, {
    method: 'DELETE'
  }, env);
  if (!res.ok) throw new Error(await res.text());
}

// ---- Announcements ----
// Posted to a fixed channel whenever an event is created/edited/deleted.
// allowed_mentions: { parse: [] } strips out ALL pings — @everyone, @here,
// roles, users — even if they appear in the text, so this can never
// accidentally ping the whole server.

function discordTimestamp(date, style) {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

async function announceToChannel(content, env) {
  if (!env.DISCORD_ANNOUNCEMENTS_CHANNEL_ID) return false; // not configured
  try {
    const res = await discordApiRequest(`/channels/${env.DISCORD_ANNOUNCEMENTS_CHANNEL_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } })
    }, env);
    return res.ok;
  } catch {
    return false;
  }
}

async function handleListEventsPublic(env) {
  const events = await listScheduledEvents(env);
  const simplified = events
    .map(e => ({
      id: e.id,
      name: e.name,
      description: e.description || '',
      location: (e.entity_metadata && e.entity_metadata.location) || '',
      start: e.scheduled_start_time,
      end: e.scheduled_end_time || null
    }))
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  return jsonResponse(simplified);
}

// ---- Modal (popup form) helpers ----

function textInputRow(customId, label, style, required, value) {
  const input = {
    type: 4, // TEXT_INPUT
    custom_id: customId,
    label,
    style, // 1 = single line, 2 = paragraph
    required: Boolean(required)
  };
  if (value) input.value = String(value).slice(0, style === 2 ? 4000 : 100);
  return { type: 1, components: [input] }; // wrapped in an ACTION_ROW, as Discord requires
}

function buildEventModal(customId, title, prefill) {
  prefill = prefill || {};
  return jsonResponse({
    type: DISCORD_RESPONSE_MODAL,
    data: {
      custom_id: customId,
      title,
      components: [
        textInputRow('name', 'Event name', 1, true, prefill.name),
        textInputRow('location', 'Location', 1, true, prefill.location),
        textInputRow('start_time', 'Start (YYYY-MM-DD HH:MM, UTC)', 1, true, prefill.start_time),
        textInputRow('end_time', 'End (YYYY-MM-DD HH:MM, UTC)', 1, true, prefill.end_time),
        textInputRow('description', 'Description', 2, false, prefill.description)
      ]
    }
  });
}

function buildTalkModal() {
  return jsonResponse({
    type: DISCORD_RESPONSE_MODAL,
    data: {
      custom_id: 'talk_modal',
      title: 'Send a message',
      components: [
        textInputRow('message', 'Message', 2, true)
      ]
    }
  });
}

function extractModalFields(interaction) {
  const fields = {};
  (interaction.data.components || []).forEach(row => {
    (row.components || []).forEach(comp => {
      fields[comp.custom_id] = comp.value;
    });
  });
  return fields;
}

function formatForModal(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// Accepts "YYYY-MM-DD HH:MM" (or with a "T") and treats it as UTC, since
// that's what admins are asked to enter. Returns an invalid Date if it
// can't be parsed — callers should check with isNaN(date.getTime()).
function parseAdminDate(str) {
  if (!str) return null;
  let s = str.trim();
  if (!s.includes('T')) s = s.replace(' ', 'T');
  if (!/[Zz]$|[+-]\d\d:\d\d$/.test(s)) {
    const timePart = s.split('T')[1] || '';
    if (timePart.split(':').length === 2) s += ':00';
    s += 'Z';
  }
  return new Date(s);
}

function ephemeral(content) {
  return jsonResponse({
    type: DISCORD_RESPONSE_CHANNEL_MESSAGE,
    data: { content, flags: DISCORD_EPHEMERAL_FLAG }
  });
}

function deferred() {
  return jsonResponse({
    type: DISCORD_RESPONSE_DEFERRED,
    data: { flags: DISCORD_EPHEMERAL_FLAG }
  });
}

// Edits the "thinking..." placeholder left by a deferred response, once
// background work (like DMing several people) finishes. This uses the
// interaction's own token, not the bot token — no Authorization header
// needed, this endpoint is self-authorizing.
async function editDeferredResponse(applicationId, interactionToken, content) {
  await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
}

// ---- Discord bot interactions ----
// Discord sends interactions as a signed HTTP POST — no persistent bot
// process needed. We verify the Ed25519 signature, then respond.

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

async function verifyDiscordSignature(request, bodyText, env) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  if (!signature || !timestamp) return false;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(env.DISCORD_PUBLIC_KEY),
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const signatureBytes = hexToBytes(signature);
    const dataBytes = new TextEncoder().encode(timestamp + bodyText);
    return await crypto.subtle.verify('Ed25519', key, signatureBytes, dataBytes);
  } catch {
    return false;
  }
}

const DISCORD_INTERACTION_PING = 1;
const DISCORD_INTERACTION_APPLICATION_COMMAND = 2;
const DISCORD_INTERACTION_MODAL_SUBMIT = 5;
const DISCORD_RESPONSE_PONG = 1;
const DISCORD_RESPONSE_CHANNEL_MESSAGE = 4;
const DISCORD_RESPONSE_MODAL = 9;
const DISCORD_RESPONSE_DEFERRED = 5; // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE — "thinking..." placeholder
const DISCORD_EPHEMERAL_FLAG = 64;

function getDiscordUserId(interaction) {
  // In a server: Discord gives us interaction.member.user.id
  // In a DM: Discord gives us interaction.user.id instead
  return (interaction.member && interaction.member.user && interaction.member.user.id)
    || (interaction.user && interaction.user.id)
    || null;
}

function getDiscordUsername(interaction) {
  const user = (interaction.member && interaction.member.user) || interaction.user;
  if (!user) return 'Unknown';
  return user.global_name || user.username || 'Unknown';
}

function getAdminUserIds(env) {
  if (!env.DISCORD_ADMIN_USER_IDS) return [];
  return env.DISCORD_ADMIN_USER_IDS.split(',').map(id => id.trim()).filter(Boolean);
}

// ---- Notify-admins history log ----

const NOTIFY_LOG_PREFIX = 'notify-log:';
const NOTIFY_LOG_TTL_SECONDS = 60 * 60 * 24 * 180; // keep 180 days of history

async function logNotifyMessage(senderName, senderId, message, env) {
  const key = `${NOTIFY_LOG_PREFIX}${Date.now()}-${crypto.randomUUID()}`;
  await env.GALLERY_KV.put(key, JSON.stringify({
    senderName,
    senderId,
    message,
    sentAt: Date.now()
  }), { expirationTtl: NOTIFY_LOG_TTL_SECONDS });
}

async function listNotifyHistory(env, limit) {
  const entries = [];
  let cursor;
  do {
    const page = await env.GALLERY_KV.list({ prefix: NOTIFY_LOG_PREFIX, cursor });
    cursor = page.cursor;
    const values = await Promise.all(page.keys.map(k => env.GALLERY_KV.get(k.name)));
    for (const v of values) {
      if (v) entries.push(JSON.parse(v));
    }
    if (page.list_complete) break;
  } while (cursor);

  entries.sort((a, b) => b.sentAt - a.sentAt);
  return entries.slice(0, limit);
}

function isAuthorizedAdmin(userId, env) {
  if (!userId) return false;
  return getAdminUserIds(env).includes(userId);
}

// ---- Direct messages to admins ----

async function sendDirectMessage(userId, content, env) {
  const dmChannelRes = await discordApiRequest('/users/@me/channels', {
    method: 'POST',
    body: JSON.stringify({ recipient_id: userId })
  }, env);
  if (!dmChannelRes.ok) throw new Error(await dmChannelRes.text());
  const dmChannel = await dmChannelRes.json();

  const msgRes = await discordApiRequest(`/channels/${dmChannel.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } })
  }, env);
  if (!msgRes.ok) throw new Error(await msgRes.text());
}

async function dmAdmins(userIds, content, env) {
  const results = await Promise.allSettled(userIds.map(id => sendDirectMessage(id, content, env)));
  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failures = results
    .map((r, i) => ({ id: userIds[i], result: r }))
    .filter(x => x.result.status === 'rejected')
    .map(x => `${x.id}: ${x.result.reason.message.slice(0, 150)}`);
  return { succeeded, failed: results.length - succeeded, total: results.length, failures };
}

const ADMIN_HELP_TEXT = `**Sigma Hideout — Admin Commands**

You're on the admin list, which means you can:

**Events**
• \`/create_event\` — opens a popup to create a new server event (name, location, start/end time, description). Posts a ping-free announcement automatically.
• \`/edit_event {name}\` — opens the same popup, pre-filled, to update an existing event. \`{name}\` must match the event's current name exactly.
• \`/delete_event {name}\` — deletes an event immediately, no popup. \`{name}\` must match exactly.

Start/End times are entered as \`YYYY-MM-DD HH:MM\` and always treated as **UTC**.

**Gallery**
• Go to sigmahideout.de/gallery/admin and log in with Discord — it unlocks automatically since you're on the admin list. From there you can delete any gallery upload.

**Posting to the announcements channel directly**
• \`/talk\` — opens a popup with one text box. Whatever you type gets posted to the announcements channel exactly as-is, no pings (same as event announcements).

**Keeping other admins in the loop**
• \`/admin_help\` — resends this exact guide to every current admin (including you).
• \`/notify_admins {message}\` — DMs every current admin with a custom update, e.g. if these commands change in the future.
• \`/notify_history {count?}\` — shows the last several \`/notify_admins\` messages that were sent (default 10, max 25), so you can catch up on what you missed.

Access is checked live, every time — if you're ever removed from the admin list, all of this stops working immediately, no action needed on your end.`;

// ---- Auto-welcome newly added admins (runs on a schedule) ----

const KNOWN_ADMINS_KEY = 'known-admin-ids';

async function checkForNewAdmins(env) {
  const currentAdmins = getAdminUserIds(env);
  const knownRaw = await env.GALLERY_KV.get(KNOWN_ADMINS_KEY);
  const knownAdmins = knownRaw ? JSON.parse(knownRaw) : [];

  const newAdmins = currentAdmins.filter(id => !knownAdmins.includes(id));

  if (newAdmins.length > 0) {
    await dmAdmins(
      newAdmins,
      `👋 You've been added as an admin for Sigma Hideout. Here's what that unlocks:\n\n${ADMIN_HELP_TEXT}`,
      env
    );
  }

  await env.GALLERY_KV.put(KNOWN_ADMINS_KEY, JSON.stringify(currentAdmins));
}

async function handleSlashCommand(interaction, env, ctx) {
  const commandName = interaction.data && interaction.data.name;
  const userId = getDiscordUserId(interaction);

  if (commandName === 'adminpassword') {
    return ephemeral("This command has been retired — there's no more shared password. Just log in with Discord at /gallery/admin on the site, and it'll unlock automatically if you're an admin.");
  }

  if (commandName === 'create_event') {
    if (!isAuthorizedAdmin(userId, env)) return ephemeral("You don't have permission to create events.");
    return buildEventModal('create_event_modal', 'Create an event');
  }

  if (commandName === 'edit_event') {
    if (!isAuthorizedAdmin(userId, env)) return ephemeral("You don't have permission to edit events.");
    const nameOpt = (interaction.data.options || []).find(o => o.name === 'name');
    const searchName = nameOpt ? nameOpt.value : '';
    const existing = await findEventByName(searchName, env);
    if (!existing) return ephemeral(`No event found named "${searchName}".`);

    return buildEventModal(`edit_event_modal:${existing.id}`, 'Edit event', {
      name: existing.name,
      location: (existing.entity_metadata && existing.entity_metadata.location) || '',
      start_time: formatForModal(existing.scheduled_start_time),
      end_time: existing.scheduled_end_time ? formatForModal(existing.scheduled_end_time) : '',
      description: existing.description || ''
    });
  }

  if (commandName === 'delete_event') {
    if (!isAuthorizedAdmin(userId, env)) return ephemeral("You don't have permission to delete events.");
    const nameOpt = (interaction.data.options || []).find(o => o.name === 'name');
    const searchName = nameOpt ? nameOpt.value : '';
    const existing = await findEventByName(searchName, env);
    if (!existing) return ephemeral(`No event found named "${searchName}".`);

    try {
      await deleteScheduledEvent(existing.id, env);
      await announceToChannel(`🗑️ **Event cancelled:** ${existing.name}`, env);
      return ephemeral(`Deleted "${existing.name}". Announced in the announcements channel.`);
    } catch (err) {
      return ephemeral('Could not delete that event: ' + err.message);
    }
  }

  if (commandName === 'talk') {
    if (!isAuthorizedAdmin(userId, env)) return ephemeral("You don't have permission to use this.");
    return buildTalkModal();
  }

  if (commandName === 'admin_help') {
    if (!isAuthorizedAdmin(userId, env)) return ephemeral("You don't have permission to use this.");
    const admins = getAdminUserIds(env);
    const applicationId = interaction.application_id;
    const interactionToken = interaction.token;

    ctx.waitUntil((async () => {
      const { succeeded, failed, total, failures } = await dmAdmins(admins, ADMIN_HELP_TEXT, env);
      let msg = `Sent to ${succeeded}/${total} admins.`;
      if (failed) msg += `\n\n${failed} failed:\n` + failures.map(f => `• ${f}`).join('\n');
      await editDeferredResponse(applicationId, interactionToken, msg);
    })());

    return deferred();
  }

  if (commandName === 'notify_admins') {
    if (!isAuthorizedAdmin(userId, env)) return ephemeral("You don't have permission to use this.");
    const msgOpt = (interaction.data.options || []).find(o => o.name === 'message');
    const message = (msgOpt ? msgOpt.value : '').trim();
    if (!message) return ephemeral('Message cannot be empty.');

    const admins = getAdminUserIds(env);
    const applicationId = interaction.application_id;
    const interactionToken = interaction.token;
    const senderName = getDiscordUsername(interaction);

    ctx.waitUntil((async () => {
      await logNotifyMessage(senderName, userId, message, env);
      const { succeeded, failed, total, failures } = await dmAdmins(admins, `📢 **Admin update:**\n${message}`, env);
      let resultMsg = `Sent to ${succeeded}/${total} admins.`;
      if (failed) resultMsg += `\n\n${failed} failed:\n` + failures.map(f => `• ${f}`).join('\n');
      await editDeferredResponse(applicationId, interactionToken, resultMsg);
    })());

    return deferred();
  }

  if (commandName === 'notify_history') {
    if (!isAuthorizedAdmin(userId, env)) return ephemeral("You don't have permission to use this.");
    const countOpt = (interaction.data.options || []).find(o => o.name === 'count');
    const limit = countOpt ? Math.max(1, Math.min(25, parseInt(countOpt.value, 10) || 10)) : 10;

    const history = await listNotifyHistory(env, limit);
    if (history.length === 0) return ephemeral('No /notify_admins messages have been sent yet.');

    const lines = history.map(entry => {
      const when = new Date(entry.sentAt).toISOString().slice(0, 16).replace('T', ' ');
      return `**${when} UTC** — ${entry.senderName}:\n${entry.message}`;
    });

    let content = `**Last ${history.length} /notify_admins message(s):**\n\n` + lines.join('\n\n');
    if (content.length > 1900) content = content.slice(0, 1900) + '\n\n…(truncated)';

    return ephemeral(content);
  }

  return ephemeral('Unknown command.');
}

async function handleModalSubmit(interaction, env) {
  const userId = getDiscordUserId(interaction);
  if (!isAuthorizedAdmin(userId, env)) return ephemeral("You don't have permission to do this.");

  const customId = interaction.data.custom_id;
  const fields = extractModalFields(interaction);

  if (customId === 'talk_modal') {
    const message = (fields.message || '').trim();
    if (!message) return ephemeral('Message cannot be empty.');
    const ok = await announceToChannel(message, env);
    return ephemeral(ok
      ? 'Sent to the announcements channel.'
      : "Could not post that — check DISCORD_ANNOUNCEMENTS_CHANNEL_ID is set correctly and the bot has permission to post there.");
  }

  const startTime = parseAdminDate(fields.start_time);
  const endTime = parseAdminDate(fields.end_time);

  if (!startTime || isNaN(startTime.getTime())) {
    return ephemeral('Could not understand the start time. Use the format: YYYY-MM-DD HH:MM (UTC).');
  }
  if (!endTime || isNaN(endTime.getTime())) {
    return ephemeral('Could not understand the end time. Use the format: YYYY-MM-DD HH:MM (UTC).');
  }
  if (endTime <= startTime) {
    return ephemeral('The end time needs to be after the start time.');
  }

  const eventFields = {
    name: fields.name,
    description: fields.description,
    location: fields.location,
    startTime,
    endTime
  };

  try {
    if (customId === 'create_event_modal') {
      await createScheduledEvent(eventFields, env);

      let announcement = `📅 **New event: ${fields.name}**\n${discordTimestamp(startTime, 'F')} (${discordTimestamp(startTime, 'R')})`;
      if (fields.location) announcement += `\n📍 ${fields.location}`;
      if (fields.description) announcement += `\n\n${fields.description}`;
      await announceToChannel(announcement, env);

      return ephemeral(`Created "${fields.name}". Announced in the announcements channel.`);
    }
    if (customId.startsWith('edit_event_modal:')) {
      const eventId = customId.split(':')[1];
      await updateScheduledEvent(eventId, eventFields, env);

      let announcement = `✏️ **Event updated: ${fields.name}**\n${discordTimestamp(startTime, 'F')} (${discordTimestamp(startTime, 'R')})`;
      if (fields.location) announcement += `\n📍 ${fields.location}`;
      await announceToChannel(announcement, env);

      return ephemeral(`Updated "${fields.name}". Announced in the announcements channel.`);
    }
  } catch (err) {
    return ephemeral('Something went wrong talking to Discord: ' + err.message);
  }

  return ephemeral('Unknown submission.');
}

async function handleDiscordInteraction(request, env, ctx) {
  const bodyText = await request.text();

  const validSignature = await verifyDiscordSignature(request, bodyText, env);
  if (!validSignature) return new Response('Invalid signature', { status: 401 });

  const interaction = JSON.parse(bodyText);

  if (interaction.type === DISCORD_INTERACTION_PING) {
    return jsonResponse({ type: DISCORD_RESPONSE_PONG });
  }

  if (interaction.type === DISCORD_INTERACTION_APPLICATION_COMMAND) {
    return await handleSlashCommand(interaction, env, ctx);
  }

  if (interaction.type === DISCORD_INTERACTION_MODAL_SUBMIT) {
    return await handleModalSubmit(interaction, env);
  }

  return new Response('Unhandled interaction type', { status: 400 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === '/api/gallery' && request.method === 'GET') {
        const items = await listGallery(env);
        return jsonResponse(items);
      }

      if (pathname === '/api/upload' && request.method === 'POST') {
        return await handleUpload(request, env);
      }

      if (pathname.startsWith('/api/gallery/') && request.method === 'DELETE') {
        const id = pathname.split('/').pop();
        return await handleDelete(request, id, env);
      }

      if (pathname.startsWith('/uploads/') && request.method === 'GET') {
        return await handleServeFile(pathname, env);
      }

      if (pathname === '/api/auth/login' && request.method === 'GET') {
        return await handleAuthLogin(request, env);
      }

      if (pathname === '/api/auth/callback' && request.method === 'GET') {
        return await handleAuthCallback(request, env);
      }

      if (pathname === '/api/auth/me' && request.method === 'GET') {
        return await handleAuthMe(request, env);
      }

      if (pathname === '/api/auth/logout' && request.method === 'POST') {
        return await handleAuthLogout(request, env);
      }

      if (pathname === '/api/events' && request.method === 'GET') {
        return await handleListEventsPublic(env);
      }

      if (pathname === '/api/discord/interactions' && request.method === 'POST') {
        return await handleDiscordInteraction(request, env, ctx);
      }
    } catch (err) {
      return jsonResponse({ error: 'Server error: ' + err.message }, 500);
    }

    // Everything else -> static assets (your existing HTML pages, images, particles.js, etc.)
    return env.ASSETS.fetch(request);
  },

  // Runs on the schedule set in wrangler.jsonc (see "triggers" -> "crons").
  // Compares the current DISCORD_ADMIN_USER_IDS against who was already
  // known, and DMs anyone new with the admin help guide — so adding
  // someone to that list is the only step needed; they get welcomed
  // automatically next time this runs.
  async scheduled(event, env, ctx) {
    await checkForNewAdmins(env);
  }
};
