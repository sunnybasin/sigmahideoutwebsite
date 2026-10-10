// RSVP bot: its own Discord application, its own Cloudflare Worker.
//
// Needs on THIS Worker:
//   secrets: DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN
//   KV binding: PLAYTEST_KV   (internal name, see wrangler.bot-a.jsonc; no need to rename)
//
// /rsvp_create channel_category:<category> [image:<file>]
//     -> opens a popup (name, category, description, where to announce, ping).
//        If the category is "Other", a button appears to type a custom one.
//        Creates: a role, a private text channel (named after the RSVP, inside the
//        chosen Discord category, visible only to people with the role, only admins can
//        talk), and an announcement post with I'm interested / Opt out buttons.
//        Allowed: administrators, plus any role added with /rsvp_roles.
// /rsvp_edit role:<the RSVP's role> [image:<file>] [remove_image:true]
//     -> popup prefilled with the current name, category, and description.
//        Updates the post (keeping its Interested count), and renames the
//        role and private channel if the name changed.
// /rsvp_delete role:<the RSVP's role>
//     -> asks to confirm, then deletes the post, the private channel, and the role.
// /announce
//     -> popup: optional title, message, channel, and who to ping (nobody,
//        @everyone, or a role you pick). Same permission rule as /rsvp_create.
// /rsvp_roles add|remove|list
//     -> manage which roles may create RSVPs. Administrators only.
//
// To close an RSVP: delete its role (the buttons then say it has closed).

const encoder = new TextEncoder();

// permission bits
const ADMINISTRATOR = 8n;
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const READ_HISTORY = 1n << 16n;
const CREATE_PUBLIC_THREADS = 1n << 35n;
const CREATE_PRIVATE_THREADS = 1n << 36n;
const SEND_IN_THREADS = 1n << 38n;

// custom ids
const MODAL_PREFIX = 'rsvp_modal:';
const OTHER_BTN_PREFIX = 'rsvp_other:';
const OTHER_MODAL_PREFIX = 'rsvp_other_modal:';
const ANNOUNCE_MODAL_ID = 'announce_modal';
const EDIT_MODAL_PREFIX = 'rsvp_edit_modal:';
const DEL_YES_PREFIX = 'rsvp_del_yes:';
const DEL_NO_PREFIX = 'rsvp_del_no:';
const BTN_IN = 'ev_in:';
const BTN_OUT = 'ev_out:';

// KV keys
const ALLOWED_ROLES_KEY = 'allowed-roles';
const EVENT_PREFIX = 'event:';
const DRAFT_PREFIX = 'draft:';
const RSVP_PREFIX = 'rsvp:'; // one record per RSVP, keyed by its role id
const EVENT_TTL_SECONDS = 60 * 60 * 24 * 365;
const DRAFT_TTL_SECONDS = 900;

const CATEGORIES = ['Playtest', 'Tournament', 'Hangout', 'Announcement', 'Other'];

const IMAGE_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp'
};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

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

