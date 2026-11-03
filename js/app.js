// Screens and interaction. Everything is built with text nodes, never innerHTML,
// so saved titles and notes can't inject code into the page.

import {
  createEnvelope, InvalidFileError, isEnvelope, openEnvelope, seal, WrongPasswordError,
} from './crypto.js';
import {
  CATEGORIES, emptyVault, estimateStrength, filterEntries, generatePassword, isAcceptableMaster,
  makeEntry, mergeVaults, MIN_MASTER_LENGTH, normalizeVault, removeEntry, safeWebUrl, updateEntry,
} from './vault.js';
import { deleteVault, loadVault, saveVault } from './store.js';

const root = document.getElementById('app');
const toastEl = document.getElementById('toast');
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('bhadram') : null;

const CLIPBOARD_CLEAR_MS = 30000;
const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const BACKUP_REMINDER_MS = 14 * 24 * 60 * 60 * 1000;
const AUTO_LOCK_CHOICES = [1, 3, 5, 15];
const GMAIL_SUBJECT = 'Bhadram backup';
const GMAIL_BODY = 'Encrypted Bhadram backup attached. Never put your master password in this email.';

let session = null;
let envelope = null;
let vault = null;
let ui = { view: null, id: null, query: '', category: 'All' };
let listEl = null;
let paneEl = null;
let lastActive = Date.now();
let clipboardTimer = null;
let saveQueue = Promise.resolve();

// Small DOM helpers

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (name.startsWith('on')) el.addEventListener(name.slice(2), value);
    else if (name === 'class') el.className = value;
    else if (name in el && name !== 'list') el[name] = value;
    else el.setAttribute(name, value);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  el.append(...children);
  return el;
}

let toastTimer = null;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('shown'), 3200);
}

const secretInputProps = {
  autocomplete: 'off', autocapitalize: 'off', spellcheck: false, autocorrect: 'off',
};

function field(labelText, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, labelText), control,
    hint && h('span', { class: 'field-hint' }, hint));
}

function secretField(props = {}) {
  const input = h('input', { type: 'password', ...secretInputProps, ...props });
  const toggle = h('button', {
    type: 'button',
    class: 'link-button',
    onclick: () => {
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      toggle.textContent = hidden ? 'Hide' : 'Show';
    },
  }, 'Show');
  return { input, wrap: h('span', { class: 'secret-input' }, input, toggle), toggle };
}

function strengthMeter() {
  const bars = [1, 2, 3, 4].map(() => h('i'));
  const label = h('span');
  const el = h('span', { class: 'strength', 'data-score': '0' }, h('span', { class: 'bars' }, bars), label);
  return {
    el,
    update(password) {
      const { score, label: text } = estimateStrength(password);
      el.dataset.score = String(score);
      label.textContent = text;
    },
  };
}

function ask({
  title, message, inputType, inputLabel, confirmLabel, danger, error,
}) {
  return new Promise((resolve) => {
    let result = null;
    const input = inputType && h('input', { type: inputType, ...secretInputProps });
    const dialog = h('dialog', { class: 'dialog' }, h('form', {
      onsubmit: (event) => {
        event.preventDefault();
        result = input ? input.value : true;
        dialog.close();
      },
    },
    h('h2', {}, title),
    message && h('p', {}, message),
    input && field(inputLabel, input),
    error && h('p', { class: 'error', role: 'alert' }, error),
    h('div', { class: 'actions' },
      h('button', { type: 'submit', class: danger ? 'button danger' : 'button primary' }, confirmLabel),
      h('button', { type: 'button', class: 'button', onclick: () => dialog.close() }, 'Cancel'))));
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    input?.focus();
  });
}

// The dial on the lock screen

function buildDial() {
  const ticks = [];
  for (let i = 0; i < 60; i += 1) {
    const major = i % 5 === 0;
    ticks.push(svg('line', {
      class: major ? 'tick major' : 'tick',
      x1: 100,
      y1: 30,
      x2: 100,
      y2: major ? 44 : 38,
      transform: `rotate(${i * 6} 100 100)`,
    }));
  }
  const face = svg('g', { class: 'dial-face' },
    svg('circle', { class: 'dial-plate', cx: 100, cy: 100, r: 76 }),
    ...ticks,
    svg('circle', { class: 'dial-knob', cx: 100, cy: 100, r: 34 }),
    svg('rect', {
      class: 'dial-grip', x: 95, y: 70, width: 10, height: 60, rx: 5,
    }));
  const el = svg('svg', { class: 'dial', viewBox: '0 0 200 200', 'aria-hidden': 'true' },
    svg('circle', { class: 'dial-rim', cx: 100, cy: 100, r: 92 }),
    face,
    svg('path', { class: 'dial-pointer', d: 'M100 26 L91 6 H109 Z' }));
  return { el, turn: (steps) => { face.style.transform = `rotate(${steps * 33}deg)`; } };
}

