# Supabase Gratuit

## Objectif

Recuperer une URL Postgres gratuite pour la variable `DATABASE_URL`.

## Etapes

1. Cree un compte sur Supabase.
2. Cree un nouveau projet.
3. Attends que la base soit provisionnee.
4. Recupere la chaine de connexion Postgres du projet.
5. Colle cette valeur dans `DATABASE_URL` sur Render.

## Variables a garder sur Render

```env
DATABASE_URL=postgresql://...
DATABASE_SSL=true
```

## Resultat

Une fois `DATABASE_URL` ajoutee:

- Render Free utilise Postgres au lieu de la memoire
- les reglages dashboard restent persistants
- le bot et le dashboard peuvent partager la meme base

## Important

- garde cette URL privee
- ne la mets pas dans Netlify
- mets-la seulement dans le backend Render
