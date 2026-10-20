#!/usr/bin/env node
/* global process, console */
// Wrap the release bundle (dist/release/lib, from bundle.mjs) as the `openterminal` npm package and pack it, so
// `npx openterminal` runs the same bundle as the archives on the user's own Node (≥ 22.13, for node:sqlite).
// Nothing is published: publishing is the user's call (PLAN.md section 0, **Ask**).
//
//   node scripts/release/npm.mjs     # stage dist/release/npm/, then npm pack into dist/release/npm-pack/
//
// The package has no dependencies (everything is in lib/), a bin that loads lib/openterminal.mjs, and the README.
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const RELEASE = join(repo, 'dist/release')
const LIB = join(RELEASE, 'lib')
const STAGE = join(RELEASE, 'npm')
const OUT = join(RELEASE, 'npm-pack')
if (!existsSync(join(LIB, 'openterminal.mjs'))) throw new Error(`${LIB} is missing; run node scripts/release/bundle.mjs first`)

const cli = JSON.parse(readFileSync(join(repo, 'packages/cli/package.json'), 'utf8'))
const root = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))

rmSync(STAGE, { recursive: true, force: true })
mkdirSync(join(STAGE, 'bin'), { recursive: true })
cpSync(LIB, join(STAGE, 'lib'), { recursive: true })
cpSync(join(repo, 'LICENSE'), join(STAGE, 'LICENSE'))
writeFileSync(join(STAGE, 'bin/openterminal.mjs'), "#!/usr/bin/env node\n// `npx openterminal`: the release bundle on this machine's Node.\nimport '../lib/openterminal.mjs'\n")
chmodSync(join(STAGE, 'bin/openterminal.mjs'), 0o755)
writeFileSync(
  join(STAGE, 'package.json'),
  JSON.stringify(
    {
      name: 'openterminal',
      version: cli.version,
      description: root.description,
      license: 'MIT',
      type: 'module',
      bin: { openterminal: 'bin/openterminal.mjs' },
      files: ['bin', 'lib'],
      engines: { node: '>=22.13.0' },
      homepage: 'https://terminal.spova.ai',
      repository: { type: 'git', url: 'git+https://github.com/spovalova/openterminal.git' },
      bugs: { url: 'https://github.com/spovalova/openterminal/issues' },
      keywords: ['trading', 'terminal', 'finance', 'stocks', 'ai', 'agent', 'local-first'],
    },
    null,
    2,
  ) + '\n',
)
writeFileSync(
  join(STAGE, 'README.md'),
  `# Open Terminal

The open-source, AI-native terminal for traders. Ask a question, get a live workspace of charts, tables and option
chains, and an answer that points at them. Runs on your machine, with your keys.

\`\`\`sh
npx openterminal
\`\`\`

Needs Node 22.13 or later. It opens \`http://localhost:4242\`; your data stays in \`~/.openterminal\`.
The desktop app, docs, source and issues: https://github.com/spovalova/openterminal
`,
)

mkdirSync(OUT, { recursive: true })
const file = execFileSync('npm', ['pack', '--pack-destination', OUT, '--silent'], { cwd: STAGE, encoding: 'utf8', shell: process.platform === 'win32' }).trim().split('\n').pop()
const tgz = join(OUT, file)
console.error(`${tgz}: ${(statSync(tgz).size / 1e6).toFixed(1)} MB (not published)`)