function lockShell(subtitle, dial, ...content) {
  return h('main', { class: 'lock' },
    h('div', { class: 'lock-inner' },
      dial.el,
      h('h1', {}, 'Bhadram'),
      h('p', { class: 'lock-sub' }, subtitle),
      content));
}

function isAppleMobile() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isInstalled() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}

function renderSetup() {
  const dial = buildDial();
  const master = secretField({ required: true, minLength: MIN_MASTER_LENGTH });
  const confirm = secretField({ required: true });
  const meter = strengthMeter();
  const accept = h('input', { type: 'checkbox', required: true });
  const error = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'button brass' }, 'Create vault');

  master.input.addEventListener('input', () => {
    meter.update(master.input.value);
    dial.turn(master.input.value.length);
  });

  const onSubmit = async (event) => {
    event.preventDefault();
    error.textContent = '';
    const password = master.input.value;
    if (password !== confirm.input.value) {
      error.textContent = 'The two passwords do not match.';
      return;
    }
    if (!isAcceptableMaster(password)) {
      error.textContent = `Use at least ${MIN_MASTER_LENGTH} characters that are hard to guess. A short sentence works well.`;
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Creating vault…';
    const created = await createEnvelope(password, emptyVault());
    await saveVault(created.envelope);
    navigator.storage?.persist?.();
    channel?.postMessage('saved');
    enterVault(created.session, created.envelope, emptyVault());
  };

  root.replaceChildren(lockShell('Keep every password in one locked place.', dial,
    isAppleMobile() && !isInstalled() && h('p', { class: 'notice' },
      'Add Bhadram to your Home Screen first: tap Share, then Add to Home Screen, and open it from there. Safari keeps a separate copy and can erase it after 7 days without use.'),
    h('form', { class: 'lock-form', onsubmit: onSubmit, novalidate: true },
      field('Master password', master.wrap),
      meter.el,
      field('Enter it again', confirm.wrap),
      h('label', { class: 'check' }, accept,
        h('span', {}, 'I understand that nobody can recover this password if I forget it.')),
      error,
      submit),
    h('button', {
      type: 'button',
      class: 'link-button on-enamel',
      onclick: () => chooseBackup(restoreOnSetup),
    }, 'Restore from a backup file')));
  accept.addEventListener('change', () => { submit.disabled = !accept.checked; });
  submit.disabled = true;
  master.input.focus();
}

function renderLocked() {
  const dial = buildDial();
  const master = secretField({ required: true, 'aria-label': 'Master password' });
  const error = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'button brass' }, 'Unlock');

  master.input.addEventListener('input', () => {
    dial.turn(master.input.value.length);
    dial.el.classList.remove('refused');
  });

  const onSubmit = async (event) => {
    event.preventDefault();
    if (!master.input.value || submit.disabled) return;
    error.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Unlocking…';
    dial.el.classList.add('turning');
    try {
      const stored = await loadVault();
      const opened = await openEnvelope(master.input.value, stored);
      const screen = root.querySelector('.lock');
      screen.classList.add('opening');
      await wait(matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 420);
      enterVault(opened.session, stored, normalizeVault(opened.data));
    } catch (err) {
      dial.el.classList.remove('turning');
      dial.el.classList.add('refused');
      dial.turn(0);
      error.textContent = err instanceof WrongPasswordError
        ? 'That master password is not correct.'
        : 'This vault could not be read. Restore it from a backup file.';
      submit.disabled = false;
      submit.textContent = 'Unlock';
      master.input.select();
    }
  };

  root.replaceChildren(lockShell('Enter your master password.', dial,
    h('form', { class: 'lock-form', onsubmit: onSubmit, novalidate: true },
      field('Master password', master.wrap), error, submit)));
  master.input.focus();
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Vault session

