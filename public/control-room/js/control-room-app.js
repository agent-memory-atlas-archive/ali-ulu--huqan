'use strict';

(function () {
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function ago(iso) {
    if (!iso) return 'unknown time';
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return 'just now';
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} h ${mins % 60} min ago`;
    const days = Math.floor(hrs / 24);
    return `${days} d ago`;
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
  }

  function closeDrawer() {
    $('#drawer')?.classList.remove('on');
    $('#scrim')?.classList.remove('on');
    $('#drawer')?.setAttribute('aria-hidden', 'true');
  }
  function openDrawer(html) {
    const drawer = $('#drawer');
    if (!drawer) return;
    drawer.innerHTML = html;
    drawer.classList.add('on');
    $('#scrim')?.classList.add('on');
    drawer.setAttribute('aria-hidden', 'false');
    drawer.querySelector('[data-close]')?.focus();
  }

  // ---------- navigation ----------
  const views = {}; // name -> { onShow() }
  function registerView(name, handlers) { views[name] = handlers; }

  function go(view) {
    $$('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
    $$('.nav button[data-go]').forEach((b) => {
      if (b.dataset.go === view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    window.scrollTo({ top: 0 });
    const handler = views[view];
    if (handler && typeof handler.onShow === 'function') handler.onShow();
  }

  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]');
    if (g) { go(g.dataset.go); return; }
    if (e.target.closest('#d-close') || e.target.id === 'scrim') { closeDrawer(); return; }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  // ---------- session ----------
  function refreshSessionUi() {
    const data = window.HuqanControlRoomData;
    const state = $('#session-state');
    const wsField = $('#session-ws');
    if (wsField && document.activeElement !== wsField) wsField.value = data.workspace();
    if (!state) return;
    if (data.hasKey()) {
      state.textContent = `Connected · ${data.workspace()}`;
      state.classList.add('connected');
      state.classList.remove('error');
    } else {
      state.textContent = 'Not connected — some views need an API key';
      state.classList.remove('connected');
    }
  }

  $('#session-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const key = $('#session-key').value.trim();
    const ws = $('#session-ws').value.trim() || 'default';
    window.HuqanControlRoomData.setSession(key, ws);
    $('#session-key').value = '';
    refreshSessionUi();
    toast('Session saved to this browser tab.');
    go(currentView());
  });

  function currentView() {
    const active = $$('.nav button[aria-current="page"]')[0];
    return active ? active.dataset.go : 'overview';
  }

  // ---------- theme ----------
  const THEME_KEY = 'huqan-control-room-theme';
  function applyTheme(value) {
    if (value === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', value);
  }
  (function initTheme() {
    let saved = 'system';
    try { saved = localStorage.getItem(THEME_KEY) || 'system'; } catch (_) { /* private browsing */ }
    applyTheme(saved);
    const select = $('#theme');
    if (select) select.value = saved;
    select?.addEventListener('change', (e) => {
      applyTheme(e.target.value);
      try { localStorage.setItem(THEME_KEY, e.target.value); } catch (_) { /* ignore */ }
    });
  })();

  window.HuqanControlRoomUI = {
    $, $$, esc, ago, toast, openDrawer, closeDrawer, registerView, go, refreshSessionUi,
  };

  refreshSessionUi();
  // View scripts loaded after this one call registerView() synchronously as
  // they execute; DOMContentLoaded fires only once every script tag in the
  // document (this one included) has run, so every view is registered by
  // the time the first navigation happens.
  document.addEventListener('DOMContentLoaded', () => go('overview'));
})();
