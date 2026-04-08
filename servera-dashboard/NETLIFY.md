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

## API directe

Le front parle directement a la fonction Supabase:

```txt
https://gxsxdcwwqxiiivtoyzha.supabase.co/functions/v1/smart-worker
```

Cette valeur est deja preparee dans:

- [runtime-config.js](C:\Users\Utilisateur\Desktop\AnimoraTV\servera-dashboard\public\runtime-config.js)

## Discord OAuth2

Dans Discord Developer Portal, ajoute exactement:

```txt
https://gxsxdcwwqxiiivtoyzha.supabase.co/functions/v1/smart-worker/auth/discord/callback
```

## Important

Netlify sert seulement le front. L'auth Discord et l'API passent maintenant par
la fonction Supabase `smart-worker`.