// Sends a DM from the bot. Fails silently if the person has DMs closed.
async function sendDirectMessage(userId, content, env) {
  try {
    const chRes = await discordApi('/users/@me/channels', {
      method: 'POST',
      body: JSON.stringify({ recipient_id: userId })
    }, env);
    if (!chRes.ok) return;
    const channel = await chRes.json();
    await discordApi(`/channels/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } })
    }, env);
  } catch {
    // ignore: the signup itself already worked
  }
}

// Edits the "thinking..." placeholder from a deferred response.
// Uses the interaction token itself, so no Authorization header is needed.
async function editOriginal(interaction, content, clearComponents = false) {
  try {
    const body = { content, allowed_mentions: { parse: [] } };
    if (clearComponents) body.components = [];
    await fetch(
      `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );
  } catch {
    // nothing else we can do
  }
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

// ---------- short-lived drafts (carry data between popup steps) ----------

async function saveDraft(env, draftId, data) {
  await env.PLAYTEST_KV.put(DRAFT_PREFIX + draftId, JSON.stringify(data), {
    expirationTtl: DRAFT_TTL_SECONDS
  });
}

async function loadDraft(env, draftId) {
  const raw = await env.PLAYTEST_KV.get(DRAFT_PREFIX + draftId);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------- RSVP records (what /rsvp_edit and /rsvp_delete look up) ----------

async function loadRsvpRecord(env, roleId) {
  const raw = await env.PLAYTEST_KV.get(RSVP_PREFIX + roleId);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveRsvpRecord(env, record) {
  await env.PLAYTEST_KV.put(RSVP_PREFIX + record.roleId, JSON.stringify(record));
}

// Reads and checks the optional "image" attachment on a command.
// Returns { image } (image is null if none was given) or { error }.
function readImageOption(interaction) {
  const imageOpt = (interaction.data.options || []).find(o => o.name === 'image');
  if (!imageOpt) return { image: null };

  const resolved = interaction.data.resolved || {};
  const att = resolved.attachments && resolved.attachments[imageOpt.value];
  if (!att) return { image: null };

  const contentType = (att.content_type || '').split(';')[0].trim();
  const ext = IMAGE_TYPES[contentType];
  if (!ext) return { error: 'The image must be a PNG, JPG, GIF, or WebP file.' };
  if (att.size > MAX_IMAGE_BYTES) return { error: 'That image is too big. Keep it under 8 MB.' };
  return { image: { url: att.url, ext } };
}

// ---------- who is allowed to create RSVPs ----------

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
    return ephemeral('Only server administrators can manage which roles may create RSVPs.');
  }

  const sub = (interaction.data.options || [])[0];
  if (!sub) return ephemeral('Pick add, remove, or list.');

  const allowed = await getAllowedRoles(env);

  if (sub.name === 'list') {
    if (allowed.length === 0) {
      return ephemeral('No extra roles yet. Only administrators can create RSVPs. Add one with `/rsvp_roles add`.');
    }
    return ephemeral('Roles allowed to create RSVPs (besides administrators):\n' +
      allowed.map(id => `• <@&${id}>`).join('\n'));
  }

  const roleOpt = (sub.options || []).find(o => o.name === 'role');
  const roleId = roleOpt && roleOpt.value;
  if (!roleId) return ephemeral('Pick a role.');

  if (sub.name === 'add') {
    if (allowed.includes(roleId)) return ephemeral(`<@&${roleId}> is already allowed.`);
    allowed.push(roleId);
    await env.PLAYTEST_KV.put(ALLOWED_ROLES_KEY, JSON.stringify(allowed));
    return ephemeral(`Done. Members with <@&${roleId}> can now create RSVPs.`);
  }

  if (sub.name === 'remove') {
    if (!allowed.includes(roleId)) return ephemeral(`<@&${roleId}> wasn't on the list.`);
    const next = allowed.filter(id => id !== roleId);
    await env.PLAYTEST_KV.put(ALLOWED_ROLES_KEY, JSON.stringify(next));
    return ephemeral(`Removed. <@&${roleId}> can no longer create RSVPs.`);
  }

  return ephemeral('Unknown option.');
}

// ---------- step 1: the command, then the popup ----------

function buildRsvpModal(draftId) {
  return json({
    type: 9, // MODAL
    data: {
      custom_id: MODAL_PREFIX + draftId,
      title: 'Create an RSVP',
      components: [
        {
          type: 18, // Label
          label: 'Name of RSVP',
          component: { type: 4, custom_id: 'name', style: 1, required: true, max_length: 100 }
        },
        {
          type: 18,
          label: 'Category',
          component: {
            type: 3, // String Select
            custom_id: 'category',
            required: true,
            min_values: 1,
            max_values: 1,
            placeholder: 'Pick a category',
            options: CATEGORIES.map(c => ({ label: c, value: c }))
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
    return ephemeral("You don't have permission to create RSVPs. Ask an admin to add your role with /rsvp_roles.");
  }

  const opts = interaction.data.options || [];
  const categoryOpt = opts.find(o => o.name === 'channel_category');
  if (!categoryOpt) return ephemeral('Pick a category to create the private channel in.');

  const img = readImageOption(interaction);
  if (img.error) return ephemeral(img.error);
  const image = img.image;

  // The popup can't see the command's options, so keep them for the next step.
  const draftId = interaction.id;
  await saveDraft(env, draftId, {
    parentId: categoryOpt.value,
    image,
    userId: getUserId(interaction)
  });

  return buildRsvpModal(draftId);
}

// ---------- step 2: popup submitted ----------

function startFinalize(interaction, data, draftId, env, ctx) {
  // Creating a role, a channel, and a post can take longer than Discord's
  // 3 second limit, so acknowledge now and finish in the background.
  ctx.waitUntil((async () => {
    let message;
    try {
      message = await finalizeRsvp(interaction, data, env);
    } catch (err) {
      message = 'Something went wrong: ' + err.message;
    }
    try {
      await env.PLAYTEST_KV.delete(DRAFT_PREFIX + draftId);
    } catch {
      // drafts expire on their own
    }
    await editOriginal(interaction, message);
  })());

  return json({ type: 5, data: { flags: 64 } }); // "thinking..." (only you can see it)
}

async function handleRsvpForm(interaction, env, ctx, draftId) {
  if (!interaction.guild_id) return ephemeral('Use this in the server, not in DMs.');
  if (!(await canCreateEvents(interaction, env))) {
    return ephemeral("You don't have permission to create RSVPs.");
  }

  const draft = await loadDraft(env, draftId);
  if (!draft || draft.userId !== getUserId(interaction)) {
    return ephemeral('That form expired. Run /rsvp_create again.');
  }

  const f = readModal(interaction);
  const name = String(first(f.name) || '').trim().slice(0, 100);
  const category = String(first(f.category) || 'Other');
  const description = String(first(f.description) || '').trim().slice(0, 1000);
  const announceChannelId = first(f.channel);
  const pingEveryone = first(f.ping) === 'true';

  if (!name) return ephemeral('The RSVP needs a name.');
  if (!announceChannelId) return ephemeral('Pick a channel to announce in.');

  const data = { ...draft, name, category, description, announceChannelId, pingEveryone };

  if (category === 'Other') {
    // A popup can't answer a popup, so ask with a button that opens the next one.
    await saveDraft(env, draftId, data);
    return json({
      type: 4,
      data: {
        flags: 64,
        content: 'You picked **Other**. Press the button to type your own category.',
        components: [{
          type: 1,
          components: [{
            type: 2,
            style: 1,
            label: 'Type a custom category',
            custom_id: OTHER_BTN_PREFIX + draftId
          }]
        }]
      }
    });
  }

  return startFinalize(interaction, data, draftId, env, ctx);
}

async function handleOtherButton(interaction, env) {
  const draftId = interaction.data.custom_id.slice(OTHER_BTN_PREFIX.length);
  if (!(await canCreateEvents(interaction, env))) {
    return ephemeral("You don't have permission to create RSVPs.");
  }
  const draft = await loadDraft(env, draftId);
  if (!draft || draft.userId !== getUserId(interaction)) {
    return ephemeral('That form expired. Run /rsvp_create again.');
  }

  return json({
    type: 9,
    data: {
      custom_id: OTHER_MODAL_PREFIX + draftId,
      title: 'Custom category',
      components: [{
        type: 18,
        label: 'Custom category',
        component: {
          type: 4,
          custom_id: 'custom_category',
          style: 1,
          required: true,
          max_length: 50,
          placeholder: 'e.g. Movie night'
        }
      }]
    }
  });
}

async function handleCustomCategoryForm(interaction, env, ctx, draftId) {
  if (!(await canCreateEvents(interaction, env))) {
    return ephemeral("You don't have permission to create RSVPs.");
  }
  const draft = await loadDraft(env, draftId);
  if (!draft || draft.userId !== getUserId(interaction)) {
    return ephemeral('That form expired. Run /rsvp_create again.');
  }

  const f = readModal(interaction);
  const custom = String(first(f.custom_category) || '').trim().slice(0, 50);
  const data = { ...draft, category: custom || 'Other' };
  return startFinalize(interaction, data, draftId, env, ctx);
}

// ---------- creating everything ----------

function buildEmbed(name, category, description, count, imageName) {
  const lines = [`Category: ${category}`];
  if (description) lines.push('', description);
  lines.push('', "Press **I'm interested** to sign up and get the role. Press **Opt out** to leave.");

  const embed = {
    title: name.slice(0, 256),
    description: lines.join('\n'),
    color: 0x5865f2,
    fields: [{ name: 'Interested', value: String(count), inline: true }]
  };
  if (imageName) embed.image = { url: 'attachment://' + imageName };
  return embed;
}

function buildButtons(roleId) {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: "I'm interested", emoji: { name: '👍' }, custom_id: BTN_IN + roleId },
      { type: 2, style: 4, label: 'Opt out', custom_id: BTN_OUT + roleId }
    ]
  }];
}

// Private channel: hidden from everyone except the RSVP role (and admins, who
// can always see everything). The role can read but not send or start threads.
function buildPrivateChannelBody(name, parentId, roleId, guildId, botId) {
  const overwrites = [
    { id: guildId, type: 0, allow: '0', deny: VIEW_CHANNEL.toString() }, // @everyone
    {
      id: roleId,
      type: 0,
      allow: (VIEW_CHANNEL | READ_HISTORY).toString(),
      deny: (SEND_MESSAGES | CREATE_PUBLIC_THREADS | CREATE_PRIVATE_THREADS | SEND_IN_THREADS).toString()
    }
  ];
  if (botId) {
    // so the bot itself can't lock itself out of the channel it just made
    overwrites.push({
      id: botId,
      type: 1,
      allow: (VIEW_CHANNEL | SEND_MESSAGES | READ_HISTORY).toString(),
      deny: '0'
    });
  }
  return { name: name.slice(0, 100), type: 0, parent_id: parentId, permission_overwrites: overwrites };
}

async function finalizeRsvp(interaction, d, env) {
  const guildId = interaction.guild_id;

  // 1) download the image first, so a bad image fails before anything is created
  let imageBlob = null;
  let imageName = null;
  if (d.image) {
    const imgRes = await fetch(d.image.url);
    if (!imgRes.ok) return 'Could not download that image. Try uploading it again.';
    imageBlob = await imgRes.blob();
    imageName = 'rsvp-image' + d.image.ext;
  }

  // 2) the role people get when they sign up
  const roleRes = await discordApi(`/guilds/${guildId}/roles`, {
    method: 'POST',
    headers: { 'X-Audit-Log-Reason': 'RSVP created' },
    body: JSON.stringify({ name: d.name, mentionable: true })
  }, env);
  if (!roleRes.ok) {
    const detail = (await roleRes.text()).slice(0, 200);
    return `Could not create the role. Does the bot have Manage Roles? (${detail})`;
  }
  const role = await roleRes.json();

  // 3) the private channel
  const chRes = await discordApi(`/guilds/${guildId}/channels`, {
    method: 'POST',
    headers: { 'X-Audit-Log-Reason': 'RSVP created' },
    body: JSON.stringify(buildPrivateChannelBody(d.name, d.parentId, role.id, guildId, interaction.application_id))
  }, env);
  if (!chRes.ok) {
    const detail = (await chRes.text()).slice(0, 200);
    await discordApi(`/guilds/${guildId}/roles/${role.id}`, { method: 'DELETE' }, env);
    return `Could not create the private channel in that category. Does the bot have Manage Channels? (${detail})`;
  }
  const channel = await chRes.json();

  // 4) the announcement post
  const payload = {
    content: d.pingEveryone ? '@everyone' : undefined,
    embeds: [buildEmbed(d.name, d.category, d.description, 0, imageName)],
    components: buildButtons(role.id),
    allowed_mentions: d.pingEveryone ? { parse: ['everyone'] } : { parse: [] }
  };

  let msgRes;
  if (imageBlob) {
    // Re-upload the image as the bot's own attachment so it never expires.
    const form = new FormData();
    form.append('payload_json', JSON.stringify({
      ...payload,
      attachments: [{ id: 0, filename: imageName }]
    }));
    form.append('files[0]', imageBlob, imageName);
    msgRes = await fetch(`https://discord.com/api/v10/channels/${d.announceChannelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
      body: form
    });
  } else {
    msgRes = await discordApi(`/channels/${d.announceChannelId}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }, env);
  }

  if (!msgRes.ok) {
    const detail = (await msgRes.text()).slice(0, 200);
    // don't leave orphans behind
    await discordApi(`/channels/${channel.id}`, { method: 'DELETE' }, env);
    await discordApi(`/guilds/${guildId}/roles/${role.id}`, { method: 'DELETE' }, env);
    return `Could not post in <#${d.announceChannelId}>. The bot needs View Channel, Send Messages, Embed Links, and Attach Files there` +
      (d.pingEveryone ? ', plus Mention Everyone' : '') + `. Nothing was created. (${detail})`;
  }

  // 5) remember it, so /rsvp_edit and /rsvp_delete can find everything later
  let saveWarning = '';
  try {
    const posted = await msgRes.json();
    await saveRsvpRecord(env, {
      roleId: role.id,
      channelId: channel.id,
      announceChannelId: d.announceChannelId,
      messageId: posted.id,
      guildId,
      name: d.name,
      category: d.category,
      description: d.description,
      createdBy: getUserId(interaction)
    });
  } catch {
    saveWarning = "\n⚠️ I couldn't save this RSVP's details, so /rsvp_edit and /rsvp_delete won't work for it.";
  }

  return `Done! Posted **${d.name}** in <#${d.announceChannelId}>` +
    (d.pingEveryone ? ' with @everyone' : '') + '.\n' +
    `Private channel: <#${channel.id}> (only people who RSVP can see it, and only admins can talk).\n` +
    `Role: <@&${role.id}>` + saveWarning;
}

// ---------- editing and deleting RSVPs ----------
// /rsvp_edit and /rsvp_delete take the RSVP's role, then look up its record
// (post, private channel, role). RSVPs created before this feature existed
// have no record, so they can't be edited or deleted with these commands.
// Same permission rule as /rsvp_create: administrators + roles from /rsvp_roles.

// Acknowledge now and finish in the background (several API calls can exceed
// Discord's 3 second limit). The result replaces the "thinking..." message.
function deferWork(interaction, work, ctx) {
  ctx.waitUntil((async () => {
    let message;
    try {
      message = await work();
    } catch (err) {
      message = 'Something went wrong: ' + err.message;
    }
    await editOriginal(interaction, message);
  })());
  return json({ type: 5, data: { flags: 64 } });
}

async function lookupRsvpFromCommand(interaction, env) {
  const roleOpt = (interaction.data.options || []).find(o => o.name === 'role');
  const roleId = roleOpt && roleOpt.value;
  if (!roleId) return { error: "Pick the RSVP's role." };

  const rec = await loadRsvpRecord(env, roleId);
  if (!rec) {
    return {
      error: "That role isn't an RSVP I can manage. (RSVPs made before editing was added can't be edited or deleted with this command.)"
    };
  }
  if (rec.guildId && rec.guildId !== interaction.guild_id) {
    return { error: 'That RSVP belongs to a different server.' };
  }
  return { rec };
}

function buildEditModal(draftId, rec) {
  const withValue = (input, value) => (value ? { ...input, value: String(value) } : input);
  return json({
    type: 9, // MODAL
    data: {
      custom_id: EDIT_MODAL_PREFIX + draftId,
      title: 'Edit RSVP',
      components: [
        {
          type: 18,
          label: 'Name of RSVP',
          component: withValue({ type: 4, custom_id: 'name', style: 1, required: true, max_length: 100 }, rec.name)
        },
        {
          type: 18,
          label: 'Category',
          component: withValue({ type: 4, custom_id: 'category', style: 1, required: true, max_length: 50 }, rec.category)
        },
        {
          type: 18,
          label: 'Description',
          component: withValue({ type: 4, custom_id: 'description', style: 2, required: false, max_length: 1000 }, rec.description)
        }
      ]
    }
  });
}

async function handleEditCommand(interaction, env) {
  if (!interaction.guild_id) return ephemeral('Use this command in the server, not in DMs.');
  if (!(await canCreateEvents(interaction, env))) {
    return ephemeral("You don't have permission to edit RSVPs. Ask an admin to add your role with /rsvp_roles.");
  }

  const found = await lookupRsvpFromCommand(interaction, env);
  if (found.error) return ephemeral(found.error);

  const img = readImageOption(interaction);
  if (img.error) return ephemeral(img.error);
  const removeOpt = (interaction.data.options || []).find(o => o.name === 'remove_image');
  const removeImage = Boolean(removeOpt && removeOpt.value) && !img.image; // a new image wins

  const draftId = interaction.id;
  await saveDraft(env, draftId, {
    kind: 'edit',
    roleId: found.rec.roleId,
    image: img.image,
    removeImage,
    userId: getUserId(interaction)
  });
  return buildEditModal(draftId, found.rec);
}

async function handleEditForm(interaction, env, ctx, draftId) {
  if (!interaction.guild_id) return ephemeral('Use this in the server, not in DMs.');
  if (!(await canCreateEvents(interaction, env))) {
    return ephemeral("You don't have permission to edit RSVPs.");
  }

  const draft = await loadDraft(env, draftId);
  if (!draft || draft.kind !== 'edit' || draft.userId !== getUserId(interaction)) {
    return ephemeral('That form expired. Run /rsvp_edit again.');
  }

  const f = readModal(interaction);
  const name = String(first(f.name) || '').trim().slice(0, 100);
  const category = String(first(f.category) || '').trim().slice(0, 50);
  const description = String(first(f.description) || '').trim().slice(0, 1000);
  if (!name) return ephemeral('The RSVP needs a name.');

  return deferWork(interaction, async () => {
    const message = await finalizeEdit(interaction, { ...draft, name, category, description }, env);
    try {
      await env.PLAYTEST_KV.delete(DRAFT_PREFIX + draftId);
    } catch {
      // drafts expire on their own
    }
    return message;
  }, ctx);
}

async function finalizeEdit(interaction, d, env) {
  const guildId = interaction.guild_id;
  const rec = await loadRsvpRecord(env, d.roleId);
  if (!rec) return 'That RSVP no longer exists.';

  const name = d.name;
  const category = d.category || rec.category || 'Other';
  const description = d.description;

  // 1) new image, downloaded first so a bad one fails before anything changes
  let imageBlob = null;
  let imageName = null;
  if (d.image) {
    const imgRes = await fetch(d.image.url);
    if (!imgRes.ok) return 'Could not download that image. Try again.';
    imageBlob = await imgRes.blob();
    imageName = 'rsvp-image' + d.image.ext;
  }

  // 2) read the current post, to keep its "Interested" count and image
  const messagePath = `/channels/${rec.announceChannelId}/messages/${rec.messageId}`;
  const getRes = await discordApi(messagePath, { method: 'GET' }, env);
  if (getRes.status === 404) {
    return "The announcement post no longer exists, so there's nothing to edit. Use /rsvp_delete to clean up the role and channel.";
  }
  if (!getRes.ok) return `Could not read the announcement post (${getRes.status}).`;
  const current = await getRes.json();
  const oldEmbed = (current.embeds && current.embeds[0]) || {};
  const countValue = (oldEmbed.fields && oldEmbed.fields[0] && oldEmbed.fields[0].value) || '0';
  const existingAtt = current.attachments && current.attachments[0];

  let embedImageName = null;
  if (imageBlob) embedImageName = imageName;
  else if (!d.removeImage && existingAtt && existingAtt.filename) embedImageName = existingAtt.filename;

  const embed = buildEmbed(name, category, description, countValue, embedImageName);
  if (!embedImageName && !d.removeImage && oldEmbed.image && oldEmbed.image.url) {
    embed.image = { url: oldEmbed.image.url };
  }

  // 3) update the post (buttons and the count stay as they are)
  let patchRes;
  if (imageBlob) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({
      embeds: [embed],
      allowed_mentions: { parse: [] },
      attachments: [{ id: 0, filename: imageName }] // replaces the old image
    }));
    form.append('files[0]', imageBlob, imageName);
    patchRes = await fetch(`https://discord.com/api/v10${messagePath}`, {
      method: 'PATCH',
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
      body: form
    });
  } else {
    const body = { embeds: [embed], allowed_mentions: { parse: [] } };
    if (d.removeImage) body.attachments = [];
    patchRes = await discordApi(messagePath, { method: 'PATCH', body: JSON.stringify(body) }, env);
  }
  if (!patchRes.ok) {
    const detail = (await patchRes.text()).slice(0, 200);
    return `Could not edit the announcement post. (${detail})`;
  }

  // 4) if the name changed, rename the role and the private channel too
  const notes = [];
  if (name !== rec.name) {
    const roleRes = await discordApi(`/guilds/${guildId}/roles/${rec.roleId}`, {
      method: 'PATCH',
      headers: { 'X-Audit-Log-Reason': 'RSVP renamed' },
      body: JSON.stringify({ name })
    }, env);
    if (!roleRes.ok) notes.push("⚠️ I couldn't rename the role.");

    const chRes = await discordApi(`/channels/${rec.channelId}`, {
      method: 'PATCH',
      headers: { 'X-Audit-Log-Reason': 'RSVP renamed' },
      body: JSON.stringify({ name: name.slice(0, 100) })
    }, env);
    if (!chRes.ok) {
      notes.push("⚠️ I couldn't rename the private channel (Discord only allows 2 channel renames per 10 minutes, so try again later).");
    }
  }

  // 5) remember the new details
  try {
    await saveRsvpRecord(env, { ...rec, name, category, description });
  } catch {
    notes.push("⚠️ I couldn't save the new details, so the next edit may show the old text.");
  }

  const imageNote = imageBlob ? ' New image added.' : (d.removeImage ? ' Image removed.' : '');
  return `Updated **${name}**.${imageNote}` + (notes.length ? '\n' + notes.join('\n') : '');
}

