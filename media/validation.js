// Local form validation for the Data Sources dialog. Pure data-in, errors-out,
// shared between the webview (window.tableclothValidation) and node unit tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.tableclothValidation = api;
})(this, function () {
  'use strict';

  function filled(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  /**
   * Validate the collected dialog form.
   * `forSave` adds the checks only saving needs (name); Test Connection and
   * Load Schemas validate just the connection fields.
   * Returns [{ field, message }] — empty when the form is good.
   */
  function validateDataSourceForm(form, opts) {
    const forSave = !!(opts && opts.forSave);
    const errors = [];
    const add = (field, message) => errors.push({ field, message });

    if (forSave && !filled(form.name)) add('name', 'Name is required.');

    if (form.driver === 'sqlite') {
      if (!filled(form.file)) add('file', 'Database file is required.');
      return errors;
    }

    if (!filled(form.host)) add('host', 'Host is required.');
    const port = Number(form.port);
    if (form.port === undefined || form.port === null || form.port === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
      add('port', 'Port must be a number between 1 and 65535.');
    }
    if (form.auth !== 'none' && !filled(form.user)) {
      add('user', 'User is required for this authentication mode.');
    }

    const ssh = form.ssh;
    if (ssh && ssh.enabled) {
      if (!filled(ssh.host)) add('sshHost', 'SSH host is required.');
      if (!filled(ssh.user)) add('sshUser', 'SSH user is required.');
      const sshPort = Number(ssh.port);
      if (ssh.port !== undefined && ssh.port !== null && ssh.port !== '' && (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535)) {
        add('sshPort', 'SSH port must be a number between 1 and 65535.');
      }
      if (ssh.auth === 'keyFile' && !filled(ssh.keyFile)) {
        add('sshKeyFile', 'SSH key file is required.');
      }
    }

    return errors;
  }

  /**
   * The IntelliJ-style automatic data source name: database@host for network
   * drivers, the file name for SQLite. Empty when nothing is filled in yet.
   */
  function deriveDataSourceName(form) {
    if (form.driver === 'sqlite') {
      const file = (form.file || '').trim();
      if (!file) return '';
      const parts = file.split(/[\\/]/);
      return parts[parts.length - 1] || '';
    }
    const database = (form.database || '').trim();
    const host = (form.host || '').trim();
    if (database && host) return database + '@' + host;
    return database || host;
  }

  return { validateDataSourceForm, deriveDataSourceName };
});
