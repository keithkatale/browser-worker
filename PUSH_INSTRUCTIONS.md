# Push to GitHub (run this on your machine)

The code is committed locally. To push to **https://github.com/keithkatale/browser-worker** you must push from your machine with your GitHub credentials.

1. Open a terminal.
2. Go to this folder (the clone of browser-worker):
   ```bash
   cd /Users/KeithKatale/Documents/terabits/browser-worker-repo
   ```
3. Push (you may be asked for your GitHub username and password or token):
   ```bash
   git push -u origin main
   ```
   If you use 2FA, use a **Personal Access Token** instead of your password: GitHub → Settings → Developer settings → Personal access tokens.

After the push, the repo https://github.com/keithkatale/browser-worker will contain the worker. You can then point Railway at **this repo** (no need to set a root directory—the repo root is already the worker).
