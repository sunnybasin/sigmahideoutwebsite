// Run locally (Node 18+) to register the bot's slash commands.
// Replaces the bot's whole command list, so old ones like /ping disappear.
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
    name: "playtest_create",
    description: "Create an event with a signup button and role",
    type: 1,
  },
  {
    name: "playtest_roles",
    description: "Choose which roles can create events (admins only)",
    type: 1,
    default_member_permissions: "8", // hidden from non-administrators
    options: [
      {
        type: 1, // subcommand
        name: "add",
        description: "Let a role create events",
        options: [{ type: 8, name: "role", description: "Role to allow", required: true }],
      },
      {
        type: 1,
        name: "remove",
        description: "Stop a role from creating events",
        options: [{ type: 8, name: "role", description: "Role to remove", required: true }],
      },
      { type: 1, name: "list", description: "Show which roles can create events" },
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

console.log(res.status, res.ok ? "Commands registered." : await res.text());
