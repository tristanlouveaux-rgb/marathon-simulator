/**
 * Auth page — email/password sign in and sign up.
 *
 * Supports a "guest upgrade" mode (renderAuthView({ upgradeGuest: true }))
 * for users currently on an anonymous Supabase session. In that mode:
 *   - Sign up uses supabase.auth.updateUser({ email, password }) which
 *     converts the anonymous user in place, preserving the user_id and
 *     all data already linked to it. signUp() would have created a
 *     fresh user and orphaned the guest data.
 *   - Sign in still uses signInWithPassword, but a warning is shown
 *     because logging into a different account abandons guest data.
 *   - A Cancel link returns to Home without changing auth state.
 */

import { supabase } from '@/data/supabaseClient';

let isSignUp = false;
let loading = false;
let errorMsg = '';
let confirmationEmail = ''; // set after successful sign-up to show "check your email"
let upgradeGuest = false;

export function renderAuthView(opts: { upgradeGuest?: boolean } = {}): void {
  const container = document.getElementById('app-root');
  if (!container) return;

  // Reset state when rendering fresh (e.g. after sign-out)
  loading = false;
  errorMsg = '';
  confirmationEmail = '';
  upgradeGuest = !!opts.upgradeGuest;
  if (upgradeGuest) isSignUp = true; // default to sign-up; user can toggle

  container.innerHTML = getAuthHTML();
  wireAuthHandlers();
}

function renderInPlace(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  container.innerHTML = getAuthHTML();
  wireAuthHandlers();
}

function authShell(inner: string): string {
  return `
    <style>
      @keyframes aRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .a-rise { opacity:0; animation: aRise 0.7s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      .a-input {
        width:100%; padding:14px 18px; text-align:left; font-size:14px;
        background:rgba(255,255,255,0.92);
        backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);
        border:1px solid rgba(0,0,0,0.08);
        border-radius:50px;
        color:var(--c-black); outline:none; box-sizing:border-box;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 2px rgba(0,0,0,0.03), 0 8px 20px -4px rgba(0,0,0,0.05);
        transition: border-color 0.2s ease, box-shadow 0.2s ease;
        font-family: var(--f);
      }
      .a-input::placeholder { color:var(--c-faint); }
      .a-input:focus { border-color: rgba(0,0,0,0.18); box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 2px rgba(0,0,0,0.04), 0 10px 24px -4px rgba(0,0,0,0.08); }
      .a-label { display:block; font-size:11px; color:var(--c-faint); margin:0 0 8px 18px; letter-spacing:0.08em; text-transform:uppercase; }
      .a-err {
        font-size:13px; color:var(--c-black);
        background: rgba(239,68,68,0.08);
        border: 1px solid rgba(239,68,68,0.25);
        padding: 10px 14px; border-radius: 14px;
        text-align: center;
      }
    </style>
    <div class="flex flex-col" style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden">
      <div aria-hidden="true" style="position:absolute;inset:0;background:radial-gradient(ellipse 720px 560px at 50% 42%, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0) 72%);pointer-events:none"></div>

      <div class="flex-1 flex flex-col items-center justify-center px-6 py-16" style="position:relative;z-index:1">
        <div class="a-rise" style="text-align:center;animation-delay:0.05s">
          <h1 class="font-semibold uppercase" style="font-size:clamp(1.8rem,7vw,2.8rem);color:var(--c-black);letter-spacing:0.22em;text-align:center;margin:0;line-height:1">
            MOSAIC
          </h1>
          <div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-top:12px">
            <div style="height:1px;width:24px;background:var(--c-black);opacity:0.2"></div>
            <p style="font-size:11px;font-weight:500;letter-spacing:0.26em;text-transform:uppercase;color:var(--c-faint);margin:0">Training that adapts</p>
            <div style="height:1px;width:24px;background:var(--c-black);opacity:0.2"></div>
          </div>
        </div>
        ${inner}
      </div>
    </div>
  `;
}

