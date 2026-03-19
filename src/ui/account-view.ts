/**
 * Account page — user email, wearable connection status, sync controls, sign out.
 */

import { supabase, getAccessToken, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_FUNCTIONS_BASE, isGarminConnected, resetGarminCache, isStravaConnected, resetStravaCache, refreshGarminToken } from '@/data/supabaseClient';
import { syncActivities, processPendingCrossTraining } from '@/data/activitySync';
import { syncStravaActivities, fetchStravaHistory, backfillStravaHistory } from '@/data/stravaSync';
import { syncPhysiologySnapshot } from '@/data/physiologySync';
import { syncAppleHealth } from '@/data/appleHealthSync';
import { renderAuthView } from './auth-view';
import { isSimulatorMode } from '@/main';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { getState, getMutableState, updateState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { initializeSimulator } from '@/state/initialization';

let garminConnected = false;
let stravaConnectedStatus = false;
let checkingStrava = false;
let lastSyncTime: string | null = null;
let garminExpiresAt: string | null = null;
let garminTokenExpired = false;
let lastGarminSyncDate: string | null = null;
let syncing = false;
let checkingGarmin = true;
let syncResultMsg = '';
let syncResultOk = true;
let _renderGen = 0; // guard against stale re-renders after navigation

/**
 * Render the account page into #app-root
 */
export async function renderAccountView(): Promise<void> {
  const container = document.getElementById('app-root');
  if (!container) return;

  const myGen = ++_renderGen;

  checkingGarmin = true;
  syncResultMsg = '';
  container.innerHTML = getAccountHTML();
  wireAccountHandlers();

  const s = getState();

  // Only check Garmin status when the user has a Garmin wearable (or no preference set yet)
  if (!isSimulatorMode() && s.wearable !== 'apple' && s.wearable !== 'strava') {
    await checkGarminStatus();
  }
  checkingGarmin = false;

  // Check Strava status for enrichment (Garmin users) or standalone
  if (!isSimulatorMode()) {
    checkingStrava = true;
    if (_renderGen !== myGen || !document.getElementById('btn-unit-km')) return;
    container.innerHTML = getAccountHTML();
    wireAccountHandlers();
    try {
      resetStravaCache();
      stravaConnectedStatus = await isStravaConnected();
    } catch {
      stravaConnectedStatus = false;
    }
    checkingStrava = false;
  }

  if (_renderGen !== myGen || !document.getElementById('btn-unit-km')) return;
  container.innerHTML = getAccountHTML();
  wireAccountHandlers();
}

async function checkGarminStatus(): Promise<void> {
  try {
    resetGarminCache();
    garminConnected = await isGarminConnected();
    if (garminConnected) {
      const token = await getAccessToken();

      // Fetch token info (created_at + expires_at)
      const res = await fetch(`${SUPABASE_URL}/rest/v1/garmin_tokens?select=created_at,expires_at&limit=1`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'apikey': SUPABASE_ANON_KEY,
        },
      });
      if (res.ok) {
        const rows = await res.json();
        lastSyncTime = rows?.[0]?.created_at ?? null;
        garminExpiresAt = rows?.[0]?.expires_at ?? null;
        garminTokenExpired = garminExpiresAt ? new Date(garminExpiresAt).getTime() < Date.now() : false;
      }

      // Fetch latest daily_metrics date as "last sync" indicator
      const metricsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/daily_metrics?select=day_date&order=day_date.desc&limit=1`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'apikey': SUPABASE_ANON_KEY,
          },
        },
      );
      if (metricsRes.ok) {
        const metricsRows = await metricsRes.json();
        lastGarminSyncDate = metricsRows?.[0]?.day_date ?? null;
      }
    } else {
      lastSyncTime = null;
      garminExpiresAt = null;
      garminTokenExpired = false;
      lastGarminSyncDate = null;
    }
  } catch {
    garminConnected = false;
    lastSyncTime = null;
    garminExpiresAt = null;
    garminTokenExpired = false;
    lastGarminSyncDate = null;
  }
}

function getUserEmail(): string {
  if (isSimulatorMode()) return 'Simulator mode';
  const sessionStr = localStorage.getItem('sb-' + new URL(SUPABASE_URL).hostname.split('.')[0] + '-auth-token');
  if (sessionStr) {
    try {
      const parsed = JSON.parse(sessionStr);
      const email = parsed?.user?.email ?? parsed?.currentSession?.user?.email;
      if (email) return email;
    } catch { /* ignore */ }
  }
  return 'Signed in';
}

// ─── Shared style helpers ─────────────────────────────────────────────────────

function sectionLabel(text: string, mt = 28): string {
  return `<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);padding:0 4px;margin-top:${mt}px;margin-bottom:8px">${text}</div>`;
}

function groupCard(rows: string): string {
  return `<div style="border-radius:13px;overflow:hidden;background:var(--c-surface);border:1px solid var(--c-border)">${rows}</div>`;
}

function rowDivider(ml = 16): string {
  return `<div style="height:1px;background:var(--c-border);margin-left:${ml}px"></div>`;
}

function chevron(): string {
  return `<svg width="14" height="14" fill="none" stroke="var(--c-faint)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" style="flex-shrink:0"><path d="M9 18l6-6-6-6"/></svg>`;
}

function statusDot(color: string): string {
  return `<div style="width:7px;height:7px;border-radius:50%;background:${color};flex-shrink:0"></div>`;
}

function iconBox(svg: string, bg: string): string {
  return `<div style="width:32px;height:32px;border-radius:9px;background:${bg};display:flex;align-items:center;justify-content:center;flex-shrink:0">${svg}</div>`;
}

function pillBtn(id: string, label: string, style: string): string {
  return `<button id="${id}" style="padding:7px 13px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0;${style}">${label}</button>`;
}

// ─── Main HTML ─────────────────────────────────────────────────────────────────

