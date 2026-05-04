var apiKeyEl = document.getElementById('apiKey');
var modelEl = document.getElementById('model');
var debugLanguageEl = document.getElementById('debugLanguage');
var debugLanguageWarningEl = document.getElementById('debugLanguageWarning');
var saveEl = document.getElementById('save');
var testEl = document.getElementById('test');
var statusEl = document.getElementById('status');

var _currentLanguage = null;

chrome.storage.local.get('sfnavOptions', function (data) {
  var opts = data.sfnavOptions || {};
  if (opts.anthropicApiKey) apiKeyEl.value = opts.anthropicApiKey;
  if (opts.model) modelEl.value = opts.model;
  loadActiveLanguagesIntoSelect(opts.debugLanguage || '');
});

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

// Read-modify-write so we don't clobber other keys in sfnavOptions.
function persistOptions(patch, cb) {
  chrome.storage.local.get('sfnavOptions', function (data) {
    var opts = Object.assign({}, data.sfnavOptions || {}, patch);
    chrome.storage.local.set({ sfnavOptions: opts }, function () { if (cb) cb(opts); });
  });
}

saveEl.addEventListener('click', function () {
  var patch = {
    anthropicApiKey: apiKeyEl.value.trim(),
    model: modelEl.value,
  };
  // Only touch debugLanguage when the picklist is actually loaded (more than
  // just a placeholder option). Avoids clobbering an existing stored value
  // when the user saves with no SF tab open. When loaded, an explicit
  // "— none —" selection (value === '') clears it.
  if (debugLanguageEl.options.length > 1) {
    patch.debugLanguage = debugLanguageEl.value || null;
  }
  persistOptions(patch, function () {
    setStatus('Saved', 'ok');
    setTimeout(function () { setStatus(''); }, 1800);
  });
});

testEl.addEventListener('click', async function () {
  var key = apiKeyEl.value.trim();
  if (!key) { setStatus('Enter an API key first', 'err'); return; }

  // Persist before testing so the background uses the latest value
  await new Promise(function (resolve) {
    persistOptions({ anthropicApiKey: key, model: modelEl.value }, resolve);
  });

  setStatus('Testing…', 'loading');
  chrome.runtime.sendMessage(
    {
      type: 'soql.generate',
      system: 'Reply with exactly the word "ok" and nothing else.',
      user: 'ping'
    },
    function (resp) {
      if (chrome.runtime.lastError) {
        setStatus('Error: ' + chrome.runtime.lastError.message, 'err');
        return;
      }
      if (!resp) { setStatus('No response from background', 'err'); return; }
      if (!resp.ok) { setStatus('Failed: ' + resp.error, 'err'); return; }
      setStatus('Connected — model replied: ' + (resp.text || '').trim().slice(0, 60), 'ok');
    }
  );
});

debugLanguageEl.addEventListener('change', function () {
  updateWarning();
});

// Asks the content script in any open SF tab for the active-language picklist
// + the current user's language. The options page itself runs at chrome-extension://
// so it can't call the SF REST API directly.
function loadActiveLanguagesIntoSelect(currentDebug) {
  var sfMatches = [
    'https://*.lightning.force.com/*',
    'https://*.salesforce.com/*',
    'https://*.salesforce-setup.com/*',
    'https://*.force.com/*',
  ];
  chrome.tabs.query({ url: sfMatches }, function (tabs) {
    if (!tabs || !tabs.length) {
      debugLanguageEl.innerHTML = '<option value="">Open a Salesforce tab to load languages</option>';
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'language.activeLanguages' }, function (resp) {
      if (chrome.runtime.lastError || !resp) {
        debugLanguageEl.innerHTML = '<option value="">Could not reach Salesforce tab — reload it</option>';
        return;
      }
      if (!resp.ok) {
        debugLanguageEl.innerHTML = '<option value="">Failed: ' + (resp.error || 'unknown') + '</option>';
        return;
      }
      _currentLanguage = resp.currentLanguage || null;
      renderLanguageOptions(resp.languages || [], currentDebug);
      updateWarning();
    });
  });
}

function renderLanguageOptions(languages, selectedValue) {
  debugLanguageEl.innerHTML = '';
  var blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '— none —';
  debugLanguageEl.appendChild(blank);
  languages.forEach(function (l) {
    var opt = document.createElement('option');
    opt.value = l.value;
    opt.textContent = l.label + ' (' + l.value + ')';
    if (l.value === selectedValue) opt.selected = true;
    debugLanguageEl.appendChild(opt);
  });
}

function updateWarning() {
  if (!_currentLanguage || !debugLanguageEl.value) {
    debugLanguageWarningEl.style.display = 'none';
    return;
  }
  if (debugLanguageEl.value === _currentLanguage) {
    debugLanguageWarningEl.textContent = 'Debug language equals your current language — toggle will be a no-op.';
    debugLanguageWarningEl.style.display = '';
  } else {
    debugLanguageWarningEl.style.display = 'none';
  }
}
