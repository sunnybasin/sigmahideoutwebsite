// Event signup bot: its own Discord application, its own Cloudflare Worker.
//
// Needs on THIS Worker:
//   secrets: DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN
//   KV binding: PLAYTEST_KV   (see wrangler.bot-a.jsonc)
//
// /playtest_create  -> popup form: name, type, description, channel, ping.
//                      Allowed: administrators, plus any role added with /playtest_roles.
// /playtest_roles   -> add / remove / list the roles allowed to create events.
//                      Administrators only.
// The posted message has "I'm interested" and "Opt out" buttons and a live
// interested count. Interested people get a role named after the event.
// To close an event, delete its role: the buttons then say it has closed.

const encoder = new TextEncoder();

const ADMINISTRATOR = 8n;
const MODAL_ID = 'event_modal';
const BTN_IN = 'ev_in:';
const BTN_OUT = 'ev_out:';
const ALLOWED_ROLES_KEY = 'allowed-roles';
const EVENT_PREFIX = 'event:';
const EVENT_TTL_SECONDS = 60 * 60 * 24 * 365;
const EVENT_TYPES = ['Playtest', 'Tournament', 'Hangout', 'Announcement', 'Other'];

// ---------- helpers ----------

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
  return json({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
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

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

// Reads submitted modal values whether components are wrapped in a Label
// (row.component) or an older-style action row (row.components[0]).
function readModal(interaction) {
  const out = {};
  for (const row of (interaction.data.components || [])) {
    const comp = row.component || (row.components && row.components[0]);
    if (!comp || !comp.custom_id) continue;
    out[comp.custom_id] = comp.values !== undefined ? comp.values : comp.value;
  }
  return out;
}

// ---------- who is allowed to create events ----------

async function getAllowedRoles(env) {
  const raw = await env.PLAYTEST_KV.get(ALLOWED_ROLES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function canCreateEvents(interaction, env) {
  if (isAdministrator(interaction)) return true;
  const memberRoles = (interaction.member && interaction.member.roles) || [];
  if (memberRoles.length === 0) return false;
  const allowed = await getAllowedRoles(env);
  return memberRoles.some(r => allowed.includes(r));
}

async function handleRolesCommand(interaction, env) {
  if (!interaction.guild_id) return ephemeral('Use this command in the server, not in DMs.');
  if (!isAdministrator(interaction)) {
    return ephemeral('Only server administrators can manage which roles may create events.');
  }

  const sub = (interaction.data.options || [])[0];
  if (!sub) return ephemeral('Pick add, remove, or list.');

  const allowed = await getAllowedRoles(env);

  if (sub.name === 'list') {
    if (allowed.length === 0) {
      return ephemeral('No extra roles yet. Only administrators can create events. Add one with `/playtest_roles add`.');
    }
    return ephemeral('Roles allowed to create events (besides administrators):\n' +
      allowed.map(id => `• <@&${id}>`).join('\n'));
  }

  const roleOpt = (sub.options || []).find(o => o.name === 'role');
  const roleId = roleOpt && roleOpt.value;
  if (!roleId) return ephemeral('Pick a role.');

  if (sub.name === 'add') {
    if (allowed.includes(roleId)) return ephemeral(`<@&${roleId}> is already allowed.`);
    allowed.push(roleId);
    await env.PLAYTEST_KV.put(ALLOWED_ROLES_KEY, JSON.stringify(allowed));
    return ephemeral(`Done. Members with <@&${roleId}> can now create events.`);
  }

  if (sub.name === 'remove') {
    if (!allowed.includes(roleId)) return ephemeral(`<@&${roleId}> wasn't on the list.`);
    const next = allowed.filter(id => id !== roleId);
    await env.PLAYTEST_KV.put(ALLOWED_ROLES_KEY, JSON.stringify(next));
    return ephemeral(`Removed. <@&${roleId}> can no longer create events.`);
  }

  return ephemeral('Unknown option.');
}

// ---------- the popup form ----------

function buildEventModal() {
  return json({
    type: 9, // MODAL
    data: {
      custom_id: MODAL_ID,
      title: 'Create an event',
      components: [
        {
          type: 18, // Label
          label: 'Name of event',
          component: { type: 4, custom_id: 'name', style: 1, required: true, max_length: 100 }
        },
        {
          type: 18,
          label: 'Type of event',
          component: {
            type: 3, // String Select
            custom_id: 'type',
            required: true,
            min_values: 1,
            max_values: 1,
            placeholder: 'Pick a type',
            options: EVENT_TYPES.map(t => ({ label: t, value: t }))
          }
        },
        {
          type: 18,
          label: 'Description',
          component: { type: 4, custom_id: 'description', style: 2, required: false, max_length: 1000 }
        },
        {
          type: 18,
          label: 'Where to announce',
          component: {
            type: 8, // Channel Select
            custom_id: 'channel',
            required: true,
            min_values: 1,
            max_values: 1,
            channel_types: [0, 5], // text + announcement channels
            placeholder: 'Pick a channel'
          }
        },
        {
          type: 18,
          label: 'Ping @everyone?',
          component: {
            type: 3,
            custom_id: 'ping',
            required: true,
            min_values: 1,
            max_values: 1,
            options: [
              { label: 'No', value: 'false', default: true },
              { label: 'Yes', value: 'true' }
            ]
          }
        }
      ]
    }
  });
}

async function handleCreateCommand(interaction, env) {
  if (!interaction.guild_id) return ephemeral('Use this command in the server, not in DMs.');
  if (!(await canCreateEvents(interaction, env))) {
    return ephemeral("You don't have permission to create events. Ask an admin to add your role with /playtest_roles.");
  }
  return buildEventModal();
}

// ---------- the posted message ----------

function buildButtons(roleId) {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: "I'm interested", emoji: { name: '👍' }, custom_id: BTN_IN + roleId },
      { type: 2, style: 4, label: 'Opt out', custom_id: BTN_OUT + roleId }
    ]
  }];
}