function getAccountHTML(): string {
  const s = getState();
  const email = getUserEmail();
  const sim = isSimulatorMode();
  const useApple = s.wearable === 'apple';
  const useStravaStandalone = s.wearable === 'strava';
  const useGarmin = !useApple && !useStravaStandalone;

  const tier = s.athleteTierOverride ?? s.athleteTier;
  const tierDisplay = tier ? (TIER_LABELS_ACCOUNT[tier] ?? tier) : null;

  const displayName = sim ? 'Simulator' : email;
  const initials = sim ? 'SIM'
    : email.includes('@') ? (email[0] + (email.split('@')[0][1] ?? '')).toUpperCase()
    : email.slice(0, 2).toUpperCase();

  return `
    <div class="mosaic-page" style="background:var(--c-bg)">

      <!-- Profile header -->
      <div style="padding:32px 20px 24px;display:flex;flex-direction:column;align-items:center;gap:6px">
        <div style="width:72px;height:72px;border-radius:50%;background:var(--c-black);display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:700;color:#fff;letter-spacing:-0.02em;flex-shrink:0">${initials}</div>
        <div style="font-size:17px;font-weight:600;color:var(--c-black);margin-top:8px">${displayName}</div>
        ${tierDisplay ? `<div style="font-size:12px;color:var(--c-muted);padding:3px 0">${tierDisplay}</div>` : ''}
        ${sim ? `<div style="font-size:12px;color:var(--c-muted);padding:2px 0">Simulator Mode</div>` : ''}
      </div>

      <div style="padding:0 16px 90px">

        ${renderPendingAlert()}

        ${sectionLabel('Connected Apps', 4)}
        ${groupCard(
          (useApple ? renderAppleRow() : useStravaStandalone ? renderStravaStandaloneRow() : renderGarminRow()) +
          (useGarmin ? rowDivider(60) + renderStravaEnrichRow() : '')
        )}

        ${sectionLabel('Profile')}
        ${renderProfileGroup()}

        ${sectionLabel('Preferences')}
        ${renderPreferencesGroup()}

        ${(s.stravaConnected || s.stravaHistoryFetched) ? sectionLabel('Training History') + renderTrainingHistoryGroup() : ''}

        ${sectionLabel('Plan')}
        ${groupCard(`
          <button id="btn-edit-plan" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:15px 16px;background:none;border:none;cursor:pointer;text-align:left">
            <span style="font-size:15px;color:var(--c-black)">Edit Plan</span>
            ${chevron()}
          </button>
        `)}

        ${sectionLabel('Advanced')}
        ${groupCard(`
          <button id="btn-reset-vdot" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:15px 16px;background:none;border:none;cursor:pointer;text-align:left;gap:12px">
            <div>
              <div style="font-size:15px;color:var(--c-black);text-align:left">Reset VDOT</div>
              <div style="font-size:12px;color:var(--c-muted);margin-top:2px;text-align:left">Recalibrates from your next training data</div>
            </div>
            ${chevron()}
          </button>
          ${rowDivider()}
          ${renderRecoverPlanRow()}
          ${rowDivider()}
          <button id="btn-reset-plan" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:15px 16px;background:none;border:none;cursor:pointer;text-align:left">
            <span style="font-size:15px;color:#dc2626">Reset Plan</span>
            ${chevron()}
          </button>
        `)}

        <div id="garmin-error" style="font-size:12px;color:var(--c-warn);margin-top:8px;display:none;padding:0 4px"></div>

        <!-- Sign Out -->
        <div style="margin-top:28px">
          ${sim ? `
            <button id="btn-exit-simulator" style="width:100%;padding:15px;border-radius:13px;border:1px solid var(--c-border);background:transparent;font-size:15px;font-weight:500;color:var(--c-muted);cursor:pointer">
              Exit Simulator Mode
            </button>
          ` : `
            <button id="btn-sign-out" style="width:100%;padding:15px;border-radius:13px;border:none;background:none;font-size:15px;font-weight:500;color:#dc2626;cursor:pointer">
              Sign Out
            </button>
          `}
        </div>

      </div>
      ${renderTabBar('account', sim)}
    </div>
  `;
}

// ─── Connected App Rows ────────────────────────────────────────────────────────

function renderGarminRow(): string {
  const connected = garminConnected;
  const expired = garminTokenExpired && !checkingGarmin;
  const dotColor = expired ? 'var(--c-warn)' : connected ? 'var(--c-ok)' : 'var(--c-faint)';
  const sub = checkingGarmin ? 'Checking…'
    : expired ? 'Token expired — reconnect'
    : connected ? (lastGarminSyncDate ? `Connected · last sync ${lastGarminSyncDate}` : 'Connected')
    : 'Not connected';

  return `
    <div style="padding:14px 16px;display:flex;align-items:center;gap:12px">
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:500;color:var(--c-black)">Garmin Connect</div>
        <div style="display:flex;align-items:center;gap:5px;margin-top:2px">
          ${statusDot(dotColor)}
          <span style="font-size:12px;color:var(--c-muted)">${sub}</span>
        </div>
      </div>
      ${!connected && !checkingGarmin
        ? pillBtn('btn-connect-garmin', 'Connect', 'border:1px solid var(--c-border-strong);background:transparent;color:var(--c-black);')
        : connected ? `<div style="display:flex;gap:8px;align-items:center">
            ${pillBtn('btn-sync-now', syncing ? 'Syncing…' : 'Sync', `border:1px solid var(--c-border);background:transparent;color:var(--c-muted);opacity:${syncing ? '0.5' : '1'};`)}
            <button id="btn-disconnect-garmin" style="background:none;border:none;font-size:12px;font-weight:500;color:#dc2626;cursor:pointer;padding:4px 2px">Remove</button>
          </div>` : ''}
    </div>
    ${syncResultMsg && connected ? `<div style="padding:0 16px 10px 60px;font-size:12px;color:${syncResultOk ? 'var(--c-ok)' : 'var(--c-warn)'}">${syncResultMsg}</div>` : ''}
  `;
}

function renderAppleRow(): string {
  return `
    <div style="padding:14px 16px;display:flex;align-items:center;gap:12px">
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:500;color:var(--c-black)">Apple Watch</div>
        <div style="display:flex;align-items:center;gap:5px;margin-top:2px">
          ${statusDot('var(--c-ok)')}
          <span style="font-size:12px;color:var(--c-muted)">Syncs automatically</span>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        ${pillBtn('btn-sync-apple', syncing ? 'Syncing…' : 'Sync', `border:1px solid var(--c-border);background:transparent;color:var(--c-muted);opacity:${syncing ? '0.5' : '1'};`)}
        <button id="btn-switch-device" style="background:none;border:none;font-size:12px;font-weight:500;color:var(--c-muted);cursor:pointer;padding:4px 2px">Change</button>
      </div>
    </div>
    ${syncResultMsg ? `<div style="padding:0 16px 10px 60px;font-size:12px;color:${syncResultOk ? 'var(--c-ok)' : 'var(--c-warn)'}">${syncResultMsg}</div>` : ''}
  `;
}

