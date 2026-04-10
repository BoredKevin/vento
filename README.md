# Vento

Vento is a lightweight, real-time web application I built that lets people send me anonymous messages and vent without revealing their identity. Think of it like a dark-themed, highly moderated ticketing system where every visitor gets a random anonymous callsign (e.g. `Tiger42`), and their messages are instantly piped directly into a private category on my Discord server. 

From Discord, I can natively read their vents, reply directly back to their browser, or quietly shadow-ban them if they're being annoying—all without ever leaving my Discord client.

## Why I Built This

I wanted a clean way to let people reach out anonymously without dealing with the usual spam and abuse that comes with anonymous forms. Standard IP bans are way too easy to bypass with a VPN, so I built a custom browser-fingerprinting system that handles bans silently. To the spammer, their chat still looks like it's working perfectly, but their messages are just dropped into the void.

## Features

- **Anonymous Callsigns:** No accounts required. When someone passes verification, the server assigns them a persistent, readable alias (like `Ocean15`).
- **Discord Ticketing:** Every new chat dynamically spawns a dedicated text channel in Discord. My replies in that channel instantly route back to their specific browser tab.
- **Turnstile Captcha:** Cloudflare Turnstile blocks automated bots before they can even request a session.
- **Fingerprint Shadow Banning:** Heavy abuse mitigation using `FingerprintJS`. If I ban someone via Discord (`/ban <fingerprint>`), their active sessions are instantly silenced. They'll never know they were muted, and they can't just flip a VPN to bypass it.
- **Live Presence:** A manual toggle (via Discord `/status` command) that lights up a red/green status dot on the website so people know if I'm around to read it instantly.
- **Profanity Filter:** Automatically scrubs hard slurs out of chat messages so the point gets across without the harshness.
- **Obfuscated Client:** The production frontend JS is heavily minified and obfuscated during the build process to deter basic reverse engineering.

## Setup & Running

You'll need a Discord Bot created in the [Discord Developer Portal](https://discord.com/developers/applications) with Message Content intent enabled, plus free Turnstile keys from Cloudflare.

1. Clone the repo and install dependencies:
   ```bash
   npm install
   ```

2. Copy the `.env.example` to `.env` and fill in your keys:
   ```bash
   cp .env.example .env
   ```
   *Make sure you grab your exact Discord Category ID and Owner ID so the bot knows where to put channels and who is allowed to talk.*

3. Run the development server:
   ```bash
   npm start
   ```

4. If you make edits to the frontend Javascript in `src/frontend/`, compile the obfuscated production files into `public/` by running:
   ```bash
   npm run build
   ```

## Discord Commands

- `/status [online/offline]` - Manually flip the presence indicator on the web interface.
- `/close` - Use this inside a user's specific ticket channel. It ends their web session, forces them to the home page, and archives the Discord channel safely.
- `/ban [fingerprint]` - Drop the ban hammer. Renders their browser useless for sending messages immediately.
- `/unban [fingerprint]` - Reverses a ban.
- `/bans` - Lists active shadow-bans.

## Tech Stack

- **Backend:** Node.js, Express, Socket.IO
- **Database:** SQLite (`better-sqlite3`)
- **Bot:** `discord.js` v14
- **Frontend:** Vanilla HTML/CSS/JS + CSS Canvas particles

## License
MIT