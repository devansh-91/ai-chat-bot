# Setup & deployment (all free)

## 1. Supabase project
1. Create a project at <https://supabase.com> (free plan).
2. Install the CLI (already a dev dependency), then link and push the schema:
   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```
3. Dashboard → **Authentication → Hooks** → enable **Custom Access Token** →
   `public.custom_access_token_hook`.
4. Dashboard → **Database → Extensions**: confirm `pg_cron` is enabled. The migration schedules
   the job; check it with `select * from cron.job;`.

## 2. Google sign-in
1. <https://console.cloud.google.com> → APIs & Services → Credentials → **Create OAuth client ID** →
   *Web application*.
2. **Authorized redirect URI:** `https://<project-ref>.supabase.co/auth/v1/callback`
3. Supabase → **Authentication → Providers → Google**: paste the client ID and secret, enable it.
4. Supabase → **Authentication → URL Configuration**:
   - Site URL: `https://<github-user>.github.io/ai-chat-bot/`
   - Additional redirect URLs: `http://localhost:5173`

## 3. Deploy the app (GitHub Pages)
1. Repo **Settings → Pages** → Source: *GitHub Actions*.
2. Repo **Settings → Secrets and variables → Actions → Variables**:
   - `VITE_SUPABASE_URL` = `https://<project-ref>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = the project's anon/publishable key
3. Push to `main`. The site deploys to `https://<github-user>.github.io/ai-chat-bot/`.

Without the variables, the site still deploys and works in offline guest mode.

## 4. Make yourself admin
Sign in once, then run in the SQL editor:
```sql
update public.profiles set role = 'admin' where email = '<your-gmail>';
```
Sign out and back in so the new role is signed into your token.

## 5. Demo laptop with Ollama (optional, for the fastest replies)
```bash
ollama pull llama3.2:3b
OLLAMA_ORIGINS="https://<github-user>.github.io,http://localhost:*" ollama serve
```
In the app, the model picker lists installed Ollama models automatically.

## Free-tier notes
- Supabase pauses projects after 7 idle days. `.github/workflows/keepalive.yml` pings it every 3 days.
- Model weights are served from Hugging Face's CDN and cached in the browser, so they don't use
  your hosting bandwidth.
