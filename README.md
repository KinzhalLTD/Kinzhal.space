# Kinzhal.space

One repository for everything Kinzhal LTD runs on the web.

| Folder | What it is | Netlify site | Base directory |
|---|---|---|---|
| `nest/` | **Kinzhal Nest**: the games HQ (login, team, live data, marketing, products, Steam) | kinzhalnest.netlify.app | `nest` |
| `site/` | **kinzhal.space**: the studio website, with a page, privacy, terms and support for every game, plus one shared `app-ads.txt` | kinzhal.space | `site` |

Each folder keeps its own `netlify.toml`, `package.json` and README, so each Netlify site builds only its own folder.

## Netlify settings (per site)
Site configuration → Build & deploy → Continuous deployment → Repository: `KinzhalLTD/Kinzhal.space`, branch `main`.

- **Kinzhal Nest:** Base directory `nest` · Publish directory `nest/public` · Functions directory `nest/netlify/functions`
- **kinzhal.space:** Base directory `site` · Build command `node build.mjs` · Publish directory `site/public`

Secrets stay in Netlify environment variables and in the Kinzhal Nest settings screen. They never go in this repo.
