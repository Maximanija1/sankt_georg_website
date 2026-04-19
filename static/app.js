(function () {
    "use strict";

    let sessionExpired = false;
    let lastSessionPing = 0;
    const SESSION_PING_THROTTLE_MS = 2000;

    function redirectToLogin() {
        if (sessionExpired) return;
        sessionExpired = true;
        window.location.href = "/login";
    }

    async function pingSession() {
        if (sessionExpired) return;
        const now = Date.now();
        if (now - lastSessionPing < SESSION_PING_THROTTLE_MS) return;
        lastSessionPing = now;
        try {
            const res = await fetch("/api/session", {
                credentials: "same-origin",
                headers: { Accept: "application/json" },
                cache: "no-store",
            });
            if (res.status === 401) redirectToLogin();
        } catch (_e) { /* network error: ignore */ }
    }

    function filterTable() {
        const input = document.getElementById("searchInput");
        if (!input) return;
        const query = input.value.toLowerCase();
        const rows = document.querySelectorAll(".medication-row");
        rows.forEach(function (row) {
            const searchText = row.getAttribute("data-search") || "";
            row.style.display = searchText.includes(query) ? "" : "none";
        });
    }

    async function copyCodesForMedication(pzn, fromDate, toDate, btn) {
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Laden...";

        try {
            const params = new URLSearchParams({ pzn: pzn, from: fromDate, to: toDate });
            const response = await fetch("/api/codes?" + params.toString(), {
                credentials: "same-origin",
                headers: { Accept: "application/json" },
            });
            if (response.status === 401) {
                redirectToLogin();
                return;
            }
            const data = await response.json();

            if (data.codes && data.codes.length > 0) {
                await navigator.clipboard.writeText(data.codes.join("\n"));
                btn.textContent = "Kopiert!";
                btn.classList.add("copied");
                setTimeout(function () {
                    btn.textContent = originalText;
                    btn.classList.remove("copied");
                    btn.disabled = false;
                }, 2000);
            } else {
                btn.textContent = "Keine Codes";
                setTimeout(function () {
                    btn.textContent = originalText;
                    btn.disabled = false;
                }, 2000);
            }
        } catch (err) {
            btn.textContent = "Fehler!";
            setTimeout(function () {
                btn.textContent = originalText;
                btn.disabled = false;
            }, 2000);
        }
    }

    // ---------- Codes modal ----------

    let modalPzn = "";
    let modalFrom = "";
    let modalTo = "";
    let modalCodes = [];

    function csrfToken() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.content : "";
    }

    function getSelectedIds() {
        return modalCodes
            .filter(function (c) { return c._checked; })
            .map(function (c) { return c.id; });
    }

    function updateCopyBtn() {
        const copyBtn = document.getElementById("codesCopyBtn");
        if (!copyBtn) return;
        const n = getSelectedIds().length;
        copyBtn.disabled = n === 0;
        copyBtn.textContent = n + " ausgewählt kopieren";
    }

    function renderCodeList() {
        const list = document.getElementById("codesList");
        const loading = document.getElementById("codesLoading");
        if (!list) return;

        loading.hidden = true;
        list.hidden = false;
        list.innerHTML = "";

        modalCodes.forEach(function (item, idx) {
            const li = document.createElement("li");
            li.className = "code-item" + (item.copied_at ? " is-copied" : "");

            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = !!item._checked;
            cb.id = "code-cb-" + idx;

            const label = document.createElement("label");
            label.htmlFor = "code-cb-" + idx;
            label.className = "code-text";
            label.textContent = item.code;

            li.appendChild(cb);
            li.appendChild(label);

            li.addEventListener("click", function (e) {
                if (e.target === cb) return;
                cb.checked = !cb.checked;
                item._checked = cb.checked;
                li.classList.toggle("is-selected", cb.checked);
                updateCopyBtn();
            });
            cb.addEventListener("change", function () {
                item._checked = cb.checked;
                updateCopyBtn();
            });

            list.appendChild(li);
        });

        updateCopyBtn();
    }

    async function openCodesModal(pzn, from, to, name) {
        const modal = document.getElementById("codesModal");
        if (!modal) return;

        modalPzn = pzn;
        modalFrom = from;
        modalTo = to;
        modalCodes = [];

        document.getElementById("codesModalTitle").textContent = name;
        document.getElementById("codesLoading").hidden = false;
        document.getElementById("codesList").hidden = true;
        document.getElementById("codesList").innerHTML = "";
        document.getElementById("codesSelectCount").value = "";
        updateCopyBtn();

        modal.showModal();

        try {
            const params = new URLSearchParams({ pzn: pzn, from: from, to: to });
            const res = await fetch("/api/codes/detail?" + params.toString(), {
                credentials: "same-origin",
                headers: { Accept: "application/json" },
            });
            if (res.status === 401) { redirectToLogin(); return; }
            const data = await res.json();
            modalCodes = (data.codes || []).map(function (c) {
                return { id: c.id, code: c.code, copied_at: c.copied_at, _checked: false };
            });
        } catch (_e) {
            document.getElementById("codesLoading").textContent = "Fehler beim Laden.";
            return;
        }

        renderCodeList();
    }

    function initCodesModal() {
        const modal = document.getElementById("codesModal");
        if (!modal) return;

        document.getElementById("codesModalClose").addEventListener("click", function () {
            modal.close();
        });

        modal.addEventListener("click", function (e) {
            if (e.target === modal) modal.close();
        });

        document.getElementById("codesSelectBtn").addEventListener("click", function () {
            const n = parseInt(document.getElementById("codesSelectCount").value, 10);
            if (!n || n < 1) return;
            let remaining = n;
            modalCodes.forEach(function (c) {
                if (!c.copied_at && remaining > 0) {
                    c._checked = true;
                    remaining--;
                } else {
                    c._checked = false;
                }
            });
            renderCodeList();
        });

        document.getElementById("codesCopyBtn").addEventListener("click", async function () {
            const btn = this;
            const selected = modalCodes.filter(function (c) { return c._checked; });
            if (!selected.length) return;

            const text = selected.map(function (c) { return c.code; }).join("\n");
            try {
                await navigator.clipboard.writeText(text);
            } catch (_e) {
                btn.textContent = "Kopieren fehlgeschlagen";
                return;
            }

            const ids = selected.map(function (c) { return c.id; });
            try {
                await fetch("/api/codes/mark", {
                    method: "POST",
                    credentials: "same-origin",
                    headers: {
                        "Content-Type": "application/json",
                        "X-CSRFToken": csrfToken(),
                    },
                    body: JSON.stringify({ ids: ids }),
                });
            } catch (_e) { /* mark failed silently */ }

            const now = new Date().toISOString();
            selected.forEach(function (c) {
                c.copied_at = now;
                c._checked = false;
            });

            const originalText = btn.textContent;
            btn.textContent = "Kopiert!";
            btn.classList.add("copied");
            renderCodeList();
            setTimeout(function () {
                btn.classList.remove("copied");
                updateCopyBtn();
            }, 2000);

            // refresh the "neu" badge on the table row
            refreshNeuBadge(modalPzn, modalFrom, modalTo);
        });

        document.getElementById("codesResetBtn").addEventListener("click", async function () {
            if (!confirm("Alle kopierten Markierungen zurücksetzen?")) return;
            try {
                await fetch("/api/codes/reset", {
                    method: "POST",
                    credentials: "same-origin",
                    headers: {
                        "Content-Type": "application/json",
                        "X-CSRFToken": csrfToken(),
                    },
                    body: JSON.stringify({ pzn: modalPzn, from: modalFrom, to: modalTo }),
                });
            } catch (_e) { /* reset failed silently */ }

            modalCodes.forEach(function (c) {
                c.copied_at = null;
                c._checked = false;
            });
            renderCodeList();
            refreshNeuBadge(modalPzn, modalFrom, modalTo);
        });

        document.querySelectorAll(".med-name-btn").forEach(function (btn) {
            btn.addEventListener("click", function () {
                openCodesModal(
                    btn.dataset.pzn || "",
                    btn.dataset.from,
                    btn.dataset.to,
                    btn.dataset.name
                );
            });
        });
    }

    function refreshNeuBadge(pzn, from, to) {
        document.querySelectorAll(".med-name-btn").forEach(function (btn) {
            if (btn.dataset.pzn !== pzn || btn.dataset.from !== from) return;
            const hasCopied = modalCodes.some(function (c) { return c.copied_at; });
            const unchecked = modalCodes.filter(function (c) { return !c.copied_at; });
            const maxCopiedAt = modalCodes.reduce(function (max, c) {
                return c.copied_at && (!max || c.copied_at > max) ? c.copied_at : max;
            }, null);
            const newCount = maxCopiedAt
                ? modalCodes.filter(function (c) { return !c.copied_at && c.scanned_at > maxCopiedAt; }).length
                : 0;

            const cell = btn.closest("td");
            let badge = cell.querySelector(".badge-neu");
            if (newCount > 0) {
                if (!badge) {
                    badge = document.createElement("span");
                    badge.className = "badge-neu";
                    btn.insertAdjacentElement("afterend", badge);
                }
                badge.textContent = newCount + " neu";
            } else if (badge) {
                badge.remove();
            }
        });
    }

    document.addEventListener("DOMContentLoaded", function () {
        const searchInput = document.getElementById("searchInput");
        if (searchInput) {
            searchInput.addEventListener("input", filterTable);
        }

        document.querySelectorAll(".btn-copy").forEach(function (btn) {
            btn.addEventListener("click", function () {
                const pzn = btn.dataset.pzn || "";
                if (btn.dataset.from && btn.dataset.to) {
                    copyCodesForMedication(pzn, btn.dataset.from, btn.dataset.to, btn);
                }
            });
        });

        initCodesModal();

        ["pointerdown", "keydown", "input", "change", "copy", "paste", "cut"].forEach(
            function (evt) {
                document.addEventListener(evt, pingSession, { capture: true, passive: true });
            }
        );
        document.addEventListener("visibilitychange", function () {
            if (document.visibilityState === "visible") pingSession();
        });
    });
})();