function buildEmbed(type, name, description, count) {
  return {
    title: `${type}: ${name}`.slice(0, 256),
    description: (description ? description + '\n\n' : '') +
      "Press **I'm interested** to sign up and get the role. Press **Opt out** to leave.",
    color: 0x5865f2,
    fields: [{ name: 'Interested', value: String(count), inline: true }]
  };
}

async function handleModalSubmit(interaction, env) {
  if (interaction.data.custom_id !== MODAL_ID) return ephemeral('Unknown form.');
  if (!interaction.guild_id) return ephemeral('Use this in the server, not in DMs.');
  if (!(await canCreateEvents(interaction, env))) {
    return ephemeral("You don't have permission to create events.");
  }

  const f = readModal(interaction);
  const name = String(first(f.name) || '').trim().slice(0, 100);
  const type = String(first(f.type) || 'Event');
  const description = String(first(f.description) || '').trim().slice(0, 1000);
  const channelId = first(f.channel);
  const pingEveryone = first(f.ping) === 'true';

  if (!name) return ephemeral('The event needs a name.');
  if (!channelId) return ephemeral('Pick a channel to announce in.');

  // 1) the role people receive when they sign up
  const roleRes = await discordApi(`/guilds/${interaction.guild_id}/roles`, {
    method: 'POST',
    headers: { 'X-Audit-Log-Reason': 'Event signup created' },
    body: JSON.stringify({ name, mentionable: true })
  }, env);
  if (!roleRes.ok) {
    const detail = (await roleRes.text()).slice(0, 200);
    return ephemeral(`Could not create the role. Does the bot have Manage Roles? (${detail})`);
  }
  const role = await roleRes.json();

  // 2) the announcement with buttons
  const msgRes = await discordApi(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: pingEveryone ? '@everyone' : undefined,
      embeds: [buildEmbed(type, name, description, 0)],
      components: buildButtons(role.id),
      allowed_mentions: pingEveryone ? { parse: ['everyone'] } : { parse: [] }
    })
  }, env);

  if (!msgRes.ok) {
    const detail = (await msgRes.text()).slice(0, 200);
    // don't leave an orphan role behind
    await discordApi(`/guilds/${interaction.guild_id}/roles/${role.id}`, { method: 'DELETE' }, env);
    return ephemeral(
      `Could not post in <#${channelId}>. The bot needs View Channel, Send Messages, and Embed Links there` +
      (pingEveryone ? ', plus Mention Everyone' : '') + `. (${detail})`
    );
  }

  return ephemeral(`Posted "${name}" in <#${channelId}>` + (pingEveryone ? ' with @everyone.' : '.'));
}