function renderStravaStandaloneRow(): string {
  const dotColor = stravaConnectedStatus ? 'var(--c-ok)' : 'var(--c-faint)';
  const sub = checkingStrava ? 'Checking…' : stravaConnectedStatus ? 'Connected · auto-syncs on launch' : 'Not connected';
  return `
    <div style="padding:14px 16px;display:flex;align-items:center;gap:12px">
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:500;color:var(--c-black)">Strava</div>
        <div style="display:flex;align-items:center;gap:5px;margin-top:2px">
          ${statusDot(dotColor)}
          <span style="font-size:12px;color:var(--c-muted)">${sub}</span>
        </div>
      </div>
      ${!stravaConnectedStatus && !checkingStrava
        ? pillBtn('btn-connect-strava', 'Connect', 'border:1px solid var(--c-border-strong);background:transparent;color:var(--c-black);')
        : stravaConnectedStatus ? `<div style="display:flex;gap:8px;align-items:center">
            ${pillBtn('btn-sync-strava', syncing ? 'Syncing…' : 'Sync', `border:1px solid var(--c-border);background:transparent;color:var(--c-muted);opacity:${syncing ? '0.5' : '1'};`)}
            <button id="btn-disconnect-strava" style="background:none;border:none;font-size:12px;font-weight:500;color:#dc2626;cursor:pointer;padding:4px 2px">Remove</button>
          </div>` : ''}
    </div>
    ${syncResultMsg && stravaConnectedStatus ? `<div style="padding:0 16px 10px 60px;font-size:12px;color:${syncResultOk ? 'var(--c-ok)' : 'var(--c-warn)'}">${syncResultMsg}</div>` : ''}
  `;
}

function renderStravaEnrichRow(): string {
  const dotColor = stravaConnectedStatus ? 'var(--c-ok)' : 'var(--c-faint)';
  const sub = checkingStrava ? 'Checking…' : stravaConnectedStatus ? 'Connected · HR enrichment active' : 'Not connected — add for accurate load';
  return `
    <div style="padding:14px 16px;display:flex;align-items:center;gap:12px">
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:500;color:var(--c-black)">Strava</div>
        <div style="display:flex;align-items:center;gap:5px;margin-top:2px">
          ${statusDot(dotColor)}
          <span style="font-size:12px;color:var(--c-muted)">${sub}</span>
        </div>
      </div>
      ${!stravaConnectedStatus && !checkingStrava
        ? pillBtn('btn-connect-strava', 'Connect', 'border:1px solid var(--c-border-strong);background:transparent;color:var(--c-black);')
        : stravaConnectedStatus ? `<div style="display:flex;gap:8px;align-items:center">
            ${pillBtn('btn-sync-strava-hr', syncing ? 'Syncing…' : 'Sync', `border:1px solid var(--c-border);background:transparent;color:var(--c-muted);opacity:${syncing ? '0.5' : '1'};`)}
            <button id="btn-disconnect-strava" style="background:none;border:none;font-size:12px;font-weight:500;color:#dc2626;cursor:pointer;padding:4px 2px">Remove</button>
          </div>` : ''}
    </div>
    ${syncResultMsg && stravaConnectedStatus ? `<div style="padding:0 16px 10px 60px;font-size:12px;color:${syncResultOk ? 'var(--c-ok)' : 'var(--c-warn)'}">${syncResultMsg}</div>` : ''}
  `;
}

// ─── Profile Group ─────────────────────────────────────────────────────────────

