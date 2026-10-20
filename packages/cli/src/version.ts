// The release version, from packages/cli/package.json: the one place it is set. The release bundle inlines the
// import, the archive writes it to VERSION, the npm package copies it.
import pkg from '../package.json' with { type: 'json' }

export const VERSION: string = pkg.version
