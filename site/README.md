# site/: the landing page

The public page for Open Terminal, and the installers it serves. One static page with no build step, no framework, nothing loaded from another origin and no analytics. Its main call to action is the download for the visitor's system (Open Terminal is a desktop app for macOS, Windows and Linux):

```sh
curl -fsSL https://terminal.spova.ai/install | sh        # macOS and Linux
irm https://terminal.spova.ai/install.ps1 | iex          # Windows PowerShell
```

| File | What |
|---|---|
| `index.html` | the page |
| `styles.css` | the styles: the product's tokens (`packages/ui/src/styles.css`) at landing-page scale |
| `app.js` | the prompt tabs, the download tabs (macOS, Windows, Linux; the default follows the visitor's system) and the copy buttons; without it every prompt and screenshot still shows, one after another, and every system's downloads show |
| `install` | the macOS and Linux installer (POSIX `sh`) |
| `install.ps1` | the Windows installer (Windows PowerShell 5.1 and PowerShell 7) |
| `vercel.json` | serves both installers as `text/plain; charset=utf-8` |
| `prompts.json` | the example prompts, word for word, with the run behind each screenshot |
| `assets/` | screenshots (WebP, 1440x900 at 2x) and `og.jpg`, the 1200x630 social card |
| `fonts/` | Geist (the latin file from Fontsource) and Ioskeley Mono Regular and Medium, with their OFL licenses |
| `favicon.svg` | the app's mark (the Linux installer writes the same mark as the menu icon) |

## Downloads and the release contract

The release workflow publishes these assets on every GitHub release, under stable names so `https://github.com/spovalova/openterminal/releases/latest/download/<asset>` always works (`…/releases/download/v<version>/<asset>` for a given version):

| System | Assets |
|---|---|
| macOS | `OpenTerminal-mac-arm64.dmg`, `OpenTerminal-mac-x64.dmg`, and `OpenTerminal-mac-arm64.zip`, `OpenTerminal-mac-x64.zip` (with `Open Terminal.app` at the root of the zip) |
| Windows | `OpenTerminal-win-x64-setup.exe` (NSIS, per user, `/S` for silent) |
| Linux | `OpenTerminal-linux-x86_64.AppImage`, `OpenTerminal-linux-arm64.AppImage`, `OpenTerminal-linux-amd64.deb`, `OpenTerminal-linux-arm64.deb` |
| All | `SHA256SUMS`, in `sha256sum` format |

The app is not code-signed (no Apple Developer ID, no Windows certificate). The page says so plainly and links the direct downloads with the one-time step each system asks for (macOS: System Settings → Privacy & Security → Open Anyway; Windows: SmartScreen's More info → Run anyway), and recommends the install commands, which avoid both prompts: a file that `curl` or `Invoke-WebRequest` downloads carries no quarantine flag or Mark of the Web.

## The installers

Both check the download against the release's `SHA256SUMS` before touching anything, never use sudo or ask for an administrator, and never touch the user's data in `~/.openterminal`. Running one again updates in place.

| | What it does |
|---|---|
| `install` on macOS | downloads the zip for the Mac's arch (arm64 on Apple silicon, even from a Rosetta shell), asks a running Open Terminal to quit and waits for it, swaps `Open Terminal.app` into `/Applications` (or `~/Applications` when `/Applications` needs an administrator, or wherever it already is) by rename, and opens it. The app's Update runs this same script, so it runs unattended and ends by reopening the app. |
| `install` on Linux | downloads the AppImage to `~/.local/share/openterminal/OpenTerminal.AppImage`, links `~/.local/bin/openterminal` to it, writes a menu entry (`~/.local/share/applications/openterminal.desktop`, with the mark as its icon), adds `~/.local/bin` to `PATH` once (`~/.zshrc`, `~/.bashrc`, fish's `config.fish`, or `~/.profile`), and, when no `fusermount` helper is installed, prints the one-line fix for the distribution (`fuse3`; the AppImage carries the static runtime, so `libfuse2` is not needed) and the `APPIMAGE_EXTRACT_AND_RUN=1` fallback. It mentions the `.deb` as the alternative. |
| `install.ps1` | downloads the setup with `Invoke-WebRequest`, closes a running Open Terminal, runs the setup with `/S` and waits for it, finds the app through the uninstall entry the setup writes, and opens it. No `PATH` changes. |

The version comes from where `releases/latest` redirects (`…/releases/tag/v<version>`), so the checksums and the asset come from the same release; a redirect to `…/releases` means nothing is published yet, and the installers say so. They also refuse musl (Alpine), 32-bit and unknown systems with a pointer to the other ways to run it.

Environment, read by both:

- `OPENTERMINAL_VERSION`: a specific version (`0.2.0` or `v0.2.0`) instead of the latest.
- `OPENTERMINAL_INSTALL_BASE`: a base URL or a local directory holding the assets and `SHA256SUMS`, for mirrors and testing.
- `OPENTERMINAL_NO_LAUNCH=1`: leave the app closed at the end (macOS and Windows).
- `OPENTERMINAL_APP_DIR`: macOS only, the folder for `Open Terminal.app` (tests point it at a temporary folder).
- `NO_COLOR`: plain output (colour is only used on a terminal anyway).
- `sh -s -- --no-modify-path`: Linux only, leave the shell's startup files alone.

The whole sh script is one function called on its last line, and the PowerShell script one function called at its end, so a download cut short runs nothing. `install.ps1` is ASCII on purpose: Windows PowerShell 5.1 reads a saved `.ps1` without a byte order mark as ANSI.

### Testing an installer

Never against your real home or `/Applications`. Make a folder of fake assets with the names above (a shell script that prints a version will do for an AppImage; a zip holding `Open Terminal.app/Contents/Info.plist` for a Mac), write `SHA256SUMS` with `sha256sum * > SHA256SUMS`, then:

```sh
python3 -m http.server 4318 -d <assets-dir> &          # or point OPENTERMINAL_INSTALL_BASE at the folder itself
HOME=$(mktemp -d) OPENTERMINAL_INSTALL_BASE=http://127.0.0.1:4318 sh site/install
```

The macOS branch runs on Linux too, with stand-ins for `uname` (printing `Darwin`), `ditto`, `pgrep`, `osascript`, `pkill` and `open` first on `PATH`, and `OPENTERMINAL_APP_DIR` set to a temporary folder. `packages/ui/test/site-install.test.ts` does both on every test run (install, re-install, upgrade, a tampered checksum, an update while the app runs), and checks the asset names, the commands and download links on the page, the headers in `vercel.json`, `sh -n` (plus `dash -n` and `shellcheck` when installed) and that `install.ps1` is ASCII. `install.ps1` itself is not run there.

### Why vercel.json

Vercel serves a file without an extension, like `install`, as `application/octet-stream`. `irm` hands `iex` bytes rather than text for a binary content type, and `iex` fails, so `vercel.json` sets `Content-Type: text/plain; charset=utf-8` (and a five-minute `Cache-Control`) on `/install` and `/install.ps1`. Nothing else about how the site is served changes.

## Preview

Any static server, from the repo root:

```sh
python3 -m http.server 4310 -d site     # then open http://localhost:4310
```

## Deploy on Vercel

1. Add a new project in Vercel and import `spovalova/openterminal`.
2. Set **Root Directory** to `site`, **Framework Preset** to **Other**, and leave the build command empty (no build step; the output is the directory itself). `site/vercel.json` only sets the installers' headers.
3. Deploy. Pushes to `main` redeploy; pull requests get preview URLs.
4. For a subdomain: in the project, **Settings → Domains**, add it (for example `terminal.example.com`). At your DNS provider, add a `CNAME` record for that subdomain pointing to the value Vercel shows there. Vercel issues the certificate once the record resolves.

The social card (`og:image`, `twitter:image`) points at `og.jpg` on GitHub's raw host, which works before the domain exists; once it does, those two tags can point at `https://<domain>/assets/og.jpg` and an `og:url` can be added.

## Changing the example prompts

1. Run the prompt on a scratch server (never production): build the web app, start `packages/cli/bin/openterminal.js` with `OPENTERMINAL_HOME` set to a fresh directory and a spare `PORT`, then `BASE=http://127.0.0.1:<port> node scripts/prompt-bench.mjs --prompt "<text>" --out <dir>` (or a named prompt from `scripts/prompts.json`).
2. Score it with `scripts/accept.mjs --runs <dir>` and keep it only if the reply verifies every figure and the workspace passes the checklist.
3. Screenshot the workspace at 1440x900 with the conversation panel open, device scale 2, saved as WebP.
4. Update `prompts.json` and the matching tab and panel in `index.html` (between `<!-- prompts:start` and `<!-- prompts:end -->`). `packages/ui/test/site.test.ts` fails when the two disagree, when a referenced file is missing, or when `site/` passes 3 MB.

Colours follow the pure-hue rule (PLAN.md section 6): `packages/ui/test/pure-hue.test.ts` scans this directory too.
