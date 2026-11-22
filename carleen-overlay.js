/**
 * Carleen Ligozio LLC — Official Consumer Advisory & Verified Boutique Overlay
 * Target Domain: https://carleenligoziollc-fl.com
 * Prepared by: Rivvak Media (connect@rivvak.com)
 * 
 * Exhaustive Multi-Slot DOM Target Architecture:
 * 1. Global Interstitial/Modal: div#wcpa_img_preview (fallback document.body)
 * 2. Sticky Top Bar: .whb-main-header > .whb-top-bar .whb-top-bar-inner (unhiding .whb-hidden-desktop.whb-hidden-mobile)
 * 3. In-Page Hero Slot: #main-content .site-content > article#post-1401 > .elementor-1401
 * 4. /contact-us/ Maps Slot: .elementor-element-3f7aee8.elementor-widget-google_maps .elementor-custom-embed
 * 5. /my-account/ Auth Slot: .elementor-element-463e31.wd-wc-notices .woocommerce-notices-wrapper
 * 6. /cart/ & /checkout/ Slots:
 *    - Express Payment: div.wp-block-woocommerce-cart-express-payment-block
 *    - Proceed to Checkout: div.wp-block-woocommerce-proceed-to-checkout-block
 *    - WooCommerce Notices: div.woocommerce-notices-wrapper
 * 7. Search Results Slot: h1.entry-title.title (when ?s= query is active)
 */

