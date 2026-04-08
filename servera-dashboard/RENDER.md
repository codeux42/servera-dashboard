# Deploy Render

Le repo contient deja le blueprint Render a la racine:

- [render.yaml](C:\Users\Utilisateur\Desktop\AnimoraTV\render.yaml)

## Ce que ce blueprint fait

- cree un web service `servera-dashboard-api`
- utilise `servera-dashboard` comme `rootDir`
- lance `npm install`
- lance `npm start`
- expose `/health`
- configure SQLite sur `/var/data/servera-dashboard.sqlite`
- ajoute un disque persistant Render sur `/var/data`

## Deploiement

1. Ouvre Render
2. Clique `New`
3. Clique `Blueprint`
4. Connecte ce repo
5. Valide la creation

## Valeurs a fournir pendant la creation

Ces 2 valeurs ne doivent pas etre renseignees par quelqu'un d'autre que le
proprietaire du bot ou de l'application Discord:

- `DISCORD_CLIENT_SECRET`
- `DISCORD_BOT_TOKEN`

Les IDs publics sont deja preconfigures:

- `DISCORD_CLIENT_ID=1480878152816529501`
- `DISCORD_BOT_CLIENT_ID=1480878152816529501`

## Apres le deploy Render

Si Render garde bien ce nom de service, l'URL backend sera:

```txt
https://servera-dashboard-api.onrender.com
```

Le front Netlify est deja configure pour la viser via:

- [public/_redirects](C:\Users\Utilisateur\Desktop\AnimoraTV\servera-dashboard\public\_redirects)

## Important

Le plan `starter` est utilise car Render indique que les disques persistants
sont pour les services payants. Sans disque persistant, SQLite serait perdue a
chaque redeploiement. C'est une inference basee sur la doc Render des disques:
[Persistent Disks](https://render.com/docs/disks)
