import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.TGG_USER_DATA = mkdtempSync(join(tmpdir(), 'tgg-unit-'))
