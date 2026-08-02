# First deployment — beginner walkthrough (private repos)

> The copy-paste version of the first-time setup for play.pathlands.cc. One-time only —
> every later update is just `bash /opt/dawned/game/deploy/UPDATE.sh`. Deeper background:
> [../docs/tech/DEPLOYMENT.md](../docs/tech/DEPLOYMENT.md).

## 0. You need

- Your VPS **IP address** and **root password** (Hostinger hPanel → your VPS).
- The domain already pointing at that IP (play.pathlands.cc — done).
- A GitHub **fine-grained personal access token** (step 2).
- ~20 minutes.

## 1. Merge the code to `main` (on github.com)

`DEPLOY.sh` installs the `main` branch. On GitHub: **Dawned repo → Pull requests → New pull
request → base: `main`, compare: your work branch → Create → Merge**. (Dawned-Admin has no code
yet — nothing to merge there; the installer skips it automatically.)

## 2. Create the access token (because the repos are private)

GitHub → click your avatar → **Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**:

- Name: `dawned-vps` · Expiration: 1 year (the maximum)
- Repository access: **Only select repositories** → `Dawned` and `Dawned-Admin`
- Permissions → Repository permissions → **Contents: Read-only**

Generate, then **copy the token** (`github_pat_…`). It's a read-only key to your code — treat it
like a password.

## 3. Connect to the VPS

Windows: open **PowerShell**. Mac/Linux: open **Terminal**. Then:

```bash
ssh root@YOUR_SERVER_IP
```

Type `yes` if asked about a fingerprint, then the root password (typing stays invisible — normal).
You now have a command prompt **on the server**. (Alternative: the browser terminal in hPanel.)

## 4. Install everything (three commands)

Paste your token between the quotes in the first line:

```bash
export GH_TOKEN='github_pat_PASTE_YOUR_TOKEN_HERE'

apt-get update -y && apt-get install -y git
git clone "https://EinPallux:$GH_TOKEN@github.com/EinPallux/Dawned.git" /root/dawned-installer

DAWNED_REPO_GAME="https://EinPallux:$GH_TOKEN@github.com/EinPallux/Dawned.git" \
DAWNED_REPO_ADMIN="https://EinPallux:$GH_TOKEN@github.com/EinPallux/Dawned-Admin.git" \
bash /root/dawned-installer/deploy/DEPLOY.sh
```

This runs 5–10 minutes (installs Node, PostgreSQL, Caddy; builds the game; starts the services;
gets the HTTPS certificate automatically). It ends with **`DONE — https://play.pathlands.cc`**.
Safe to re-run if anything interrupts it. Afterwards: `rm -rf /root/dawned-installer`.

Note it prints about SSH: password login stays **enabled** until you install an SSH key —
deliberate, so you can't lock yourself out. fail2ban guards the password in the meantime.

## 5. Play

Open **https://play.pathlands.cc** in two browser windows, pick two names, walk around — you
should see each other move. That's the P0 Definition of Done, live.

## 6. Later

| Task                                         | How                                                                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy new code (after merging to `main`)    | `ssh root@IP` → `bash /opt/dawned/game/deploy/UPDATE.sh`                                                                                             |
| Watch the server log                         | `journalctl -u dawned-game -f` (Ctrl+C to stop)                                                                                                      |
| Is everything running?                       | `systemctl status dawned-game caddy postgresql`                                                                                                      |
| Backups                                      | nightly + rotated automatically on the VPS; your Hostinger snapshots cover the off-box copy                                                          |
| Token expired (git pull fails after ~1 year) | make a new token, then: `sudo -u dawned git -C /opt/dawned/game remote set-url origin "https://EinPallux:NEW_TOKEN@github.com/EinPallux/Dawned.git"` |

## 7. If something's wrong

1. `journalctl -u dawned-game -n 50` — the game server's last 50 log lines.
2. Site unreachable at all → hPanel firewall: ports **80, 443** (and 22) must be allowed.
3. `systemctl restart dawned-game` / `systemctl restart caddy` — the classic turn-it-off-and-on.
4. Re-running `DEPLOY.sh` is always safe (it skips what's already done).