async function handleDeleteCommand(interaction, env) {
  if (!interaction.guild_id) return ephemeral('Use this command in the server, not in DMs.');
  if (!(await canCreateEvents(interaction, env))) {
    return ephemeral("You don't have permission to delete RSVPs. Ask an admin to add your role with /rsvp_roles.");
  }

  const found = await lookupRsvpFromCommand(interaction, env);
  if (found.error) return ephemeral(found.error);
  const rec = found.rec;

  // Deleting can't be undone, so ask first.
  return json({
    type: 4,
    data: {
      flags: 64,
      allowed_mentions: { parse: [] },
      content:
        `Delete **${rec.name}**? This permanently deletes:\n` +
        `• the announcement post\n• the private channel <#${rec.channelId}>\n• the role <@&${rec.roleId}> (everyone loses it)\n\n` +
        "This can't be undone.",
      components: [{
        type: 1,
        components: [
          { type: 2, style: 4, label: 'Yes, delete everything', custom_id: DEL_YES_PREFIX + rec.roleId },
          { type: 2, style: 2, label: 'Cancel', custom_id: DEL_NO_PREFIX + rec.roleId }
        ]
      }]
    }
  });
}

async function handleDeleteButton(interaction, env, ctx) {
  const customId = interaction.data.custom_id;

  if (customId.startsWith(DEL_NO_PREFIX)) {
    return json({ type: 7, data: { content: 'Cancelled. Nothing was deleted.', components: [] } });
  }

  if (!(await canCreateEvents(interaction, env))) {
    return ephemeral("You don't have permission to delete RSVPs.");
  }

  const roleId = customId.slice(DEL_YES_PREFIX.length);
  ctx.waitUntil((async () => {
    let message;
    try {
      message = await deleteRsvp(interaction, roleId, env);
    } catch (err) {
      message = 'Something went wrong: ' + err.message;
    }
    await editOriginal(interaction, message, true); // also removes the buttons
  })());

  return json({ type: 6 }); // DEFERRED_UPDATE_MESSAGE: edit the confirmation in place
}

