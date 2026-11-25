'use strict';

/**
 * Self-contained verification suite for Rivvak Media Automation Backend.
 * Starts server on ephemeral port 0 using an isolated temporary data directory
 * and cleans up all temp files on completion.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const {
  startServer,
  parseCsv,
  runSchedulerTick,
  sendSmtpEmail,
  verifySmtpAuth,
  fetchImapInboxSummary,
  loadStore,
  saveStore,
  safeEqualToken,
  parseDotEnvFile,
  buildIntegrationsStatus,
  aggregateShopifyFinances,
  createShopifyDraftOrderInvoice,
  fetchShopifyDraftOrderStatus,
  createDefaultOnboarding,
  normalizeOnboarding,
} = require('./server');

/**
 * Spin up an ephemeral loopback mock IMAP4rev1 server for header summary verification.
 */
function createMockImapServer() {
  const server = net.createServer((socket) => {
    let buf = '';
    socket.write('* OK [CAPABILITY IMAP4rev1] mock.rivvak.local IMAP4rev1 ready\r\n');

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx === -1) continue;
        const tag = line.slice(0, spaceIdx);
        const cmd = line.slice(spaceIdx + 1);
        const upper = cmd.toUpperCase();

        if (upper.startsWith('LOGIN ')) {
          socket.write(`${tag} OK Logged in\r\n`);
        } else if (upper.startsWith('EXAMINE ')) {
          socket.write('* FLAGS (\\Seen \\Answered)\r\n* 2 EXISTS\r\n* 0 RECENT\r\n');
          socket.write(`${tag} OK [READ-ONLY] Examine completed\r\n`);
        } else if (upper.startsWith('FETCH ')) {
          const h1 =
            'Date: Sat, 21 Nov 2026 10:00:00 -0500\r\nFrom: Jaime <info@bluediamondpools.com>\r\nSubject: Blue Diamond Pools Preview\r\n\r\n';
          const h2 =
            'Date: Sat, 21 Nov 2026 12:30:00 -0500\r\nFrom: =?UTF-8?B?Uml2dmFr?= <connect@rivvak.com>\r\nSubject: Case Update\r\n\r\n';
          socket.write(
            `* 1 FETCH (UID 101 FLAGS (\\Seen) BODY[HEADER.FIELDS (DATE FROM SUBJECT)] {${Buffer.byteLength(h1)}}\r\n${h1})\r\n`
          );
          socket.write(
            `* 2 FETCH (UID 102 FLAGS () BODY[HEADER.FIELDS (DATE FROM SUBJECT)] {${Buffer.byteLength(h2)}}\r\n${h2})\r\n`
          );
          socket.write(`${tag} OK Fetch completed\r\n`);
        } else if (upper === 'LOGOUT') {
          socket.write('* BYE IMAP4rev1 Server logging out\r\n');
          socket.write(`${tag} OK Logout completed\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK Done\r\n`);
        }
      }
    });
  });
  return server;
}

/**
 * Spin up an ephemeral loopback mock SMTP server validating AUTH LOGIN & DATA framing.
 */
function createMockSmtpServer() {
  const captured = [];
  const server = net.createServer((socket) => {
    let state = 'GREETING';
    let current = { user: '', pass: '', mailFrom: '', rcptTo: [], rawData: '' };
    let buf = '';
    socket.write('220 mock.rivvak.local ESMTP Mock\r\n');

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (state === 'DATA') {
        const endIdx = buf.indexOf('\r\n.\r\n');
        if (endIdx !== -1) {
          current.rawData += buf.slice(0, endIdx);
          buf = buf.slice(endIdx + 5);
          captured.push(current);
          current = { user: '', pass: '', mailFrom: '', rcptTo: [], rawData: '' };
          state = 'CMD';
          socket.write('250 2.0.0 OK queued\r\n');
        }
        return;
      }

      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        const upper = line.toUpperCase();

        if (state === 'AUTH_USER') {
          current.user = Buffer.from(line, 'base64').toString('utf8');
          state = 'AUTH_PASS';
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (state === 'AUTH_PASS') {
          current.pass = Buffer.from(line, 'base64').toString('utf8');
          state = 'CMD';
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (upper.startsWith('EHLO ') || upper.startsWith('HELO ')) {
          socket.write('250-mock.rivvak.local\r\n250 AUTH LOGIN PLAIN\r\n');
        } else if (upper === 'AUTH LOGIN') {
          state = 'AUTH_USER';
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (upper.startsWith('MAIL FROM:')) {
          current.mailFrom = line.slice(10).trim();
          socket.write('250 2.1.0 Ok\r\n');
        } else if (upper.startsWith('RCPT TO:')) {
          current.rcptTo.push(line.slice(8).trim());
          socket.write('250 2.1.5 Ok\r\n');
        } else if (upper === 'DATA') {
          state = 'DATA';
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          if (buf.length > 0) {
            const endIdx = buf.indexOf('\r\n.\r\n');
            if (endIdx !== -1) {
              current.rawData += buf.slice(0, endIdx);
              buf = buf.slice(endIdx + 5);
              captured.push(current);
              current = { user: '', pass: '', mailFrom: '', rcptTo: [], rawData: '' };
              state = 'CMD';
              socket.write('250 2.0.0 OK queued\r\n');
            }
          }
          break;
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 Ok\r\n');
        }
      }
    });
  });

  return { server, captured };
}

async function jsonReq(baseUrl, route, { method = 'GET', token, body, headers = {} } = {}) {
  const reqHeaders = { ...headers };
  if (token) reqHeaders.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    if (typeof body === 'string') {
      payload = body;
    } else {
      payload = JSON.stringify(body);
      if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
    }
  }
  const resp = await fetch(`${baseUrl}${route}`, { method, headers: reqHeaders, body: payload });
  const text = await resp.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    parsed = text;
  }
  return { status: resp.status, headers: resp.headers, data: parsed, raw: text };
}

function build529ContactsCsv() {
  const header = 'First Name,Last Name,Email,Phone,Tags,Status,Source,Birthday,Injury Notes,Membership Tier';
  const rows = [header];
  for (let i = 1; i <= 529; i++) {
    const first = `Member${i}`;
    const last = i === 1 ? 'Martinez, Jr.' : `Tester${i}`;
    const email = `member${i}@cleanresults-test.example.com`;
    const phone = `(561) 555-${String(1000 + i).slice(-4)}`;
    const tags = i % 2 === 0 ? '"Body by Bobby, WPB"' : '"7-Day Pass, Meta Ad"';
    const injury =
      i === 1
        ? '"Left knee pain\r\nNeeds ""Body by Bobby"" modified squat"'
        : 'None reported';
    const bday = `199${i % 10}-0${(i % 9) + 1}-${String((i % 28) + 1).padStart(2, '0')}`;
    rows.push(`"${first}","${last}",${email},"${phone}",${tags},Active,Meta Ads,${bday},${injury},1-on-1 Coaching`);
  }
  return rows.join('\r\n');
}

function build473OpportunitiesCsv() {
  const header = 'Opportunity Name,First Name,Last Name,Email,Phone,Stage,Value,Source,Status';
  const stages = ['New Inquiry', 'Contacted', 'Trial Booked', 'Showed', 'Won/Member', 'Cold/Winback'];
  const rows = [header];
  for (let i = 1; i <= 473; i++) {
    const stage = stages[i % stages.length];
    const value = `$${(500 + (i % 15) * 100).toLocaleString('en-US')}.00`;
    rows.push(
      `"Lead Deal #${i}",Prospect${i},Athlete${i},opp${i}@cleanresults-test.example.com,561600${String(1000 + i).slice(-4)},${stage},"${value}",Meta Ads Body by Bobby,Open`
    );
  }
  return rows.join('\n');
}

