const $ = (selector) => document.querySelector(selector);
let currentUser = null;
let authMode = "login";
let cachedContent = [];

$("#year").textContent = new Date().getFullYear();

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options, headers: { ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}
function showModal(mode) {
  authMode = mode;
  $("#modalTitle").textContent = mode === "register" ? "Create your student account" : "Sign in to continue";
  $("#modalSub").textContent = mode === "register" ? "Join the learning community. It only takes a moment." : "Access your learning library.";
  $("#authSubmit").textContent = mode === "register" ? "Create account" : "Sign in";
  $("#switchAuth").innerHTML = mode === "register" ? 'Already registered? <button type="button" class="inline-button" id="switchMode">Sign in</button>' : 'New here? <button type="button" class="inline-button" id="switchMode">Create a student account</button>';
  $("#authError").textContent = "";
  $("#authModal").hidden = false;
  $("#switchMode").addEventListener("click", () => showModal(mode === "register" ? "login" : "register"));
}
function closeModal() { $("#authModal").hidden = true; }
$("#openLogin").addEventListener("click", () => showModal("login"));
$("#openRegister").addEventListener("click", () => showModal("register"));
$("#heroJoin").addEventListener("click", () => currentUser ? $("#library").scrollIntoView() : showModal("register"));
$("#closeModal").addEventListener("click", closeModal);
$("#authModal").addEventListener("click", e => { if (e.target === $("#authModal")) closeModal(); });

$("#authForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("#authError").textContent = "";
  const form = new FormData(e.currentTarget);
  try {
    const data = await api(authMode === "register" ? "/api/register" : "/api/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
    currentUser = data.user;
    e.currentTarget.reset();
    closeModal();
    renderAccount();
    await loadContent();
  } catch (error) { $("#authError").textContent = error.message; }
});

function renderAccount() {
  const area = $("#accountArea");
  if (!currentUser) {
    area.innerHTML = '<button class="btn btn-light" id="openLogin">Sign in</button><button class="btn btn-primary" id="openRegister">Join free</button>';
    $("#openLogin").addEventListener("click", () => showModal("login"));
    $("#openRegister").addEventListener("click", () => showModal("register"));
    return;
  }
  area.innerHTML = '<span class="user-greeting">Hi, ' + escapeHtml(currentUser.username) + '</span>' + (currentUser.role === "admin" ? '<button class="btn btn-light" id="manageContent">Manage</button>' : '') + '<button class="btn btn-primary" id="logout">Sign out</button>';
  $("#logout").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); currentUser = null; renderAccount(); loadContent(); });
  if (currentUser.role === "admin") $("#manageContent").addEventListener("click", openAdmin);
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }

async function loadContent() {
  const notice = $("#resourceNotice");
  const grid = $("#resourceGrid");
  grid.innerHTML = "";
  if (!currentUser) { notice.hidden = false; notice.textContent = "Sign in or create a student account to view learning resources."; return; }
  try {
    const level = $("#classFilter").value;
    const data = await api("/api/content?class=" + encodeURIComponent(level));
    cachedContent = data.content;
    notice.hidden = data.content.length > 0;
    notice.textContent = data.content.length ? "" : "No resources have been published for this class yet. Please check back soon.";
    grid.innerHTML = data.content.map(item => {
      const icon = item.resource_type === "video" ? "▶" : item.resource_type === "pdf" ? "▤" : "✦";
      const url = item.video_url || item.file_url;
      const action = url ? '<a class="resource-action" href="' + escapeHtml(url) + '" target="_blank" rel="noopener">Open resource ↗</a>' : '<span class="tag">Coming soon</span>';
      return '<article class="resource-card"><div class="resource-icon">' + icon + '</div><h3>' + escapeHtml(item.title) + '</h3><p>' + escapeHtml(item.description || "Learning resource shared by your administrator.") + '</p><div class="resource-meta"><span class="tag">' + escapeHtml(item.class_level) + '</span><span class="tag">' + escapeHtml(item.subject || "General") + '</span><span class="tag">' + escapeHtml(item.resource_type) + '</span></div>' + action + '</article>';
    }).join("");
  } catch (error) { notice.hidden = false; notice.textContent = error.message; }
}
$("#classFilter").addEventListener("change", loadContent);

function openAdmin() {
  $("#adminModal").hidden = false;
  clearContentForm();
  renderManageList();
}
function closeAdmin() { $("#adminModal").hidden = true; }
$("#closeAdmin").addEventListener("click", closeAdmin);
$("#cancelEdit").addEventListener("click", clearContentForm);
$("#adminModal").addEventListener("click", e => { if (e.target === $("#adminModal")) closeAdmin(); });
function clearContentForm() { $("#contentForm").reset(); $("#contentForm").elements.id.value = ""; $("#contentError").textContent = ""; }
function renderManageList() {
  $("#manageList").innerHTML = cachedContent.map(item => '<div class="manage-item"><div><strong>' + escapeHtml(item.title) + '</strong><small>' + escapeHtml(item.class_level) + ' · ' + escapeHtml(item.subject || "General") + '</small></div><div class="manage-actions"><button class="edit-btn" data-edit="' + item.id + '">Edit</button><button class="delete-btn" data-delete="' + item.id + '">Delete</button></div></div>').join("") || '<p class="notice">No resources published yet.</p>';
  $("#manageList").querySelectorAll("[data-edit]").forEach(button => button.addEventListener("click", () => {
    const item = cachedContent.find(x => x.id === Number(button.dataset.edit));
    const form = $("#contentForm");
    for (const key of ["id","title","description","class_level","subject","resource_type","file_url","video_url"]) form.elements[key].value = item[key] ?? "";
    $("#adminTitle").textContent = "Edit learning resource";
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $("#manageList").querySelectorAll("[data-delete]").forEach(button => button.addEventListener("click", async () => {
    if (!confirm("Delete this resource?")) return;
    try { await api("/api/content/" + button.dataset.delete, { method: "DELETE" }); await loadContent(); renderManageList(); }
    catch (error) { alert(error.message); }
  }));
}
$("#contentForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("#contentError").textContent = "";
  const form = e.currentTarget;
  const values = Object.fromEntries(new FormData(form).entries());
  const file = form.elements.resource.files[0];
  try {
    if (file) {
      const uploadData = new FormData();
      uploadData.append("resource", file);
      const uploaded = await api("/api/upload", { method: "POST", body: uploadData });
      if (file.type === "application/pdf") values.file_url = uploaded.url;
      else values.video_url = uploaded.url;
      values.resource_type = file.type === "application/pdf" ? "pdf" : "video";
    }
    delete values.resource;
    const id = values.id;
    delete values.id;
    await api(id ? "/api/content/" + id : "/api/content", { method: id ? "PUT" : "POST", body: JSON.stringify(values) });
    clearContentForm();
    $("#adminTitle").textContent = "Manage learning resources";
    await loadContent();
    renderManageList();
  } catch (error) { $("#contentError").textContent = error.message; }
});

(async function init() {
  try { const data = await api("/api/me"); currentUser = data.user; renderAccount(); await loadContent(); }
  catch { renderAccount(); await loadContent(); }
})();