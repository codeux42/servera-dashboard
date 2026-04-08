# Servera Dashboard

Dashboard web Discord pour Servera, construit sans dependances backend externes:

- auth Discord OAuth2
- affichage des serveurs admin uniquement
- statut bot present ou absent
- configuration tickets, logs et parametres generaux
- stats avis + graphiques
- lecture/ecriture directe sur SQLite

## Lancer le projet

1. Copier `.env.example` vers `.env`
2. Renseigner les variables Discord
3. Lancer:

```powershell
node src/server.js
```

Le dashboard sera servi sur `http://localhost:3000` par defaut.

## Variables importantes

- `APP_URL`: URL publique du dashboard
- `SESSION_SECRET`: secret des sessions
- `DATABASE_PATH`: chemin vers la base SQLite partagee
- `DISCORD_CLIENT_ID`: client OAuth2 du dashboard
- `DISCORD_CLIENT_SECRET`: secret OAuth2
- `DISCORD_REDIRECT_URI`: callback OAuth2
- `DISCORD_BOT_CLIENT_ID`: client id du bot pour le lien d'invitation
- `DISCORD_BOT_TOKEN`: token bot pour lire roles/salons live
- `DISCORD_BOT_PERMISSIONS`: permissions du lien d'invitation
- `ALLOW_DEV_LOGIN=true`: active le login demo local
- `SEED_DEMO_DATA=true`: injecte des donnees demo si la base est vide

## Scripts utiles

```powershell
node src/self-test.js
```

Verifie:

- login demo
- session
- listing serveurs
- chargement dashboard
- sauvegarde logs

## Schema SQLite

Le dashboard cree et lit les tables suivantes:

- `guild_cache`
- `guild_settings`
- `ticket_records`
- `review_records`

### Ce que le bot doit ecrire

Pour une synchro temps reel, ton bot doit utiliser la meme base SQLite et tenir ces donnees a jour:

- `guild_cache`: presence bot, roles, salons et stats serveur
- `ticket_records`: creation, claim, fermeture et utilisateur du ticket
- `review_records`: note, auteur, commentaire et date

Le dashboard ecrit de son cote:

- `guild_settings.ticket_category_id`
- `guild_settings.support_roles_json`
- `guild_settings.logs_enabled`
- `guild_settings.log_channel_id`
- `guild_settings.general_json`

## Presence du bot

Le dashboard marque un serveur comme present si:

- le bot repond via `DISCORD_BOT_TOKEN`, ou
- le cache SQLite indique `bot_present = 1`

Si le bot est absent, le dashboard affiche automatiquement un bouton
"Inviter le bot".

## Notes integration bot

Si ton bot est aussi en Node, il peut reutiliser directement la meme base.

Exemple d'idee:

```js
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("path/to/servera-dashboard.sqlite");

db.prepare(`
  INSERT INTO ticket_records (
    guild_id, channel_id, channel_name, user_id, username,
    claimed_by_id, claimed_by_name, status, topic, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  guildId,
  channelId,
  channelName,
  userId,
  username,
  null,
  null,
  "open",
  topic,
  new Date().toISOString(),
  new Date().toISOString(),
);
```

Tant que le bot lit la config en base ou recharge a l'usage, aucun redemarrage n'est necessaire.
