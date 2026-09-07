async function approveQrOrder(orderId) {
  if (!confirm("Have you verified the exact payment amount and transaction reference in your UPI/bank account?")) return;
  try {
    await api(`/api/admin/orders/${encodeURIComponent(orderId)}/upi-qr/approve`, { method: "POST" });
    alert("QR payment verified and access unlocked.");
    await loadData();
  } catch (error) {
    alert(error.message || "Could not approve QR payment.");
  }
}

async function rejectQrOrder(orderId) {
  if (!confirm("Reject this QR payment request?")) return;
  try {
    await api(`/api/admin/orders/${encodeURIComponent(orderId)}/upi-qr/reject`, { method: "POST" });
    alert("QR payment rejected.");
    await loadData();
  } catch (error) {
    alert(error.message || "Could not reject QR payment.");
  }
}

let token = localStorage.getItem("pm_admin_token") || "";
let adminApps = [];
let adminOrders = [];

let analyticsTimer = null;

async function loadLiveAnalytics() {
  if (!token) return;
  try {
    const data = await api("/api/admin/analytics");
    const fmt = n => Number(n || 0).toLocaleString("en-IN");
    const live = document.getElementById("liveUsersStat");
    const total = document.getElementById("totalVisitorsStat");
    const today = document.getElementById("todayVisitorsStat");
    if (live) live.textContent = fmt(data.liveUsers);
    if (total) total.textContent = fmt(data.totalVisitors);
    if (today) today.textContent = fmt(data.todayVisitors);
    const updated = document.getElementById("analyticsUpdated");
    if (updated) updated.textContent = "Updated " + new Date().toLocaleTimeString();

    const rows = document.getElementById("liveVisitorRows");
    if (rows) {
      rows.innerHTML = (data.liveList || []).map(v => `
        <tr>
          <td><span class="live-dot" style="display:inline-block"></span> LIVE</td>
          <td>${esc(String(v.visitorId || "").slice(0, 12))}…</td>
          <td>${esc(v.page || "/")}</td>
          <td>${new Date(v.lastSeen).toLocaleTimeString()}</td>
        </tr>
      `).join("") || `<tr><td colspan="4">No users online right now.</td></tr>`;
    }
  } catch (e) {
    console.error("Live analytics:", e);
  }
}

function startLiveAnalyticsPolling() {
  loadLiveAnalytics();
  clearInterval(analyticsTimer);
  analyticsTimer = setInterval(loadLiveAnalytics, 5000);
}



/* =========================================================
   HELPERS
========================================================= */

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}


function money(value) {
  return `₹${Number(value || 0).toLocaleString("en-IN")}`;
}


function val(id) {
  return document.getElementById(id)?.value || "";
}


function setv(id, value) {
  const el = document.getElementById(id);

  if (el) {
    el.value = value ?? "";
  }
}


function checked(id) {
  return !!document.getElementById(id)?.checked;
}


/* =========================================================
   API HELPER
========================================================= */

async function api(path, options = {}) {

  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${token}`
  };


  /*
    JSON ke liye Content-Type automatically add karein.
  */

  if (
    options.body &&
    typeof options.body === "string"
  ) {
    headers["Content-Type"] =
      "application/json";
  }


  const response =
    await fetch(path, {
      ...options,
      headers
    });


  const data =
    await response.json()
      .catch(() => ({}));


  if (
    response.status === 401
  ) {

    adminLogout();

    throw new Error(
      data.error ||
      "Admin authentication required."
    );
  }


  if (!response.ok) {

    throw new Error(
      data.error ||
      "Request failed."
    );
  }


  return data;
}


async function uploadFile(file, kind) {
  if (!file) return null;
  const form = new FormData();
  form.append("kind", kind);
  form.append("file", file);

  const response = await fetch("/api/admin/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${kind} upload failed.`);
  return data;
}

/* =========================================================
   ADMIN LOGIN
========================================================= */

