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

# Fill in the two values below, or export them as env vars before running.

APPLICATION_ID="REPLACE_WITH_YOUR_CLIENT_ID"
BOT_TOKEN="REPLACE_WITH_YOUR_BOT_TOKEN"

curl -X PUT \
  "https://discord.com/api/v10/applications/${APPLICATION_ID}/commands" \
  -H "Authorization: Bot ${BOT_TOKEN}" \
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