function enterVault(nextSession, nextEnvelope, nextVault) {
  session = nextSession;
  envelope = nextEnvelope;
  vault = nextVault;
  lastActive = Date.now();
  ui = { view: null, id: null, query: '', category: 'All' };
  renderMain();
}

function clearClipboard() {
  clearTimeout(clipboardTimer);
  clipboardTimer = null;
  navigator.clipboard?.writeText('').catch(() => {});
}

function lock() {
  if (clipboardTimer) clearClipboard();
  session = null;
  envelope = null;
  vault = null;
  document.querySelectorAll('dialog').forEach((d) => d.close());
  document.body.removeAttribute('data-pane');
  root.replaceChildren();
  boot();
}

function persist() {
  const snapshot = vault;
  const current = session;
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    const next = await seal(current, snapshot);
    await saveVault(next);
    if (session === current) envelope = next;
    channel?.postMessage('saved');
  });
  return saveQueue.catch((err) => {
    toast('This change could not be saved. Free up storage on this device and try again.');
    throw err;
  });
}

// For browsers that refuse the clipboard API, such as a window without permission.
function copyWithSelection(text) {
  const area = h('textarea', { class: 'copy-buffer', readOnly: true, value: text });
  const previous = document.activeElement;
  document.body.append(area);
  area.focus({ preventScroll: true });
  area.setSelectionRange(0, text.length);
  const copied = document.execCommand('copy');
  area.remove();
  previous?.focus?.({ preventScroll: true });
  return copied;
}

async function copyText(text, what) {
  let copied = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    copied = copyWithSelection(text);
  }
  if (!copied) {
    toast(`${what} could not be copied. Tap Show and copy it by hand.`);
    return;
  }
  toast(`${what} copied`);
  clearTimeout(clipboardTimer);
  clipboardTimer = setTimeout(clearClipboard, CLIPBOARD_CLEAR_MS);
}

// Backups

function backupFileName() {
  return `bhadram-backup-${new Date().toISOString().slice(0, 10)}.json`;
}

// Opens the share sheet on iPhone and saves a file everywhere else.
// Returns true when the share sheet was used.
async function handOverBackup() {
  const name = backupFileName();
  const text = JSON.stringify(envelope);
  const file = new File([text], name, { type: 'application/json' });
  if (isAppleMobile() && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: name });
    return true;
  }
  const url = URL.createObjectURL(file);
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return false;
}

async function recordBackup(message) {
  vault = { ...vault, settings: { ...vault.settings, lastBackupAt: Date.now() } };
  await persist();
  toast(message);
  renderList();
  renderPane();
}

async function downloadBackup() {
  try {
    await handOverBackup();
  } catch (err) {
    if (err.name !== 'AbortError') toast('The backup could not be saved. Try again.');
    return;
  }
  await recordBackup('Backup saved');
}

async function sendBackupToGmail() {
  const confirmed = await ask({
    title: 'Send backup to Gmail',
    message: isAppleMobile()
      ? 'Choose Gmail in the share sheet, then send the email to yourself. The backup stays encrypted, so a strong master password is what protects it.'
      : 'Bhadram saves the backup file, then opens a new Gmail message in your browser. Attach the saved file there and send it to yourself. The backup stays encrypted, so a strong master password is what protects it.',
    confirmLabel: 'Continue',
  });
  if (!confirmed || !session) return;
  let shared;
  try {
    shared = await handOverBackup();
  } catch (err) {
    if (err.name !== 'AbortError') toast('The backup could not be sent. Try again.');
    return;
  }
  if (!shared) {
    const subject = encodeURIComponent(GMAIL_SUBJECT);
    const body = encodeURIComponent(GMAIL_BODY);
    window.open(`https://mail.google.com/mail/?view=cm&fs=1&su=${subject}&body=${body}`, '_blank', 'noopener,noreferrer');
  }
  await recordBackup(shared ? 'Backup shared' : 'Backup saved. Attach it to the Gmail message.');
}

function chooseBackup(onChosen) {
  h('input', {
    type: 'file',
    onchange: async (event) => {
      const [file] = event.target.files;
      if (file) await readBackup(file, onChosen);
    },
  }).click();
}