async function adminLogin() {

  const username =
    document
      .getElementById("adminUser")
      ?.value
      ?.trim();

  const password =
    document
      .getElementById("adminPass")
      ?.value || "";

  const secretKey =
    document
      .getElementById("adminSecret")
      ?.value || "";


  const message =
    document.getElementById(
      "loginMsg"
    );


  if (!username || !password || !secretKey) {

    if (message) {
      message.textContent =
        "Username, password and secret key are required.";
    }

    return;
  }


  try {

    if (message) {
      message.textContent =
        "Logging in...";
    }


    const response =
      await fetch(
        "/api/admin/login",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({

            username,

            password,

            secretKey

          })
        }
      );


    const data =
      await response.json();


    if (!response.ok) {

      throw new Error(
        data.error ||
        "Login failed."
      );
    }


    token =
      data.token;


    localStorage.setItem(
      "pm_admin_token",
      token
    );


    showPanel();


  } catch (error) {

    console.error(error);

    if (message) {
      message.textContent =
        error.message ||
        "Login failed.";
    }
  }
}


/* =========================================================
   SHOW ADMIN PANEL
========================================================= */

function showPanel() {

  const login =
    document.getElementById(
      "adminLogin"
    );

  const panel =
    document.getElementById(
      "adminPanel"
    );


  if (login) {
    login.classList.add(
      "hidden"
    );
  }


  if (panel) {
    panel.classList.remove(
      "hidden"
    );
  }


  refreshAdmin();
  startLiveAnalyticsPolling();
}



async function loadBatchOwnerships() {
  try {
    const rows = await api("/api/admin/batch-ownerships");
    const el = document.getElementById("batchOwnerships");
    if (!el) return;
    if (!rows.length) { el.innerHTML = '<p class="loading">No active course ownerships.</p>'; return; }
    el.innerHTML = rows.map(x => {
      const o = x.orderId || {};
      const expires = x.expiresAt ? new Date(x.expiresAt).toLocaleString("en-IN") : "Lifetime";
      return `<div class="order"><b>${esc(x.appId?.name || "Course")}</b><br>Name: ${esc(o.customerName || "—")} • Email: ${esc(o.customerEmail || x.ownerEmail || "—")} • Mobile: ${esc(o.customerPhone || "—")}<br>Payment: ${esc(o.paymentGateway || "—")} • Amount: ${money(o.amount || 0)} • Duration: <b>${esc(x.purchaseDurationLabel || "1 Year")}</b> • Expires: ${esc(expires)}<br>Status: <b>${x.active ? "ACTIVE" : "REMOVED"}</b><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">${x.active ? `<select id="dur_${x._id}"><option value="2_months">2 Months</option><option value="3_months">3 Months</option><option value="1_year">1 Year</option><option value="lifetime">Lifetime</option></select><button class="primary" onclick="changeBatchDuration('${x._id}')">Change Duration</button><button class="secondary" onclick="removeBatchOwnership('${x._id}')">Remove Access</button>` : ""}</div></div>`;
    }).join("");
  } catch (e) { const el=document.getElementById("batchOwnerships"); if(el) el.innerHTML=`<p class="loading">${esc(e.message||"Unable to load")}</p>`; }
}

async function changeBatchDuration(id) {
  const value = document.getElementById(`dur_${id}`)?.value || "1_year";
  if (!confirm(`Change this student's access to ${value}?`)) return;
  try { await api(`/api/admin/batch-ownerships/${encodeURIComponent(id)}/change-duration`, { method:"POST", body:JSON.stringify({ purchaseDuration:value }) }); alert("Course duration updated."); await loadBatchOwnerships(); } catch(e) { alert(e.message || "Could not change duration."); }
}

async function removeBatchOwnership(id) {
  if (!confirm("Remove this student's course access? They will have to pay again.")) return;
  try { await api(`/api/admin/batch-ownerships/${encodeURIComponent(id)}/remove`, { method:"POST" }); alert("Course access removed. Student must pay again."); await loadBatchOwnerships(); } catch(e) { alert(e.message || "Could not remove access."); }
}

async function loadPurchaseDurationSettings() {
  try {
    const d = await api("/api/admin/purchase-durations");
    const keys = d.durations || [];
    document.getElementById("duration2Months").checked = keys.includes("2_months");
    document.getElementById("duration3Months").checked = keys.includes("3_months");
    document.getElementById("duration1Year").checked = keys.includes("1_year");
    document.getElementById("defaultPurchaseDuration").value = d.defaultDuration || "1_year";
  } catch(e) {}
}

async function savePurchaseDurationSettings() {
  const durations=[];
  if(document.getElementById("duration2Months").checked) durations.push("2_months");
  if(document.getElementById("duration3Months").checked) durations.push("3_months");
  if(document.getElementById("duration1Year").checked) durations.push("1_year");
  const def=document.getElementById("defaultPurchaseDuration").value;
  if(!durations.length){alert("Select at least one duration.");return;}
  try { await api("/api/admin/purchase-durations",{method:"PUT",body:JSON.stringify({durations,defaultDuration:def})}); alert("Purchase duration settings saved."); } catch(e){alert(e.message||"Could not save duration settings.");}
}

