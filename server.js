'use strict';

/**
 * Rivvak Media Automation Backend Engine v2.0.0
 * Zero-dependency Node.js multi-tenant server providing:
 * - Persistent JSON store (data/store.json) with atomic .tmp+rename & .bak recovery
 * - Dark-obsidian HTML status dashboard & /api/health endpoint
 * - Public lead intake (/api/public/lead) with sliding-window rate limiter, honeypot, Resend/SMTP alerts & auto-reply
 * - Strict CORS & constant-time Bearer token isolation (Admin vs Client accessCode)
 * - RFC-4180 PushPress Grow CSV migration & deduplication (Contacts & Opportunities)
 * - Live channel dispatchers via native fetch / TLS SMTP & IMAP inbox summary with honest dry-run mode
 * - Inbound webhooks (Twilio SMS, Meta IG DM verify + events, Google Business Profile reviews, Stripe HMAC-SHA256)
 * - Idempotent 24/7 workflow scheduler (24h/2h bookings, birthdays, 7/14/30d retention, due posts, 3d retainer reminders)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');
const querystring = require('querystring');
const tls = require('tls');
const net = require('net');

const SERVICE_NAME = 'rivvak-automation-backend';
const BRAND_NAME = 'Rivvak Media';
const SERVICE_VERSION = '2.0.0';
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_PUBLIC_LEADS = 500;
const MAX_STRIPE_EVENTS = 200;
const LEAD_RATE_WINDOW_MS = 10 * 60 * 1000;
const LEAD_RATE_MAX_REQUESTS = 10;
const VALID_LEAD_STATUSES = new Set(['new', 'contacted', 'qualified', 'won', 'archived']);
const HANDLED_STRIPE_EVENTS = new Set([
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.deleted',
]);

const CANONICAL_STAGES = [
  'New Lead',
  'In Discussion',
  'Tour / Trial',
  'Booked',
  'Active Member',
  'Nurture',
];

/**
 * Parse a .env file into a key/value object without mutating process.env.
 * @param {string} envPath
 * @returns {Record<string, string>}
 */
function parseDotEnvFile(envPath = path.join(__dirname, '.env')) {
  const parsed = {};
  if (!fs.existsSync(envPath)) return parsed;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) parsed[key] = val;
  }
  return parsed;
}

/**
 * Load .env file into process.env without overriding existing variables.
 * @param {string} envPath
 * @returns {Record<string, string>}
 */
