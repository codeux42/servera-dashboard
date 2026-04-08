# Deploy Netlify

Le dossier du site a deployer est:

- `servera-dashboard`

## Reglages Netlify

Si tu deployes depuis ce repo en monorepo:

- Package directory: `servera-dashboard`
- Base directory: laisser vide
- Build command: vide
- Publish directory: `public`

Netlify cherchera le `netlify.toml` dans `servera-dashboard` si le package
directory pointe bien dessus. Source: [Monorepos | Netlify Docs](https://docs.netlify.com/configure-builds/monorepos/).

## Sous-domaine

Le nom `servera-dashboard.netlify.app` ne se fixe pas dans le code.
Il faut aller dans:

- Site configuration
- Domain management
- Options
- Edit site name

et choisir `servera-dashboard` si le nom est libre.

## Backend

Le frontend peut etre deploye sur Netlify, mais le backend Node + SQLite local
ne doit pas etre heberge tel quel sur Netlify.

Le repo contient maintenant un blueprint Render pret a deployer:

- [render.yaml](C:\Users\Utilisateur\Desktop\AnimoraTV\render.yaml)

Il cree un web service `servera-dashboard-api` en region `frankfurt` avec:

- backend Node
- health check `/health`
- disque persistant Render monte sur `/var/data`
- SQLite a `DATABASE_PATH=/var/data/servera-dashboard.sqlite`

La methode recommandee est:

1. deployer le frontend sur Netlify
2. deployer le backend Node sur Render via le blueprint
3. activer dans `public/_redirects` le proxy:

```txt
/api/*  https://servera-dashboard-api.onrender.com/api/:splat  200
/auth/* https://servera-dashboard-api.onrender.com/auth/:splat 200
/*      /index.html                                 200
```

Comme ca:

- le frontend reste sur `servera-dashboard.netlify.app`
- l'auth Discord continue de fonctionner
- les cookies de session restent sur le meme domaine visible cote navigateur

## Option 2: runtime-config.js

`runtime-config.js` existe aussi, mais ce n'est pas le mode recommande pour
l'auth/session si tu n'as pas mis en place le CORS + cookies cross-origin cote
backend.

## Variables backend importantes

Sur ton backend, utilise:

- `APP_URL=https://servera-dashboard.netlify.app`
- `DISCORD_REDIRECT_URI=https://servera-dashboard.netlify.app/auth/discord/callback`

Et dans le portail Discord, ajoute exactement cette URL de callback.

## Secrets bot

Comme le bot appartient a quelqu'un d'autre, les valeurs suivantes doivent etre
ajoutees par son proprietaire dans Render:

- `DISCORD_CLIENT_SECRET`
- `DISCORD_BOT_TOKEN`

Ne les commit pas dans le repo et ne les laisse pas dans `.env` si tu n'en es
pas le proprietaire.
