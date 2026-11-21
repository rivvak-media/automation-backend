'use strict';

/**
 * Self-contained verification suite for Rivvak Media Automation Backend.
 * Starts server on ephemeral port 0 using an isolated temporary data directory
 * and cleans up all temp files on completion.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const { startServer, parseCsv, runSchedulerTick, sendSmtpEmail, verifySmtpAuth, parseDotEnvFile } = require('./server');

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
    ADMIN_PASSCODE: 'RIVVAK-2026',
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
        assert.strictEqual(h.data.clients, 2);
        assert.strictEqual(h.headers.get('access-control-allow-origin'), 'https://rivvak.com');

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
        const stateRes = await jsonReq(baseUrl, '/api/state', { token: 'RIVVAK-2026' });
        assert.strictEqual(stateRes.status, 200);
        assert.ok(stateRes.data.clients['clean-results'], 'Clean Results client seeded');
        assert.ok(stateRes.data.clients['carleen-ligozio'], 'Carleen Ligozio client seeded');
        const cr = stateRes.data.clients['clean-results'];
        assert.strictEqual(cr.workflows.length, 7, 'Clean Results seeded with 7 gym workflows');
        assert.ok(
          cr.campaigns.some((c) => c.name.includes('CleanResults_ "Body by Bobby!"')),
          'Meta Ad campaign seeded'
        );

        const carleenSync = await jsonReq(baseUrl, '/api/client/carleen-ligozio/sync', { token: 'RIVVAK-2026' });
        assert.strictEqual(carleenSync.status, 200);
        assert.strictEqual(carleenSync.data.client.business, 'Carleen Ligozio');

        const created = await jsonReq(baseUrl, '/api/admin/clients', {
          method: 'POST',
          token: 'RIVVAK-2026',
          body: { business: 'Temp Test Studio', accessCode: 'TEMP-2026' },
        });
        assert.strictEqual(created.status, 201);
        assert.strictEqual(created.data.slug, 'temp-test-studio');

        const deleted = await jsonReq(baseUrl, '/api/admin/clients/temp-test-studio', {
          method: 'DELETE',
          token: 'RIVVAK-2026',
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
          token: 'RIVVAK-2026',
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
              ADMIN_PASSCODE: 'RIVVAK-2026',
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
