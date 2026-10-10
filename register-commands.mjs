// Run locally (Node 18+) to register the bot's slash commands.
// Replaces the bot's whole command list, so old ones (/playtest_create etc.) disappear.
//
// Git Bash:
//   export DISCORD_TOKEN="..." DISCORD_APPLICATION_ID="..."
//   node register-commands.mjs
// PowerShell:
//   $env:DISCORD_TOKEN="..."; $env:DISCORD_APPLICATION_ID="..."; node register-commands.mjs

const { DISCORD_TOKEN, DISCORD_APPLICATION_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_APPLICATION_ID) {
  console.error("Set DISCORD_TOKEN and DISCORD_APPLICATION_ID first.");
  process.exit(1);
}

const commands = [
  {
    // Visible to everyone so allowed roles can use it; the Worker itself
    // refuses anyone who isn't an admin or an allowed role.
    name: "rsvp_create",
    description: "Create an RSVP with a signup button, role, and private channel",
    type: 1,
    options: [
      {
        type: 7, // CHANNEL
        name: "channel_category",
        description: "Discord category to create the private RSVP channel in",
        required: true,
        channel_types: [4], // category channels only
      },
      {
        type: 11, // ATTACHMENT
        name: "image",
        description: "Optional image for the RSVP post (PNG, JPG, GIF, or WebP, up to 8 MB)",
        required: false,
      },
    ],
  },
  {
    name: "rsvp_edit",
    description: "Edit an RSVP's name, category, description, or image",
    type: 1,
    options: [
      { type: 8, name: "role", description: "The RSVP's role", required: true },
      {
        type: 11, // ATTACHMENT
        name: "image",
        description: "Optional new image (replaces the old one)",
        required: false,
      },
      {
        type: 5, // BOOLEAN
        name: "remove_image",
        description: "Remove the RSVP's image",
        required: false,
      },
    ],
  },
  {
    name: "rsvp_delete",
    description: "Delete an RSVP, its private channel, and its role",
    type: 1,
    options: [{ type: 8, name: "role", description: "The RSVP's role", required: true }],
  },
  {
    // Same as /rsvp_create: visible to everyone, the Worker enforces who may use it.
    name: "announce",
    description: "Post an announcement and choose who to ping",
    type: 1,
  },
  {
    name: "rsvp_roles",
    description: "Choose which roles can create RSVPs (admins only)",
    type: 1,
    default_member_permissions: "8", // hidden from non-administrators
    options: [
      {
        type: 1, // subcommand
        name: "add",
        description: "Let a role create RSVPs",
        options: [{ type: 8, name: "role", description: "Role to allow", required: true }],
      },
      {
        type: 1,
        name: "remove",
        description: "Stop a role from creating RSVPs",
        options: [{ type: 8, name: "role", description: "Role to remove", required: true }],
      },
      { type: 1, name: "list", description: "Show which roles can create RSVPs" },
    ],
  },
];

const res = await fetch(
  `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands`,
  {
    method: "PUT",
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  }
);

if (res.ok) {
  const created = await res.json();
  console.log(res.status, "Commands registered:");
  for (const c of created) console.log("  /" + c.name);
} else {
  console.log(res.status, "FAILED:");
  console.log(await res.text());
}
