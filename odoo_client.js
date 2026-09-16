const xmlrpc = require('xmlrpc');

class OdooClient {
  constructor({ url, db, username, apiKey, uid }) {
    const parsed = new URL(url);
    const clientOpts = { host: parsed.hostname, port: parsed.port || 443, path: '' };
    this._common = xmlrpc.createSecureClient({ ...clientOpts, path: '/xmlrpc/2/common' });
    this._object = xmlrpc.createSecureClient({ ...clientOpts, path: '/xmlrpc/2/object' });
    this._db = db;
    this._username = username;
    this._apiKey = apiKey;
    this._uid = uid || null;
  }

  _call(client, method, params) {
    return new Promise((resolve, reject) => {
      client.methodCall(method, params, (err, value) => {
        if (err) return reject(err);
        resolve(value);
      });
    });
  }

  async authenticate() {
    if (this._uid) return this._uid;
    this._uid = await this._call(this._common, 'authenticate', [
      this._db,
      this._username,
      this._apiKey,
      {},
    ]);
    if (!this._uid) throw new Error('Autenticación fallida: revisa db/usuario/api key');
    return this._uid;
  }

  async execute(model, method, args, kwargs = {}) {
    await this.authenticate();
    return this._call(this._object, 'execute_kw', [
      this._db,
      this._uid,
      this._apiKey,
      model,
      method,
      args,
      kwargs,
    ]);
  }

  searchRead(model, domain, fields, opts = {}) {
    return this.execute(model, 'search_read', [domain, fields], opts);
  }

  fieldsGet(model, fieldNames, attributes = ['string', 'type', 'required']) {
    return this.execute(model, 'fields_get', [fieldNames], { attributes });
  }
}

module.exports = OdooClient;