async function deleteRsvp(interaction, roleId, env) {
  const rec = await loadRsvpRecord(env, roleId);
  if (!rec) return 'That RSVP was already deleted.';
  if (rec.guildId && rec.guildId !== interaction.guild_id) return 'That RSVP belongs to a different server.';

  const lines = [];
  let allOk = true;
  // a 404 means it's already gone, which is what we want
  const remove = async (label, path) => {
    const res = await discordApi(path, {
      method: 'DELETE',
      headers: { 'X-Audit-Log-Reason': 'RSVP deleted' }
    }, env);
    if (res.ok || res.status === 404) {
      lines.push(`✅ Deleted the ${label}`);
    } else {
      allOk = false;
      lines.push(`⚠️ Could not delete the ${label} (error ${res.status})`);
    }
  };

  // post first, so nobody can press the buttons while the rest is removed
  await remove('announcement post', `/channels/${rec.announceChannelId}/messages/${rec.messageId}`);
  await remove('private channel', `/channels/${rec.channelId}`);
  await remove('role', `/guilds/${rec.guildId || interaction.guild_id}/roles/${rec.roleId}`);

  if (allOk) {
    try {
      await env.PLAYTEST_KV.delete(RSVP_PREFIX + roleId);
      await env.PLAYTEST_KV.delete(EVENT_PREFIX + roleId);
    } catch {
      // not critical
    }
    return `**${rec.name}** is gone.\n` + lines.join('\n');
  }

  // keep the record so running /rsvp_delete again can finish the job
  return `**${rec.name}** was only partly deleted.\n` + lines.join('\n') +
    '\n\nFix the permission it mentions, then run /rsvp_delete again to finish.';
}

