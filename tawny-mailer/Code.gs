/* ── SPIFF MAILER: sends vendor reports from Tawny's own Gmail (Sky, 2026-11-16) ──────────────────
 *
 * WHY THIS EXISTS. "Send to brand" used to send from Sky's account using tawny@ as a Send-As alias,
 * which needed Sky set up as a delegate on Tawny's mailbox, and her mail landed in his inbox. This
 * small project is deployed as a web app that runs AS TAWNY ("Execute as: Me", deployed by her), so
 * the email really comes from her: it sits in her Sent folder and replies go straight to her. The
 * SPIFF engine builds the email and calls this; this only sends it.
 *
 * WHAT IT WILL DO, AND NOTHING ELSE.
 *   pair   Store the shared secret, ONCE. Accepted only while no secret is stored, so whoever pairs
 *          first owns it. The SPIFF engine pairs right after Tawny deploys; if pairing fails because a
 *          secret is already there, clear MAILER_SECRET in Project Settings and pair again.
 *   ping   Says which account this runs as and how many sends Google allows today. Secret required.
 *   send   One email, to ONE address, with one PDF attached. Secret required, and it refuses unless
 *          it is running as the address the engine expects (expect_from), so a copy deployed by the
 *          wrong person cannot send under the wrong name. Capped per day.
 *
 * It uses MailApp (scope script.send_mail: send only), never GmailApp, so this project cannot read,
 * search or delete anything in Tawny's mailbox.
 *
 * Deploy: Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone. "Anyone" is
 * needed because the engine calls it server to server with no Google sign-in; the secret is the gate.
 * Setup steps for Tawny are in README.md beside this file. */

var SECRET_PROP = 'MAILER_SECRET';
var MAX_SENDS_PER_DAY = 40;
var MAX_HTML_CHARS = 500000;
var MAX_PDF_BYTES = 10 * 1024 * 1024;

function doGet() {
  return json_({ ok: false, error: 'This mailer only answers the SPIFF engine.' });
}

function doPost(e) {
  var req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'Bad request' }); }
  try { return json_(handle_(req || {})); }
  catch (err) { return json_({ ok: false, error: String((err && err.message) || err) }); }
}

function handle_(req) {
  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty(SECRET_PROP) || '';
  var given = String(req.secret || '');
  var me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();

  if (req.action === 'pair') {
    if (given.length < 32) return { ok: false, error: 'The secret must be at least 32 characters.' };
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return { ok: false, error: 'Busy. Try again.' };
    try {
      if (props.getProperty(SECRET_PROP)) {
        return { ok: false, already_paired: true,
                 error: 'Already paired. To pair again, delete MAILER_SECRET in Project Settings first.' };
      }
      props.setProperty(SECRET_PROP, given);
    } finally { lock.releaseLock(); }
    return { ok: true, paired: true, from: me };
  }

  if (!stored) return { ok: false, error: 'Not paired yet.' };
  if (!sameSecret_(given, stored)) return { ok: false, error: 'Not allowed' };

  if (req.action === 'ping') {
    return { ok: true, from: me, quota_left: MailApp.getRemainingDailyQuota(),
             sent_today: sentToday_(props) };
  }
  if (req.action !== 'send') return { ok: false, error: 'Unknown action' };

  var expect = String(req.expect_from || '').trim().toLowerCase();
  if (!expect || expect !== me) {
    return { ok: false, from: me,
             error: 'This mailer runs as ' + me + ', not ' + (expect || '(nobody named)') + '. Nothing was sent.' };
  }
  var to = String(req.to || '').trim().toLowerCase();
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) return { ok: false, error: 'One valid address only.' };
  var subject = String(req.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  if (!subject) return { ok: false, error: 'The subject is empty.' };
  var html = String(req.html || '');
  if (!html || html.length > MAX_HTML_CHARS) return { ok: false, error: 'The email body is missing or too large.' };
  var att = req.attachment || {};
  var name = String(att.name || '').replace(/[\/\\\r\n]/g, ' ').trim();
  if (!/\.pdf$/i.test(name) || !att.base64) return { ok: false, error: 'A PDF attachment is required.' };
  var bytes = Utilities.base64Decode(String(att.base64));
  if (bytes.length > MAX_PDF_BYTES) return { ok: false, error: 'The PDF is too large.' };

  var lock2 = LockService.getScriptLock();
  if (!lock2.tryLock(15000)) return { ok: false, error: 'Another send is in progress. Try again in a moment.' };
  try {
    var day = today_();
    var count = sentToday_(props);
    if (count >= MAX_SENDS_PER_DAY) {
      return { ok: false, error: 'The daily limit of ' + MAX_SENDS_PER_DAY + ' vendor emails is reached. Try tomorrow.' };
    }
    MailApp.sendEmail({
      to: to,
      subject: subject,
      body: String(req.text || ''),
      htmlBody: html,
      name: String(req.name || 'Green Cross Cannabis Emporium').slice(0, 80),
      attachments: [Utilities.newBlob(bytes, 'application/pdf', name)]
    });
    props.setProperty('SENT_ON', day);
    props.setProperty('SENT_COUNT', String(count + 1));
    return { ok: true, from: me, to: to };
  } finally { lock2.releaseLock(); }
}

function sentToday_(props) {
  return props.getProperty('SENT_ON') === today_() ? Number(props.getProperty('SENT_COUNT') || 0) : 0;
}

function today_() {
  return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
}

/* Compares every character, so how long a wrong guess takes says nothing about how close it was. */
function sameSecret_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* Run once from the editor (Run > authorize) if Deploy does not ask for permission on its own. */
function authorize() {
  MailApp.getRemainingDailyQuota();
  return Session.getEffectiveUser().getEmail();
}
