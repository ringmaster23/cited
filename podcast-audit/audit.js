// Each submission is posted to the cited-audit-requests process in Appy (saved, feed checked,
// posted to #library-approval-requests). text/plain + no-cors keeps it a simple request: no preflight.
(function () {
  var WEBHOOK = 'https://gql.appy.ai/api/trigger/webhook/delegator/ayj31zwj';
  var loadedAt = Date.now();
  var sending = false;

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 's-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }
  var form = document.getElementById('audit-form');
  var confirmBox = document.getElementById('confirm');
  var fields = ['rss', 'firstName', 'lastName', 'email'];

  // The field takes an RSS feed or a YouTube channel link. A bare @handle or a link typed without
  // https:// is completed here so the podcaster never has to; the intake converts channel links.
  function normalizeSource(v) {
    v = v.trim();
    if (/^@[\w.\-]+$/.test(v)) return 'https://www.youtube.com/' + v;
    if (/^(www\.|m\.)?youtube\.com\/\S+$/i.test(v)) return 'https://' + v;
    return v;
  }

  function valid(id) {
    var el = document.getElementById(id);
    var v = el.value.trim();
    if (id === 'rss') v = normalizeSource(v);
    var ok = v.length > 0;
    if (ok && id === 'rss') ok = /^https?:\/\/[^\s.]+\.[^\s]+$/i.test(v);
    if (ok && id === 'email') ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
    el.closest('.field').classList.toggle('invalid', !ok);
    el.setAttribute('aria-invalid', ok ? 'false' : 'true');
    return ok;
  }

  function show(data) {
    document.getElementById('c-name').textContent = data.firstName || 'there';
    // The show name isn't known yet; the team reads it from the feed.
    document.getElementById('c-rss').textContent = data.rss;
    document.getElementById('c-email').textContent = data.email;
    form.hidden = true;
    confirmBox.hidden = false;
    confirmBox.focus();
    confirmBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  fields.forEach(function (id) {
    var el = document.getElementById(id);
    el.addEventListener('blur', function () { if (el.value) valid(id); });
    el.addEventListener('input', function () {
      if (el.closest('.field').classList.contains('invalid')) valid(id);
    });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var firstBad = null;
    fields.forEach(function (id) {
      if (!valid(id) && !firstBad) firstBad = id;
    });
    if (firstBad) { document.getElementById(firstBad).focus(); return; }
    if (sending) return;
    sending = true;
    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    var firstName = document.getElementById('firstName').value.trim();
    var lastName = document.getElementById('lastName').value.trim();
    var payload = {
      formId: 'cited-audit',
      rss: normalizeSource(document.getElementById('rss').value),
      firstName: firstName,
      lastName: lastName,
      // Kept during the switchover so anything still reading `name` keeps working.
      name: firstName + ' ' + lastName,
      email: document.getElementById('email').value.trim(),
      website: (document.getElementById('website') || {}).value || '',
      elapsedMs: Date.now() - loadedAt,
      submissionId: uuid(),
      source: location.href
    };
    fetch(WEBHOOK, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(payload),
      keepalive: true
    }).then(function () {
      sending = false; btn.disabled = false;
      show(payload);
    }).catch(function () {
      sending = false; btn.disabled = false;
      alert('Sorry, your request did not go through. Please check your connection and try again.');
    });
  });

  document.getElementById('again').addEventListener('click', function () {
    form.reset();
    loadedAt = Date.now();
    confirmBox.hidden = true;
    form.hidden = false;
    document.getElementById('rss').focus();
  });
})();