// ---------- announcements ----------
// /announce opens a popup: optional title, message, channel, who to ping, and
// (if you chose "A role") which role. Same permission rule as RSVPs:
// administrators plus any role added with /rsvp_roles.

function buildAnnounceModal() {
  return json({
    type: 9, // MODAL
    data: {
      custom_id: ANNOUNCE_MODAL_ID,
      title: 'Make an announcement',
      components: [
        {
          type: 18, // Label
          label: 'Title',
          description: 'Optional',
          component: { type: 4, custom_id: 'title', style: 1, required: false, max_length: 200 }
        },
        {
          type: 18,
          label: 'Message',
          component: { type: 4, custom_id: 'message', style: 2, required: true, max_length: 4000 }
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
          label: 'Who to ping',
          component: {
            type: 3, // String Select
            custom_id: 'ping',
            required: true,
            min_values: 1,
            max_values: 1,
            options: [
              { label: 'No ping', value: 'none', default: true },
              { label: '@everyone', value: 'everyone' },
              { label: 'A role (pick one below)', value: 'role' }
            ]
          }
        },
        {
          type: 18,
          label: 'Role to ping',
          description: 'Only used if you chose "A role" above',
          component: {
            type: 6, // Role Select
            custom_id: 'role',
            required: false,
            min_values: 0,
            max_values: 1,
            placeholder: 'Pick a role'
          }
        }
      ]
    }
  });
}