async function readBackup(file, onChosen) {
  let parsed = null;
  if (file.size <= MAX_BACKUP_BYTES) {
    try { parsed = JSON.parse(await file.text()); } catch { parsed = null; }
  }
  if (!isEnvelope(parsed)) {
    toast('This file is not a Bhadram backup.');
    return;
  }
  let error = null;
  for (;;) {
    const password = await ask({
      title: 'Open backup',
      message: 'Enter the master password that was in use when this backup was made.',
      inputType: 'password',
      inputLabel: 'Master password',
      confirmLabel: 'Open backup',
      error,
    });
    if (password === null) return;
    try {
      const opened = await openEnvelope(password, parsed);
      await onChosen(opened, parsed);
      return;
    } catch (err) {
      if (err instanceof WrongPasswordError) error = 'That master password is not correct.';
      else if (err instanceof InvalidFileError) { toast('This backup is damaged.'); return; } else {
        toast('This backup could not be restored.');
        return;
      }
    }
  }
}

async function restoreOnSetup(opened, file) {
  const restored = normalizeVault(opened.data);
  await saveVault(file);
  navigator.storage?.persist?.();
  channel?.postMessage('saved');
  enterVault(opened.session, file, restored);
  toast(`Restored ${restored.entries.length} passwords`);
}

async function mergeBackup(opened) {
  if (!session) return;
  const result = mergeVaults(vault, normalizeVault(opened.data));
  vault = result.vault;
  await persist();
  renderList();
  renderPane();
  toast(`${result.added} added, ${result.updated} updated, ${result.removed} removed`);
}

function needsBackup() {
  const { lastBackupAt } = vault.settings;
  const changes = [...vault.entries.map((e) => e.updatedAt), ...Object.values(vault.tombstones)];
  if (!changes.length || Math.max(...changes) <= lastBackupAt) return false;
  return lastBackupAt === 0 || Date.now() - lastBackupAt > BACKUP_REMINDER_MS;
}

// Main layout

function open(view, id = null) {
  ui.view = view;
  ui.id = id;
  renderPane();
  renderList();
  paneEl.scrollTop = 0;
}

function renderMain() {
  listEl = h('div', { class: 'list-scroll' });
  paneEl = h('section', { class: 'pane', 'aria-live': 'off' });
  const search = h('input', {
    type: 'search',
    placeholder: 'Search passwords',
    'aria-label': 'Search passwords',
    ...secretInputProps,
    value: ui.query,
    oninput: (event) => { ui.query = event.target.value; renderList(); },
  });
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter by category' },
    ['All', ...CATEGORIES].map((name) => h('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(ui.category === name),
      onclick: (event) => {
        ui.category = name;
        chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
        event.currentTarget.setAttribute('aria-pressed', 'true');
        renderList();
      },
    }, name)));

  root.replaceChildren(h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('header', { class: 'topbar' },
        h('h1', {}, 'Bhadram'),
        h('button', { type: 'button', class: 'link-button', onclick: () => open('settings') }, 'Settings'),
        h('button', { type: 'button', class: 'button small', onclick: lock }, 'Lock')),
      h('div', { class: 'tools' }, search, chips),
      listEl,
      h('div', { class: 'sidebar-foot' },
        h('button', { type: 'button', class: 'button primary wide', onclick: () => open('new') }, 'Add password'))),
    paneEl));
  renderList();
  renderPane();
}

function renderList() {
  const items = filterEntries(vault.entries, ui.query, ui.category);
  const nodes = items.map((entry) => h('button', {
    type: 'button',
    class: 'row',
    'aria-current': ui.id === entry.id ? 'true' : null,
    onclick: () => open('detail', entry.id),
  },
  h('span', { class: 'tag', 'aria-hidden': 'true' }, (entry.title.trim()[0] ?? '?').toUpperCase()),
  h('span', { class: 'row-text' },
    h('span', { class: 'row-title' }, entry.title, entry.favorite && h('span', { class: 'star', title: 'Favourite' }, ' ★')),
    h('span', { class: 'row-sub' }, entry.username || entry.category))));

  if (!vault.entries.length) {
    nodes.push(h('p', { class: 'empty' }, 'No passwords yet. Add your first one below.'));
  } else if (!items.length) {
    nodes.push(h('p', { class: 'empty' }, 'Nothing matches. Check the spelling or choose All.'));
  }

  const reminder = needsBackup() && h('button', {
    type: 'button',
    class: 'backup-nudge',
    onclick: () => open('settings'),
  }, 'You have changes with no backup. Back up now');

  listEl.replaceChildren(...[reminder, ...nodes].filter(Boolean));
}