function getCheckEmailHTML(): string {
  const inner = `
    <div class="a-rise" style="width:100%;max-width:340px;margin-top:40px;display:flex;flex-direction:column;align-items:center;gap:18px;animation-delay:0.2s">
      <div style="width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.7);backdrop-filter:blur(20px) saturate(1.4);-webkit-backdrop-filter:blur(20px) saturate(1.4);border:1px solid rgba(255,255,255,0.6);box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.9)">
        <svg style="width:22px;height:22px;color:var(--c-black)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
        </svg>
      </div>
      <div style="text-align:center">
        <h2 style="font-size:18px;font-weight:500;color:var(--c-black);margin:0 0 8px">Check your email</h2>
        <p style="font-size:13px;color:var(--c-muted);margin:0;line-height:1.5">
          We sent a confirmation link to<br>
          <span style="color:var(--c-black);font-weight:500">${confirmationEmail}</span>
        </p>
        <p style="font-size:11px;color:var(--c-faint);margin:14px 0 0">Didn't get it? Check your spam folder.</p>
      </div>
      <button id="auth-back-to-login" class="m-btn-glass" style="padding:12px 22px;font-size:13px;margin-top:6px">
        Back to sign in
      </button>
    </div>
  `;
  return authShell(inner);
}

function getAuthHTML(): string {
  if (confirmationEmail) return getCheckEmailHTML();

  const title = upgradeGuest && isSignUp
    ? 'Save your account'
    : isSignUp ? 'Create your account' : 'Welcome back';
  const sub = upgradeGuest && isSignUp
    ? 'Keep your training history. Same data, now backed up.'
    : isSignUp
      ? 'A few details and we\'ll build your plan.'
      : 'Sign in to pick up where you left off.';
  const toggleText = isSignUp
    ? `Already have an account? <button id="auth-toggle" style="color:var(--c-black);background:none;border:none;cursor:pointer;font-size:12px;text-decoration:underline;padding:0;margin-left:4px">Sign in</button>`
    : `Don't have an account? <button id="auth-toggle" style="color:var(--c-black);background:none;border:none;cursor:pointer;font-size:12px;text-decoration:underline;padding:0;margin-left:4px">Sign up</button>`;
  const submitLabel = loading
    ? (isSignUp ? 'Saving…' : 'Signing in…')
    : (upgradeGuest && isSignUp ? 'Save my account' : isSignUp ? 'Create account' : 'Sign in');

  // When upgrading from guest and switching to "Sign in", warn that signing
  // into a different account abandons guest data (no way to merge after the fact).
  const guestSignInWarn = upgradeGuest && !isSignUp
    ? `<div style="font-size:12px;color:#92400E;background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.3);padding:10px 14px;border-radius:14px;line-height:1.45">Signing into an existing account will leave your current guest training data behind. To keep it, choose <strong>Sign up</strong> instead.</div>`
    : '';

  const cancelButton = upgradeGuest
    ? `<div class="a-rise" style="margin-top:14px;text-align:center;animation-delay:0.4s">
         <button id="auth-cancel-upgrade" style="font-size:12px;color:var(--c-faint);background:none;border:none;cursor:pointer;letter-spacing:0.02em">Not now</button>
       </div>`
    : '';

  const inner = `
    <p class="a-rise" style="font-size:14px;font-weight:300;text-align:center;line-height:1.55;color:var(--c-muted);margin:28px auto 36px;max-width:320px;animation-delay:0.15s">
      ${sub}
    </p>

    <form id="auth-form" class="a-rise" style="width:100%;max-width:340px;display:flex;flex-direction:column;gap:14px;animation-delay:0.25s" autocomplete="on">
      <div style="text-align:center;margin-bottom:-4px">
        <h2 style="font-size:15px;font-weight:500;color:var(--c-black);margin:0 0 4px;letter-spacing:-0.005em">${title}</h2>
      </div>

      ${errorMsg ? `<div class="a-err">${errorMsg}</div>` : ''}
      ${guestSignInWarn}

      <div>
        <label class="a-label" for="auth-email">Email</label>
        <input id="auth-email" type="email" required autocomplete="email"
          class="a-input" placeholder="you@example.com" />
      </div>
      <div>
        <label class="a-label" for="auth-password">Password</label>
        <input id="auth-password" type="password" required autocomplete="${isSignUp ? 'new-password' : 'current-password'}" minlength="6"
          class="a-input" placeholder="${isSignUp ? 'At least 6 characters' : 'Your password'}" />
      </div>

      <button type="submit" id="auth-submit"
        class="m-btn-glass"
        style="width:100%;padding:15px 20px;font-size:15px;margin-top:6px;${loading ? 'opacity:0.55;pointer-events:none' : ''}">
        ${submitLabel}
      </button>
    </form>

    <p class="a-rise" style="margin:18px 0 0;font-size:12px;color:var(--c-faint);text-align:center;animation-delay:0.35s">
      ${toggleText}
    </p>

    ${cancelButton}

    ${upgradeGuest ? '' : `<div class="a-rise" style="margin-top:32px;animation-delay:0.45s">
      <button id="auth-simulator-mode" style="font-size:11px;color:var(--c-faint);background:none;border:none;cursor:pointer;letter-spacing:0.02em">
        Use simulator mode (no account)
      </button>
    </div>`}

    <div class="a-rise" style="margin-top:28px;display:flex;align-items:center;justify-content:center;gap:10px;white-space:nowrap;animation-delay:0.55s">
      ${['Proven principles', 'Recovery-informed', 'Built from your existing training'].map((label, i, arr) => `
        <span style="font-size:10px;color:var(--c-faint)">${label}</span>
        ${i < arr.length - 1 ? '<span style="width:3px;height:3px;border-radius:50%;background:var(--c-black);opacity:0.28;flex-shrink:0"></span>' : ''}
      `).join('')}
    </div>
  `;
  return authShell(inner);
}

