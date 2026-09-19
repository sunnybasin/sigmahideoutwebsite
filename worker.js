// Sigma Hideout — gallery Worker
//
// Files go in an R2 bucket, capped at a total storage budget so you never
// pay more than a predictable, tiny amount past R2's 10GB free tier.
// Metadata (caption, uploader, timestamp) stays in Workers KV.
//
// Uploading requires being logged in via Discord (and being a member of
// your server). The admin password used to delete items is distributed
// through a Discord slash command instead of being shared by hand.
//
// Routes:
//   GET    /api/gallery         -> list all uploaded items (newest first)
//   POST   /api/upload          -> accept image/video uploads (requires Discord login)
//   GET    /uploads/<file>      -> serve an uploaded file from R2
//   DELETE /api/gallery/:id     -> remove an item (requires admin password)
//   POST   /api/admin/verify    -> check an admin password
//   GET    /api/auth/login      -> redirect to Discord OAuth2
//   GET    /api/auth/callback   -> Discord sends the user back here after login
//   GET    /api/auth/me         -> current session info, or { loggedIn: false }
//   POST   /api/auth/logout     -> clear the session
//   POST   /api/discord/interactions -> Discord slash-command webhook (the bot)
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
    avatar: session.avatar
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
  const uploader = (formData.get('uploader') || '').toString().trim().slice(0, 40);

  if (!caption) return jsonResponse({ error: 'A caption is required.' }, 400);
  if (!uploader) return jsonResponse({ error: 'Your name is required.' }, 400);

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

function checkAdminPassword(request, env) {
  const provided = request.headers.get('X-Admin-Password') || '';
  return Boolean(env.ADMIN_PASSWORD) && provided === env.ADMIN_PASSWORD;
}

async function handleDelete(request, id, env) {
  if (!checkAdminPassword(request, env)) {
    return jsonResponse({ error: 'Incorrect password.' }, 401);
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

// ---- Discord bot slash command (/adminpassword) ----
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
const DISCORD_RESPONSE_PONG = 1;
const DISCORD_RESPONSE_CHANNEL_MESSAGE = 4;
const DISCORD_EPHEMERAL_FLAG = 64;

function getDiscordUserId(interaction) {
  // In a server: Discord gives us interaction.member.user.id
  // In a DM: Discord gives us interaction.user.id instead
  return (interaction.member && interaction.member.user && interaction.member.user.id)
    || (interaction.user && interaction.user.id)
    || null;
}

function isAuthorizedAdmin(userId, env) {
  if (!userId || !env.DISCORD_ADMIN_USER_IDS) return false;
  const allowed = env.DISCORD_ADMIN_USER_IDS.split(',').map(id => id.trim()).filter(Boolean);
  return allowed.includes(userId);
}

async function handleDiscordInteraction(request, env) {
  const bodyText = await request.text();

  const validSignature = await verifyDiscordSignature(request, bodyText, env);
  if (!validSignature) return new Response('Invalid signature', { status: 401 });

  const interaction = JSON.parse(bodyText);

  if (interaction.type === DISCORD_INTERACTION_PING) {
    return jsonResponse({ type: DISCORD_RESPONSE_PONG });
  }

  if (interaction.type === DISCORD_INTERACTION_APPLICATION_COMMAND) {
    if (interaction.data && interaction.data.name === 'adminpassword') {
      const userId = getDiscordUserId(interaction);
      const isAuthorized = isAuthorizedAdmin(userId, env);

      const content = isAuthorized
        ? (env.ADMIN_PASSWORD
            ? `The gallery admin password is: \`${env.ADMIN_PASSWORD}\``
            : 'ADMIN_PASSWORD isn\'t set on the server yet — ask whoever manages the Worker to set it.')
        : "You don't have permission to use this command.";

      return jsonResponse({
        type: DISCORD_RESPONSE_CHANNEL_MESSAGE,
        data: { content, flags: DISCORD_EPHEMERAL_FLAG }
      });
    }

    return jsonResponse({
      type: DISCORD_RESPONSE_CHANNEL_MESSAGE,
      data: { content: 'Unknown command.', flags: DISCORD_EPHEMERAL_FLAG }
    });
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

      if (pathname === '/api/admin/verify' && request.method === 'POST') {
        return jsonResponse({ ok: checkAdminPassword(request, env) }, checkAdminPassword(request, env) ? 200 : 401);
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

      if (pathname === '/api/discord/interactions' && request.method === 'POST') {
        return await handleDiscordInteraction(request, env);
      }
    } catch (err) {
      return jsonResponse({ error: 'Server error: ' + err.message }, 500);
    }

    // Everything else -> static assets (your existing HTML pages, images, particles.js, etc.)
    return env.ASSETS.fetch(request);
  }
};
