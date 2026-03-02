/**
 * Account page — user email, wearable connection status, sync controls, sign out.
 */

import { supabase, getAccessToken, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_FUNCTIONS_BASE, isGarminConnected, resetGarminCache, isStravaConnected, resetStravaCache } from '@/data/supabaseClient';
import { syncActivities, processPendingCrossTraining } from '@/data/activitySync';
import { syncStravaActivities, fetchStravaHistory } from '@/data/stravaSync';
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
let syncing = false;
let checkingGarmin = true;
let syncResultMsg = '';
let syncResultOk = true;

/**
 * Render the account page into #app-root
 */
export async function renderAccountView(): Promise<void> {
  const container = document.getElementById('app-root');
  if (!container) return;

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

  container.innerHTML = getAccountHTML();
  wireAccountHandlers();
}

async function checkGarminStatus(): Promise<void> {
  try {
    resetGarminCache();
    garminConnected = await isGarminConnected();
    if (garminConnected) {
      const token = await getAccessToken();
      const res = await fetch(`${SUPABASE_URL}/rest/v1/garmin_tokens?select=created_at&limit=1`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'apikey': SUPABASE_ANON_KEY,
        },
      });
      if (res.ok) {
        const rows = await res.json();
        lastSyncTime = rows?.[0]?.created_at ?? null;
      }
    } else {
      lastSyncTime = null;
    }
  } catch {
    garminConnected = false;
    lastSyncTime = null;
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

function getAccountHTML(): string {
  const s = getState();
  const email = getUserEmail();

  const modeLabel = isSimulatorMode()
    ? `<span style="font-size:12px;color:#d97706;font-weight:600">Simulator Mode</span>`
    : `<span style="font-size:12px;color:var(--c-muted)">${email}</span>`;

  // Determine which primary wearable card to show
  const useApple = s.wearable === 'apple';
  const useStravaStandalone = s.wearable === 'strava';
  const useGarmin = !useApple && !useStravaStandalone;

  return `
    <div class="mosaic-page" style="background:var(--c-bg)">
      <!-- Header -->
      <div style="padding:14px 18px 12px;border-bottom:1px solid var(--c-border)">
        <div style="font-size:20px;font-weight:700;letter-spacing:-0.02em;color:var(--c-black)">Account</div>
        <div style="margin-top:2px">${modeLabel}</div>
      </div>

      <div style="padding:16px;display:flex;flex-direction:column;gap:12px;padding-bottom:90px">

        ${useApple ? renderAppleWatchCard() : (useStravaStandalone ? renderStravaStandaloneCard() : renderGarminCard())}

        ${useGarmin ? renderStravaEnrichCard() : ''}

        ${renderRunnerProfileCard()}

        ${renderPendingActivitiesCard()}

        ${renderPlanRecoveryCard()}

        ${renderStravaHistoryCard()}

        <!-- Plan Settings -->
        <div class="m-card" style="padding:16px">
          <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:12px">Plan Settings</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <button id="btn-edit-plan"
              style="width:100%;padding:11px 14px;border-radius:10px;border:1px solid var(--c-border-strong);background:var(--c-surface);font-size:14px;color:var(--c-black);text-align:left;cursor:pointer;box-sizing:border-box">
              Edit Plan
            </button>
            <button id="btn-reset-plan"
              style="width:100%;padding:11px 14px;border-radius:10px;border:1px solid rgba(239,68,68,0.2);background:rgba(239,68,68,0.04);font-size:14px;color:#dc2626;text-align:left;cursor:pointer;box-sizing:border-box">
              Reset Plan
            </button>
          </div>
        </div>

        <!-- Sign Out / Exit Simulator -->
        <div class="m-card" style="padding:14px">
          ${isSimulatorMode() ? `
            <button id="btn-exit-simulator"
              style="width:100%;padding:11px;border-radius:10px;border:none;background:rgba(217,119,6,0.08);font-size:14px;font-weight:600;color:#d97706;cursor:pointer">
              Exit Simulator Mode
            </button>
          ` : `
            <button id="btn-sign-out"
              style="width:100%;padding:11px;border-radius:10px;border:none;background:rgba(239,68,68,0.06);font-size:14px;font-weight:600;color:#dc2626;cursor:pointer">
              Sign Out
            </button>
          `}
        </div>
      </div>
      ${renderTabBar('account', isSimulatorMode())}
    </div>
  `;
}

function renderGarminCard(): string {
  const connected = garminConnected;
  const statusColor = connected ? 'var(--c-ok)' : 'var(--c-faint)';
  const statusText = checkingGarmin ? 'Checking…' : (connected ? 'Connected' : 'Not connected');
  const syncTimeStr = lastSyncTime ? new Date(lastSyncTime).toLocaleDateString() : '—';

  return `
    <div class="m-card" style="padding:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:${connected ? '12px' : '0'}">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="width:40px;height:40px;border-radius:10px;background:rgba(59,130,246,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="22" height="22" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
              <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
          </div>
          <div>
            <div style="font-size:15px;font-weight:600;color:var(--c-black)">Garmin Connect</div>
            <div style="display:flex;align-items:center;gap:5px;margin-top:2px">
              <div style="width:7px;height:7px;border-radius:50%;background:${statusColor}"></div>
              <span style="font-size:12px;color:var(--c-muted)">${statusText}</span>
            </div>
          </div>
        </div>
        ${!connected && !checkingGarmin ? `
          <button id="btn-connect-garmin"
            style="padding:8px 14px;border-radius:8px;background:#3b82f6;color:white;border:none;font-size:13px;font-weight:600;cursor:pointer">
            Connect
          </button>
        ` : ''}
      </div>

      ${connected ? `
        <div style="border-top:1px solid var(--c-border);padding-top:12px;display:flex;flex-direction:column;gap:10px">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:13px;color:var(--c-muted)">Connected since</span>
            <span style="font-size:13px;color:var(--c-black)">${syncTimeStr}</span>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:13px;color:var(--c-muted)">Manual sync</span>
            <button id="btn-sync-now"
              style="padding:6px 12px;border-radius:8px;background:var(--c-faint);border:1px solid var(--c-border-strong);font-size:12px;font-weight:600;color:var(--c-black);cursor:pointer;opacity:${syncing ? '0.5' : '1'}">
              ${syncing ? 'Syncing…' : 'Sync Now'}
            </button>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:13px;color:var(--c-muted)">Remove access</span>
            <button id="btn-disconnect-garmin"
              style="padding:6px 12px;border-radius:8px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);font-size:12px;font-weight:600;color:#dc2626;cursor:pointer">
              Disconnect
            </button>
          </div>
          ${syncResultMsg ? `<div style="font-size:12px;color:${syncResultOk ? 'var(--c-ok)' : 'var(--c-warn)'}">${syncResultMsg}</div>` : ''}
        </div>
      ` : (checkingGarmin ? '' : `
        <div style="font-size:13px;color:var(--c-muted);line-height:1.5;margin-top:10px">
          Connect your Garmin watch to automatically sync activities, heart rate, HRV, and training load.
        </div>
      `)}
      <div id="garmin-error" style="font-size:12px;color:var(--c-warn);margin-top:8px;display:none"></div>
    </div>
  `;
}

function renderAppleWatchCard(): string {
  return `
    <div class="m-card" style="padding:16px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <div style="width:40px;height:40px;border-radius:10px;background:rgba(0,0,0,0.06);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg width="22" height="22" fill="none" stroke="var(--c-black)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
            <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
        </div>
        <div>
          <div style="font-size:15px;font-weight:600;color:var(--c-black)">Apple Watch</div>
          <div style="display:flex;align-items:center;gap:5px;margin-top:2px">
            <div style="width:7px;height:7px;border-radius:50%;background:var(--c-ok)"></div>
            <span style="font-size:12px;color:var(--c-muted)">Syncs automatically</span>
          </div>
        </div>
      </div>

      <div style="border-top:1px solid var(--c-border);padding-top:12px;display:flex;flex-direction:column;gap:10px">
        <div style="font-size:13px;color:var(--c-muted);line-height:1.5">Workouts from Apple Health sync each time you open the app on your iPhone.</div>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:13px;color:var(--c-muted)">Manual sync</span>
          <button id="btn-sync-apple"
            style="padding:6px 12px;border-radius:8px;background:var(--c-faint);border:1px solid var(--c-border-strong);font-size:12px;font-weight:600;color:var(--c-black);cursor:pointer;opacity:${syncing ? '0.5' : '1'}">
            ${syncing ? 'Syncing…' : 'Sync Now'}
          </button>
        </div>
        ${syncResultMsg ? `<div style="font-size:12px;color:${syncResultOk ? 'var(--c-ok)' : 'var(--c-warn)'}">${syncResultMsg}</div>` : ''}
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:13px;color:var(--c-muted)">Switch device</span>
          <button id="btn-switch-device"
            style="padding:6px 12px;border-radius:8px;background:var(--c-faint);border:1px solid var(--c-border-strong);font-size:12px;font-weight:600;color:var(--c-muted);cursor:pointer">
            Change
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderStravaStandaloneCard(): string {
  const statusColor = stravaConnectedStatus ? 'var(--c-ok)' : 'var(--c-faint)';
  const statusText = checkingStrava ? 'Checking…' : (stravaConnectedStatus ? 'Connected' : 'Not connected');

  return `
    <div class="m-card" style="padding:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:${stravaConnectedStatus ? '12px' : '0'}">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="width:40px;height:40px;border-radius:10px;background:rgba(249,115,22,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="20" height="20" fill="#f97316" viewBox="0 0 24 24">
              <path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0 5 13.828h4.172"/>
            </svg>
          </div>
          <div>
            <div style="font-size:15px;font-weight:600;color:var(--c-black)">Strava</div>
            <div style="display:flex;align-items:center;gap:5px;margin-top:2px">
              <div style="width:7px;height:7px;border-radius:50%;background:${statusColor}"></div>
              <span style="font-size:12px;color:var(--c-muted)">${statusText}</span>
            </div>
          </div>
        </div>
        ${!stravaConnectedStatus && !checkingStrava ? `
          <button id="btn-connect-strava"
            style="padding:8px 14px;border-radius:8px;background:#f97316;color:white;border:none;font-size:13px;font-weight:600;cursor:pointer">
            Connect
          </button>
        ` : ''}
      </div>

      ${stravaConnectedStatus ? `
        <div style="border-top:1px solid var(--c-border);padding-top:12px;display:flex;flex-direction:column;gap:10px">
          <div style="font-size:12px;color:var(--c-muted)">Activities sync automatically each time you open the app.</div>
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:13px;color:var(--c-muted)">Manual sync</span>
            <button id="btn-sync-strava"
              style="padding:6px 12px;border-radius:8px;background:var(--c-faint);border:1px solid var(--c-border-strong);font-size:12px;font-weight:600;color:var(--c-black);cursor:pointer;opacity:${syncing ? '0.5' : '1'}">
              ${syncing ? 'Syncing…' : 'Sync Now'}
            </button>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:13px;color:var(--c-muted)">Remove access</span>
            <button id="btn-disconnect-strava"
              style="padding:6px 12px;border-radius:8px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);font-size:12px;font-weight:600;color:#dc2626;cursor:pointer">
              Disconnect
            </button>
          </div>
          ${syncResultMsg ? `<div style="font-size:12px;color:${syncResultOk ? 'var(--c-ok)' : 'var(--c-warn)'}">${syncResultMsg}</div>` : ''}
        </div>
      ` : (checkingStrava ? '' : `
        <div style="font-size:13px;color:var(--c-muted);line-height:1.5;margin-top:10px">
          Connect Strava to sync your activities and heart rate data into your training plan.
        </div>
      `)}
    </div>
  `;
}

function renderStravaEnrichCard(): string {
  const statusColor = stravaConnectedStatus ? 'var(--c-ok)' : 'var(--c-faint)';
  const statusText = checkingStrava ? 'Checking…' : (stravaConnectedStatus ? 'Connected' : 'Not connected');

  return `
    <div class="m-card" style="padding:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:${stravaConnectedStatus ? '12px' : '0'}">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="width:40px;height:40px;border-radius:10px;background:rgba(249,115,22,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="20" height="20" fill="#f97316" viewBox="0 0 24 24">
              <path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0 5 13.828h4.172"/>
            </svg>
          </div>
          <div>
            <div style="font-size:15px;font-weight:600;color:var(--c-black)">Strava HR Enrichment</div>
            <div style="display:flex;align-items:center;gap:5px;margin-top:2px">
              <div style="width:7px;height:7px;border-radius:50%;background:${statusColor}"></div>
              <span style="font-size:12px;color:var(--c-muted)">${statusText}</span>
            </div>
          </div>
        </div>
        ${!stravaConnectedStatus && !checkingStrava ? `
          <button id="btn-connect-strava"
            style="padding:8px 14px;border-radius:8px;background:#f97316;color:white;border:none;font-size:13px;font-weight:600;cursor:pointer">
            Connect
          </button>
        ` : ''}
      </div>

      ${stravaConnectedStatus ? `
        <div style="border-top:1px solid var(--c-border);padding-top:12px;display:flex;flex-direction:column;gap:10px">
          <div style="font-size:12px;color:var(--c-muted);line-height:1.4">Synced with full heart rate streams for accurate training load calculations.</div>
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:13px;color:var(--c-muted)">Re-sync activities</span>
            <button id="btn-sync-strava-hr"
              style="padding:6px 12px;border-radius:8px;background:rgba(249,115,22,0.1);border:1px solid rgba(249,115,22,0.3);font-size:12px;font-weight:600;color:#ea580c;cursor:pointer;opacity:${syncing ? '0.5' : '1'}">
              ${syncing ? 'Syncing…' : 'Sync Strava'}
            </button>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:13px;color:var(--c-muted)">Remove access</span>
            <button id="btn-disconnect-strava"
              style="padding:6px 12px;border-radius:8px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);font-size:12px;font-weight:600;color:#dc2626;cursor:pointer">
              Disconnect
            </button>
          </div>
          ${syncResultMsg ? `<div style="font-size:12px;color:${syncResultOk ? 'var(--c-ok)' : 'var(--c-warn)'}">${syncResultMsg}</div>` : ''}
        </div>
      ` : (checkingStrava ? '' : `
        <div style="font-size:13px;color:var(--c-muted);line-height:1.5;margin-top:10px">
          Connect Strava to add second-by-second heart rate data to your cross-training activities for more accurate load calculations.
        </div>
      `)}
    </div>
  `;
}

function renderRunnerProfileCard(): string {
  const s = getState();
  const email = getUserEmail();
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

  const runnerTypeLabel = s.typ || '—';

  const pbGrid = [
    { label: '5K', val: pbs.k5 },
    { label: '10K', val: pbs.k10 },
    { label: 'Half', val: pbs.h },
    { label: 'Marathon', val: pbs.m },
  ].filter(pb => pb.val);

  return `
    <div class="m-card" style="padding:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div style="font-size:14px;font-weight:600;color:var(--c-black)">Runner Profile</div>
        <button id="btn-edit-profile"
          style="font-size:12px;font-weight:600;color:var(--c-accent);background:none;border:none;cursor:pointer;padding:0">
          Edit
        </button>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px;color:var(--c-muted)">Email</span>
          <span style="font-size:13px;color:var(--c-black);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${email}</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px;color:var(--c-muted)">Gender</span>
          <span style="font-size:13px;color:var(--c-black)">${genderLabel}</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px;color:var(--c-muted)">Runner type</span>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:13px;color:var(--c-black)">${runnerTypeLabel}</span>
            <button id="btn-change-runner-type"
              style="font-size:12px;font-weight:600;color:var(--c-accent);background:none;border:none;cursor:pointer;padding:0">
              Change
            </button>
          </div>
        </div>
      </div>
      ${pbGrid.length > 0 ? `
      <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--c-border)">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:8px">Personal Bests</div>
        <div style="display:grid;grid-template-columns:repeat(${pbGrid.length},1fr);gap:6px">
          ${pbGrid.map(pb => `
            <div style="background:var(--c-faint);border-radius:8px;padding:8px;text-align:center">
              <div style="font-size:11px;color:var(--c-muted)">${pb.label}</div>
              <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-top:2px">${fmtTime(pb.val)}</div>
            </div>
          `).join('')}
        </div>
      </div>` : ''}
    </div>
  `;
}

function renderPendingActivitiesCard(): string {
  const s = getState();
  const wk = s.wks?.[s.w - 1];
  if (!wk?.garminPending?.length) return '';

  // Find items not yet reviewed (garminMatched undefined or '__pending__')
  const unprocessed = wk.garminPending.filter(item => {
    const matched = wk.garminMatched?.[item.garminId];
    return !matched || matched === '__pending__';
  });

  if (unprocessed.length === 0) return '';

  const activityLines = unprocessed.slice(0, 5).map(item => {
    const date = new Date(item.startTime).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const dur = item.durationSec ? `${Math.round(item.durationSec / 60)}min` : '';
    const dist = item.distanceM ? ` · ${(item.distanceM / 1000).toFixed(1)}km` : '';
    const label = item.activityType.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0">
        <div style="width:7px;height:7px;border-radius:50%;background:var(--c-accent);flex-shrink:0"></div>
        <span style="font-size:13px;color:var(--c-black);flex:1">${label}${dur ? ' · ' + dur : ''}${dist}</span>
        <span style="font-size:12px;color:var(--c-muted)">${date}</span>
      </div>`;
  }).join('');

  const extra = unprocessed.length > 5 ? `<div style="font-size:12px;color:var(--c-muted);margin-top:4px">+ ${unprocessed.length - 5} more</div>` : '';

  return `
    <div class="m-card" style="padding:16px;border-left:3px solid var(--c-accent)">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <div style="width:40px;height:40px;border-radius:10px;background:rgba(59,130,246,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg width="20" height="20" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
            <path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
          </svg>
        </div>
        <div>
          <div style="font-size:15px;font-weight:600;color:var(--c-black)">${unprocessed.length} activit${unprocessed.length === 1 ? 'y' : 'ies'} pending</div>
          <div style="font-size:12px;color:var(--c-muted)">Week ${s.w} · waiting to be integrated</div>
        </div>
      </div>
      <div style="border-top:1px solid var(--c-border);padding-top:12px">
        ${activityLines}
        ${extra}
        <button id="btn-review-pending" class="m-btn-primary" style="width:100%;margin-top:12px">
          Review Now
        </button>
      </div>
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

function renderStravaHistoryCard(): string {
  const s = getState();

  // Only show if Strava is connected or history has been fetched
  if (!s.stravaConnected && !s.stravaHistoryFetched) return '';

  const hasFetched = !!s.stravaHistoryFetched;
  const tier = s.athleteTierOverride ?? s.athleteTier;
  const tierLabel = tier ? (TIER_LABELS_ACCOUNT[tier] ?? tier) : null;
  const avgKm = s.detectedWeeklyKm;
  const avgTSS = s.historicWeeklyTSS && s.historicWeeklyTSS.length > 0
    ? Math.round(s.historicWeeklyTSS.reduce((a, b) => a + b, 0) / s.historicWeeklyTSS.length)
    : null;
  const weeksFound = s.historicWeeklyTSS?.length ?? 0;
  const accepted = !!s.stravaHistoryAccepted;

  if (!hasFetched) {
    return `
      <div class="m-card" style="padding:14px 16px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-size:14px;font-weight:600;color:var(--c-black)">Training History</div>
            <div style="font-size:12px;color:var(--c-muted);margin-top:2px">Strava history not yet loaded</div>
          </div>
          <button id="btn-fetch-history"
            style="padding:7px 12px;border-radius:8px;background:rgba(249,115,22,0.1);border:1px solid rgba(249,115,22,0.3);font-size:12px;font-weight:600;color:#ea580c;cursor:pointer">
            Load History
          </button>
        </div>
      </div>
    `;
  }

  return `
    <div class="m-card" style="padding:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="font-size:14px;font-weight:600;color:var(--c-black)">Training History</div>
        ${accepted ? `<span style="font-size:12px;font-weight:600;color:var(--c-ok)">✓ Applied</span>` : ''}
      </div>

      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">
        ${weeksFound > 0 ? `<div style="font-size:12px;color:var(--c-muted)">${weeksFound} weeks of Strava data loaded</div>` : ''}
        ${avgTSS !== null ? `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px;color:var(--c-muted)">Avg weekly load</span>
          <span style="font-size:13px;font-weight:600;color:var(--c-black)">${avgTSS} TSS/week</span>
        </div>` : ''}
        ${avgKm !== null ? `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px;color:var(--c-muted)">Avg running volume</span>
          <span style="font-size:13px;font-weight:600;color:var(--c-black)">${avgKm} km/week</span>
        </div>` : ''}
        ${tierLabel ? `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px;color:var(--c-muted)">Detected tier</span>
          <span style="font-size:13px;font-weight:600;color:var(--c-black)">${tierLabel}</span>
        </div>` : ''}
      </div>

      <div style="display:flex;flex-direction:column;gap:8px">
        <button id="btn-rebuild-plan"
          style="width:100%;padding:11px;border-radius:10px;background:rgba(249,115,22,0.1);border:1px solid rgba(249,115,22,0.3);font-size:14px;font-weight:600;color:#ea580c;cursor:pointer;box-sizing:border-box">
          Rebuild Plan with Strava Data
        </button>
        <button id="btn-refresh-history"
          style="width:100%;padding:9px;border-radius:10px;background:var(--c-faint);border:1px solid var(--c-border-strong);font-size:13px;color:var(--c-muted);cursor:pointer;box-sizing:border-box">
          Refresh History
        </button>
      </div>
      <div style="font-size:11px;color:var(--c-faint);margin-top:10px">Your logged activities and ratings are preserved when rebuilding.</div>
    </div>
  `;
}

function renderPlanRecoveryCard(): string {
  const s = getState();
  const currentWeek = s.w || 1;
  const currentStart = s.planStartDate || '';

  // Default date suggestion: work backwards from today using current week
  let suggestedStart = currentStart;
  if (!suggestedStart || suggestedStart === new Date().toISOString().slice(0, 10)) {
    // Plan was reset today — suggest a start date based on week number
    const d = new Date();
    d.setDate(d.getDate() - (currentWeek - 1) * 7);
    suggestedStart = d.toISOString().slice(0, 10);
  }

  return `
    <details class="m-card" style="padding:0">
      <summary style="padding:14px 16px;cursor:pointer;display:flex;align-items:center;gap:12px;list-style:none">
        <div style="width:38px;height:38px;border-radius:10px;background:rgba(217,119,6,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg width="18" height="18" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
            <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
        </div>
        <div style="flex:1">
          <div style="font-size:14px;font-weight:600;color:var(--c-black)">Recover Plan</div>
          <div style="font-size:12px;color:var(--c-muted)">Restore progress if the plan was accidentally reset</div>
        </div>
        <svg width="16" height="16" fill="none" stroke="var(--c-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" style="flex-shrink:0"><path d="M19 9l-7 7-7-7"/></svg>
      </summary>
      <div style="padding:0 16px 16px;border-top:1px solid var(--c-border);padding-top:14px;display:flex;flex-direction:column;gap:10px">
        <div style="font-size:12px;color:var(--c-muted);line-height:1.5">
          Enter the date your plan originally started and the week you were on. Activities from the last 28 days will re-sync automatically.
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
            <label style="font-size:13px;color:var(--c-muted);flex-shrink:0">Plan started on</label>
            <input type="date" id="recovery-start-date"
              style="background:var(--c-faint);color:var(--c-black);font-size:13px;border-radius:8px;padding:6px 10px;border:1px solid var(--c-border-strong);flex-shrink:0"
              value="${suggestedStart}">
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
            <label style="font-size:13px;color:var(--c-muted);flex-shrink:0">I was on week</label>
            <input type="number" id="recovery-week" min="1" max="52"
              style="background:var(--c-faint);color:var(--c-black);font-size:13px;border-radius:8px;padding:6px 10px;border:1px solid var(--c-border-strong);width:64px;text-align:center;flex-shrink:0"
              value="${currentWeek}">
          </div>
        </div>
        <div id="recovery-result" style="font-size:12px;display:none"></div>
        <button id="btn-recover-plan"
          style="width:100%;padding:11px;border-radius:10px;background:rgba(217,119,6,0.1);border:1px solid rgba(217,119,6,0.3);font-size:14px;font-weight:600;color:#d97706;cursor:pointer;box-sizing:border-box">
          Restore &amp; Re-sync
        </button>

        ${s.w > 1 ? `
        <div style="margin-top:4px;padding-top:12px;border-top:1px solid var(--c-border)">
          <div style="font-size:12px;color:var(--c-muted);line-height:1.5;margin-bottom:10px">
            Need to re-review Week ${s.w - 1} activities? This rolls back one week and re-syncs so the review screen reappears. Tap <strong>Complete Week</strong> after reviewing to advance back.
          </div>
          <div id="rewind-result" style="font-size:12px;display:none;margin-bottom:6px"></div>
          <button id="btn-rewind-week"
            style="width:100%;padding:11px;border-radius:10px;background:var(--c-faint);border:1px solid var(--c-border-strong);font-size:14px;font-weight:500;color:var(--c-black);cursor:pointer;box-sizing:border-box">
            Re-review Week ${s.w - 1} Activities
          </button>
        </div>
        ` : ''}
      </div>
    </details>
  `;
}

function wireAccountHandlers(): void {
  // Tab bar navigation
  wireTabBarHandlers((tab: TabId) => {
    if (tab === 'plan') {
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

  document.getElementById('btn-edit-plan')?.addEventListener('click', () => {
    import('./events').then(({ editSettings }) => editSettings());
  });

  document.getElementById('btn-reset-plan')?.addEventListener('click', () => {
    import('./events').then(({ reset }) => reset());
  });

  // Strava history: Fetch or refresh
  document.getElementById('btn-fetch-history')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-fetch-history') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    await fetchStravaHistory(8).catch(() => {});
    renderAccountView();
  });

  document.getElementById('btn-refresh-history')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-refresh-history') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
    const ms = getMutableState();
    ms.stravaHistoryFetched = false; // force re-fetch
    await fetchStravaHistory(8).catch(() => {});
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
      (avgKm ? `Plan will start at ~${avgKm}km/week (${tierLabel}).\n` : '');

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
