# Setting Prediq up

Everything here is one-time. Work through it in order; nothing later depends on
you understanding anything earlier.

The site itself already works — open `index.html` in a browser and you'll get live
predictions. This is about getting the **archive** running, so that the site can
eventually show its own track record.

---

## Step 1 — Lock down Firestore (do this first)

If you created the Firestore database in "test mode", it is currently readable
**and writable** by anyone on the internet, and stays that way for 30 days.

1. Go to the [Firebase console](https://console.firebase.google.com/), open the
   **prediq-b5690** project.
2. Left sidebar → **Firestore Database**. If it says "Create database", do that
   first — pick a region close to you and choose **production mode** when offered.
3. Click the **Rules** tab.
4. Delete everything in the box. Open `firestore.rules` from this project, copy
   all of it, paste it in.
5. Click **Publish**.

That makes the archive readable by everyone and writable by nobody — which is the
posture Prediq wants permanently, not just for now.

> **Why this matters and the API key doesn't:** the config in
> `assets/js/firebase-config.js` is public on purpose. It ships in the browser, so
> every visitor has it, and that is how Firebase is designed. It identifies the
> project; it doesn't authorise anything. These rules are the actual security.

---

## Step 2 — Put the code on GitHub

If you don't have `git` installed, get it from [git-scm.com](https://git-scm.com/)
and accept all the defaults.

1. Go to [github.com/new](https://github.com/new).
2. Repository name: `prediq` (or anything you like).
3. **Public** or **Private** — either works. Pages needs Public on a free account,
   but you aren't turning Pages on yet, so Private is fine for now.
4. Do **not** tick "Add a README" or "Add .gitignore" — this project already has
   both, and pre-filling them creates a conflict you'd have to untangle.
5. Click **Create repository**. Leave that page open; you'll need the URL.

Now open a terminal in this project folder and run these one at a time:

```bash
git init -b main
git add .
git commit -m "Prediq: site, model, archive writer and tests"
git remote add origin https://github.com/YOUR-USERNAME/prediq.git
git push -u origin main
```

Replace `YOUR-USERNAME`. If it asks for a password, GitHub wants a Personal Access
Token rather than your account password — the easier route is to install the
[GitHub CLI](https://cli.github.com/) and run `gh auth login` once.

**Check:** refresh the GitHub page. You should see `assets/`, `tools/`, `tests/`,
`data/`, and a `.github` folder.

---

## Step 3 — Give the workflow permission to commit

The archive job writes to the repository, so it needs write access. This is off by
default on new repositories.

1. In your repository: **Settings** → **Actions** → **General**.
2. Scroll to **Workflow permissions**.
3. Select **Read and write permissions**.
4. **Save**.

Skip this and the job will run, fetch, predict — and fail at the last moment with
`403` when it tries to push.

---

## Step 4 — Add the Firebase service account key

This is the one genuine secret in the project. It grants admin access to your
Firestore database.

1. Firebase console → the **gear icon** → **Project settings**.
2. **Service accounts** tab → **Generate new private key** → **Generate key**.
   A `.json` file downloads.
3. In your GitHub repository: **Settings** → **Secrets and variables** →
   **Actions** → **New repository secret**.
4. Name: `FIREBASE_SERVICE_ACCOUNT`
5. Secret: open the downloaded `.json` in a text editor, select **all** of it
   (including the outer `{` and `}`), and paste. Don't add quotes around it, don't
   reformat it, don't remove the `\n` sequences inside `private_key`.
6. **Add secret**.
7. **Delete the downloaded file from your computer.** GitHub has it now, and a
   copy sitting in Downloads is the most likely way it leaks.

The service account also needs permission to write. Usually it has it already, but
if the mirror later reports `PERMISSION_DENIED`:
[Google Cloud IAM](https://console.cloud.google.com/iam-admin/iam) → find the
`...@prediq-b5690.iam.gserviceaccount.com` account → **Edit** → add the role
**Cloud Datastore User** → **Save**.

> **Never paste this file into a chat, a code file, or a commit.** Unlike the web
> config, this one really is a credential — and because it authenticates as an
> administrator, it bypasses the rules from Step 1 entirely. That asymmetry is
> exactly why `data/` in the repository, whose history anyone can audit, is the
> primary copy of the archive and Firestore is only a mirror.

---

## Step 5 — Do a dry run

Never let a new scheduled job write anything on its first outing.

1. Repository → **Actions** tab. If it asks you to enable workflows, do.
2. Click **predictions** in the left sidebar.
3. **Run workflow** → tick **Report what would happen, write nothing** → **Run
   workflow**.
4. Wait about a minute, then click into the run and read the log.

What a healthy dry run looks like:

```
freeze — 2026-08-23T...  (dry run)
model rev 1.0, 14 competitions
  47 fixtures in the next few days
  6 predictions across 2 days
    skipped 41 · kickoff more than 24h away
  2026-08-23  would add 4 of 4
  ...
0 recorded, 0 left as first written (nothing written)
```

Things that are fine and not problems:

- **`skipped N · kickoff more than 24h away`** — expected, and most fixtures. The
  archive deliberately only records matches starting within 24 hours.
- **`0 fixtures`** for the European cups in summer — those competitions genuinely
  aren't playing.
- **`nothing awaiting a result`** from the settler — correct on a first run.
- **Zero predictions overall** if there's no football in the next 24 hours. Try
  again on a Friday.

Things that are actual problems:

- **`403`** on the commit step → Step 3 wasn't saved.
- **`fetch errors: eng.1×3`** for every league → ESPN is unreachable or has
  changed. Worth telling me about.

---

## Step 6 — Let it run for real

Same as Step 5 but leave the dry-run box **unticked**.

This time the job commits. Check the repository's commit list: you should see
`prediq-archive` commit something like `archive: 6 recorded, 0 settled`, and a
`data/2026-08-23.json` file you can open and read.

Then check Firestore: console → **Firestore Database** → **Data**. There should be
a `predictions` collection with one document per prediction, and a `meta`
collection with `index` and `summary`.

From here it runs itself every three hours. Nothing more to do.

**A useful thing to know:** run it again immediately and it will say
`archive unchanged`. That isn't a bug — it's the write-once rule working. A
prediction is recorded once and never revised, so a second run within the same
window has genuinely nothing to add.

---

## Step 7 — Publishing the site (later)

Not yet. We're holding the launch until the remaining pages are built, and the
archive needs a few weeks of matches behind it before an accuracy page is worth
looking at. When you're ready it's: **Settings** → **Pages** → Source:
**Deploy from a branch** → `main` / `/ (root)` → **Save**.

Nothing in the project needs changing for that — the empty `.nojekyll` file at the
root already tells Pages to publish the files as they are rather than running them
through Jekyll first.

Note that Pages requires a Public repository on a free plan, so if you chose
Private in Step 2 you'd switch it then.

---

## If something goes wrong

Run the test suite first — it needs no credentials and no network:

```bash
node tests/run.mjs
```

778 assertions across 15 suites. If those pass, the code is fine and the problem
is configuration: permissions, a secret, or ESPN.

To see what the writers would do without touching anything:

```bash
node tools/freeze.mjs --dry-run
node tools/settle.mjs --dry-run
node tools/mirror.mjs --dry-run
```

If Firestore ever falls behind the repository — an outage, a bad key, a stretch
with the secret missing — this catches it up:

```bash
FIREBASE_SERVICE_ACCOUNT="$(cat /path/to/key.json)" node tools/mirror.mjs --all
```

It is safe to run as often as you like. Records already mirrored are refused by
the database itself, so a second run writes nothing.
