# Deploy Netlify

## Reglages

Depuis le repo:

- Package directory: `servera-dashboard`
- Build command: vide
- Publish directory: `public`

Puis renommer le site en:

- `servera-dashboard`

URL attendue:

- `https://servera-dashboard.netlify.app`

## Proxy backend

Le front est deja configure pour proxy:

```txt
/api/*  https://servera-dashboard.onrender.com/api/:splat  200
/auth/* https://servera-dashboard.onrender.com/auth/:splat 200
/*      /index.html                                             200
```

Ces regles sont dans:

- [public/_redirects](C:\Users\Utilisateur\Desktop\AnimoraTV\servera-dashboard\public\_redirects)

## Discord OAuth2

Dans Discord Developer Portal, ajoute exactement:

```txt
https://servera-dashboard.netlify.app/auth/discord/callback
```

## Important

Netlify sert seulement le front. L'auth Discord et l'API passent par le backend
Render via les rewrites ci-dessus.
