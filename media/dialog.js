// Data source dialog webview logic.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const DEFAULT_PORTS = { postgres: 5432, mysql: 3306 };
  let secretsPresent = { password: false, sshPassword: false, sshPassphrase: false };
  const touched = { password: false, sshPassword: false, sshPassphrase: false };
  let selectedSchemas = [];
  let nameTouched = false;

  // ------------------------------------------------------------ validation
  const FIELD_IDS = {
    name: 'f-name',
    host: 'f-host',
    port: 'f-port',
    user: 'f-user',
    file: 'f-file',
    sshHost: 'f-ssh-host',
    sshUser: 'f-ssh-user',
    sshPort: 'f-ssh-port',
    sshKeyFile: 'f-ssh-key',
    awsProfile: 'f-aws-profile',
    awsRegion: 'f-aws-region',
    timeZone: 'f-timezone',
  };

  function clearInvalidMarks() {
    document.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
  }

  function markInvalid(field) {
    const el = $(FIELD_IDS[field]);
    if (!el) return;
    el.classList.add('invalid');
    el.addEventListener('input', () => el.classList.remove('invalid'), { once: true });
  }

  /** Validate locally; on failure mark fields, surface the first message, focus. */
  function runValidation(forSave) {
    clearInvalidMarks();
    const errors = window.tableclothValidation.validateDataSourceForm(collectConfig(), { forSave });
    if (errors.length === 0) return true;
    for (const e of errors) markInvalid(e.field);
    const result = $('test-result');
    result.className = 'fail';
    result.textContent = errors[0].message;
    const first = $(FIELD_IDS[errors[0].field]);
    if (first) {
      // the field may live on a non-active tab (e.g. an SSH field); reveal it
      const pane = first.closest('.pane');
      if (pane && pane.hidden) {
        const tab = document.querySelector('.tabs .tab[data-tab="' + pane.id.replace('pane-', '') + '"]');
        if (tab) tab.click();
      }
      first.focus();
    }
    return false;
  }

  // ------------------------------------------------------------ auto-name
  // Like the IntelliJ dialog, the name follows database@host (or the SQLite
  // file name) until the user edits it by hand.
  function maybeDeriveName() {
    if (nameTouched) return;
    $('f-name').value = window.tableclothValidation.deriveDataSourceName(collectConfig());
  }

  // ------------------------------------------------------------ tabs
  document.querySelectorAll('.tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tabs .tab').forEach((t) => t.classList.toggle('on', t === tab));
      ['general', 'options', 'ssh', 'schemas'].forEach((name) => {
        $('pane-' + name).hidden = name !== tab.dataset.tab;
      });
    });
  });

  // ------------------------------------------------------------ visibility rules
  function applyVisibility() {
    const driver = $('f-driver').value;
    const isLite = driver === 'sqlite';
    document.querySelectorAll('.net').forEach((el) => (el.hidden = isLite));
    document.querySelectorAll('.lite').forEach((el) => (el.hidden = !isLite));
    document.querySelectorAll('#f-auth option[data-pg-only]').forEach((o) => (o.hidden = driver !== 'postgres'));
    if (driver !== 'postgres' && $('f-auth').value === 'pgpass') $('f-auth').value = 'userPassword';

    const auth = $('f-auth').value;
    const creds = auth === 'userPassword';
    document.querySelectorAll('.cred').forEach((el) => (el.hidden = isLite || auth === 'none'));
    document.querySelectorAll('.pass').forEach((el) => (el.hidden = isLite || !creds));
    document.querySelectorAll('.aws').forEach((el) => (el.hidden = isLite || auth !== 'awsIam'));

    const sshOn = $('f-ssh-on').checked;
    document.querySelectorAll('.ssh').forEach((el) => (el.hidden = !sshOn || isLite));
    if (sshOn && !isLite) {
      const sshAuth = $('f-ssh-auth').value;
      document.querySelectorAll('.sshpass').forEach((el) => (el.hidden = sshAuth !== 'password'));
      document.querySelectorAll('.sshkey').forEach((el) => (el.hidden = sshAuth !== 'keyFile'));
    }
    // the SSL mode row follows .net; the CA row shows only for verify modes
    const caVisible = !isLite && ($('f-ssl-mode').value === 'verify-ca' || $('f-ssl-mode').value === 'verify-full');
    document.querySelectorAll('.sslca').forEach((el) => (el.hidden = !caVisible));
    updateUrl();
  }

  function updateUrl() {
    const driver = $('f-driver').value;
    let url;
    if (driver === 'sqlite') {
      url = 'sqlite:' + ($('f-file').value || '<file>');
    } else {
      const scheme = driver === 'postgres' ? 'postgresql' : 'mysql';
      const host = $('f-host').value || 'localhost';
      const port = $('f-port').value || DEFAULT_PORTS[driver];
      const db = $('f-database').value;
      url = scheme + '://' + host + ':' + port + (db ? '/' + db : '');
    }
    $('f-url').textContent = url;
  }

  // The region the token is signed for, read off an RDS host name as it is typed;
  // the field itself stays empty unless the host is a CNAME and the user has to say.
  function updateRegionHint() {
    const region = window.tableclothValidation.inferRdsRegion($('f-host').value);
    $('f-aws-region').placeholder = region ? region + ' (from host)' : 'e.g. us-east-1';
  }

  // registered before applyVisibility so the SSL rows reflect the nudge
  $('f-auth').addEventListener('change', () => {
    // RDS takes an IAM token only over TLS; leaving disable in place would fail the
    // first connect on a rule the user never saw
    if ($('f-auth').value === 'awsIam' && $('f-ssl-mode').value === 'disable') $('f-ssl-mode').value = 'require';
  });
  ['f-driver', 'f-auth', 'f-ssh-on', 'f-ssh-auth', 'f-ssl-mode'].forEach((id) =>
    $(id).addEventListener('change', applyVisibility),
  );
  ['f-host', 'f-port', 'f-database', 'f-file'].forEach((id) => $(id).addEventListener('input', updateUrl));
  $('f-host').addEventListener('input', updateRegionHint);
  $('f-driver').addEventListener('change', () => {
    const port = DEFAULT_PORTS[$('f-driver').value];
    if (port && !$('f-port').dataset.touched) $('f-port').value = String(port);
    maybeDeriveName();
  });
  $('f-port').addEventListener('input', () => ($('f-port').dataset.touched = '1'));
  ['f-host', 'f-database', 'f-file'].forEach((id) => $(id).addEventListener('input', maybeDeriveName));
  $('f-name').addEventListener('input', () => (nameTouched = true));

  ['f-password', 'f-ssh-password', 'f-ssh-passphrase'].forEach((id) => {
    const key = id === 'f-password' ? 'password' : id === 'f-ssh-password' ? 'sshPassword' : 'sshPassphrase';
    $(id).addEventListener('input', () => {
      touched[key] = true;
      $(id).placeholder = '';
    });
  });

  // ------------------------------------------------------------ browse buttons
  $('b-file').addEventListener('click', () => vscode.postMessage({ type: 'browse', field: 'file', title: 'Select SQLite database file' }));
  $('b-ssh-key').addEventListener('click', () => vscode.postMessage({ type: 'browse', field: 'sshKey', title: 'Select SSH private key' }));
  $('b-ssl-ca').addEventListener('click', () => vscode.postMessage({ type: 'browse', field: 'sslCa', title: 'Select CA certificate' }));

  // ------------------------------------------------------------ collect
  function collectConfig() {
    const driver = $('f-driver').value;
    return {
      name: $('f-name').value,
      driver,
      color: $('f-color').value,
      readOnly: $('f-readonly').checked,
      autoSync: $('f-autosync').checked,
      host: $('f-host').value,
      port: $('f-port').value ? Number($('f-port').value) : undefined,
      database: $('f-database').value,
      user: $('f-user').value,
      auth: driver === 'sqlite' ? 'none' : $('f-auth').value,
      aws: { profile: $('f-aws-profile').value, region: $('f-aws-region').value },
      file: $('f-file').value,
      ssl: { mode: $('f-ssl-mode').value, caFile: $('f-ssl-ca').value },
      ssh: {
        enabled: $('f-ssh-on').checked && driver !== 'sqlite',
        host: $('f-ssh-host').value,
        port: $('f-ssh-port').value ? Number($('f-ssh-port').value) : 22,
        user: $('f-ssh-user').value,
        auth: $('f-ssh-auth').value,
        keyFile: $('f-ssh-key').value,
      },
      schemas: selectedSchemas,
      timeZone: $('f-timezone').value,
    };
  }

  function collectSecrets() {
    const secrets = {};
    if (touched.password) secrets.password = $('f-password').value;
    if (touched.sshPassword) secrets.sshPassword = $('f-ssh-password').value;
    if (touched.sshPassphrase) secrets.sshPassphrase = $('f-ssh-passphrase').value;
    return secrets;
  }

  // ------------------------------------------------------------ actions
  $('b-test').addEventListener('click', () => {
    if (!runValidation(false)) return;
    const el = $('test-result');
    el.className = '';
    el.textContent = 'Connecting…';
    vscode.postMessage({ type: 'test', config: collectConfig(), secrets: collectSecrets() });
  });
  $('b-save').addEventListener('click', () => {
    if (!runValidation(true)) return;
    vscode.postMessage({ type: 'save', config: collectConfig(), secrets: collectSecrets(), scope: $('f-scope').value });
  });
  $('b-cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $('b-schemas').addEventListener('click', () => {
    if (!runValidation(false)) return;
    $('schema-list').textContent = 'Loading…';
    vscode.postMessage({ type: 'loadSchemas', config: collectConfig(), secrets: collectSecrets() });
  });

  /** The profile names behind the AWS profile field, each with how it signs in and its region. */
  function renderAwsProfiles(profiles) {
    const list = $('aws-profiles');
    list.textContent = '';
    for (const profile of profiles || []) {
      const option = document.createElement('option');
      option.value = profile.name;
      option.label = [profile.kind === 'other' ? '' : profile.kind, profile.region || ''].filter(Boolean).join(' · ');
      list.appendChild(option);
    }
  }

  // ------------------------------------------------------------ time zone combobox
  // Local and Server first, then every zone the extension host knows, in an
  // anchored popup (menu.css) that filters as the user types. Its height is
  // capped to the room below the field, so a long list scrolls instead of
  // running past the bottom of the window.
  let zoneEntries = [];
  let zoneRows = [];
  let zoneFocus = -1;

  function renderTimeZones(names, local) {
    zoneEntries = [
      { value: 'Local', desc: 'this machine: ' + local },
      { value: 'Server', desc: 'as the server is set' },
    ].concat((names || []).map((name) => ({ value: name, desc: '' })));
    $('tz-hint').textContent =
      'Session time zone for values that carry one. Local is ' + local + " on this machine; Server keeps the server's setting.";
  }

  function zoneMatches(query) {
    const q = query.trim().toLowerCase();
    if (!q) return zoneEntries;
    return zoneEntries.filter((e) => e.value.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q));
  }

  function setZoneFocus(index, center) {
    zoneFocus = index;
    zoneRows.forEach((row, i) => row.classList.toggle('focused', i === index));
    if (index >= 0 && zoneRows[index]) zoneRows[index].scrollIntoView({ block: center ? 'center' : 'nearest' });
  }

  /** Show the zones matching `query` (empty = all), focused on the field's current value when it is listed. */
  function openZoneList(query) {
    const input = $('f-timezone');
    const list = $('tz-list');
    const entries = zoneMatches(query);
    list.textContent = '';
    zoneRows = [];
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tc-empty';
      empty.textContent = 'No zone matches';
      list.appendChild(empty);
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'tc-mi';
      row.setAttribute('role', 'option');
      const label = document.createElement('span');
      label.className = 'tc-label';
      label.textContent = entry.value;
      row.appendChild(label);
      if (entry.desc) {
        const desc = document.createElement('span');
        desc.className = 'tc-desc';
        desc.textContent = entry.desc;
        row.appendChild(desc);
      }
      // keep the input focused through the click, so blur does not close the list first
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => pickZone(entry.value));
      list.appendChild(row);
      zoneRows.push(row);
    }
    const room = window.innerHeight - $('tz-combo').getBoundingClientRect().bottom - 16;
    list.style.maxHeight = Math.max(120, Math.min(320, room)) + 'px';
    $('tz-menu').hidden = false;
    input.setAttribute('aria-expanded', 'true');
    const current = input.value.trim().toLowerCase();
    const at = entries.findIndex((e) => e.value.toLowerCase() === current);
    setZoneFocus(at >= 0 ? at : entries.length > 0 ? 0 : -1, at >= 0);
  }

  function closeZoneList() {
    $('tz-menu').hidden = true;
    $('f-timezone').setAttribute('aria-expanded', 'false');
    zoneRows = [];
    zoneFocus = -1;
  }

  function pickZone(value) {
    const input = $('f-timezone');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    closeZoneList();
    input.focus();
  }

  $('f-timezone').addEventListener('input', () => openZoneList($('f-timezone').value));
  $('f-timezone').addEventListener('blur', closeZoneList);
  $('f-timezone').addEventListener('keydown', (e) => {
    const open = !$('tz-menu').hidden;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        openZoneList('');
        return;
      }
      const count = zoneRows.length;
      if (count > 0) setZoneFocus((zoneFocus + (e.key === 'ArrowDown' ? 1 : -1) + count) % count, false);
    } else if (e.key === 'Enter' && open && zoneFocus >= 0) {
      e.preventDefault();
      pickZone(zoneRows[zoneFocus].firstChild.textContent);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      closeZoneList();
    } else if (e.key === 'Tab') {
      closeZoneList();
    }
  });
  // the arrow must not steal focus from the input, or blur would close what click is about to open
  $('tz-arrow').addEventListener('mousedown', (e) => e.preventDefault());
  $('tz-arrow').addEventListener('click', () => {
    if ($('tz-menu').hidden) {
      $('f-timezone').focus();
      openZoneList('');
    } else {
      closeZoneList();
    }
  });

  function renderSchemaList(names) {
    const list = $('schema-list');
    list.textContent = '';
    for (const name of names) {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = name;
      cb.checked = selectedSchemas.includes(name);
      cb.addEventListener('change', () => {
        selectedSchemas = [...list.querySelectorAll('input:checked')].map((c) => c.value);
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(name));
      list.appendChild(label);
    }
  }

  // ------------------------------------------------------------ init
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init': {
        const c = msg.config;
        $('f-name').value = c.name || '';
        $('f-color').value = c.color || 'none';
        $('f-scope').value = msg.scope;
        if (!msg.projectScopeAvailable) {
          $('f-scope').querySelector('option[value="project"]').disabled = true;
        }
        $('f-driver').value = c.driver;
        $('f-host').value = c.host || '';
        $('f-port').value = c.port || DEFAULT_PORTS[c.driver] || '';
        if (c.port) $('f-port').dataset.touched = '1';
        $('f-auth').value = c.auth || 'userPassword';
        $('f-user').value = c.user || '';
        $('f-aws-profile').value = (c.aws && c.aws.profile) || '';
        $('f-aws-region').value = (c.aws && c.aws.region) || '';
        renderAwsProfiles(msg.awsProfiles);
        $('f-database').value = c.database || '';
        $('f-file').value = c.file || '';
        $('f-readonly').checked = !!c.readOnly;
        $('f-autosync').checked = c.autoSync !== false;
        renderTimeZones(msg.timeZones, msg.localTimeZone);
        $('f-timezone').value = c.timeZone === 'server' ? 'Server' : c.timeZone || 'Local';
        $('f-ssl-mode').value = (c.ssl && c.ssl.mode) || 'disable';
        $('f-ssl-ca').value = (c.ssl && c.ssl.caFile) || '';
        if (c.ssh) {
          $('f-ssh-on').checked = !!c.ssh.enabled;
          $('f-ssh-host').value = c.ssh.host || '';
          $('f-ssh-port').value = c.ssh.port || 22;
          $('f-ssh-user').value = c.ssh.user || '';
          $('f-ssh-auth').value = c.ssh.auth || 'password';
          $('f-ssh-key').value = c.ssh.keyFile || '';
        }
        selectedSchemas = c.schemas || [];
        if (selectedSchemas.length > 0) renderSchemaList(selectedSchemas);
        secretsPresent = msg.secretsPresent;
        if (secretsPresent.password) $('f-password').placeholder = '•••••• (saved)';
        if (secretsPresent.sshPassword) $('f-ssh-password').placeholder = '•••••• (saved)';
        if (secretsPresent.sshPassphrase) $('f-ssh-passphrase').placeholder = '•••••• (saved)';
        // existing sources keep their name; new ones follow database@host
        nameTouched = !msg.isNew || !!(c.name && c.name.trim());
        applyVisibility();
        updateRegionHint();
        maybeDeriveName();
        if (msg.isNew) $('f-host').focus();
        break;
      }
      case 'browsed':
        if (msg.field === 'file') {
          $('f-file').value = msg.path;
          $('f-file').classList.remove('invalid');
          maybeDeriveName();
        }
        if (msg.field === 'sshKey') {
          $('f-ssh-key').value = msg.path;
          $('f-ssh-key').classList.remove('invalid');
        }
        if (msg.field === 'sslCa') $('f-ssl-ca').value = msg.path;
        updateUrl();
        break;
      case 'testResult': {
        const el = $('test-result');
        el.className = msg.ok ? 'ok' : 'fail';
        el.textContent = msg.ok ? '✓ ' + msg.message : '✗ ' + msg.message;
        break;
      }
      case 'schemas':
        if (msg.ok) renderSchemaList(msg.list);
        else $('schema-list').textContent = 'Failed: ' + msg.message;
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
