# SPIFF mailer: vendor reports from Tawny's own Gmail

"Send to brand" in SPIFF emails the vendor report. This small script sends that email **from
Tawny's Gmail account**, so it shows in her Sent folder and replies go to her. It can only send
(it cannot read, search or delete her email), only to one address at a time, only with the SPIFF
report attached, and at most 40 a day.

## Tawny: one-time setup (about 5 minutes)

Do this signed in to Chrome as **tawny@greencrosscanna.com**.

1. Go to <https://script.google.com> and click **New project**.
2. Click **Untitled project** at the top and rename it **SPIFF Mailer**.
3. Delete everything in the code box, then paste in all of `Code.gs` from this folder (Sky will send
   it to you). Click the save icon.
4. Click **Deploy** (top right) > **New deployment**.
5. Click the gear next to "Select type" and pick **Web app**. Set:
   - Description: `SPIFF Mailer`
   - Execute as: **Me (tawny@greencrosscanna.com)**
   - Who has access: **Anyone**
6. Click **Deploy**. Google asks for permission: click **Authorize access**, pick your account, and
   allow it to **send email as you**. (If it says "Google hasn't verified this app", click
   **Advanced** > **Go to SPIFF Mailer**. It's our own script.)
7. Copy the **Web app URL** (it ends in `/exec`) and send it to Sky.

That's all. Don't share the URL anywhere else. It's useless without the secret SPIFF holds, but
there's no reason to spread it around.

## Sky / a SPIFF session: connecting it

With the URL from Tawny, connect it (deploy secret; dry run first, then `apply=1`):

```
?action=setBrandMailer&secret=<GX_DEPLOY_SECRET>&url=<the /exec URL>&apply=1
```

This pairs with the mailer (hands it a fresh secret, once), saves the URL, and checks that it sends
as tawny@. `?action=setBrandMailer&secret=…` with no URL re-checks it later. `clear=1&apply=1`
disconnects it and puts sending back on the old Send-As path.

Then send one real "Send to brand" to an internal address to confirm. After that, Sky can remove
himself as Tawny's delegate and delete tawny@ from his Gmail "Send mail as" list.

## If it ever needs re-pairing

In the SPIFF Mailer project: **Project Settings** (gear) > **Script Properties** > delete
`MAILER_SECRET`, then run the connect step again.

## Changing the code

Edit `Code.gs` here, commit, then Tawny pastes the new version in and does **Deploy > Manage
deployments > edit (pencil) > Version: New version > Deploy**. That keeps the same URL.