// ---------- buttons ----------

async function handleButton(interaction, env) {
  const customId = (interaction.data && interaction.data.custom_id) || '';
  let action;
  let roleId;
  if (customId.startsWith(BTN_IN)) {
    action = 'in';
    roleId = customId.slice(BTN_IN.length);
  } else if (customId.startsWith(BTN_OUT)) {
    action = 'out';
    roleId = customId.slice(BTN_OUT.length);
  } else {
    return ephemeral('Unknown button.');
  }

  const userId = getUserId(interaction);
  if (!userId || !interaction.guild_id) return ephemeral('This only works inside the server.');

  const res = await discordApi(
    `/guilds/${interaction.guild_id}/members/${userId}/roles/${roleId}`,
    {
      method: action === 'in' ? 'PUT' : 'DELETE',
      headers: { 'X-Audit-Log-Reason': 'Event signup button' }
    },
    env
  );
  if (res.status === 404) return ephemeral('This event has closed.');
  if (!res.ok) return ephemeral('Could not update your role. An admin may need to check my permissions.');

  // keep a list of interested people so the count can be shown
  const key = EVENT_PREFIX + roleId;
  let list = [];
  try {
    const raw = await env.PLAYTEST_KV.get(key);
    if (raw) list = JSON.parse(raw);
  } catch {
    list = [];
  }
  const has = list.includes(userId);
  if (action === 'in' && !has) list.push(userId);
  if (action === 'out' && has) list = list.filter(id => id !== userId);
  await env.PLAYTEST_KV.put(key, JSON.stringify(list), { expirationTtl: EVENT_TTL_SECONDS });

  // update the message in place with the new count
  const old = (interaction.message && interaction.message.embeds && interaction.message.embeds[0]) || {};
  const embed = {
    title: old.title || 'Event',
    description: old.description || '',
    color: old.color || 0x5865f2,
    fields: [{ name: 'Interested', value: String(list.length), inline: true }]
  };

  return json({
    type: 7, // UPDATE_MESSAGE
    data: { embeds: [embed], components: buildButtons(roleId) }
  });
}

// ---------- entry point ----------

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('event bot is running', { status: 200 });
    }

    const { valid, body } = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!valid) return new Response('Bad request signature', { status: 401 });

    const interaction = JSON.parse(body);

    try {
      if (interaction.type === 1) return json({ type: 1 }); // PING

      if (interaction.type === 2) { // slash command
        const name = interaction.data.name;
        if (name === 'playtest_create') return await handleCreateCommand(interaction, env);
        if (name === 'playtest_roles') return await handleRolesCommand(interaction, env);
        return ephemeral('Unknown command.');
      }

      if (interaction.type === 3) return await handleButton(interaction, env);       // button
      if (interaction.type === 5) return await handleModalSubmit(interaction, env);  // popup submitted
    } catch (err) {
      return ephemeral('Something went wrong: ' + err.message);
    }

    return new Response('Unhandled interaction type', { status: 400 });
  }
};
