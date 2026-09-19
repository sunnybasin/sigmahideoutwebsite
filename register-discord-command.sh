#!/bin/bash
# Run this ONCE after your Discord app is set up, to register the
# /adminpassword slash command.
#
# This registers it as a GLOBAL command (not scoped to one server) with
# contexts set to allow both server channels AND DMs with the bot. That's
# required for DM support — a guild-scoped command literally cannot be
# used in DMs at all, no matter how it's configured.
#
# Tradeoff: global commands can take up to an hour to show up everywhere
# (guild-scoped ones are instant). Discord's own caching, not something
# this script controls.
#
# This script reads its credentials from environment variables rather
# than having them hardcoded, so it's safe to commit this file to your
# repo — just don't commit the values themselves anywhere.

if [ -z "$DISCORD_APPLICATION_ID" ] || [ -z "$DISCORD_BOT_TOKEN" ]; then
  echo "Missing environment variables. Run it like this instead:"
  echo ""
  echo "  DISCORD_APPLICATION_ID=your_client_id DISCORD_BOT_TOKEN=your_bot_token bash register-discord-command.sh"
  echo ""
  exit 1
fi

curl -X PUT \
  "https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "name": "adminpassword",
      "description": "Get the gallery admin password (Admin role only)",
      "type": 1,
      "integration_types": [0],
      "contexts": [0, 1]
    }
  ]'

echo ""
echo "Done. This can take up to an hour to appear everywhere (Discord's caching, not this script)."
echo "Try /adminpassword both in your server and in a DM with the bot once it shows up."