async function runTests() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivvak-backend-test-'));
  const isolatedEnv = {
    ADMIN_PASSCODE: 'Jh22mp21??.',
    META_VERIFY_TOKEN: 'rivvak-meta-verify-2026',
    ALLOWED_ORIGINS: 'https://rivvak.com,https://www.rivvak.com',
  };

  let passed = 0;
  const check = (label, fn) => async () => {
    await fn();
    passed++;
    console.log(`  [PASS] ${label}`);
  };

  let instance = null;
  let webhookReceiver = null;
  const receivedWebhooks = [];

  try {
    // Ephemeral local webhook receiver to verify outbound webhook forwarding without external calls
    webhookReceiver = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          receivedWebhooks.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"received":true}');
      });
    });
    await new Promise((resolve) => webhookReceiver.listen(0, '127.0.0.1', resolve));
    const webhookUrl = `http://127.0.0.1:${webhookReceiver.address().port}/hook`;

    instance = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir: tmpDir,
      enableScheduler: false,
      loadEnv: false,
      env: isolatedEnv,
    });

    assert.ok(instance.port > 0, 'Server should bind ephemeral port > 0');
    assert.ok(fs.existsSync(instance.storePath), 'store.json should auto-initialize');

    const baseUrl = instance.url;

    const suites = [
      check('1. Health endpoint & CORS origin validation', async () => {
        const h = await jsonReq(baseUrl, '/api/health', {
          headers: { Origin: 'https://rivvak.com' },
        });
        assert.strictEqual(h.status, 200);
        assert.strictEqual(h.data.ok, true);
        assert.strictEqual(h.data.clients, 3);
        assert.strictEqual(h.headers.get('access-control-allow-origin'), 'https://rivvak.com');

        const shopifyOriginPreflight = await fetch(`${baseUrl}/api/health`, {
          method: 'OPTIONS',
          headers: { Origin: 'https://fdguvq-yv.myshopify.com' },
        });
        assert.strictEqual(shopifyOriginPreflight.status, 204);
        assert.strictEqual(shopifyOriginPreflight.headers.get('access-control-allow-origin'), 'https://fdguvq-yv.myshopify.com');

        const localPreflight = await fetch(`${baseUrl}/api/health`, {
          method: 'OPTIONS',
          headers: { Origin: 'http://localhost:3000' },
        });
        assert.strictEqual(localPreflight.status, 204);
        assert.strictEqual(localPreflight.headers.get('access-control-allow-origin'), 'http://localhost:3000');

        const badPreflight = await fetch(`${baseUrl}/api/health`, {
          method: 'OPTIONS',
          headers: { Origin: 'https://evil-phish.example' },
        });
        assert.strictEqual(badPreflight.status, 403);
        assert.strictEqual(badPreflight.headers.get('access-control-allow-origin'), null);
      }),

      check('2. Unauthenticated requests return 401 Unauthorized', async () => {
        const s1 = await jsonReq(baseUrl, '/api/state');
        assert.strictEqual(s1.status, 401);
        const s2 = await jsonReq(baseUrl, '/api/client/clean-results/sync');
        assert.strictEqual(s2.status, 401);
      }),

      check('3. Admin Bearer auth reads seeded store & manages cross-client state', async () => {
        const stateRes = await jsonReq(baseUrl, '/api/state', { token: 'Jh22mp21??.' });
        assert.strictEqual(stateRes.status, 200);
        assert.ok(stateRes.data.clients['clean-results'], 'Clean Results client seeded');
        assert.ok(stateRes.data.clients['carleen-ligozio'], 'Carleen Ligozio client seeded');
        assert.ok(stateRes.data.clients['blue-diamond-pools'], 'Blue Diamond Pools client seeded');
        const cr = stateRes.data.clients['clean-results'];
        assert.strictEqual(cr.workflows.length, 7, 'Clean Results seeded with 7 gym workflows');
        assert.ok(
          cr.campaigns.some((c) => c.name.includes('CleanResults_ "Body by Bobby!"')),
          'Meta Ad campaign seeded'
        );

        const carleenSync = await jsonReq(baseUrl, '/api/client/carleen-ligozio/sync', { token: 'Jh22mp21??.' });
        assert.strictEqual(carleenSync.status, 200);
        assert.strictEqual(carleenSync.data.client.business, 'Carleen Ligozio');

        const created = await jsonReq(baseUrl, '/api/admin/clients', {
          method: 'POST',
          token: 'Jh22mp21??.',
          body: { business: 'Temp Test Studio', accessCode: 'TEMP-2026' },
        });
        assert.strictEqual(created.status, 201);
        assert.strictEqual(created.data.slug, 'temp-test-studio');

        const deleted = await jsonReq(baseUrl, '/api/admin/clients/temp-test-studio', {
          method: 'DELETE',
          token: 'Jh22mp21??.',
        });
        assert.strictEqual(deleted.status, 200);
        assert.strictEqual(deleted.data.deleted, 'temp-test-studio');
      }),

      check('4. Client Bearer auth strictly isolates tenant (403 on Admin & Carleen)', async () => {
        const ownSync = await jsonReq(baseUrl, '/api/client/clean-results/sync', { token: 'CLEAN-2026' });
        assert.strictEqual(ownSync.status, 200);
        assert.strictEqual(ownSync.data.slug, 'clean-results');

        const adminStateDenied = await jsonReq(baseUrl, '/api/state', { token: 'CLEAN-2026' });
        assert.strictEqual(adminStateDenied.status, 403);

        const adminRouteDenied = await jsonReq(baseUrl, '/api/admin/clients', { token: 'CLEAN-2026' });
        assert.strictEqual(adminRouteDenied.status, 403);

        const adminSchedDenied = await jsonReq(baseUrl, '/api/admin/scheduler/tick', {
          method: 'POST',
          token: 'CLEAN-2026',
          body: {},
        });
        assert.strictEqual(adminSchedDenied.status, 403);

        const otherTenantDenied = await jsonReq(baseUrl, '/api/client/carleen-ligozio/sync', { token: 'CLEAN-2026' });
        assert.strictEqual(otherTenantDenied.status, 403);

        const updateOwn = await jsonReq(baseUrl, '/api/client/clean-results', {
          method: 'PUT',
          token: 'CLEAN-2026',
          body: { customUrl: 'https://cleanresultshouseoffitness.example' },
        });
        assert.strictEqual(updateOwn.status, 200);
        assert.strictEqual(updateOwn.data.client.accessCode, 'CLEAN-2026');
      }),

      check('5. RFC-4180 CSV parser + 529-contact PushPress import & duplicate merge', async () => {
        const csv529 = build529ContactsCsv();
        const parsedPreview = parseCsv(csv529);
        assert.strictEqual(parsedPreview.length, 529);
        assert.strictEqual(parsedPreview[0]['Last Name'], 'Martinez, Jr.');
        assert.ok(parsedPreview[0]['Injury Notes'].includes('Needs "Body by Bobby" modified squat'));

        const imp = await jsonReq(baseUrl, '/api/client/clean-results/import-csv', {
          method: 'POST',
          token: 'CLEAN-2026',
          body: { kind: 'contacts', csvText: csv529 },
        });
        assert.strictEqual(imp.status, 200);
        assert.strictEqual(imp.data.added, 529);
        assert.strictEqual(imp.data.updated, 0);
        assert.strictEqual(imp.data.total, 532);

        // Merge duplicate by email + duplicate by phone + 1 brand-new contact
        const mergeCsv = [
          'First Name,Last Name,Email,Phone,Tags,Injury Notes',
          'Member1,Martinez,member1@cleanresults-test.example.com,,VIP Upgrade,"Cleared for squats"',
          'Member2,Tester2,,561-555-1002,VIP Renewal,""',
          'Brand,NewLead,brand.new@example.com,561-555-9876,Walk-In,""',
        ].join('\n');

        const imp2 = await jsonReq(baseUrl, '/api/client/clean-results/import-csv', {
          method: 'POST',
          token: 'CLEAN-2026',
          body: { kind: 'contacts', csvText: mergeCsv },
        });
        assert.strictEqual(imp2.status, 200);
        assert.strictEqual(imp2.data.added, 1);
        assert.strictEqual(imp2.data.updated, 2);
        assert.strictEqual(imp2.data.total, 533);
      }),

      check('6. 473-opportunity PushPress CSV import & deduplication', async () => {
        const csv473 = build473OpportunitiesCsv();
        const imp = await jsonReq(baseUrl, '/api/client/clean-results/import-csv', {
          method: 'POST',
          token: 'CLEAN-2026',
          body: { kind: 'opportunities', csvText: csv473 },
        });
        assert.strictEqual(imp.status, 200);
        assert.strictEqual(imp.data.added, 473);
        assert.strictEqual(imp.data.updated, 0);
        assert.strictEqual(imp.data.total, 479);

        // Duplicate by email + duplicate by name+stage (no email/phone)
        const dupCsv = [
          'Opportunity Name,First Name,Last Name,Email,Phone,Stage,Value',
          'Lead Deal #1 Updated,Prospect1,Athlete1,opp1@cleanresults-test.example.com,,Booked,"$2,400"',
          'Jordan Deal Update,Jordan,Perez,,,New Lead,"$1,100"',
        ].join('\n');

        const imp2 = await jsonReq(baseUrl, '/api/client/clean-results/import-csv', {
          method: 'POST',
          token: 'CLEAN-2026',
          body: { kind: 'opportunities', csvText: dupCsv },
        });
        assert.strictEqual(imp2.status, 200);
        assert.strictEqual(imp2.data.added, 0);
        assert.strictEqual(imp2.data.updated, 2);
        assert.strictEqual(imp2.data.total, 479);
      }),

      check('7. Inbound Twilio SMS webhook appends to Unified Inbox', async () => {
        const bodyParams = new URLSearchParams({
          From: '+15615559999',
          To: '+15613242189',
          Body: 'Can I book a Body by Bobby tour today at 5pm?',
          MessageSid: 'SM_TEST_001',
        }).toString();

        const twRes = await jsonReq(baseUrl, '/webhooks/twilio', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: bodyParams,
        });
        assert.strictEqual(twRes.status, 200);
        assert.strictEqual(twRes.data.clientSlug, 'clean-results');
        assert.strictEqual(twRes.data.channel, 'SMS');
        assert.strictEqual(twRes.data.unread, 1);

        const sync = await jsonReq(baseUrl, '/api/client/clean-results/sync', { token: 'CLEAN-2026' });
        const smsThread = sync.data.client.inboxThreads.find((t) => t.id === twRes.data.threadId);
        assert.ok(smsThread);
        assert.strictEqual(smsThread.messages[smsThread.messages.length - 1].body, 'Can I book a Body by Bobby tour today at 5pm?');
      }),

      check('8. Inbound Meta GET verification & POST IG DM into Unified Inbox', async () => {
        const badVerify = await jsonReq(
          baseUrl,
          '/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=111'
        );
        assert.strictEqual(badVerify.status, 403);

        const goodVerify = await jsonReq(
          baseUrl,
          '/webhooks/meta?hub.mode=subscribe&hub.verify_token=rivvak-meta-verify-2026&hub.challenge=CHALLENGE_98765'
        );
        assert.strictEqual(goodVerify.status, 200);
        assert.strictEqual(goodVerify.raw, 'CHALLENGE_98765');

        const igEvent = {
          object: 'instagram',
          entry: [
            {
              id: 'ig_page_clean_results',
              messaging: [
                {
                  sender: { id: 'ig_sender_44', username: '@wpb_lifter' },
                  recipient: { id: 'ig_page_clean_results' },
                  message: { mid: 'mid_test_1', text: 'What is included in 1-on-1 coaching?' },
                },
              ],
            },
          ],
        };
        const postMeta = await jsonReq(baseUrl, '/webhooks/meta?client=clean-results', {
          method: 'POST',
          body: igEvent,
        });
        assert.strictEqual(postMeta.status, 200);
        assert.strictEqual(postMeta.data.processed, 1);

        const sync = await jsonReq(baseUrl, '/api/client/clean-results/sync', { token: 'CLEAN-2026' });
        const igThread = sync.data.client.inboxThreads.find((t) => t.recipientId === 'ig_sender_44');
        assert.ok(igThread);
        assert.strictEqual(igThread.channel, 'Instagram DM');
        assert.strictEqual(igThread.unread, 1);
      }),

      check('9. Inbound Google Business Profile review webhook appends to Unified Inbox', async () => {
        const gbp = await jsonReq(baseUrl, '/webhooks/gbp-review', {
          method: 'POST',
          body: {
            clientSlug: 'clean-results',
            reviewerName: 'Carlos D.',
            rating: 5,
            comment: 'Best private training gym in West Palm Beach.',
          },
        });
        assert.strictEqual(gbp.status, 200);
        assert.strictEqual(gbp.data.channel, 'Google Reviews');
        assert.strictEqual(gbp.data.unread, 1);
      }),

      check('10. Outbound send-sms / send-email / send-ig-dm honest dry_run_queued + webhook forward', async () => {
        const smsRes = await jsonReq(baseUrl, '/api/client/clean-results/send-sms', {
          method: 'POST',
          token: 'CLEAN-2026',
          body: {
            to: '+15615559999',
            body: 'Hey! Bobby here — 5pm today is wide open.',
            webhookUrl,
          },
        });
        assert.strictEqual(smsRes.status, 200);
        assert.strictEqual(smsRes.data.ok, true);
        assert.strictEqual(smsRes.data.mode, 'dry_run_queued');
        assert.deepStrictEqual(smsRes.data.missingEnv, [
          'TWILIO_ACCOUNT_SID',
          'TWILIO_AUTH_TOKEN',
          'TWILIO_FROM_NUMBER',
        ]);
        assert.strictEqual(smsRes.data.webhookResult.ok, true);

        const emailRes = await jsonReq(baseUrl, '/api/client/clean-results/send-email', {
          method: 'POST',
          token: 'CLEAN-2026',
          body: { to: 'lead@example.com', subject: 'Welcome', body: 'See you soon!' },
        });
        assert.strictEqual(emailRes.data.mode, 'dry_run_queued');
        assert.deepStrictEqual(emailRes.data.missingEnv, ['RESEND_API_KEY or SMTP_*']);

        const igRes = await jsonReq(baseUrl, '/api/client/clean-results/send-ig-dm', {
          method: 'POST',
          token: 'CLEAN-2026',
          body: { recipientId: 'ig_sender_44', body: 'Custom programming + nutrition!' },
        });
        assert.strictEqual(igRes.data.mode, 'dry_run_queued');
        assert.deepStrictEqual(igRes.data.missingEnv, ['META_ACCESS_TOKEN', 'META_IG_USER_ID']);
        assert.ok(receivedWebhooks.length >= 1, 'Webhook forwarder received outbound event');
      }),

      check('11. Manual workflow trigger executes cleanly and logs run', async () => {
        const trig = await jsonReq(baseUrl, '/api/client/clean-results/trigger-workflow', {
          method: 'POST',
          token: 'CLEAN-2026',
          body: {
            workflowId: 'wf_speed_to_lead',
            contact: { firstName: 'BobbyTest', phone: '+15615550001' },
            webhookUrl,
          },
        });
        assert.strictEqual(trig.status, 200);
        assert.strictEqual(trig.data.ok, true);
        assert.strictEqual(trig.data.mode, 'dry_run_queued');
        assert.ok(trig.data.executionLog.message.includes('BobbyTest'));
        assert.strictEqual(trig.data.workflowRunCount, 49);
      }),

      check('12. 24/7 Scheduler tick covers bookings, birthdays, retention, social posts + idempotency', async () => {
        // Seed deterministic test records via PUT /api/client/clean-results
        const sync = await jsonReq(baseUrl, '/api/client/clean-results/sync', { token: 'CLEAN-2026' });
        const client = sync.data.client;
        const fixedNow = '2026-11-21T12:00:00.000Z';

        client.bookings.push({
          id: 'bk_sched_2h',
          leadName: 'Sched TwoHour',
          phone: '+15615557777',
          email: 'sched2h@example.com',
          sessionType: 'Strength Assessment',
          staff: 'Bobby',
          scheduledAt: '2026-11-21T13:30:00.000Z',
          status: 'Confirmed',
        });
        client.contacts.push(
          {
            id: 'ct_bday_today',
            firstName: 'Birthday',
            lastName: 'Member',
            name: 'Birthday Member',
            phone: '+15615558888',
            birthday: '1992-11-21',
            joinedAt: '2026-10-01',
            lastCheckInAt: '2026-11-20',
          },
          {
            id: 'ct_ret_7d',
            firstName: 'SevenDay',
            lastName: 'Member',
            name: 'SevenDay Member',
            phone: '+15615558889',
            birthday: '1990-01-01',
            joinedAt: '2026-11-14',
            lastCheckInAt: '2026-11-14',
          }
        );
        client.marketing.scheduledPosts.push({
          id: 'sp_due_now',
          platform: 'IG Reel',
          title: 'Due Reel Post',
          caption: 'Live floor highlights',
          scheduledAt: '2026-11-21T11:00:00.000Z',
          status: 'Scheduled',
        });

        await jsonReq(baseUrl, '/api/client/clean-results', {
          method: 'PUT',
          token: 'CLEAN-2026',
          body: client,
        });

        // Verify direct exported runSchedulerTick as well as HTTP endpoint
        const tick1 = await jsonReq(baseUrl, '/api/client/clean-results/scheduler/tick', {
          method: 'POST',
          token: 'CLEAN-2026',
          body: { now: fixedNow },
        });
        assert.strictEqual(tick1.status, 200);
        assert.strictEqual(tick1.data.ok, true);

        const categories = tick1.data.results.map((r) => r.category);
        assert.ok(categories.includes('booking_reminder_2h'), '2h booking reminder fired');
        assert.ok(categories.includes('member_birthday'), 'Member birthday MM-DD fired');
        assert.ok(categories.includes('retention_7d'), '7-day retention check-in fired');
        assert.ok(categories.includes('scheduled_post'), 'Due scheduled post fired');

        // Idempotent second tick at same timestamp fires 0 duplicates
        const tick2 = await runSchedulerTick('clean-results', {
          dataDir: tmpDir,
          now: fixedNow,
          env: isolatedEnv,
        });
        assert.strictEqual(tick2.processedCount, 0, 'Second scheduler tick must be idempotent');

        // Verify post status honestly reflects dry-run queued
        const after = await jsonReq(baseUrl, '/api/client/clean-results/sync', { token: 'CLEAN-2026' });
        const duePost = after.data.client.marketing.scheduledPosts.find((p) => p.id === 'sp_due_now');
        assert.strictEqual(duePost.status, 'Queued (Dry-Run)');

        // Verify Admin global scheduler tick endpoint runs across clients cleanly
        const adminTick = await jsonReq(baseUrl, '/api/admin/scheduler/tick', {
          method: 'POST',
          token: 'Jh22mp21??.',
          body: { clientSlug: 'carleen-ligozio', now: fixedNow },
        });
        assert.strictEqual(adminTick.status, 200);
        assert.strictEqual(adminTick.data.ok, true);
      }),

      check('13. Native SMTP wire protocol (AUTH LOGIN, headers, dot-stuffing) & /send-email live_smtp mode', async () => {
        const mockSmtp = createMockSmtpServer();
        await new Promise((resolve) => mockSmtp.server.listen(0, '127.0.0.1', resolve));
        const smtpPort = mockSmtp.server.address().port;
        const smtpTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivvak-smtp-test-'));
        let smtpApiInstance = null;

        try {
          const direct = await sendSmtpEmail({
            host: '127.0.0.1',
            port: smtpPort,
            user: 'connect@rivvak.com',
            pass: 'unit-test-secret',
            from: 'Rivvak Media <connect@rivvak.com>',
            to: 'Bobby <bobby@cleanresults.example>',
            subject: 'Body by Bobby — SMTP Wire Test',
            text: 'Line 1\n.LeadingDotLine\nLine 3',
            plain: true,
          });
          assert.strictEqual(direct.ok, true);
          assert.ok(/^<.+@rivvak\.com>$/.test(direct.messageId));
          assert.strictEqual(mockSmtp.captured.length, 1);
          assert.strictEqual(mockSmtp.captured[0].user, 'connect@rivvak.com');
          assert.strictEqual(mockSmtp.captured[0].pass, 'unit-test-secret');
          assert.strictEqual(mockSmtp.captured[0].mailFrom, '<connect@rivvak.com>');
          assert.strictEqual(mockSmtp.captured[0].rcptTo[0], '<bobby@cleanresults.example>');
          assert.ok(mockSmtp.captured[0].rawData.includes('Content-Type: text/plain; charset=UTF-8'));
          assert.ok(mockSmtp.captured[0].rawData.includes('\r\n..LeadingDotLine\r\n'), 'Dot-stuffing must escape leading dots');

          smtpApiInstance = await startServer({
            port: 0,
            host: '127.0.0.1',
            dataDir: smtpTmpDir,
            enableScheduler: false,
            loadEnv: false,
            env: {
              ADMIN_PASSCODE: 'Jh22mp21??.',
              SMTP_HOST: '127.0.0.1',
              SMTP_PORT: String(smtpPort),
              SMTP_USER: 'connect@rivvak.com',
              SMTP_PASS: 'unit-test-secret',
              SMTP_FROM: 'Rivvak Media <connect@rivvak.com>',
              SMTP_PLAIN: 'true',
            },
          });

          const apiRes = await jsonReq(smtpApiInstance.url, '/api/client/clean-results/send-email', {
            method: 'POST',
            token: 'CLEAN-2026',
            body: {
              to: 'lead@cleanresults.example',
              subject: 'Welcome to Clean Results',
              body: 'Your 1-on-1 tour is confirmed!',
            },
          });
          assert.strictEqual(apiRes.status, 200);
          assert.strictEqual(apiRes.data.ok, true);
          assert.strictEqual(apiRes.data.mode, 'live_smtp');
          assert.ok(/^<.+@rivvak\.com>$/.test(apiRes.data.messageId));
          assert.strictEqual(mockSmtp.captured.length, 2);
          assert.ok(mockSmtp.captured[1].rawData.includes('Your 1-on-1 tour is confirmed!'));
        } finally {
          if (smtpApiInstance) await smtpApiInstance.stop().catch(() => {});
          await new Promise((resolve) => mockSmtp.server.close(resolve));
          fs.rmSync(smtpTmpDir, { recursive: true, force: true });
        }
      }),

      check('14. Live non-sending TLS AUTH LOGIN verification via .env (mail.privateemail.com:465)', async () => {
        const localEnv = parseDotEnvFile(path.join(__dirname, '.env'));
        assert.ok(localEnv.SMTP_HOST && localEnv.SMTP_USER && localEnv.SMTP_PASS, 'Local .env must define SMTP credentials');
        const authRes = await verifySmtpAuth({
          host: localEnv.SMTP_HOST,
          port: Number(localEnv.SMTP_PORT || 465),
          user: localEnv.SMTP_USER,
          pass: localEnv.SMTP_PASS,
        });
        assert.strictEqual(authRes.ok, true);
        assert.strictEqual(authRes.authenticated, true);
        assert.strictEqual(authRes.host, 'mail.privateemail.com');
        assert.strictEqual(authRes.port, 465);
      }),

      check('15. GET / HTML dashboard & JSON status, upgraded /api/health, security headers, zero "Rivvak Digital"', async () => {
        const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
        assert.strictEqual(/Rivvak Digital/i.test(serverSource), false, 'server.js must not contain Rivvak Digital');

        const rootHtml = await jsonReq(baseUrl, '/', {
          headers: { Accept: 'text/html,application/xhtml+xml' },
        });
        assert.strictEqual(rootHtml.status, 200);
        assert.ok(rootHtml.headers.get('content-type').includes('text/html'));
        assert.ok(rootHtml.raw.includes('#09090B'));
        assert.ok(rootHtml.raw.includes('Rivvak Media — Cloud Automation Engine'));
        assert.ok(rootHtml.raw.includes('ONLINE'));
        assert.ok(rootHtml.raw.includes('2.0.0'));
        assert.ok(rootHtml.raw.includes('Dry-Run'));
        assert.ok(rootHtml.raw.includes('/api/health'));
        assert.ok(rootHtml.raw.includes('https://rivvak.com/'));
        assert.strictEqual(/Rivvak Digital/i.test(rootHtml.raw), false);
        assert.strictEqual(rootHtml.headers.get('x-content-type-options'), 'nosniff');
        assert.strictEqual(rootHtml.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
        assert.strictEqual(rootHtml.headers.get('x-frame-options'), 'DENY');

        const rootJson = await jsonReq(baseUrl, '/', {
          headers: { Accept: 'application/json' },
        });
        assert.strictEqual(rootJson.status, 200);
        assert.strictEqual(rootJson.data.ok, true);
        assert.strictEqual(rootJson.data.service, 'rivvak-automation-backend');
        assert.strictEqual(rootJson.data.brand, 'Rivvak Media');
        assert.strictEqual(rootJson.data.version, '2.0.0');
        assert.strictEqual(rootJson.data.status, 'online');
        assert.strictEqual(typeof rootJson.data.uptimeSeconds, 'number');
        assert.strictEqual(rootJson.data.clients, 3);
        assert.strictEqual(rootJson.data.publicLeadsCount, 1);
        assert.strictEqual(rootJson.data.smtpConfigured, false);
        assert.ok(rootJson.data.endpoints && rootJson.data.endpoints.health === '/api/health');

        const rootForceJson = await jsonReq(baseUrl, '/?format=json', {
          headers: { Accept: 'text/html' },
        });
        assert.strictEqual(rootForceJson.status, 200);
        assert.strictEqual(rootForceJson.data.version, '2.0.0');

        const health = await jsonReq(baseUrl, '/api/health');
        assert.strictEqual(health.status, 200);
        assert.strictEqual(health.data.brand, 'Rivvak Media');
        assert.strictEqual(health.data.version, '2.0.0');
        assert.strictEqual(health.data.publicLeads, 1);
        assert.strictEqual(health.data.smtpConfigured, false);
        assert.strictEqual(typeof health.data.uptimeSeconds, 'number');
      }),

      check('16. POST /api/public/lead (happy path + mock SMTP alert & 72h auto-reply + honeypot + 429 rate limit)', async () => {
        const mockSmtp = createMockSmtpServer();
        await new Promise((resolve) => mockSmtp.server.listen(0, '127.0.0.1', resolve));
        const smtpPort = mockSmtp.server.address().port;
        const leadTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivvak-lead-test-'));
        let leadServer = null;

        try {
          leadServer = await startServer({
            port: 0,
            host: '127.0.0.1',
            dataDir: leadTmpDir,
            enableScheduler: false,
            loadEnv: false,
            env: {
              ADMIN_PASSCODE: 'Jh22mp21??.',
              SMTP_HOST: '127.0.0.1',
              SMTP_PORT: String(smtpPort),
              SMTP_USER: 'connect@rivvak.com',
              SMTP_PASS: 'mock-smtp-pass',
              SMTP_FROM: 'Rivvak Media <connect@rivvak.com>',
              SMTP_PLAIN: 'true',
              AUTO_REPLY_LEADS: 'true',
            },
          });

          const happy = await jsonReq(leadServer.url, '/api/public/lead', {
            method: 'POST',
            headers: { Origin: 'https://rivvak.com' },
            body: {
              name: 'Sam Rivera',
              business: 'Palm Beach Marine',
              email: 'sam@pbmarine.example',
              phone: '(561) 555-0144',
              industry: 'Service & Trades',
              scope: 'Growth Build + Local SEO',
              estimatedSetup: '$1,650',
              estimatedMonthly: '$450/mo',
              message: 'Need a 72-hour staging link before Friday.',
              source: 'calculator-form',
              pageUrl: 'https://rivvak.com/#calculator',
              ticketId: 'RV-TEST-101',
              _hp: '',
            },
          });
          assert.strictEqual(happy.status, 201);
          assert.strictEqual(happy.headers.get('access-control-allow-origin'), 'https://rivvak.com');
          assert.strictEqual(happy.data.ok, true);
          assert.ok(happy.data.leadId.startsWith('lead_'));
          assert.strictEqual(happy.data.ticketId, 'RV-TEST-101');
          assert.strictEqual(happy.data.emailDispatched, true);
          assert.strictEqual(happy.data.mode, 'live_smtp');

          // Agency alert + branded 72-hour receipt auto-reply
          assert.strictEqual(mockSmtp.captured.length, 2);
          assert.strictEqual(mockSmtp.captured[0].rcptTo[0], '<connect@rivvak.com>');
          assert.ok(mockSmtp.captured[0].rawData.includes('Palm Beach Marine'));
          assert.strictEqual(mockSmtp.captured[1].mailFrom, '<connect@rivvak.com>');
          assert.strictEqual(mockSmtp.captured[1].rcptTo[0], '<sam@pbmarine.example>');
          assert.ok(mockSmtp.captured[1].rawData.includes('Rivvak Media <connect@rivvak.com>'));
          assert.ok(mockSmtp.captured[1].rawData.includes('72-hour'));

          // Honeypot _hp silently returns 200 ignored without saving or emailing
          const spam = await jsonReq(leadServer.url, '/api/public/lead', {
            method: 'POST',
            body: {
              name: 'Spam Bot',
              email: 'bot@spam.example',
              message: 'Buy crypto',
              _hp: 'http://spam.example',
            },
          });
          assert.strictEqual(spam.status, 200);
          assert.deepStrictEqual(spam.data, { ok: true, ignored: true });
          assert.strictEqual(mockSmtp.captured.length, 2);

          // Rate limit: 2 requests already used from 127.0.0.1; send 8 more valid/honeypot, then 11th -> 429
          for (let i = 0; i < 8; i++) {
            const okReq = await jsonReq(leadServer.url, '/api/public/lead', {
              method: 'POST',
              body: { _hp: 'skip', message: `burst-${i}` },
            });
            assert.strictEqual(okReq.status, 200);
          }
          const limited = await jsonReq(leadServer.url, '/api/public/lead', {
            method: 'POST',
            body: { name: 'Rate Limited', email: 'over@limit.example', message: 'Too fast' },
          });
          assert.strictEqual(limited.status, 429);
          assert.strictEqual(limited.data.error, 'Too Many Requests');
        } finally {
          if (leadServer) await leadServer.stop().catch(() => {});
          await new Promise((resolve) => mockSmtp.server.close(resolve));
          fs.rmSync(leadTmpDir, { recursive: true, force: true });
        }
      }),

      check('17. Admin leads GET/PATCH + seeded Blue Diamond Pools + 403 client isolation', async () => {
        const deniedClient = await jsonReq(baseUrl, '/api/admin/leads', { token: 'CLEAN-2026' });
        assert.strictEqual(deniedClient.status, 403);

        const deniedPatch = await jsonReq(baseUrl, '/api/admin/leads/lead_blue_diamond_pools', {
          method: 'PATCH',
          token: 'CARLEEN-2026',
          body: { status: 'won' },
        });
        assert.strictEqual(deniedPatch.status, 403);

        const listRes = await jsonReq(baseUrl, '/api/admin/leads', { token: 'Jh22mp21??.' });
        assert.strictEqual(listRes.status, 200);
        assert.strictEqual(listRes.data.ok, true);
        const bdp = listRes.data.leads.find((l) => l.business === 'Blue Diamond Pools');
        assert.ok(bdp, 'Blue Diamond Pools seeded in createDefaultStore()');
        assert.strictEqual(bdp.name, 'Jaime');
        assert.strictEqual(bdp.website, 'https://bluediamondpools.com/');
        assert.strictEqual(bdp.phone, '(954) 755-0777');
        assert.strictEqual(bdp.email, 'info@bluediamondpools.com');
        assert.strictEqual(bdp.location, 'Broward & Palm Beach County');
        assert.strictEqual(bdp.status, 'qualified');
        assert.strictEqual(bdp.source, 'Google Doc — Jaime Pool Company');

        const badStatus = await jsonReq(baseUrl, `/api/admin/leads/${bdp.id}`, {
          method: 'PATCH',
          token: 'Jh22mp21??.',
          body: { status: 'invalid-stage' },
        });
        assert.strictEqual(badStatus.status, 400);

        const patched = await jsonReq(baseUrl, `/api/admin/leads/${bdp.id}`, {
          method: 'PATCH',
          token: 'Jh22mp21??.',
          body: { status: 'contacted', notes: 'Walkthrough scheduled for Tuesday at 2pm.' },
        });
        assert.strictEqual(patched.status, 200);
        assert.strictEqual(patched.data.lead.status, 'contacted');
        assert.strictEqual(patched.data.lead.notes, 'Walkthrough scheduled for Tuesday at 2pm.');
      }),

      check('18. Admin backup & restore round-trip + atomic .bak recovery in loadStore()', async () => {
        const bakTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivvak-backup-test-'));
        let bakServer = null;
        try {
          bakServer = await startServer({
            port: 0,
            host: '127.0.0.1',
            dataDir: bakTmpDir,
            enableScheduler: false,
            loadEnv: false,
            env: { ADMIN_PASSCODE: 'Jh22mp21??.' },
          });

          const denied = await jsonReq(bakServer.url, '/api/admin/backup', { token: 'CLEAN-2026' });
          assert.strictEqual(denied.status, 403);

          const backupRes = await jsonReq(bakServer.url, '/api/admin/backup', { token: 'Jh22mp21??.' });
          assert.strictEqual(backupRes.status, 200);
          assert.strictEqual(
            backupRes.headers.get('content-disposition'),
            'attachment; filename="rivvak-store-backup.json"'
          );
          assert.ok(backupRes.data.clients['clean-results']);

          // Mutate store via a newly created client, then verify restore rolls back cleanly + writes .bak
          await jsonReq(bakServer.url, '/api/admin/clients', {
            method: 'POST',
            token: 'Jh22mp21??.',
            body: { business: 'Transient Studio', accessCode: 'TRANS-2026' },
          });

          const badRestore = await jsonReq(bakServer.url, '/api/admin/restore', {
            method: 'POST',
            token: 'Jh22mp21??.',
            body: { clients: 'not-an-object' },
          });
          assert.strictEqual(badRestore.status, 400);

          const restoreRes = await jsonReq(bakServer.url, '/api/admin/restore', {
            method: 'POST',
            token: 'Jh22mp21??.',
            body: backupRes.data,
          });
          assert.strictEqual(restoreRes.status, 200);
          assert.strictEqual(restoreRes.data.ok, true);
          assert.strictEqual(restoreRes.data.restoredClients, 3);
          assert.ok(fs.existsSync(`${bakServer.storePath}.bak`), 'Restore must preserve pre-restore .bak snapshot');

          const afterSync = await jsonReq(bakServer.url, '/api/state', { token: 'Jh22mp21??.' });
          assert.strictEqual(afterSync.data.clients['transient-studio'], undefined);

          // Simulate corrupted store.json -> loadStore() recovers from .bak
          const validSaved = loadStore(bakServer.storePath);
          validSaved.adminState.eoyTargetClients = 9;
          saveStore(bakServer.storePath, validSaved); // writes valid state to store.json & prior state to .bak
          saveStore(bakServer.storePath, validSaved); // ensures .bak also holds eoyTargetClients: 9
          fs.writeFileSync(bakServer.storePath, '{corrupted json!!!', 'utf8');
          const recovered = loadStore(bakServer.storePath);
          assert.strictEqual(recovered.adminState.eoyTargetClients, 9);
        } finally {
          if (bakServer) await bakServer.stop().catch(() => {});
          fs.rmSync(bakTmpDir, { recursive: true, force: true });
        }
      }),

      check('19. POST /webhooks/stripe HMAC-SHA256 verification (valid & invalid) + client payment logging', async () => {
        const stripeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivvak-stripe-test-'));
        const webhookSecret = 'whsec_test_rivvak_secret_2026';
        let stripeServer = null;

        const signStripe = (payloadObj, secretOverride = webhookSecret) => {
          const raw = JSON.stringify(payloadObj);
          const t = Math.floor(Date.now() / 1000);
          const sig = crypto.createHmac('sha256', secretOverride).update(`${t}.${raw}`, 'utf8').digest('hex');
          return { raw, sigHeader: `t=${t},v1=${sig}` };
        };

        try {
          stripeServer = await startServer({
            port: 0,
            host: '127.0.0.1',
            dataDir: stripeTmpDir,
            enableScheduler: false,
            loadEnv: false,
            env: {
              ADMIN_PASSCODE: 'Jh22mp21??.',
              STRIPE_WEBHOOK_SECRET: webhookSecret,
            },
          });

          const missingSig = await jsonReq(stripeServer.url, '/webhooks/stripe', {
            method: 'POST',
            body: { id: 'evt_bad_1', type: 'invoice.paid', data: { object: {} } },
          });
          assert.strictEqual(missingSig.status, 400);

          const badSigPayload = signStripe(
            { id: 'evt_bad_2', type: 'invoice.paid', data: { object: {} } },
            'wrong_secret'
          );
          const badSig = await jsonReq(stripeServer.url, '/webhooks/stripe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Stripe-Signature': badSigPayload.sigHeader },
            body: badSigPayload.raw,
          });
          assert.strictEqual(badSig.status, 400);

          const eventsToTest = [
            {
              id: 'evt_chk_1',
              type: 'checkout.session.completed',
              data: {
                object: {
                  customer: 'cus_cr_001',
                  subscription: 'sub_cr_001',
                  amount_total: 165000,
                  currency: 'usd',
                  payment_status: 'paid',
                  metadata: { clientSlug: 'clean-results' },
                },
              },
            },
            {
              id: 'evt_inv_paid_2',
              type: 'invoice.paid',
              data: {
                object: {
                  customer: 'cus_cr_001',
                  amount_paid: 45000,
                  currency: 'usd',
                  status: 'paid',
                  metadata: { clientSlug: 'clean-results' },
                },
              },
            },
            {
              id: 'evt_inv_fail_3',
              type: 'invoice.payment_failed',
              data: {
                object: {
                  customer: 'cus_cr_001',
                  amount_due: 45000,
                  currency: 'usd',
                  status: 'open',
                },
              },
            },
            {
              id: 'evt_sub_del_4',
              type: 'customer.subscription.deleted',
              data: {
                object: {
                  id: 'sub_cr_001',
                  customer: 'cus_cr_001',
                  status: 'canceled',
                },
              },
            },
          ];

          for (const ev of eventsToTest) {
            const signed = signStripe(ev);
            const res = await jsonReq(stripeServer.url, '/webhooks/stripe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signed.sigHeader },
              body: signed.raw,
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.data.ok, true);
            assert.strictEqual(res.data.handled, true);
            assert.strictEqual(res.data.clientSlug, 'clean-results');
          }

          const stored = loadStore(stripeServer.storePath);
          assert.strictEqual(stored.stripeEvents.length, 4);
          const cr = stored.clients['clean-results'];
          assert.strictEqual(cr.billing.status, 'canceled');
          assert.strictEqual(cr.paymentRecords.length, 4);
          assert.ok(cr.executionLogs.some((l) => l.workflowId === 'stripe_webhook' && l.mode === 'verified_stripe'));
        } finally {
          if (stripeServer) await stripeServer.stop().catch(() => {});
          fs.rmSync(stripeTmpDir, { recursive: true, force: true });
        }
      }),

      check('20. Email-inbox dry-run + mock IMAP + constant-time auth + 3d retainer scheduler + /overlay.js', async () => {
        // Constant-time safeEqualToken checks
        assert.strictEqual(safeEqualToken('Jh22mp21??.', 'Jh22mp21??.'), true);
        assert.strictEqual(safeEqualToken('Jh22mp21??.', 'RIVVAK-2027'), false);
        assert.strictEqual(safeEqualToken('short', 'much-longer-token'), false);
        assert.strictEqual(safeEqualToken('', ''), false);

        // /overlay.js & /api/client/carleen-ligozio/overlay.js 200 JS responses
        for (const overlayRoute of ['/overlay.js', '/api/client/carleen-ligozio/overlay.js']) {
          const ov = await jsonReq(baseUrl, overlayRoute);
          assert.strictEqual(ov.status, 200);
          assert.ok(ov.headers.get('content-type').includes('application/javascript'));
          assert.strictEqual(ov.headers.get('access-control-allow-origin'), '*');
          assert.ok(ov.raw.includes('CARLEEN_OVERLAY'));
        }

        // Honest dry_run_unconfigured when IMAP/SMTP creds absent + 403 for client tokens
        const clientDenied = await jsonReq(baseUrl, '/api/admin/email-inbox', { token: 'CLEAN-2026' });
        assert.strictEqual(clientDenied.status, 403);

        const dryInbox = await jsonReq(baseUrl, '/api/admin/email-inbox', { token: 'Jh22mp21??.' });
        assert.strictEqual(dryInbox.status, 200);
        assert.deepStrictEqual(dryInbox.data, {
          ok: true,
          mode: 'dry_run_unconfigured',
          messages: [],
        });

        // Mock loopback IMAP header summary check (zero live network calls)
        const mockImap = createMockImapServer();
        await new Promise((resolve) => mockImap.listen(0, '127.0.0.1', resolve));
        try {
          const imapPort = mockImap.address().port;
          const summary = await fetchImapInboxSummary({
            host: '127.0.0.1',
            port: imapPort,
            user: 'connect@rivvak.com',
            pass: 'unit-test-imap',
            limit: 12,
            timeoutMs: 8000,
            plain: true,
          });
          assert.strictEqual(summary.ok, true);
          assert.strictEqual(summary.mode, 'live_imap');
          assert.strictEqual(summary.messages.length, 2);
          assert.strictEqual(summary.messages[0].uid, 102);
          assert.strictEqual(summary.messages[0].from, 'Rivvak <connect@rivvak.com>');
          assert.strictEqual(summary.messages[0].seen, false);
          assert.strictEqual(summary.messages[1].uid, 101);
          assert.strictEqual(summary.messages[1].seen, true);
        } finally {
          await new Promise((resolve) => mockImap.close(resolve));
        }

        // 3-day-ahead retainer/renewal reminder idempotency in runSchedulerTick()
        const schedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivvak-retainer-sched-'));
        try {
          const store = loadStore(path.join(schedTmpDir, 'store.json'), isolatedEnv);
          store.clients['carleen-ligozio'].retainerDueAt = '2026-11-24T00:00:00.000Z';
          store.clients['carleen-ligozio'].retainerAmount = '$850/mo';
          saveStore(path.join(schedTmpDir, 'store.json'), store);

          const t1 = await runSchedulerTick('carleen-ligozio', {
            dataDir: schedTmpDir,
            now: '2026-11-21T12:00:00.000Z',
            env: isolatedEnv,
          });
          assert.ok(
            t1.results.some((r) => r.category === 'retainer_renewal_3d'),
            '3-day-ahead retainer reminder must fire'
          );

          const t2 = await runSchedulerTick('carleen-ligozio', {
            dataDir: schedTmpDir,
            now: '2026-11-21T12:00:00.000Z',
            env: isolatedEnv,
          });
          assert.strictEqual(t2.processedCount, 0, 'Retainer reminder must be idempotent');
        } finally {
          fs.rmSync(schedTmpDir, { recursive: true, force: true });
        }
      }),

      check('21. Rotated default fallback passcode + POST /api/admin/verify-passcode (CORS, JSON body & Bearer)', async () => {
        // Test default fallback when ADMIN_PASSCODE is omitted from env
        const fallbackTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivvak-fallback-pass-'));
        let fallbackServer = null;
        try {
          fallbackServer = await startServer({
            port: 0,
            host: '127.0.0.1',
            dataDir: fallbackTmpDir,
            enableScheduler: false,
            loadEnv: false,
            env: {},
          });

          const preflight = await fetch(`${fallbackServer.url}/api/admin/verify-passcode`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://rivvak.com' },
          });
          assert.strictEqual(preflight.status, 204);
          assert.strictEqual(preflight.headers.get('access-control-allow-origin'), 'https://rivvak.com');

          const oldPassState = await jsonReq(fallbackServer.url, '/api/state', { token: 'RIVVAK-2026' });
          assert.strictEqual(oldPassState.status, 401, 'Revoked RIVVAK-2026 must return 401');

          const newPassState = await jsonReq(fallbackServer.url, '/api/state', { token: 'Jh22mp21??.' });
          assert.strictEqual(newPassState.status, 200, 'Rotated default fallback Jh22mp21??. must return 200');

          const verifyBodyOk = await jsonReq(fallbackServer.url, '/api/admin/verify-passcode', {
            method: 'POST',
            headers: { Origin: 'https://rivvak.com' },
            body: { passcode: 'Jh22mp21??.' },
          });
          assert.strictEqual(verifyBodyOk.status, 200);
          assert.strictEqual(verifyBodyOk.headers.get('access-control-allow-origin'), 'https://rivvak.com');
          assert.deepStrictEqual(verifyBodyOk.data, { ok: true });

          const verifyBearerOk = await jsonReq(fallbackServer.url, '/api/admin/verify-passcode', {
            method: 'POST',
            token: 'Jh22mp21??.',
          });
          assert.strictEqual(verifyBearerOk.status, 200);
          assert.deepStrictEqual(verifyBearerOk.data, { ok: true });

          const verifyOldBody = await jsonReq(fallbackServer.url, '/api/admin/verify-passcode', {
            method: 'POST',
            body: { passcode: 'RIVVAK-2026' },
          });
          assert.strictEqual(verifyOldBody.status, 401);
          assert.deepStrictEqual(verifyOldBody.data, { ok: false, error: 'Invalid passcode' });

          const verifyOldBearer = await jsonReq(fallbackServer.url, '/api/admin/verify-passcode', {
            method: 'POST',
            token: 'RIVVAK-2026',
          });
          assert.strictEqual(verifyOldBearer.status, 401);
          assert.deepStrictEqual(verifyOldBearer.data, { ok: false, error: 'Invalid passcode' });

          const verifyEmpty = await jsonReq(fallbackServer.url, '/api/admin/verify-passcode', {
            method: 'POST',
            body: {},
          });
          assert.strictEqual(verifyEmpty.status, 401);
          assert.deepStrictEqual(verifyEmpty.data, { ok: false, error: 'Invalid passcode' });

          const verifyClient = await jsonReq(fallbackServer.url, '/api/admin/verify-passcode', {
            method: 'POST',
            body: { passcode: 'CLEAN-2026' },
          });
          assert.strictEqual(verifyClient.status, 401);
          assert.deepStrictEqual(verifyClient.data, { ok: false, error: 'Invalid passcode' });
        } finally {
          if (fallbackServer) await fallbackServer.stop().catch(() => {});
          fs.rmSync(fallbackTmpDir, { recursive: true, force: true });
        }
      }),

      check('22. GET /api/admin/integrations auth, boolean-only reporting & 15-integration coverage', async () => {
        const unauth = await jsonReq(baseUrl, '/api/admin/integrations');
        assert.strictEqual(unauth.status, 401);

        const revoked = await jsonReq(baseUrl, '/api/admin/integrations', { token: 'RIVVAK-2026' });
        assert.strictEqual(revoked.status, 401);

        const clientDenied = await jsonReq(baseUrl, '/api/admin/integrations', { token: 'CLEAN-2026' });
        assert.strictEqual(clientDenied.status, 403);

        // Partial env: ALLOWED_ORIGINS + META_VERIFY_TOKEN + built-in First-Party Analytics & Shopify Checkout
        const partialRes = await jsonReq(baseUrl, '/api/admin/integrations', { token: 'Jh22mp21??.' });
        assert.strictEqual(partialRes.status, 200);
        assert.strictEqual(partialRes.data.ok, true);
        assert.deepStrictEqual(partialRes.data.summary, { connected: 3, missing: 12, total: 15 });
        assert.strictEqual(partialRes.data.integrations.length, 15);
        assert.strictEqual(partialRes.raw.includes('rivvak-meta-verify-2026'), false, 'Never leak raw env values');
        assert.strictEqual(partialRes.raw.includes('Jh22mp21??.'), false, 'Never leak passcode');

        const firstPartyItem = partialRes.data.integrations.find((i) => i.id === 'rivvak-first-party-analytics');
        assert.ok(firstPartyItem && firstPartyItem.connected === true);
        const billingItem = partialRes.data.integrations.find((i) => i.id === 'shopify-checkout-billing');
        assert.ok(billingItem && billingItem.connected === true);
        const corsItem = partialRes.data.integrations.find((i) => i.name === 'Shopify Storefront CORS');
        assert.ok(corsItem && corsItem.connected === true);
        const metaItem = partialRes.data.integrations.find((i) => i.name === 'Meta / Facebook & Instagram');
        assert.ok(metaItem && metaItem.connected === false && metaItem.partial === true);
        assert.strictEqual(metaItem.env.META_VERIFY_TOKEN, true);
        assert.strictEqual(metaItem.env.META_ACCESS_TOKEN, false);
        assert.ok(metaItem.setupUrl && metaItem.setupUrl.startsWith('https://'));

        // Full env: verify 14/14 connected and zero raw secret strings leaked
        const fullTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivvak-int-full-'));
        let fullServer = null;
        try {
          const canarySecret = 'CANARY-TOP-SECRET-VALUE-9999';
          fullServer = await startServer({
            port: 0,
            host: '127.0.0.1',
            dataDir: fullTmpDir,
            enableScheduler: false,
            loadEnv: false,
            env: {
              ADMIN_PASSCODE: 'Jh22mp21??.',
              DATABASE_URL: `postgresql://user:${canarySecret}@127.0.0.1/neondb`,
              SMTP_HOST: 'mail.privateemail.com',
              SMTP_USER: 'connect@rivvak.com',
              SMTP_PASS: canarySecret,
              IMAP_HOST: 'mail.privateemail.com',
              ALLOWED_ORIGINS: 'https://rivvak.com',
              GA4_PROPERTY_ID: '123456789',
              GA4_SERVICE_ACCOUNT_JSON: canarySecret,
              GOOGLE_ADS_DEVELOPER_TOKEN: canarySecret,
              GOOGLE_ADS_CLIENT_ID: 'client-id',
              GOOGLE_ADS_CLIENT_SECRET: canarySecret,
              GOOGLE_ADS_REFRESH_TOKEN: canarySecret,
              GOOGLE_ADS_CUSTOMER_ID: '123-456-7890',
              META_ACCESS_TOKEN: canarySecret,
              META_AD_ACCOUNT_ID: 'act_123',
              META_IG_USER_ID: 'ig_123',
              META_VERIFY_TOKEN: canarySecret,
              TIKTOK_ACCESS_TOKEN: canarySecret,
              TIKTOK_ADVERTISER_ID: 'tt_123',
              GSC_SITE_URL: 'https://rivvak.com/',
              GOOGLE_SERVICE_ACCOUNT_JSON: canarySecret,
              STRIPE_SECRET_KEY: canarySecret,
              STRIPE_WEBHOOK_SECRET: canarySecret,
              TWILIO_ACCOUNT_SID: 'AC123',
              TWILIO_AUTH_TOKEN: canarySecret,
              TWILIO_FROM_NUMBER: '+15615550100',
              RESEND_API_KEY: canarySecret,
              RESEND_FROM: 'Rivvak Media <connect@rivvak.com>',
              WEBHOOK_URL: `https://hook.example/${canarySecret}`,
              SHOPIFY_SHOP_DOMAIN: 'fdguvq-yv.myshopify.com',
              SHOPIFY_CLIENT_ID: 'cid_full',
              SHOPIFY_CLIENT_SECRET: canarySecret,
            },
          });

          const fullRes = await jsonReq(fullServer.url, '/api/admin/integrations', { token: 'Jh22mp21??.' });
          assert.strictEqual(fullRes.status, 200);
          assert.strictEqual(fullRes.data.ok, true);
          assert.deepStrictEqual(fullRes.data.summary, { connected: 15, missing: 0, total: 15 });
          assert.strictEqual(fullRes.raw.includes(canarySecret), false, 'Response must contain booleans only, never values');
          for (const item of fullRes.data.integrations) {
            assert.strictEqual(item.connected, true);
            for (const val of Object.values(item.env)) {
              assert.strictEqual(typeof val, 'boolean');
            }
          }
        } finally {
          if (fullServer) await fullServer.stop().catch(() => {});
          fs.rmSync(fullTmpDir, { recursive: true, force: true });
        }
      }),

      check('23. POST /api/public/track deduplication, attribution & conversion persistence', async () => {
        // Two pageviews in same session -> 1 unique session, 2 pageviews
        const pv1 = await jsonReq(baseUrl, '/api/public/track', {
          method: 'POST',
          body: {
            type: 'pageview',
            path: '/demo/pool',
            client: 'blue-diamond-pools',
            sessionId: 'sess-pool-1',
            visitorId: 'vis-pool-1',
            referrer: 'https://www.google.com/search?q=pool+service',
            device: 'mobile',
          },
        });
        assert.strictEqual(pv1.status, 200);
        assert.strictEqual(pv1.data.client, 'blue-diamond-pools');

        const pv2 = await jsonReq(baseUrl, '/api/public/track', {
          method: 'POST',
          body: {
            type: 'pageview',
            path: '/demo/pool#book',
            sessionId: 'sess-pool-1',
            visitorId: 'vis-pool-1',
            device: 'mobile',
          },
        });
        assert.strictEqual(pv2.status, 200);
        assert.strictEqual(pv2.data.client, 'blue-diamond-pools');

        // Duplicate engaged beacons from same session count once
        await jsonReq(baseUrl, '/api/public/track', {
          method: 'POST',
          body: { type: 'engaged', path: '/demo/pool', client: 'blue-diamond-pools', sessionId: 'sess-pool-1' },
        });
        await jsonReq(baseUrl, '/api/public/track', {
          method: 'POST',
          body: { type: 'engaged', path: '/demo/pool', client: 'blue-diamond-pools', sessionId: 'sess-pool-1' },
        });

        // Conversion event + second Rivvak studio visitor (unengaged)
        await jsonReq(baseUrl, '/api/public/track', {
          method: 'POST',
          body: { type: 'conversion', path: '/demo/pool', client: 'blue-diamond-pools', sessionId: 'sess-pool-1', label: 'estimate_submit' },
        });
        await jsonReq(baseUrl, '/api/public/track', {
          method: 'POST',
          body: { type: 'pageview', path: '/', client: 'rivvak', sessionId: 'sess-rivvak-2', visitorId: 'vis-rivvak-2', device: 'desktop' },
        });

        // Honeypot should be ignored silently
        const hpRes = await jsonReq(baseUrl, '/api/public/track', {
          method: 'POST',
          body: { type: 'pageview', path: '/spam', _hp: 'bot-filled' },
        });
        assert.strictEqual(hpRes.status, 200);
        assert.strictEqual(hpRes.data.ignored, true);

        const poolOv = await jsonReq(baseUrl, '/api/admin/analytics-overview?range=7d&client=blue-diamond-pools', {
          token: 'Jh22mp21??.',
        });
        assert.strictEqual(poolOv.status, 200);
        assert.strictEqual(poolOv.data.firstParty.sessions, 1);
        assert.strictEqual(poolOv.data.firstParty.totalUsers, 1);
        assert.strictEqual(poolOv.data.firstParty.pageviews, 2);
        assert.strictEqual(poolOv.data.firstParty.engagedSessions, 1);
        assert.strictEqual(poolOv.data.firstParty.engagementRate, 100);
        assert.strictEqual(poolOv.data.firstParty.conversions, 1);
        assert.strictEqual(poolOv.data.firstParty.topPages[0].path, '/demo/pool');
        assert.strictEqual(poolOv.data.firstParty.topSources[0].source, 'Organic Search');
      }),

      check('24. GET /api/admin/analytics-overview auth, JWT RS256 GA4 & Stripe live connector parsing', async () => {
        const unauth = await jsonReq(baseUrl, '/api/admin/analytics-overview');
        assert.strictEqual(unauth.status, 401);
        const clientDenied = await jsonReq(baseUrl, '/api/admin/analytics-overview', { token: 'CLEAN-2026' });
        assert.strictEqual(clientDenied.status, 403);

        const allOv = await jsonReq(baseUrl, '/api/admin/analytics-overview?range=30d', { token: 'Jh22mp21??.' });
        assert.strictEqual(allOv.status, 200);
        assert.strictEqual(allOv.data.ok, true);
        assert.strictEqual(allOv.data.firstParty.connected, true);
        assert.ok(allOv.data.firstParty.sessions >= 2);
        assert.ok(Array.isArray(allOv.data.firstParty.dailySeries) && allOv.data.firstParty.dailySeries.length === 30);
        assert.strictEqual(allOv.data.ga4.connected, false);
        assert.strictEqual(allOv.data.ga4.reason, 'missing_credentials');

        // Verify live external connectors with ephemeral RSA keypair & mock fetchImpl
        const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
        const extTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivvak-ext-analytics-'));
        let extServer = null;
        try {
          extServer = await startServer({
            port: 0,
            host: '127.0.0.1',
            dataDir: extTmpDir,
            enableScheduler: false,
            loadEnv: false,
            env: {
              ADMIN_PASSCODE: 'Jh22mp21??.',
              GA4_PROPERTY_ID: '998877665',
              GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
                client_email: 'rivvak-analytics@rivvak.iam.gserviceaccount.com',
                private_key: privatePem,
                token_uri: 'https://oauth2.googleapis.com/token',
              }),
              GSC_SITE_URL: 'https://rivvak.com/',
              STRIPE_SECRET_KEY: 'sk_test_mock_123',
            },
            fetchImpl: async (targetUrl, init = {}) => {
              const u = String(targetUrl);
              if (u === 'https://oauth2.googleapis.com/token') {
                assert.ok(String(init.body || '').includes('assertion='));
                return { ok: true, status: 200, json: async () => ({ access_token: 'mock-google-token', expires_in: 3600 }) };
              }
              if (u.includes('analyticsdata.googleapis.com/v1beta/properties/998877665:runReport')) {
                return {
                  ok: true,
                  status: 200,
                  json: async () => ({
                    rows: [
                      {
                        dimensionValues: [{ value: '20261121' }],
                        metricValues: [
                          { value: '42' },
                          { value: '0.6' },
                          { value: '70' },
                          { value: '55' },
                          { value: '4' },
                          { value: '120' },
                        ],
                      },
                    ],
                  }),
                };
              }
              if (u.includes('searchconsole.googleapis.com')) {
                return {
                  ok: true,
                  status: 200,
                  json: async () => ({
                    rows: [{ keys: ['2026-11-21'], clicks: 18, impressions: 310, ctr: 0.058, position: 6.4 }],
                  }),
                };
              }
              if (u.includes('api.stripe.com/v1/subscriptions')) {
                return {
                  ok: true,
                  status: 200,
                  json: async () => ({
                    data: [{ items: { data: [{ price: { unit_amount: 150000, recurring: { interval: 'month' } }, quantity: 1 }] } }],
                  }),
                };
              }
              return { ok: false, status: 404, json: async () => ({ error: { message: 'Unexpected URL' } }) };
            },
          });

          const extOv = await jsonReq(extServer.url, '/api/admin/analytics-overview?range=7d', { token: 'Jh22mp21??.' });
          assert.strictEqual(extOv.status, 200);
          assert.strictEqual(extOv.data.ga4.connected, true);
          assert.strictEqual(extOv.data.ga4.engagedSessions, 42);
          assert.strictEqual(extOv.data.ga4.sessions, 70);
          assert.strictEqual(extOv.data.gsc.connected, true);
          assert.strictEqual(extOv.data.gsc.clicks, 18);
          assert.strictEqual(extOv.data.stripe.connected, true);
          assert.strictEqual(extOv.data.stripe.mrr, 1500);
        } finally {
          if (extServer) await extServer.stop().catch(() => {});
          fs.rmSync(extTmpDir, { recursive: true, force: true });
        }
      }),

      check('25. Client-owned Stripe config, secret masking, cross-tenant 403 & per-client webhook HMAC verification', async () => {
        const badPrefix = await jsonReq(baseUrl, '/api/client/clean-results/stripe-config', {
          method: 'POST',
          token: 'CLEAN-2026',
          body: { publishableKey: 'bad_pk', secretKey: 'sk_live_testsecret_9876' },
        });
        assert.strictEqual(badPrefix.status, 400);

        const crossDenied = await jsonReq(baseUrl, '/api/client/clean-results/stripe-config', {
          method: 'POST',
          token: 'CARLEEN-2026',
          body: { publishableKey: 'pk_live_hack1234' },
        });
        assert.strictEqual(crossDenied.status, 403);

        const clientSecret = 'sk_live_bobby_supersecret_4321';
        const clientWhSecret = 'whsec_bobby_webhook_9988';
        const saveRes = await jsonReq(baseUrl, '/api/client/clean-results/stripe-config', {
          method: 'POST',
          token: 'CLEAN-2026',
          body: {
            publishableKey: 'pk_live_bobby_public_1122',
            secretKey: clientSecret,
            webhookSecret: clientWhSecret,
            paymentLink: 'https://buy.stripe.com/test_bobby_149',
          },
        });
        assert.strictEqual(saveRes.status, 200);
        assert.strictEqual(saveRes.data.ok, true);
        assert.strictEqual(saveRes.data.stripeConfig.connected, true);
        assert.strictEqual(saveRes.data.stripeConfig.hasSecretKey, true);
        assert.strictEqual(saveRes.data.stripeConfig.secretKeyMask, '••••4321');
        assert.strictEqual(saveRes.data.stripeConfig.hasWebhookSecret, true);
        assert.strictEqual(saveRes.data.stripeConfig.webhookSecretMask, '••••9988');
        assert.strictEqual(saveRes.raw.includes(clientSecret), false, 'Never return raw Stripe secretKey');
        assert.strictEqual(saveRes.raw.includes(clientWhSecret), false, 'Never return raw Stripe webhookSecret');

        const getClient = await jsonReq(baseUrl, '/api/client/clean-results', { token: 'CLEAN-2026' });
        assert.strictEqual(getClient.status, 200);
        assert.strictEqual(getClient.raw.includes(clientSecret), false);
        assert.strictEqual(getClient.raw.includes(clientWhSecret), false);
        assert.strictEqual(getClient.data.client.stripeConfig.hasSecretKey, true);

        // Verify PUT /api/client/clean-results preserves saved secrets cleanly
        const putSync = await jsonReq(baseUrl, '/api/client/clean-results', {
          method: 'PUT',
          token: 'CLEAN-2026',
          body: { client: { ...getClient.data.client, notes: 'Updated portal notes' } },
        });
        assert.strictEqual(putSync.status, 200);
        assert.strictEqual(putSync.data.client.stripeConfig.hasSecretKey, true);
        assert.strictEqual(putSync.data.client.stripeConfig.hasWebhookSecret, true);

        const adminClients = await jsonReq(baseUrl, '/api/admin/clients', { token: 'Jh22mp21??.' });
        assert.strictEqual(adminClients.status, 200);
        assert.strictEqual(adminClients.raw.includes(clientSecret), false);
        assert.strictEqual(adminClients.raw.includes(clientWhSecret), false);

        // Per-client Stripe webhook HMAC-SHA256 verification
        const evtPayload = JSON.stringify({
          id: 'evt_bobby_test_1',
          type: 'invoice.paid',
          data: { object: { amount_paid: 19900, currency: 'usd', payment_status: 'paid' } },
        });
        const ts = Math.floor(Date.now() / 1000);
        const validSig = crypto
          .createHmac('sha256', clientWhSecret)
          .update(`${ts}.${evtPayload}`)
          .digest('hex');

        const badHook = await fetch(`${baseUrl}/webhooks/stripe?client=clean-results`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${ts},v1=deadbeef` },
          body: evtPayload,
        });
        assert.strictEqual(badHook.status, 400);

        const goodHook = await fetch(`${baseUrl}/webhooks/stripe?client=clean-results`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${ts},v1=${validSig}` },
          body: evtPayload,
        });
        assert.strictEqual(goodHook.status, 200);
        const goodJson = await goodHook.json();
        assert.strictEqual(goodJson.clientSlug, 'clean-results');
      }),

      check('26. Shopify finances aggregator (dedup, refunds/voids, EST month bucketing) & /api/admin/shopify-finances endpoint', async () => {
        // Unconfigured integration check
        const partialInt = buildIntegrationsStatus({
          SHOPIFY_SHOP_DOMAIN: 'fdguvq-yv.myshopify.com',
          SHOPIFY_CLIENT_ID: 'e3223a03bb1380e4af13f22be6eebac8',
        });
        const sfEntry = partialInt.integrations.find((i) => i.id === 'shopify-admin-finances');
        assert.ok(sfEntry, 'shopify-admin-finances present in catalog');
        assert.strictEqual(sfEntry.connected, false);
        assert.strictEqual(sfEntry.partial, true);
        assert.deepStrictEqual(sfEntry.missingKeys, ['SHOPIFY_CLIENT_SECRET']);

        // Pure aggregator accuracy test
        const agg = aggregateShopifyFinances(
          [
            {
              id: 1001,
              name: '#1032',
              created_at: '2026-11-12T17:50:00Z',
              financial_status: 'paid',
              total_price: '900.00',
              current_total_price: '900.00',
              customer: { first_name: 'Aiden', last_name: 'Strompf' },
              line_items: [{ title: 'Website Package', quantity: 1 }],
            },
            {
              id: 1002,
              name: '#1038',
              // 2026-11-22 22:48 EST = 2026-11-23 03:48 UTC; EST check -> still 2026-11 (2026-11-01 02:00 UTC -> 2026-10!)
              created_at: '2026-11-23T03:48:00Z',
              financial_status: 'paid',
              total_price: '400.00',
              current_total_price: '400.00',
              source_name: 'shopify_draft_order',
              line_items: [{ title: 'Website Carleen Ligozio', quantity: 1 }],
            },
            {
              id: 1003,
              name: '#1029',
              created_at: '2026-10-31T16:16:00Z',
              financial_status: 'refunded',
              total_price: '250.00',
              current_total_price: '0.00',
              refunds: [{ transactions: [{ kind: 'refund', status: 'success', amount: '250.00' }] }],
              line_items: [{ title: 'Refunded Test', quantity: 1 }],
            },
            {
              id: 1004,
              name: '#1027',
              created_at: '2026-10-05T18:31:00Z',
              financial_status: 'voided',
              cancelled_at: '2026-10-05T19:00:00Z',
              total_price: '99.00',
              line_items: [{ title: 'Voided Sub', quantity: 1 }],
            },
            {
              id: 1005,
              name: '#1099',
              created_at: '2026-11-20T15:00:00Z',
              financial_status: 'paid',
              test: true,
              total_price: '7777.00',
              line_items: [{ title: 'Shopify Bogus Test', quantity: 1 }],
            },
            {
              id: 1006,
              name: '#1039',
              created_at: '2026-12-01T02:00:00Z', // 2026-11-30 9:00 PM EST -> belongs to 2026-11!
              financial_status: 'partially_paid',
              total_price: '500.00',
              total_outstanding: '200.00',
              line_items: [{ title: 'Retainer Deposit', quantity: 1 }],
            },
          ],
          [
            {
              id: 1632323797312,
              name: '#D37',
              status: 'completed',
              order_id: 1002,
              total_price: '400.00',
              created_at: '2026-11-23T03:48:00Z',
              line_items: [{ title: 'Website Carleen Ligozio', quantity: 1 }],
            },
            {
              id: 999001,
              name: '#D38',
              status: 'open',
              order_id: null,
              total_price: '650.00',
              created_at: '2026-11-23T18:00:00Z',
              customer: { first_name: 'Prospect', last_name: 'Draft' },
              line_items: [{ title: 'Pool Build Invoice', quantity: 1 }],
            },
          ],
          { shopHandle: 'fdguvq-yv', timeZone: 'America/New_York', minOrderNumber: 0, minCreatedAt: '' }
        );

        // #1032 (900) + #1038 (400, NOT doubled by #D37) + #1039 paid part (300) = 1600
        assert.strictEqual(agg.summary.allTimeNet, 1600);
        assert.strictEqual(agg.summary.allTimeRefunded, 250);
        assert.strictEqual(agg.summary.openDraftsTotal, 650);
        assert.strictEqual(agg.summary.openDraftsCount, 1);
        assert.strictEqual(agg.summary.pendingOrdersTotal, 200);
        assert.strictEqual(agg.summary.totalUnpaidShopify, 850);
        assert.strictEqual(agg.summary.testOrdersCount, 1);
        assert.strictEqual(agg.byMonth['2026-11'].netRevenue, 1600);
        assert.strictEqual(agg.byMonth['2026-10'].netRevenue, 0);
        assert.strictEqual(agg.byMonth['2026-10'].refunded, 250);
        assert.strictEqual(agg.draftOrders.find((d) => d.name === '#D37').dedupedWithOrder, true);

        // Cutoff verification: disregard all legacy/test orders before #1038 (2026-11-22T22:48:33-05:00)
        const cutoffAgg = aggregateShopifyFinances(
          [
            {
              id: 19045737431360,
              name: '#1037',
              created_at: '2026-11-14T22:09:22-05:00',
              financial_status: 'paid',
              total_price: '11.21',
              current_total_price: '11.21',
              customer: { first_name: 'ghost', last_name: 'Customer' },
            },
            {
              id: 19067276722496,
              name: '#1038',
              created_at: '2026-11-22T22:48:33-05:00',
              financial_status: 'paid',
              total_price: '400.00',
              current_total_price: '400.00',
              source_name: 'shopify_draft_order',
              customer: { first_name: 'Carleen', last_name: 'Ligozio' },
              line_items: [{ title: 'Website Carleen Ligozio', quantity: 1 }],
            },
          ],
          [
            {
              id: 1632323797312,
              name: '#D37',
              status: 'completed',
              order_id: 19067276722496,
              total_price: '400.00',
              created_at: '2026-11-21T16:33:27-05:00',
            },
          ],
          { shopHandle: 'fdguvq-yv', timeZone: 'America/New_York', minOrderNumber: 1038, minCreatedAt: '2026-11-22T22:48:33-05:00' }
        );
        assert.strictEqual(cutoffAgg.summary.excludedLegacyOrdersCount, 1);
        assert.strictEqual(cutoffAgg.summary.orderCount, 1);
        assert.strictEqual(cutoffAgg.summary.allTimeNet, 400);
        assert.strictEqual(cutoffAgg.orders.length, 1);
        assert.strictEqual(cutoffAgg.orders[0].name, '#1038');
        assert.strictEqual(cutoffAgg.draftOrders.find((d) => d.name === '#D37').dedupedWithOrder, true);

        // Auth + Graceful Unconfigured 200 check on baseUrl (no Shopify keys configured in base test server)
        const unauth = await jsonReq(baseUrl, '/api/admin/shopify-finances');
        assert.strictEqual(unauth.status, 401);
        const uncfg = await jsonReq(baseUrl, '/api/admin/shopify-finances', { token: 'Jh22mp21??.' });
        assert.strictEqual(uncfg.status, 200);
        assert.strictEqual(uncfg.data.connected, false);

        // Live mocked OAuth client_credentials + pagination + 401 refresh test
        const shTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivvak-shopify-test-'));
        let shServer;
        let oauthCalls = 0;
        let orderCalls = 0;
        try {
          shServer = await startServer({
            port: 0,
            host: '127.0.0.1',
            storePath: path.join(shTmpDir, 'store.json'),
            envPath: path.join(shTmpDir, '.env.missing'),
            env: {
              ADMIN_PASSCODE: 'Jh22mp21??.',
              SHOPIFY_SHOP_DOMAIN: 'fdguvq-yv.myshopify.com',
              SHOPIFY_CLIENT_ID: 'cid_test_123',
              SHOPIFY_CLIENT_SECRET: 'csec_test_456',
            },
            fetchImpl: async (targetUrl, init = {}) => {
              const u = String(targetUrl);
              if (u.includes('/admin/oauth/access_token')) {
                oauthCalls++;
                return {
                  ok: true,
                  status: 200,
                  json: async () => ({ access_token: `shpat_mock_${oauthCalls}`, expires_in: 86400 }),
                };
              }
              if (u.includes('/orders.json')) {
                orderCalls++;
                // First order call returns 401 to verify automatic OAuth token refresh retry
                if (orderCalls === 1) {
                  return { ok: false, status: 401, json: async () => ({ errors: 'Expired token' }) };
                }
                if (u.includes('page_info=p2')) {
                  return {
                    ok: true,
                    status: 200,
                    headers: { get: () => '' },
                    json: async () => ({
                      orders: [
                        {
                          id: 2002,
                          name: '#1037',
                          created_at: '2026-11-14T22:09:00-05:00',
                          financial_status: 'paid',
                          total_price: '11.21',
                          current_total_price: '11.21',
                          line_items: [{ title: 'Sample 2', quantity: 1 }],
                        },
                      ],
                    }),
                  };
                }
                return {
                  ok: true,
                  status: 200,
                  headers: {
                    get: (k) =>
                      String(k).toLowerCase() === 'link'
                        ? '<https://fdguvq-yv.myshopify.com/admin/api/2026-01/orders.json?page_info=p2>; rel="next"'
                        : '',
                  },
                  json: async () => ({
                    orders: [
                      {
                        id: 2001,
                        name: '#1038',
                        created_at: '2026-11-22T22:48:33-05:00',
                        financial_status: 'paid',
                        total_price: '400.00',
                        current_total_price: '400.00',
                        line_items: [{ title: 'Website Carleen Ligozio', quantity: 1 }],
                      },
                      {
                        id: 2003,
                        name: '#1039',
                        created_at: '2026-11-23T15:00:00-05:00',
                        financial_status: 'paid',
                        total_price: '511.21',
                        current_total_price: '511.21',
                        line_items: [{ title: 'Growth Retainer', quantity: 1 }],
                      },
                    ],
                  }),
                };
              }
              if (u.includes('/draft_orders.json')) {
                return {
                  ok: true,
                  status: 200,
                  headers: { get: () => '' },
                  json: async () => ({
                    draft_orders: [
                      {
                        id: 1632323797313,
                        name: '#D38',
                        status: 'open',
                        total_price: '400.00',
                        created_at: '2026-11-23T16:00:00-05:00',
                        line_items: [{ title: 'Pool Invoice', quantity: 1 }],
                      },
                    ],
                  }),
                };
              }
              return { ok: false, status: 404, json: async () => ({ error: 'Unexpected URL' }) };
            },
          });

          const finRes = await jsonReq(shServer.url, '/api/admin/shopify-finances?refresh=1', { token: 'Jh22mp21??.' });
          assert.strictEqual(finRes.status, 200);
          assert.strictEqual(finRes.data.connected, true);
          assert.strictEqual(oauthCalls, 2, 'Should refresh OAuth token once after 401');
          assert.strictEqual(finRes.data.summary.allTimeNet, 911.21);
          assert.strictEqual(finRes.data.summary.openDraftsTotal, 400);
          assert.strictEqual(finRes.data.summary.excludedLegacyOrdersCount, 1);
          assert.strictEqual(finRes.data.orders.length, 2);

          const intLive = await jsonReq(shServer.url, '/api/admin/integrations', { token: 'Jh22mp21??.' });
          assert.strictEqual(intLive.status, 200);
          const sfLive = intLive.data.integrations.find((i) => i.id === 'shopify-admin-finances');
          assert.strictEqual(sfLive.connected, true);
        } finally {
          if (shServer) await shServer.stop().catch(() => {});
          fs.rmSync(shTmpDir, { recursive: true, force: true });
        }
      }),

      check('27. Onboarding schema, CORS PATCH, POST /api/admin/clients/onboard (new/update) & zero-em-dash welcome email', async () => {
        // 1. Direct helper checks
        const defOb = createDefaultOnboarding(
          { slug: 'sample-co', business: 'Sample Co', setupUsd: 1500, monthlyUsd: 400 },
          { slug: 'sample-co', business: 'Sample Co' }
        );
        assert.strictEqual(defOb.agreement.version, '2026.1');
        assert.strictEqual(
          defOb.agreement.ownershipClause,
          '100% client ownership of code, domain, and brand assets with zero lock in.'
        );
        assert.strictEqual(
          defOb.agreement.timelineText,
          '72 hour interactive staging preview, 7 to 14 day production launch'
        );
        assert.strictEqual(defOb.welcome.whatHappensNext.length, 5);
        assert.strictEqual(defOb.welcome.supportEmail, 'connect@rivvak.com');
        assert.strictEqual(defOb.welcome.supportPhone, '(728) 231-6974');
        assert.strictEqual(defOb.shopifyInvoice.totalUsd, 1900);
        assert.ok(defOb.milestones.some((m) => m.title === 'Send & Sign Client Agreement'));
        assert.ok(defOb.milestones.some((m) => m.title === 'Schedule Kickoff Strategy Call'));
        assert.strictEqual(defOb.portalUrl, 'https://rivvak.com/pages/client-portal?client=sample-co');

        const normPartial = normalizeOnboarding({}, { slug: 'legacy-co', business: 'Legacy Co' });
        assert.strictEqual(normPartial.agreement.status, 'draft');
        assert.strictEqual(normPartial.shopifyInvoice.status, 'not_created');

        // 2. CORS preflight PATCH check from https://rivvak.com
        const corsPre = await fetch(`${baseUrl}/api/admin/clients/clean-results/onboarding`, {
          method: 'OPTIONS',
          headers: { Origin: 'https://rivvak.com', 'Access-Control-Request-Method': 'PATCH' },
        });
        assert.strictEqual(corsPre.status, 204);
        const allowMethods = corsPre.headers.get('access-control-allow-methods') || '';
        assert.ok(allowMethods.includes('PATCH'), `Expected PATCH in CORS methods, got: ${allowMethods}`);

        // 3. Seeded client + POST /api/admin/clients have onboarding
        const bdpSync = await jsonReq(baseUrl, '/api/client/blue-diamond-pools/sync', { token: 'BLUEDIAMOND-2026' });
        assert.strictEqual(bdpSync.status, 200);
        assert.strictEqual(bdpSync.data.client.onboarding.agreement.version, '2026.1');

        const createdBasic = await jsonReq(baseUrl, '/api/admin/clients', {
          method: 'POST',
          token: 'Jh22mp21??.',
          body: { business: 'Basic Studio', owner: 'Alex', email: 'alex@basicstudio.example.com' },
        });
        assert.strictEqual(createdBasic.status, 201);
        assert.strictEqual(createdBasic.data.client.onboarding.welcome.supportEmail, 'connect@rivvak.com');

        // 4. Client token blocked from POST /api/admin/clients/onboard
        const clientBlocked = await jsonReq(baseUrl, '/api/admin/clients/onboard', {
          method: 'POST',
          token: 'CARLEEN-2026',
          body: { business: 'Blocked Co' },
        });
        assert.strictEqual(clientBlocked.status, 403);

        // 5. POST /api/admin/clients/onboard creates new client (201) with dry-run invoice & welcome email
        const onboardNew = await jsonReq(baseUrl, '/api/admin/clients/onboard', {
          method: 'POST',
          token: 'Jh22mp21??.',
          body: {
            slug: 'apex-roofing',
            business: 'Apex Roofing South Florida',
            owner: 'Jordan Apex',
            email: 'jordan@apexroofing.example.com',
            phone: '(561) 555-0199',
            setupUsd: 1950,
            monthlyUsd: 500,
            scopeSummary: 'High converting roofing website, instant roof quote calculator, and Growth OS CRM.',
            createShopifyInvoice: true,
            sendWelcomeEmail: true,
            dryRun: true,
          },
        });
        assert.strictEqual(onboardNew.status, 201);
        assert.strictEqual(onboardNew.data.ok, true);
        assert.strictEqual(onboardNew.data.slug, 'apex-roofing');
        assert.ok(onboardNew.data.accessCode);
        assert.strictEqual(
          onboardNew.data.portalUrl,
          'https://rivvak.com/pages/client-portal?client=apex-roofing'
        );
        assert.strictEqual(
          onboardNew.data.portalMagicUrl,
          `https://rivvak.com/pages/client-portal?client=apex-roofing&code=${encodeURIComponent(onboardNew.data.accessCode)}`
        );
        assert.strictEqual(onboardNew.data.shopifyInvoice.mode, 'dry_run');
        assert.strictEqual(onboardNew.data.shopifyInvoice.draftOrderId, null);
        assert.strictEqual(onboardNew.data.shopifyInvoice.invoiceUrl, 'https://rivvak.com/pages/pricing');
        assert.strictEqual(onboardNew.data.shopifyInvoice.status, 'open');
        assert.strictEqual(onboardNew.data.shopifyInvoice.setupUsd, 1950);
        assert.strictEqual(onboardNew.data.shopifyInvoice.monthlyUsd, 500);
        assert.strictEqual(onboardNew.data.shopifyInvoice.totalUsd, 2450);
        assert.strictEqual(onboardNew.data.welcomeEmail.mode, 'dry_run');
        assert.strictEqual(onboardNew.data.client.onboarding.agreement.status, 'sent');

        // 6. Calling onboard again for same slug updates existing client (200)
        const onboardUpd = await jsonReq(baseUrl, '/api/admin/clients/onboard', {
          method: 'POST',
          token: 'Jh22mp21??.',
          body: {
            slug: 'apex-roofing',
            setupUsd: 2200,
            monthlyUsd: 500,
          },
        });
        assert.strictEqual(onboardUpd.status, 200);
        assert.strictEqual(onboardUpd.data.shopifyInvoice.setupUsd, 2200);
        assert.strictEqual(onboardUpd.data.shopifyInvoice.totalUsd, 2700);

        // 7. Verify live transactional welcome email content (zero em-dashes, official contacts only, zero secrets)
        const mailTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivvak-onboard-mail-'));
        const capturedEmails = [];
        let mailServer;
        try {
          mailServer = await startServer({
            port: 0,
            host: '127.0.0.1',
            storePath: path.join(mailTmpDir, 'store.json'),
            envPath: path.join(mailTmpDir, '.env.missing'),
            enableScheduler: false,
            env: {
              ADMIN_PASSCODE: 'Jh22mp21??.',
              SMTP_HOST: 'smtp.example.local',
              SMTP_USER: 'connect@rivvak.com',
              SMTP_PASS: 'super-secret-smtp-pass',
            },
            smtpSendImpl: async (cfg) => {
              capturedEmails.push(cfg);
              return { ok: true, messageId: '<onboard-test@rivvak.com>', response: '250 OK' };
            },
          });
          const liveOnboard = await jsonReq(mailServer.url, '/api/admin/clients/onboard', {
            method: 'POST',
            token: 'Jh22mp21??.',
            body: {
              slug: 'palm-wellness',
              business: 'Palm Wellness Clinic',
              owner: 'Dr. Nina',
              email: 'nina@palmwellness.example.com',
              setupUsd: 1200,
              monthlyUsd: 350,
              createShopifyInvoice: true,
              sendWelcomeEmail: true,
            },
          });
          assert.strictEqual(liveOnboard.status, 201);
          assert.strictEqual(liveOnboard.data.welcomeEmail.mode, 'live_smtp');
          assert.strictEqual(capturedEmails.length, 1);
          const sentText = capturedEmails[0].text;
          assert.ok(sentText.includes(liveOnboard.data.portalMagicUrl));
          assert.ok(sentText.includes('connect@rivvak.com'));
          assert.ok(sentText.includes('(728) 231-6974'));
          assert.ok(!sentText.includes('\u2014'), 'Welcome email must contain zero em-dashes');
          assert.ok(!sentText.includes('\u2013'), 'Welcome email must contain zero en-dashes');
          assert.ok(!sentText.includes('Jh22mp21??.'), 'Welcome email must never leak admin passcode');
          assert.ok(!sentText.includes('super-secret-smtp-pass'), 'Welcome email must never leak SMTP secret');
        } finally {
          if (mailServer) await mailServer.stop().catch(() => {});
          fs.rmSync(mailTmpDir, { recursive: true, force: true });
        }
      }),

      check('28. Shopify Draft Order invoice create, send_invoice, sync-payment & dry-run fallback', async () => {
        // Direct unit dry-run & missing-credentials checks
        const dryDirect = await createShopifyDraftOrderInvoice(
          { SHOPIFY_CLIENT_ID: 'cid', SHOPIFY_CLIENT_SECRET: 'csec' },
          { dryRun: true, setupUsd: 1950, monthlyUsd: 500 }
        );
        assert.strictEqual(dryDirect.ok, true);
        assert.strictEqual(dryDirect.mode, 'dry_run');
        assert.strictEqual(dryDirect.draftOrderId, null);
        assert.strictEqual(dryDirect.invoiceUrl, 'https://rivvak.com/pages/pricing');
        assert.strictEqual(dryDirect.status, 'open');

        const missingDirect = await createShopifyDraftOrderInvoice({}, { setupUsd: 1000 });
        assert.strictEqual(missingDirect.ok, true);
        assert.strictEqual(missingDirect.mode, 'dry_run');
        assert.strictEqual(missingDirect.draftOrderId, null);
        assert.strictEqual(missingDirect.invoiceUrl, 'https://rivvak.com/pages/pricing');

        const missingStatus = await fetchShopifyDraftOrderStatus({}, '99999');
        assert.strictEqual(missingStatus.ok, true);
        assert.strictEqual(missingStatus.mode, 'dry_run');

        // Live mocked Shopify Draft Orders flow
        const shInvTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivvak-shopify-inv-'));
        let shInvServer;
        let syncCallCount = 0;
        const recordedCalls = [];
        try {
          shInvServer = await startServer({
            port: 0,
            host: '127.0.0.1',
            storePath: path.join(shInvTmpDir, 'store.json'),
            envPath: path.join(shInvTmpDir, '.env.missing'),
            enableScheduler: false,
            env: {
              ADMIN_PASSCODE: 'Jh22mp21??.',
              SHOPIFY_SHOP_DOMAIN: 'fdguvq-yv.myshopify.com',
              SHOPIFY_CLIENT_ID: 'cid_inv_123',
              SHOPIFY_CLIENT_SECRET: 'csec_inv_456',
            },
            fetchImpl: async (targetUrl, init = {}) => {
              const u = String(targetUrl);
              recordedCalls.push({ method: init.method || 'GET', url: u, body: init.body });
              if (u.includes('/admin/oauth/access_token')) {
                return {
                  ok: true,
                  status: 200,
                  json: async () => ({ access_token: 'shpat_inv_mock', expires_in: 86400 }),
                };
              }
              if (u.endsWith('/admin/api/2026-01/draft_orders.json') && init.method === 'POST') {
                return {
                  ok: true,
                  status: 201,
                  json: async () => ({
                    draft_order: {
                      id: 987654,
                      name: '#D98',
                      status: 'open',
                      order_id: null,
                      invoice_url: 'https://fdguvq-yv.myshopify.com/12345/invoices/abc123',
                      total_price: '2450.00',
                      currency: 'USD',
                    },
                  }),
                };
              }
              if (u.endsWith('/admin/api/2026-01/draft_orders/987654/send_invoice.json') && init.method === 'POST') {
                return {
                  ok: true,
                  status: 200,
                  json: async () => ({ draft_order_invoice: { to: 'connect@rivvak.com' } }),
                };
              }
              if (u.endsWith('/admin/api/2026-01/draft_orders/987654.json')) {
                syncCallCount++;
                if (syncCallCount === 1) {
                  return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                      draft_order: {
                        id: 987654,
                        name: '#D98',
                        status: 'open',
                        order_id: null,
                        invoice_url: 'https://fdguvq-yv.myshopify.com/12345/invoices/abc123',
                      },
                    }),
                  };
                }
                return {
                  ok: true,
                  status: 200,
                  json: async () => ({
                    draft_order: {
                      id: 987654,
                      name: '#D98',
                      status: 'completed',
                      order_id: 5550001,
                      completed_at: '2026-11-25T18:30:00Z',
                      invoice_url: 'https://fdguvq-yv.myshopify.com/12345/invoices/abc123',
                    },
                  }),
                };
              }
              return { ok: false, status: 404, json: async () => ({ error: 'Unexpected endpoint' }) };
            },
          });

          const invCreate = await jsonReq(shInvServer.url, '/api/admin/clients/clean-results/onboarding/shopify-invoice', {
            method: 'POST',
            token: 'Jh22mp21??.',
            body: { setupUsd: 1950, monthlyUsd: 500, sendInvoiceEmail: true },
          });
          assert.strictEqual(invCreate.status, 200);
          assert.strictEqual(invCreate.data.ok, true);
          assert.strictEqual(invCreate.data.shopifyInvoice.draftOrderId, '987654');
          assert.strictEqual(invCreate.data.shopifyInvoice.invoiceNumber, '#D98');
          assert.strictEqual(invCreate.data.shopifyInvoice.status, 'invoice_sent');
          assert.strictEqual(invCreate.data.shopifyInvoice.mode, 'live_shopify');
          assert.ok(invCreate.data.shopifyInvoice.sentAt);
          assert.ok(recordedCalls.some((c) => c.url.includes('/draft_orders/987654/send_invoice.json')));

          // Sync payment #1: still open
          const syncOpen = await jsonReq(shInvServer.url, '/api/admin/clients/clean-results/onboarding/sync-payment', {
            method: 'POST',
            token: 'Jh22mp21??.',
            body: {},
          });
          assert.strictEqual(syncOpen.status, 200);
          assert.strictEqual(syncOpen.data.shopifyInvoice.status, 'open');
          assert.ok(syncOpen.data.shopifyInvoice.lastSyncedAt);

          // Sync payment #2: completed -> paid + orderId + invoice milestone Done
          const syncPaid = await jsonReq(shInvServer.url, '/api/admin/clients/clean-results/onboarding/sync-payment', {
            method: 'POST',
            token: 'Jh22mp21??.',
            body: {},
          });
          assert.strictEqual(syncPaid.status, 200);
          assert.strictEqual(syncPaid.data.shopifyInvoice.status, 'paid');
          assert.strictEqual(syncPaid.data.shopifyInvoice.orderId, '5550001');
          assert.ok(syncPaid.data.shopifyInvoice.paidAt);
          const invMilestone = syncPaid.data.client.onboarding.milestones.find((m) => m.id === 'ms_p1_invoice');
          assert.strictEqual(invMilestone.discovery, 'Done');

          // Dry-run endpoint check even when credentials exist
          const invDry = await jsonReq(shInvServer.url, '/api/admin/clients/blue-diamond-pools/onboarding/shopify-invoice', {
            method: 'POST',
            token: 'Jh22mp21??.',
            body: { setupUsd: 1950, monthlyUsd: 500, dryRun: true },
          });
          assert.strictEqual(invDry.status, 200);
          assert.strictEqual(invDry.data.shopifyInvoice.mode, 'dry_run');
          assert.strictEqual(invDry.data.shopifyInvoice.draftOrderId, null);
          assert.strictEqual(invDry.data.shopifyInvoice.invoiceUrl, 'https://rivvak.com/pages/pricing');
        } finally {
          if (shInvServer) await shInvServer.stop().catch(() => {});
          fs.rmSync(shInvTmpDir, { recursive: true, force: true });
        }
      }),

      check('29. Client SHA-256 agreement signing, cross-tenant 403 isolation & tamper protection', async () => {
        // Ensure apex-roofing client exists from Test 27
        const stateRes = await jsonReq(baseUrl, '/api/state', { token: 'Jh22mp21??.' });
        assert.strictEqual(stateRes.status, 200);
        const apexClient = stateRes.data.clients['apex-roofing'];
        assert.ok(apexClient && apexClient.accessCode);
        const apexCode = apexClient.accessCode;

        // Cross-tenant 403 isolation: Carleen cannot hit apex-roofing onboarding endpoints
        for (const sub of ['sign-agreement', 'schedule-call', 'assets']) {
          const cross = await jsonReq(baseUrl, `/api/client/apex-roofing/onboarding/${sub}`, {
            method: 'POST',
            token: 'CARLEEN-2026',
            body: { signerName: 'Intruder', accepted: true, scheduledIso: '2026-12-01T16:00:00Z', label: 'X', url: '/x' },
          });
          assert.strictEqual(cross.status, 403, `Expected 403 on cross-tenant /${sub}`);
        }

        // Client token blocked on admin onboarding endpoints
        for (const [m, p] of [
          ['POST', '/api/admin/clients/apex-roofing/onboarding/shopify-invoice'],
          ['POST', '/api/admin/clients/apex-roofing/onboarding/sync-payment'],
          ['POST', '/api/admin/clients/apex-roofing/onboarding/send-welcome'],
          ['PATCH', '/api/admin/clients/apex-roofing/onboarding'],
        ]) {
          const forbiddenAdmin = await jsonReq(baseUrl, p, { method: m, token: apexCode, body: {} });
          assert.strictEqual(forbiddenAdmin.status, 403, `Expected 403 for client calling ${m} ${p}`);
        }

        // Validation 400 checks on sign-agreement
        const badName = await jsonReq(baseUrl, '/api/client/apex-roofing/onboarding/sign-agreement', {
          method: 'POST',
          token: apexCode,
          body: { signerName: '   ', accepted: true },
        });
        assert.strictEqual(badName.status, 400);

        const badAccepted = await jsonReq(baseUrl, '/api/client/apex-roofing/onboarding/sign-agreement', {
          method: 'POST',
          token: apexCode,
          body: { signerName: 'Jordan Apex', accepted: false },
        });
        assert.strictEqual(badAccepted.status, 400);

        // Valid signing by client tenant
        const signRes = await jsonReq(baseUrl, '/api/client/apex-roofing/onboarding/sign-agreement', {
          method: 'POST',
          token: apexCode,
          headers: { 'User-Agent': 'RivvakTestAgent/2.0' },
          body: {
            signerName: 'Jordan Apex',
            signerTitle: 'Managing Partner',
            signerEmail: 'jordan@apexroofing.example.com',
            accepted: true,
            dryRun: true,
          },
        });
        assert.strictEqual(signRes.status, 200);
        assert.strictEqual(signRes.data.ok, true);
        assert.strictEqual(signRes.data.agreement.status, 'signed');
        assert.strictEqual(signRes.data.agreement.signerName, 'Jordan Apex');
        assert.strictEqual(signRes.data.agreement.signerTitle, 'Managing Partner');
        assert.strictEqual(signRes.data.agreement.userAgent, 'RivvakTestAgent/2.0');
        assert.ok(/^[0-9a-f]{64}$/.test(signRes.data.agreement.agreementHash));
        assert.strictEqual(signRes.data.emailConfirmation.mode, 'dry_run');

        // Recompute canonical SHA-256 independently to verify integrity
        const obAfterSign = signRes.data.client.onboarding;
        const expectedCanonical = JSON.stringify({
          agreementId: obAfterSign.agreement.agreementId,
          version: obAfterSign.agreement.version,
          slug: 'apex-roofing',
          business: signRes.data.client.business,
          scopeSummary: obAfterSign.agreement.scopeSummary,
          deliverables: obAfterSign.agreement.deliverables,
          timelineText: obAfterSign.agreement.timelineText,
          paymentTerms: obAfterSign.agreement.paymentTerms,
          ownershipClause: obAfterSign.agreement.ownershipClause,
          setupUsd: obAfterSign.shopifyInvoice.setupUsd,
          monthlyUsd: obAfterSign.shopifyInvoice.monthlyUsd,
          totalUsd: obAfterSign.shopifyInvoice.totalUsd,
          signedAt: obAfterSign.agreement.signedAt,
          signerName: 'Jordan Apex',
          signerTitle: 'Managing Partner',
          signerEmail: 'jordan@apexroofing.example.com',
        });
        const expectedHash = crypto.createHash('sha256').update(expectedCanonical).digest('hex');
        assert.strictEqual(signRes.data.agreement.agreementHash, expectedHash);

        // Agreement milestone flipped to Done
        const agRow = obAfterSign.milestones.find((m) => m.title === 'Send & Sign Client Agreement');
        assert.strictEqual(agRow.discovery, 'Done');

        // Client PUT /sync preserves signed agreement & does not allow client tampering
        const clientPut = await jsonReq(baseUrl, '/api/client/apex-roofing/sync', {
          method: 'PUT',
          token: apexCode,
          body: {
            onboarding: {
              agreement: { status: 'draft', agreementHash: 'tampered' },
              shopifyInvoice: { status: 'paid' },
            },
          },
        });
        assert.strictEqual(clientPut.status, 200);
        assert.strictEqual(clientPut.data.client.onboarding.agreement.status, 'signed');
        assert.strictEqual(clientPut.data.client.onboarding.agreement.agreementHash, expectedHash);
        assert.notStrictEqual(clientPut.data.client.onboarding.shopifyInvoice.status, 'paid');
      }),

      check('30. Strategy call booking + milestone flip, asset upload, send-welcome & admin PATCH', async () => {
        const stateRes = await jsonReq(baseUrl, '/api/state', { token: 'Jh22mp21??.' });
        const apexCode = stateRes.data.clients['apex-roofing'].accessCode;

        // Schedule call validation
        const badCall = await jsonReq(baseUrl, '/api/client/apex-roofing/onboarding/schedule-call', {
          method: 'POST',
          token: apexCode,
          body: { scheduledIso: 'not-a-date', platform: 'Zoom' },
        });
        assert.strictEqual(badCall.status, 400);

        const badPlatform = await jsonReq(baseUrl, '/api/client/apex-roofing/onboarding/schedule-call', {
          method: 'POST',
          token: apexCode,
          body: { scheduledIso: '2026-12-01T16:00:00Z', platform: 'Carrier Pigeon' },
        });
        assert.strictEqual(badPlatform.status, 400);

        // Valid strategy call booking
        const callRes = await jsonReq(baseUrl, '/api/client/apex-roofing/onboarding/schedule-call', {
          method: 'POST',
          token: apexCode,
          body: {
            scheduledIso: '2026-12-01T16:00:00Z',
            platform: 'Zoom',
            timezone: 'America/New_York',
            notes: 'Focus on Broward and Palm Beach storm roof inspections',
            dryRun: true,
          },
        });
        assert.strictEqual(callRes.status, 200);
        assert.strictEqual(callRes.data.strategyCall.status, 'scheduled');
        assert.strictEqual(callRes.data.strategyCall.platform, 'Zoom');
        assert.strictEqual(callRes.data.emailConfirmation.mode, 'dry_run');
        assert.ok(callRes.data.client.bookings.some((b) => b.sessionType === 'Kickoff Strategy Call (Zoom)'));
        const callRow = callRes.data.client.onboarding.milestones.find(
          (m) => m.title === 'Schedule Kickoff Strategy Call'
        );
        assert.strictEqual(callRow.discovery, 'Done');

        // Asset upload validation (empty and javascript: URL)
        const badAssetEmpty = await jsonReq(baseUrl, '/api/client/apex-roofing/onboarding/assets', {
          method: 'POST',
          token: apexCode,
          body: {},
        });
        assert.strictEqual(badAssetEmpty.status, 400);

        const badAssetUrl = await jsonReq(baseUrl, '/api/client/apex-roofing/onboarding/assets', {
          method: 'POST',
          token: apexCode,
          body: { label: 'XSS', url: 'javascript:alert(1)' },
        });
        assert.strictEqual(badAssetUrl.status, 400);

        // Valid asset + note upload
        const assetRes = await jsonReq(baseUrl, '/api/client/apex-roofing/onboarding/assets', {
          method: 'POST',
          token: apexCode,
          body: {
            label: 'Primary Vector Logo',
            url: 'https://cdn.example.com/apex-logo.svg',
            category: 'asset',
            note: 'Prefer matte slate and emerald accents on calculator CTA.',
          },
        });
        assert.strictEqual(assetRes.status, 200);
        assert.ok(assetRes.data.deliverables.some((d) => d.label === 'Primary Vector Logo' && d.addedBy === 'client'));
        assert.ok(
          assetRes.data.clientNotes.some((n) => n.text.includes('Prefer matte slate and emerald accents'))
        );
        const assetRow = assetRes.data.client.onboarding.milestones.find((m) => m.id === 'ms_p1_assets');
        assert.strictEqual(assetRow.discovery, 'In Progress');

        // Admin send-welcome resend
        const resendRes = await jsonReq(baseUrl, '/api/admin/clients/apex-roofing/onboarding/send-welcome', {
          method: 'POST',
          token: 'Jh22mp21??.',
          body: { dryRun: true },
        });
        assert.strictEqual(resendRes.status, 200);
        assert.strictEqual(resendRes.data.welcomeEmail.mode, 'dry_run');
        assert.ok(resendRes.data.client.onboarding.welcome.sentAt);

        // Admin PATCH onboarding (milestone update + agency deliverable + launchedAt)
        const patchRes = await jsonReq(baseUrl, '/api/admin/clients/apex-roofing/onboarding', {
          method: 'PATCH',
          token: 'Jh22mp21??.',
          body: {
            milestoneUpdate: { id: 'ms_p2_preview', field: 'review', value: 'Done' },
            addDeliverable: {
              label: '72 Hour Interactive Staging Preview',
              url: 'https://rivvak.com/demo/roofing',
              category: 'staging',
            },
            launchedAt: '2026-12-05T15:00:00.000Z',
          },
        });
        assert.strictEqual(patchRes.status, 200);
        assert.strictEqual(patchRes.data.onboarding.launchedAt, '2026-12-05T15:00:00.000Z');
        const previewRow = patchRes.data.onboarding.milestones.find((m) => m.id === 'ms_p2_preview');
        assert.strictEqual(previewRow.review, 'Done');
        assert.ok(
          patchRes.data.onboarding.deliverables.some(
            (d) => d.url === 'https://rivvak.com/demo/roofing' && d.category === 'staging' && d.addedBy === 'agency'
          )
        );

        // Final sync confirms full persistence
        const finalSync = await jsonReq(baseUrl, '/api/client/apex-roofing/sync', { token: apexCode });
        assert.strictEqual(finalSync.status, 200);
        assert.strictEqual(finalSync.data.client.onboarding.agreement.status, 'signed');
        assert.strictEqual(finalSync.data.client.onboarding.strategyCall.status, 'scheduled');
        assert.strictEqual(finalSync.data.client.onboarding.launchedAt, '2026-12-05T15:00:00.000Z');
      }),
    ];

    for (const run of suites) {
      await run();
    }

    console.log(`\nALL ${passed}/${suites.length} AUTOMATION BACKEND TESTS PASSED.`);
  } finally {
    if (instance) await instance.stop().catch(() => {});
    if (webhookReceiver) await new Promise((r) => webhookReceiver.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error('\nTEST FAILURE:', err);
  process.exit(1);
});
