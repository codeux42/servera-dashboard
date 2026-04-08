# Deploy Render Free

## Service

Creer un `Web Service` Render avec:

- Name: `servera-dashboard`
- Runtime: `Node`
- Branch: `main`
- Region: `Frankfurt`
- Root Directory: `servera-dashboard`
- Build Command: `npm install`
- Start Command: `npm start`
- Plan: `Free`

## Variables Render

```env
APP_URL=https://servera-dashboard.netlify.app
SESSION_SECRET=une-longue-cle-secrete
DATABASE_URL=postgresql://...
DATABASE_SSL=true
DISCORD_CLIENT_ID=1480878152816529501
DISCORD_CLIENT_SECRET=...
DISCORD_REDIRECT_URI=https://servera-dashboard.netlify.app/auth/discord/callback
DISCORD_BOT_CLIENT_ID=1480878152816529501
DISCORD_BOT_TOKEN=...
DISCORD_BOT_PERMISSIONS=8
ALLOW_DEV_LOGIN=false
SEED_DEMO_DATA=false
```

## Base gratuite

Utilise une base Postgres gratuite, par exemple Supabase.
Copie simplement l'URL Postgres dans `DATABASE_URL`.
Guide rapide: [SUPABASE.md](C:\Users\Utilisateur\Desktop\AnimoraTV\servera-dashboard\SUPABASE.md)

## Health check

Le backend expose:

```txt
/health
```

URL attendue si tu gardes le nom propose:

```txt
https://servera-dashboard.onrender.com
```

## Important

Le plan gratuit Render n'est pas adapte a SQLite locale persistante.
Cette version du projet utilise donc Postgres cloud pour rester 100% gratuite.