async function handleAnnounceCommand(interaction, env) {
  if (!interaction.guild_id) return ephemeral('Use this command in the server, not in DMs.');
  if (!(await canCreateEvents(interaction, env))) {
    return ephemeral("You don't have permission to make announcements. Ask an admin to add your role with /rsvp_roles.");
  }
  return buildAnnounceModal();
}

async function handleAnnounceForm(interaction, env) {
  if (!interaction.guild_id) return ephemeral('Use this in the server, not in DMs.');
  if (!(await canCreateEvents(interaction, env))) {
    return ephemeral("You don't have permission to make announcements.");
  }

  const f = readModal(interaction);
  const title = String(first(f.title) || '').trim().slice(0, 256);
  const message = String(first(f.message) || '').trim().slice(0, 4000);
  const channelId = first(f.channel);
  const pingChoice = first(f.ping) || 'none';
  const roleId = first(f.role);

  if (!message) return ephemeral('The announcement needs a message.');
  if (!channelId) return ephemeral('Pick a channel to announce in.');
  if (pingChoice === 'role' && !roleId) {
    return ephemeral('You chose "A role" but didn\'t pick one. Run /announce again and pick a role.');
  }

  let content;
  let allowedMentions = { parse: [] };
  let pingText = 'no ping';
  if (pingChoice === 'everyone') {
    content = '@everyone';
    allowedMentions = { parse: ['everyone'] };
    pingText = '@everyone';
  } else if (pingChoice === 'role') {
    content = `<@&${roleId}>`;
    allowedMentions = { roles: [roleId] };
    pingText = `<@&${roleId}>`;
  }

  const embed = { description: message, color: 0x5865f2 };
  if (title) embed.title = title;

  const res = await discordApi(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, embeds: [embed], allowed_mentions: allowedMentions })
  }, env);

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    return ephemeral(
      `Could not post in <#${channelId}>. The bot needs View Channel, Send Messages, and Embed Links there` +
      (pingChoice !== 'none' ? ', plus Mention Everyone for pings' : '') + `. (${detail})`
    );
  }

  return ephemeral(`Announcement posted in <#${channelId}> (${pingText}).`);
}

