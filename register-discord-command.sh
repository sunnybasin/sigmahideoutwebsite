#!/bin/bash
# Run this ONCE after your Discord app is set up, to register all of the
# site's slash commands.
#
# - create_event, edit_event, delete_event, admin_help, notify_admins,
#   notify_history, talk are all registered as GUILD commands (scoped to
#   your one server via DISCORD_GUILD_ID). Guild commands show up
#   instantly and only make sense in a server anyway - no reason to make
#   them global.
# - adminpassword (retired, but harmless to leave registered) stays a
#   GLOBAL command with DM support, since that's what it was set up as
#   originally.
#
# JSON payloads are written to temp files and sent with --data-binary
# @file rather than passed inline on the command line. This avoids
# shell-specific quoting/encoding issues (seen on Git Bash on Windows)
# that can otherwise corrupt a long, multi-line, quoted string.
#
# This script reads its credentials from environment variables rather
# than having them hardcoded, so it's safe to commit this file to your
# repo - just don't commit the values themselves anywhere.

if [ -z "$DISCORD_APPLICATION_ID" ] || [ -z "$DISCORD_BOT_TOKEN" ] || [ -z "$DISCORD_GUILD_ID" ]; then
  echo "Missing environment variables. Run it like this instead:"
  echo ""
  echo "  DISCORD_APPLICATION_ID=your_client_id DISCORD_BOT_TOKEN=your_bot_token DISCORD_GUILD_ID=your_server_id bash register-discord-command.sh"
  echo ""
  exit 1
fi

GUILD_JSON="$(mktemp)"
GLOBAL_JSON="$(mktemp)"

cat > "$GUILD_JSON" << 'PAYLOAD'
[
  {
    "name": "create_event",
    "description": "Create a server event (opens a popup form) - admins only",
    "type": 1
  },
  {
    "name": "edit_event",
    "description": "Edit an existing server event (opens a popup form) - admins only",
    "type": 1,
    "options": [
      {
        "name": "name",
        "description": "The exact current name of the event to edit",
        "type": 3,
        "required": true
      }
    ]
  },
  {
    "name": "delete_event",
    "description": "Delete a server event - admins only",
    "type": 1,
    "options": [
      {
        "name": "name",
        "description": "The exact name of the event to delete",
        "type": 3,
        "required": true
      }
    ]
  },
  {
    "name": "admin_help",
    "description": "DM every admin the how-to-use guide for admin commands - admins only",
    "type": 1
  },
  {
    "name": "notify_admins",
    "description": "DM every admin a custom update message - admins only",
    "type": 1,
    "options": [
      {
        "name": "message",
        "description": "The message to send to every admin",
        "type": 3,
        "required": true
      }
    ]
  },
  {
    "name": "notify_history",
    "description": "Show the last several /notify_admins messages - admins only",
    "type": 1,
    "options": [
      {
        "name": "count",
        "description": "How many to show (default 10, max 25)",
        "type": 4,
        "required": false
      }
    ]
  },
  {
    "name": "talk",
    "description": "Post a message to the announcements channel via a popup - admins only",
    "type": 1
  }
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

echo "Registering guild commands (create_event, edit_event, delete_event, admin_help, notify_admins, notify_history, talk)..."
curl -s -X PUT \
  "https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary "@${GUILD_JSON}"
echo ""

echo "Registering global command (adminpassword, retired but left in place)..."
curl -s -X PUT \
  "https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary "@${GLOBAL_JSON}"
echo ""

rm -f "$GUILD_JSON" "$GLOBAL_JSON"

echo "Done. The guild commands (create_event/edit_event/delete_event/admin_help/notify_admins/notify_history/talk)"
echo "should show up immediately. The global command can take up to an hour, same as always."
