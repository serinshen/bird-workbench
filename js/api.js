(function () {
  function root() {
    var configured = window.WORKBENCH_CONFIG && window.WORKBENCH_CONFIG.apiOrigin;
    return String(configured || "").replace(/\/$/, "");
  }

  async function request(path, options) {
    var opts = options || {};
    var headers = Object.assign({}, opts.headers || {});
    var body = opts.body;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    var res;
    try {
      res = await fetch(root() + path, {
        method: opts.method || "GET",
        headers: headers,
        body: body,
        credentials: "include",
        cache: "no-store",
      });
    } catch (err) {
      throw new Error("没有连上工作台。");
    }
    var text = await res.text();
    var data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (err) { data = { message: text }; }
    }
    if (!res.ok) {
      var error = new Error((data && data.message) || ("没有完成（" + res.status + "）"));
      error.status = res.status;
      throw error;
    }
    return data;
  }

  window.WBApi = {
    root: root,
    request: request,
    get: function (path) { return request(path); },
    post: function (path, json) { return request(path, { method: "POST", json: json }); },
    put: function (path, json) { return request(path, { method: "PUT", json: json }); },
    del: function (path) { return request(path, { method: "DELETE" }); },
    form: function (path, method, body) { return request(path, { method: method, body: body }); },
  };
})();