// ---------- buttons on the announcement ----------

async function handleButton(interaction, env, ctx) {
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
      headers: { 'X-Audit-Log-Reason': 'RSVP signup button' }
    },
    env
  );
  if (res.status === 404) return ephemeral('This RSVP has closed.');
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
  const changed = (action === 'in' && !has) || (action === 'out' && has);
  if (action === 'in' && !has) list.push(userId);
  if (action === 'out' && has) list = list.filter(id => id !== userId);
  await env.PLAYTEST_KV.put(key, JSON.stringify(list), { expirationTtl: EVENT_TTL_SECONDS });

  // update the post in place with the new count (text and image stay the same)
  const old = (interaction.message && interaction.message.embeds && interaction.message.embeds[0]) || {};
  const embed = {
    title: old.title || 'RSVP',
    description: old.description || '',
    color: old.color || 0x5865f2,
    fields: [{ name: 'Interested', value: String(list.length), inline: true }]
  };
  const attachment = interaction.message && interaction.message.attachments && interaction.message.attachments[0];
  if (attachment && attachment.filename) {
    embed.image = { url: 'attachment://' + attachment.filename };
  } else if (old.image && old.image.url) {
    embed.image = { url: old.image.url };
  }

  // DM confirmation, only when something actually changed (no spam on repeat clicks).
  // Runs in the background so it never delays the response Discord is waiting for.
  if (changed && ctx) {
    const eventName = old.title || 'the RSVP';
    const link = (interaction.message && interaction.message.id)
      ? `\n<https://discord.com/channels/${interaction.guild_id}/${interaction.channel_id}/${interaction.message.id}>`
      : '';
    const text = action === 'in'
      ? `✅ You're signed up for **${eventName}**. You now have the role, and you can see the private RSVP channel. Press **Opt out** on the post any time to leave.${link}`
      : `👋 You've opted out of **${eventName}** and the role was removed. Press **I'm interested** on the post if you change your mind.${link}`;
    ctx.waitUntil(sendDirectMessage(userId, text, env));
  }

  return json({
    type: 7, // UPDATE_MESSAGE
    data: { embeds: [embed], components: buildButtons(roleId) }
  });
}

