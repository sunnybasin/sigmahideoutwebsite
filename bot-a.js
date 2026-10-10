// Playtest signup bot: its own Discord application, its own Cloudflare Worker.
// Needs (set on THIS Worker only): DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN
//
// /playtest_create name:<text> description:<text, optional>   (administrators only)
//   -> creates a role named after the event and posts a "Sign up" button.
// Pressing the button toggles that role for the person who pressed it.
// To close a playtest, delete the role: the button then says it has closed.

const encoder = new TextEncoder();
const BUTTON_PREFIX = 'playtest_toggle:';
const ADMINISTRATOR = 8n;

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function verifyDiscordRequest(request, publicKey) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  const body = await request.text();
  if (!signature || !timestamp || !publicKey) return { valid: false, body };

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKey),
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const valid = await crypto.subtle.verify(
      'Ed25519',
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
    headers: { 'Content-Type': 'application/json' }
  });
}

function ephemeral(content) {
  return json({ type: 4, data: { content, flags: 64 } });
}

function discordApi(path, options, env) {
  return fetch(`https://discord.com/api/v10${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options && options.headers)
    }
  });
}

function getUserId(interaction) {
  return (interaction.member && interaction.member.user && interaction.member.user.id)
    || (interaction.user && interaction.user.id)
    || null;
}

function isAdministrator(interaction) {
  try {
    const perms = BigInt((interaction.member && interaction.member.permissions) || '0');
    return (perms & ADMINISTRATOR) !== 0n;
  } catch {
    return false;
  }
}

async function handleCreate(interaction, env) {
  if (!interaction.guild_id) return ephemeral('Use this command in the server, not in DMs.');
  if (!isAdministrator(interaction)) return ephemeral('Only server administrators can create playtests.');

  const opts = interaction.data.options || [];
  const nameOpt = opts.find(o => o.name === 'name');
  const descOpt = opts.find(o => o.name === 'description');
  const name = ((nameOpt && nameOpt.value) || '').trim().slice(0, 100);
  const description = ((descOpt && descOpt.value) || '').trim().slice(0, 3500);
  if (!name) return ephemeral('Give the playtest a name.');

  const roleRes = await discordApi(`/guilds/${interaction.guild_id}/roles`, {
    method: 'POST',
    headers: { 'X-Audit-Log-Reason': 'Playtest signup created' },
    body: JSON.stringify({ name, mentionable: true })
  }, env);
  if (!roleRes.ok) {
    const detail = (await roleRes.text()).slice(0, 200);
    return ephemeral(`Could not create the role. Does the bot have Manage Roles? (${detail})`);
  }
  const role = await roleRes.json();

  const body = (description ? description + '\n\n' : '') +
    'Press the button to sign up. Press it again to drop out.';

  return json({
    type: 4,
    data: {
      embeds: [{
        title: `Playtest: ${name}`.slice(0, 256),
        description: body,
        color: 0x5865f2
      }],
      components: [{
        type: 1,
        components: [{
          type: 2,
          style: 1,
          label: 'Sign up',
          emoji: { name: '👍' },
          custom_id: BUTTON_PREFIX + role.id
        }]
      }],
      allowed_mentions: { parse: [] }
    }
  });
}

async function handleButton(interaction, env) {
  const customId = (interaction.data && interaction.data.custom_id) || '';
  if (!customId.startsWith(BUTTON_PREFIX)) return ephemeral('Unknown button.');

  const roleId = customId.slice(BUTTON_PREFIX.length);
  const userId = getUserId(interaction);
  if (!userId || !interaction.guild_id) return ephemeral('This only works inside the server.');

  const hasRole = ((interaction.member && interaction.member.roles) || []).includes(roleId);
  const res = await discordApi(
    `/guilds/${interaction.guild_id}/members/${userId}/roles/${roleId}`,
    {
      method: hasRole ? 'DELETE' : 'PUT',
      headers: { 'X-Audit-Log-Reason': 'Playtest signup button' }
    },
    env
  );

  if (res.status === 404) return ephemeral('This playtest has closed.');
  if (!res.ok) return ephemeral('Could not update your role. An admin may need to check my permissions.');

  return ephemeral(hasRole
    ? "You've been removed from this playtest."
    : "You're signed up! ✅");
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('playtest bot is running', { status: 200 });
    }

    const { valid, body } = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!valid) return new Response('Bad request signature', { status: 401 });

    const interaction = JSON.parse(body);

    try {
      if (interaction.type === 1) return json({ type: 1 }); // PING
      if (interaction.type === 2) {                          // slash command
        if (interaction.data.name === 'playtest_create') return await handleCreate(interaction, env);
        return ephemeral('Unknown command.');
      }
      if (interaction.type === 3) return await handleButton(interaction, env); // button
    } catch (err) {
      return ephemeral('Something went wrong: ' + err.message);
    }

    return new Response('Unhandled interaction type', { status: 400 });
  }
};
