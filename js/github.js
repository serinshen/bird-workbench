(function () {
  function cfg() {
    return window.WORKBENCH_CONFIG;
  }

  function headers(token, accept) {
    return {
      Authorization: "Bearer " + token,
      Accept: accept || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  async function readError(res) {
    const text = await res.text();
    try {
      const data = JSON.parse(text);
      return data.message || text || "GitHub " + res.status;
    } catch (err) {
      return text || "GitHub " + res.status;
    }
  }

  async function request(token, url, options) {
    const res = await fetch(url, options);
    if (res.status === 401) {
      const err = new Error("登录已失效。请重新登录。");
      err.code = 401;
      throw err;
    }
    return res;
  }

  async function readText(token, path) {
    const c = cfg();
    const url = "https://api.github.com/repos/" + c.owner + "/" + c.repo + "/contents/" + path + "?ref=" + encodeURIComponent(c.branch);
    const res = await request(token, url, {
      headers: headers(token, "application/vnd.github.raw"),
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await readError(res));
    return await res.text();
  }

  // One commit as the logged-in user. Blobs, not the contents API,
  // so a field photo larger than 1 MB can be written.
  async function commitFiles(token, files, message) {
    const c = cfg();
    const base = "https://api.github.com/repos/" + c.owner + "/" + c.repo;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const refRes = await request(token, base + "/git/ref/heads/" + encodeURIComponent(c.branch), {
        headers: headers(token),
        cache: "no-store",
      });
      if (!refRes.ok) throw new Error(await readError(refRes));
      const parent = (await refRes.json()).object.sha;
      const parentRes = await request(token, base + "/git/commits/" + parent, {
        headers: headers(token),
        cache: "no-store",
      });
      if (!parentRes.ok) throw new Error(await readError(parentRes));
      const parentCommit = await parentRes.json();
      const tree = [];
      for (const file of files) {
        if (file.deleted) {
          if (!file.path || !/^photos\/[A-Za-z0-9._-]+$/.test(file.path)) {
            throw new Error("只能删除 photos/ 里的野外照片。");
          }
          tree.push({ path: file.path, mode: "100644", type: "blob", sha: null });
          continue;
        }
        const blobRes = await request(token, base + "/git/blobs", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, headers(token)),
          body: JSON.stringify({ content: file.base64, encoding: "base64" }),
        });
        if (!blobRes.ok) throw new Error(await readError(blobRes));
        const blob = await blobRes.json();
        tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
      }
      const treeRes = await request(token, base + "/git/trees", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, headers(token)),
        body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree }),
      });
      if (!treeRes.ok) throw new Error(await readError(treeRes));
      const newTree = await treeRes.json();
      const commitRes = await request(token, base + "/git/commits", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, headers(token)),
        body: JSON.stringify({ message: message, tree: newTree.sha, parents: [parent] }),
      });
      if (!commitRes.ok) throw new Error(await readError(commitRes));
      const commit = await commitRes.json();
      const patchRes = await request(token, base + "/git/refs/heads/" + encodeURIComponent(c.branch), {
        method: "PATCH",
        headers: Object.assign({ "Content-Type": "application/json" }, headers(token)),
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });
      if (patchRes.ok) {
        return {
          sha: commit.sha,
          url: commit.html_url || "https://github.com/" + c.owner + "/" + c.repo + "/commit/" + commit.sha,
        };
      }
      lastError = new Error(await readError(patchRes));
      if (patchRes.status !== 409 && patchRes.status !== 422) throw lastError;
    }
    throw lastError || new Error("没有完成提交。");
  }

  window.WBGitHub = { readText, commitFiles };
})();
