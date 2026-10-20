# site/: the landing page

The public page for Open Terminal. One static page with no build step, no framework, nothing loaded from another origin and no analytics. Its main call to action, Download, links to the GitHub repository.

| File | What |
|---|---|
| `index.html` | the page |
| `styles.css` | the styles: the product's tokens (`packages/ui/src/styles.css`) at landing-page scale |
| `app.js` | the prompt tabs and the copy buttons; without it every prompt and screenshot still shows, one after another |
| `prompts.json` | the example prompts, word for word, with the run behind each screenshot |
| `assets/` | screenshots (WebP, 1440x900 at 2x) and `og.jpg`, the 1200x630 social card |
| `fonts/` | Geist (the latin file from Fontsource) and Ioskeley Mono Regular and Medium, with their OFL licenses |
| `favicon.svg` | the app's mark |

## Preview

Any static server, from the repo root:

```sh
python3 -m http.server 4310 -d site     # then open http://localhost:4310
```

## Deploy on Vercel

1. Add a new project in Vercel and import `spovalova/openterminal`.
2. Set **Root Directory** to `site`, **Framework Preset** to **Other**, and leave the build command empty (no build step; the output is the directory itself). No `vercel.json` is needed.
3. Deploy. Pushes to `main` redeploy; pull requests get preview URLs.
4. For a subdomain: in the project, **Settings → Domains**, add it (for example `terminal.example.com`). At your DNS provider, add a `CNAME` record for that subdomain pointing to the value Vercel shows there. Vercel issues the certificate once the record resolves.

The social card (`og:image`, `twitter:image`) points at `og.jpg` on GitHub's raw host, which works before the domain exists; once it does, those two tags can point at `https://<domain>/assets/og.jpg` and an `og:url` can be added.

## Changing the example prompts

1. Run the prompt on a scratch server (never production): build the web app, start `packages/cli/bin/openterminal.js` with `OPENTERMINAL_HOME` set to a fresh directory and a spare `PORT`, then `BASE=http://127.0.0.1:<port> node scripts/prompt-bench.mjs --prompt "<text>" --out <dir>` (or a named prompt from `scripts/prompts.json`).
2. Score it with `scripts/accept.mjs --runs <dir>` and keep it only if the reply verifies every figure and the workspace passes the checklist.
3. Screenshot the workspace at 1440x900 with the conversation panel open, device scale 2, saved as WebP.
4. Update `prompts.json` and the matching tab and panel in `index.html` (between `<!-- prompts:start` and `<!-- prompts:end -->`). `packages/ui/test/site.test.ts` fails when the two disagree, when a referenced file is missing, or when `site/` passes 3 MB.

Colours follow the pure-hue rule (PLAN.md section 6): `packages/ui/test/pure-hue.test.ts` scans this directory too.
