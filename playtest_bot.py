import json
import os

import discord
from discord import app_commands
from discord.ext import commands

DATA_FILE = "playtests.json"
SIGNUP_EMOJI = "👍"

intents = discord.Intents.default()  # no privileged intents needed
bot = commands.Bot(command_prefix="!", intents=intents)


# ---------- storage: message_id -> role_id ----------
def load_data() -> dict:
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r") as f:
            return json.load(f)
    return {}


def save_data(data: dict) -> None:
    with open(DATA_FILE, "w") as f:
        json.dump(data, f, indent=2)


playtests = load_data()


@bot.event
async def setup_hook():
    await bot.tree.sync()


@bot.event
async def on_ready():
    print(f"Logged in as {bot.user} ({bot.user.id})")


# ---------- slash commands ----------
@bot.tree.command(name="playtest_create", description="Create a playtest signup post and role")
@app_commands.describe(
    name="Event name (also becomes the role name)",
    description="Details: date, time, what's being tested, etc.",
    channel="Channel to post in (defaults to this one)",
    mentionable="Let the role be @mentioned (default: yes)",
)
@app_commands.guild_only()
@app_commands.default_permissions(administrator=True)
@app_commands.checks.has_permissions(administrator=True)
async def playtest_create(
    interaction: discord.Interaction,
    name: str,
    description: str = "",
    channel: discord.TextChannel | None = None,
    mentionable: bool = True,
):
    await interaction.response.defer(ephemeral=True)
    channel = channel or interaction.channel
    guild = interaction.guild

    role = await guild.create_role(
        name=name,
        mentionable=mentionable,
        reason=f"Playtest signup created by {interaction.user}",
    )

    embed = discord.Embed(
        title=f"Playtest: {name}",
        description=f"{description}\n\nReact with {SIGNUP_EMOJI} to sign up. "
        f"Remove your reaction to drop out.",
        color=discord.Color.blurple(),
    )
    message = await channel.send(embed=embed)
    await message.add_reaction(SIGNUP_EMOJI)

    playtests[str(message.id)] = {"role_id": role.id, "guild_id": guild.id, "name": name}
    save_data(playtests)

    await interaction.followup.send(
        f"Created {role.mention} and posted signups in {channel.mention}.\n"
        f"Message ID (for /playtest_close): `{message.id}`",
        ephemeral=True,
    )


@bot.tree.command(name="playtest_close", description="Stop signups for a playtest")
@app_commands.describe(
    message_id="ID of the signup message",
    delete_role="Also delete the role (default: no)",
)
@app_commands.guild_only()
@app_commands.default_permissions(administrator=True)
@app_commands.checks.has_permissions(administrator=True)
async def playtest_close(
    interaction: discord.Interaction, message_id: str, delete_role: bool = False
):
    entry = playtests.pop(message_id, None)
    if not entry:
        await interaction.response.send_message("No playtest found with that message ID.", ephemeral=True)
        return
    save_data(playtests)

    msg = f"Closed signups for **{entry['name']}**."
    if delete_role:
        role = interaction.guild.get_role(entry["role_id"])
        if role:
            await role.delete(reason="Playtest closed")
            msg += " Role deleted."
    await interaction.response.send_message(msg, ephemeral=True)


@playtest_create.error
@playtest_close.error
async def on_command_error(interaction: discord.Interaction, error: app_commands.AppCommandError):
    if isinstance(error, app_commands.MissingPermissions):
        await interaction.response.send_message("Only server administrators can use this command.", ephemeral=True)
    else:
        raise error


# ---------- reaction handling ----------
@bot.event
async def on_raw_reaction_add(payload: discord.RawReactionActionEvent):
    entry = playtests.get(str(payload.message_id))
    if not entry or payload.user_id == bot.user.id or str(payload.emoji) != SIGNUP_EMOJI:
        return

    guild = bot.get_guild(payload.guild_id)
    role = guild.get_role(entry["role_id"]) if guild else None
    if not role:
        return

    member = payload.member or await guild.fetch_member(payload.user_id)
    try:
        await member.add_roles(role, reason="Playtest signup")
    except discord.Forbidden:
        print("Missing permission: is the bot's role above the playtest role?")


@bot.event
async def on_raw_reaction_remove(payload: discord.RawReactionActionEvent):
    entry = playtests.get(str(payload.message_id))
    if not entry or str(payload.emoji) != SIGNUP_EMOJI:
        return

    guild = bot.get_guild(payload.guild_id)
    role = guild.get_role(entry["role_id"]) if guild else None
    if not role:
        return

    try:
        member = guild.get_member(payload.user_id) or await guild.fetch_member(payload.user_id)
        await member.remove_roles(role, reason="Playtest signup removed")
    except (discord.NotFound, discord.Forbidden):
        pass


def get_token() -> str:
    token = os.environ.get("DISCORD_TOKEN")
    if token and token.strip():
        print("Using token from DISCORD_TOKEN environment variable.")
        return token.strip()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(script_dir, "token.txt"),
        os.path.join(os.getcwd(), "token.txt"),
    ]
    for path in candidates:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8-sig") as f:
                content = f.read().strip()
            # tolerate "DISCORD_TOKEN=abc", quotes, and extra lines
            content = content.splitlines()[0].strip() if content else ""
            if "=" in content and content.upper().startswith("DISCORD_TOKEN"):
                content = content.split("=", 1)[1].strip()
            content = content.strip("\"'")
            if content:
                print(f"Using token from {path}")
                return content
            print(f"Found {path} but it is empty.")

    print("Files in script folder:", os.listdir(script_dir))
    raise SystemExit(
        "No token found. Set the DISCORD_TOKEN environment variable, "
        "or create a file named exactly token.txt next to this script "
        "containing only your bot token."
    )


bot.run(get_token())
