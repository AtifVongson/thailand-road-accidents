# Deploying to GitHub Pages

Everything in this folder is static. No build step, no server, no database.

## Measured payload

| | raw | over the wire (gzip) |
|---|---:|---:|
| `assets/data/*.json` | 7.19 MB | **1.45 MB** |
| `assets/vendor/maplibre-gl.*` | 0.87 MB | 0.22 MB |
| figures + html | ~1.2 MB | ~1.2 MB (PNG is already compressed) |
| **first load of the map page** | | **≈ 1.7 MB** |

The map page fetches only what its view draws, so the province view pulls 0.37 MB, not 7.19 MB.

## One-time setup

```bash
cd "C:/Users/atif_/Desktop/Data Science & Visualization/Group Project/site"
git init -b main
git add -A
git commit -m "Thailand road accident analysis site"
gh repo create thailand-road-accidents --public --source=. --push
```

Then turn Pages on — either in the repo's Settings → Pages → Source: `main` / root, or:

```bash
gh api -X POST repos/:owner/thailand-road-accidents/pages -f source[branch]=main -f source[path]=/
```

The site appears at `https://<user>.github.io/thailand-road-accidents/` about a minute later.

## Publishing a change

```bash
git add -A && git commit -m "update" && git push
```

## Verify after the first deploy

Compression is the whole performance story here, so confirm it actually happened. The data
files are named `.json` (not `.geojson`) precisely because every host compresses `.json`:

```bash
curl -sI -H "Accept-Encoding: gzip" https://<user>.github.io/thailand-road-accidents/assets/data/roads.json
```

Expect `content-encoding: gzip` and a `content-length` near 1.15 MB. If it comes back
without `content-encoding`, the browser is downloading 4.46 MB and the page will feel slow
on a phone — say so rather than shipping it quietly.

Also check, on the deployed URL, not just locally:

- the map draws (MapLibre is vendored in `assets/vendor/`, so this must not depend on the venue's network reaching a CDN)
- `?variant=` still switches views
- the page works on a phone

## Notes

- `.nojekyll` is required. Without it GitHub runs Jekyll, which ignores files and folders
  beginning with `_` and slows every deploy down for no benefit here.
- The repo is public, which is what makes GitHub Pages free. Everything in it is open
  government data — no keys, no personal data. Crash coordinates are incident locations,
  not home addresses.
- Road centrelines (ArcGIS DOH/DRR) and province borders (GADM 4.1) are used as **geography
  only**; every number on the site is computed from `Datasource/`. Both must stay credited
  on the methodology section.
