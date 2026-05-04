// Language toggle: switch the running user's User.LanguageLocaleKey between
// their working language and a configured "debug language" via the @lang palette.
// Loaded after shared.js / soql.js so sfRestPreamble() is available.

var LANGUAGE_STATE_KEY = 'sfnavLanguageState';
var LANGUAGES_TTL_MS = 30 * 60 * 1000;

// Two REST calls: /chatter/users/me returns the running user's id; the User
// sobject GET returns LanguageLocaleKey. Chatter's UserDetail does not include
// LanguageLocaleKey directly across API versions, so don't rely on it.
async function fetchCurrentUserLanguage() {
  var pre = await sfRestPreamble();
  var meResp = await fetch(pre.apiBase + pre.basePath + '/chatter/users/me', { headers: pre.headers });
  if (!meResp.ok) throw new Error('users/me failed: ' + meResp.status);
  var me = await meResp.json();
  var userResp = await fetch(pre.apiBase + pre.basePath + '/sobjects/User/' + me.id + '?fields=LanguageLocaleKey', { headers: pre.headers });
  if (!userResp.ok) throw new Error('User fetch failed: ' + userResp.status);
  var user = await userResp.json();
  return { id: me.id, languageLocaleKey: user.LanguageLocaleKey };
}

// Independent describe call — soql.js fetchDescribe strips picklistValues to
// bare strings and slices to 50, so we can't reuse it. Cached in
// sfnavLanguageState.activeLanguagesCache (30-min TTL).
async function fetchActiveLanguages() {
  var state = await getLanguageState();
  var cache = state.activeLanguagesCache;
  if (cache && (Date.now() - cache.ts) < LANGUAGES_TTL_MS) {
    return cache.values;
  }

  var pre = await sfRestPreamble();
  var resp = await fetch(pre.apiBase + pre.basePath + '/sobjects/User/describe', { headers: pre.headers });
  if (!resp.ok) throw new Error('User describe failed: ' + resp.status);
  var data = await resp.json();
  var langField = (data.fields || []).find(function (f) { return f.name === 'LanguageLocaleKey'; });
  if (!langField || !langField.picklistValues) throw new Error('LanguageLocaleKey picklist not found in User describe');
  var values = langField.picklistValues
    .filter(function (v) { return v.active; })
    .map(function (v) { return { value: v.value, label: v.label }; });

  await writeLanguageState({ activeLanguagesCache: { values: values, ts: Date.now() } });
  return values;
}

async function patchUserLanguage(userId, languageLocaleKey) {
  var pre = await sfRestPreamble();
  var headers = Object.assign({}, pre.headers, { 'Content-Type': 'application/json' });
  var resp = await fetch(pre.apiBase + pre.basePath + '/sobjects/User/' + userId, {
    method: 'PATCH',
    headers: headers,
    body: JSON.stringify({ LanguageLocaleKey: languageLocaleKey }),
  });
  if (!resp.ok) {
    var body = '';
    try { body = await resp.text(); } catch (_) {}
    throw new Error('PATCH failed (' + resp.status + '): ' + body);
  }
}

function getDebugLanguage() {
  return new Promise(function (resolve) {
    chrome.storage.local.get('sfnavOptions', function (data) {
      var opts = data.sfnavOptions || {};
      resolve(opts.debugLanguage || null);
    });
  });
}

function getLanguageState() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(LANGUAGE_STATE_KEY, function (data) {
      resolve(data[LANGUAGE_STATE_KEY] || {});
    });
  });
}

// Read-modify-write a partial update into sfnavLanguageState.
function writeLanguageState(partial) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(LANGUAGE_STATE_KEY, function (data) {
      var next = Object.assign({}, data[LANGUAGE_STATE_KEY] || {}, partial);
      var update = {};
      update[LANGUAGE_STATE_KEY] = next;
      chrome.storage.local.set(update, function () { resolve(); });
    });
  });
}

function setPreviousLanguage(lang) {
  return writeLanguageState({ previousLanguage: lang });
}

// Read-modify-write into the existing sfnavOptions blob to avoid clobbering
// anthropicApiKey / model that the SOQL feature stores there.
function setDebugLanguage(lang) {
  return new Promise(function (resolve) {
    chrome.storage.local.get('sfnavOptions', function (data) {
      var opts = Object.assign({}, data.sfnavOptions || {}, { debugLanguage: lang });
      chrome.storage.local.set({ sfnavOptions: opts }, function () { resolve(); });
    });
  });
}

// Orchestrator. Throws Error('NO_DEBUG_LANGUAGE') sentinel when the user has not
// configured a debug language yet — caller routes that to the picker.
//
// Order of operations is deliberate: when leaving the working language we
// write previousLanguage = current BEFORE the PATCH. If PATCH fails, the
// stored previous still equals the actual current — no corruption. If we wrote
// after PATCH and the page closed mid-flight, previous would be lost.
async function performLanguageToggle() {
  var current = await fetchCurrentUserLanguage();
  var debug = await getDebugLanguage();
  if (!debug) throw new Error('NO_DEBUG_LANGUAGE');

  var target;
  if (current.languageLocaleKey === debug) {
    var state = await getLanguageState();
    target = state.previousLanguage;
    if (!target) throw new Error('No previous language stored — set a different debug language first');
  } else {
    await setPreviousLanguage(current.languageLocaleKey);
    target = debug;
  }

  await patchUserLanguage(current.id, target);
  return { from: current.languageLocaleKey, to: target };
}

async function setDebugLanguageAndToggle(lang) {
  await setDebugLanguage(lang);
  return performLanguageToggle();
}