function renderProfileGroup(): string {
  const s = getState();
  const pbs = s.pbs || {};

  const fmtTime = (secs: number | undefined): string => {
    if (!secs) return '—';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const sec = secs % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  const genderLabel = s.biologicalSex === 'male' ? 'Male'
    : s.biologicalSex === 'female' ? 'Female'
    : 'Not set';

  const pbItems = [
    { label: '5K', val: pbs.k5 },
    { label: '10K', val: pbs.k10 },
    { label: 'HM', val: pbs.h },
    { label: 'Marathon', val: pbs.m },
  ].filter(pb => pb.val);

  const pbSection = pbItems.length > 0 ? `
    ${rowDivider()}
    <div style="padding:14px 16px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.07em;color:var(--c-faint);margin-bottom:10px">Personal Bests</div>
      <div style="display:grid;grid-template-columns:repeat(${Math.min(pbItems.length, 4)},1fr);gap:8px">
        ${pbItems.map(pb => `
          <div style="border:1px solid var(--c-border);border-radius:10px;padding:10px 6px;text-align:center">
            <div style="font-size:11px;color:var(--c-muted);margin-bottom:3px">${pb.label}</div>
            <div style="font-size:15px;font-weight:700;color:var(--c-black)">${fmtTime(pb.val)}</div>
          </div>
        `).join('')}
      </div>
    </div>` : '';

  return groupCard(`
    <div style="padding:14px 16px;display:flex;align-items:center;justify-content:space-between">
      <span style="font-size:15px;color:var(--c-black)">Gender</span>
      <span style="font-size:15px;color:var(--c-muted)">${genderLabel}</span>
    </div>
    ${rowDivider()}
    <div style="padding:14px 16px;display:flex;align-items:center;justify-content:space-between">
      <span style="font-size:15px;color:var(--c-black)">Runner type</span>
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:15px;color:var(--c-muted)">${s.typ || '—'}</span>
        <button id="btn-change-runner-type" style="font-size:13px;font-weight:600;color:var(--c-accent);background:none;border:none;cursor:pointer;padding:0">Change</button>
      </div>
    </div>
    ${pbSection}
    ${rowDivider()}
    <button id="btn-edit-profile" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:none;border:none;cursor:pointer">
      <span style="font-size:15px;color:var(--c-accent)">Edit Profile</span>
      ${chevron()}
    </button>
  `);
}

// ─── Pending Alert ─────────────────────────────────────────────────────────────

function renderPendingAlert(): string {
  const s = getState();
  const wk = s.wks?.[s.w - 1];
  if (!wk?.garminPending?.length) return '';

  const unprocessed = wk.garminPending.filter(item => {
    const matched = wk.garminMatched?.[item.garminId];
    return !matched || matched === '__pending__';
  });
  if (unprocessed.length === 0) return '';

  return `
    <div style="margin-bottom:4px;background:var(--c-surface);border:1px solid var(--c-border);border-radius:13px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div>
        <div style="font-size:14px;font-weight:600;color:var(--c-black)">${unprocessed.length} activit${unprocessed.length === 1 ? 'y' : 'ies'} to review</div>
        <div style="font-size:12px;color:var(--c-muted);margin-top:2px">Week ${s.w} · not yet matched to your plan</div>
      </div>
      <button id="btn-review-pending" style="padding:9px 16px;border-radius:9px;background:var(--c-black);color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;flex-shrink:0">Review</button>
    </div>
  `;
}

const TIER_LABELS_ACCOUNT: Record<string, string> = {
  beginner:     'New to structured training',
  recreational: 'Recreational runner',
  trained:      'Trained runner',
  performance:  'Performance athlete',
  high_volume:  'High-volume athlete',
};

// ─── Training History Group ────────────────────────────────────────────────────

function renderTrainingHistoryGroup(): string {
  const s = getState();
  const hasFetched = !!s.stravaHistoryFetched;
  const tier = s.athleteTierOverride ?? s.athleteTier;
  const tierLabel = tier ? (TIER_LABELS_ACCOUNT[tier] ?? tier) : null;
  const avgKm = s.detectedWeeklyKm;
  const avgTSS = s.historicWeeklyTSS?.length
    ? Math.round(s.historicWeeklyTSS.reduce((a, b) => a + b, 0) / s.historicWeeklyTSS.length)
    : null;
  const accepted = !!s.stravaHistoryAccepted;

  if (!hasFetched) {
    return groupCard(`
      <div style="padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div>
          <div style="font-size:15px;color:var(--c-black)">Strava History</div>
          <div style="font-size:12px;color:var(--c-muted);margin-top:2px">Not yet loaded</div>
        </div>
        ${pillBtn('btn-fetch-history', 'Load', 'border:1px solid var(--c-border-strong);background:transparent;color:var(--c-black);')}
      </div>
    `);
  }

  const rows = [
    avgTSS !== null ? `
      <div style="padding:14px 16px;display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:15px;color:var(--c-black)">Avg weekly load</span>
        <span style="font-size:15px;color:var(--c-muted)">${avgTSS} <span style="font-size:12px">TSS/wk</span></span>
      </div>` : '',
    avgKm !== null ? `
      <div style="padding:14px 16px;display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:15px;color:var(--c-black)">Running volume</span>
        <span style="font-size:15px;color:var(--c-muted)">${s.unitPref === 'mi' ? ((avgKm ?? 0) * 0.621371).toFixed(0) : avgKm} <span style="font-size:12px">${s.unitPref === 'mi' ? 'mi' : 'km'}/wk</span></span>
      </div>` : '',
    tierLabel ? `
      <div style="padding:14px 16px;display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:15px;color:var(--c-black)">Fitness tier</span>
        <div style="display:flex;align-items:center;gap:8px">
          ${accepted ? `<span style="font-size:11px;font-weight:600;color:var(--c-ok)">✓ Applied</span>` : ''}
          <span style="font-size:15px;color:var(--c-muted)">${tierLabel}</span>
        </div>
      </div>` : '',
  ].filter(Boolean);

  const dataRows = rows.join(rowDivider());

  return groupCard(`
    ${dataRows}
    ${dataRows ? rowDivider() : ''}
    <div style="padding:12px 16px;display:flex;flex-direction:column;gap:8px">
      <button id="btn-rebuild-plan" style="width:100%;padding:11px;border-radius:10px;background:transparent;border:1px solid var(--c-border-strong);font-size:14px;font-weight:600;color:var(--c-black);cursor:pointer">
        Rebuild Plan from Strava Data
      </button>
      <button id="btn-refresh-history" style="width:100%;padding:9px;border-radius:10px;background:transparent;border:1px solid var(--c-border);font-size:13px;color:var(--c-muted);cursor:pointer">
        Sync History (last 16 weeks)
      </button>
      <div style="font-size:11px;color:var(--c-faint);line-height:1.5">Your logged activities and ratings are preserved when rebuilding.</div>
    </div>
  `);
}

// ─── Preferences Group ─────────────────────────────────────────────────────────

function renderPreferencesGroup(): string {
  const s = getState();
  return groupCard(`
    <div style="padding:13px 16px;display:flex;align-items:center;justify-content:space-between">
      <span style="font-size:15px;color:var(--c-black)">Distance</span>
      <div style="display:flex;border:1px solid var(--c-border-strong);border-radius:8px;overflow:hidden">
        <button id="btn-unit-km"
          style="padding:6px 16px;font-size:13px;font-weight:500;cursor:pointer;border:none;${(s.unitPref ?? 'km') === 'km' ? 'background:var(--c-black);color:#fff' : 'background:transparent;color:var(--c-muted)'}">km</button>
        <button id="btn-unit-mi"
          style="padding:6px 16px;font-size:13px;font-weight:500;cursor:pointer;border:none;${s.unitPref === 'mi' ? 'background:var(--c-black);color:#fff' : 'background:transparent;color:var(--c-muted)'}">mi</button>
      </div>
    </div>
    ${rowDivider()}
    <div style="padding:13px 16px;display:flex;align-items:center;justify-content:space-between;gap:16px">
      <label for="input-max-hr" style="font-size:15px;color:var(--c-black);white-space:nowrap">Max HR</label>
      <div style="display:flex;align-items:center;gap:6px">
        <input id="input-max-hr" type="number" min="100" max="240"
          value="${s.maxHR ?? ''}" placeholder="190"
          style="width:72px;padding:7px 10px;border:1px solid var(--c-border);border-radius:8px;font-size:14px;text-align:right;background:transparent;color:var(--c-black)">
        <span style="font-size:13px;color:var(--c-muted)">bpm</span>
      </div>
    </div>
    ${rowDivider()}
    <div style="padding:13px 16px;display:flex;align-items:center;justify-content:space-between;gap:16px">
      <label for="input-resting-hr" style="font-size:15px;color:var(--c-black);white-space:nowrap">Resting HR</label>
      <div style="display:flex;align-items:center;gap:6px">
        <input id="input-resting-hr" type="number" min="30" max="100"
          value="${s.restingHR ?? ''}" placeholder="55"
          style="width:72px;padding:7px 10px;border:1px solid var(--c-border);border-radius:8px;font-size:14px;text-align:right;background:transparent;color:var(--c-black)">
        <span style="font-size:13px;color:var(--c-muted)">bpm</span>
      </div>
    </div>
    ${rowDivider()}
    <div style="padding:12px 16px;display:flex;justify-content:flex-end">
      <button id="btn-save-hr" style="padding:8px 18px;border-radius:8px;background:transparent;border:1px solid var(--c-border-strong);font-size:13px;font-weight:600;color:var(--c-black);cursor:pointer">
        Save
      </button>
    </div>
  `);
}

// ─── Recover Plan Row (inside Advanced group) ──────────────────────────────────

function renderRecoverPlanRow(): string {
  const s = getState();
  const currentWeek = s.w || 1;
  const currentStart = s.planStartDate || '';

  let suggestedStart = currentStart;
  if (!suggestedStart || suggestedStart === new Date().toISOString().slice(0, 10)) {
    const d = new Date();
    d.setDate(d.getDate() - (currentWeek - 1) * 7);
    suggestedStart = d.toISOString().slice(0, 10);
  }

  return `
    <details style="overflow:hidden">
      <summary style="padding:15px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;list-style:none;cursor:pointer">
        <div>
          <div style="font-size:15px;color:var(--c-black);text-align:left">Recover Plan</div>
          <div style="font-size:12px;color:var(--c-muted);margin-top:2px;text-align:left">Restore progress if plan was reset</div>
        </div>
        ${chevron()}
      </summary>
      <div style="padding:0 16px 16px;border-top:1px solid var(--c-border)">
        <div style="font-size:12px;color:var(--c-muted);line-height:1.5;margin:12px 0">
          Enter the date your plan originally started and the week you were on. Activities from the last 28 days will re-sync.
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
            <label style="font-size:13px;color:var(--c-muted);flex-shrink:0">Plan started</label>
            <input type="date" id="recovery-start-date"
              style="background:var(--c-faint);color:var(--c-black);font-size:13px;border-radius:8px;padding:7px 10px;border:1px solid var(--c-border-strong)"
              value="${suggestedStart}">
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
            <label style="font-size:13px;color:var(--c-muted);flex-shrink:0">I was on week</label>
            <input type="number" id="recovery-week" min="1" max="52"
              style="background:var(--c-faint);color:var(--c-black);font-size:13px;border-radius:8px;padding:7px 10px;border:1px solid var(--c-border-strong);width:64px;text-align:center"
              value="${currentWeek}">
          </div>
        </div>
        <div id="recovery-result" style="font-size:12px;display:none;margin-top:8px"></div>
        <button id="btn-recover-plan" style="width:100%;margin-top:10px;padding:11px;border-radius:10px;background:transparent;border:1px solid var(--c-border-strong);font-size:14px;font-weight:600;color:var(--c-black);cursor:pointer">
          Restore &amp; Re-sync
        </button>
        ${s.w > 1 ? `
          <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--c-border)">
            <div style="font-size:12px;color:var(--c-muted);line-height:1.5;margin-bottom:8px">
              Need to re-review Week ${s.w - 1}? Roll back one week so the review screen reappears.
            </div>
            <div id="rewind-result" style="font-size:12px;display:none;margin-bottom:6px"></div>
            <button id="btn-rewind-week" style="width:100%;padding:9px;border-radius:10px;background:transparent;border:1px solid var(--c-border);font-size:13px;font-weight:500;color:var(--c-black);cursor:pointer">
              Re-review Week ${s.w - 1}
            </button>
          </div>
        ` : ''}
      </div>
    </details>
  `;
}