function renderPane() {
  document.body.toggleAttribute('data-pane', ui.view !== null);
  const entry = vault.entries.find((e) => e.id === ui.id);
  if (ui.view === 'settings') paneEl.replaceChildren(settingsView());
  else if (ui.view === 'new') paneEl.replaceChildren(formView(null));
  else if (ui.view === 'edit' && entry) paneEl.replaceChildren(formView(entry));
  else if (ui.view === 'detail' && entry) paneEl.replaceChildren(detailView(entry));
  else {
    ui.view = null;
    ui.id = null;
    document.body.removeAttribute('data-pane');
    paneEl.replaceChildren(h('div', { class: 'pane-empty' },
      h('p', {}, vault.entries.length ? 'Choose a password from the list.' : 'Your vault is empty.')));
  }
}

function backButton() {
  return h('button', {
    type: 'button',
    class: 'link-button back',
    onclick: () => open(null),
  }, 'Back');
}

function detailRow(label, value, ...actions) {
  return h('div', { class: 'detail-row' },
    h('span', { class: 'field-label' }, label),
    h('div', { class: 'detail-value' }, value),
    h('div', { class: 'detail-actions' }, actions));
}

function detailView(entry) {
  const hiddenText = '•'.repeat(12);
  const passwordEl = h('code', { class: 'secret' }, hiddenText);
  const url = safeWebUrl(entry.url);
  const showButton = h('button', {
    type: 'button',
    class: 'link-button',
    onclick: () => {
      const hidden = passwordEl.textContent === hiddenText;
      passwordEl.textContent = hidden ? entry.password : hiddenText;
      showButton.textContent = hidden ? 'Hide' : 'Show';
    },
  }, 'Show');

  return h('article', { class: 'pane-body' },
    h('div', { class: 'pane-head' }, backButton(),
      h('button', {
        type: 'button',
        class: 'button small',
        onclick: () => open('edit', entry.id),
      }, 'Edit')),
    h('h2', {}, entry.title),
    h('p', { class: 'meta' }, entry.category),
    entry.username && detailRow('Username', h('span', {}, entry.username),
      h('button', {
        type: 'button',
        class: 'link-button',
        onclick: () => copyText(entry.username, 'Username'),
      }, 'Copy')),
    detailRow('Password', passwordEl, showButton,
      h('button', {
        type: 'button',
        class: 'link-button',
        onclick: () => copyText(entry.password, 'Password'),
      }, 'Copy')),
    entry.url && detailRow('Website', h('span', {}, entry.url),
      url && h('a', {
        class: 'link-button', href: url, target: '_blank', rel: 'noopener noreferrer',
      }, 'Open')),
    entry.notes && detailRow('Notes', h('p', { class: 'notes' }, entry.notes)),
    h('p', { class: 'meta' }, `Last changed ${new Date(entry.updatedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}`),
    h('button', {
      type: 'button',
      class: 'button danger-quiet',
      onclick: async () => {
        const confirmed = await ask({
          title: `Delete ${entry.title}?`,
          message: 'This password will be removed from this vault.',
          confirmLabel: 'Delete password',
          danger: true,
        });
        if (!confirmed || !session) return;
        vault = removeEntry(vault, entry.id);
        await persist();
        open(null);
        toast('Password deleted');
      },
    }, 'Delete password'));
}

const generatorOptions = {
  length: 20, upper: true, digits: true, symbols: true,
};

