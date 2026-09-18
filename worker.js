// Sigma Hideout — gallery Worker
//
// Files go in an R2 bucket, capped at a total storage budget so you never
// pay more than a predictable, tiny amount past R2's 10GB free tier.
// Metadata (caption, uploader, timestamp) stays in Workers KV.
//
// Handles:
//   GET    /api/gallery       -> list all uploaded items (newest first)
//   POST   /api/upload        -> accept image/video uploads (multipart form)
//   GET    /uploads/<file>    -> serve an uploaded file from R2
//   DELETE /api/gallery/:id   -> remove an item (see warning in README)
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

function extFromMime(mime) {
  const map = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/avif': '.avif',
    'video/mp4': '.mp4', 'video/webm': '.webm',
    'video/quicktime': '.mov', 'video/ogg': '.ogv'
  };
  return map[mime] || '';
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ---- Storage usage tracking (KV counter, self-healing from R2 if missing) ----

async function getUsedBytes(env) {
  const raw = await env.GALLERY_KV.get(USAGE_KEY);
  if (raw !== null) return parseInt(raw, 10) || 0;

  // First run, or counter got lost somehow — recompute from R2 directly.
  let total = 0;
  let cursor;
  do {
    const page = await env.GALLERY_BUCKET.list({ cursor });
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

  const caption = (formData.get('caption') || '').toString().slice(0, 200);
  const uploader = (formData.get('uploader') || 'anonymous').toString().slice(0, 40) || 'anonymous';

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

    await env.GALLERY_BUCKET.put(objectKey, await file.arrayBuffer(), {
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
      uploadedAt: Date.now()
    };

    await env.GALLERY_KV.put(ITEM_PREFIX + id, JSON.stringify(entry));
    saved.push(entry);
  }

  return jsonResponse({ ok: true, items: saved });
}

async function handleServeFile(pathname, env) {
  const objectKey = pathname.replace(/^\//, ''); // "uploads/<id>.<ext>"
  const object = await env.GALLERY_BUCKET.get(objectKey);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=604800'); // 7 days

  return new Response(object.body, { headers });
}

async function handleDelete(id, env) {
  const key = ITEM_PREFIX + id;
  const raw = await env.GALLERY_KV.get(key);
  if (!raw) return jsonResponse({ error: 'Not found' }, 404);

  const entry = JSON.parse(raw);
  await env.GALLERY_BUCKET.delete(entry.objectKey);
  await env.GALLERY_KV.delete(key);
  if (typeof entry.size === 'number') {
    await adjustUsedBytes(env, -entry.size);
  }
  return jsonResponse({ ok: true });
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
        return await handleDelete(id, env);
      }

      if (pathname.startsWith('/uploads/') && request.method === 'GET') {
        return await handleServeFile(pathname, env);
      }
    } catch (err) {
      return jsonResponse({ error: 'Server error: ' + err.message }, 500);
    }

    // Everything else -> static assets (your existing HTML pages, images, particles.js, etc.)
    return env.ASSETS.fetch(request);
  }
};