function loadDotEnv(envPath = path.join(__dirname, '.env')) {
  const parsed = parseDotEnvFile(envPath);
  for (const [key, val] of Object.entries(parsed)) {
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
  return parsed;
}

/**
 * Build the default seeded multi-tenant store.
 * @param {object} env
 * @returns {object}
 */
function createDefaultStore(env = process.env) {
  const now = new Date();
  const nowIso = now.toISOString();
  const plusHours = (h) => new Date(now.getTime() + h * 3600000).toISOString();
  const minusDays = (d) => new Date(now.getTime() - d * 86400000).toISOString().slice(0, 10);

  return {
    version: 2,
    updatedAt: nowIso,
    settings: {
      agencyName: 'Rivvak Media',
      agencyEmail: 'connect@rivvak.com',
      globalWebhookUrl: env.WEBHOOK_URL || '',
    },
    adminState: {
      eoyTargetClients: 4,
      lastSyncedAt: nowIso,
    },
    clients: {
      'clean-results': {
        slug: 'clean-results',
        id: 'c_clean_results',
        business: 'Clean Results — House of Fitness',
        owner: 'Bobby',
        phone: '(561) 324-2189',
        email: '',
        location: 'West Palm Beach, FL',
        accessCode: 'CLEAN-2026',
        assignedDemos: ['/pages/demo-gym'],
        customUrl: '',
        webhookUrl: '',
        twilioNumber: env.TWILIO_FROM_NUMBER || '',
        igUserId: env.META_IG_USER_ID || '',
        modules: {
          analytics: { enabled: true, mode: 'self', label: 'Website & Analytics' },
          ads: { enabled: true, mode: 'managed', label: 'Meta Ad Manager' },
          calendars: { enabled: true, mode: 'self', label: 'Calendars & Bookings' },
          workflows: { enabled: true, mode: 'managed', label: 'Workflows & Email/SMS' },
          contacts: { enabled: true, mode: 'self', label: 'Contacts (CRM)' },
          inbox: { enabled: true, mode: 'self', label: 'Conversations (Inbox)' },
          opportunities: { enabled: true, mode: 'self', label: 'Opportunities (Funnel)' },
          marketing: { enabled: true, mode: 'self', label: 'Marketing Extras' },
        },
        campaigns: [
          {
            id: 'cmp_cr_bbb',
            name: 'CleanResults_ "Body by Bobby!"',
            platform: 'Meta Ads (IG & FB Video)',
            status: 'Active',
            managedBy: 'Rivvak Media',
            targetLocations: ['West Palm Beach, FL', 'Wellington, FL', 'Jupiter, FL', 'Palm Beach Gardens, FL'],
            objective: 'Lead Generation & 1-on-1 Facility Tours',
            dailyBudget: 45,
            spend: 1240,
            leads: 48,
            cpl: 25.83,
          },
          {
            id: 'cmp_cr_retarget',
            name: 'Clean Results 7-Day Pass Retargeting',
            platform: 'Meta Ads (Reels & Stories)',
            status: 'Active',
            managedBy: 'Rivvak Media',
            targetLocations: ['West Palm Beach, FL', 'Palm Beach County, FL'],
            objective: 'Trial Pass & Assessment Bookings',
            dailyBudget: 25,
            spend: 420,
            leads: 19,
            cpl: 22.11,
          },
        ],
        leadSources: [
          { name: 'Meta Ads — CleanResults_ "Body by Bobby!"', count: 48, conversionPct: 31 },
          { name: 'Google Search & Maps GBP', count: 29, conversionPct: 38 },
          { name: 'Instagram Organic & Reels', count: 22, conversionPct: 24 },
          { name: 'Website 4K Floor Tour', count: 18, conversionPct: 44 },
          { name: 'Walk-In / Member Referral', count: 14, conversionPct: 57 },
        ],
        bookings: [
          {
            id: 'bk_cr_1',
            leadName: 'Marcus Vance',
            phone: '+15615550114',
            email: 'marcus.vance@example.com',
            sessionType: '1-on-1 Facility Tour & Body-Comp Assessment',
            staff: 'Bobby',
            scheduledAt: plusHours(20),
            status: 'Tour Scheduled',
            notes: 'Interested in Body by Bobby 12-week strength program.',
          },
          {
            id: 'bk_cr_2',
            leadName: 'Elena Rostova',
            phone: '+15615550132',
            email: 'elena.r@example.com',
            sessionType: 'Personal Training Intro Consult',
            staff: 'Bobby',
            scheduledAt: plusHours(36),
            status: 'Confirmed',
            notes: 'Lower back mobility focus; requested morning slot.',
          },
          {
            id: 'bk_cr_3',
            leadName: 'Devon Brooks',
            phone: '+15615550178',
            email: 'devon.b@example.com',
            sessionType: '7-Day VIP Trial Kickoff',
            staff: 'Coach Alex',
            scheduledAt: plusHours(60),
            status: 'Confirmed',
            notes: 'Coming from Wellington after Meta video ad.',
          },
          {
            id: 'bk_cr_4',
            leadName: 'Tessa Miller',
            phone: '+15615550195',
            email: 'tessa.miller@example.com',
            sessionType: 'Athlete Conditioning Evaluation',
            staff: 'Bobby',
            scheduledAt: minusDays(2) + 'T15:00:00.000Z',
            status: 'Completed',
            notes: 'Signed up for 3x/week hybrid coaching.',
          },
        ],
        workflows: [
          {
            id: 'wf_speed_to_lead',
            name: 'New Lead Speed-to-Lead SMS (<60s)',
            trigger: 'new_lead',
            delayMinutes: 1,
            channel: 'SMS',
            active: true,
            managedBy: 'Rivvak Media',
            template:
              'Hey {{firstName}}, Bobby from Clean Results House of Fitness here! Saw you checked out our Body by Bobby program. Want to swing by this week for a quick 1-on-1 tour?',
            runCount: 48,
            lastRunAt: nowIso,
          },
          {
            id: 'wf_injury_intake',
            name: 'Injury / Health History Intake Questionnaire',
            trigger: 'tour_booked',
            delayMinutes: 5,
            channel: 'SMS',
            active: true,
            managedBy: 'Rivvak Media',
            template:
              'Before we meet at Clean Results, {{firstName}}, let Bobby know if you have any prior injuries or mobility limits so we tailor your session safely.',
            runCount: 27,
            lastRunAt: nowIso,
          },
          {
            id: 'wf_booking_reminders',
            name: '24h & 2h Session Booking Reminders',
            trigger: 'booking_reminder',
            delayMinutes: 0,
            channel: 'SMS',
            active: true,
            managedBy: 'Rivvak Media',
            reminderHours: [24, 2],
            template:
              'Reminder {{firstName}}: your {{sessionType}} at Clean Results House of Fitness is coming up at {{scheduledAt}}. Reply C to confirm!',
            runCount: 64,
            lastRunAt: nowIso,
          },
          {
            id: 'wf_retention_checkin',
            name: 'Member Retention 7/14/30-Day Check-In',
            trigger: 'retention_checkin',
            delayMinutes: 0,
            channel: 'SMS',
            active: true,
            managedBy: 'Rivvak Media',
            checkpointsDays: [7, 14, 30],
            template:
              'Hey {{firstName}}, checking in from Clean Results! How is training feeling so far? Reply anytime if you want Bobby to adjust your split.',
            runCount: 39,
            lastRunAt: nowIso,
          },
          {
            id: 'wf_birthday_sms',
            name: 'Member Birthday SMS Celebration',
            trigger: 'member_birthday',
            delayMinutes: 0,
            channel: 'SMS',
            active: true,
            managedBy: 'Rivvak Media',
            template:
              'Happy Birthday {{firstName}}! From Bobby and the entire Clean Results crew — come grab a complimentary recovery shake on your next lift.',
            runCount: 19,
            lastRunAt: nowIso,
          },
          {
            id: 'wf_missed_call',
            name: 'Missed-Call Text-Back',
            trigger: 'missed_call',
            delayMinutes: 1,
            channel: 'SMS',
            active: true,
            managedBy: 'Rivvak Media',
            template:
              'Sorry we missed your call at Clean Results House of Fitness — Bobby is on the gym floor coaching. Text us here and we will get right back to you!',
            runCount: 22,
            lastRunAt: nowIso,
          },
          {
            id: 'wf_gbp_review',
            name: 'Policy-Compliant Post-Session Google Review Request',
            trigger: 'session_completed',
            delayMinutes: 120,
            channel: 'SMS',
            active: true,
            managedBy: 'Rivvak Media',
            template:
              'Thanks for training with us at Clean Results, {{firstName}}! If you have 30 seconds, sharing an honest Google review helps local West Palm Beach lifters find us.',
            runCount: 31,
            lastRunAt: nowIso,
          },
        ],
        contacts: [
          {
            id: 'ct_cr_1',
            firstName: 'Marcus',
            lastName: 'Vance',
            name: 'Marcus Vance',
            email: 'marcus.vance@example.com',
            phone: '(561) 555-0114',
            tags: ['Meta Lead', 'Body by Bobby', 'West Palm Beach'],
            status: 'Lead',
            source: 'Meta Ads — CleanResults_ "Body by Bobby!"',
            birthday: '1993-05-14',
            injuryNotes: 'Mild right shoulder impingement on overhead press.',
            membershipTier: 'Prospect',
            joinedAt: minusDays(3),
            lastCheckInAt: minusDays(3),
            customFields: {
              injuryIntake: 'Mild right shoulder impingement on overhead press.',
              birthday: '1993-05-14',
              leadSource: 'Meta Ads — CleanResults_ "Body by Bobby!"',
              membershipTier: 'Prospect',
            },
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          {
            id: 'ct_cr_2',
            firstName: 'Elena',
            lastName: 'Rostova',
            name: 'Elena Rostova',
            email: 'elena.r@example.com',
            phone: '(561) 555-0132',
            tags: ['Tour Scheduled', 'Personal Training'],
            status: 'Active Member',
            source: 'Google Search & Maps GBP',
            birthday: '1991-08-22',
            injuryNotes: 'Lower back stiffness; prefers trap-bar deadlifts.',
            membershipTier: '1-on-1 Coaching',
            joinedAt: minusDays(14),
            lastCheckInAt: minusDays(14),
            customFields: {
              injuryIntake: 'Lower back stiffness; prefers trap-bar deadlifts.',
              birthday: '1991-08-22',
              leadSource: 'Google Search & Maps GBP',
              membershipTier: '1-on-1 Coaching',
            },
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          {
            id: 'ct_cr_3',
            firstName: 'Tessa',
            lastName: 'Miller',
            name: 'Tessa Miller',
            email: 'tessa.miller@example.com',
            phone: '(561) 555-0195',
            tags: ['Active Member', 'Hybrid Coaching'],
            status: 'Active Member',
            source: 'Website 4K Floor Tour',
            birthday: '1996-02-09',
            injuryNotes: 'None reported.',
            membershipTier: 'Hybrid 3x/wk',
            joinedAt: minusDays(30),
            lastCheckInAt: minusDays(2),
            customFields: {
              injuryIntake: 'None reported.',
              birthday: '1996-02-09',
              leadSource: 'Website 4K Floor Tour',
              membershipTier: 'Hybrid 3x/wk',
            },
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
        inboxThreads: [
          {
            id: 'th_cr_ig_1',
            channel: 'Instagram DM',
            contactName: 'Jordan Perez (@jordanp_wpb)',
            contactHandle: '@jordanp_wpb',
            recipientId: 'ig_jordan_001',
            unread: 1,
            lastMessageAt: nowIso,
            preview: 'Saw the Body by Bobby reel — do you have evening coaching slots?',
            messages: [
              {
                id: 'msg_cr_1',
                direction: 'inbound',
                channel: 'Instagram DM',
                sender: '@jordanp_wpb',
                body: 'Saw the Body by Bobby reel — do you have evening coaching slots this week in West Palm Beach?',
                receivedAt: nowIso,
                deliveryMode: 'seeded',
              },
            ],
          },
          {
            id: 'th_cr_sms_1',
            channel: 'SMS',
            contactName: 'Marcus Vance',
            contactPhone: '+15615550114',
            unread: 0,
            lastMessageAt: nowIso,
            preview: 'Confirmed for tomorrow at 10am!',
            messages: [
              {
                id: 'msg_cr_2',
                direction: 'outbound',
                channel: 'SMS',
                sender: 'Clean Results — House of Fitness',
                body: 'Hey Marcus, Bobby from Clean Results here! Want to lock in a 1-on-1 tour tomorrow?',
                receivedAt: nowIso,
                deliveryMode: 'seeded',
              },
              {
                id: 'msg_cr_3',
                direction: 'inbound',
                channel: 'SMS',
                sender: '+15615550114',
                body: 'Confirmed for tomorrow at 10am!',
                receivedAt: nowIso,
                deliveryMode: 'seeded',
              },
            ],
          },
          {
            id: 'th_cr_email_1',
            channel: 'Email',
            contactName: 'Samantha Cole',
            contactEmail: 'samantha.cole@example.com',
            unread: 0,
            lastMessageAt: nowIso,
            preview: 'Corporate wellness passes for 8 staff members',
            messages: [
              {
                id: 'msg_cr_4',
                direction: 'inbound',
                channel: 'Email',
                sender: 'samantha.cole@example.com',
                subject: 'Corporate wellness passes for 8 staff members',
                body: 'Hi Bobby, our Flagler Drive office is looking into semi-private strength sessions for 8 team members.',
                receivedAt: nowIso,
                deliveryMode: 'seeded',
              },
            ],
          },
          {
            id: 'th_cr_gbp_1',
            channel: 'Google Reviews',
            contactName: 'Derrick Holloway (5★ Google Review)',
            rating: 5,
            unread: 0,
            lastMessageAt: nowIso,
            preview: 'Cleanest private training floor in West Palm Beach.',
            messages: [
              {
                id: 'msg_cr_5',
                direction: 'inbound',
                channel: 'Google Reviews',
                sender: 'Derrick Holloway',
                rating: 5,
                body: 'Cleanest private training floor in West Palm Beach. Bobby dialed in my form from day one.',
                receivedAt: nowIso,
                deliveryMode: 'seeded',
              },
            ],
          },
        ],
        opportunities: [
          {
            id: 'opp_cr_1',
            title: 'Marcus Vance — 12-Week Body by Bobby',
            contactName: 'Marcus Vance',
            email: 'marcus.vance@example.com',
            phone: '+15615550114',
            stage: 'Tour / Trial',
            value: 1450,
            source: 'Meta Ads — CleanResults_ "Body by Bobby!"',
            status: 'Open',
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          {
            id: 'opp_cr_2',
            title: 'Jordan Perez — Evening Semi-Private',
            contactName: 'Jordan Perez',
            email: '',
            phone: '',
            stage: 'New Lead',
            value: 900,
            source: 'Instagram Organic & Reels',
            status: 'Open',
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          {
            id: 'opp_cr_3',
            title: 'Samantha Cole — Corporate Group (8)',
            contactName: 'Samantha Cole',
            email: 'samantha.cole@example.com',
            phone: '',
            stage: 'In Discussion',
            value: 3600,
            source: 'Google Search & Maps GBP',
            status: 'Open',
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          {
            id: 'opp_cr_4',
            title: 'Devon Brooks — 7-Day Pass to Monthly',
            contactName: 'Devon Brooks',
            email: 'devon.b@example.com',
            phone: '+15615550178',
            stage: 'Booked',
            value: 780,
            source: 'Meta Ads — CleanResults_ "Body by Bobby!"',
            status: 'Open',
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          {
            id: 'opp_cr_5',
            title: 'Tessa Miller — Hybrid Coaching 3x/wk',
            contactName: 'Tessa Miller',
            email: 'tessa.miller@example.com',
            phone: '+15615550195',
            stage: 'Active Member',
            value: 2100,
            source: 'Website 4K Floor Tour',
            status: 'Won',
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          {
            id: 'opp_cr_6',
            title: 'Andre Silva — Q4 Winback',
            contactName: 'Andre Silva',
            email: 'andre.silva@example.com',
            phone: '(561) 555-0188',
            stage: 'Nurture',
            value: 650,
            source: 'Walk-In / Member Referral',
            status: 'Open',
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
        marketing: {
          mediaAssets: [
            { id: 'ma_1', title: '4K Gym Floor Interactive Render', type: 'Image', url: '/assets/cr-master-gym-wall.webp', tags: ['4K', 'Floor Tour'] },
            { id: 'ma_2', title: 'Body by Bobby Transformation Reel', type: 'Video', url: '/assets/reel-misc.webp', tags: ['IG Reel', 'Meta Ad'] },
            { id: 'ma_3', title: 'Turf & Sled Conditioning Bay', type: 'Image', url: '/assets/cr-facility-turf.webp', tags: ['GBP', 'Turf'] },
          ],
          scheduledPosts: [
            {
              id: 'sp_1',
              platform: 'IG Reel',
              title: 'Body by Bobby — 6AM West Palm Beach Turf Finisher',
              caption: 'Zero crowded commercial racks. Private turf, calibrated plates, and custom splits in West Palm Beach.',
              scheduledAt: plusHours(48),
              status: 'Scheduled',
            },
            {
              id: 'sp_2',
              platform: 'FB Post',
              title: '7-Day VIP Strength Assessment Pass',
              caption: 'West Palm Beach, Wellington & Jupiter athletes — lock in your 1-on-1 body-comp & tour slot.',
              scheduledAt: plusHours(72),
              status: 'Scheduled',
            },
            {
              id: 'sp_3',
              platform: 'GBP Update',
              title: 'New Morning Personal Training Windows Open',
              caption: 'Updated morning coaching availability at Clean Results House of Fitness.',
              scheduledAt: plusHours(96),
              status: 'Scheduled',
            },
          ],
          brandBoard: {
            colors: ['#09090B', '#10B981', '#FFFFFF', '#F8F9FA'],
            fonts: 'Plus Jakarta Sans / DM Sans',
            serviceAreas: 'West Palm Beach, Wellington, Jupiter, Palm Beach Gardens',
          },
          templates: [
            { id: 'tpl_1', title: 'New Lead Speed SMS', channel: 'SMS', body: 'Hey {{firstName}}, Bobby from Clean Results! Got your request — want to swing by for a quick tour today or tomorrow?' },
            { id: 'tpl_2', title: 'Injury Intake Follow-Up', channel: 'SMS', body: 'Quick prep before your assessment, {{firstName}}: any knee, back, or shoulder history we should work around?' },
            { id: 'tpl_3', title: '14-Day Reactivation', channel: 'SMS', body: 'Hey {{firstName}}, saved you a quiet floor slot this week at Clean Results. Want me to put you down for Thursday?' },
            { id: 'tpl_4', title: 'Member Birthday Wish', channel: 'SMS', body: 'Happy Birthday {{firstName}}! Next recovery shake at Clean Results is on Bobby.' },
            { id: 'tpl_5', title: '5-Star Google Review Ask', channel: 'SMS', body: 'Loved having you train with us, {{firstName}}! Mind dropping an honest Google review for Clean Results?' },
            { id: 'tpl_6', title: 'IG Transformation Reel Caption', channel: 'IG Reel', body: 'Consistent form, customized programming, zero guesswork. Clean Results — West Palm Beach.' },
          ],
        },
        executionLogs: [],
        outboundQueue: [],
        processedScheduleKeys: {},
      },
      'carleen-ligozio': {
        slug: 'carleen-ligozio',
        id: 'c_carleen',
        business: 'Carleen Ligozio',
        owner: 'Carleen Ligozio',
        phone: '(561) 841-6097',
        email: 'cligozio@me.com',
        location: 'West Palm Beach, FL & Southampton, NY',
        accessCode: 'CARLEEN-2026',
        assignedDemos: ['/pages/demo-clothes'],
        customUrl: '',
        webhookUrl: '',
        twilioNumber: '',
        igUserId: '',
        modules: {
          analytics: { enabled: true, mode: 'self', label: 'Website & Analytics' },
          ads: { enabled: true, mode: 'managed', label: 'Meta Ad Manager' },
          calendars: { enabled: true, mode: 'self', label: 'Calendars & Bookings' },
          workflows: { enabled: true, mode: 'managed', label: 'Workflows & Email/SMS' },
          contacts: { enabled: true, mode: 'self', label: 'Contacts (CRM)' },
          inbox: { enabled: true, mode: 'self', label: 'Conversations (Inbox)' },
          opportunities: { enabled: true, mode: 'self', label: 'Opportunities (Funnel)' },
          marketing: { enabled: true, mode: 'self', label: 'Marketing Extras' },
        },
        campaigns: [
          {
            id: 'cmp_cl_launch',
            name: 'Carleen Ligozio — Official Boutique Showcase',
            platform: 'Meta Ads (IG Carousel)',
            status: 'Paused',
            managedBy: 'Rivvak Media',
            targetLocations: ['West Palm Beach, FL', 'Palm Beach, FL', 'Southampton, NY'],
            objective: 'Private Styling Appointments & Lookbook',
            dailyBudget: 35,
            spend: 0,
            leads: 0,
            cpl: 0,
          },
        ],
        leadSources: [
          { name: 'Google Business Profile (WPB & Southampton)', count: 14, conversionPct: 42 },
          { name: 'Instagram Boutique DMs', count: 11, conversionPct: 36 },
          { name: 'Private Client Referrals', count: 9, conversionPct: 67 },
        ],
        bookings: [
          {
            id: 'bk_cl_1',
            leadName: 'Victoria Sterling',
            phone: '+15615550241',
            email: 'v.sterling@example.com',
            sessionType: 'Private Resort Styling Appointment (WPB)',
            staff: 'Carleen Ligozio',
            scheduledAt: plusHours(30),
            status: 'Confirmed',
            notes: '3727 S Dixie Hwy showroom visit.',
          },
        ],
        workflows: [
          {
            id: 'wf_cl_gbp_cleanup',
            name: 'GBP Verification & Impersonation Cleanup',
            trigger: 'manual',
            delayMinutes: 0,
            channel: 'Email',
            active: true,
            managedBy: 'Rivvak Media',
            template: 'Status update for Carleen: GBP edit & registrar/host takedown notices active for carleenligoziollc-fl.com.',
            runCount: 1,
            lastRunAt: nowIso,
          },
          {
            id: 'wf_cl_launch',
            name: 'Official Boutique Website & VIP Styling Invite',
            trigger: 'new_lead',
            delayMinutes: 2,
            channel: 'Email',
            active: true,
            managedBy: 'Rivvak Media',
            template: 'Welcome {{firstName}}, thank you for reaching out to Carleen Ligozio. Reply with your preferred showroom (West Palm Beach or Southampton).',
            runCount: 0,
            lastRunAt: null,
          },
        ],
        contacts: [
          {
            id: 'ct_cl_1',
            firstName: 'Victoria',
            lastName: 'Sterling',
            name: 'Victoria Sterling',
            email: 'v.sterling@example.com',
            phone: '(561) 555-0241',
            tags: ['VIP Client', 'West Palm Beach'],
            status: 'Active Member',
            source: 'Private Client Referrals',
            birthday: '1985-09-12',
            injuryNotes: '',
            membershipTier: 'VIP Styling',
            joinedAt: minusDays(10),
            lastCheckInAt: minusDays(10),
            customFields: {
              injuryIntake: '',
              birthday: '1985-09-12',
              leadSource: 'Private Client Referrals',
              membershipTier: 'VIP Styling',
            },
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
        inboxThreads: [
          {
            id: 'th_cl_email_1',
            channel: 'Email',
            contactName: 'Victoria Sterling',
            contactEmail: 'v.sterling@example.com',
            unread: 1,
            lastMessageAt: nowIso,
            preview: 'Confirming Friday afternoon at 3727 S Dixie Hwy',
            messages: [
              {
                id: 'msg_cl_1',
                direction: 'inbound',
                channel: 'Email',
                sender: 'v.sterling@example.com',
                subject: 'Friday Showroom Visit',
                body: 'Confirming Friday afternoon at 3727 S Dixie Hwy for the seasonal resort preview.',
                receivedAt: nowIso,
                deliveryMode: 'seeded',
              },
            ],
          },
        ],
        opportunities: [
          {
            id: 'opp_cl_1',
            title: 'Victoria Sterling — Seasonal Capsule',
            contactName: 'Victoria Sterling',
            email: 'v.sterling@example.com',
            phone: '(561) 555-0241',
            stage: 'Booked',
            value: 4200,
            source: 'Private Client Referrals',
            status: 'Open',
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
        marketing: {
          mediaAssets: [
            { id: 'ma_cl_1', title: 'Luxury Apparel Boutique Hero', type: 'Image', url: '/assets/showcase-clothes.webp', tags: ['Lookbook', 'Apparel'] },
          ],
          scheduledPosts: [
            {
              id: 'sp_cl_1',
              platform: 'IG Reel',
              title: 'West Palm Beach & Southampton Resort Preview',
              caption: 'Private showroom appointments open on S Dixie Hwy and Jobs Lane.',
              scheduledAt: plusHours(60),
              status: 'Scheduled',
            },
          ],
          brandBoard: {
            colors: ['#09090B', '#18181B', '#FFFFFF'],
            fonts: 'Editorial Serif / DM Sans',
            serviceAreas: '3727 S Dixie Hwy, West Palm Beach, FL 33405 & 16 Jobs Ln, Southampton, NY',
          },
          templates: [
            { id: 'tpl_cl_1', title: 'Private Appointment Invite', channel: 'Email', body: 'Dear {{firstName}}, we would love to welcome you to our West Palm Beach or Southampton showroom.' },
          ],
        },
        executionLogs: [],
        outboundQueue: [],
        processedScheduleKeys: {},
      },
    },
    publicLeads: [
      {
        id: 'lead_blue_diamond_pools',
        ticketId: 'RV-BDP-001',
        name: 'Jaime',
        business: 'Blue Diamond Pools',
        email: 'info@bluediamondpools.com',
        phone: '(954) 755-0777',
        website: 'https://bluediamondpools.com/',
        pageUrl: 'https://bluediamondpools.com/',
        location: 'Broward & Palm Beach County',
        industry: 'Pools & Outdoor',
        scope: 'Interactive Pool Transformation Showcase + Quote Calculator + Broward & Palm Beach Local SEO',
        estimatedSetup: '$1,950',
        estimatedMonthly: '$500/mo',
        message: 'Seeded prospect: Blue Diamond Pools (Jaime) — https://bluediamondpools.com/ — Broward & Palm Beach County.',
        status: 'qualified',
        source: 'Google Doc — Jaime Pool Company',
        notes: 'Initial agency prospect synced from Google Doc — Jaime Pool Company.',
        emailDispatched: false,
        emailMode: 'seeded',
        autoReplySent: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ],
    stripeEvents: [],
  };
}

/**
 * Resolve the JSON store file path from options or environment.
 * @param {object} options
 * @returns {string}
 */
function resolveStorePath(options = {}) {
  if (options.storePath) return path.resolve(options.storePath);
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  return path.join(path.resolve(dataDir), 'store.json');
}

/**
 * Normalize required store fields cleanly without clobbering existing tenant data.
 * @param {object} parsed
 * @param {object} env
 * @returns {object}
 */
function normalizeStoreShape(parsed, env = process.env) {
  const defaults = createDefaultStore(env);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return defaults;
  }
  if (!parsed.clients || typeof parsed.clients !== 'object' || Array.isArray(parsed.clients)) {
    parsed.clients = defaults.clients;
  }
  if (!parsed.settings || typeof parsed.settings !== 'object') {
    parsed.settings = defaults.settings;
  } else {
    parsed.settings = { ...defaults.settings, ...parsed.settings };
  }
  if (!parsed.adminState || typeof parsed.adminState !== 'object') {
    parsed.adminState = defaults.adminState;
  }
  if (!Array.isArray(parsed.publicLeads)) {
    parsed.publicLeads = defaults.publicLeads;
  }
  if (!Array.isArray(parsed.stripeEvents)) {
    parsed.stripeEvents = [];
  }
  if (!parsed.version) {
    parsed.version = 2;
  }
  return parsed;
}

/**
 * Attempt to parse a store JSON file on disk, ensuring it contains a valid clients map.
 * @param {string} filePath
 * @returns {object|null}
 */
function tryReadValidStoreFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.clients || typeof parsed.clients !== 'object' || Array.isArray(parsed.clients)) {
      return null;
    }
    return parsed;
  } catch (_) {
    return null;
  }
}

/**
 * Load store from disk with automatic .bak recovery on missing/corrupted store.json.
 * @param {string} storePath
 * @param {object} env
 * @returns {object}
 */
function loadStore(storePath, env = process.env) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const bakPath = `${storePath}.bak`;

  const primary = tryReadValidStoreFile(storePath);
  if (primary) {
    return normalizeStoreShape(primary, env);
  }

  const backup = tryReadValidStoreFile(bakPath);
  if (backup) {
    const recovered = normalizeStoreShape(backup, env);
    const serialized = JSON.stringify(recovered, null, 2);
    const tmpPath = `${storePath}.${process.pid}.${Date.now()}.recover.tmp`;
    fs.writeFileSync(tmpPath, serialized, 'utf8');
    fs.renameSync(tmpPath, storePath);
    return recovered;
  }

  const initial = createDefaultStore(env);
  saveStore(storePath, initial);
  return initial;
}

/**
 * Atomically persist store JSON to disk (.tmp + rename) and maintain a valid .bak snapshot.
 * @param {string} storePath
 * @param {object} store
 */
function saveStore(storePath, store) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  store.updatedAt = new Date().toISOString();
  const serialized = JSON.stringify(store, null, 2);
  const bakPath = `${storePath}.bak`;

  if (fs.existsSync(storePath)) {
    try {
      const currentRaw = fs.readFileSync(storePath, 'utf8');
      if (currentRaw.trim()) {
        const parsed = JSON.parse(currentRaw);
        if (parsed && typeof parsed.clients === 'object') {
          const bakTmp = `${bakPath}.${process.pid}.${Date.now()}.tmp`;
          fs.writeFileSync(bakTmp, currentRaw, 'utf8');
          fs.renameSync(bakTmp, bakPath);
        }
      }
    } catch (_) {
      // Never overwrite a good .bak with corrupted store.json bytes
    }
  }

  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, serialized, 'utf8');
  fs.renameSync(tmpPath, storePath);
}

/**
 * Constant-time token comparison via SHA-256 digests and crypto.timingSafeEqual.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqualToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Alias preserved for internal callers.
 */
function safeEqual(a, b) {
  return safeEqualToken(a, b);
}

/**
 * Apply baseline defensive HTTP security headers.
 * @param {http.ServerResponse} res
 */
function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
}

/**
 * Escape HTML special characters for safe server-side rendering.
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Check whether Native TLS SMTP credentials are configured.
 * @param {object} env
 * @returns {boolean}
 */
function isSmtpConfigured(env = process.env) {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

/**
 * Check whether any live transactional email provider (Resend or SMTP) is configured.
 * @param {object} env
 * @returns {boolean}
 */
function isLiveEmailConfigured(env = process.env) {
  return Boolean(env.RESEND_API_KEY || isSmtpConfigured(env));
}

/**
 * Render the dark-obsidian Rivvak Media status HTML dashboard for GET /.
 */
function renderStatusDashboardHtml({ uptimeSeconds, clientsCount, publicLeadsCount, smtpConfigured }) {
  const smtpLabel = smtpConfigured ? 'Configured' : 'Dry-Run';
  const smtpClass = smtpConfigured ? 'badge-ok' : 'badge-warn';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Rivvak Media — Cloud Automation Engine</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: #09090B;
      color: #F4F4F5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      width: 100%;
      max-width: 680px;
      background: #111114;
      border: 1px solid #27272A;
      border-radius: 16px;
      padding: 32px;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
    }
    .top {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 20px;
    }
    .brand {
      font-size: 12px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #A1A1AA;
      font-weight: 600;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      background: rgba(16, 185, 129, 0.14);
      color: #34D399;
      border: 1px solid rgba(16, 185, 129, 0.35);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #10B981;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 24px;
      line-height: 1.25;
      color: #FFFFFF;
    }
    p.sub {
      margin: 0 0 24px;
      color: #A1A1AA;
      font-size: 14px;
      line-height: 1.5;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .metric {
      background: #09090B;
      border: 1px solid #27272A;
      border-radius: 12px;
      padding: 14px 16px;
    }
    .metric-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #71717A;
      margin-bottom: 6px;
    }
    .metric-val {
      font-size: 20px;
      font-weight: 700;
      color: #FAFAFA;
    }
    .badge-ok { color: #34D399; }
    .badge-warn { color: #FBBF24; }
    .links {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      padding-top: 20px;
      border-top: 1px solid #27272A;
    }
    a.btn {
      display: inline-flex;
      align-items: center;
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      border: 1px solid #27272A;
      color: #FAFAFA;
      background: #18181B;
    }
    a.btn-primary {
      background: #0F766E;
      border-color: #0F766E;
      color: #FFFFFF;
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="top">
      <span class="brand">Rivvak Media Cloud</span>
      <span class="pill"><span class="dot"></span> ONLINE</span>
    </div>
    <h1>Rivvak Media — Cloud Automation Engine</h1>
    <p class="sub">Zero-dependency multi-tenant CRM, public intake, transactional dispatch, and 24/7 automation scheduler.</p>
    <section class="grid">
      <div class="metric">
        <div class="metric-label">Version</div>
        <div class="metric-val">${escapeHtml(SERVICE_VERSION)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Uptime</div>
        <div class="metric-val">${escapeHtml(uptimeSeconds)}s</div>
      </div>
      <div class="metric">
        <div class="metric-label">Active Clients</div>
        <div class="metric-val">${escapeHtml(clientsCount)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Public Leads</div>
        <div class="metric-val">${escapeHtml(publicLeadsCount)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">SMTP Status</div>
        <div class="metric-val ${smtpClass}">${escapeHtml(smtpLabel)}</div>
      </div>
    </section>
    <nav class="links">
      <a class="btn btn-primary" href="/api/health">Health JSON (/api/health)</a>
      <a class="btn" href="https://rivvak.com/" rel="noopener noreferrer">Rivvak Media Studio</a>
    </nav>
  </main>
</body>
</html>`;
}

/**
 * Determine whether an HTTP Origin header is allowed for CORS.
 * @param {string|undefined} origin
 * @param {object} env
 * @returns {boolean}
 */
function isAllowedOrigin(origin, env = process.env) {
  if (!origin || typeof origin !== 'string') return false;
  const cleaned = origin.trim().replace(/\/+$/, '');
  if (cleaned === 'https://rivvak.com' || cleaned === 'https://www.rivvak.com') {
    return true;
  }
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(cleaned)) {
    return true;
  }
  const extra = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return extra.includes(cleaned);
}

/**
 * Attach strict CORS headers when origin is allowed.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {object} env
 * @returns {boolean} True if request had an Origin that was rejected.
 */
function applyCors(req, res, env = process.env) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (!isAllowedOrigin(origin, env)) {
    return true;
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Rivvak-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
  return false;
}

/**
 * Send JSON HTTP response.
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {object} payload
 * @param {Record<string, string>} extraHeaders
 */
function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * Send HTML HTTP response.
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {string} html
 */
function sendHtml(res, statusCode, html) {
  const body = String(html);
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Send plain text HTTP response.
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {string} text
 */
function sendText(res, statusCode, text) {
  const body = String(text);
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Read request body up to MAX_BODY_BYTES and parse JSON or form-urlencoded payload.
 * @param {http.IncomingMessage} req
 * @returns {Promise<{ raw: string, data: any }>}
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        const err = new Error('Payload too large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({ raw, data: {} });
        return;
      }
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (ct.includes('application/x-www-form-urlencoded')) {
        resolve({ raw, data: querystring.parse(raw) });
        return;
      }
      try {
        resolve({ raw, data: JSON.parse(raw) });
      } catch (e) {
        if (!ct.includes('application/json') && raw.includes('=') && !raw.trim().startsWith('{')) {
          resolve({ raw, data: querystring.parse(raw) });
          return;
        }
        const err = new Error('Invalid JSON payload');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Authenticate incoming Bearer token as admin or single-tenant client using constant-time comparison.
 * @param {http.IncomingMessage} req
 * @param {object} store
 * @param {string} adminPasscode
 * @returns {{ role: 'admin' } | { role: 'client', clientSlug: string } | null}
 */
function authenticateRequest(req, store, adminPasscode) {
  const authHeader = String(req.headers.authorization || '');
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : '';
  if (!token) return null;
  if (safeEqualToken(token, adminPasscode)) {
    return { role: 'admin' };
  }
  for (const [slug, client] of Object.entries(store.clients || {})) {
    if (client && client.accessCode && safeEqualToken(token, String(client.accessCode))) {
      return { role: 'client', clientSlug: slug };
    }
  }
  return null;
}

/**
 * Parse RFC-4180 CSV text (handles quoted commas, newlines, escaped quotes, CRLF/LF, and BOM).
 * @param {string} csvText
 * @returns {Array<object>}
 */
function parseCsv(csvText) {
  if (typeof csvText !== 'string') return [];
  const text = csvText.replace(/^\uFEFF/, '');
  if (!text.trim()) return [];

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmptyRows = rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
  if (nonEmptyRows.length < 2) return [];

  const headers = nonEmptyRows[0].map((h) => h.trim());
  const records = [];
  for (let rIdx = 1; rIdx < nonEmptyRows.length; rIdx++) {
    const cells = nonEmptyRows[rIdx];
    const obj = {};
    let hasValue = false;
    for (let cIdx = 0; cIdx < headers.length; cIdx++) {
      const key = headers[cIdx] || `col_${cIdx}`;
      const val = cells[cIdx] !== undefined ? cells[cIdx].trim() : '';
      if (val) hasValue = true;
      obj[key] = val;
    }
    if (hasValue) records.push(obj);
  }
  return records;
}

function normHeader(h) {
  return String(h || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function normPhone(v) {
  const digits = String(v || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits.length >= 7 ? digits : '';
}

function normText(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseTags(v) {
  if (Array.isArray(v)) {
    return Array.from(new Set(v.map((t) => String(t).trim()).filter(Boolean)));
  }
  return Array.from(
    new Set(
      String(v || '')
        .split(/[,;|]/)
        .map((t) => t.trim())
        .filter(Boolean)
    )
  );
}

function parseMoney(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const cleaned = String(v || '').replace(/[^0-9.-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function mapStageName(rawStage) {
  const raw = String(rawStage || '').trim();
  if (!raw) return 'New Lead';
  const low = normText(raw);
  if (low === 'new inquiry' || low === 'new lead' || low === 'lead' || low === 'new') return 'New Lead';
  if (low === 'contacted' || low === 'in discussion' || low === 'discussion' || low === 'qualified') {
    return 'In Discussion';
  }
  if (low === 'trial booked' || low === 'tour' || low === 'trial' || low === 'tour trial' || low === 'tour / trial') {
    return 'Tour / Trial';
  }
  if (low === 'showed' || low === 'booked' || low === 'appointment booked') return 'Booked';
  if (low === 'won/member' || low === 'won member' || low === 'won' || low === 'active member' || low === 'closed won') {
    return 'Active Member';
  }
  if (low === 'cold/winback' || low === 'cold winback' || low === 'nurture' || low === 'lost' || low === 'cold') {
    return 'Nurture';
  }
  const exactCanonical = CANONICAL_STAGES.find((s) => normText(s) === low);
  return exactCanonical || raw;
}

/**
 * Extract normalized PushPress Grow fields from an arbitrary row object.
 * @param {object} rawRow
 * @returns {object}
 */
function mapPushPressRow(rawRow) {
  const mapped = {};
  const setField = (field, val) => {
    if (val || mapped[field] === undefined) mapped[field] = val;
  };
  for (const [rawKey, rawVal] of Object.entries(rawRow || {})) {
    const key = normHeader(rawKey);
    const val = rawVal === null || rawVal === undefined ? '' : String(rawVal).trim();

    if (key === 'first name' || key === 'firstname' || key === 'fname') setField('firstName', val);
    else if (key === 'last name' || key === 'lastname' || key === 'lname') setField('lastName', val);
    else if (key === 'name' || key === 'full name' || key === 'contact name' || key === 'lead name' || key === 'member name') {
      setField('name', val);
    } else if (key === 'email' || key === 'email address' || key === 'e mail') setField('email', val);
    else if (key === 'phone' || key === 'phone number' || key === 'mobile' || key === 'mobile phone' || key === 'cell' || key === 'sms') {
      setField('phone', val);
    } else if (key === 'tags' || key === 'tag' || key === 'labels') setField('tags', val);
    else if (key === 'status' || key === 'member status' || key === 'lead status' || key === 'opportunity status') {
      setField('status', val);
    } else if (key === 'source' || key === 'lead source' || key === 'acquisition source' || key === 'utm source') {
      setField('source', val);
    } else if (key === 'birthday' || key === 'birth date' || key === 'dob' || key === 'date of birth') {
      setField('birthday', val);
    } else if (
      key === 'injury notes' ||
      key === 'injury health intake notes' ||
      key === 'injury intake' ||
      key === 'health notes' ||
      key === 'health intake' ||
      key === 'medical notes' ||
      key === 'notes'
    ) {
      setField('injuryNotes', val);
    } else if (key === 'membership tier' || key === 'membership' || key === 'plan' || key === 'tier') {
      setField('membershipTier', val);
    } else if (key === 'stage' || key === 'pipeline stage' || key === 'funnel stage') {
      setField('stage', val);
    } else if (key === 'value' || key === 'monetary value' || key === 'deal value' || key === 'lead value' || key === 'amount' || key === 'price') {
      setField('value', val);
    } else if (key === 'opportunity name' || key === 'opportunity' || key === 'title' || key === 'deal name') {
      setField('title', val);
    } else if (key === 'joined at' || key === 'join date' || key === 'created at' || key === 'date added') {
      setField('joinedAt', val);
    } else if (key === 'last check in' || key === 'last checkin' || key === 'last visit') {
      setField('lastCheckInAt', val);
    }
  }

  let firstName = mapped.firstName || '';
  let lastName = mapped.lastName || '';
  let fullName = mapped.name || '';
  if (!fullName && (firstName || lastName)) {
    fullName = [firstName, lastName].filter(Boolean).join(' ');
  } else if (fullName && !firstName && !lastName) {
    const parts = fullName.split(/\s+/);
    firstName = parts[0] || '';
    lastName = parts.slice(1).join(' ');
  }

  return {
    firstName,
    lastName,
    name: fullName || mapped.title || mapped.email || mapped.phone || 'Unknown Contact',
    contactName: fullName,
    email: mapped.email || '',
    phone: mapped.phone || '',
    tags: parseTags(mapped.tags),
    status: mapped.status || '',
    source: mapped.source || '',
    birthday: mapped.birthday || '',
    injuryNotes: mapped.injuryNotes || '',
    membershipTier: mapped.membershipTier || '',
    stage: mapped.stage ? mapStageName(mapped.stage) : '',
    value: parseMoney(mapped.value),
    title: mapped.title || '',
    joinedAt: mapped.joinedAt || '',
    lastCheckInAt: mapped.lastCheckInAt || '',
  };
}

/**
 * Import contacts or opportunities from PushPress Grow CSV rows with deduplication.
 * @param {object} client
 * @param {'contacts'|'opportunities'} kind
 * @param {Array<object>} rawRows
 * @returns {{ kind: string, added: number, updated: number, merged: number, total: number }}
 */
function importPushPressRecords(client, kind, rawRows) {
  const nowIso = new Date().toISOString();
  let added = 0;
  let updated = 0;

  if (kind === 'contacts') {
    if (!Array.isArray(client.contacts)) client.contacts = [];
    const byEmail = new Map();
    const byPhone = new Map();
    for (const c of client.contacts) {
      const e = normEmail(c.email);
      const p = normPhone(c.phone);
      if (e) byEmail.set(e, c);
      if (p) byPhone.set(p, c);
    }

    for (const raw of rawRows) {
      const r = mapPushPressRow(raw);
      const e = normEmail(r.email);
      const p = normPhone(r.phone);
      const existing = (e && byEmail.get(e)) || (p && byPhone.get(p)) || null;

      if (existing) {
        if (r.firstName) existing.firstName = r.firstName;
        if (r.lastName) existing.lastName = r.lastName;
        if (r.name && r.name !== 'Unknown Contact') existing.name = r.name;
        if (r.email) existing.email = r.email;
        if (r.phone) existing.phone = r.phone;
        if (r.status) existing.status = r.status;
        if (r.source) existing.source = r.source;
        if (r.birthday) existing.birthday = r.birthday;
        if (r.injuryNotes) existing.injuryNotes = r.injuryNotes;
        if (r.membershipTier) existing.membershipTier = r.membershipTier;
        if (r.joinedAt) existing.joinedAt = r.joinedAt;
        if (r.lastCheckInAt) existing.lastCheckInAt = r.lastCheckInAt;
        existing.tags = Array.from(new Set([...(existing.tags || []), ...r.tags]));
        existing.customFields = {
          ...(existing.customFields || {}),
          injuryIntake: existing.injuryNotes || '',
          birthday: existing.birthday || '',
          leadSource: existing.source || '',
          membershipTier: existing.membershipTier || '',
        };
        existing.updatedAt = nowIso;
        if (normEmail(existing.email)) byEmail.set(normEmail(existing.email), existing);
        if (normPhone(existing.phone)) byPhone.set(normPhone(existing.phone), existing);
        updated++;
      } else {
        const record = {
          id: `ct_${crypto.randomUUID().slice(0, 8)}`,
          firstName: r.firstName,
          lastName: r.lastName,
          name: r.name,
          email: r.email,
          phone: r.phone,
          tags: r.tags,
          status: r.status || 'Lead',
          source: r.source || 'PushPress Grow Import',
          birthday: r.birthday,
          injuryNotes: r.injuryNotes,
          membershipTier: r.membershipTier,
          joinedAt: r.joinedAt || nowIso.slice(0, 10),
          lastCheckInAt: r.lastCheckInAt || '',
          customFields: {
            injuryIntake: r.injuryNotes || '',
            birthday: r.birthday || '',
            leadSource: r.source || 'PushPress Grow Import',
            membershipTier: r.membershipTier || '',
          },
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        client.contacts.push(record);
        if (e) byEmail.set(e, record);
        if (p) byPhone.set(p, record);
        added++;
      }
    }
    return { kind, added, updated, merged: updated, total: client.contacts.length };
  }

  if (kind === 'opportunities') {
    if (!Array.isArray(client.opportunities)) client.opportunities = [];
    const byEmail = new Map();
    const byPhone = new Map();
    const byNameStage = new Map();

    const registerOpp = (opp) => {
      const e = normEmail(opp.email);
      const p = normPhone(opp.phone);
      const ns = `${normText(opp.contactName || opp.title)}::${normText(opp.stage)}`;
      if (e) byEmail.set(e, opp);
      if (p) byPhone.set(p, opp);
      if (normText(opp.contactName || opp.title)) byNameStage.set(ns, opp);
    };

    client.opportunities.forEach(registerOpp);

    for (const raw of rawRows) {
      const r = mapPushPressRow(raw);
      const stage = r.stage || 'New Lead';
      const contactName = r.contactName || r.title || r.name;
      const e = normEmail(r.email);
      const p = normPhone(r.phone);
      const ns = `${normText(contactName)}::${normText(stage)}`;
      const existing =
        (e && byEmail.get(e)) ||
        (p && byPhone.get(p)) ||
        (normText(contactName) && byNameStage.get(ns)) ||
        null;

      if (existing) {
        if (r.title) existing.title = r.title;
        if (contactName) existing.contactName = contactName;
        if (r.email) existing.email = r.email;
        if (r.phone) existing.phone = r.phone;
        if (r.stage) existing.stage = stage;
        if (r.value) existing.value = r.value;
        if (r.source) existing.source = r.source;
        if (r.status) existing.status = r.status;
        if (r.injuryNotes) existing.notes = r.injuryNotes;
        existing.updatedAt = nowIso;
        registerOpp(existing);
        updated++;
      } else {
        const opp = {
          id: `opp_${crypto.randomUUID().slice(0, 8)}`,
          title: r.title || `${contactName} — ${stage}`,
          contactName,
          email: r.email,
          phone: r.phone,
          stage,
          value: r.value,
          source: r.source || 'PushPress Grow Import',
          status: r.status || (stage === 'Active Member' ? 'Won' : 'Open'),
          notes: r.injuryNotes || '',
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        client.opportunities.push(opp);
        registerOpp(opp);
        added++;
      }
    }
    return { kind, added, updated, merged: updated, total: client.opportunities.length };
  }

  const err = new Error('kind must be "contacts" or "opportunities"');
  err.statusCode = 400;
  throw err;
}

/**
 * Append a message into the matching client's Unified Inbox thread (creating one if needed).
 * @param {object} client
 * @param {object} params
 * @returns {object}
 */
function appendInboxMessage(client, { threadId, channel, contactName, contactPhone, contactEmail, contactHandle, recipientId, rating, sender, subject, body, direction, deliveryMode, sid }) {
  if (!Array.isArray(client.inboxThreads)) client.inboxThreads = [];
  const nowIso = new Date().toISOString();
  const phoneKey = normPhone(contactPhone || (channel === 'SMS' ? sender : ''));
  const emailKey = normEmail(contactEmail || (channel === 'Email' ? sender : ''));

  let thread = null;
  if (threadId) {
    thread = client.inboxThreads.find((t) => t.id === threadId);
  }
  if (!thread) {
    thread = client.inboxThreads.find((t) => {
      if (t.channel !== channel) return false;
      if (phoneKey && normPhone(t.contactPhone) === phoneKey) return true;
      if (emailKey && normEmail(t.contactEmail) === emailKey) return true;
      if (recipientId && t.recipientId === recipientId) return true;
      if (contactHandle && t.contactHandle === contactHandle) return true;
      if (contactName && normText(t.contactName) === normText(contactName)) return true;
      return false;
    });
  }

  if (!thread) {
    thread = {
      id: `th_${crypto.randomUUID().slice(0, 8)}`,
      channel,
      contactName: contactName || contactPhone || contactEmail || contactHandle || recipientId || 'New Contact',
      ...(contactPhone ? { contactPhone } : {}),
      ...(contactEmail ? { contactEmail } : {}),
      ...(contactHandle ? { contactHandle } : {}),
      ...(recipientId ? { recipientId } : {}),
      ...(rating !== undefined ? { rating } : {}),
      unread: 0,
      lastMessageAt: nowIso,
      preview: '',
      messages: [],
    };
    client.inboxThreads.unshift(thread);
  }

  const msg = {
    id: `msg_${crypto.randomUUID().slice(0, 8)}`,
    direction,
    channel,
    sender,
    ...(subject ? { subject } : {}),
    ...(rating !== undefined ? { rating } : {}),
    ...(sid ? { sid } : {}),
    body,
    receivedAt: nowIso,
    deliveryMode,
  };
  thread.messages.push(msg);
  thread.lastMessageAt = nowIso;
  thread.preview = String(body || subject || '').slice(0, 120);
  if (direction === 'inbound') {
    thread.unread = (Number(thread.unread) || 0) + 1;
  }
  return { thread, msg };
}

function resolveTemplate(template, vars = {}) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) =>
    vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : ''
  );
}

function extractEmailAddress(value) {
  const s = String(value || '').trim();
  const angle = s.match(/<([^<>]+)>/);
  return (angle ? angle[1] : s).replace(/[\r\n]/g, '').trim();
}

function sanitizeHeaderValue(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function encodeMimeHeader(value) {
  const clean = sanitizeHeaderValue(value);
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

function dotStuffBody(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

/**
 * Buffered line-oriented SMTP reply reader supporting multi-line responses.
 * @param {net.Socket|tls.TLSSocket} socket
 * @param {number} timeoutMs
 */
function createSmtpSession(socket, timeoutMs = 15000) {
  let buffer = '';
  let lines = [];
  let closed = false;
  let pendingResolve = null;
  let pendingReject = null;

  socket.setTimeout(timeoutMs);

  const failPending = (err) => {
    if (pendingReject) {
      const rj = pendingReject;
      pendingResolve = null;
      pendingReject = null;
      rj(err);
    }
  };

  const tryParseReply = () => {
    if (!pendingResolve) return;
    const collected = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      collected.push(line);
      const m = line.match(/^(\d{3})([ -])(.*)$/);
      if (m && m[2] === ' ') {
        const code = Number(m[1]);
        lines = lines.slice(i + 1);
        const rs = pendingResolve;
        pendingResolve = null;
        pendingReject = null;
        rs({ code, text: collected.join('\n'), lines: collected });
        return;
      }
    }
  };

  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const rawLine = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      lines.push(rawLine);
    }
    tryParseReply();
  };

  const onError = (err) => failPending(err);
  const onTimeout = () => {
    socket.destroy();
    failPending(new Error('SMTP socket timeout'));
  };
  const onClose = () => {
    closed = true;
    failPending(new Error('SMTP connection closed unexpectedly'));
  };

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('timeout', onTimeout);
  socket.on('close', onClose);

  const readReply = (expectedCodes) =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('SMTP socket already closed'));
        return;
      }
      pendingResolve = (reply) => {
        if (expectedCodes && !expectedCodes.includes(reply.code)) {
          reject(new Error(`SMTP unexpected reply ${reply.code}: ${reply.text}`));
          return;
        }
        resolve(reply);
      };
      pendingReject = reject;
      tryParseReply();
    });

  const command = async (cmdLine, expectedCodes) => {
    socket.write(`${cmdLine}\r\n`);
    return readReply(expectedCodes);
  };

  const detach = () => {
    socket.removeListener('data', onData);
    socket.removeListener('error', onError);
    socket.removeListener('timeout', onTimeout);
    socket.removeListener('close', onClose);
  };

  return { socket, readReply, command, detach };
}

/**
 * Connect via SMTPS (:465) or STARTTLS (:587) and complete AUTH LOGIN.
 * @param {object} cfg
 */
async function connectSmtpAndAuth(cfg = {}) {
  const host = cfg.host;
  const port = Number(cfg.port || 465);
  const user = cfg.user;
  const pass = cfg.pass;
  const ehloDomain = cfg.ehloDomain || 'rivvak.com';
  const timeoutMs = Number(cfg.timeoutMs || 15000);
  const isPlain = Boolean(cfg.plain);
  const useImplicitTls = !isPlain && (cfg.secure !== undefined ? Boolean(cfg.secure) : port === 465);

  if (!host || !user || !pass) {
    throw new Error('SMTP host, user, and pass are required');
  }

  let socket = await new Promise((resolve, reject) => {
    const onErr = (err) => reject(err);
    if (typeof cfg.connectFn === 'function') {
      const s = cfg.connectFn({ host, port }, () => {
        s.removeListener('error', onErr);
        resolve(s);
      });
      s.once('error', onErr);
      return;
    }
    if (useImplicitTls) {
      const s = tls.connect(
        {
          host,
          port,
          servername: host,
          ...(cfg.tlsOptions || {}),
        },
        () => {
          s.removeListener('error', onErr);
          resolve(s);
        }
      );
      s.once('error', onErr);
      return;
    }
    const s = net.connect({ host, port }, () => {
      s.removeListener('error', onErr);
      resolve(s);
    });
    s.once('error', onErr);
  });

  let session = createSmtpSession(socket, timeoutMs);
  try {
    const banner = await session.readReply([220]);
    let ehlo = await session.command(`EHLO ${ehloDomain}`, [250]);

    if (!isPlain && !useImplicitTls) {
      await session.command('STARTTLS', [220]);
      session.detach();
      socket = await new Promise((resolve, reject) => {
        const tlsSock = tls.connect(
          {
            socket,
            servername: host,
            ...(cfg.tlsOptions || {}),
          },
          () => resolve(tlsSock)
        );
        tlsSock.once('error', reject);
      });
      session = createSmtpSession(socket, timeoutMs);
      ehlo = await session.command(`EHLO ${ehloDomain}`, [250]);
    }

    await session.command('AUTH LOGIN', [334]);
    await session.command(Buffer.from(String(user), 'utf8').toString('base64'), [334]);
    await session.command(Buffer.from(String(pass), 'utf8').toString('base64'), [235]);

    return { session, socket, banner: banner.text, capabilities: ehlo.lines };
  } catch (err) {
    try {
      socket.destroy();
    } catch (_) {}
    throw err;
  }
}

/**
 * Verify SMTP TLS + AUTH LOGIN handshake and QUIT cleanly without sending mail.
 * @param {object} cfg
 * @returns {Promise<{ ok: boolean, authenticated: boolean, host: string, port: number, user: string, banner: string, capabilities: string[] }>}
 */
async function verifySmtpAuth(cfg = {}) {
  const { session, socket, banner, capabilities } = await connectSmtpAndAuth(cfg);
  try {
    await session.command('QUIT', [221]).catch(() => {});
    return {
      ok: true,
      authenticated: true,
      host: cfg.host,
      port: Number(cfg.port || 465),
      user: cfg.user,
      banner,
      capabilities,
    };
  } finally {
    try {
      socket.end();
    } catch (_) {}
  }
}

/**
 * Send an email via zero-dependency native TLS/STARTTLS SMTP (AUTH LOGIN).
 * @param {object} cfg
 * @returns {Promise<{ ok: boolean, messageId: string, response: string, host: string, port: number }>}
 */
async function sendSmtpEmail(cfg = {}) {
  const fromHeader = sanitizeHeaderValue(cfg.from || cfg.user);
  const toHeader = sanitizeHeaderValue(cfg.to);
  const mailFromAddr = extractEmailAddress(fromHeader || cfg.user);
  const rcptToAddr = extractEmailAddress(toHeader);
  if (!mailFromAddr || !rcptToAddr) {
    throw new Error('Valid SMTP from and to email addresses are required');
  }

  const domainPart = (mailFromAddr.split('@')[1] || 'rivvak.com').replace(/[^a-zA-Z0-9.-]/g, '');
  const messageId = `<${crypto.randomUUID()}@${domainPart}>`;
  const subjectHeader = encodeMimeHeader(cfg.subject || 'Message from Rivvak Media');
  const rawBody = cfg.text !== undefined ? cfg.text : cfg.body || '';
  const stuffedBody = dotStuffBody(rawBody);

  const headers = [
    `From: ${fromHeader}`,
    `To: ${toHeader}`,
    `Subject: ${subjectHeader}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
  ];
  if (cfg.replyTo) {
    headers.push(`Reply-To: ${sanitizeHeaderValue(cfg.replyTo)}`);
  }

  const { session, socket } = await connectSmtpAndAuth(cfg);
  try {
    await session.command(`MAIL FROM:<${mailFromAddr}>`, [250]);
    await session.command(`RCPT TO:<${rcptToAddr}>`, [250, 251]);
    await session.command('DATA', [354]);
    const mimePayload = `${headers.join('\r\n')}\r\n\r\n${stuffedBody}\r\n.`;
    const dataReply = await session.command(mimePayload, [250]);
    await session.command('QUIT', [221]).catch(() => {});
    return {
      ok: true,
      messageId,
      response: dataReply.text,
      host: cfg.host,
      port: Number(cfg.port || 465),
    };
  } finally {
    try {
      socket.end();
    } catch (_) {}
  }
}

/**
 * Shared transactional email dispatcher: Resend API -> Native TLS SMTP -> Honest dry_run_queued.
 */
async function sendTransactionalEmail({ to, subject, text, html, from, replyTo }, ctx = {}) {
  const env = ctx.env || process.env;
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  const smtpSendImpl = ctx.smtpSendImpl || sendSmtpEmail;
  const defaultFrom = from || env.RESEND_FROM || env.SMTP_FROM || env.SMTP_USER || 'Rivvak Media <connect@rivvak.com>';

  if (env.RESEND_API_KEY) {
    const resp = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: defaultFrom,
        to: [to],
        subject,
        text,
        ...(html ? { html } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        ok: false,
        statusCode: 502,
        mode: 'resend_error',
        error: data.message || 'Resend API error',
        status: resp.status,
        fromUsed: defaultFrom,
      };
    }
    return {
      ok: true,
      statusCode: 200,
      mode: 'live_resend',
      id: data.id,
      messageId: data.id,
      fromUsed: defaultFrom,
    };
  }

  if (isSmtpConfigured(env)) {
    const smtpHost = env.SMTP_HOST;
    const smtpPort = Number(env.SMTP_PORT || 465);
    const isLoopbackPlain =
      env.SMTP_PLAIN === 'true' && (smtpHost === '127.0.0.1' || smtpHost === 'localhost');
    const smtpSender = from || env.SMTP_FROM || env.RESEND_FROM || env.SMTP_USER;
    try {
      const smtpRes = await smtpSendImpl({
        host: smtpHost,
        port: smtpPort,
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        from: smtpSender,
        to,
        subject,
        text,
        replyTo,
        plain: isLoopbackPlain,
      });
      return {
        ok: true,
        statusCode: 200,
        mode: 'live_smtp',
        messageId: smtpRes.messageId,
        response: smtpRes.response,
        fromUsed: smtpSender,
      };
    } catch (err) {
      return {
        ok: false,
        statusCode: 502,
        mode: 'smtp_error',
        error: err.message || 'SMTP delivery failed',
        fromUsed: smtpSender,
      };
    }
  }

  return {
    ok: true,
    statusCode: 200,
    mode: 'dry_run_queued',
    missingEnv: ['RESEND_API_KEY or SMTP_*'],
    fromUsed: defaultFrom,
  };
}

/**
 * Decode RFC-2047 encoded-word MIME headers (=?UTF-8?B?...?= and =?UTF-8?Q?...?=).
 * @param {string} value
 * @returns {string}
 */
function decodeMimeWords(value) {
  return String(value || '').replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (full, _cs, enc, text) => {
    try {
      if (enc.toUpperCase() === 'B') {
        return Buffer.from(text, 'base64').toString('utf8');
      }
      const bytes = [];
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '_') {
          bytes.push(0x20);
        } else if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
          bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          bytes.push(text.charCodeAt(i));
        }
      }
      return Buffer.from(bytes).toString('utf8');
    } catch (_) {
      return full;
    }
  });
}

function escapeImapQuoted(value) {
  return String(value || '')
    .replace(/[\r\n]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function tryConsumeImapRecord(buf) {
  let cursor = 0;
  const segments = [];
  while (cursor < buf.length) {
    const crlf = buf.indexOf('\r\n', cursor);
    const lf = crlf === -1 ? buf.indexOf('\n', cursor) : -1;
    const eol = crlf !== -1 ? crlf : lf;
    const eolLen = crlf !== -1 ? 2 : 1;
    if (eol === -1) return null;
    const linePart = buf.slice(cursor, eol).toString('utf8');
    segments.push(linePart);
    cursor = eol + eolLen;
    const litMatch = linePart.match(/\{(\d+)\+?\}$/);
    if (litMatch) {
      const litLen = Number(litMatch[1]);
      if (buf.length < cursor + litLen) return null;
      segments.push({ literal: buf.slice(cursor, cursor + litLen).toString('utf8') });
      cursor += litLen;
      continue;
    }
    return { segments, rest: buf.slice(cursor) };
  }
  return null;
}

function parseHeaderBlock(rawHeaders) {
  const unfolded = String(rawHeaders || '').replace(/\r?\n[ \t]+/g, ' ');
  const out = { date: '', from: '', subject: '' };
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = decodeMimeWords(line.slice(idx + 1).trim());
    if (key === 'date' && !out.date) out.date = val;
    else if (key === 'from' && !out.from) out.from = val;
    else if (key === 'subject' && !out.subject) out.subject = val;
  }
  return out;
}

/**
 * Connect via zero-dependency Node TLS IMAP4rev1, EXAMINE INBOX read-only, and fetch latest email headers.
 * Returns honest dry_run_unconfigured if host/user/pass are absent.
 * @param {object} cfg
 * @returns {Promise<{ ok: boolean, mode: string, folder?: string, total?: number, messages: Array<object> }>}
 */
async function fetchImapInboxSummary(cfg = {}) {
  const host = cfg.host || cfg.imapHost || '';
  const port = Number(cfg.port || cfg.imapPort || 993);
  const user = cfg.user || '';
  const pass = cfg.pass || '';
  const limit = Math.max(1, Math.min(50, Number(cfg.limit || 12) || 12));
  const timeoutMs = Math.max(500, Number(cfg.timeoutMs || 8000) || 8000);

  if (!host || !user || !pass) {
    return {
      ok: true,
      mode: 'dry_run_unconfigured',
      messages: [],
    };
  }

  const isPlain = Boolean(cfg.plain);
  let socket = null;
  let deadlineTimer = null;

  const openSocket = () =>
    new Promise((resolve, reject) => {
      const onErr = (err) => reject(err);
      if (typeof cfg.connectFn === 'function') {
        const s = cfg.connectFn({ host, port }, () => {
          s.removeListener('error', onErr);
          resolve(s);
        });
        s.once('error', onErr);
        return;
      }
      if (isPlain) {
        const s = net.connect({ host, port }, () => {
          s.removeListener('error', onErr);
          resolve(s);
        });
        s.once('error', onErr);
        return;
      }
      const s = tls.connect(
        {
          host,
          port,
          servername: host,
          ...(cfg.tlsOptions || {}),
        },
        () => {
          s.removeListener('error', onErr);
          resolve(s);
        }
      );
      s.once('error', onErr);
    });

  const runSession = async () => {
    socket = await openSocket();
    socket.setTimeout(timeoutMs);

    let buffer = Buffer.alloc(0);
    const records = [];
    let waiter = null;

    const wake = () => {
      if (waiter) {
        const fn = waiter;
        waiter = null;
        fn();
      }
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      let rec;
      while ((rec = tryConsumeImapRecord(buffer)) !== null) {
        buffer = rec.rest;
        records.push(rec.segments);
      }
      wake();
    });

    let streamErr = null;
    socket.on('error', (err) => {
      streamErr = err;
      wake();
    });
    socket.on('timeout', () => {
      streamErr = new Error('IMAP socket timeout');
      try {
        socket.destroy();
      } catch (_) {}
      wake();
    });
    socket.on('close', () => {
      if (!streamErr) streamErr = new Error('IMAP connection closed');
      wake();
    });

    const nextRecord = () =>
      new Promise((resolve, reject) => {
        const check = () => {
          if (records.length > 0) {
            resolve(records.shift());
            return true;
          }
          if (streamErr) {
            reject(streamErr);
            return true;
          }
          return false;
        };
        if (check()) return;
        const poll = () => {
          if (!check()) waiter = poll;
        };
        waiter = poll;
      });

    // Wait for server greeting (* OK ...)
    const greeting = await nextRecord();
    const greetingText = greeting.filter((s) => typeof s === 'string').join(' ');
    if (/^\*\s*(NO|BAD|BYE)/i.test(greetingText)) {
      throw new Error(`IMAP server rejected connection: ${greetingText}`);
    }

    let tagSeq = 0;
    const sendCmd = async (cmdLine) => {
      const tag = `A${String(++tagSeq).padStart(3, '0')}`;
      socket.write(`${tag} ${cmdLine}\r\n`);
      const collected = [];
      while (true) {
        const rec = await nextRecord();
        const textJoin = rec.filter((s) => typeof s === 'string').join(' ').trim();
        if (textJoin.startsWith(`${tag} `)) {
          const statusMatch = textJoin.match(new RegExp(`^${tag}\\s+(OK|NO|BAD)\\b(.*)$`, 'i'));
          if (statusMatch) {
            const status = statusMatch[1].toUpperCase();
            if (status !== 'OK') {
              throw new Error(`IMAP command failed (${tag}): ${textJoin}`);
            }
            return { tag, status, line: textJoin, untagged: collected };
          }
        }
        collected.push(rec);
      }
    };

    await sendCmd(`LOGIN "${escapeImapQuoted(user)}" "${escapeImapQuoted(pass)}"`);
    const examine = await sendCmd('EXAMINE INBOX');
    let total = 0;
    for (const rec of examine.untagged) {
      const line = rec.filter((s) => typeof s === 'string').join(' ');
      const existsMatch = line.match(/^\*\s+(\d+)\s+EXISTS\b/i);
      if (existsMatch) total = Number(existsMatch[1]);
    }

    if (total <= 0) {
      await sendCmd('LOGOUT').catch(() => {});
      return { ok: true, mode: 'live_imap', folder: 'INBOX', total: 0, messages: [] };
    }

    const startSeq = Math.max(1, total - limit + 1);
    const fetchRes = await sendCmd(
      `FETCH ${startSeq}:${total} (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (DATE FROM SUBJECT)])`
    );

    const messages = [];
    for (const rec of fetchRes.untagged) {
      const fullText = rec.filter((s) => typeof s === 'string').join(' ');
      const seqMatch = fullText.match(/^\*\s+(\d+)\s+FETCH\b/i);
      if (!seqMatch) continue;
      const uidMatch = fullText.match(/\bUID\s+(\d+)\b/i);
      const flagsMatch = fullText.match(/\bFLAGS\s*\(([^)]*)\)/i);
      const internalDateMatch = fullText.match(/\bINTERNALDATE\s+"([^"]+)"/i);
      const literalSeg = rec.find((s) => s && typeof s === 'object' && typeof s.literal === 'string');
      const headers = parseHeaderBlock(literalSeg ? literalSeg.literal : '');
      messages.push({
        uid: uidMatch ? Number(uidMatch[1]) : Number(seqMatch[1]),
        date: headers.date || (internalDateMatch ? internalDateMatch[1] : ''),
        from: headers.from,
        subject: headers.subject || '(No Subject)',
        seen: flagsMatch ? /\\Seen/i.test(flagsMatch[1]) : false,
      });
    }

    messages.sort((a, b) => b.uid - a.uid);
    await sendCmd('LOGOUT').catch(() => {});

    return {
      ok: true,
      mode: 'live_imap',
      folder: 'INBOX',
      total,
      messages: messages.slice(0, limit),
    };
  };

  try {
    const deadlinePromise = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => {
        if (socket) {
          try {
            socket.destroy();
          } catch (_) {}
        }
        reject(new Error(`IMAP summary timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
    });
    return await Promise.race([runSession(), deadlinePromise]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (socket) {
      try {
        socket.end();
      } catch (_) {}
    }
  }
}

/**
 * Verify Stripe-Signature header (t=...,v1=...) using HMAC-SHA256 & crypto.timingSafeEqual.
 * @param {string} rawBody
 * @param {string} signatureHeader
 * @param {string} secret
 * @param {number} toleranceSec
 * @returns {{ valid: boolean, timestamp?: number, reason?: string }}
 */
function verifyStripeSignature(rawBody, signatureHeader, secret, toleranceSec = 300) {
  if (!secret || typeof secret !== 'string') {
    return { valid: false, reason: 'Missing webhook secret' };
  }
  const header = String(signatureHeader || '').trim();
  if (!header) {
    return { valid: false, reason: 'Missing Stripe-Signature header' };
  }
  let timestamp = '';
  const signatures = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') timestamp = v;
    else if (k === 'v1' && v) signatures.push(v);
  }
  const tNum = Number(timestamp);
  if (!timestamp || !Number.isFinite(tNum) || tNum <= 0 || signatures.length === 0) {
    return { valid: false, reason: 'Malformed Stripe-Signature header' };
  }
  if (toleranceSec > 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - tNum) > toleranceSec) {
      return { valid: false, reason: 'Stripe-Signature timestamp outside tolerance' };
    }
  }
  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${String(rawBody || '')}`, 'utf8')
    .digest('hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  for (const sig of signatures) {
    if (!/^[0-9a-f]+$/i.test(sig)) continue;
    const sigBuf = Buffer.from(sig, 'hex');
    if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(expectedBuf, sigBuf)) {
      return { valid: true, timestamp: tNum };
    }
  }
  return { valid: false, reason: 'Signature mismatch' };
}

/**
 * Dispatch an outbound channel message or workflow webhook honestly.
 * Never fabricates live carrier delivery when env vars are missing.
 */
async function dispatchChannelMessage(client, store, channel, payload, ctx) {
  const { env, fetchImpl } = ctx;
  const nowIso = new Date().toISOString();
  if (!Array.isArray(client.outboundQueue)) client.outboundQueue = [];
  if (!Array.isArray(client.executionLogs)) client.executionLogs = [];

  const targetWebhook = payload.webhookUrl || client.webhookUrl || store.settings.globalWebhookUrl || env.WEBHOOK_URL || '';
  let webhookResult = null;
  if (targetWebhook && payload.forwardWebhook !== false) {
    try {
      const whRes = await fetchImpl(targetWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: `outbound_${channel.toLowerCase().replace(/\s+/g, '_')}`,
          clientSlug: client.slug,
          business: client.business,
          channel,
          payload,
          timestamp: nowIso,
        }),
      });
      webhookResult = { attempted: true, ok: whRes.ok, status: whRes.status, url: targetWebhook };
    } catch (err) {
      webhookResult = { attempted: true, ok: false, error: err.message, url: targetWebhook };
    }
  }

  if (channel === 'SMS') {
    const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'];
    const missingEnv = required.filter((k) => !env[k]);
    if (missingEnv.length === 0) {
      const sid = env.TWILIO_ACCOUNT_SID;
      const auth = Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
      const form = new URLSearchParams({
        To: payload.to,
        From: client.twilioNumber || env.TWILIO_FROM_NUMBER,
        Body: payload.body,
      });
      const resp = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return {
          statusCode: 502,
          result: { ok: false, mode: 'twilio_error', status: resp.status, error: data.message || 'Twilio API error' },
        };
      }
      const { thread, msg } = appendInboxMessage(client, {
        threadId: payload.threadId,
        channel: 'SMS',
        contactName: payload.contactName || payload.to,
        contactPhone: payload.to,
        sender: client.business,
        body: payload.body,
        direction: 'outbound',
        deliveryMode: 'live_twilio',
        sid: data.sid,
      });
      return {
        statusCode: 200,
        result: { ok: true, mode: 'live_twilio', sid: data.sid, status: data.status, threadId: thread.id, messageId: msg.id, webhookResult },
      };
    }

    const { thread, msg } = appendInboxMessage(client, {
      threadId: payload.threadId,
      channel: 'SMS',
      contactName: payload.contactName || payload.to,
      contactPhone: payload.to,
      sender: client.business,
      body: payload.body,
      direction: 'outbound',
      deliveryMode: 'dry_run_queued',
    });
    const queueEntry = {
      id: `oq_${crypto.randomUUID().slice(0, 8)}`,
      channel: 'SMS',
      to: payload.to,
      body: payload.body,
      mode: 'dry_run_queued',
      missingEnv,
      webhookResult,
      createdAt: nowIso,
    };
    client.outboundQueue.push(queueEntry);
    return {
      statusCode: 200,
      result: { ok: true, mode: 'dry_run_queued', missingEnv, queueId: queueEntry.id, threadId: thread.id, messageId: msg.id, webhookResult },
    };
  }

  if (channel === 'Email') {
    const fromFallback = env.RESEND_FROM || env.SMTP_FROM || env.SMTP_USER || store.settings.agencyEmail || 'Rivvak Media <connect@rivvak.com>';
    const emailOut = await sendTransactionalEmail(
      {
        to: payload.to,
        subject: payload.subject || `Message from ${client.business}`,
        text: payload.body,
        html: payload.html,
        from: fromFallback,
        replyTo: payload.replyTo,
      },
      ctx
    );

    if (!emailOut.ok) {
      return {
        statusCode: emailOut.statusCode || 502,
        result: {
          ok: false,
          mode: emailOut.mode,
          ...(emailOut.status ? { status: emailOut.status } : {}),
          error: emailOut.error,
        },
      };
    }

    if (emailOut.mode === 'live_resend') {
      const { thread, msg } = appendInboxMessage(client, {
        threadId: payload.threadId,
        channel: 'Email',
        contactName: payload.contactName || payload.to,
        contactEmail: payload.to,
        sender: emailOut.fromUsed,
        subject: payload.subject,
        body: payload.body,
        direction: 'outbound',
        deliveryMode: 'live_resend',
        sid: emailOut.id,
      });
      return {
        statusCode: 200,
        result: { ok: true, mode: 'live_resend', id: emailOut.id, threadId: thread.id, messageId: msg.id, webhookResult },
      };
    }

    if (emailOut.mode === 'live_smtp') {
      const { thread, msg } = appendInboxMessage(client, {
        threadId: payload.threadId,
        channel: 'Email',
        contactName: payload.contactName || payload.to,
        contactEmail: payload.to,
        sender: emailOut.fromUsed,
        subject: payload.subject,
        body: payload.body,
        direction: 'outbound',
        deliveryMode: 'live_smtp',
        sid: emailOut.messageId,
      });
      return {
        statusCode: 200,
        result: {
          ok: true,
          mode: 'live_smtp',
          messageId: emailOut.messageId,
          inboxMessageId: msg.id,
          threadId: thread.id,
          response: emailOut.response,
          webhookResult,
        },
      };
    }

    const missingEnv = emailOut.missingEnv || ['RESEND_API_KEY or SMTP_*'];
    const { thread, msg } = appendInboxMessage(client, {
      threadId: payload.threadId,
      channel: 'Email',
      contactName: payload.contactName || payload.to,
      contactEmail: payload.to,
      sender: client.email || store.settings.agencyEmail,
      subject: payload.subject,
      body: payload.body,
      direction: 'outbound',
      deliveryMode: 'dry_run_queued',
    });
    const queueEntry = {
      id: `oq_${crypto.randomUUID().slice(0, 8)}`,
      channel: 'Email',
      to: payload.to,
      subject: payload.subject || '',
      body: payload.body,
      mode: 'dry_run_queued',
      missingEnv,
      webhookResult,
      createdAt: nowIso,
    };
    client.outboundQueue.push(queueEntry);
    return {
      statusCode: 200,
      result: { ok: true, mode: 'dry_run_queued', missingEnv, queueId: queueEntry.id, threadId: thread.id, messageId: msg.id, webhookResult },
    };
  }

  if (channel === 'Instagram DM') {
    const required = ['META_ACCESS_TOKEN', 'META_IG_USER_ID'];
    const missingEnv = required.filter((k) => !env[k]);
    const igUserId = client.igUserId || env.META_IG_USER_ID;
    if (missingEnv.length === 0) {
      const resp = await fetchImpl(`https://graph.facebook.com/v21.0/${encodeURIComponent(igUserId)}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipient: { id: payload.recipientId },
          message: { text: payload.body },
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return {
          statusCode: 502,
          result: { ok: false, mode: 'meta_error', status: resp.status, error: data.error?.message || 'Meta Graph API error' },
        };
      }
      const { thread, msg } = appendInboxMessage(client, {
        threadId: payload.threadId,
        channel: 'Instagram DM',
        contactName: payload.contactName || payload.recipientId,
        recipientId: payload.recipientId,
        sender: client.business,
        body: payload.body,
        direction: 'outbound',
        deliveryMode: 'live_meta',
        sid: data.message_id,
      });
      return {
        statusCode: 200,
        result: { ok: true, mode: 'live_meta', messageId: data.message_id, threadId: thread.id, inboxMessageId: msg.id, webhookResult },
      };
    }

    const { thread, msg } = appendInboxMessage(client, {
      threadId: payload.threadId,
      channel: 'Instagram DM',
      contactName: payload.contactName || payload.recipientId,
      recipientId: payload.recipientId,
      sender: client.business,
      body: payload.body,
      direction: 'outbound',
      deliveryMode: 'dry_run_queued',
    });
    const queueEntry = {
      id: `oq_${crypto.randomUUID().slice(0, 8)}`,
      channel: 'Instagram DM',
      to: payload.recipientId,
      body: payload.body,
      mode: 'dry_run_queued',
      missingEnv,
      webhookResult,
      createdAt: nowIso,
    };
    client.outboundQueue.push(queueEntry);
    return {
      statusCode: 200,
      result: { ok: true, mode: 'dry_run_queued', missingEnv, queueId: queueEntry.id, threadId: thread.id, messageId: msg.id, webhookResult },
    };
  }

  return {
    statusCode: 400,
    result: { ok: false, error: `Unsupported channel: ${channel}` },
  };
}

/**
 * Trigger a specific workflow on a client cleanly (live or dry_run_queued + webhook forward).
 */
async function executeWorkflow(client, store, { workflow, contact, payload, webhookUrl }, ctx) {
  const nowIso = new Date().toISOString();
  if (!Array.isArray(client.executionLogs)) client.executionLogs = [];

  const firstName =
    contact?.firstName ||
    (contact?.name ? String(contact.name).split(/\s+/)[0] : '') ||
    (payload?.leadName ? String(payload.leadName).split(/\s+/)[0] : '') ||
    'there';

  const renderedMessage = resolveTemplate(workflow?.template || payload?.message || '', {
    firstName,
    name: contact?.name || payload?.leadName || firstName,
    business: client.business,
    owner: client.owner,
    sessionType: payload?.sessionType || 'training session',
    scheduledAt: payload?.scheduledAt || '',
  });

  const channel = workflow?.channel || payload?.channel || 'SMS';
  const to =
    channel === 'Email'
      ? contact?.email || payload?.email || ''
      : channel === 'Instagram DM'
      ? contact?.recipientId || payload?.recipientId || ''
      : contact?.phone || payload?.phone || payload?.to || '';

  const targetWebhook = webhookUrl || client.webhookUrl || store.settings.globalWebhookUrl || ctx.env.WEBHOOK_URL || '';
  let dispatchOutcome;

  if (to) {
    const dispatched = await dispatchChannelMessage(
      client,
      store,
      channel,
      {
        to,
        recipientId: to,
        contactName: contact?.name || payload?.leadName || to,
        subject: payload?.subject || workflow?.name || client.business,
        body: renderedMessage,
        webhookUrl: targetWebhook,
      },
      ctx
    );
    dispatchOutcome = dispatched.result;
  } else {
    const hasEmailProvider = Boolean(
      ctx.env.RESEND_API_KEY || (ctx.env.SMTP_HOST && ctx.env.SMTP_USER && ctx.env.SMTP_PASS)
    );
    const missingEnv =
      channel === 'Email'
        ? hasEmailProvider
          ? []
          : ['RESEND_API_KEY or SMTP_*']
        : ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'].filter((k) => !ctx.env[k]);
    let webhookResult = null;
    if (targetWebhook) {
      try {
        const whRes = await ctx.fetchImpl(targetWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'workflow_trigger',
            clientSlug: client.slug,
            workflowId: workflow?.id || 'custom',
            workflowName: workflow?.name || 'Custom Workflow',
            message: renderedMessage,
            payload,
            timestamp: nowIso,
          }),
        });
        webhookResult = { attempted: true, ok: whRes.ok, status: whRes.status, url: targetWebhook };
      } catch (err) {
        webhookResult = { attempted: true, ok: false, error: err.message, url: targetWebhook };
      }
    }
    dispatchOutcome = {
      ok: true,
      mode: missingEnv.length === 0 ? 'queued_no_recipient' : 'dry_run_queued',
      missingEnv,
      webhookResult,
    };
  }

  if (workflow) {
    workflow.runCount = (Number(workflow.runCount) || 0) + 1;
    workflow.lastRunAt = nowIso;
  }

  const logEntry = {
    id: `log_${crypto.randomUUID().slice(0, 8)}`,
    workflowId: workflow?.id || 'custom',
    workflowName: workflow?.name || 'Custom Workflow',
    channel,
    to: to || '(workflow log only)',
    message: renderedMessage,
    mode: dispatchOutcome.mode,
    missingEnv: dispatchOutcome.missingEnv || [],
    webhookResult: dispatchOutcome.webhookResult || null,
    ranAt: nowIso,
  };
  client.executionLogs.push(logEntry);
  return logEntry;
}

function extractBirthdayMmDd(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[2]}-${iso[3]}`;
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?$/);
  if (slash) return `${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`;
  const mmdd = s.match(/^(\d{2})-(\d{2})$/);
  if (mmdd) return `${mmdd[1]}-${mmdd[2]}`;
  return '';
}

function toDayStartMs(dateInput) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return NaN;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Execute one idempotent 24/7 scheduler tick across one or all clients.
 * Checks: 24h/2h booking reminders, MM-DD birthdays, 7/14/30d retention check-ins, due social posts.
 * @param {string|object|null} clientSlugOrOpts
 * @param {object} [maybeOpts]
 * @returns {Promise<{ ok: boolean, ranAt: string, processedCount: number, results: Array<object> }>}
 */
async function runSchedulerTick(clientSlugOrOpts = null, maybeOpts = {}) {
  let clientSlug = null;
  let options = maybeOpts;
  if (clientSlugOrOpts && typeof clientSlugOrOpts === 'object') {
    options = clientSlugOrOpts;
  } else if (typeof clientSlugOrOpts === 'string') {
    clientSlug = clientSlugOrOpts;
  }

  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const storePath = resolveStorePath(options);
  const store = options.store || loadStore(storePath, env);
  const now = options.now ? new Date(options.now) : new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  let todayYYYYMMDD;
  let todayMMDD;
  if (typeof options.now === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(options.now)) {
    todayYYYYMMDD = options.now;
    todayMMDD = options.now.slice(5, 10);
  } else {
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    todayYYYYMMDD = `${yyyy}-${mm}-${dd}`;
    todayMMDD = `${mm}-${dd}`;
  }

  const targets = clientSlug
    ? store.clients[clientSlug]
      ? [store.clients[clientSlug]]
      : []
    : Object.values(store.clients || {});

  const results = [];
  let dirty = false;

  for (const client of targets) {
    if (!client.processedScheduleKeys || typeof client.processedScheduleKeys !== 'object') {
      client.processedScheduleKeys = {};
    }
    const workflows = Array.isArray(client.workflows) ? client.workflows : [];
    const findEnabledWorkflow = (triggerName, namePattern) =>
      workflows.find(
        (w) =>
          w &&
          w.active !== false &&
          (w.trigger === triggerName || (namePattern && namePattern.test(String(w.name || ''))))
      );

    // 1. 24h & 2h Booking Reminders
    const bookingWf = findEnabledWorkflow('booking_reminder', /reminder/i);
    if (bookingWf && Array.isArray(client.bookings)) {
      for (const bk of client.bookings) {
        if (!['Confirmed', 'Tour Scheduled', 'Pending'].includes(bk.status)) continue;
        const bkMs = Date.parse(bk.scheduledAt || bk.dateTime || '');
        if (!Number.isFinite(bkMs)) continue;
        const hoursUntil = (bkMs - nowMs) / 3600000;
        let windowTag = null;
        if (hoursUntil > 0 && hoursUntil <= 2.5) windowTag = '2h';
        else if (hoursUntil > 2.5 && hoursUntil <= 24.5) windowTag = '24h';
        if (!windowTag) continue;

        const key = `booking:${bk.id}:${windowTag}`;
        if (client.processedScheduleKeys[key]) continue;

        const log = await executeWorkflow(
          client,
          store,
          {
            workflow: bookingWf,
            contact: { name: bk.leadName, phone: bk.phone, email: bk.email },
            payload: {
              leadName: bk.leadName,
              phone: bk.phone,
              email: bk.email,
              sessionType: bk.sessionType,
              scheduledAt: bk.scheduledAt,
              window: windowTag,
            },
          },
          { env, fetchImpl }
        );
        client.processedScheduleKeys[key] = nowIso;
        dirty = true;
        results.push({ clientSlug: client.slug, category: `booking_reminder_${windowTag}`, key, log });
      }
    }

    // 2. Member Birthdays (MM-DD)
    const birthdayWf = findEnabledWorkflow('member_birthday', /birthday/i);
    if (birthdayWf && Array.isArray(client.contacts)) {
      for (const c of client.contacts) {
        const bday = extractBirthdayMmDd(c.birthday || c.customFields?.birthday);
        if (!bday || bday !== todayMMDD) continue;
        const key = `birthday:${c.id}:${todayYYYYMMDD}`;
        if (client.processedScheduleKeys[key]) continue;

        const log = await executeWorkflow(
          client,
          store,
          { workflow: birthdayWf, contact: c, payload: { birthday: bday } },
          { env, fetchImpl }
        );
        client.processedScheduleKeys[key] = nowIso;
        dirty = true;
        results.push({ clientSlug: client.slug, category: 'member_birthday', key, log });
      }
    }

    // 3. 7 / 14 / 30-Day Retention Check-Ins
    const retentionWf = findEnabledWorkflow('retention_checkin', /retention/i);
    if (retentionWf && Array.isArray(client.contacts)) {
      const todayDayMs = toDayStartMs(todayYYYYMMDD);
      for (const c of client.contacts) {
        const refDate = c.lastCheckInAt || c.joinedAt || '';
        const refDayMs = toDayStartMs(refDate);
        if (!Number.isFinite(refDayMs) || !Number.isFinite(todayDayMs)) continue;
        const daysSince = Math.floor((todayDayMs - refDayMs) / 86400000);
        if (![7, 14, 30].includes(daysSince)) continue;

        const key = `retention:${c.id}:${daysSince}d:${String(refDate).slice(0, 10)}`;
        if (client.processedScheduleKeys[key]) continue;

        const log = await executeWorkflow(
          client,
          store,
          { workflow: retentionWf, contact: c, payload: { milestoneDays: daysSince } },
          { env, fetchImpl }
        );
        client.processedScheduleKeys[key] = nowIso;
        dirty = true;
        results.push({ clientSlug: client.slug, category: `retention_${daysSince}d`, key, log });
      }
    }

    // 4. Due Scheduled Social Posts (scheduledAt <= now)
    const posts = client.marketing?.scheduledPosts;
    if (Array.isArray(posts)) {
      for (const post of posts) {
        if (!['Scheduled', 'Queued'].includes(post.status)) continue;
        const postMs = Date.parse(post.scheduledAt || '');
        if (!Number.isFinite(postMs) || postMs > nowMs) continue;
        const key = `post:${post.id}`;
        if (client.processedScheduleKeys[key]) continue;

        const targetWebhook = client.webhookUrl || store.settings.globalWebhookUrl || env.WEBHOOK_URL || '';
        let webhookResult = null;
        if (targetWebhook) {
          try {
            const whRes = await fetchImpl(targetWebhook, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                event: 'scheduled_social_post_due',
                clientSlug: client.slug,
                post,
                timestamp: nowIso,
              }),
            });
            webhookResult = { attempted: true, ok: whRes.ok, status: whRes.status, url: targetWebhook };
          } catch (err) {
            webhookResult = { attempted: true, ok: false, error: err.message, url: targetWebhook };
          }
        }

        const missingEnv = ['META_ACCESS_TOKEN', 'META_IG_USER_ID'].filter((k) => !env[k]);
        post.status = webhookResult?.ok ? 'Dispatched (Webhook)' : 'Queued (Dry-Run)';
        post.dispatchedAt = nowIso;

        if (!Array.isArray(client.executionLogs)) client.executionLogs = [];
        const log = {
          id: `log_${crypto.randomUUID().slice(0, 8)}`,
          workflowId: 'social_scheduler',
          workflowName: `Social Post Due: ${post.platform} — ${post.title}`,
          channel: post.platform,
          to: post.platform,
          message: post.caption || post.title,
          mode: webhookResult?.ok ? 'webhook_dispatched' : 'dry_run_queued',
          missingEnv,
          webhookResult,
          ranAt: nowIso,
        };
        client.executionLogs.push(log);
        client.processedScheduleKeys[key] = nowIso;
        dirty = true;
        results.push({ clientSlug: client.slug, category: 'scheduled_post', key, log });
      }
    }

    // 5. 3-Day-Ahead Retainer / Renewal Reminders
    const renewalDateRaw =
      client.retainerDueAt ||
      client.renewalDate ||
      client.billing?.nextBillingAt ||
      client.billing?.renewalAt ||
      client.billing?.currentPeriodEnd ||
      '';
    if (renewalDateRaw && client.billing?.status !== 'canceled') {
      const dueDayMs = toDayStartMs(renewalDateRaw);
      const todayDayMs = toDayStartMs(todayYYYYMMDD);
      if (Number.isFinite(dueDayMs) && Number.isFinite(todayDayMs)) {
        const daysUntil = Math.round((dueDayMs - todayDayMs) / 86400000);
        if (daysUntil >= 0 && daysUntil <= 3) {
          const dueKeyDate = String(renewalDateRaw).slice(0, 10);
          const key = `retainer_renewal:${client.slug}:${dueKeyDate}`;
          if (!client.processedScheduleKeys[key]) {
            const reminderChannel = client.email ? 'Email' : client.phone ? 'SMS' : 'Email';
            const retainerAmount = client.retainerAmount || client.billing?.retainerAmount || '';
            const reminderText = `Heads up ${client.owner || client.business}: your Rivvak Media monthly growth retainer${
              retainerAmount ? ` (${retainerAmount})` : ''
            } renews in ${daysUntil} day${daysUntil === 1 ? '' : 's'} (${dueKeyDate}). Reply anytime with questions or campaign updates.`;
            const log = await executeWorkflow(
              client,
              store,
              {
                workflow: {
                  id: 'wf_retainer_renewal_3d',
                  name: '3-Day-Ahead Retainer / Renewal Reminder',
                  channel: reminderChannel,
                  template: reminderText,
                },
                contact: {
                  name: client.owner || client.business,
                  email: client.email || '',
                  phone: client.phone || '',
                },
                payload: {
                  channel: reminderChannel,
                  subject: `Rivvak Media Retainer Renewal Reminder (${dueKeyDate})`,
                  message: reminderText,
                  dueDate: dueKeyDate,
                  daysUntil,
                },
              },
              { env, fetchImpl, smtpSendImpl: options.smtpSendImpl }
            );
            client.processedScheduleKeys[key] = nowIso;
            dirty = true;
            results.push({ clientSlug: client.slug, category: 'retainer_renewal_3d', key, log });
          }
        }
      }
    }
  }

  if (dirty && !options.store) {
    saveStore(storePath, store);
  }

  return {
    ok: true,
    ranAt: nowIso,
    processedCount: results.length,
    results,
  };
}

/**
 * Resolve which client owns an inbound webhook event.
 * @param {object} store
 * @param {object} hints
 * @returns {object|null}
 */
function matchInboundClient(store, { slug, toPhone, igUserId, locationName }) {
  const clients = Object.values(store.clients || {});
  if (slug && store.clients[slug]) return store.clients[slug];

  const targetPhone = normPhone(toPhone);
  if (targetPhone) {
    const byNum = clients.find(
      (c) => normPhone(c.twilioNumber) === targetPhone || normPhone(c.phone) === targetPhone
    );
    if (byNum) return byNum;
  }

  if (igUserId) {
    const byIg = clients.find((c) => c.igUserId && String(c.igUserId) === String(igUserId));
    if (byIg) return byIg;
  }

  if (locationName) {
    const low = normText(locationName);
    const byLoc = clients.find((c) => low.includes(normText(c.business)) || low.includes(normText(c.owner)));
    if (byLoc) return byLoc;
  }

  return store.clients['clean-results'] || clients[0] || null;
}

/**
 * Create the zero-dependency HTTP server without immediately binding a port.
 * @param {object} options
 * @returns {http.Server}
 */
function createServer(options = {}) {
  if (options.loadEnv !== false && !options.env) {
    loadDotEnv(options.envPath);
  }
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const smtpSendImpl = options.smtpSendImpl || sendSmtpEmail;
  const storePath = resolveStorePath(options);
  const adminPasscode = options.adminPasscode || env.ADMIN_PASSCODE || 'RIVVAK-2026';
  const metaVerifyToken = options.metaVerifyToken || env.META_VERIFY_TOKEN || 'rivvak-meta-verify-2026';
  const serverStartedAtMs = Date.now();
  const leadRateWindowMs = Number(options.leadRateWindowMs || LEAD_RATE_WINDOW_MS);
  const leadRateMax = Number(options.leadRateMaxRequests || LEAD_RATE_MAX_REQUESTS);
  const leadRateLimiter = new Map();

  const getClientIp = (req) => {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      return xff.split(',')[0].trim();
    }
    return req.socket?.remoteAddress || 'unknown';
  };

  const checkLeadRateLimit = (ip) => {
    const nowMs = Date.now();
    const prev = leadRateLimiter.get(ip) || [];
    const recent = prev.filter((ts) => nowMs - ts < leadRateWindowMs);
    if (recent.length >= leadRateMax) {
      leadRateLimiter.set(ip, recent);
      const retryAfterSec = Math.max(1, Math.ceil((recent[0] + leadRateWindowMs - nowMs) / 1000));
      return { allowed: false, retryAfterSec };
    }
    recent.push(nowMs);
    leadRateLimiter.set(ip, recent);
    if (leadRateLimiter.size > 2000) {
      for (const [k, list] of leadRateLimiter.entries()) {
        if (!list.some((ts) => nowMs - ts < leadRateWindowMs)) {
          leadRateLimiter.delete(k);
        }
      }
    }
    return { allowed: true };
  };

  // Ensure store file exists at server creation
  loadStore(storePath, env);

  const server = http.createServer(async (req, res) => {
    try {
      applySecurityHeaders(res);
      const corsRejected = applyCors(req, res, env);
      if (req.method === 'OPTIONS') {
        if (corsRejected) {
          sendJson(res, 403, { error: 'Origin not allowed' });
        } else {
          res.writeHead(204);
          res.end();
        }
        return;
      }

      const parsedUrl = new url.URL(req.url || '/', 'http://127.0.0.1');
      const pathname = (parsedUrl.pathname || '/').replace(/\/+$/, '') || '/';
      const queryParams = Object.fromEntries(parsedUrl.searchParams.entries());
      const method = (req.method || 'GET').toUpperCase();
      const store = loadStore(storePath, env);

      // --- Public Routes ---
      if (method === 'GET' && pathname === '/') {
        const uptimeSeconds = Math.max(0, Math.floor((Date.now() - serverStartedAtMs) / 1000));
        const clientsCount = Object.keys(store.clients || {}).length;
        const publicLeadsCount = Array.isArray(store.publicLeads) ? store.publicLeads.length : 0;
        const smtpConfigured = isSmtpConfigured(env);
        const acceptHeader = String(req.headers.accept || '').toLowerCase();
        if (acceptHeader.includes('text/html') && queryParams.format !== 'json') {
          sendHtml(
            res,
            200,
            renderStatusDashboardHtml({
              uptimeSeconds,
              clientsCount,
              publicLeadsCount,
              smtpConfigured,
            })
          );
          return;
        }
        sendJson(res, 200, {
          ok: true,
          service: SERVICE_NAME,
          brand: BRAND_NAME,
          version: SERVICE_VERSION,
          status: 'online',
          uptimeSeconds,
          clients: clientsCount,
          publicLeadsCount,
          smtpConfigured,
          endpoints: {
            health: '/api/health',
            publicLead: '/api/public/lead',
            state: '/api/state',
            adminClients: '/api/admin/clients',
            adminLeads: '/api/admin/leads',
            adminEmailInbox: '/api/admin/email-inbox',
            adminBackup: '/api/admin/backup',
            adminRestore: '/api/admin/restore',
            stripeWebhook: '/webhooks/stripe',
            overlay: '/overlay.js',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (method === 'GET' && (pathname === '/overlay.js' || pathname === '/api/client/carleen-ligozio/overlay.js')) {
        const scriptCandidate = path.join(__dirname, 'carleen-overlay.js');
        if (fs.existsSync(scriptCandidate)) {
          const content = fs.readFileSync(scriptCandidate, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=300'
          });
          return res.end(content);
        }
      }

      if (method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          service: SERVICE_NAME,
          brand: BRAND_NAME,
          version: SERVICE_VERSION,
          clients: Object.keys(store.clients || {}).length,
          publicLeads: Array.isArray(store.publicLeads) ? store.publicLeads.length : 0,
          smtpConfigured: isSmtpConfigured(env),
          uptimeSeconds: Math.max(0, Math.floor((Date.now() - serverStartedAtMs) / 1000)),
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Public Website & Chat Lead Intake (POST /api/public/lead)
      if (method === 'POST' && pathname === '/api/public/lead') {
        const rateStatus = checkLeadRateLimit(getClientIp(req));
        if (!rateStatus.allowed) {
          sendJson(
            res,
            429,
            {
              ok: false,
              error: 'Too Many Requests',
              message: 'Submission rate limit reached. Please wait a few minutes and try again.',
            },
            { 'Retry-After': String(rateStatus.retryAfterSec) }
          );
          return;
        }

        const { data } = await readRequestBody(req);
        const hpValue = String(data._hp ?? data.honeypot ?? '').trim();
        if (hpValue.length > 0) {
          sendJson(res, 200, { ok: true, ignored: true });
          return;
        }

        const cap = (v, maxLen) =>
          String(v ?? '')
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
            .trim()
            .slice(0, maxLen);

        const cleanName = cap(data.name ?? data['contact[name]'], 120);
        const cleanBusiness = cap(data.business ?? data.company ?? data['contact[business]'], 160);
        const cleanEmail = cap(data.email ?? data['contact[email]'], 180);
        const cleanPhone = cap(data.phone ?? data['contact[phone]'], 40);
        const cleanWebsite = cap(data.website ?? data['contact[website]'], 300);
        const cleanLocation = cap(data.location ?? data['contact[location]'], 160);
        const cleanIndustry = cap(data.industry ?? data['contact[industry]'], 100);
        const cleanScope = cap(data.scope ?? data['contact[scope]'], 600);
        const cleanEstimatedSetup = cap(data.estimatedSetup ?? data['contact[estimatedSetup]'], 40);
        const cleanEstimatedMonthly = cap(data.estimatedMonthly ?? data['contact[estimatedMonthly]'], 40);
        const cleanMessage = cap(data.message ?? data.body ?? data['contact[body]'], 3000);
        const cleanSource = cap(data.source || 'website-form', 120) || 'website-form';
        const cleanPageUrl = cap(data.pageUrl ?? data.url, 500);
        const cleanTicketId =
          cap(data.ticketId, 40) || `RV-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
        const hasValidEmail = Boolean(cleanEmail && emailPattern.test(cleanEmail));
        if (cleanEmail && !hasValidEmail) {
          sendJson(res, 400, { ok: false, error: 'Please provide a valid email address.' });
          return;
        }
        if (!cleanEmail && !cleanPhone && !cleanMessage && !(cleanName && cleanBusiness)) {
          sendJson(res, 400, {
            ok: false,
            error: 'Please provide your email, phone number, or project message.',
          });
          return;
        }

        const nowIso = new Date().toISOString();
        const leadId = `lead_${crypto.randomUUID().slice(0, 12)}`;
        const leadRecord = {
          id: leadId,
          ticketId: cleanTicketId,
          name: cleanName,
          business: cleanBusiness,
          email: cleanEmail,
          phone: cleanPhone,
          ...(cleanWebsite ? { website: cleanWebsite } : {}),
          ...(cleanLocation ? { location: cleanLocation } : {}),
          industry: cleanIndustry,
          scope: cleanScope,
          estimatedSetup: cleanEstimatedSetup,
          estimatedMonthly: cleanEstimatedMonthly,
          message: cleanMessage,
          source: cleanSource,
          pageUrl: cleanPageUrl,
          status: 'new',
          notes: '',
          emailDispatched: false,
          emailMode: 'pending',
          autoReplySent: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        };

        if (!Array.isArray(store.publicLeads)) store.publicLeads = [];
        store.publicLeads.unshift(leadRecord);
        if (store.publicLeads.length > MAX_PUBLIC_LEADS) {
          store.publicLeads.length = MAX_PUBLIC_LEADS;
        }

        const agencyEmail = store.settings?.agencyEmail || 'connect@rivvak.com';
        const alertLines = [
          `New Rivvak Media Public Lead — Ref #${cleanTicketId}`,
          `Lead ID: ${leadId}`,
          `Name: ${cleanName || '(not provided)'}`,
          `Business: ${cleanBusiness || '(not provided)'}`,
          `Email: ${cleanEmail || '(not provided)'}`,
          `Phone: ${cleanPhone || '(not provided)'}`,
          ...(cleanWebsite ? [`Website: ${cleanWebsite}`] : []),
          ...(cleanLocation ? [`Location: ${cleanLocation}`] : []),
          `Industry: ${cleanIndustry || '(not specified)'}`,
          `Scope: ${cleanScope || '(not specified)'}`,
          `Estimated Setup: ${cleanEstimatedSetup || '(not specified)'}`,
          `Estimated Monthly: ${cleanEstimatedMonthly || '(not specified)'}`,
          `Source: ${cleanSource}`,
          `Page URL: ${cleanPageUrl || '(not specified)'}`,
          `Submitted At: ${nowIso}`,
          '',
          'Message / Project Notes:',
          cleanMessage || '(no additional message)',
        ];

        let emailDispatched = false;
        let mode = 'dry_run_queued';
        try {
          const alertRes = await sendTransactionalEmail(
            {
              to: agencyEmail,
              subject: `[Rivvak Lead #${cleanTicketId}] ${cleanBusiness || cleanName || cleanEmail || 'New Inquiry'}`,
              text: alertLines.join('\n'),
              replyTo: hasValidEmail ? cleanEmail : undefined,
            },
            { env, fetchImpl, smtpSendImpl }
          );
          if (alertRes.ok && (alertRes.mode === 'live_resend' || alertRes.mode === 'live_smtp')) {
            emailDispatched = true;
            mode = alertRes.mode;
          } else if (!alertRes.ok) {
            emailDispatched = false;
            mode = alertRes.mode || 'email_error';
          } else {
            emailDispatched = false;
            mode = 'dry_run_queued';
          }
        } catch (_) {
          emailDispatched = false;
          mode = 'email_error';
        }

        leadRecord.emailDispatched = emailDispatched;
        leadRecord.emailMode = mode;

        if (hasValidEmail && env.AUTO_REPLY_LEADS !== 'false' && isLiveEmailConfigured(env) && emailDispatched) {
          try {
            const greetingName = cleanName || cleanBusiness || 'there';
            const receiptLines = [
              `Hi ${greetingName},`,
              '',
              `Thanks for reaching out to Rivvak Media! We received your project request (Ref #${cleanTicketId}).`,
              ...(cleanScope ? [`Selected Scope: ${cleanScope}`] : []),
              ...(cleanEstimatedSetup
                ? [
                    `Estimated Setup: ${cleanEstimatedSetup}${
                      cleanEstimatedMonthly ? ` | Optional Retainer: ${cleanEstimatedMonthly}` : ''
                    }`,
                  ]
                : []),
              '',
              'What happens next:',
              '- Mason Pilger & Aiden Strompf are reviewing your notes and existing site.',
              '- You can expect a response shortly with your 72-hour free staging preview timeline.',
              '',
              'Questions in the meantime? Reply directly to connect@rivvak.com or visit https://rivvak.com/.',
              '',
              '— Rivvak Media',
              'West Palm Beach & South Florida | https://rivvak.com/',
            ];
            const replyRes = await sendTransactionalEmail(
              {
                to: cleanEmail,
                from: 'Rivvak Media <connect@rivvak.com>',
                replyTo: 'connect@rivvak.com',
                subject: `We received your Rivvak Media inquiry (Ref #${cleanTicketId})`,
                text: receiptLines.join('\n'),
              },
              { env, fetchImpl, smtpSendImpl }
            );
            leadRecord.autoReplySent = Boolean(
              replyRes.ok && (replyRes.mode === 'live_resend' || replyRes.mode === 'live_smtp')
            );
          } catch (_) {
            leadRecord.autoReplySent = false;
          }
        }

        saveStore(storePath, store);
        sendJson(res, 201, {
          ok: true,
          leadId,
          ticketId: cleanTicketId,
          emailDispatched,
          mode,
        });
        return;
      }

      // Stripe Webhook Receiver (POST /webhooks/stripe)
      if (method === 'POST' && pathname === '/webhooks/stripe') {
        const { raw, data } = await readRequestBody(req);
        const stripeSecret = env.STRIPE_WEBHOOK_SECRET || '';
        if (stripeSecret) {
          const toleranceSec =
            env.STRIPE_WEBHOOK_TOLERANCE_SEC !== undefined ? Number(env.STRIPE_WEBHOOK_TOLERANCE_SEC) : 300;
          const sigResult = verifyStripeSignature(
            raw,
            req.headers['stripe-signature'],
            stripeSecret,
            Number.isFinite(toleranceSec) ? toleranceSec : 300
          );
          if (!sigResult.valid) {
            sendJson(res, 400, { ok: false, error: 'Invalid Stripe-Signature', reason: sigResult.reason });
            return;
          }
        }

        const eventType = String(data.type || '');
        const obj = (data.data && data.data.object) || data.object || {};
        const nowIso = new Date().toISOString();
        const eventId = String(data.id || `evt_${crypto.randomUUID().slice(0, 12)}`);
        const candidateSlug = String(obj.metadata?.clientSlug || obj.metadata?.slug || obj.client_reference_id || '').trim();
        const customerEmail = String(obj.customer_email || obj.customer_details?.email || '').trim().toLowerCase();
        const customerId = String(obj.customer || '').trim();

        let matchedClient = null;
        if (candidateSlug && store.clients[candidateSlug]) {
          matchedClient = store.clients[candidateSlug];
        } else if (customerEmail) {
          matchedClient =
            Object.values(store.clients || {}).find((c) => normEmail(c.email) === customerEmail) || null;
        } else if (customerId) {
          matchedClient =
            Object.values(store.clients || {}).find((c) => c.stripeCustomerId && c.stripeCustomerId === customerId) ||
            null;
        }

        const amountCents = Number(obj.amount_paid ?? obj.amount_total ?? obj.amount_due ?? 0) || 0;
        const currency = String(obj.currency || 'usd').toLowerCase();
        const stripeRecord = {
          id: eventId,
          type: eventType,
          handled: HANDLED_STRIPE_EVENTS.has(eventType),
          clientSlug: matchedClient ? matchedClient.slug : null,
          customerEmail,
          customerId,
          subscriptionId: String(obj.subscription || (eventType === 'customer.subscription.deleted' ? obj.id || '' : '')),
          amountCents,
          currency,
          status: String(obj.payment_status || obj.status || ''),
          verified: Boolean(stripeSecret),
          receivedAt: nowIso,
        };

        if (!Array.isArray(store.stripeEvents)) store.stripeEvents = [];
        store.stripeEvents.unshift(stripeRecord);
        if (store.stripeEvents.length > MAX_STRIPE_EVENTS) {
          store.stripeEvents.length = MAX_STRIPE_EVENTS;
        }

        if (matchedClient && HANDLED_STRIPE_EVENTS.has(eventType)) {
          if (!matchedClient.billing || typeof matchedClient.billing !== 'object') {
            matchedClient.billing = {};
          }
          if (!Array.isArray(matchedClient.paymentRecords)) {
            matchedClient.paymentRecords = [];
          }
          if (!Array.isArray(matchedClient.executionLogs)) {
            matchedClient.executionLogs = [];
          }

          if (customerId) matchedClient.stripeCustomerId = customerId;
          if (stripeRecord.subscriptionId) matchedClient.billing.subscriptionId = stripeRecord.subscriptionId;

          if (eventType === 'checkout.session.completed') {
            matchedClient.billing.status = 'active';
            matchedClient.billing.lastPaymentAt = nowIso;
            matchedClient.billing.lastEventType = eventType;
          } else if (eventType === 'invoice.paid') {
            matchedClient.billing.status = 'active';
            matchedClient.billing.lastPaidAt = nowIso;
            matchedClient.billing.lastAmountCents = amountCents;
            matchedClient.billing.lastEventType = eventType;
          } else if (eventType === 'invoice.payment_failed') {
            matchedClient.billing.status = 'past_due';
            matchedClient.billing.lastFailedAt = nowIso;
            matchedClient.billing.lastEventType = eventType;
          } else if (eventType === 'customer.subscription.deleted') {
            matchedClient.billing.status = 'canceled';
            matchedClient.billing.canceledAt = nowIso;
            matchedClient.billing.lastEventType = eventType;
          }

          matchedClient.paymentRecords.unshift({
            eventId,
            type: eventType,
            amountCents,
            currency,
            billingStatus: matchedClient.billing.status,
            recordedAt: nowIso,
          });
          if (matchedClient.paymentRecords.length > 100) {
            matchedClient.paymentRecords.length = 100;
          }

          matchedClient.executionLogs.push({
            id: `log_${crypto.randomUUID().slice(0, 8)}`,
            workflowId: 'stripe_webhook',
            workflowName: `Stripe Event: ${eventType}`,
            channel: 'Stripe',
            to: customerEmail || matchedClient.slug,
            message: `${eventType} (${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}) -> status ${matchedClient.billing.status}`,
            mode: stripeSecret ? 'verified_stripe' : 'unverified_stripe',
            missingEnv: stripeSecret ? [] : ['STRIPE_WEBHOOK_SECRET'],
            ranAt: nowIso,
          });
        }

        saveStore(storePath, store);
        sendJson(res, 200, {
          ok: true,
          received: true,
          eventId,
          type: eventType,
          handled: HANDLED_STRIPE_EVENTS.has(eventType),
          clientSlug: matchedClient ? matchedClient.slug : null,
        });
        return;
      }

      // Meta Webhook Verification Challenge (GET)
      if (method === 'GET' && pathname === '/webhooks/meta') {
        const mode = queryParams['hub.mode'];
        const token = queryParams['hub.verify_token'];
        const challenge = queryParams['hub.challenge'];
        if (mode === 'subscribe' && token === metaVerifyToken && challenge !== undefined) {
          sendText(res, 200, String(challenge));
        } else {
          sendJson(res, 403, { error: 'Meta verify_token mismatch' });
        }
        return;
      }

      // Inbound Twilio SMS Webhook (POST)
      if (method === 'POST' && pathname === '/webhooks/twilio') {
        const { data } = await readRequestBody(req);
        const from = data.From || data.from || '';
        const to = data.To || data.to || '';
        const body = data.Body || data.body || '';
        const sid = data.MessageSid || data.SmsSid || '';
        if (!from || !body) {
          sendJson(res, 400, { error: 'Twilio payload requires From and Body' });
          return;
        }
        const client = matchInboundClient(store, { slug: queryParams.client, toPhone: to });
        if (!client) {
          sendJson(res, 404, { error: 'No matching client found for inbound SMS' });
          return;
        }
        const matchedContact = (client.contacts || []).find((c) => normPhone(c.phone) === normPhone(from));
        const { thread, msg } = appendInboxMessage(client, {
          channel: 'SMS',
          contactName: matchedContact?.name || from,
          contactPhone: from,
          sender: from,
          body,
          direction: 'inbound',
          deliveryMode: 'inbound_twilio',
          sid,
        });
        saveStore(storePath, store);
        sendJson(res, 200, {
          ok: true,
          clientSlug: client.slug,
          threadId: thread.id,
          messageId: msg.id,
          channel: 'SMS',
          unread: thread.unread,
        });
        return;
      }

      // Inbound Meta IG DM Webhook (POST)
      if (method === 'POST' && pathname === '/webhooks/meta') {
        const { data } = await readRequestBody(req);
        const events = [];

        if (Array.isArray(data.entry)) {
          for (const entry of data.entry) {
            if (Array.isArray(entry.messaging)) {
              for (const m of entry.messaging) {
                const text = m.message?.text || m.text || '';
                if (!text) continue;
                events.push({
                  senderId: m.sender?.id || 'ig_user',
                  recipientId: m.recipient?.id || entry.id || '',
                  text,
                  senderName: m.sender?.username || m.sender?.name || m.sender?.id || 'Instagram User',
                  mid: m.message?.mid || '',
                });
              }
            } else if (Array.isArray(entry.changes)) {
              for (const ch of entry.changes) {
                const v = ch.value || {};
                const text = v.message?.text || v.text || '';
                if (!text) continue;
                events.push({
                  senderId: v.sender?.id || v.from?.id || 'ig_user',
                  recipientId: v.recipient?.id || entry.id || '',
                  text,
                  senderName: v.from?.username || v.sender?.id || 'Instagram User',
                  mid: v.message?.mid || '',
                });
              }
            }
          }
        } else if (data.text || data.body || data.message) {
          events.push({
            senderId: data.senderId || 'ig_user',
            recipientId: data.recipientId || '',
            text: data.text || data.body || data.message,
            senderName: data.senderName || data.senderId || 'Instagram User',
            mid: data.mid || '',
          });
        }

        if (events.length === 0) {
          sendJson(res, 200, { ok: true, processed: 0 });
          return;
        }

        const updatedThreads = [];
        for (const ev of events) {
          const client = matchInboundClient(store, { slug: queryParams.client, igUserId: ev.recipientId });
          if (!client) continue;
          const { thread } = appendInboxMessage(client, {
            channel: 'Instagram DM',
            contactName: ev.senderName,
            contactHandle: ev.senderName.startsWith('@') ? ev.senderName : undefined,
            recipientId: ev.senderId,
            sender: ev.senderName,
            body: ev.text,
            direction: 'inbound',
            deliveryMode: 'inbound_meta',
            sid: ev.mid,
          });
          updatedThreads.push({ clientSlug: client.slug, threadId: thread.id, unread: thread.unread });
        }
        saveStore(storePath, store);
        sendJson(res, 200, { ok: true, processed: updatedThreads.length, updatedThreads });
        return;
      }

      // Inbound Google Business Profile Review Webhook (POST)
      if (method === 'POST' && pathname === '/webhooks/gbp-review') {
        const { data } = await readRequestBody(req);
        const reviewerName = data.reviewerName || data.reviewer || 'Google Reviewer';
        const rating = Number(data.rating || 5);
        const comment = data.comment || data.text || data.body || `${rating}-star Google rating received.`;
        const client = matchInboundClient(store, {
          slug: data.clientSlug || queryParams.client,
          locationName: data.locationName,
        });
        if (!client) {
          sendJson(res, 404, { error: 'No matching client found for GBP review' });
          return;
        }
        const { thread, msg } = appendInboxMessage(client, {
          channel: 'Google Reviews',
          contactName: `${reviewerName} (${rating}★ Google Review)`,
          rating,
          sender: reviewerName,
          body: comment,
          direction: 'inbound',
          deliveryMode: 'inbound_gbp',
          sid: data.reviewId || '',
        });
        saveStore(storePath, store);
        sendJson(res, 200, {
          ok: true,
          clientSlug: client.slug,
          threadId: thread.id,
          messageId: msg.id,
          channel: 'Google Reviews',
          unread: thread.unread,
        });
        return;
      }

      // --- Authenticated API Routes (/api/state, /api/admin/*, /api/client/*) ---
      if (!pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'Not Found' });
        return;
      }

      const auth = authenticateRequest(req, store, adminPasscode);
      if (!auth) {
        sendJson(res, 401, { error: 'Unauthorized', message: 'Valid Authorization: Bearer token required.' });
        return;
      }

      // Admin-only routes: /api/state and /api/admin/*
      if (pathname === '/api/state' || pathname.startsWith('/api/admin')) {
        if (auth.role !== 'admin') {
          sendJson(res, 403, { error: 'Forbidden', message: 'Admin privileges required.' });
          return;
        }

        if (method === 'GET' && pathname === '/api/state') {
          sendJson(res, 200, {
            ok: true,
            role: 'admin',
            settings: store.settings,
            adminState: store.adminState,
            clients: store.clients,
            updatedAt: store.updatedAt,
          });
          return;
        }

        if (method === 'PUT' && pathname === '/api/state') {
          const { data } = await readRequestBody(req);
          if (data.settings && typeof data.settings === 'object') {
            store.settings = { ...store.settings, ...data.settings };
          }
          if (data.adminState && typeof data.adminState === 'object') {
            store.adminState = { ...store.adminState, ...data.adminState };
          }
          if (data.clients && typeof data.clients === 'object') {
            for (const [slug, incoming] of Object.entries(data.clients)) {
              const prev = store.clients[slug] || {};
              store.clients[slug] = { ...prev, ...incoming, slug };
            }
          }
          saveStore(storePath, store);
          sendJson(res, 200, { ok: true, updatedAt: store.updatedAt, clientCount: Object.keys(store.clients).length });
          return;
        }

        if (method === 'GET' && pathname === '/api/admin/clients') {
          sendJson(res, 200, { ok: true, clients: store.clients });
          return;
        }

        if (method === 'POST' && pathname === '/api/admin/clients') {
          const { data } = await readRequestBody(req);
          const slug = String(data.slug || data.business || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');
          if (!slug) {
            sendJson(res, 400, { error: 'Client business or slug is required' });
            return;
          }
          if (store.clients[slug]) {
            sendJson(res, 409, { error: `Client slug "${slug}" already exists` });
            return;
          }
          const created = {
            slug,
            id: data.id || `c_${slug.replace(/-/g, '_')}`,
            business: data.business || slug,
            owner: data.owner || '',
            phone: data.phone || '',
            email: data.email || '',
            location: data.location || '',
            accessCode: data.accessCode || `${slug.toUpperCase().slice(0, 8)}-2026`,
            assignedDemos: Array.isArray(data.assignedDemos) ? data.assignedDemos : [],
            customUrl: data.customUrl || '',
            webhookUrl: data.webhookUrl || '',
            twilioNumber: data.twilioNumber || '',
            igUserId: data.igUserId || '',
            modules: data.modules || createDefaultStore(env).clients['clean-results'].modules,
            campaigns: data.campaigns || [],
            leadSources: data.leadSources || [],
            bookings: data.bookings || [],
            workflows: data.workflows || [],
            contacts: data.contacts || [],
            inboxThreads: data.inboxThreads || [],
            opportunities: data.opportunities || [],
            marketing: data.marketing || { mediaAssets: [], scheduledPosts: [], brandBoard: {}, templates: [] },
            executionLogs: [],
            outboundQueue: [],
            processedScheduleKeys: {},
          };
          store.clients[slug] = created;
          saveStore(storePath, store);
          sendJson(res, 201, { ok: true, slug, client: created });
          return;
        }

        if (method === 'POST' && pathname === '/api/admin/scheduler/tick') {
          const { data } = await readRequestBody(req);
          const tickRes = await runSchedulerTick(data.clientSlug || null, {
            store,
            storePath,
            now: data.now,
            env,
            fetchImpl,
            smtpSendImpl,
          });
          if (tickRes.processedCount > 0) saveStore(storePath, store);
          sendJson(res, 200, tickRes);
          return;
        }

        if (method === 'GET' && pathname === '/api/admin/leads') {
          const leads = Array.isArray(store.publicLeads) ? store.publicLeads : [];
          const statusFilter = queryParams.status ? String(queryParams.status).trim().toLowerCase() : '';
          const filtered = statusFilter ? leads.filter((l) => String(l.status || '').toLowerCase() === statusFilter) : leads;
          sendJson(res, 200, { ok: true, total: filtered.length, leads: filtered });
          return;
        }

        const adminLeadMatch = pathname.match(/^\/api\/admin\/leads\/([a-zA-Z0-9_-]+)$/);
        if (adminLeadMatch && method === 'PATCH') {
          const leadId = adminLeadMatch[1];
          const leads = Array.isArray(store.publicLeads) ? store.publicLeads : [];
          const lead = leads.find((l) => l.id === leadId || l.ticketId === leadId);
          if (!lead) {
            sendJson(res, 404, { ok: false, error: 'Lead not found' });
            return;
          }
          const { data } = await readRequestBody(req);
          if (data.status !== undefined) {
            const nextStatus = String(data.status).trim().toLowerCase();
            if (!VALID_LEAD_STATUSES.has(nextStatus)) {
              sendJson(res, 400, {
                ok: false,
                error: 'Invalid status. Allowed values: new, contacted, qualified, won, archived',
              });
              return;
            }
            lead.status = nextStatus;
          }
          if (data.notes !== undefined) {
            lead.notes = String(data.notes ?? '').trim().slice(0, 3000);
          }
          lead.updatedAt = new Date().toISOString();
          saveStore(storePath, store);
          sendJson(res, 200, { ok: true, lead });
          return;
        }

        if (method === 'GET' && pathname === '/api/admin/email-inbox') {
          const imapHost = env.IMAP_HOST || env.SMTP_HOST || '';
          const imapPort = Number(env.IMAP_PORT || 993);
          const imapUser = env.IMAP_USER || env.SMTP_USER || '';
          const imapPass = env.IMAP_PASS || env.SMTP_PASS || '';
          const limit = queryParams.limit ? Number(queryParams.limit) : 12;
          if (!imapHost || !imapUser || !imapPass) {
            sendJson(res, 200, {
              ok: true,
              mode: 'dry_run_unconfigured',
              messages: [],
            });
            return;
          }
          const isLoopbackPlain =
            env.IMAP_PLAIN === 'true' && (imapHost === '127.0.0.1' || imapHost === 'localhost');
          try {
            const summary = await fetchImapInboxSummary({
              host: imapHost,
              port: imapPort,
              user: imapUser,
              pass: imapPass,
              limit,
              timeoutMs: 8000,
              plain: isLoopbackPlain,
              tlsOptions: options.imapTlsOptions,
              connectFn: options.imapConnectFn,
            });
            sendJson(res, 200, summary);
          } catch (err) {
            sendJson(res, 502, {
              ok: false,
              mode: 'imap_error',
              error: err.message || 'IMAP fetch failed',
              messages: [],
            });
          }
          return;
        }

        if (method === 'GET' && pathname === '/api/admin/backup') {
          const backupJson = JSON.stringify(store, null, 2);
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': 'attachment; filename="rivvak-store-backup.json"',
            'Content-Length': Buffer.byteLength(backupJson),
          });
          res.end(backupJson);
          return;
        }

        if (method === 'POST' && pathname === '/api/admin/restore') {
          const { data } = await readRequestBody(req);
          const candidate =
            data && typeof data === 'object' && !Array.isArray(data) && data.clients !== undefined
              ? data
              : data?.store && typeof data.store === 'object' && !Array.isArray(data.store)
              ? data.store
              : null;

          if (
            !candidate ||
            !candidate.clients ||
            typeof candidate.clients !== 'object' ||
            Array.isArray(candidate.clients) ||
            !Object.values(candidate.clients).every((c) => c && typeof c === 'object' && !Array.isArray(c))
          ) {
            sendJson(res, 400, { ok: false, error: 'Invalid restore payload: clients object is required.' });
            return;
          }

          const restoredStore = normalizeStoreShape(JSON.parse(JSON.stringify(candidate)), env);
          saveStore(storePath, restoredStore);
          sendJson(res, 200, {
            ok: true,
            restoredClients: Object.keys(restoredStore.clients).length,
            publicLeadsCount: Array.isArray(restoredStore.publicLeads) ? restoredStore.publicLeads.length : 0,
            updatedAt: restoredStore.updatedAt,
          });
          return;
        }

        const adminClientMatch = pathname.match(/^\/api\/admin\/clients\/([a-z0-9-]+)$/i);
        if (adminClientMatch) {
          const slug = adminClientMatch[1];
          if (method === 'DELETE') {
            if (!store.clients[slug]) {
              sendJson(res, 404, { error: 'Client not found' });
              return;
            }
            delete store.clients[slug];
            saveStore(storePath, store);
            sendJson(res, 200, { ok: true, deleted: slug });
            return;
          }
          if (method === 'PUT') {
            if (!store.clients[slug]) {
              sendJson(res, 404, { error: 'Client not found' });
              return;
            }
            const { data } = await readRequestBody(req);
            store.clients[slug] = { ...store.clients[slug], ...data, slug };
            saveStore(storePath, store);
            sendJson(res, 200, { ok: true, slug, client: store.clients[slug] });
            return;
          }
        }

        sendJson(res, 404, { error: 'Admin endpoint not found' });
        return;
      }

      // Client-scoped routes: /api/client/:slug(/*)
      const clientMatch = pathname.match(/^\/api\/client\/([a-z0-9-]+)(?:\/(.*))?$/i);
      if (clientMatch) {
        const slug = clientMatch[1];
        const subRoute = clientMatch[2] || '';

        if (auth.role === 'client' && auth.clientSlug !== slug) {
          sendJson(res, 403, { error: 'Forbidden', message: 'Cross-tenant access denied.' });
          return;
        }

        const client = store.clients[slug];
        if (!client) {
          sendJson(res, 404, { error: `Client "${slug}" not found` });
          return;
        }

        if (method === 'GET' && (subRoute === '' || subRoute === 'sync')) {
          sendJson(res, 200, { ok: true, slug, role: auth.role, client, updatedAt: store.updatedAt });
          return;
        }

        if (method === 'PUT' && (subRoute === '' || subRoute === 'sync')) {
          const { data } = await readRequestBody(req);
          const incoming = data.client && typeof data.client === 'object' ? data.client : data;
          const preservedCode = client.accessCode;
          store.clients[slug] = {
            ...client,
            ...incoming,
            slug,
            accessCode: auth.role === 'admin' && incoming.accessCode ? incoming.accessCode : preservedCode,
          };
          saveStore(storePath, store);
          sendJson(res, 200, { ok: true, slug, client: store.clients[slug], updatedAt: store.updatedAt });
          return;
        }

        if (method === 'POST' && subRoute === 'import-csv') {
          const { data } = await readRequestBody(req);
          const kind = data.kind || 'contacts';
          let rawRows = [];
          if (Array.isArray(data)) {
            rawRows = data;
          } else if (Array.isArray(data.rows)) {
            rawRows = data.rows;
          } else if (Array.isArray(data.records)) {
            rawRows = data.records;
          } else if (typeof data.csvText === 'string') {
            rawRows = parseCsv(data.csvText);
          } else {
            sendJson(res, 400, { error: 'Provide csvText or rows array' });
            return;
          }

          const summary = importPushPressRecords(client, kind, rawRows);
          saveStore(storePath, store);
          sendJson(res, 200, { ok: true, slug, ...summary });
          return;
        }

        if (method === 'POST' && subRoute === 'send-sms') {
          const { data } = await readRequestBody(req);
          if (!data.to || !data.body) {
            sendJson(res, 400, { error: 'Fields "to" and "body" are required' });
            return;
          }
          const out = await dispatchChannelMessage(client, store, 'SMS', data, { env, fetchImpl });
          saveStore(storePath, store);
          sendJson(res, out.statusCode, out.result);
          return;
        }

        if (method === 'POST' && subRoute === 'send-email') {
          const { data } = await readRequestBody(req);
          if (!data.to || !data.body) {
            sendJson(res, 400, { error: 'Fields "to" and "body" are required' });
            return;
          }
          const out = await dispatchChannelMessage(client, store, 'Email', data, { env, fetchImpl, smtpSendImpl });
          saveStore(storePath, store);
          sendJson(res, out.statusCode, out.result);
          return;
        }

        if (method === 'POST' && subRoute === 'send-ig-dm') {
          const { data } = await readRequestBody(req);
          const recipientId = data.recipientId || data.to;
          if (!recipientId || !data.body) {
            sendJson(res, 400, { error: 'Fields "recipientId" and "body" are required' });
            return;
          }
          const out = await dispatchChannelMessage(
            client,
            store,
            'Instagram DM',
            { ...data, recipientId },
            { env, fetchImpl }
          );
          saveStore(storePath, store);
          sendJson(res, out.statusCode, out.result);
          return;
        }

        if (method === 'POST' && subRoute === 'trigger-workflow') {
          const { data } = await readRequestBody(req);
          const workflows = Array.isArray(client.workflows) ? client.workflows : [];
          const workflow =
            workflows.find((w) => w.id === data.workflowId || normText(w.name) === normText(data.workflowId)) || null;
          if (data.workflowId && !workflow && !data.payload?.message) {
            sendJson(res, 404, { error: `Workflow "${data.workflowId}" not found` });
            return;
          }
          const contact = data.contactId
            ? (client.contacts || []).find((c) => c.id === data.contactId)
            : data.contact || null;

          const logEntry = await executeWorkflow(
            client,
            store,
            { workflow, contact, payload: data.payload || data, webhookUrl: data.webhookUrl },
            { env, fetchImpl, smtpSendImpl }
          );
          saveStore(storePath, store);
          sendJson(res, 200, {
            ok: true,
            slug,
            mode: logEntry.mode,
            missingEnv: logEntry.missingEnv,
            executionLog: logEntry,
            workflowRunCount: workflow ? workflow.runCount : null,
          });
          return;
        }

        if (method === 'POST' && subRoute === 'scheduler/tick') {
          const { data } = await readRequestBody(req);
          const tickRes = await runSchedulerTick(slug, {
            store,
            storePath,
            now: data.now,
            env,
            fetchImpl,
            smtpSendImpl,
          });
          if (tickRes.processedCount > 0) saveStore(storePath, store);
          sendJson(res, 200, tickRes);
          return;
        }

        if (method === 'POST' && subRoute === 'sync-meta-ads') {
          const missingEnv = ['META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID'].filter((k) => !env[k]);
          if (missingEnv.length > 0) {
            sendJson(res, 200, {
              ok: true,
              mode: 'dry_run_queued',
              missingEnv,
              campaigns: client.campaigns || [],
            });
            return;
          }
          const acct = env.META_AD_ACCOUNT_ID.startsWith('act_')
            ? env.META_AD_ACCOUNT_ID
            : `act_${env.META_AD_ACCOUNT_ID}`;
          const resp = await fetchImpl(
            `https://graph.facebook.com/v21.0/${encodeURIComponent(acct)}/campaigns?fields=name,status,objective`,
            { headers: { Authorization: `Bearer ${env.META_ACCESS_TOKEN}` } }
          );
          const metaJson = await resp.json().catch(() => ({}));
          if (!resp.ok) {
            sendJson(res, 502, { ok: false, mode: 'meta_error', error: metaJson.error?.message || 'Meta Ads sync error' });
            return;
          }
          sendJson(res, 200, { ok: true, mode: 'live_meta', remoteCampaigns: metaJson.data || [], campaigns: client.campaigns });
          return;
        }

        sendJson(res, 404, { error: 'Client endpoint not found' });
        return;
      }

      sendJson(res, 404, { error: 'Route not found' });
    } catch (err) {
      const status = err.statusCode || 500;
      sendJson(res, status, { error: err.message || 'Internal Server Error' });
    }
  });

  server._rivvakContext = { storePath, env, fetchImpl };
  return server;
}

/**
 * Start the HTTP server and optional 24/7 scheduler interval cleanly.
 * @param {object} options
 * @returns {Promise<{ server: http.Server, port: number, url: string, dataDir: string, storePath: string, close: Function, stop: Function, runSchedulerTick: Function }>}
 */
function startServer(options = {}) {
  if (options.loadEnv !== false) {
    loadDotEnv(options.envPath);
  }
  const env = options.env || process.env;
  const port = options.port !== undefined ? Number(options.port) : Number(env.PORT || 8787);
  const host = options.host || env.HOST || '127.0.0.1';
  const server = createServer(options);
  const { storePath, fetchImpl } = server._rivvakContext;

  const enableInterval = options.enableScheduler !== false;
  const intervalMs = Number(options.schedulerIntervalMs || env.SCHEDULER_INTERVAL_MS || 60000);
  let timer = null;

  if (enableInterval && intervalMs > 0) {
    timer = setInterval(() => {
      runSchedulerTick(null, { storePath, env, fetchImpl }).catch(() => {});
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  const stop = () =>
    new Promise((resolve) => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
      server.close(() => resolve());
    });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      const boundHost = host === '0.0.0.0' ? '127.0.0.1' : host;
      resolve({
        server,
        port: boundPort,
        url: `http://${boundHost}:${boundPort}`,
        dataDir: path.dirname(storePath),
        storePath,
        stop,
        close: stop,
        runSchedulerTick: (slug, tickOpts = {}) =>
          runSchedulerTick(slug, { storePath, env, fetchImpl, ...tickOpts }),
      });
    });
  });
}

if (require.main === module) {
  loadDotEnv();
  const host = process.env.HOST || '0.0.0.0';
  startServer({ host }).then((instance) => {
    console.log(
      `[rivvak-automation-backend] Listening on ${instance.url} (store: ${instance.storePath}, version: ${SERVICE_VERSION})`
    );
    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[rivvak-automation-backend] Received ${signal}, shutting down gracefully...`);
      const forceTimer = setTimeout(() => process.exit(1), 5000);
      if (typeof forceTimer.unref === 'function') forceTimer.unref();
      instance
        .stop()
        .then(() => {
          clearTimeout(forceTimer);
          process.exit(0);
        })
        .catch(() => process.exit(1));
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });
}

module.exports = {
  createServer,
  startServer,
  runSchedulerTick,
  parseCsv,
  createDefaultStore,
  loadStore,
  saveStore,
  resolveStorePath,
  sendSmtpEmail,
  verifySmtpAuth,
  fetchImapInboxSummary,
  verifyStripeSignature,
  safeEqualToken,
  loadDotEnv,
  parseDotEnvFile,
};