function formView(entry) {
  const title = h('input', { type: 'text', value: entry?.title ?? '', required: true, autocomplete: 'off' });
  const username = h('input', { type: 'text', value: entry?.username ?? '', ...secretInputProps });
  const secret = secretField({ value: entry?.password ?? '', required: true });
  const url = h('input', { type: 'text', inputMode: 'url', value: entry?.url ?? '', ...secretInputProps });
  const notes = h('textarea', { rows: 4, value: entry?.notes ?? '', autocomplete: 'off' });
  const category = h('select', {}, CATEGORIES.map((name) => h('option', {
    value: name, selected: (entry?.category ?? 'Login') === name,
  }, name)));
  const favorite = h('input', { type: 'checkbox', checked: entry?.favorite ?? false });
  const meter = strengthMeter();
  const error = h('p', { class: 'error', role: 'alert' });
  const lengthLabel = h('span', {}, `Length: ${generatorOptions.length}`);

  const generate = () => {
    secret.input.value = generatePassword(generatorOptions);
    secret.input.type = 'text';
    secret.toggle.textContent = 'Hide';
    meter.update(secret.input.value);
  };

  const optionBox = (key, label) => h('label', { class: 'check' },
    h('input', {
      type: 'checkbox',
      checked: generatorOptions[key],
      onchange: (event) => {
        generatorOptions[key] = event.target.checked;
        generate();
      },
    }), h('span', {}, label));

  const generator = h('div', { class: 'generator', hidden: true },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, lengthLabel),
      h('input', {
        type: 'range',
        min: 8,
        max: 40,
        value: generatorOptions.length,
        oninput: (event) => {
          generatorOptions.length = Number(event.target.value);
          lengthLabel.textContent = `Length: ${generatorOptions.length}`;
          generate();
        },
      })),
    h('div', { class: 'generator-options' },
      optionBox('upper', 'Capital letters'),
      optionBox('digits', 'Numbers'),
      optionBox('symbols', 'Symbols')));

  secret.input.addEventListener('input', () => meter.update(secret.input.value));
  meter.update(secret.input.value);

  const onSubmit = async (event) => {
    event.preventDefault();
    const fields = {
      title: title.value.trim(),
      username: username.value.trim(),
      password: secret.input.value,
      url: url.value.trim(),
      notes: notes.value,
      category: category.value,
      favorite: favorite.checked,
    };
    if (!fields.title || !fields.password) {
      error.textContent = 'Enter a name and a password to save this.';
      return;
    }
    let id = entry?.id;
    if (entry) {
      vault = updateEntry(vault, id, fields);
    } else {
      const created = makeEntry(fields);
      id = created.id;
      vault = { ...vault, entries: [...vault.entries, created] };
    }
    await persist();
    open('detail', id);
    toast('Password saved');
  };

  return h('form', { class: 'pane-body', onsubmit: onSubmit, novalidate: true },
    h('div', { class: 'pane-head' },
      h('button', {
        type: 'button',
        class: 'link-button back always',
        onclick: () => open(entry ? 'detail' : null, entry?.id ?? null),
      }, 'Cancel')),
    h('h2', {}, entry ? 'Edit password' : 'Add password'),
    field('Name', title, 'For example: SBI net banking'),
    field('Username or email', username),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Password'), secret.wrap),
    meter.el,
    h('button', {
      type: 'button',
      class: 'button',
      onclick: () => {
        generator.hidden = false;
        generate();
      },
    }, 'Generate password'),
    generator,
    field('Website', url),
    field('Category', category),
    field('Notes', notes),
    h('label', { class: 'check' }, favorite, h('span', {}, 'Show at the top of my list')),
    error,
    h('button', { type: 'submit', class: 'button primary' }, 'Save password'));
}