// ---------- entry point ----------

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('rsvp bot is running', { status: 200 });
    }

    const { valid, body } = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!valid) return new Response('Bad request signature', { status: 401 });

    const interaction = JSON.parse(body);

    try {
      if (interaction.type === 1) return json({ type: 1 }); // PING

      if (interaction.type === 2) { // slash command
        const name = interaction.data.name;
        if (name === 'rsvp_create') return await handleCreateCommand(interaction, env);
        if (name === 'rsvp_roles') return await handleRolesCommand(interaction, env);
        if (name === 'announce') return await handleAnnounceCommand(interaction, env);
        if (name === 'rsvp_edit') return await handleEditCommand(interaction, env);
        if (name === 'rsvp_delete') return await handleDeleteCommand(interaction, env);
        return ephemeral('Unknown command.');
      }

      if (interaction.type === 3) { // button
        const customId = (interaction.data && interaction.data.custom_id) || '';
        if (customId.startsWith(OTHER_BTN_PREFIX)) return await handleOtherButton(interaction, env);
        if (customId.startsWith(DEL_YES_PREFIX) || customId.startsWith(DEL_NO_PREFIX)) {
          return await handleDeleteButton(interaction, env, ctx);
        }
        return await handleButton(interaction, env, ctx);
      }

      if (interaction.type === 5) { // popup submitted
        const customId = interaction.data.custom_id || '';
        if (customId.startsWith(MODAL_PREFIX)) {
          return await handleRsvpForm(interaction, env, ctx, customId.slice(MODAL_PREFIX.length));
        }
        if (customId.startsWith(OTHER_MODAL_PREFIX)) {
          return await handleCustomCategoryForm(interaction, env, ctx, customId.slice(OTHER_MODAL_PREFIX.length));
        }
        if (customId.startsWith(EDIT_MODAL_PREFIX)) {
          return await handleEditForm(interaction, env, ctx, customId.slice(EDIT_MODAL_PREFIX.length));
        }
        if (customId === ANNOUNCE_MODAL_ID) return await handleAnnounceForm(interaction, env);
        return ephemeral('Unknown form.');
      }
    } catch (err) {
      return ephemeral('Something went wrong: ' + err.message);
    }

    return new Response('Unhandled interaction type', { status: 400 });
  }
};