function setUnitButtonActive(pref: 'km' | 'mi'): void {
  const kmBtn = document.getElementById('btn-unit-km') as HTMLButtonElement | null;
  const miBtn = document.getElementById('btn-unit-mi') as HTMLButtonElement | null;
  if (!kmBtn || !miBtn) return;
  const activeStyle = 'background:var(--c-black);color:#fff';
  const inactiveStyle = 'background:transparent;color:var(--c-muted)';
  kmBtn.style.cssText = `padding:6px 16px;font-size:13px;font-weight:500;cursor:pointer;border:none;${pref === 'km' ? activeStyle : inactiveStyle}`;
  miBtn.style.cssText = `padding:6px 16px;font-size:13px;font-weight:500;cursor:pointer;border:none;${pref === 'mi' ? activeStyle : inactiveStyle}`;
}

function wireAccountHandlers(): void {
  // Tab bar navigation
  wireTabBarHandlers((tab: TabId) => {
    if (tab === 'home') {
      import('./home-view').then(({ renderHomeView }) => renderHomeView());
    } else if (tab === 'plan') {
      import('./plan-view').then(({ renderPlanView }) => renderPlanView());
    } else if (tab === 'record') {
      import('./record-view').then(({ renderRecordView }) => renderRecordView());
    } else if (tab === 'stats') {
      import('./stats-view').then(({ renderStatsView }) => renderStatsView());
    }
  });

  document.getElementById('btn-sign-out')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    renderAuthView();
  });

  document.getElementById('btn-save-hr')?.addEventListener('click', () => {
    const maxHRInput = (document.getElementById('input-max-hr') as HTMLInputElement)?.value;
    const restingHRInput = (document.getElementById('input-resting-hr') as HTMLInputElement)?.value;
    const maxHR = maxHRInput ? +maxHRInput : null;
    const restingHR = restingHRInput ? +restingHRInput : null;
    if (maxHR !== null && (maxHR < 100 || maxHR > 240)) { alert('Max HR must be between 100 and 240'); return; }
    if (restingHR !== null && (restingHR < 30 || restingHR > 100)) { alert('Resting HR must be between 30 and 100'); return; }
    const s = getMutableState();
    if (maxHR !== null) s.maxHR = maxHR;
    if (restingHR !== null) s.restingHR = restingHR;
    saveState();
    const btn = document.getElementById('btn-save-hr') as HTMLButtonElement;
    if (btn) { btn.textContent = 'Saved'; btn.disabled = true; setTimeout(() => { btn.textContent = 'Save HR values'; btn.disabled = false; }, 2000); }
  });

  document.getElementById('btn-unit-km')?.addEventListener('click', () => {
    getMutableState().unitPref = 'km';
    saveState();
    setUnitButtonActive('km');
  });

  document.getElementById('btn-unit-mi')?.addEventListener('click', () => {
    getMutableState().unitPref = 'mi';
    saveState();
    setUnitButtonActive('mi');
  });

  document.getElementById('btn-edit-plan')?.addEventListener('click', () => {
    import('./events').then(({ editSettings }) => editSettings());
  });

  document.getElementById('btn-reset-plan')?.addEventListener('click', () => {
    import('./events').then(({ reset }) => reset());
  });

  document.getElementById('btn-reset-vdot')?.addEventListener('click', () => {
    const btn = document.getElementById('btn-reset-vdot') as HTMLButtonElement | null;
    const s = getMutableState();
    s.physioAdj = 0;
    saveState();
    if (btn) {
      const original = btn.textContent ?? 'Reset VDOT calibration';
      btn.textContent = 'VDOT calibration reset. Your score will update with your next training data.';
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = original;
        btn.disabled = false;
      }, 3000);
    }
  });

  // Strava history: Fetch or refresh
  document.getElementById('btn-fetch-history')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-fetch-history') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    await backfillStravaHistory(16).catch(() => {});
    renderAccountView();
  });

  document.getElementById('btn-refresh-history')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-refresh-history') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = 'Syncing from Strava…'; }
    const result = await backfillStravaHistory(16).catch(() => null);
    if (btn && result) {
      btn.textContent = result.processed > 0
        ? `Synced ${result.processed} activities ✓`
        : 'Up to date ✓';
    }
    renderAccountView();
  });

  // Phase C3: Rebuild plan using Strava history data
  document.getElementById('btn-rebuild-plan')?.addEventListener('click', () => {
    const s = getState();
    if (!s.onboarding) {
      alert('Onboarding data not found — cannot rebuild plan.');
      return;
    }

    const avgKm = s.detectedWeeklyKm;
    const tierLabel = s.athleteTier ? (TIER_LABELS_ACCOUNT[s.athleteTier] ?? s.athleteTier) : 'your detected level';

    const msg = `Rebuild your training plan?\n\n` +
      `Your logged activities and ratings will be preserved.\n` +
      `Only the unstarted workout plan will be rebuilt.\n\n` +
      (avgKm ? `Plan will start at ~${s.unitPref === 'mi' ? (avgKm * 0.621371).toFixed(0) : avgKm}${s.unitPref === 'mi' ? 'mi' : 'km'}/week (${tierLabel}).\n` : '');

    if (!confirm(msg)) return;

    // Capture existing activity data before overwriting
    const oldWks = (s.wks ?? []).map(wk => ({
      garminActuals: wk.garminActuals,
      garminMatched: wk.garminMatched,
      actualTSS: wk.actualTSS,
      rated: wk.rated,
    }));

    // Accept the history and rebuild
    const ms = getMutableState();
    ms.stravaHistoryAccepted = true;
    saveState();

    const result = initializeSimulator(s.onboarding);
    if (!result.success) {
      alert(`Rebuild failed: ${result.error || 'unknown error'}`);
      return;
    }

    // Re-patch preserved activity data onto rebuilt weeks
    const freshState = getMutableState();
    for (let i = 0; i < Math.min(freshState.wks?.length ?? 0, oldWks.length); i++) {
      const old = oldWks[i];
      if (old.garminActuals && Object.keys(old.garminActuals).length > 0) {
        freshState.wks[i].garminActuals = old.garminActuals;
        freshState.wks[i].garminMatched = old.garminMatched;
        freshState.wks[i].actualTSS = old.actualTSS;
        freshState.wks[i].rated = old.rated;
      }
    }
    saveState();

    import('./home-view').then(({ renderHomeView }) => renderHomeView());
  });

  document.getElementById('btn-exit-simulator')?.addEventListener('click', () => {
    localStorage.removeItem('mosaic_simulator_mode');
    window.location.reload();
  });

  // Garmin: Connect
  document.getElementById('btn-connect-garmin')?.addEventListener('click', async () => {
    const errorEl = document.getElementById('garmin-error');
    try {
      const token = await getAccessToken();
      const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/garmin-auth-start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'apikey': SUPABASE_ANON_KEY,
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (errorEl) {
          errorEl.textContent = `Failed to start Garmin auth (${res.status}): ${text}`;
          errorEl.classList.remove('hidden');
        }
        return;
      }
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'SESSION_EXPIRED') {
        if (errorEl) {
          errorEl.innerHTML = `Session expired — please <a href="#" id="garmin-sign-in-link" class="underline text-blue-400">sign in again</a>`;
          errorEl.classList.remove('hidden');
          document.getElementById('garmin-sign-in-link')?.addEventListener('click', (e) => {
            e.preventDefault();
            supabase.auth.signOut().then(() => renderAuthView());
          });
        }
      } else if (errorEl) {
        errorEl.textContent = `Garmin auth error: ${err instanceof Error ? err.message : 'Unknown error'}`;
        errorEl.classList.remove('hidden');
      }
    }
  });

  // Garmin: Disconnect
  document.getElementById('btn-disconnect-garmin')?.addEventListener('click', async () => {
    try {
      const token = await getAccessToken();
      await fetch(`${SUPABASE_URL}/rest/v1/garmin_tokens?user_id=eq.${encodeURIComponent((await supabase.auth.getUser()).data.user!.id)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON_KEY },
      });
      resetGarminCache();
      garminConnected = false;
      updateState({ wearable: undefined });
      saveState();
      const container = document.getElementById('app-root');
      if (container) { container.innerHTML = getAccountHTML(); wireAccountHandlers(); }
    } catch (err) {
      console.error('Disconnect failed', err);
    }
  });

  // Sync Now — routes to Strava (activities) or Garmin (activities + biometrics)
  document.getElementById('btn-sync-now')?.addEventListener('click', async () => {
    if (syncing) return;
    syncing = true;
    syncResultMsg = '';
    rerender();

    try {
      const sNow = getState();
      if (sNow.stravaConnected) {
        const syncs: Promise<unknown>[] = [syncStravaActivities()];
        if (sNow.wearable === 'garmin') syncs.push(syncPhysiologySnapshot(7));
        await Promise.all(syncs);
      } else {
        await Promise.all([syncActivities(), syncPhysiologySnapshot(7)]);
      }
      syncResultMsg = 'Sync complete — check your plan for updated activities.';
      syncResultOk = true;
    } catch (err) {
      syncResultMsg = `Sync failed: ${err instanceof Error ? err.message : 'check your connection'}`;
      syncResultOk = false;
    } finally {
      syncing = false;
      rerender();
    }
  });

  // Apple Watch: Sync Now
  document.getElementById('btn-sync-apple')?.addEventListener('click', async () => {
    if (syncing) return;
    syncing = true;
    syncResultMsg = '';
    rerender();

    try {
      await syncAppleHealth();
      syncResultMsg = 'Sync complete — check your plan for updated activities.';
      syncResultOk = true;
    } catch (err) {
      syncResultMsg = `Sync failed: ${err instanceof Error ? err.message : 'check your connection'}`;
      syncResultOk = false;
    } finally {
      syncing = false;
      rerender();
    }
  });

  // Re-review pending activities
  document.getElementById('btn-review-pending')?.addEventListener('click', () => {
    // Navigate back to Plan tab first so the review modal renders over the correct view
    import('./plan-view').then(({ renderPlanView }) => {
      renderPlanView();
      // Small delay to let the plan view mount before showing the modal
      setTimeout(() => processPendingCrossTraining(), 150);
    });
  });

  // Plan Recovery
  document.getElementById('btn-recover-plan')?.addEventListener('click', () => {
    const dateInput = document.getElementById('recovery-start-date') as HTMLInputElement;
    const weekInput = document.getElementById('recovery-week') as HTMLInputElement;
    const resultEl = document.getElementById('recovery-result');

    const startDate = dateInput?.value;
    const week = parseInt(weekInput?.value || '1', 10);

    if (!startDate) {
      if (resultEl) { resultEl.textContent = 'Please enter the original plan start date.'; resultEl.className = 'text-xs text-red-400'; resultEl.classList.remove('hidden'); }
      return;
    }
    if (isNaN(week) || week < 1) {
      if (resultEl) { resultEl.textContent = 'Week must be 1 or higher.'; resultEl.className = 'text-xs text-red-400'; resultEl.classList.remove('hidden'); }
      return;
    }

    updateState({
      planStartDate: startDate,
      w: week,
      hasCompletedOnboarding: true,
    });
    // Clear garminMatched across all weeks so re-sync can re-process everything
    const ms = getMutableState();
    if (ms.wks) {
      for (const wk of ms.wks) {
        wk.garminMatched = {};
        wk.garminActuals = {};
        wk.garminPending = [];
      }
    }
    saveState();

    if (resultEl) { resultEl.textContent = 'Plan restored! Reloading and re-syncing...'; resultEl.className = 'text-xs text-emerald-400'; resultEl.classList.remove('hidden'); }
    setTimeout(() => window.location.reload(), 800);
  });

  // Re-review previous week
  document.getElementById('btn-rewind-week')?.addEventListener('click', () => {
    const resultEl = document.getElementById('rewind-result');
    const s = getState();
    if (s.w <= 1) return;

    const prevWeekIdx = s.w - 2; // 0-indexed
    const ms = getMutableState();
    const prevWk = ms.wks?.[prevWeekIdx];

    if (prevWk) {
      // Clear all Garmin-sourced data so the re-sync queues items for review
      prevWk.garminMatched = {};
      prevWk.garminActuals = {};
      prevWk.garminPending = [];
      // Remove only Garmin-sourced adhoc workouts (id starts with 'garmin-')
      if (prevWk.adhocWorkouts) {
        prevWk.adhocWorkouts = prevWk.adhocWorkouts.filter(w => !w.id?.startsWith('garmin-'));
      }
      // Remove Garmin workout ratings so runs are unrated again
      if (prevWk.rated) {
        for (const key of Object.keys(prevWk.rated)) {
          if (key.startsWith('garmin-')) delete prevWk.rated[key];
        }
      }
    }

    // Step back one week so sync treats the previous week as current.
    // Also shift planStartDate back 7 days so that week's activities
    // fall within the plan date range (fixes the case where planStartDate
    // was reset to today and previous-week activities get skipped).
    ms.w = s.w - 1;
    if (ms.planStartDate) {
      const d = new Date(ms.planStartDate);
      d.setDate(d.getDate() - 7);
      ms.planStartDate = d.toISOString().slice(0, 10);
    }
    ms.hasCompletedOnboarding = true;
    saveState();

    if (resultEl) {
      resultEl.textContent = `Stepping back to Week ${ms.w} — reloading and re-syncing...`;
      resultEl.className = 'text-xs text-emerald-400';
      resultEl.classList.remove('hidden');
    }
    setTimeout(() => window.location.reload(), 800);
  });

  // Switch device (clears wearable preference)
  document.getElementById('btn-switch-device')?.addEventListener('click', () => {
    updateState({ wearable: undefined });
    saveState();
    rerender();
  });

  // Strava: Connect (shared by both standalone and enrich cards)
  document.getElementById('btn-connect-strava')?.addEventListener('click', async () => {
    try {
      const token = await getAccessToken();
      const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/strava-auth-start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'apikey': SUPABASE_ANON_KEY,
        },
      });
      if (!res.ok) {
        console.error('Strava auth start failed', res.status);
        return;
      }
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err) {
      console.error('Strava connect error', err);
    }
  });

  // Strava: Disconnect
  document.getElementById('btn-disconnect-strava')?.addEventListener('click', async () => {
    try {
      const token = await getAccessToken();
      const userId = (await supabase.auth.getUser()).data.user?.id;
      if (userId) {
        await fetch(`${SUPABASE_URL}/rest/v1/strava_tokens?user_id=eq.${encodeURIComponent(userId)}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON_KEY },
        });
      }
      resetStravaCache();
      stravaConnectedStatus = false;
      updateState({ stravaConnected: false });
      saveState();
      rerender();
    } catch (err) {
      console.error('Strava disconnect failed', err);
    }
  });

  // Strava: Sync Now (standalone)
  document.getElementById('btn-sync-strava')?.addEventListener('click', async () => {
    if (syncing) return;
    syncing = true;
    syncResultMsg = '';
    rerender();
    try {
      await syncStravaActivities();
      syncResultMsg = 'Sync complete — check your plan for updated activities.';
      syncResultOk = true;
    } catch (err) {
      syncResultMsg = `Sync failed: ${err instanceof Error ? err.message : 'check your connection'}`;
      syncResultOk = false;
    } finally {
      syncing = false;
      rerender();
    }
  });

  // Strava: Re-sync / pair (enrich)
  document.getElementById('btn-sync-strava-hr')?.addEventListener('click', async () => {
    if (syncing) return;
    syncing = true;
    syncResultMsg = '';
    rerender();
    try {
      const { processed } = await syncStravaActivities();
      if (processed > 0) {
        syncResultMsg = `${processed} activit${processed === 1 ? 'y' : 'ies'} synced from Strava.`;
        syncResultOk = true;
      } else {
        syncResultMsg = 'No new Strava activities found. Make sure activities are uploaded to Strava.';
        syncResultOk = false;
      }
    } catch (err) {
      syncResultMsg = `Sync failed: ${err instanceof Error ? err.message : 'check your connection'}`;
      syncResultOk = false;
    } finally {
      syncing = false;
      rerender();
    }
  });

  // Edit Profile — jump into wizard at the PBs step
  document.getElementById('btn-edit-profile')?.addEventListener('click', () => {
    import('@/ui/wizard/controller').then(({ initWizard, goToStep }) => {
      initWizard();
      goToStep('pbs');
    });
  });

  // Change Runner Type
  document.getElementById('btn-change-runner-type')?.addEventListener('click', showRunnerTypeModal);
}