(function () {
  'use strict';

  // Prevent multiple injections
  if (window.__CARLEEN_OVERLAY_INITIALIZED__) return;
  window.__CARLEEN_OVERLAY_INITIALIZED__ = true;

  const CONFIG = {
    domain: 'carleenligoziollc-fl.com',
    agency: 'Rivvak Media',
    agencyEmail: 'connect@rivvak.com',
    owner: 'Carleen Ligozio',
    ownerEmail: 'cligozio@me.com',
    phoneWPB: '(561) 841-6097',
    addressWPB: '3727 S Dixie Hwy, West Palm Beach, FL 33405',
    phoneNY: '(631) 204-0104',
    addressNY: '16 Jobs Lane, Southampton, NY 11968',
    backendApi: 'http://localhost:3000/api/client/carleen-ligozio',
    clientToken: 'CARLEEN-2026',
    takedownCaseId: 'DCU102460176'
  };

  // --- Scoped CSS Styles ---
  const STYLES = `
    #cl-overlay-root, #cl-overlay-root *,
    .cl-slot-injected, .cl-slot-injected * {
      box-sizing: border-box !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
      -webkit-font-smoothing: antialiased !important;
      -moz-osx-font-smoothing: grayscale !important;
      line-height: 1.5;
    }

    /* Modal / Interstitial Overlay */
    #cl-interstitial-backdrop {
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      background: rgba(9, 9, 11, 0.88) !important;
      backdrop-filter: blur(12px) !important;
      -webkit-backdrop-filter: blur(12px) !important;
      z-index: 2147483647 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      padding: 16px !important;
      overflow-y: auto !important;
      transition: opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1), visibility 0.3s !important;
    }

    #cl-interstitial-backdrop.cl-hidden {
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }

    .cl-card {
      background: #121214 !important;
      color: #F4F4F5 !important;
      border: 1px solid rgba(212, 175, 55, 0.4) !important;
      border-radius: 14px !important;
      max-width: 720px !important;
      width: 100% !important;
      box-shadow: 0 25px 60px -15px rgba(0, 0, 0, 0.9), 0 0 40px rgba(212, 175, 55, 0.15) !important;
      overflow: hidden !important;
      position: relative !important;
      animation: cl-slide-in 0.35s cubic-bezier(0.16, 1, 0.3, 1) !important;
    }

    @keyframes cl-slide-in {
      from { transform: translateY(20px) scale(0.97); opacity: 0; }
      to { transform: translateY(0) scale(1); opacity: 1; }
    }

    .cl-header {
      background: linear-gradient(135deg, #18181b 0%, #27272a 100%) !important;
      padding: 20px 24px !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
    }

    .cl-badge-warning {
      display: inline-flex !important;
      align-items: center !important;
      gap: 6px !important;
      background: rgba(245, 158, 11, 0.15) !important;
      color: #FBBF24 !important;
      border: 1px solid rgba(245, 158, 11, 0.4) !important;
      padding: 4px 10px !important;
      border-radius: 9999px !important;
      font-size: 11px !important;
      font-weight: 700 !important;
      letter-spacing: 0.06em !important;
      text-transform: uppercase !important;
    }

    .cl-badge-verified {
      display: inline-flex !important;
      align-items: center !important;
      gap: 6px !important;
      background: rgba(16, 185, 129, 0.15) !important;
      color: #34D399 !important;
      border: 1px solid rgba(16, 185, 129, 0.4) !important;
      padding: 4px 10px !important;
      border-radius: 9999px !important;
      font-size: 11px !important;
      font-weight: 700 !important;
      letter-spacing: 0.06em !important;
      text-transform: uppercase !important;
    }

    .cl-close-btn {
      background: transparent !important;
      border: none !important;
      color: #A1A1AA !important;
      cursor: pointer !important;
      padding: 6px !important;
      border-radius: 6px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      transition: color 0.15s, background 0.15s !important;
    }
    .cl-close-btn:hover {
      color: #FFFFFF !important;
      background: rgba(255, 255, 255, 0.1) !important;
    }

    .cl-body {
      padding: 24px !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 18px !important;
    }

    .cl-title {
      font-size: 22px !important;
      font-weight: 800 !important;
      color: #FFFFFF !important;
      letter-spacing: -0.02em !important;
      line-height: 1.3 !important;
    }

    .cl-title span {
      color: #D4AF37 !important;
    }

    .cl-text {
      font-size: 14px !important;
      color: #D4D4D8 !important;
      line-height: 1.6 !important;
    }

    .cl-alert-box {
      background: rgba(239, 68, 68, 0.1) !important;
      border-left: 4px solid #EF4444 !important;
      padding: 12px 16px !important;
      border-radius: 6px !important;
      font-size: 13px !important;
      color: #FCA5A5 !important;
    }

    .cl-locations-grid {
      display: grid !important;
      grid-template-columns: 1fr 1fr !important;
      gap: 14px !important;
      margin-top: 6px !important;
    }

    @media (max-width: 600px) {
      .cl-locations-grid {
        grid-template-columns: 1fr !important;
      }
    }

    .cl-loc-card {
      background: #18181B !important;
      border: 1px solid rgba(255, 255, 255, 0.1) !important;
      border-radius: 8px !important;
      padding: 14px !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 6px !important;
    }

    .cl-loc-title {
      font-size: 13px !important;
      font-weight: 700 !important;
      color: #D4AF37 !important;
      text-transform: uppercase !important;
      letter-spacing: 0.05em !important;
    }

    .cl-loc-address {
      font-size: 13px !important;
      color: #E4E4E7 !important;
    }

    .cl-loc-phone {
      font-size: 13px !important;
      color: #38BDF8 !important;
      text-decoration: none !important;
      font-weight: 600 !important;
    }
    .cl-loc-phone:hover {
      text-decoration: underline !important;
    }

    .cl-form-container {
      background: #18181B !important;
      border: 1px solid rgba(212, 175, 55, 0.2) !important;
      border-radius: 8px !important;
      padding: 16px !important;
      margin-top: 4px !important;
    }

    .cl-form-title {
      font-size: 14px !important;
      font-weight: 700 !important;
      color: #FFFFFF !important;
      margin-bottom: 8px !important;
    }

    .cl-form-row {
      display: flex !important;
      gap: 10px !important;
      margin-bottom: 10px !important;
    }

    @media (max-width: 500px) {
      .cl-form-row {
        flex-direction: column !important;
      }
    }

    .cl-input {
      flex: 1 !important;
      background: #27272A !important;
      border: 1px solid #3F3F46 !important;
      color: #FFFFFF !important;
      padding: 9px 12px !important;
      border-radius: 6px !important;
      font-size: 13px !important;
      outline: none !important;
    }
    .cl-input:focus {
      border-color: #D4AF37 !important;
    }

    .cl-btn {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 6px !important;
      padding: 10px 18px !important;
      border-radius: 6px !important;
      font-size: 13px !important;
      font-weight: 700 !important;
      cursor: pointer !important;
      border: none !important;
      transition: background 0.15s, transform 0.1s !important;
      text-decoration: none !important;
    }

    .cl-btn-primary {
      background: #D4AF37 !important;
      color: #09090B !important;
    }
    .cl-btn-primary:hover {
      background: #DFBE52 !important;
      transform: translateY(-1px) !important;
    }

    .cl-btn-outline {
      background: transparent !important;
      color: #A1A1AA !important;
      border: 1px solid #3F3F46 !important;
    }
    .cl-btn-outline:hover {
      color: #FFFFFF !important;
      border-color: #71717A !important;
    }

    .cl-footer {
      background: #18181B !important;
      border-top: 1px solid rgba(255, 255, 255, 0.08) !important;
      padding: 14px 24px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      flex-wrap: wrap !important;
      gap: 10px !important;
      font-size: 12px !important;
      color: #71717A !important;
    }

    /* Floating Dock / Minimized Badge */
    #cl-floating-dock {
      position: fixed !important;
      bottom: 20px !important;
      right: 20px !important;
      z-index: 2147483646 !important;
      display: flex !important;
      align-items: center !important;
      gap: 10px !important;
      background: #121214 !important;
      color: #FFFFFF !important;
      border: 1px solid rgba(212, 175, 55, 0.5) !important;
      padding: 10px 16px !important;
      border-radius: 9999px !important;
      cursor: pointer !important;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6), 0 0 20px rgba(212, 175, 55, 0.2) !important;
      transition: transform 0.2s, box-shadow 0.2s !important;
    }
    #cl-floating-dock:hover {
      transform: translateY(-2px) scale(1.02) !important;
      box-shadow: 0 14px 35px rgba(0, 0, 0, 0.7), 0 0 25px rgba(212, 175, 55, 0.35) !important;
    }

    /* Sticky Top Bar Banner */
    #cl-sticky-topbar {
      background: linear-gradient(90deg, #18181B 0%, #27272A 50%, #18181B 100%) !important;
      color: #F4F4F5 !important;
      border-bottom: 2px solid #D4AF37 !important;
      padding: 8px 16px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      gap: 12px !important;
      font-size: 12px !important;
      width: 100% !important;
      z-index: 999999 !important;
      box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3) !important;
    }
    #cl-sticky-topbar strong {
      color: #D4AF37 !important;
    }
    #cl-sticky-topbar a {
      color: #38BDF8 !important;
      text-decoration: underline !important;
    }

    /* Route-Specific Slot Blocks */
    .cl-block-alert {
      background: #18181B !important;
      border: 1px solid rgba(212, 175, 55, 0.4) !important;
      border-radius: 8px !important;
      padding: 18px 20px !important;
      margin: 16px 0 !important;
      color: #E4E4E7 !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 10px !important;
      box-shadow: 0 4px 20px rgba(0,0,0,0.2) !important;
    }

    .cl-block-alert--danger {
      border-color: #EF4444 !important;
      background: rgba(239, 68, 68, 0.08) !important;
    }
  `;

  // Inject Scoped Stylesheet
  const styleEl = document.createElement('style');
  styleEl.id = 'cl-overlay-styles';
  styleEl.textContent = STYLES;
  (document.head || document.getElementsByTagName('head')[0] || document.documentElement).appendChild(styleEl);

  // Root Host
  const root = document.createElement('div');
  root.id = 'cl-overlay-root';

  // Modal / Interstitial HTML
  const modalHtml = `
    <div id="cl-interstitial-backdrop" role="dialog" aria-modal="true" aria-labelledby="cl-modal-title">
      <div class="cl-card">
        <div class="cl-header">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="cl-badge-warning">⚠ Consumer Security Notice</span>
            <span class="cl-badge-verified">Official Boutique Advisory</span>
          </div>
          <button class="cl-close-btn" id="cl-modal-close" title="Minimize Advisory" aria-label="Minimize Advisory">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div class="cl-body">
          <h2 class="cl-title" id="cl-modal-title">
            Notice Regarding <span>Carleen Ligozio LLC</span>
          </h2>

          <div class="cl-alert-box">
            <strong>FRAUD & IMPERSONATION ALERT:</strong> The website at <code>${CONFIG.domain}</code> is an unauthorized third-party entity. Carleen Ligozio operates no official e-commerce store at this domain. Any credit card or payment submissions here are NOT processed or fulfilled by Carleen Ligozio.
          </div>

          <p class="cl-text">
            For authentic European apparel collections, private styling consultations, and inquiries, please contact or visit Carleen Ligozio directly at our official Florida and New York locations:
          </p>

          <div class="cl-locations-grid">
            <div class="cl-loc-card">
              <span class="cl-loc-title">West Palm Beach Boutique</span>
              <span class="cl-loc-address">${CONFIG.addressWPB}</span>
              <a href="tel:${CONFIG.phoneWPB.replace(/[^0-9]/g, '')}" class="cl-loc-phone">📞 ${CONFIG.phoneWPB}</a>
            </div>
            <div class="cl-loc-card">
              <span class="cl-loc-title">Southampton Atelier</span>
              <span class="cl-loc-address">${CONFIG.addressNY}</span>
              <a href="tel:${CONFIG.phoneNY.replace(/[^0-9]/g, '')}" class="cl-loc-phone">📞 ${CONFIG.phoneNY}</a>
            </div>
          </div>

          <!-- Direct Inbound Appointment & Concierge Request -->
          <div class="cl-form-container">
            <h3 class="cl-form-title">Direct Boutique Concierge & Appointment Request</h3>
            <form id="cl-appointment-form">
              <div class="cl-form-row">
                <input class="cl-input" type="text" name="name" placeholder="Your Name" required />
                <input class="cl-input" type="tel" name="phone" placeholder="Phone Number" required />
              </div>
              <div class="cl-form-row">
                <input class="cl-input" type="email" name="email" placeholder="Email Address" required />
                <select class="cl-input" name="location">
                  <option value="West Palm Beach, FL">West Palm Beach Showroom</option>
                  <option value="Southampton, NY">Southampton Showroom</option>
                  <option value="Virtual Consultation">Private Phone / Email Consult</option>
                </select>
              </div>
              <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px;">
                <span id="cl-form-status" style="font-size: 12px; color: #34D399;"></span>
                <button type="submit" class="cl-btn cl-btn-primary">
                  Request Private Appointment
                </button>
              </div>
            </form>
          </div>
        </div>

        <div class="cl-footer">
          <span>Official Agency Representative: <strong>${CONFIG.agency}</strong> (<a href="mailto:${CONFIG.agencyEmail}" style="color: #A1A1AA; text-decoration: underline;">${CONFIG.agencyEmail}</a>)</span>
          <div style="display: flex; gap: 8px;">
            <a href="mailto:${CONFIG.ownerEmail}?cc=${CONFIG.agencyEmail}&subject=Customer%20Inquiry%20via%20Official%20Advisory" class="cl-btn cl-btn-outline" style="padding: 6px 12px; font-size: 11px;">
              Email Carleen Directly
            </a>
            <button id="cl-dismiss-btn" class="cl-btn cl-btn-outline" style="padding: 6px 12px; font-size: 11px;">
              Acknowledge & Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Minimized Floating Badge HTML
  const dockHtml = `
    <div id="cl-floating-dock" title="Click to view Official Advisory">
      <span style="font-size: 16px;">🛡️</span>
      <span style="font-size: 12px; font-weight: 700; color: #D4AF37;">Carleen Ligozio Boutique Advisory</span>
    </div>
  `;

  // Sticky Top Bar HTML
  const stickyTopbarHtml = `
    <div id="cl-sticky-topbar">
      <div>
        <strong>OFFICIAL ADVISORY:</strong> <code>${CONFIG.domain}</code> is unauthorized. Official boutiques: 
        <a href="tel:${CONFIG.phoneWPB.replace(/[^0-9]/g, '')}">WPB: ${CONFIG.phoneWPB}</a> | 
        <a href="tel:${CONFIG.phoneNY.replace(/[^0-9]/g, '')}">Southampton: ${CONFIG.phoneNY}</a>
      </div>
      <button id="cl-topbar-reopen" class="cl-btn cl-btn-primary" style="padding: 4px 10px; font-size: 11px;">
        View Official Notice
      </button>
    </div>
  `;

  // Hero Section Disclaimer HTML
  const heroDisclaimerHtml = `
    <div id="cl-hero-disclaimer" class="cl-block-alert cl-slot-injected">
      <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px;">
        <span class="cl-badge-warning">Verified Consumer Advisory</span>
        <span style="font-size: 12px; color: #A1A1AA;">Notice Case Ref: ${CONFIG.takedownCaseId}</span>
      </div>
      <p style="font-size: 13px; line-height: 1.5; color: #E4E4E7;">
        <strong>Notice to Customers:</strong> Carleen Ligozio LLC does not fulfill orders through this website. To arrange an in-person viewing of luxury apparel or coordinate concierge styling, please contact our physical locations at <strong>3727 S Dixie Hwy, West Palm Beach</strong> (${CONFIG.phoneWPB}) or <strong>16 Jobs Lane, Southampton</strong> (${CONFIG.phoneNY}).
      </p>
    </div>
  `;

  // Contact Page Maps Overlay / Replacement HTML
  const contactMapsSlotHtml = `
    <div class="cl-block-alert cl-slot-injected" id="cl-contact-map-advisory">
      <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 6px;">
        <span class="cl-badge-verified">Verified Storefront Location</span>
        <span class="cl-badge-warning">Unauthorized Website Association</span>
      </div>
      <p style="font-size: 13px; color: #F4F4F5; margin-top: 4px;">
        The physical storefront at <strong>${CONFIG.addressWPB}</strong> is the authentic boutique of Carleen Ligozio. However, <em>the website operating at this domain (${CONFIG.domain}) is entirely unauthorized and unaffiliated with Carleen Ligozio</em>.
      </p>
      <div style="display: flex; gap: 12px; margin-top: 6px;">
        <a href="tel:${CONFIG.phoneWPB.replace(/[^0-9]/g, '')}" class="cl-btn cl-btn-primary" style="font-size: 12px; padding: 6px 12px;">Call WPB Showroom: ${CONFIG.phoneWPB}</a>
        <a href="tel:${CONFIG.phoneNY.replace(/[^0-9]/g, '')}" class="cl-btn cl-btn-outline" style="font-size: 12px; padding: 6px 12px;">Call Southampton: ${CONFIG.phoneNY}</a>
      </div>
    </div>
  `;

  // Account Page Notice Slot HTML
  const accountNoticeSlotHtml = `
    <div class="cl-block-alert cl-block-alert--danger cl-slot-injected" id="cl-account-warning">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span class="cl-badge-warning">SECURITY CAUTION</span>
        <strong style="color: #EF4444; font-size: 13px;">Do Not Submit Credentials or Create Accounts</strong>
      </div>
      <p style="font-size: 12px; color: #FCA5A5; margin-top: 4px;">
        This store does not belong to Carleen Ligozio LLC. Creating an account or entering passwords on this domain compromises your personal data.
      </p>
    </div>
  `;

  // Cart & Checkout Interception Block HTML
  const checkoutNoticeSlotHtml = `
    <div class="cl-block-alert cl-block-alert--danger cl-slot-injected" id="cl-checkout-interception">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span class="cl-badge-warning">FRAUD INTERCEPTION</span>
        <strong style="color: #EF4444; font-size: 13px;">Checkout Disabled by Consumer Advisory</strong>
      </div>
      <p style="font-size: 12px; color: #FCA5A5; margin-top: 4px;">
        Carleen Ligozio does not authorize purchases or Stripe charges on this domain. Orders placed here will not be fulfilled. Call (561) 841-6097 for authentic boutique orders.
      </p>
    </div>
  `;

  root.innerHTML = modalHtml + dockHtml;

  // --- Multi-Slot Mounting Logic ---

  function mountOverlay() {
    // 1. Primary Modal Injection: Target div#wcpa_img_preview or fallback to document.body
    const targetPreview = document.getElementById('wcpa_img_preview');
    if (targetPreview) {
      targetPreview.appendChild(root);
    } else {
      document.body.appendChild(root);
    }

    // 2. Sticky Top-Bar Injection: Target .whb-top-bar-inner or .whb-main-header > .whb-top-bar
    const topBarInner = document.querySelector('.whb-main-header > .whb-top-bar .whb-top-bar-inner') ||
                        document.querySelector('.whb-top-bar-inner') ||
                        document.querySelector('.whb-main-header > .whb-top-bar');
    if (topBarInner) {
      // Unhide parent if Woodmart hid it
      const parentBar = topBarInner.closest('.whb-top-bar');
      if (parentBar) {
        parentBar.classList.remove('whb-hidden-desktop', 'whb-hidden-mobile');
        parentBar.style.display = 'block';
      }
      const topBarWrapper = document.createElement('div');
      topBarWrapper.innerHTML = stickyTopbarHtml;
      topBarInner.prepend(topBarWrapper.firstElementChild);
    } else {
      const siteWrapper = document.querySelector('.website-wrapper') || document.body;
      const topBarWrapper = document.createElement('div');
      topBarWrapper.innerHTML = stickyTopbarHtml;
      siteWrapper.parentNode.insertBefore(topBarWrapper.firstElementChild, siteWrapper);
    }

    // 3. In-Page Hero Slot Injection
    const heroTarget = document.querySelector('#main-content .site-content > article#post-1401 > .elementor-1401') ||
                       document.querySelector('.elementor-1401');
    if (heroTarget) {
      const heroWrapper = document.createElement('div');
      heroWrapper.innerHTML = heroDisclaimerHtml;
      heroTarget.insertBefore(heroWrapper.firstElementChild, heroTarget.firstChild);
    }

    // 4. /contact-us/ Maps Slot Injection
    const mapsEmbedSlot = document.querySelector('.elementor-element-3f7aee8.elementor-widget-google_maps .elementor-custom-embed') ||
                          document.querySelector('.elementor-widget-google_maps');
    if (mapsEmbedSlot && !document.getElementById('cl-contact-map-advisory')) {
      const mapsWrapper = document.createElement('div');
      mapsWrapper.innerHTML = contactMapsSlotHtml;
      mapsEmbedSlot.parentNode.insertBefore(mapsWrapper.firstElementChild, mapsEmbedSlot);
    }

    // 5. /my-account/ Notices Slot Injection
    const accountNoticeSlot = document.querySelector('.elementor-element-463e31.wd-wc-notices .woocommerce-notices-wrapper') ||
                              document.querySelector('.elementor-element-463e31 .woocommerce-notices-wrapper') ||
                              (window.location.pathname.includes('my-account') ? document.querySelector('.woocommerce-notices-wrapper') : null);
    if (accountNoticeSlot && !document.getElementById('cl-account-warning')) {
      const accountWrapper = document.createElement('div');
      accountWrapper.innerHTML = accountNoticeSlotHtml;
      accountNoticeSlot.prepend(accountWrapper.firstElementChild);
    }

    // 6. /cart/ & /checkout/ Payment Blocks Interception
    const checkoutBlocks = document.querySelectorAll(
      '.wp-block-woocommerce-cart-express-payment-block, .wp-block-woocommerce-proceed-to-checkout-block, .wc-proceed-to-checkout'
    );
    checkoutBlocks.forEach(function (block) {
      if (!block.querySelector('#cl-checkout-interception')) {
        const wrap = document.createElement('div');
        wrap.innerHTML = checkoutNoticeSlotHtml;
        block.prepend(wrap.firstElementChild);
      }
    });

    // 7. Search Results Query Injection (if ?s= is present or on search results template)
    const searchHeader = document.querySelector('h1.entry-title.title');
    if (searchHeader && (window.location.search.includes('s=') || searchHeader.textContent.toLowerCase().includes('search results')) && !document.getElementById('cl-search-warning')) {
      const searchWarn = document.createElement('div');
      searchWarn.id = 'cl-search-warning';
      searchWarn.className = 'cl-block-alert cl-block-alert--danger cl-slot-injected';
      searchWarn.innerHTML = '<strong>SECURITY NOTICE:</strong> Catalog items displayed below are unverified dropship products unaffiliated with Carleen Ligozio LLC.';
      searchHeader.parentNode.insertBefore(searchWarn, searchHeader.nextSibling);
    }

    attachInteractions();
    attachCheckoutGuards();
  }

  // --- Event Handling & Interactions ---

  function attachInteractions() {
    const backdrop = document.getElementById('cl-interstitial-backdrop');
    const closeBtn = document.getElementById('cl-modal-close');
    const dismissBtn = document.getElementById('cl-dismiss-btn');
    const dock = document.getElementById('cl-floating-dock');
    const reopenBtn = document.getElementById('cl-topbar-reopen');

    function hideModal() {
      if (backdrop) backdrop.classList.add('cl-hidden');
    }

    function showModal() {
      if (backdrop) backdrop.classList.remove('cl-hidden');
    }

    window.__CARLEEN_SHOW_MODAL__ = showModal;
    window.__CARLEEN_HIDE_MODAL__ = hideModal;

    // If running on agency domain, dock by default unless requested
    if (window.location.hostname.includes('rivvak') && !window.location.search.includes('preview=carleen')) {
      hideModal();
    }

    if (closeBtn) closeBtn.addEventListener('click', hideModal);
    if (dismissBtn) dismissBtn.addEventListener('click', hideModal);
    if (dock) dock.addEventListener('click', showModal);
    if (reopenBtn) reopenBtn.addEventListener('click', showModal);

    // Form submission hook
    const form = document.getElementById('cl-appointment-form');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        const status = document.getElementById('cl-form-status');
        const formData = new FormData(form);
        const payload = {
          name: formData.get('name'),
          phone: formData.get('phone'),
          email: formData.get('email'),
          sessionType: `Private Styling Consultation (${formData.get('location')})`,
          scheduledAt: new Date(Date.now() + 86400000 * 2).toISOString(),
          status: 'Inquiry Received',
          source: 'carleenligoziollc-fl.com Overlay Concierge',
          notes: `Submitted via consumer advisory overlay on ${CONFIG.domain}`
        };

        if (status) status.textContent = 'Transmitting request to Carleen Ligozio...';

        // Dispatch to Automation Backend if available
        fetch(CONFIG.backendApi + '/trigger-workflow', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + CONFIG.clientToken
          },
          body: JSON.stringify({
            workflowId: 'wf_cl_launch',
            leadData: payload
          })
        })
        .then(function (res) {
          if (status) status.textContent = '✓ Request received! Boutique staff will contact you shortly.';
          form.reset();
        })
        .catch(function () {
          // Graceful fallback to client-side storage + mailto
          try {
            const saved = JSON.parse(localStorage.getItem('cl_advisory_inquiries') || '[]');
            saved.push(payload);
            localStorage.setItem('cl_advisory_inquiries', JSON.stringify(saved));
          } catch (_) {}
          if (status) status.textContent = '✓ Logged. Opening email client...';
          window.location.href = `mailto:${CONFIG.ownerEmail}?cc=${CONFIG.agencyEmail}&subject=Appointment%20Request%20from%20${encodeURIComponent(payload.name)}&body=Name:%20${encodeURIComponent(payload.name)}%0D%0APhone:%20${encodeURIComponent(payload.phone)}%0D%0AEmail:%20${encodeURIComponent(payload.email)}%0D%0ALocation:%20${encodeURIComponent(payload.sessionType)}`;
        });
      });
    }
  }

  // --- Consumer Protection: Intercept Checkout Buttons ---
  function attachCheckoutGuards() {
    const checkoutSelectors = [
      'a.checkout-button',
      '.wc-proceed-to-checkout a',
      'form.checkout button#place_order',
      '#place_order',
      '.single_add_to_cart_button',
      '.add_to_cart_button',
      '.wp-block-woocommerce-proceed-to-checkout-block a'
    ];

    document.addEventListener('click', function (e) {
      const target = e.target.closest(checkoutSelectors.join(', '));
      if (target) {
        e.preventDefault();
        e.stopPropagation();
        alert(
          'SECURITY ADVISORY:\n\n' +
          'This domain (carleenligoziollc-fl.com) is NOT an authorized store of Carleen Ligozio LLC.\n' +
          'Payment processing on this site is currently under formal abuse investigation (GoDaddy Case DCU102460176).\n\n' +
          'To avoid financial loss, please contact the legitimate boutique directly:\n' +
          'West Palm Beach: (561) 841-6097\n' +
          'Southampton: (631) 204-0104'
        );
        const backdrop = document.getElementById('cl-interstitial-backdrop');
        if (backdrop) backdrop.classList.remove('cl-hidden');
      }
    }, true);
  }

  // Execute on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountOverlay);
  } else {
    mountOverlay();
  }
})();
