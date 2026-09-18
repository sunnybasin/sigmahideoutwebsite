// Sigma Hideout — gallery Worker
//
// Stores everything in Workers KV — no R2, no payment method required.
// (KV's free tier needs no card on file; R2 does, even though R2 usage
// itself would be free too. This trades that off for a 25MB-per-file cap.)
//
// Handles:
//   GET    /api/gallery       -> list all uploaded items (newest first)
//   POST   /api/upload        -> accept image/video uploads (multipart form)
//   GET    /uploads/<id>      -> serve an uploaded file from KV
//   DELETE /api/gallery/:id   -> remove an item (see warning in README)
//
// Everything else falls through to the static site (env.ASSETS).

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/ogg'
]);

// KV caps a single value at 25MB — stay comfortably under that.
const MAX_FILE_SIZE = 24 * 1024 * 1024;
const ITEM_PREFIX = 'item:';
const FILE_PREFIX = 'file:';

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

  const saved = [];
  for (const file of files) {
    if (!ALLOWED_MIME.has(file.type)) {
      return jsonResponse({ error: `Unsupported file type: ${file.type || 'unknown'}` }, 400);
    }
    if (file.size > MAX_FILE_SIZE) {
      return jsonResponse({ error: `${file.name} is too large (max 24MB per file on this setup).` }, 413);
    }

    const id = crypto.randomUUID();

    // Store the raw file bytes under file:<id>, with its content-type as KV metadata
    // so serving it back later takes a single read.
    await env.GALLERY_KV.put(FILE_PREFIX + id, await file.arrayBuffer(), {
      metadata: { contentType: file.type }
    });

    const entry = {
      id,
      url: `/uploads/${id}`,
      type: file.type.startsWith('video') ? 'video' : 'image',
      mimetype: file.type,
      caption,
      uploader,
      uploadedAt: Date.now()
    };

    await env.GALLERY_KV.put(ITEM_PREFIX + id, JSON.stringify(entry));
    saved.push(entry);
  }

  return jsonResponse({ ok: true, items: saved });
}

async function handleServeFile(id, env) {
  const result = await env.GALLERY_KV.getWithMetadata(FILE_PREFIX + id, 'arrayBuffer');
  if (!result || !result.value) return new Response('Not found', { status: 404 });

  const contentType = (result.metadata && result.metadata.contentType) || 'application/octet-stream';
  return new Response(result.value, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=604800' // 7 days
    }
  });
}

async function handleDelete(id, env) {
  const key = ITEM_PREFIX + id;
  const raw = await env.GALLERY_KV.get(key);
  if (!raw) return jsonResponse({ error: 'Not found' }, 404);

  await env.GALLERY_KV.delete(FILE_PREFIX + id);
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
        const id = pathname.split('/').pop();
        return await handleServeFile(id, env);
      }
    } catch (err) {
      return jsonResponse({ error: 'Server error: ' + err.message }, 500);
    }

    // Everything else -> static assets (your existing HTML pages, images, particles.js, etc.)
    return env.ASSETS.fetch(request);
  }
};
