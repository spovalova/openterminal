#!/usr/bin/env node
// The bin's path before the rename to Open Terminal (2026-10-19), kept so a unit or script that still runs
// `packages/cli/bin/terminal.js` (the old terminal.service) keeps working until it is switched to
// `bin/openterminal.js`. Nothing else lives here.
import './openterminal.js'