function settingsView() {
  const { lastBackupAt, autoLockMinutes } = vault.settings;
  const current = secretField({ required: true });
  const next = secretField({ required: true });
  const repeat = secretField({ required: true });
  const meter = strengthMeter();
  const masterError = h('p', { class: 'error', role: 'alert' });
  const changeButton = h('button', { type: 'submit', class: 'button' }, 'Change master password');
  next.input.addEventListener('input', () => meter.update(next.input.value));

  const changeMaster = async (event) => {
    event.preventDefault();
    masterError.textContent = '';
    if (next.input.value !== repeat.input.value) {
      masterError.textContent = 'The two new passwords do not match.';
      return;
    }
    if (!isAcceptableMaster(next.input.value)) {
      masterError.textContent = `Use at least ${MIN_MASTER_LENGTH} characters that are hard to guess.`;
      return;
    }
    changeButton.disabled = true;
    changeButton.textContent = 'Changing…';
    try {
      await saveQueue.catch(() => {});
      await openEnvelope(current.input.value, envelope);
      const created = await createEnvelope(next.input.value, vault);
      await saveVault(created.envelope);
      session = created.session;
      envelope = created.envelope;
      channel?.postMessage('saved');
      toast('Master password changed. Make a new backup.');
      renderPane();
    } catch (err) {
      masterError.textContent = err instanceof WrongPasswordError
        ? 'Your current master password is not correct.'
        : 'The master password could not be changed.';
      changeButton.disabled = false;
      changeButton.textContent = 'Change master password';
    }
  };

  const deleteAll = async () => {
    const typed = await ask({
      title: 'Delete this vault?',
      message: 'Every password on this device will be erased. Backup files you saved are not affected. Type DELETE to confirm.',
      inputType: 'text',
      inputLabel: 'Type DELETE',
      confirmLabel: 'Delete vault',
      danger: true,
    });
    if (typed !== 'DELETE') {
      if (typed !== null) toast('Vault kept. Type DELETE exactly to erase it.');
      return;
    }
    await saveQueue.catch(() => {});
    await deleteVault();
    channel?.postMessage('saved');
    lock();
  };

  return h('div', { class: 'pane-body' },
    h('div', { class: 'pane-head' }, backButton()),
    h('h2', {}, 'Settings'),

    h('section', { class: 'setting' },
      h('h3', {}, 'Backup and sync'),
      h('p', {}, 'Your passwords live only on this device. If it is lost or reset, a backup file is the only way to get them back.'),
      h('p', {}, 'To sync, save a backup here, move the file to your other device, and import it there. The newest change to each password wins.'),
      h('p', { class: 'meta' }, lastBackupAt
        ? `Last backup: ${new Date(lastBackupAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
        : 'No backup yet'),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'button primary', onclick: downloadBackup }, 'Save backup'),
        h('button', { type: 'button', class: 'button', onclick: sendBackupToGmail }, 'Send to Gmail'),
        h('button', { type: 'button', class: 'button', onclick: () => chooseBackup(mergeBackup) }, 'Import backup'))),

    h('section', { class: 'setting' },
      h('h3', {}, 'Auto-lock'),
      field('Lock after no activity for', h('select', {
        onchange: async (event) => {
          vault = {
            ...vault,
            settings: { ...vault.settings, autoLockMinutes: Number(event.target.value) },
          };
          await persist();
          toast('Auto-lock updated');
        },
      }, AUTO_LOCK_CHOICES.map((minutes) => h('option', {
        value: minutes, selected: minutes === autoLockMinutes,
      }, minutes === 1 ? '1 minute' : `${minutes} minutes`))))),

    h('form', { class: 'setting', onsubmit: changeMaster, novalidate: true },
      h('h3', {}, 'Master password'),
      field('Current master password', current.wrap),
      field('New master password', next.wrap),
      meter.el,
      field('Enter the new one again', repeat.wrap),
      masterError,
      changeButton),

    h('section', { class: 'setting' },
      h('h3', {}, 'Delete vault'),
      h('p', {}, 'Erase every password from this device.'),
      h('button', { type: 'button', class: 'button danger-quiet', onclick: deleteAll }, 'Delete vault')));
}

// Auto-lock and app start

function checkAutoLock() {
  if (!session) return;
  const limit = vault.settings.autoLockMinutes * 60000;
  if (Date.now() - lastActive >= limit) lock();
}

for (const name of ['pointerdown', 'keydown', 'input']) {
  document.addEventListener(name, () => { lastActive = Date.now(); }, { capture: true, passive: true });
}

document.addEventListener('visibilitychange', () => {
  // Hides content from the phone's app switcher preview.
  document.body.classList.toggle('veiled', document.hidden);
  if (!document.hidden) checkAutoLock();
});

setInterval(checkAutoLock, 5000);

if (channel) {
  // Another open window changed the vault, so this copy is out of date.
  channel.onmessage = () => {
    if (session) lock();
    else boot();
  };
}

async function boot() {
  if (!window.crypto?.subtle) {
    root.replaceChildren(h('main', { class: 'lock' }, h('div', { class: 'lock-inner' },
      h('h1', {}, 'Bhadram'),
      h('p', { class: 'lock-sub' }, 'Encryption is only available on a secure site. Open Bhadram from its https:// address.'))));
    return;
  }
  const stored = await loadVault();
  if (stored) renderLocked();
  else renderSetup();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot().catch(() => {
  root.replaceChildren(h('main', { class: 'lock' }, h('div', { class: 'lock-inner' },
    h('h1', {}, 'Bhadram'),
    h('p', { class: 'lock-sub' }, 'This browser is blocking storage. Turn off private browsing and open Bhadram again.'))));
});