// ─── Runner Type Change ───────────────────────────────────────────────────────

function showRunnerTypeModal(): void {
  const s = getState();
  const currentType = s.typ || '';
  const planStarted = (s.wks?.length || 0) > 0;

  const types = [
    { key: 'Speed',     label: 'Speed',     desc: 'Strong at shorter, faster efforts. Training builds aerobic endurance and long-run durability.' },
    { key: 'Balanced',  label: 'Balanced',  desc: 'Even performance across distances. Training blends speed and endurance in equal measure.' },
    { key: 'Endurance', label: 'Endurance', desc: 'Maintains pace over long distances. Training emphasises speed and neuromuscular work.' },
  ];

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:flex-end;justify-content:center;z-index:9999;';
  overlay.innerHTML = `
    <div style="background:var(--c-surface,#fff);border-radius:20px 20px 0 0;width:100%;max-width:480px;padding:0 0 env(safe-area-inset-bottom,0)">
      <div style="display:flex;justify-content:center;padding:12px 0 4px">
        <div style="width:36px;height:4px;border-radius:2px;background:#e2e8f0"></div>
      </div>
      <div style="padding:16px 20px 28px">
        <div style="font-size:17px;font-weight:700;color:#1a1a1a;margin-bottom:4px">Change Runner Type</div>
        <div style="font-size:13px;color:#6b7280;margin-bottom:${planStarted ? '12px' : '16px'}">
          Updates how your training plan is structured.
        </div>
        ${planStarted ? `
          <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:10px 12px;margin-bottom:14px;font-size:12px;color:#92400e;line-height:1.4">
            ⚠️ Changing your runner type will rebuild your plan from scratch. Training history is preserved.
          </div>
        ` : ''}
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">
          ${types.map(t => `
            <button class="runner-type-option"
              data-type="${t.key}"
              style="text-align:left;padding:12px 14px;border-radius:12px;border:1.5px solid ${t.key === currentType ? '#3b82f6' : '#e5e7eb'};background:${t.key === currentType ? 'rgba(59,130,246,0.06)' : 'transparent'};cursor:${t.key === currentType ? 'default' : 'pointer'}">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px">
                <span style="font-size:14px;font-weight:600;color:${t.key === currentType ? '#3b82f6' : '#1a1a1a'}">
                  ${t.label}
                </span>
                ${t.key === currentType ? `<span style="font-size:11px;font-weight:600;color:#3b82f6;background:rgba(59,130,246,0.1);padding:2px 8px;border-radius:10px">Current</span>` : ''}
              </div>
              <div style="font-size:12px;color:#6b7280">${t.desc}</div>
            </button>
          `).join('')}
        </div>
        <button id="btn-cancel-runner-type"
          style="width:100%;padding:10px;background:none;border:none;cursor:pointer;font-size:14px;color:#9ca3af">
          Cancel
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#btn-cancel-runner-type')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelectorAll('.runner-type-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const newType = (btn as HTMLElement).dataset.type;
      if (!newType || newType === currentType) { overlay.remove(); return; }
      overlay.remove();
      // Confirm if plan already started
      if (planStarted) {
        showRunnerTypeConfirm(newType);
      } else {
        applyRunnerTypeChange(newType);
      }
    });
  });
}

function showRunnerTypeConfirm(newType: string): void {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;';
  overlay.innerHTML = `
    <div style="background:var(--c-surface,#fff);border-radius:16px;width:100%;max-width:340px;padding:24px">
      <div style="font-size:16px;font-weight:700;color:#1a1a1a;margin-bottom:8px">Rebuild plan as ${newType}?</div>
      <div style="font-size:13px;color:#6b7280;margin-bottom:20px;line-height:1.5">
        This will rebuild your entire training plan from scratch. All completed runs and training history will be preserved.
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button id="btn-rt-confirm"
          style="padding:12px;border-radius:10px;background:#ef4444;border:none;color:white;font-size:14px;font-weight:600;cursor:pointer">
          Yes, rebuild my plan
        </button>
        <button id="btn-rt-cancel"
          style="padding:12px;border-radius:10px;background:none;border:none;color:#6b7280;font-size:14px;cursor:pointer">
          Cancel
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#btn-rt-confirm')?.addEventListener('click', () => {
    overlay.remove();
    applyRunnerTypeChange(newType);
  });
  overlay.querySelector('#btn-rt-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function applyRunnerTypeChange(newType: string): void {
  const s = getMutableState();
  if (!s.onboarding) return;

  // Spinner overlay
  const spinner = document.createElement('div');
  spinner.style.cssText = 'position:fixed;inset:0;background:rgba(255,255,255,0.92);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;';
  spinner.innerHTML = `
    <div style="width:40px;height:40px;border:3px solid #e2e8f0;border-top-color:#3b82f6;border-radius:50%;animation:spin 0.7s linear infinite;margin-bottom:16px"></div>
    <div style="font-size:15px;font-weight:600;color:#1a1a1a">Rebuilding plan…</div>
    <div style="font-size:12px;color:#6b7280;margin-top:4px">Recalculating your workouts</div>
    <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
  `;
  document.body.appendChild(spinner);

  s.onboarding.confirmedRunnerType = newType as any;
  s.onboarding.calculatedRunnerType = newType as any;
  saveState();

  setTimeout(() => {
    const result = initializeSimulator(s.onboarding!);
    if (result.success) {
      window.location.reload();
    } else {
      spinner.remove();
      alert('Failed to recalculate: ' + (result.error || 'Unknown error'));
    }
  }, 1000);
}

function rerender(): void {
  const container = document.getElementById('app-root');
  if (container) {
    container.innerHTML = getAccountHTML();
    wireAccountHandlers();
  }
}
