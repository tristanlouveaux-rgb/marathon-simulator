/**
 * Auth page — email/password sign in and sign up.
 */

import { supabase } from '@/data/supabaseClient';

let isSignUp = false;
let loading = false;
let errorMsg = '';
let confirmationEmail = ''; // set after successful sign-up to show "check your email"

export function renderAuthView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;

  // Reset state when rendering fresh (e.g. after sign-out)
  loading = false;
  errorMsg = '';
  confirmationEmail = '';

  container.innerHTML = getAuthHTML();
  wireAuthHandlers();
}

function renderInPlace(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  container.innerHTML = getAuthHTML();
  wireAuthHandlers();
}

function getCheckEmailHTML(): string {
  return `
    <div class="flex items-center justify-center px-4" style="min-height:100vh;background:var(--c-bg)">
      <div class="w-full max-w-sm space-y-6">
        <div class="text-center">
          <h1 class="text-2xl font-bold" style="color:var(--c-black)">Mosaic</h1>
          <p class="text-sm mt-1" style="color:var(--c-muted)">Adaptive marathon training</p>
        </div>

        <div class="rounded-xl p-6 space-y-4 text-center" style="background:var(--c-surface);border:1px solid var(--c-border)">
          <div class="w-12 h-12 mx-auto rounded-full flex items-center justify-center" style="background:rgba(78,159,229,0.1)">
            <svg class="w-6 h-6" style="color:var(--c-accent)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
            </svg>
          </div>
          <h2 class="text-lg font-semibold" style="color:var(--c-black)">Check your email</h2>
          <p class="text-sm" style="color:var(--c-muted)">
            We sent a confirmation link to <span class="font-medium" style="color:var(--c-black)">${confirmationEmail}</span>.
            Click the link in your email to activate your account.
          </p>
          <p class="text-xs" style="color:var(--c-faint)">Didn't get it? Check your spam folder.</p>
          <button id="auth-back-to-login" class="text-sm underline mt-2" style="color:var(--c-accent);background:none;border:none;cursor:pointer">
            Back to sign in
          </button>
        </div>
      </div>
    </div>
  `;
}

function getAuthHTML(): string {
  if (confirmationEmail) return getCheckEmailHTML();

  const title = isSignUp ? 'Create Account' : 'Sign In';
  const toggleText = isSignUp
    ? `Already have an account? <button id="auth-toggle" class="underline" style="color:var(--c-accent);background:none;border:none;cursor:pointer">Sign in</button>`
    : `Don't have an account? <button id="auth-toggle" class="underline" style="color:var(--c-accent);background:none;border:none;cursor:pointer">Sign up</button>`;
  const submitLabel = loading
    ? (isSignUp ? 'Creating account...' : 'Signing in...')
    : (isSignUp ? 'Create Account' : 'Sign In');

  return `
    <div class="flex items-center justify-center px-4" style="min-height:100vh;background:var(--c-bg)">
      <div class="w-full max-w-sm space-y-6">
        <div class="text-center">
          <h1 class="text-2xl font-bold" style="color:var(--c-black)">Mosaic</h1>
          <p class="text-sm mt-1" style="color:var(--c-muted)">Adaptive marathon training</p>
        </div>

        <div class="rounded-xl p-6 space-y-4" style="background:var(--c-surface);border:1px solid var(--c-border)">
          <h2 class="text-lg font-semibold" style="color:var(--c-black)">${title}</h2>

          ${errorMsg ? `<div class="text-sm rounded-lg px-3 py-2" style="color:var(--c-warn);background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.25)">${errorMsg}</div>` : ''}

          <form id="auth-form" class="space-y-3">
            <div>
              <label class="block text-xs mb-1" style="color:var(--c-muted)" for="auth-email">Email</label>
              <input id="auth-email" type="email" required autocomplete="email"
                class="w-full px-3 py-2 rounded-lg text-sm focus:outline-none"
                style="background:var(--c-bg);border:1.5px solid var(--c-border-strong);color:var(--c-black)"
                placeholder="you@example.com" />
            </div>
            <div>
              <label class="block text-xs mb-1" style="color:var(--c-muted)" for="auth-password">Password</label>
              <input id="auth-password" type="password" required autocomplete="${isSignUp ? 'new-password' : 'current-password'}" minlength="6"
                class="w-full px-3 py-2 rounded-lg text-sm focus:outline-none"
                style="background:var(--c-bg);border:1.5px solid var(--c-border-strong);color:var(--c-black)"
                placeholder="${isSignUp ? 'At least 6 characters' : 'Your password'}" />
            </div>
            <button type="submit" id="auth-submit"
              class="w-full m-btn-primary py-2.5 rounded-lg text-sm font-medium ${loading ? 'opacity-50 pointer-events-none' : ''}">
              ${submitLabel}
            </button>
          </form>

          <p class="text-xs text-center" style="color:var(--c-faint)">${toggleText}</p>
        </div>

        <div class="text-center">
          <button id="auth-simulator-mode" class="text-xs" style="color:var(--c-faint);background:none;border:none;cursor:pointer">
            Use simulator mode (no account)
          </button>
        </div>
      </div>
    </div>
  `;
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
