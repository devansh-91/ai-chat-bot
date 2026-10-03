// Runs a command with the local Supabase URL/keys in the environment (used by integration tests).
import { execSync, spawnSync } from 'node:child_process'

const env = Object.fromEntries(
  execSync('npx supabase status -o env', { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
)
const [cmd, ...args] = process.argv.slice(2)
const r = spawnSync('npx', [cmd, ...args], {
  stdio: 'inherit',
  env: { ...process.env, SUPABASE_URL: env.API_URL, SUPABASE_ANON_KEY: env.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: env.SERVICE_ROLE_KEY },
})
process.exit(r.status ?? 1)
