/**
 * Claude for Safari — Extension Popup
 * Lets the user set a profile name for this Safari instance.
 */

const input  = document.getElementById('profileName');
const saveBtn = document.getElementById('save');
const status  = document.getElementById('status');

let statusTimer = null;

// Load current profile name on open
browser.storage.local.get('profileName').then(({ profileName }) => {
  if (profileName) input.value = profileName;
});

// Save on button click
saveBtn.addEventListener('click', save);

// Save on Enter key
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') save();
});

function save() {
  const name = input.value.trim() || 'default';
  input.value = name === 'default' ? '' : name;

  browser.storage.local.set({ profileName: name }).then(() => {
    showStatus(`✓ Profile "${name}" saved`);
  }).catch((err) => {
    showStatus('Error: ' + err.message, true);
  });
}

function showStatus(msg, isError = false) {
  clearTimeout(statusTimer);
  status.textContent = msg;
  status.className = isError ? 'error' : '';
  statusTimer = setTimeout(() => {
    status.textContent = '';
    status.className = '';
  }, 2500);
}
