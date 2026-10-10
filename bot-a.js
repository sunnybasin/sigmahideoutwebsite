// Minimal Discord interactions bot for Cloudflare Workers.
// Secrets required (set per Worker): DISCORD_PUBLIC_KEY

const encoder = new TextEncoder();

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function verifyDiscordRequest(request, publicKey) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  const body = await request.text();
  if (!signature || !timestamp || !publicKey) return { valid: false, body };

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKey),
      { name: "NODE-ED25519", namedCurve: "NODE-ED25519" },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "NODE-ED25519",
      key,
      hexToBytes(signature),
      encoder.encode(timestamp + body)
    );
    return { valid, body };
  } catch {
    return { valid: false, body };
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    // Browsers / uptime checks
    if (request.method !== "POST") {
      return new Response("bot-a is running", { status: 200 });
    }

    const { valid, body } = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!valid) {
      return new Response("Bad request signature", { status: 401 });
    }

    const interaction = JSON.parse(body);

    // 1 = PING (Discord uses this to validate your endpoint URL)
    if (interaction.type === 1) {
      return json({ type: 1 });
    }

    // 2 = slash command
    if (interaction.type === 2) {
      switch (interaction.data.name) {
        case "ping":
          return json({ type: 4, data: { content: "Pong! 🏓" } });
        default:
          return json({
            type: 4,
            data: { content: "Unknown command.", flags: 64 },
          });
      }
    }

    return new Response("Unhandled interaction type", { status: 400 });
  },
};
