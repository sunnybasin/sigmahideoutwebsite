// Run locally (Node 18+) to register slash commands for bot-a:
//   DISCORD_TOKEN=xxx DISCORD_APPLICATION_ID=yyy node register-commands.mjs
// On Windows PowerShell:
//   $env:DISCORD_TOKEN="xxx"; $env:DISCORD_APPLICATION_ID="yyy"; node register-commands.mjs

const { DISCORD_TOKEN, DISCORD_APPLICATION_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_APPLICATION_ID) {
  console.error("Set DISCORD_TOKEN and DISCORD_APPLICATION_ID first.");
  process.exit(1);
}

const commands = [
  {
    name: "playtest_create",
    description: "Create a playtest signup button and role",
    type: 1,
    default_member_permissions: "8", // hidden from non-administrators
    options: [
      { type: 3, name: "name", description: "Playtest name (also the role name)", required: true },
      { type: 3, name: "description", description: "Date, time, details", required: false },
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
