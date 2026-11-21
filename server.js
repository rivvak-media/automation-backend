'use strict';

/**
 * Rivvak Media Automation Backend Engine
 * Zero-dependency Node.js multi-tenant server providing:
 * - Persistent JSON store (data/store.json) with Clean Results & Carleen Ligozio seeds
 * - Strict CORS & Bearer token isolation (Admin vs Client accessCode)
 * - RFC-4180 PushPress Grow CSV migration & deduplication (Contacts & Opportunities)
 * - Live channel dispatchers via native fetch (Twilio, Resend, Meta Graph, Webhooks) with honest dry_run_queued mode
 * - Inbound webhooks (Twilio SMS, Meta IG DM verify + events, Google Business Profile reviews)
 * - Idempotent 24/7 workflow scheduler (24h/2h bookings, birthdays, 7/14/30d retention, due social posts)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');
const querystring = require('querystring');
const tls = require('tls');
const net = require('net');

const MAX_BODY_BYTES = 10 * 1024 * 1024;

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
    version: 1,
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
 * Load store from disk, creating seeded store.json if missing.
 * @param {string} storePath
 * @param {object} env
 * @returns {object}
 */
function loadStore(storePath, env = process.env) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  if (!fs.existsSync(storePath)) {
    const initial = createDefaultStore(env);
    saveStore(storePath, initial);
    return initial;
  }
  const raw = fs.readFileSync(storePath, 'utf8').trim();
  if (!raw) {
    const initial = createDefaultStore(env);
    saveStore(storePath, initial);
    return initial;
  }
  const parsed = JSON.parse(raw);
  if (!parsed.clients || typeof parsed.clients !== 'object') {
    parsed.clients = createDefaultStore(env).clients;
  }
  if (!parsed.settings) {
    parsed.settings = createDefaultStore(env).settings;
  }
  return parsed;
}

/**
 * Atomically persist store JSON to disk.
 * @param {string} storePath
 * @param {object} store
 */
function saveStore(storePath, store) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  store.updatedAt = new Date().toISOString();
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmpPath, storePath);
}

/**
 * Constant-time string comparison via SHA-256 digests.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
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
 */
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
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
 * Authenticate incoming Bearer token as admin or single-tenant client.
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
  if (safeEqual(token, adminPasscode)) {
    return { role: 'admin' };
  }
  for (const [slug, client] of Object.entries(store.clients || {})) {
    if (client && client.accessCode && safeEqual(token, String(client.accessCode))) {
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
    if (env.RESEND_API_KEY) {
      const resp = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromFallback,
          to: [payload.to],
          subject: payload.subject || `Message from ${client.business}`,
          text: payload.body,
          ...(payload.html ? { html: payload.html } : {}),
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return {
          statusCode: 502,
          result: { ok: false, mode: 'resend_error', status: resp.status, error: data.message || 'Resend API error' },
        };
      }
      const { thread, msg } = appendInboxMessage(client, {
        threadId: payload.threadId,
        channel: 'Email',
        contactName: payload.contactName || payload.to,
        contactEmail: payload.to,
        sender: fromFallback,
        subject: payload.subject,
        body: payload.body,
        direction: 'outbound',
        deliveryMode: 'live_resend',
        sid: data.id,
      });
      return {
        statusCode: 200,
        result: { ok: true, mode: 'live_resend', id: data.id, threadId: thread.id, messageId: msg.id, webhookResult },
      };
    }

    if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) {
      const smtpHost = env.SMTP_HOST;
      const smtpPort = Number(env.SMTP_PORT || 465);
      const isLoopbackPlain =
        env.SMTP_PLAIN === 'true' && (smtpHost === '127.0.0.1' || smtpHost === 'localhost');
      const smtpSender = env.SMTP_FROM || env.RESEND_FROM || env.SMTP_USER;
      const sendFn = ctx.smtpSendImpl || sendSmtpEmail;
      try {
        const smtpRes = await sendFn({
          host: smtpHost,
          port: smtpPort,
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
          from: smtpSender,
          to: payload.to,
          subject: payload.subject || `Message from ${client.business}`,
          text: payload.body,
          plain: isLoopbackPlain,
        });
        const { thread, msg } = appendInboxMessage(client, {
          threadId: payload.threadId,
          channel: 'Email',
          contactName: payload.contactName || payload.to,
          contactEmail: payload.to,
          sender: smtpSender,
          subject: payload.subject,
          body: payload.body,
          direction: 'outbound',
          deliveryMode: 'live_smtp',
          sid: smtpRes.messageId,
        });
        return {
          statusCode: 200,
          result: {
            ok: true,
            mode: 'live_smtp',
            messageId: smtpRes.messageId,
            inboxMessageId: msg.id,
            threadId: thread.id,
            response: smtpRes.response,
            webhookResult,
          },
        };
      } catch (err) {
        return {
          statusCode: 502,
          result: { ok: false, mode: 'smtp_error', error: err.message || 'SMTP delivery failed' },
        };
      }
    }

    const missingEnv = ['RESEND_API_KEY or SMTP_*'];
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

  // Ensure store file exists at server creation
  loadStore(storePath, env);

  const server = http.createServer(async (req, res) => {
    try {
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
      if (method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          service: 'rivvak-automation-backend',
          version: '1.0.0',
          clients: Object.keys(store.clients).length,
          timestamp: new Date().toISOString(),
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
          });
          if (tickRes.processedCount > 0) saveStore(storePath, store);
          sendJson(res, 200, tickRes);
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
      `[rivvak-automation-backend] Listening on ${instance.url} (store: ${instance.storePath})`
    );
    const shutdown = () => {
      instance.stop().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
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
  loadDotEnv,
  parseDotEnvFile,
};
