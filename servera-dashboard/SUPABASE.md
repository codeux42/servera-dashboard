# Supabase Gratuit

## Objectif

Tout faire sans Render :

- base Postgres
- sessions dashboard
- OAuth Discord
- API dashboard via Edge Function

## Etapes

1. Cree un projet Supabase.
2. Ouvre `SQL Editor`.
3. Execute le SQL de [20260408_servera_dashboard.sql](C:\Users\Utilisateur\Desktop\AnimoraTV\supabase\migrations\20260408_servera_dashboard.sql).
4. Ouvre `Edge Functions`.
5. Cree ou deploie la fonction `smart-worker` avec le code de [index.ts](C:\Users\Utilisateur\Desktop\AnimoraTV\supabase\functions\servera-api\index.ts).
6. Desactive la verification JWT pour cette fonction.
7. Ajoute les secrets suivants dans Supabase Edge Functions :

```env
APP_URL=https://servera-dashboard.netlify.app
DISCORD_CLIENT_ID=1480878152816529501
DISCORD_CLIENT_SECRET=...
DISCORD_REDIRECT_URI=https://gxsxdcwwqxiiivtoyzha.supabase.co/functions/v1/smart-worker/auth/discord/callback
DISCORD_BOT_CLIENT_ID=1480878152816529501
DISCORD_BOT_TOKEN=...
DISCORD_BOT_PERMISSIONS=8
ALLOW_DEV_LOGIN=false
```

## Resultat

Une fois la fonction et les tables en place :

- Supabase remplace Render completement
- Netlify parle directement a `smart-worker`
- les reglages dashboard restent persistants
- le bot et le dashboard peuvent partager la meme base

## Important

- la callback Discord n'est plus sur Netlify
- elle doit pointer vers la fonction Supabase
- le bot doit ecrire dans les memes tables Postgres