function wireAuthHandlers(): void {
  document.getElementById('auth-back-to-login')?.addEventListener('click', () => {
    confirmationEmail = '';
    isSignUp = false;
    renderInPlace();
  });

  document.getElementById('auth-simulator-mode')?.addEventListener('click', () => {
    localStorage.setItem('mosaic_simulator_mode', '1');
    window.location.reload();
  });

  document.getElementById('auth-toggle')?.addEventListener('click', () => {
    isSignUp = !isSignUp;
    errorMsg = '';
    renderInPlace();
  });

  // Guest-upgrade: "Not now" returns the user to Home without changing auth.
  // The anonymous session stays intact; the banner is dismissable from there.
  document.getElementById('auth-cancel-upgrade')?.addEventListener('click', () => {
    upgradeGuest = false;
    import('@/ui/home-view').then(({ renderHomeView }) => renderHomeView());
  });

  document.getElementById('auth-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (loading) return;

    const email = (document.getElementById('auth-email') as HTMLInputElement).value.trim();
    const password = (document.getElementById('auth-password') as HTMLInputElement).value;

    if (!email || !password) {
      errorMsg = 'Please enter your email and password.';
      renderInPlace();
      return;
    }

    loading = true;
    errorMsg = '';
    renderInPlace();

    try {
      if (isSignUp && upgradeGuest) {
        // Convert anonymous user in place — same user_id, now linked to email/password.
        // This is the only path that preserves guest data; signUp() would create
        // a fresh user and orphan everything attached to the anonymous one.
        const { error } = await supabase.auth.updateUser({ email, password });
        if (error) throw error;
        loading = false;
        upgradeGuest = false;
        confirmationEmail = email;
        renderInPlace();
        return;
      }

      if (isSignUp) {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;

        // If email confirmation is required, the session will be null
        if (!data.session) {
          loading = false;
          confirmationEmail = email;
          renderInPlace();
          return;
        }
        // If auto-confirmed (e.g. dev mode), onAuthStateChange handles it
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      // On success, onAuthStateChange in main.ts handles navigation
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Something went wrong';
      errorMsg = msg;
      loading = false;
      renderInPlace();
    }
  });
}
