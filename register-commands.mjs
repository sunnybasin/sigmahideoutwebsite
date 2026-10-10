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
  { name: "ping", description: "Check that the bot is alive", type: 1 },
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
