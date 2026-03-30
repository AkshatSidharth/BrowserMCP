'use strict';

const apiKeyInput = document.getElementById('apiKey');
const modelInput  = document.getElementById('model');
const saveBtn     = document.getElementById('saveBtn');
const clearBtn    = document.getElementById('clearBtn');
const toast       = document.getElementById('toast');

function showToast(msg, type = 'success') {
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

// Load saved values
chrome.storage.local.get(['openaiApiKey', 'gptModel'], (r) => {
  if (r.openaiApiKey) apiKeyInput.value = r.openaiApiKey;
  if (r.gptModel)     modelInput.value  = r.gptModel;
  else                modelInput.value  = 'gpt-4o';
});

saveBtn.addEventListener('click', () => {
  const key   = apiKeyInput.value.trim();
  const model = modelInput.value.trim() || 'gpt-4o';

  if (!key) {
    showToast('API key is required.', 'error');
    return;
  }
  if (!key.startsWith('sk-')) {
    showToast('Key should start with sk-', 'error');
    return;
  }

  chrome.storage.local.set({ openaiApiKey: key, gptModel: model }, () => {
    showToast('Settings saved ✓');
  });
});

clearBtn.addEventListener('click', () => {
  chrome.storage.local.remove(['openaiApiKey', 'gptModel'], () => {
    apiKeyInput.value = '';
    modelInput.value  = 'gpt-4o';
    showToast('Cleared.');
  });
});