/* =========================================================
   LOGOUT
========================================================= */

function adminLogout() {

  token = "";

  localStorage.removeItem(
    "pm_admin_token"
  );

  location.reload();
}


/* =========================================================
   REFRESH EVERYTHING
========================================================= */

async function refreshAdmin() {

  try {

    const [
      apps,
      stats,
      orders,
      donations,
      batchOwnerships
    ] = await Promise.all([

      api("/api/admin/apps"),

      api("/api/admin/stats"),

      api("/api/admin/orders"),

      api("/api/admin/donations"),

      api("/api/admin/batch-ownerships")

    ]);


    adminApps =
      Array.isArray(apps)
        ? apps
        : [];


    adminOrders =
      Array.isArray(orders)
        ? orders
        : [];


    renderStats(stats);

    renderApps(adminApps);

    renderOrders(adminOrders);

    renderCustomers(adminOrders);
    renderDonations(Array.isArray(donations) ? donations : []);
    await loadBatchOwnerships();
    await loadPurchaseDurationSettings();
    await loadWebsiteSettings();


  } catch (error) {

    console.error(
      "Admin refresh failed:",
      error
    );
  }
}


/* =========================================================
   STATS
========================================================= */

function renderStats(stats = {}) {

  const element =
    document.getElementById(
      "stats"
    );

  if (!element) return;


  element.innerHTML = `

    <div class="stat">

      <small>
        Apps
      </small>

      <b>
        ${Number(stats.apps || 0).toLocaleString("en-IN")}
      </b>

    </div>


    <div class="stat">

      <small>
        Orders
      </small>

      <b>
        ${Number(stats.orders || 0).toLocaleString("en-IN")}
      </b>

    </div>


    <div class="stat">

      <small>
        Paid Orders
      </small>

      <b>
        ${Number(stats.paidOrders || 0).toLocaleString("en-IN")}
      </b>

    </div>


    <div class="stat">

      <small>
        Revenue
      </small>

      <b>
        ${money(stats.revenue)}
      </b>

    </div>

  `;
}


/* =========================================================
   APP LIST
========================================================= */

function renderApps(apps) {

  const container =
    document.getElementById(
      "adminApps"
    );

  if (!container) return;


  if (!apps.length) {

    container.innerHTML =
      `<p class="loading">
        No apps or courses added yet.
      </p>`;

    return;
  }


  container.innerHTML =
    apps.map(app => {

      const price =
        Number(app.price || 0);


      return `

        <div class="admin-item">

          <img
            src="${esc(app.logo || "")}"
            alt=""
            loading="lazy"
            onerror="this.style.opacity='.25'"
          >


          <div class="grow">

            <h3>
              ${esc(app.name)}
            </h3>

            <p>
              ${esc(app.category || "Education")}
              •
              ${price > 0
          ? `Paid ${money(price)}`
          : "Free"}
              •
              ${app.published
          ? "Published"
          : "Hidden"}
            </p>

            <p>
              ★ ${Number(app.rating || 0).toFixed(1)}
              •
              ${Number(app.downloads || 0).toLocaleString("en-IN")} downloads
            </p>

          </div>


          <button
            onclick="editApp('${esc(app._id)}')"
          >
            Edit
          </button>


          <button
            class="danger"
            onclick="deleteApp('${esc(app._id)}')"
          >
            Delete
          </button>

        </div>

      `;

    }).join("");
}


/* =========================================================
   SAVE APP / COURSE
========================================================= */

