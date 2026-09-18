// Sigma Hideout — gallery Worker
//
// Handles:
//   GET    /api/gallery        -> list all uploaded items (newest first)
//   POST   /api/upload         -> accept image/video uploads (multipart form)
//   GET    /uploads/<filename> -> serve an uploaded file from R2
//   DELETE /api/gallery/:id    -> remove an item (see warning in README)
//
// Everything else falls through to the static site (env.ASSETS).

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/ogg'
]);

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB — adjust to fit your Cloudflare plan's request-body limit
const KV_PREFIX = 'item:';

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

async function listGallery(env) {
  const items = [];
  let cursor;
  do {
    const page = await env.GALLERY_KV.list({ prefix: KV_PREFIX, cursor });
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

  const saved = [];
  for (const file of files) {
    if (!ALLOWED_MIME.has(file.type)) {
      return jsonResponse({ error: `Unsupported file type: ${file.type || 'unknown'}` }, 400);
    }
    if (file.size > MAX_FILE_SIZE) {
      return jsonResponse({ error: `${file.name} is too large (max 100MB).` }, 413);
    }

    const id = crypto.randomUUID();
    const ext = extFromMime(file.type);
    const objectKey = `uploads/${id}${ext}`;

    await env.GALLERY_BUCKET.put(objectKey, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type }
    });

    const entry = {
      id,
      objectKey,
      url: `/${objectKey}`,
      type: file.type.startsWith('video') ? 'video' : 'image',
      mimetype: file.type,
      caption,
      uploader,
      uploadedAt: Date.now()
    };

    await env.GALLERY_KV.put(KV_PREFIX + id, JSON.stringify(entry));
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
  const key = KV_PREFIX + id;
  const raw = await env.GALLERY_KV.get(key);
  if (!raw) return jsonResponse({ error: 'Not found' }, 404);

  const entry = JSON.parse(raw);
  await env.GALLERY_BUCKET.delete(entry.objectKey);
  await env.GALLERY_KV.delete(key);
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
