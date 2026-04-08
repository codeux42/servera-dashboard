# Servera Dashboard

Dashboard web Discord pour Servera avec:

- connexion Discord OAuth2
- serveurs admin uniquement
- tickets, logs, avis, stats, configuration
- front Netlify
- API Supabase Edge Functions
- base Postgres Supabase

## Stack gratuite

- Front: Netlify
- API: Supabase Edge Functions
- Base: Supabase Postgres Free

## Variables

```env
APP_URL=https://servera-dashboard.netlify.app

DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_REDIRECT_URI=https://gxsxdcwwqxiiivtoyzha.supabase.co/functions/v1/servera-api/auth/discord/callback
DISCORD_BOT_CLIENT_ID=
DISCORD_BOT_TOKEN=
DISCORD_BOT_PERMISSIONS=8

ALLOW_DEV_LOGIN=false
```

## Tables attendues

La migration Supabase cree:

- `guild_cache`
- `guild_settings`
- `ticket_records`
- `review_records`
- `dashboard_sessions`
- `dashboard_oauth_states`

## Ce que le bot doit synchroniser

Le bot doit lire/ecrire les memes tables Supabase/Postgres que le dashboard:

- presence bot par serveur
- roles et salons
- tickets ouverts/claim/fermes
- avis utilisateurs
- config tickets/logs/general

## Deploy

- Netlify: voir [NETLIFY.md](C:\Users\Utilisateur\Desktop\AnimoraTV\servera-dashboard\NETLIFY.md)
- Supabase: voir [SUPABASE.md](C:\Users\Utilisateur\Desktop\AnimoraTV\servera-dashboard\SUPABASE.md)