async function saveApp() {
  const name = val("fName").trim();
  if (!name) {
    alert("App / Course name is required.");
    return;
  }

  const price = Number(val("fPrice") || 0);

  try {
    const button = document.querySelector(".form-actions .primary");
    if (button) {
      button.disabled = true;
      button.textContent = "Uploading / Saving...";
    }

    let logo = val("fLogo").trim();
    let logoKey = val("fLogoKey").trim();
    let banner = val("fBanner").trim();
    let bannerKey = val("fBannerKey").trim();

    const logoFile = document.getElementById("fLogoFile")?.files?.[0];
    if (logoFile) {
      const uploaded = await uploadFile(logoFile, "logo");
      logo = uploaded.url;
      logoKey = uploaded.key;
    }

    const bannerFile = document.getElementById("fBannerFile")?.files?.[0];
    if (bannerFile) {
      const uploaded = await uploadFile(bannerFile, "banner");
      banner = uploaded.url;
      bannerKey = uploaded.key;
    }

    const screenshots = val("fScreenshots").split("\n").map(x => x.trim()).filter(Boolean);
    const screenshotKeys = val("fScreenshotKeys").split("\n").map(x => x.trim()).filter(Boolean);

    const screenshotFiles = Array.from(
      document.getElementById("fScreenshotFiles")?.files || []
    );

    for (const file of screenshotFiles) {
      const uploaded = await uploadFile(file, "screenshot");
      screenshots.push(uploaded.url);
      screenshotKeys.push(uploaded.key);
    }

    let appFileKey = val("fAppFileKey").trim();
    let appFileName = val("fAppFileName").trim();
    let appFileMime = val("fAppFileMime").trim();
    let appFileSize = Number(val("fAppFileSize") || 0);

    const apkFile = document.getElementById("fApkFile")?.files?.[0];
    if (apkFile) {
      const uploaded = await uploadFile(apkFile, "apk");
      appFileKey = uploaded.key;
      appFileName = uploaded.fileName;
      appFileMime = uploaded.mime;
      appFileSize = uploaded.size;
    }

    const body = {
      name,
      developer: val("fDeveloper").trim(),
      category: val("fCategory").trim() || "Education",
      price,
      logo,
      logoKey,
      banner,
      bannerKey,
      websiteUrl: val("fWebsite").trim(),
      downloadUrl: val("fDownload").trim(),
      appFileKey,
      appFileName,
      appFileMime,
      appFileSize,
      validity: val("fValidity").trim() || "Lifetime",
      rating: Number(val("fRating") || 4.8),
      description: val("fDescription").trim(),
      screenshots,
      screenshotKeys,
      featured: checked("fFeatured"),
      trending: checked("fTrending"),
      upcoming: checked("fUpcoming"),
      published: checked("fPublished"),
      accessType: price > 0 ? "paid" : "free"
    };

    const id = val("editId");

    if (id) {
      await api(`/api/admin/apps/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(body)
      });
      alert("App updated successfully.");
    } else {
      await api("/api/admin/apps", {
        method: "POST",
        body: JSON.stringify(body)
      });
      alert("App added successfully.");
    }

    clearForm();
    await refreshAdmin();
  } catch (error) {
    console.error(error);
    alert(error.message || "Could not save app.");
  } finally {
    const button = document.querySelector(".form-actions .primary");
    if (button) {
      button.disabled = false;
      button.textContent = "Save App";
    }
  }
}


/* =========================================================
   EDIT APP
========================================================= */

function editApp(id) {

  const app =
    adminApps.find(
      item => String(item._id) === String(id)
    );


  if (!app) {

    alert(
      "App not found."
    );

    return;
  }


  setv(
    "editId",
    app._id
  );

  setv(
    "fName",
    app.name
  );

  setv(
    "fDeveloper",
    app.developer
  );

  setv(
    "fCategory",
    app.category
  );

  setv(
    "fPrice",
    app.price
  );

  setv(
    "fLogo",
    app.logo
  );
  setv("fLogoKey", app.logoKey || "");

  setv(
    "fBanner",
    app.banner
  );
  setv("fBannerKey", app.bannerKey || "");

  setv(
    "fWebsite",
    app.websiteUrl
  );

  setv(
    "fDownload",
    app.downloadUrl
  );
  setv("fAppFileKey", app.appFileKey || "");
  setv("fAppFileName", app.appFileName || "");
  setv("fAppFileMime", app.appFileMime || "");
  setv("fAppFileSize", app.appFileSize || 0);

  setv(
    "fValidity",
    app.validity
  );

  setv(
    "fRating",
    app.rating
  );

  setv(
    "fDescription",
    app.description
  );

  setv(
    "fScreenshots",
    (app.screenshots || [])
      .join("\n")
  );
  setv("fScreenshotKeys", (app.screenshotKeys || []).join("\n"));


  const featured =
    document.getElementById(
      "fFeatured"
    );

  const trending =
    document.getElementById(
      "fTrending"
    );

  const published =
    document.getElementById(
      "fPublished"
    );

  const upcoming =
    document.getElementById(
      "fUpcoming"
    );


  if (featured) {
    featured.checked =
      !!app.featured;
  }


  if (trending) {
    trending.checked =
      !!app.trending;
  }


  if (published) {
    published.checked =
      !!app.published;
  }

  if (upcoming) {
    upcoming.checked =
      !!app.upcoming;
  }


  const title =
    document.getElementById(
      "formTitle"
    );


  if (title) {

    title.textContent =
      "Edit App / Course";
  }


  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}


/* =========================================================
   CLEAR FORM
========================================================= */

function clearForm() {
  [
    "editId","fName","fDeveloper","fCategory","fPrice",
    "fLogo","fLogoKey","fBanner","fBannerKey","fWebsite",
    "fDownload","fAppFileKey","fAppFileName","fAppFileMime",
    "fAppFileSize","fScreenshotKeys","fValidity","fRating",
    "fDescription","fScreenshots"
  ].forEach(id => setv(id, ""));

  ["fLogoFile","fBannerFile","fApkFile","fScreenshotFiles"].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.value = "";
  });

  const featured = document.getElementById("fFeatured");
  const trending = document.getElementById("fTrending");
  const published = document.getElementById("fPublished");
  const upcoming = document.getElementById("fUpcoming");

  if (featured) featured.checked = false;
  if (trending) trending.checked = false;
  if (upcoming) upcoming.checked = false;
  if (published) published.checked = true;

  const title = document.getElementById("formTitle");
  if (title) title.textContent = "Add App / Course";
}


/* =========================================================
   DELETE APP
========================================================= */

async function deleteApp(id) {

  const app =
    adminApps.find(
      item => String(item._id) === String(id)
    );


  const name =
    app?.name ||
    "this app";


  const confirmed =
    confirm(
      `Delete "${name}"?\n\nThis action cannot be undone.`
    );


  if (!confirmed) return;


  try {

    await api(
      `/api/admin/apps/${encodeURIComponent(id)}`,
      {
        method: "DELETE"
      }
    );


    alert(
      "App deleted successfully."
    );


    await refreshAdmin();


  } catch (error) {

    console.error(error);

    alert(
      error.message ||
      "Could not delete app."
    );
  }
}



async function approveDonation(id){
  if(!confirm("Approve this batch donation? The batch will move to the recipient.")) return;
  try{ await api(`/api/admin/donations/${encodeURIComponent(id)}/approve`,{method:"POST"}); alert("Donation approved and batch transferred."); await refreshAdmin(); }catch(e){alert(e.message||"Could not approve donation.")}
}
async function rejectDonation(id){
  const reason=prompt("Reason for rejection:","Rejected by provider/admin") || "Rejected by provider/admin";
  try{ await api(`/api/admin/donations/${encodeURIComponent(id)}/reject`,{method:"POST",body:JSON.stringify({reason})}); alert("Donation rejected."); await refreshAdmin(); }catch(e){alert(e.message||"Could not reject donation.")}
}
function renderDonations(rows){
  const el=document.getElementById("donations"); if(!el) return;
  if(!rows.length){el.innerHTML='<p class="loading">No pending donation requests.</p>';return;}
  el.innerHTML=rows.map(x=>`<div class="order"><b>${esc(x.appId?.name||"Batch")}</b><br><span>${esc(x.donorEmail)} → ${esc(x.recipientEmail)}</span><br><small>Status: ${esc(x.status)} • ${new Date(x.createdAt).toLocaleString("en-IN")}</small><div style="display:flex;gap:8px;margin-top:10px"><button class="primary" onclick="approveDonation('${x._id}')">Approve & Transfer</button><button class="secondary" onclick="rejectDonation('${x._id}')">Reject</button></div></div>`).join("");
}

async function loadWebsiteSettings() {
  const settings = await api("/api/admin/settings");
  setv("siteTitle", settings.title || "STUDY PREMIUM COURSE");
  setv("siteTagline", settings.tagline || "LEARN • PREPARE • SUCCEED");
}

async function saveWebsiteSettings() {
  try {
    await api("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify({
        title: val("siteTitle"),
        tagline: val("siteTagline")
      })
    });
    alert("Website settings saved.");
  } catch (error) {
    alert(error.message || "Could not save settings.");
  }
}


/* =========================================================
   PAYMENTS
========================================================= */

function renderOrders(orders) {

  const container =
    document.getElementById(
      "orders"
    );

  if (!container) return;


  if (!orders.length) {

    container.innerHTML =
      `<p class="loading">
        No payments yet.
      </p>`;

    return;
  }


  container.innerHTML =
    orders.map(order => {

      const status =
        String(order.status || "")
          .toLowerCase();


      const date =
        order.createdAt
          ? new Date(
            order.createdAt
          ).toLocaleString("en-IN")
          : "—";


      return `

        <div class="order">

          <b>
            ${esc(order.appName || "Unknown")}
          </b>

          —
          <strong>
            ${money(order.amount)}
          </strong>

          —
          <strong>
            ${esc(status.toUpperCase())}
          </strong>


          <br>


          <span>

            Name:
            ${esc(order.customerName || "—")}

            •

            Email:
            ${esc(order.customerEmail || "—")}

            •

            Mobile:
            ${esc(order.customerPhone || "—")}

          </span>


          <br>


          <span>

            Gateway:
            ${esc(order.paymentGateway || "razorpay")}

            •

            Payment ID:
            ${esc(order.cashfreePaymentId || order.razorpayPaymentId || order.upiReference || "—")}

            •

            Order ID:
            ${esc(order.cashfreeOrderId || order.razorpayOrderId || order.upiOrderId || "—")}

          </span>


          <br>

          ${String(order.paymentGateway || "").toLowerCase() === "upi_qr" && status === "pending_verification" ? `
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
              <button class="primary" onclick="approveQrOrder('${order._id}')">✓ Verify & Approve</button>
              <button class="secondary" onclick="rejectQrOrder('${order._id}')">Reject</button>
            </div>
            <small style="display:block;margin-top:8px">Verify the exact amount and reference in your UPI/bank account before approving.</small>
          ` : ""}

          <span>
            ${esc(date)}
          </span>

        </div>

      `;

    }).join("");
}


/* =========================================================
   CUSTOMER TABLE / LIST
========================================================= */

function renderCustomers(orders) {

  const container =
    document.getElementById(
      "customers"
    );

  if (!container) return;


  const paid =
    orders.filter(
      order =>
        String(order.status).toLowerCase() ===
        "paid"
    );


  if (!paid.length) {

    container.innerHTML =
      `<p class="loading">
        No successful customers yet.
      </p>`;

    return;
  }


  container.innerHTML =
    paid.map(order => {

      const date =
        order.createdAt
          ? new Date(
            order.createdAt
          ).toLocaleString("en-IN")
          : "—";


      return `

        <div class="order">

          <b>
            ${esc(
        order.customerName ||
        "Customer"
      )}
          </b>

          <br>

          <span>
            📧
            ${esc(
        order.customerEmail ||
        "—"
      )}
          </span>

          <br>

          <span>
            📱
            ${esc(
        order.customerPhone ||
        "—"
      )}
          </span>

          <br>

          <span>
            📚
            ${esc(
        order.appName ||
        "—"
      )}
          </span>

          <br>

          <span>
            💰
            ${money(order.amount)}
          </span>

          <br>

          <span>
            🕒
            ${esc(date)}
          </span>

        </div>

      `;

    }).join("");
}


/* =========================================================
   WEBSITE SETTINGS
========================================================= */

function saveWebsiteSettings() {

  /*
    IMPORTANT:

    Current backend mein settings API abhi
    available nahi hai.

    Isliye yahan UI value collect ki ja rahi hai.
    Actual MongoDB settings save karne ke liye
    /api/admin/settings endpoint next backend
    update mein add karna hoga.
  */

  const title =
    val("siteTitle").trim();

  const tagline =
    val("siteTagline").trim();


  if (!title) {

    alert(
      "Website title required."
    );

    return;
  }


  /*
    Temporary browser storage.
    Backend settings endpoint add hone ke
    baad isko API call se replace karna hoga.
  */

  localStorage.setItem(
    "pm_site_title",
    title
  );

  localStorage.setItem(
    "pm_site_tagline",
    tagline
  );


  alert(
    "Website settings saved on this browser."
  );
}


/* =========================================================
   LOGIN FORM ENTER KEY
========================================================= */

document.addEventListener(
  "keydown",
  event => {

    if (
      event.key !== "Enter"
    ) {
      return;
    }


    const login =
      document.getElementById(
        "adminLogin"
      );


    if (
      login &&
      !login.classList.contains(
        "hidden"
      )
    ) {

      adminLogin();
    }

  }
);


/* =========================================================
   STARTUP
========================================================= */

if (token) {

  showPanel();

}