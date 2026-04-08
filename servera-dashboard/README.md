# Servera Dashboard

Dashboard web Discord pour Servera avec:

- connexion Discord OAuth2
- serveurs admin uniquement
- tickets, logs, avis, stats, configuration
- front Netlify
- backend Node Render
- base Postgres gratuite type Supabase

## Stack gratuite

- Front: Netlify
- API: Render Free
- Base: Supabase Postgres Free

Le backend peut tourner en mode:

- `postgres` si `DATABASE_URL` est defini
- `memory` sinon, pratique pour le local/demo

## Variables

```env
PORT=3000
APP_URL=https://servera-dashboard.netlify.app
SESSION_SECRET=replace-with-a-long-random-secret
DATABASE_URL=
DATABASE_SSL=true

DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_REDIRECT_URI=https://servera-dashboard.netlify.app/auth/discord/callback
DISCORD_BOT_CLIENT_ID=
DISCORD_BOT_TOKEN=
DISCORD_BOT_PERMISSIONS=8

ALLOW_DEV_LOGIN=false
SEED_DEMO_DATA=false
```

## Local

Pour lancer localement sans Postgres:

```powershell
node src/server.js
```

Si `DATABASE_URL` est vide, le serveur utilise le mode memoire.

## Test local

```powershell
node src/self-test.js
```

## Tables attendues

Le backend cree automatiquement:

- `guild_cache`
- `guild_settings`
- `ticket_records`
- `review_records`

## Ce que le bot doit synchroniser

Le bot doit lire/ecrire la meme base Postgres que le dashboard pour que tout se
mette a jour en temps reel:

- presence bot par serveur
- roles et salons
- tickets ouverts/claim/fermes
- avis utilisateurs
- config tickets/logs/general

## Deploy

- Netlify: voir [NETLIFY.md](C:\Users\Utilisateur\Desktop\AnimoraTV\servera-dashboard\NETLIFY.md)
- Render: voir [RENDER.md](C:\Users\Utilisateur\Desktop\AnimoraTV\servera-dashboard\RENDER.md)
- Supabase: voir [SUPABASE.md](C:\Users\Utilisateur\Desktop\AnimoraTV\servera-dashboard\SUPABASE.md)
