#!/bin/bash

set -e

if [ -z "$DISCORD_APPLICATION_ID" ] || [ -z "$DISCORD_BOT_TOKEN" ] || [ -z "$DISCORD_GUILD_ID" ]; then
  echo "Missing environment variables."
  exit 1
fi

GUILD_JSON="$(mktemp)"
GLOBAL_JSON="$(mktemp)"

cleanup() {
  rm -f "$GUILD_JSON" "$GLOBAL_JSON"
}
trap cleanup EXIT

cat > "$GUILD_JSON" << 'PAYLOAD'
[
  {"name":"create_event","description":"Create a server event (opens a popup form) - admins only","type":1,"options":[{"name":"ping_everyone","description":"Ping @everyone in the announcement and day-of reminder (default: no)","type":5}]},
  {"name":"edit_event","description":"Edit an existing server event (opens a popup form) - admins only","type":1,"options":[{"name":"name","description":"The exact current name of the event to edit","type":3,"required":true},{"name":"ping_everyone","description":"Ping @everyone in the update announcement (default: no)","type":5}]},
  {"name":"delete_event","description":"Delete a server event - admins only","type":1,"options":[{"name":"name","description":"The exact name of the event to delete","type":3,"required":true}]},
  {"name":"dm","description":"Send a direct message to a Discord member - admins only","type":1,"options":[{"name":"user","description":"The member to send a DM to","type":6,"required":true},{"name":"message","description":"The message to send (up to 2,000 characters)","type":3,"required":true,"max_length":2000}]},
  {"name":"dm_history","description":"View recent individual DM logs - admins only","type":1,"options":[{"name":"count","description":"How many logs to show (default 10, max 25)","type":4,"min_value":1,"max_value":25}]},
  {"name":"admin_help","description":"DM every admin the how-to-use guide for admin commands - admins only","type":1},
  {"name":"notify_admins","description":"DM every admin a custom update message - admins only","type":1,"options":[{"name":"message","description":"The message to send to every admin","type":3,"required":true}]},
  {"name":"notify_history","description":"Show the last several /notify_admins messages - admins only","type":1,"options":[{"name":"count","description":"How many to show (default 10, max 25)","type":4}]},
  {"name":"talk","description":"Post a message to a channel of your choice via a popup - admins only","type":1,"options":[{"name":"channel","description":"Which channel to post the message in","type":7,"required":true}]}
]
PAYLOAD

cat > "$GLOBAL_JSON" << 'PAYLOAD'
[
  {
    "name": "adminpassword",
    "description": "Retired - log in with Discord at /gallery/admin instead",
    "type": 1,
    "integration_types": [0],
    "contexts": [0, 1]
  }
]
PAYLOAD

echo "Commands in payload:"
grep -o '"name":"[^"]*"' "$GUILD_JSON"

echo ""
echo "Registering guild commands..."

curl -sS -w '\nHTTP STATUS: %{http_code}\n' -X PUT \
  "https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary "@${GUILD_JSON}"

echo ""
echo "Registering global command..."

curl -sS -w '\nHTTP STATUS: %{http_code}\n' -X PUT \
  "https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary "@${GLOBAL_JSON}"

echo ""
echo "Registration requests completed."
